//! Settings shared by every Atlas desktop app on this computer.
//!
//! The viewer and other builds of the shell (with a different app name and
//! identifier) keep their own app data, but they read and write one small
//! settings file in a folder that does not depend on the identifier:
//!
//! - Windows: `%LOCALAPPDATA%\Atlas\settings.json`
//! - macOS: `~/Library/Application Support/Atlas/settings.json`
//! - Linux: `$XDG_DATA_HOME/atlas/settings.json` (`~/.local/share/atlas/…`)
//! - Android: `Atlas/settings.json` in the app's own data folder, which no
//!   other app reads
//!
//! On Android the maps folder is not next to the settings file but in
//! `no_backup/Maps` in the app's data folder (see [`default_maps_folder`]).
//!
//! ```json
//! { "format": "atlas-settings", "version": 1,
//!   "mapsFolder": null,
//!   "packsFolder": "E:\\Packs",
//!   "locations": [{ "path": "E:\\Maps\\My Game", "kind": "pack" }],
//!   "packFiles": ["E:\\Shared\\Test Valley.atlaspack"],
//!   "downloads": { "parallel": 2, "pauseMs": 250,
//!                  "requestsPerMinute": null, "kilobytesPerSecond": null } }
//! ```
//!
//! `mapsFolder` null means the default maps folder next to this file
//! (`Maps`, or `maps` on Linux). `packsFolder`, absent unless the person
//! chose another, is the folder of pack files Atlas reads where they lie
//! (see [`packs_folder`]); another program that puts pack files there reads
//! it from this file. `linuxAppImage`, on Linux only and absent while
//! unknown, is the AppImage the viewer last started from (see
//! [`SharedSettings::linux_app_image`]). Every change re-reads the file first, so
//! two apps changing different settings do not undo each other. A file that
//! cannot be read counts as the defaults.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::activity::{self, Area};

pub const SETTINGS_FORMAT: &str = "atlas-settings";
pub const SETTINGS_VERSION: u32 = 1;
const SETTINGS_FILE: &str = "settings.json";
/// Settings files larger than this are not ours.
const MAX_SETTINGS_BYTES: u64 = 1 << 20;
/// Remembered locations beyond this are dropped, oldest first.
const MAX_LOCATIONS: usize = 100;
/// Remembered pack files beyond this are dropped, oldest first.
const MAX_PACK_FILES: usize = 100;

/// The folder shared by the Atlas apps, under the platform's local data folder.
pub fn shared_dir(local_data: &Path) -> PathBuf {
    if cfg!(target_os = "linux") {
        local_data.join("atlas")
    } else {
        local_data.join("Atlas")
    }
}

/// The maps folder used until the person chooses another.
///
/// On Android, where it cannot be chosen, it is `no_backup/Maps` in the
/// app's data folder (the shared folder's parent): the folder Android
/// itself names for files never to back up (`Context.getNoBackupFilesDir`).
/// Android's Auto Backup keeps at most 25 MB of an app and backs up nothing
/// of an app over that, so map packs, often hundreds of megabytes, would
/// stop the found marks (in the web view's storage) being backed up. Until
/// version 0.3.6 it was `Atlas/Maps`, beside the settings file; see
/// [`move_old_maps`].
pub fn default_maps_folder(shared: &Path) -> PathBuf {
    if cfg!(target_os = "android") {
        android_maps_folder(shared)
    } else if cfg!(target_os = "linux") {
        shared.join("maps")
    } else {
        shared.join("Maps")
    }
}

/// The packs folder used until the person chooses another: `Packs`
/// beside the default maps folder (`packs` on Linux, as `maps` is),
/// whichever maps folder is chosen. Only [`packs_folder`] and the choice
/// "Use the default folder" read it; everything else asks
/// [`packs_folder`].
pub fn default_packs_folder(shared: &Path) -> PathBuf {
    let name = if cfg!(target_os = "linux") {
        "packs"
    } else {
        "Packs"
    };
    default_maps_folder(shared).with_file_name(name)
}

/// The longest packs folder path the settings file may give.
const MAX_FOLDER_CHARS: usize = 4096;

