# Generated from the stand-alone FOV annotator app (app.R v5).
# Internal functions: the only exported functions are in run.R.
IMG_PATTERN <- "\\.(jpe?g|png)$"
TEMPLATE_FN <- "_bait_arm_template.json"
RESULTS_FN  <- "fov_metrics.csv"
HISTORY_FN  <- "history.csv"

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a
num <- function(x) if (is.null(x) || length(x) == 0) NA_real_ else suppressWarnings(as.numeric(x))
chr <- function(x) if (is.null(x) || length(x) == 0) NA_character_ else as.character(x)

# ---------------------------------------------------------------- storage helpers
read_list <- function(path) {
  if (!file.exists(path)) return(list())
  tryCatch(jsonlite::fromJSON(path, simplifyVector = FALSE), error = function(e) list())
}
write_list <- function(x, path) {                      # atomic write
  tmp <- paste0(path, ".tmp")
  writeLines(as.character(jsonlite::toJSON(x, auto_unbox = TRUE, pretty = TRUE, null = "null")), tmp, useBytes = TRUE)
  file.rename(tmp, path)
}
ann_file  <- function(ann_dir, img) file.path(ann_dir, paste0(img, ".json"))
read_text <- function(f) if (file.exists(f)) paste(readLines(f, warn = FALSE, encoding = "UTF-8"), collapse = "\n") else ""
read_ann  <- function(f) if (file.exists(f)) tryCatch(jsonlite::fromJSON(f, simplifyVector = FALSE), error = function(e) NULL) else NULL
rand_hex  <- function(n) paste(as.character(openssl::rand_bytes(n)), collapse = "")

# ---------------------------------------------------------------- accounts
hash_pw <- function(pw, salt) {
  h <- charToRaw(paste0(salt, ":", pw))
  for (i in seq_len(20000)) h <- as.raw(as.integer(openssl::sha256(h)))
  paste(as.character(h), collapse = "")
}
valid_username <- function(u) grepl("^[A-Za-z0-9._-]{2,40}$", u)
get_users <- function() read_list(users_path())
find_user <- function(u) { for (x in get_users()) if (identical(x$username, u)) return(x); NULL }
add_user <- function(username, password, role = "member") {
  users <- get_users(); salt <- rand_hex(16)
  users[[length(users) + 1]] <- list(username = username, salt = salt, hash = hash_pw(password, salt),
                                     role = role, created = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"))
  write_list(users, users_path())
}
set_password <- function(username, password) {
  users <- get_users()
  for (i in seq_along(users)) if (identical(users[[i]]$username, username)) {
    users[[i]]$salt <- rand_hex(16); users[[i]]$hash <- hash_pw(password, users[[i]]$salt)
  }
  write_list(users, users_path())
}
check_login <- function(u, pw) { x <- find_user(u); !is.null(x) && identical(hash_pw(pw, x$salt), x$hash) }

# ---------------------------------------------------------------- projects
get_projects <- function() read_list(projects_path())
project_dir  <- function(id) file.path(fov_data_dir(), "projects", id, "annotations")
can_access   <- function(p, user, role) identical(role, "admin") || identical(p$owner, user) || user %in% unlist(p$members)
can_manage   <- function(p, user, role) identical(role, "admin") || identical(p$owner, user)

# ---------------------------------------------------------------- annotation status / results
ann_status <- function(a) {
  if (is.null(a)) return("none")
  if (isTRUE(a$meta$reviewed)) return("reviewed")
  if (length(a$polygons)) "review" else "none"
}
layer_method <- function(meta, L) {
  m <- meta$methods[[L]]
  if (is.null(m)) {
    if (L == "water" && isTRUE(meta$auto_water_used)) return(if (isTRUE(meta$edited_after_auto)) "auto+edited" else "auto")
    return(NA_character_)
  }
  if (isTRUE(meta$edited[[L]])) paste0(m, "+edited") else m
}
collect_results <- function(ann_dir) {
  files <- list.files(ann_dir, pattern = "\\.json$", full.names = TRUE)
  files <- files[!startsWith(basename(files), "_")]
  rows <- lapply(files, function(f) {
    a <- read_ann(f); if (is.null(a)) return(NULL)
    m <- a$metrics; meta <- a$meta
    layers <- vapply(a$polygons, function(p) chr(p$layer), character(1))
    data.frame(
      image             = chr(a$image),
      status            = switch(ann_status(a), reviewed = "reviewed", review = "needs review", none = "not annotated"),
      percent_water_col = num(m$percent_water_col %||% m$pc_water_col),
      percent_seabed    = num(m$percent_seabed    %||% m$pc_seabed),
      percent_blocked   = num(m$percent_blocked   %||% m$pc_blocked),
      percent_excluded  = num(m$percent_excluded  %||% m$pc_excluded),
      range_m           = num(meta$range_m),
      water_method      = layer_method(meta, "water"),
      blocked_method    = layer_method(meta, "blocked"),
      n_water_pieces    = sum(layers == "water"),
      n_blocked_pieces  = sum(layers == "blocked"),
      last_edited_by    = chr(meta$updated_by %||% meta$annotator),
      notes             = chr(meta$notes),
      updated           = chr(a$updated),
      stringsAsFactors  = FALSE)
  })
  rows <- Filter(Negate(is.null), rows)
  if (!length(rows)) return(data.frame(image = character(), status = character(), percent_water_col = numeric(),
                                       percent_seabed = numeric(), percent_blocked = numeric(), stringsAsFactors = FALSE))
  out <- do.call(rbind, rows)
  out[order(out$image), , drop = FALSE]
}
DISPLAY_NAMES <- c(percent_water_col = "% water column", percent_seabed = "% seabed", percent_blocked = "% blocked",
                   percent_excluded = "% excluded", range_m = "range (m)", water_method = "water method",
                   blocked_method = "blocked method", n_water_pieces = "water pieces", n_blocked_pieces = "blocked pieces",
                   last_edited_by = "last edited by")
