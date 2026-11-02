# run `code` with the app's data folder pointing at a fresh temporary folder
with_temp_data <- function(code) {
  d <- tempfile("fovdata")
  dir.create(d)
  fov <- fovannotator:::.fov
  old_opt <- options(fovannotator.data_dir = d)
  old_env <- fov$data_dir
  fov$data_dir <- NULL
  on.exit({
    options(old_opt)
    fov$data_dir <- old_env
    unlink(d, recursive = TRUE)
  }, add = TRUE)
  force(code)
}

test_that("data folder follows the option", {
  with_temp_data({
    expect_equal(fov_data_dir(), normalizePath(getOption("fovannotator.data_dir"), mustWork = FALSE))
  })
})

test_that("usernames are validated", {
  expect_true(fovannotator:::valid_username("brooke.g"))
  expect_false(fovannotator:::valid_username("a"))
  expect_false(fovannotator:::valid_username("no spaces"))
})

test_that("accounts can be created and checked", {
  with_temp_data({
    fovannotator:::add_user("tester", "correct horse", "admin")
    expect_true(file.exists(file.path(fov_data_dir(), "users.json")))
    expect_true(fovannotator:::check_login("tester", "correct horse"))
    expect_false(fovannotator:::check_login("tester", "wrong"))
    expect_false(fovannotator:::check_login("nobody", "correct horse"))
    fovannotator:::set_password("tester", "new password")
    expect_true(fovannotator:::check_login("tester", "new password"))
  })
})

test_that("passwords are hashed with a salt", {
  h1 <- fovannotator:::hash_pw("secret", "aa")
  expect_identical(h1, fovannotator:::hash_pw("secret", "aa"))
  expect_false(identical(h1, fovannotator:::hash_pw("secret", "bb")))
  expect_match(h1, "^[0-9a-f]{64}$")
})

test_that("example annotations are summarised", {
  ann <- file.path(fov_example_frames(), "fov_annotations")
  res <- fovannotator:::collect_results(ann)
  expect_equal(nrow(res), 4)
  expect_true(all(res$status == "reviewed"))
  expect_true(all(res$percent_water_col >= 0 & res$percent_water_col <= 100))
  expect_equal(res$percent_water_col + res$percent_seabed, rep(100, 4), tolerance = 0.11)
  expect_true(any(res$percent_blocked > 0))
})

test_that("example frames are installed", {
  f <- list.files(fov_example_frames(), pattern = "\\.jpg$")
  expect_length(f, 4)
})

test_that("the app object and UI can be built", {
  with_temp_data({
    app <- fov_app(data_dir = fov_data_dir())
    expect_s3_class(app, "shiny.appobj")
    html <- as.character(fovannotator:::fov_ui(NULL))
    expect_match(html, "FOV annotator", fixed = TRUE)
    expect_match(html, "fov-canvas", fixed = TRUE)
  })
})
