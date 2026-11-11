//! Keeping map images that the person's own browsing of a map page loaded.
//!
//! The page window hands over response bodies with the URL they were asked
//! for (see `script.rs`). This module decides which of them are map images
//! of the pack, and writes those where "Download map images" would have
//! written them:
//!
//! - A URL is a map image only when it is exactly a URL the downloader would
//!   request: the remote URL template of one of the pack's own layers, filled
//!   in with whole numbers, for a remote level the layer lists, inside the
//!   layer's tile grid. Both sides are compared in the standard form of a web
//!   address (as browsers write it), so `HTTPS://Host/a` and `https://host/a`
//!   are the same. Everything else is ignored.
//! - The bytes must be a JPEG, PNG or WebP image whose header can be read,
//!   at most `MAX_IMAGE_BYTES` long.
//! - A tile already on disk that is a readable image is never replaced, so a
//!   good file is never overwritten with a smaller or broken one. A file at
//!   that place that is not an image is replaced.
//! - Files are written through a `.part` file and a rename, only below the
//!   pack folder, never through a symbolic link.
//! - The levels a person cannot have loaded by hand (the ones the downloader
//!   builds by shrinking) are built from the saved tiles, tile by tile, as the
//!   downloader would; the status files and the manifest's image summary are
//!   updated the same way.

use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::{self, Cursor},
    path::{Path, PathBuf},
};

use tauri::Url;

use crate::{
    manifest::{update_images, ImagesUpdate},
    tiles::{
        downscale::downscale,
        pyramid::{fill_template, relative_path, LayerPlan, PackPlan},
        status::{add_levels, read_levels},
        store::{TileStore, MISSING_SUFFIX, PART_SUFFIX},
    },
};

/// Larger answers are not a map image (the downloader uses the same limit).
pub const MAX_IMAGE_BYTES: usize = 16 << 20;
/// Images wider or taller than this are not a map tile.
const MAX_IMAGE_SIDE: u32 = 4096;

// ---------------------------------------------------------------------------
// Which URLs are map images

#[derive(Clone, Debug, PartialEq, Eq)]
enum Part {
    Text(String),
    /// `{z}`, `{x}` or `{y}`: index 0, 1 or 2.
    Number(usize),
}

/// Stand-ins for the placeholders while a template is put in standard form.
/// Letters and underscores come through URL parsing unchanged.
const MARKERS: [&str; 3] = ["__atlasz__", "__atlasx__", "__atlasy__"];
const PLACEHOLDERS: [&str; 3] = ["{z}", "{x}", "{y}"];

/// A web address in standard form, without a fragment, or `None`.
pub fn standard_url(text: &str) -> Option<String> {
    let mut url = Url::parse(text).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_fragment(None);
    Some(url.into())
}

/// Splits a remote URL template, in standard form, into text and numbers.
fn parse_template(template: &str) -> Option<Vec<Part>> {
    let mut marked = template.to_owned();
    for (placeholder, marker) in PLACEHOLDERS.iter().zip(MARKERS) {
        marked = marked.replace(placeholder, marker);
    }
    let standard = standard_url(&marked)?;
    let mut parts = Vec::new();
    let mut rest = standard.as_str();
    let mut seen = [false; 3];
    loop {
        let next = MARKERS
            .iter()
            .enumerate()
            .filter_map(|(index, marker)| rest.find(marker).map(|at| (at, index)))
            .min();
        let Some((at, index)) = next else {
            if !rest.is_empty() {
                parts.push(Part::Text(rest.to_owned()));
            }
            break;
        };
        if at > 0 {
            parts.push(Part::Text(rest[..at].to_owned()));
        }
        parts.push(Part::Number(index));
        seen[index] = true;
        rest = &rest[at + MARKERS[index].len()..];
    }
    seen.iter().all(|&s| s).then_some(parts)
}

