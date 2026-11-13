//! A person's own lists and guides of a game, in a file of their own in the
//! maps folder, beside the game's pack folder: `<maps folder>/<game
//! id>.my-lists.json`. The web app reads and writes it (see `ownLists.ts`
//! in the schema package for what it holds); the shell only checks that it
//! is the own lists file of that game and keeps it safe.
//!
//! It is never inside a pack folder, so nothing that replaces a pack's
//! files touches it: refreshing a pack from its site, a newer pack that
//! comes with the app, importing a `.atlaspack` file over the game, or
//! deleting the game (which removes the pack folder only, unless the person
//! asks to delete their lists too). Moving the maps folder takes the files
//! along (see [`carry_over`]).
//!
//! It is written whole, to a hidden part file first that is then renamed
//! over it, so a crash leaves the old file or the new one, never half of
//! one. When the web app asks, the file as it was is kept beside it first
//! (`<game id>.my-lists.<time>.json`), for when it held something the app
//! could not read.
//!
//! Not on Android, whose maps folder is never backed up: the Android app
//! keeps own lists in its web view's storage with the found marks (see
//! `DesktopInfo::own_list_files`).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use crate::{manifest::write_atomic, packs::is_valid_pack_id};

/// The end of an own lists file's name, after the game id.
pub const OWN_LISTS_SUFFIX: &str = ".my-lists.json";
/// What the file says it is (`format`).
const FORMAT: &str = "atlas-own-lists";
/// An own lists file larger than this is refused, read or written.
pub const MAX_OWN_LISTS_BYTES: usize = 16 << 20;

static WRITING: Mutex<()> = Mutex::new(());

/// The own lists file of a game in a maps folder.
pub fn own_lists_path(maps_folder: &Path, game_id: &str) -> Result<PathBuf, String> {
    if !is_valid_pack_id(game_id) {
        return Err("That is not a game id Atlas can use.".to_owned());
    }
    Ok(maps_folder.join(format!("{game_id}{OWN_LISTS_SUFFIX}")))
}

/// The text of a game's own lists file, or `None` when it has none.
pub fn read(maps_folder: &Path, game_id: &str) -> Result<Option<String>, String> {
    let path = own_lists_path(maps_folder, game_id)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read your lists: {error}")),
    };
    if !metadata.is_file() {
        return Err(format!(
            "{} is not a file, so your lists cannot be read.",
            path.display()
        ));
    }
    if metadata.len() > MAX_OWN_LISTS_BYTES as u64 {
        return Err("Your lists file is too large to read.".to_owned());
    }
    let bytes = fs::read(&path).map_err(|error| format!("Could not read your lists: {error}"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Your lists file is not text, so it cannot be read.".to_owned())
}

/// Checks that a text is an own lists file of this game: JSON, not too
/// large, with the right `format` and `gameId`. The web app checks the
/// rest with the schema before it writes.
fn check(game_id: &str, contents: &str) -> Result<(), String> {
    if contents.len() > MAX_OWN_LISTS_BYTES {
        return Err("Your lists are too large to save.".to_owned());
    }
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|_| "Your lists could not be saved: they are not JSON.".to_owned())?;
    let format = value.get("format").and_then(serde_json::Value::as_str);
    let game = value.get("gameId").and_then(serde_json::Value::as_str);
    if format != Some(FORMAT) || game != Some(game_id) {
        return Err("Your lists could not be saved: they are not this game's lists.".to_owned());
    }
    Ok(())
}

/// Writes a game's own lists file whole (see the module). With `keep_copy`,
/// the file there now is kept beside it first, named with `stamp`.
/// Returns the name of the copy kept, if one was.
pub fn write(
    maps_folder: &Path,
    game_id: &str,
    contents: &str,
    keep_copy: Option<&str>,
) -> Result<Option<String>, String> {
    check(game_id, contents)?;
    let path = own_lists_path(maps_folder, game_id)?;
    // One write at a time, so a later save never lands before an earlier one.
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    fs::create_dir_all(maps_folder)
        .map_err(|error| format!("Could not create the maps folder: {error}"))?;
    let mut kept = None;
    if let Some(stamp) = keep_copy {
        if path.is_file() {
            let safe: String = stamp
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .take(40)
                .collect();
            let name = format!("{game_id}.my-lists.{safe}.json");
            fs::copy(&path, maps_folder.join(&name))
                .map_err(|error| format!("Could not keep a copy of your lists: {error}"))?;
            kept = Some(name);
        }
    }
    write_atomic(&path, contents.as_bytes())
        .map_err(|error| format!("Could not save your lists: {error}"))?;
    Ok(kept)
}

/// Deletes a game's own lists file, when the person asks for it with the
/// game. Whether there was one.
pub fn delete(maps_folder: &Path, game_id: &str) -> Result<bool, String> {
    let path = own_lists_path(maps_folder, game_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not delete your lists: {error}")),
    }
}

/// The own lists files directly in a folder, by name.
fn own_list_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.strip_suffix(OWN_LISTS_SUFFIX)
                .is_some_and(is_valid_pack_id)
        })
        .collect();
    names.sort();
    names
}

