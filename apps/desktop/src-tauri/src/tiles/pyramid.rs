//! Pyramid maths and the download plan of a pack: which tiles each layer
//! has, where each one is saved and which remote tile it is a copy of.
//!
//! The level maths match `pyramidLevel` in `@atlas/core`: level `z` of a
//! layer shows the map image at scale `2^(z - maxZoom)`, rounded up to whole
//! pixels, cut into `tileSize` tiles.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The tile grid of one pyramid level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LevelGrid {
    pub z: u8,
    pub columns: u64,
    pub rows: u64,
}

impl LevelGrid {
    pub fn tiles(&self) -> u64 {
        self.columns * self.rows
    }
}

/// Columns and rows of level `z` of a `width` x `height` image whose
/// full-resolution level is `max_zoom`.
pub fn level_grid(width: u32, height: u32, tile_size: u32, max_zoom: u8, z: u8) -> LevelGrid {
    let scale = 2f64.powi(i32::from(z) - i32::from(max_zoom));
    let level_width = (f64::from(width) * scale).ceil().max(1.0);
    let level_height = (f64::from(height) * scale).ceil().max(1.0);
    let tile = f64::from(tile_size);
    // The values are small positive whole numbers, so the casts are exact.
    LevelGrid {
        z,
        columns: (level_width / tile).ceil() as u64,
        rows: (level_height / tile).ceil() as u64,
    }
}

/// Fills `{z}`, `{x}` and `{y}` in a tile URL template.
pub fn fill_template(template: &str, z: u64, x: u64, y: u64) -> String {
    template
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string())
}

/// Whether one segment of a pack-relative path is safe to use on disk: no
/// traversal, hidden files, empty segments, or anything a platform could
/// read as a separator, drive or device prefix. The pack protocol applies the
/// same rule to request paths.
pub fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty() && !segment.starts_with('.') && !segment.contains(['\\', ':', '\0'])
}

/// A pack-relative `/` path as a relative file path, or `None` if any of its
/// segments is unsafe.
pub fn relative_path(path: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for segment in path.split('/') {
        if !is_safe_segment(segment) {
            return None;
        }
        out.push(segment);
    }
    Some(out)
}

/// Whether a remote URL template may be downloaded from: `https`, or plain
/// `http` on this computer only (127.0.0.1 or localhost), which tests and
/// local mirrors use. The pack schema applies the same rule.
pub fn is_allowed_remote(template: &str) -> bool {
    let Some(rest) = template
        .strip_prefix("https://")
        .or_else(|| template.strip_prefix("http://"))
    else {
        return false;
    };
    if template.starts_with("http://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let name = host.rsplit_once(':').map_or(host, |(name, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) {
                name
            } else {
                host
            }
        });
        if name != "127.0.0.1" && name != "localhost" {
            return false;
        }
    }
    ["{z}", "{x}", "{y}"]
        .iter()
        .all(|part| template.contains(part))
}

/// One level of a layer that is a copy of a remote level.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLevel {
    pub z: u8,
    pub source_z: u8,
    pub offset_x: u64,
    pub offset_y: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDef {
    url_template: String,
    levels: Vec<RemoteLevel>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TileSourceDef {
    Xyz {
        url: String,
        remote: Option<RemoteDef>,
    },
    Pmtiles {},
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerDef {
    id: String,
    map_id: String,
    name: String,
    tiles: TileSourceDef,
    min_zoom: u8,
    max_zoom: u8,
    tile_size: u32,
}

#[derive(Deserialize)]
struct MapDef {
    id: String,
    name: String,
    width: u32,
    height: u32,
}

/// How much of the pyramid to download.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Detail {
    /// Two levels short of the top: a quick download, blurry close up.
    Overview,
    /// One level short of the top: about a quarter of the full download.
    Standard,
    /// Every level.
    Full,
}

impl Detail {
    pub const ALL: [Detail; 3] = [Detail::Overview, Detail::Standard, Detail::Full];

    /// Levels left out at the top of each layer.
    pub fn levels_short(self) -> u8 {
        match self {
            Detail::Overview => 2,
            Detail::Standard => 1,
            Detail::Full => 0,
        }
    }
}

/// A layer whose tiles can be downloaded.
#[derive(Clone, Debug)]
pub struct LayerPlan {
    pub layer_id: String,
    /// The local part of the layer id (`<game>:layer:<local>`), used in file names.
    pub local_id: String,
    pub layer_name: String,
    pub map_id: String,
    pub map_name: String,
    /// The layer's own tile URL template, relative to the pack root.
    pub url: String,
    pub url_template: String,
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// Remote levels, lowest first, consecutive, ending at `max_zoom`.
    pub levels: Vec<RemoteLevel>,
}

/// One tile of a layer to fetch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TileRef {
    pub z: u8,
    pub x: u64,
    pub y: u64,
}