/// Matches `text` against template parts, filling `values`, and asks
/// `accept` about each complete reading until it says yes (a template such
/// as `{z}{x}` can be read more than one way). Numbers are written as the
/// downloader writes them: plain digits, no leading zeros.
fn match_parts(
    parts: &[Part],
    text: &str,
    values: &mut [Option<u64>; 3],
    accept: &mut dyn FnMut([u64; 3]) -> bool,
) -> bool {
    let Some((first, rest)) = parts.split_first() else {
        return match *values {
            [Some(z), Some(x), Some(y)] if text.is_empty() => accept([z, x, y]),
            _ => false,
        };
    };
    match first {
        Part::Text(literal) => text
            .strip_prefix(literal.as_str())
            .is_some_and(|after| match_parts(rest, after, values, accept)),
        Part::Number(index) => {
            let digits = text.bytes().take_while(u8::is_ascii_digit).count().min(12);
            for len in (1..=digits).rev() {
                if len > 1 && text.starts_with('0') {
                    continue;
                }
                let Ok(value) = text[..len].parse::<u64>() else {
                    continue;
                };
                if values[*index].is_some_and(|known| known != value) {
                    continue;
                }
                let before = values[*index];
                values[*index] = Some(value);
                if match_parts(rest, &text[len..], values, accept) {
                    return true;
                }
                values[*index] = before;
            }
            false
        }
    }
}

/// One tile of one of the pack's layers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileHit {
    /// Index of the layer in the pack plan.
    pub layer: usize,
    pub z: u8,
    pub x: u64,
    pub y: u64,
}

/// Finds the tile a remote URL is a copy of.
pub struct TileMatcher {
    plan: PackPlan,
    patterns: Vec<Option<Vec<Part>>>,
}

impl TileMatcher {
    pub fn new(plan: PackPlan) -> Self {
        let patterns = plan
            .layers
            .iter()
            .map(|layer| parse_template(&layer.url_template))
            .collect();
        Self { plan, patterns }
    }

    pub fn plan(&self) -> &PackPlan {
        &self.plan
    }

    /// The fixed start of each layer's remote URLs, for the page to set
    /// aside responses that could be map images. The final decision is
    /// [`TileMatcher::find`]'s.
    pub fn prefixes(&self) -> Vec<String> {
        let mut prefixes: Vec<String> = self
            .patterns
            .iter()
            .flatten()
            .filter_map(|parts| match parts.first() {
                Some(Part::Text(text)) => Some(text.clone()),
                _ => None,
            })
            .collect();
        prefixes.sort();
        prefixes.dedup();
        prefixes
    }

    /// The tile `url` is a copy of, if it is exactly a URL the downloader
    /// would request for one of the pack's layers.
    pub fn find(&self, url: &str) -> Option<TileHit> {
        let url = standard_url(url)?;
        for (index, (layer, parts)) in self.plan.layers.iter().zip(&self.patterns).enumerate() {
            let Some(parts) = parts else { continue };
            let mut found = None;
            match_parts(parts, &url, &mut [None; 3], &mut |[z, x, y]| {
                found = locate(layer, z, x, y);
                found.is_some()
            });
            if let Some((z, x, y)) = found {
                return Some(TileHit {
                    layer: index,
                    z,
                    x,
                    y,
                });
            }
        }
        None
    }
}

/// The layer tile that a remote tile is, if the layer lists its level and it
/// falls inside the layer's grid.
fn locate(
    layer: &LayerPlan,
    source_z: u64,
    source_x: u64,
    source_y: u64,
) -> Option<(u8, u64, u64)> {
    layer.levels.iter().find_map(|level| {
        if u64::from(level.source_z) != source_z {
            return None;
        }
        let x = source_x.checked_sub(level.offset_x)?;
        let y = source_y.checked_sub(level.offset_y)?;
        let grid = layer.grid(level.z);
        (x < grid.columns && y < grid.rows).then_some((level.z, x, y))
    })
}

// ---------------------------------------------------------------------------
// Whether bytes are an image

/// Why an answer was not kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    TooLarge,
    NotAnImage,
}

/// Checks that bytes are a JPEG, PNG or WebP image whose size can be read.
pub fn check_image(bytes: &[u8]) -> Result<(), Refusal> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(Refusal::TooLarge);
    }
    let format = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        image::ImageFormat::Jpeg
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        image::ImageFormat::Png
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        image::ImageFormat::WebP
    } else {
        return Err(Refusal::NotAnImage);
    };
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| Refusal::NotAnImage)?;
    if width == 0 || height == 0 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
        return Err(Refusal::NotAnImage);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Writing

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Written {
    /// A new file with this many bytes.
    Saved(u64),
    /// A readable image was there already; it was left as it is.
    AlreadyHad,
}

