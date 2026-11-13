//! The commands the web app may call (see `capabilities/main.json`, and
//! `capabilities/downloads/` for the commands of a build with downloads).
//!
//! They cover what a browser does differently from a desktop app: saving and
//! opening progress files through the system's dialogs, opening links in the
//! system browser, the maps library, and, in a build with the `downloads`
//! feature only, downloading map images. The web app reaches them through a
//! small bridge that it only uses when it runs inside this shell.

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::Manager as _;
use tauri::{AppHandle, Runtime, State, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{
    activity::{self, ActivityLog, Area, RecentLog},
    downloads::Downloads,
    imports::{Imports, PollResult},
    library::{FolderChoice, Library, Listing, SaveImport, SavedSource},
    packfile::{self, AppInfo, ExportOptions, Progress, Stop},
    removal::{ImagesCount, ImagesDeleted, PackDeleted},
    tiles::pyramid::Detail,
};
#[cfg(feature = "downloads")]
use crate::{
    settings::DownloadSettings,
    tiles::{
        manager::{PlanInfo, Snapshot},
        measure::{MeasureRequest, Measured},
        DownloadManager,
    },
};

/// Progress files larger than this are not an Atlas export.
const MAX_OPEN_BYTES: u64 = 64 << 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// The app's name, which a build may set (see apps/desktop/README.md).
    name: String,
    version: String,
    platform: &'static str,
    /// The build downloads map images and saves them from map pages (the
    /// `downloads` feature). Without it, those commands do not exist.
    downloads: bool,
    /// Folders can be chosen and shown in the file manager: the maps folder
    /// can be changed, pack folders added and the Maps dialog used. False
    /// on Android, which keeps its maps in the app's own storage.
    folders: bool,
    /// The Maps dialog is offered: the packs shown, opening, deleting and
    /// importing them. True in every build; without `folders` (Android) it
    /// has no folder choices and no file manager buttons.
    maps: bool,
    /// Progress can be exported to and imported from files through the
    /// system's save and open dialogs. On Android those give `content://`
    /// addresses, which are read and written through the fs plugin.
    progress_files: bool,
    /// Web pages can be opened in the import window, for importers. False on
    /// Android.
    imports: bool,
    /// Map pack files are picked with the system's picker and copied into
    /// the app before they are imported (`packfile_pick_copy`,
    /// `packfile_copy_picked`), since the picker gives no path. True on
    /// Android; a desktop uses `packfile_pick`.
    copy_picked_files: bool,
}

/// Whether this platform has what `DesktopInfo::folders` and
/// `DesktopInfo::imports` need: a desktop's dialogs, file manager and
/// windows.
const DESKTOP_ONLY: bool = cfg!(desktop);

/// The answer of a desktop-only command on Android, whose web app does not
/// offer it.
const NOT_ON_THIS_DEVICE: &str = "This is not available on this device.";

fn desktop_only() -> Result<(), String> {
    if DESKTOP_ONLY {
        Ok(())
    } else {
        Err(NOT_ON_THIS_DEVICE.to_owned())
    }
}

#[tauri::command]
pub fn desktop_info<R: Runtime>(app: AppHandle<R>) -> DesktopInfo {
    DesktopInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        downloads: Downloads::in_build(),
        folders: DESKTOP_ONLY,
        maps: true,
        progress_files: true,
        imports: DESKTOP_ONLY,
        copy_picked_files: !DESKTOP_ONLY,
    }
}

/// An `http` or `https` URL to show in the system browser, or `None`.
pub fn external_url(url: &str) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some()).then_some(url)
}

/// Opens a web link in the system browser. Only `http` and `https`.
#[tauri::command]
pub fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let url = external_url(&url).ok_or_else(|| "Only web links can be opened.".to_owned())?;
    open_in_browser(&app, &url)
}

pub fn open_in_browser<R: Runtime>(app: &AppHandle<R>, url: &Url) -> Result<(), String> {
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open the link: {error}"))
}

/// A file dialog over `window`: on top of it, where the platform has windows.
pub(crate) fn file_dialog<R: Runtime>(
    window: &WebviewWindow<R>,
    title: &str,
) -> FileDialogBuilder<R> {
    let dialog = window.dialog().file();
    #[cfg(desktop)]
    let dialog = dialog.set_parent(window);
    dialog.set_title(title)
}

/// What the person chose in a file dialog: a path on a desktop, a
/// `content://` address on Android. `None` when the dialog was closed.
async fn chosen_file(
    pick: impl FnOnce(Box<dyn FnOnce(Option<FilePath>) + Send>),
) -> Option<FilePath> {
    let (send, receive) = oneshot::channel();
    pick(Box::new(move |path| {
        let _ = send.send(path);
    }));
    receive.await.ok().flatten()
}

pub(crate) async fn chosen_path(
    pick: impl FnOnce(Box<dyn FnOnce(Option<FilePath>) + Send>),
) -> Result<Option<PathBuf>, String> {
    match chosen_file(pick).await {
        None => Ok(None),
        Some(path) => path
            .into_path()
            .map(Some)
            .map_err(|error| format!("That location cannot be used: {error}")),
    }
}

/// A file the system's dialog gave as an address rather than a path: a
/// `content://` address on Android. `None` for a path (or a `file:` URL),
/// which is used as on a desktop.
fn content_address(file: &FilePath) -> Option<&Url> {
    match file {
        FilePath::Url(url) if url.scheme() != "file" => Some(url),
        _ => None,
    }
}

/// Files behind `content://` addresses, opened through the fs plugin, which
/// asks Android for a file descriptor. Only the Android app has them.
#[cfg(target_os = "android")]
mod content {
    use std::fs::File;

    use tauri::{AppHandle, Manager as _, Runtime, Url};
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    pub fn open<R: Runtime>(app: &AppHandle<R>, url: &Url) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(true);
        app.fs().open(FilePath::Url(url.clone()), options)
    }

    /// Opens for writing from the start, dropping what was there ("wt").
    /// A file the save screen has just made is empty, so where a provider
    /// does not take "wt", plain "w" does the same.
    pub fn create<R: Runtime>(app: &AppHandle<R>, url: &Url) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(false).write(true).truncate(true).create(true);
        app.fs()
            .open(FilePath::Url(url.clone()), options.clone())
            .or_else(|_| {
                options.truncate(false);
                app.fs().open(FilePath::Url(url.clone()), options)
            })
    }

    /// The name the file has where it is, as the system shows it.
    pub fn name<R: Runtime>(app: &AppHandle<R>, url: &Url) -> Option<String> {
        app.path().file_name(url.as_str())
    }
}

#[cfg(not(target_os = "android"))]
mod content {
    use std::fs::File;

    use tauri::{AppHandle, Runtime, Url};

    fn unusable(url: &Url) -> std::io::Error {
        std::io::Error::other(format!("That location cannot be used: {url}"))
    }

    pub fn open<R: Runtime>(_app: &AppHandle<R>, url: &Url) -> std::io::Result<File> {
        Err(unusable(url))
    }

    pub fn create<R: Runtime>(_app: &AppHandle<R>, url: &Url) -> std::io::Result<File> {
        Err(unusable(url))
    }

    pub fn name<R: Runtime>(_app: &AppHandle<R>, _url: &Url) -> Option<String> {
        None
    }
}

/// A file name to suggest in the save dialog: the web app's name, kept to
/// safe characters.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.');
    if cleaned.is_empty() {
        "atlas-progress.json".to_owned()
    } else {
        cleaned.to_owned()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    name: String,
}

/// Asks where to save a progress export and writes it there. `None` when
/// the person closes the dialog.
///
/// On Android the save screen gives a `content://` address, written through
/// the fs plugin.
#[tauri::command]
pub async fn save_text_file<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    suggested_name: String,
    contents: String,
) -> Result<Option<SavedFile>, String> {
    let suggested = safe_file_name(&suggested_name);
    let dialog = file_dialog(&window, "Export progress")
        .set_file_name(suggested.clone())
        .add_filter("Atlas progress", &["json"]);
    let Some(file) = chosen_file(|done| dialog.save_file(done)).await else {
        return Ok(None);
    };
    if let Some(url) = content_address(&file) {
        let url = url.clone();
        return blocking(move || {
            let written = content::create(&app, &url)
                .and_then(|file| write_stream(file, contents.as_bytes()));
            let name = content::name(&app, &url).unwrap_or(suggested);
            written.map_err(|error| format!("Could not save {name}: {error}"))?;
            Ok(Some(SavedFile { name }))
        })
        .await;
    }
    let path = file
        .into_path()
        .map_err(|error| format!("That location cannot be used: {error}"))?;
    write_text(&path, &contents)?;
    Ok(Some(SavedFile {
        name: file_name(&path),
    }))
}

/// Writes all of `bytes` to a file opened for writing and makes sure they
/// reached it.
fn write_stream(mut file: impl std::io::Write, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.flush()
}

fn file_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn write_text(path: &std::path::Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents)
        .map_err(|error| format!("Could not save {}: {error}", file_name(path)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    name: String,
    contents: String,
}

fn read_text(path: &std::path::Path) -> Result<OpenedFile, String> {
    let name = file_name(path);
    let size = fs::metadata(path)
        .map_err(|error| format!("Could not open {name}: {error}"))?
        .len();
    if size > MAX_OPEN_BYTES {
        return Err(format!("{name} is too large to be an Atlas progress file."));
    }
    let bytes = fs::read(path).map_err(|error| format!("Could not open {name}: {error}"))?;
    let contents = String::from_utf8(bytes)
        .map_err(|_| format!("{name} is not a text file, so it is not an Atlas progress file."))?;
    Ok(OpenedFile { name, contents })
}

/// The text of a progress file read in order (a `content://` file on
/// Android), with the same limits as [`read_text`].
fn read_text_stream(name: String, file: impl std::io::Read) -> Result<OpenedFile, String> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    file.take(MAX_OPEN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not open {name}: {error}"))?;
    if bytes.len() as u64 > MAX_OPEN_BYTES {
        return Err(format!("{name} is too large to be an Atlas progress file."));
    }
    let contents = String::from_utf8(bytes)
        .map_err(|_| format!("{name} is not a text file, so it is not an Atlas progress file."))?;
    Ok(OpenedFile { name, contents })
}

/// Asks for a progress file to import and returns its text. `None` when the
/// person closes the dialog.
///
/// On Android the picker gives a `content://` address, read through the fs
/// plugin. It offers every file there, since a progress file in a cloud
/// drive or a chat app may not be marked as JSON; the web app checks what
/// is read.
#[tauri::command]
pub async fn open_text_file<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<OpenedFile>, String> {
    let dialog = file_dialog(&window, "Import progress");
    #[cfg(desktop)]
    let dialog = dialog.add_filter("Atlas progress", &["json"]);
    let Some(file) = chosen_file(|done| dialog.pick_file(done)).await else {
        return Ok(None);
    };
    if let Some(url) = content_address(&file) {
        let url = url.clone();
        return blocking(move || {
            let name = content::name(&app, &url).unwrap_or_else(|| "The file".to_owned());
            let opened = content::open(&app, &url)
                .map_err(|error| format!("Could not open {name}: {error}"))?;
            read_text_stream(name, opened).map(Some)
        })
        .await;
    }
    let path = file
        .into_path()
        .map_err(|error| format!("That location cannot be used: {error}"))?;
    read_text(&path).map(Some)
}

#[cfg(feature = "downloads")]
type Manager<'a> = State<'a, Arc<DownloadManager>>;

/// The download choices for a pack, with estimates.
#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn tiles_plan(manager: Manager<'_>, pack_id: String) -> Result<PlanInfo, String> {
    let manager = Arc::clone(&manager);
    // Looks at every tile on disk.
    tokio::task::spawn_blocking(move || manager.plan_info(&pack_id))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn tiles_start(
    manager: Manager<'_>,
    pack_id: String,
    detail: Detail,
) -> Result<Snapshot, String> {
    manager.start(&pack_id, detail)
}

#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn tiles_pause(manager: Manager<'_>, pack_id: String) -> Result<Snapshot, String> {
    manager.pause(&pack_id)
}

