//! Game saves: finding them, and reading copies of them for the web app,
//! which reads the save itself (in `@atlas/saves`). Only file access is
//! here, so the Android app can do the same with its own file access.
//!
//! The shell never writes, renames or deletes anything in a saves folder.
//! It reads only:
//!
//! - files with the `.sav` ending directly in a folder the person chose
//!   (or the game's own saves folder under Documents), or a save file the
//!   person chose, never a link to somewhere else;
//! - the screenshot the game keeps next to a save (`.png`, same name);
//! - the folder listing, to find the newest save.
//!
//! The folders and files the person chose are remembered in
//! `<app data>/saves.json`, so a link to a save keeps working after a
//! restart without the web app being able to name any other file.
//!
//! "Follow new saves" asks for the watch status every few seconds; a save
//! is announced once its size and time have not changed for a few seconds,
//! so it is not read while the game is still writing it. A read that sees
//! the file change under it waits a second and tries once more.

use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, Manager as _, Runtime, State, WebviewWindow};

use crate::{
    activity::{self, Area},
    commands::{blocking, chosen_path, file_dialog},
};

/// No save of a supported game is this large (late-game saves are a few MB).
pub const MAX_SAVE_BYTES: u64 = 64 << 20;
/// Screenshots next to saves are small; anything larger is not one.
pub const MAX_SCREENSHOT_BYTES: u64 = 8 << 20;
/// How long a save's size and time must stay the same before it is read.
pub const SETTLE: Duration = Duration::from_secs(3);
/// How long to wait before reading a save again that changed while it was read.
const RETRY_DELAY: Duration = Duration::from_secs(1);
/// Remembered folders and files beyond this are dropped, oldest first.
const MAX_REMEMBERED: usize = 20;
const STORE_FILE: &str = "saves.json";

/// The games whose saves folder the shell knows, by the id the web app's
/// save reader uses, and where under Documents their saves are.
const GAME_FOLDERS: &[(&str, &[&str])] = &[("witcher3", &["The Witcher 3", "gamesaves"])];

