/* =====================================================================
   BRUVS FOV annotator — client-side engine (v2)
   ---------------------------------------------------------------------
   Layers (each layer is ONE geometry; overlapping pieces fuse automatically,
   layers never merge with each other):
     water   (A)  water column visible in the frame
     blocked (C)  obstacles behind the bait canister hiding the view
     exclude      bait arm / canister / frame parts (not part of the FOV)
   Seabed (B) is everything in the FOV that is not water.

   Metrics (all as % of FOV, where FOV = image minus "exclude"):
     percent_water_col = water pixels not covered by a blockage
     percent_seabed    = 100 - percent_water_col
     percent_blocked   = blocked pixels
   Geometry is stored in original-image pixel coordinates as parts:
     { id, layer, source, rings: [outer, hole1, hole2, ...] }
   ===================================================================== */
(function () {
  "use strict";

  const LAYERS = {
    exclude: { label: "Bait arm",      fill: "rgba(120,120,120,0.45)", stroke: "#d0d0d0" },
    water:   { label: "Water column", fill: "rgba(40,150,255,0.30)",  stroke: "#1f8fff" },
    blocked: { label: "Blocked",      fill: "rgba(255,212,0,0.35)",   stroke: "#ffd400" }
  };
  const LAYER_ORDER = ["exclude", "water", "blocked"];
  /* user-chosen layer colours / fill opacity (per browser) */
  const STYLE_DEFAULT = { water: ["#2896ff", 30], blocked: ["#ffd400", 35], exclude: ["#787878", 45] };
  const STYLE_KEY = "fov-layer-style-v1";
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function applyLayerStyle(st) {
    Object.keys(STYLE_DEFAULT).forEach(L => {
      const [hex, a] = st[L] || STYLE_DEFAULT[L], [r, g, b] = hexRgb(hex);
      LAYERS[L].fill = `rgba(${r},${g},${b},${a / 100})`;
      LAYERS[L].stroke = L === "exclude" ? "#d0d0d0" : hex;
      document.querySelectorAll(".fov-swatch." + L).forEach(el => { el.style.background = LAYERS[L].fill; el.style.borderColor = hex; });
      const c = document.getElementById("fov-col-" + L), s = document.getElementById("fov-alpha-" + L), v = document.getElementById("fov-alpha-" + L + "-val");
      if (c) c.value = hex; if (s) s.value = a; if (v) v.textContent = a + "%";
    });
  }
  function loadLayerStyle() { try { return Object.assign({}, STYLE_DEFAULT, JSON.parse(localStorage.getItem(STYLE_KEY) || "{}")); } catch (e) { return Object.assign({}, STYLE_DEFAULT); } }
  function saveLayerStyle(st) { try { localStorage.setItem(STYLE_KEY, JSON.stringify(st)); } catch (e) {} }
  const METRIC_MAX_W = 900;   // raster width used to count pixels
  const AUTO_W = 240;         // working width for auto water detection
  const WAND_MAX_W = 520;     // working width for the magic wand
  const MERGE_MAX = 2000;     // max raster dimension when fusing/erasing shapes
  const MODEL_W = 256;        // working width for the trainable pixel model
  let NEXT_ID = 1;
  let USER = null;

  /* ================= small helpers ================= */
  const $ = (id) => document.getElementById(id);
  const r1 = (x) => Math.round(x * 10) / 10;
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const shiny = (name, value) => { if (window.Shiny && Shiny.setInputValue) Shiny.setInputValue(name, value, { priority: "event" }); };

  function pointInRing(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  const pointInPart = (x, y, p) => pointInRing(x, y, p.rings[0]) && !p.rings.slice(1).some(h => pointInRing(x, y, h));
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function simplifyOpen(pts, eps) {           // Ramer–Douglas–Peucker
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = distToSeg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function simplifyRing(ring, eps) {
    if (ring.length < 5) return ring.slice();
    let far = 0, fd = -1;
    for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
    const a = simplifyOpen(ring.slice(0, far + 1), eps);
    const b = simplifyOpen(ring.slice(far).concat([ring[0]]), eps);
    return a.concat(b.slice(1, -1));
  }
  function ringArea(pts) {                      // signed; positive = clockwise on screen
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }
  function partBBox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    p.rings[0].forEach(([x, y]) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; });
    return { x0, y0, x1, y1 };
  }
  const bboxOverlap = (a, b, m) => a.x0 - m <= b.x1 && b.x0 - m <= a.x1 && a.y0 - m <= b.y1 && b.y0 - m <= a.y1;
  const roundRings = (rings) => rings.map(r => r.map(([x, y]) => [r1(x), r1(y)]));
  const loadImage = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Could not load " + src)); im.src = src; });

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0, n = 0;
      for (let x = -r; x < w; x++) {
        const xa = x + r, xr = x - r - 1;
        if (xa < w) { acc += src[y * w + xa]; n++; }
        if (xr >= 0) { acc -= src[y * w + xr]; n--; }
        if (x >= 0) tmp[y * w + x] = acc / n;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0, n = 0;
      for (let y = -r; y < h; y++) {
        const ya = y + r, yr = y - r - 1;
        if (ya < h) { acc += tmp[ya * w + x]; n++; }
        if (yr >= 0) { acc -= tmp[yr * w + x]; n--; }
        if (y >= 0) out[y * w + x] = acc / n;
      }
    }
    return out;
  }
  function medianFilter(a, win) {
    const half = win >> 1, out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const s = [];
      for (let j = Math.max(0, i - half); j <= Math.min(a.length - 1, i + half); j++) s.push(a[j]);
      s.sort((p, q) => p - q); out[i] = s[s.length >> 1];
    }
    return out;
  }
  const quantile = (a, p) => { if (!a.length) return 0; const s = Array.from(a).sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

  /* ================= frames =================
     A frame = { image, img, W, H, polys: [parts], meta }.
     The editor's current image is a frame; batch jobs use offscreen frames. */
  function blankMeta() {
    return { range_m: null, notes: "", annotator: "", reviewed: false,
             methods: { water: null, blocked: null, exclude: null },
             edited: { water: false, blocked: false, exclude: false } };
  }
  function frameFrom(img, image, annotation) {
    const F = { image, img, W: img.naturalWidth, H: img.naturalHeight, polys: [], meta: blankMeta() };
    if (annotation) {
      const a = typeof annotation === "string" ? JSON.parse(annotation) : annotation;
      const fx = a.width ? F.W / a.width : 1, fy = a.height ? F.H / a.height : 1;
      F.polys = (a.polygons || []).map(p => ({
        id: NEXT_ID++, layer: p.layer, source: p.source || "manual",
        rings: [p.points].concat(p.holes || []).map(r => r.map(q => [q[0] * fx, q[1] * fy]))
      }));
      const m = a.meta || {};
      F.meta = Object.assign(blankMeta(), m);
      F.meta.methods = Object.assign(blankMeta().methods, m.methods || {});
      F.meta.edited = Object.assign(blankMeta().edited, m.edited || {});
      if (!m.methods) {                           // annotation from the v1 demo
        F.meta.methods.water = m.auto_water_used ? "auto" : (F.polys.some(p => p.layer === "water") ? "manual" : null);
        F.meta.edited.water = !!m.edited_after_auto;
        if (F.polys.some(p => p.layer === "blocked")) F.meta.methods.blocked = "manual";
      }
      F.updated = a.updated;
      LAYER_ORDER.forEach(L => normalizeLayer(F, L));   // fuse any legacy overlaps
    }
    return F;
  }
  const layerParts = (F, L) => F.polys.filter(p => p.layer === L);

  /* ================= raster <-> polygon ================= */
  function imagePixels(F, w) {
    const h = Math.max(1, Math.round(F.H * w / F.W));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.drawImage(F.img, 0, 0, w, h);
    return { data: g.getImageData(0, 0, w, h).data, w, h };
  }
  // rect = { x0, y0, s, w, h }: image point (x,y) -> mask ((x-x0)*s, (y-y0)*s)
  function rasterParts(parts, rect) {
    const c = document.createElement("canvas"); c.width = rect.w; c.height = rect.h;
    const g = c.getContext("2d"); g.fillStyle = "#fff";
    parts.forEach(p => {
      g.beginPath();
      p.rings.forEach(r => {
        r.forEach(([x, y], i) => {
          const X = (x - rect.x0) * rect.s, Y = (y - rect.y0) * rect.s;
          i ? g.lineTo(X, Y) : g.moveTo(X, Y);
        });
        g.closePath();
      });
      g.fill("evenodd");
    });
    const d = g.getImageData(0, 0, rect.w, rect.h).data, m = new Uint8Array(rect.w * rect.h);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    return m;
  }
  const fullRect = (F, w) => ({ x0: 0, y0: 0, s: w / F.W, w, h: Math.max(1, Math.round(F.H * w / F.W)) });
  const rasterLayer = (F, layers, w) => rasterParts(F.polys.filter(p => layers.includes(p.layer)), fullRect(F, w));

  /* Trace a binary mask into polygons with holes, following pixel edges
     exactly (inside kept on the right; outer rings clockwise, holes anticlockwise). */
  function traceMask(m, w, h) {
    const W1 = w + 1, nv = W1 * (h + 1);
    const out1 = new Int32Array(nv).fill(-1), out2 = new Int32Array(nv).fill(-1);
    const from = [], to = [], dir = [];
    const add = (x0, y0, x1, y1, d) => {
      const e = from.length, v = y0 * W1 + x0;
      from.push(v); to.push(y1 * W1 + x1); dir.push(d);
      if (out1[v] < 0) out1[v] = e; else out2[v] = e;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      if (y === 0 || !m[(y - 1) * w + x]) add(x, y, x + 1, y, 0);
      if (x === w - 1 || !m[y * w + x + 1]) add(x + 1, y, x + 1, y + 1, 1);
      if (y === h - 1 || !m[(y + 1) * w + x]) add(x + 1, y + 1, x, y + 1, 2);
      if (x === 0 || !m[y * w + x - 1]) add(x, y + 1, x, y, 3);
    }
    const used = new Uint8Array(from.length), rings = [];
    for (let e0 = 0; e0 < from.length; e0++) {
      if (used[e0]) continue;
      const ring = []; let e = e0, prevDir = -1;
      while (e >= 0 && !used[e]) {
        used[e] = 1;
        if (dir[e] !== prevDir) ring.push([from[e] % W1, (from[e] / W1) | 0]);   // corners only
        prevDir = dir[e];
        const v = to[e], a = out1[v], b = out2[v];
        const ua = a >= 0 && !used[a], ub = b >= 0 && !used[b];
        if (ua && ub) e = (dir[a] === (dir[e] + 1) % 4) ? a : b;   // saddle: turn right
        else e = ua ? a : (ub ? b : -1);
      }
      if (ring.length >= 3) rings.push(ring);
    }
    // group holes into their outers
    const outers = [], holes = [];
    rings.forEach(r => { const A = ringArea(r); (A > 0 ? outers : holes).push({ r, A: Math.abs(A) }); });
    const parts = outers.map(o => ({ rings: [o.r], A: o.A }));
    holes.forEach(hl => {
      const [hx, hy] = hl.r[0];
      let best = null;
      parts.forEach(p => { if (pointInRing(hx + 0.01, hy + 0.01, p.rings[0]) && (!best || p.A < best.A)) best = p; });
      if (best) best.rings.push(hl.r);
    });
    return parts.map(p => ({ rings: p.rings }));
  }
  // mask (in rect space) -> parts in image coordinates, simplified, tiny rings dropped
  function maskToParts(m, rect, opts) {
    const eps = (opts && opts.eps) || 0.7, minA = (opts && opts.minArea) || 4;
    const toImg = (r) => r.map(([x, y]) => [rect.x0 + x / rect.s, rect.y0 + y / rect.s]);
    const ok = (r) => r.length >= 3 && Math.abs(ringArea(r)) >= minA;
    return traceMask(m, rect.w, rect.h).map(p => {
      const outer = simplifyRing(p.rings[0], eps);
      if (!ok(outer)) return null;
      const holes = p.rings.slice(1).map(r => simplifyRing(r, eps)).filter(ok);
      return { rings: [outer].concat(holes).map(toImg) };
    }).filter(Boolean);
  }
  function rectFor(F, bb, pad) {
    const x0 = Math.max(0, Math.floor(bb.x0 - pad)), y0 = Math.max(0, Math.floor(bb.y0 - pad));
    const x1 = Math.min(F.W, Math.ceil(bb.x1 + pad)), y1 = Math.min(F.H, Math.ceil(bb.y1 + pad));
    const s = Math.min(1, MERGE_MAX / Math.max(1, x1 - x0, y1 - y0));
    return { x0, y0, s, w: Math.max(1, Math.ceil((x1 - x0) * s)), h: Math.max(1, Math.ceil((y1 - y0) * s)) };
  }
  const unionBB = (bbs) => bbs.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));

  // Fuse every set of overlapping/touching parts within a layer into one part
  function normalizeLayer(F, L) {
    const parts = layerParts(F, L);
    if (parts.length < 2) return false;
    const bbs = parts.map(partBBox), n = parts.length, par = parts.map((_, i) => i);
    const find = (i) => par[i] === i ? i : (par[i] = find(par[i]));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j) || !bboxOverlap(bbs[i], bbs[j], 1)) continue;
      const bb = unionBB([bbs[i], bbs[j]]);
      const rect = rectFor(F, bb, 2); const sc = Math.min(1, 500 / Math.max(rect.w, rect.h));
      const r2 = { x0: rect.x0, y0: rect.y0, s: rect.s * sc, w: Math.max(1, Math.ceil(rect.w * sc)), h: Math.max(1, Math.ceil(rect.h * sc)) };
      const a = rasterParts([parts[i]], r2), b = rasterParts([parts[j]], r2);
      let hit = false;
      for (let k = 0; k < a.length; k++) if (a[k] && b[k]) { hit = true; break; }
      if (!hit) {                                  // touching but not overlapping? test dilated
        for (let k = 0; k < a.length && !hit; k++) if (a[k]) {
          const x = k % r2.w, y = (k / r2.w) | 0;
          if ((x > 0 && b[k - 1]) || (x < r2.w - 1 && b[k + 1]) || (y > 0 && b[k - r2.w]) || (y < r2.h - 1 && b[k + r2.w])) hit = true;
        }
      }
      if (hit) par[find(i)] = find(j);
    }
    const groups = {};
    parts.forEach((p, i) => (groups[find(i)] = groups[find(i)] || []).push(p));
    let changed = false;
    Object.values(groups).forEach(g => {
      if (g.length < 2) return;
      const rect = rectFor(F, unionBB(g.map(partBBox)), 2);
      const fused = maskToParts(rasterParts(g, rect), rect);
      const src = Array.from(new Set(g.map(p => p.source))).join("+");
      F.polys = F.polys.filter(p => !g.includes(p));
      fused.forEach(fp => F.polys.push({ id: NEXT_ID++, layer: L, source: src, rings: roundRings(fp.rings) }));
      changed = true;
    });
    return changed;
  }
  function addParts(F, L, partsRings, source) {
    partsRings.forEach(rings => F.polys.push({ id: NEXT_ID++, layer: L, source: source || "manual", rings: roundRings(rings) }));
    normalizeLayer(F, L);
  }
  function replaceLayer(F, L, partsRings, source) {
    F.polys = F.polys.filter(p => p.layer !== L);
    addParts(F, L, partsRings, source);
  }
  // Subtract an eraser polygon from every part of layer L
  function eraseFromLayer(F, L, eraserRing) {
    const er = { rings: [eraserRing] }, ebb = partBBox(er);
    let changed = false;
    layerParts(F, L).forEach(p => {
      const bb = partBBox(p); if (!bboxOverlap(bb, ebb, 0)) return;
      const rect = rectFor(F, bb, 2);
      const m = rasterParts([p], rect), e = rasterParts([er], rect);
      let any = false; for (let k = 0; k < m.length; k++) if (m[k] && e[k]) { m[k] = 0; any = true; }
      if (!any) return;
      F.polys = F.polys.filter(q => q !== p);
      maskToParts(m, rect).forEach(fp => F.polys.push({ id: NEXT_ID++, layer: L, source: p.source, rings: roundRings(fp.rings) }));
      changed = true;
    });
    return changed;
  }

  /* ================= metrics ================= */
  function computeMetrics(F) {
    if (!F || !F.img) return null;
    const w = Math.min(METRIC_MAX_W, F.W);
    const ex = rasterLayer(F, ["exclude"], w), wa = rasterLayer(F, ["water"], w), bl = rasterLayer(F, ["blocked"], w);
    let fov = 0, water = 0, blocked = 0;
    for (let i = 0; i < ex.length; i++) {
      if (ex[i]) continue;
      fov++;
      if (bl[i]) blocked++; else if (wa[i]) water++;
    }
    const pct = (n) => fov ? r1(100 * n / fov) : 0;
    return {
      percent_water_col: pct(water),
      percent_seabed: fov ? r1(100 - 100 * water / fov) : 0,
      percent_blocked: pct(blocked),
      percent_excluded: r1(100 * (ex.length - fov) / ex.length)
    };
  }

  /* ================= auto water column (v4) =================
     Open water is smooth, keeps its hue and touches the top of the frame.
     1. Seabed evidence per pixel: texture and colour shift relative to the top
        band (as before), plus "looks more like the bottom of the frame than the
        top" for low-contrast sand in murky or night frames.
     2. Thin upright things (fish, bait line, hooks, snow) are removed with a
        horizontal opening, so they no longer punch spikes into the outline.
     3. One continuous horizon is found for the whole frame by dynamic
        programming: water above it should look like water, seabed below it like
        seabed, and the line pays a price for every step it takes.
     Tuned on 33 reviewed frames (Capes, South-west Corner, Two Rocks):
     mean |error| in % water 0.67 vs 1.19 for v3. */
  const AW = { c0: 0.75, cw: 0.1, minSep: 12, tGate: 0.15, open: 7, beta: 0.2, lam: 0.6, jump: 20, a: 6, shift: 5 };
  function sobelAbs(src, w, h) {
    const T = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (src[i - w + 1] + 2 * src[i + 1] + src[i + w + 1]) - (src[i - w - 1] + 2 * src[i - 1] + src[i + w - 1]);
      const gy = (src[i + w - 1] + 2 * src[i + w] + src[i + w + 1]) - (src[i - w - 1] + 2 * src[i - w] + src[i - w + 1]);
      T[i] = Math.abs(gx) + Math.abs(gy);
    }
    for (let y = 0; y < h; y++) { T[y * w] = T[y * w + 1]; T[y * w + w - 1] = T[y * w + w - 2]; }
    for (let x = 0; x < w; x++) { T[x] = T[w + x]; T[(h - 1) * w + x] = T[(h - 2) * w + x]; }
    return T;
  }
  const median = (a) => quantile(a, 0.5);
  function hMinMax(a, w, h, r, useMax) {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = useMax ? -Infinity : Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const u = a[y * w + k]; v = useMax ? Math.max(v, u) : Math.min(v, u); }
      o[y * w + x] = v;
    }
    return o;
  }
  // d: RGBA bytes (w*h*4), ex: exclude mask or null -> { hz (rows, length w), w, h }
  function autoWaterPixels(d, w, h, ex, sensitivity) {
    const n = w * h, m = 4, bandH = Math.max(6, Math.round(h * 0.15));
    const gray = new Float32Array(n), chroma = new Float32Array(n);
    const Yh = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], sum = r + g + b + 1;
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      chroma[i] = (g - b) / sum * 100 + (r / sum) * 100;
      Yh[i] = gray[i] * 0.5; Cb[i] = -0.1687 * r - 0.3313 * g + 0.5 * b; Cr[i] = 0.5 * r - 0.4187 * g - 0.0813 * b;
    }
    const isEx = (i) => ex && ex[i];
    // texture + chroma z-scores against the top band (v3 cues)
    const Tb = boxBlur(boxBlur(sobelAbs(boxBlur(gray, w, h, 1), w, h), w, h, 2), w, h, 2);
    const Cc = boxBlur(boxBlur(chroma, w, h, 2), w, h, 2);
    const tBand = [], cBand = [];
    for (let y = m; y < bandH; y++) for (let x = m; x < w - m; x++) { const i = y * w + x; if (isEx(i)) continue; tBand.push(Tb[i]); cBand.push(Cc[i]); }
    const med = quantile(tBand, 0.5), tSpread = Math.max(quantile(tBand, 0.9) - med, 2);
    const cMed = quantile(cBand, 0.5), cSpread = Math.max(quantile(cBand, 0.9) - quantile(cBand, 0.1), 1);
    const k = 11 - sensitivity;
    const thr = Math.max(med + k * tSpread, med * 1.5 + 4), cThr = (2 + k * 0.8) * cSpread;
    // colour similarity to the bottom band vs the top band
    const ch = [Yh, Cb, Cr].map(a => boxBlur(a, w, h, 2));
    const top = [], bot = [];
    ch.forEach(c => {
      const t = [], b = [];
      for (let y = m; y < bandH; y++) for (let x = m; x < w - m; x++) { const i = y * w + x; if (!isEx(i)) t.push(c[i]); }
      for (let y = h - bandH; y < h - m; y++) for (let x = m; x < w - m; x++) { const i = y * w + x; if (!isEx(i)) b.push(c[i]); }
      top.push(median(t)); bot.push(median(b));
    });
    const sep = Math.hypot(top[0] - bot[0], top[1] - bot[1], top[2] - bot[2]);
    let S = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tz = (Tb[i] - med) / (thr - med), cz = Math.abs(Cc[i] - cMed) / cThr;
      let s = Math.max(tz, cz, 2 * Math.min(tz, cz));
      if (sep >= AW.minSep) {
        const dt = Math.hypot(ch[0][i] - top[0], ch[1][i] - top[1], ch[2][i] - top[2]);
        const db = Math.hypot(ch[0][i] - bot[0], ch[1][i] - bot[1], ch[2][i] - bot[2]);
        let c = (dt / (dt + db + 1e-3) - AW.c0) / AW.cw + 1;
        if (tz <= AW.tGate) c = Math.min(c, 0.5);
        s = Math.max(s, c);
      }
      S[i] = s;
    }
    const r = AW.open >> 1;
    S = hMinMax(hMinMax(S, w, h, r, false), w, h, r, true);
    // dynamic programming over one horizon row per column (0..h)
    const H1 = h + 1, U = new Float64Array(H1 * w);
    for (let x = 0; x < w; x++) {
      const ca = new Float64Array(h), cb = new Float64Array(h);
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (isEx(i)) continue;
        const ps = 1 / (1 + Math.exp(-AW.a * (S[i] - 1)));
        ca[y] = ps; cb[y] = AW.beta * (1 - ps);
      }
      let below = 0; for (let y = 0; y < h; y++) below += cb[y];
      let above = 0;
      for (let kk = 0; kk <= h; kk++) {
        U[kk * w + x] = above + below;
        if (kk < h) { above += ca[kk]; below -= cb[kk]; }
      }
    }
    let acc = new Float64Array(H1), nxt = new Float64Array(H1);
    const bp = new Int16Array(H1 * w);
    for (let kk = 0; kk <= h; kk++) acc[kk] = U[kk * w];
    for (let x = 1; x < w; x++) {
      for (let kk = 0; kk <= h; kk++) {
        let best = Infinity, arg = 0;
        for (let j = 0; j <= h; j++) {
          const v = acc[j] + Math.min(AW.lam * Math.abs(kk - j), AW.jump);
          if (v < best) { best = v; arg = j; }
        }
        nxt[kk] = best + U[kk * w + x]; bp[kk * w + x] = arg;
      }
      const t = acc; acc = nxt; nxt = t;
    }
    let kk = 0; for (let j = 1; j <= h; j++) if (acc[j] < acc[kk]) kk = j;
    const hz = new Float32Array(w);
    for (let x = w - 1; x >= 0; x--) { hz[x] = kk > 0 ? Math.min(h, kk + AW.shift) : 0; if (x > 0) kk = bp[kk * w + x]; }
    return { hz, w, h };
  }
  function autoWaterCore(F, sensitivity) {
    const P = imagePixels(F, Math.min(AUTO_W, F.W));
    const ex = rasterLayer(F, ["exclude"], P.w);
    return autoWaterPixels(P.data, P.w, P.h, ex.some(v => v) ? ex : null, sensitivity);
  }
  function autoWater(F, sensitivity) {        // -> array of parts (rings)
    const { hz, w, h } = autoWaterCore(F, sensitivity);
    const sx = F.W / w, sy = F.H / h, line = [];
    for (let x = 0; x < w; x++) line.push([(x + 0.5) * sx, hz[x] <= 3 ? 0 : (hz[x] >= h - 2 ? F.H : hz[x] * sy)]);
    line[0][0] = 0; line[line.length - 1][0] = F.W;
    const simp = simplifyOpen(line, Math.max(1.5, F.W / 300));
    const ring = [[0, 0], [F.W, 0]].concat(simp.reverse());
    return Math.abs(ringArea(ring)) / (F.W * F.H) > 0.002 ? [[ring]] : [];
  }

  /* ================= bait arm: fit a hand-drawn mask to a new frame =================
     Uses the frames in this project where someone drew the bait arm by hand as
     templates. Each template outline is shifted, rotated and scaled to sit on the
     strongest image edges; the part of the outline that runs along the frame edge
     must stay on the frame edge (the arm always enters from outside the picture).
     Templates from the same system (e.g. "System 5", "BRUV 6") are tried first. */
  const ARM_W = 320;
  function systemKey(name) {
    const m = /(system|bruvs?)[ _-]*(\d+)/i.exec(name || "");
    if (m) return (m[1].toLowerCase().startsWith("bruv") ? "bruv" : "system") + m[2];
    const c = /_([LR]\d+)_/.exec(name || ""); return c ? c[1] : null;
  }
  function armTemplate(a) {
    const W = a.width, H = a.height, pts = [], nrm = [], bord = [];
    const polys = (a.polygons || []).filter(p => p.layer === "exclude");
    if (!polys.length) return null;
    let per = 0; polys.forEach(p => p.points.forEach((q, i) => { const r = p.points[(i + 1) % p.points.length]; per += Math.hypot((r[0] - q[0]) / W, (r[1] - q[1]) / H); }));
    polys.forEach(p => {
      const R = p.points.map(q => [q[0] / W, q[1] / H]);
      for (let i = 0; i < R.length; i++) {
        const a0 = R[i], b0 = R[(i + 1) % R.length], dx = b0[0] - a0[0], dy = b0[1] - a0[1], L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        const k = Math.max(1, Math.round(L / per * 240));
        for (let j = 0; j < k; j++) {
          const t = j / k, q = [a0[0] + dx * t, a0[1] + dy * t];
          const onBorder = q[0] < 0.004 || q[0] > 0.996 || q[1] < 0.004 || q[1] > 0.996;
          (onBorder ? bord : pts).push(q); if (!onBorder) nrm.push([-dy / L, dx / L]);
        }
      }
    });
    if (pts.length < 20) return null;
    const piv = [0, 0]; pts.forEach(q => { piv[0] += q[0] / pts.length; piv[1] += q[1] / pts.length; });
    return { a, pts, nrm, bord, piv, key: systemKey(a.image) };
  }
  function armGradient(d, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const b = boxBlur(boxBlur(g, w, h, 1), w, h, 1);
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1]) - (b[i - w - 1] + 2 * b[i - 1] + b[i + w - 1]);
      gy[i] = (b[i + w - 1] + 2 * b[i + w] + b[i + w + 1]) - (b[i - w - 1] + 2 * b[i - w] + b[i - w + 1]);
      if ((x + y) % 3 === 0) mag.push(Math.hypot(gx[i], gy[i]));
    }
    const s = quantile(mag, 0.9) + 1e-3;
    for (let i = 0; i < w * h; i++) { gx[i] /= s; gy[i] /= s; }
    return { gx, gy, w, h };
  }
  function armScore(G, T, dx, dy, rot, sc) {
    const c = Math.cos(rot), s = Math.sin(rot), { w, h } = G, px = T.piv[0], py = T.piv[1];
    for (const q of T.bord) {                     // frame-edge part must stay on the frame edge
      const X = (q[0] - px) * c * sc - (q[1] - py) * s * sc + px + dx, Y = (q[0] - px) * s * sc + (q[1] - py) * c * sc + py + dy;
      if (Math.min(X, 1 - X, Y, 1 - Y) > 0.015) return -1;
    }
    let sum = 0, n = 0, out = 0;
    for (let k = 0; k < T.pts.length; k++) {
      const q = T.pts[k];
      const X = ((q[0] - px) * c * sc - (q[1] - py) * s * sc + px + dx) * w, Y = ((q[0] - px) * s * sc + (q[1] - py) * c * sc + py + dy) * h;
      if (X <= 2 || X >= w - 3 || Y <= 2 || Y >= h - 3) { out++; continue; }
      const nx0 = T.nrm[k][0] * c - T.nrm[k][1] * s, ny0 = T.nrm[k][0] * s + T.nrm[k][1] * c;
      let nx = nx0 * w, ny = ny0 * h; const nn = Math.hypot(nx, ny) + 1e-9; nx /= nn; ny /= nn;
      const i = Math.round(Y) * w + Math.round(X);
      sum += Math.min(1.5, Math.abs(G.gx[i] * nx + G.gy[i] * ny)); n++;
    }
    if (!n || out > 0.1 * T.pts.length) return -1;
    return sum / n;
  }
  // -> { rings: [...parts], score, template } or null
  function fitArmPixels(d, w, h, templates) {
    const G = armGradient(d, w, h);
    let best = { s: -1 };
    for (const T of templates) {
      for (let r = -10; r <= 10.01; r += 2.5) for (const sc of [0.85, 0.95, 1.05, 1.15])
        for (let dx = -0.2; dx <= 0.2001; dx += 0.02) for (let dy = -0.25; dy <= 0.2501; dy += 0.02) {
          const v = armScore(G, T, dx, dy, r * Math.PI / 180, sc);
          if (v > best.s) best = { s: v, T, dx, dy, rot: r * Math.PI / 180, sc };
        }
    }
    if (!best.T) return null;
    for (const step of [0.01, 0.005]) {
      let improved = true;
      while (improved) {
        improved = false;
        for (const [a, b, c2, d2] of [[step, 0, 0, 0], [-step, 0, 0, 0], [0, step, 0, 0], [0, -step, 0, 0], [0, 0, 0.01, 0], [0, 0, -0.01, 0], [0, 0, 0, 0.02], [0, 0, 0, -0.02]]) {
          const v = armScore(G, best.T, best.dx + a, best.dy + b, best.rot + c2, best.sc + d2);
          if (v > best.s) { best = { s: v, T: best.T, dx: best.dx + a, dy: best.dy + b, rot: best.rot + c2, sc: best.sc + d2 }; improved = true; }
        }
      }
    }
    return best;
  }
  function armTransformRings(best, W, H) {
    const { T, dx, dy, rot, sc } = best, c = Math.cos(rot), s = Math.sin(rot), px = T.piv[0], py = T.piv[1];
    const tw = T.a.width, th = T.a.height;
    const tf = (q) => { const x = q[0] / tw, y = q[1] / th; return [((x - px) * c * sc - (y - py) * s * sc + px + dx) * W, ((x - px) * s * sc + (y - py) * c * sc + py + dy) * H]; };
    return T.a.polygons.filter(p => p.layer === "exclude").map(p => [p.points.map(tf)].concat((p.holes || []).map(r => r.map(tf))));
  }
  function pickTemplates(image, anns, sameOnly) {
    const all = anns.map(a => typeof a === "string" ? JSON.parse(a) : a).filter(a => a && a.image !== image).map(armTemplate).filter(Boolean);
    const k = systemKey(image), same = all.filter(T => k && T.key === k);
    return (same.length || sameOnly ? same : all).slice(0, 8);
  }
  function fitArm(F, anns, sameOnly) {
    const T = pickTemplates(F.image, anns, sameOnly); if (!T.length) return null;
    const P = imagePixels(F, Math.min(ARM_W, F.W));
    const best = fitArmPixels(P.data, P.w, P.h, T); if (!best) return null;
    return { parts: armTransformRings(best, F.W, F.H), score: best.s, from: best.T.a.image };
  }

  /* ================= bait arm: shape-and-colour detector =================
     No templates needed. The arm is a long straight bar entering from the frame
     edge; the bait bag is a red blob at its inner end.
     1. Straight edges: Hough transform of gradient-oriented edge pixels (480 px wide);
        keep lines whose edge support forms a long run touching the frame border.
     2. Bar: the best pair of near-parallel lines (both edges of the arm), scored on
        edge support, contrast with the surroundings and uniform colour inside.
     3. Width and taper: walk out from the bar's midline to the next edge parallel to
        it, fit a straight taper; extend toward the tip while the bar continues.
     4. Bag: red blob (CIELAB a* above its surroundings) nearest the tip. */
  const BAR_W = 480;
  function rgbToLab8(r, g, b) {
    const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const R = f(r), G = f(g), B = f(b);
    let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const h = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const fx = h(X), fy = h(Y), fz = h(Z);
    return [(116 * fy - 16) * 2.55, 500 * (fx - fy) + 128, 200 * (fy - fz) + 128];
  }
  function median1(a) { return quantile(a, 0.5); }
  function detectBarPixels(d, w, h) {
    const n = w * h, Y = new Float32Array(n);
    for (let i = 0; i < n; i++) Y[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const Yb = boxBlur(boxBlur(Y, w, h, 1), w, h, 1);
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n), ms = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (Yb[i - w + 1] + 2 * Yb[i + 1] + Yb[i + w + 1]) - (Yb[i - w - 1] + 2 * Yb[i - 1] + Yb[i + w - 1]);
      gy[i] = (Yb[i + w - 1] + 2 * Yb[i + w] + Yb[i + w + 1]) - (Yb[i - w - 1] + 2 * Yb[i - w] + Yb[i - w + 1]);
      mag[i] = Math.hypot(gx[i], gy[i]); ms.push(mag[i]);
    }
    const s90 = quantile(ms, 0.9) + 1e-3;
    for (let i = 0; i < n; i++) mag[i] /= s90;
    // Hough
    const NT = 180, diag = Math.ceil(Math.hypot(w, h)) + 1, NR = 2 * diag + 1, acc = new Float32Array(NT * NR);
    const COS = new Float32Array(NT), SIN = new Float32Array(NT);
    for (let t = 0; t < NT; t++) { COS[t] = Math.cos(t * Math.PI / NT); SIN[t] = Math.sin(t * Math.PI / NT); }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (mag[i] <= 1) continue;
      const wt = Math.min(mag[i], 3); let th = Math.atan2(gy[i], gx[i]); th = ((th % Math.PI) + Math.PI) % Math.PI;
      const t0 = Math.round(th / Math.PI * NT);
      for (let dt = -2; dt <= 2; dt++) {
        const t = ((t0 + dt) % NT + NT) % NT;
        const r = Math.round(x * COS[t] + y * SIN[t]) + diag;
        acc[t * NR + r] += wt * (1 - 0.15 * Math.abs(dt));
      }
    }
    const A2 = new Float32Array(NT * NR);                 // 3x3 smoothing
    for (let t = 0; t < NT; t++) for (let r = 1; r < NR - 1; r++) {
      let v = 0, ws = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const tt = t + a; if (tt < 0 || tt >= NT) continue;
        const k = (2 - Math.abs(a)) * (2 - Math.abs(b)); v += acc[tt * NR + r + b] * k; ws += k;
      }
      A2[t * NR + r] = v / ws * 16 / 16;
    }
    const peaksL = [];
    for (let k = 0; k < 80; k++) {
      let bi = -1, bv = 0;
      for (let i = 0; i < A2.length; i++) if (A2[i] > bv) { bv = A2[i]; bi = i; }
      if (bi < 0) break;
      const t = Math.floor(bi / NR), r = bi % NR;
      peaksL.push([t * Math.PI / NT, r - diag]);
      for (let a = Math.max(0, t - 3); a <= Math.min(NT - 1, t + 3); a++) for (let b = Math.max(0, r - 3); b <= Math.min(NR - 1, r + 3); b++) A2[a * NR + b] = 0;
    }
    const tol = 12 * Math.PI / 180, lines = [];
    for (const [t, r] of peaksL) {
      const c = Math.cos(t), s = Math.sin(t), x0 = r * c, y0 = r * s, L = Math.ceil(Math.hypot(w, h));
      const X = [], Yp = [], on = [];
      for (let tt = -L; tt <= L; tt++) {
        const x = x0 - s * tt, y = y0 + c * tt;
        if (!(x >= 1 && x < w - 1 && y >= 1 && y < h - 1)) continue;
        let hit = false;
        for (const off of [-1, 0, 1]) {
          const xx = Math.min(w - 1, Math.max(0, Math.round(x + c * off))), yy = Math.min(h - 1, Math.max(0, Math.round(y + s * off))), i = yy * w + xx;
          if (mag[i] <= 0.8) continue;
          let ga = Math.atan2(gy[i], gx[i]); ga = ((ga % Math.PI) + Math.PI) % Math.PI;
          let da = Math.abs(ga - t); da = Math.min(da, Math.PI - da);
          if (da < tol) { hit = true; break; }
        }
        X.push(x); Yp.push(y); on.push(hit);
      }
      if (X.length < 10) continue;
      const idx = []; on.forEach((v, k) => { if (v) idx.push(k); });
      if (!idx.length) continue;
      const segs = []; let a0 = idx[0], p = idx[0];
      for (let k = 1; k < idx.length; k++) { if (idx[k] - p > 10) { segs.push([a0, p]); a0 = idx[k]; } p = idx[k]; }
      segs.push([a0, p]);
      for (const [a, b] of segs) {
        const len = b - a + 1; let cnt = 0; for (let k = a; k <= b; k++) cnt += on[k] ? 1 : 0;
        const dens = cnt / len; if (dens < 0.4 || len < 0.18 * w) continue;
        const e0 = [X[a], Yp[a]], e1 = [X[b], Yp[b]];
        const bd = (q) => Math.min(q[0], w - 1 - q[0], q[1], h - 1 - q[1]);
        if (Math.min(bd(e0), bd(e1)) > 6) continue;
        const outer = bd(e0) <= bd(e1) ? e0 : e1, inner = bd(e0) <= bd(e1) ? e1 : e0;
        lines.push({ t, r, len, dens, outer, inner });
      }
    }
    const poly2mask = (pts) => {
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d");
      g.fillStyle = "#fff"; g.beginPath(); pts.forEach((q, k) => k ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.closePath(); g.fill();
      const dd = g.getImageData(0, 0, w, h).data, m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = dd[i * 4 + 3] > 127 ? 1 : 0; return m;
    };
    const meanStd = (vals) => { let s1 = 0, s2 = 0; vals.forEach(v => { s1 += v; s2 += v * v; }); const m = s1 / vals.length; return [m, Math.sqrt(Math.max(0, s2 / vals.length - m * m))]; };
    let best = null;
    const ldist = (q, L) => Math.abs(q[0] * Math.cos(L.t) + q[1] * Math.sin(L.t) - L.r);
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i], B = lines[j];
      let dt = Math.abs(A.t - B.t); dt = Math.min(dt, Math.PI - dt);
      if (dt > 8 * Math.PI / 180) continue;
      const so = ldist(A.outer, B), si = ldist(A.inner, B);
      if (!(si >= 5 && si <= 0.12 * w && so >= 6 && so <= 0.16 * w)) continue;
      if (Math.hypot(A.outer[0] - B.outer[0], A.outer[1] - B.outer[1]) > 0.2 * w) continue;
      const quad = [A.outer, A.inner, B.inner, B.outer], m = poly2mask(quad);
      const inside = [], out = [];
      let cnt = 0; for (let k = 0; k < n; k++) if (m[k]) { inside.push(Yb[k]); cnt++; }
      if (cnt < 30) continue;
      for (let k = 0; k < n; k++) {
        if (m[k]) continue; const x = k % w, y = (k / w) | 0; let near = false;
        for (let dy = -4; dy <= 4 && !near; dy++) for (let dx = -4; dx <= 4; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && m[yy * w + xx]) { near = true; break; } }
        if (near) out.push(Yb[k]);
      }
      const [mi, si2] = meanStd(inside), [mo, so2] = meanStd(out);
      const contrast = Math.abs(mi - mo) / (so2 + 8), unif = 1 / (1 + si2 / 20);
      const sc = (A.len * A.dens + B.len * B.dens) / w * (0.5 + contrast) * unif;
      if (!best || sc > best.score) best = { score: sc, A, B, quad };
    }
    if (!best && lines.length) {
      const L = lines.reduce((p, q) => q.len * q.dens > p.len * p.dens ? q : p);
      if (L.len >= 0.3 * w && L.dens >= 0.5) {
        const off = [Math.cos(L.t), Math.sin(L.t)];
        for (const sg of [1, -1]) {
          const B = Object.assign({}, L, { outer: [L.outer[0] + off[0] * sg * 5, L.outer[1] + off[1] * sg * 5], inner: [L.inner[0] + off[0] * sg * 4, L.inner[1] + off[1] * sg * 4] });
          const quad = [L.outer, L.inner, B.inner, B.outer], m = poly2mask(quad), inside = [];
          for (let k = 0; k < n; k++) if (m[k]) inside.push(Yb[k]);
          if (inside.length < 20) continue;
          const sc = L.len * L.dens / w * 0.5 / (1 + meanStd(inside)[1] / 20);
          if (!best || sc > best.score) best = { score: sc, A: L, B, quad };
        }
      }
    }
    if (!best) return null;
    // ---- refine width, taper and tip
    const lab = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) { const v = rgbToLab8(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); lab[0][i] = v[0]; lab[1][i] = v[1]; lab[2][i] = v[2]; }
    const LB = lab.map(a => boxBlur(a, w, h, 1));
    const { A, B } = best;
    const o = [(A.outer[0] + B.outer[0]) / 2, (A.outer[1] + B.outer[1]) / 2], i0 = [(A.inner[0] + B.inner[0]) / 2, (A.inner[1] + B.inner[1]) / 2];
    const Lax = Math.hypot(i0[0] - o[0], i0[1] - o[1]); if (Lax < 5) return null;
    const u = [(i0[0] - o[0]) / Lax, (i0[1] - o[1]) / Lax], nv = [-u[1], u[0]];
    const m0 = poly2mask(best.quad), ref = [[], [], []];
    for (let k = 0; k < n; k++) if (m0[k]) for (let c = 0; c < 3; c++) ref[c].push(LB[c][k]);
    const mu = ref.map(median1), sd = ref.map((a, c) => median1(a.map(v => Math.abs(v - mu[c]))) * 1.48 + 1);
    const tolc = Math.max(14, 2.5 * (Math.hypot(sd[1], sd[2]) + sd[0] * 0.5)), maxhw = 0.07 * w;
    const edgeAt = (p, sg) => {
      for (let k = 3; k < Math.floor(maxhw); k++) {
        const x = Math.round(p[0] + nv[0] * sg * k), y = Math.round(p[1] + nv[1] * sg * k);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return null;
        const i = y * w + x, gn = Math.hypot(gx[i], gy[i]) + 1e-6;
        if (mag[i] > 0.7 && Math.abs(gx[i] * nv[0] + gy[i] * nv[1]) / gn > 0.85) return k;
      }
      return null;
    };
    const ts = []; for (let t = 0; t <= Lax + 1e-9; t += 2) ts.push(t);
    const W2 = { 1: [], [-1]: [] };
    ts.forEach(t => { const c = [o[0] + u[0] * t, o[1] + u[1] * t]; for (const sg of [1, -1]) { const k = edgeAt(c, sg); if (k != null) W2[sg].push([t, k]); } });
    const sep = Math.abs((A.outer[0] - B.outer[0]) * nv[0] + (A.outer[1] - B.outer[1]) * nv[1]) / 2 + 1;
    const fitLine = (P, def) => {
      if (P.length < 5) return () => def;
      let keep = P.map(() => true), a = 0, b = def;
      for (let it = 0; it < 3; it++) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
        P.forEach((p, k) => { if (!keep[k]) return; sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; sxy += p[0] * p[1]; m++; });
        const den = m * sxx - sx * sx; a = den ? (m * sxy - sx * sy) / den : 0; b = (sy - a * sx) / m;
        const res = P.map(p => Math.abs(p[1] - (a * p[0] + b))), lim = Math.max(1.5, quantile(res, 0.6));
        keep = res.map(r => r <= lim);
      }
      return (t) => Math.min(maxhw, Math.max(1, a * t + b));
    };
    const fl = fitLine(W2[1], sep), fr = fitLine(W2[-1], sep);
    const coldist = (p) => { const x = Math.round(p[0]), y = Math.round(p[1]); if (x < 0 || y < 0 || x >= w || y >= h) return 1e9; const i = y * w + x; return Math.hypot((LB[0][i] - mu[0]) * 0.5, LB[1][i] - mu[1], LB[2][i] - mu[2]); };
    let t = ts[ts.length - 1], miss = 0, tend = t;
    while (miss < 5 && t < 2 * Lax) {
      t += 2; const c = [o[0] + u[0] * t, o[1] + u[1] * t]; let ok = 0;
      for (const [sg, f] of [[1, fl], [-1, fr]]) { const k = edgeAt(c, sg), ex = f(t); if (k != null && Math.abs(k - ex) <= Math.max(2, 0.5 * ex)) ok++; }
      if (ok >= 1 && coldist(c) < tolc * 1.3) { tend = t; miss = 0; } else miss++;
    }
    const tip = [o[0] + u[0] * tend, o[1] + u[1] * tend], T2 = []; for (let tt = 0; tt <= tend + 1e-9; tt += 2) T2.push(tt);
    const poly = [[o[0] - u[0] * 6 + nv[0] * (fl(0) + 0.5), o[1] - u[1] * 6 + nv[1] * (fl(0) + 0.5)]];
    T2.forEach(tt => { const l = fl(tt) + 0.5; poly.push([o[0] + u[0] * tt + nv[0] * l, o[1] + u[1] * tt + nv[1] * l]); });
    T2.slice().reverse().forEach(tt => { const r = fr(tt) + 0.5; poly.push([o[0] + u[0] * tt - nv[0] * r, o[1] + u[1] * tt - nv[1] * r]); });
    poly.push([o[0] - u[0] * 6 - nv[0] * (fr(0) + 0.5), o[1] - u[1] * 6 - nv[1] * (fr(0) + 0.5)]);
    const mask = poly2mask(poly);
    // ---- bait bag: red blob nearest the tip
    const R = 0.07 * w, near = [];
    for (let y = Math.max(0, Math.floor(tip[1] - R)); y <= Math.min(h - 1, Math.ceil(tip[1] + R)); y++)
      for (let x = Math.max(0, Math.floor(tip[0] - R)); x <= Math.min(w - 1, Math.ceil(tip[0] + R)); x++)
        if (Math.hypot(x - tip[0], y - tip[1]) < R) near.push(y * w + x);
    let bag = 0;
    if (near.length > 50) {
      const bg = median1(near.map(i => LB[1][i]));
      let red = new Uint8Array(n); near.forEach(i => { if (LB[1][i] - bg > 12) red[i] = 1; });
      red = morphOpen(red, w, h);
      const { lab: cl, sizes } = components(red, w, h);
      const cx = sizes.map(() => 0), cy = sizes.map(() => 0);
      for (let i = 0; i < n; i++) if (red[i]) { cx[cl[i]] += i % w; cy[cl[i]] += (i / w) | 0; }
      let bj = -1, bd = Infinity;
      sizes.forEach((s, k) => { if (s < 12) return; const dd = Math.hypot(cx[k] / s - tip[0], cy[k] / s - tip[1]); if (dd < bd) { bd = dd; bj = k; } });
      if (bj >= 0) {
        let bm = new Uint8Array(n); for (let i = 0; i < n; i++) if (red[i] && cl[i] === bj) bm[i] = 1;
        bm = dilate(dilate(bm, w, h), w, h);
        for (let i = 0; i < n; i++) if (bm[i]) { mask[i] = 1; bag++; }
      }
    }
    return { mask, w, h, score: best.score, bag: bag > 0 };
  }
  // mean normal gradient along a set of outline rings (normalised 0-1 coords); comparable across methods
  function outlineScore(G, rings) {
    const { w, h } = G; let sum = 0, cnt = 0;
    rings.forEach(r => {
      for (let k = 0; k < r.length; k++) {
        const a = r[k], b = r[(k + 1) % r.length], dx = (b[0] - a[0]) * w, dy = (b[1] - a[1]) * h, L = Math.hypot(dx, dy);
        if (L < 1e-6) continue;
        const nx = -dy / L, ny = dx / L, steps = Math.max(1, Math.round(L));
        for (let j = 0; j < steps; j++) {
          const x = Math.round((a[0] + (b[0] - a[0]) * j / steps) * w), y = Math.round((a[1] + (b[1] - a[1]) * j / steps) * h);
          if (x <= 2 || y <= 2 || x >= w - 3 || y >= h - 3) continue;
          const i = y * w + x; sum += Math.min(1.5, Math.abs(G.gx[i] * nx + G.gy[i] * ny)); cnt++;
        }
      }
    });
    return cnt >= 20 ? sum / cnt : -1;
  }
  // find the bait arm on frame F: shape/colour detector, plus template fitting when hand-drawn arms exist;
  // keep whichever outline sits better on the image edges
  function findArm(F, anns) {
    const cands = [];
    const P = imagePixels(F, Math.min(BAR_W, F.W));
    const det = detectBarPixels(P.data, P.w, P.h);
    if (det) {
      const parts = maskToParts(det.mask, { x0: 0, y0: 0, s: P.w / F.W, w: P.w, h: P.h }, { eps: 0.8, minArea: 20 }).map(p => p.rings);
      if (parts.length) cands.push({ parts, how: det.bag ? "shape + colour (bar and red bag)" : "shape + colour (bar; no red bag found)", from: null });
    }
    if (anns && anns.length) {
      const r = fitArm(F, anns, true);          // only hand-drawn arms from the same system
      if (r) cands.push({ parts: r.parts, how: "fitted from the hand-drawn arm on " + r.from, from: r.from, bonus: 0.9 });
    }
    if (!cands.length) return null;
    const Q = imagePixels(F, Math.min(ARM_W, F.W)), G = armGradient(Q.data, Q.w, Q.h);
    cands.forEach(c => { c.score = outlineScore(G, c.parts.flatMap(rings => [rings[0]]).map(r => r.map(q => [q[0] / F.W, q[1] / F.H]))) * (c.bonus || 1); });
    cands.sort((a, b) => b.score - a.score);
    return cands[0];
  }

  /* ================= magic wand ================= */
  function magicWand(F, ix, iy, tol) {        // -> array of parts (rings) or []
    const P = imagePixels(F, Math.min(WAND_MAX_W, F.W)), w = P.w, h = P.h;
    const s = w / F.W;
    const cx = Math.min(w - 1, Math.max(0, Math.round(ix * s))), cy = Math.min(h - 1, Math.max(0, Math.round(iy * s)));
    const LW = 0.3, BR = 3;
    const Y = new Float32Array(w * h), Cb = new Float32Array(w * h), Cr = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = P.data[i * 4], g = P.data[i * 4 + 1], bl = P.data[i * 4 + 2];
      Y[i] = (0.299 * r + 0.587 * g + 0.114 * bl) * LW;
      Cb[i] = -0.1687 * r - 0.3313 * g + 0.5 * bl;
      Cr[i] = 0.5 * r - 0.4187 * g - 0.0813 * bl;
    }
    const ch = [Y, Cb, Cr].map(a => boxBlur(a, w, h, BR));
    let s0 = 0, s1 = 0, s2 = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x; s0 += ch[0][i]; s1 += ch[1][i]; s2 += ch[2][i]; n++;
    }
    s0 /= n; s1 /= n; s2 /= n;
    const t2 = (tol * 0.6) * (tol * 0.6);
    let mask = new Uint8Array(w * h);
    const q = new Int32Array(w * h); let qh = 0, qt = 0;
    const seed = cy * w + cx; mask[seed] = 1; q[qt++] = seed;
    while (qh < qt) {
      const i = q[qh++], x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || mask[j]) continue;
        const a = ch[0][j] - s0, b = ch[1][j] - s1, c = ch[2][j] - s2;
        if (a * a + b * b + c * c <= t2) { mask[j] = 1; q[qt++] = j; }
      }
    }
    mask = fillHoles(morphClose(mask, w, h), w, h, Infinity);
    return maskToParts(mask, { x0: 0, y0: 0, s, w, h }, { eps: 0.8, minArea: 6 }).map(p => p.rings);
  }
  function dilate(m, w, h) {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      o[i] = m[i] || (x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w]) ? 1 : 0;
    }
    return o;
  }
  function erode(m, w, h) {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      o[i] = m[i] && (x === 0 || m[i - 1]) && (x === w - 1 || m[i + 1]) && (y === 0 || m[i - w]) && (y === h - 1 || m[i + w]) ? 1 : 0;
    }
    return o;
  }
  const morphClose = (m, w, h) => { const c = erode(dilate(m, w, h), w, h); for (let i = 0; i < m.length; i++) c[i] |= m[i]; return c; };
  const morphOpen = (m, w, h) => dilate(erode(m, w, h), w, h);
  // label connected components (4-connected); returns {lab, sizes}
  function components(m, w, h) {
    const lab = new Int32Array(w * h).fill(-1), sizes = [], q = new Int32Array(w * h);
    for (let s = 0; s < m.length; s++) {
      if (!m[s] || lab[s] >= 0) continue;
      const id = sizes.length; let qh = 0, qt = 0; q[qt++] = s; lab[s] = id;
      while (qh < qt) {
        const i = q[qh++], x = i % w, y = (i / w) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && m[j] && lab[j] < 0) { lab[j] = id; q[qt++] = j; }
      }
      sizes.push(qt);
    }
    return { lab, sizes };
  }
  function removeSmall(m, w, h, minA) {
    const { lab, sizes } = components(m, w, h), o = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) if (m[i] && sizes[lab[i]] >= minA) o[i] = 1;
    return o;
  }
  // fill enclosed background regions smaller than maxA (Infinity = all holes)
  function fillHoles(m, w, h, maxA) {
    const inv = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
    const { lab, sizes } = components(inv, w, h), touches = new Uint8Array(sizes.length);
    for (let x = 0; x < w; x++) { if (inv[x]) touches[lab[x]] = 1; const j = (h - 1) * w + x; if (inv[j]) touches[lab[j]] = 1; }
    for (let y = 0; y < h; y++) { const a = y * w, b = y * w + w - 1; if (inv[a]) touches[lab[a]] = 1; if (inv[b]) touches[lab[b]] = 1; }
    const o = new Uint8Array(m);
    for (let i = 0; i < m.length; i++) if (inv[i] && !touches[lab[i]] && sizes[lab[i]] <= maxA) o[i] = 1;
    return o;
  }

  /* ================= trainable pixel model =================
     A random forest classifies each pixel as water / seabed / blocked from colour,
     texture, context, position and the auto-water horizon, trained on the frames
     you have marked as reviewed. Runs entirely in the browser. */
  const FEATURE_NAMES = ["Y", "Cb", "Cr", "Yctx", "Cbctx", "Crctx", "tex2", "tex6", "sdY",
    "dY_top", "dCb_top", "dCr_top", "dTex_top", "row", "centre", "below_horizon"];
  const NF = FEATURE_NAMES.length;
  function frameFeatures(F) {
    const P = imagePixels(F, Math.min(MODEL_W, F.W)), w = P.w, h = P.h, d = P.data, n = w * h;
    const ex = rasterLayer(F, ["exclude"], w);
    const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      Cb[i] = -0.1687 * r - 0.3313 * g + 0.5 * b + 128;
      Cr[i] = 0.5 * r - 0.4187 * g - 0.0813 * b + 128;
    }
    const Yb = boxBlur(Y, w, h, 1), Cbb = boxBlur(Cb, w, h, 1), Crb = boxBlur(Cr, w, h, 1);
    const Yc = boxBlur(Y, w, h, 6), Cbc = boxBlur(Cb, w, h, 6), Crc = boxBlur(Cr, w, h, 6);
    const T = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (Yb[i - w + 1] + 2 * Yb[i + 1] + Yb[i + w + 1]) - (Yb[i - w - 1] + 2 * Yb[i - 1] + Yb[i + w - 1]);
      const gy = (Yb[i + w - 1] + 2 * Yb[i + w] + Yb[i + w + 1]) - (Yb[i - w - 1] + 2 * Yb[i - w] + Yb[i - w + 1]);
      T[i] = Math.abs(gx) + Math.abs(gy);
    }
    const T2 = boxBlur(T, w, h, 2), T6 = boxBlur(T, w, h, 6);
    const Y2 = new Float32Array(n); for (let i = 0; i < n; i++) Y2[i] = Y[i] * Y[i];
    const mY = boxBlur(Y, w, h, 3), mY2 = boxBlur(Y2, w, h, 3);
    const top = { Y: [], Cb: [], Cr: [], T: [] }, bandH = Math.max(4, Math.round(h * 0.15));
    for (let y = 3; y < bandH; y++) for (let x = 3; x < w - 3; x++) {
      const i = y * w + x; if (ex[i]) continue;
      top.Y.push(Yb[i]); top.Cb.push(Cbb[i]); top.Cr.push(Crb[i]); top.T.push(T2[i]);
    }
    const rY = quantile(top.Y, .5), rCb = quantile(top.Cb, .5), rCr = quantile(top.Cr, .5), rT = quantile(top.T, .5);
    const aw = autoWaterCore(F, 5);
    const X = new Float32Array(n * NF);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * NF;
      const hzY = aw.hz[Math.min(aw.w - 1, Math.floor(x * aw.w / w))] * h / aw.h;
      X[o] = Yb[i]; X[o + 1] = Cbb[i]; X[o + 2] = Crb[i];
      X[o + 3] = Yc[i]; X[o + 4] = Cbc[i]; X[o + 5] = Crc[i];
      X[o + 6] = T2[i]; X[o + 7] = T6[i]; X[o + 8] = Math.sqrt(Math.max(0, mY2[i] - mY[i] * mY[i]));
      X[o + 9] = Yb[i] - rY; X[o + 10] = Cbb[i] - rCb; X[o + 11] = Crb[i] - rCr; X[o + 12] = T2[i] - rT;
      X[o + 13] = y / h; X[o + 14] = Math.abs(x / w - 0.5); X[o + 15] = (y - hzY) / h;
    }
    return { X, w, h, ex };
  }
  // labels: 0 water, 1 seabed, 2 blocked, -1 excluded
  function frameLabels(F, w) {
    const ex = rasterLayer(F, ["exclude"], w), wa = rasterLayer(F, ["water"], w), bl = rasterLayer(F, ["blocked"], w);
    const y = new Int8Array(ex.length);
    for (let i = 0; i < y.length; i++) y[i] = ex[i] ? -1 : (bl[i] ? 2 : (wa[i] ? 0 : 1));
    return y;
  }
  function trainForest(X, Y, opts) {
    const n = Y.length, nTrees = opts.trees || 30, maxDepth = opts.depth || 14, minLeaf = opts.minLeaf || 3;
    const mtry = opts.mtry || 5, K = 12, bag = Math.min(n, opts.bag || 8000);
    const rnd = (k) => Math.floor(Math.random() * k);
    const trees = [];
    for (let t = 0; t < nTrees; t++) {
      const idx0 = new Int32Array(bag); for (let i = 0; i < bag; i++) idx0[i] = rnd(n);
      const nodes = []; const stack = [{ idx: idx0, depth: 0, slot: -1, side: 0 }];
      while (stack.length) {
        const nd = stack.pop(), idx = nd.idx;
        const cnt = [0, 0, 0]; for (let i = 0; i < idx.length; i++) cnt[Y[idx[i]]]++;
        const me = nodes.length;
        if (nd.slot >= 0) nodes[nd.slot][nd.side] = me;
        const pure = (cnt[0] === idx.length) || (cnt[1] === idx.length) || (cnt[2] === idx.length);
        let best = null;
        if (!pure && nd.depth < maxDepth && idx.length >= 2 * minLeaf) {
          const parentG = 1 - (cnt[0] ** 2 + cnt[1] ** 2 + cnt[2] ** 2) / (idx.length ** 2);
          for (let m = 0; m < mtry; m++) {
            const f = rnd(NF), th = new Float32Array(K);
            for (let k = 0; k < K; k++) th[k] = X[idx[rnd(idx.length)] * NF + f];
            const L = new Int32Array(K * 3);
            for (let i = 0; i < idx.length; i++) {
              const v = X[idx[i] * NF + f], c = Y[idx[i]];
              for (let k = 0; k < K; k++) if (v <= th[k]) L[k * 3 + c]++;
            }
            for (let k = 0; k < K; k++) {
              const l0 = L[k * 3], l1 = L[k * 3 + 1], l2 = L[k * 3 + 2], nl = l0 + l1 + l2, nr = idx.length - nl;
              if (nl < minLeaf || nr < minLeaf) continue;
              const r0 = cnt[0] - l0, r1_ = cnt[1] - l1, r2 = cnt[2] - l2;
              const g = (nl * (1 - (l0 * l0 + l1 * l1 + l2 * l2) / (nl * nl)) + nr * (1 - (r0 * r0 + r1_ * r1_ + r2 * r2) / (nr * nr))) / idx.length;
              if (g < parentG - 1e-9 && (!best || g < best.g)) best = { g, f, t: th[k] };
            }
          }
        }
        if (!best) { const s = cnt[0] + cnt[1] + cnt[2]; nodes.push({ p: [cnt[0] / s, cnt[1] / s, cnt[2] / s] }); continue; }
        const li = [], ri = [];
        for (let i = 0; i < idx.length; i++) (X[idx[i] * NF + best.f] <= best.t ? li : ri).push(idx[i]);
        nodes.push({ f: best.f, t: best.t, 0: -1, 1: -1 });
        stack.push({ idx: Int32Array.from(ri), depth: nd.depth + 1, slot: me, side: 1 });
        stack.push({ idx: Int32Array.from(li), depth: nd.depth + 1, slot: me, side: 0 });
      }
      trees.push(nodes);
    }
    return trees;
  }
  function forestProba(trees, X, n) {
    const P = new Float32Array(n * 3);
    for (const nodes of trees) for (let i = 0; i < n; i++) {
      let k = 0, o = i * NF;
      while (!nodes[k].p) k = X[o + nodes[k].f] <= nodes[k].t ? nodes[k][0] : nodes[k][1];
      const p = nodes[k].p; P[i * 3] += p[0]; P[i * 3 + 1] += p[1]; P[i * 3 + 2] += p[2];
    }
    for (let i = 0; i < P.length; i++) P[i] /= trees.length;
    return P;
  }
  const MODEL = { key: null, trees: null, nImages: 0, nSamples: 0 };
  async function getModel(train, report) {
    const key = JSON.stringify(train.map(t => [t.image, t.updated || ""]));
    if (MODEL.key === key && MODEL.trees) return MODEL;
    if (!train.length) throw new Error("No reviewed images yet — mark a few frames as reviewed first (10 or more recommended).");
    const Xs = [], Ys = [], PER_CLASS = 2500;
    for (let t = 0; t < train.length; t++) {
      report && report(`Reading training image ${t + 1} of ${train.length}…`);
      await sleep(0);
      const img = await loadImage(train[t].src);
      const F = frameFrom(img, train[t].image, train[t].annotation);
      const feat = frameFeatures(F), lab = frameLabels(F, feat.w);
      for (let c = 0; c < 3; c++) {
        const ids = []; for (let i = 0; i < lab.length; i++) if (lab[i] === c) ids.push(i);
        for (let k = ids.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [ids[k], ids[j]] = [ids[j], ids[k]]; }
        ids.slice(0, PER_CLASS).forEach(i => { Xs.push(feat.X.subarray(i * NF, i * NF + NF)); Ys.push(c); });
      }
    }
    const n = Ys.length, X = new Float32Array(n * NF), Y = Int8Array.from(Ys);
    Xs.forEach((r, i) => X.set(r, i * NF));
    report && report(`Training on ${n.toLocaleString()} pixels from ${train.length} reviewed image(s)…`);
    await sleep(0);
    MODEL.trees = trainForest(X, Y, { trees: 30, depth: 14, minLeaf: 3, mtry: 5, bag: Math.min(n, 9000) });
    MODEL.key = key; MODEL.nImages = train.length; MODEL.nSamples = n;
    MODEL.classes = [0, 1, 2].map(c => Ys.filter(v => v === c).length);
    return MODEL;
  }
  // -> { water: [parts rings], blocked: [parts rings] }
  function predictFrame(F, model) {
    const feat = frameFeatures(F), w = feat.w, h = feat.h, n = w * h;
    const P = forestProba(model.trees, feat.X, n);
    const ch = [0, 1, 2].map(c => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = P[i * 3 + c]; return boxBlur(a, w, h, 1); });
    const water = new Uint8Array(n), blocked = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (feat.ex[i]) continue;
      const a = ch[0][i], b = ch[1][i], c = ch[2][i];
      if (a >= b && a >= c) water[i] = 1; else if (c > a && c >= b) blocked[i] = 1;
    }
    const minA = Math.max(8, Math.round(n * 0.002));
    const clean = (m) => fillHoles(removeSmall(morphClose(morphOpen(m, w, h), w, h), w, h, minA), w, h, minA);
    const rect = { x0: 0, y0: 0, s: w / F.W, w, h };
    // open water connects to the top of the frame; drop isolated water blobs under 1% of the frame
    let wm = clean(water);
    {
      const { lab, sizes } = components(wm, w, h), keep = new Uint8Array(sizes.length);
      for (let x = 0; x < w; x++) for (let y = 0; y < Math.max(2, Math.round(h * 0.03)); y++) { const i = y * w + x; if (wm[i]) keep[lab[i]] = 1; }
      sizes.forEach((s, k) => { if (s > n * 0.01) keep[k] = 1; });
      for (let i = 0; i < n; i++) if (wm[i] && !keep[lab[i]]) wm[i] = 0;
    }
    return {
      water: maskToParts(wm, rect, { eps: 0.6, minArea: 3 }).map(p => p.rings),
      blocked: maskToParts(clean(blocked), rect, { eps: 0.6, minArea: 3 }).map(p => p.rings)
    };
  }

  /* ================= methods / review bookkeeping ================= */
  // a human changed layer L
  function markHuman(F, L, hadParts) {
    const M = F.meta;
    if (!hadParts && !M.methods[L]) M.methods[L] = "manual";
    else if (M.methods[L] === "auto" || M.methods[L] === "model") M.edited[L] = true;
    else if (!M.methods[L]) M.methods[L] = "manual";
    if (!layerParts(F, L).length) { M.methods[L] = null; M.edited[L] = false; }
  }
  function setMachine(F, L, method) { F.meta.methods[L] = layerParts(F, L).length ? method : null; F.meta.edited[L] = false; }
  // may a batch job overwrite layer L without destroying human work?
  function machineMayReplace(F, L) {
    const m = F.meta.methods[L];
    if (!layerParts(F, L).length) return true;
    return (m === "auto" || m === "model") && !F.meta.edited[L];
  }
  function applyTemplate(F, tpl) {
    const a = typeof tpl === "string" ? JSON.parse(tpl) : tpl;
    if (!a || !a.polygons || !a.polygons.length) return false;
    const fx = F.W / a.width, fy = F.H / a.height;
    replaceLayer(F, "exclude", a.polygons.map(p => [p.points].concat(p.holes || []).map(r => r.map(q => [q[0] * fx, q[1] * fy]))), "template");
    F.meta.methods.exclude = "template"; F.meta.edited.exclude = false;
    return true;
  }
  function frameStatus(F) {
    if (F.meta.reviewed) return "reviewed";
    return F.polys.length ? "needs review" : "not annotated";
  }
  function serialise(F) {
    return {
      schema: "bruvs-fov-annotation/2",
      image: F.image, width: F.W, height: F.H,
      polygons: F.polys.map(p => ({ id: p.id, layer: p.layer, source: p.source || "manual", points: p.rings[0], holes: p.rings.slice(1) })),
      metrics: computeMetrics(F),
      status: frameStatus(F),
      meta: Object.assign(JSON.parse(JSON.stringify(F.meta)), USER ? { updated_by: USER } : {}),
      definitions: "FOV = image minus exclude; percent_water_col = water not under blockage / FOV; percent_seabed = 100 - percent_water_col; percent_blocked = blocked / FOV",
      updated: new Date().toISOString()
    };
  }

  /* =====================================================================
     EDITOR
     ===================================================================== */
  const S = {
    F: null, loaded: false, busy: false,
    layer: "water", tool: "draw", drawing: [], cursor: null,
    selected: null, drag: null, hover: null, history: [], future: [],
    sendTimer: null, pendingSend: false, canvas: null, ctx: null, scale: 1,
    zoom: 1, ox: 0, oy: 0, pan: null, free: null, space: false, mag: false, magCanvas: null
  };
  const VS = () => S.scale * S.zoom;          // CSS px per image px at the current zoom

  function snapshot() {
    S.history.push(JSON.stringify({ polys: S.F.polys, meta: S.F.meta }));
    if (S.history.length > 60) S.history.shift();
    S.future = [];
  }
  function restore(str) { const o = JSON.parse(str); S.F.polys = o.polys; S.F.meta = o.meta; S.selected = null; changed(); }
  function undo() { if (!S.history.length) return; S.future.push(JSON.stringify({ polys: S.F.polys, meta: S.F.meta })); restore(S.history.pop()); }
  function redo() { if (!S.future.length) return; S.history.push(JSON.stringify({ polys: S.F.polys, meta: S.F.meta })); restore(S.future.pop()); }

  // run a human edit on layer L with undo + bookkeeping
  function humanEdit(L, fn) {
    snapshot();
    const had = layerParts(S.F, L).length > 0;
    fn();
    normalizeLayer(S.F, L);
    markHuman(S.F, L, had);
    if (S.selected != null && !S.F.polys.some(p => p.id === S.selected)) S.selected = null;
    changed();
  }

  function changed(skipSend) {
    render(); updatePanels();
    if (skipSend) return;
    clearTimeout(S.sendTimer); S.pendingSend = true;
    setStatus("Unsaved changes…", "pending");
    S.sendTimer = setTimeout(sendState, 500);
  }
  function sendState() {
    clearTimeout(S.sendTimer); S.pendingSend = false;
    if (!S.loaded) return;
    const payload = JSON.stringify(serialise(S.F));
    shiny("fov_annot", payload);
    window.__lastPayload = payload;
  }
  function setStatus(txt, cls) { const el = $("fov-status"); if (el) { el.textContent = txt; el.className = "fov-status " + (cls || ""); } }

  async function load(msg) {
    if (S.pendingSend) sendState();
    S.loaded = false; S.drawing = []; S.selected = null; S.history = []; S.future = [];
    try {
      const img = await loadImage(msg.src);
      const annotator = S.F ? S.F.meta.annotator : "";
      S.F = frameFrom(img, msg.image, msg.annotation || null);
      if (!S.F.meta.annotator) S.F.meta.annotator = annotator || "";
      S.loaded = true;
      const who = S.F.meta.updated_by || S.F.meta.annotator, when = fmtTime(S.F.updated);
      setStatus(msg.annotation
        ? `Saved annotation reopened${who ? " (last edited by " + who + (when ? ", " + when : "") + ")" : ""}. Keep editing; changes save automatically.`
        : "Not annotated yet. Start with Auto water column or draw a layer; your work saves as you go.", msg.annotation ? "ok" : "");
      const le = $("fov-lastedit");
      if (le) le.textContent = msg.annotation && who ? `Last edited by ${who}${when ? " on " + when : ""}` : "";
      S.zoom = 1; S.ox = 0; S.oy = 0;
      syncMetaInputs(); resize(); updatePanels();
      G.current = msg.image; highlightGallery();
    } catch (e) { setStatus(e.message, "err"); }
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso); if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function syncMetaInputs() {
    if ($("fov-range")) $("fov-range").value = S.F.meta.range_m == null ? "" : S.F.meta.range_m;
    if ($("fov-notes")) $("fov-notes").value = S.F.meta.notes || "";
    if ($("fov-annotator")) $("fov-annotator").value = S.F.meta.annotator || "";
  }

  /* ---------- rendering ---------- */
  function resize() {
    const wrap = $("fov-canvas-wrap"); if (!wrap || !S.loaded) return;
    const availW = (wrap.clientWidth || 808) - 8;
    const maxH = Math.max(300, window.innerHeight - 280);
    let cssW = availW, cssH = cssW * S.F.H / S.F.W;
    if (cssH > maxH) { cssH = maxH; cssW = cssH * S.F.W / S.F.H; }
    const dpr = window.devicePixelRatio || 1;
    S.canvas.style.width = cssW + "px"; S.canvas.style.height = cssH + "px";
    S.canvas.width = Math.round(cssW * dpr); S.canvas.height = Math.round(cssH * dpr);
    const oldVS = VS(), cx = S.ox, cy = S.oy;
    S.scale = cssW / S.F.W;
    if (oldVS) { S.ox = cx * VS() / oldVS; S.oy = cy * VS() / oldVS; }
    clampView();
    S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }
  const hidden = (L) => { const el = $("fov-hide-" + L); return el && el.checked; };
  function pathPart(g, p, s) {
    g.beginPath();
    p.rings.forEach(r => { r.forEach(([x, y], i) => i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)); g.closePath(); });
  }
  function drawParts(g, polys, s, opts) {
    LAYER_ORDER.forEach(L => {
      if (opts && opts.hide && opts.hide(L)) return;
      polys.filter(p => p.layer === L).forEach(p => {
        pathPart(g, p, s);
        g.fillStyle = LAYERS[L].fill; g.fill("evenodd");
        const sel = opts && opts.selected === p.id;
        g.lineWidth = sel ? 3 : (opts && opts.thin ? 1 : 1.6); g.strokeStyle = LAYERS[L].stroke; g.stroke();
      });
    });
  }
  function render() {
    const g = S.ctx; if (!g || !S.loaded) return;
    const s = VS(), F = S.F, dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S.canvas.width, S.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, -S.ox * dpr, -S.oy * dpr);
    g.drawImage(F.img, 0, 0, F.W * s, F.H * s);
    drawParts(g, F.polys, s, { hide: hidden, selected: S.selected });
    const showVerts = S.tool === "edit";
    F.polys.forEach(p => {
      if (hidden(p.layer) || !(showVerts || p.id === S.selected)) return;
      const sel = p.id === S.selected;
      p.rings.forEach((r, ri) => r.forEach(([x, y], i) => {
        const hov = S.hover && S.hover.id === p.id && S.hover.r === ri && S.hover.v === i;
        g.beginPath(); g.arc(x * s, y * s, hov ? 6 : (sel ? 4 : 2.6), 0, Math.PI * 2);
        g.fillStyle = hov ? "#fff" : LAYERS[p.layer].stroke; g.fill();
        g.lineWidth = 1; g.strokeStyle = "#000"; g.stroke();
      }));
    });
    if (S.drawing.length) {
      const col = S.tool === "erase" ? "#ff4d4d" : LAYERS[S.layer].stroke;
      g.beginPath();
      S.drawing.forEach(([x, y], i) => i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s));
      if (S.cursor) g.lineTo(S.cursor[0] * s, S.cursor[1] * s);
      g.setLineDash([6, 4]); g.lineWidth = 2; g.strokeStyle = col; g.stroke(); g.setLineDash([]);
      const step = S.free ? Math.max(1, Math.floor(S.drawing.length / 40)) : 1;
      S.drawing.forEach(([x, y], i) => {
        if (i && i % step) return;
        g.beginPath(); g.arc(x * s, y * s, i === 0 ? 6 : (S.free ? 2 : 3.5), 0, Math.PI * 2);
        g.fillStyle = i === 0 ? "#fff" : col; g.fill(); g.strokeStyle = "#000"; g.lineWidth = 1; g.stroke();
      });
    }
    drawMagnifier();
    updateZoomLabel();
    updateSelectionUI();
  }
  /* ---------- zoom, pan and magnifier ---------- */
  function clampView() {
    const cw = S.F.W * S.scale, ch = S.F.H * S.scale;          // canvas CSS size
    S.zoom = Math.max(1, Math.min(12, S.zoom));
    S.ox = Math.max(0, Math.min(cw * S.zoom - cw, S.ox));
    S.oy = Math.max(0, Math.min(ch * S.zoom - ch, S.oy));
  }
  function zoomAt(factor, cx, cy) {               // cx, cy: CSS px within the canvas
    if (!S.loaded) return;
    const ix = (cx + S.ox) / VS(), iy = (cy + S.oy) / VS();
    S.zoom *= factor; clampView();
    S.ox = ix * VS() - cx; S.oy = iy * VS() - cy; clampView(); render();
  }
  function zoomBy(factor) { const r = S.canvas.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2); }
  function zoomFit() { S.zoom = 1; S.ox = 0; S.oy = 0; render(); }
  function updateZoomLabel() { const el = $("fov-zoom-val"); if (el) el.textContent = Math.round(S.zoom * 100) + "%"; }
  function drawMagnifier() {
    const mc = $("fov-mag"); if (!mc) return;
    const show = S.mag && S.loaded && S.cursor && S.inCanvas;
    mc.style.display = show ? "block" : "none"; if (!show) return;
    const size = 200, dpr = window.devicePixelRatio || 1, F = S.F;
    if (mc.width !== size * dpr) { mc.width = size * dpr; mc.height = size * dpr; mc.style.width = size + "px"; mc.style.height = size + "px"; }
    const g = mc.getContext("2d"), z = 4 * VS();            // 4x the current view
    const [cx, cy] = S.cursor, sx = cx - size / 2 / z, sy = cy - size / 2 / z;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = "#000"; g.fillRect(0, 0, size, size);
    g.setTransform(dpr, 0, 0, dpr, -sx * z * dpr, -sy * z * dpr);
    g.imageSmoothingEnabled = false;
    g.drawImage(F.img, 0, 0, F.W * z, F.H * z);
    g.imageSmoothingEnabled = true;
    drawParts(g, F.polys, z, { hide: hidden, selected: S.selected });
    if (S.drawing.length) {
      g.beginPath(); S.drawing.forEach(([x, y], i) => i ? g.lineTo(x * z, y * z) : g.moveTo(x * z, y * z)); g.lineTo(cx * z, cy * z);
      g.setLineDash([6, 4]); g.lineWidth = 2; g.strokeStyle = S.tool === "erase" ? "#ff4d4d" : LAYERS[S.layer].stroke; g.stroke(); g.setLineDash([]);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(size / 2, size / 2 - 10); g.lineTo(size / 2, size / 2 + 10); g.moveTo(size / 2 - 10, size / 2); g.lineTo(size / 2 + 10, size / 2); g.stroke();
    // keep the inset away from the cursor
    const r = S.canvas.getBoundingClientRect(), vx = cx * VS() - S.ox, vy = cy * VS() - S.oy;
    const left = vx > r.width - size - 30 && vy < size + 30;
    mc.style.left = left ? "10px" : ""; mc.style.right = left ? "" : "10px";
  }
  function updatePanels() {
    if (!S.loaded) return;
    const m = computeMetrics(S.F);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v.toFixed(1) + "%"; };
    set("m-water", m.percent_water_col); set("m-seabed", m.percent_seabed); set("m-blocked", m.percent_blocked); set("m-excluded", m.percent_excluded);
    const bar = $("m-bar");
    if (bar) {
      const wv = m.percent_water_col, bv = m.percent_blocked, sv = Math.max(0, 100 - wv - bv);
      bar.innerHTML = `<span class="seg seg-water" style="width:${wv}%"></span><span class="seg seg-seabed" style="width:${sv}%"></span><span class="seg seg-blocked" style="width:${bv}%"></span>`;
    }
    const cnt = $("fov-counts");
    if (cnt) cnt.textContent = ["water", "blocked", "exclude"].map(L => {
      const k = layerParts(S.F, L).length, meth = S.F.meta.methods[L];
      return `${L}: ${k ? k + (k > 1 ? " pieces" : " piece") : "—"}${meth && L !== "exclude" ? " (" + meth + (S.F.meta.edited[L] ? "+edited" : "") + ")" : ""}`;
    }).join(" · ");
    const rb = $("fov-review");
    if (rb) { rb.classList.toggle("done", !!S.F.meta.reviewed); rb.textContent = S.F.meta.reviewed ? "Reviewed ✓" : "Mark reviewed"; }
  }

  /* ---------- interaction ---------- */
  function toImg(e) { const r = S.canvas.getBoundingClientRect(); return [(e.clientX - r.left + S.ox) / VS(), (e.clientY - r.top + S.oy) / VS()]; }
  const clampPt = ([x, y]) => [Math.max(0, Math.min(S.F.W, x)), Math.max(0, Math.min(S.F.H, y))];
  function hitVertex(x, y) {
    const tol = 8 / VS();
    for (let k = S.F.polys.length - 1; k >= 0; k--) {
      const p = S.F.polys[k]; if (hidden(p.layer)) continue;
      for (let r = 0; r < p.rings.length; r++) for (let i = 0; i < p.rings[r].length; i++)
        if (Math.hypot(p.rings[r][i][0] - x, p.rings[r][i][1] - y) < tol) return { id: p.id, r, v: i };
    }
    return null;
  }
  function hitPart(x, y) {
    for (const L of LAYER_ORDER.slice().reverse()) {
      if (hidden(L)) continue;
      const c = S.F.polys.filter(p => p.layer === L && pointInPart(x, y, p));
      if (c.length) return c[c.length - 1];
    }
    return null;
  }
  function hitEdge(x, y) {
    const tol = 7 / VS();
    const order = S.F.polys.slice().sort((a, b) => (b.id === S.selected) - (a.id === S.selected));
    for (const p of order) {
      if (hidden(p.layer)) continue;
      for (let r = 0; r < p.rings.length; r++) {
        const ring = p.rings[r];
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          if (distToSeg(x, y, a[0], a[1], b[0], b[1]) < tol) return { id: p.id, r, i };
        }
      }
    }
    return null;
  }
  const partById = (id) => S.F.polys.find(p => p.id === id);

  function finishDrawing() {
    S.free = null;
    if (S.drawing.length >= 3) {
      const ring = S.drawing.map(clampPt), L = S.layer;
      if (S.tool === "erase") humanEdit(L, () => eraseFromLayer(S.F, L, ring));
      else humanEdit(L, () => S.F.polys.push({ id: NEXT_ID++, layer: L, source: "manual", rings: roundRings([ring]) }));
    }
    S.drawing = []; render();
  }
  function onDown(e) {
    if (!S.loaded || S.busy) return;
    if (e.button === 1 || (e.button === 0 && S.space)) {          // pan: middle button or Space + drag
      S.pan = { x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy }; S.canvas.style.cursor = "grabbing"; e.preventDefault(); return;
    }
    const [x, y] = toImg(e);
    if (S.tool === "draw" || S.tool === "erase") {
      if (e.button !== 0) return;
      if (S.drawing.length >= 3) {
        const f = S.drawing[0];
        if (Math.hypot(f[0] - x, f[1] - y) < 10 / VS()) { finishDrawing(); return; }
      }
      const last = S.drawing[S.drawing.length - 1];
      S.free = { start: [x, y], startLen: S.drawing.length, active: false };
      if (last && Math.hypot(last[0] - x, last[1] - y) < 3 / VS()) return;
      S.drawing.push(clampPt([x, y])); render();
    } else if (S.tool === "edit") {
      const v = hitVertex(x, y);
      if (v && (e.shiftKey || e.button === 2)) {
        const p = partById(v.id);
        if (p.rings[v.r].length > 3) humanEdit(p.layer, () => p.rings[v.r].splice(v.v, 1));
        return;
      }
      if (v) { S.drag = Object.assign({ start: JSON.stringify({ polys: S.F.polys, meta: S.F.meta }) }, v); S.selected = v.id; render(); return; }
      const p = hitPart(x, y);
      S.selected = p ? p.id : null;
      if (p) S.drag = { id: p.id, move: true, from: [x, y], start: JSON.stringify({ polys: S.F.polys, meta: S.F.meta }) };
      render();
    } else if (S.tool === "wand") {
      if (e.button !== 0) return;
      setStatus("Magic wand working…", "pending");
      setTimeout(() => {
        const tol = +($("fov-wand-tol") ? $("fov-wand-tol").value : 40);
        const parts = magicWand(S.F, x, y, tol);
        if (!parts.length) { setStatus("Wand found no region", "err"); return; }
        const L = S.layer;
        humanEdit(L, () => parts.forEach(rings => S.F.polys.push({ id: NEXT_ID++, layer: L, source: "wand", rings: roundRings(rings) })));
      }, 10);
    }
  }
  function onMove(e) {
    if (!S.loaded) return;
    if (S.pan) { S.ox = S.pan.ox - (e.clientX - S.pan.x); S.oy = S.pan.oy - (e.clientY - S.pan.y); clampView(); render(); return; }
    const [x, y] = toImg(e);
    S.cursor = [x, y];
    const rc = S.canvas.getBoundingClientRect();
    S.inCanvas = e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom;
    if (S.free && (e.buttons & 1) && (S.tool === "draw" || S.tool === "erase")) {      // freehand: follow the cursor while the button is held
      const last = S.drawing[S.drawing.length - 1];
      if (!S.free.active && Math.hypot(x - S.free.start[0], y - S.free.start[1]) * VS() > 4) S.free.active = true;
      if (S.free.active && (!last || Math.hypot(x - last[0], y - last[1]) * VS() >= 3)) S.drawing.push(clampPt([x, y]));
      render(); return;
    }
    if (S.drag) {
      const p = partById(S.drag.id); if (!p) return;
      if (S.drag.move) {
        const dx = x - S.drag.from[0], dy = y - S.drag.from[1];
        p.rings = p.rings.map(r => r.map(([a, b]) => [a + dx, b + dy])); S.drag.from = [x, y];
      } else p.rings[S.drag.r][S.drag.v] = clampPt([x, y]);
      S.drag.moved = true; render(); return;
    }
    if (S.tool === "edit") { const h = hitVertex(x, y); if (JSON.stringify(h) !== JSON.stringify(S.hover)) { S.hover = h; render(); } }
    if ((S.tool === "draw" || S.tool === "erase") && S.drawing.length) render();
    else if (S.mag) drawMagnifier();
  }
  function onUp() {
    if (S.pan) { S.pan = null; setTool(S.tool, true); return; }
    if (S.free) {
      const fr = S.free; S.free = null;
      if (fr.active) {
        // simplify the traced line, then close the shape if the stroke started a new one
        const head = S.drawing.slice(0, fr.startLen), stroke = S.drawing.slice(fr.startLen);
        S.drawing = head.concat(simplifyOpen(stroke, 0.8 / VS()));
        if (fr.startLen === 0 && S.drawing.length >= 3) finishDrawing(); else render();
      }
      return;
    }
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    const p = partById(d.id);
    if (d.moved && p) {
      S.history.push(d.start); if (S.history.length > 60) S.history.shift(); S.future = [];
      const L = p.layer;
      const had = true;
      p.rings = roundRings(p.rings);
      normalizeLayer(S.F, L); markHuman(S.F, L, had);
      if (!S.F.polys.some(q => q.id === S.selected)) S.selected = null;
      changed();
    }
  }
  function onDbl(e) {
    if (!S.loaded || S.busy) return;
    const [x, y] = toImg(e);
    if (S.tool === "draw" || S.tool === "erase") { finishDrawing(); return; }
    if (S.tool === "edit") {
      const ed = hitEdge(x, y);
      if (ed) { const p = partById(ed.id); humanEdit(p.layer, () => p.rings[ed.r].splice(ed.i + 1, 0, [r1(x), r1(y)])); }
    }
  }
  function onKey(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (!S.loaded || S.busy) return;
    if (!document.querySelector("#fov-canvas") || !document.querySelector("#fov-canvas").offsetParent) return;  // editor tab hidden
    if (e.key === "Enter") { finishDrawing(); e.preventDefault(); }
    else if (e.key === "Escape") { S.drawing = []; S.selected = null; render(); }
    else if (e.key === "Backspace" || e.key === "Delete") {
      if (S.drawing.length) { S.drawing.pop(); render(); } else deleteSelected();
      e.preventDefault();
    }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.shiftKey ? redo() : undo(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { redo(); e.preventDefault(); }
    else if (e.shiftKey && !e.ctrlKey && !e.metaKey && /^Digit[123]$/.test(e.code)) {
      moveSelected({ Digit1: "water", Digit2: "blocked", Digit3: "exclude" }[e.code]); e.preventDefault();
    }
    else if (e.key === "+" || e.key === "=") zoomBy(1.4);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.4);
    else if (e.key === "0") zoomFit();
    else if (e.key === " ") { S.space = true; if (S.canvas) S.canvas.style.cursor = "grab"; e.preventDefault(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "m") { toggleMag(); return; }
      if (k === "d") setTool("draw"); else if (k === "e") setTool("edit"); else if (k === "w") setTool("wand"); else if (k === "x") setTool("erase");
      else if (k === "1") setLayer("water"); else if (k === "2") setLayer("blocked"); else if (k === "3") setLayer("exclude");
      else if (k === "r") toggleReviewed();
    }
  }
  // move the selected piece to another layer (fixes a piece drawn on the wrong layer)
  function moveSelected(L2) {
    const p = partById(S.selected);
    if (!p) { setStatus("Select a piece first: choose Edit (E) and click the shape", "err"); return; }
    if (p.layer === L2) return;
    snapshot();
    const L1 = p.layer, had2 = layerParts(S.F, L2).length > 0;
    p.layer = L2; p.source = "manual";
    normalizeLayer(S.F, L2);
    markHuman(S.F, L1, true); markHuman(S.F, L2, had2);
    if (!S.F.polys.some(q => q.id === S.selected)) S.selected = null;
    setLayer(L2); changed();
    setStatus(`Moved the piece from ${LAYERS[L1].label} to ${LAYERS[L2].label}`, "ok");
  }
  function updateSelectionUI() {
    const has = S.loaded && S.selected != null && !!partById(S.selected);
    document.querySelectorAll("[data-fov-move]").forEach(b => { b.disabled = !has; });
    const lab = $("fov-sel-label");
    if (lab) lab.textContent = has ? `Selected: ${LAYERS[partById(S.selected).layer].label}` : "No piece selected";
  }
  function deleteSelected() {
    const p = partById(S.selected); if (!p) return;
    humanEdit(p.layer, () => { S.F.polys = S.F.polys.filter(q => q !== p); });
  }
  function clearLayer(L) {
    if (!layerParts(S.F, L).length) return;
    humanEdit(L, () => { S.F.polys = S.F.polys.filter(p => p.layer !== L); });
  }
  function toggleReviewed() { if (!S.loaded) return; snapshot(); S.F.meta.reviewed = !S.F.meta.reviewed; changed(); }

  function toggleMag() { S.mag = !S.mag; const b = $("fov-mag-btn"); if (b) b.classList.toggle("active", S.mag); render(); }
  function setTool(t, keepDrawing) {
    S.tool = t; if (!keepDrawing) S.drawing = [];
    document.querySelectorAll("[data-fov-tool]").forEach(b => b.classList.toggle("active", b.dataset.fovTool === t));
    if (S.canvas) S.canvas.style.cursor = t === "edit" ? "default" : "crosshair";
    const hint = $("fov-hint");
    if (hint) hint.innerHTML = {
      draw: "Hold the mouse button and trace round the area (the shape closes when you let go), or click point by point and close with a double-click or <kbd>Enter</kbd> · overlapping shapes on the same layer fuse",
      edit: "Click a shape to select it · drag a vertex or the whole shape · double-click an edge to add a vertex · <kbd>Shift</kbd>+click a vertex to remove it · <kbd>Shift</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> moves the selected piece to water/blocked/bait arm",
      wand: "Click on an object (e.g. a bommie) to outline it · each click adds to the active layer · lower tolerance = tighter outline",
      erase: "Trace (hold and drag) or click a polygon to cut it out of the active layer, e.g. trim a wand leak or open a hole"
    }[t];
    render();
  }
  function setLayer(L) {
    S.layer = L;
    document.querySelectorAll("[data-fov-layer]").forEach(b => b.classList.toggle("active", b.dataset.fovLayer === L));
  }
  function runAutoWater() {
    if (!S.loaded || S.busy) return;
    if (layerParts(S.F, "water").length && !confirm("Replace the water-column layer with an automatic estimate?")) return;
    setStatus("Detecting water column…", "pending");
    setTimeout(() => {
      const sens = +($("fov-auto-sens") ? $("fov-auto-sens").value : 5);
      snapshot();
      replaceLayer(S.F, "water", autoWater(S.F, sens), "auto");
      setMachine(S.F, "water", "auto"); S.F.meta.auto_sensitivity = sens;
      setLayer("water"); changed();
    }, 10);
  }
  // bait arm: ask R for the hand-drawn bait-arm masks in this project, then fit one here
  function requestFitArm() {
    if (!S.loaded || S.busy) return;
    if (layerParts(S.F, "exclude").length && !confirm("Replace the bait-arm layer on this frame with a fitted outline?")) return;
    if (S.pendingSend) sendState();
    setStatus("Finding the bait arm…", "pending");
    shiny("fov_arm_request", Date.now());
  }
  function fitArmCurrent(msg) {
    if (!S.loaded) return;
    const anns = msg.templates || [];
    setStatus("Finding the bait arm…", "pending");
    setTimeout(() => {
      const r = findArm(S.F, anns);
      if (!r) { setStatus("No bait arm found on this frame. Draw it by hand on the Bait arm layer.", "err"); return; }
      snapshot();
      replaceLayer(S.F, "exclude", r.parts, "auto"); setMachine(S.F, "exclude", "auto");
      S.F.meta.arm_fit = { how: r.how, from: r.from, score: Math.round(r.score * 100) / 100 };
      setLayer("exclude"); changed();
      setStatus(`Bait arm found (${r.how}). Check it and adjust with Edit if needed.`, "ok");
    }, 10);
  }
  // "Predict this image": ask R for the reviewed training set, then predict here
  function requestPredictCurrent() {
    if (!S.loaded || S.busy) return;
    if ((layerParts(S.F, "water").length || layerParts(S.F, "blocked").length) &&
        !confirm("Replace the water and blocked layers on this image with the model's prediction?")) return;
    if (S.pendingSend) sendState();
    setStatus("Fetching reviewed images for training…", "pending");
    shiny("fov_train_request", Date.now());
  }
  async function predictCurrent(msg) {
    if (!S.loaded) return;
    S.busy = true;
    try {
      const model = await getModel(msg.train || [], (t) => setStatus(t, "pending"));
      setStatus("Predicting…", "pending"); await sleep(0);
      const pr = predictFrame(S.F, model);
      snapshot();
      replaceLayer(S.F, "water", pr.water, "model"); setMachine(S.F, "water", "model");
      replaceLayer(S.F, "blocked", pr.blocked, "model"); setMachine(S.F, "blocked", "model");
      S.F.meta.reviewed = false;
      S.busy = false; changed();
      setTimeout(() => setStatus(`Predicted with a model trained on ${model.nImages} reviewed image(s) — check, edit, then mark reviewed`, "ok"), 650);
    } catch (e) { S.busy = false; setStatus(e.message, "err"); alert(e.message); }
  }

  /* =====================================================================
     BATCH (auto water / model) over many images, offscreen
     ===================================================================== */
  const B = { running: false, cancel: false };
  function batchUI(text, frac) {
    const el = $("fov-batch-progress"); if (!el) return;
    el.style.display = text ? "flex" : "none";
    const t = el.querySelector(".txt"), bar = el.querySelector(".bar > span");
    if (t) t.textContent = text || "";
    if (bar) bar.style.width = Math.round(100 * (frac || 0)) + "%";
  }
  function requestBatch(mode) {
    if (B.running) return;
    if (S.pendingSend) sendState();
    const scope = $("fov-batch-scope") ? $("fov-batch-scope").value : "unannotated";
    const sens = +($("fov-auto-sens") ? $("fov-auto-sens").value : 5);
    shiny("fov_batch_request", JSON.stringify({ mode, scope, sens }));
  }
  async function runBatch(msg) {
    if (B.running) return;
    const items = msg.items || [];
    if (!items.length) { alert("No images in that scope — nothing to do."); return; }
    B.running = true; B.cancel = false; S.busy = true;
    let done = 0, skipped = 0, model = null;
    try {
      if (msg.mode === "model") model = await getModel(msg.train || [], (t) => batchUI(t, 0));
      for (let i = 0; i < items.length && !B.cancel; i++) {
        batchUI(`${{ model: "Predicting", arm: "Finding bait arm", auto: "Auto water" }[msg.mode] || "Working"}: ${i + 1} of ${items.length} — ${items[i].image}`, i / items.length);
        await sleep(0);
        const img = await loadImage(items[i].src);
        const F = frameFrom(img, items[i].image, items[i].annotation || null);
        let touched = false;
        if (msg.mode === "arm") {
          if (machineMayReplace(F, "exclude") && F.meta.methods.exclude !== "template") {
            const r = findArm(F, msg.arms || []);
            if (r) { replaceLayer(F, "exclude", r.parts, "auto"); setMachine(F, "exclude", "auto"); F.meta.arm_fit = { how: r.how, from: r.from, score: Math.round(r.score * 100) / 100 }; touched = true; }
          }
          if (!touched) { skipped++; continue; }
          F.meta.reviewed = false;
          F.meta.last_batch = { mode: msg.mode, by: USER, at: new Date().toISOString() };
          shiny("fov_batch_save", JSON.stringify(serialise(F)));
          done++; continue;
        }
        if (!layerParts(F, "exclude").length && msg.template) applyTemplate(F, msg.template);
        if (msg.mode === "auto") {
          if (machineMayReplace(F, "water")) {
            replaceLayer(F, "water", autoWater(F, msg.sens || 5), "auto"); setMachine(F, "water", "auto"); F.meta.auto_sensitivity = msg.sens || 5; touched = true;
          }
        } else {
          const pr = predictFrame(F, model);
          if (machineMayReplace(F, "water")) { replaceLayer(F, "water", pr.water, "model"); setMachine(F, "water", "model"); touched = true; }
          if (machineMayReplace(F, "blocked")) { replaceLayer(F, "blocked", pr.blocked, "model"); setMachine(F, "blocked", "model"); touched = true; }
        }
        if (!touched) { skipped++; continue; }
        F.meta.reviewed = false;
        F.meta.last_batch = { mode: msg.mode, by: USER, at: new Date().toISOString() };
        shiny("fov_batch_save", JSON.stringify(serialise(F)));
        done++;
      }
      batchUI(`${B.cancel ? "Stopped" : "Finished"}: ${done} image(s) updated${skipped ? `, ${skipped} skipped (layers edited by hand)` : ""}. Review them in the gallery.`, 1);
    } catch (e) {
      batchUI("Batch stopped: " + e.message, 0); alert(e.message);
    }
    B.running = false; S.busy = false;
    shiny("fov_batch_done", JSON.stringify({ done, skipped, mode: msg.mode, t: Date.now() }));
  }

  /* =====================================================================
     GALLERY
     ===================================================================== */
  const G = { items: new Map(), filter: "all", current: null, observer: null };
  const THUMB_W = 260;
  function itemStatus(it) {
    if (!it.ann) return "none";
    if (it.ann.meta && it.ann.meta.reviewed) return "reviewed";
    return (it.ann.polygons && it.ann.polygons.length) ? "review" : "none";
  }
  const STATUS_LABEL = { none: "Not annotated", review: "Needs review", reviewed: "Reviewed" };
  function setGallery(msg) {
    G.items = new Map();
    (msg.items || []).forEach(it => G.items.set(it.image, { image: it.image, src: it.src, ann: parseAnn(it.annotation) }));
    buildGallery();
  }
  function parseAnn(a) { if (!a) return null; try { return typeof a === "string" ? JSON.parse(a) : a; } catch (e) { return null; } }
  function updateGalleryItem(it) {
    const old = G.items.get(it.image);
    G.items.set(it.image, { image: it.image, src: it.src, ann: parseAnn(it.annotation), img: old && old.img });
    const card = document.querySelector(`.fov-card[data-image="${CSS.escape(it.image)}"]`);
    if (card) fillCard(card, G.items.get(it.image));
    updateGalleryCounts(); applyFilter();
  }
  function buildGallery() {
    const grid = $("fov-gallery"); if (!grid) return;
    grid.innerHTML = "";
    if (G.observer) G.observer.disconnect();
    G.observer = window.IntersectionObserver ? new IntersectionObserver((ents) => ents.forEach(en => {
      if (en.isIntersecting) { drawThumb(en.target); G.observer.unobserve(en.target); }
    }), { rootMargin: "300px" }) : null;
    G.items.forEach(it => {
      const card = document.createElement("div");
      card.className = "fov-card"; card.dataset.image = it.image;
      card.innerHTML = `<canvas width="${THUMB_W}" height="${Math.round(THUMB_W * 9 / 16)}"></canvas>
        <div class="fov-card-body"><div class="fov-card-name" title="${it.image}"></div>
        <div class="fov-card-row"><span class="fov-badge"></span><span class="fov-card-metrics"></span></div>
        <div class="fov-card-by"></div></div>`;
      card.querySelector(".fov-card-name").textContent = it.image;
      card.addEventListener("click", () => shiny("fov_goto", it.image));
      grid.appendChild(card);
      fillCard(card, it, true);
      if (G.observer) G.observer.observe(card); else drawThumb(card);
    });
    updateGalleryCounts(); applyFilter(); highlightGallery();
  }
  function fillCard(card, it, noDraw) {
    const st = itemStatus(it);
    card.dataset.status = st;
    const b = card.querySelector(".fov-badge"); b.className = "fov-badge " + st; b.textContent = STATUS_LABEL[st];
    const m = it.ann && it.ann.metrics, mm = card.querySelector(".fov-card-metrics");
    if (m) {
      const w = m.percent_water_col != null ? m.percent_water_col : m.pc_water_col, bl = m.percent_blocked != null ? m.percent_blocked : m.pc_blocked;
      mm.textContent = `water ${(+w).toFixed(0)}% · blocked ${(+bl).toFixed(0)}%`;
    } else mm.textContent = "";
    const by = card.querySelector(".fov-card-by"), who = it.ann && it.ann.meta && (it.ann.meta.updated_by || it.ann.meta.annotator);
    if (by) by.textContent = it.ann ? (who ? `Edited by ${who}, ${fmtTime(it.ann.updated)}` : `Edited ${fmtTime(it.ann.updated)}`) : "Click to start annotating";
    if (!noDraw && card.dataset.drawn) drawThumb(card);
  }
  async function drawThumb(card) {
    const it = G.items.get(card.dataset.image); if (!it) return;
    try {
      if (!it.img) it.img = await loadImage(it.src);
      const im = it.img, cv = card.querySelector("canvas"), W = im.naturalWidth, H = im.naturalHeight;
      cv.width = THUMB_W; cv.height = Math.round(THUMB_W * H / W);
      const g = cv.getContext("2d"), s = THUMB_W / W;
      g.drawImage(im, 0, 0, cv.width, cv.height);
      if (it.ann && it.ann.polygons) {
        const fx = it.ann.width ? W / it.ann.width : 1, fy = it.ann.height ? H / it.ann.height : 1;
        const polys = it.ann.polygons.map(p => ({ layer: p.layer, rings: [p.points].concat(p.holes || []).map(r => r.map(q => [q[0] * fx, q[1] * fy])) }));
        drawParts(g, polys, s, { thin: true });
      }
      card.dataset.drawn = "1";
    } catch (e) { /* missing image */ }
  }
  function updateGalleryCounts() {
    const c = { all: 0, none: 0, review: 0, reviewed: 0 };
    G.items.forEach(it => { c.all++; c[itemStatus(it)]++; });
    document.querySelectorAll("[data-gfilter]").forEach(b => {
      const k = b.dataset.gfilter, n = b.querySelector(".n"); if (n) n.textContent = c[k];
    });
    const tr = $("fov-train-info");
    if (tr) tr.textContent = `${c.reviewed} reviewed image(s) available for training` + (c.reviewed < 10 ? " — 10+ recommended" : "");
  }
  function applyFilter() {
    document.querySelectorAll("[data-gfilter]").forEach(b => b.classList.toggle("active", b.dataset.gfilter === G.filter));
    document.querySelectorAll(".fov-card").forEach(c => { c.style.display = (G.filter === "all" || c.dataset.status === G.filter) ? "" : "none"; });
  }
  function highlightGallery() {
    document.querySelectorAll(".fov-card").forEach(c => c.classList.toggle("current", c.dataset.image === G.current));
  }

  /* =====================================================================
     wiring
     ===================================================================== */
  function init() {
    S.canvas = $("fov-canvas"); if (!S.canvas) return;
    S.ctx = S.canvas.getContext("2d");
    S.canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    S.canvas.addEventListener("dblclick", onDbl);
    S.canvas.addEventListener("contextmenu", e => e.preventDefault());
    window.addEventListener("keydown", onKey);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || document.body.classList.contains("fov-authed")) return;
      const btn = document.querySelector("#fov-auth .btn-primary"); if (btn) { e.preventDefault(); btn.click(); }
    });
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(() => resize()).observe($("fov-canvas-wrap"));

    document.querySelectorAll("[data-fov-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.fovTool)));
    document.querySelectorAll("[data-fov-layer]").forEach(b => b.addEventListener("click", () => setLayer(b.dataset.fovLayer)));
    document.querySelectorAll("[data-gfilter]").forEach(b => b.addEventListener("click", () => { G.filter = b.dataset.gfilter; applyFilter(); }));
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on("fov-auto", "click", runAutoWater);
    on("fov-predict", "click", requestPredictCurrent);
    on("fov-fit-arm", "click", requestFitArm);
    on("fov-batch-arm", "click", () => requestBatch("arm"));
    on("fov-zoom-in", "click", () => zoomBy(1.4));
    on("fov-zoom-out", "click", () => zoomBy(1 / 1.4));
    on("fov-zoom-fit", "click", zoomFit);
    on("fov-mag-btn", "click", toggleMag);
    on("fov-help-btn", "click", () => openHelp());
    document.querySelectorAll("[data-fov-move]").forEach(b => b.addEventListener("click", () => moveSelected(b.dataset.fovMove)));
    S.canvas.addEventListener("wheel", (e) => {
      if (!S.loaded) return;
      e.preventDefault();
      const r = S.canvas.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    S.canvas.addEventListener("mouseleave", () => { S.inCanvas = false; drawMagnifier(); });
    window.addEventListener("keyup", (e) => { if (e.key === " " && S.space) { S.space = false; setTool(S.tool, true); } });
    initTips(); initResultsTable();
    on("fov-undo", "click", undo);
    on("fov-redo", "click", redo);
    on("fov-delete", "click", deleteSelected);
    on("fov-clear", "click", () => { if (S.loaded && confirm("Remove the whole " + S.layer + " layer on this image?")) clearLayer(S.layer); });
    on("fov-review", "click", toggleReviewed);
    on("fov-review-next", "click", () => {
      if (!S.loaded) return;
      if (!S.F.meta.reviewed) { snapshot(); S.F.meta.reviewed = true; changed(true); }
      sendState(); shiny("fov_next", Date.now());
    });
    on("fov-batch-auto", "click", () => requestBatch("auto"));
    on("fov-batch-model", "click", () => requestBatch("model"));
    on("fov-batch-cancel", "click", () => { B.cancel = true; });
    on("fov-save-template", "click", () => {
      if (!S.loaded) return;
      const ex = layerParts(S.F, "exclude");
      if (!ex.length) { alert("Draw the bait arm / canister on the Exclude layer first."); return; }
      shiny("fov_save_template", JSON.stringify({ width: S.F.W, height: S.F.H, polygons: ex.map(p => ({ layer: "exclude", points: p.rings[0], holes: p.rings.slice(1) })) }));
    });
    on("fov-apply-template", "click", () => shiny("fov_apply_template", Date.now()));
    ["water", "blocked", "exclude"].forEach(L => on("fov-hide-" + L, "change", render));
    on("fov-range", "change", e => { if (!S.loaded) return; const v = e.target.value; S.F.meta.range_m = v === "" ? null : +v; changed(); });
    on("fov-notes", "change", e => { if (!S.loaded) return; S.F.meta.notes = e.target.value; changed(); });
    on("fov-annotator", "change", e => { if (!S.loaded) return; S.F.meta.annotator = e.target.value; changed(); });
    on("fov-auto-sens", "input", e => { const o = $("fov-auto-sens-val"); if (o) o.textContent = e.target.value; });
    on("fov-wand-tol", "input", e => { const o = $("fov-wand-tol-val"); if (o) o.textContent = e.target.value; });
    window.addEventListener("beforeunload", (e) => { if (S.pendingSend) { sendState(); e.preventDefault(); e.returnValue = ""; } });
    // redraw when the Annotate tab becomes visible again
    document.addEventListener("shown.bs.tab", () => setTimeout(resize, 30));
    // layer colours / opacity
    let style = loadLayerStyle(); applyLayerStyle(style);
    const restyle = () => {
      Object.keys(STYLE_DEFAULT).forEach(L => {
        const c = $("fov-col-" + L), a = $("fov-alpha-" + L);
        if (c && a) style[L] = [c.value, +a.value];
      });
      applyLayerStyle(style); saveLayerStyle(style); render();
    };
    const redrawThumbs = () => document.querySelectorAll(".fov-card[data-drawn]").forEach(c => drawThumb(c));
    Object.keys(STYLE_DEFAULT).forEach(L => {
      ["col", "alpha"].forEach(k => { on(`fov-${k}-${L}`, "input", restyle); on(`fov-${k}-${L}`, "change", redrawThumbs); });
    });
    on("fov-style-reset", "click", () => { style = Object.assign({}, STYLE_DEFAULT); applyLayerStyle(style); saveLayerStyle(style); render(); redrawThumbs(); });
    setTool("draw"); setLayer("water");
  }

  function bindShiny() {
    if (!window.Shiny || !Shiny.addCustomMessageHandler) return false;
    Shiny.addCustomMessageHandler("fov_load", load);
    Shiny.addCustomMessageHandler("fov_saved", (m) => {
      setStatus("Saved at " + m.time + ". This frame stays editable; come back to it any time.", "ok");
      const le = $("fov-lastedit"); if (le && USER) le.textContent = "Last edited by " + USER + " just now";
    });
    Shiny.addCustomMessageHandler("fov_auth", (m) => { USER = m.user; document.body.classList.add("fov-authed"); });
    Shiny.addCustomMessageHandler("fov_project", (m) => {
      document.body.classList.add("fov-has-project");
      MODEL.key = null; MODEL.trees = null;
      setTimeout(resize, 50);
    });
    Shiny.addCustomMessageHandler("fov_template", (m) => {
      if (!S.loaded) return;
      if (!m.template) { alert("No bait-arm template saved yet."); return; }
      snapshot();
      if (applyTemplate(S.F, m.template)) changed();
    });
    Shiny.addCustomMessageHandler("fov_note", (m) => setStatus(m.text, m.cls || "ok"));
    Shiny.addCustomMessageHandler("fov_gallery", setGallery);
    Shiny.addCustomMessageHandler("fov_gallery_item", updateGalleryItem);
    Shiny.addCustomMessageHandler("fov_batch_start", runBatch);
    Shiny.addCustomMessageHandler("fov_train_data", predictCurrent);
    Shiny.addCustomMessageHandler("fov_arm_data", fitArmCurrent);
    return true;
  }

  /* =====================================================================
     TOOLTIPS, HELP AND THE RESULTS TABLE
     ===================================================================== */
  // any element with data-tip="..." gets an instant tooltip; data-tip-title adds a bold heading
  function initTips() {
    const tip = document.createElement("div"); tip.className = "fov-tip"; document.body.appendChild(tip);
    let cur = null;
    const show = (el) => {
      cur = el;
      const t = el.getAttribute("data-tip-title");
      tip.innerHTML = (t ? `<b>${t}</b>` : "") + `<span>${el.getAttribute("data-tip")}</span>`;
      tip.style.display = "block";
      const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2, y = r.bottom + 8;
      if (y + th > window.innerHeight - 8) y = r.top - th - 8;
      x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    document.addEventListener("mouseover", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el && el !== cur) show(el); else if (!el && cur) { cur = null; tip.style.display = "none"; } });
    document.addEventListener("mousedown", () => { cur = null; tip.style.display = "none"; });
  }
  function openHelp() { const m = $("fov-help"); if (m) m.classList.add("open"); }
  document.addEventListener("click", (e) => {
    const m = $("fov-help");
    if (m && m.classList.contains("open") && (e.target === m || (e.target.closest && e.target.closest("[data-close-help]")))) m.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => { const m = $("fov-help"); if (e.key === "Escape" && m) m.classList.remove("open"); if (e.key === "?" && !/input|textarea|select/i.test(e.target.tagName)) openHelp(); });

  // make the Results table searchable and sortable (works on whatever Shiny renders)
  const RT = { col: null, dir: 1 };
  function enhanceResults() {
    const host = $("results_tbl"); if (!host) return;
    const table = host.querySelector("table"); if (!table) return;
    if (table.dataset.enhanced) return;          // our own re-ordering also triggers the observer
    const head = table.tHead && table.tHead.rows[0], body = table.tBodies[0]; if (!head || !body) return;
    table.dataset.enhanced = "1";
    Array.from(head.cells).forEach((th, i) => {
      if (th.dataset.sortable) return;
      th.dataset.sortable = "1"; th.classList.add("fov-sortable"); th.title = "Click to sort";
      th.addEventListener("click", () => { RT.dir = RT.col === i ? -RT.dir : 1; RT.col = i; sortResults(); });
    });
    Array.from(body.rows).forEach(tr => {
      if (tr.dataset.bound) return;
      tr.dataset.bound = "1"; tr.classList.add("fov-row-link"); tr.title = "Open this frame in Annotate";
      tr.addEventListener("click", () => { const img = tr.cells[0] && tr.cells[0].textContent.trim(); if (img) shiny("fov_goto", img); });
    });
    if (RT.col != null) sortResults(); else filterResults();
  }
  function sortResults() {
    const table = $("results_tbl") && $("results_tbl").querySelector("table"); if (!table) return;
    const body = table.tBodies[0], rows = Array.from(body.rows), i = RT.col;
    const val = (tr) => { const t = (tr.cells[i] ? tr.cells[i].textContent : "").trim(); const n = parseFloat(t); return t === "" ? null : (isNaN(n) || !/^-?[\d.]+$/.test(t) ? t.toLowerCase() : n); };
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * RT.dir;
    });
    rows.forEach(r => body.appendChild(r));
    Array.from(table.tHead.rows[0].cells).forEach((th, k) => th.dataset.dir = k === i ? (RT.dir > 0 ? "asc" : "desc") : "");
    filterResults();
  }
  function filterResults() {
    const table = $("results_tbl") && $("results_tbl").querySelector("table"); if (!table) return;
    const q = ($("fov-results-search") ? $("fov-results-search").value : "").trim().toLowerCase();
    const st = $("fov-results-status") ? $("fov-results-status").value : "";
    const terms = q.split(/\s+/).filter(Boolean);
    let shown = 0, total = 0;
    Array.from(table.tBodies[0].rows).forEach(tr => {
      total++;
      const txt = tr.textContent.toLowerCase();
      const ok = terms.every(t => txt.includes(t)) && (!st || (tr.cells[1] && tr.cells[1].textContent.trim() === st));
      tr.style.display = ok ? "" : "none"; if (ok) shown++;
    });
    const c = $("fov-results-count"); if (c) c.textContent = `${shown} of ${total} frames`;
  }
  function initResultsTable() {
    const host = $("results_tbl");
    if (host && window.MutationObserver) new MutationObserver(() => enhanceResults()).observe(host, { childList: true, subtree: true });
    const sb = $("fov-results-search"); if (sb) sb.addEventListener("input", filterResults);
    const ss = $("fov-results-status"); if (ss) ss.addEventListener("change", filterResults);
    enhanceResults();
  }

  document.addEventListener("DOMContentLoaded", () => {
    init();
    if (!bindShiny()) document.addEventListener("shiny:connected", bindShiny, { once: true });
  });

  // exposed for testing and for power users in the browser console
  window.FOV = {
    S, G, B, MODEL, load, frameFrom, serialise, computeMetrics, autoWater, magicWand, normalizeLayer, eraseFromLayer,
    addParts, replaceLayer, traceMask, getModel, predictFrame, frameFeatures, runBatch, setGallery, updateGalleryItem,
    predictCurrent, setTool, setLayer, runAutoWater, undo, redo, toggleReviewed, loadImage, applyTemplate, layerParts,
    fitArm, fitArmPixels, findArm, detectBarPixels, pickTemplates, systemKey, moveSelected, zoomAt, zoomFit, toggleMag, fitArmCurrent, enhanceResults
  };
})();