#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn tiles_resume(manager: Manager<'_>, pack_id: String) -> Result<Snapshot, String> {
    manager.resume(&pack_id)
}

#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn tiles_cancel(manager: Manager<'_>, pack_id: String) -> Result<(), String> {
    manager.cancel(&pack_id)
}

/// Which map images of one zoom exist around a start tile, for an importer
/// that sizes a map's picture by them (`ImportContext.pictureTiles`), or
/// what was learnt about them before. Only the app's own window may ask;
/// the capability grants it to no other window either. None when the
/// picture cannot be measured; the activity log says why.
#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn picture_tiles<R: Runtime>(
    window: WebviewWindow<R>,
    manager: Manager<'_>,
    request: MeasureRequest,
) -> Result<Option<Measured>, String> {
    if window.label() != crate::MAIN_WINDOW {
        return Err("Only the app's own window can measure a map picture.".to_owned());
    }
    let manager = Arc::clone(&manager);
    Ok(manager.measure_picture(&request).await)
}

/// Stops a measurement of a map picture, when an import is cancelled.
#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn picture_cancel<R: Runtime>(
    window: WebviewWindow<R>,
    manager: Manager<'_>,
) -> Result<(), String> {
    if window.label() != crate::MAIN_WINDOW {
        return Err("Only the app's own window can stop measuring a map picture.".to_owned());
    }
    manager.cancel_measuring();
    Ok(())
}

/// Reads one address for an importer that reads pages by fetching them
/// (see `pagefetch.rs`). Only the app's own window may ask.
#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn import_fetch<R: Runtime>(
    window: WebviewWindow<R>,
    url: String,
) -> Result<crate::pagefetch::FetchedPage, String> {
    if window.label() != crate::MAIN_WINDOW {
        return Err("Only the app's own window can read pages.".to_owned());
    }
    crate::pagefetch::fetch_page(&url).await
}

#[cfg(feature = "downloads")]
#[tauri::command]
pub async fn tiles_snapshot(
    manager: Manager<'_>,
    pack_id: String,
) -> Result<Option<Snapshot>, String> {
    Ok(manager.snapshot(&pack_id))
}

// ---------------------------------------------------------------------------
// Download settings

#[cfg(feature = "downloads")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettingsInfo {
    settings: DownloadSettings,
    /// Lowest and highest allowed value of each setting.
    bounds: DownloadBounds,
}

#[cfg(feature = "downloads")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadBounds {
    parallel: (u32, u32),
    pause_ms: (u32, u32),
    requests_per_minute: (u32, u32),
    kilobytes_per_second: (u32, u32),
}

type LibraryState<'a> = State<'a, Arc<Library>>;

#[cfg(feature = "downloads")]
fn settings_info(settings: DownloadSettings) -> DownloadSettingsInfo {
    DownloadSettingsInfo {
        settings,
        bounds: DownloadBounds {
            parallel: DownloadSettings::PARALLEL,
            pause_ms: DownloadSettings::PAUSE_MS,
            requests_per_minute: DownloadSettings::REQUESTS_PER_MINUTE,
            kilobytes_per_second: DownloadSettings::KILOBYTES_PER_SECOND,
        },
    }
}

#[cfg(feature = "downloads")]
#[tauri::command]
pub fn download_settings_get(library: LibraryState<'_>) -> DownloadSettingsInfo {
    settings_info(library.settings().read().downloads)
}

/// Saves the download settings for every Atlas app and applies them at once.
#[cfg(feature = "downloads")]
#[tauri::command]
pub fn download_settings_set(
    library: LibraryState<'_>,
    manager: Manager<'_>,
    settings: DownloadSettings,
) -> Result<DownloadSettingsInfo, String> {
    let settings = settings.validate()?;
    library
        .settings()
        .update(|shared| shared.downloads = settings)?;
    manager.set_download_settings(&settings);
    Ok(settings_info(settings))
}

// ---------------------------------------------------------------------------
// The maps library

/// This app's downloads, as the library sees them; none in a build without
/// downloads.
type DownloadsState<'a> = State<'a, Downloads>;

pub(crate) async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

/// Asks for a folder. Android has no folder dialog.
#[cfg(desktop)]
async fn pick_folder<R: Runtime>(
    window: &WebviewWindow<R>,
    title: &str,
) -> Result<Option<PathBuf>, String> {
    let mut dialog = file_dialog(window, title);
    // Start in the home folder rather than a list of recent files.
    if let Ok(home) = window.path().home_dir() {
        dialog = dialog.set_directory(home);
    }
    chosen_path(|done| dialog.pick_folder(done)).await
}

#[cfg(mobile)]
#[allow(clippy::unused_async)]
async fn pick_folder<R: Runtime>(
    _window: &WebviewWindow<R>,
    _title: &str,
) -> Result<Option<PathBuf>, String> {
    Err(NOT_ON_THIS_DEVICE.to_owned())
}

/// Asks for a folder, starting in `start` when given (saves and game
/// folders). Android has no folder dialog.
#[cfg(desktop)]
pub(crate) async fn pick_folder_at<R: Runtime>(
    window: &WebviewWindow<R>,
    title: &str,
    start: Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    let mut dialog = file_dialog(window, title);
    if let Some(start) = start {
        dialog = dialog.set_directory(start);
    }
    chosen_path(|done| dialog.pick_folder(done)).await
}

#[cfg(mobile)]
#[allow(clippy::unused_async)]
pub(crate) async fn pick_folder_at<R: Runtime>(
    _window: &WebviewWindow<R>,
    _title: &str,
    _start: Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    Err(NOT_ON_THIS_DEVICE.to_owned())
}

/// Lists every pack the app can show, after looking at every folder again.
#[tauri::command]
pub async fn library_list(library: LibraryState<'_>) -> Result<Listing, String> {
    let library = Arc::clone(&library);
    blocking(move || Ok(library.scan())).await
}

/// Asks for a pack folder and remembers it. The pack id, or `None` when the
/// dialog was closed.
#[tauri::command]
pub async fn library_open_pack<R: Runtime>(
    window: WebviewWindow<R>,
    library: LibraryState<'_>,
) -> Result<Option<String>, String> {
    let Some(path) = pick_folder(&window, "Open a map pack").await? else {
        return Ok(None);
    };
    let library = Arc::clone(&library);
    blocking(move || library.add_pack_location(&path).map(Some)).await
}

/// Asks for a folder of map packs and remembers it. The number of packs in
/// it, or `None` when the dialog was closed.
#[tauri::command]
pub async fn library_add_folder<R: Runtime>(
    window: WebviewWindow<R>,
    library: LibraryState<'_>,
) -> Result<Option<usize>, String> {
    let Some(path) = pick_folder(&window, "Add a folder of map packs").await? else {
        return Ok(None);
    };
    let library = Arc::clone(&library);
    blocking(move || library.add_folder_location(&path).map(Some)).await
}

/// Forgets a remembered location. Its files are left alone.
#[tauri::command]
pub fn library_remove_location(library: LibraryState<'_>, path: String) -> Result<(), String> {
    library.remove_location(&path)
}

/// Asks for a new maps folder. It is used only after
/// `library_apply_maps_folder`.
#[tauri::command]
pub async fn library_choose_maps_folder<R: Runtime>(
    window: WebviewWindow<R>,
    library: LibraryState<'_>,
) -> Result<Option<FolderChoice>, String> {
    let Some(path) = pick_folder(&window, "Choose where maps are saved").await? else {
        return Ok(None);
    };
    let library = Arc::clone(&library);
    blocking(move || library.propose_maps_folder(&path).map(Some)).await
}

/// Uses the chosen maps folder from now on, moving the maps there or not.
#[tauri::command]
pub async fn library_apply_maps_folder(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    move_packs: bool,
) -> Result<Vec<String>, String> {
    let busy = downloads.active_packs();
    let library = Arc::clone(&library);
    blocking(move || library.apply_maps_folder(move_packs, &busy)).await
}

/// What to show in the system's file manager.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RevealTarget {
    MapsFolder,
    Pack {
        id: String,
    },
    Location {
        path: String,
    },
    /// The activity log's folder.
    LogFolder,
}

/// Opens the maps folder, a pack's folder or a remembered location in the
/// system's file manager. Only those: the web app cannot name another path.
#[tauri::command]
pub fn library_reveal<R: Runtime>(
    app: AppHandle<R>,
    library: LibraryState<'_>,
    target: RevealTarget,
) -> Result<(), String> {
    desktop_only()?;
    let path = match target {
        RevealTarget::MapsFolder => {
            let folder = library.maps_folder();
            fs::create_dir_all(&folder)
                .map_err(|error| format!("Cannot create the maps folder: {error}"))?;
            folder
        }
        RevealTarget::Pack { id } => library
            .pack_folder(&id)
            .ok_or_else(|| "That pack has no folder.".to_owned())?,
        RevealTarget::Location { path } => library
            .known_location(&path)
            .ok_or_else(|| "That location is not remembered.".to_owned())?,
        RevealTarget::LogFolder => {
            let folder = ActivityLog::global()
                .dir()
                .map(std::path::Path::to_path_buf)
                .ok_or_else(|| "This app keeps no activity log.".to_owned())?;
            fs::create_dir_all(&folder)
                .map_err(|error| format!("Cannot create the log folder: {error}"))?;
            folder
        }
    };
    if !path.is_dir() {
        return Err("That folder cannot be found.".to_owned());
    }
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|error| format!("Could not open the folder: {error}"))
}

/// How long a download may take to stop before a delete gives up.
const STOP_TIMEOUT: Duration = Duration::from_secs(60);

/// Stops a pack's download, if one is running or paused, and waits until it
/// has let go of the pack's files.
async fn stop_download(downloads: &Downloads, id: &str) -> Result<(), String> {
    if downloads.stop_and_wait(id, STOP_TIMEOUT).await {
        Ok(())
    } else {
        Err("The download of this map did not stop in time, so nothing was deleted. Try again in a moment.".to_owned())
    }
}

