//! The player's own floor cuts: `floor-overrides.json` in the app's config folder, next to `settings.json`.
//!
//! The file holds, per game and then per area (`mAA_BB`), what the helper's config holds under `floorOverrides`
//! (tools/gamefiles/config/<game>.json): `cuts` (every cut height in metres, in place of the automatic ones),
//! `splitAt`, `mergeAt` and `names` (lowest first, an empty name for "as the Map Maker names it"). The Adjust floors
//! panel writes one area's entry at a time; Make map and Make this area again give the file to the helper
//! (`--floor-overrides`), where per area the player's entry replaces the shipped one. "Save my floor cuts to a
//! file…" writes one game's entries to a file of the same shape, and "Load floor cuts from a file…" takes such a
//! file in. Everything read is checked: bounded sizes, numbers in range, names cut to length, anything else left
//! out.

use std::{fs, path::Path};

use serde_json::{json, Map, Value};

pub const FILE_NAME: &str = "floor-overrides.json";
const MAX_GAMES: usize = 16;
const MAX_AREAS: usize = 512;
const MAX_CUTS: usize = 32;
const MAX_NAMES: usize = 33;
const MAX_NAME_CHARS: usize = 80;
const MAX_HEIGHT: f64 = 100_000.0;
/// A larger file is not read.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const COMMENT: &str = "Atlas Map Maker floor cuts: per game, per area (mAA_BB): cuts (every cut height in metres, lowest first, in place of the automatic ones), names (of the floors, lowest first; empty for the Map Maker's own name).";

