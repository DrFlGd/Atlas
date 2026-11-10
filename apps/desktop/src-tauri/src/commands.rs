//! The commands the web app may call (see `capabilities/main.json`).
//!
//! They cover what a browser does differently from a desktop app: saving and
//! opening progress files through the system's dialogs, opening links in the
//! system browser, and downloading map images. The web app reaches them
//! through a small bridge that it only uses when it runs inside this shell.

use std::{fs, path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime, State, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{
    imports::{Imports, PollResult},
    library::{FolderChoice, Library, Listing, SaveImport, SavedSource},
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
    Pack { id: String },
    Location { path: String },
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
    };
    if !path.is_dir() {
        return Err("That folder cannot be found.".to_owned());
    }
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|error| format!("Could not open the folder: {error}"))
}

/// Deletes a pack, with its map images, from the maps folder.
#[tauri::command]
pub async fn library_delete_pack(
    library: LibraryState<'_>,
    manager: Manager<'_>,
    id: String,
) -> Result<(), String> {
    if manager.is_active(&id) {
        return Err("Its map images are downloading. Cancel the download first.".to_owned());
    }
    let library = Arc::clone(&library);
    blocking(move || library.delete_pack(&id)).await
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
        library.save_import(&request)?;
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
) -> Result<(), String> {
    imports.open(&app, &url, reader)
}

/// Asks the open page for its data once.
#[tauri::command]
pub async fn import_poll<R: Runtime>(
    app: AppHandle<R>,
    imports: State<'_, Imports>,
) -> Result<PollResult, String> {
    Ok(imports.poll(&app).await)
}

#[tauri::command]
pub async fn import_close<R: Runtime>(
    app: AppHandle<R>,
    imports: State<'_, Imports>,
) -> Result<(), String> {
    imports.close(&app);
    Ok(())
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
}
