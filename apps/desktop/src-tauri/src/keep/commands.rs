//! The commands of the setting "Keep packs for Game Repo up to date", in a
//! build with downloads only (listed in `build.rs`, granted to the main
//! window in `capabilities/downloads/main-downloads.json`). The folder is
//! chosen in the system's folder dialog: the page never names a path.

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Runtime, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use super::{
    store::{Schedule, Setting},
    Keeper, Status,
};
use crate::{
    commands::{blocking, pick_folder_at},
    library::{is_inside, same_path, Library},
    manifest::MANIFEST_FILE,
};

type KeeperState<'a> = State<'a, Arc<Keeper>>;

/// What the settings show: the setting, what is written now, and each
/// game's state.
#[tauri::command]
pub fn kept_packs_status(keeper: KeeperState<'_>) -> Status {
    keeper.status()
}

/// Asks for the folder in the system's dialog, starting at the folder in
/// use, and turns the setting on with it. `None` when the dialog was
/// closed. A folder that is, holds or lies in the maps folder, or that is
/// a pack folder, is refused.
#[tauri::command]
pub async fn kept_packs_choose_folder<R: Runtime>(
    window: WebviewWindow<R>,
    keeper: KeeperState<'_>,
    library: State<'_, Arc<Library>>,
) -> Result<Option<Status>, String> {
    let start = keeper.folder();
    let start = start
        .ancestors()
        .find(|folder| folder.is_dir())
        .map(std::path::Path::to_path_buf);
    let Some(folder) = pick_folder_at(&window, "Choose the folder to keep packs in", start).await?
    else {
        return Ok(None);
    };
    let keeper = Arc::clone(&keeper);
    let library = Arc::clone(&library);
    blocking(move || {
        let maps = library.maps_folder();
        if is_inside(&folder, &maps) || is_inside(&maps, &folder) {
            return Err("That folder is the maps folder, inside it or around it, which holds folders Atlas changes. Choose another folder.".to_owned());
        }
        if folder.join(MANIFEST_FILE).is_file() {
            return Err(
                "That folder is the folder of one map or wiki. Choose the folder that holds the pack files."
                    .to_owned(),
            );
        }
        let setting = keeper.setting();
        // The packs folder chosen in the dialog is the default: it follows
        // a change of the packs folder.
        let folder = (!same_path(&folder, &library.packs_folder())).then_some(folder);
        keeper
            .set(Setting {
                on: true,
                folder,
                schedule: setting.schedule,
            })
            .map(Some)
    })
    .await
}

/// The switch and the schedule.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptPacksChoice {
    pub on: bool,
    pub schedule: Schedule,
}

/// Turns the setting on or off and keeps how often it checks; the folder
/// stays as chosen.
#[tauri::command]
pub async fn kept_packs_set(
    keeper: KeeperState<'_>,
    choice: KeptPacksChoice,
) -> Result<Status, String> {
    let keeper = Arc::clone(&keeper);
    blocking(move || {
        let setting = keeper.setting();
        keeper.set(Setting {
            on: choice.on,
            folder: setting.folder,
            schedule: choice.schedule,
        })
    })
    .await
}

/// "Write all packs now": checks every game and writes each pack that is
/// not current, without waiting for a quiet time.
#[tauri::command]
pub fn kept_packs_write_all(keeper: KeeperState<'_>) -> Result<Status, String> {
    if !keeper.setting().on {
        return Err("Keeping packs up to date is off.".to_owned());
    }
    Ok(keeper.write_all())
}

/// "Write again": writes a pack the person removed from the folder.
#[tauri::command]
pub fn kept_packs_write_again(keeper: KeeperState<'_>, id: String) -> Result<Status, String> {
    if !keeper.setting().on {
        return Err("Keeping packs up to date is off.".to_owned());
    }
    if !crate::packs::is_valid_pack_id(&id) {
        return Err("That is not a game id Atlas can use.".to_owned());
    }
    Ok(keeper.write_again(&id))
}

/// Stops the run under way; what is not written is tried again at the
/// next check.
#[tauri::command]
pub fn kept_packs_cancel(keeper: KeeperState<'_>) -> Status {
    keeper.cancel()
}

/// Opens the folder in the system's file manager.
#[tauri::command]
pub fn kept_packs_reveal<R: Runtime>(
    app: AppHandle<R>,
    keeper: KeeperState<'_>,
) -> Result<(), String> {
    let folder = keeper.folder();
    if !folder.is_dir() {
        return Err("That folder cannot be found.".to_owned());
    }
    app.opener()
        .open_path(folder.display().to_string(), None::<&str>)
        .map_err(|error| format!("Could not open the folder: {error}"))
}
