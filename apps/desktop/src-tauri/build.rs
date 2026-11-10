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
            "download_settings_get",
            "download_settings_set",
            "library_list",
            "library_open_pack",
            "library_add_folder",
            "library_remove_location",
            "library_choose_maps_folder",
            "library_apply_maps_folder",
            "library_reveal",
            "library_delete_pack",
            "library_import_sources",
            "library_save_import",
            "import_open",
            "import_poll",
            "import_close",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
