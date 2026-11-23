//! The Map Maker's settings, in `settings.json` in the app's config folder: the last game folder, whether Make
//! map also makes 3D maps, and the last make (so its report, and Adjust floors, are there when the app opens again).
//! The player's own floor cuts are in `floor-overrides.json` beside it (see overrides.rs).

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub last_folder: Option<String>,
    /// "Also make 3D maps"; on when never chosen.
    #[serde(rename = "make3d", skip_serializing_if = "Option::is_none")]
    pub make_3d: Option<bool>,
    /// The last make: its game folder and output folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_make: Option<LastMake>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastMake {
    pub folder: String,
    pub out: String,
}

impl Settings {
    pub fn make_3d(&self) -> bool {
        self.make_3d.unwrap_or(true)
    }
}

pub fn read(file: &Path) -> Settings {
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write(file: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    // Written next to it first, so a crash never leaves half a file.
    let partial = file.with_extension("json.partial");
    fs::write(&partial, text).map_err(|error| error.to_string())?;
    fs::rename(&partial, file).map_err(|error| error.to_string())
}

/// Where Steam installs Dark Souls Remastered by default, when that folder exists here.
pub fn typical_folder() -> Option<String> {
    let candidates = [
        r"C:\Program Files (x86)\Steam\steamapps\common\DARK SOULS REMASTERED",
        r"C:\Program Files\Steam\steamapps\common\DARK SOULS REMASTERED",
    ];
    candidates
        .iter()
        .find(|path| cfg!(windows) && Path::new(path).is_dir())
        .map(|path| (*path).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_bad_files() {
        let dir =
            std::env::temp_dir().join(format!("atlas-mapmaker-settings-{}", std::process::id()));
        let file = dir.join("settings.json");
        assert_eq!(read(&file), Settings::default());
        assert!(read(&file).make_3d(), "3D maps are on until turned off");
        let settings = Settings {
            last_folder: Some(r"C:\Games\DARK SOULS REMASTERED".into()),
            make_3d: Some(false),
            last_make: Some(LastMake {
                folder: r"C:\Games\DARK SOULS REMASTERED".into(),
                out: r"C:\Users\Someone\AppData\Local\Atlas Map Maker\makes\run-1".into(),
            }),
        };
        write(&file, &settings).unwrap();
        assert_eq!(read(&file), settings);
        assert!(!read(&file).make_3d());
        let text = fs::read_to_string(&file).unwrap();
        assert!(
            text.contains("lastFolder") && text.contains("make3d") && text.contains("lastMake"),
            "{text}"
        );
        fs::write(&file, "not json").unwrap();
        assert_eq!(read(&file), Settings::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
