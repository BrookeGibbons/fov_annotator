# Generated from the stand-alone FOV annotator app (app.R v5).
# Internal functions: the only exported functions are in run.R.
# Builds the user interface. Called when the app starts, so nothing is evaluated at install time.
fov_ui <- function(request) {
  logo <- HTML('<svg class="fov-logo" viewBox="0 0 64 40" aria-hidden="true">
    <path d="M22 20 L62 4 M22 20 L62 36" stroke="currentColor" stroke-width="1.6" fill="none" stroke-dasharray="3 3" opacity=".7"/>
    <rect x="3" y="11" width="18" height="18" rx="3" fill="currentColor"/>
    <circle cx="17" cy="20" r="4.2" fill="#0F2A36"/><circle cx="17" cy="20" r="1.8" fill="#2B7FD0"/>
    <path d="M21 26 L44 26" stroke="currentColor" stroke-width="2.2"/>
    <rect x="44" y="22" width="7" height="8" rx="1.5" fill="#F25C05"/></svg>')

  slider <- function(id, label, min, max, value) {
    tags$label(class = "fov-slider", label,
               tags$input(type = "range", id = id, min = min, max = max, value = value, step = 1),
               tags$span(id = paste0(id, "-val"), value))
  }
  swatch <- function(cls) span(class = paste("fov-swatch", cls))

  # ---- auth overlay (shown until signed in) ----
  auth_overlay <- div(
    id = "fov-auth", class = "fov-auth",
    div(class = "fov-auth-inner",
        div(class = "fov-auth-brand", logo, span("FOV annotator")),
        div(class = "fov-auth-card", uiOutput("auth_form")),
        p(class = "fov-auth-foot", "Measure the water column, seabed and blockages in every frame. Your annotations stay editable.")))

  # ---- Home ----
  home_ui <- div(
    class = "fov-home",
    div(class = "fov-hero",
        div(class = "fov-hero-text",
            h1("FOV annotator"),
            p(class = "lead", "Each still is partitioned into open water column, seabed and areas blocked by nearby structure, ",
              "after removing the bait arm. The proportions describe how much of the scene a camera could actually sample ",
              "and can be used as covariates when modelling counts from baited remote underwater video."),
            div(class = "fov-hero-actions",
                tags$a(href = "#fov-projects", class = "fov-cta", "Open a project"),
                tags$a(href = "#fov-how", class = "fov-cta ghost", "Definitions and methods"))),
        tags$figure(class = "fov-hero-fig",
                    tags$img(src = "fovassets/fov-example.jpg", alt = "Annotated BRUVS frame: water column, seabed, a sea fan blocking the view and the bait arm"),
                    tags$figcaption("Annotated frame (South-west Corner, SWC-BV-240). A, water column (44% of the field of view); ",
                                    "B, seabed (56%), which includes C, the sea fan blocking the view behind the bait (21%). ",
                                    "The bait arm and bag (3% of the image) are excluded from the field of view."))),

    div(class = "fov-section", id = "fov-projects",
        h2("Projects"),
        p(class = "fov-sub", "A project links a folder of frames to a set of annotations. All members of a project read and edit the same annotations."),
        uiOutput("projects_ui")),

    div(class = "fov-section fov-cols", id = "fov-how",
        div(h2("Definitions"),
            p(class = "fov-sub", "The field of view (FOV) is the image area minus the excluded layer (bait arm, bag, canister and frame). All values are percentages of the FOV."),
            tags$dl(class = "fov-defs-list",
                    tags$dt(swatch("water"), "% water column (", tags$code("percent_water_col"), ")"),
                    tags$dd("Area of open water, excluding any part covered by the blocked layer, divided by the FOV."),
                    tags$dt(swatch("seabed"), "% seabed (", tags$code("percent_seabed"), ")"),
                    tags$dd("100 \u2212 % water column. Includes blocked areas."),
                    tags$dt(swatch("blocked"), "% blocked (", tags$code("percent_blocked"), ")"),
                    tags$dd("Area occupied by structure close behind the bait canister (e.g. bommies, boulders, kelp) that obstructs the view beyond it, divided by the FOV."),
                    tags$dt(swatch("exclude"), "% excluded (", tags$code("percent_excluded"), ")"),
                    tags$dd("Share of the whole image removed as bait arm and frame; reported for quality control."),
                    tags$dt("range (", tags$code("range_m"), ")"),
                    tags$dd("Visibility range beyond the canister in metres, entered by the annotator."))),
        div(h2("Recommended workflow"),
            tags$ol(class = "fov-steps",
                    tags$li(strong("Bait arm. "), "Run ", em("Find bait arm"), " from the Gallery and correct the results; arms you draw by hand are also used as templates for later runs."),
                    tags$li(strong("Water column. "), "Run ", em("Auto water column"), " on all frames. Each result is flagged ", em("needs review"), "."),
                    tags$li(strong("Review. "), "Correct a varied subset (at least 10 frames spanning sites, depths and visibility), add blocked areas, and mark each frame reviewed."),
                    tags$li(strong("Predict. "), "Train the pixel classifier on the reviewed frames and apply it to the remainder; review its output in turn. Each correction enlarges the training set.")))),

    div(class = "fov-section fov-cols",
        div(h2("Methods"),
            tags$dl(class = "fov-defs-list",
                    tags$dt("Automatic water column"),
                    tags$dd("Each frame is reduced to 240 px wide. Seabed evidence is computed per pixel from (i) local texture (Sobel gradient magnitude) and (ii) chromatic departure, both standardised against the top 15% of the frame, and (iii) colour similarity to the bottom 15% relative to the top, which detects low-contrast sand in turbid or dark frames. A horizontal morphological opening removes thin vertical objects (fish, bait line, hooks). A single horizon per column is then chosen by dynamic programming, minimising seabed evidence above the line and water evidence below it with a truncated linear penalty on vertical steps. On 33 reviewed frames from three regions the mean absolute error in % water column was 0.7 percentage points."),
                    tags$dt("Pixel classifier (Predict)"),
                    tags$dd("A random forest of 30 trees is trained in the browser on up to 2,500 pixels per class per reviewed frame, using colour (YCbCr), texture at two scales, local contrast, colour relative to the top of the frame, image position and the automatic horizon. Predictions are smoothed morphologically; water must connect to the top of the frame. Unreviewed frames are never used for training."),
                    tags$dt("Bait-arm detection"),
                    tags$dd("The arm is located from its shape and colour: straight edges are extracted with an orientation-weighted Hough transform, and the arm is taken as the best pair of near-parallel edges that enter from the frame border with uniform colour between them. Width is measured perpendicular to the arm and fitted as a linear taper; the bait bag is the red region (CIELAB a* above its surroundings) nearest the arm tip. Hand-drawn arms in the project are also fitted as templates (translation, \u00b110\u00b0 rotation, \u00b115% scale), and the candidate whose outline best follows the image gradient is retained."))),
        div(h2("Data and reproducibility"),
            tags$ul(class = "fov-plain",
                    tags$li("Outlines are stored as polygons in original image pixels (one JSON file per frame), so they can be re-edited or re-measured at any time."),
                    tags$li("Every layer records how it was produced: manual, auto, model, template, or any of these followed by a manual edit."),
                    tags$li("Batch jobs never overwrite frames marked reviewed or layers edited by hand."),
                    tags$li("Each save is appended to the project's history file with time, user and resulting percentages."),
                    tags$li("Results export as one CSV per project (Results tab).")))),
    uiOutput("account_ui")
  )

  # ---- Annotate ----
  tip <- function(tag, text, title = NULL) tagAppendAttributes(tag, `data-tip` = text, `data-tip-title` = title)
  tbtn <- function(..., tip_text, tip_title = NULL) tip(tags$button(...), tip_text, tip_title)

  toolbar <- div(
    class = "fov-toolbar",
    div(class = "fov-toolrow",
        div(class = "fov-group",
            span(class = "fov-group-label", "Layer"),
            tbtn(class = "fov-btn", `data-fov-layer` = "water", swatch("water"), "Water (A)",
                 tip_title = "Water column layer (key 1)", tip_text = "Open water visible above and between the seabed. New shapes, wand clicks and erasing apply to the active layer."),
            tbtn(class = "fov-btn", `data-fov-layer` = "blocked", swatch("blocked"), "Blocked (C)",
                 tip_title = "Blocked layer (key 2)", tip_text = "Objects close behind the bait canister that hide the view beyond it (bommies, boulders, kelp)."),
            tbtn(class = "fov-btn", `data-fov-layer` = "exclude", swatch("exclude"), "Bait arm",
                 tip_title = "Bait arm layer (key 3)", tip_text = "Bait arm, bag/canister and frame. Removed from the field of view before any percentage is calculated.")),
        div(class = "fov-group",
            span(class = "fov-group-label", "Tool"),
            tbtn(class = "fov-btn", `data-fov-tool` = "draw", "Draw",
                 tip_title = "Draw (D)", tip_text = "Hold the mouse button and trace round an area; the shape closes when you let go. Or click point by point and double-click / Enter to close."),
            tbtn(class = "fov-btn", `data-fov-tool` = "edit", "Edit",
                 tip_title = "Edit (E)", tip_text = "Click a shape to select it, drag vertices or the whole shape, double-click an edge to add a vertex, Shift+click a vertex to delete it."),
            tbtn(class = "fov-btn", `data-fov-tool` = "wand", "Magic wand",
                 tip_title = "Magic wand (W)", tip_text = "Click an object to outline it by colour similarity. Lower tolerance gives a tighter outline."),
            tbtn(class = "fov-btn", `data-fov-tool` = "erase", "Erase",
                 tip_title = "Erase (X)", tip_text = "Trace or click a polygon; the enclosed area is cut out of the active layer."),
            tip(slider("fov-wand-tol", "tolerance", 5, 80, 40), "Colour tolerance for the magic wand (5 = strict, 80 = loose).")),
        div(class = "fov-group",
            tbtn(id = "fov-undo", class = "fov-btn", "Undo", tip_text = "Undo the last change (Ctrl/Cmd+Z)."),
            tbtn(id = "fov-redo", class = "fov-btn", "Redo", tip_text = "Redo (Ctrl/Cmd+Shift+Z)."),
            tbtn(id = "fov-clear", class = "fov-btn", "Clear layer", tip_text = "Remove every shape on the active layer of this frame."))),
    div(class = "fov-toolrow",
        div(class = "fov-group",
            span(class = "fov-group-label", "Automatic"),
            tbtn(id = "fov-auto", class = "fov-btn accent", "Auto water column",
                 tip_title = "Auto water column", tip_text = "Estimates the seabed horizon from texture and colour relative to the top and bottom of the frame and fills the water layer above it. Replaces the current water layer."),
            tip(slider("fov-auto-sens", "sensitivity", 1, 10, 5), "Higher sensitivity treats fainter texture as seabed, so the horizon moves up."),
            tbtn(id = "fov-predict", class = "fov-btn accent", "Predict",
                 tip_title = "Predict water + blocked", tip_text = "Trains a random-forest pixel classifier on the frames marked reviewed in this project and labels this frame. Replaces water and blocked layers."),
            tbtn(id = "fov-fit-arm", class = "fov-btn accent", "Find bait arm",
                 tip_title = "Find bait arm", tip_text = "Looks for a long straight bar entering from the frame edge and the red bait bag at its end. If arms have been drawn by hand in this project, it also fits those and keeps whichever outline follows the image edges better. Replaces the bait-arm layer.")),
        div(class = "fov-group",
            span(class = "fov-group-label", id = "fov-sel-label", "No piece selected"),
            tbtn(class = "fov-btn sm", `data-fov-move` = "water", disabled = NA, "\u2192 Water",
                 tip_text = "Move the selected piece to the water layer (Shift+1)."),
            tbtn(class = "fov-btn sm", `data-fov-move` = "blocked", disabled = NA, "\u2192 Blocked",
                 tip_text = "Move the selected piece to the blocked layer (Shift+2)."),
            tbtn(class = "fov-btn sm", `data-fov-move` = "exclude", disabled = NA, "\u2192 Bait arm",
                 tip_text = "Move the selected piece to the bait-arm layer (Shift+3)."),
            tbtn(id = "fov-delete", class = "fov-btn sm", "Delete piece", tip_text = "Delete the selected piece (Delete key)."))),
    div(class = "fov-toolrow fov-viewrow",
        div(class = "fov-group",
            span(class = "fov-group-label", "Show"),
            tip(tags$label(class = "fov-toggle", tags$input(type = "checkbox", id = "fov-hide-water"), swatch("water"), "hide water"),
                "Hide the water layer on screen (it is still saved and counted)."),
            tip(tags$label(class = "fov-toggle", tags$input(type = "checkbox", id = "fov-hide-blocked"), swatch("blocked"), "hide blocked"),
                "Hide the blocked layer on screen."),
            tip(tags$label(class = "fov-toggle", tags$input(type = "checkbox", id = "fov-hide-exclude"), swatch("exclude"), "hide bait arm"),
                "Hide the bait-arm layer on screen."),
            tags$details(class = "fov-style fov-dropdown",
                tip(tags$summary(class = "fov-btn sm", "Colours"), "Change layer colours and fill opacity (saved in this browser)."),
                div(class = "fov-dropdown-panel",
                    lapply(list(c("water", "Water"), c("blocked", "Blocked"), c("exclude", "Bait arm")), function(L)
                      div(class = "fov-style-row",
                          span(class = "nm", L[2]),
                          tags$input(type = "color", id = paste0("fov-col-", L[1])),
                          tags$input(type = "range", id = paste0("fov-alpha-", L[1]), min = 0, max = 100, step = 5, title = "Fill opacity (%)"),
                          tags$span(class = "val", id = paste0("fov-alpha-", L[1], "-val"), ""))),
                    tags$button(id = "fov-style-reset", class = "fov-btn sm", "Reset colours")))),
        div(class = "fov-group",
            span(class = "fov-group-label", "Zoom"),
            tbtn(id = "fov-zoom-out", class = "fov-btn sm", "\u2212", tip_text = "Zoom out (\u2212 key or mouse wheel)."),
            span(id = "fov-zoom-val", class = "fov-zoom-val", "100%"),
            tbtn(id = "fov-zoom-in", class = "fov-btn sm", "+", tip_text = "Zoom in (+ key or mouse wheel over the image). Pan with the middle mouse button or hold Space and drag."),
            tbtn(id = "fov-zoom-fit", class = "fov-btn sm", "Fit", tip_text = "Show the whole frame (0 key)."),
            tbtn(id = "fov-mag-btn", class = "fov-btn sm", "Magnifier", tip_text = "Show a 4\u00d7 inset around the cursor for precise tracing (M key).")),
        div(class = "fov-group",
            tbtn(id = "fov-help-btn", class = "fov-btn sm", "? Help", tip_text = "How each tool works, keyboard shortcuts and definitions (? key).")))
  )

  help_modal <- div(
    id = "fov-help", class = "fov-modal",
    div(class = "fov-modal-card",
        tags$button(class = "fov-modal-close", `data-close-help` = NA, "\u00d7"),
        h3("Annotating a frame"),
        tags$table(class = "fov-help-table",
          tags$tbody(
            tags$tr(tags$th("Layers"), tags$td(strong("Water (A)"), " open water column; ", strong("Blocked (C)"), " objects behind the canister that hide the view beyond; ",
                                               strong("Bait arm"), " arm, bag and frame, removed from the field of view. One active layer at a time (keys 1, 2, 3).")),
            tags$tr(tags$th("Draw (D)"), tags$td("Hold the button and trace: the outline follows the cursor and closes on release. Alternatively click vertices and close with a double-click, Enter or a click on the first point. Shapes on the same layer that overlap are merged.")),
            tags$tr(tags$th("Edit (E)"), tags$td("Click a shape to select it. Drag a vertex or the shape; double-click an edge to insert a vertex; Shift+click a vertex to delete it; Delete removes the selected piece.")),
            tags$tr(tags$th("Wrong layer?"), tags$td("Select the piece with Edit, then use \u2192 Water / \u2192 Blocked / \u2192 Bait arm, or Shift+1/2/3.")),
            tags$tr(tags$th("Magic wand (W)"), tags$td("Region growing from the clicked pixel in a smoothed luminance\u2013chrominance space; tolerance sets the maximum colour distance.")),
            tags$tr(tags$th("Erase (X)"), tags$td("Trace or click a polygon; its area is subtracted from the active layer.")),
            tags$tr(tags$th("Auto water column"), tags$td("Per-pixel seabed evidence (texture and chroma departures from the top of the frame, and colour similarity to the bottom of the frame) is cleaned of thin vertical objects and a single horizon is found by dynamic programming with a smoothness penalty. Sensitivity lowers the evidence threshold.")),
            tags$tr(tags$th("Predict"), tags$td("A random forest (30 trees) is trained on pixels sampled from frames marked reviewed, using colour, texture, local context, position and the auto horizon, and applied to this frame.")),
            tags$tr(tags$th("Find bait arm"), tags$td("Straight edges are found with a Hough transform; the arm is the best pair of near-parallel edges that runs in from the frame edge with uniform colour between them. Its width is measured to the nearest parallel edges and extended to the tip, and the bait bag is the red blob (high CIELAB a*) nearest the tip. Where arms have been drawn by hand, those outlines are also fitted (shift, \u00b110\u00b0 rotation, \u00b115% scale) and the outline that best follows the image edges is kept. Always check the result.")),
            tags$tr(tags$th("View"), tags$td("Mouse wheel or +/\u2212 to zoom, 0 to fit, middle-drag or Space+drag to pan, M for the magnifier. Hide toggles and colours affect the display only.")),
            tags$tr(tags$th("Saving"), tags$td("Every change is saved automatically. R marks the frame reviewed; reviewed frames and hand edits are never overwritten by batch jobs."))))))

  metrics_panel <- tagList(
    div(class = "fov-metrics",
        div(class = "fov-metric water",   div(class = "lab", "% water column"), div(class = "val", id = "m-water", "\u2013")),
        div(class = "fov-metric seabed",  div(class = "lab", "% seabed"),       div(class = "val", id = "m-seabed", "\u2013")),
        div(class = "fov-metric blocked", div(class = "lab", "% blocked"),      div(class = "val", id = "m-blocked", "\u2013")),
        div(class = "fov-metric excl",    div(class = "lab", "% excluded"),     div(class = "val", id = "m-excluded", "\u2013"))),
    div(class = "fov-bar", id = "m-bar"),
    div(class = "fov-counts", id = "fov-counts")
  )

  annotate_ui <- tagList(
    div(class = "fov-noproject", "Open a project on the Home page to start annotating."),
    div(class = "fov-needs-project",
        layout_sidebar(
          fillable = FALSE,
          sidebar = sidebar(
            width = 320,
            div(class = "fov-project-name", textOutput("project_title", inline = TRUE)),
            selectInput("image", "Frame", choices = NULL),
            div(class = "fov-legend-line", "\u2013 not annotated   \u2022 needs review   \u2713 reviewed"),
            div(class = "d-flex gap-2",
                actionButton("prev_img", "Previous", class = "btn-sm flex-fill"),
                actionButton("next_img", "Next", class = "btn-sm flex-fill")),
            uiOutput("progress"),
            div(class = "fov-autosave", "Autosave is on. Every frame stays editable: reopen it here or from the Gallery at any time."),
            hr(),
            metrics_panel,
            hr(),
            div(class = "fov-meta",
                tags$label(`for` = "fov-range", "Visibility range beyond the canister (m)"),
                tags$input(id = "fov-range", type = "number", min = 0, step = 0.5, class = "form-control form-control-sm"),
                tags$label(`for` = "fov-notes", "Notes"),
                tags$textarea(id = "fov-notes", rows = 2, class = "form-control form-control-sm"),
                div(class = "fov-lastedit", id = "fov-lastedit")),
            hr(),
            div(class = "fov-group-label", "Bait-arm template"),
            div(class = "d-flex gap-2",
                tbtn(id = "fov-save-template",  class = "fov-btn flex-fill", "Save from this frame",
                     tip_text = "Store this frame's bait-arm outline as the project template (copied unchanged onto frames by batch jobs)."),
                tbtn(id = "fov-apply-template", class = "fov-btn flex-fill", "Apply here",
                     tip_text = "Copy the saved template onto this frame without fitting. Use Find bait arm to detect it on this frame."))
          ),
          toolbar,
          div(class = "fov-hint", id = "fov-hint"),
          div(id = "fov-canvas-wrap", tags$canvas(id = "fov-canvas"), tags$canvas(id = "fov-mag", class = "fov-mag")),
          div(class = "fov-statusbar",
              div(class = "fov-status", id = "fov-status", ""),
              div(class = "d-flex gap-2",
                  tbtn(id = "fov-review", class = "fov-btn", "Mark reviewed",
                       tip_text = "Mark this frame as checked (R). Reviewed frames are used to train Predict and are never changed by batch jobs."),
                  tbtn(id = "fov-review-next", class = "fov-btn accent", "Reviewed, next to review",
                       tip_text = "Mark reviewed and open the next frame that is not yet reviewed.")))
        )),
    help_modal
  )

  gallery_ui <- tagList(
    div(class = "fov-noproject", "Open a project on the Home page to see its frames."),
    div(class = "fov-needs-project fov-page",
        div(class = "fov-batch",
            strong("Batch"),
            tags$select(id = "fov-batch-scope", class = "form-select form-select-sm",
                        tags$option(value = "unannotated", "Frames not yet annotated"),
                        tags$option(value = "unreviewed",  "All frames not reviewed (keeps hand edits)")),
            tags$button(id = "fov-batch-auto",  class = "fov-btn accent", "Auto water column"),
            tags$button(id = "fov-batch-model", class = "fov-btn accent", "Predict water + blocked"),
            tip(tags$button(id = "fov-batch-arm", class = "fov-btn accent", "Find bait arm"),
                "Find the bait arm (straight grey bar plus red bag) on every frame in scope. Arms drawn by hand or applied from the template are left alone."),
            span(id = "fov-train-info"),
            div(id = "fov-batch-progress", span(class = "txt"), div(class = "bar", span()),
                tags$button(id = "fov-batch-cancel", class = "fov-btn", "Stop"))),
        div(class = "fov-gal-bar",
            tags$button(class = "fov-btn", `data-gfilter` = "all",      "All",           span(class = "n")),
            tags$button(class = "fov-btn", `data-gfilter` = "none",     "Not annotated", span(class = "n")),
            tags$button(class = "fov-btn", `data-gfilter` = "review",   "Needs review",  span(class = "n")),
            tags$button(class = "fov-btn", `data-gfilter` = "reviewed", "Reviewed",      span(class = "n")),
            span(class = "fov-gal-hint", "Click any frame to reopen and edit it.")),
        div(id = "fov-gallery", class = "fov-gallery"))
  )

  results_ui <- tagList(
    div(class = "fov-noproject", "Open a project on the Home page to see its results."),
    div(class = "fov-needs-project fov-page",
        div(class = "d-flex gap-2 align-items-center mb-2 flex-wrap",
            downloadButton("dl_csv", "Download CSV", class = "btn-sm"),
            downloadButton("dl_history", "Download edit history", class = "btn-sm"),
            span(class = "fov-sub", textOutput("results_path", inline = TRUE))),
        div(class = "fov-results-tools",
            tags$input(id = "fov-results-search", type = "search", class = "form-control form-control-sm",
                       placeholder = "Search frames, methods, people, notes\u2026"),
            tags$select(id = "fov-results-status", class = "form-select form-select-sm",
                        tags$option(value = "", "All statuses"), tags$option("reviewed"), tags$option("needs review"), tags$option("not annotated")),
            span(id = "fov-results-count", class = "fov-sub"),
            span(class = "fov-sub", "Click a column heading to sort; click a row to open the frame.")),
        div(class = "fov-table", tableOutput("results_tbl")))
  )

  page_navbar(
    id = "main_tabs",
    title = span(class = "fov-brand", logo, span("FOV annotator")),
    window_title = "FOV annotator",
    fillable = FALSE,
    theme = bs_theme(version = 5, bg = "#EEF2EF", fg = "#0F2A36", primary = "#F25C05", secondary = "#2B7FD0",
                     success = "#3E8E6A", base_font = "Archivo, 'Segoe UI', system-ui, sans-serif",
                     heading_font = "Archivo, 'Segoe UI', system-ui, sans-serif"),
    header = tagList(
      tags$head(
        tags$link(rel = "preconnect", href = "https://fonts.googleapis.com"),
        tags$link(rel = "stylesheet", href = "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap"),
        tags$link(rel = "stylesheet", href = "fovassets/annotator.css"),
        tags$script(src = "fovassets/annotator.js")),
      auth_overlay),
    nav_panel("Home", value = "Home", home_ui),
    nav_panel("Annotate", value = "Annotate", annotate_ui),
    nav_panel("Gallery", value = "Gallery", gallery_ui),
    nav_panel("Results", value = "Results", results_ui),
    nav_spacer(),
    nav_item(uiOutput("user_chip"))
  )
}