#[derive(Debug)]
pub enum WriteError {
    Refused(Refusal),
    /// The place is not inside the pack folder, or goes through a link.
    Unsafe,
    Disk(io::Error),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(Refusal::TooLarge) => write!(f, "too large for a map image"),
            Self::Refused(Refusal::NotAnImage) => write!(f, "not an image"),
            Self::Unsafe => write!(f, "the place for it is not a plain folder in the pack"),
            Self::Disk(error) => write!(f, "{error}"),
        }
    }
}

/// Where a tile of a layer is kept, relative to the pack folder.
pub fn tile_relative(layer: &LayerPlan, z: u8, x: u64, y: u64) -> Option<PathBuf> {
    relative_path(&fill_template(&layer.url, u64::from(z), x, y))
}

/// Whether every folder from `root` down to the file's folder is a real
/// folder (or not there yet), never a symbolic link, and the file itself is
/// not a link or a folder.
fn plain_path(root: &Path, relative: &Path) -> bool {
    let mut path = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let std::path::Component::Normal(name) = component else {
            return false;
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => return false,
            Ok(meta) if meta.file_type().is_symlink() => return false,
            Ok(meta) if components.peek().is_some() && !meta.is_dir() => return false,
            Ok(meta) if components.peek().is_none() && !meta.is_file() => return false,
            Ok(_) => {}
        }
    }
    true
}

