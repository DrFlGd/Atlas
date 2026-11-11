/// The commands the Map Maker's page may call; `capabilities/main.json` grants them to its window.
const COMMANDS: &[&str] = &[
    "app_info",
    "choose_folder",
    "check_start",
    "check_status",
    "check_cancel",
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