/// Why a `packsFolder` value of the settings file cannot be used; none
/// when it can. Read from the file, so untrusted: a path of at most
/// [`MAX_FOLDER_CHARS`] characters, absolute, with no `..` and no NUL.
fn unusable_folder(text: &str) -> Option<&'static str> {
    if text.trim().is_empty() {
        return Some("it is empty");
    }
    if text.chars().count() > MAX_FOLDER_CHARS {
        return Some("it is too long");
    }
    if text.contains('\0') {
        return Some("it is not a path");
    }
    let path = Path::new(text);
    if !path.is_absolute() {
        return Some("it is not a full path");
    }
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Some("it goes up a folder with ..");
    }
    None
}

/// The packs folder value last written to the activity log as unusable,
/// so a value read again and again (the watcher reads the settings at
/// every look) gives one line.
static LOGGED_BAD_FOLDER: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The folder of pack files (`.atlaspack`) Atlas reads where they lie, as
/// the settings say: `packsFolder` when the person chose one, else the
/// default folder (see [`default_packs_folder`]). A value that cannot be
/// used (empty, not a full path, not text) counts as the default, with one
/// line in the activity log. Every use of the packs folder, in every Atlas
/// app on the computer, goes through this, so they always agree. Another
/// app may put pack files there; Atlas never changes or deletes them, and
/// moves them only when the person changes the folder and asks to.
pub fn packs_folder(settings: &SharedSettings, shared: &Path) -> PathBuf {
    chosen_packs_folder(settings).unwrap_or_else(|| default_packs_folder(shared))
}

/// Whether the packs folder is the default one (none chosen, or a value
/// that cannot be used).
pub fn packs_folder_is_default(settings: &SharedSettings) -> bool {
    chosen_packs_folder(settings).is_none()
}

/// The packs folder the person chose, when the value can be used.
fn chosen_packs_folder(settings: &SharedSettings) -> Option<PathBuf> {
    let text = settings.packs_folder.as_ref()?;
    let Some(reason) = unusable_folder(text) else {
        return Some(PathBuf::from(text));
    };
    let mut logged = LOGGED_BAD_FOLDER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if logged.as_deref() != Some(text.as_str()) {
        activity::warn(
            Area::Library,
            format!(
                "The packs folder in the settings cannot be used ({reason}), so the default packs folder is used"
            ),
        );
        *logged = Some(text.clone());
    }
    None
}

/// Reads `packsFolder` leniently: a value that is not text counts as an
/// empty one, which cannot be used, rather than making the whole settings
/// file unreadable.
fn lenient_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text),
        _ => Some(String::new()),
    })
}

/// Reads an optional text leniently: a value that is not text counts as
/// none, rather than making the whole settings file unreadable.
fn lenient_optional_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::String(text) => Some(text),
        _ => None,
    })
}

/// The folder Android never backs up, in the app's data folder.
const NO_BACKUP_DIR: &str = "no_backup";

/// The Android maps folder: `<app data>/no_backup/Maps`, for the shared
/// folder `<app data>/Atlas`.
pub fn android_maps_folder(shared: &Path) -> PathBuf {
    shared
        .parent()
        .unwrap_or(shared)
        .join(NO_BACKUP_DIR)
        .join("Maps")
}

/// The Android maps folder of version 0.3.5 and earlier, which Auto Backup
/// included: `Atlas/Maps`, beside the settings file.
pub fn old_android_maps_folder(shared: &Path) -> PathBuf {
    shared.join("Maps")
}

/// Moves what is in an old maps folder into the new one (on the same
/// drive, so each entry is renamed, not copied) and removes the old folder
/// when it is empty. An entry whose name is taken in the new folder stays
/// where it is. The names moved, in order.
pub fn move_old_maps(old: &Path, new: &Path) -> std::io::Result<Vec<String>> {
    if !crate::removal::is_real_dir(old) {
        return Ok(Vec::new());
    }
    let mut entries: Vec<_> = fs::read_dir(old)?.flatten().collect();
    entries.sort_by_key(fs::DirEntry::file_name);
    let mut moved = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let target = new.join(&name);
        if fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        fs::create_dir_all(new)?;
        fs::rename(entry.path(), &target)?;
        moved.push(name.to_string_lossy().into_owned());
    }
    // Only when empty; an entry left behind keeps it.
    let _ = fs::remove_dir(old);
    Ok(moved)
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

