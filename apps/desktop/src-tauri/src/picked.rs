//! Files picked with Android's system picker.
//!
//! On Android the picker hands over a `content://` address, not a path: the
//! file may be in the Download folder, on a memory card or in a cloud
//! drive, and is read through a file descriptor that may not be able to
//! seek. A map pack file is a ZIP archive, which the import reads by
//! seeking, so it is copied first, in order, into the app's cache, and the
//! import is given that copy (`commands::packfile_copy_picked`).
//!
//! The copy keeps the picked file's name (so the import dialog and the
//! imported game's record name the file the person chose), in a folder of
//! its own under `<app cache>/pack-files/`. It is written as `<name>.part`
//! and renamed when complete. Only one copy is kept: starting another, and
//! starting the app, removes any left from before. The web app discards
//! the copy when the import has finished, or when the import dialog
//! closes, whether the import failed, was cancelled or never started.
//!
//! Nothing here is Android-specific, so the tests run on any computer.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::packfile::{import::SPACE_MARGIN, space, Header, Stop, EXTENSION};

/// The folder in the app's cache that holds copies of picked files.
pub const COPIES_DIR: &str = "pack-files";
/// What a picked file is called when its name is not known or not usable.
const FALLBACK_NAME: &str = "map-pack";
/// Longest name kept, in characters, before `.atlaspack`.
const MAX_NAME_CHARS: usize = 100;
/// Bytes copied between progress reports and cancel checks.
const CHUNK: usize = 1 << 20;
/// The suffix of a copy that is not complete yet.
const PART_SUFFIX: &str = ".part";

/// The name to give the copy of a picked map pack file: the picked file's
/// own name, kept to characters every file system takes, ending in
/// `.atlaspack` (the import opens only such files).
pub fn copy_name(picked: Option<&str>) -> String {
    let picked = picked.unwrap_or_default();
    let stem = match picked.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case(EXTENSION) => stem,
        _ => picked,
    };
    let cleaned: String = stem
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ' | '(' | ')'))
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let stem = if cleaned.is_empty() {
        FALLBACK_NAME
    } else {
        cleaned
    };
    format!("{stem}.{EXTENSION}")
}

/// The room importing a picked file takes on the device: the copy (its
/// size, or the unpacked size when the picker does not say) and the
/// unpacked game, with the margin the import keeps free.
pub fn room_needed(file_size: Option<u64>, header: &Header) -> u64 {
    file_size
        .unwrap_or(header.bytes)
        .saturating_add(header.bytes)
        .saturating_add(SPACE_MARGIN)
}

/// Refuses a picked file that cannot be copied and unpacked in the room
/// left (`available`, none when the system cannot tell), before anything
/// is written.
pub fn check_room(
    file_size: Option<u64>,
    header: &Header,
    available: Option<u64>,
) -> Result<(), String> {
    let needed = room_needed(file_size, header);
    match available {
        Some(free) if free < needed => Err(format!(
            "There is not enough free space on this device to import {}: it needs about {} (a copy of the file while it is imported, and the game unpacked), and {} is free. Free some space and try again.",
            header.title,
            space::describe(needed),
            space::describe(free)
        )),
        _ => Ok(()),
    }
}

/// Copies a picked file, read in order from `source`, into a folder of its
/// own under `copies` and returns the copy's path. Copies left from before
/// are removed first. `progress` is told the bytes copied so far;
/// `cancelled` is asked between chunks. A failure or cancel removes what
/// was written.
pub fn copy_in(
    source: &mut dyn Read,
    copies: &Path,
    name: &str,
    progress: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, Stop> {
    clear(copies);
    let dir = copies.join(unique_folder_name());
    fs::create_dir_all(&dir).map_err(|error| {
        Stop::Failed(format!(
            "Could not make room for a copy of the file: {error}"
        ))
    })?;
    let result = write_copy(source, &dir, name, progress, cancelled);
    if result.is_err() {
        let _ = fs::remove_dir_all(&dir);
    }
    result
}

fn write_copy(
    source: &mut dyn Read,
    dir: &Path,
    name: &str,
    progress: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, Stop> {
    let copy = dir.join(name);
    let part = dir.join(format!("{name}{PART_SUFFIX}"));
    let failed = |error: io::Error| {
        Stop::Failed(format!(
            "Could not copy the file into the app: {error}. Nothing was imported."
        ))
    };
    let mut file = fs::File::create(&part).map_err(failed)?;
    let mut buffer = vec![0; CHUNK];
    let mut done: u64 = 0;
    loop {
        if cancelled() {
            return Err(Stop::Cancelled);
        }
        let read = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(Stop::Failed(format!(
                    "Could not read the file you chose: {error}. Nothing was imported."
                )))
            }
        };
        file.write_all(&buffer[..read]).map_err(failed)?;
        done += read as u64;
        progress(done);
    }
    file.flush().map_err(failed)?;
    drop(file);
    fs::rename(&part, &copy).map_err(failed)?;
    Ok(copy)
}