impl LayerPlan {
    pub fn grid(&self, z: u8) -> LevelGrid {
        level_grid(self.width, self.height, self.tile_size, self.max_zoom, z)
    }

    /// The lowest level that is downloaded; levels below it are built.
    pub fn first_remote_z(&self) -> u8 {
        self.levels[0].z
    }

    /// The highest level a download at `detail` fetches.
    pub fn top_for(&self, detail: Detail) -> u8 {
        self.max_zoom
            .saturating_sub(detail.levels_short())
            .max(self.first_remote_z())
    }

    /// The remote levels up to and including `top`, lowest first.
    pub fn remote_levels(&self, top: u8) -> impl Iterator<Item = &RemoteLevel> {
        self.levels.iter().filter(move |level| level.z <= top)
    }

    /// The levels made by shrinking, highest first.
    pub fn built_levels(&self) -> impl Iterator<Item = u8> {
        (self.min_zoom..self.first_remote_z()).rev()
    }

    /// Number of remote tiles up to `top`.
    pub fn remote_tile_count(&self, top: u8) -> u64 {
        self.remote_levels(top)
            .map(|level| self.grid(level.z).tiles())
            .sum()
    }

    /// Every tile of level `z`, row by row.
    pub fn tiles_of(&self, z: u8) -> impl Iterator<Item = TileRef> {
        let grid = self.grid(z);
        (0..grid.rows).flat_map(move |y| (0..grid.columns).map(move |x| TileRef { z, x, y }))
    }

    /// The tiles of remote level `level` in the order they are asked for:
    /// the middle of the map first. Tiles that share a remote parent (the
    /// 2 x 2 tiles one remote zoom up covers) are kept together, and these
    /// groups go outwards from the middle of the level by their distance
    /// from it, measured in proportion to the level's width and height;
    /// within a group, the tile nearest the middle comes first. Ties go top
    /// to bottom, then left to right, so the order is the same on every run
    /// and a resumed job goes on where it stopped.
    ///
    /// The middle comes first because it is the part of a map most likely
    /// to exist on the server; the edges of a padded grid often do not.
    /// Keeping a parent's tiles together means that, where the parent
    /// exists, at least one tile of each group exists too.
    pub fn tiles_centre_out(&self, level: &RemoteLevel) -> Vec<TileRef> {
        let grid = self.grid(level.z);
        let (columns, rows) = (i128::from(grid.columns), i128::from(grid.rows));
        let (offset_x, offset_y) = (i128::from(level.offset_x), i128::from(level.offset_y));
        // Twice the local position of the middle of the 2 x 2 group a
        // remote coordinate belongs to; doubled to stay in whole numbers.
        let middle = |remote: u64, offset: i128| {
            let group = i128::from(remote / 2);
            4 * group - 2 * offset + 2
        };
        // (dx / columns)^2 + (dy / rows)^2, scaled to whole numbers.
        let distance = |dx: i128, dy: i128| {
            (dx * dx * rows * rows + dy * dy * columns * columns).unsigned_abs()
        };
        let mut tiles: Vec<((u128, u64, u64, u128), TileRef)> = self
            .tiles_of(level.z)
            .map(|tile| {
                let (remote_x, remote_y) = (tile.x + level.offset_x, tile.y + level.offset_y);
                let group = distance(
                    middle(remote_x, offset_x) - columns,
                    middle(remote_y, offset_y) - rows,
                );
                let own = distance(
                    2 * i128::from(tile.x) + 1 - columns,
                    2 * i128::from(tile.y) + 1 - rows,
                );
                ((group, remote_y / 2, remote_x / 2, own), tile)
            })
            .collect();
        tiles.sort_by(|(a, ta), (b, tb)| (a, ta.y, ta.x).cmp(&(b, tb.y, tb.x)));
        tiles.into_iter().map(|(_, tile)| tile).collect()
    }

