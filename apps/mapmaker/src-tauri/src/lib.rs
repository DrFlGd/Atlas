//! Atlas Map Maker: one window that checks a player's own game files with the bundled helper
//! (`atlas-gamefiles`, tools/gamefiles), shows what map data can be read, and makes a map pack from them for the
//! Atlas viewer.

pub mod checks;
mod commands;
pub mod maps;
pub mod settings;

use tauri::RunEvent;

use checks::Checks;
use commands::LastSaved;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Checks::default())
        .manage(LastSaved::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::choose_folder,
            commands::check_start,
            commands::check_status,
            commands::check_cancel,
            commands::make_start,
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
        }
    });
}