/// Whether `id` is a game id: 1 to 64 of `a`–`z`, `0`–`9` and `-`.
pub fn is_game(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The area key of `area` (`m15_01` of `m15_01` or `m15_01_00_00`), when it is one.
pub fn area_key(area: &str) -> Option<String> {
    let area = area.to_ascii_lowercase();
    let bytes = area.as_bytes();
    let key = bytes.get(..6)?;
    let ok = key[0] == b'm'
        && key[1].is_ascii_digit()
        && key[2].is_ascii_digit()
        && key[3] == b'_'
        && key[4].is_ascii_digit()
        && key[5].is_ascii_digit();
    let rest_ok = match bytes.len() {
        6 => true,
        12 => {
            bytes[6] == b'_'
                && bytes[7..9].iter().all(u8::is_ascii_digit)
                && bytes[9] == b'_'
                && bytes[10..12].iter().all(u8::is_ascii_digit)
        }
        _ => false,
    };
    (ok && rest_ok).then(|| area[..6].to_owned())
}

/// One area's entry, kept to what the helper reads; `None` when nothing usable is left.
pub fn clean_entry(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut entry = Map::new();
    for key in ["cuts", "splitAt", "mergeAt"] {
        if let Some(Value::Array(heights)) = object.get(key) {
            let kept: Vec<Value> = heights
                .iter()
                .take(MAX_CUTS)
                .filter_map(Value::as_f64)
                .filter(|h| h.is_finite() && h.abs() < MAX_HEIGHT)
                .map(|h| json!((h * 100.0).round() / 100.0))
                .collect();
            if !kept.is_empty() || key == "cuts" {
                entry.insert(key.to_owned(), Value::Array(kept));
            }
        }
    }
    if let Some(Value::Array(names)) = object.get("names") {
        let names: Vec<Value> = names
            .iter()
            .take(MAX_NAMES)
            .map(|name| {
                let text: String = name
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(MAX_NAME_CHARS)
                    .collect();
                Value::String(text.trim().to_owned())
            })
            .collect();
        if names.iter().any(|name| name.as_str() != Some("")) {
            entry.insert("names".to_owned(), Value::Array(names));
        }
    }
    (!entry.is_empty()).then_some(Value::Object(entry))
}

/// Every game's entries of a file's contents, cleaned: `{game: {area: entry}}`.
pub fn clean(value: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(games) = value.as_object() else {
        return out;
    };
    for (game, areas) in games.iter().filter(|(game, _)| is_game(game)) {
        if out.len() == MAX_GAMES {
            break;
        }
        let Some(areas) = areas.as_object() else {
            continue;
        };
        let mut kept = Map::new();
        for (area, entry) in areas {
            if kept.len() == MAX_AREAS {
                break;
            }
            if let (Some(key), Some(entry)) = (area_key(area), clean_entry(entry)) {
                kept.insert(key, entry);
            }
        }
        if !kept.is_empty() {
            out.insert(game.clone(), Value::Object(kept));
        }
    }
    out
}

fn read_value(file: &Path) -> Result<Option<Value>, String> {
    match fs::metadata(file) {
        Err(_) => return Ok(None),
        Ok(meta) if meta.len() > MAX_FILE_BYTES => {
            return Err(format!("{} is too large to be floor cuts.", file.display()))
        }
        Ok(_) => {}
    }
    let text = fs::read_to_string(file)
        .map_err(|error| format!("Could not read {}: {error}", file.display()))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map(Some)
        .map_err(|_| format!("{} is not a floor cuts file (JSON).", file.display()))
}

/// The player's floor cuts (empty when there are none yet).
pub fn read(file: &Path) -> Result<Map<String, Value>, String> {
    Ok(read_value(file)?
        .map(|value| clean(&value))
        .unwrap_or_default())
}

fn write(file: &Path, games: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut out = Map::new();
    out.insert("$comment".to_owned(), Value::String(COMMENT.to_owned()));
    out.extend(games.clone());
    let text =
        serde_json::to_string_pretty(&Value::Object(out)).map_err(|error| error.to_string())?;
    // Written next to it first, so a crash never leaves half a file.
    let partial = file.with_extension("json.partial");
    fs::write(&partial, text + "\n").map_err(|error| error.to_string())?;
    fs::rename(&partial, file).map_err(|error| error.to_string())
}

/// Sets (or with `None` removes, "Back to automatic") one area's entry. Returns every game's entries.
pub fn set_area(
    file: &Path,
    game: &str,
    area: &str,
    entry: Option<&Value>,
) -> Result<Map<String, Value>, String> {
    if !is_game(game) {
        return Err(format!("{game} is not a game."));
    }
    let key = area_key(area).ok_or_else(|| format!("{area} is not an area."))?;
    // An unreadable file is started again rather than left in the way of every change.
    let mut games = read(file).unwrap_or_default();
    let mut areas = games
        .get(game)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    match entry.and_then(clean_entry) {
        Some(entry) => {
            areas.insert(key, entry);
        }
        None => {
            areas.remove(&key);
        }
    }
    if areas.is_empty() {
        games.remove(game);
    } else {
        games.insert(game.to_owned(), Value::Object(areas));
    }
    write(file, &games)?;
    Ok(games)
}

/// The contents of a "Save my floor cuts to a file…" file: the game's entries alone.
pub fn export(file: &Path, game: &str) -> Result<(Value, usize), String> {
    let games = read(file)?;
    let areas = games.get(game).cloned().unwrap_or_else(|| json!({}));
    let count = areas.as_object().map_or(0, Map::len);
    Ok((json!({ "$comment": COMMENT, game: areas }), count))
}

/// Takes in a floor cuts file (`other`): its entries replace the player's for the same areas. Returns every game's
/// entries and how many areas were taken.
pub fn import(file: &Path, other: &Path) -> Result<(Map<String, Value>, usize), String> {
    let taken = clean(&read_value(other)?.ok_or("That file is gone.")?);
    let count: usize = taken
        .values()
        .filter_map(Value::as_object)
        .map(Map::len)
        .sum();
    if count == 0 {
        return Err("That file holds no floor cuts.".to_owned());
    }
    let mut games = read(file).unwrap_or_default();
    for (game, areas) in taken {
        let mut mine = games
            .get(&game)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Value::Object(areas) = areas {
            mine.extend(areas);
        }
        games.insert(game, Value::Object(mine));
    }
    write(file, &games)?;
    Ok((games, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("atlas-mapmaker-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn areas_and_games() {
        assert_eq!(area_key("m15_01").as_deref(), Some("m15_01"));
        assert_eq!(area_key("M15_01_00_00").as_deref(), Some("m15_01"));
        for bad in ["m15", "x15_01", "m15_01_0", "m15_01/..", "", "m1a_01"] {
            assert_eq!(area_key(bad), None, "{bad}");
        }
        assert!(is_game("dark-souls-remastered"));
        assert!(!is_game("Dark Souls") && !is_game("$comment") && !is_game(""));
    }

    #[test]
    fn entries_are_cleaned() {
        let entry =
            json!({"cuts": [4.567, "x", 1e9, 2], "names": ["  Roof ", 3, "a\u{7}b"], "other": 1});
        assert_eq!(
            clean_entry(&entry).unwrap(),
            json!({"cuts": [4.57, 2.0], "names": ["Roof", "", "ab"]})
        );
        assert_eq!(
            clean_entry(&json!({"cuts": []})).unwrap(),
            json!({"cuts": []})
        );
        assert_eq!(clean_entry(&json!({"names": ["", ""]})), None);
        assert_eq!(clean_entry(&json!([1])), None);
        let long = "x".repeat(500);
        let cleaned = clean_entry(&json!({ "names": [long] })).unwrap();
        assert_eq!(cleaned["names"][0].as_str().unwrap().len(), MAX_NAME_CHARS);
        let file = clean(
            &json!({"$comment": "x", "Bad Game": {}, "g": {"m15_01": {"cuts": [3]}, "bad": {"cuts": [1]}}}),
        );
        assert_eq!(
            Value::Object(file),
            json!({"g": {"m15_01": {"cuts": [3.0]}}})
        );
    }

    #[test]
    fn set_export_and_import() {
        let dir = temp("floor-overrides");
        let file = dir.join(FILE_NAME);
        assert!(read(&file).unwrap().is_empty(), "no file yet: no cuts");
        let games = set_area(
            &file,
            "g",
            "m15_01_00_00",
            Some(&json!({"cuts": [4.5], "names": ["Low", ""]})),
        )
        .unwrap();
        assert_eq!(games["g"]["m15_01"]["cuts"], json!([4.5]));
        set_area(&file, "g", "m10_01", Some(&json!({"cuts": []}))).unwrap();
        assert!(fs::read_to_string(&file).unwrap().contains("$comment"));
        let (exported, count) = export(&file, "g").unwrap();
        assert_eq!(count, 2);
        assert_eq!(exported["g"]["m10_01"], json!({"cuts": []}));
        // Back to automatic removes the entry, and the game with its last one.
        let games = set_area(&file, "g", "m15_01", None).unwrap();
        assert!(games["g"].get("m15_01").is_none());
        let games = set_area(&file, "g", "m10_01", None).unwrap();
        assert!(games.is_empty());
        assert!(set_area(&file, "g", "../x", None).is_err());

        let other = dir.join("shared.json");
        fs::write(&other, exported.to_string()).unwrap();
        set_area(&file, "g", "m12_00", Some(&json!({"cuts": [9]}))).unwrap();
        let (games, taken) = import(&file, &other).unwrap();
        assert_eq!(taken, 2);
        assert_eq!(games["g"].as_object().unwrap().len(), 3);
        fs::write(&other, "{}").unwrap();
        assert!(import(&file, &other).unwrap_err().contains("no floor cuts"));
        fs::write(&other, "not json").unwrap();
        assert!(import(&file, &other).is_err());
        fs::write(&file, "not json").unwrap();
        assert!(read(&file).is_err());
        // A broken file is started again by the next change.
        assert!(set_area(&file, "g", "m15_01", Some(&json!({"cuts": [1]}))).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}
