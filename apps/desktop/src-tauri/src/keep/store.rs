//! The setting and the record of packs kept up to date, each a small JSON
//! file in this app's own data folder on this computer (never in the shared
//! settings file, which other apps rewrite, and never in the chosen
//! folder, which other computers share):
//!
//! - `kept-packs.json`, the setting: whether it is on, the folder (none for
//!   the default, the packs folder) and how often it is checked.
//! - `kept-packs-record.json`, the record: for which folder it is, when it
//!   was last checked, and for each pack this app wrote (or found in the
//!   folder in step with its own copy) where it lies, when it was written,
//!   the description's times and the fingerprint of the game it was
//!   written from.
//!
//! Both are read as untrusted: at most a few megabytes, every field
//! checked, entries that cannot be used dropped. A file that is missing
//! counts as none; one that cannot be read counts as none too, and the
//! activity log says so. Both are written through a `.part` file and a
//! rename.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    activity::{self, Area},
    manifest::write_atomic,
    packfile::iso_millis,
    packs::is_valid_pack_id,
};

pub const SETTING_FILE: &str = "kept-packs.json";
pub const RECORD_FILE: &str = "kept-packs-record.json";
const SETTING_FORMAT: &str = "atlas-kept-packs";
const RECORD_FORMAT: &str = "atlas-kept-packs-record";
const VERSION: u64 = 1;
/// A setting file larger than this is not one.
const MAX_SETTING_BYTES: u64 = 64 << 10;
/// A record file larger than this is not one.
const MAX_RECORD_BYTES: u64 = 8 << 20;
/// The most packs the record keeps; more are dropped.
pub const MAX_RECORD_PACKS: usize = 5000;
/// The longest path the setting and the record keep.
const MAX_PATH_CHARS: usize = 4096;

/// How often the folder is checked, besides after each change.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Schedule {
    /// At each start of the app.
    #[default]
    Start,
    /// At each start, and once a day while it runs.
    Daily,
    /// At each start, and once a week while it runs.
    Weekly,
}

impl Schedule {
    /// How long after the last check the next one is due while the app
    /// runs; none for a check at each start only.
    pub fn period(self) -> Option<std::time::Duration> {
        match self {
            Schedule::Start => None,
            Schedule::Daily => Some(std::time::Duration::from_secs(24 * 3600)),
            Schedule::Weekly => Some(std::time::Duration::from_secs(7 * 24 * 3600)),
        }
    }
}

/// The setting.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Setting {
    pub on: bool,
    /// The folder chosen; none for the default (the packs folder).
    pub folder: Option<PathBuf>,
    pub schedule: Schedule,
}

/// One pack in the record.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    /// Where the pack file lies, as last written or found.
    pub path: PathBuf,
    /// When this app wrote it; none for a pack found in the folder in step
    /// with this computer's copy, written by another computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_at: Option<String>,
    /// The description's `exportedAt` of the file in the folder then.
    pub exported_at: String,
    /// The description's `pack.updated` then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_updated: Option<String>,
    /// The fingerprint of the game on this computer then (see
    /// `fingerprint.rs`).
    pub fingerprint: String,
    /// Its map images then, and the file's size.
    #[serde(default)]
    pub images: u64,
    #[serde(default)]
    pub size: u64,
}

/// The record.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Record {
    /// The folder the record is for. A record of another folder is not
    /// used: packs written there are not in the new one.
    pub folder: Option<PathBuf>,
    /// When the folder was last checked (ISO 8601).
    pub last_check_at: Option<String>,
    pub packs: BTreeMap<String, Written>,
}