    /// The tile one remote zoom up that covers tile (`x`, `y`) of `level`:
    /// its parent, when the layer lists that level (remote zoom one lower,
    /// local level one lower) and the parent lies in that level's grid.
    pub fn parent_of(&self, level: &RemoteLevel, x: u64, y: u64) -> Option<TileRef> {
        let parent = self
            .levels
            .iter()
            .find(|p| p.z + 1 == level.z && p.source_z + 1 == level.source_z)?;
        let px = ((x + level.offset_x) / 2).checked_sub(parent.offset_x)?;
        let py = ((y + level.offset_y) / 2).checked_sub(parent.offset_y)?;
        let grid = self.grid(parent.z);
        (px < grid.columns && py < grid.rows).then_some(TileRef {
            z: parent.z,
            x: px,
            y: py,
        })
    }

    /// The remote URL of a tile of a remote level.
    pub fn remote_url(&self, level: &RemoteLevel, x: u64, y: u64) -> String {
        fill_template(
            &self.url_template,
            u64::from(level.source_z),
            x + level.offset_x,
            y + level.offset_y,
        )
    }

    /// Where a tile lives, relative to the pack root (and to the overlay).
    pub fn tile_path(&self, z: u8, x: u64, y: u64) -> PathBuf {
        relative_path(&fill_template(&self.url, u64::from(z), x, y))
            .expect("layer URL templates are checked when the plan is read")
    }

    /// The image format of the layer's tiles, from its URL's extension.
    pub fn format(&self) -> TileFormat {
        TileFormat::from_path(&self.url)
    }
}

/// Image formats the downscaler writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileFormat {
    Jpeg,
    Png,
    Webp,
}

impl TileFormat {
    pub fn from_path(path: &str) -> TileFormat {
        let extension = path
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_ascii_lowercase());
        match extension.as_deref() {
            Some("png") => TileFormat::Png,
            Some("webp") => TileFormat::Webp,
            _ => TileFormat::Jpeg,
        }
    }

    /// A rough size of one tile, for estimates before any tile is on disk.
    pub fn typical_bytes(self) -> u64 {
        match self {
            TileFormat::Jpeg => 30_000,
            TileFormat::Png => 70_000,
            TileFormat::Webp => 25_000,
        }
    }
}

/// The downloadable layers of a pack.
#[derive(Clone, Debug)]
pub struct PackPlan {
    pub layers: Vec<LayerPlan>,
    /// Maps that have downloadable layers, in pack order: (id, name).
    pub maps: Vec<(String, String)>,
}

