//! Keeps a layer's downloaded map images when a new version of its pack
//! moves the layer's edges.
//!
//! An importer that sizes a map's image from what the map shows can give a
//! rebuilt pack a larger or shifted image: another size, another `maxZoom`,
//! other offsets in `tiles.remote.levels`. The images already downloaded are
//! named by the old layer's tile numbers, and they are still the same remote
//! tiles: the old tile (z, x, y) of a listed level is the remote tile
//! (sourceZ, x + offsetX, y + offsetY). When the new layer lists a level with
//! that remote zoom and the remote tile lies inside its image, the file (or
//! its `.404` marker) moves to its new number; otherwise it is removed. The
//! levels below the first listed one were made by shrinking, so they are
//! removed and made again from the moved images, and the status file is
//! written again from what is on disk: a level counts as complete only when
//! every one of its tiles is an image or a `.404` marker, so "Download map
//! images" offers the rest and fetches nothing that was kept. Until then
//! the status file tells the map to show the levels that have images (see
//! `status`): a new layout can list remote levels below the old lowest one,
//! of which nothing is downloaded yet.
//!
//! Only layers with a remote source before and after, with the same
//! `urlTemplate` and tile size, are renumbered (see [`moved_layers`]);
//! anything else is left as it was.
//!
//! **Crash safety.** A new tile number can be another tile's old one, so
//! nothing is renamed in place. The files go through a folder of the images
//! root that is never served, `.atlas/renumber/<layer local id>/`:
//!
//! 1. [`stage`] writes `journal.json` there with both layouts, and removes
//!    the layer's status file, so no level counts as complete meanwhile.
//! 2. It moves every file of the old layout into the folder under its old
//!    number (removing those without a place in the new layout, and the
//!    shrunk levels), then removes whatever is left at the new layout's tile
//!    paths, and records in the journal that this step is complete.
//! 3. The caller writes the new pack files.
//! 4. [`settle`] moves each staged file to its number in the layout the
//!    pack has on disk now, builds the shrunk levels again, writes the
//!    status file and removes the folder.
//!
//! When the process stops on the way, the next [`settle`] (at the next
//! import and at start-up) goes on from the journal: with the new layout on
//! disk it finishes, and when the pack files were never written it puts the
//! files back under their old numbers. A file is only ever at a path where
//! it belongs, or in the folder; anything lost is fetched again by the next
//! download.

use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    downscale::build_lower_levels,
    pyramid::{check_layer, LayerPlan, PackPlan, RemoteLevel, TileRef},
    status::{remove_status, status_path, write_levels_showing},
    store::{TileStore, MISSING_SUFFIX, PART_SUFFIX},
};
use crate::library::META_DIR;

/// The folder of unfinished renumberings, inside [`META_DIR`] of an images root.
const RENUMBER_DIR: &str = "renumber";
const JOURNAL_FILE: &str = "journal.json";
const JOURNAL_FORMAT: &str = "atlas-renumber";
const JOURNAL_VERSION: u32 = 1;
/// The staged files, as `<z>/<x>/<y>` and `<z>/<x>/<y>.404` by old number.
const STAGED_TILES: &str = "tiles";

/// What decides where a layer's tiles are: everything of a [`LayerPlan`]
/// but its names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub layer_id: String,
    pub url: String,
    pub url_template: String,
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub levels: Vec<RemoteLevel>,
}

impl Layout {
    pub fn of(layer: &LayerPlan) -> Self {
        Self {
            layer_id: layer.layer_id.clone(),
            url: layer.url.clone(),
            url_template: layer.url_template.clone(),
            width: layer.width,
            height: layer.height,
            tile_size: layer.tile_size,
            min_zoom: layer.min_zoom,
            max_zoom: layer.max_zoom,
            levels: layer.levels.clone(),
        }
    }

    /// The layer plan of a recorded layout, when it is a usable one: the
    /// journal is a file in a folder the person keeps, so it is checked like
    /// a pack's own layers.
    fn plan(&self) -> Option<LayerPlan> {
        let plan = LayerPlan {
            layer_id: self.layer_id.clone(),
            local_id: self
                .layer_id
                .rsplit(':')
                .next()
                .unwrap_or_default()
                .to_owned(),
            layer_name: String::new(),
            map_id: String::new(),
            map_name: String::new(),
            url: self.url.clone(),
            url_template: self.url_template.clone(),
            width: self.width,
            height: self.height,
            tile_size: self.tile_size,
            min_zoom: self.min_zoom,
            max_zoom: self.max_zoom,
            levels: self.levels.clone(),
        };
        check_layer(&plan).ok().map(|()| plan)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    format: String,
    version: u32,
    /// The layout the staged files are numbered by.
    from: Layout,
    /// The layout the new pack files give the layer.
    to: Layout,
    /// Every file of `from` is staged and `to`'s tile paths are clear.
    staged: bool,
    /// Files without a place in `to`, removed while staging.
    #[serde(default)]
    removed: u64,
    /// Images of the shrunk levels of `from`, removed while staging.
    #[serde(default)]
    shrunk: u64,
}

/// What became of one layer's images in one images root.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Renumbered {
    pub layer_id: String,
    /// Images now under their new numbers.
    pub moved: u64,
    /// "Not on the server" markers now under their new numbers.
    pub markers: u64,
    /// Images and markers removed because the new image does not have them.
    pub removed: u64,
    /// Images of the shrunk levels removed; they are made again.
    pub shrunk: u64,
    /// The pack on disk still has the old layout (its files were not
    /// written), so the images went back under their old numbers.
    pub put_back: bool,
    /// The pack on disk has a layout the files cannot be moved to (another
    /// remote source, or no such layer), so the staged files were dropped.
    pub dropped: bool,
    /// The complete levels recorded now.
    pub levels: BTreeSet<u8>,
    pub complete: bool,
    /// The levels that have images, lowest and highest of an unbroken run:
    /// what the map shows while the lowest level is not complete.
    pub shown: Option<(u8, u8)>,
}

