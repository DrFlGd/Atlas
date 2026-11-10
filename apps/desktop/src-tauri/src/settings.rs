//! Settings shared by every Atlas desktop app on this computer.
//!
//! The viewer and other builds of the shell (with a different app name and
//! identifier) keep their own app data, but they read and write one small
//! settings file in a folder that does not depend on the identifier:
//!
//! - Windows: `%LOCALAPPDATA%\Atlas\settings.json`
//! - macOS: `~/Library/Application Support/Atlas/settings.json`
//! - Linux: `$XDG_DATA_HOME/atlas/settings.json` (`~/.local/share/atlas/…`)
//!
//! ```json
//! { "format": "atlas-settings", "version": 1,
//!   "mapsFolder": null,
//!   "locations": [{ "path": "E:\\Maps\\My Game", "kind": "pack" }],
//!   "downloads": { "parallel": 2, "pauseMs": 250,
//!                  "requestsPerMinute": null, "kilobytesPerSecond": null } }
//! ```
//!
//! `mapsFolder` null means the default maps folder next to this file
//! (`Maps`, or `maps` on Linux). Every change re-reads the file first, so
//! two apps changing different settings do not undo each other. A file that
//! cannot be read counts as the defaults.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub const SETTINGS_FORMAT: &str = "atlas-settings";
pub const SETTINGS_VERSION: u32 = 1;
const SETTINGS_FILE: &str = "settings.json";
/// Settings files larger than this are not ours.
const MAX_SETTINGS_BYTES: u64 = 1 << 20;
/// Remembered locations beyond this are dropped, oldest first.
const MAX_LOCATIONS: usize = 100;

/// The folder shared by the Atlas apps, under the platform's local data folder.
pub fn shared_dir(local_data: &Path) -> PathBuf {
    if cfg!(target_os = "linux") {
        local_data.join("atlas")
    } else {
        local_data.join("Atlas")
    }
}

