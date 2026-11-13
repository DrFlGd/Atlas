//! A person's own photos of a game: the screenshots they add to steps of
//! their own lists and to their own locations. Their records are kept in
//! the own lists and own locations files (see `ownlists`); their files are
//! kept here, in a folder of the game's own beside its pack folder in the
//! maps folder: `<maps folder>/<game id>.my-pictures/<file>`, where a file
//! is named after its picture's own id: `own.<letters and digits>.jpg`,
//! `.png` or `.webp`.
//!
//! The web app makes a photo at most 1280 pixels wide before it is written,
//! names its files and deletes those nothing names any more; the shell
//! checks that each name is an own photo's and its bytes are a picture of
//! that kind, writes each file whole (to a part file first, renamed over
//! it) and never reads or writes anything else.
//!
//! Like the own lists file, the folder is never inside a pack folder, so
//! nothing that replaces a pack touches it, and it goes along when the maps
//! folder changes (see [`carry_over`]). Not on Android, whose web app keeps
//! the photos in its own storage with the own lists.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use crate::{manifest::write_atomic, packs::is_valid_pack_id};

/// The end of the name of a game's own photos folder, after the game id.
pub const PICTURES_SUFFIX: &str = ".my-pictures";
/// The largest own photo kept (they are made smaller before).
pub const MAX_OWN_PICTURE_BYTES: usize = 8 << 20;
/// The most own photos a game may have: a list's and its locations' at most.
pub const MAX_OWN_PICTURES: usize = 4000;
/// The largest picture read to be made into a photo, before it is made smaller.
pub const MAX_PICKED_BYTES: u64 = 40 << 20;

static WRITING: Mutex<()> = Mutex::new(());

/// Whether a file name is an own photo's: `own.<1 to 40 lowercase letters
/// and digits>.<jpg|png|webp>`.
pub fn is_own_picture_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("own.") else {
        return false;
    };
    let Some((stem, extension)) = rest.rsplit_once('.') else {
        return false;
    };
    (1..=40).contains(&stem.len())
        && stem
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && matches!(extension, "jpg" | "png" | "webp")
}

/// Whether bytes are a picture of the kind a file name says.
pub fn bytes_match_name(name: &str, bytes: &[u8]) -> bool {
    let starts = |prefix: &[u8]| bytes.starts_with(prefix);
    match name.rsplit_once('.').map(|(_, ext)| ext) {
        Some("jpg") => starts(&[0xff, 0xd8, 0xff]),
        Some("png") => starts(&[0x89, b'P', b'N', b'G']),
        Some("webp") => bytes.len() >= 12 && starts(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// A game's own photos folder in a maps folder.
pub fn folder(maps_folder: &Path, game_id: &str) -> Result<PathBuf, String> {
    if !is_valid_pack_id(game_id) {
        return Err("That is not a game id Atlas can use.".to_owned());
    }
    Ok(maps_folder.join(format!("{game_id}{PICTURES_SUFFIX}")))
}

fn file_path(maps_folder: &Path, game_id: &str, file: &str) -> Result<PathBuf, String> {
    if !is_own_picture_name(file) {
        return Err("That is not the name of one of your photos.".to_owned());
    }
    Ok(folder(maps_folder, game_id)?.join(file))
}

/// A photo's bytes, or `None` when it is not there.
pub fn read(maps_folder: &Path, game_id: &str, file: &str) -> Result<Option<Vec<u8>>, String> {
    let path = file_path(maps_folder, game_id, file)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read your photo: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_OWN_PICTURE_BYTES as u64 {
        return Ok(None);
    }
    fs::read(&path)
        .map(Some)
        .map_err(|error| format!("Could not read your photo: {error}"))
}

/// Writes a photo whole, after checking its name and bytes.
pub fn write(maps_folder: &Path, game_id: &str, file: &str, bytes: &[u8]) -> Result<(), String> {
    let path = file_path(maps_folder, game_id, file)?;
    if bytes.len() > MAX_OWN_PICTURE_BYTES {
        return Err("That photo is too large to keep.".to_owned());
    }
    if !bytes_match_name(file, bytes) {
        return Err("That photo is not a PNG, JPEG or WebP picture.".to_owned());
    }
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    let dir = folder(maps_folder, game_id)?;
    if !path.exists() && list(maps_folder, game_id).len() >= MAX_OWN_PICTURES {
        return Err("This game has as many photos of your own as it can keep.".to_owned());
    }
    fs::create_dir_all(&dir).map_err(|error| format!("Could not keep your photo: {error}"))?;
    write_atomic(&path, bytes).map_err(|error| format!("Could not keep your photo: {error}"))
}

/// The photos of a game, by file name.
pub fn list(maps_folder: &Path, game_id: &str) -> Vec<String> {
    let Ok(dir) = folder(maps_folder, game_id) else {
        return Vec::new();
    };
    names_in(&dir)
}

fn names_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_own_picture_name(name))
        .collect();
    names.sort();
    names
}

/// Deletes photos of a game; how many there were.
pub fn delete(maps_folder: &Path, game_id: &str, files: &[String]) -> Result<usize, String> {
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    let mut deleted = 0;
    for file in files {
        let path = file_path(maps_folder, game_id, file)?;
        match fs::remove_file(&path) {
            Ok(()) => deleted += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not delete your photo: {error}")),
        }
    }
    let dir = folder(maps_folder, game_id)?;
    // An empty folder goes too; one with anything else in it stays.
    let _ = fs::remove_dir(&dir);
    Ok(deleted)
}

/// Deletes every photo of a game, as its own lists and locations are
/// deleted. Whether there were any. Only the photos go: anything else in
/// the folder is left, and the folder with it.
pub fn delete_all(maps_folder: &Path, game_id: &str) -> Result<bool, String> {
    let files = list(maps_folder, game_id);
    let deleted = delete(maps_folder, game_id, &files)?;
    Ok(deleted > 0)
}

/// The own photo folders directly in a maps folder, by name.
fn folders_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.strip_suffix(PICTURES_SUFFIX)
                .is_some_and(is_valid_pack_id)
        })
        .collect();
    names.sort();
    names
}

