//! The checks of a 3D map, as the pack file format sets them ("3D maps" in
//! `docs/pack-file-format.md`, and `packages/schema/src/scene.ts`): a scene
//! written strictly (no field that is not listed, every value in its
//! bounds), its integrity rules (square cells with unique ids, levels finest
//! first with triangles that never grow, every model file named once), and
//! the files themselves (each there, a glTF binary file of the length it
//! says, at most 256 MB). The builder checks what it writes with these, and
//! `atlas-scene check <pack folder>` checks a whole pack folder, so an app
//! without Node (the Map Maker on a player's PC) can check what it made.
//! The pipeline's `validate-pack` checks the same and the rest of a pack.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

/// The most cells a map's scene has.
pub const MAX_CELLS: usize = 4096;
/// The highest level of detail.
pub const MAX_LEVEL: u64 = 7;
/// The most bytes one model file may have.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

const SCENE_FIELDS: &[&str] = &[
    "axes",
    "scale",
    "offset",
    "heights",
    "cells",
    "water",
    "sky",
    "camera",
    "neighbours",
];
const CELL_FIELDS: &[&str] = &["id", "bounds", "heights", "lods"];
const LOD_FIELDS: &[&str] = &["level", "file", "triangles"];
const CAMERA_FIELDS: &[&str] = &["target", "distance", "yaw", "pitch"];
const AXES: &[&str] = &["+x", "-x", "+y", "-y", "+z", "-z"];

/// Whether `id` is a cell id: 1 to 64 of `a`–`z`, `0`–`9`, `_` and `-`,
/// starting with a letter or digit.
pub fn is_cell_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn finite_list(value: &Value, n: usize) -> Option<Vec<f64>> {
    let list = value.as_array()?;
    if list.len() != n {
        return None;
    }
    list.iter()
        .map(|v| v.as_f64().filter(|f| f.is_finite()))
        .collect()
}

fn unknown_fields(value: &Value, allowed: &[&str], what: &str, problems: &mut Vec<String>) {
    if let Some(object) = value.as_object() {
        for key in object.keys() {
            if !allowed.contains(&key.as_str()) {
                problems.push(format!(
                    "{what} has a field that is not in the format: {key}"
                ));
            }
        }
    }
}

fn check_range(value: Option<&Value>, what: &str, problems: &mut Vec<String>) {
    if let Some(value) = value {
        match finite_list(value, 2) {
            Some(range) if range[0] <= range[1] => {}
            Some(_) => problems.push(format!("{what}: its min is above its max")),
            None => problems.push(format!("{what} is not [min, max]")),
        }
    }
}

/// Whether a file starts as a glTF 2.0 binary file of the length it says.
pub fn check_model_file(path: &Path) -> Result<u64, String> {
    let metadata = fs::metadata(path).map_err(|_| "is missing".to_owned())?;
    let size = metadata.len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "is {size} bytes, over the 256 MB a model file may have"
        ));
    }
    let mut header = [0u8; 12];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| "is too short to be a glTF binary file".to_owned())?;
    if &header[0..4] != b"glTF" {
        return Err("is not a glTF binary file".to_owned());
    }
    let version = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    if version != 2 {
        return Err(format!("is glTF version {version}, not 2"));
    }
    let length = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
    if u64::from(length) != size {
        return Err(format!("says it is {length} bytes but is {size}"));
    }
    Ok(size)
}