/// When the maps folder changes: the own lists files of the old folder go
/// to the new one, moved (`move_files`, with the pack folders) or copied
/// (the old folder stays listed with its packs, and keeps its copies). A
/// file the new folder has already is left as it is in both. The names
/// carried over.
pub fn carry_over(old: &Path, new: &Path, move_files: bool) -> Vec<String> {
    let mut carried = Vec::new();
    for name in own_list_files(old) {
        let target = new.join(&name);
        if fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        let from = old.join(&name);
        let done = if move_files {
            fs::rename(&from, &target)
                .or_else(|_| fs::copy(&from, &target).and_then(|_| fs::remove_file(&from)))
        } else {
            fs::copy(&from, &target).map(drop)
        };
        if done.is_ok() {
            carried.push(name);
        }
    }
    carried
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    fn lists(game: &str) -> String {
        format!(r#"{{"format":"atlas-own-lists","version":1,"gameId":"{game}","lists":[]}}"#)
    }

    #[test]
    fn writes_and_reads_beside_the_pack_folder() {
        let maps = TempDir::new("own-lists-1");
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), None);
        assert_eq!(
            write(maps.0.as_path(), "demo", &lists("demo"), None).unwrap(),
            None
        );
        assert!(maps.0.as_path().join("demo.my-lists.json").is_file());
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), Some(lists("demo")));
        // No part file is left behind.
        let names: Vec<_> = fs::read_dir(maps.0.as_path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["demo.my-lists.json".to_owned()]);
    }

    #[test]
    fn refuses_what_is_not_this_games_lists() {
        let maps = TempDir::new("own-lists-2");
        assert!(write(maps.0.as_path(), "demo", "not json", None).is_err());
        assert!(write(maps.0.as_path(), "demo", &lists("other"), None).is_err());
        assert!(write(maps.0.as_path(), "demo", r#"{"gameId":"demo"}"#, None).is_err());
        assert!(write(maps.0.as_path(), "../demo", &lists("../demo"), None).is_err());
        assert!(read(maps.0.as_path(), "Demo/..").is_err());
        let large = format!("{}{}", lists("demo"), " ".repeat(MAX_OWN_LISTS_BYTES));
        assert!(write(maps.0.as_path(), "demo", &large, None).is_err());
        assert!(!maps.0.as_path().join("demo.my-lists.json").exists());
    }

    #[test]
    fn keeps_a_copy_of_the_file_when_asked() {
        let maps = TempDir::new("own-lists-3");
        write(maps.0.as_path(), "demo", &lists("demo"), None).unwrap();
        let newer = lists("demo").replace("\"lists\":[]", "\"lists\":[{}]");
        let kept = write(
            maps.0.as_path(),
            "demo",
            &newer,
            Some("2026-11-13T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(
            kept.as_deref(),
            Some("demo.my-lists.2026-11-13T100000Z.json")
        );
        let copy = fs::read_to_string(maps.0.as_path().join(kept.unwrap())).unwrap();
        assert_eq!(copy, lists("demo"));
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), Some(newer));
    }

    #[test]
    fn deletes_only_when_asked_and_says_whether_there_was_one() {
        let maps = TempDir::new("own-lists-4");
        assert!(!delete(maps.0.as_path(), "demo").unwrap());
        write(maps.0.as_path(), "demo", &lists("demo"), None).unwrap();
        assert!(delete(maps.0.as_path(), "demo").unwrap());
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), None);
    }

    #[test]
    fn is_not_a_pack_and_survives_a_pack_folder_being_replaced() {
        let maps = TempDir::new("own-lists-5");
        let pack = maps.0.as_path().join("demo");
        fs::create_dir_all(&pack).unwrap();
        fs::write(pack.join("manifest.json"), "{}").unwrap();
        write(maps.0.as_path(), "demo", &lists("demo"), None).unwrap();
        // The pack folder goes, as a delete or an import over it does.
        fs::remove_dir_all(&pack).unwrap();
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), Some(lists("demo")));
        // A folder of packs lists folders only.
        assert!(crate::library::packs_in(maps.0.as_path()).0.is_empty());
    }

    #[test]
    fn carries_the_files_to_a_new_maps_folder() {
        let old = TempDir::new("own-lists-6");
        let new = TempDir::new("own-lists-7");
        write(old.0.as_path(), "demo", &lists("demo"), None).unwrap();
        write(old.0.as_path(), "other", &lists("other"), None).unwrap();
        fs::write(old.0.as_path().join("notes.json"), "{}").unwrap();
        write(
            new.0.as_path(),
            "other",
            &lists("other").replace("[]", "[1]"),
            None,
        )
        .unwrap();

        // Copied: both folders have it; the new folder's own file stays.
        assert_eq!(
            carry_over(old.0.as_path(), new.0.as_path(), false),
            vec!["demo.my-lists.json"]
        );
        assert!(old.0.as_path().join("demo.my-lists.json").is_file());
        assert_eq!(
            read(new.0.as_path(), "other").unwrap(),
            Some(lists("other").replace("[]", "[1]"))
        );

        // Moved: it leaves the old folder.
        let third = TempDir::new("own-lists-8");
        assert_eq!(
            carry_over(old.0.as_path(), third.0.as_path(), true),
            vec!["demo.my-lists.json", "other.my-lists.json"]
        );
        assert!(!old.0.as_path().join("demo.my-lists.json").exists());
        assert!(old.0.as_path().join("notes.json").exists());
        assert_eq!(
            read(third.0.as_path(), "demo").unwrap(),
            Some(lists("demo"))
        );
    }
}