/// When the maps folder changes: the own photo folders of the old folder go
/// to the new one, moved (`move_files`) or copied, as the own lists files
/// do (see `ownlists::carry_over`). A photo the new folder has already is
/// left as it is in both. The folders carried over.
pub fn carry_over(old: &Path, new: &Path, move_files: bool) -> Vec<String> {
    let mut carried = Vec::new();
    for name in folders_in(old) {
        let from = old.join(&name);
        let to = new.join(&name);
        if fs::symlink_metadata(&to).is_err() && move_files && fs::rename(&from, &to).is_ok() {
            carried.push(name);
            continue;
        }
        if fs::create_dir_all(&to).is_err() {
            continue;
        }
        let mut all = true;
        for file in names_in(&from) {
            let target = to.join(&file);
            if fs::symlink_metadata(&target).is_ok() {
                continue;
            }
            if fs::copy(from.join(&file), &target).is_err() {
                all = false;
            }
        }
        if move_files && all {
            for file in names_in(&from) {
                let _ = fs::remove_file(from.join(&file));
            }
            let _ = fs::remove_dir(&from);
        }
        carried.push(name);
    }
    carried
}

/// The own photo files the text of an own lists or own locations file names
/// (its `pictures`, and each list's), by file name.
pub fn named_in(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let pictures = |value: &serde_json::Value| -> Vec<String> {
        value
            .get("pictures")
            .and_then(serde_json::Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|picture| picture.get("file")?.as_str())
                    .filter_map(|file| file.strip_prefix("pictures/"))
                    .filter(|name| is_own_picture_name(name))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut names = pictures(&value);
    if let Some(lists) = value.get("lists").and_then(serde_json::Value::as_array) {
        for list in lists {
            names.extend(pictures(list));
        }
    }
    names.sort();
    names.dedup();
    names
}

// ---------------------------------------------------------------------------
// Base64, for photos handed between the shell and the web app as text

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Bytes as standard base64, with padding.
pub fn to_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let (chunks, rest) = bytes.as_chunks::<3>();
    for chunk in chunks {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        for shift in [18, 12, 6, 0] {
            out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
        }
    }
    match rest {
        [a] => {
            let n = u32::from(*a) << 16;
            out.push(char::from(ALPHABET[((n >> 18) & 63) as usize]));
            out.push(char::from(ALPHABET[((n >> 12) & 63) as usize]));
            out.push_str("==");
        }
        [a, b] => {
            let n = (u32::from(*a) << 16) | (u32::from(*b) << 8);
            out.push(char::from(ALPHABET[((n >> 18) & 63) as usize]));
            out.push(char::from(ALPHABET[((n >> 12) & 63) as usize]));
            out.push(char::from(ALPHABET[((n >> 6) & 63) as usize]));
            out.push('=');
        }
        _ => {}
    }
    out
}

