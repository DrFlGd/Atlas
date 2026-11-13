//! A person's links between guide pages and the map of a game, in a file of
//! their own in the maps folder, beside the game's pack folder: `<maps
//! folder>/<game id>.guide-links.json`. The web app reads and writes it
//! (see `guideLinks.ts` in the schema package for what it holds: which
//! pages the person linked to which types, location names and regions,
//! which they skipped, and other games whose guides are read with this
//! one's); the shell only checks that it is the guide links file of that
//! game and keeps it safe.
//!
//! It is kept as the own lists file is (see `ownlists`): never inside a
//! pack folder, so refreshing or rebuilding a pack, importing a map pack
//! file over the game or deleting the game leaves it as it is; written
//! whole, to a part file that is then renamed over it; with a copy of the
//! file as it was kept beside it when the web app asks; and carried along
//! when the maps folder changes. Not on Android, whose web app keeps it in
//! its own storage with the found marks (see `DesktopInfo::own_list_files`).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

use tauri::State;

use crate::{
    activity::{self, Area},
    commands::blocking,
    library::Library,
    manifest::write_atomic,
    packs::is_valid_pack_id,
};

/// The end of a guide links file's name, after the game id.
pub const GUIDE_LINKS_SUFFIX: &str = ".guide-links.json";
/// What the file says it is (`format`).
const FORMAT: &str = "atlas-guide-links";
/// A guide links file larger than this is refused, read or written.
pub const MAX_GUIDE_LINKS_BYTES: usize = 8 << 20;

static WRITING: Mutex<()> = Mutex::new(());

/// The guide links file of a game in a maps folder.
pub fn guide_links_path(maps_folder: &Path, game_id: &str) -> Result<PathBuf, String> {
    if !is_valid_pack_id(game_id) {
        return Err("That is not a game id Atlas can use.".to_owned());
    }
    Ok(maps_folder.join(format!("{game_id}{GUIDE_LINKS_SUFFIX}")))
}

/// The text of a game's guide links file, or `None` when it has none.
pub fn read(maps_folder: &Path, game_id: &str) -> Result<Option<String>, String> {
    let path = guide_links_path(maps_folder, game_id)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read your guide links: {error}")),
    };
    if !metadata.is_file() {
        return Err(format!(
            "{} is not a file, so your guide links cannot be read.",
            path.display()
        ));
    }
    if metadata.len() > MAX_GUIDE_LINKS_BYTES as u64 {
        return Err("Your guide links file is too large to read.".to_owned());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Could not read your guide links: {error}"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Your guide links file is not text, so it cannot be read.".to_owned())
}

/// Checks that a text is a guide links file of this game: JSON, not too
/// large, with the right `format` and `gameId`. The web app checks the
/// rest with the schema before it writes.
fn check(game_id: &str, contents: &str) -> Result<(), String> {
    if contents.len() > MAX_GUIDE_LINKS_BYTES {
        return Err("Your guide links are too large to save.".to_owned());
    }
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|_| "Your guide links could not be saved: they are not JSON.".to_owned())?;
    let format = value.get("format").and_then(serde_json::Value::as_str);
    let game = value.get("gameId").and_then(serde_json::Value::as_str);
    if format != Some(FORMAT) || game != Some(game_id) {
        return Err(
            "Your guide links could not be saved: they are not this game's links.".to_owned(),
        );
    }
    Ok(())
}

/// Writes a game's guide links file whole (see the module). With
/// `keep_copy`, the file there now is kept beside it first, named with
/// `stamp`. Returns the name of the copy kept, if one was.
pub fn write(
    maps_folder: &Path,
    game_id: &str,
    contents: &str,
    keep_copy: Option<&str>,
) -> Result<Option<String>, String> {
    check(game_id, contents)?;
    let path = guide_links_path(maps_folder, game_id)?;
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
            let name = format!("{game_id}.guide-links.{safe}.json");
            fs::copy(&path, maps_folder.join(&name))
                .map_err(|error| format!("Could not keep a copy of your guide links: {error}"))?;
            kept = Some(name);
        }
    }
    write_atomic(&path, contents.as_bytes())
        .map_err(|error| format!("Could not save your guide links: {error}"))?;
    Ok(kept)
}

/// The guide links files directly in a folder, by name.
fn guide_link_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.strip_suffix(GUIDE_LINKS_SUFFIX)
                .is_some_and(is_valid_pack_id)
        })
        .collect();
    names.sort();
    names
}