fn listed(library: &Library, id: &str) -> Result<(), String> {
    if library.is_listed(id) {
        Ok(())
    } else {
        Err("That map is not in the list any more. Refresh the list and try again.".to_owned())
    }
}

/// Deletes a pack, with its map images, from the maps folder. A download of
/// it is stopped first, and everything kept about its downloads is
/// forgotten. Only packs in the maps folder that do not come with the app.
#[tauri::command]
pub async fn library_delete_pack(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    id: String,
) -> Result<PackDeleted, String> {
    delete_pack(Arc::clone(&library), downloads.inner().clone(), id).await
}

async fn delete_pack(
    library: Arc<Library>,
    downloads: Downloads,
    id: String,
) -> Result<PackDeleted, String> {
    listed(&library, &id)?;
    {
        // The same checks as deleting, before any download is stopped.
        let library = Arc::clone(&library);
        let id = id.clone();
        blocking(move || library.check_deletable(&id)).await?;
    }
    stop_download(&downloads, &id).await?;
    let deleted = {
        let id = id.clone();
        blocking(move || library.delete_pack(&id)).await
    };
    let deleted = match deleted {
        Ok(deleted) => deleted,
        Err(error) => {
            activity::warn(
                Area::Library,
                format!("Could not delete the map {}: {error}", short(&id)),
            );
            return Err(error);
        }
    };
    downloads.forget(&id);
    activity::info(
        Area::Library,
        if deleted.complete {
            format!("Deleted the map {} from the maps folder", short(&id))
        } else {
            format!(
                "Deleted the map {} from the maps folder; some files were in use and are removed at the next start",
                short(&id)
            )
        },
    );
    Ok(deleted)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagesInfo {
    /// Downloaded map images and their bytes.
    #[serde(flatten)]
    count: ImagesCount,
    /// A download of the pack is running or paused.
    downloading: bool,
}

/// How many map images were downloaded for a pack, to say what a delete
/// would remove. A pack without map images to download has none.
#[tauri::command]
pub async fn library_images_info(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    id: String,
) -> Result<ImagesInfo, String> {
    images_info(Arc::clone(&library), downloads.inner().clone(), id).await
}

async fn images_info(
    library: Arc<Library>,
    downloads: Downloads,
    id: String,
) -> Result<ImagesInfo, String> {
    listed(&library, &id)?;
    let downloading = downloads.is_active(&id);
    let Ok(location) = downloads.images_location(&id) else {
        return Ok(ImagesInfo {
            count: ImagesCount::default(),
            downloading,
        });
    };
    let count = blocking(move || Ok(library.count_images(&id, &location))).await?;
    Ok(ImagesInfo { count, downloading })
}

/// Deletes the map images downloaded for a pack and their bookkeeping, and
/// keeps the pack. A download of it is stopped first.
#[tauri::command]
pub async fn library_delete_images(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    id: String,
) -> Result<ImagesDeleted, String> {
    delete_images(Arc::clone(&library), downloads.inner().clone(), id).await
}

async fn delete_images(
    library: Arc<Library>,
    downloads: Downloads,
    id: String,
) -> Result<ImagesDeleted, String> {
    listed(&library, &id)?;
    let location = downloads
        .images_location(&id)
        .map_err(|_| "This map has no map images to delete.".to_owned())?;
    stop_download(&downloads, &id).await?;
    let deleted = {
        let id = id.clone();
        blocking(move || library.delete_images(&id, &location)).await
    };
    let deleted = match deleted {
        Ok(deleted) => deleted,
        Err(error) => {
            activity::warn(
                Area::Library,
                format!(
                    "Could not delete the downloaded map images of {}: {error}",
                    short(&id)
                ),
            );
            return Err(error);
        }
    };
    downloads.forget(&id);
    activity::info(
        Area::Library,
        format!(
            "Deleted the downloaded map images of {}: {} images, {} bytes; {} left because they were in use",
            short(&id),
            deleted.files,
            deleted.bytes,
            deleted.left
        ),
    );
    Ok(deleted)
}

/// Page data an importer stored with a pack.
#[tauri::command]
pub async fn library_import_sources(
    library: LibraryState<'_>,
    pack_id: String,
    importer_id: String,
) -> Result<Vec<SavedSource>, String> {
    let library = Arc::clone(&library);
    blocking(move || library.saved_sources(&pack_id, &importer_id)).await
}

/// Writes an imported pack and lists the packs again.
#[tauri::command]
pub async fn library_save_import(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    request: SaveImport,
) -> Result<Listing, String> {
    if downloads.is_active(&request.pack_id) {
        return Err(
            "Map images of this game are downloading. Pause or cancel that first.".to_owned(),
        );
    }
    let library = Arc::clone(&library);
    blocking(move || {
        match library.save_import(&request) {
            Ok(dir) => activity::info(
                Area::Import,
                format!(
                    "Wrote the imported pack {} ({} pack files, page data {} characters) to {}",
                    request.pack_id,
                    request.files.len(),
                    request.page_data.len(),
                    dir.display()
                ),
            ),
            Err(error) => {
                activity::warn(
                    Area::Import,
                    format!(
                        "Could not write the imported pack {}: {error}",
                        short(&request.pack_id)
                    ),
                );
                return Err(error);
            }
        }
        Ok(library.scan())
    })
    .await
}

// ---------------------------------------------------------------------------
// Map pack files

/// The map pack file being written or read, if any: one at a time. Cheap
/// to clone.
#[derive(Clone, Default)]
pub struct PackFileJobs(Arc<std::sync::Mutex<Option<PackFileJob>>>);

struct PackFileJob {
    progress: PackFileProgress,
    cancel: Arc<AtomicBool>,
}

/// What `packfile_progress` says about the running export or import.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFileProgress {
    /// `export`, `import`, or `copy` (a picked file copied into the app,
    /// counted in bytes only).
    kind: &'static str,
    pack_id: String,
    title: String,
    #[serde(flatten)]
    progress: Progress,
    cancelling: bool,
}

/// Clears the job when the work ends, however it ends.
struct PackFileTurn {
    jobs: PackFileJobs,
    cancel: Arc<AtomicBool>,
}

impl Drop for PackFileTurn {
    fn drop(&mut self) {
        *lock_jobs(&self.jobs) = None;
    }
}

fn lock_jobs(jobs: &PackFileJobs) -> std::sync::MutexGuard<'_, Option<PackFileJob>> {
    jobs.0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PackFileJobs {
    fn begin(
        &self,
        kind: &'static str,
        pack_id: &str,
        title: &str,
    ) -> Result<PackFileTurn, String> {
        let mut job = lock_jobs(self);
        if job.is_some() {
            return Err(
                "Another map pack file is being saved or imported. Wait until it has finished."
                    .to_owned(),
            );
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *job = Some(PackFileJob {
            progress: PackFileProgress {
                kind,
                pack_id: pack_id.to_owned(),
                title: title.to_owned(),
                progress: Progress::default(),
                cancelling: false,
            },
            cancel: Arc::clone(&cancel),
        });
        Ok(PackFileTurn {
            jobs: self.clone(),
            cancel,
        })
    }
}

impl PackFileTurn {
    fn update(&self, progress: Progress) {
        if let Some(job) = lock_jobs(&self.jobs).as_mut() {
            job.progress.progress = progress;
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

type PackFileJobsState<'a> = State<'a, PackFileJobs>;

fn app_info<R: Runtime>(app: &AppHandle<R>) -> AppInfo {
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_owned(),
    }
}

/// The Export dialog's choices for a pack, with their sizes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFileChoices {
    #[serde(flatten)]
    options: ExportOptions,
    /// A download of the pack is not over; exporting waits for it.
    downloading: bool,
}

/// What can be exported of a pack, and how large each detail is.
#[tauri::command]
pub async fn packfile_options(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    id: String,
) -> Result<PackFileChoices, String> {
    let library = Arc::clone(&library);
    let downloads = downloads.inner().clone();
    blocking(move || {
        let source = packfile::shell::source_for(&library, &downloads, &id)?;
        Ok(PackFileChoices {
            options: packfile::export_options(&source)?,
            downloading: downloads.is_active(&id),
        })
    })
    .await
}

/// A finished export.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFileExported {
    path: String,
    file_name: String,
    /// The file's size on disk.
    size: u64,
    header: packfile::Header,
    /// The progress export written beside it, when asked for.
    progress_file: Option<String>,
    /// Why the progress export could not be written; the pack file is fine.
    progress_error: Option<String>,
}

/// The name of the progress export beside a pack file:
/// `<name>.progress.json` for `<name>.atlaspack`.
fn progress_file_beside(pack_file: &std::path::Path) -> PathBuf {
    let stem = pack_file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "atlas".to_owned());
    pack_file.with_file_name(format!("{stem}.progress.json"))
}

/// Asks where to save a map pack file of a pack at `detail` and writes it.
/// With `progress` (the text of a progress export, as "Export all
/// profiles" writes it), that is saved beside it too. `None` when the
/// person closes the dialog. `packfile_progress` reports how far it is and
/// `packfile_cancel` stops it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn packfile_export<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    jobs: PackFileJobsState<'_>,
    id: String,
    detail: Detail,
    progress: Option<String>,
) -> Result<Option<PackFileExported>, String> {
    desktop_only()?;
    listed(&library, &id)?;
    if downloads.is_active(&id) {
        return Err(
            "Map images of this game are downloading. Pause or cancel that first, then try again."
                .to_owned(),
        );
    }
    let dialog = file_dialog(&window, "Export map pack file")
        .set_file_name(packfile::default_file_name(&id, detail))
        .add_filter("Atlas map pack", &[packfile::EXTENSION]);
    let Some(mut destination) = chosen_path(|done| dialog.save_file(done)).await? else {
        return Ok(None);
    };
    let named = destination
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(packfile::EXTENSION));
    if !named {
        let mut name = destination.as_os_str().to_owned();
        name.push(format!(".{}", packfile::EXTENSION));
        destination = PathBuf::from(name);
    }
    let title = library
        .scan()
        .packs
        .iter()
        .find(|pack| pack.id == id)
        .map_or_else(|| id.clone(), |pack| pack.title.clone());
    let turn = jobs.begin("export", &id, &title)?;
    let library = Arc::clone(&library);
    let downloads = downloads.inner().clone();
    let app_info = app_info(&app);
    blocking(move || {
        activity::info(
            Area::Library,
            format!(
                "Exporting {} at {} detail to the map pack file {}",
                short(&id),
                packfile::detail_name(detail),
                destination.display()
            ),
        );
        let result = packfile::shell::export_pack(
            &library,
            &downloads,
            &id,
            &app_info,
            detail,
            &destination,
            &mut |done| turn.update(done),
            &|| turn.cancelled(),
        );
        let exported = match result {
            Ok(exported) => exported,
            Err(Stop::Cancelled) => {
                activity::info(
                    Area::Library,
                    format!("Cancelled exporting {}; nothing was saved", short(&id)),
                );
                return Err(Stop::Cancelled.message());
            }
            Err(Stop::Failed(error)) => {
                activity::warn(
                    Area::Library,
                    format!("Could not export {}: {error}", short(&id)),
                );
                return Err(error);
            }
        };
        activity::info(
            Area::Library,
            format!(
                "Exported {} ({} detail, {} map images) to {}: {} files, {}",
                short(&id),
                packfile::detail_name(detail),
                exported.header.images.files,
                exported.path.display(),
                exported.header.files + 1,
                packfile::space::describe(exported.size)
            ),
        );
        let (progress_file, progress_error) = match progress {
            None => (None, None),
            Some(text) => {
                let beside = progress_file_beside(&exported.path);
                match fs::write(&beside, text) {
                    Ok(()) => {
                        activity::info(
                            Area::Library,
                            format!("Saved the progress export beside it: {}", beside.display()),
                        );
                        (Some(beside.display().to_string()), None)
                    }
                    Err(error) => {
                        activity::warn(
                            Area::Library,
                            format!(
                                "Could not save the progress export {}: {error}",
                                beside.display()
                            ),
                        );
                        (
                            None,
                            Some(format!(
                                "Your progress could not be saved beside it ({}): {error}",
                                file_name(&beside)
                            )),
                        )
                    }
                }
            }
        };
        Ok(Some(PackFileExported {
            file_name: file_name(&exported.path),
            path: exported.path.display().to_string(),
            size: exported.size,
            header: exported.header,
            progress_file,
            progress_error,
        }))
    })
    .await
}

