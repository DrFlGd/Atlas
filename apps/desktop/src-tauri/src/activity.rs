//! The activity log: what the desktop apps did, in a plain text file that a
//! person can read, copy and send.
//!
//! Every Atlas desktop app on the computer writes to the same file, in the
//! shared folder (see `settings.rs`): `<shared folder>/logs/atlas.log`, so
//! `%LOCALAPPDATA%\Atlas\logs\atlas.log` on Windows. One event per line:
//!
//! ```text
//! 2026-11-11T09:12:03.123Z [Atlas 0.3.1] download error: Stopped: …
//! ```
//!
//! the time in UTC (ISO 8601, milliseconds), the app's name and version in
//! brackets, an area (`app`, `download`, `import`, `library`, `migration`, `saves`), a
//! level (`info`, `warn`, `error`) and the message. Messages are one line:
//! line breaks and tabs become spaces and other control characters are
//! dropped.
//!
//! When the file would grow past 2 MB it is renamed to `atlas.1.log`
//! (replacing the one before) and a new file is started. Each line is
//! appended with one write to a file opened in append mode, while holding an
//! operating system lock on `atlas.log.lock`, so two apps writing at once
//! never mix or lose each other's lines, and a rotation never happens under
//! another app's write. Writing the log is never fatal: when the folder
//! cannot be written, the app carries on, and every event is still printed
//! to stderr as before.
//!
//! The log holds no file contents, no progress and nothing from web storage
//! or from the pages an import reads, and nothing from inside a game save
//! (only its file name, version, world and how many places matched). Local
//! paths and the addresses of map images are in it, since they are what is
//! needed to tell what happened; for saves, only file and folder names.

use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, PoisonError,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

/// The log folder inside the shared folder.
pub const LOG_DIR: &str = "logs";
pub const LOG_FILE: &str = "atlas.log";
/// The file before the current one.
pub const PREVIOUS_FILE: &str = "atlas.1.log";
const LOCK_FILE: &str = "atlas.log.lock";
/// The current file is rotated when a line would take it past this size.
pub const MAX_BYTES: u64 = 2 << 20;
/// Longer messages are cut.
const MAX_MESSAGE_CHARS: usize = 8000;

/// What part of the app an event is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    App,
    Download,
    Import,
    Library,
    Migration,
    Saves,
}

impl fmt::Display for Area {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Area::App => "app",
            Area::Download => "download",
            Area::Import => "import",
            Area::Library => "library",
            Area::Migration => "migration",
            Area::Saves => "saves",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        })
    }
}

struct Inner {
    /// None: stderr only (unit tests, or before the app has started).
    dir: Option<PathBuf>,
    /// `<name> <version>`, as written in each line.
    app: String,
    max_bytes: u64,
    /// One writer at a time within this app.
    write: Mutex<()>,
    /// Whether a failed write was already reported on stderr.
    complained: AtomicBool,
}

/// A handle on the activity log. Cloning is cheap.
#[derive(Clone)]
pub struct ActivityLog(Arc<Inner>);

static GLOBAL: OnceLock<ActivityLog> = OnceLock::new();

/// The log folder under the shared folder.
pub fn log_dir(shared: &Path) -> PathBuf {
    shared.join(LOG_DIR)
}

/// The most recent lines of the log, newest last.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentLog {
    /// The log folder.
    pub folder: String,
    /// The current log file.
    pub file: String,
    pub lines: Vec<String>,
    /// Older lines exist that are not included.
    pub truncated: bool,
}

impl ActivityLog {
    /// A log in `dir`, written as the app `name` `version`.
    pub fn new(dir: PathBuf, name: &str, version: &str) -> Self {
        Self::with_limit(Some(dir), name, version, MAX_BYTES)
    }

    /// A log that only prints to stderr.
    pub fn stderr_only() -> Self {
        Self::with_limit(None, "Atlas", env!("CARGO_PKG_VERSION"), MAX_BYTES)
    }

