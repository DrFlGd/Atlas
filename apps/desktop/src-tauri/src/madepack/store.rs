//! What this computer remembers of the pack files of maps made here, in the
//! app's own data folder (`made-packs.json`):
//!
//! - **Written.** Each pack file "Write the pack file" wrote here: the
//!   game's id, the file's `exportedAt` and where it was written. A file
//!   this computer wrote carries the person's own things that are on this
//!   computer already, so they are never offered from it here (see
//!   [`super::mine_offer`]); and a map made here that has no record of the
//!   file it was opened from is written again over the file it wrote last,
//!   when that file is still the one it wrote.
//! - **Offered.** For each version of a pack file (its game's id and its
//!   `exportedAt`) whose own things were offered: whether the person added
//!   them or said no, so they are not offered again.
//!
//! The file is read as untrusted: at most [`MAX_STORE_BYTES`], another
//! format or version counts as none, entries that cannot be used are
//! dropped, and only the newest [`MAX_ENTRIES`] of each list are kept. It is
//! written whole through a part file renamed over it.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{manifest::write_atomic, packfile::iso_millis, packs::is_valid_pack_id};

/// The store's file in the app's data folder.
pub const STORE_FILE: &str = "made-packs.json";
const FORMAT: &str = "atlas-made-packs";
const VERSION: u64 = 1;
/// A larger file is not read.
pub const MAX_STORE_BYTES: u64 = 1 << 20;
/// The most entries kept of each list.
pub const MAX_ENTRIES: usize = 1000;
/// The longest path kept.
const MAX_PATH_CHARS: usize = 4096;

/// A pack file this computer wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrittenFile {
    pub pack_id: String,
    pub exported_at: String,
    pub path: PathBuf,
}

/// What the person chose for the own things of one version of a pack file.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Choice {
    Added,
    Dismissed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offered {
    pub pack_id: String,
    pub exported_at: String,
    pub choice: Choice,
}

/// The whole store.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Remembered {
    pub written: Vec<WrittenFile>,
    pub offered: Vec<Offered>,
}

impl Remembered {
    /// Whether this computer wrote the file of this game made at `exported_at`.
    pub fn wrote(&self, pack_id: &str, exported_at: &str) -> bool {
        self.written
            .iter()
            .any(|file| file.pack_id == pack_id && file.exported_at == exported_at)
    }

    /// The file of a game this computer wrote last, if any.
    pub fn last_written(&self, pack_id: &str) -> Option<&WrittenFile> {
        self.written
            .iter()
            .rev()
            .find(|file| file.pack_id == pack_id)
    }

    /// What the person chose for one version's own things, if anything.
    pub fn choice(&self, pack_id: &str, exported_at: &str) -> Option<Choice> {
        self.offered
            .iter()
            .rev()
            .find(|offered| offered.pack_id == pack_id && offered.exported_at == exported_at)
            .map(|offered| offered.choice)
    }
}

/// The store, in the app's data folder.
pub struct Store {
    path: PathBuf,
    /// One change at a time.
    changing: Mutex<()>,
}

impl Store {
    pub fn new(app_data: &Path) -> Self {
        Self {
            path: app_data.join(STORE_FILE),
            changing: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// What is remembered; nothing when the file is missing or cannot be used.
    pub fn read(&self) -> Remembered {
        read_file(&self.path).unwrap_or_default()
    }

    /// Notes a pack file this computer wrote.
    pub fn note_written(&self, file: WrittenFile) -> Result<(), String> {
        self.change(|remembered| {
            remembered
                .written
                .retain(|known| !(known.pack_id == file.pack_id && known.path == file.path));
            remembered.written.push(file);
        })
    }

    /// Notes what the person chose for one version's own things.
    pub fn note_choice(
        &self,
        pack_id: &str,
        exported_at: &str,
        choice: Choice,
    ) -> Result<(), String> {
        self.change(|remembered| {
            remembered
                .offered
                .retain(|known| !(known.pack_id == pack_id && known.exported_at == exported_at));
            remembered.offered.push(Offered {
                pack_id: pack_id.to_owned(),
                exported_at: exported_at.to_owned(),
                choice,
            });
        })
    }

    fn change(&self, change: impl FnOnce(&mut Remembered)) -> Result<(), String> {
        let _changing = self.changing.lock().unwrap_or_else(PoisonError::into_inner);
        let mut remembered = self.read();
        change(&mut remembered);
        trim(&mut remembered.written);
        trim(&mut remembered.offered);
        let value = serde_json::json!({
            "format": FORMAT,
            "version": VERSION,
            "written": remembered.written.iter().map(|file| serde_json::json!({
                "packId": file.pack_id,
                "exportedAt": file.exported_at,
                "path": file.path.display().to_string(),
            })).collect::<Vec<_>>(),
            "offered": remembered.offered.iter().map(|offered| serde_json::json!({
                "packId": offered.pack_id,
                "exportedAt": offered.exported_at,
                "choice": offered.choice,
            })).collect::<Vec<_>>(),
        });
        let mut text = serde_json::to_vec_pretty(&value).expect("JSON serialises");
        text.push(b'\n');
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Could not write what this computer remembers: {error}")
            })?;
        }
        write_atomic(&self.path, &text)
            .map_err(|error| format!("Could not write what this computer remembers: {error}"))
    }
}

/// Keeps the newest [`MAX_ENTRIES`].
fn trim<T>(list: &mut Vec<T>) {
    if list.len() > MAX_ENTRIES {
        list.drain(..list.len() - MAX_ENTRIES);
    }
}

fn read_file(path: &Path) -> Option<Remembered> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_STORE_BYTES {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    if value.get("format").and_then(Value::as_str) != Some(FORMAT)
        || value.get("version").and_then(Value::as_u64) != Some(VERSION)
    {
        return None;
    }
    let list = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().take(MAX_ENTRIES * 2).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let text_of =
        |item: &Value, key: &str| item.get(key).and_then(Value::as_str).map(str::to_owned);
    let usable = |item: &Value| -> Option<(String, String)> {
        let pack_id = text_of(item, "packId").filter(|id| is_valid_pack_id(id))?;
        let exported_at = text_of(item, "exportedAt").filter(|at| iso_millis(at).is_some())?;
        Some((pack_id, exported_at))
    };
    let mut written: Vec<WrittenFile> = list("written")
        .into_iter()
        .filter_map(|item| {
            let (pack_id, exported_at) = usable(item)?;
            let path = text_of(item, "path")
                .filter(|path| path.chars().count() <= MAX_PATH_CHARS)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())?;
            Some(WrittenFile {
                pack_id,
                exported_at,
                path,
            })
        })
        .collect();
    let mut offered: Vec<Offered> = list("offered")
        .into_iter()
        .filter_map(|item| {
            let (pack_id, exported_at) = usable(item)?;
            let choice = serde_json::from_value(item.get("choice")?.clone()).ok()?;
            Some(Offered {
                pack_id,
                exported_at,
                choice,
            })
        })
        .collect();
    trim(&mut written);
    trim(&mut offered);
    Some(Remembered { written, offered })
}