/// The layers whose images move between two versions of a pack, as (old,
/// new): the same layer id with a remote source in both, the same remote URL
/// template and tile size, and another image size, zoom range or list of
/// remote levels. A layer whose only change is its own tile `url` is not
/// among them: `downscale::rebuild_moved_layers` deals with that.
pub fn moved_layers(before: &PackPlan, after: &PackPlan) -> Vec<(LayerPlan, LayerPlan)> {
    after
        .layers
        .iter()
        .filter_map(|to| {
            let from = before.layers.iter().find(|l| l.layer_id == to.layer_id)?;
            let same_source =
                from.url_template == to.url_template && from.tile_size == to.tile_size;
            let moved = from.levels != to.levels
                || from.width != to.width
                || from.height != to.height
                || from.min_zoom != to.min_zoom
                || from.max_zoom != to.max_zoom;
            (same_source && moved).then(|| (from.clone(), to.clone()))
        })
        .collect()
}

/// Where `from`'s tile (`z`, `x`, `y`) belongs in `to`: the same remote tile,
/// when `to` lists its remote zoom and it lies inside `to`'s image there.
pub fn target(from: &LayerPlan, to: &LayerPlan, z: u8, x: u64, y: u64) -> Option<TileRef> {
    let level = from.levels.iter().find(|level| level.z == z)?;
    let remote_x = x.checked_add(level.offset_x)?;
    let remote_y = y.checked_add(level.offset_y)?;
    let new = to
        .levels
        .iter()
        .find(|new| new.source_z == level.source_z)?;
    let new_x = remote_x.checked_sub(new.offset_x)?;
    let new_y = remote_y.checked_sub(new.offset_y)?;
    let grid = to.grid(new.z);
    (new_x < grid.columns && new_y < grid.rows).then_some(TileRef {
        z: new.z,
        x: new_x,
        y: new_y,
    })
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn renumber_root(root: &Path) -> PathBuf {
    root.join(META_DIR).join(RENUMBER_DIR)
}

fn staging_dir(root: &Path, layer: &LayerPlan) -> PathBuf {
    renumber_root(root).join(&layer.local_id)
}

fn staged_path(tiles: &Path, z: u8, x: u64, y: u64, suffix: &str) -> PathBuf {
    tiles
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{y}{suffix}"))
}

/// Removes a file; one that is not there is fine.
fn remove(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn is_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_dir())
}

/// Whether `root` has anything of `layer`: a status file, or an image or
/// marker at one of its tile paths.
pub fn has_files(root: &Path, layer: &LayerPlan) -> bool {
    if status_path(root, layer).exists() {
        return true;
    }
    // Most packs keep a layer's tiles in a folder of their own; when it is
    // not there, nothing else needs to be looked at.
    let prefix = layer.url.split("{z}").next().unwrap_or_default();
    let prefix = prefix.trim_end_matches('/');
    if prefix.contains(['{', '}']) {
        return true;
    }
    if !prefix.is_empty() && !root.join(prefix).exists() {
        return false;
    }
    (layer.min_zoom..=layer.max_zoom).any(|z| {
        layer.tiles_of(z).any(|tile| {
            let path = root.join(layer.tile_path(tile.z, tile.x, tile.y));
            is_file(&path) || is_file(&with_suffix(&path, MISSING_SUFFIX))
        })
    })
}

/// Whether `root` has renumberings that [`settle`] has not finished.
pub fn has_unsettled(root: &Path) -> bool {
    renumber_root(root).is_dir()
}

fn write_journal(dir: &Path, journal: &Journal) -> io::Result<()> {
    let path = dir.join(JOURNAL_FILE);
    let part = with_suffix(&path, PART_SUFFIX);
    let json = serde_json::to_string_pretty(journal).expect("the journal serialises");
    fs::write(&part, format!("{json}\n"))?;
    fs::rename(&part, &path)
}