/// Where a game keeps its saves under `documents`, or `None` for a game the
/// shell does not know.
pub fn default_folder(documents: &Path, game: &str) -> Option<PathBuf> {
    let (_, parts) = GAME_FOLDERS.iter().find(|(id, _)| *id == game)?;
    Some(
        parts
            .iter()
            .fold(documents.to_path_buf(), |path, part| path.join(part)),
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEntry {
    pub path: String,
    pub name: String,
    /// Last change, in milliseconds since the epoch.
    pub modified: u64,
    pub size: u64,
    /// The game's screenshot of the save is next to it.
    pub screenshot: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFolder {
    pub path: String,
    pub name: String,
    pub exists: bool,
    /// Newest first; empty when the folder does not exist.
    pub saves: Vec<SaveEntry>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    /// The folder or file followed; `None` when nothing is.
    pub path: Option<String>,
    /// The newest save there now, settled or not.
    pub newest: Option<SaveEntry>,
    /// The last save that settled since following started; read it when
    /// `revision` changes.
    pub settled: Option<SaveEntry>,
    pub revision: u64,
}

/// The folders and files the person chose, as kept in `saves.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct Remembered {
    folders: Vec<String>,
    files: Vec<String>,
}

/// What a watch follows.
enum Target {
    Folder(PathBuf),
    File(PathBuf),
}

struct Watch {
    target: Target,
    shown: String,
    settler: Settler,
    settled: Option<SaveEntry>,
    revision: u64,
}

struct Inner {
    remembered: Remembered,
    watch: Option<Watch>,
}

/// The saves the web app may read, and the save being followed.
pub struct Saves {
    store: Option<PathBuf>,
    documents: Option<PathBuf>,
    inner: Mutex<Inner>,
}

impl Saves {
    /// `app_data` holds `saves.json`; `documents` is the person's Documents
    /// folder (a Known Folder on Windows, so OneDrive and moved folders work).
    pub fn new(app_data: Option<PathBuf>, documents: Option<PathBuf>) -> Self {
        let store = app_data.map(|dir| dir.join(STORE_FILE));
        let remembered = store
            .as_deref()
            .and_then(|file| fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            store,
            documents,
            inner: Mutex::new(Inner {
                remembered,
                watch: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn default_folder(&self, game: &str) -> Result<PathBuf, String> {
        let documents = self.documents.as_deref().ok_or_else(|| {
            "This computer has no Documents folder that Atlas can find.".to_owned()
        })?;
        default_folder(documents, game)
            .ok_or_else(|| "Atlas does not know where that game keeps its saves.".to_owned())
    }

    /// Where a file dialog for a game's saves starts: its saves folder when
    /// there is one, else Documents.
    pub fn dialog_start(&self, game: &str) -> Option<PathBuf> {
        self.default_folder(game)
            .ok()
            .filter(|folder| folder.is_dir())
            .or_else(|| self.documents.clone())
    }

    /// Remembers a folder or file the person chose, newest first.
    pub fn remember(&self, path: &Path, folder: bool) {
        let mut inner = self.lock();
        let list = if folder {
            &mut inner.remembered.folders
        } else {
            &mut inner.remembered.files
        };
        let text = path.to_string_lossy().into_owned();
        list.retain(|known| known != &text);
        list.insert(0, text);
        list.truncate(MAX_REMEMBERED);
        let remembered = inner.remembered.clone();
        drop(inner);
        self.store(&remembered);
    }

    fn store(&self, remembered: &Remembered) {
        let Some(file) = &self.store else { return };
        let written = file
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| {
                fs::write(
                    file,
                    serde_json::to_vec_pretty(remembered).unwrap_or_default(),
                )
            });
        if let Err(error) = written {
            activity::warn(
                Area::Saves,
                format!("Could not remember the chosen saves folder: {error}"),
            );
        }
    }

    /// The folders saves may be read from: those chosen, and the known
    /// games' own saves folders.
    fn folders(&self) -> Vec<PathBuf> {
        let mut folders: Vec<PathBuf> = self
            .lock()
            .remembered
            .folders
            .iter()
            .map(PathBuf::from)
            .collect();
        if let Some(documents) = &self.documents {
            for (game, _) in GAME_FOLDERS {
                folders.extend(default_folder(documents, game));
            }
        }
        folders
    }

    /// A folder the web app may list or follow: a remembered one, or a
    /// game's own saves folder.
    pub fn allowed_folder(&self, path: &str) -> Result<PathBuf, String> {
        let wanted = PathBuf::from(path);
        let canonical = fs::canonicalize(&wanted).ok();
        let allowed = self.folders().iter().any(|folder| {
            *folder == wanted
                || canonical
                    .as_ref()
                    .is_some_and(|c| fs::canonicalize(folder).ok().as_ref() == Some(c))
        });
        if allowed {
            Ok(wanted)
        } else {
            Err("Atlas may only look in a saves folder you chose.".to_owned())
        }
    }

    /// A save file the web app may read: a `.sav` file (not a link) directly
    /// in an allowed folder, or a file the person chose.
    pub fn allowed_save(&self, path: &str) -> Result<PathBuf, String> {
        let wanted = PathBuf::from(path);
        let refused = || "Atlas may only read saves in a folder you chose.".to_owned();
        if !is_save_name(&wanted) {
            return Err(refused());
        }
        let meta = fs::symlink_metadata(&wanted)
            .map_err(|_| format!("{} cannot be found.", file_name(&wanted)))?;
        if !meta.file_type().is_file() {
            return Err(refused());
        }
        let canonical = fs::canonicalize(&wanted).map_err(|_| refused())?;
        let files: Vec<PathBuf> = self
            .lock()
            .remembered
            .files
            .iter()
            .map(PathBuf::from)
            .collect();
        let chosen_file = files
            .iter()
            .any(|file| fs::canonicalize(file).ok().as_ref() == Some(&canonical));
        let in_folder = canonical.parent().is_some_and(|parent| {
            self.folders()
                .iter()
                .any(|folder| fs::canonicalize(folder).ok().as_deref() == Some(parent))
        });
        if chosen_file || in_folder {
            Ok(wanted)
        } else {
            Err(refused())
        }
    }

    /// Starts following a folder (its newest save) or a save file. The save
    /// there now counts as read already.
    pub fn watch(&self, path: &str) -> Result<WatchStatus, String> {
        let target = match self.allowed_folder(path) {
            Ok(folder) => Target::Folder(folder),
            Err(_) => Target::File(self.allowed_save(path)?),
        };
        let now = current(&target).map(|entry| observed(&entry));
        let shown = match &target {
            Target::Folder(folder) => file_name(folder),
            Target::File(file) => file_name(file),
        };
        activity::info(Area::Saves, format!("Following new saves in {shown}"));
        self.lock().watch = Some(Watch {
            target,
            shown,
            settler: Settler::new(SETTLE, now),
            settled: None,
            revision: 0,
        });
        Ok(self.watch_status())
    }

    pub fn unwatch(&self) {
        if let Some(watch) = self.lock().watch.take() {
            activity::info(
                Area::Saves,
                format!("Stopped following new saves in {}", watch.shown),
            );
        }
    }

    /// Looks at the followed folder or file again. Call it every few seconds.
    pub fn watch_status(&self) -> WatchStatus {
        let mut inner = self.lock();
        let Some(watch) = inner.watch.as_mut() else {
            return WatchStatus::default();
        };
        let newest = current(&watch.target);
        if let Some(settled) = watch
            .settler
            .observe(Instant::now(), newest.as_ref().map(observed))
        {
            if let Some(entry) = newest.clone().filter(|entry| observed(entry) == settled) {
                watch.revision += 1;
                watch.settled = Some(entry);
            }
        }
        WatchStatus {
            path: Some(match &watch.target {
                Target::Folder(path) | Target::File(path) => path.to_string_lossy().into_owned(),
            }),
            newest,
            settled: watch.settled.clone(),
            revision: watch.revision,
        }
    }
}

/// The save a watch looks at now: the newest in a folder, or the file.
fn current(target: &Target) -> Option<SaveEntry> {
    match target {
        Target::Folder(folder) => list_saves(folder).into_iter().next(),
        Target::File(file) => entry(file),
    }
}

fn is_save_name(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("sav"))
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn screenshot_path(save: &Path) -> PathBuf {
    save.with_extension("png")
}

/// A save file's entry, or `None` when it is not a plain save file.
fn entry(path: &Path) -> Option<SaveEntry> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || !is_save_name(path) {
        return None;
    }
    Some(SaveEntry {
        path: path.to_string_lossy().into_owned(),
        name: file_name(path),
        modified: meta.modified().map(millis).unwrap_or(0),
        size: meta.len(),
        screenshot: fs::symlink_metadata(screenshot_path(path))
            .is_ok_and(|meta| meta.file_type().is_file()),
    })
}

/// The saves directly in a folder, newest first.
pub fn list_saves(folder: &Path) -> Vec<SaveEntry> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut saves: Vec<SaveEntry> = entries
        .flatten()
        .filter_map(|item| entry(&item.path()))
        .collect();
    saves.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    saves
}

pub fn folder_info(folder: &Path) -> SaveFolder {
    SaveFolder {
        path: folder.to_string_lossy().into_owned(),
        name: file_name(folder),
        exists: folder.is_dir(),
        saves: list_saves(folder),
    }
}

/// What a save looked like on disk: its path, size and time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

fn observed(entry: &SaveEntry) -> Observed {
    Observed {
        path: entry.path.clone(),
        size: entry.size,
        modified: entry.modified,
    }
}

/// Tells when a save has settled: seen the same for `settle`, and not
/// announced before.
pub struct Settler {
    settle: Duration,
    candidate: Option<(Observed, Instant)>,
    announced: Option<Observed>,
}

impl Settler {
    /// `already`: the save there when following started, which counts as
    /// announced.
    pub fn new(settle: Duration, already: Option<Observed>) -> Self {
        Self {
            settle,
            candidate: None,
            announced: already,
        }
    }

    /// Takes a look at `seen` at `now`; returns it once it has settled.
    pub fn observe(&mut self, now: Instant, seen: Option<Observed>) -> Option<Observed> {
        let Some(seen) = seen else {
            self.candidate = None;
            return None;
        };
        let since = match &self.candidate {
            Some((candidate, since)) if *candidate == seen => *since,
            _ => {
                self.candidate = Some((seen.clone(), now));
                now
            }
        };
        if now.duration_since(since) >= self.settle && self.announced.as_ref() != Some(&seen) {
            self.announced = Some(seen.clone());
            return Some(seen);
        }
        None
    }
}

/// Why one read of a save did not give its bytes.
#[derive(Debug)]
enum ReadProblem {
    /// The file changed while it was read: the game is writing it.
    Changing,
    TooLarge,
    Empty,
    Io(std::io::Error),
}

fn read_once(path: &Path, max: u64) -> Result<Vec<u8>, ReadProblem> {
    let stamp = |meta: &fs::Metadata| (meta.len(), meta.modified().ok());
    let before = fs::metadata(path).map_err(ReadProblem::Io)?;
    if before.len() > max {
        return Err(ReadProblem::TooLarge);
    }
    if before.len() == 0 {
        return Err(ReadProblem::Changing);
    }
    let bytes = fs::read(path).map_err(ReadProblem::Io)?;
    let after = fs::metadata(path).map_err(ReadProblem::Io)?;
    if stamp(&before) != stamp(&after) || bytes.len() as u64 != after.len() {
        return Err(ReadProblem::Changing);
    }
    if bytes.is_empty() {
        return Err(ReadProblem::Empty);
    }
    Ok(bytes)
}

/// Reads a save file, read-only. When it changes under the read (the game
/// is writing it), waits `retry` and reads once more.
pub fn read_file(path: &Path, max: u64, retry: Duration) -> Result<(Vec<u8>, bool), String> {
    let name = file_name(path);
    let first = match read_once(path, max) {
        Ok(bytes) => return Ok((bytes, false)),
        Err(problem) => problem,
    };
    let problem = match first {
        ReadProblem::TooLarge => {
            return Err(format!("{name} is too large to be a game save."));
        }
        _ => {
            std::thread::sleep(retry);
            match read_once(path, max) {
                Ok(bytes) => return Ok((bytes, true)),
                Err(problem) => problem,
            }
        }
    };
    Err(match problem {
        ReadProblem::Changing | ReadProblem::Empty => format!(
            "The game was still writing {name}. It is read again once the game has finished."
        ),
        ReadProblem::TooLarge => format!("{name} is too large to be a game save."),
        ReadProblem::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            format!("{name} cannot be found any more.")
        }
        ReadProblem::Io(error) => format!("Could not read {name}: {error}"),
    })
}

fn megabytes(bytes: u64) -> String {
    let mb = bytes as f64 / 1_048_576.0;
    format!("{mb:.1} MB")
}

// ---------------------------------------------------------------------------
// Commands

type SavesState<'a> = State<'a, std::sync::Arc<Saves>>;

fn saves_of(saves: &SavesState<'_>) -> std::sync::Arc<Saves> {
    std::sync::Arc::clone(saves)
}

/// Where a game keeps its saves on this computer (under Documents), and
/// the saves there.
#[tauri::command]
pub async fn saves_default_folder(
    saves: SavesState<'_>,
    game: String,
) -> Result<SaveFolder, String> {
    let saves = saves_of(&saves);
    blocking(move || {
        saves
            .default_folder(&game)
            .map(|folder| folder_info(&folder))
    })
    .await
}

/// Asks for a saves folder; `None` when the person closes the dialog.
#[tauri::command]
pub async fn saves_choose_folder<R: Runtime>(
    window: WebviewWindow<R>,
    saves: SavesState<'_>,
    game: String,
) -> Result<Option<SaveFolder>, String> {
    let mut dialog = file_dialog(&window, "Choose the folder with your game saves");
    if let Some(start) = saves.dialog_start(&game) {
        dialog = dialog.set_directory(start);
    }
    let Some(folder) = chosen_path(|done| dialog.pick_folder(done)).await? else {
        return Ok(None);
    };
    let saves = saves_of(&saves);
    blocking(move || {
        saves.remember(&folder, true);
        let info = folder_info(&folder);
        activity::info(
            Area::Saves,
            format!(
                "Linked the saves folder {} ({} saves)",
                info.name,
                info.saves.len()
            ),
        );
        Ok(Some(info))
    })
    .await
}

/// Asks for one save file; `None` when the person closes the dialog.
#[tauri::command]
pub async fn saves_choose_file<R: Runtime>(
    window: WebviewWindow<R>,
    saves: SavesState<'_>,
    game: String,
) -> Result<Option<SaveEntry>, String> {
    let mut dialog = file_dialog(&window, "Choose a game save").add_filter("Game saves", &["sav"]);
    if let Some(start) = saves.dialog_start(&game) {
        dialog = dialog.set_directory(start);
    }
    let Some(file) = chosen_path(|done| dialog.pick_file(done)).await? else {
        return Ok(None);
    };
    let saves = saves_of(&saves);
    blocking(move || {
        let save =
            entry(&file).ok_or_else(|| format!("{} is not a game save.", file_name(&file)))?;
        saves.remember(&file, false);
        activity::info(Area::Saves, format!("Linked the save {}", save.name));
        Ok(Some(save))
    })
    .await
}

/// The saves in a folder the person chose (or the game's own), newest first.
#[tauri::command]
pub async fn saves_list(saves: SavesState<'_>, folder: String) -> Result<SaveFolder, String> {
    let saves = saves_of(&saves);
    blocking(move || {
        saves
            .allowed_folder(&folder)
            .map(|folder| folder_info(&folder))
    })
    .await
}

/// The bytes of a save, read-only.
#[tauri::command]
pub async fn saves_read(saves: SavesState<'_>, path: String) -> Result<Response, String> {
    let saves = saves_of(&saves);
    blocking(move || {
        let path = saves.allowed_save(&path)?;
        let started = Instant::now();
        match read_file(&path, MAX_SAVE_BYTES, RETRY_DELAY) {
            Ok((bytes, retried)) => {
                activity::info(
                    Area::Saves,
                    format!(
                        "Read {} ({}, {} ms){}",
                        file_name(&path),
                        megabytes(bytes.len() as u64),
                        started.elapsed().as_millis(),
                        if retried {
                            ", after waiting for the game to finish writing it"
                        } else {
                            ""
                        }
                    ),
                );
                Ok(Response::new(bytes))
            }
            Err(error) => {
                activity::warn(Area::Saves, &error);
                Err(error)
            }
        }
    })
    .await
}

/// The screenshot the game keeps next to a save.
#[tauri::command]
pub async fn saves_screenshot(saves: SavesState<'_>, path: String) -> Result<Response, String> {
    let saves = saves_of(&saves);
    blocking(move || {
        let save = saves.allowed_save(&path)?;
        let image = screenshot_path(&save);
        let missing = || "This save has no screenshot.".to_owned();
        let meta = fs::symlink_metadata(&image).map_err(|_| missing())?;
        if !meta.file_type().is_file() || meta.len() > MAX_SCREENSHOT_BYTES {
            return Err(missing());
        }
        fs::read(&image).map(Response::new).map_err(|_| missing())
    })
    .await
}

/// Follows a folder (its newest save) or one save file.
#[tauri::command]
pub async fn saves_watch(saves: SavesState<'_>, path: String) -> Result<WatchStatus, String> {
    let saves = saves_of(&saves);
    blocking(move || saves.watch(&path)).await
}

/// Looks at the followed folder or file again (see [`WatchStatus`]).
#[tauri::command]
pub async fn saves_watch_status(saves: SavesState<'_>) -> Result<WatchStatus, String> {
    let saves = saves_of(&saves);
    blocking(move || Ok(saves.watch_status())).await
}

#[tauri::command]
pub fn saves_unwatch(saves: SavesState<'_>) {
    saves.unwatch();
}

/// How reading a save went, from the web app, for the activity log. Names
/// of files, versions, world ids and counts only: nothing from inside the
/// save that names the player.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    file: String,
    ok: bool,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    world: Option<String>,
    #[serde(default)]
    matched: u32,
    #[serde(default)]
    marked: u32,
    #[serde(default)]
    message: Option<String>,
}

fn short(text: &str, max: usize) -> String {
    let text = activity::clean(text);
    if text.chars().count() > max {
        text.chars().take(max).collect::<String>() + "…"
    } else {
        text
    }
}

pub fn report_line(report: &SaveReport) -> String {
    let file = short(&report.file, 80);
    if !report.ok {
        return format!(
            "Could not use the save {file}: {}",
            short(report.message.as_deref().unwrap_or("no reason given"), 300)
        );
    }
    let mut line = format!("Used the save {file}");
    if let Some(version) = &report.version {
        line += &format!(" ({})", short(version, 80));
    }
    if let Some(world) = &report.world {
        line += &format!(" | world {}", short(world, 40));
    }
    line += &format!(
        " | {} places matched, {} newly marked found",
        report.matched, report.marked
    );
    line
}

#[tauri::command]
pub fn saves_report(report: SaveReport) {
    let line = report_line(&report);
    if report.ok {
        activity::info(Area::Saves, line);
    } else {
        activity::warn(Area::Saves, line);
    }
}

/// The saves service for the app: `saves.json` in the app's data folder,
/// and the person's Documents folder.
pub fn for_app<R: Runtime>(app: &tauri::App<R>) -> Saves {
    let paths = app.path();
    Saves::new(paths.app_data_dir().ok(), paths.document_dir().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    fn setup(name: &str) -> (TempDir, Saves, PathBuf) {
        let dir = TempDir::new(&format!("saves-{name}"));
        let documents = dir.0.join("Documents");
        let folder = documents.join("The Witcher 3").join("gamesaves");
        fs::create_dir_all(&folder).unwrap();
        let saves = Saves::new(Some(dir.0.join("app")), Some(documents));
        (dir, saves, folder)
    }

    fn touch(path: &Path, bytes: &[u8], age_secs: u64) {
        fs::write(path, bytes).unwrap();
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(age_secs))
            .unwrap();
    }

    #[test]
    fn knows_where_the_witcher_3_keeps_its_saves() {
        let documents = Path::new("docs");
        assert_eq!(
            default_folder(documents, "witcher3"),
            Some(documents.join("The Witcher 3").join("gamesaves"))
        );
        assert_eq!(default_folder(documents, "other"), None);
    }

    #[test]
    fn lists_saves_newest_first_with_their_screenshots() {
        let (_dir, saves, folder) = setup("list");
        touch(&folder.join("ManualSave_1.sav"), b"one", 300);
        touch(&folder.join("AutoSave_2.sav"), b"two!", 100);
        touch(&folder.join("AutoSave_2.png"), b"png", 100);
        touch(&folder.join("QuickSave.SAV"), b"three", 200);
        touch(&folder.join("notes.txt"), b"x", 0);
        fs::create_dir_all(folder.join("folder.sav")).unwrap();

        let listed = saves
            .allowed_folder(&folder.to_string_lossy())
            .map(|folder| folder_info(&folder))
            .unwrap();
        assert!(listed.exists);
        assert_eq!(listed.name, "gamesaves");
        let names: Vec<_> = listed.saves.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            ["AutoSave_2.sav", "QuickSave.SAV", "ManualSave_1.sav"]
        );
        assert!(listed.saves[0].screenshot);
        assert!(!listed.saves[1].screenshot);
        assert_eq!(listed.saves[0].size, 4);
    }

    #[test]
    fn reads_only_saves_in_folders_and_files_the_person_chose() {
        let (dir, saves, folder) = setup("allowed");
        let save = folder.join("ManualSave_1.sav");
        touch(&save, b"save", 10);
        let elsewhere = dir.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let other = elsewhere.join("Other.sav");
        touch(&other, b"other", 10);
        let not_a_save = folder.join("ManualSave_1.png");
        touch(&not_a_save, b"png", 10);

        assert!(saves.allowed_save(&save.to_string_lossy()).is_ok());
        assert!(saves.allowed_save(&other.to_string_lossy()).is_err());
        assert!(saves.allowed_save(&not_a_save.to_string_lossy()).is_err());
        assert!(saves
            .allowed_save(&folder.join("missing.sav").to_string_lossy())
            .is_err());
        // A path that climbs out of an allowed folder is judged by where it lands.
        let climbing = folder
            .join("..")
            .join("..")
            .join("..")
            .join("elsewhere")
            .join("Other.sav");
        assert!(saves.allowed_save(&climbing.to_string_lossy()).is_err());
        assert!(saves.allowed_folder(&elsewhere.to_string_lossy()).is_err());

        // Choosing the file, or its folder, allows it, also after a restart.
        saves.remember(&other, false);
        assert!(saves.allowed_save(&other.to_string_lossy()).is_ok());
        let another = elsewhere.join("Another.sav");
        touch(&another, b"x", 10);
        assert!(saves.allowed_save(&another.to_string_lossy()).is_err());
        saves.remember(&elsewhere, true);
        let restarted = Saves::new(Some(dir.0.join("app")), Some(dir.0.join("Documents")));
        assert!(restarted.allowed_save(&another.to_string_lossy()).is_ok());
        assert!(restarted
            .allowed_folder(&elsewhere.to_string_lossy())
            .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_link_out_of_the_folder() {
        let (dir, saves, folder) = setup("links");
        let secret = dir.0.join("secret.sav");
        touch(&secret, b"secret", 10);
        let link = folder.join("Link.sav");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(saves.allowed_save(&link.to_string_lossy()).is_err());
        assert!(list_saves(&folder).is_empty());
    }

    #[test]
    fn reads_a_save_and_refuses_oversized_or_missing_ones() {
        let (_dir, _saves, folder) = setup("read");
        let save = folder.join("QuickSave.sav");
        touch(&save, b"SNFHFZLC....", 10);
        let (bytes, retried) = read_file(&save, MAX_SAVE_BYTES, Duration::ZERO).unwrap();
        assert_eq!(bytes, b"SNFHFZLC....");
        assert!(!retried);
        assert!(read_file(&save, 4, Duration::ZERO)
            .unwrap_err()
            .contains("too large"));
        assert!(
            read_file(&folder.join("Gone.sav"), MAX_SAVE_BYTES, Duration::ZERO)
                .unwrap_err()
                .contains("cannot be found")
        );
        // An empty file is a save the game has only begun to write.
        let empty = folder.join("Empty.sav");
        touch(&empty, b"", 0);
        assert!(read_file(&empty, MAX_SAVE_BYTES, Duration::ZERO)
            .unwrap_err()
            .contains("still writing"));
    }

    #[test]
    fn reads_again_when_the_game_was_still_writing() {
        let (_dir, _saves, folder) = setup("retry");
        let save = folder.join("AutoSave_1.sav");
        touch(&save, b"", 0);
        let writer = {
            let save = save.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                fs::write(&save, b"finished").unwrap();
            })
        };
        let (bytes, retried) =
            read_file(&save, MAX_SAVE_BYTES, Duration::from_millis(900)).unwrap();
        writer.join().unwrap();
        assert_eq!(bytes, b"finished");
        assert!(retried);
    }

    #[test]
    fn settles_a_save_once_it_stops_changing() {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        let seen = |size: u64, path: &str| Observed {
            path: path.to_owned(),
            size,
            modified: size,
        };
        let mut settler = Settler::new(Duration::from_secs(3), Some(seen(1, "a")));
        // The save there when following starts is not announced.
        assert_eq!(settler.observe(at(0), Some(seen(1, "a"))), None);
        assert_eq!(settler.observe(at(5), Some(seen(1, "a"))), None);
        // A new save, still growing.
        assert_eq!(settler.observe(at(6), Some(seen(10, "b"))), None);
        assert_eq!(settler.observe(at(8), Some(seen(20, "b"))), None);
        assert_eq!(settler.observe(at(10), Some(seen(20, "b"))), None);
        assert_eq!(
            settler.observe(at(11), Some(seen(20, "b"))),
            Some(seen(20, "b"))
        );
        // Announced once only.
        assert_eq!(settler.observe(at(20), Some(seen(20, "b"))), None);
        // The folder emptied, then the same save again: not announced twice.
        assert_eq!(settler.observe(at(21), None), None);
        assert_eq!(settler.observe(at(30), Some(seen(20, "b"))), None);
        assert_eq!(settler.observe(at(34), Some(seen(20, "b"))), None);
    }

    #[test]
    fn follows_the_newest_save_in_a_folder() {
        let (_dir, saves, folder) = setup("watch");
        touch(&folder.join("ManualSave_1.sav"), b"one", 60);
        let status = saves.watch(&folder.to_string_lossy()).unwrap();
        assert_eq!(status.revision, 0);
        assert_eq!(status.newest.unwrap().name, "ManualSave_1.sav");
        assert!(status.settled.is_none());

        touch(&folder.join("AutoSave_2.sav"), b"two", 30);
        let status = saves.watch_status();
        assert_eq!(status.newest.unwrap().name, "AutoSave_2.sav");
        assert_eq!(status.revision, 0, "not settled yet");

        saves.unwatch();
        let status = saves.watch_status();
        assert!(status.path.is_none());
        assert!(saves.watch("/not/allowed").is_err());
    }

    #[test]
    fn reports_without_anything_from_inside_the_save() {
        let report: SaveReport = serde_json::from_value(serde_json::json!({
            "file": "ManualSave_12.sav",
            "ok": true,
            "version": "save version 67, game version 29, format 164",
            "world": "novigrad",
            "matched": 31,
            "marked": 4
        }))
        .unwrap();
        assert_eq!(
            report_line(&report),
            "Used the save ManualSave_12.sav (save version 67, game version 29, format 164) | world novigrad | 31 places matched, 4 newly marked found"
        );
        let failed: SaveReport = serde_json::from_value(serde_json::json!({
            "file": "AutoSave_3.sav",
            "ok": false,
            "message": "This Witcher 3 save was written by a game version Atlas cannot read yet.\nNothing was changed."
        }))
        .unwrap();
        assert_eq!(
            report_line(&failed),
            "Could not use the save AutoSave_3.sav: This Witcher 3 save was written by a game version Atlas cannot read yet. Nothing was changed."
        );
    }
}
