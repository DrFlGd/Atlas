//! Games made in the app ("New game"): a game whose maps are pictures the
//! person chose, cut into tiles (see `tiles::cut`). It is a pack in the
//! maps folder like any other, whose manifest says `madeInApp`, with a
//! `maps.json` and `layers.json` of its maps and their levels, and no
//! locations, types or areas of its own: those the person adds are kept
//! beside the game (`<game id>.my-locations.json`, see `ownlists.rs`), as
//! for any game.
//!
//! A new game is made in a hidden folder in the maps folder and moved into
//! place when complete; a map or level added later is cut into a hidden
//! folder in the pack and its entries are written once its tiles are all
//! there. A failure or a cancel leaves nothing half made. Every change to
//! the pack's files holds the pack folder's lock.
//!
//! In the desktop apps only; Android has no way to choose a picture file
//! for this and no image code (see `DesktopInfo::own_games`).

use std::{fs, path::Path};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::{
    library::PackLock,
    manifest::{now_rfc3339, read_head, write_atomic, MANIFEST_FILE},
    packs::is_valid_pack_id,
};

/// The longest name of a game, map or level.
pub const MAX_NAME_CHARS: usize = 100;
/// The folder in a pack that holds its maps' tiles.
pub const TILES_DIR: &str = "tiles";
/// The name of a map's first level, until the person adds another.
pub const FIRST_LEVEL: &str = "Main level";

/// A name the person gave, trimmed, or why it cannot be used.
pub fn clean_name(name: &str, what: &str) -> Result<String, String> {
    let name: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_owned();
    if name.is_empty() {
        return Err(format!("Give the {what} a name."));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "The {what}'s name is too long: at most {MAX_NAME_CHARS} characters."
        ));
    }
    Ok(name)
}

/// Lowercase letters, digits and dashes made from a name: "Ruined Keep 2"
/// is `ruined-keep-2`. Empty when nothing of it fits.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_end_matches('-').to_owned()
}

/// The first of `base`, `base-2`, `base-3`… that `taken` does not have.
fn unique(base: &str, taken: impl Fn(&str) -> bool) -> String {
    std::iter::once(base.to_owned())
        .chain((2..).map(|n| format!("{base}-{n}")))
        .find(|candidate| !taken(candidate))
        .expect("some name is free")
}

/// A game id for a new game: from its name, not used by any game listed or
/// any folder or file in the maps folder.
pub fn new_game_id(title: &str, maps_folder: &Path, taken: impl Fn(&str) -> bool) -> String {
    let base = match slug(title) {
        id if is_valid_pack_id(&id) => id,
        _ => "my-game".to_owned(),
    };
    unique(&base, |id| {
        taken(id)
            || fs::symlink_metadata(maps_folder.join(id)).is_ok()
            || crate::ownlists::OWN_FILES.iter().any(|kind| {
                fs::symlink_metadata(maps_folder.join(format!("{id}{}", kind.suffix))).is_ok()
            })
    })
}

// ---------------------------------------------------------------------------
// The pack's files

fn read_array(pack: &Path, name: &str) -> Result<Vec<Value>, String> {
    let path = pack.join(name);
    let text =
        fs::read_to_string(&path).map_err(|error| format!("Could not read {name}: {error}"))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| format!("The game's {name} cannot be read."))
}

fn write_json(pack: &Path, name: &str, value: &Value) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value).expect("JSON serialises");
    text.push('\n');
    write_atomic(&pack.join(name), text.as_bytes())
        .map_err(|error| format!("Could not save {name}: {error}"))
}

/// Writes each entry of an array on a line of its own, as packs are written.
fn write_array(pack: &Path, name: &str, items: &[Value]) -> Result<(), String> {
    let text = if items.is_empty() {
        "[]\n".to_owned()
    } else {
        let lines: Vec<String> = items
            .iter()
            .map(|item| {
                format!(
                    "  {}",
                    serde_json::to_string(item).expect("JSON serialises")
                )
            })
            .collect();
        format!("[\n{}\n]\n", lines.join(",\n"))
    };
    write_atomic(&pack.join(name), text.as_bytes())
        .map_err(|error| format!("Could not save {name}: {error}"))
}

