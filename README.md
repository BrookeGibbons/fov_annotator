# fovannotator

**FOV annotator** is a Shiny app for measuring field-of-view covariates on still
frames from baited remote underwater video stations (BRUVS). Each frame is
partitioned into open water column, seabed, and areas blocked by nearby
structure, after excluding the bait arm and bag. The resulting percentages can
be used as covariates when modelling counts from BRUVS.

| Column | Meaning |
|---|---|
| `percent_water_col` | open water, not covered by a blockage, as % of the field of view |
| `percent_seabed` | 100 − `percent_water_col` (includes blocked areas) |
| `percent_blocked` | structure close behind the bait canister that hides the view beyond it |
| `percent_excluded` | share of the image removed as bait arm, bag and frame |
| `range_m` | visibility range beyond the canister (entered by the annotator) |

The field of view is the image minus the excluded (bait arm) layer.

## Install

```r
# development version
# install.packages("remotes")
remotes::install_github("BrookeGibbons/fov_annotator")
```

## Run

```r
library(fovannotator)
run_fov_annotator()
```

The first account you create is the team administrator. On the Home page,
create a project and give it the full path of a folder of frames (`.jpg` or
`.png`). To try the app, use the example frames:

```r
fov_example_frames()   # paste this path as the project's image folder
```

Tick *Import annotations already saved in that folder* to load the example
annotations too.

## Where data are stored

Accounts, projects and annotations are kept in `fov_data_dir()`, by default
`tools::R_user_dir("fovannotator", "data")`. Use another folder with
`run_fov_annotator(data_dir = "path/to/fov_data")`, the option
`fovannotator.data_dir`, or the environment variable `FOV_DATA_DIR`. Image
folders are only read, never written. Back up the data folder to back up all
annotation work.

```
fov_data/
  users.json                       accounts (salted, iterated SHA-256 password hashes)
  projects.json                    project names, image folders, owners and members
  projects/<id>/annotations/
      <image>.json                 editable outlines, percentages, review status, editor
      fov_metrics.csv              one row per frame
      history.csv                  one row per save
```

## Working as a team

Run one copy of the app on a machine everyone can reach (a lab server, a
university virtual machine, Shiny Server or Posit Connect), with the image
folders on storage that machine can read. For Shiny Server or Posit Connect,
deploy an `app.R` containing:

```r
fovannotator::fov_app()
```

and set `FOV_DATA_DIR` to a persistent folder. Each person signs in with their
own account. Hosts whose local disk is wiped on restart (such as shinyapps.io)
are not suitable unless the data folder is on persistent storage.

## Tools

Draw (freehand or point by point), edit, magic wand and erase on three layers
(water, blocked, bait arm), with zoom, a magnifier and adjustable layer colours.
Automatic tools: **Auto water column** (seabed horizon by dynamic programming
over texture and colour evidence), **Find bait arm** (straight-bar detection plus
red bait bag), and **Predict** (random-forest pixel classifier trained on the
frames you have marked reviewed). Batch jobs never overwrite reviewed frames or
hand edits. Open **? Help** in the app for details.

## Licence

MIT
