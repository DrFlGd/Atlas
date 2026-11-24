//! `atlas-scene`: the 3D builder as a program, for apps that are not written
//! in Rust (the Map Maker's helper is Python). Every line it writes on
//! standard output is one JSON object.
//!
//! ```text
//! atlas-scene build <job.json>       build a model into a pack folder
//! atlas-scene check <pack folder>    check the 3D side of a pack folder
//! atlas-scene inspect <model file> [--max-triangles <n>]
//!                                    what a model file holds, and a preview
//! atlas-scene triangles <job.json>   a model file's triangles in the world
//! atlas-scene draw <job.json>        a model file's floors from above
//! atlas-scene --version
//! ```
//!
//! A job is `{"input": "<model file>", "pack": "<pack folder>", "options":
//! {…}}` (see `atlas_scene::Options`; relative paths are taken from the
//! job file's folder). The model file is a raw `.glb`, or any model file
//! `atlas_scene::formats` reads (glTF, OBJ, STL, PLY, ActorX `.psk`), or an
//! Atlas level file (`.atlaslevel`, `atlas_scene::level`: the meshes of a
//! game level the Map Maker's helper put together). `build` writes
//! `{"event":"progress","fraction":…, "message":…}` lines, then
//! `{"event":"done","scene":…,"report":…}` (and `"rendered"` when it drew
//! the map), or `{"event":"error","message":…}` and exits with 1. `check`
//! writes `{"event":"checked",…}` with the problems it found and exits with
//! 1 when there are any. A bad command line exits with 2.
//!
//! For the Map Maker's "Make a map from a 3D model…":
//!
//! - `inspect` writes `{"event":"inspected","info":…,"preview":…}` (see
//!   `atlas_scene::formats::ModelInfo` and `atlas_scene::draw::Preview`), or
//!   an `error` line with a message for the person;
//! - `triangles` takes `{"input", "output", "options": {"axes", "scale",
//!   "offset", "maxTriangles"}}` and writes the triangles into `output`
//!   (`atlas_scene::draw::write_triangles`), then `{"event":"done",
//!   "triangles":…,"min":…,"max":…,"info":…}`;
//! - `draw` takes `{"input", "output" (a folder), "options": {…, "colouring":
//!   "textures" | "plain"}, "frame": {"xMin", "zMax", "scale", "width",
//!   "height"}, "floors": "<file: a 16-bit floor a triangle>", "count": n}`
//!   and writes `floor-<n>.png` into `output`
//!   (`atlas_scene::draw::draw_floors`), then `{"event":"done","files":[…]}`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    input: PathBuf,
    pack: PathBuf,
    options: atlas_scene::Options,
}

fn say(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn build(job_file: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(job_file)
        .map_err(|e| format!("the job {} cannot be read: {e}", job_file.display()))?;
    let job: Job = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("the job cannot be read: {e}"))?;
    let base = job_file.parent().unwrap_or(Path::new("."));
    let input = base.join(&job.input);
    let pack = base.join(&job.pack);
    let mut last = -1.0;
    let mut progress = |fraction: f64, message: &str| {
        // A line per hundredth at most, and every change of step.
        if fraction - last >= 0.01 || fraction <= 0.0 || fraction >= 1.0 {
            last = fraction;
            say(
                &json!({ "event": "progress", "fraction": (fraction * 1000.0).round() / 1000.0, "message": message }),
            );
        }
    };
    let built = atlas_scene::build_file(&input, &job.options, &pack, &mut progress)?;
    let mut done = serde_json::to_value(&built).map_err(|e| e.to_string())?;
    done["event"] = json!("done");
    Ok(done)
}

/// How a model file is lined up, for `triangles` and `draw`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Placing {
    #[serde(default)]
    axes: Option<[String; 3]>,
    #[serde(default)]
    scale: Option<f64>,
    #[serde(default)]
    offset: Option<[f64; 3]>,
    #[serde(default)]
    max_triangles: Option<usize>,
    #[serde(default)]
    colouring: atlas_scene::draw::Colouring,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrianglesJob {
    input: PathBuf,
    output: PathBuf,
    options: Placing,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DrawJob {
    input: PathBuf,
    output: PathBuf,
    options: Placing,
    frame: atlas_scene::draw::Frame,
    floors: PathBuf,
    count: usize,
}

fn read_job<T: serde::de::DeserializeOwned>(job_file: &Path) -> Result<T, String> {
    let text = std::fs::read_to_string(job_file)
        .map_err(|e| format!("the job {} cannot be read: {e}", job_file.display()))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("the job cannot be read: {e}"))
}

