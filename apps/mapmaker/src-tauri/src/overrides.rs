//! The player's own floor cuts: `floor-overrides.json` in the app's config folder, next to `settings.json`.
//!
//! The file holds, per game and then per area (`mAA_BB`), what the helper's config holds under `floorOverrides`
//! (tools/gamefiles/config/<game>.json): `cuts` (every cut height in metres, in place of the automatic ones),
//! `splitAt`, `mergeAt` and `names` (lowest first, an empty name for "as the Map Maker names it"), and since
//! version 2 of the file (its top-level `version`), `method` (`passages` or `cuts`: how the area's floors are
//! found) and `passages` (`[{x, z, show}]`: in the overlapping place at x, z, whether the main floor shows the
//! `upper` or the `lower` storey), and since version 3, `removed` (the pieces the player removed in Adjust floors:
//! `[{part, box, triangles, area, whole}]`, the collision part's name, the piece's bounds `[x0, y0, z0, x1, y1, z1]`
//! in metres, how many triangles and square metres it had, and `whole` for a whole part; see the helper's
//! atlas_gamefiles/pieces.py). Files without `version` (version 1) and version 2 files load as before. The Adjust floors
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
const MAX_PASSAGES: usize = 256;
const MAX_REMOVED: usize = 256;
const MAX_PART_CHARS: usize = 64;
/// The version of the file this app writes (`version` at the top).
pub const FILE_VERSION: u64 = 3;
/// A larger file is not read.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const COMMENT: &str = "Atlas Map Maker floor cuts: per game, per area (mAA_BB): cuts (every cut height in metres, lowest first, in place of the automatic ones), names (of the floors, lowest first; empty for the Map Maker's own name), method (passages: automatic passages, or cuts), passages (per overlapping place at x, z: show the upper or the lower storey on the main floor), removed (pieces left out of the map: the collision part, the piece's bounds in metres, its triangles and area, whole for a whole part).";

