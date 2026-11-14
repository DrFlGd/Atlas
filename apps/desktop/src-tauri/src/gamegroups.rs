//! Games shown under one title: one file in the maps folder,
//! `<maps folder>/game-groups.json`, that says which games are the same game
//! from several sources. The web app reads and writes it (see
//! `gameGroups.ts` in the schema package for what it holds); the shell only
//! checks that it is that file and keeps it safe. It is the first file of
//! the maps folder as a whole rather than of one game, so the viewer and an
//! app built with downloads, which share the maps folder, show the same
//! titles.
//!
//! No game is changed by it: each stays a pack of its own. It is kept as the
//! own lists files are (see `ownlists`): never inside a pack folder; written
//! whole, to a part file that is then renamed over it; with a copy of the
//! file as it was kept beside it when the web app asks; and carried along
//! when the maps folder changes.
//!
//! A map pack file of a game under a title carries that title and its games
//! as `mine/game-group.json` ([`carried`], see `packfile`).
//!
//! Not on Android, whose web app keeps the titles in its own storage with
//! the found marks (see `DesktopInfo::game_groups_file`).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tauri::State;

use crate::{
    activity::{self, Area},
    commands::{blocking, desktop_only},
    library::Library,
    manifest::{rfc3339, write_atomic},
    ownlists::OwnFile,
    packs::is_valid_pack_id,
};

/// The file's name in the maps folder.
pub const GAME_GROUPS_FILE: &str = "game-groups.json";
/// What the file says it is (`format`).
pub const FORMAT: &str = "atlas-game-groups";
/// What the title of one game in a map pack file says it is (`format`).
pub const GROUP_FORMAT: &str = "atlas-game-group";
/// The version of that file this app writes.
const GROUP_VERSION: u64 = 1;
/// The title of one game in a map pack file, described as an own file is,
/// so the file can carry and check it as it does the others (its `suffix`
/// names no file in the maps folder).
pub const CARRIED: OwnFile = OwnFile {
    suffix: ".game-group.json",
    format: GROUP_FORMAT,
    what: "title",
};
/// A file larger than this is refused, read or written.
pub const MAX_GAME_GROUPS_BYTES: usize = 4 << 20;
/// The most games one title holds (as the schema says).
const MAX_MEMBERS: usize = 20;

static WRITING: Mutex<()> = Mutex::new(());

/// The file in a maps folder.
pub fn path(maps_folder: &Path) -> PathBuf {
    maps_folder.join(GAME_GROUPS_FILE)
}

/// The file's text, or `None` when there is none.
pub fn read(maps_folder: &Path) -> Result<Option<String>, String> {
    let path = path(maps_folder);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the titles of your games: {error}")),
    };
    if !metadata.is_file() {
        return Err(format!(
            "{} is not a file, so the titles of your games cannot be read.",
            path.display()
        ));
    }
    if metadata.len() > MAX_GAME_GROUPS_BYTES as u64 {
        return Err("The file of your games' titles is too large to read.".to_owned());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read the titles of your games: {error}"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "The file of your games' titles is not text, so it cannot be read.".to_owned())
}

/// Checks that a text is this file: JSON, not too large, with the right
/// `format`. The web app checks the rest with the schema before it writes.
fn check(contents: &str) -> Result<(), String> {
    if contents.len() > MAX_GAME_GROUPS_BYTES {
        return Err("The titles of your games are too large to save.".to_owned());
    }
    let value: Value = serde_json::from_str(contents).map_err(|_| {
        "The titles of your games could not be saved: they are not JSON.".to_owned()
    })?;
    if value.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(
            "The titles of your games could not be saved: this is not their file.".to_owned(),
        );
    }
    Ok(())
}

