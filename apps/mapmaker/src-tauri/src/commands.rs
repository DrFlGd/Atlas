//! The commands the Map Maker's page calls. Only the main window may call them (capabilities/main.json).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{
    checks::{self, Checks, Job, Status},
    floorviews::FloorViews,
    maps, overrides,
    settings::{self, LastMake, Settings},
};

/// The report saved last, which "Show in folder" reveals.
#[derive(Default)]
pub struct LastSaved(pub Mutex<Option<PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    helper_found: bool,
    /// The 3D builder (atlas-scene) is installed next to the app.
    scene_builder_found: bool,
    /// "Also make 3D maps", as last chosen (on by default).
    make_3d: bool,
    /// "Map style", as last chosen.
    map_style: String,
    /// "Floors", as last chosen: `passages` or `cuts`; none for as suits the game.
    floor_method: Option<String>,
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

fn floor_overrides_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(overrides::FILE_NAME))
        .map_err(|error| error.to_string())
}

/// The player's floor cuts file for the helper, when there is one.
fn floor_overrides_for_helper<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    floor_overrides_file(app).ok().filter(|file| file.is_file())
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
        scene_builder_found: checks::find_scene_builder().is_some(),
        make_3d: settings.make_3d(),
        map_style: settings.map_style().to_owned(),
        floor_method: settings.floor_method().map(str::to_owned),
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

/// The map style asked for, when it is one the helper can draw.
fn checked_style(
    map_style: Option<String>,
    settings: &settings::Settings,
) -> Result<String, String> {
    match map_style {
        Some(style) if settings::is_map_style(&style) => Ok(style),
        Some(style) => Err(format!("{style} is not a map style that can be drawn.")),
        None => Ok(settings.map_style().to_owned()),
    }
}

/// The floor method asked for: `passages` or `cuts`, or none (`game`, or nothing) for as suits the game.
fn checked_method(floor_method: Option<String>) -> Result<Option<String>, String> {
    match floor_method.as_deref() {
        None | Some("game") => Ok(None),
        Some(method) if settings::is_floor_method(method) => Ok(Some(method.to_owned())),
        Some(method) => Err(format!("{method} is not a way of finding floors.")),
    }
}

/// Starts making the map pack of `folder`, installed in the Atlas viewer's maps folder, with 3D maps when
/// `make_3d` ("Also make 3D maps"), drawn in `map_style`, its floors found by `floor_method` (all three
/// remembered). Its report goes to a new folder in the app's own data.
#[tauri::command]
pub fn make_start<R: Runtime>(
    app: AppHandle<R>,
    checks: State<'_, Checks>,
    folder: String,
    make_3d: bool,
    map_style: Option<String>,
    floor_method: Option<String>,
) -> Result<Status, String> {
    let maps_folder = viewer_maps_folder(&app)?;
    let file = settings_file(&app)?;
    let mut settings = settings::read(&file);
    let map_style = checked_style(map_style, &settings)?;
    let floor_method = checked_method(floor_method)?;
    if settings.make_3d() != make_3d
        || settings.map_style() != map_style
        || settings.floor_method() != floor_method.as_deref()
    {
        settings.make_3d = Some(make_3d);
        settings.map_style = Some(map_style.clone());
        settings.floor_method = floor_method.clone();
        let _ = settings::write(&file, &settings);
    }
    let job = Job::Make {
        maps_folder,
        three_d: make_3d,
        scene_builder: checks::find_scene_builder(),
        floor_overrides: floor_overrides_for_helper(&app),
        map_style,
        floor_method,
    };
    start(&app, &checks, folder, job, "makes")
}

