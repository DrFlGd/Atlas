//! The chosen folder: the pack files in it and its sub-folders, known by
//! the `packId` of their descriptions wherever they lie and whatever their
//! names; this app's own unfinished files; and the name a pack not written
//! before gets in `No game yet`.
//!
//! The folder is read as untrusted, and never changed here: only pack
//! files (`.atlaspack`) are read, and only their description (the first
//! entry, at most 4 MB, see the `atlas-pack` crate); a folder whose name
//! begins with a dot, a pack folder (one with a `manifest.json`) and a
//! link are not looked into; every other file is left alone. A look reads
//! at most [`MAX_ENTRIES`] files and folders, [`MAX_PACK_FILES`] pack
//! files and [`MAX_DEPTH`] folders down; a look that a limit or a folder
//! that could not be read cut short says so, and then no pack is written
//! as a new one (its file may lie in what was not read).

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use crate::{
    manifest::MANIFEST_FILE,
    packfile::{import::read_header, iso_millis, Header, EXTENSION},
};

/// The ending of this app's unfinished files: `<name>.atlas-importer.part`.
/// Only files with exactly this ending are ever cleared.
pub const PART_ENDING: &str = ".atlas-importer.part";
/// The sub-folder a pack not written before goes into.
pub const NEW_PACKS_FOLDER: &str = "No game yet";
/// The most files and folders one look reads.
pub const MAX_ENTRIES: usize = 200_000;
/// The most pack files one look takes.
pub const MAX_PACK_FILES: usize = 5000;
/// How deep a look goes.
pub const MAX_DEPTH: usize = 8;
/// A leftover unfinished file younger than this is left: another computer
/// may be writing it into a folder they share.
pub const LEFTOVER_AGE: Duration = Duration::from_secs(10 * 60);
/// The most characters of a new file's name before ` (2)` and the
/// extension, so that the name, its unfinished file's and the folder
/// around it stay within what Windows and the programs on it take.
pub const MAX_STEM_CHARS: usize = 100;

/// A pack file found in the folder.
#[derive(Clone, Debug)]
pub struct Copy {
    pub path: PathBuf,
    pub header: Header,
}

impl Copy {
    /// When its pack was changed last (`pack.updated`), in milliseconds.
    pub fn updated(&self) -> Option<i64> {
        self.header.pack.updated.as_deref().and_then(iso_millis)
    }

    /// When the file was made (`exportedAt`), in milliseconds.
    pub fn made(&self) -> Option<i64> {
        iso_millis(&self.header.exported_at)
    }
}

/// What a look into the folder found.
#[derive(Debug, Default)]
pub struct Found {
    /// The pack files, by pack id, the one changed last first (see
    /// [`changed_last_first`]).
    pub copies: BTreeMap<String, Vec<Copy>>,
    /// This app's unfinished files.
    pub parts: Vec<PathBuf>,
    /// Pack files that could not be read, with why (left alone).
    pub unreadable: Vec<(PathBuf, String)>,
    /// A limit or a folder that could not be read cut the look short.
    pub incomplete: bool,
}

/// A description read before: the file's length and time then, and what
/// was read.
type Known = (u64, Option<SystemTime>, Result<Header, String>);

/// The descriptions read before, by path, with the length and time of the
/// file then, so a look reads only the files that changed.
#[derive(Default)]
pub struct HeaderCache {
    known: HashMap<PathBuf, Known>,
}

impl HeaderCache {
    fn read(&mut self, path: &Path, metadata: &fs::Metadata) -> Result<Header, String> {
        let stamp = (metadata.len(), metadata.modified().ok());
        if let Some((len, time, header)) = self.known.get(path) {
            if (*len, *time) == stamp {
                return header.clone();
            }
        }
        let header = read_header(path);
        self.known
            .insert(path.to_path_buf(), (stamp.0, stamp.1, header.clone()));
        header
    }

    /// Forgets files not found by the last look.
    fn keep_only(&mut self, seen: &[PathBuf]) {
        let seen: std::collections::HashSet<&PathBuf> = seen.iter().collect();
        self.known.retain(|path, _| seen.contains(path));
    }
}

/// Whether a file name is a pack file's (in any case), and not an
/// unfinished file.
fn is_pack_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(&format!(".{EXTENSION}")) && !lower.ends_with(".part")
}