fn read_placed(
    input: &Path,
    options: &Placing,
) -> Result<
    (
        atlas_scene::gltf::Model,
        atlas_scene::formats::ModelInfo,
        atlas_scene::Transform,
    ),
    String,
> {
    let transform =
        atlas_scene::Transform::from_parts(options.axes.as_ref(), options.scale, options.offset)?;
    let read = atlas_scene::formats::ReadOptions {
        max_triangles: options
            .max_triangles
            .unwrap_or(atlas_scene::formats::DEFAULT_MAX_TRIANGLES),
    };
    let (model, info) = atlas_scene::read_model(input, &read)?;
    Ok((model, info, transform))
}

fn triangles(job_file: &Path) -> Result<Value, String> {
    let job: TrianglesJob = read_job(job_file)?;
    let base = job_file.parent().unwrap_or(Path::new("."));
    let (model, info, transform) = read_placed(&base.join(&job.input), &job.options)?;
    let (count, min, max) =
        atlas_scene::draw::write_triangles(&model, &transform, &base.join(&job.output))?;
    Ok(json!({ "event": "done", "triangles": count, "min": min, "max": max, "info": info }))
}

fn draw(job_file: &Path) -> Result<Value, String> {
    let job: DrawJob = read_job(job_file)?;
    let base = job_file.parent().unwrap_or(Path::new("."));
    let (model, _, transform) = read_placed(&base.join(&job.input), &job.options)?;
    let bytes = std::fs::read(base.join(&job.floors))
        .map_err(|e| format!("the floors file cannot be read: {e}"))?;
    let floors: Vec<i16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(*b))
        .collect();
    let files = atlas_scene::draw::draw_floors(
        &model,
        &transform,
        &job.frame,
        &floors,
        job.count,
        job.options.colouring,
        &base.join(&job.output),
    )?;
    Ok(json!({ "event": "done", "files": files }))
}

fn inspect(model_file: &Path, max_triangles: usize) -> Result<Value, String> {
    let read = atlas_scene::formats::ReadOptions { max_triangles };
    let (model, info) = atlas_scene::formats::read_model(model_file, &read)?;
    let preview = atlas_scene::draw::preview(&model, atlas_scene::draw::PREVIEW_TRIANGLES);
    Ok(json!({ "event": "inspected", "info": info, "preview": preview }))
}

fn answer(result: Result<Value, String>) -> ExitCode {
    match result {
        Ok(done) => {
            say(&done);
            ExitCode::SUCCESS
        }
        Err(message) => {
            say(&json!({ "event": "error", "message": message }));
            ExitCode::from(1)
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--version"] => {
            println!("atlas-scene {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["build", job] => match build(Path::new(job)) {
            Ok(done) => {
                say(&done);
                ExitCode::SUCCESS
            }
            Err(message) => {
                say(&json!({ "event": "error", "message": message }));
                ExitCode::from(1)
            }
        },
        ["inspect", file] => answer(inspect(
            Path::new(file),
            atlas_scene::formats::DEFAULT_MAX_TRIANGLES,
        )),
        ["inspect", file, "--max-triangles", most] => match most.parse::<usize>() {
            Ok(most) => answer(inspect(Path::new(file), most)),
            Err(_) => {
                eprintln!("--max-triangles needs a number");
                ExitCode::from(2)
            }
        },
        ["triangles", job] => answer(triangles(Path::new(job))),
        ["draw", job] => answer(draw(Path::new(job))),
        ["check", folder] => {
            let checked = atlas_scene::check::check_pack(Path::new(folder));
            let failed = !checked.problems.is_empty();
            let mut line = serde_json::to_value(&checked).unwrap_or_default();
            line["event"] = json!("checked");
            say(&line);
            if failed {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        _ => {
            eprintln!(
                "atlas-scene {}\n\nUsage:\n  atlas-scene build <job.json>\n  atlas-scene check <pack folder>\n  atlas-scene inspect <model file> [--max-triangles <n>]\n  atlas-scene triangles <job.json>\n  atlas-scene draw <job.json>\n  atlas-scene --version",
                env!("CARGO_PKG_VERSION")
            );
            ExitCode::from(2)
        }
    }
}
