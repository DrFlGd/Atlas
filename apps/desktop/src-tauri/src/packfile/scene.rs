//! 3D maps in a pack file (version 11 of the format): the model files a
//! map's `scene` names in `maps.json` (`scene/…`, see `scene.ts` in the
//! schema package and `docs/pack-file-format.md`).
//!
//! An export carries the levels of detail of each cell that its detail
//! picks ([`Detail::scene_levels`]) and the light model of what lies
//! around (`neighbours`), and writes `maps.json` again naming only what it
//! carries: a level whose file is not in the pack folder is left out, a
//! cell left with none is left out, and a scene left with no cell is left
//! out, so the map is shown in 2D. A file that carries a scene is version
//! 11. An import and a file read where it lies take only the model files
//! the file's own `maps.json` names, and only from version 11.

use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::Path,
};

use serde_json::Value;

use super::{read_json_capped, Detail, Entry, EntryData};
use crate::tiles::pyramid::relative_path;

pub use atlas_pack::{is_scene_file_name, MAX_SCENE_FILE_BYTES, VERSION_WITH_SCENES};

/// The pack's maps (`maps.json`).
pub const MAPS_FILE: &str = "maps.json";

/// What an export carries of a pack's 3D maps.
#[derive(Debug, Default)]
pub struct SceneExport {
    /// `maps.json` written again, when it names less than the pack's own.
    pub maps_json: Option<Vec<u8>>,
    /// The model files, stored in the file.
    pub files: Vec<Entry>,
    /// The maps that keep a scene.
    pub maps: BTreeSet<String>,
}

impl SceneExport {
    /// The bytes of its model files.
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|entry| entry.size).sum()
    }
}

/// The model files of a pack folder's 3D maps at `detail`, and its
/// `maps.json` cut down to them when that names less (see the module).
/// Nothing when the pack has no `maps.json` or no scene.
pub fn scene_export(root: &Path, detail: Detail) -> Result<SceneExport, String> {
    let path = root.join(MAPS_FILE);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(SceneExport::default());
    }
    let Value::Array(mut maps) =
        read_json_capped(&path, crate::library::MAX_PACK_FILE_BYTES as u64)?
    else {
        return Err(format!("The pack's {MAPS_FILE} is not a list."));
    };
    let mut out = SceneExport::default();
    let mut seen = HashSet::new();
    let mut changed = false;
    let mut carry = |file: &str, out: &mut SceneExport| -> bool {
        if !is_scene_file_name(file) {
            return false;
        }
        if !seen.insert(file.to_owned()) {
            return true;
        }
        let Some(relative) = relative_path(file) else {
            return false;
        };
        let on_disk = root.join(relative);
        match fs::symlink_metadata(&on_disk) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_SCENE_FILE_BYTES => {
                out.files.push(Entry {
                    name: file.to_owned(),
                    data: EntryData::File(on_disk),
                    size: metadata.len(),
                });
                true
            }
            _ => false,
        }
    };
    for map in &mut maps {
        let Some(object) = map.as_object_mut() else {
            continue;
        };
        let Some(scene) = object.get_mut("scene").and_then(Value::as_object_mut) else {
            continue;
        };
        if let Some(cells) = scene.get_mut("cells").and_then(Value::as_array_mut) {
            cells.retain_mut(|cell| {
                let Some(lods) = cell.get_mut("lods").and_then(Value::as_array_mut) else {
                    changed = true;
                    return false;
                };
                let levels: Vec<u8> = lods
                    .iter()
                    .filter_map(|lod| lod.get("level").and_then(Value::as_u64))
                    .filter_map(|level| u8::try_from(level).ok())
                    .collect();
                let kept = detail.scene_levels(&levels);
                let before = lods.len();
                lods.retain(|lod| {
                    let level = lod
                        .get("level")
                        .and_then(Value::as_u64)
                        .and_then(|level| u8::try_from(level).ok());
                    let file = lod.get("file").and_then(Value::as_str);
                    match (level, file) {
                        (Some(level), Some(file)) if kept.contains(&level) => carry(file, &mut out),
                        _ => false,
                    }
                });
                changed |= lods.len() != before;
                if lods.is_empty() {
                    changed = true;
                    return false;
                }
                true
            });
        }
        let neighbours = scene
            .get("neighbours")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(file) = neighbours {
            if !carry(&file, &mut out) {
                scene.remove("neighbours");
                changed = true;
            }
        }
        let has_cells = scene
            .get("cells")
            .and_then(Value::as_array)
            .is_some_and(|cells| !cells.is_empty());
        if has_cells {
            if let Some(id) = object.get("id").and_then(Value::as_str) {
                out.maps.insert(id.to_owned());
            }
        } else {
            object.remove("scene");
            changed = true;
        }
    }
    // The model files of a scene left out go out with it.
    if out.maps.is_empty() && !out.files.is_empty() {
        out.files.clear();
    }
    if changed {
        let mut bytes = serde_json::to_vec_pretty(&Value::Array(maps)).expect("JSON serialises");
        bytes.push(b'\n');
        out.maps_json = Some(bytes);
    }
    Ok(out)
}

/// The model files the text of a file's `maps.json` names, the only ones
/// the file may hold (see the module). Names that are not safe are left
/// out, so such an entry is refused.
pub fn named_scene_files(maps_json: &str) -> HashSet<String> {
    let Ok(Value::Array(maps)) =
        serde_json::from_str::<Value>(maps_json.trim_start_matches('\u{feff}'))
    else {
        return HashSet::new();
    };
    let mut files = HashSet::new();
    for scene in maps.iter().filter_map(|map| map.get("scene")) {
        let cells = scene.get("cells").and_then(Value::as_array);
        for lod in cells
            .into_iter()
            .flatten()
            .filter_map(|cell| cell.get("lods").and_then(Value::as_array))
            .flatten()
        {
            if let Some(file) = lod.get("file").and_then(Value::as_str) {
                files.insert(file.to_owned());
            }
        }
        if let Some(file) = scene.get("neighbours").and_then(Value::as_str) {
            files.insert(file.to_owned());
        }
    }
    files.retain(|file| is_scene_file_name(file));
    files
}