/// Asks for a map pack file to import and says what is in it and what
/// importing it would do. `None` when the person closes the dialog.
#[tauri::command]
pub async fn packfile_pick<R: Runtime>(
    window: WebviewWindow<R>,
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
) -> Result<Option<packfile::shell::FileInfo>, String> {
    desktop_only()?;
    let dialog = file_dialog(&window, "Import map pack file")
        .add_filter("Atlas map pack", &[packfile::EXTENSION]);
    let Some(path) = chosen_path(|done| dialog.pick_file(done)).await? else {
        return Ok(None);
    };
    inspect_pack_file(Arc::clone(&library), downloads.inner().clone(), path)
        .await
        .map(Some)
}

async fn inspect_pack_file(
    library: Arc<Library>,
    downloads: Downloads,
    path: PathBuf,
) -> Result<packfile::shell::FileInfo, String> {
    blocking(move || {
        packfile::shell::inspect(&library, &downloads, &path).inspect_err(|error| {
            activity::warn(
                Area::Library,
                format!(
                    "Could not read the map pack file {}: {error}",
                    path.display()
                ),
            );
        })
    })
    .await
}

/// Reads the header of the map pack file at `path` (a `.atlaspack` file)
/// and says what importing it would do, without unpacking anything. For a
/// file the app has a path for already, such as one the Android app
/// copied from the system's picker.
#[tauri::command]
pub async fn packfile_inspect(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    path: String,
) -> Result<packfile::shell::FileInfo, String> {
    inspect_pack_file(
        Arc::clone(&library),
        downloads.inner().clone(),
        PathBuf::from(path),
    )
    .await
}

// ---------------------------------------------------------------------------
// Map pack files picked with Android's picker (see `picked.rs`)

/// The map pack file picked with `packfile_pick_copy`, waiting for
/// `packfile_copy_picked`.
#[derive(Default)]
pub struct PickedPackFiles(std::sync::Mutex<Option<Picked>>);

struct Picked {
    file: FilePath,
    copy_name: String,
    size: Option<u64>,
    header: packfile::Header,
}

fn lock_picked(picked: &PickedPackFiles) -> std::sync::MutexGuard<'_, Option<Picked>> {
    picked
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What the person picked, before it is copied.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedPackFile {
    /// The file's name where it is.
    file_name: String,
    /// Its size, when the system says.
    size: Option<u64>,
    pack_id: String,
    title: String,
    /// The room importing it takes: the copy and the game unpacked.
    room_needed: u64,
}

/// Where copies of picked files are kept: `pack-files` in the app's cache,
/// which Android never backs up and may empty when the app is not running.
pub fn picked_copies_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(crate::picked::COPIES_DIR))
        .map_err(|error| format!("The app has no cache folder: {error}"))
}

/// The picked file, read from its start.
fn open_picked<R: Runtime>(app: &AppHandle<R>, file: &FilePath) -> std::io::Result<fs::File> {
    match content_address(file) {
        Some(url) => content::open(app, url),
        None => fs::File::open(file.clone().into_path().map_err(std::io::Error::other)?),
    }
}

fn picked_name<R: Runtime>(app: &AppHandle<R>, file: &FilePath) -> Option<String> {
    match file {
        FilePath::Path(path) => Some(file_name(path)),
        FilePath::Url(url) => {
            content::name(app, url).or_else(|| url.path_segments()?.next_back().map(str::to_owned))
        }
    }
}

/// Asks for a map pack file with the system's picker (Android), reads what
/// it holds from its start, and checks there is room to copy and import
/// it. `None` when the person closes the picker. `packfile_copy_picked`
/// then copies it into the app.
#[tauri::command]
pub async fn packfile_pick_copy<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    picked: State<'_, PickedPackFiles>,
) -> Result<Option<PickedPackFile>, String> {
    if DESKTOP_ONLY {
        return Err("On a computer, use Import map pack file… in the Maps dialog.".to_owned());
    }
    // No filter: Android knows no type for `.atlaspack`, and would grey it out.
    let dialog = file_dialog(&window, "Import map pack file");
    let Some(file) = chosen_file(|done| dialog.pick_file(done)).await else {
        return Ok(None);
    };
    let copies = picked_copies_dir(&app)?;
    let checked = {
        let file = file.clone();
        blocking(move || {
            let name = picked_name(&app, &file);
            let opened = open_picked(&app, &file)
                .map_err(|error| format!("Could not open the file you chose: {error}"))?;
            // A real file says its size; a stream from a cloud drive may not.
            let size = opened
                .metadata()
                .ok()
                .filter(std::fs::Metadata::is_file)
                .map(|metadata| metadata.len())
                .filter(|&size| size > 0);
            let header = packfile::import::read_header_from(opened)?;
            fs::create_dir_all(&copies)
                .map_err(|error| format!("Could not make room for a copy of the file: {error}"))?;
            crate::picked::check_room(size, &header, packfile::space::available(&copies))?;
            Ok((name, size, header))
        })
        .await
    };
    let (name, size, header) = checked.inspect_err(|error| {
        activity::warn(
            Area::Library,
            format!("Could not use the picked map pack file: {error}"),
        );
    })?;
    let info = PickedPackFile {
        file_name: name.clone().unwrap_or_else(|| "The file".to_owned()),
        size,
        pack_id: header.pack_id.clone(),
        title: header.title.clone(),
        room_needed: crate::picked::room_needed(size, &header),
    };
    *lock_picked(&picked) = Some(Picked {
        file,
        copy_name: crate::picked::copy_name(name.as_deref()),
        size,
        header,
    });
    Ok(Some(info))
}

/// Copies the file picked with `packfile_pick_copy` into the app's cache
/// and returns the copy's path, for `packfile_inspect` and
/// `packfile_import`. `packfile_progress` reports how far it is (kind
/// `copy`) and `packfile_cancel` stops it; a failure or cancel leaves no
/// copy. `packfile_discard_copy` deletes the copy when the import is over.
#[tauri::command]
pub async fn packfile_copy_picked<R: Runtime>(
    app: AppHandle<R>,
    jobs: PackFileJobsState<'_>,
    picked: State<'_, PickedPackFiles>,
) -> Result<String, String> {
    let Some(chosen) = lock_picked(&picked).take() else {
        return Err("Choose the map pack file again.".to_owned());
    };
    let copies = picked_copies_dir(&app)?;
    let turn = jobs.begin("copy", &chosen.header.pack_id, &chosen.header.title)?;
    blocking(move || {
        let Picked {
            file,
            copy_name,
            size,
            header,
        } = chosen;
        let total = size.unwrap_or(header.bytes);
        let progress = |bytes_done: u64| Progress {
            entries_done: 0,
            entries_total: 0,
            bytes_done,
            bytes_total: total.max(bytes_done),
        };
        turn.update(progress(0));
        let result = fs::create_dir_all(&copies)
            .map_err(|error| {
                Stop::Failed(format!(
                    "Could not make room for a copy of the file: {error}"
                ))
            })
            .and_then(|()| {
                crate::picked::check_room(size, &header, packfile::space::available(&copies))
                    .map_err(Stop::Failed)
            })
            .and_then(|()| {
                open_picked(&app, &file).map_err(|error| {
                    Stop::Failed(format!("Could not open the file you chose: {error}"))
                })
            })
            .and_then(|mut opened| {
                crate::picked::copy_in(
                    &mut opened,
                    &copies,
                    &copy_name,
                    &mut |done| turn.update(progress(done)),
                    &|| turn.cancelled(),
                )
            });
        match result {
            Ok(copy) => {
                activity::info(
                    Area::Library,
                    format!(
                        "Copied the picked map pack file {} ({}) into the app to import it",
                        short(&copy_name),
                        packfile::space::describe(fs::metadata(&copy).map_or(0, |m| m.len()))
                    ),
                );
                Ok(copy.display().to_string())
            }
            Err(Stop::Cancelled) => {
                activity::info(
                    Area::Library,
                    format!("Cancelled copying {}; nothing was kept", short(&copy_name)),
                );
                Err("Cancelled. Nothing was imported.".to_owned())
            }
            Err(Stop::Failed(error)) => {
                activity::warn(
                    Area::Library,
                    format!("Could not copy {}: {error}", short(&copy_name)),
                );
                Err(error)
            }
        }
    })
    .await
}

/// Deletes a copy made by `packfile_copy_picked`. Any other path is left
/// alone.
#[tauri::command]
pub async fn packfile_discard_copy<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), String> {
    let copies = picked_copies_dir(&app)?;
    blocking(move || crate::picked::discard(&copies, std::path::Path::new(&path)).map(|_| ())).await
}

/// A finished import.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFileImported {
    pack_id: String,
    title: String,
    replaced: bool,
    header: packfile::Header,
    listing: Listing,
}

/// Imports the map pack file at `path` (a `.atlaspack` file) into the maps
/// folder, replacing the game with the same id there only with `replace`,
/// and lists the packs again. `packfile_progress` reports how far it is and
/// `packfile_cancel` stops it.
#[tauri::command]
pub async fn packfile_import(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    jobs: PackFileJobsState<'_>,
    path: String,
    replace: bool,
) -> Result<PackFileImported, String> {
    import_pack_file(
        Arc::clone(&library),
        downloads.inner().clone(),
        jobs.inner().clone(),
        PathBuf::from(path),
        replace,
    )
    .await
}