fn read_journal(dir: &Path) -> Option<Journal> {
    let text = fs::read_to_string(dir.join(JOURNAL_FILE)).ok()?;
    serde_json::from_str::<Journal>(&text)
        .ok()
        .filter(|journal| journal.format == JOURNAL_FORMAT && journal.version == JOURNAL_VERSION)
}

/// Steps 1 and 2 (see the module documentation) for one layer whose images
/// in `root` go from layout `from` to `to`. Errs when a file cannot be moved
/// or removed; [`settle`] with the pack's current layout then puts back what
/// was staged.
pub fn stage(root: &Path, from: &LayerPlan, to: &LayerPlan) -> Result<(), String> {
    let dir = staging_dir(root, from);
    if dir.exists() {
        return Err(format!("{} holds an unfinished renumbering", dir.display()));
    }
    let tiles = dir.join(STAGED_TILES);
    let fail = |path: &Path, error: io::Error| format!("{}: {error}", path.display());
    fs::create_dir_all(&tiles).map_err(|error| fail(&tiles, error))?;
    let mut journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        version: JOURNAL_VERSION,
        from: Layout::of(from),
        to: Layout::of(to),
        staged: false,
        removed: 0,
        shrunk: 0,
    };
    write_journal(&dir, &journal).map_err(|error| fail(&dir, error))?;
    remove_status(root, from).map_err(|error| fail(&status_path(root, from), error))?;

    for level in &from.levels {
        for tile in from.tiles_of(level.z) {
            let image = root.join(from.tile_path(tile.z, tile.x, tile.y));
            let part = with_suffix(&image, PART_SUFFIX);
            remove(&part).map_err(|error| fail(&part, error))?;
            let keep = target(from, to, tile.z, tile.x, tile.y).is_some();
            for suffix in ["", MISSING_SUFFIX] {
                let file = with_suffix(&image, suffix);
                if !is_file(&file) {
                    continue;
                }
                if keep {
                    let staged = staged_path(&tiles, tile.z, tile.x, tile.y, suffix);
                    let parent = staged.parent().expect("has a parent");
                    fs::create_dir_all(parent).map_err(|error| fail(parent, error))?;
                    fs::rename(&file, &staged).map_err(|error| fail(&file, error))?;
                } else {
                    remove(&file).map_err(|error| fail(&file, error))?;
                    journal.removed += 1;
                }
            }
        }
    }
    for z in from.built_levels() {
        for tile in from.tiles_of(z) {
            let image = root.join(from.tile_path(tile.z, tile.x, tile.y));
            for suffix in [PART_SUFFIX, MISSING_SUFFIX] {
                let file = with_suffix(&image, suffix);
                remove(&file).map_err(|error| fail(&file, error))?;
            }
            if remove(&image).map_err(|error| fail(&image, error))? {
                journal.shrunk += 1;
            }
        }
    }
    // Whatever is still at the new layout's tile paths is none of these
    // images: it would show in the wrong place.
    clear(root, to)?;
    journal.staged = true;
    write_journal(&dir, &journal).map_err(|error| fail(&dir, error))
}

/// Removes every image, marker and part file at `layer`'s tile paths.
fn clear(root: &Path, layer: &LayerPlan) -> Result<(), String> {
    for z in layer.min_zoom..=layer.max_zoom {
        for tile in layer.tiles_of(z) {
            let image = root.join(layer.tile_path(tile.z, tile.x, tile.y));
            for suffix in ["", MISSING_SUFFIX, PART_SUFFIX] {
                let file = with_suffix(&image, suffix);
                remove(&file).map_err(|error| format!("{}: {error}", file.display()))?;
            }
        }
    }
    Ok(())
}

/// Step 4 (see the module documentation) for every renumbering staged in
/// `root`, against `current`, the layout the pack has on disk now. `bundled`
/// is the pack folder when `root` is that folder, so that tiles are read from
/// there too, as the downloader does. One result per staged layer.
pub fn settle(
    root: &Path,
    bundled: Option<&Path>,
    current: &PackPlan,
) -> Vec<Result<Renumbered, String>> {
    let base = renumber_root(root);
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut results = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            let _ = fs::remove_file(&dir);
            continue;
        }
        results.push(settle_layer(root, bundled, current, &dir));
    }
    let _ = fs::remove_dir(&base);
    results
}

