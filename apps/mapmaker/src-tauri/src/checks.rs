//! Running the helper (`atlas-gamefiles`, from tools/gamefiles) and following it.
//!
//! The helper is a separate program, installed next to the app. The app starts it with the chosen folder and an
//! output folder in the app's own data, reads its JSON lines from standard output as they come, keeps the last
//! lines of its standard error for a failed check, and reads `report.json` when it says `done`. Cancel writes
//! `cancel` to its standard input, which it checks between files; if it has not stopped a few seconds later, the
//! app ends it (on Windows with its child processes, as the single-file helper runs as two processes).

use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;

/// The helper's file name, without `.exe`.
pub const HELPER_NAME: &str = "atlas-gamefiles";
/// What the helper writes in its output folder.
pub const REPORT_FILE: &str = "report.json";
pub const ZIP_FILE: &str = "atlas-check-report.zip";
/// Check folders kept in the app's data, newest first; older ones are deleted when a check starts.
const KEEP_RUNS: usize = 3;
const MAX_LINES: usize = 500;
const MAX_HELPER_OUTPUT: usize = 80;
/// How long a cancelled helper has to stop by itself.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Idle,
    Running,
    Cancelling,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Line {
    pub kind: &'static str,
    pub text: String,
}

/// What the page shows: `check_status` returns it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub run_id: u64,
    pub folder: Option<String>,
    pub fraction: f64,
    pub message: String,
    pub lines: Vec<Line>,
    pub report: Option<Value>,
    pub error: Option<String>,
    pub helper_output: Vec<String>,
    pub elapsed_seconds: f64,
}

impl Status {
    fn idle() -> Self {
        Status {
            state: State::Idle,
            run_id: 0,
            folder: None,
            fraction: 0.0,
            message: String::new(),
            lines: Vec::new(),
            report: None,
            error: None,
            helper_output: Vec::new(),
            elapsed_seconds: 0.0,
        }
    }
}

/// A check's progress, built from the helper's lines. Kept apart from the process so it can be tested alone.
#[derive(Debug)]
pub struct Progress {
    pub state: State,
    pub fraction: f64,
    pub message: String,
    pub lines: Vec<Line>,
    pub error: Option<String>,
    pub helper_output: VecDeque<String>,
    saw_done: bool,
    saw_cancelled: bool,
}

