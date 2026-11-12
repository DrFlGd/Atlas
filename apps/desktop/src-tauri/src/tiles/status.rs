//! The status file of a layer's downloaded tiles, which tells the map which
//! pyramid levels it can use.
//!
//! One file per layer at `<overlay>/offline-tiles/<layer local id>.json`,
//! served by the pack protocol as `<pack URL>/offline-tiles/<local id>.json`:
//!
//! ```json
//! { "format": "atlas-tile-status", "version": 1,
//!   "layerId": "demo:layer:surface",
//!   "levels": [0, 1, 2, 3],
//!   "nativeMinZoom": 0, "nativeMaxZoom": 3,
//!   "complete": false, "updatedAt": 1767225600000 }
//! ```
//!
//! `levels` lists every complete level. `nativeMinZoom` to `nativeMaxZoom` is
//! the unbroken run of complete levels from the layer's `minZoom` up, which
//! the map shows natively (Leaflet scales the top one beyond it); both are
//! null while the lowest level is not ready. `complete` is true once every
//! level of the layer is there.
//!
//! One case differs: after a pack update moved a layer's edges and its
//! images were renumbered (see `renumber`), most images are there while no
//! level may be complete, and the lowest levels can be new ones with nothing
//! downloaded yet. The range is then the unbroken run of levels that have
//! images, from the lowest such level up, so that the map goes on showing
//! them (Leaflet scales the lowest one for the levels below) until the next
//! download records complete levels again.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::pyramid::LayerPlan;

pub const STATUS_FORMAT: &str = "atlas-tile-status";
pub const STATUS_VERSION: u32 = 1;
/// Folder in the overlay that holds the status files.
pub const STATUS_DIR: &str = "offline-tiles";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayerStatus {
    pub format: String,
    pub version: u32,
    pub layer_id: String,
    pub levels: Vec<u8>,
    pub native_min_zoom: Option<u8>,
    pub native_max_zoom: Option<u8>,
    pub complete: bool,
    pub updated_at: u64,
}

/// The status file of a layer, inside a pack's overlay folder.
pub fn status_path(overlay: &Path, layer: &LayerPlan) -> PathBuf {
    overlay
        .join(STATUS_DIR)
        .join(format!("{}.json", layer.local_id))
}

/// The complete levels recorded for a layer; empty when there is no file
/// or it belongs to another layer.
pub fn read_levels(overlay: &Path, layer: &LayerPlan) -> BTreeSet<u8> {
    fs::read_to_string(status_path(overlay, layer))
        .ok()
        .and_then(|text| serde_json::from_str::<LayerStatus>(&text).ok())
        .filter(|status| status.layer_id == layer.layer_id && status.format == STATUS_FORMAT)
        .map(|status| status.levels.into_iter().collect())
        .unwrap_or_default()
}

/// The status for a set of complete levels.
pub fn status_for(layer: &LayerPlan, levels: &BTreeSet<u8>) -> LayerStatus {
    let mut native_max = None;
    for z in layer.min_zoom..=layer.max_zoom {
        if !levels.contains(&z) {
            break;
        }
        native_max = Some(z);
    }
    LayerStatus {
        format: STATUS_FORMAT.to_owned(),
        version: STATUS_VERSION,
        layer_id: layer.layer_id.clone(),
        levels: levels.iter().copied().collect(),
        native_min_zoom: native_max.map(|_| layer.min_zoom),
        native_max_zoom: native_max,
        complete: native_max == Some(layer.max_zoom),
        updated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
    }
}

/// Records more complete levels for a layer, atomically. Returns the levels
/// now recorded.
pub fn add_levels(
    overlay: &Path,
    layer: &LayerPlan,
    new_levels: impl IntoIterator<Item = u8>,
) -> std::io::Result<BTreeSet<u8>> {
    let mut levels = read_levels(overlay, layer);
    levels.extend(new_levels);
    write_levels(overlay, layer, &levels)?;
    Ok(levels)
}

