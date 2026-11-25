//! The views of the Adjust floors panel: the helper's `floor-views` command (tools/gamefiles,
//! atlas_gamefiles/floorviews.py), kept running while the panel is open, so each change of the cuts is redrawn in
//! a second or two without starting the helper again.
//!
//! It is started for one area of the last make's output folder and first says `ready` (the area's height profile
//! and its cuts without the player's own). Each request is one JSON line on its standard input; the answer is the
//! `views` line of the same `id` on its standard output. It ends when its standard input is closed (the panel
//! closes, another area is opened, or the app closes), or is ended a moment later.

use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

/// How long the helper may take to start and load the area (the single-file helper unpacks itself first).
const START_LIMIT: Duration = Duration::from_secs(90);
/// How long one redraw may take.
const REQUEST_LIMIT: Duration = Duration::from_secs(60);

struct Viewer {
    out_dir: std::path::PathBuf,
    area: String,
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    ready: Value,
    next_id: u64,
}

impl Viewer {
    fn end(mut self) {
        drop(self.stdin);
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            crate::checks::end_process(&mut self.child);
        });
    }
}

/// The one views helper of the app.
#[derive(Default, Clone)]
pub struct FloorViews {
    inner: Arc<Mutex<Option<Viewer>>>,
}

fn lock(inner: &Mutex<Option<Viewer>>) -> MutexGuard<'_, Option<Viewer>> {
    inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Waits for the first line of `event` (and `id`, when given) from the helper, passing over others; an `error`
/// line of that request (or of none) is the error.
fn wait_for(
    lines: &mpsc::Receiver<String>,
    event: &str,
    id: Option<u64>,
    limit: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + limit;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match lines.recv_timeout(left) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(
                    "The floor views took too long. Close the panel and open it again.".to_owned(),
                )
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(
                    "The floor views stopped. Close the panel and open it again.".to_owned(),
                )
            }
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let line_id = value.get("id").and_then(Value::as_u64);
        let mine = match id {
            Some(id) => line_id == Some(id),
            None => true,
        };
        match value.get("event").and_then(Value::as_str) {
            Some(name) if name == event && mine => return Ok(value),
            Some("error") if mine || line_id.is_none() => {
                return Err(value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The floor views stopped with an error.")
                    .to_owned())
            }
            _ => {}
        }
    }
}