impl Default for Progress {
    fn default() -> Self {
        Progress {
            state: State::Running,
            fraction: 0.0,
            message: String::new(),
            lines: Vec::new(),
            error: None,
            helper_output: VecDeque::new(),
            saw_done: false,
            saw_cancelled: false,
        }
    }
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

impl Progress {
    /// Takes in one line of the helper's standard output.
    pub fn apply_line(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            self.helper_output_line(format!("(output) {line}"));
            return;
        };
        match event
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "progress" => {
                if let Some(fraction) = event.get("fraction").and_then(Value::as_f64) {
                    self.fraction = self.fraction.max(fraction.clamp(0.0, 1.0));
                }
                self.message = text(&event, "message");
            }
            "game" => {
                let game = event.get("game").cloned().unwrap_or(Value::Null);
                let title = text(&game, "title");
                let version = text(&game, "version");
                let line = if game.get("supported").and_then(Value::as_bool) == Some(true) {
                    if version.is_empty() {
                        format!("Found {title}")
                    } else {
                        format!("Found {title}, version {version}")
                    }
                } else {
                    let reason = text(&game, "reason");
                    if reason.is_empty() {
                        format!("{title}: not supported")
                    } else {
                        reason
                    }
                };
                self.push_line("game", line);
            }
            "areas" => {
                let count = event.get("count").and_then(Value::as_u64).unwrap_or(0);
                self.push_line("info", format!("{count} areas to read"));
            }
            "area" => {
                let statuses = event
                    .get("geometry")
                    .and_then(Value::as_object)
                    .map(|geometry| {
                        geometry
                            .iter()
                            .map(|(source, status)| {
                                format!("{source} {}", status.as_str().unwrap_or("?"))
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                self.push_line("area", format!("{}: {statuses}", text(&event, "name")));
            }
            "warning" => self.push_line("warning", text(&event, "message")),
            "error" => self.error = Some(text(&event, "message")),
            "cancelled" => self.saw_cancelled = true,
            "done" => {
                self.saw_done = true;
                self.fraction = 1.0;
            }
            _ => {}
        }
    }

    pub fn helper_output_line(&mut self, line: String) {
        if self.helper_output.len() == MAX_HELPER_OUTPUT {
            self.helper_output.pop_front();
        }
        self.helper_output.push_back(line);
    }

    fn push_line(&mut self, kind: &'static str, text: String) {
        if self.lines.len() < MAX_LINES {
            self.lines.push(Line { kind, text });
        }
    }

    /// The state once the helper has exited with `code`, given what it said. Returns the report to read when
    /// it finished.
    pub fn finish(&mut self, code: Option<i32>) -> bool {
        if self.saw_done {
            self.state = State::Done;
            return true;
        }
        if self.saw_cancelled || self.state == State::Cancelling {
            self.state = State::Cancelled;
            return false;
        }
        self.state = State::Failed;
        if self.error.is_none() {
            self.error = Some(match code {
                Some(code) => format!("The file reader stopped unexpectedly (exit code {code})."),
                None => "The file reader was stopped unexpectedly.".to_owned(),
            });
        }
        false
    }
}

struct Run {
    id: u64,
    folder: PathBuf,
    out_dir: PathBuf,
    started: Instant,
    finished: Option<Instant>,
    progress: Progress,
    report: Option<Value>,
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct Inner {
    run: Option<Run>,
    next_id: u64,
}

/// The app's one check at a time.
#[derive(Default, Clone)]
pub struct Checks {
    inner: Arc<Mutex<Inner>>,
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The helper next to the app's executable, where the installer puts it. A debug build may name another one
/// with `ATLAS_GAMEFILES_HELPER`, for development.
pub fn find_helper() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("ATLAS_GAMEFILES_HELPER") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let candidate = exe
        .parent()?
        .join(format!("{HELPER_NAME}{}", std::env::consts::EXE_SUFFIX));
    candidate.is_file().then_some(candidate)
}

/// A new, empty folder for one check under `base`, and the older check folders deleted but the newest few.
pub fn new_run_folder(base: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(base)
        .map_err(|error| format!("Could not create {}: {error}", base.display()))?;
    let mut runs: Vec<PathBuf> = fs::read_dir(base)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_dir()
                        && path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with("run-"))
                })
                .collect()
        })
        .unwrap_or_default();
    runs.sort();
    while runs.len() >= KEEP_RUNS {
        let old = runs.remove(0);
        let _ = fs::remove_dir_all(old);
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let mut folder = base.join(format!("run-{stamp:015}"));
    let mut extra = 0;
    while folder.exists() {
        extra += 1;
        folder = base.join(format!("run-{stamp:015}-{extra}"));
    }
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Could not create {}: {error}", folder.display()))?;
    Ok(folder)
}

fn is_inside(path: &Path, folder: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let folder = folder
        .canonicalize()
        .unwrap_or_else(|_| folder.to_path_buf());
    path.starts_with(folder)
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Ends the helper and, on Windows, the process it started (the single-file build unpacks and runs a child).
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut taskkill = Command::new("taskkill");
        taskkill
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut taskkill);
        let _ = taskkill.status();
    }
    let _ = child.kill();
}

