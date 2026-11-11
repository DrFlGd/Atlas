//! The commands the web app may call (see `capabilities/main.json`).
//!
//! They cover what a browser does differently from a desktop app: saving and
//! opening progress files through the system's dialogs, opening links in the
//! system browser, and downloading map images. The web app reaches them
//! through a small bridge that it only uses when it runs inside this shell.

use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime, State, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{
    activity::{self, ActivityLog, Area, RecentLog},
    imports::{Imports, PollResult},
    library::{FolderChoice, Library, Listing, SaveImport, SavedSource},
    removal::{ImagesCount, ImagesDeleted, PackDeleted},
    settings::DownloadSettings,
    tiles::{
        manager::{PlanInfo, Snapshot},
        pyramid::Detail,
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
}

#[tauri::command]
pub fn desktop_info<R: Runtime>(app: AppHandle<R>) -> DesktopInfo {
    DesktopInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
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

async fn chosen_path(
    pick: impl FnOnce(Box<dyn FnOnce(Option<FilePath>) + Send>),
) -> Result<Option<PathBuf>, String> {
    let (send, receive) = oneshot::channel();
    pick(Box::new(move |path| {
        let _ = send.send(path);
    }));
    match receive.await.ok().flatten() {
        None => Ok(None),
        Some(path) => path
            .into_path()
            .map(Some)
            .map_err(|error| format!("That location cannot be used: {error}")),
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
#[tauri::command]
pub async fn save_text_file<R: Runtime>(
    window: WebviewWindow<R>,
    suggested_name: String,
    contents: String,
) -> Result<Option<SavedFile>, String> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Export progress")
        .set_file_name(safe_file_name(&suggested_name))
        .add_filter("Atlas progress", &["json"]);
    let Some(path) = chosen_path(|done| dialog.save_file(done)).await? else {
        return Ok(None);
    };
    write_text(&path, &contents)?;
    Ok(Some(SavedFile {
        name: file_name(&path),
    }))
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

/// Asks for a progress file to import and returns its text. `None` when the
/// person closes the dialog.
#[tauri::command]
pub async fn open_text_file<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<OpenedFile>, String> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Import progress")
        .add_filter("Atlas progress", &["json"]);
    match chosen_path(|done| dialog.pick_file(done)).await? {
        None => Ok(None),
        Some(path) => read_text(&path).map(Some),
    }
}

type Manager<'a> = State<'a, Arc<DownloadManager>>;

/// The download choices for a pack, with estimates.
#[tauri::command]
pub async fn tiles_plan(manager: Manager<'_>, pack_id: String) -> Result<PlanInfo, String> {
    let manager = Arc::clone(&manager);
    // Looks at every tile on disk.
    tokio::task::spawn_blocking(move || manager.plan_info(&pack_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn tiles_start(
    manager: Manager<'_>,
    pack_id: String,
    detail: Detail,
) -> Result<Snapshot, String> {
    manager.start(&pack_id, detail)
}

#[tauri::command]
pub async fn tiles_pause(manager: Manager<'_>, pack_id: String) -> Result<Snapshot, String> {
    manager.pause(&pack_id)
}

#[tauri::command]
pub async fn tiles_resume(manager: Manager<'_>, pack_id: String) -> Result<Snapshot, String> {
    manager.resume(&pack_id)
}

#[tauri::command]
pub async fn tiles_cancel(manager: Manager<'_>, pack_id: String) -> Result<(), String> {
    manager.cancel(&pack_id)
}

#[tauri::command]
pub async fn tiles_snapshot(
    manager: Manager<'_>,
    pack_id: String,
) -> Result<Option<Snapshot>, String> {
    Ok(manager.snapshot(&pack_id))
}

// ---------------------------------------------------------------------------
// Download settings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettingsInfo {
    settings: DownloadSettings,
    /// Lowest and highest allowed value of each setting.
    bounds: DownloadBounds,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadBounds {
    parallel: (u32, u32),
    pause_ms: (u32, u32),
    requests_per_minute: (u32, u32),
    kilobytes_per_second: (u32, u32),
}

type LibraryState<'a> = State<'a, Arc<Library>>;

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

#[tauri::command]
pub fn download_settings_get(library: LibraryState<'_>) -> DownloadSettingsInfo {
    settings_info(library.settings().read().downloads)
}

/// Saves the download settings for every Atlas app and applies them at once.
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

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

async fn pick_folder<R: Runtime>(
    window: &WebviewWindow<R>,
    title: &str,
) -> Result<Option<PathBuf>, String> {
    let mut dialog = window.dialog().file().set_parent(window).set_title(title);
    // Start in the home folder rather than a list of recent files.
    if let Ok(home) = window.path().home_dir() {
        dialog = dialog.set_directory(home);
    }
    chosen_path(|done| dialog.pick_folder(done)).await
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
    manager: Manager<'_>,
    move_packs: bool,
) -> Result<Vec<String>, String> {
    let busy = manager.active_packs();
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
async fn stop_download(manager: &Arc<DownloadManager>, id: &str) -> Result<(), String> {
    if manager.stop_and_wait(id, STOP_TIMEOUT).await {
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
    manager: Manager<'_>,
    id: String,
) -> Result<PackDeleted, String> {
    delete_pack(Arc::clone(&library), Arc::clone(&manager), id).await
}

async fn delete_pack(
    library: Arc<Library>,
    manager: Arc<DownloadManager>,
    id: String,
) -> Result<PackDeleted, String> {
    listed(&library, &id)?;
    {
        // The same checks as deleting, before any download is stopped.
        let library = Arc::clone(&library);
        let id = id.clone();
        blocking(move || library.check_deletable(&id)).await?;
    }
    stop_download(&manager, &id).await?;
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
    manager.forget(&id);
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
    manager: Manager<'_>,
    id: String,
) -> Result<ImagesInfo, String> {
    images_info(Arc::clone(&library), Arc::clone(&manager), id).await
}

async fn images_info(
    library: Arc<Library>,
    manager: Arc<DownloadManager>,
    id: String,
) -> Result<ImagesInfo, String> {
    listed(&library, &id)?;
    let downloading = manager.is_active(&id);
    let Ok(location) = manager.images_location(&id) else {
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
    manager: Manager<'_>,
    id: String,
) -> Result<ImagesDeleted, String> {
    delete_images(Arc::clone(&library), Arc::clone(&manager), id).await
}

async fn delete_images(
    library: Arc<Library>,
    manager: Arc<DownloadManager>,
    id: String,
) -> Result<ImagesDeleted, String> {
    listed(&library, &id)?;
    let location = manager
        .images_location(&id)
        .map_err(|_| "This map has no map images to delete.".to_owned())?;
    stop_download(&manager, &id).await?;
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
    manager.forget(&id);
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
    manager: Manager<'_>,
    request: SaveImport,
) -> Result<Listing, String> {
    if manager.is_active(&request.pack_id) {
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
// Importing from a web page

/// Opens a web page in the import window, for an importer's page reader.
#[tauri::command]
pub async fn import_open<R: Runtime>(
    app: AppHandle<R>,
    imports: State<'_, Imports>,
    url: String,
    reader: String,
    importer_id: Option<String>,
    wait_seconds: Option<u32>,
) -> Result<(), String> {
    *lock_poll() = None;
    let importer = importer_id
        .as_deref()
        .map(short)
        .unwrap_or_else(|| "unknown".to_owned());
    let page = page_address(&url);
    let wait = wait_seconds.map_or_else(String::new, |seconds| {
        format!(", waiting up to {seconds} s for its map data")
    });
    match imports.open(&app, &url, reader) {
        Ok(()) => {
            activity::info(
                Area::Import,
                format!("Opened {page} in the import window for importer {importer}{wait}"),
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
        Ok(url) => {
            format!(
                "{}://{}{}",
                url.scheme(),
                url.host_str().unwrap_or_default(),
                url.port()
                    .map_or_else(String::new, |port| format!(":{port}"))
            ) + url.path()
        }
        Err(_) => "an address that is not a URL".to_owned(),
    }
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

/// Asks the open page for its data once.
#[tauri::command]
pub async fn import_poll<R: Runtime>(
    app: AppHandle<R>,
    imports: State<'_, Imports>,
) -> Result<PollResult, String> {
    let result = imports.poll(&app).await;
    // What the page holds is never logged; only what the app saw happen.
    let (state, line) = match &result {
        PollResult::Waiting { loading: true, .. } => ("loading", None),
        PollResult::Waiting { loading: false, .. } => (
            "waiting",
            Some((
                false,
                "The page has loaded; waiting for its map data".to_owned(),
            )),
        ),
        PollResult::Ready { data } => (
            "ready",
            Some((
                false,
                format!("Read the page's map data ({} characters)", data.len()),
            )),
        ),
        PollResult::Closed => (
            "closed",
            Some((
                true,
                "The page window was closed before the map data appeared".to_owned(),
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

/// How an import ended, as the web app reports it for the activity log.
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    map_locations: u64,
    maps: u64,
    locations: u64,
    categories: u64,
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
            " | locations on this map: {} | in the game: maps {}, locations {}, categories {}",
            counts.map_locations, counts.maps, counts.locations, counts.categories
        ));
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
            "Import with importer demo-maps added: pack test-valley, map test-valley:map:east | locations on this map: 4 | in the game: maps 1, locations 4, categories 3"
        );
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
                Arc::clone(&s.manager),
                "my-game".into(),
            )
            .await
            .unwrap();
            assert!(info.downloading);
            assert!(info.count.files >= 3);

            let deleted = delete_pack(
                Arc::clone(&s.library),
                Arc::clone(&s.manager),
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
                Arc::clone(&s.manager),
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
                Arc::clone(&s.manager),
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
                Arc::clone(&s.manager),
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
                let error = delete_pack(Arc::clone(&s.library), Arc::clone(&s.manager), id.into())
                    .await
                    .unwrap_err();
                assert!(error.contains("not in the list"), "{id}: {error}");
                assert!(
                    delete_images(Arc::clone(&s.library), Arc::clone(&s.manager), id.into())
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
                Arc::clone(&s.manager),
                "my-game".into(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("Another Atlas window or app"), "{error}");
            let error = delete_images(
                Arc::clone(&s.library),
                Arc::clone(&s.manager),
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
                Arc::clone(&s.manager),
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
                Arc::clone(&s.manager),
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
                Arc::clone(&s.manager),
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
            // A finished download.
            s.manager.start("my-game", Detail::Full).unwrap();
            for _ in 0..800 {
                if !s.manager.is_active("my-game") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(s.manager.snapshot("my-game").unwrap().state, JobState::Done);
            assert!(pack.join("offline-tiles/a.json").exists());
            let info = images_info(
                Arc::clone(&s.library),
                Arc::clone(&s.manager),
                "my-game".into(),
            )
            .await
            .unwrap();
            // 320 downloaded and 20 built below them (levels 0 to 2), less the
            // one that came with the app.
            assert_eq!(info.count.files, 320 + 16 + 4 + 1 - 1);

            let deleted = delete_images(
                Arc::clone(&s.library),
                Arc::clone(&s.manager),
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
                Arc::clone(&s.manager),
                "my-game".into(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("comes with the app"), "{error}");
        }
    }
}