/// The size downloaded location photos are kept at (`photos` of the
/// download settings).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PhotoSize {
    /// At most 1,280 pixels wide, as before photos were kept at full size.
    Smaller,
    /// Up to 4,096 pixels wide, as a wiki's pictures kept at full size, with
    /// a smaller copy for cards made from the file kept. A value this app
    /// does not know counts as this.
    #[default]
    #[serde(other)]
    Full,
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
    /// The size location photos are kept at. A file written by an app that
    /// does not know it has none: full size then.
    pub photos: PhotoSize,
    /// Whether a map's location photos are downloaded after it is added,
    /// once its map images are downloaded or need no download ("Download
    /// location photos with a map"). The web app starts that download; the
    /// shell only keeps the choice. On unless the person turned it off.
    pub photos_with_map: bool,
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
            ..self
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
            photos: PhotoSize::Full,
            photos_with_map: true,
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
    /// The packs folder the person chose; none for the default (see
    /// [`packs_folder`]). Left out of the file while it is none, so a file
    /// without it reads as the default. An app that does not know it
    /// leaves it out when it writes the file.
    #[serde(
        default,
        deserialize_with = "lenient_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub packs_folder: Option<String>,
    #[serde(default)]
    pub locations: Vec<Location>,
    /// Single pack files (`.atlaspack`) the person opened from a folder
    /// Atlas does not read otherwise (from the file manager, or as the
    /// path Atlas was started with), oldest first. Each is read where it
    /// lies, as the pack files of the packs folder are. An app that does
    /// not know this list leaves it out when it writes the file.
    #[serde(default)]
    pub pack_files: Vec<String>,
    #[serde(default)]
    pub downloads: DownloadSettings,
    /// When an app that reads sites (a build with downloads) last started
    /// on this computer, in RFC 3339. Such an app keeps each map and wiki
    /// as a working folder in the maps folder, which every Atlas app on the
    /// computer shares, so a reader then offers none of the folders there
    /// for removal (see `oldfolders.rs`). Written by that app at each
    /// start; an app that does not know it leaves it out when it writes the
    /// file, until that app starts again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_reader_started_at: Option<String>,
    /// Linux only: the full path of the AppImage the plain viewer (the app
    /// without downloads) last started from, for another app that writes
    /// the line which starts Atlas with a game in Steam (see `linux.rs`).
    /// Written at each start from an AppImage whose path the line can hold,
    /// and taken out when the file it names is gone; absent while unknown,
    /// and never written on Windows or Android. A value that is not text
    /// counts as none. An app that does not know it leaves it out when it
    /// writes the file, until the viewer starts again.
    #[serde(
        rename = "linuxAppImage",
        default,
        deserialize_with = "lenient_optional_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub linux_app_image: Option<String>,
}