async fn import_pack_file(
    library: Arc<Library>,
    downloads: Downloads,
    jobs: PackFileJobs,
    path: PathBuf,
    replace: bool,
) -> Result<PackFileImported, String> {
    let header = {
        let path = path.clone();
        blocking(move || packfile::import::read_header(&path)).await?
    };
    let turn = jobs.begin("import", &header.pack_id, &header.title)?;
    blocking(move || {
        activity::info(
            Area::Library,
            format!(
                "Importing the map pack file {}: {} version {}, {} detail, exported {} by {} {}",
                path.display(),
                short(&header.pack_id),
                short(&header.pack_version),
                packfile::detail_name(header.detail),
                short(&header.exported_at),
                short(&header.exported_by.name),
                short(&header.exported_by.version)
            ),
        );
        let result = packfile::shell::import_pack_file(
            &library,
            &downloads,
            &path,
            replace,
            &mut |done| turn.update(done),
            &|| turn.cancelled(),
        );
        let imported = match result {
            Ok(imported) => imported,
            Err(Stop::Cancelled) => {
                activity::info(
                    Area::Library,
                    format!(
                        "Cancelled importing {}; nothing was changed",
                        short(&header.pack_id)
                    ),
                );
                return Err(Stop::Cancelled.message());
            }
            Err(Stop::Failed(error)) => {
                activity::warn(
                    Area::Library,
                    format!(
                        "Could not import the map pack file {}: {error}",
                        path.display()
                    ),
                );
                return Err(error);
            }
        };
        if imported.replaced {
            // Its old download record went with the old folder.
            downloads.forget(&imported.pack_id);
        }
        activity::info(
            Area::Library,
            format!(
                "Imported {} into {}{}",
                short(&imported.pack_id),
                imported.folder.display(),
                if imported.replaced {
                    " (replaced the pack that was there; progress is kept)"
                } else {
                    ""
                }
            ),
        );
        Ok(PackFileImported {
            pack_id: imported.pack_id,
            title: imported.title,
            replaced: imported.replaced,
            header: imported.header,
            listing: library.scan(),
        })
    })
    .await
}

/// How far the map pack file being saved or imported is; `None` when none is.
#[tauri::command]
pub fn packfile_progress(jobs: PackFileJobsState<'_>) -> Option<PackFileProgress> {
    lock_jobs(&jobs).as_ref().map(|job| job.progress.clone())
}

/// Stops the map pack file being saved or imported; it leaves nothing behind.
#[tauri::command]
pub fn packfile_cancel(jobs: PackFileJobsState<'_>) {
    if let Some(job) = lock_jobs(&jobs).as_mut() {
        job.cancel.store(true, Ordering::Relaxed);
        job.progress.cancelling = true;
    }
}

/// What is known about a listed pack: where its data came from and when,
/// its version and its map images, as a map pack file would say.
#[tauri::command]
pub async fn library_pack_details(
    library: LibraryState<'_>,
    downloads: DownloadsState<'_>,
    id: String,
) -> Result<packfile::PackDetails, String> {
    let library = Arc::clone(&library);
    let downloads = downloads.inner().clone();
    blocking(move || packfile::shell::details(&library, &downloads, &id)).await
}

// ---------------------------------------------------------------------------
// Importing from a web page

/// Opens a web page in the import window, for an importer's page reader.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_open<R: Runtime>(
    app: AppHandle<R>,
    imports: State<'_, Imports>,
    url: String,
    reader: String,
    importer_id: Option<String>,
    wait_seconds: Option<u32>,
    purpose: Option<String>,
    measure: Option<String>,
) -> Result<(), String> {
    desktop_only()?;
    *lock_poll() = None;
    // Only for the log: what is read from the page. Nothing about the window changes.
    let listing = matches!(purpose.as_deref(), Some("game" | "catalogue"));
    *lock_listing() = listing;
    let reading = match purpose.as_deref() {
        Some("game") => " to read the list of the game's pages",
        Some("catalogue") => " to read the list of games",
        _ => "",
    };
    let importer = importer_id
        .as_deref()
        .map(short)
        .unwrap_or_else(|| "unknown".to_owned());
    let page = page_address(&url);
    let wait = wait_seconds.map_or_else(String::new, |seconds| {
        let what = if listing { "list" } else { "page data" };
        format!(", waiting up to {seconds} s for its {what}")
    });
    let measuring = if measure.is_some() {
        ", and then to measure the map picture from the page: the window is as large as the screen allows, the page's own requests are watched, and the importer's script may press the page's zoom control (at most 20 steps within 90 s)"
    } else {
        ""
    };
    match imports.open(&app, &url, reader, measure) {
        Ok(()) => {
            activity::info(
                Area::Import,
                format!(
                    "Opened {page} in the import window{reading} for importer {importer}{wait}{measuring}"
                ),
            );
            Ok(())
        }
        Err(error) => {
            activity::warn(
                Area::Import,
                format!("Could not open {page} for importer {importer}: {error}"),
            );
            Err(error)
        }
    }
}

/// A page address for the log: its host and path, without the query or
/// fragment, which may hold personal tokens.
fn page_address(url: &str) -> String {
    match Url::parse(url.trim()) {
        Ok(url) => site_address(&url) + url.path(),
        Err(_) => "an address that is not a URL".to_owned(),
    }
}

/// The site of a page for the log: `scheme://host[:port]`.
fn site_address(url: &Url) -> String {
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port()
            .map_or_else(String::new, |port| format!(":{port}"))
    )
}

/// A short, clean piece of text from the web app, for the log.
fn short(text: &str) -> String {
    let text = activity::clean(text);
    if text.chars().count() > 300 {
        text.chars().take(300).collect::<String>() + "…"
    } else {
        text
    }
}