/// Starts making one area (`mAA_BB`) of the last make again, with the player's floor cuts, drawn in `map_style`,
/// and putting its new map in place of the old one in the pack that make installed.
#[tauri::command]
pub fn remake_start<R: Runtime>(
    app: AppHandle<R>,
    checks: State<'_, Checks>,
    views: State<'_, FloorViews>,
    area: String,
    make_3d: bool,
    map_style: Option<String>,
) -> Result<Status, String> {
    let settings = settings::read(&settings_file(&app)?);
    let map_style = checked_style(map_style, &settings)?;
    let key = overrides::area_key(&area).ok_or_else(|| format!("{area} is not an area."))?;
    let (folder, out_dir, _) = checks
        .last_make()
        .ok_or("Make the map first: then its areas can be made again.")?;
    if !folder.is_dir() {
        return Err(format!(
            "The game folder {} is not there any more. Choose it and press Make map.",
            folder.display()
        ));
    }
    let helper = checks::find_helper().ok_or(
        "The file reader that comes with the Map Maker (atlas-gamefiles) is missing. Please reinstall the app.",
    )?;
    // The views read the area's floor data, which the run writes anew.
    views.close();
    let job = Job::Remake {
        maps_folder: viewer_maps_folder(&app)?,
        three_d: make_3d,
        scene_builder: checks::find_scene_builder(),
        floor_overrides: floor_overrides_for_helper(&app),
        map_style,
        // An area's own choice is in the floor cuts file; otherwise as the last make.
        floor_method: settings.floor_method().map(str::to_owned),
        area: key,
    };
    checks.start(&helper, job, &folder, &out_dir)
}

/// The packs in the Atlas viewer's maps folder that have 3D maps, which "Draw all areas again" can draw again.
#[tauri::command]
pub fn redraw_packs<R: Runtime>(app: AppHandle<R>) -> Result<Vec<maps::PackWithScenes>, String> {
    Ok(maps::packs_with_scenes(&viewer_maps_folder(&app)?))
}

/// Starts drawing every 2D floor of the pack `pack` (a folder in the Atlas viewer's maps folder) again from its
/// own 3D models, in `map_style` (remembered), with the player's floor cuts. No game folder is needed. Its report
/// goes to a new folder in the app's own data.
#[tauri::command]
pub fn redraw_start<R: Runtime>(
    app: AppHandle<R>,
    checks: State<'_, Checks>,
    pack: String,
    map_style: Option<String>,
) -> Result<Status, String> {
    if !maps::is_pack_name(&pack) {
        return Err(format!("{pack} is not a map pack in the maps folder."));
    }
    let folder = viewer_maps_folder(&app)?.join(&pack);
    if !folder.join("manifest.json").is_file() {
        return Err(format!(
            "The map pack {pack} is not in the maps folder any more."
        ));
    }
    let file = settings_file(&app)?;
    let mut settings = settings::read(&file);
    let map_style = checked_style(map_style, &settings)?;
    if settings.map_style() != map_style {
        settings.map_style = Some(map_style.clone());
        let _ = settings::write(&file, &settings);
    }
    let helper = checks::find_helper().ok_or(
        "The file reader that comes with the Map Maker (atlas-gamefiles) is missing. Please reinstall the app.",
    )?;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("redraws");
    let out_dir = checks::new_run_folder(&base)?;
    let job = Job::Redraw {
        scene_builder: checks::find_scene_builder(),
        floor_overrides: floor_overrides_for_helper(&app),
        map_style,
        floor_method: settings.floor_method().map(str::to_owned),
    };
    checks.start(&helper, job, &folder, &out_dir)
}

/// Shows the report of the last make of an earlier session again, when the app has just opened.
#[tauri::command]
pub fn restore_last_make<R: Runtime>(app: AppHandle<R>, checks: State<'_, Checks>) -> Status {
    if let (Ok(file), Ok(maps_folder)) = (settings_file(&app), viewer_maps_folder(&app)) {
        if let Some(last) = settings::read(&file).last_make {
            checks.restore(Path::new(&last.folder), Path::new(&last.out), &maps_folder);
        }
    }
    checks.status()
}

/// The player's floor cuts: `{game: {mAA_BB: {cuts, names}}}`.
#[tauri::command]
pub fn floor_overrides_read<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    overrides::read(&floor_overrides_file(&app)?).map(Value::Object)
}

