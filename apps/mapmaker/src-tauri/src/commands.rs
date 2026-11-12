//! The commands the Map Maker's page calls. Only the main window may call them (capabilities/main.json).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{
    checks::{self, Checks, Job, Status},
    maps,
    settings::{self, Settings},
};

/// The report saved last, which "Show in folder" reveals.
#[derive(Default)]
pub struct LastSaved(pub Mutex<Option<PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    helper_found: bool,
    last_folder: Option<String>,
    typical_folder: Option<String>,
    /// Where Make map installs the pack: the Atlas viewer's maps folder.
    maps_folder: Option<String>,
}

#[derive(Serialize)]
pub struct SavedReport {
    path: String,
    name: String,
}

fn settings_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|error| error.to_string())
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

#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>) -> Result<AppInfo, String> {
    let settings = settings::read(&settings_file(&app)?);
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        helper_found: checks::find_helper().is_some(),
        last_folder: settings.last_folder,
        typical_folder: settings::typical_folder(),
        maps_folder: viewer_maps_folder(&app)
            .ok()
            .map(|folder| folder.display().to_string()),
    })
}

fn viewer_maps_folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .local_data_dir()
        .map(|local| maps::maps_folder(&local))
        .map_err(|error| error.to_string())
}

/// Asks for the game folder, starting in the last one, or where Steam puts Dark Souls Remastered.
#[tauri::command]
pub async fn choose_folder<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    let file = settings_file(&app)?;
    let mut settings = settings::read(&file);
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose your game folder");
    let start = settings
        .last_folder
        .clone()
        .filter(|folder| Path::new(folder).is_dir())
        .or_else(settings::typical_folder)
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok());
    if let Some(start) = start {
        dialog = dialog.set_directory(start);
    }
    let Some(path) = chosen_path(|done| dialog.pick_folder(done)).await? else {
        return Ok(None);
    };
    let folder = path.display().to_string();
    settings.last_folder = Some(folder.clone());
    settings::write(&file, &settings)?;
    Ok(Some(folder))
}

/// Starts a check of `folder`. Its output goes to a new folder in the app's own data.
#[tauri::command]
pub fn check_start<R: Runtime>(
    app: AppHandle<R>,
    checks: State<'_, Checks>,
    folder: String,
) -> Result<Status, String> {
    start(&app, &checks, folder, Job::Check, "checks")
}

/// Starts making the map pack of `folder`, installed in the Atlas viewer's maps folder. Its report goes to a new
/// folder in the app's own data.
#[tauri::command]
pub fn make_start<R: Runtime>(
    app: AppHandle<R>,
    checks: State<'_, Checks>,
    folder: String,
) -> Result<Status, String> {
    let maps_folder = viewer_maps_folder(&app)?;
    start(&app, &checks, folder, Job::Make { maps_folder }, "makes")
}

fn start<R: Runtime>(
    app: &AppHandle<R>,
    checks: &Checks,
    folder: String,
    job: Job,
    runs: &str,
) -> Result<Status, String> {
    let helper = checks::find_helper().ok_or(
        "The file reader that comes with the Map Maker (atlas-gamefiles) is missing. Please reinstall the app.",
    )?;
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err(format!(
            "The folder {folder} does not exist any more. Choose it again."
        ));
    }
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(runs);
    let out_dir = checks::new_run_folder(&base)?;
    let status = checks.start(&helper, job, &folder_path, &out_dir)?;
    let file = settings_file(app)?;
    let mut settings = settings::read(&file);
    if settings.last_folder.as_deref() != Some(folder.as_str()) {
        settings = Settings {
            last_folder: Some(folder),
        };
        let _ = settings::write(&file, &settings);
    }
    Ok(status)
}

#[tauri::command]
pub fn check_status(checks: State<'_, Checks>) -> Status {
    checks.status()
}

#[tauri::command]
pub fn check_cancel(checks: State<'_, Checks>) {
    checks.cancel();
}

/// A preview picture of the finished check, as a `data:` URL.
#[tauri::command]
pub fn preview_image(checks: State<'_, Checks>, file: String) -> Result<String, String> {
    if !file.ends_with(".png") {
        return Err("Not a picture.".to_owned());
    }
    let path = checks.output_file(&file)?;
    let bytes = fs::read(&path).map_err(|error| format!("Could not read {file}: {error}"))?;
    Ok(format!("data:image/png;base64,{}", checks::base64(&bytes)))
}

/// Asks where to save the report and copies the check's zip there. `None` when the dialog was closed.
#[tauri::command]
pub async fn save_report<R: Runtime>(
    window: WebviewWindow<R>,
    checks: State<'_, Checks>,
    last_saved: State<'_, LastSaved>,
    suggested_name: String,
) -> Result<Option<SavedReport>, String> {
    let zip = checks.report_zip()?;
    if !zip.is_file() {
        return Err("No report was written to save.".to_owned());
    }
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save the report")
        .set_file_name(safe_file_name(&suggested_name))
        .add_filter("Zip file", &["zip"]);
    if let Ok(documents) = window.path().document_dir() {
        dialog = dialog.set_directory(documents);
    }
    let Some(mut path) = chosen_path(|done| dialog.save_file(done)).await? else {
        return Ok(None);
    };
    if path.extension().is_none() {
        path.set_extension("zip");
    }
    fs::copy(&zip, &path).map_err(|error| format!("Could not save {}: {error}", path.display()))?;
    *last_saved
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path.clone());
    Ok(Some(SavedReport {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.display().to_string(),
    }))
}

/// Shows the saved report in the system's file manager.
#[tauri::command]
pub fn reveal_saved_report<R: Runtime>(
    app: AppHandle<R>,
    last_saved: State<'_, LastSaved>,
) -> Result<(), String> {
    let path = last_saved
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .ok_or("No report saved yet.")?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())
}

/// Shows the map pack the last make installed in the system's file manager.
#[tauri::command]
pub fn reveal_pack<R: Runtime>(app: AppHandle<R>, checks: State<'_, Checks>) -> Result<(), String> {
    let folder = checks.pack_folder()?;
    app.opener()
        .reveal_item_in_dir(&folder)
        .map_err(|error| error.to_string())
}

/// A file name to suggest in the save dialog, kept to safe characters.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    if cleaned.is_empty() || cleaned.starts_with('.') {
        "atlas-check-report.zip".to_owned()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

    #[test]
    fn suggested_names_are_safe() {
        assert_eq!(
            safe_file_name("atlas-check-dark-souls-remastered-2026-11-11.zip"),
            "atlas-check-dark-souls-remastered-2026-11-11.zip"
        );
        assert_eq!(safe_file_name("../../x.zip"), "atlas-check-report.zip");
        assert_eq!(safe_file_name("a/b\\c.zip"), "abc.zip");
        assert_eq!(safe_file_name(""), "atlas-check-report.zip");
    }
}