/// When the maps folder changes: the guide links files of the old folder go
/// to the new one, moved (`move_files`) or copied, as own lists are (see
/// `ownlists::carry_over`). A file the new folder has already is left as it
/// is in both. The names carried over.
pub fn carry_over(old: &Path, new: &Path, move_files: bool) -> Vec<String> {
    let mut carried = Vec::new();
    for name in guide_link_files(old) {
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

// ---------------------------------------------------------------------------
// Commands

/// Whether this platform keeps the file in the maps folder (see the module).
fn desktop_only() -> Result<(), String> {
    if cfg!(desktop) {
        Ok(())
    } else {
        Err("This is not available on this device.".to_owned())
    }
}

/// A person's guide links of a game, from their file beside the game's
/// folder in the maps folder; `None` when there is none yet.
#[tauri::command]
pub async fn guide_links_read(
    library: State<'_, Arc<Library>>,
    game_id: String,
) -> Result<Option<String>, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || read(&maps, &game_id)).await
}

/// Writes a person's guide links of a game, whole and at once. With
/// `keep_copy` (a time), the file as it was is kept beside it first; the
/// name of that copy is returned.
#[tauri::command]
pub async fn guide_links_write(
    library: State<'_, Arc<Library>>,
    game_id: String,
    contents: String,
    keep_copy: Option<String>,
) -> Result<Option<String>, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || {
        let kept = write(&maps, &game_id, &contents, keep_copy.as_deref())?;
        if let Some(name) = &kept {
            activity::info(
                Area::Library,
                format!("Kept a copy of the guide links of {game_id} as {name} before saving them"),
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

    fn links(game: &str) -> String {
        format!(
            r#"{{"format":"atlas-guide-links","version":1,"gameId":"{game}","guidesFrom":[],"choices":{{}}}}"#
        )
    }

    #[test]
    fn writes_and_reads_beside_the_pack_folder() {
        let maps = TempDir::new("guide-links-1");
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), None);
        assert_eq!(
            write(maps.0.as_path(), "demo", &links("demo"), None).unwrap(),
            None
        );
        assert!(maps.0.as_path().join("demo.guide-links.json").is_file());
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), Some(links("demo")));
        let names: Vec<_> = fs::read_dir(maps.0.as_path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["demo.guide-links.json".to_owned()]);
    }

    #[test]
    fn refuses_what_is_not_this_games_links() {
        let maps = TempDir::new("guide-links-2");
        assert!(write(maps.0.as_path(), "demo", "not json", None).is_err());
        assert!(write(maps.0.as_path(), "demo", &links("other"), None).is_err());
        let lists = r#"{"format":"atlas-own-lists","version":1,"gameId":"demo","lists":[]}"#;
        assert!(write(maps.0.as_path(), "demo", lists, None).is_err());
        assert!(write(maps.0.as_path(), "../demo", &links("../demo"), None).is_err());
        assert!(read(maps.0.as_path(), "Demo/..").is_err());
        let large = format!("{}{}", links("demo"), " ".repeat(MAX_GUIDE_LINKS_BYTES));
        assert!(write(maps.0.as_path(), "demo", &large, None).is_err());
        assert!(!maps.0.as_path().join("demo.guide-links.json").exists());
    }

    #[test]
    fn keeps_a_copy_when_asked_and_survives_the_pack_folder_being_replaced() {
        let maps = TempDir::new("guide-links-3");
        let pack = maps.0.as_path().join("demo");
        fs::create_dir_all(&pack).unwrap();
        fs::write(pack.join("manifest.json"), "{}").unwrap();
        write(maps.0.as_path(), "demo", &links("demo"), None).unwrap();
        let newer = links("demo").replace("\"choices\":{}", "\"choices\":{\"x\":1}");
        let kept = write(
            maps.0.as_path(),
            "demo",
            &newer,
            Some("2026-11-13T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(
            kept.as_deref(),
            Some("demo.guide-links.2026-11-13T100000Z.json")
        );
        fs::remove_dir_all(&pack).unwrap();
        assert_eq!(read(maps.0.as_path(), "demo").unwrap(), Some(newer));
        // A folder of packs lists folders only.
        assert!(crate::library::packs_in(maps.0.as_path()).0.is_empty());
    }

    #[test]
    fn carries_the_files_to_a_new_maps_folder() {
        let old = TempDir::new("guide-links-4");
        let new = TempDir::new("guide-links-5");
        write(old.0.as_path(), "demo", &links("demo"), None).unwrap();
        fs::write(old.0.as_path().join("demo.my-lists.json"), "{}").unwrap();
        assert_eq!(
            carry_over(old.0.as_path(), new.0.as_path(), true),
            vec!["demo.guide-links.json"]
        );
        assert!(!old.0.as_path().join("demo.guide-links.json").exists());
        assert!(old.0.as_path().join("demo.my-lists.json").exists());
        assert_eq!(read(new.0.as_path(), "demo").unwrap(), Some(links("demo")));
    }
}