/// Sets the manifest's `updated` time, and any other fields given.
fn touch_manifest(pack: &Path, fields: &[(&str, Value)]) -> Result<(), String> {
    let path = pack.join(MANIFEST_FILE);
    let text =
        fs::read_to_string(&path).map_err(|error| format!("Could not read the game: {error}"))?;
    let mut manifest: Map<String, Value> = serde_json::from_str(&text)
        .map_err(|_| "The game's manifest cannot be read.".to_owned())?;
    for (key, value) in fields {
        manifest.insert((*key).to_owned(), value.clone());
    }
    manifest.insert("updated".to_owned(), json!(now_rfc3339()));
    write_json(pack, MANIFEST_FILE, &Value::Object(manifest))
}

/// The local part of an id: `ruins` of `my-game:map:ruins`.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn local(id: &str) -> &str {
    id.rsplit(':').next().unwrap_or(id)
}

/// The tile folder a layer of a game made in the app keeps its tiles in,
/// from its `url` (`tiles/<folder>/{z}/{x}/{y}.<ext>`); none for any other.
fn tile_folder_of(layer: &Value) -> Option<String> {
    let url = layer.get("tiles")?.get("url")?.as_str()?;
    let rest = url.strip_prefix(&format!("{TILES_DIR}/"))?;
    let (folder, pattern) = rest.split_once('/')?;
    let safe = crate::tiles::pyramid::is_safe_segment(folder)
        && folder
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (safe && pattern.starts_with("{z}/{x}/{y}.")).then(|| folder.to_owned())
}

/// A game made in the app, in its pack folder: errs for any other pack.
pub fn check_made_in_app(pack: &Path) -> Result<(), String> {
    match read_head(pack) {
        Ok(head) if head.made_in_app => Ok(()),
        Ok(_) => Err("Only a game made in Atlas can be changed this way.".to_owned()),
        Err(reason) => Err(format!("The game cannot be read: {reason}.")),
    }
}

/// What was added: the game, and its new map and level.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub game_id: String,
    pub map_id: String,
    pub layer_id: String,
}

/// A layer's entry for a cut picture.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn layer_entry(id: &str, map_id: &str, name: &str, folder: &str, cut: &CutFacts) -> Value {
    json!({
        "id": id,
        "mapId": map_id,
        "name": name,
        "tiles": { "type": "xyz", "url": format!("{TILES_DIR}/{folder}/{{z}}/{{x}}/{{y}}.{}", cut.extension) },
        "minZoom": 0,
        "maxZoom": cut.max_zoom,
        "tileSize": cut.tile_size,
    })
}

/// What a cut gave that the pack's files record.
#[derive(Clone, Debug)]
pub struct CutFacts {
    pub width: u32,
    pub height: u32,
    pub max_zoom: u8,
    pub tile_size: u32,
    pub extension: &'static str,
}

/// Renames a game made in the app.
pub fn rename_game(pack: &Path, title: &str) -> Result<String, String> {
    let title = clean_name(title, "game")?;
    check_made_in_app(pack)?;
    let _lock = PackLock::acquire(pack)?;
    touch_manifest(pack, &[("title", json!(title))])?;
    Ok(title)
}

/// Removes a map of a game made in the app, with its levels and their
/// tiles. A game keeps one map at least.
pub fn delete_map(pack: &Path, map_id: &str) -> Result<String, String> {
    check_made_in_app(pack)?;
    let _lock = PackLock::acquire(pack)?;
    let maps = read_array(pack, "maps.json")?;
    let layers = read_array(pack, "layers.json")?;
    let Some(map) = maps
        .iter()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(map_id))
    else {
        return Err("That map is not in this game any more.".to_owned());
    };
    let name = map
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("The map")
        .to_owned();
    if maps.len() < 2 {
        return Err(format!(
            "{name} is this game's only map, so it cannot be deleted on its own. Delete the game instead."
        ));
    }
    let of_map = |layer: &Value| layer.get("mapId").and_then(Value::as_str) == Some(map_id);
    let folders: Vec<String> = layers
        .iter()
        .filter(|l| of_map(l))
        .filter_map(tile_folder_of)
        .collect();
    let kept_maps: Vec<Value> = maps
        .iter()
        .filter(|m| m.get("id").and_then(Value::as_str) != Some(map_id))
        .cloned()
        .collect();
    let kept_layers: Vec<Value> = layers.iter().filter(|l| !of_map(l)).cloned().collect();
    // The layers go first, so a map is never without a level.
    write_array(pack, "layers.json", &kept_layers)?;
    write_array(pack, "maps.json", &kept_maps)?;
    touch_manifest(pack, &[])?;
    for folder in folders {
        let _ = fs::remove_dir_all(pack.join(TILES_DIR).join(folder));
    }
    Ok(name)
}