impl FloorViews {
    /// Starts the views of `area` in the make output folder `out_dir` (ending those of another area), and returns
    /// the helper's `ready` line. Blocks until the helper has loaded the area.
    pub fn open(&self, helper: &Path, out_dir: &Path, area: &str) -> Result<Value, String> {
        let mut inner = lock(&self.inner);
        if let Some(viewer) = inner.as_ref() {
            if viewer.out_dir == out_dir && viewer.area == area {
                return Ok(viewer.ready.clone());
            }
        }
        if let Some(viewer) = inner.take() {
            viewer.end();
        }
        let mut command = Command::new(helper);
        command
            .arg("floor-views")
            .arg(out_dir)
            .arg("--area")
            .arg(area)
            .current_dir(out_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::checks::hide_console(&mut command);
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start the floor views ({}): {error}",
                helper.display()
            )
        })?;
        let stdin = child.stdin.take().ok_or("The floor views have no input.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("The floor views have no output.")?;
        let (send, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        let ready = match wait_for(&lines, "ready", None, START_LIMIT) {
            Ok(ready) => ready,
            Err(error) => {
                crate::checks::end_process(&mut child);
                return Err(error);
            }
        };
        *inner = Some(Viewer {
            out_dir: out_dir.to_path_buf(),
            area: area.to_owned(),
            child,
            stdin,
            lines,
            ready: ready.clone(),
            next_id: 0,
        });
        Ok(ready)
    }

    /// The views for `cuts` (heights in metres) and `names` (lowest first), the floors from above with `outlines`
    /// or without, without the `removed` pieces. Blocks until they are drawn.
    #[allow(clippy::too_many_arguments)]
    pub fn request(
        &self,
        area: &str,
        cuts: &[f64],
        names: &[String],
        outlines: bool,
        method: &str,
        passages: &Value,
        removed: &Value,
    ) -> Result<Value, String> {
        let mut inner = lock(&self.inner);
        let viewer = inner
            .as_mut()
            .filter(|viewer| viewer.area == area)
            .ok_or("The floor views are not open for this area.")?;
        viewer.next_id += 1;
        let id = viewer.next_id;
        let line =
            json!({ "id": id, "cuts": cuts, "names": names, "outlines": outlines, "method": method, "passages": passages, "removed": removed })
                .to_string();
        let sent = viewer
            .stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|()| viewer.stdin.flush());
        let answer = match sent {
            Ok(()) => wait_for(&viewer.lines, "views", Some(id), REQUEST_LIMIT),
            Err(_) => Err("The floor views stopped. Close the panel and open it again.".to_owned()),
        };
        if answer.is_err() {
            // A helper that stopped or hangs is ended; the panel opens a new one.
            if let Some(viewer) = inner.take() {
                viewer.end();
            }
        }
        answer
    }

    /// Ends the views (the panel was closed, or the app is closing).
    pub fn close(&self) {
        if let Some(viewer) = lock(&self.inner).take() {
            viewer.end();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_its_own_answer() {
        let (send, lines) = mpsc::channel();
        for line in [
            "not json",
            r#"{"event":"views","id":1}"#,
            r#"{"event":"progress"}"#,
            r#"{"event":"views","id":2,"cuts":[4.5]}"#,
        ] {
            send.send(line.to_owned()).unwrap();
        }
        let answer = wait_for(&lines, "views", Some(2), Duration::from_secs(1)).unwrap();
        assert_eq!(answer["cuts"], json!([4.5]));

        send.send(r#"{"event":"error","id":3,"message":"Bad cuts"}"#.to_owned())
            .unwrap();
        assert_eq!(
            wait_for(&lines, "views", Some(3), Duration::from_secs(1)).unwrap_err(),
            "Bad cuts"
        );
        send.send(
            r#"{"event":"error","code":"no-floor-data","message":"Press Make map"}"#.to_owned(),
        )
        .unwrap();
        assert_eq!(
            wait_for(&lines, "ready", None, Duration::from_secs(1)).unwrap_err(),
            "Press Make map"
        );
        assert!(
            wait_for(&lines, "views", Some(4), Duration::from_millis(50))
                .unwrap_err()
                .contains("too long")
        );
        drop(send);
        assert!(wait_for(&lines, "views", Some(4), Duration::from_secs(1))
            .unwrap_err()
            .contains("stopped"));
    }

    /// A stand-in helper (a shell script) that answers as the real one does.
    #[cfg(unix)]
    #[test]
    fn opens_asks_and_closes() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let base =
            std::env::temp_dir().join(format!("atlas-mapmaker-views-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let script = base.join("helper.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
[ "$1" = floor-views ] && [ "$3" = --area ] || exit 9
echo "{\"event\":\"ready\",\"area\":\"$4\"}"
n=0
while read -r line; do
  n=$((n+1))
  echo "{\"event\":\"views\",\"id\":$n,\"seen\":$line}"
done
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let views = FloorViews::default();
        let ready = views.open(&script, &base, "m15_01").unwrap();
        assert_eq!(ready["area"], "m15_01");
        let answer = views
            .request(
                "m15_01",
                &[4.5, 12.0],
                &["Low".to_owned()],
                true,
                "passages",
                &json!([{"x": 1.5, "z": 2.0, "show": "lower"}]),
                &json!([{"part": "h000100", "box": [0, 0, 0, 1, 1, 1]}]),
            )
            .unwrap();
        assert_eq!(answer["seen"]["cuts"], json!([4.5, 12.0]));
        assert_eq!(answer["seen"]["names"], json!(["Low"]));
        assert_eq!(answer["seen"]["outlines"], json!(true));
        assert_eq!(answer["seen"]["method"], json!("passages"));
        assert_eq!(answer["seen"]["passages"][0]["show"], json!("lower"));
        assert_eq!(answer["seen"]["removed"][0]["part"], json!("h000100"));
        let none = json!([]);
        assert_eq!(
            views
                .request("m15_01", &[], &[], false, "cuts", &none, &none)
                .unwrap()["id"],
            2
        );
        assert!(views
            .request("m10_01", &[], &[], false, "cuts", &none, &none)
            .is_err());
        views.close();
        assert!(views
            .request("m15_01", &[], &[], false, "cuts", &none, &none)
            .is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