impl PackPlan {
    /// The detail levels worth offering: those that differ from each other.
    pub fn details(&self) -> Vec<Detail> {
        let mut out: Vec<Detail> = Vec::new();
        for detail in Detail::ALL {
            let tops: Vec<u8> = self.layers.iter().map(|l| l.top_for(detail)).collect();
            if let Some(previous) = out.last() {
                let previous_tops: Vec<u8> =
                    self.layers.iter().map(|l| l.top_for(*previous)).collect();
                if previous_tops == tops {
                    out.pop();
                }
            }
            out.push(detail);
        }
        out
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{} is not valid: {error}", path.display()))
}

/// Reads the downloadable layers from a pack folder's `maps.json` and
/// `layers.json`. Layers without a usable `remote` are left out; a layer
/// whose `remote` is unusable is an error, so a broken pack is reported
/// rather than half downloaded.
pub fn read_pack_plan(pack_root: &Path) -> Result<PackPlan, String> {
    let maps: Vec<MapDef> = read_json(&pack_root.join("maps.json"))?;
    let layers: Vec<LayerDef> = read_json(&pack_root.join("layers.json"))?;
    let mut plan = PackPlan {
        layers: Vec::new(),
        maps: Vec::new(),
    };
    for layer in layers {
        let TileSourceDef::Xyz {
            url,
            remote: Some(remote),
        } = layer.tiles
        else {
            continue;
        };
        let map = maps
            .iter()
            .find(|map| map.id == layer.map_id)
            .ok_or_else(|| format!("layer {} names unknown map {}", layer.id, layer.map_id))?;
        let plan_layer = LayerPlan {
            local_id: layer.id.rsplit(':').next().unwrap_or_default().to_owned(),
            layer_id: layer.id,
            layer_name: layer.name,
            map_id: map.id.clone(),
            map_name: map.name.clone(),
            url,
            url_template: remote.url_template,
            width: map.width,
            height: map.height,
            tile_size: layer.tile_size,
            min_zoom: layer.min_zoom,
            max_zoom: layer.max_zoom,
            levels: remote.levels,
        };
        check_layer(&plan_layer)?;
        if !plan.maps.iter().any(|(id, _)| *id == plan_layer.map_id) {
            plan.maps
                .push((plan_layer.map_id.clone(), plan_layer.map_name.clone()));
        }
        plan.layers.push(plan_layer);
    }
    Ok(plan)
}

fn check_layer(layer: &LayerPlan) -> Result<(), String> {
    let fail = |reason: &str| Err(format!("layer {}: {reason}", layer.layer_id));
    if !is_safe_segment(&layer.local_id) {
        return fail("unusable layer id");
    }
    if !is_allowed_remote(&layer.url_template) {
        return fail("the remote URL must be https and contain {z}, {x} and {y}");
    }
    if relative_path(&fill_template(&layer.url, 0, 0, 0)).is_none()
        || !["{z}", "{x}", "{y}"]
            .iter()
            .all(|part| layer.url.contains(part))
    {
        return fail("the tile URL must be a relative {z}/{x}/{y} path inside the pack");
    }
    if !layer.tile_size.is_power_of_two() || !(64..=1024).contains(&layer.tile_size) {
        return fail("unusable tile size");
    }
    let (Some(first), Some(last)) = (layer.levels.first(), layer.levels.last()) else {
        return fail("no remote levels");
    };
    let consecutive = layer
        .levels
        .windows(2)
        .all(|pair| pair[1].z == pair[0].z + 1);
    if !consecutive
        || first.z < layer.min_zoom
        || last.z != layer.max_zoom
        || layer.min_zoom > layer.max_zoom
    {
        return fail("remote levels must be consecutive and end at maxZoom");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_grid_matches_pyramid_level() {
        // The same cases as pyramidLevel's tests in @atlas/core.
        assert_eq!(
            level_grid(600, 300, 256, 2, 2),
            LevelGrid {
                z: 2,
                columns: 3,
                rows: 2
            }
        );
        assert_eq!(
            level_grid(600, 300, 256, 2, 1),
            LevelGrid {
                z: 1,
                columns: 2,
                rows: 1
            }
        );
        assert_eq!(level_grid(600, 300, 256, 2, 0).tiles(), 1);
        assert_eq!(level_grid(8192, 8192, 256, 5, 3).tiles(), 64);
        assert_eq!(level_grid(8192, 8192, 256, 5, 5).tiles(), 32 * 32);
        // A tiny image still has one tile per level.
        assert_eq!(level_grid(10, 10, 256, 0, 0).tiles(), 1);
        // Odd sizes round up at every level.
        assert_eq!(level_grid(1000, 513, 256, 2, 2).columns, 4);
        assert_eq!(level_grid(1000, 513, 256, 2, 2).rows, 3);
        assert_eq!(level_grid(1000, 513, 256, 2, 1).rows, 2);
    }

    #[test]
    fn fills_templates_and_checks_paths() {
        assert_eq!(
            fill_template("https://tiles.example.com/{z}/{x}/{y}.jpg", 12, 40, 7),
            "https://tiles.example.com/12/40/7.jpg"
        );
        assert_eq!(fill_template("{z}-{z}/{x}", 1, 2, 3), "1-1/2");
        assert_eq!(
            relative_path("tiles/world/3/1/2.jpg"),
            Some(
                PathBuf::from("tiles")
                    .join("world")
                    .join("3")
                    .join("1")
                    .join("2.jpg")
            )
        );
        for bad in [
            "../x.jpg",
            "tiles/../x",
            "/abs",
            "tiles//x",
            "tiles/.hidden",
            "c:/x",
            "a\\b",
        ] {
            assert_eq!(relative_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn allows_https_and_loopback_http_only() {
        assert!(is_allowed_remote(
            "https://tiles.example.com/{z}/{x}/{y}.jpg"
        ));
        assert!(is_allowed_remote("http://127.0.0.1:4431/{z}/{x}/{y}.png"));
        assert!(is_allowed_remote("http://localhost/{z}/{x}/{y}.png"));
        assert!(!is_allowed_remote(
            "http://tiles.example.com/{z}/{x}/{y}.jpg"
        ));
        assert!(!is_allowed_remote(
            "http://127.0.0.1.example.com/{z}/{x}/{y}"
        ));
        assert!(!is_allowed_remote(
            "http://localhost.example.com:80/{z}/{x}/{y}"
        ));
        assert!(!is_allowed_remote("ftp://tiles.example.com/{z}/{x}/{y}"));
        assert!(!is_allowed_remote("https://tiles.example.com/{z}/{x}.jpg"));
    }

    fn layer() -> LayerPlan {
        LayerPlan {
            layer_id: "test:layer:world".into(),
            local_id: "world".into(),
            layer_name: "World".into(),
            map_id: "test:map:world".into(),
            map_name: "World".into(),
            url: "tiles/world/{z}/{x}/{y}.jpg".into(),
            url_template: "https://tiles.example.com/w/{z}/{x}/{y}.jpg".into(),
            width: 1000,
            height: 600,
            tile_size: 256,
            min_zoom: 0,
            max_zoom: 2,
            levels: vec![
                RemoteLevel {
                    z: 1,
                    source_z: 11,
                    offset_x: 100,
                    offset_y: 200,
                },
                RemoteLevel {
                    z: 2,
                    source_z: 12,
                    offset_x: 200,
                    offset_y: 400,
                },
            ],
        }
    }

    #[test]
    fn plans_remote_tiles_and_paths() {
        let layer = layer();
        check_layer(&layer).unwrap();
        assert_eq!(layer.first_remote_z(), 1);
        assert_eq!(layer.built_levels().collect::<Vec<_>>(), vec![0]);
        assert_eq!(layer.top_for(Detail::Full), 2);
        assert_eq!(layer.top_for(Detail::Standard), 1);
        // Never below the first remote level.
        assert_eq!(layer.top_for(Detail::Overview), 1);
        // Level 2: 1000 x 600 px -> 4 x 3 tiles; level 1: 500 x 300 -> 2 x 2.
        assert_eq!(layer.remote_tile_count(2), 12 + 4);
        assert_eq!(layer.remote_tile_count(1), 4);
        let tiles: Vec<TileRef> = layer.tiles_of(1).collect();
        assert_eq!(tiles.len(), 4);
        assert_eq!(tiles[1], TileRef { z: 1, x: 1, y: 0 });
        assert_eq!(
            layer.remote_url(&layer.levels[1], 3, 2),
            "https://tiles.example.com/w/12/203/402.jpg"
        );
        assert_eq!(
            layer.tile_path(2, 3, 2),
            PathBuf::from("tiles/world/2/3/2.jpg")
        );
        assert_eq!(layer.format(), TileFormat::Jpeg);
    }

    /// The test layer at 1536 x 1536: level 2 has 6 x 6 tiles, level 1 3 x 3.
    fn square_layer() -> LayerPlan {
        LayerPlan {
            width: 1536,
            height: 1536,
            ..layer()
        }
    }

    #[test]
    fn asks_for_the_middle_first_with_siblings_together() {
        let layer = square_layer();
        let order = layer.tiles_centre_out(&layer.levels[1]);
        let at = |tile: &TileRef| (tile.x, tile.y);
        // Every tile once.
        let mut seen: Vec<(u64, u64)> = order.iter().map(at).collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 36);
        // The middle group first, the corners last.
        assert_eq!(
            order[..4].iter().map(at).collect::<Vec<_>>(),
            vec![(2, 2), (3, 2), (2, 3), (3, 3)]
        );
        // Then the group above it, its tiles nearest the middle first.
        assert_eq!(
            order[4..8].iter().map(at).collect::<Vec<_>>(),
            vec![(2, 1), (3, 1), (2, 0), (3, 0)]
        );
        assert_eq!(
            order[32..].iter().map(at).collect::<Vec<_>>(),
            vec![(4, 4), (5, 4), (4, 5), (5, 5)]
        );
        // The same order on every run.
        assert_eq!(order, layer.tiles_centre_out(&layer.levels[1]));

        // With an odd offset, tiles still go in groups of one remote parent.
        let mut odd = square_layer();
        odd.levels[1].offset_x = 201;
        odd.levels[1].offset_y = 401;
        let order = odd.tiles_centre_out(&odd.levels[1]);
        let group = |tile: &TileRef| ((tile.x + 201) / 2, (tile.y + 401) / 2);
        let mut groups: Vec<(u64, u64)> = order.iter().map(group).collect();
        groups.dedup();
        let mut distinct = groups.clone();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(groups.len(), distinct.len(), "a group was split: {order:?}");
        // Four groups tie for the middle; the first of them comes first,
        // and in it the tile nearest the middle of the level.
        assert_eq!(
            order[..4].iter().map(at).collect::<Vec<_>>(),
            vec![(2, 2), (2, 1), (1, 2), (1, 1)]
        );
    }

    #[test]
    fn finds_the_parent_one_remote_zoom_up() {
        let layer = square_layer();
        let (lower, upper) = (&layer.levels[0], &layer.levels[1]);
        // Level 2 tile (3, 5) is remote (203, 405) at zoom 12; its parent is
        // remote (101, 202) at zoom 11, which is (1, 2) of level 1.
        assert_eq!(
            layer.parent_of(upper, 3, 5),
            Some(TileRef { z: 1, x: 1, y: 2 })
        );
        assert_eq!(
            layer.parent_of(upper, 0, 0),
            Some(TileRef { z: 1, x: 0, y: 0 })
        );
        // The lowest remote level has none.
        assert_eq!(layer.parent_of(lower, 1, 1), None);
        // Nor a tile whose parent lies outside the level below.
        let mut shifted = square_layer();
        shifted.levels[0].offset_x = 101;
        assert_eq!(shifted.parent_of(&shifted.levels[1], 0, 0), None);
        assert_eq!(
            shifted.parent_of(&shifted.levels[1], 2, 0),
            Some(TileRef { z: 1, x: 0, y: 0 })
        );
        // Nor when the level below is not one remote zoom lower.
        let mut gap = square_layer();
        gap.levels[0].source_z = 10;
        assert_eq!(gap.parent_of(&gap.levels[1], 3, 5), None);
    }

    #[test]
    fn rejects_broken_layers() {
        let mut bad = layer();
        bad.levels.pop();
        assert!(check_layer(&bad).is_err(), "must end at maxZoom");
        let mut bad = layer();
        bad.levels.swap(0, 1);
        assert!(check_layer(&bad).is_err(), "must be lowest first");
        let mut bad = layer();
        bad.url = "../tiles/{z}/{x}/{y}.jpg".into();
        assert!(check_layer(&bad).is_err(), "must stay in the pack");
        let mut bad = layer();
        bad.url_template = "http://tiles.example.com/{z}/{x}/{y}.jpg".into();
        assert!(check_layer(&bad).is_err(), "must be https");
    }

    #[test]
    fn offers_distinct_details() {
        let mut plan = PackPlan {
            layers: vec![layer()],
            maps: vec![],
        };
        // Overview and Standard both stop at level 1, so only one is offered.
        assert_eq!(plan.details(), vec![Detail::Standard, Detail::Full]);
        plan.layers[0].levels.insert(
            0,
            RemoteLevel {
                z: 0,
                source_z: 10,
                offset_x: 50,
                offset_y: 100,
            },
        );
        assert_eq!(
            plan.details(),
            vec![Detail::Overview, Detail::Standard, Detail::Full]
        );
    }

    #[test]
    fn reads_a_pack_plan() {
        let dir = std::env::temp_dir().join(format!("atlas-plan-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("maps.json"),
            r#"[{"id":"t:map:a","name":"A","width":1000,"height":600},
                {"id":"t:map:b","name":"B","width":512,"height":512}]"#,
        )
        .unwrap();
        fs::write(
            dir.join("layers.json"),
            r#"[{"id":"t:layer:a","mapId":"t:map:a","name":"A","minZoom":0,"maxZoom":2,"tileSize":256,
                 "tiles":{"type":"xyz","url":"tiles/a/{z}/{x}/{y}.jpg","remote":{
                   "urlTemplate":"https://tiles.example.com/{z}/{x}/{y}.jpg",
                   "levels":[{"z":2,"sourceZ":5,"offsetX":0,"offsetY":0}]}}},
                {"id":"t:layer:b","mapId":"t:map:b","name":"B","minZoom":0,"maxZoom":1,"tileSize":256,
                 "tiles":{"type":"pmtiles","url":"tiles/b.pmtiles"}}]"#,
        )
        .unwrap();
        let plan = read_pack_plan(&dir).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(plan.layers.len(), 1);
        assert_eq!(plan.layers[0].local_id, "a");
        assert_eq!(plan.layers[0].map_name, "A");
        assert_eq!(plan.maps, vec![("t:map:a".to_owned(), "A".to_owned())]);
    }
}