/// Sets one area's floor cuts and names, or with no `entry` removes them ("Back to automatic"). Returns them all.
#[tauri::command]
pub fn floor_overrides_set<R: Runtime>(
    app: AppHandle<R>,
    game: String,
    area: String,
    entry: Option<Value>,
) -> Result<Value, String> {
    overrides::set_area(&floor_overrides_file(&app)?, &game, &area, entry.as_ref())
        .map(Value::Object)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorCutsFile {
    name: String,
    areas: usize,
    /// After a load: the player's floor cuts with those of the file.
    overrides: Option<Value>,
}

/// "Save my floor cuts to a file…": asks where, and writes the game's floor cuts there. `None` when the dialog
/// was closed.
#[tauri::command]
pub async fn floor_overrides_save_file<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    game: String,
) -> Result<Option<FloorCutsFile>, String> {
    if !overrides::is_game(&game) {
        return Err(format!("{game} is not a game."));
    }
    let (contents, areas) = overrides::export(&floor_overrides_file(&app)?, &game)?;
    if areas == 0 {
        return Err("You have not set any floor cuts yet.".to_owned());
    }
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save your floor cuts")
        .set_file_name(format!("atlas-floor-cuts-{game}.json"))
        .add_filter("Floor cuts", &["json"]);
    if let Ok(documents) = window.path().document_dir() {
        dialog = dialog.set_directory(documents);
    }
    let Some(mut path) = chosen_path(|done| dialog.save_file(done)).await? else {
        return Ok(None);
    };
    if path.extension().is_none() {
        path.set_extension("json");
    }
    let text = serde_json::to_string_pretty(&contents).map_err(|error| error.to_string())?;
    fs::write(
        &path,
        text + "
",
    )
    .map_err(|error| format!("Could not save {}: {error}", path.display()))?;
    Ok(Some(FloorCutsFile {
        name: file_name(&path),
        areas,
        overrides: None,
    }))
}