/// The problems of one map's scene; none when it is right. `files` holds the
/// model files named so far in the pack (each may be named once); with a
/// pack folder, each file is looked at too.
pub fn check_scene(scene: &Value, pack: Option<&Path>, files: &mut HashSet<String>) -> Vec<String> {
    let mut problems = Vec::new();
    if !scene.is_object() {
        return vec!["the scene is not an object".to_owned()];
    }
    unknown_fields(scene, SCENE_FIELDS, "the scene", &mut problems);
    if let Some(axes) = scene.get("axes") {
        let names: Option<Vec<&str>> = axes.as_array().and_then(|list| {
            list.iter()
                .map(|a| a.as_str().filter(|a| AXES.contains(a)))
                .collect()
        });
        let ok = names.is_some_and(|names| {
            names.len() == 3 && names.iter().map(|a| &a[1..]).collect::<HashSet<_>>().len() == 3
        });
        if !ok {
            problems
                .push("axes must name each of x, y and z once, as +x, -z, +y and so on".to_owned());
        }
    }
    if let Some(scale) = scene.get("scale") {
        if !scale.as_f64().is_some_and(|s| s.is_finite() && s > 0.0) {
            problems.push("scale must be a number above 0".to_owned());
        }
    }
    if let Some(offset) = scene.get("offset") {
        if finite_list(offset, 3).is_none() {
            problems.push("offset must be [x, y, height]".to_owned());
        }
    }
    check_range(scene.get("heights"), "the scene's heights", &mut problems);
    if let Some(water) = scene.get("water") {
        if !water.as_f64().is_some_and(f64::is_finite) {
            problems.push("water must be a height".to_owned());
        }
    }
    if let Some(sky) = scene.get("sky") {
        let ok = sky.as_str().is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
        });
        if !ok {
            problems.push("sky must be a #rrggbb colour".to_owned());
        }
    }
    if let Some(camera) = scene.get("camera") {
        unknown_fields(camera, CAMERA_FIELDS, "the camera", &mut problems);
        let target = camera.get("target").and_then(|t| finite_list(t, 3));
        let distance = camera.get("distance").and_then(Value::as_f64);
        let yaw = camera.get("yaw").and_then(Value::as_f64);
        let pitch = camera.get("pitch").and_then(Value::as_f64);
        if target.is_none()
            || !distance.is_some_and(|d| d.is_finite() && d > 0.0)
            || !yaw.is_some_and(|y| (-360.0..=360.0).contains(&y))
            || !pitch.is_some_and(|p| (0.0..=90.0).contains(&p))
        {
            problems.push(
                "the camera needs a target [x, y, height], a distance above 0, a yaw from -360 to 360 and a pitch from 0 to 90"
                    .to_owned(),
            );
        }
    }
    let mut name_file = |file: &Value, what: &str, problems: &mut Vec<String>| {
        let Some(name) = file.as_str() else {
            problems.push(format!("{what}: its file is not a name"));
            return;
        };
        if !atlas_pack::is_scene_file_name(name) {
            problems.push(format!(
                "{what}: {name} is not a model file name (scene/…, lower case letters, digits, _, . and -, ending in .glb)"
            ));
            return;
        }
        if !files.insert(name.to_owned()) {
            problems.push(format!("{what}: {name} is named twice in the pack"));
        }
        if let Some(pack) = pack {
            if let Err(error) = check_model_file(&pack.join(name)) {
                problems.push(format!("{what}: {name} {error}"));
            }
        }
    };
    if let Some(neighbours) = scene.get("neighbours") {
        name_file(neighbours, "the neighbours", &mut problems);
    }
    let Some(cells) = scene.get("cells").and_then(Value::as_array) else {
        problems.push("the scene has no list of cells".to_owned());
        return problems;
    };
    if cells.is_empty() || cells.len() > MAX_CELLS {
        problems.push(format!(
            "a scene has 1 to {MAX_CELLS} cells, not {}",
            cells.len()
        ));
    }
    let mut ids = HashSet::new();
    for (index, cell) in cells.iter().enumerate() {
        let id = cell.get("id").and_then(Value::as_str).unwrap_or("");
        let what = if id.is_empty() {
            format!("cell {}", index + 1)
        } else {
            format!("cell {id}")
        };
        unknown_fields(cell, CELL_FIELDS, &what, &mut problems);
        if !is_cell_id(id) {
            problems.push(format!(
                "{what}: its id must be 1 to 64 of a-z, 0-9, _ and -"
            ));
        } else if !ids.insert(id.to_owned()) {
            problems.push(format!("{what}: two cells have this id"));
        }
        match cell.get("bounds").and_then(|b| finite_list(b, 4)) {
            Some(b) if b[0] < b[2] && b[1] < b[3] => {
                let (w, h) = (b[2] - b[0], b[3] - b[1]);
                if (w - h).abs() > 1e-6 * w.max(h) {
                    problems.push(format!("{what}: its bounds are not a square ({w} by {h})"));
                }
            }
            _ => problems.push(format!(
                "{what}: bounds must be [minX, minY, maxX, maxY], min below max"
            )),
        }
        check_range(
            cell.get("heights"),
            &format!("{what}: heights"),
            &mut problems,
        );
        let Some(lods) = cell.get("lods").and_then(Value::as_array) else {
            problems.push(format!("{what} has no levels of detail"));
            continue;
        };
        if lods.is_empty() || lods.len() > (MAX_LEVEL + 1) as usize {
            problems.push(format!("{what}: a cell has 1 to 8 levels of detail"));
        }
        let mut last_level: Option<u64> = None;
        let mut last_triangles: Option<u64> = None;
        for lod in lods {
            unknown_fields(lod, LOD_FIELDS, &what, &mut problems);
            let level = lod.get("level").and_then(Value::as_u64);
            match level {
                Some(level) if level <= MAX_LEVEL => {
                    if last_level.is_some_and(|last| level <= last) {
                        problems.push(format!(
                            "{what}: its levels must be finest first, each once"
                        ));
                    }
                    last_level = Some(level);
                }
                _ => problems.push(format!("{what}: a level must be 0 to 7")),
            }
            if let Some(triangles) = lod.get("triangles") {
                match triangles.as_u64() {
                    Some(t) => {
                        if last_triangles.is_some_and(|last| t > last) {
                            problems.push(format!("{what}: a coarser level has more triangles"));
                        }
                        last_triangles = Some(t);
                    }
                    None => problems.push(format!("{what}: triangles must be a whole number")),
                }
            }
            match lod.get("file") {
                Some(file) => name_file(file, &what, &mut problems),
                None => problems.push(format!("{what}: a level has no file")),
            }
        }
    }
    problems
}