/// Writes the file whole (see the module). With `keep_copy`, the file there
/// now is kept beside it first, named with `stamp`. Returns the name of the
/// copy kept, if one was.
pub fn write(
    maps_folder: &Path,
    contents: &str,
    keep_copy: Option<&str>,
) -> Result<Option<String>, String> {
    check(contents)?;
    let path = path(maps_folder);
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
            let name = format!("game-groups.{safe}.json");
            fs::copy(&path, maps_folder.join(&name)).map_err(|error| {
                format!("Could not keep a copy of the titles of your games: {error}")
            })?;
            kept = Some(name);
        }
    }
    write_atomic(&path, contents.as_bytes())
        .map_err(|error| format!("Could not save the titles of your games: {error}"))?;
    Ok(kept)
}

/// When the maps folder changes: the file goes to the new folder, moved
/// (`move_files`) or copied, as the own lists files do (see
/// `ownlists::carry_over`). A file the new folder has already is left as it
/// is in both. Whether it was carried.
pub fn carry_over(old: &Path, new: &Path, move_files: bool) -> bool {
    let from = path(old);
    let target = path(new);
    if !from.is_file() || fs::symlink_metadata(&target).is_ok() {
        return false;
    }
    let done = if move_files {
        fs::rename(&from, &target)
            .or_else(|_| fs::copy(&from, &target).and_then(|_| fs::remove_file(&from)))
    } else {
        fs::copy(&from, &target).map(drop)
    };
    done.is_ok()
}

