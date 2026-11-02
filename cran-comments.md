## R CMD check results

0 errors | 0 warnings | 2 notes (local Windows check, R 4.4.2)

* "unable to verify current time" and "Files 'README.md' or 'NEWS.md' cannot be
  checked without 'pandoc' being installed" are due to the local machine
  (no internet time service, no pandoc) and do not appear on CRAN.
* This is a new submission.

## Notes for reviewers

* The package is a Shiny application. Examples that start the app are wrapped in
  `if (interactive())`.
* The app stores accounts, project lists and annotations in
  `tools::R_user_dir("fovannotator", "data")` by default, only when the user runs
  the app; the folder can be changed with the `data_dir` argument. Nothing is
  written during examples or tests outside `tempdir()`.