/// The state of the last poll that was logged, so each change is logged once.
fn lock_poll() -> std::sync::MutexGuard<'static, Option<&'static str>> {
    static LAST_POLL: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);
    LAST_POLL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether the open page is read for a list (a game's pages, or games)
/// rather than page data (a map page, or a checklist or guide page), for
/// the wording of the log.
fn lock_listing() -> std::sync::MutexGuard<'static, bool> {
    static LISTING: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
    LISTING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Asks the open page for its data once.
#[tauri::command]
pub async fn import_poll<R: Runtime>(
    app: AppHandle<R>,
    imports: State<'_, Imports>,
) -> Result<PollResult, String> {
    let result = imports.poll(&app).await;
    let listing = *lock_listing();
    let what = if listing { "list" } else { "page data" };
    // What the page holds is never logged; only what the app saw happen.
    let (state, line) = match &result {
        PollResult::Waiting { loading: true, .. } => ("loading", None),
        PollResult::Waiting { loading: false, .. } => (
            "waiting",
            Some((
                false,
                format!("The page has loaded; waiting for its {what}"),
            )),
        ),
        // The page measuring logs its own steps.
        PollResult::Measuring { .. } => ("measuring", None),
        PollResult::Ready { data, .. } => (
            "ready",
            Some((
                false,
                if listing {
                    format!("Read the page's list ({} characters)", data.len())
                } else {
                    format!("Read the page data ({} characters)", data.len())
                },
            )),
        ),
        PollResult::Closed => (
            "closed",
            Some((
                true,
                format!("The page window was closed before the {what} appeared"),
            )),
        ),
        PollResult::Failed { message } => ("failed", Some((true, short(message)))),
    };
    let mut last = lock_poll();
    if *last != Some(state) {
        *last = Some(state);
        match line {
            Some((true, line)) => activity::warn(Area::Import, line),
            Some((false, line)) => activity::info(Area::Import, line),
            None => {}
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn import_close<R: Runtime>(
    app: AppHandle<R>,
    imports: State<'_, Imports>,
) -> Result<(), String> {
    imports.close(&app);
    Ok(())
}

/// How an import ended, or how a run of several went, as the web app
/// reports it for the activity log.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    importer_id: Option<String>,
    outcome: ImportOutcome,
    pack_id: Option<String>,
    map_id: Option<String>,
    /// A failure message, as the dialog shows it.
    message: Option<String>,
    /// Locations of the map, maps and locations of the game, categories.
    counts: Option<ImportCounts>,
    /// The pages of a run, when it starts. Only their hosts are logged.
    pages: Option<Vec<String>>,
    /// A run's figures.
    run: Option<RunCounts>,
    /// A run that updates games the person has, rather than adding maps.
    #[serde(default)]
    update: bool,
    /// What a game page listed: its pages by kind.
    kinds: Option<BTreeMap<String, u64>>,
    /// Of a game page's map pages, or a list's games: how many are already added.
    already_added: Option<u64>,
    /// Games: in a list of games, or to update.
    games: Option<u64>,
    /// How the map's picture was sized, when the importer could measure it.
    picture: Option<PictureReport>,
}

/// Whether an import measured the map's picture (see `tiles::measure`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureReport {
    measured: bool,
    /// The map images found, when it was measured.
    tiles: Option<u64>,
    /// The importer's words: why it was not measured, or what was done.
    note: Option<String>,
    /// What the page showed, when the picture was measured from the page.
    page: Option<PageReport>,
}

/// What measuring a map's picture from its page found (see `pagemeasure.rs`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageReport {
    zoom: u64,
    images: u64,
    missing: u64,
    unseen: u64,
    complete: bool,
    used: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportOutcome {
    Added,
    Updated,
    Rebuilt,
    Failed,
    Cancelled,
    TimedOut,
    /// Several addresses: the pages are opened one at a time.
    RunStarted,
    /// A run ended before its last page.
    RunStopped,
    /// A run ended; its summary.
    RunFinished,
    /// A game page was read: its pages by kind.
    GameListed,
    /// The list of games was read.
    CatalogueListed,
    /// A game page or the list of games gave no usable list.
    ListingFailed,
    /// Reading game pages to update games started.
    UpdateStarted,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    map_locations: u64,
    maps: u64,
    locations: u64,
    categories: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunCounts {
    added: u64,
    refreshed: u64,
    not_added: u64,
    not_started: u64,
    /// Addresses left out because no importer recognises them.
    left_out: u64,
}

/// The sites of a run's pages, each once, as `scheme://host[:port]`: no
/// paths and no queries.
fn run_hosts(pages: &[String]) -> String {
    const SHOWN: usize = 10;
    let mut hosts: Vec<String> = Vec::new();
    for page in pages {
        let Ok(url) = Url::parse(page.trim()) else {
            continue;
        };
        let host = site_address(&url);
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    let more = hosts.len().saturating_sub(SHOWN);
    hosts.truncate(SHOWN);
    let mut text = short(&hosts.join(", "));
    if more > 0 {
        text.push_str(&format!(" and {more} more"));
    }
    text
}

/// The site of the one page a report is about, as `scheme://host[:port]`.
fn report_host(report: &ImportReport) -> String {
    let pages = report.pages.as_deref().unwrap_or_default();
    if pages.is_empty() {
        "an unknown site".to_owned()
    } else {
        run_hosts(&pages[..1])
    }
}

/// The line a report about reading a list (a game's pages, or games) becomes.
/// "1 game", "2 games".
fn count(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn listing_report_line(report: &ImportReport) -> (bool, String) {
    let host = report_host(report);
    let added = report.already_added.unwrap_or(0);
    match report.outcome {
        ImportOutcome::GameListed => {
            let mut kinds: Vec<(String, u64)> = report
                .kinds
                .iter()
                .flatten()
                .take(20)
                .map(|(kind, count)| (short(kind), *count))
                .collect();
            let maps = kinds
                .iter()
                .position(|(kind, _)| kind == "map")
                .map_or(0, |at| kinds.remove(at).1);
            let others = kinds
                .iter()
                .map(|(kind, count)| format!(", {count} of kind {kind}"))
                .collect::<String>();
            (
                false,
                format!(
                    "Read the list of a game's pages from {host}: {} ({added} already added, {} new){others}",
                    count(maps, "map page", "map pages"),
                    maps.saturating_sub(added)
                ),
            )
        }
        ImportOutcome::CatalogueListed => (
            false,
            format!(
                "Read the list of games from {host}: {} ({added} already in the maps folder)",
                count(report.games.unwrap_or(0), "game", "games")
            ),
        ),
        ImportOutcome::UpdateStarted => {
            let pages = report.pages.as_deref().unwrap_or_default();
            (
                false,
                format!(
                    "Updating {} from {} site: reading {}, one at a time, from {}",
                    count(report.games.unwrap_or(0), "game", "games"),
                    if report.games == Some(1) {
                        "its"
                    } else {
                        "their"
                    },
                    count(pages.len() as u64, "game page", "game pages"),
                    if pages.is_empty() {
                        "no site (only the pages they were made from)".to_owned()
                    } else {
                        run_hosts(pages)
                    }
                ),
            )
        }
        _ => (
            true,
            format!(
                "Could not read a list of pages from {host}: {}",
                report.message.as_deref().map_or_else(String::new, short)
            ),
        ),
    }
}

/// The line a report about a run of several pages becomes.
fn run_report_line(report: &ImportReport) -> (bool, String) {
    let counts = report.run.as_ref();
    let left_out = counts.map_or(0, |counts| counts.left_out);
    let left_out = if left_out > 0 {
        format!(" | left out, as no importer recognises them: {left_out}")
    } else {
        String::new()
    };
    let figures = || {
        counts.map_or_else(String::new, |c| {
            format!(
                "{} added, {} refreshed, {} not added, {} not started",
                c.added, c.refreshed, c.not_added, c.not_started
            )
        })
    };
    match report.outcome {
        ImportOutcome::RunStarted => {
            let pages = report.pages.as_deref().unwrap_or_default();
            (
                false,
                format!(
                    "{} {}, one page at a time, from {}{left_out}",
                    if report.update { "Updating" } else { "Adding" },
                    count(pages.len() as u64, "page", "pages"),
                    run_hosts(pages)
                ),
            )
        }
        ImportOutcome::RunStopped => (
            true,
            format!(
                "Stopped {} maps early: {} | {}",
                if report.update { "updating" } else { "adding" },
                report.message.as_deref().map_or_else(String::new, short),
                figures()
            ),
        ),
        _ => (
            false,
            format!(
                "{} maps ended: {}{left_out}",
                if report.update { "Updating" } else { "Adding" },
                figures()
            ),
        ),
    }
}

/// The line an import report becomes.
fn import_report_line(report: &ImportReport) -> (bool, String) {
    let importer = report
        .importer_id
        .as_deref()
        .map_or_else(|| "unknown".to_owned(), short);
    let what = match report.outcome {
        ImportOutcome::Added => "added",
        ImportOutcome::Updated => "updated",
        ImportOutcome::Rebuilt => "rebuilt",
        ImportOutcome::Failed => "failed",
        ImportOutcome::Cancelled => "was cancelled",
        ImportOutcome::TimedOut => "timed out",
        ImportOutcome::RunStarted | ImportOutcome::RunStopped | ImportOutcome::RunFinished => {
            return run_report_line(report);
        }
        ImportOutcome::GameListed
        | ImportOutcome::CatalogueListed
        | ImportOutcome::ListingFailed
        | ImportOutcome::UpdateStarted => return listing_report_line(report),
    };
    let mut line = format!("Import with importer {importer} {what}");
    if let Some(pack) = &report.pack_id {
        line.push_str(&format!(": pack {}", short(pack)));
        if let Some(map) = &report.map_id {
            line.push_str(&format!(", map {}", short(map)));
        }
    }
    if let Some(counts) = &report.counts {
        line.push_str(&format!(
            " | locations on this map: {} | in the game: maps {}, locations {}, types {}",
            counts.map_locations, counts.maps, counts.locations, counts.categories
        ));
    }
    if let Some(picture) = &report.picture {
        line.push_str(&match (picture.measured, picture.tiles) {
            (true, Some(tiles)) => format!(" | map picture: measured, {tiles} map images found"),
            (true, None) => " | map picture: measured".to_owned(),
            (false, _) => {
                " | map picture: not measured, sized from where the locations are".to_owned()
            }
        });
        if let Some(page) = &picture.page {
            line.push_str(&format!(
                " | measured from the page at zoom {}: {} map images, {} not there, {} next to them not seen, {}, {}",
                page.zoom,
                page.images,
                page.missing,
                page.unseen,
                if page.complete {
                    "complete"
                } else {
                    "not complete"
                },
                if page.used {
                    "used for the map's size"
                } else {
                    "not used"
                }
            ));
        }
        if let Some(note) = &picture.note {
            line.push_str(&format!(" ({})", short(note)));
        }
    }
    if let Some(message) = &report.message {
        line.push_str(&format!(" | {}", short(message)));
    }
    (
        matches!(
            report.outcome,
            ImportOutcome::Failed | ImportOutcome::TimedOut
        ),
        line,
    )
}

/// Records how an import ended in the activity log.
#[tauri::command]
pub fn import_report(report: ImportReport) {
    match import_report_line(&report) {
        (true, line) => activity::warn(Area::Import, line),
        (false, line) => activity::info(Area::Import, line),
    }
}

// ---------------------------------------------------------------------------
// The activity log

/// Lines the log viewer loads at most.
const LOG_LINES: usize = 2000;
const LOG_BYTES: u64 = 512 * 1024;

/// The most recent lines of the activity log, newest last.
#[tauri::command]
pub async fn activity_log_read() -> Result<RecentLog, String> {
    blocking(|| ActivityLog::global().read_recent(LOG_LINES, LOG_BYTES)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    #[test]
    fn opens_only_web_links() {
        assert!(external_url("https://example.com/guide?x=1#y").is_some());
        assert!(external_url("http://example.com/").is_some());
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "atlas-pack://localhost/demo/manifest.json",
            "tauri://localhost/",
            "mailto:someone@example.com",
            "data:text/html,hi",
            "ftp://example.com/",
            "not a url",
        ] {
            assert!(external_url(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn logs_page_addresses_and_import_reports_without_page_data() {
        assert_eq!(
            page_address("https://maps.example.com:8443/game/map?token=secret#x"),
            "https://maps.example.com:8443/game/map"
        );
        assert_eq!(page_address("nonsense"), "an address that is not a URL");
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":"demo-maps","outcome":"added","packId":"test-valley","mapId":"test-valley:map:east",
                "counts":{"mapLocations":4,"maps":1,"locations":4,"categories":3}}"#,
        )
        .unwrap();
        let (warn, line) = import_report_line(&report);
        assert!(!warn);
        assert_eq!(
            line,
            "Import with importer demo-maps added: pack test-valley, map test-valley:map:east | locations on this map: 4 | in the game: maps 1, locations 4, types 3"
        );
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":"demo-maps","outcome":"updated","packId":"test-valley",
                "picture":{"measured":true,"tiles":40}}"#,
        )
        .unwrap();
        assert!(import_report_line(&report)
            .1
            .ends_with("updated: pack test-valley | map picture: measured, 40 map images found"));
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":"demo-maps","outcome":"added","packId":"test-valley",
                "picture":{"measured":false,"note":"the image server could\nnot be asked"}}"#,
        )
        .unwrap();
        assert!(import_report_line(&report).1.ends_with(
            "| map picture: not measured, sized from where the locations are (the image server could not be asked)"
        ));
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":"demo-maps","outcome":"updated","packId":"test-valley",
                "picture":{"measured":true,"tiles":16,"note":"Measured from the page",
                  "page":{"zoom":10,"images":16,"missing":4,"unseen":2,"complete":false,"used":true}}}"#,
        )
        .unwrap();
        assert!(import_report_line(&report).1.ends_with(
            "| map picture: measured, 16 map images found | measured from the page at zoom 10: 16 map images, 4 not there, 2 next to them not seen, not complete, used for the map's size (Measured from the page)"
        ));
        let report: ImportReport = serde_json::from_str(
            r#"{"outcome":"timed-out","message":"The page did not provide\nthe map data"}"#,
        )
        .unwrap();
        let (warn, line) = import_report_line(&report);
        assert!(warn);
        assert!(line.ends_with("timed out | The page did not provide the map data"));
        assert!(serde_json::from_str::<ImportReport>(r#"{"outcome":"pwned"}"#).is_err());
    }

    #[test]
    fn logs_game_pages_and_updates_with_hosts_and_kinds_only() {
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":"demo-maps","outcome":"game-listed","pages":["https://maps.example.com/game?token=secret"],
                "kinds":{"map":3,"guides":17,"checklist\nx":1},"alreadyAdded":2}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report),
            (
                false,
                "Read the list of a game's pages from https://maps.example.com: 3 map pages (2 already added, 1 new), 1 of kind checklist x, 17 of kind guides".to_owned()
            )
        );
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":"demo-maps","outcome":"catalogue-listed","pages":["https://maps.example.com/"],"games":274,"alreadyAdded":3}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report).1,
            "Read the list of games from https://maps.example.com: 274 games (3 already in the maps folder)"
        );
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":null,"outcome":"update-started","games":2,"pages":["https://maps.example.com/a","https://maps.example.com/b/c"]}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report).1,
            "Updating 2 games from their site: reading 2 game pages, one at a time, from https://maps.example.com"
        );
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":null,"outcome":"run-started","update":true,"pages":["https://maps.example.com/a"]}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report).1,
            "Updating 1 page, one page at a time, from https://maps.example.com"
        );
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":"demo-maps","outcome":"listing-failed","pages":["https://maps.example.com/a"],"message":"No list."}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report),
            (
                true,
                "Could not read a list of pages from https://maps.example.com: No list.".to_owned()
            )
        );
    }

    #[test]
    fn logs_runs_with_hosts_only() {
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":null,"outcome":"run-started","run":{"leftOut":1},"pages":[
                "https://maps.example.com/world/one?token=secret",
                "https://maps.example.com/world/two#x",
                "http://127.0.0.1:4432/demo-maps/a/b",
                "not a url"]}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report),
            (
                false,
                "Adding 4 pages, one page at a time, from https://maps.example.com, http://127.0.0.1:4432 | left out, as no importer recognises them: 1".to_owned()
            )
        );
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":null,"outcome":"run-stopped","message":"Two pages in a row\ndid not provide their map data.",
                "run":{"added":1,"refreshed":0,"notAdded":2,"notStarted":3}}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report),
            (
                true,
                "Stopped adding maps early: Two pages in a row did not provide their map data. | 1 added, 0 refreshed, 2 not added, 3 not started".to_owned()
            )
        );
        let report: ImportReport = serde_json::from_str(
            r#"{"importerId":null,"outcome":"run-finished","run":{"added":4,"refreshed":1,"notAdded":1}}"#,
        )
        .unwrap();
        assert_eq!(
            import_report_line(&report),
            (
                false,
                "Adding maps ended: 4 added, 1 refreshed, 1 not added, 0 not started".to_owned()
            )
        );
        let many: Vec<String> = (0..12)
            .map(|i| format!("https://site{i}.example.com/x"))
            .collect();
        assert!(run_hosts(&many).ends_with("https://site9.example.com and 2 more"));
    }

    #[test]
    fn suggests_safe_file_names() {
        assert_eq!(
            safe_file_name("atlas-demo-2026-11-10.json"),
            "atlas-demo-2026-11-10.json"
        );
        assert_eq!(safe_file_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(safe_file_name("..."), "atlas-progress.json");
        assert_eq!(safe_file_name("a\\b:c.json"), "abc.json");
    }

    #[test]
    fn writes_and_reads_progress_files() {
        let dir = TempDir::new("files");
        let path = dir.0.join("progress.json");
        write_text(&path, "{\"format\":\"atlas-progress\"}").unwrap();
        let opened = read_text(&path).unwrap();
        assert_eq!(opened.name, "progress.json");
        assert_eq!(opened.contents, "{\"format\":\"atlas-progress\"}");

        fs::write(dir.0.join("binary.json"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_text(&dir.0.join("binary.json"))
            .unwrap_err()
            .contains("not a text file"));
        assert!(read_text(&dir.0.join("missing.json")).is_err());
        assert!(write_text(&dir.0.join("no/such/dir/x.json"), "x").is_err());
    }

    /// Android's save and open screens give `content://` addresses, which
    /// are read and written as streams; paths and `file:` URLs are used as
    /// on a desktop.
    #[test]
    fn reads_and_writes_progress_files_as_streams() {
        let content = FilePath::Url(
            Url::parse("content://com.android.providers.downloads.documents/document/42").unwrap(),
        );
        assert!(content_address(&content).is_some());
        let local = FilePath::Url(Url::parse("file:///home/test/progress.json").unwrap());
        assert!(content_address(&local).is_none());
        assert!(content_address(&FilePath::Path(PathBuf::from("/home/test/p.json"))).is_none());

        let mut written = Vec::new();
        write_stream(&mut written, b"{\"format\":\"atlas-progress\"}").unwrap();
        let opened = read_text_stream("progress.json".into(), written.as_slice()).unwrap();
        assert_eq!(opened.name, "progress.json");
        assert_eq!(opened.contents, "{\"format\":\"atlas-progress\"}");

        let binary: &[u8] = &[0xff, 0xfe, 0x00];
        assert!(read_text_stream("photo.jpg".into(), binary)
            .unwrap_err()
            .contains("photo.jpg is not a text file"));
        // Read no further than the limit, whatever the stream holds.
        let huge = std::io::Read::take(std::io::repeat(b' '), MAX_OPEN_BYTES + 10);
        assert!(read_text_stream("big.json".into(), huge)
            .unwrap_err()
            .contains("too large"));
    }

    /// Images another Atlas app or an earlier version downloaded, which every
    /// build counts and deletes, also one without downloads.
    mod images_on_disk {
        use std::path::Path;

        use super::*;
        use crate::{library::BundledPack, packs::PackRegistry, settings::SettingsFile};

        /// A pack "My Game" whose one map's levels 0 and 1 come from a
        /// remote source, with three images, a status file and the record
        /// of an unfinished download on disk, as a download leaves them.
        fn write_downloaded_pack(dir: &Path, id: &str) {
            fs::create_dir_all(dir).unwrap();
            fs::write(
                dir.join("manifest.json"),
                format!(
                    r#"{{"schemaVersion":1,"gameId":"{id}","title":"My Game","packVersion":"1.0.0","gamePatch":"1","attribution":[],"idMigrations":{{}}}}"#
                ),
            )
            .unwrap();
            fs::write(
                dir.join("maps.json"),
                format!(r#"[{{"id":"{id}:map:a","name":"Island","width":512,"height":512}}]"#),
            )
            .unwrap();
            fs::write(
                dir.join("layers.json"),
                format!(
                    r#"[{{"id":"{id}:layer:a","mapId":"{id}:map:a","name":"Surface","minZoom":0,"maxZoom":1,"tileSize":256,
                      "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{x}}/{{y}}.png","remote":{{
                        "urlTemplate":"https://tiles.invalid/{{z}}/{{x}}/{{y}}.png",
                        "levels":[{{"z":1,"sourceZ":1,"offsetX":0,"offsetY":0}}]}}}}}}]"#
                ),
            )
            .unwrap();
            fs::write(dir.join("locations.json"), "[]").unwrap();
            for tile in ["0/0/0", "1/0/0", "1/1/0"] {
                let path = dir.join(format!("tiles/a/{tile}.png"));
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"\x89PNG image").unwrap();
            }
            fs::create_dir_all(dir.join("offline-tiles")).unwrap();
            fs::write(dir.join("offline-tiles/a.json"), "{}").unwrap();
            fs::create_dir_all(dir.join(".atlas")).unwrap();
            fs::write(
                dir.join(".atlas/download-job.json"),
                format!(r#"{{"packId":"{id}","detail":"full","stopReason":"closed"}}"#),
            )
            .unwrap();
        }

        fn setup(dir: &TempDir) -> (Arc<Library>, Downloads) {
            let registry = PackRegistry::default();
            let library = Arc::new(Library::new(
                SettingsFile::new(dir.0.join("shared")),
                registry.clone(),
                Vec::<BundledPack>::new(),
                Vec::new(),
            ));
            let downloads = crate::downloads::for_tests(&registry, dir.0.join("data"));
            (library, downloads)
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn counts_and_deletes_images_another_app_downloaded() {
            let dir = TempDir::new("images-on-disk");
            let (library, downloads) = setup(&dir);
            let pack = library.maps_folder().join("my-game");
            write_downloaded_pack(&pack, "my-game");
            library.scan();

            let info = images_info(Arc::clone(&library), downloads.clone(), "my-game".into())
                .await
                .unwrap();
            assert_eq!((info.count.files, info.downloading), (3, false));
            let deleted = delete_images(Arc::clone(&library), downloads.clone(), "my-game".into())
                .await
                .unwrap();
            assert_eq!((deleted.files, deleted.left), (3, 0));
            assert!(!pack.join("tiles").exists());
            assert!(!pack.join("offline-tiles").exists());
            assert!(!pack.join(".atlas/download-job.json").exists());
            assert!(pack.join("manifest.json").exists(), "the pack stays");
            assert!(pack.join("layers.json").exists());

            delete_pack(Arc::clone(&library), downloads.clone(), "my-game".into())
                .await
                .unwrap();
            assert!(!pack.exists());
            assert!(library.scan().packs.is_empty());
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn deletes_a_pack_that_nothing_downloads() {
            let dir = TempDir::new("images-on-disk-pack");
            let (library, downloads) = setup(&dir);
            let pack = library.maps_folder().join("my-game");
            write_downloaded_pack(&pack, "my-game");
            library.scan();
            assert!(downloads.active_packs().is_empty());
            assert!(!downloads.is_active("my-game"));
            assert!(downloads.stop_and_wait("my-game", Duration::ZERO).await);
            delete_pack(Arc::clone(&library), downloads.clone(), "my-game".into())
                .await
                .unwrap();
            assert!(!pack.exists());
            // Nothing to delete for a pack that is gone or not listed.
            for id in ["my-game", "../my-game", ""] {
                let error = delete_images(Arc::clone(&library), downloads.clone(), id.into())
                    .await
                    .unwrap_err();
                assert!(error.contains("not in the list"), "{id}: {error}");
            }
        }
    }

    #[cfg(feature = "downloads")]
    mod deleting {
        use std::path::Path;

        use super::*;
        use crate::{
            library::{BundledPack, PackLock},
            packs::PackRegistry,
            settings::SettingsFile,
            tiles::{
                download::{
                    tests::{ensure_crypto, Handler, MockServer, Reply},
                    Settings,
                },
                manager::JobState,
                pyramid::Detail,
            },
        };

        fn tile() -> Vec<u8> {
            let image = image::RgbImage::from_pixel(256, 256, image::Rgb([10, 20, 30]));
            let mut out = std::io::Cursor::new(Vec::new());
            image.write_to(&mut out, image::ImageFormat::Png).unwrap();
            out.into_inner()
        }

        /// Answers every tile after a while, so a download takes some seconds.
        fn slow_server() -> Handler {
            let tile = tile();
            Arc::new(move |_, _| Reply::image(tile.clone()).delayed(Duration::from_millis(60)))
        }

        /// A pack "My Game" with one 4096 px map whose levels 3 and 4 come
        /// from the mock server (320 images), a place and a checklist.
        fn write_pack(dir: &Path, id: &str, server: &MockServer) {
            fs::create_dir_all(dir).unwrap();
            fs::write(
                dir.join("manifest.json"),
                format!(
                    r#"{{"schemaVersion":2,"gameId":"{id}","title":"My Game","packVersion":"1.0.0","gamePatch":"1","attribution":[],"idMigrations":{{}},
                      "contents":{{"maps":[{{"id":"{id}:map:a","name":"Island","layers":[{{"id":"{id}:layer:a","name":"Surface","tiles":"xyz"}}]}}]}}}}"#
                ),
            )
            .unwrap();
            fs::write(
                dir.join("maps.json"),
                format!(r#"[{{"id":"{id}:map:a","name":"Island","width":4096,"height":4096}}]"#),
            )
            .unwrap();
            let template = server.url("/remote/{z}/{x}/{y}.png");
            fs::write(
                dir.join("layers.json"),
                format!(
                    r#"[{{"id":"{id}:layer:a","mapId":"{id}:map:a","name":"Surface","minZoom":0,"maxZoom":4,"tileSize":256,
                      "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{x}}/{{y}}.png","remote":{{
                        "urlTemplate":"{template}",
                        "levels":[{{"z":3,"sourceZ":3,"offsetX":0,"offsetY":0}},
                                  {{"z":4,"sourceZ":4,"offsetX":0,"offsetY":0}}]}}}}}}]"#
                ),
            )
            .unwrap();
            fs::write(dir.join("locations.json"), "[]").unwrap();
            fs::write(dir.join("checklists.json"), "[]").unwrap();
        }

        struct Setup {
            dir: TempDir,
            registry: PackRegistry,
            library: Arc<Library>,
            manager: Arc<DownloadManager>,
            downloads: Downloads,
        }

        fn setup(name: &str, bundled: Vec<BundledPack>) -> Setup {
            let dir = TempDir::new(name);
            let registry = PackRegistry::default();
            let library = Arc::new(Library::new(
                SettingsFile::new(dir.0.join("shared")),
                registry.clone(),
                bundled,
                Vec::new(),
            ));
            let manager = Arc::new(DownloadManager::with_settings(
                dir.0.join("data"),
                registry.clone(),
                Settings {
                    delay: Duration::from_millis(1),
                    ..Settings::default()
                },
            ));
            Setup {
                dir,
                registry,
                library,
                downloads: Downloads::new(Arc::clone(&manager)),
                manager,
            }
        }

        async fn wait_for_images(s: &Setup, id: &str, at_least: u64) {
            for _ in 0..400 {
                if s.manager
                    .snapshot(id)
                    .is_some_and(|job| job.saved >= at_least)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("no images were downloaded");
        }

        fn hidden_entries(dir: &Path) -> Vec<String> {
            fs::read_dir(dir)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with('.'))
                .collect()
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn map_pack_files_wait_for_a_running_download() {
            ensure_crypto();
            let server = MockServer::start(slow_server()).await;
            let s = setup("packfile-downloading", Vec::new());
            let pack = s.library.maps_folder().join("my-game");
            write_pack(&pack, "my-game", &server);
            s.library.scan();
            s.manager.start("my-game", Detail::Full).unwrap();
            wait_for_images(&s, "my-game", 1).await;
            let file = s.dir.0.join("my-game.atlaspack");
            let error = packfile::shell::export_pack(
                &s.library,
                &s.downloads,
                "my-game",
                &AppInfo::default(),
                Detail::Overview,
                &file,
                &mut |_| {},
                &|| false,
            )
            .unwrap_err();
            assert!(error.message().contains("downloading"), "{error:?}");
            assert!(!file.exists());
            let header: packfile::Header = serde_json::from_value(serde_json::json!({
                "format": "atlas-pack-file", "version": 1, "packId": "my-game", "title": "My Game",
                "packVersion": "1.0.0", "detail": "overview", "exportedAt": "2026-11-11T10:00:00Z",
                "exportedBy": {"name": "Atlas", "version": "0.3.5", "platform": "linux"},
                "pack": {"id": "my-game", "title": "My Game", "packVersion": "1.0.0", "schemaVersion": 2},
                "source": {"kind": "unknown"}, "contents": {},
                "images": {"detail": "overview", "files": 0, "bytes": 0, "layers": []},
                "files": 0, "bytes": 0
            }))
            .unwrap();
            let error =
                packfile::shell::check_import(&s.library, &s.downloads, &header).unwrap_err();
            assert!(error.contains("downloading"), "{error}");
            s.manager.cancel("my-game").unwrap();
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn deletes_a_pack_while_its_download_runs() {
            ensure_crypto();
            let server = MockServer::start(slow_server()).await;
            let s = setup("delete-running", Vec::new());
            let maps = s.library.maps_folder();
            let pack = maps.join("my-game");
            write_pack(&pack, "my-game", &server);
            s.library.scan();
            s.manager.start("my-game", Detail::Full).unwrap();
            wait_for_images(&s, "my-game", 3).await;
            assert!(s.manager.is_active("my-game"));

            let info = images_info(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert!(info.downloading);
            assert!(info.count.files >= 3);

            let deleted = delete_pack(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert!(deleted.complete);
            assert!(!pack.exists(), "the pack folder is gone");
            assert!(hidden_entries(&maps).is_empty(), "nothing left behind");
            assert!(s.registry.root("my-game").is_none(), "no longer served");
            assert!(s.library.scan().packs.is_empty());
            // The download is stopped and forgotten, and makes no more requests.
            assert!(!s.manager.is_active("my-game"));
            assert!(s.manager.snapshot("my-game").is_none());
            let seen = server.seen().len();
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(server.seen().len(), seen);
            assert!(!pack.exists(), "the stopped job wrote nothing afterwards");
            // It is not there to delete again.
            let again = delete_pack(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap_err();
            assert!(again.contains("not in the list"), "{again}");
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn deletes_a_pack_whose_download_stopped_part_way() {
            ensure_crypto();
            let refusing = MockServer::start(Arc::new(|_, _| Reply::status(403))).await;
            let s = setup("delete-stopped", Vec::new());
            let pack = s.library.maps_folder().join("my-game");
            write_pack(&pack, "my-game", &refusing);
            s.library.scan();
            s.manager.start("my-game", Detail::Full).unwrap();
            for _ in 0..200 {
                if !s.manager.is_active("my-game") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(
                s.manager.snapshot("my-game").unwrap().state,
                JobState::Stopped
            );
            assert!(pack.join(".atlas/download-job.json").exists());
            delete_pack(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert!(!pack.exists());
            assert!(s.manager.snapshot("my-game").is_none());
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn refuses_packs_it_may_not_delete_without_stopping_their_download() {
            ensure_crypto();
            let server = MockServer::start(slow_server()).await;
            let s = setup("delete-refused", Vec::new());
            // A pack opened from another folder: only removed from the list.
            let elsewhere = s.dir.0.join("USB drive/My Game");
            write_pack(&elsewhere, "my-game", &server);
            s.library.add_pack_location(&elsewhere).unwrap();
            s.library.scan();
            s.manager.start("my-game", Detail::Full).unwrap();
            let error = delete_pack(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("Remove from list"), "{error}");
            assert!(s.manager.is_active("my-game"), "its download goes on");
            assert!(elsewhere.join("manifest.json").exists());
            assert!(s.manager.stop_and_wait("my-game", STOP_TIMEOUT).await);

            // Ids that are not listed, or try to leave the maps folder.
            for id in ["../my-game", "..", "my-game/..", "", "C:\\Windows"] {
                let error = delete_pack(Arc::clone(&s.library), s.downloads.clone(), id.into())
                    .await
                    .unwrap_err();
                assert!(error.contains("not in the list"), "{id}: {error}");
                assert!(
                    delete_images(Arc::clone(&s.library), s.downloads.clone(), id.into())
                        .await
                        .is_err()
                );
            }
            assert!(elsewhere.join("manifest.json").exists());
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn says_so_when_another_app_holds_the_pack() {
            ensure_crypto();
            let server = MockServer::start(slow_server()).await;
            let s = setup("delete-other-app", Vec::new());
            let pack = s.library.maps_folder().join("my-game");
            write_pack(&pack, "my-game", &server);
            fs::create_dir_all(pack.join("tiles/a/3/0")).unwrap();
            fs::write(pack.join("tiles/a/3/0/0.png"), tile()).unwrap();
            s.library.scan();
            // The other Atlas app (viewer or importer) is downloading into it.
            let other_app = PackLock::acquire(&pack).unwrap();
            let error = delete_pack(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("Another Atlas window or app"), "{error}");
            let error = delete_images(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("Another Atlas window or app"), "{error}");
            assert!(pack.join("manifest.json").exists());
            assert!(pack.join("tiles/a/3/0/0.png").exists());
            assert!(s.registry.root("my-game").is_some(), "still listed");
            drop(other_app);
            delete_pack(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert!(!pack.exists());
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn deletes_downloaded_images_while_a_download_runs() {
            ensure_crypto();
            let server = MockServer::start(slow_server()).await;
            let s = setup("delete-images-running", Vec::new());
            let pack = s.library.maps_folder().join("my-game");
            write_pack(&pack, "my-game", &server);
            fs::create_dir_all(pack.join("import")).unwrap();
            fs::write(pack.join("import/index.json"), "{}").unwrap();
            s.library.scan();
            s.manager.start("my-game", Detail::Full).unwrap();
            wait_for_images(&s, "my-game", 3).await;

            let deleted = delete_images(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert!(deleted.files >= 3);
            assert_eq!(deleted.left, 0);
            assert!(!pack.join("tiles").exists(), "every image is gone");
            assert!(!pack.join("offline-tiles").exists());
            assert!(!pack.join(".atlas/download-job.json").exists());
            for kept in [
                "manifest.json",
                "maps.json",
                "layers.json",
                "locations.json",
                "checklists.json",
                "import/index.json",
            ] {
                assert!(pack.join(kept).exists(), "{kept} is kept");
            }
            let manifest: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(pack.join("manifest.json")).unwrap())
                    .unwrap();
            assert!(manifest["contents"]["maps"][0]["layers"][0]
                .get("images")
                .is_none());
            assert_eq!(manifest["title"], "My Game");
            assert!(!s.manager.is_active("my-game"));
            assert!(s.manager.snapshot("my-game").is_none());
            let seen = server.seen().len();
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(server.seen().len(), seen, "no requests after stopping");
            // Still listed, and it can be downloaded again from the start.
            assert_eq!(s.library.scan().packs.len(), 1);
            let info = images_info(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert_eq!((info.count.files, info.downloading), (0, false));
            let plan = s.manager.plan_info("my-game").unwrap();
            assert!(plan.unfinished.is_none());
            assert_eq!(plan.options.last().unwrap().remaining, 320);
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn deletes_the_images_of_a_bundled_pack_in_the_maps_folder() {
            ensure_crypto();
            let server = MockServer::start(slow_server()).await;
            let resources = TempDir::new("delete-images-bundled-src");
            let shipped = resources.0.join("my-game");
            write_pack(&shipped, "my-game", &server);
            // One image comes with the app.
            fs::create_dir_all(shipped.join("tiles/a/0/0")).unwrap();
            fs::write(shipped.join("tiles/a/0/0/0.png"), tile()).unwrap();
            let s = setup(
                "delete-images-bundled",
                vec![BundledPack {
                    id: "my-game".into(),
                    path: shipped.clone(),
                    downloadable: true,
                }],
            );
            s.library.start();
            let pack = s.library.maps_folder().join("my-game");
            assert!(pack.join("tiles/a/0/0/0.png").exists(), "installed");
            // A finished download. The slow server takes about ten seconds for
            // the 320 images at best, and three times that on a busy machine,
            // so the wait ends at a time, not after a count of short sleeps.
            s.manager.start("my-game", Detail::Full).unwrap();
            let give_up = std::time::Instant::now() + Duration::from_secs(120);
            while s.manager.is_active("my-game") && std::time::Instant::now() < give_up {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(s.manager.snapshot("my-game").unwrap().state, JobState::Done);
            assert!(pack.join("offline-tiles/a.json").exists());
            let info = images_info(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            // 320 downloaded and 20 built below them (levels 0 to 2), less the
            // one that came with the app.
            assert_eq!(info.count.files, 320 + 16 + 4 + 1 - 1);

            let deleted = delete_images(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert_eq!(deleted.files, info.count.files);
            assert!(
                pack.join("tiles/a/0/0/0.png").exists(),
                "what came with the app stays"
            );
            assert!(!pack.join("tiles/a/4").exists());
            assert!(!pack.join("offline-tiles").exists());
            assert!(pack.join("manifest.json").exists());
            assert!(s.manager.snapshot("my-game").is_none());
            // The pack itself still cannot be deleted: it comes with the app.
            let error = delete_pack(
                Arc::clone(&s.library),
                s.downloads.clone(),
                "my-game".into(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("comes with the app"), "{error}");
        }
    }
}