/// The games of a group as the file has them: valid game ids, each once.
fn members_of(group: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for member in group
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = member.get("gameId").and_then(Value::as_str) else {
            continue;
        };
        if is_valid_pack_id(id) && !ids.iter().any(|known| known == id) && ids.len() < MAX_MEMBERS {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// The title of one game, as a map pack file carries it
/// (`mine/game-group.json`): the title and the games of the group the game
/// is in, from the file of the maps folder; `None` when it is in none. Read
/// tolerantly, as the web app reads the file: a group it cannot read is
/// passed over.
pub fn carried(maps_folder: &Path, game_id: &str) -> Result<Option<String>, String> {
    if !is_valid_pack_id(game_id) {
        return Err("That is not a game id Atlas can use.".to_owned());
    }
    let Some(text) = read(maps_folder)? else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Ok(None);
    };
    if value.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Ok(None);
    }
    for group in value
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let members = members_of(group);
        if !members.iter().any(|id| id == game_id) {
            continue;
        }
        let title = group
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty() && title.chars().count() <= 200);
        let Some(title) = title else {
            continue;
        };
        if members.len() < 2 {
            continue;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        let file = json!({
            "format": GROUP_FORMAT,
            "version": GROUP_VERSION,
            "gameId": game_id,
            "updatedAt": rfc3339(now),
            "title": title,
            "members": members.iter().map(|id| json!({ "gameId": id })).collect::<Vec<_>>(),
        });
        return serde_json::to_string_pretty(&file)
            .map(|text| Some(format!("{text}\n")))
            .map_err(|error| format!("Could not write the title of the game: {error}"));
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Commands

/// The titles of the games in the maps folder, from their file; `None` when
/// there is none yet. Not on Android, where the web app keeps them itself.
#[tauri::command]
pub async fn game_groups_read(library: State<'_, Arc<Library>>) -> Result<Option<String>, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || read(&maps)).await
}

/// Writes the titles of the games, whole and at once. With `keep_copy` (a
/// time), the file as it was is kept beside it first; the name of that copy
/// is returned.
#[tauri::command]
pub async fn game_groups_write(
    library: State<'_, Arc<Library>>,
    contents: String,
    keep_copy: Option<String>,
) -> Result<Option<String>, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || {
        let kept = write(&maps, &contents, keep_copy.as_deref())?;
        if let Some(name) = &kept {
            activity::info(
                Area::Library,
                format!("Kept a copy of the titles of the games as {name} before saving them"),
            );
        }
        Ok(kept)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    fn groups(members: &str) -> String {
        format!(
            r#"{{"format":"atlas-game-groups","version":1,"updatedAt":"2026-11-14T10:00:00.000Z","groups":[{{"id":"g1","title":"Isles","members":[{members}]}}]}}"#
        )
    }

    const TWO: &str = r#"{"gameId":"isles-a"},{"gameId":"isles-b"}"#;

    #[test]
    fn writes_and_reads_one_file_in_the_maps_folder() {
        let maps = TempDir::new("game-groups-1");
        assert_eq!(read(maps.0.as_path()).unwrap(), None);
        assert_eq!(write(maps.0.as_path(), &groups(TWO), None).unwrap(), None);
        assert!(maps.0.as_path().join("game-groups.json").is_file());
        assert_eq!(read(maps.0.as_path()).unwrap(), Some(groups(TWO)));
        // No part file is left behind, and it is not a pack.
        let names: Vec<_> = fs::read_dir(maps.0.as_path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["game-groups.json".to_owned()]);
        assert!(crate::library::packs_in(maps.0.as_path()).0.is_empty());
    }

    #[test]
    fn refuses_what_is_not_the_file() {
        let maps = TempDir::new("game-groups-2");
        assert!(write(maps.0.as_path(), "not json", None).is_err());
        let lists = r#"{"format":"atlas-own-lists","version":1,"gameId":"demo","lists":[]}"#;
        assert!(write(maps.0.as_path(), lists, None).is_err());
        let large = format!("{}{}", groups(TWO), " ".repeat(MAX_GAME_GROUPS_BYTES));
        assert!(write(maps.0.as_path(), &large, None).is_err());
        assert!(!maps.0.as_path().join("game-groups.json").exists());
    }

    #[test]
    fn keeps_a_copy_when_asked_and_is_carried_to_a_new_maps_folder() {
        let maps = TempDir::new("game-groups-3");
        write(maps.0.as_path(), &groups(TWO), None).unwrap();
        let kept = write(
            maps.0.as_path(),
            &groups(TWO).replace("Isles", "The Isles"),
            Some("2026-11-14T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(kept.as_deref(), Some("game-groups.2026-11-14T100000Z.json"));
        assert_eq!(
            fs::read_to_string(maps.0.as_path().join(kept.unwrap())).unwrap(),
            groups(TWO)
        );

        // Copied: both folders have it; a file the new folder has stays.
        let new = TempDir::new("game-groups-4");
        assert!(carry_over(maps.0.as_path(), new.0.as_path(), false));
        assert!(path(maps.0.as_path()).is_file());
        write(new.0.as_path(), &groups(TWO), None).unwrap();
        assert!(!carry_over(maps.0.as_path(), new.0.as_path(), true));
        assert_eq!(read(new.0.as_path()).unwrap(), Some(groups(TWO)));
        // Moved: it leaves the old folder.
        let third = TempDir::new("game-groups-5");
        assert!(carry_over(maps.0.as_path(), third.0.as_path(), true));
        assert!(!path(maps.0.as_path()).exists());
        assert!(!carry_over(maps.0.as_path(), third.0.as_path(), true));
    }

    #[test]
    fn gives_the_title_of_one_game_for_a_map_pack_file() {
        let maps = TempDir::new("game-groups-6");
        assert_eq!(carried(maps.0.as_path(), "isles-a").unwrap(), None);
        write(
            maps.0.as_path(),
            &groups(r#"{"gameId":"isles-a"},{"gameId":"isles-a"},{"gameId":"Bad id"},{"gameId":"isles-b"}"#),
            None,
        )
        .unwrap();
        let text = carried(maps.0.as_path(), "isles-b").unwrap().unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["format"], "atlas-game-group");
        assert_eq!(value["version"], 1);
        assert_eq!(value["gameId"], "isles-b");
        assert_eq!(value["title"], "Isles");
        assert_eq!(
            value["members"],
            json!([{ "gameId": "isles-a" }, { "gameId": "isles-b" }])
        );
        // A game under no title, a title with one game, not a game id.
        assert_eq!(carried(maps.0.as_path(), "hills").unwrap(), None);
        write(maps.0.as_path(), &groups(r#"{"gameId":"isles-a"}"#), None).unwrap();
        assert_eq!(carried(maps.0.as_path(), "isles-a").unwrap(), None);
        assert!(carried(maps.0.as_path(), "../x").is_err());
    }
}