#[cfg(not(target_os = "android"))]
pub use cutting::{add_level, add_map, create_game, Cutting};

#[cfg(not(target_os = "android"))]
mod cutting {
    use std::path::PathBuf;

    use super::*;
    use crate::{
        manifest::MANIFEST_FILE,
        packfile::{import::IMPORTING_PREFIX, AppInfo, Stop},
        tiles::cut::{cut, work_folder, CutProgress, TILE_SIZE},
    };

    /// How a cut reports and is stopped.
    pub struct Cutting<'a> {
        pub progress: &'a mut dyn FnMut(CutProgress),
        pub cancelled: &'a (dyn Fn() -> bool + Sync),
    }

    fn cut_into(picture: &Path, folder: &Path, how: &mut Cutting<'_>) -> Result<CutFacts, Stop> {
        let done = cut(picture, folder, how.progress, how.cancelled)?;
        Ok(CutFacts {
            width: done.width,
            height: done.height,
            max_zoom: done.max_zoom,
            tile_size: TILE_SIZE,
            extension: done.extension,
        })
    }

    /// Removes a folder when dropped, unless kept.
    struct Scrap {
        path: PathBuf,
        kept: bool,
    }

    impl Drop for Scrap {
        fn drop(&mut self) {
            if !self.kept {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }

    /// Makes a new game in the maps folder from its name and its first
    /// map's picture: `<maps folder>/<game id>/`. The game id is new (see
    /// [`new_game_id`]); `taken` says which ids are used by games listed.
    pub fn create_game(
        maps_folder: &Path,
        title: &str,
        map_name: &str,
        picture: &Path,
        app: &AppInfo,
        taken: impl Fn(&str) -> bool,
        how: &mut Cutting<'_>,
    ) -> Result<Added, Stop> {
        let title = clean_name(title, "game")?;
        let map_name = clean_name(map_name, "map")?;
        fs::create_dir_all(maps_folder)
            .map_err(|error| Stop::Failed(format!("Could not create the maps folder: {error}")))?;
        let game_id = new_game_id(&title, maps_folder, taken);
        // A hidden folder the next start clears if the app ends meanwhile
        // (see `removal::finish_pending_deletes`).
        let work = maps_folder.join(format!("{IMPORTING_PREFIX}{game_id}"));
        if fs::symlink_metadata(&work).is_ok() {
            let _ = fs::remove_dir_all(&work);
        }
        fs::create_dir_all(&work).map_err(|error| {
            Stop::Failed(format!("Could not write to the maps folder: {error}"))
        })?;
        let mut scrap = Scrap {
            path: work.clone(),
            kept: false,
        };
        let lock = PackLock::acquire(&work)?;
        let map_local = match slug(&map_name) {
            local if local.is_empty() => "map".to_owned(),
            local => local,
        };
        let map_id = format!("{game_id}:map:{map_local}");
        let layer_id = format!("{game_id}:layer:{map_local}");
        let facts = cut_into(picture, &work.join(TILES_DIR).join(&map_local), how)?;
        let now = now_rfc3339();
        let manifest = json!({
            "schemaVersion": 2,
            "gameId": game_id,
            "title": title,
            "packVersion": "1.0.0",
            "gamePatch": "any",
            "attribution": [],
            "idMigrations": {},
            "created": now,
            "updated": now,
            "writtenBy": { "name": app.name, "version": app.version },
            "madeInApp": true,
        });
        write_array(
            &work,
            "maps.json",
            &[
                json!({ "id": map_id, "name": map_name, "width": facts.width, "height": facts.height }),
            ],
        )?;
        write_array(
            &work,
            "layers.json",
            &[layer_entry(
                &layer_id,
                &map_id,
                FIRST_LEVEL,
                &map_local,
                &facts,
            )],
        )?;
        for name in ["categoryGroups.json", "categories.json", "locations.json"] {
            write_array(&work, name, &[])?;
        }
        // The manifest last: the folder is a pack once it is there.
        write_json(&work, MANIFEST_FILE, &manifest)?;
        if (how.cancelled)() {
            return Err(Stop::Cancelled);
        }
        drop(lock);
        let target = maps_folder.join(&game_id);
        fs::rename(&work, &target).map_err(|error| {
            Stop::Failed(format!(
                "Could not put the new game in the maps folder: {error}"
            ))
        })?;
        scrap.kept = true;
        Ok(Added {
            game_id,
            map_id,
            layer_id,
        })
    }

    /// Cuts a picture into a new tile folder of a pack, named from `name`,
    /// and runs `record` once every tile is there, under the pack's lock.
    fn add_tiles(
        pack: &Path,
        name: &str,
        picture: &Path,
        how: &mut Cutting<'_>,
        record: impl FnOnce(
            &str,
            &CutFacts,
            &[Value],
            &[Value],
        ) -> Result<(Vec<Value>, Vec<Value>, Added), String>,
    ) -> Result<Added, Stop> {
        check_made_in_app(pack)?;
        let _lock = PackLock::acquire(pack)?;
        let maps = read_array(pack, "maps.json")?;
        let layers = read_array(pack, "layers.json")?;
        let tiles = pack.join(TILES_DIR);
        fs::create_dir_all(&tiles).map_err(|error| {
            Stop::Failed(format!("Could not write to the game's folder: {error}"))
        })?;
        // Left by a cut that did not finish.
        if let Ok(entries) = fs::read_dir(&tiles) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(".cutting-") {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        let base = match slug(name) {
            local if local.is_empty() => "map".to_owned(),
            local => local,
        };
        let used: Vec<String> = maps
            .iter()
            .chain(&layers)
            .filter_map(|v| {
                v.get("id")
                    .and_then(Value::as_str)
                    .map(|id| local(id).to_owned())
            })
            .collect();
        let folder = unique(&base, |candidate| {
            used.iter().any(|u| u == candidate)
                || fs::symlink_metadata(tiles.join(candidate)).is_ok()
        });
        let target = tiles.join(&folder);
        let work = work_folder(&target);
        let facts = cut_into(picture, &work, how)?;
        let mut scrap = Scrap {
            path: work.clone(),
            kept: false,
        };
        let (new_maps, new_layers, added) = record(&folder, &facts, &maps, &layers)?;
        if (how.cancelled)() {
            return Err(Stop::Cancelled);
        }
        fs::rename(&work, &target)
            .map_err(|error| Stop::Failed(format!("Could not save the map: {error}")))?;
        scrap.kept = true;
        let saved = write_array(pack, "maps.json", &new_maps)
            .and_then(|()| write_array(pack, "layers.json", &new_layers))
            .and_then(|()| touch_manifest(pack, &[]));
        if let Err(error) = saved {
            // Put the files back as they were, and the tiles away.
            let _ = write_array(pack, "maps.json", &maps);
            let _ = write_array(pack, "layers.json", &layers);
            let _ = fs::remove_dir_all(&target);
            return Err(Stop::Failed(error));
        }
        Ok(added)
    }

    /// Adds a map, with its first level, to a game made in the app.
    pub fn add_map(
        pack: &Path,
        game_id: &str,
        map_name: &str,
        picture: &Path,
        how: &mut Cutting<'_>,
    ) -> Result<Added, Stop> {
        let map_name = clean_name(map_name, "map")?;
        add_tiles(
            pack,
            &map_name,
            picture,
            how,
            |folder, facts, maps, layers| {
                let map_id = format!("{game_id}:map:{folder}");
                let layer_id = format!("{game_id}:layer:{folder}");
                let mut maps = maps.to_vec();
                maps.push(json!({ "id": map_id, "name": map_name, "width": facts.width, "height": facts.height }));
                let mut layers = layers.to_vec();
                layers.push(layer_entry(&layer_id, &map_id, FIRST_LEVEL, folder, facts));
                Ok((
                    maps,
                    layers,
                    Added {
                        game_id: game_id.to_owned(),
                        map_id,
                        layer_id,
                    },
                ))
            },
        )
    }

    /// Adds a level (a floor, say) to a map of a game made in the app. Its
    /// picture must be the size of the map's.
    pub fn add_level(
        pack: &Path,
        game_id: &str,
        map_id: &str,
        level_name: &str,
        picture: &Path,
        how: &mut Cutting<'_>,
    ) -> Result<Added, Stop> {
        let level_name = clean_name(level_name, "level")?;
        // Checked before cutting, so a picture of the wrong size is not cut.
        let maps = read_array(pack, "maps.json")?;
        let Some(map) = maps
            .iter()
            .find(|m| m.get("id").and_then(Value::as_str) == Some(map_id))
        else {
            return Err(Stop::Failed(
                "That map is not in this game any more.".to_owned(),
            ));
        };
        let size = |key: &str| map.get(key).and_then(Value::as_u64).unwrap_or(0);
        let (width, height) = (size("width"), size("height"));
        let map_name = map
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("the map")
            .to_owned();
        let info = crate::tiles::cut::inspect(picture)?;
        if u64::from(info.width) != width || u64::from(info.height) != height {
            return Err(Stop::Failed(format!(
                "A level of {map_name} needs a picture of the same size as its first one, {width} × {height} pixels; this one is {} × {} pixels.",
                info.width, info.height
            )));
        }
        let name = format!("{}-{level_name}", local(map_id));
        add_tiles(pack, &name, picture, how, |folder, facts, maps, layers| {
            let layer_id = format!("{game_id}:layer:{folder}");
            let mut layers = layers.to_vec();
            // After the map's other levels.
            let at = layers
                .iter()
                .rposition(|l| l.get("mapId").and_then(Value::as_str) == Some(map_id))
                .map_or(layers.len(), |i| i + 1);
            layers.insert(
                at,
                layer_entry(&layer_id, map_id, &level_name, folder, facts),
            );
            Ok((
                maps.to_vec(),
                layers,
                Added {
                    game_id: game_id.to_owned(),
                    map_id: map_id.to_owned(),
                    layer_id,
                },
            ))
        })
    }
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{
        packfile::{AppInfo, Stop},
        tiles::{
            cut::{tests::gradient, tests::save, CutProgress},
            store::tests::TempDir,
        },
    };
    use image::{DynamicImage, ImageFormat};

    fn app() -> AppInfo {
        AppInfo {
            name: "Atlas".into(),
            version: "0.4.4".into(),
            platform: "linux".into(),
        }
    }

    fn picture(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
        let path = dir.join(name);
        save(
            &DynamicImage::ImageRgb8(gradient(width, height)),
            &path,
            ImageFormat::Png,
        );
        path
    }

    fn never() -> bool {
        false
    }

    fn quietly() -> impl FnMut(CutProgress) {
        |_| {}
    }

    fn array(pack: &Path, name: &str) -> Vec<Value> {
        read_array(pack, name).unwrap()
    }

    /// Makes a game with two maps and a level in `ATLAS_OWN_GAME_OUT`, to
    /// open by hand with the web app's pack reader (`loadPack` in the core
    /// package) and so check that what the shell writes is a pack it reads.
    #[test]
    #[ignore = "writes a game for the web app's check; run by hand"]
    fn writes_a_game_for_the_web_check() {
        let out = PathBuf::from(std::env::var("ATLAS_OWN_GAME_OUT").expect("ATLAS_OWN_GAME_OUT"));
        let scratch = TempDir::new("own-game-web-check");
        let mut progress = quietly();
        let mut how = Cutting {
            progress: &mut progress,
            cancelled: &never,
        };
        let added = create_game(
            &out,
            "Cloud Isles",
            "Harbour",
            &picture(&scratch.0, "harbour.png", 1300, 700),
            &app(),
            |_| false,
            &mut how,
        )
        .unwrap();
        let pack = out.join(&added.game_id);
        let caves = add_map(
            &pack,
            &added.game_id,
            "Sea caves",
            &picture(&scratch.0, "caves.png", 300, 900),
            &mut how,
        )
        .unwrap();
        add_level(
            &pack,
            &added.game_id,
            &caves.map_id,
            "Lower",
            &picture(&scratch.0, "lower.png", 300, 900),
            &mut how,
        )
        .unwrap();
        println!("WROTE {}", pack.display());
    }

    #[test]
    fn names_and_ids() {
        assert_eq!(slug("Ruined Keep 2"), "ruined-keep-2");
        assert_eq!(slug("  --Ünder  the  sea--  "), "nder-the-sea");
        assert_eq!(slug("???"), "");
        assert_eq!(clean_name("  Isle\n ", "game").unwrap(), "Isle");
        assert!(clean_name("   ", "game")
            .unwrap_err()
            .contains("Give the game a name"));
        assert!(clean_name(&"x".repeat(101), "map").is_err());
        let maps = TempDir::new("own-game-ids");
        fs::create_dir_all(maps.0.join("my-isle")).unwrap();
        fs::write(maps.0.join("my-isle-2.my-lists.json"), "{}").unwrap();
        assert_eq!(new_game_id("My Isle", &maps.0, |_| false), "my-isle-3");
        assert_eq!(
            new_game_id("My Isle", &maps.0, |id| id == "my-isle-3"),
            "my-isle-4"
        );
        assert_eq!(new_game_id("!!", &maps.0, |_| false), "my-game");
    }

    #[test]
    fn makes_a_game_from_a_picture_that_the_app_lists() {
        let dir = TempDir::new("own-game-create");
        let maps = dir.0.join("Maps");
        let source = picture(&dir.0, "island.png", 600, 300);
        let mut progress = quietly();
        let added = create_game(
            &maps,
            " My Island ",
            "The isle",
            &source,
            &app(),
            |id| id == "demo",
            &mut Cutting {
                progress: &mut progress,
                cancelled: &never,
            },
        )
        .unwrap();
        assert_eq!(
            added,
            Added {
                game_id: "my-island".into(),
                map_id: "my-island:map:the-isle".into(),
                layer_id: "my-island:layer:the-isle".into(),
            }
        );
        let pack = maps.join("my-island");
        let head = read_head(&pack).unwrap();
        assert_eq!((head.title.as_str(), head.made_in_app), ("My Island", true));
        assert_eq!(
            array(&pack, "maps.json"),
            [json!({"id":"my-island:map:the-isle","name":"The isle","width":600,"height":300})]
        );
        assert_eq!(
            array(&pack, "layers.json"),
            [
                json!({"id":"my-island:layer:the-isle","mapId":"my-island:map:the-isle","name":"Main level",
                "tiles":{"type":"xyz","url":"tiles/the-isle/{z}/{x}/{y}.jpg"},"minZoom":0,"maxZoom":2,"tileSize":256})
            ]
        );
        assert!(pack.join("tiles/the-isle/2/2/1.jpg").is_file());
        assert!(pack.join("tiles/the-isle/0/0/0.jpg").is_file());
        assert_eq!(array(&pack, "locations.json"), Vec::<Value>::new());
        // Nothing is left beside it.
        let names: Vec<String> = fs::read_dir(&maps)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["my-island"]);
        // The app lists it like any pack.
        let (packs, _) = crate::library::packs_in(&maps);
        assert_eq!(packs.len(), 1);
        // And it can be exported as a map pack file.
        let layers = crate::packfile::parse_layers(
            &fs::read_to_string(pack.join("maps.json")).unwrap(),
            &fs::read_to_string(pack.join("layers.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(layers[0].max_zoom, 2);
    }

    #[test]
    fn a_cancelled_or_failed_new_game_leaves_nothing() {
        let dir = TempDir::new("own-game-cancel");
        let maps = dir.0.join("Maps");
        let source = picture(&dir.0, "island.png", 900, 900);
        let mut progress = quietly();
        let result = create_game(
            &maps,
            "Isle",
            "Isle",
            &source,
            &app(),
            |_| false,
            &mut Cutting {
                progress: &mut progress,
                cancelled: &|| true,
            },
        );
        assert_eq!(result, Err(Stop::Cancelled));
        assert_eq!(fs::read_dir(&maps).unwrap().count(), 0);
        let text = dir.0.join("notes.png");
        fs::write(&text, "no picture").unwrap();
        let result = create_game(
            &maps,
            "Isle",
            "Isle",
            &text,
            &app(),
            |_| false,
            &mut Cutting {
                progress: &mut progress,
                cancelled: &never,
            },
        );
        assert!(matches!(result, Err(Stop::Failed(_))));
        assert_eq!(fs::read_dir(&maps).unwrap().count(), 0);
        let result = create_game(
            &maps,
            " ",
            "Isle",
            &source,
            &app(),
            |_| false,
            &mut Cutting {
                progress: &mut progress,
                cancelled: &never,
            },
        );
        assert_eq!(result, Err(Stop::Failed("Give the game a name.".into())));
    }

    #[test]
    fn adds_maps_and_levels_renames_and_deletes_a_map() {
        let dir = TempDir::new("own-game-change");
        let maps = dir.0.join("Maps");
        let first = picture(&dir.0, "first.png", 600, 300);
        let mut progress = quietly();
        let mut how = Cutting {
            progress: &mut progress,
            cancelled: &never,
        };
        let game = create_game(&maps, "Keep", "Keep", &first, &app(), |_| false, &mut how).unwrap();
        let pack = maps.join(&game.game_id);
        // Another map of another size, named like the first.
        let second = picture(&dir.0, "second.png", 300, 1000);
        let added = add_map(&pack, "keep", "Keep", &second, &mut how).unwrap();
        assert_eq!(added.map_id, "keep:map:keep-2");
        assert!(pack.join("tiles/keep-2/2/1/3.jpg").is_file());
        // A level of the first map: its picture must be the map's size.
        let wrong = add_level(&pack, "keep", "keep:map:keep", "Cellar", &second, &mut how);
        let Err(Stop::Failed(message)) = wrong else {
            panic!("{wrong:?}")
        };
        assert!(message.contains("same size"), "{message}");
        let cellar = picture(&dir.0, "cellar.png", 600, 300);
        let level = add_level(&pack, "keep", "keep:map:keep", "Cellar", &cellar, &mut how).unwrap();
        assert_eq!(level.layer_id, "keep:layer:keep-cellar");
        let layers = array(&pack, "layers.json");
        let order: Vec<&str> = layers.iter().map(|l| l["id"].as_str().unwrap()).collect();
        assert_eq!(
            order,
            [
                "keep:layer:keep",
                "keep:layer:keep-cellar",
                "keep:layer:keep-2"
            ]
        );
        assert_eq!(layers[1]["name"], "Cellar");
        // A cancelled level leaves the pack as it was.
        let mut cancelled_how = Cutting {
            progress: &mut progress,
            cancelled: &|| true,
        };
        let stopped = add_level(
            &pack,
            "keep",
            "keep:map:keep",
            "Attic",
            &cellar,
            &mut cancelled_how,
        );
        assert_eq!(stopped, Err(Stop::Cancelled));
        assert_eq!(array(&pack, "layers.json"), layers);
        let tiles: Vec<String> = fs::read_dir(pack.join("tiles"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(tiles.len(), 3, "{tiles:?}");

        assert_eq!(rename_game(&pack, " Old keep ").unwrap(), "Old keep");
        assert_eq!(read_head(&pack).unwrap().title, "Old keep");
        assert!(read_head(&pack).unwrap().made_in_app);

        assert_eq!(delete_map(&pack, "keep:map:keep").unwrap(), "Keep");
        assert_eq!(array(&pack, "maps.json").len(), 1);
        let layers = array(&pack, "layers.json");
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0]["id"], "keep:layer:keep-2");
        assert!(!pack.join("tiles/keep").exists());
        assert!(!pack.join("tiles/keep-cellar").exists());
        assert!(pack.join("tiles/keep-2").is_dir());
        // The last map stays.
        assert!(delete_map(&pack, "keep:map:keep-2")
            .unwrap_err()
            .contains("only map"));
        assert!(delete_map(&pack, "keep:map:gone").is_err());
    }

    #[test]
    fn changes_only_games_made_in_the_app() {
        let dir = TempDir::new("own-game-other");
        fs::write(
            dir.0.join(MANIFEST_FILE),
            r#"{"schemaVersion":2,"gameId":"t","title":"T","packVersion":"1.0.0"}"#,
        )
        .unwrap();
        assert!(rename_game(&dir.0, "New")
            .unwrap_err()
            .contains("made in Atlas"));
        assert!(delete_map(&dir.0, "t:map:a").is_err());
    }
}
