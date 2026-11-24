/// The commands the Map Maker's page may call; `capabilities/main.json` grants them to its window.
const COMMANDS: &[&str] = &[
    "app_info",
    "choose_folder",
    "check_start",
    "check_status",
    "check_cancel",
    "make_start",
    "remake_start",
    "choose_model",
    "choose_level_folder",
    "model_inspect",
    "model_make_start",
    "restore_last_make",
    "floor_overrides_read",
    "floor_overrides_set",
    "floor_overrides_save_file",
    "floor_overrides_load_file",
    "floor_views_open",
    "floor_views_request",
    "floor_views_close",
    "reveal_pack",
    "preview_image",
    "save_report",
    "reveal_saved_report",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