    pub(crate) fn with_limit(
        dir: Option<PathBuf>,
        name: &str,
        version: &str,
        max_bytes: u64,
    ) -> Self {
        let name: String = clean(name)
            .chars()
            .filter(|c| !matches!(c, '[' | ']'))
            .collect();
        let version: String = clean(version)
            .chars()
            .filter(|c| !c.is_whitespace() && !matches!(c, '[' | ']'))
            .collect();
        Self(Arc::new(Inner {
            dir,
            app: format!("{} {}", name.trim(), version),
            max_bytes,
            write: Mutex::new(()),
            complained: AtomicBool::new(false),
        }))
    }

    /// Makes this the log that [`ActivityLog::global`] returns. Only the
    /// first call has an effect.
    pub fn install(&self) {
        let _ = GLOBAL.set(self.clone());
    }

    /// The app's log, or a stderr-only log before the app has set one up
    /// (and in unit tests).
    pub fn global() -> Self {
        static STDERR: OnceLock<ActivityLog> = OnceLock::new();
        GLOBAL
            .get()
            .or_else(|| Some(STDERR.get_or_init(ActivityLog::stderr_only)))
            .cloned()
            .expect("set above")
    }

    /// The log folder, if this log writes one.
    pub fn dir(&self) -> Option<&Path> {
        self.0.dir.as_deref()
    }

    pub fn info(&self, area: Area, message: impl AsRef<str>) {
        self.record(area, Level::Info, message.as_ref());
    }

    pub fn warn(&self, area: Area, message: impl AsRef<str>) {
        self.record(area, Level::Warn, message.as_ref());
    }

    pub fn error(&self, area: Area, message: impl AsRef<str>) {
        self.record(area, Level::Error, message.as_ref());
    }

    /// Writes one event, to stderr and to the file. Never fails.
    pub fn record(&self, area: Area, level: Level, message: &str) {
        let line = format_line(
            &timestamp(SystemTime::now()),
            &self.0.app,
            area,
            level,
            message,
        );
        eprint!("atlas: {}", &line[line.find(']').map_or(0, |i| i + 2)..]);
        let Some(dir) = &self.0.dir else { return };
        if let Err(error) = self.append(dir, &line) {
            if !self.0.complained.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "atlas: cannot write the activity log in {}: {error}",
                    dir.display()
                );
            }
        }
    }

    fn append(&self, dir: &Path, line: &str) -> std::io::Result<()> {
        let _guard = self.0.write.lock().unwrap_or_else(PoisonError::into_inner);
        fs::create_dir_all(dir)?;
        // Other apps write the same file: hold the shared lock while
        // rotating and appending. If it cannot be had, append anyway.
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(LOCK_FILE))
            .ok()
            .filter(|file| file.lock().is_ok());
        let path = dir.join(LOG_FILE);
        if fs::metadata(&path)
            .is_ok_and(|meta| meta.len() > 0 && meta.len() + line.len() as u64 > self.0.max_bytes)
        {
            // Replaces the previous file. If it fails (for example while
            // another program has the file open), the next line tries again.
            let _ = fs::rename(&path, dir.join(PREVIOUS_FILE));
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(line.as_bytes())?;
        drop(file);
        drop(lock);
        Ok(())
    }

    /// The most recent lines, newest last: at most `max_lines` lines and
    /// about `max_bytes` bytes, from the current file and, when that is not
    /// enough, the previous one.
    pub fn read_recent(&self, max_lines: usize, max_bytes: u64) -> Result<RecentLog, String> {
        let dir = self
            .dir()
            .ok_or_else(|| "This app keeps no activity log.".to_owned())?;
        // Something that is not a folder sits where the log folder should be.
        // Systems disagree on whether opening a file below it is "not found",
        // so say it here, the same way everywhere.
        if fs::metadata(dir).is_ok_and(|meta| !meta.is_dir()) {
            return Err(
                "Cannot read the activity log: its folder could not be created.".to_owned(),
            );
        }
        let current = dir.join(LOG_FILE);
        let (mut lines, mut truncated) = read_tail(&current, max_bytes)?;
        let used: u64 = lines.iter().map(|line| line.len() as u64 + 1).sum();
        if !truncated && lines.len() < max_lines && used < max_bytes {
            let (older, older_truncated) = read_tail(&dir.join(PREVIOUS_FILE), max_bytes - used)?;
            truncated = older_truncated;
            lines.splice(0..0, older);
        }
        if lines.len() > max_lines {
            lines.drain(..lines.len() - max_lines);
            truncated = true;
        }
        Ok(RecentLog {
            folder: dir.display().to_string(),
            file: current.display().to_string(),
            lines,
            truncated,
        })
    }
}