fn read_list(folder: &Path, name: &str) -> Result<Vec<Value>, String> {
    let path = folder.join(name);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text =
        fs::read_to_string(&path).map_err(|error| format!("{name} cannot be read: {error}"))?;
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(Value::Array(list)) => Ok(list),
        Ok(_) => Err(format!("{name} is not a list")),
        Err(error) => Err(format!("{name} is not JSON: {error}")),
    }
}

/// What `check_pack` found.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackCheck {
    /// Maps with a scene.
    pub scenes: usize,
    pub cells: usize,
    pub files: usize,
    pub bytes: u64,
    pub floors: usize,
    pub heights: usize,
    pub problems: Vec<String>,
}

/// Checks the 3D side of a pack folder: every map's scene and its files,
/// the layers' `heights` and the locations' `height`.
pub fn check_pack(folder: &Path) -> PackCheck {
    let mut out = PackCheck::default();
    let maps = match read_list(folder, "maps.json") {
        Ok(maps) => maps,
        Err(error) => {
            out.problems.push(error);
            return out;
        }
    };
    let mut files = HashSet::new();
    for map in &maps {
        let Some(scene) = map.get("scene") else {
            continue;
        };
        let id = map.get("id").and_then(Value::as_str).unwrap_or("?");
        out.scenes += 1;
        if map.get("worldTransform").is_none() {
            out.problems.push(format!(
                "map {id}: a map with a scene must have a worldTransform"
            ));
        }
        out.cells += scene
            .get("cells")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        for problem in check_scene(scene, Some(folder), &mut files) {
            out.problems.push(format!("map {id}: {problem}"));
        }
    }
    for name in &files {
        if let Ok(metadata) = fs::metadata(folder.join(name)) {
            out.files += 1;
            out.bytes += metadata.len();
        }
    }
    match read_list(folder, "layers.json") {
        Ok(layers) => {
            for layer in &layers {
                if let Some(heights) = layer.get("heights") {
                    out.floors += 1;
                    let id = layer.get("id").and_then(Value::as_str).unwrap_or("?");
                    check_range(
                        Some(heights),
                        &format!("layer {id}: heights"),
                        &mut out.problems,
                    );
                }
            }
        }
        Err(error) => out.problems.push(error),
    }
    match read_list(folder, "locations.json") {
        Ok(locations) => {
            for location in &locations {
                if let Some(height) = location.get("height") {
                    out.heights += 1;
                    if !height.as_f64().is_some_and(f64::is_finite) {
                        let id = location.get("id").and_then(Value::as_str).unwrap_or("?");
                        out.problems
                            .push(format!("location {id}: height must be a number"));
                    }
                }
            }
        }
        Err(error) => out.problems.push(error),
    }
    out
}
