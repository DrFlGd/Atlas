//! Where map packs go: the maps folder the Atlas viewer reads, found the same way the viewer finds it
//! (apps/desktop/src-tauri/src/settings.rs).
//!
//! The viewer's shared folder is `Atlas` in the local data folder (`%LOCALAPPDATA%\Atlas` on Windows,
//! `~/.local/share/atlas` on Linux). Its `settings.json` may name another maps folder (`mapsFolder`), which the
//! person chose in the viewer; otherwise packs are in `Maps` there (`maps` on Linux).

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

/// The viewer's shared folder in `local_data`.
pub fn shared_dir(local_data: &Path) -> PathBuf {
    if cfg!(target_os = "linux") {
        local_data.join("atlas")
    } else {
        local_data.join("Atlas")
    }
}

/// The maps folder the viewer uses, for the local data folder `local_data`.
pub fn maps_folder(local_data: &Path) -> PathBuf {
    let shared = shared_dir(local_data);
    let chosen = fs::read_to_string(shared.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|settings| {
            settings
                .get("mapsFolder")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|folder| !folder.trim().is_empty() && Path::new(folder).is_absolute());
    match chosen {
        Some(folder) => PathBuf::from(folder),
        None if cfg!(target_os = "linux") => shared.join("maps"),
        None => shared.join("Maps"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_chosen_maps_folders() {
        let local =
            std::env::temp_dir().join(format!("atlas-mapmaker-maps-{}", std::process::id()));
        let _ = fs::remove_dir_all(&local);
        let shared = shared_dir(&local);
        let default = maps_folder(&local);
        assert_eq!(default.parent(), Some(shared.as_path()));
        assert!(matches!(
            default.file_name().and_then(|name| name.to_str()),
            Some("Maps" | "maps")
        ));

        fs::create_dir_all(&shared).unwrap();
        let chosen = local.join("Elsewhere");
        fs::write(
            shared.join("settings.json"),
            serde_json::json!({"format": "atlas-settings", "version": 1, "mapsFolder": chosen})
                .to_string(),
        )
        .unwrap();
        assert_eq!(maps_folder(&local), chosen);

        // A relative or unreadable choice falls back to the default.
        fs::write(shared.join("settings.json"), r#"{"mapsFolder":"relative"}"#).unwrap();
        assert_eq!(maps_folder(&local), default);
        fs::write(shared.join("settings.json"), "not json").unwrap();
        assert_eq!(maps_folder(&local), default);
        let _ = fs::remove_dir_all(&local);
    }
}