/// The maps folder used until the person chooses another.
pub fn default_maps_folder(shared: &Path) -> PathBuf {
    if cfg!(target_os = "linux") {
        shared.join("maps")
    } else {
        shared.join("Maps")
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocationKind {
    /// One pack folder.
    Pack,
    /// A folder whose sub-folders are packs.
    Folder,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    pub kind: LocationKind,
}

/// How map images are downloaded. Kept within bounds that stay considerate
/// to the image servers; there is no "unlimited".
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadSettings {
    /// Requests in flight at once.
    pub parallel: u32,
    /// Pause after each request, per parallel download, in milliseconds.
    pub pause_ms: u32,
    /// Optional cap on requests per minute, over all parallel downloads.
    pub requests_per_minute: Option<u32>,
    /// Optional cap on download speed, in kilobytes (1000 bytes) per second.
    pub kilobytes_per_second: Option<u32>,
}

impl DownloadSettings {
    pub const PARALLEL: (u32, u32) = (1, 4);
    pub const PAUSE_MS: (u32, u32) = (100, 5000);
    pub const REQUESTS_PER_MINUTE: (u32, u32) = (10, 600);
    pub const KILOBYTES_PER_SECOND: (u32, u32) = (50, 50_000);

    /// The same settings with every value moved into its bounds.
    #[must_use]
    pub fn clamped(self) -> Self {
        let clamp = |value: u32, (low, high): (u32, u32)| value.clamp(low, high);
        Self {
            parallel: clamp(self.parallel, Self::PARALLEL),
            pause_ms: clamp(self.pause_ms, Self::PAUSE_MS),
            requests_per_minute: self
                .requests_per_minute
                .map(|n| clamp(n, Self::REQUESTS_PER_MINUTE)),
            kilobytes_per_second: self
                .kilobytes_per_second
                .map(|n| clamp(n, Self::KILOBYTES_PER_SECOND)),
        }
    }

    /// Checks values coming from the web app; out-of-bounds values are refused, not moved.
    pub fn validate(self) -> Result<Self, String> {
        if self == self.clamped() {
            Ok(self)
        } else {
            Err("Those download settings are outside the allowed range.".to_owned())
        }
    }
}

impl Default for DownloadSettings {
    fn default() -> Self {
        Self {
            parallel: 2,
            pause_ms: 250,
            requests_per_minute: None,
            kilobytes_per_second: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedSettings {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub maps_folder: Option<String>,
    #[serde(default)]
    pub locations: Vec<Location>,
    #[serde(default)]
    pub downloads: DownloadSettings,
}

impl Default for SharedSettings {
    fn default() -> Self {
        Self {
            format: SETTINGS_FORMAT.to_owned(),
            version: SETTINGS_VERSION,
            maps_folder: None,
            locations: Vec::new(),
            downloads: DownloadSettings::default(),
        }
    }
}

/// Reads and writes the shared settings file in one folder.
#[derive(Clone, Debug)]
pub struct SettingsFile {
    dir: PathBuf,
}

impl SettingsFile {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(SETTINGS_FILE)
    }

    /// The current settings; the defaults when the file is missing or unusable.
    pub fn read(&self) -> SharedSettings {
        let path = self.path();
        let Ok(metadata) = fs::metadata(&path) else {
            return SharedSettings::default();
        };
        if metadata.len() > MAX_SETTINGS_BYTES {
            eprintln!("atlas: ignoring {}: too large", path.display());
            return SharedSettings::default();
        }
        let parsed = fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<SharedSettings>(text.trim_start_matches('\u{feff}'))
                    .map_err(|error| error.to_string())
            });
        match parsed {
            Ok(settings)
                if settings.format == SETTINGS_FORMAT && settings.version == SETTINGS_VERSION =>
            {
                SharedSettings {
                    downloads: settings.downloads.clamped(),
                    ..settings
                }
            }
            Ok(_) => {
                eprintln!(
                    "atlas: ignoring {}: not a settings file of this version",
                    path.display()
                );
                SharedSettings::default()
            }
            Err(error) => {
                eprintln!("atlas: ignoring {}: {error}", path.display());
                SharedSettings::default()
            }
        }
    }

    /// Re-reads the file, applies `change` and writes the result atomically.
    pub fn update(
        &self,
        change: impl FnOnce(&mut SharedSettings),
    ) -> Result<SharedSettings, String> {
        let mut settings = self.read();
        change(&mut settings);
        if settings.locations.len() > MAX_LOCATIONS {
            let extra = settings.locations.len() - MAX_LOCATIONS;
            settings.locations.drain(..extra);
        }
        self.write(&settings)
            .map_err(|error| format!("Could not save the settings: {error}"))?;
        Ok(settings)
    }

    fn write(&self, settings: &SharedSettings) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let part = self.dir.join(format!("{SETTINGS_FILE}.part"));
        let mut file = fs::File::create(&part)?;
        file.write_all(serde_json::to_string_pretty(settings)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&part, self.path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    #[test]
    fn reads_defaults_and_keeps_other_apps_changes() {
        let dir = TempDir::new("settings");
        let file = SettingsFile::new(dir.0.join("shared"));
        assert_eq!(file.read(), SharedSettings::default());

        file.update(|s| s.maps_folder = Some("/maps".into()))
            .unwrap();
        // Another app adds a location; the maps folder set above stays.
        let other = SettingsFile::new(dir.0.join("shared"));
        other
            .update(|s| {
                s.locations.push(Location {
                    path: "/usb/pack".into(),
                    kind: LocationKind::Pack,
                });
            })
            .unwrap();
        let read = file.read();
        assert_eq!(read.maps_folder.as_deref(), Some("/maps"));
        assert_eq!(read.locations.len(), 1);
        assert!(!dir.0.join("shared/settings.json.part").exists());
    }

    #[test]
    fn ignores_unusable_files_and_clamps_downloads() {
        let dir = TempDir::new("settings-bad");
        let file = SettingsFile::new(dir.0.clone());
        fs::write(file.path(), b"{ not json").unwrap();
        assert_eq!(file.read(), SharedSettings::default());
        fs::write(file.path(), br#"{"format":"other","version":1}"#).unwrap();
        assert_eq!(file.read(), SharedSettings::default());
        fs::write(
            file.path(),
            br#"{"format":"atlas-settings","version":1,"downloads":{"parallel":99,"pauseMs":1,"requestsPerMinute":100000}}"#,
        )
        .unwrap();
        let downloads = file.read().downloads;
        assert_eq!(downloads.parallel, 4);
        assert_eq!(downloads.pause_ms, 100);
        assert_eq!(downloads.requests_per_minute, Some(600));
        assert_eq!(downloads.kilobytes_per_second, None);
    }

    #[test]
    fn validates_download_settings() {
        assert!(DownloadSettings::default().validate().is_ok());
        let fast = DownloadSettings {
            parallel: 8,
            ..DownloadSettings::default()
        };
        assert!(fast.validate().is_err());
        let slow = DownloadSettings {
            parallel: 1,
            pause_ms: 5000,
            requests_per_minute: Some(10),
            kilobytes_per_second: Some(50),
        };
        assert_eq!(slow.validate(), Ok(slow));
        let unlimited = DownloadSettings {
            pause_ms: 0,
            ..DownloadSettings::default()
        };
        assert!(unlimited.validate().is_err());
    }
}
