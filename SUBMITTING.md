# Releasing fovannotator

## 1. GitHub

The package lives in https://github.com/BrookeGibbons/fov_annotator (the repository
name differs from the package name, which is fine). Install with
`remotes::install_github("BrookeGibbons/fov_annotator")`.

Add automatic checks on Windows, macOS and Linux for every push:
```r
usethis::use_github_action("check-standard")
```

## 2. r-universe (optional, easy binary installs)

Create a repository `brookegibbons.r-universe.dev` on GitHub containing a `packages.json`:
```json
[{ "package": "fovannotator", "url": "https://github.com/BrookeGibbons/fov_annotator" }]
```
and install the r-universe GitHub app. Users can then run
`install.packages("fovannotator", repos = c("https://brookegibbons.r-universe.dev", "https://cloud.r-project.org"))`.

## 3. CRAN

1. Run the checks:
   ```r
   devtools::check(remote = TRUE, manual = TRUE)   # needs pandoc and LaTeX for the manual
   devtools::check_win_devel()                      # emails results from R-devel on Windows
   rhub::rhub_check()                               # Linux/macOS via GitHub Actions
   ```
2. Update `cran-comments.md` with the results.
3. Submit: `devtools::release()` (asks a series of questions) or
   `devtools::submit_cran()`. Confirm the email CRAN sends to the maintainer address.
4. If CRAN asks for changes, fix them, bump the version (0.1.1), note them in
   `cran-comments.md`, and resubmit.
