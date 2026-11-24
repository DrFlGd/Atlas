//! Where map packs go: the maps folder the Atlas viewer reads, found the same way the viewer finds it
//! (apps/desktop/src-tauri/src/settings.rs).
//!
//! The viewer's shared folder is `Atlas` in the local data folder (`%LOCALAPPDATA%\Atlas` on Windows,
//! `~/.local/share/atlas` on Linux). Its `settings.json` may name another maps folder (`mapsFolder`), which the
//! person chose in the viewer; otherwise packs are in `Maps` there (`maps` on Linux).
//!
//! "Draw all areas again" lists the packs in that folder that have 3D maps (`packs_with_scenes`).

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;

/// A larger `maps.json` is not read to list a pack.
const MAX_MAPS_BYTES: u64 = 64 * 1024 * 1024;

/// A pack in the maps folder whose maps can be drawn again from their 3D models.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackWithScenes {
    /// Its folder's name in the maps folder.
    pub id: String,
    pub title: String,
    /// Maps with a 3D model, and all its maps.
    pub maps_3d: usize,
    pub maps: usize,
    /// The Map Maker made it (`writtenBy`): new floor cuts can change its layers.
    pub made_by_map_maker: bool,
}

/// Whether `name` is the name of a pack folder in the maps folder: no path, nothing hidden.
pub fn is_pack_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && name != ".."
}

/// The packs in `folder` with at least one 3D map, by title.
pub fn packs_with_scenes(folder: &Path) -> Vec<PackWithScenes> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = entry.path();
        if !is_pack_name(&name) || !path.is_dir() {
            continue;
        }
        let read = |file: &str| -> Option<Value> {
            let path = path.join(file);
            if fs::metadata(&path).ok()?.len() > MAX_MAPS_BYTES {
                return None;
            }
            let text = fs::read_to_string(path).ok()?;
            serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
        };
        let (Some(manifest), Some(Value::Array(maps))) = (read("manifest.json"), read("maps.json"))
        else {
            continue;
        };
        let maps_3d = maps
            .iter()
            .filter(|map| map.get("scene").is_some_and(Value::is_object))
            .count();
        if maps_3d == 0 {
            continue;
        }
        out.push(PackWithScenes {
            title: manifest
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
                .unwrap_or(&name)
                .chars()
                .take(200)
                .collect(),
            id: name,
            maps_3d,
            maps: maps.len(),
            made_by_map_maker: manifest
                .get("writtenBy")
                .and_then(|by| by.get("name"))
                .and_then(Value::as_str)
                == Some("Atlas Map Maker"),
        });
    }
    out.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
    out
}

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

    #[test]
    fn lists_the_packs_with_3d_maps() {
        let folder =
            std::env::temp_dir().join(format!("atlas-mapmaker-packs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        let pack = |name: &str, manifest: &str, maps: &str| {
            fs::create_dir_all(folder.join(name)).unwrap();
            fs::write(folder.join(name).join("manifest.json"), manifest).unwrap();
            fs::write(folder.join(name).join("maps.json"), maps).unwrap();
        };
        pack(
            "made",
            r#"{"title":"Made up","writtenBy":{"name":"Atlas Map Maker"}}"#,
            r#"[{"id":"a","scene":{"cells":[]}},{"id":"b"}]"#,
        );
        pack("flat", r#"{"title":"Flat"}"#, r#"[{"id":"a"}]"#);
        pack(
            "other",
            r#"{"title":"Another"}"#,
            r#"[{"id":"a","scene":{}}]"#,
        );
        pack(
            ".hidden",
            r#"{"title":"Hidden"}"#,
            r#"[{"id":"a","scene":{}}]"#,
        );
        pack("broken", "not json", r#"[{"id":"a","scene":{}}]"#);
        let found = packs_with_scenes(&folder);
        assert_eq!(
            found,
            vec![
                PackWithScenes {
                    id: "other".into(),
                    title: "Another".into(),
                    maps_3d: 1,
                    maps: 1,
                    made_by_map_maker: false
                },
                PackWithScenes {
                    id: "made".into(),
                    title: "Made up".into(),
                    maps_3d: 1,
                    maps: 2,
                    made_by_map_maker: true
                },
            ]
        );
        assert!(packs_with_scenes(&folder.join("missing")).is_empty());
        for bad in ["", ".", "..", ".hidden", "a/b", "a\\b", "c:x"] {
            assert!(!is_pack_name(bad), "{bad}");
        }
        assert!(is_pack_name("dark-souls-remastered"));
        let _ = fs::remove_dir_all(&folder);
    }
}