/// The bytes of standard base64 with padding; `None` for anything else.
pub fn from_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if padding > 2 {
        return None;
    }
    let value =
        |b: u8| -> Option<u32> { ALPHABET.iter().position(|&c| c == b).map(|at| at as u32) };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let (quads, _) = bytes.as_chunks::<4>();
    let last = quads.len().saturating_sub(1);
    for (at, quad) in quads.iter().enumerate() {
        let mut n = 0u32;
        let mut real = 4;
        for (k, &b) in quad.iter().enumerate() {
            let v = if b == b'=' && at == last && k >= 4 - padding {
                real = real.min(k);
                0
            } else {
                value(b)?
            };
            n = (n << 6) | v;
        }
        let three = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&three[..real - 1]);
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Commands

use std::sync::Arc;

use tauri::{ipc::Response, Runtime, State, WebviewWindow};

use crate::{
    activity::{self, Area},
    commands::{blocking, desktop_only},
    library::Library,
};

type LibraryState<'a> = State<'a, Arc<Library>>;

/// A photo's bytes; empty when it is not there.
#[tauri::command]
pub async fn own_pictures_read(
    library: LibraryState<'_>,
    game_id: String,
    file: String,
) -> Result<Response, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || {
        Ok(Response::new(
            read(&maps, &game_id, &file)?.unwrap_or_default(),
        ))
    })
    .await
}

/// Keeps a photo the web app made (its bytes in base64).
#[tauri::command]
pub async fn own_pictures_write(
    library: LibraryState<'_>,
    game_id: String,
    file: String,
    data: String,
) -> Result<(), String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || {
        let bytes = from_base64(&data).ok_or_else(|| "That photo could not be read.".to_owned())?;
        write(&maps, &game_id, &file, &bytes)
    })
    .await
}

/// The photos of a game, by file name.
#[tauri::command]
pub async fn own_pictures_list(
    library: LibraryState<'_>,
    game_id: String,
) -> Result<Vec<String>, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || Ok(list(&maps, &game_id))).await
}

/// Deletes photos nothing names any more; how many there were.
#[tauri::command]
pub async fn own_pictures_delete(
    library: LibraryState<'_>,
    game_id: String,
    files: Vec<String>,
) -> Result<usize, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || delete(&maps, &game_id, &files)).await
}

/// Deletes every photo of a game, when the person asks for it as they
/// delete the game. Whether there were any.
#[tauri::command]
pub async fn own_pictures_delete_all(
    library: LibraryState<'_>,
    game_id: String,
) -> Result<bool, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || {
        let deleted = delete_all(&maps, &game_id)?;
        if deleted {
            activity::info(
                Area::Library,
                format!("Deleted the photos of {game_id}, as asked with the game"),
            );
        }
        Ok(deleted)
    })
    .await
}