fn settle_layer(
    root: &Path,
    bundled: Option<&Path>,
    current: &PackPlan,
    dir: &Path,
) -> Result<Renumbered, String> {
    let fail = |error: String| format!("{}: {error}", dir.display());
    let journal = read_journal(dir);
    let from = journal.as_ref().and_then(|journal| journal.from.plan());
    let (Some(journal), Some(from)) = (journal, from) else {
        fs::remove_dir_all(dir).map_err(|error| fail(error.to_string()))?;
        return Err(fail(
            "the record of the renumbering cannot be read, so its images were removed".to_owned(),
        ));
    };
    let mut report = Renumbered {
        layer_id: journal.from.layer_id.clone(),
        removed: journal.removed,
        shrunk: journal.shrunk,
        ..Renumbered::default()
    };
    let layer = current
        .layers
        .iter()
        .find(|layer| layer.layer_id == journal.from.layer_id);
    let tiles = dir.join(STAGED_TILES);
    let placed = match layer {
        // The pack files were not replaced: back to the old numbers. Files
        // still at their old paths (a stage that stopped halfway) are right.
        Some(layer) if Layout::of(layer) == journal.from => {
            report.put_back = true;
            place(root, &tiles, &from, layer, &mut report)
        }
        Some(layer) if journal.staged && Layout::of(layer) == journal.to => {
            place(root, &tiles, &from, layer, &mut report)
        }
        Some(layer)
            if journal.staged
                && layer.url_template == from.url_template
                && layer.tile_size == from.tile_size =>
        {
            // Yet another layout: its tile paths were not cleared.
            clear(root, layer).and_then(|()| place(root, &tiles, &from, layer, &mut report))
        }
        _ => {
            report.dropped = true;
            Ok(())
        }
    };
    placed.map_err(fail)?;
    if let Some(layer) = layer.filter(|_| !report.dropped) {
        finish(root, bundled, layer, &mut report).map_err(fail)?;
    }
    fs::remove_dir_all(dir).map_err(|error| fail(error.to_string()))?;
    Ok(report)
}

/// Moves the staged files, numbered by `from`, to their numbers in `to`.
fn place(
    root: &Path,
    tiles: &Path,
    from: &LayerPlan,
    to: &LayerPlan,
    report: &mut Renumbered,
) -> Result<(), String> {
    let fail = |path: &Path, error: io::Error| format!("{}: {error}", path.display());
    let numbered = |entry: &fs::DirEntry| entry.file_name().to_str().map(str::to_owned);
    let Ok(levels) = fs::read_dir(tiles) else {
        return Ok(());
    };
    for level in levels.flatten() {
        let Some(z) = numbered(&level).and_then(|name| name.parse::<u8>().ok()) else {
            continue;
        };
        let Ok(columns) = fs::read_dir(level.path()) else {
            continue;
        };
        for column in columns.flatten() {
            let Some(x) = numbered(&column).and_then(|name| name.parse::<u64>().ok()) else {
                continue;
            };
            let Ok(files) = fs::read_dir(column.path()) else {
                continue;
            };
            for file in files.flatten() {
                let Some(name) = numbered(&file) else {
                    continue;
                };
                let (number, marker) = match name.strip_suffix(MISSING_SUFFIX) {
                    Some(number) => (number, true),
                    None => (name.as_str(), false),
                };
                let staged = file.path();
                let Some(y) = number.parse::<u64>().ok() else {
                    continue;
                };
                let Some(tile) = target(from, to, z, x, y) else {
                    remove(&staged).map_err(|error| fail(&staged, error))?;
                    report.removed += 1;
                    continue;
                };
                let image = root.join(to.tile_path(tile.z, tile.x, tile.y));
                let parent = image.parent().expect("a tile path has a folder");
                fs::create_dir_all(parent).map_err(|error| fail(parent, error))?;
                if marker {
                    if is_file(&image) {
                        remove(&staged).map_err(|error| fail(&staged, error))?;
                    } else {
                        let missing = with_suffix(&image, MISSING_SUFFIX);
                        fs::rename(&staged, &missing).map_err(|error| fail(&missing, error))?;
                        report.markers += 1;
                    }
                } else {
                    fs::rename(&staged, &image).map_err(|error| fail(&image, error))?;
                    let missing = with_suffix(&image, MISSING_SUFFIX);
                    remove(&missing).map_err(|error| fail(&missing, error))?;
                    report.moved += 1;
                }
            }
        }
    }
    Ok(())
}

/// Builds the shrunk levels of `layer` again and records its complete levels.
fn finish(
    root: &Path,
    bundled: Option<&Path>,
    layer: &LayerPlan,
    report: &mut Renumbered,
) -> Result<(), String> {
    let store = TileStore::new(root.to_owned(), bundled.map(Path::to_owned));
    if layer.built_levels().next().is_some() {
        build_lower_levels(layer, &store, || true)?;
    }
    // A level is complete when every tile is an image or known not to be on
    // the server; the shrunk levels are when the level they come from is.
    let mut levels: BTreeSet<u8> = layer
        .levels
        .iter()
        .filter(|level| {
            layer
                .tiles_of(level.z)
                .all(|tile| store.is_done(&layer.tile_path(tile.z, tile.x, tile.y)))
        })
        .map(|level| level.z)
        .collect();
    if levels.contains(&layer.first_remote_z()) {
        levels.extend(layer.built_levels());
    }
    // While the lowest level is not complete, the map shows the levels that
    // have images: the new layout's lowest levels can be ones the old layout
    // did not have, with nothing downloaded yet.
    report.shown = shown_levels(root, bundled, layer);
    write_levels_showing(root, layer, &levels, report.shown)
        .map_err(|error| format!("could not write the status file: {error}"))?;
    report.complete = (layer.min_zoom..=layer.max_zoom).all(|z| levels.contains(&z));
    report.levels = levels;
    Ok(())
}

