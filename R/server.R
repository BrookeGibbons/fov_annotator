# Generated from the stand-alone FOV annotator app (app.R v5).
# Internal functions: the only exported functions are in run.R.
fov_server <- function(input, output, session) {
  rv <- reactiveValues(user = NULL, role = NULL, project = NULL, ann_dir = NULL, dir = NULL, prefix = NULL,
                       images = character(), results = collect_results(file.path(tempdir(), "none")),
                       tick = 0)
  bump <- function() rv$tick <- isolate(rv$tick) + 1

  # ------------------------------------------------ authentication
  output$auth_form <- renderUI({
    rv$tick
    if (!length(get_users())) {
      tagList(h2("Set up the first account"),
              p(class = "fov-sub", "This account manages the team and can see every project."),
              textInput("setup_user", "Username"),
              passwordInput("setup_pw", "Password (8+ characters)"),
              passwordInput("setup_pw2", "Repeat password"),
              actionButton("setup_go", "Create account", class = "btn-primary w-100"),
              div(class = "fov-auth-msg", textOutput("auth_msg")))
    } else {
      tagList(h2("Sign in"),
              textInput("login_user", "Username"),
              passwordInput("login_pw", "Password"),
              actionButton("login_go", "Sign in", class = "btn-primary w-100"),
              div(class = "fov-auth-msg", textOutput("auth_msg")))
    }
  })
  auth_msg <- reactiveVal("")
  output$auth_msg <- renderText(auth_msg())

  signed_in <- function(u) {
    x <- find_user(u)
    rv$user <- u; rv$role <- x$role %||% "member"
    session$sendCustomMessage("fov_auth", list(user = u, role = rv$role))
    bump()
  }
  observeEvent(input$setup_go, {
    req(!length(get_users()))
    u <- trimws(input$setup_user)
    if (!valid_username(u)) return(auth_msg("Use 2\u201340 letters, numbers, dots, dashes or underscores."))
    if (nchar(input$setup_pw) < 8) return(auth_msg("Use at least 8 characters for the password."))
    if (!identical(input$setup_pw, input$setup_pw2)) return(auth_msg("The two passwords don't match."))
    add_user(u, input$setup_pw, "admin")
    auth_msg(""); signed_in(u)
  })
  observeEvent(input$login_go, {
    u <- trimws(input$login_user %||% "")
    if (check_login(u, input$login_pw %||% "")) { auth_msg(""); signed_in(u) }
    else { Sys.sleep(0.8); auth_msg("That username and password don't match an account.") }
  })
  observeEvent(input$logout, session$reload())

  output$user_chip <- renderUI({
    req(rv$user)
    div(class = "fov-user",
        if (!is.null(rv$project)) span(class = "fov-user-project", rv$project$name),
        span(class = "fov-user-name", rv$user, if (identical(rv$role, "admin")) span(class = "fov-role", "admin")),
        actionLink("logout", "Sign out", class = "fov-signout"))
  })

  # ------------------------------------------------ projects
  my_projects <- function() Filter(function(p) can_access(p, rv$user, rv$role), get_projects())

  project_progress <- function(p) {
    imgs <- if (dir.exists(p$image_dir)) list.files(p$image_dir, pattern = IMG_PATTERN, ignore.case = TRUE) else character()
    st <- vapply(imgs, function(i) ann_status(read_ann(ann_file(project_dir(p$id), i))), character(1))
    list(n = length(imgs), ann = sum(st != "none"), rev = sum(st == "reviewed"), ok = dir.exists(p$image_dir))
  }

  output$projects_ui <- renderUI({
    req(rv$user); rv$tick
    ps <- my_projects()
    others <- setdiff(vapply(get_users(), function(x) x$username, character(1)), rv$user)
    cards <- lapply(ps, function(p) {
      pr <- project_progress(p)
      pct <- if (pr$n) round(100 * pr$rev / pr$n) else 0
      pct_a <- if (pr$n) round(100 * pr$ann / pr$n) else 0
      is_open <- !is.null(rv$project) && identical(rv$project$id, p$id)
      div(class = paste("fov-proj", if (is_open) "open"),
          div(class = "fov-proj-head",
              h3(p$name),
              if (is_open) span(class = "fov-proj-open", "Open now")),
          div(class = "fov-proj-path", title = p$image_dir, p$image_dir),
          if (!pr$ok) div(class = "fov-proj-warn", "This image folder can't be found on the server.")
          else tagList(
            div(class = "fov-proj-bar", span(class = "a", style = sprintf("width:%s%%", pct_a)),
                span(class = "r", style = sprintf("width:%s%%", pct))),
            div(class = "fov-proj-stats", sprintf("%d frames: %d annotated, %d reviewed", pr$n, pr$ann, pr$rev))),
          div(class = "fov-proj-members", "Team: ", paste(unique(c(p$owner, unlist(p$members))), collapse = ", ")),
          div(class = "fov-proj-actions",
              tags$button(class = "btn btn-primary btn-sm", disabled = if (!pr$ok) NA,
                          onclick = sprintf("Shiny.setInputValue('open_project','%s',{priority:'event'})", p$id),
                          if (is_open) "Go to frames" else "Open"),
              if (can_manage(p, rv$user, rv$role))
                tags$button(class = "btn btn-outline-secondary btn-sm",
                            onclick = sprintf("Shiny.setInputValue('manage_project','%s',{priority:'event'})", p$id), "Manage")))
    })
    tagList(
      if (length(cards)) div(class = "fov-proj-grid", cards)
      else div(class = "fov-empty", "You're not on any projects yet. Create one below, or ask a project owner to add you."),
      tags$details(class = "fov-new", open = if (!length(cards)) NA,
                   tags$summary("New project"),
                   div(class = "fov-new-grid",
                       textInput("new_name", "Project name", placeholder = "e.g. Rowley Shoals 2024 FOV"),
                       textInput("new_dir", "Image folder on this computer/server", placeholder = "/data/bruvs/rowley_2024/stills"),
                       selectizeInput("new_members", "Team members", choices = others, multiple = TRUE,
                                      options = list(placeholder = if (length(others)) "Add people" else "Add accounts on the Team panel first")),
                       checkboxInput("new_import", "Import annotations already saved in that folder (from earlier versions of this app)", TRUE)),
                   actionButton("create_project", "Create project", class = "btn-primary btn-sm")))
  })

  observeEvent(input$create_project, {
    req(rv$user)
    nm <- trimws(input$new_name); d <- normalizePath(path.expand(trimws(input$new_dir)), mustWork = FALSE)
    if (!nzchar(nm)) return(showNotification("Give the project a name.", type = "warning"))
    if (!dir.exists(d)) return(showNotification(paste("Can't find that folder:", d), type = "error"))
    if (!length(list.files(d, pattern = IMG_PATTERN, ignore.case = TRUE)))
      return(showNotification("That folder has no .jpg or .png frames.", type = "warning"))
    id <- paste0(gsub("[^a-z0-9]+", "-", tolower(substr(nm, 1, 30))), "-", rand_hex(3))
    ad <- project_dir(id); dir.create(ad, recursive = TRUE, showWarnings = FALSE)
    imported <- 0
    old <- file.path(d, "fov_annotations")
    if (isTRUE(input$new_import) && dir.exists(old)) {
      fs <- list.files(old, pattern = "\\.json$", full.names = TRUE)
      imported <- sum(file.copy(fs, ad))
    }
    ps <- get_projects()
    ps[[length(ps) + 1]] <- list(id = id, name = nm, image_dir = d, owner = rv$user,
                                 members = as.list(setdiff(input$new_members %||% character(), rv$user)),
                                 created = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"))
    write_list(ps, projects_path())
    showNotification(paste0("Created \u201C", nm, "\u201D", if (imported) sprintf(" and imported %d annotation file(s)", imported), "."), type = "message")
    bump()
    open_project(id)
  })

  observeEvent(input$manage_project, {
    p <- Filter(function(x) identical(x$id, input$manage_project), get_projects())
    req(length(p)); p <- p[[1]]; req(can_manage(p, rv$user, rv$role))
    users <- vapply(get_users(), function(x) x$username, character(1))
    showModal(modalDialog(
      title = paste("Manage", p$name), easyClose = TRUE,
      textInput("mg_name", "Name", p$name),
      textInput("mg_dir", "Image folder", p$image_dir),
      selectizeInput("mg_members", "Team members", choices = setdiff(users, p$owner),
                     selected = unlist(p$members), multiple = TRUE),
      p(class = "fov-sub", "Owner: ", p$owner, ". Removing a project hides it from everyone but keeps its annotation files in ",
        code(project_dir(p$id)), "."),
      footer = tagList(
        actionButton("mg_remove", "Remove project", class = "btn-outline-danger btn-sm"),
        modalButton("Cancel"),
        actionButton("mg_save", "Save changes", class = "btn-primary btn-sm"))))
    session$userData$managing <- p$id
  })
  update_project <- function(id, fn) {
    ps <- get_projects()
    for (i in seq_along(ps)) if (identical(ps[[i]]$id, id)) ps[[i]] <- fn(ps[[i]])
    write_list(Filter(Negate(is.null), ps), projects_path())
  }
  observeEvent(input$mg_save, {
    id <- session$userData$managing; req(id)
    p <- Filter(function(x) identical(x$id, id), get_projects())[[1]]; req(can_manage(p, rv$user, rv$role))
    d <- normalizePath(path.expand(trimws(input$mg_dir)), mustWork = FALSE)
    if (!dir.exists(d)) return(showNotification(paste("Can't find that folder:", d), type = "error"))
    nm <- trimws(input$mg_name %||% "")
    update_project(id, function(x) { if (nzchar(nm)) x$name <- nm; x$image_dir <- d
                                     x$members <- as.list(input$mg_members %||% character()); x })
    removeModal(); bump()
    if (!is.null(rv$project) && identical(rv$project$id, id)) open_project(id, switch_tab = FALSE)
  })
  observeEvent(input$mg_remove, {
    id <- session$userData$managing; req(id)
    p <- Filter(function(x) identical(x$id, id), get_projects())[[1]]; req(can_manage(p, rv$user, rv$role))
    update_project(id, function(x) NULL)
    removeModal(); bump()
    if (!is.null(rv$project) && identical(rv$project$id, id)) session$reload()
  })

  # ------------------------------------------------ open a project
  img_src <- function(img) paste0(rv$prefix, "/", utils::URLencode(img, reserved = TRUE))
  statuses <- function() vapply(rv$images, function(i) ann_status(read_ann(ann_file(rv$ann_dir, i))), character(1))
  image_choices <- function() {
    sym <- c(none = "\u2013 ", review = "\u2022 ", reviewed = "\u2713 ")[statuses()]
    stats::setNames(rv$images, paste0(sym, rv$images))
  }
  refresh_choices <- function(selected = input$image) updateSelectInput(session, "image", choices = image_choices(), selected = selected)
  refresh_results <- function() {
    rv$results <- collect_results(rv$ann_dir)
    try(utils::write.csv(rv$results, file.path(rv$ann_dir, RESULTS_FN), row.names = FALSE), silent = TRUE)
  }
  gallery_item <- function(img) list(image = img, src = img_src(img), annotation = read_text(ann_file(rv$ann_dir, img)))

  open_project <- function(id, switch_tab = TRUE) {
    p <- Filter(function(x) identical(x$id, id), get_projects())
    if (!length(p) || !can_access(p[[1]], rv$user, rv$role)) return(showNotification("You don't have access to that project.", type = "error"))
    p <- p[[1]]
    if (!dir.exists(p$image_dir)) return(showNotification("That project's image folder can't be found.", type = "error"))
    imgs <- list.files(p$image_dir, pattern = IMG_PATTERN, ignore.case = TRUE)
    prefix <- paste0("frames-", rand_hex(12))         # unguessable URL prefix for this session's images
    addResourcePath(prefix, p$image_dir)
    rv$project <- p; rv$dir <- p$image_dir; rv$ann_dir <- project_dir(p$id); rv$prefix <- prefix; rv$images <- imgs
    dir.create(rv$ann_dir, recursive = TRUE, showWarnings = FALSE)
    refresh_results()
    refresh_choices(selected = if (length(imgs)) imgs[1] else character())
    session$sendCustomMessage("fov_project", list(id = p$id, name = p$name))
    session$sendCustomMessage("fov_gallery", list(items = lapply(imgs, gallery_item)))
    bump()
    if (switch_tab) updateTabsetPanel(session, "main_tabs", selected = "Annotate")
  }
  observeEvent(input$open_project, { req(rv$user); open_project(input$open_project) })

  output$project_title <- renderText({ req(rv$project); rv$project$name })

  send_image <- function(img) {
    session$sendCustomMessage("fov_load", list(image = img, src = img_src(img), annotation = read_text(ann_file(rv$ann_dir, img))))
  }
  observeEvent(list(input$image, rv$prefix), {
    req(rv$user, input$image, rv$ann_dir, input$image %in% rv$images)
    send_image(input$image)
  })
  step_image <- function(delta) {
    req(length(rv$images), input$image)
    i <- match(input$image, rv$images)
    refresh_choices(selected = rv$images[max(1, min(length(rv$images), i + delta))])
  }
  observeEvent(input$prev_img, step_image(-1))
  observeEvent(input$next_img, step_image(+1))

  observeEvent(input$fov_next, {
    req(rv$ann_dir, length(rv$images), input$image)
    st <- statuses(); i <- match(input$image, rv$images)
    order_after <- c(seq_along(rv$images)[-seq_len(i)], seq_len(i))
    cand <- order_after[st[order_after] != "reviewed" & rv$images[order_after] != input$image]
    if (!length(cand)) { showNotification("Every frame in this project is reviewed.", type = "message"); refresh_choices() }
    else refresh_choices(selected = rv$images[cand[1]])
  })
  observeEvent(input$fov_goto, {
    req(rv$ann_dir, input$fov_goto %in% rv$images)
    refresh_choices(selected = input$fov_goto)
    updateTabsetPanel(session, "main_tabs", selected = "Annotate")
  })

  # ------------------------------------------------ saving
  log_history <- function(a, source) {
    f <- file.path(rv$ann_dir, HISTORY_FN)
    row <- data.frame(time = format(Sys.time(), "%Y-%m-%d %H:%M:%S"), user = rv$user, image = chr(a$image),
                      source = source, status = chr(a$status),
                      percent_water_col = num(a$metrics$percent_water_col), percent_blocked = num(a$metrics$percent_blocked))
    utils::write.table(row, f, sep = ",", row.names = FALSE, col.names = !file.exists(f), append = file.exists(f))
  }
  save_annotation <- function(txt, from_editor) {
    a <- tryCatch(jsonlite::fromJSON(txt, simplifyVector = FALSE), error = function(e) NULL)
    if (is.null(rv$user) || is.null(a) || is.null(rv$ann_dir) || !(chr(a$image) %in% rv$images)) return(invisible(FALSE))
    f <- ann_file(rv$ann_dir, a$image)
    writeLines(as.character(jsonlite::prettify(txt, indent = 1)), f, useBytes = TRUE)
    try(log_history(a, if (from_editor) "editor" else "batch"), silent = TRUE)
    session$sendCustomMessage("fov_gallery_item", gallery_item(a$image))
    if (from_editor) {
      refresh_results()
      session$sendCustomMessage("fov_saved", list(time = format(Sys.time(), "%H:%M:%S"), file = basename(f)))
    }
    invisible(TRUE)
  }
  observeEvent(input$fov_annot, save_annotation(input$fov_annot, TRUE))
  observeEvent(input$fov_batch_save, save_annotation(input$fov_batch_save, FALSE))

  # ------------------------------------------------ model + batch
  training_set <- function() {
    out <- list()
    for (img in rv$images) {
      f <- ann_file(rv$ann_dir, img); a <- read_ann(f)
      if (identical(ann_status(a), "reviewed"))
        out[[length(out) + 1]] <- list(image = img, src = img_src(img), annotation = read_text(f), updated = chr(a$updated))
    }
    out
  }
  # frames where someone drew the bait arm by hand: templates for fitting the arm elsewhere
  arm_set <- function() {
    out <- list()
    for (img in rv$images) {
      f <- ann_file(rv$ann_dir, img); a <- read_ann(f)
      if (is.null(a)) next
      has_arm <- any(vapply(a$polygons, function(p) identical(p$layer, "exclude"), logical(1)))
      m <- a$meta$methods$exclude
      hand <- identical(m, "manual") || (has_arm && isTRUE(a$meta$edited$exclude))
      if (has_arm && hand) out[[length(out) + 1]] <- read_text(f)
    }
    out
  }
  observeEvent(input$fov_arm_request, {
    req(rv$user, rv$ann_dir)
    session$sendCustomMessage("fov_arm_data", list(templates = arm_set()))
  })
  observeEvent(input$fov_train_request, {
    req(rv$user, rv$ann_dir)
    session$sendCustomMessage("fov_train_data", list(train = training_set()))
  })
  observeEvent(input$fov_batch_request, {
    req(rv$user, rv$ann_dir)
    r <- jsonlite::fromJSON(input$fov_batch_request)
    st <- statuses()
    keep <- if (identical(r$scope, "unannotated")) st == "none" else st != "reviewed"
    items <- lapply(rv$images[keep], gallery_item)
    if (!length(items)) return(showNotification("No frames in that scope, so there's nothing to do.", type = "message"))
    train <- if (identical(r$mode, "model")) training_set() else list()
    arms <- if (identical(r$mode, "arm")) arm_set() else list()
    if (identical(r$mode, "model") && !length(train))
      return(showNotification("Mark some frames as reviewed first. The model trains only on reviewed frames (10 or more is a good start).",
                              type = "warning", duration = 8))
    session$sendCustomMessage("fov_batch_start", list(mode = r$mode, sens = r$sens %||% 5, items = items, train = train, arms = arms,
                                                      template = read_text(file.path(rv$ann_dir, TEMPLATE_FN))))
  })
  observeEvent(input$fov_batch_done, {
    req(rv$ann_dir)
    refresh_results(); refresh_choices(); bump()
    if (!is.null(input$image) && input$image %in% rv$images) send_image(input$image)
    d <- jsonlite::fromJSON(input$fov_batch_done)
    showNotification(sprintf("Batch finished: %s frame(s) updated.", d$done), type = "message")
  })

  observeEvent(input$fov_save_template, {
    req(rv$user, rv$ann_dir)
    writeLines(as.character(jsonlite::prettify(input$fov_save_template, indent = 1)), file.path(rv$ann_dir, TEMPLATE_FN))
    session$sendCustomMessage("fov_note", list(text = "Bait-arm template saved. Batch jobs apply it automatically; use \u201CApply here\u201D on other frames."))
  })
  observeEvent(input$fov_apply_template, {
    req(rv$user, rv$ann_dir)
    session$sendCustomMessage("fov_template", list(template = read_text(file.path(rv$ann_dir, TEMPLATE_FN))))
  })

  # ------------------------------------------------ account + team
  output$account_ui <- renderUI({
    req(rv$user); rv$tick
    admin <- identical(rv$role, "admin")
    users <- get_users()
    div(class = "fov-section fov-cols", id = "fov-account",
        div(h2("Your account"),
            p(class = "fov-sub", "Signed in as ", strong(rv$user), if (admin) " (team admin)"),
            tags$details(class = "fov-new", tags$summary("Change password"),
                         passwordInput("pw_old", "Current password"),
                         passwordInput("pw_new", "New password (8+ characters)"),
                         passwordInput("pw_new2", "Repeat new password"),
                         actionButton("pw_go", "Change password", class = "btn-primary btn-sm"))),
        if (admin) div(h2("Team"),
                       tags$table(class = "fov-team",
                                  tags$thead(tags$tr(tags$th("Username"), tags$th("Role"), tags$th("Added"))),
                                  tags$tbody(lapply(users, function(x) tags$tr(tags$td(x$username), tags$td(x$role), tags$td(substr(x$created %||% "", 1, 10)))))),
                       tags$details(class = "fov-new", tags$summary("Add a person"),
                                    textInput("nu_user", "Username"),
                                    passwordInput("nu_pw", "Temporary password (8+ characters)"),
                                    selectInput("nu_role", "Role", c("Member" = "member", "Admin (manages team, sees all projects)" = "admin")),
                                    actionButton("nu_go", "Add person", class = "btn-primary btn-sm")),
                       tags$details(class = "fov-new", tags$summary("Reset a password or remove someone"),
                                    selectInput("mu_user", "Person", setdiff(vapply(users, function(x) x$username, character(1)), rv$user)),
                                    passwordInput("mu_pw", "New temporary password"),
                                    div(class = "d-flex gap-2",
                                        actionButton("mu_reset", "Reset password", class = "btn-primary btn-sm"),
                                        actionButton("mu_remove", "Remove person", class = "btn-outline-danger btn-sm")))))
  })
  observeEvent(input$pw_go, {
    req(rv$user)
    if (!check_login(rv$user, input$pw_old)) return(showNotification("Your current password isn't right.", type = "error"))
    if (nchar(input$pw_new) < 8) return(showNotification("Use at least 8 characters.", type = "warning"))
    if (!identical(input$pw_new, input$pw_new2)) return(showNotification("The new passwords don't match.", type = "warning"))
    set_password(rv$user, input$pw_new); showNotification("Password changed.", type = "message"); bump()
  })
  observeEvent(input$nu_go, {
    req(identical(rv$role, "admin"))
    u <- trimws(input$nu_user)
    if (!valid_username(u)) return(showNotification("Use 2\u201340 letters, numbers, dots, dashes or underscores.", type = "warning"))
    if (!is.null(find_user(u))) return(showNotification("That username is taken.", type = "warning"))
    if (nchar(input$nu_pw) < 8) return(showNotification("Use at least 8 characters for the temporary password.", type = "warning"))
    add_user(u, input$nu_pw, input$nu_role)
    showNotification(paste("Added", u, "\u2014 give them their temporary password and ask them to change it."), type = "message"); bump()
  })
  observeEvent(input$mu_reset, {
    req(identical(rv$role, "admin"), nzchar(input$mu_user %||% ""))
    if (nchar(input$mu_pw) < 8) return(showNotification("Use at least 8 characters.", type = "warning"))
    set_password(input$mu_user, input$mu_pw); showNotification(paste("Password reset for", input$mu_user), type = "message"); bump()
  })
  observeEvent(input$mu_remove, {
    req(identical(rv$role, "admin"), nzchar(input$mu_user %||% ""), !identical(input$mu_user, rv$user))
    write_list(Filter(function(x) !identical(x$username, input$mu_user), get_users()), users_path())
    showNotification(paste("Removed", input$mu_user, "\u2014 their past annotations are kept."), type = "message"); bump()
  })

  # ------------------------------------------------ results
  output$progress <- renderUI({
    req(rv$ann_dir, length(rv$images))
    res <- rv$results
    div(class = "fov-progress-line",
        sprintf("%d of %d frames annotated, %d reviewed", sum(res$status != "not annotated"), length(rv$images), sum(res$status == "reviewed")))
  })
  output$results_tbl <- renderTable({
    req(rv$ann_dir)
    d <- rv$results; hit <- names(d) %in% names(DISPLAY_NAMES)
    names(d)[hit] <- DISPLAY_NAMES[names(d)[hit]]
    d
  }, digits = 1, striped = TRUE, hover = TRUE, na = "")
  output$results_path <- renderText({ req(rv$ann_dir); paste("Also saved to", file.path(rv$ann_dir, RESULTS_FN)) })
  output$dl_csv <- downloadHandler(
    filename = function() paste0(gsub("[^A-Za-z0-9]+", "_", rv$project$name %||% "fov"), "_metrics_", format(Sys.Date()), ".csv"),
    content  = function(file) utils::write.csv(rv$results, file, row.names = FALSE))
  output$dl_history <- downloadHandler(
    filename = function() paste0(gsub("[^A-Za-z0-9]+", "_", rv$project$name %||% "fov"), "_history_", format(Sys.Date()), ".csv"),
    content  = function(file) {
      f <- file.path(rv$ann_dir, HISTORY_FN)
      if (file.exists(f)) file.copy(f, file) else writeLines("time,user,image,source,status,percent_water_col,percent_blocked", file)
    })
}