/// Asks for a picture to add as a photo (PNG, JPEG or WebP) and reads it;
/// empty when the dialog is closed. The web app makes it smaller.
#[tauri::command]
pub async fn own_picture_pick<R: Runtime>(window: WebviewWindow<R>) -> Result<Response, String> {
    desktop_only()?;
    #[cfg(target_os = "android")]
    {
        let _ = window;
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let dialog = crate::commands::file_dialog(&window, "Choose a photo")
            .add_filter("Picture", &["png", "jpg", "jpeg", "webp"]);
        let Some(path) = crate::commands::chosen_path(|done| dialog.pick_file(done)).await? else {
            return Ok(Response::new(Vec::new()));
        };
        blocking(move || {
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Could not read the picture: {error}"))?;
            if !metadata.is_file() || metadata.len() > MAX_PICKED_BYTES {
                return Err("That picture is too large.".to_owned());
            }
            fs::read(&path)
                .map(Response::new)
                .map_err(|error| format!("Could not read the picture: {error}"))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 13, 10, 26, 10];

    #[test]
    fn knows_an_own_photos_name() {
        assert!(is_own_picture_name("own.ab12.jpg"));
        assert!(is_own_picture_name("own.x.webp"));
        assert!(!is_own_picture_name("own..jpg"));
        assert!(!is_own_picture_name("own.AB.jpg"));
        assert!(!is_own_picture_name("own.ab.gif"));
        assert!(!is_own_picture_name("gate.png"));
        assert!(!is_own_picture_name("own.a/b.png"));
        assert!(!is_own_picture_name("../own.ab.png"));
        assert!(!is_own_picture_name(&format!("own.{}.png", "a".repeat(41))));
        assert!(bytes_match_name("own.a.jpg", JPEG));
        assert!(!bytes_match_name("own.a.png", JPEG));
        assert!(bytes_match_name("own.a.webp", b"RIFF\0\0\0\0WEBPVP8 "));
    }

    #[test]
    fn writes_reads_lists_and_deletes_beside_the_pack_folder() {
        let maps = TempDir::new("own-pictures-1");
        let maps = maps.0.as_path();
        assert_eq!(read(maps, "demo", "own.a.jpg").unwrap(), None);
        write(maps, "demo", "own.a.jpg", JPEG).unwrap();
        write(maps, "demo", "own.b.png", PNG).unwrap();
        assert!(maps.join("demo.my-pictures/own.a.jpg").is_file());
        assert_eq!(
            read(maps, "demo", "own.a.jpg").unwrap().as_deref(),
            Some(JPEG)
        );
        assert_eq!(list(maps, "demo"), vec!["own.a.jpg", "own.b.png"]);
        assert_eq!(delete(maps, "demo", &["own.a.jpg".to_owned()]).unwrap(), 1);
        assert_eq!(list(maps, "demo"), vec!["own.b.png"]);
        assert!(delete_all(maps, "demo").unwrap());
        assert!(!delete_all(maps, "demo").unwrap());
        // The empty folder went with the last photo.
        assert!(!maps.join("demo.my-pictures").exists());
    }

    #[test]
    fn refuses_what_is_not_an_own_photo() {
        let maps = TempDir::new("own-pictures-2");
        let maps = maps.0.as_path();
        assert!(write(maps, "demo", "own.a.png", JPEG).is_err());
        assert!(write(maps, "demo", "../own.a.jpg", JPEG).is_err());
        assert!(write(maps, "demo", "gate.jpg", JPEG).is_err());
        assert!(write(maps, "../demo", "own.a.jpg", JPEG).is_err());
        assert!(read(maps, "demo", "../../etc").is_err());
        let large = [JPEG, &vec![0; MAX_OWN_PICTURE_BYTES]].concat();
        assert!(write(maps, "demo", "own.a.jpg", &large).is_err());
        assert!(list(maps, "demo").is_empty());
    }

    #[test]
    fn goes_along_when_the_maps_folder_changes() {
        let old = TempDir::new("own-pictures-3");
        let new = TempDir::new("own-pictures-4");
        write(old.0.as_path(), "demo", "own.a.jpg", JPEG).unwrap();
        write(old.0.as_path(), "other", "own.b.png", PNG).unwrap();
        write(new.0.as_path(), "other", "own.c.png", PNG).unwrap();
        let carried = carry_over(old.0.as_path(), new.0.as_path(), true);
        assert_eq!(carried, vec!["demo.my-pictures", "other.my-pictures"]);
        assert_eq!(list(new.0.as_path(), "demo"), vec!["own.a.jpg"]);
        assert_eq!(
            list(new.0.as_path(), "other"),
            vec!["own.b.png", "own.c.png"]
        );
        assert!(list(old.0.as_path(), "other").is_empty());
        // Copied, the old folder keeps its photos.
        let copy = TempDir::new("own-pictures-5");
        carry_over(new.0.as_path(), copy.0.as_path(), false);
        assert_eq!(list(new.0.as_path(), "demo"), vec!["own.a.jpg"]);
        assert_eq!(list(copy.0.as_path(), "demo"), vec!["own.a.jpg"]);
    }

    #[test]
    fn finds_the_photos_an_own_file_names() {
        let lists = r#"{"lists":[{"pictures":[{"file":"pictures/own.a.jpg"}]},{"pictures":[{"file":"pictures/../x"}]}]}"#;
        assert_eq!(named_in(lists), vec!["own.a.jpg"]);
        let locations = r#"{"pictures":[{"file":"pictures/own.b.png"},{"file":"own.c.png"}]}"#;
        assert_eq!(named_in(locations), vec!["own.b.png"]);
        assert!(named_in("not json").is_empty());
    }

    #[test]
    fn reads_and_writes_base64() {
        for length in [0usize, 1, 2, 3, 4, 5, 1000] {
            let bytes: Vec<u8> = (0..length).map(|i| (i * 37 % 256) as u8).collect();
            let text = to_base64(&bytes);
            assert_eq!(text.len(), length.div_ceil(3) * 4);
            assert_eq!(from_base64(&text), Some(bytes));
        }
        assert_eq!(to_base64(b"Man"), "TWFu");
        assert_eq!(to_base64(b"Ma"), "TWE=");
        assert_eq!(to_base64(b"M"), "TQ==");
        assert_eq!(from_base64("TWE="), Some(b"Ma".to_vec()));
        assert_eq!(from_base64("abc"), None);
        assert_eq!(from_base64("ab!d"), None);
        assert_eq!(from_base64("a==="), None);
        assert_eq!(from_base64("TQ==TQ=="), None);
    }
}