/// The unbroken run of `layer`'s levels that have at least one image, as
/// (lowest, highest), starting at the lowest level that has one.
fn shown_levels(root: &Path, bundled: Option<&Path>, layer: &LayerPlan) -> Option<(u8, u8)> {
    let has_image = |z: u8| {
        layer.tiles_of(z).any(|tile| {
            let relative = layer.tile_path(tile.z, tile.x, tile.y);
            root.join(&relative).is_file()
                || bundled.is_some_and(|pack| pack.join(&relative).is_file())
        })
    };
    let lowest = (layer.min_zoom..=layer.max_zoom).find(|&z| has_image(z))?;
    let highest = (lowest + 1..=layer.max_zoom)
        .take_while(|&z| has_image(z))
        .last()
        .unwrap_or(lowest);
    Some((lowest, highest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::{
        downscale::BACKGROUND,
        pyramid::read_pack_plan,
        status::{read_levels, write_levels},
        store::tests::TempDir,
    };
    use image::{Rgb, RgbImage};

    const SIZE: u32 = 64;

    /// A small PNG of one colour.
    fn png(colour: [u8; 3]) -> Vec<u8> {
        let mut out = io::Cursor::new(Vec::new());
        RgbImage::from_pixel(SIZE, SIZE, Rgb(colour))
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    /// The image of a remote tile: its colour says which one it is.
    fn remote(z: u8, x: u64, y: u64) -> Vec<u8> {
        png(colour(z, x, y))
    }

    fn colour(z: u8, x: u64, y: u64) -> [u8; 3] {
        [z * 10, (x % 25) as u8 * 10, (y % 25) as u8 * 10]
    }

    /// A layer of 64 px tiles whose remote levels are (z, sourceZ, offsetX, offsetY).
    fn layer(width: u32, height: u32, max_zoom: u8, levels: &[(u8, u8, u64, u64)]) -> LayerPlan {
        LayerPlan {
            layer_id: "t:layer:a".into(),
            local_id: "a".into(),
            layer_name: "Surface".into(),
            map_id: "t:map:a".into(),
            map_name: "Island".into(),
            url: "tiles/a/{z}/{x}/{y}.png".into(),
            url_template: "https://tiles.invalid/{z}/{x}/{y}.png".into(),
            width,
            height,
            tile_size: SIZE,
            min_zoom: 0,
            max_zoom,
            levels: levels
                .iter()
                .map(|&(z, source_z, offset_x, offset_y)| RemoteLevel {
                    z,
                    source_z,
                    offset_x,
                    offset_y,
                })
                .collect(),
        }
    }

    /// 320 x 320 px: level 3 (remote zoom 13) 5 x 5 tiles, level 2 (remote
    /// zoom 12) 3 x 3; levels 1 and 0 are made by shrinking.
    fn old_layer() -> LayerPlan {
        layer(320, 320, 3, &[(2, 12, 20, 40), (3, 13, 40, 80)])
    }

    fn plan(layer: &LayerPlan) -> PackPlan {
        PackPlan {
            layers: vec![layer.clone()],
            maps: vec![],
        }
    }

    fn path(root: &Path, layer: &LayerPlan, z: u8, x: u64, y: u64) -> PathBuf {
        root.join(layer.tile_path(z, x, y))
    }

    /// Downloads every tile of `layer` as the app does: remote levels from
    /// the "server", the shrunk ones built, the status file written. The
    /// remote tiles in `missing` are not on the server.
    fn download(root: &Path, layer: &LayerPlan, missing: &[(u8, u64, u64)]) {
        let store = TileStore::new(root.to_owned(), Some(root.to_owned()));
        for level in &layer.levels {
            for tile in layer.tiles_of(level.z) {
                let (x, y) = (tile.x + level.offset_x, tile.y + level.offset_y);
                let relative = layer.tile_path(tile.z, tile.x, tile.y);
                if missing.contains(&(level.source_z, x, y)) {
                    store.mark_missing(&relative).unwrap();
                } else {
                    store
                        .write(&relative, &remote(level.source_z, x, y))
                        .unwrap();
                }
            }
        }
        build_lower_levels(layer, &store, || true).unwrap();
        write_levels(root, layer, &(layer.min_zoom..=layer.max_zoom).collect()).unwrap();
    }

    /// Renumbers as an import does: stage, the new layout, settle.
    fn renumber(root: &Path, from: &LayerPlan, to: &LayerPlan) -> Renumbered {
        stage(root, from, to).unwrap();
        let mut results = settle(root, Some(root), &plan(to));
        assert_eq!(results.len(), 1);
        results.pop().unwrap().unwrap()
    }

    /// The remote tile each image of `layer`'s remote levels shows, checked
    /// by its colour, and the number of images.
    fn check_images(root: &Path, layer: &LayerPlan) -> u64 {
        let mut images = 0;
        for level in &layer.levels {
            for tile in layer.tiles_of(level.z) {
                let file = path(root, layer, tile.z, tile.x, tile.y);
                if let Ok(bytes) = fs::read(&file) {
                    let expected = remote(
                        level.source_z,
                        tile.x + level.offset_x,
                        tile.y + level.offset_y,
                    );
                    assert_eq!(bytes, expected, "{}", file.display());
                    images += 1;
                }
            }
        }
        images
    }

    fn pixel(file: &Path, x: u32, y: u32) -> [u8; 3] {
        image::open(file).unwrap().to_rgb8().get_pixel(x, y).0
    }

    fn close(a: [u8; 3], b: [u8; 3]) -> bool {
        a.iter().zip(b).all(|(a, b)| a.abs_diff(b) <= 6)
    }

    fn nothing_staged(root: &Path) {
        assert!(!has_unsettled(root), "the staging folder is gone");
        assert!(!root.join(".atlas/renumber").exists());
    }

    #[test]
    fn moves_images_to_their_new_numbers_when_the_origin_moves_up_and_left() {
        let dir = TempDir::new("renumber-origin");
        let root = &dir.0;
        let from = old_layer();
        // Two tiles more on the top and the left at level 3, one at level 2,
        // and two more on the other sides: 448 x 448 px, 7 x 7 and 4 x 4 tiles.
        let to = layer(448, 448, 3, &[(2, 12, 19, 39), (3, 13, 38, 78)]);
        download(root, &from, &[(13, 41, 81)]);
        assert!(has_files(root, &from));
        let before = fs::read(path(root, &from, 3, 0, 0)).unwrap();

        let done = renumber(root, &from, &to);
        nothing_staged(root);
        assert_eq!((done.moved, done.markers, done.removed), (33, 1, 0));
        assert_eq!(done.shrunk, 2 * 2 + 1);
        assert!(!done.put_back && !done.dropped);

        // Every image shows the remote tile its new number stands for. The
        // old tile (0, 0) is now (2, 2), whose old image is now at (4, 4): a
        // chain of renames through the staging folder.
        assert_eq!(check_images(root, &to), 33);
        assert_eq!(fs::read(path(root, &to, 3, 2, 2)).unwrap(), before);
        assert_eq!(
            fs::read(path(root, &to, 3, 4, 4)).unwrap(),
            remote(13, 42, 82)
        );
        assert!(
            !path(root, &to, 3, 0, 0).exists(),
            "a new tile, not there yet"
        );
        // The "not on the server" marker of remote (13, 41, 81) moved with it.
        assert!(with_suffix(&path(root, &to, 3, 3, 3), MISSING_SUFFIX).exists());
        assert!(!path(root, &to, 3, 3, 3).exists());
        assert!(!with_suffix(&path(root, &to, 3, 1, 1), MISSING_SUFFIX).exists());

        // Level 1 was made again: its tile (0, 0) covers level 2's (0, 0),
        // (1, 0), (0, 1) (new, empty) and (1, 1), the old (0, 0).
        let shrunk = path(root, &to, 1, 0, 0);
        let [r, g, b, _] = BACKGROUND.0;
        assert!(close(pixel(&shrunk, 8, 8), [r, g, b]));
        assert!(close(pixel(&shrunk, 56, 8), [r, g, b]));
        assert!(close(pixel(&shrunk, 56, 56), colour(12, 20, 40)));
        assert!(path(root, &to, 0, 0, 0).exists());

        // The new tiles are not there, so no level is complete any more.
        assert!(done.levels.is_empty());
        assert!(!done.complete);
        assert!(read_levels(root, &to).is_empty());
        let status: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(status_path(root, &to)).unwrap()).unwrap();
        assert_eq!(status["complete"], false);
        // Every level has images, so the map goes on showing them all.
        assert_eq!(done.shown, Some((0, 3)));
        assert_eq!(status["nativeMinZoom"], 0);
        assert_eq!(status["nativeMaxZoom"], 3);
        assert_eq!(status["levels"], serde_json::json!([]));
    }

    #[test]
    fn records_complete_levels_when_nothing_new_is_missing() {
        let dir = TempDir::new("renumber-shrink");
        let root = &dir.0;
        let from = old_layer();
        // Two tiles less on the left at level 3 (one at level 2): 192 x 320
        // px, level 3 is 3 x 5 tiles, level 2 is 2 x 3.
        let to = layer(192, 320, 3, &[(2, 12, 21, 40), (3, 13, 42, 80)]);
        download(root, &from, &[(13, 40, 80)]);
        let done = renumber(root, &from, &to);
        nothing_staged(root);
        // Level 3 loses its first two columns (one of them a marker), level 2
        // its first column.
        assert_eq!(done.removed, 2 * 5 + 3);
        assert_eq!((done.moved, done.markers), (3 * 5 + 2 * 3, 0));
        assert_eq!(check_images(root, &to), 21);
        assert!(
            !path(root, &from, 3, 4, 0).exists(),
            "outside the new image"
        );
        assert!(!with_suffix(&path(root, &from, 3, 0, 0), MISSING_SUFFIX).exists());
        // Everything of the smaller image is there: every level is complete.
        assert_eq!(done.levels, BTreeSet::from([0, 1, 2, 3]));
        assert!(done.complete);
        assert_eq!(read_levels(root, &to), BTreeSet::from([0, 1, 2, 3]));
    }

    #[test]
    fn follows_a_layer_whose_top_level_goes_up_by_one() {
        let dir = TempDir::new("renumber-zoom");
        let root = &dir.0;
        let from = old_layer();
        // The same remote zooms one level higher (a larger image that needs
        // one more level), and remote zoom 11 is listed too: 576 x 576 px,
        // level 4 is 9 x 9, level 3 5 x 5, level 2 3 x 3.
        let to = layer(
            576,
            576,
            4,
            &[(2, 11, 10, 20), (3, 12, 20, 40), (4, 13, 40, 80)],
        );
        download(root, &from, &[]);
        let done = renumber(root, &from, &to);
        nothing_staged(root);
        assert_eq!((done.moved, done.removed), (25 + 9, 0));
        assert_eq!(check_images(root, &to), 34);
        assert_eq!(
            fs::read(path(root, &to, 4, 4, 4)).unwrap(),
            remote(13, 44, 84)
        );
        // Level 2 is remote zoom 11 now; nothing of it is downloaded. Old
        // level 2 images were shrunk ones of level 3: removed.
        assert!(!path(root, &to, 2, 0, 0).exists());
        assert!(!path(root, &to, 1, 0, 0).exists());
        assert!(done.levels.is_empty());
        // Nothing is complete and levels 0 to 2 have no image yet: the map
        // is told to show levels 3 and 4, scaling level 3 for those below.
        assert_eq!(done.shown, Some((3, 4)));
        let status: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(status_path(root, &to)).unwrap()).unwrap();
        assert_eq!(status["nativeMinZoom"], 3);
        assert_eq!(status["nativeMaxZoom"], 4);
        assert_eq!(status["complete"], false);
        assert_eq!(status["levels"], serde_json::json!([]));
        assert!(read_levels(root, &to).is_empty());
    }

    #[test]
    fn puts_the_images_back_when_the_pack_files_were_not_written() {
        let dir = TempDir::new("renumber-back");
        let root = &dir.0;
        let from = old_layer();
        let to = layer(448, 448, 3, &[(2, 12, 19, 39), (3, 13, 38, 78)]);
        download(root, &from, &[(13, 41, 81)]);
        stage(root, &from, &to).unwrap();
        assert!(has_unsettled(root));
        assert!(!path(root, &from, 3, 0, 0).exists(), "set aside");
        assert!(
            read_levels(root, &from).is_empty(),
            "nothing complete meanwhile"
        );
        // A second stage of the same layer is refused while one is pending.
        assert!(stage(root, &from, &to).is_err());

        let done = settle(root, Some(root), &plan(&from))
            .pop()
            .unwrap()
            .unwrap();
        nothing_staged(root);
        assert!(done.put_back);
        assert_eq!((done.moved, done.markers), (33, 1));
        assert_eq!(check_images(root, &from), 33);
        assert!(with_suffix(&path(root, &from, 3, 1, 1), MISSING_SUFFIX).exists());
        assert_eq!(done.levels, BTreeSet::from([0, 1, 2, 3]));
        assert!(path(root, &from, 0, 0, 0).exists(), "built again");
    }

    #[test]
    fn puts_back_what_a_stage_that_stopped_halfway_set_aside() {
        let dir = TempDir::new("renumber-halfway");
        let root = &dir.0;
        let from = old_layer();
        let to = layer(448, 448, 3, &[(2, 12, 19, 39), (3, 13, 38, 78)]);
        download(root, &from, &[]);
        stage(root, &from, &to).unwrap();
        // As if the app had stopped while staging: the journal says the stage
        // is not complete, and some images are still at their old paths.
        let staging = staging_dir(root, &from);
        let mut journal = read_journal(&staging).unwrap();
        journal.staged = false;
        write_journal(&staging, &journal).unwrap();
        for x in 0..5 {
            let staged = staged_path(&staging.join(STAGED_TILES), 3, x, 4, "");
            fs::rename(&staged, path(root, &from, 3, x, 4)).unwrap();
        }
        let done = settle(root, Some(root), &plan(&from))
            .pop()
            .unwrap()
            .unwrap();
        nothing_staged(root);
        assert!(done.put_back);
        assert_eq!(check_images(root, &from), 34);
        assert_eq!(read_levels(root, &from), BTreeSet::from([0, 1, 2, 3]));
    }

    #[test]
    fn finishes_after_stopping_while_placing_the_images() {
        let dir = TempDir::new("renumber-placing");
        let root = &dir.0;
        let from = old_layer();
        let to = layer(448, 448, 3, &[(2, 12, 19, 39), (3, 13, 38, 78)]);
        download(root, &from, &[]);
        stage(root, &from, &to).unwrap();
        // The new pack files are written, and some images were placed before
        // the app stopped.
        let staging = staging_dir(root, &from);
        for x in 0..5 {
            let staged = staged_path(&staging.join(STAGED_TILES), 3, x, 0, "");
            let image = path(root, &to, 3, x + 2, 2);
            fs::create_dir_all(image.parent().unwrap()).unwrap();
            fs::rename(&staged, image).unwrap();
        }
        // As at the next start: the pack on disk has the new layout.
        let done = settle(root, Some(root), &plan(&to)).pop().unwrap().unwrap();
        nothing_staged(root);
        assert!(!done.put_back);
        assert_eq!(done.moved, 34 - 5);
        assert_eq!(check_images(root, &to), 34);
        assert!(path(root, &to, 0, 0, 0).exists());
    }

    #[test]
    fn drops_the_set_aside_images_when_the_layer_is_gone() {
        let dir = TempDir::new("renumber-gone");
        let root = &dir.0;
        let from = old_layer();
        let to = layer(448, 448, 3, &[(2, 12, 19, 39), (3, 13, 38, 78)]);
        download(root, &from, &[]);
        stage(root, &from, &to).unwrap();
        let empty = PackPlan {
            layers: vec![],
            maps: vec![],
        };
        let done = settle(root, Some(root), &empty).pop().unwrap().unwrap();
        assert!(done.dropped);
        nothing_staged(root);
        assert_eq!(check_images(root, &from), 0);

        // A journal that cannot be read is removed with what it set aside.
        download(root, &from, &[]);
        stage(root, &from, &to).unwrap();
        fs::write(staging_dir(root, &from).join(JOURNAL_FILE), "{").unwrap();
        assert!(settle(root, Some(root), &plan(&to)).pop().unwrap().is_err());
        nothing_staged(root);
        assert_eq!(check_images(root, &to), 0, "nothing at a wrong place");
    }

    #[test]
    fn renumbers_only_layers_whose_edges_move_on_the_same_source() {
        let from = old_layer();
        let same = plan(&from);
        assert!(moved_layers(&same, &same).is_empty());
        let wider = layer(448, 320, 3, &[(2, 12, 20, 40), (3, 13, 40, 80)]);
        assert_eq!(moved_layers(&same, &plan(&wider)).len(), 1);
        let shifted = layer(320, 320, 3, &[(2, 12, 19, 40), (3, 13, 38, 80)]);
        assert_eq!(moved_layers(&same, &plan(&shifted)).len(), 1);
        // Another image source: nothing can be mapped.
        let mut elsewhere = wider.clone();
        elsewhere.url_template = "https://tiles.invalid/v2/{z}/{x}/{y}.png".into();
        assert!(moved_layers(&same, &plan(&elsewhere)).is_empty());
        let mut bigger_tiles = wider.clone();
        bigger_tiles.tile_size = 128;
        assert!(moved_layers(&same, &plan(&bigger_tiles)).is_empty());
        // Only the tile address in the pack: left to `rebuild_moved_layers`.
        let mut moved_folder = from.clone();
        moved_folder.url = "tiles/a/{z}/{y}/{x}.png".into();
        assert!(moved_layers(&same, &plan(&moved_folder)).is_empty());
        // Another layer, or one without a remote source (not in the plan).
        let mut other = wider.clone();
        other.layer_id = "t:layer:b".into();
        assert!(moved_layers(&same, &plan(&other)).is_empty());
        let empty = PackPlan {
            layers: vec![],
            maps: vec![],
        };
        assert!(moved_layers(&same, &empty).is_empty());
    }

    #[test]
    fn reads_the_layers_a_pack_will_have() {
        let dir = TempDir::new("renumber-plan");
        let maps = r#"[{"id":"t:map:a","name":"Island","width":320,"height":320}]"#;
        let layers = r#"[{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":3,"tileSize":64,
            "tiles":{"type":"xyz","url":"tiles/a/{z}/{x}/{y}.png","remote":{
              "urlTemplate":"https://tiles.invalid/{z}/{x}/{y}.png",
              "levels":[{"z":2,"sourceZ":12,"offsetX":20,"offsetY":40},{"z":3,"sourceZ":13,"offsetX":40,"offsetY":80}]}}}]"#;
        fs::write(dir.0.join("maps.json"), maps).unwrap();
        fs::write(dir.0.join("layers.json"), layers).unwrap();
        let parsed = crate::tiles::pyramid::parse_pack_plan(maps, layers).unwrap();
        let read = read_pack_plan(&dir.0).unwrap();
        assert_eq!(Layout::of(&parsed.layers[0]), Layout::of(&read.layers[0]));
        assert_eq!(Layout::of(&read.layers[0]), Layout::of(&old_layer()));
        assert!(!has_files(&dir.0, &old_layer()));
    }
}