/// The last `budget` bytes of a file as whole lines, and whether anything
/// before them was left out. A missing file has no lines.
fn read_tail(path: &Path, budget: u64) -> Result<(Vec<String>, bool), String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), false))
        }
        Err(error) => return Err(format!("Cannot read the activity log: {error}")),
    };
    let len = file
        .metadata()
        .map_err(|error| format!("Cannot read the activity log: {error}"))?
        .len();
    let start = len.saturating_sub(budget);
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(start))
        .and_then(|_| file.take(budget).read_to_end(&mut bytes))
        .map_err(|error| format!("Cannot read the activity log: {error}"))?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        // The first line is cut; leave it out.
        text = text
            .split_once('\n')
            .map(|(_, rest)| rest.to_owned())
            .unwrap_or_default();
    }
    let lines = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect();
    Ok((lines, start > 0))
}

/// One line of the log, with its line break.
pub fn format_line(time: &str, app: &str, area: Area, level: Level, message: &str) -> String {
    let mut message = clean(message);
    if message.chars().count() > MAX_MESSAGE_CHARS {
        message = message.chars().take(MAX_MESSAGE_CHARS).collect::<String>() + "…";
    }
    format!("{time} [{app}] {area} {level}: {message}\n")
}

/// Text on one line: line breaks and tabs become spaces, other control
/// characters are dropped.
pub fn clean(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            c if c.is_control() => None,
            // Characters that change the direction of text could make a
            // line read differently from what it says.
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => None,
            c => Some(c),
        })
        .collect()
}

/// A time as ISO 8601 UTC with milliseconds, `2026-11-11T09:12:03.123Z`.
pub fn timestamp(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = crate::manifest::rfc3339(since.as_secs());
    format!(
        "{}.{:03}Z",
        seconds.trim_end_matches('Z'),
        since.subsec_millis()
    )
}

/// Writes to the app's log; see [`ActivityLog::info`].
pub fn info(area: Area, message: impl AsRef<str>) {
    ActivityLog::global().info(area, message);
}

/// Writes to the app's log; see [`ActivityLog::warn`].
pub fn warn(area: Area, message: impl AsRef<str>) {
    ActivityLog::global().warn(area, message);
}

