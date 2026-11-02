# fovannotator 0.1.0

* First release as an R package (previously a stand-alone Shiny app).
* Data are stored in `tools::R_user_dir("fovannotator", "data")` unless another
  folder is given with `run_fov_annotator(data_dir = )`, the option
  `fovannotator.data_dir` or the environment variable `FOV_DATA_DIR`.
* Example frames with annotations are included (`fov_example_frames()`).
