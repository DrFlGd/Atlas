//! The Map Maker's one setting: the last game folder, in `settings.json` in the app's config folder.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub last_folder: Option<String>,
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
        let settings = Settings {
            last_folder: Some(r"C:\Games\DARK SOULS REMASTERED".into()),
        };
        write(&file, &settings).unwrap();
        assert_eq!(read(&file), settings);
        assert!(fs::read_to_string(&file).unwrap().contains("lastFolder"));
        fs::write(&file, "not json").unwrap();
        assert_eq!(read(&file), Settings::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