/// Whether `id` is a game id: 1 to 64 of `a`–`z`, `0`–`9` and `-`.
pub fn is_game(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The one area of a map made from a 3D model.
pub const MODEL_AREA: &str = "model";

/// The area key of `area` (`m15_01` of `m15_01` or `m15_01_00_00`, or `model` for a map made from a 3D model),
/// when it is one.
pub fn area_key(area: &str) -> Option<String> {
    let area = area.to_ascii_lowercase();
    if area == MODEL_AREA {
        return Some(area);
    }
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
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        if crate::settings::is_floor_method(method) {
            entry.insert("method".to_owned(), Value::String(method.to_owned()));
        }
    }
    if let Some(Value::Array(passages)) = object.get("passages") {
        let kept: Vec<Value> = passages
            .iter()
            .take(MAX_PASSAGES)
            .filter_map(|item| {
                let show = item.get("show").and_then(Value::as_str)?;
                if show != "upper" && show != "lower" {
                    return None;
                }
                let at = |key: &str| {
                    item.get(key)
                        .and_then(Value::as_f64)
                        .filter(|v| v.is_finite() && v.abs() < MAX_HEIGHT)
                        .map(|v| (v * 100.0).round() / 100.0)
                };
                Some(json!({ "x": at("x")?, "z": at("z")?, "show": show }))
            })
            .collect();
        if !kept.is_empty() {
            entry.insert("passages".to_owned(), Value::Array(kept));
        }
    }
    if let Some(Value::Array(removed)) = object.get("removed") {
        let mut kept: Vec<Value> = Vec::new();
        for piece in removed.iter().take(MAX_REMOVED).filter_map(clean_piece) {
            if !kept.contains(&piece) {
                kept.push(piece);
            }
        }
        if !kept.is_empty() {
            entry.insert("removed".to_owned(), Value::Array(kept));
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

/// One removed piece, kept to what the helper reads (atlas_gamefiles/pieces.py `clean_piece`); `None` when it is not
/// usable.
fn clean_piece(value: &Value) -> Option<Value> {
    let part: String = value
        .get("part")?
        .as_str()?
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_PART_CHARS)
        .collect();
    let numbers: Vec<f64> = value
        .get("box")?
        .as_array()
        .filter(|values| values.len() == 6)?
        .iter()
        .map(|v| v.as_f64().filter(|v| v.is_finite() && v.abs() < MAX_HEIGHT))
        .collect::<Option<Vec<f64>>>()?
        .into_iter()
        .map(|v| (v * 100.0).round() / 100.0)
        .collect();
    if (0..3).any(|k| numbers[k + 3] < numbers[k]) {
        return None;
    }
    let mut piece = Map::new();
    piece.insert("part".to_owned(), Value::String(part.trim().to_owned()));
    piece.insert("box".to_owned(), json!(numbers));
    if value.get("whole") == Some(&Value::Bool(true)) {
        piece.insert("whole".to_owned(), Value::Bool(true));
    }
    if let Some(count) = value
        .get("triangles")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (0.0..1e9).contains(n))
    {
        piece.insert("triangles".to_owned(), json!(count as u64));
    }
    if let Some(area) = value
        .get("area")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (0.0..1e9).contains(n))
    {
        piece.insert("area".to_owned(), json!((area * 100.0).round() / 100.0));
    }
    Some(Value::Object(piece))
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
    out.insert("version".to_owned(), json!(FILE_VERSION));
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
    Ok((
        json!({ "$comment": COMMENT, "version": FILE_VERSION, game: areas }),
        count,
    ))
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
        assert_eq!(area_key("model").as_deref(), Some("model"));
        for bad in [
            "m15",
            "x15_01",
            "m15_01_0",
            "m15_01/..",
            "",
            "m1a_01",
            "models",
            "mode",
        ] {
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
        assert_eq!(
            clean_entry(&json!({"method": "passages", "passages": [
                {"x": 1.234, "z": -2, "show": "lower"},
                {"x": 1, "z": 2, "show": "sideways"},
                {"x": "a", "z": 2, "show": "upper"}
            ]}))
            .unwrap(),
            json!({"method": "passages", "passages": [{"x": 1.23, "z": -2.0, "show": "lower"}]})
        );
        assert_eq!(clean_entry(&json!({"method": "stairs"})), None);
        // Version 3: removed pieces, cleaned, each once.
        let piece = json!({"part": "h000100", "box": [1.234, 2, 3, 4, 5, 6.789], "triangles": 2, "area": 3.456});
        assert_eq!(
            clean_entry(&json!({"removed": [piece, piece, {"part": "x", "box": [5, 0, 0, 1, 1, 1]}, {"part": 3, "box": [0, 0, 0, 1, 1, 1]}, {"part": "y", "box": [0, 0, 0], "whole": true}, {"part": "\u{7}z", "box": [0, 0, 0, 1, 1, "a"]}]}))
                .unwrap(),
            json!({"removed": [{"part": "h000100", "box": [1.23, 2.0, 3.0, 4.0, 5.0, 6.79], "triangles": 2, "area": 3.46}]})
        );
        assert_eq!(
            clean_entry(&json!({"removed": [{"part": "p", "box": [0, 0, 0, 1, 1, 1], "whole": true, "other": 1}]}))
                .unwrap(),
            json!({"removed": [{"part": "p", "box": [0.0, 0.0, 0.0, 1.0, 1.0, 1.0], "whole": true}]})
        );
        assert_eq!(clean_entry(&json!({"removed": [{"part": "x"}]})), None);
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
        let written: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(written.get("$comment").is_some());
        assert_eq!(written["version"], json!(FILE_VERSION));
        // A version 1 file (no `version`) and a version 2 file read alike.
        assert_eq!(read(&file).unwrap()["g"]["m15_01"]["cuts"], json!([4.5]));
        assert!(read(&file).unwrap().get("version").is_none());
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