/// Writes to the app's log; see [`ActivityLog::error`].
pub fn error(area: Area, message: impl AsRef<str>) {
    ActivityLog::global().error(area, message);
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;
    use std::time::Duration;

    /// Whether a line has the log's shape.
    pub fn well_formed(line: &str) -> bool {
        let Some((time, rest)) = line.split_once(' ') else {
            return false;
        };
        time.len() == 24
            && time.ends_with('Z')
            && time.as_bytes()[10] == b'T'
            && rest.starts_with('[')
            && rest.contains("] ")
            && !line.contains('\n')
    }

    #[test]
    fn formats_one_line_per_event() {
        let time = timestamp(UNIX_EPOCH + Duration::from_millis(1_000_000_000_123));
        assert_eq!(time, "2001-09-09T01:46:40.123Z");
        let line = format_line(
            &time,
            "Atlas Importer 0.3.1",
            Area::Download,
            Level::Warn,
            "first\nsecond\tthird\u{7}\u{202e}end",
        );
        assert_eq!(
            line,
            "2001-09-09T01:46:40.123Z [Atlas Importer 0.3.1] download warn: first second thirdend\n"
        );
        assert!(well_formed(line.trim_end()));

        let dir = TempDir::new("activity-format");
        let log = ActivityLog::new(dir.0.join("logs"), "My [Atlas]", "0.3.1");
        log.info(Area::App, "started");
        log.error(Area::Migration, "could not move\r\nthings");
        let text = fs::read_to_string(dir.0.join("logs").join(LOG_FILE)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|line| well_formed(line)));
        assert!(lines[0].ends_with(" [My Atlas 0.3.1] app info: started"));
        assert!(lines[1].ends_with("] migration error: could not move  things"));
        let recent = log.read_recent(100, 1 << 20).unwrap();
        assert_eq!(recent.lines.len(), 2);
        assert!(!recent.truncated);
    }

    #[test]
    fn rotates_and_keeps_one_previous_file() {
        let dir = TempDir::new("activity-rotate");
        let logs = dir.0.join("logs");
        let log = ActivityLog::with_limit(Some(logs.clone()), "Atlas", "0.3.1", 2000);
        for i in 0..200 {
            log.info(Area::Download, format!("event number {i:04}"));
        }
        let current = fs::metadata(logs.join(LOG_FILE)).unwrap().len();
        let previous = fs::metadata(logs.join(PREVIOUS_FILE)).unwrap().len();
        assert!(current <= 2000, "{current}");
        assert!(previous <= 2000, "{previous}");
        assert!(!logs.join("atlas.2.log").exists());
        let recent = log.read_recent(10_000, 1 << 20).unwrap();
        assert!(recent.lines.last().unwrap().ends_with("event number 0199"));
        // Both files are read, oldest first, and older lines are gone.
        let numbers: Vec<u32> = recent
            .lines
            .iter()
            .map(|line| line[line.len() - 4..].parse().unwrap())
            .collect();
        assert!(numbers.windows(2).all(|pair| pair[1] == pair[0] + 1));
        assert!(numbers.len() > 2000 / 60, "{}", numbers.len());
        assert!(numbers[0] > 0);
        // Caps on lines and bytes.
        let few = log.read_recent(5, 1 << 20).unwrap();
        assert_eq!(few.lines.len(), 5);
        assert!(few.truncated);
        let small = log.read_recent(10_000, 200).unwrap();
        assert!(small.lines.len() <= 4 && !small.lines.is_empty());
        assert!(small.lines.iter().all(|line| well_formed(line)));
    }

    #[test]
    fn two_apps_append_at_once_without_losing_lines() {
        let dir = TempDir::new("activity-two");
        let logs = dir.0.join("logs");
        let a = ActivityLog::new(logs.clone(), "Atlas", "0.3.1");
        let b = ActivityLog::new(logs.clone(), "Atlas Importer", "0.3.1");
        let threads: Vec<_> = [a, b]
            .into_iter()
            .map(|log| {
                std::thread::spawn(move || {
                    for i in 0..300 {
                        log.info(Area::Library, format!("{} {i}", "x".repeat(i % 50)));
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let text = fs::read_to_string(logs.join(LOG_FILE)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 600);
        assert!(lines.iter().all(|line| well_formed(line)));
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("[Atlas Importer 0.3.1]"))
                .count(),
            300
        );
    }

    #[test]
    fn an_unwritable_folder_is_not_fatal() {
        let dir = TempDir::new("activity-unwritable");
        // A file where the folder should be.
        let blocked = dir.0.join("logs");
        fs::write(&blocked, b"not a folder").unwrap();
        let log = ActivityLog::new(blocked.clone(), "Atlas", "0.3.1");
        log.info(Area::App, "still running");
        log.error(Area::Download, "and again");
        assert_eq!(fs::read(&blocked).unwrap(), b"not a folder");
        assert!(log.read_recent(10, 1000).is_err());
        // A log without a folder only prints.
        let quiet = ActivityLog::stderr_only();
        quiet.warn(Area::Import, "printed only");
        assert!(quiet.read_recent(10, 1000).is_err());
    }
}