/// Whether the file at `path` is a readable image of an allowed type.
fn is_good_image(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_IMAGE_BYTES as u64 => {
            fs::read(path).is_ok_and(|bytes| check_image(&bytes).is_ok())
        }
        _ => false,
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Writes one captured tile into the pack folder `root`.
pub fn write_tile(
    root: &Path,
    layer: &LayerPlan,
    hit: &TileHit,
    bytes: &[u8],
) -> Result<Written, WriteError> {
    let relative = tile_relative(layer, hit.z, hit.x, hit.y).ok_or(WriteError::Unsafe)?;
    if !plain_path(root, &relative) {
        return Err(WriteError::Unsafe);
    }
    let file = root.join(&relative);
    if is_good_image(&file) {
        return Ok(Written::AlreadyHad);
    }
    check_image(bytes).map_err(WriteError::Refused)?;
    let store = TileStore::new(root.to_path_buf(), None);
    store.write(&relative, bytes).map_err(WriteError::Disk)?;
    // The server had no tile here when the downloader asked; now there is one.
    let _ = fs::remove_file(with_suffix(&file, MISSING_SUFFIX));
    Ok(Written::Saved(bytes.len() as u64))
}

/// Whether the pack already has a readable image for a tile.
pub fn has_tile(root: &Path, layer: &LayerPlan, hit: &TileHit) -> bool {
    tile_relative(layer, hit.z, hit.x, hit.y)
        .is_some_and(|relative| plain_path(root, &relative) && is_good_image(&root.join(relative)))
}

// ---------------------------------------------------------------------------
// Levels, status files and the manifest

/// Builds the tiles of the shrunk levels above saved tiles of a layer's
/// lowest remote level: for each saved tile, its parent on every level
/// below, from the four tiles above it, as the downloader builds them.
/// `saved` holds (x, y) on the lowest remote level.
pub fn build_parents(
    root: &Path,
    layer: &LayerPlan,
    saved: &BTreeSet<(u64, u64)>,
) -> Result<(), String> {
    let store = TileStore::new(root.to_path_buf(), Some(root.to_path_buf()));
    let format = layer.format();
    let mut tiles: BTreeSet<(u64, u64)> = saved.clone();
    for z in layer.built_levels() {
        tiles = tiles.iter().map(|&(x, y)| (x / 2, y / 2)).collect();
        let grid = layer.grid(z);
        for &(x, y) in &tiles {
            if x >= grid.columns || y >= grid.rows {
                continue;
            }
            let Some(relative) = tile_relative(layer, z, x, y) else {
                continue;
            };
            if !plain_path(root, &relative) {
                continue;
            }
            let children = [(0, 0), (1, 0), (0, 1), (1, 1)].map(|(dx, dy)| {
                tile_relative(layer, z + 1, x * 2 + dx, y * 2 + dy)
                    .and_then(|child| store.read(&child))
            });
            if children.iter().all(Option::is_none) {
                continue;
            }
            let bytes = downscale(&children, layer.tile_size, format)?;
            store
                .write(&relative, &bytes)
                .map_err(|error| format!("could not save a map image: {error}"))?;
        }
    }
    Ok(())
}

/// The levels of a layer whose every tile is on disk (or known to be
/// missing on the server), lowest first. The shrunk levels count once the
/// lowest remote level is complete, since they are built from it.
pub fn complete_levels(root: &Path, layer: &LayerPlan) -> Vec<u8> {
    let store = TileStore::new(root.to_path_buf(), None);
    let mut levels = Vec::new();
    for level in &layer.levels {
        let complete = layer.tiles_of(level.z).all(|tile| {
            tile_relative(layer, tile.z, tile.x, tile.y)
                .is_some_and(|relative| store.is_done(&relative))
        });
        if complete {
            if level.z == layer.first_remote_z() {
                levels.extend(layer.built_levels());
            }
            levels.push(level.z);
        }
    }
    levels.sort_unstable();
    levels
}

/// Records newly complete levels in a layer's status file. Levels already
/// recorded stay recorded. Returns whether the file changed.
pub fn record_levels(root: &Path, layer: &LayerPlan) -> io::Result<bool> {
    let recorded = read_levels(root, layer);
    let new: Vec<u8> = complete_levels(root, layer)
        .into_iter()
        .filter(|z| !recorded.contains(z))
        .collect();
    if new.is_empty() {
        return Ok(false);
    }
    add_levels(root, layer, new)?;
    Ok(true)
}

/// The image files of a layer in a pack folder, and their bytes, counted as
/// the downloader counts them.
pub fn count_images(root: &Path, layer: &LayerPlan) -> (u64, u64) {
    fn walk(dir: &Path, totals: &mut (u64, u64)) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&entry.path(), totals);
            } else if kind.is_file() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.ends_with(MISSING_SUFFIX) && !name.ends_with(PART_SUFFIX) {
                    totals.0 += 1;
                    totals.1 += entry.metadata().map_or(0, |m| m.len());
                }
            }
        }
    }
    let prefix = layer.url.split("{z}").next().unwrap_or_default();
    let mut totals = (0, 0);
    if let Some(relative) = relative_path(prefix.trim_end_matches('/')) {
        walk(&root.join(relative), &mut totals);
    }
    totals
}

/// Updates the image summary of the given layers in the pack's manifest.
pub fn record_manifest(root: &Path, plan: &PackPlan, layers: &BTreeSet<usize>) {
    let updates: Vec<ImagesUpdate<'_>> = layers
        .iter()
        .filter_map(|&index| plan.layers.get(index))
        .map(|layer| {
            let levels = read_levels(root, layer);
            ImagesUpdate {
                layer_id: &layer.layer_id,
                complete: (layer.min_zoom..=layer.max_zoom).all(|z| levels.contains(&z)),
                levels: levels.into_iter().collect(),
                counts: Some(count_images(root, layer)),
            }
        })
        .collect();
    if updates.is_empty() {
        return;
    }
    if let Err(error) = update_images(root, &updates) {
        eprintln!("atlas: {error}");
    }
}

/// What has been written since the status files were last brought up to
/// date: the layers touched, and the saved tiles of each layer's lowest
/// remote level, whose shrunk parents need building.
#[derive(Default)]
pub struct Pending {
    pub layers: BTreeSet<usize>,
    pub lowest: HashMap<usize, BTreeSet<(u64, u64)>>,
}