/// "Load floor cuts from a file…": asks for a file and takes its floor cuts in (they replace the player's for the
/// same areas). `None` when the dialog was closed.
#[tauri::command]
pub async fn floor_overrides_load_file<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<FloorCutsFile>, String> {
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Load floor cuts")
        .add_filter("Floor cuts", &["json"]);
    if let Ok(documents) = window.path().document_dir() {
        dialog = dialog.set_directory(documents);
    }
    let Some(path) = chosen_path(|done| dialog.pick_file(done)).await? else {
        return Ok(None);
    };
    let (games, areas) = overrides::import(&floor_overrides_file(&app)?, &path)?;
    Ok(Some(FloorCutsFile {
        name: file_name(&path),
        areas,
        overrides: Some(Value::Object(games)),
    }))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Opens the Adjust floors views of an area of the last make (see floorviews.rs): its `ready` line.
#[tauri::command]
pub async fn floor_views_open(
    checks: State<'_, Checks>,
    views: State<'_, FloorViews>,
    area: String,
) -> Result<Value, String> {
    let key = overrides::area_key(&area).ok_or_else(|| format!("{area} is not an area."))?;
    let (_, out_dir, _) = checks.last_make().ok_or("Make the map first.")?;
    let helper = checks::find_helper().ok_or(
        "The file reader that comes with the Map Maker (atlas-gamefiles) is missing. Please reinstall the app.",
    )?;
    let views = views.inner().clone();
    tauri::async_runtime::spawn_blocking(move || views.open(&helper, &out_dir, &key))
        .await
        .map_err(|error| error.to_string())?
}

/// The Adjust floors views for these cuts and names, or with `method` `passages`, for automatic passages with
/// these Upper / Lower choices.
#[tauri::command]
pub async fn floor_views_request(
    views: State<'_, FloorViews>,
    area: String,
    cuts: Vec<f64>,
    names: Vec<String>,
    outlines: Option<bool>,
    method: Option<String>,
    passages: Option<Value>,
) -> Result<Value, String> {
    let key = overrides::area_key(&area).ok_or_else(|| format!("{area} is not an area."))?;
    let cuts: Vec<f64> = cuts
        .into_iter()
        .filter(|c| c.is_finite())
        .take(32)
        .collect();
    let names: Vec<String> = names
        .into_iter()
        .take(33)
        .map(|name| name.chars().take(80).collect())
        .collect();
    let views = views.inner().clone();
    let outlines = outlines.unwrap_or(false);
    let method = checked_method(method)?.unwrap_or_else(|| "cuts".to_owned());
    // Kept to what the helper reads, as in the floor cuts file.
    let passages =
        overrides::clean_entry(&serde_json::json!({ "passages": passages.unwrap_or(Value::Null) }))
            .and_then(|entry| entry.get("passages").cloned())
            .unwrap_or_else(|| Value::Array(Vec::new()));
    tauri::async_runtime::spawn_blocking(move || {
        views.request(&key, &cuts, &names, outlines, &method, &passages)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn floor_views_close(views: State<'_, FloorViews>) {
    views.close();
}

/// The pictures to compare with, per `game:mAA_BB`, and how each lies over its map (settings::clean_alignment).
#[tauri::command]
pub fn compare_read<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    Ok(Value::Object(
        settings::read(&settings_file(&app)?).compare(),
    ))
}

/// Remembers (or with no `alignment` forgets) how one area's picture lies over its map. Returns them all.
#[tauri::command]
pub fn compare_set<R: Runtime>(
    app: AppHandle<R>,
    key: String,
    alignment: Option<Value>,
) -> Result<Value, String> {
    let file = settings_file(&app)?;
    let mut settings = settings::read(&file);
    let all = settings.set_compare(&key, alignment.as_ref())?;
    settings::write(&file, &settings)?;
    Ok(Value::Object(all))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    name: String,
    path: String,
    /// The picture as a `data:` URL.
    url: String,
}

/// A larger picture is not opened.
const MAX_PICTURE_BYTES: u64 = 40 * 1024 * 1024;

fn picture_at(path: &Path) -> Result<Picture, String> {
    let size = fs::metadata(path)
        .map_err(|_| format!("The picture {} is not there any more.", path.display()))?
        .len();
    if size > MAX_PICTURE_BYTES {
        return Err("That picture is too large (more than 40 MB).".to_owned());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let kind = picture_kind(&bytes).ok_or("That file is not a PNG or JPEG picture.")?;
    Ok(Picture {
        name: file_name(path),
        path: path.display().to_string(),
        url: format!("data:{kind};base64,{}", checks::base64(&bytes)),
    })
}

/// The type of a PNG or JPEG picture, by its first bytes.
fn picture_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else {
        None
    }
}

/// "Compare with a picture…": asks for a PNG or JPEG picture and opens it (it is only shown, never copied into a
/// map pack). `None` when the dialog was closed.
#[tauri::command]
pub async fn compare_pick_picture<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<Picture>, String> {
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a picture to compare with")
        .add_filter("Pictures", &["png", "jpg", "jpeg"]);
    if let Ok(pictures) = window.path().picture_dir() {
        dialog = dialog.set_directory(pictures);
    }
    let Some(path) = chosen_path(|done| dialog.pick_file(done)).await? else {
        return Ok(None);
    };
    picture_at(&path).map(Some)
}

/// Opens again a picture remembered for an area (only those: any other path is refused).
#[tauri::command]
pub fn compare_open_picture<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<Picture, String> {
    if !settings::read(&settings_file(&app)?).remembers_picture(&path) {
        return Err("That picture is not one you chose to compare with.".to_owned());
    }
    picture_at(Path::new(&path))
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
    let is_make = matches!(job, Job::Make { .. });
    let status = checks.start(&helper, job, &folder_path, &out_dir)?;
    let file = settings_file(app)?;
    let settings = settings::read(&file);
    let last_make = if is_make {
        Some(LastMake {
            folder: folder.clone(),
            out: out_dir.display().to_string(),
        })
    } else {
        settings.last_make.clone()
    };
    let changed = Settings {
        last_folder: Some(folder),
        last_make,
        ..settings.clone()
    };
    if changed != settings {
        let _ = settings::write(&file, &changed);
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
    use super::{checked_method, picture_kind, safe_file_name};

    #[test]
    fn floor_methods_and_pictures() {
        assert_eq!(checked_method(None).unwrap(), None);
        assert_eq!(checked_method(Some("game".into())).unwrap(), None);
        assert_eq!(
            checked_method(Some("passages".into())).unwrap().as_deref(),
            Some("passages")
        );
        assert!(checked_method(Some("stairs".into())).is_err());
        assert_eq!(picture_kind(b"\x89PNG\r\n\x1a\nmore"), Some("image/png"));
        assert_eq!(picture_kind(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(picture_kind(b"GIF89a"), None);
    }

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