impl Checks {
    /// Starts the helper on `folder`, writing into `out_dir`.
    pub fn start(&self, helper: &Path, folder: &Path, out_dir: &Path) -> Result<Status, String> {
        let mut inner = lock(&self.inner);
        if let Some(run) = &inner.run {
            if matches!(run.progress.state, State::Running | State::Cancelling) {
                return Err("A check is already running.".to_owned());
            }
        }
        if is_inside(out_dir, folder) {
            return Err("The report would be written inside the game folder, which the Map Maker never does.".to_owned());
        }
        let mut command = Command::new(helper);
        command
            .arg("check")
            .arg(folder)
            .arg("--out")
            .arg(out_dir)
            .arg("--stdin-cancel")
            .current_dir(out_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut command);
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start the file reader ({}): {error}",
                helper.display()
            )
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();
        inner.next_id += 1;
        let id = inner.next_id;
        let child = Arc::new(Mutex::new(child));
        inner.run = Some(Run {
            id,
            folder: folder.to_path_buf(),
            out_dir: out_dir.to_path_buf(),
            started: Instant::now(),
            finished: None,
            progress: Progress::default(),
            report: None,
            child: Arc::clone(&child),
            stdin,
        });
        drop(inner);

        let (stdout_done, stdout_finished) = mpsc::channel::<()>();
        if let Some(stdout) = stdout {
            let shared = Arc::clone(&self.inner);
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Some(run) = lock(&shared).run.as_mut().filter(|run| run.id == id) {
                        run.progress.apply_line(&line);
                    }
                }
                let _ = stdout_done.send(());
            });
        } else {
            let _ = stdout_done.send(());
        }
        if let Some(mut stderr) = stderr {
            let shared = Arc::clone(&self.inner);
            thread::spawn(move || {
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                while let Ok(read) = stderr.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..read]);
                    while let Some(end) = bytes.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = bytes.drain(..=end).collect();
                        let line = String::from_utf8_lossy(&line).trim_end().to_owned();
                        if let Some(run) = lock(&shared).run.as_mut().filter(|run| run.id == id) {
                            run.progress.helper_output_line(line);
                        }
                    }
                }
            });
        }
        let shared = Arc::clone(&self.inner);
        thread::spawn(move || {
            let code = loop {
                let waited = child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .try_wait();
                match waited {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(_) => break None,
                }
            };
            // The last lines may still be on their way.
            let _ = stdout_finished.recv_timeout(Duration::from_secs(3));
            let mut inner = lock(&shared);
            if let Some(run) = inner.run.as_mut().filter(|run| run.id == id) {
                run.stdin = None;
                run.finished = Some(Instant::now());
                if run.progress.finish(code) {
                    match fs::read_to_string(run.out_dir.join(REPORT_FILE))
                        .map_err(|error| error.to_string())
                        .and_then(|text| {
                            serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
                        }) {
                        Ok(report) => run.report = Some(report),
                        Err(error) => {
                            run.progress.state = State::Failed;
                            run.progress.error =
                                Some(format!("The report could not be read: {error}"));
                        }
                    }
                }
            }
        });
        Ok(self.status())
    }

    pub fn status(&self) -> Status {
        let inner = lock(&self.inner);
        let Some(run) = &inner.run else {
            return Status::idle();
        };
        let progress = &run.progress;
        Status {
            state: progress.state,
            run_id: run.id,
            folder: Some(run.folder.display().to_string()),
            fraction: progress.fraction,
            message: progress.message.clone(),
            lines: progress.lines.clone(),
            report: run.report.clone(),
            error: progress.error.clone(),
            helper_output: progress.helper_output.iter().cloned().collect(),
            elapsed_seconds: run
                .finished
                .unwrap_or_else(Instant::now)
                .duration_since(run.started)
                .as_secs_f64(),
        }
    }

    /// Asks the helper to stop, and ends it if it has not a few seconds later.
    pub fn cancel(&self) {
        let mut inner = lock(&self.inner);
        let Some(run) = inner.run.as_mut() else {
            return;
        };
        if run.progress.state != State::Running {
            return;
        }
        run.progress.state = State::Cancelling;
        if let Some(mut stdin) = run.stdin.take() {
            let _ = stdin.write_all(b"cancel\n");
            let _ = stdin.flush();
        }
        let child = Arc::clone(&run.child);
        thread::spawn(move || {
            thread::sleep(CANCEL_GRACE);
            let mut child = child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(child.try_wait(), Ok(None)) {
                kill_tree(&mut child);
            }
        });
    }

    /// Ends a running helper at once: the app is closing.
    pub fn stop_now(&self) {
        let mut inner = lock(&self.inner);
        let Some(run) = inner.run.as_mut() else {
            return;
        };
        if !matches!(run.progress.state, State::Running | State::Cancelling) {
            return;
        }
        run.progress.state = State::Cancelling;
        run.stdin = None;
        let mut child = run
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(child.try_wait(), Ok(None)) {
            kill_tree(&mut child);
        }
    }

    /// A file of the finished check's output folder, by its name in the report (`previews/<area>.png`) or the
    /// zip, refusing any other path.
    pub fn output_file(&self, name: &str) -> Result<PathBuf, String> {
        if !is_output_name(name) {
            return Err(format!("{name} is not a file of the report."));
        }
        let inner = lock(&self.inner);
        let run = inner
            .run
            .as_ref()
            .filter(|run| run.progress.state == State::Done)
            .ok_or("No finished check.")?;
        Ok(run.out_dir.join(name))
    }
}

