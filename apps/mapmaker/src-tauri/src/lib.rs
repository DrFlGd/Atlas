//! Atlas Map Maker: one window that checks a player's own game files with the bundled helper
//! (`atlas-gamefiles`, tools/gamefiles), shows what map data can be read, and makes a map pack from them for the
//! Atlas viewer, and lets the player adjust where an area's floors are cut and make that area again.

pub mod checks;
mod commands;
pub mod floorviews;
pub mod maps;
pub mod overrides;
pub mod settings;

use tauri::RunEvent;

use checks::Checks;
use commands::LastSaved;
use floorviews::FloorViews;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Checks::default())
        .manage(LastSaved::default())
        .manage(FloorViews::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::choose_folder,
            commands::check_start,
            commands::check_status,
            commands::check_cancel,
            commands::make_start,
            commands::remake_start,
            commands::restore_last_make,
            commands::floor_overrides_read,
            commands::floor_overrides_set,
            commands::floor_overrides_save_file,
            commands::floor_overrides_load_file,
            commands::floor_views_open,
            commands::floor_views_request,
            commands::floor_views_close,
            commands::reveal_pack,
            commands::preview_image,
            commands::save_report,
            commands::reveal_saved_report,
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Atlas Map Maker");
    app.run(|app, event| {
        // A check or make still running when the app closes is ended with it.
        if let RunEvent::Exit = event {
            use tauri::Manager;
            app.state::<Checks>().stop_now();
            app.state::<FloorViews>().close();
        }
    });
}
