# Where the app keeps accounts, projects and annotations for this R session.
.fov <- new.env(parent = emptyenv())

#' Folder used to store FOV annotator data
#'
#' Returns the folder in which the app keeps user accounts (\code{users.json}),
#' the project list (\code{projects.json}) and one sub-folder of annotations per
#' project. Image folders are only read, never written.
#'
#' The folder is chosen, in order, from the \code{data_dir} argument of
#' \code{\link{run_fov_annotator}}, the option \code{fovannotator.data_dir},
#' the environment variable \code{FOV_DATA_DIR}, and finally
#' \code{tools::R_user_dir("fovannotator", "data")}.
#'
#' @return A single character string: the path of the data folder (it may not
#'   exist yet; it is created when the app starts).
#' @examples
#' fov_data_dir()
#' @export
fov_data_dir <- function() {
  d <- .fov$data_dir %||% getOption("fovannotator.data_dir") %||%
    (if (nzchar(Sys.getenv("FOV_DATA_DIR"))) Sys.getenv("FOV_DATA_DIR") else NULL) %||%
    tools::R_user_dir("fovannotator", which = "data")
  normalizePath(d, mustWork = FALSE)
}
users_path    <- function() file.path(fov_data_dir(), "users.json")
projects_path <- function() file.path(fov_data_dir(), "projects.json")

#' Example frames shipped with the package
#'
#' A folder holding a few BRUVS still frames that can be used to try the app:
#' create a project on the Home page and give this path as its image folder.
#' Tick \emph{Import annotations already saved in that folder} to load the example
#' annotations as well.
#'
#' @return The path of the folder of example frames.
#' @examples
#' list.files(fov_example_frames())
#' @export
fov_example_frames <- function() {
  system.file("extdata", "example-frames", package = "fovannotator")
}

#' The FOV annotator Shiny application
#'
#' \code{fov_app()} returns the app as a \code{shiny.appobj}, for deployment
#' (for example on Posit Connect or Shiny Server: put
#' \code{fovannotator::fov_app()} in an \code{app.R}). \code{run_fov_annotator()}
#' starts it locally.
#'
#' The first person to open the app creates the first account, which becomes the
#' team administrator. A project links a folder of frames to its own set of
#' annotations; several people can be members of a project and edit the same
#' annotations.
#'
#' @param data_dir Folder for accounts, projects and annotations. Defaults to
#'   \code{\link{fov_data_dir}()}. It is created if it does not exist.
#' @param ... Further arguments passed to \code{\link[shiny]{runApp}}, such as
#'   \code{port} or \code{launch.browser}.
#' @return \code{fov_app()} returns a \code{shiny.appobj}.
#'   \code{run_fov_annotator()} is called for its side effect of running the app
#'   and returns the value passed to \code{shiny::stopApp()} (usually \code{NULL}).
#' @examples
#' if (interactive()) {
#'   # try it on the example frames, keeping data in a temporary folder
#'   run_fov_annotator(data_dir = file.path(tempdir(), "fov_data"))
#' }
#' @export
fov_app <- function(data_dir = fov_data_dir()) {
  shiny::shinyApp(
    ui = fov_ui,
    server = fov_server,
    onStart = function() {
      .fov$data_dir <- normalizePath(data_dir, mustWork = FALSE)
      dir.create(file.path(.fov$data_dir, "projects"), recursive = TRUE, showWarnings = FALSE)
      shiny::addResourcePath("fovassets", system.file("app", "www", package = "fovannotator"))
    }
  )
}

#' @rdname fov_app
#' @export
run_fov_annotator <- function(data_dir = fov_data_dir(), ...) {
  shiny::runApp(fov_app(data_dir), ...)
}