impl Default for SharedSettings {
    fn default() -> Self {
        Self {
            format: SETTINGS_FORMAT.to_owned(),
            version: SETTINGS_VERSION,
            maps_folder: None,
            packs_folder: None,
            locations: Vec::new(),
            pack_files: Vec::new(),
            downloads: DownloadSettings::default(),
            site_reader_started_at: None,
            linux_app_image: None,
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

    /// The packs folder as the file says now (see [`packs_folder`]).
    pub fn packs_folder(&self) -> PathBuf {
        packs_folder(&self.read(), &self.dir)
    }

    /// The current settings; the defaults when the file is missing or unusable.
    pub fn read(&self) -> SharedSettings {
        let path = self.path();
        let Ok(metadata) = fs::metadata(&path) else {
            return SharedSettings::default();
        };
        if metadata.len() > MAX_SETTINGS_BYTES {
            activity::warn(
                Area::Library,
                format!("Ignoring {}: too large", path.display()),
            );
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
                activity::warn(
                    Area::Library,
                    format!(
                        "Ignoring {}: not a settings file of this version",
                        path.display()
                    ),
                );
                SharedSettings::default()
            }
            Err(error) => {
                activity::warn(
                    Area::Library,
                    format!("Ignoring {}: {error}", path.display()),
                );
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
        if settings.pack_files.len() > MAX_PACK_FILES {
            let extra = settings.pack_files.len() - MAX_PACK_FILES;
            settings.pack_files.drain(..extra);
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
    fn keeps_the_pack_files_opened_through_other_changes() {
        let dir = TempDir::new("settings-pack-files");
        let file = SettingsFile::new(dir.0.clone());
        file.update(|s| s.pack_files.push("/shared/valley.atlaspack".into()))
            .unwrap();
        // Another change keeps the list; a file written before the list
        // existed reads as an empty one.
        file.update(|s| s.maps_folder = Some("/maps".into()))
            .unwrap();
        assert_eq!(file.read().pack_files, ["/shared/valley.atlaspack"]);
        assert!(fs::read_to_string(file.path())
            .unwrap()
            .contains("\"packFiles\""));
        fs::write(file.path(), br#"{"format":"atlas-settings","version":1}"#).unwrap();
        assert!(file.read().pack_files.is_empty());
        // At most 100, the oldest dropped first.
        file.update(|s| {
            s.pack_files = (0..105).map(|n| format!("/files/{n}.atlaspack")).collect();
        })
        .unwrap();
        let kept = file.read().pack_files;
        assert_eq!(kept.len(), 100);
        assert_eq!(kept[0], "/files/5.atlaspack");
    }

    #[test]
    fn keeps_the_linux_appimage_only_while_known() {
        let dir = TempDir::new("settings-appimage");
        let file = SettingsFile::new(dir.0.clone());
        // Absent while unknown.
        file.update(|s| s.maps_folder = Some("/maps".into()))
            .unwrap();
        assert!(!fs::read_to_string(file.path())
            .unwrap()
            .contains("linuxAppImage"));
        // Kept through another app's changes, under its own name.
        let path = "/home/deck/Applications/Atlas.AppImage";
        file.update(|s| s.linux_app_image = Some(path.into()))
            .unwrap();
        file.update(|s| s.pack_files.push("/a.atlaspack".into()))
            .unwrap();
        assert_eq!(file.read().linux_app_image.as_deref(), Some(path));
        assert!(fs::read_to_string(file.path())
            .unwrap()
            .contains(r#""linuxAppImage": "/home/deck/Applications/Atlas.AppImage""#));
        // A value that is not text counts as none, and the rest is read.
        fs::write(
            file.path(),
            br#"{"format":"atlas-settings","version":1,"mapsFolder":"/maps","linuxAppImage":7}"#,
        )
        .unwrap();
        let read = file.read();
        assert_eq!(read.linux_app_image, None);
        assert_eq!(read.maps_folder.as_deref(), Some("/maps"));
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
        // Location photos at full size unless the file says smaller.
        assert_eq!(downloads.photos, PhotoSize::Full);
        fs::write(
            file.path(),
            br#"{"format":"atlas-settings","version":1,"downloads":{"photos":"smaller"}}"#,
        )
        .unwrap();
        assert_eq!(file.read().downloads.photos, PhotoSize::Smaller);
        assert_eq!(file.read().downloads.pause_ms, 250);
        // A map's photos are downloaded with it unless turned off.
        assert!(file.read().downloads.photos_with_map);
        fs::write(
            file.path(),
            br#"{"format":"atlas-settings","version":1,"downloads":{"photosWithMap":false}}"#,
        )
        .unwrap();
        assert!(!file.read().downloads.photos_with_map);
        fs::write(
            file.path(),
            br#"{"format":"atlas-settings","version":1,"downloads":{"photos":"tiny","pauseMs":500}}"#,
        )
        .unwrap();
        assert_eq!(file.read().downloads.photos, PhotoSize::Full);
        assert_eq!(file.read().downloads.pause_ms, 500);
    }

    #[test]
    fn reads_the_packs_folder_and_uses_the_default_for_a_value_it_cannot_use() {
        let dir = TempDir::new("settings-packs-folder");
        let file = SettingsFile::new(dir.0.join("shared"));
        let default = default_packs_folder(file.dir());
        // Absent: the default, and nothing written for it.
        assert_eq!(file.packs_folder(), default);
        assert!(packs_folder_is_default(&file.read()));
        file.update(|s| s.maps_folder = Some("/maps".into()))
            .unwrap();
        assert!(!fs::read_to_string(file.path())
            .unwrap()
            .contains("packsFolder"));

        // A full path is used, and kept through other changes.
        let chosen = dir.0.join("Elsewhere").join("Packs");
        let text = chosen.display().to_string();
        file.update(|s| s.packs_folder = Some(text.clone()))
            .unwrap();
        assert_eq!(file.packs_folder(), chosen);
        assert!(!packs_folder_is_default(&file.read()));
        file.update(|s| s.locations.clear()).unwrap();
        assert_eq!(file.read().packs_folder.as_deref(), Some(text.as_str()));
        assert!(fs::read_to_string(file.path())
            .unwrap()
            .contains("\"packsFolder\""));

        // Values it cannot use count as the default; the rest of the file
        // is read as it is.
        let long = format!("/{}", "a".repeat(5000));
        for bad in [
            r#""""#.to_owned(),
            r#""   ""#.to_owned(),
            r#""Packs""#.to_owned(),
            r#""packs/inside""#.to_owned(),
            r#""/packs/../elsewhere""#.to_owned(),
            r#""/packs\u0000x""#.to_owned(),
            format!("\"{long}\""),
            "42".to_owned(),
            "true".to_owned(),
            r#"["/packs"]"#.to_owned(),
            r#"{"path": "/packs"}"#.to_owned(),
        ] {
            fs::write(
                file.path(),
                format!(r#"{{"format":"atlas-settings","version":1,"mapsFolder":"/maps","packsFolder":{bad}}}"#),
            )
            .unwrap();
            let read = file.read();
            assert_eq!(read.maps_folder.as_deref(), Some("/maps"), "{bad}");
            assert_eq!(packs_folder(&read, file.dir()), default, "{bad}");
            assert!(packs_folder_is_default(&read), "{bad}");
        }
        // Null is the default too.
        fs::write(
            file.path(),
            br#"{"format":"atlas-settings","version":1,"packsFolder":null}"#,
        )
        .unwrap();
        assert_eq!(file.read().packs_folder, None);
        assert_eq!(file.packs_folder(), default);
    }

    #[test]
    fn android_keeps_maps_where_it_backs_nothing_up() {
        // `shared_dir` of Android's data folder (`Atlas`, as on Windows).
        let shared = Path::new("/data/user/0/dev.atlas.android/Atlas");
        assert_eq!(
            android_maps_folder(shared),
            Path::new("/data/user/0/dev.atlas.android/no_backup/Maps")
        );
        assert_eq!(
            old_android_maps_folder(shared),
            Path::new("/data/user/0/dev.atlas.android/Atlas/Maps")
        );
        if !cfg!(target_os = "android") {
            assert_ne!(default_maps_folder(shared), android_maps_folder(shared));
        }
    }

    #[test]
    fn moves_the_old_android_maps_folder() {
        let dir = TempDir::new("settings-move-maps");
        let shared = dir.0.join("Atlas");
        let old = old_android_maps_folder(&shared);
        let new = android_maps_folder(&shared);
        // Nothing there: nothing to do, and nothing is made.
        assert_eq!(move_old_maps(&old, &new).unwrap(), Vec::<String>::new());
        assert!(!new.exists());

        fs::create_dir_all(old.join("valley/.atlas")).unwrap();
        fs::write(old.join("valley/manifest.json"), b"{}").unwrap();
        fs::create_dir_all(old.join("ridge")).unwrap();
        fs::create_dir_all(new.join("ridge")).unwrap();
        fs::write(new.join("ridge/manifest.json"), b"{\"new\":true}").unwrap();
        assert_eq!(
            move_old_maps(&old, &new).unwrap(),
            vec!["valley".to_owned()]
        );
        assert_eq!(fs::read(new.join("valley/manifest.json")).unwrap(), b"{}");
        assert!(new.join("valley/.atlas").is_dir());
        // A name taken in the new folder stays in the old one, which is kept.
        assert!(old.join("ridge").is_dir());
        assert_eq!(
            fs::read(new.join("ridge/manifest.json")).unwrap(),
            b"{\"new\":true}"
        );

        fs::remove_dir(old.join("ridge")).unwrap();
        assert_eq!(move_old_maps(&old, &new).unwrap(), Vec::<String>::new());
        assert!(!old.exists(), "the empty old folder is removed");
        assert!(shared
            .parent()
            .unwrap()
            .join("no_backup/Maps/valley")
            .is_dir());
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
            photos: PhotoSize::Smaller,
            photos_with_map: false,
        };
        assert_eq!(slow.validate(), Ok(slow));
        let unlimited = DownloadSettings {
            pause_ms: 0,
            ..DownloadSettings::default()
        };
        assert!(unlimited.validate().is_err());
    }
}