impl Pending {
    pub fn add(&mut self, plan: &PackPlan, hit: &TileHit) {
        self.layers.insert(hit.layer);
        if let Some(layer) = plan.layers.get(hit.layer) {
            if hit.z == layer.first_remote_z() {
                self.lowest
                    .entry(hit.layer)
                    .or_default()
                    .insert((hit.x, hit.y));
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }

    /// Builds shrunk tiles, records complete levels and updates the
    /// manifest. Returns whether a status file changed.
    pub fn flush(&mut self, root: &Path, plan: &PackPlan) -> bool {
        let mut changed = false;
        for (&index, saved) in &self.lowest {
            if let Some(layer) = plan.layers.get(index) {
                if let Err(error) = build_parents(root, layer, saved) {
                    eprintln!("atlas: {error}");
                }
            }
        }
        for &index in &self.layers {
            let Some(layer) = plan.layers.get(index) else {
                continue;
            };
            match record_levels(root, layer) {
                Ok(true) => changed = true,
                Ok(false) => {}
                Err(error) => eprintln!("atlas: could not record map image levels: {error}"),
            }
        }
        record_manifest(root, plan, &self.layers);
        *self = Self::default();
        changed
    }
}

// ---------------------------------------------------------------------------
// Base64, as the page hands bytes over

/// Decodes standard base64 with padding. `None` for anything else.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        Some(u32::from(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        }))
    }
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let padding = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return None;
        }
        let mut word = 0u32;
        for &byte in &chunk[..4 - padding] {
            word = (word << 6) | value(byte)?;
        }
        word <<= 6 * padding as u32;
        let decoded = [(word >> 16) as u8, (word >> 8) as u8, word as u8];
        out.extend_from_slice(&decoded[..3 - padding]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::{pyramid::RemoteLevel, store::tests::TempDir};
    use image::{Rgb, RgbImage};

    fn png(color: [u8; 3]) -> Vec<u8> {
        let image = RgbImage::from_pixel(256, 256, Rgb(color));
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn jpeg() -> Vec<u8> {
        let image = RgbImage::from_pixel(16, 16, Rgb([1, 2, 3]));
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
        out.into_inner()
    }

    /// A 1000 x 600 map whose levels 1 and 2 are remote zooms 11 and 12,
    /// offset by 100/200 and 200/400 tiles; level 0 is built.
    fn layer(template: &str) -> LayerPlan {
        LayerPlan {
            layer_id: "test:layer:world".into(),
            local_id: "world".into(),
            layer_name: "World".into(),
            map_id: "test:map:world".into(),
            map_name: "World".into(),
            url: "tiles/world/{z}/{x}/{y}.png".into(),
            url_template: template.into(),
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

    fn matcher(templates: &[&str]) -> TileMatcher {
        TileMatcher::new(PackPlan {
            layers: templates.iter().map(|t| layer(t)).collect(),
            maps: vec![],
        })
    }

    #[test]
    fn matches_exactly_the_urls_the_downloader_would_request() {
        let m = matcher(&["https://tiles.example.com/w/{z}/{x}/{y}.png?v=2"]);
        let hit = |url: &str| m.find(url);
        assert_eq!(
            hit("https://tiles.example.com/w/12/203/402.png?v=2"),
            Some(TileHit {
                layer: 0,
                z: 2,
                x: 3,
                y: 2
            })
        );
        assert_eq!(
            hit("https://tiles.example.com/w/11/101/201.png?v=2"),
            Some(TileHit {
                layer: 0,
                z: 1,
                x: 1,
                y: 1
            })
        );
        // The same address written differently.
        assert!(hit("HTTPS://Tiles.Example.COM:443/w/12/203/402.png?v=2#here").is_some());
        assert!(hit("https://tiles.example.com/w/./12/203/402.png?v=2").is_some());
        for other in [
            // Outside the grid: level 2 is 4 x 3 tiles, from 200/400.
            "https://tiles.example.com/w/12/204/402.png?v=2",
            "https://tiles.example.com/w/12/203/403.png?v=2",
            "https://tiles.example.com/w/12/199/402.png?v=2",
            // A zoom the layer does not list.
            "https://tiles.example.com/w/13/203/402.png?v=2",
            // Anything else about the address.
            "https://tiles.example.com/w/12/203/402.png",
            "https://tiles.example.com/w/12/203/402.png?v=3",
            "https://tiles.example.com/w/12/203/402.jpg?v=2",
            "http://tiles.example.com/w/12/203/402.png?v=2",
            "https://cdn.example.com/w/12/203/402.png?v=2",
            "https://tiles.example.com/x/12/203/402.png?v=2",
            "https://tiles.example.com/w/12/0203/402.png?v=2",
            "https://tiles.example.com/w/12/-1/402.png?v=2",
            "https://tiles.example.com/w/12/203/402.png?v=2&extra=1",
            "https://tiles.example.com/w/12/ab/402.png?v=2",
            "https://tiles.example.com/w/icons/marker.png",
            "not a url",
            "data:image/png;base64,AAAA",
            "blob:https://tiles.example.com/123",
        ] {
            assert_eq!(hit(other), None, "{other}");
        }
        assert_eq!(
            m.prefixes(),
            vec!["https://tiles.example.com/w/".to_owned()]
        );
    }

    #[test]
    fn matches_unusual_templates() {
        // Placeholders in another order, next to each other's digits, and twice.
        let m = matcher(&["https://t.example.com/{y}-{x}/z{z}/{x}.webp"]);
        assert_eq!(
            m.find("https://t.example.com/402-203/z12/203.webp"),
            Some(TileHit {
                layer: 0,
                z: 2,
                x: 3,
                y: 2
            })
        );
        assert_eq!(m.find("https://t.example.com/402-203/z12/202.webp"), None);
        let m = matcher(&["http://127.0.0.1:4431/{z}{x}/{y}.png"]);
        // "12" + "203" could split several ways; only one fits a listed zoom.
        assert_eq!(
            m.find("http://127.0.0.1:4431/12203/402.png"),
            Some(TileHit {
                layer: 0,
                z: 2,
                x: 3,
                y: 2
            })
        );
        // Several layers: the first whose template and grid fit.
        let m = matcher(&[
            "https://a.example.com/{z}/{x}/{y}.png",
            "https://b.example.com/{z}/{x}/{y}.png",
        ]);
        assert_eq!(
            m.find("https://b.example.com/11/100/200.png")
                .unwrap()
                .layer,
            1
        );
        assert_eq!(m.prefixes().len(), 2);
    }

    #[test]
    fn accepts_only_real_images() {
        assert!(check_image(&png([1, 2, 3])).is_ok());
        assert!(check_image(&jpeg()).is_ok());
        let mut webp = Cursor::new(Vec::new());
        RgbImage::from_pixel(8, 8, Rgb([9, 9, 9]))
            .write_to(&mut webp, image::ImageFormat::WebP)
            .unwrap();
        assert!(check_image(&webp.into_inner()).is_ok());
        assert_eq!(check_image(b""), Err(Refusal::NotAnImage));
        assert_eq!(
            check_image(b"<!doctype html><title>Sign in</title>"),
            Err(Refusal::NotAnImage)
        );
        // The right first bytes, but nothing readable after them.
        assert_eq!(
            check_image(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
            Err(Refusal::NotAnImage)
        );
        assert_eq!(
            check_image(&[0xff, 0xd8, 0xff, 0xe0]),
            Err(Refusal::NotAnImage)
        );
        let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";
        assert_eq!(check_image(gif), Err(Refusal::NotAnImage));
        let mut huge = png([1, 1, 1]);
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(check_image(&huge), Err(Refusal::TooLarge));
    }

    #[test]
    fn writes_tiles_where_the_downloader_would_and_never_replaces_good_ones() {
        let dir = TempDir::new("capture-write");
        let root = dir.0.join("pack");
        fs::create_dir_all(&root).unwrap();
        let layer = layer("https://tiles.example.com/{z}/{x}/{y}.png");
        let hit = TileHit {
            layer: 0,
            z: 2,
            x: 3,
            y: 2,
        };
        let first = png([10, 20, 30]);
        assert_eq!(
            write_tile(&root, &layer, &hit, &first).unwrap(),
            Written::Saved(first.len() as u64)
        );
        let file = root.join("tiles/world/2/3/2.png");
        assert_eq!(fs::read(&file).unwrap(), first);
        assert!(!with_suffix(&file, PART_SUFFIX).exists());
        assert!(has_tile(&root, &layer, &hit));

        // A good file stays, whatever comes later.
        let other = png([200, 0, 0]);
        assert_eq!(
            write_tile(&root, &layer, &hit, &other).unwrap(),
            Written::AlreadyHad
        );
        assert_eq!(
            write_tile(&root, &layer, &hit, b"tiny").unwrap(),
            Written::AlreadyHad
        );
        assert_eq!(fs::read(&file).unwrap(), first);

        // Not an image: refused, nothing written.
        let next = TileHit { x: 2, ..hit };
        assert!(matches!(
            write_tile(&root, &layer, &next, b"<html>no</html>"),
            Err(WriteError::Refused(Refusal::NotAnImage))
        ));
        assert!(!root.join("tiles/world/2/2/2.png").exists());

        // A broken file is replaced; a "missing on the server" mark is removed.
        fs::write(root.join("tiles/world/2/3/1.png"), b"broken").unwrap();
        fs::write(root.join("tiles/world/2/3/0.png.404"), b"").unwrap();
        for y in [0, 1] {
            let hit = TileHit { y, ..hit };
            assert!(matches!(
                write_tile(&root, &layer, &hit, &first).unwrap(),
                Written::Saved(_)
            ));
        }
        assert_eq!(fs::read(root.join("tiles/world/2/3/1.png")).unwrap(), first);
        assert!(!root.join("tiles/world/2/3/0.png.404").exists());
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_links() {
        let dir = TempDir::new("capture-links");
        let root = dir.0.join("pack");
        let outside = dir.0.join("outside");
        fs::create_dir_all(root.join("tiles")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("tiles/world")).unwrap();
        let layer = layer("https://tiles.example.com/{z}/{x}/{y}.png");
        let hit = TileHit {
            layer: 0,
            z: 1,
            x: 0,
            y: 0,
        };
        assert!(matches!(
            write_tile(&root, &layer, &hit, &png([1, 1, 1])),
            Err(WriteError::Unsafe)
        ));
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn builds_shrunk_levels_and_records_complete_ones() {
        let dir = TempDir::new("capture-levels");
        let root = dir.0.join("pack");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("manifest.json"),
            r#"{"schemaVersion":2,"gameId":"test","title":"T","packVersion":"1.0.0",
               "contents":{"maps":[{"id":"test:map:world","layers":[{"id":"test:layer:world","name":"World"}]}]}}"#,
        )
        .unwrap();
        let layer = layer("https://tiles.example.com/{z}/{x}/{y}.png");
        let plan = PackPlan {
            layers: vec![layer.clone()],
            maps: vec![],
        };
        let mut pending = Pending::default();
        // Level 1 is 2 x 2 tiles. Save three of them.
        for (x, y) in [(0, 0), (1, 0), (0, 1)] {
            let hit = TileHit {
                layer: 0,
                z: 1,
                x,
                y,
            };
            write_tile(&root, &layer, &hit, &png([100, 100, 100])).unwrap();
            pending.add(&plan, &hit);
        }
        assert!(!pending.flush(&root, &plan), "no level is complete yet");
        assert!(
            root.join("tiles/world/0/0/0.png").exists(),
            "the shrunk level is built from what is there"
        );
        assert!(read_levels(&root, &layer).is_empty());

        let hit = TileHit {
            layer: 0,
            z: 1,
            x: 1,
            y: 1,
        };
        write_tile(&root, &layer, &hit, &png([100, 100, 100])).unwrap();
        pending.add(&plan, &hit);
        assert!(pending.flush(&root, &plan));
        assert_eq!(read_levels(&root, &layer), BTreeSet::from([0, 1]));
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("manifest.json")).unwrap()).unwrap();
        let images = &manifest["contents"]["maps"][0]["layers"][0]["images"];
        assert_eq!(images["levels"], serde_json::json!([0, 1]));
        assert_eq!(images["complete"], false);
        assert_eq!(images["files"], 5);
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("/+8A").unwrap(), [0xff, 0xef, 0x00]);
        for bad in ["T", "TQ=", "TQ==TWFu", "T===", "TW!u", "TWFu\n"] {
            assert_eq!(decode_base64(bad), None, "{bad}");
        }
    }
}
