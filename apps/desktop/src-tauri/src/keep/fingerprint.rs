//! What tells a game folder that changed from one that did not, cheaply.
//!
//! Finishing a download of map images changes neither the manifest's
//! `updated` nor, while a level is not complete, any status file: what
//! changes on disk is the image files themselves (written through a
//! `.part` file and a rename), and, as levels complete, the layers' status
//! files (`offline-tiles/`) and the manifest's image summary. Reading a
//! site's pages again rewrites the pack's JSON files (and the page data
//! under `import/`, which is never in a pack file); a download of photos
//! adds files to `pictures/` and rewrites `pictures.json`; the title the
//! game is shown under with other games lives in the maps folder's
//! `game-groups.json`.
//!
//! So the fingerprint is taken from the folder's listings alone, never by
//! opening an image: every file of the pack folder (not in `.atlas/`,
//! `import/` or another folder whose name begins with a dot, not a `.part`
//! file, never through a link) counts with its path, length and modified
//! time, folded into one 64-bit FNV-1a hash that does not depend on the
//! order the system lists files in; the text of the game's title, when it
//! is grouped, is folded in too. With it come the number and bytes of the
//! map images (image files outside `pictures/`), and the newest modified
//! time, which says when this computer's copy last changed. On Windows a
//! folder's listing carries each file's length and time, so this asks the
//! drive for nothing more; elsewhere it asks for each file's metadata.
//!
//! For a map made in the app, whose pack carries the person's own things
//! (`mine/`), their files beside the folder in the maps folder count too:
//! each of `<id>.my-lists.json`, `<id>.my-locations.json`,
//! `<id>.guide-links.json`, `<id>.my-pages.json` and `<id>.my-notes.json`
//! that is a file, and every file in `<id>.my-pictures/`, with its name,
//! length and modified time.
//!
//! An unchanged game gives the same fingerprint every time; any file added,
//! removed, rewritten or renamed in it gives another one.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    gamegroups,
    packfile::MINE_ENTRIES,
    packs::{is_valid_pack_id, IMPORT_DIR},
};

/// The most files and folders one fingerprint lists.
pub const MAX_ENTRIES: u64 = 4_000_000;
/// How deep it looks.
const MAX_DEPTH: usize = 16;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// The fingerprint of a game folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    /// The hash, as 16 hexadecimal digits.
    pub hash: String,
    /// The map images in it, and their bytes.
    pub images: u64,
    pub image_bytes: u64,
    /// The newest modified time of its files, in milliseconds since 1970.
    pub changed_at: i64,
    /// Every file was listed; otherwise a limit stopped it, and the game
    /// is not written (its fingerprint would not tell a change).
    pub complete: bool,
}

fn fnv(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Whether a file is a map image: one of the image types maps use.
fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |since| {
        i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
    })
}

/// The person's own files of a game whose pack carries them: the maps
/// folder they lie in, and the game's id.
#[derive(Clone, Copy, Debug)]
pub struct Own<'a> {
    pub maps_folder: &'a Path,
    pub game_id: &'a str,
}

/// Takes the fingerprint of the game folder `root`, with `extra` (the
/// title it is shown under with other games, when grouped) and, with
/// `own`, the person's own files of it folded in.
pub fn take(root: &Path, extra: Option<&str>, own: Option<Own<'_>>) -> Fingerprint {
    struct Walk {
        sum: u64,
        mixed: u64,
        files: u64,
        entries: u64,
        images: u64,
        image_bytes: u64,
        changed_at: i64,
        complete: bool,
    }
    impl Walk {
        /// Counts one file, by its path in the fingerprint.
        fn file(&mut self, path: &str, metadata: &fs::Metadata) {
            let modified = metadata.modified().map_or(0, millis);
            let mut hash = fnv(FNV_OFFSET, path.as_bytes());
            hash = fnv(hash, &metadata.len().to_le_bytes());
            hash = fnv(hash, &modified.to_le_bytes());
            // Order does not matter: a sum and a mix of each file's hash.
            self.sum = self.sum.wrapping_add(hash);
            self.mixed ^= hash.rotate_left(17).wrapping_mul(FNV_PRIME);
            self.files += 1;
            self.changed_at = self.changed_at.max(modified);
        }

        /// The person's own files beside the folder (see the module).
        fn own(&mut self, own: Own<'_>) {
            if !is_valid_pack_id(own.game_id) {
                self.complete = false;
                return;
            }
            for (entry, kind) in MINE_ENTRIES {
                // The title it is shown under is `extra`, not a file of its own.
                if kind.suffix == gamegroups::CARRIED.suffix {
                    continue;
                }
                let path = own
                    .maps_folder
                    .join(format!("{}{}", own.game_id, kind.suffix));
                // Never through a link.
                if let Ok(metadata) = fs::symlink_metadata(&path) {
                    if metadata.is_file() {
                        self.file(entry, &metadata);
                    }
                }
            }
            let pictures = own.maps_folder.join(format!(
                "{}{}",
                own.game_id,
                crate::ownpictures::PICTURES_SUFFIX
            ));
            let is_folder = fs::symlink_metadata(&pictures).is_ok_and(|metadata| metadata.is_dir());
            if !is_folder {
                return;
            }
            let Ok(entries) = fs::read_dir(&pictures) else {
                self.complete = false;
                return;
            };
            for entry in entries.flatten() {
                self.entries += 1;
                if self.entries > MAX_ENTRIES {
                    self.complete = false;
                    return;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name.ends_with(".part") {
                    continue;
                }
                if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    self.complete = false;
                    continue;
                };
                self.file(&format!("mine/pictures/{name}"), &metadata);
            }
        }

        fn folder(&mut self, dir: &Path, relative: &str, depth: usize) {
            let Ok(entries) = fs::read_dir(dir) else {
                // A folder that cannot be listed is not known to be unchanged.
                self.complete = false;
                return;
            };
            for entry in entries.flatten() {
                self.entries += 1;
                if self.entries > MAX_ENTRIES {
                    self.complete = false;
                    return;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name.ends_with(".part") {
                    continue;
                }
                if relative.is_empty() && name.eq_ignore_ascii_case(IMPORT_DIR) {
                    continue;
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let path = if relative.is_empty() {
                    name.clone()
                } else {
                    format!("{relative}/{name}")
                };
                if kind.is_dir() {
                    if depth >= MAX_DEPTH {
                        self.complete = false;
                        continue;
                    }
                    self.folder(&entry.path(), &path, depth + 1);
                } else if kind.is_file() {
                    let Ok(metadata) = entry.metadata() else {
                        self.complete = false;
                        continue;
                    };
                    self.file(&path, &metadata);
                    if !path.starts_with("pictures/") && is_image(&name) {
                        self.images += 1;
                        self.image_bytes += metadata.len();
                    }
                }
            }
        }
    }
    let mut walk = Walk {
        sum: 0,
        mixed: 0,
        files: 0,
        entries: 0,
        images: 0,
        image_bytes: 0,
        changed_at: 0,
        complete: true,
    };
    walk.folder(root, "", 0);
    if let Some(own) = own {
        walk.own(own);
    }
    let mut hash = fnv(FNV_OFFSET, &walk.sum.to_le_bytes());
    hash = fnv(hash, &walk.mixed.to_le_bytes());
    hash = fnv(hash, &walk.files.to_le_bytes());
    hash = fnv(hash, extra.unwrap_or_default().as_bytes());
    Fingerprint {
        hash: format!("{hash:016x}"),
        images: walk.images,
        image_bytes: walk.image_bytes,
        changed_at: walk.changed_at,
        complete: walk.complete,
    }
}