/// `atlas-check-report.zip`, or `previews/` and a name of letters, digits and underscores, then `.png`.
pub fn is_output_name(name: &str) -> bool {
    if name == ZIP_FILE {
        return true;
    }
    let Some(stem) = name
        .strip_prefix("previews/")
        .and_then(|rest| rest.strip_suffix(".png"))
    else {
        return false;
    };
    !stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Standard base64, for preview pictures sent to the page as `data:` URLs.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_follows_the_helper_lines() {
        let mut progress = Progress::default();
        progress.apply_line(r#"{"event":"start","tool":"atlas-gamefiles"}"#);
        progress.apply_line(
            r#"{"event":"game","game":{"title":"Dark Souls Remastered","version":"1.3.1.0","supported":true}}"#,
        );
        progress.apply_line(r#"{"event":"areas","count":17}"#);
        progress.apply_line(r#"{"event":"progress","fraction":0.4,"message":"Reading"}"#);
        progress.apply_line(r#"{"event":"progress","fraction":0.2,"message":"Later"}"#);
        progress.apply_line(
            r#"{"event":"area","name":"Depths","geometry":{"collision":"ok","navmesh":"missing"}}"#,
        );
        progress.apply_line(r#"{"event":"warning","message":"Something odd"}"#);
        progress.apply_line("not json");
        assert_eq!(progress.fraction, 0.4, "progress never goes back");
        assert_eq!(progress.message, "Later");
        assert_eq!(
            progress.lines,
            vec![
                Line {
                    kind: "game",
                    text: "Found Dark Souls Remastered, version 1.3.1.0".into()
                },
                Line {
                    kind: "info",
                    text: "17 areas to read".into()
                },
                Line {
                    kind: "area",
                    text: "Depths: collision ok, navmesh missing".into()
                },
                Line {
                    kind: "warning",
                    text: "Something odd".into()
                },
            ]
        );
        assert_eq!(progress.helper_output, vec!["(output) not json".to_owned()]);
        progress.apply_line(r#"{"event":"done"}"#);
        assert!(progress.finish(Some(0)));
        assert_eq!(progress.state, State::Done);
        assert_eq!(progress.fraction, 1.0);
    }

    #[test]
    fn unsupported_game_is_reported_with_its_reason() {
        let mut progress = Progress::default();
        progress.apply_line(r#"{"event":"game","game":{"title":"Unknown","supported":false,"reason":"No game here."}}"#);
        assert_eq!(progress.lines[0].text, "No game here.");
    }

    #[test]
    fn failures_and_cancels() {
        let mut failed = Progress::default();
        failed.apply_line(r#"{"event":"error","message":"OSError: disk"}"#);
        assert!(!failed.finish(Some(1)));
        assert_eq!(failed.state, State::Failed);
        assert_eq!(failed.error.as_deref(), Some("OSError: disk"));

        let mut crashed = Progress::default();
        assert!(!crashed.finish(Some(-1073741819)));
        assert!(crashed.error.unwrap().contains("exit code"));

        let mut cancelled = Progress {
            state: State::Cancelling,
            ..Default::default()
        };
        assert!(!cancelled.finish(None));
        assert_eq!(cancelled.state, State::Cancelled);

        let mut stopped_itself = Progress::default();
        stopped_itself.apply_line(r#"{"event":"cancelled"}"#);
        stopped_itself.finish(Some(3));
        assert_eq!(stopped_itself.state, State::Cancelled);
    }

    #[test]
    fn helper_output_keeps_the_last_lines() {
        let mut progress = Progress::default();
        for index in 0..(MAX_HELPER_OUTPUT + 5) {
            progress.helper_output_line(format!("line {index}"));
        }
        assert_eq!(progress.helper_output.len(), MAX_HELPER_OUTPUT);
        assert_eq!(
            progress.helper_output.front().map(String::as_str),
            Some("line 5")
        );
    }

    #[test]
    fn only_report_files_are_served() {
        assert!(is_output_name("previews/m10_01_00_00.png"));
        assert!(is_output_name(ZIP_FILE));
        for bad in [
            "report.json",
            "previews/../x.png",
            "previews/.png",
            "previews/a/b.png",
            "/etc/passwd",
            "previews\\x.png",
        ] {
            assert!(!is_output_name(bad), "{bad}");
        }
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn run_folders_are_new_and_old_ones_go() {
        let base = std::env::temp_dir().join(format!("atlas-mapmaker-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("keep-me")).unwrap();
        let mut made = Vec::new();
        for _ in 0..5 {
            made.push(new_run_folder(&base).unwrap());
        }
        let left: Vec<_> = made.iter().filter(|path| path.exists()).collect();
        assert_eq!(left.len(), KEEP_RUNS);
        assert!(made.last().unwrap().exists());
        assert!(
            base.join("keep-me").exists(),
            "only run folders are removed"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn refuses_an_output_folder_inside_the_game_folder() {
        let base =
            std::env::temp_dir().join(format!("atlas-mapmaker-inside-{}", std::process::id()));
        let out = base.join("out");
        fs::create_dir_all(&out).unwrap();
        let checks = Checks::default();
        let error = checks
            .start(Path::new("missing-helper"), &base, &out)
            .unwrap_err();
        assert!(error.contains("inside the game folder"));
        let _ = fs::remove_dir_all(&base);
    }

    /// A stand-in helper (a shell script) that prints the same kind of lines the real one does.
    #[cfg(unix)]
    #[test]
    fn runs_a_helper_and_reads_its_report() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!("atlas-mapmaker-run-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let game = base.join("game");
        let out = base.join("out");
        fs::create_dir_all(&game).unwrap();
        fs::create_dir_all(&out).unwrap();
        let script = base.join("helper.sh");
        fs::write(
            &script,
            "#!/bin/sh\n\
             echo '{\"event\":\"progress\",\"fraction\":0.5,\"message\":\"Half\"}'\n\
             echo 'some noise' >&2\n\
             echo '{\"game\":{\"id\":\"unknown\"}}' > \"$4/report.json\"\n\
             echo '{\"event\":\"done\"}'\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let checks = Checks::default();
        checks.start(&script, &game, &out).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            let status = checks.status();
            if !matches!(status.state, State::Running | State::Cancelling)
                || Instant::now() > deadline
            {
                break status;
            }
            thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(status.state, State::Done, "{status:?}");
        assert_eq!(status.report.unwrap()["game"]["id"], "unknown");
        assert_eq!(status.helper_output, vec!["some noise".to_owned()]);
        assert!(checks.output_file(ZIP_FILE).unwrap().starts_with(&out));
        let _ = fs::remove_dir_all(&base);
    }
}