/// A folder name no earlier copy used: the time in nanoseconds.
fn unique_folder_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    format!("{nanos}")
}

/// Removes every copy, for example those left when the app was closed
/// during an import.
pub fn clear(copies: &Path) {
    if fs::symlink_metadata(copies).is_ok() {
        let _ = fs::remove_dir_all(copies);
    }
}

/// The folder of a copy made by [`copy_in`], when `path` is one: exactly
/// `<copies>/<folder>/<file>`, with no `..` or link on the way.
pub fn copy_folder(copies: &Path, path: &Path) -> Option<PathBuf> {
    let rest = path.strip_prefix(copies).ok()?;
    let parts: Vec<Component<'_>> = rest.components().collect();
    let [Component::Normal(folder), Component::Normal(_)] = parts.as_slice() else {
        return None;
    };
    let folder = copies.join(folder);
    crate::removal::is_real_dir(&folder).then_some(folder)
}

/// Deletes the copy at `path`, with its folder. Anything that is not a
/// copy made by [`copy_in`] is left alone; true when a copy was deleted.
pub fn discard(copies: &Path, path: &Path) -> Result<bool, String> {
    let Some(folder) = copy_folder(copies, path) else {
        return Ok(false);
    };
    fs::remove_dir_all(&folder)
        .map(|()| true)
        .map_err(|error| format!("Could not delete the copy of the map pack file: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, io::Cursor};

    use super::*;
    use crate::tiles::store::tests::TempDir;

    #[test]
    fn names_copies_after_the_picked_file() {
        assert_eq!(
            copy_name(Some("isles-standard.atlaspack")),
            "isles-standard.atlaspack"
        );
        assert_eq!(
            copy_name(Some("Demo Isles (1).ATLASPACK")),
            "Demo Isles (1).atlaspack"
        );
        // A file the picker names without the extension still gets it.
        assert_eq!(copy_name(Some("download")), "download.atlaspack");
        assert_eq!(copy_name(Some("game.zip")), "game.zip.atlaspack");
        // No way out of the folder, and no hidden file.
        assert_eq!(copy_name(Some("../../etc/passwd")), "etcpasswd.atlaspack");
        assert_eq!(copy_name(Some("..atlaspack")), "map-pack.atlaspack");
        assert_eq!(copy_name(Some(".hidden.atlaspack")), "hidden.atlaspack");
        assert_eq!(copy_name(Some("a/b\\c:d*?.atlaspack")), "abcd.atlaspack");
        assert_eq!(copy_name(None), "map-pack.atlaspack");
        assert_eq!(copy_name(Some("   ")), "map-pack.atlaspack");
        let long = "x".repeat(300);
        assert_eq!(
            copy_name(Some(&long)).len(),
            MAX_NAME_CHARS + ".atlaspack".len()
        );
    }

    fn header(title: &str, bytes: u64) -> Header {
        serde_json::from_value(serde_json::json!({
            "format": "atlas-pack-file",
            "version": 1,
            "packId": "test-valley",
            "title": title,
            "packVersion": "1.0.0",
            "detail": "standard",
            "exportedAt": "2026-11-11T09:30:00Z",
            "exportedBy": {"name": "Atlas", "version": "0.3.6", "platform": "windows"},
            "pack": {"id": "test-valley", "title": title, "packVersion": "1.0.0", "schemaVersion": 2, "attribution": []},
            "source": {"kind": "unknown"},
            "contents": {"maps": 1, "layers": 1, "locations": 1, "categories": 1, "regions": 0, "checklists": 0, "guides": 0},
            "images": {"detail": "standard", "files": 0, "bytes": 0, "layers": []},
            "files": 10,
            "bytes": bytes,
        }))
        .unwrap()
    }

    #[test]
    fn needs_room_for_the_copy_and_the_unpacked_game() {
        let game = header("Test Valley", 500_000_000);
        assert_eq!(
            room_needed(Some(480_000_000), &game),
            980_000_000 + SPACE_MARGIN
        );
        // When the picker does not say how large the file is, the unpacked
        // size stands in for it.
        assert_eq!(room_needed(None, &game), 1_000_000_000 + SPACE_MARGIN);
        assert!(check_room(Some(480_000_000), &game, Some(2_000_000_000)).is_ok());
        assert!(check_room(Some(480_000_000), &game, None).is_ok());
        let error = check_room(Some(480_000_000), &game, Some(900_000_000)).unwrap_err();
        assert!(error.contains("Test Valley"), "{error}");
        assert!(error.contains("about 1.0 GB"), "{error}");
        assert!(error.contains("900 MB is free"), "{error}");
    }

    #[test]
    fn copies_in_chunks_and_replaces_earlier_copies() {
        let dir = TempDir::new("picked-copy");
        let copies = dir.0.join(COPIES_DIR);
        // A copy left from before, for example when the app was closed.
        let old = copies.join("1").join("old.atlaspack");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::write(&old, b"old").unwrap();

        let bytes: Vec<u8> = (0..(CHUNK * 2 + 10)).map(|i| (i % 251) as u8).collect();
        let mut reports = Vec::new();
        let copy = copy_in(
            &mut Cursor::new(&bytes),
            &copies,
            "game.atlaspack",
            &mut |done| reports.push(done),
            &|| false,
        )
        .unwrap();
        assert_eq!(fs::read(&copy).unwrap(), bytes);
        assert_eq!(copy.file_name().unwrap(), "game.atlaspack");
        assert_eq!(reports.last().copied(), Some(bytes.len() as u64));
        assert!(reports.len() >= 3);
        assert!(!old.exists(), "the earlier copy is gone");
        let folders: Vec<_> = fs::read_dir(&copies).unwrap().flatten().collect();
        assert_eq!(folders.len(), 1);
        let files: Vec<_> = fs::read_dir(copy.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(files, vec![std::ffi::OsString::from("game.atlaspack")]);

        // Discarded, with its folder; the copies folder stays usable.
        assert_eq!(discard(&copies, &copy), Ok(true));
        assert!(!copy.parent().unwrap().exists());
        assert_eq!(discard(&copies, &copy), Ok(false));
    }

    /// A source that fails after some bytes, like a cloud file that stops.
    struct Broken(usize);

    impl Read for Broken {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.0 == 0 {
                return Err(io::Error::other("connection lost"));
            }
            let n = self.0.min(buffer.len());
            buffer[..n].fill(7);
            self.0 -= n;
            Ok(n)
        }
    }

    #[test]
    fn a_failed_or_cancelled_copy_leaves_nothing() {
        let dir = TempDir::new("picked-fail");
        let copies = dir.0.join(COPIES_DIR);
        let error = copy_in(
            &mut Broken(CHUNK + 5),
            &copies,
            "game.atlaspack",
            &mut |_| {},
            &|| false,
        )
        .unwrap_err();
        assert!(error.message().contains("connection lost"), "{error:?}");
        assert_eq!(fs::read_dir(&copies).unwrap().count(), 0);

        let chunks = Cell::new(0);
        let bytes = vec![1u8; CHUNK * 3];
        let error = copy_in(
            &mut Cursor::new(&bytes),
            &copies,
            "game.atlaspack",
            &mut |_| chunks.set(chunks.get() + 1),
            &|| chunks.get() >= 2,
        )
        .unwrap_err();
        assert_eq!(error, Stop::Cancelled);
        assert_eq!(chunks.get(), 2);
        assert_eq!(fs::read_dir(&copies).unwrap().count(), 0);
    }

    #[test]
    fn discards_only_copies() {
        let dir = TempDir::new("picked-discard");
        let copies = dir.0.join(COPIES_DIR);
        let copy = copy_in(
            &mut Cursor::new(b"pack"),
            &copies,
            "game.atlaspack",
            &mut |_| {},
            &|| false,
        )
        .unwrap();
        let elsewhere = dir.0.join("Download").join("game.atlaspack");
        fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
        fs::write(&elsewhere, b"pack").unwrap();
        let folder = copy.parent().unwrap();
        for path in [
            elsewhere.clone(),
            copies.clone(),
            folder.to_path_buf(),
            folder
                .join("..")
                .join("..")
                .join("Download")
                .join("game.atlaspack"),
            folder.join("inner").join("game.atlaspack"),
            dir.0
                .join("pack-files-other")
                .join("1")
                .join("game.atlaspack"),
        ] {
            assert_eq!(discard(&copies, &path), Ok(false), "{}", path.display());
        }
        assert!(elsewhere.exists() && copy.exists());
        assert_eq!(copy_folder(&copies, &copy).as_deref(), Some(folder));
        assert_eq!(discard(&copies, &copy), Ok(true));
        assert!(elsewhere.exists());

        // Starting again clears every copy, and a missing folder is fine.
        let again = copy_in(
            &mut Cursor::new(b"pack"),
            &copies,
            "game.atlaspack",
            &mut |_| {},
            &|| false,
        )
        .unwrap();
        clear(&copies);
        assert!(!again.exists() && !copies.exists());
        clear(&copies);
    }
}
