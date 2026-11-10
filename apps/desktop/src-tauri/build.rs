fn main() {
    // The web app may call only these commands, and only where
    // `capabilities/main.json` grants them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_info",
            "open_external",
            "save_text_file",
            "open_text_file",
            "tiles_plan",
            "tiles_start",
            "tiles_pause",
            "tiles_resume",
            "tiles_cancel",
            "tiles_snapshot",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
