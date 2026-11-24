//! `atlas-scene`: the 3D builder as a program, for apps that are not written
//! in Rust (the Map Maker's helper is Python). Every line it writes on
//! standard output is one JSON object.
//!
//! ```text
//! atlas-scene build <job.json>     build a model into a pack folder
//! atlas-scene check <pack folder>  check the 3D side of a pack folder
//! atlas-scene unpack <pack folder> <map id> <out.glb>
//!                                  read a map's model back out as a raw model
//! atlas-scene --version
//! ```
//!
//! A job is `{"input": "<raw .glb>", "pack": "<pack folder>", "options":
//! {…}}` (see `atlas_scene::Options`; relative paths are taken from the
//! job file's folder). `build` writes `{"event":"progress","fraction":…,
//! "message":…}` lines, then `{"event":"done","scene":…,"report":…}` (and
//! `"rendered"` when it drew the map), or `{"event":"error","message":…}`
//! and exits with 1. `check` writes `{"event":"checked",…}` with the
//! problems it found and exits with 1 when there are any. `unpack` writes
//! the map's finest model as one raw `.glb` (see `atlas_scene::unpack`) and
//! `{"event":"done","report":…}`, or an `error` line and exits with 1. A bad
//! command line exits with 2.

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
        ["unpack", folder, map, output] => {
            match atlas_scene::unpack::unpack_to_file(Path::new(folder), map, Path::new(output)) {
                Ok(report) => {
                    say(&json!({ "event": "done", "report": report }));
                    ExitCode::SUCCESS
                }
                Err(message) => {
                    say(&json!({ "event": "error", "message": message }));
                    ExitCode::from(1)
                }
            }
        }
        _ => {
            eprintln!(
                "atlas-scene {}\n\nUsage:\n  atlas-scene build <job.json>\n  atlas-scene check <pack folder>\n  atlas-scene unpack <pack folder> <map id> <out.glb>\n  atlas-scene --version",
                env!("CARGO_PKG_VERSION")
            );
            ExitCode::from(2)
        }
    }
}
