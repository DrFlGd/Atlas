//! The settings of "Atlas in the background", in the app's own data folder
//! (`background.json`): they describe this computer and this app, so they
//! are not in the shared settings file every Atlas app on the computer
//! reads. "Start Atlas when Windows starts" is not kept here: it is read
//! from the system each time.
//!
//! The file is read as untrusted: at most [`MAX_SETTINGS_BYTES`], another
//! format or version counts as none, and a value that cannot be used is
//! off (a switch) or the combination offered (the hotkey). It is written
//! whole through a part file renamed over it.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::hotkey::{self, Hotkey};
use crate::manifest::write_atomic;

/// The file in the app's data folder.
pub const SETTINGS_FILE: &str = "background.json";
const FORMAT: &str = "atlas-background";
const VERSION: u64 = 1;
/// A larger file is not read.
pub const MAX_SETTINGS_BYTES: u64 = 16 << 10;

/// The settings; all off until the person turns them on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    /// "Keep Atlas running when its window is closed".
    pub keep_running: bool,
    /// The hotkey is switched on.
    pub hotkey_on: bool,
    /// Its combination, kept while it is off too.
    pub hotkey: Hotkey,
    /// "Stay above other windows".
    pub on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            keep_running: false,
            hotkey_on: false,
            hotkey: hotkey::OFFERED,
            on_top: false,
        }
    }
}

/// The file in an app data folder.
pub fn path(app_data: &Path) -> PathBuf {
    app_data.join(SETTINGS_FILE)
}

/// The settings kept; all off when there are none that can be used.
pub fn read(app_data: &Path) -> Settings {
    let path = path(app_data);
    let small = std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() <= MAX_SETTINGS_BYTES);
    small
        .then(|| std::fs::read_to_string(&path).ok())
        .flatten()
        .map(|text| read_text(&text))
        .unwrap_or_default()
}

/// The settings a file's text holds, read as untrusted.
pub fn read_text(text: &str) -> Settings {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Settings::default();
    };
    if value.get("format").and_then(Value::as_str) != Some(FORMAT)
        || value.get("version").and_then(Value::as_u64) != Some(VERSION)
    {
        return Settings::default();
    }
    let switch = |value: Option<&Value>| value.and_then(Value::as_bool) == Some(true);
    let keys = value
        .pointer("/hotkey/keys")
        .and_then(Value::as_str)
        .and_then(hotkey::parse);
    Settings {
        keep_running: switch(value.get("keepRunning")),
        // A combination that cannot be used is off.
        hotkey_on: keys.is_some() && switch(value.pointer("/hotkey/on")),
        hotkey: keys.unwrap_or(hotkey::OFFERED),
        on_top: switch(value.get("onTop")),
    }
}

/// Keeps the settings.
pub fn write(app_data: &Path, settings: &Settings) -> Result<(), String> {
    let text = json!({
        "format": FORMAT,
        "version": VERSION,
        "keepRunning": settings.keep_running,
        "hotkey": { "on": settings.hotkey_on, "keys": settings.hotkey.to_string() },
        "onTop": settings.on_top,
    });
    std::fs::create_dir_all(app_data)
        .and_then(|()| {
            write_atomic(
                &path(app_data),
                serde_json::to_string_pretty(&text)
                    .unwrap_or_default()
                    .as_bytes(),
            )
        })
        .map_err(|error| format!("Atlas could not keep this setting: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    #[test]
    fn all_off_until_turned_on() {
        let dir = TempDir::new("background-settings");
        assert_eq!(read(&dir.0), Settings::default());
        assert_eq!(Settings::default().hotkey.to_string(), "Ctrl+Alt+M");

        let on = Settings {
            keep_running: true,
            hotkey_on: true,
            hotkey: hotkey::parse("Ctrl+Shift+F8").unwrap(),
            on_top: true,
        };
        write(&dir.0, &on).unwrap();
        assert_eq!(read(&dir.0), on);
        let text = std::fs::read_to_string(path(&dir.0)).unwrap();
        assert!(text.contains(r#""keys": "Ctrl+Shift+F8""#), "{text}");
    }

    #[test]
    fn reads_the_file_as_untrusted() {
        let off = Settings::default();
        for bad in [
            "",
            "null",
            "[true]",
            r#"{"format":"atlas-other","version":1,"keepRunning":true}"#,
            r#"{"format":"atlas-background","version":2,"keepRunning":true}"#,
            r#"{"format":"atlas-background","version":"1","keepRunning":true}"#,
            r#"{"format":"atlas-background","version":1,"keepRunning":"true","onTop":1}"#,
        ] {
            assert_eq!(read_text(bad), off, "{bad}");
        }
        // A combination that cannot be used: the hotkey is off, with the one offered.
        for keys in [r#""Win+D""#, r#""M""#, "42", r#""Ctrl+Alt+Nothing""#] {
            let text = format!(
                r#"{{"format":"atlas-background","version":1,"keepRunning":true,"hotkey":{{"on":true,"keys":{keys}}}}}"#
            );
            let read = read_text(&text);
            assert!(read.keep_running && !read.hotkey_on, "{keys}");
            assert_eq!(read.hotkey, hotkey::OFFERED);
        }
        // Switched on with no combination.
        let text = r#"{"format":"atlas-background","version":1,"hotkey":{"on":true}}"#;
        assert!(!read_text(text).hotkey_on);

        // A file too large is not read.
        let dir = TempDir::new("background-settings-large");
        let good = r#"{"format":"atlas-background","version":1,"keepRunning":true}"#;
        assert!(read_text(good).keep_running);
        std::fs::write(path(&dir.0), " ".repeat(20_000) + good).unwrap();
        assert_eq!(read(&dir.0), off);
    }
}