/// Records exactly these complete levels for a layer, atomically, replacing
/// what was recorded.
pub fn write_levels(
    overlay: &Path,
    layer: &LayerPlan,
    levels: &BTreeSet<u8>,
) -> std::io::Result<()> {
    write_status(overlay, layer, &status_for(layer, levels))
}

/// Like [`write_levels`] for a layer whose images were renumbered: when the
/// lowest level is not complete, the map is told to show `shown`, the
/// unbroken run of levels (lowest, highest) that have images.
pub fn write_levels_showing(
    overlay: &Path,
    layer: &LayerPlan,
    levels: &BTreeSet<u8>,
    shown: Option<(u8, u8)>,
) -> std::io::Result<()> {
    let mut status = status_for(layer, levels);
    if let (None, Some((lowest, highest))) = (status.native_max_zoom, shown) {
        if layer.min_zoom <= lowest && lowest <= highest && highest <= layer.max_zoom {
            status.native_min_zoom = Some(lowest);
            status.native_max_zoom = Some(highest);
        }
    }
    write_status(overlay, layer, &status)
}

fn write_status(overlay: &Path, layer: &LayerPlan, status: &LayerStatus) -> std::io::Result<()> {
    let path = status_path(overlay, layer);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(status).expect("the status serialises");
    let part = path.with_extension("json.part");
    fs::write(&part, format!("{json}\n"))?;
    fs::rename(&part, &path)
}

/// Removes a layer's status file, so that no level counts as complete.
pub fn remove_status(overlay: &Path, layer: &LayerPlan) -> std::io::Result<()> {
    let path = status_path(overlay, layer);
    let _ = fs::remove_file(path.with_extension("json.part"));
    match fs::remove_file(&path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::{pyramid::RemoteLevel, store::tests::TempDir};

    fn layer() -> LayerPlan {
        LayerPlan {
            layer_id: "t:layer:a".into(),
            local_id: "a".into(),
            layer_name: "A".into(),
            map_id: "t:map:a".into(),
            map_name: "A".into(),
            url: "tiles/a/{z}/{x}/{y}.png".into(),
            url_template: "https://tiles.example.com/{z}/{x}/{y}.png".into(),
            width: 1024,
            height: 1024,
            tile_size: 256,
            min_zoom: 0,
            max_zoom: 2,
            levels: vec![RemoteLevel {
                z: 2,
                source_z: 2,
                offset_x: 0,
                offset_y: 0,
            }],
        }
    }

    #[test]
    fn native_range_is_the_unbroken_run_from_min_zoom() {
        let layer = layer();
        let status = status_for(&layer, &BTreeSet::from([1, 2]));
        assert_eq!(
            (status.native_min_zoom, status.native_max_zoom),
            (None, None)
        );
        let status = status_for(&layer, &BTreeSet::from([0, 1]));
        assert_eq!(
            (status.native_min_zoom, status.native_max_zoom),
            (Some(0), Some(1))
        );
        assert!(!status.complete);
        assert!(status_for(&layer, &BTreeSet::from([0, 1, 2])).complete);
    }

    #[test]
    fn records_levels_in_a_file() {
        let dir = TempDir::new("status");
        let layer = layer();
        assert!(read_levels(&dir.0, &layer).is_empty());
        add_levels(&dir.0, &layer, [1, 0]).unwrap();
        let levels = add_levels(&dir.0, &layer, [2]).unwrap();
        assert_eq!(levels, BTreeSet::from([0, 1, 2]));
        let text = fs::read_to_string(dir.0.join("offline-tiles/a.json")).unwrap();
        let status: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(status["format"], "atlas-tile-status");
        assert_eq!(status["layerId"], "t:layer:a");
        assert_eq!(status["levels"], serde_json::json!([0, 1, 2]));
        assert_eq!(status["nativeMaxZoom"], 2);
        assert_eq!(status["complete"], true);
    }
}