/// Where the two files are: this app's data folder.
#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(app_data: &Path) -> Self {
        Self {
            dir: app_data.to_path_buf(),
        }
    }

    pub fn setting_path(&self) -> PathBuf {
        self.dir.join(SETTING_FILE)
    }

    pub fn record_path(&self) -> PathBuf {
        self.dir.join(RECORD_FILE)
    }

    /// The setting; off when there is none or it cannot be read.
    pub fn read_setting(&self) -> Setting {
        match read_capped(&self.setting_path(), MAX_SETTING_BYTES) {
            Ok(None) => Setting::default(),
            Ok(Some(value)) => setting_of(&value).unwrap_or_else(|| {
                activity::warn(
                    Area::Library,
                    "Keeping packs up to date: the setting could not be read, so it is off until it is chosen again",
                );
                Setting::default()
            }),
            Err(reason) => {
                activity::warn(
                    Area::Library,
                    format!("Keeping packs up to date: the setting could not be read ({reason}), so it is off until it is chosen again"),
                );
                Setting::default()
            }
        }
    }

    pub fn write_setting(&self, setting: &Setting) -> Result<(), String> {
        let value = serde_json::json!({
            "format": SETTING_FORMAT,
            "version": VERSION,
            "on": setting.on,
            "folder": setting.folder.as_ref().map(|folder| folder.display().to_string()),
            "schedule": setting.schedule,
        });
        self.write(&self.setting_path(), &value)
    }

    /// The record; empty when there is none, and empty with a line in the
    /// activity log when it cannot be read.
    pub fn read_record(&self) -> Record {
        let path = self.record_path();
        match read_capped(&path, MAX_RECORD_BYTES) {
            Ok(None) => Record::default(),
            Ok(Some(value)) => record_of(&value).unwrap_or_else(|| {
                activity::warn(
                    Area::Library,
                    format!(
                        "Keeping packs up to date: the record in {} is damaged, so it starts empty",
                        path.display()
                    ),
                );
                Record::default()
            }),
            Err(reason) => {
                activity::warn(
                    Area::Library,
                    format!("Keeping packs up to date: the record in {} could not be read ({reason}), so it starts empty", path.display()),
                );
                Record::default()
            }
        }
    }

    pub fn write_record(&self, record: &Record) -> Result<(), String> {
        let packs: serde_json::Map<String, Value> = record
            .packs
            .iter()
            .take(MAX_RECORD_PACKS)
            .map(|(id, written)| {
                (
                    id.clone(),
                    serde_json::to_value(written).unwrap_or(Value::Null),
                )
            })
            .collect();
        let value = serde_json::json!({
            "format": RECORD_FORMAT,
            "version": VERSION,
            "folder": record.folder.as_ref().map(|folder| folder.display().to_string()),
            "lastCheckAt": record.last_check_at,
            "packs": packs,
        });
        self.write(&self.record_path(), &value)
    }

    fn write(&self, path: &Path, value: &Value) -> Result<(), String> {
        fs::create_dir_all(&self.dir)
            .map_err(|error| format!("Could not create {}: {error}", self.dir.display()))?;
        let mut bytes = serde_json::to_vec_pretty(value).expect("JSON serialises");
        bytes.push(b'\n');
        write_atomic(path, &bytes)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))
    }
}

/// A JSON file of at most `cap` bytes; none when it is not there.
fn read_capped(path: &Path, cap: u64) -> Result<Option<Value>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Err("it is not a file".to_owned());
    }
    if metadata.len() > cap {
        return Err("it is too large".to_owned());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map(Some)
        .map_err(|_| "it is not JSON".to_owned())
}

fn path_of(value: Option<&Value>) -> Option<PathBuf> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.chars().count() <= MAX_PATH_CHARS)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn setting_of(value: &Value) -> Option<Setting> {
    if value.get("format")?.as_str()? != SETTING_FORMAT
        || value.get("version")?.as_u64()? != VERSION
    {
        return None;
    }
    Some(Setting {
        on: value.get("on").and_then(Value::as_bool).unwrap_or(false),
        folder: path_of(value.get("folder")),
        schedule: value
            .get("schedule")
            .cloned()
            .and_then(|schedule| serde_json::from_value(schedule).ok())
            .unwrap_or_default(),
    })
}

/// A time the record keeps: ISO 8601 that can be read.
fn time_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| text.len() <= 64 && iso_millis(text).is_some())
        .map(str::to_owned)
}

fn record_of(value: &Value) -> Option<Record> {
    if value.get("format")?.as_str()? != RECORD_FORMAT || value.get("version")?.as_u64()? != VERSION
    {
        return None;
    }
    let mut packs = BTreeMap::new();
    if let Some(listed) = value.get("packs").and_then(Value::as_object) {
        for (id, entry) in listed {
            if packs.len() >= MAX_RECORD_PACKS {
                break;
            }
            if !is_valid_pack_id(id) {
                continue;
            }
            let Some(path) = path_of(entry.get("path")) else {
                continue;
            };
            let Some(exported_at) = time_of(entry.get("exportedAt")) else {
                continue;
            };
            let Some(fingerprint) = entry
                .get("fingerprint")
                .and_then(Value::as_str)
                .filter(|text| text.len() <= 64)
            else {
                continue;
            };
            packs.insert(
                id.clone(),
                Written {
                    path,
                    written_at: time_of(entry.get("writtenAt")),
                    exported_at,
                    pack_updated: time_of(entry.get("packUpdated")),
                    fingerprint: fingerprint.to_owned(),
                    images: entry.get("images").and_then(Value::as_u64).unwrap_or(0),
                    size: entry.get("size").and_then(Value::as_u64).unwrap_or(0),
                },
            );
        }
    }
    Some(Record {
        folder: path_of(value.get("folder")),
        last_check_at: time_of(value.get("lastCheckAt")),
        packs,
    })
}