/// Looks through `folder` and its sub-folders.
pub fn look(folder: &Path, cache: &mut HeaderCache) -> Found {
    struct Walk<'a> {
        read: usize,
        found: Found,
        cache: &'a mut HeaderCache,
        seen: Vec<PathBuf>,
    }
    impl Walk<'_> {
        fn folder(&mut self, dir: &Path, depth: usize) {
            let Ok(entries) = fs::read_dir(dir) else {
                self.found.incomplete = true;
                return;
            };
            let mut listed = Vec::new();
            for entry in entries {
                let Ok(entry) = entry else {
                    self.found.incomplete = true;
                    continue;
                };
                self.read += 1;
                if self.read > MAX_ENTRIES {
                    self.found.incomplete = true;
                    return;
                }
                listed.push(entry);
            }
            listed.sort_by_key(fs::DirEntry::file_name);
            let mut folders = Vec::new();
            for entry in listed {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                // A link is not followed: its own type, not its target's.
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let path = entry.path();
                if kind.is_dir() {
                    if !path.join(MANIFEST_FILE).exists() {
                        folders.push(path);
                    }
                } else if kind.is_file() && name.ends_with(PART_ENDING) {
                    self.found.parts.push(path);
                } else if kind.is_file() && is_pack_name(&name) {
                    let count: usize = self.found.copies.values().map(Vec::len).sum();
                    if count >= MAX_PACK_FILES {
                        self.found.incomplete = true;
                        return;
                    }
                    let Ok(metadata) = entry.metadata() else {
                        continue;
                    };
                    self.seen.push(path.clone());
                    match self.cache.read(&path, &metadata) {
                        Ok(header) => self
                            .found
                            .copies
                            .entry(header.pack_id.clone())
                            .or_default()
                            .push(Copy { path, header }),
                        Err(reason) => self.found.unreadable.push((path, reason)),
                    }
                }
            }
            for folder in folders {
                if depth >= MAX_DEPTH {
                    self.found.incomplete = true;
                    return;
                }
                self.folder(&folder, depth + 1);
            }
        }
    }
    let mut walk = Walk {
        read: 0,
        found: Found::default(),
        cache,
        seen: Vec::new(),
    };
    walk.folder(folder, 0);
    let Walk {
        mut found, seen, ..
    } = walk;
    cache.keep_only(&seen);
    for copies in found.copies.values_mut() {
        copies.sort_by(changed_last_first);
    }
    found
}

/// The order of copies of one pack: the one whose pack was changed last
/// (`pack.updated`) first, then the one made last (`exportedAt`), then by
/// path. A missing time counts as older than any.
pub fn changed_last_first(a: &Copy, b: &Copy) -> std::cmp::Ordering {
    (b.updated(), b.made())
        .cmp(&(a.updated(), a.made()))
        .then_with(|| a.path.cmp(&b.path))
}

/// Clears this app's unfinished files found by a look that are older than
/// [`LEFTOVER_AGE`] (a younger one may be another computer's write in
/// progress). Only files whose name ends in exactly [`PART_ENDING`] are
/// touched. Returns those removed.
pub fn clear_leftovers(parts: &[PathBuf], now: SystemTime) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    for part in parts {
        let named = part
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(PART_ENDING));
        if !named {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(part) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let old = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= LEFTOVER_AGE);
        if old && fs::remove_file(part).is_ok() {
            removed.push(part.clone());
        }
    }
    removed
}

/// The unfinished file of `target`: `<target>.atlas-importer.part`.
pub fn part_of(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(PART_ENDING);
    PathBuf::from(name)
}

/// Names Windows keeps for devices, which no file may have, whatever its
/// extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A text made safe as (part of) a Windows file name: no character Windows
/// refuses (`<>:"/\|?*` and control characters), `:` and slashes made a
/// dash, spaces run together, no dot or space at the end.
fn safe_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            ':' => out.push_str(" - "),
            '/' | '\\' => out.push('-'),
            '<' | '>' | '"' | '|' | '?' | '*' => out.push(' '),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    joined
        .trim_end_matches(['.', ' '])
        .trim_start_matches(' ')
        .to_owned()
}

/// The stem of a new pack's file name, `<Game title> - <Source>`: the
/// game's title (`game.title`, else the pack's own title, else its id) and
/// the site's name (`source.name`, else the pack's own title when it
/// differs from the game's; nothing otherwise, and then the name is the
/// game's title alone). Made safe as a Windows file name, at most
/// [`MAX_STEM_CHARS`] characters, never a name Windows keeps for devices.
pub fn stem_from(game: Option<&str>, own_title: &str, source: Option<&str>, id: &str) -> String {
    let title_of = |text: &str| Some(safe_text(text)).filter(|text| !text.is_empty());
    let game = game
        .and_then(title_of)
        .or_else(|| title_of(own_title))
        .unwrap_or_else(|| id.to_owned());
    let source = source
        .and_then(title_of)
        .or_else(|| title_of(own_title).filter(|title| *title != game));
    let joined = match source {
        Some(source) if source != game => format!("{game} - {source}"),
        _ => game,
    };
    let mut stem: String = joined.chars().take(MAX_STEM_CHARS).collect();
    stem = stem.trim_end_matches(['.', ' ']).to_owned();
    if stem.is_empty() {
        id.clone_into(&mut stem);
    }
    let base = stem.split('.').next().unwrap_or_default().trim_end();
    if RESERVED.iter().any(|name| name.eq_ignore_ascii_case(base)) {
        stem.push('_');
    }
    stem
}

/// A free path for a new pack in `folder`: `<stem>.atlaspack`, else
/// `<stem> (2).atlaspack` and so on, never a name that is taken (in any
/// case, where the drive does not tell case apart) or whose unfinished file
/// is there. None after 100 names.
pub fn free_path(folder: &Path, stem: &str) -> Option<PathBuf> {
    let taken_names: Vec<String> = fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
                .collect()
        })
        .unwrap_or_default();
    (1..=100).find_map(|n| {
        let name = if n == 1 {
            format!("{stem}.{EXTENSION}")
        } else {
            format!("{stem} ({n}).{EXTENSION}")
        };
        let lower = name.to_lowercase();
        let part = format!("{lower}{PART_ENDING}");
        let path = folder.join(&name);
        let taken = taken_names
            .iter()
            .any(|taken| *taken == lower || *taken == part)
            || fs::symlink_metadata(&path).is_ok();
        (!taken).then_some(path)
    })
}
