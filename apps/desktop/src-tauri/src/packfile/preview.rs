//! Small pictures of the maps in a pack file (version 7): one JPEG per map,
//! its longest side [`PREVIEW_SIDE`] pixels at most, named
//! `preview/<name>.jpg` after the map's id, and written right after the
//! header, so another app shows a card for the file from its start alone.
//!
//! A map's small picture is drawn from the map's own images that go in the
//! file: the first folder layer of the map, at the lowest level of its
//! pyramid that is at least [`PREVIEW_SIDE`] pixels on its longest side
//! (else its most detailed level in the file), its tiles put side by side on
//! a dark backdrop and made smaller. A map made from one picture is cut into
//! such a pyramid too, so it has one the same way. Only levels of at most
//! [`MAX_TILES`] tiles and [`MAX_PIXELS`] pixels are drawn. A map with no
//! image in the file, or whose images cannot be read, has none; nothing
//! here ever stops an export. A picture that would be larger than
//! [`MAX_PREVIEW_BYTES`] at the lowest quality tried is left out too.
//!
//! Drawn with the `image` crate's decoders and JPEG encoder, which every
//! desktop build has (see `tiles/cut.rs`): reading files on this computer
//! is not downloading. Not on Android, which makes no pack files; there
//! [`make_previews`] makes none.

use std::collections::HashSet;

use super::{
    Analysis, DirCache, LayerFacts, LayerInfo, MapFacts, Stop, TileKind, MAX_PREVIEWS, PREVIEW_DIR,
    PREVIEW_SIDE,
};

/// The most tiles drawn for one small picture.
pub const MAX_TILES: u64 = 64;
/// The most pixels of the level a small picture is drawn from.
pub const MAX_PIXELS: u64 = 4096 * 4096;
/// The most bytes of small pictures one file holds.
pub const MAX_PREVIEW_TOTAL_BYTES: u64 = 64 << 20;
/// A tile file larger than this is not read (the downloader's limit).
const MAX_TILE_BYTES: u64 = 16 << 20;
/// The qualities tried, best first, until the picture is small enough.
#[cfg(not(target_os = "android"))]
const QUALITIES: [u8; 3] = [80, 65, 50];

/// The small picture of one map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    /// The map's place in the list of maps.
    pub map: usize,
    /// Its entry name, `preview/<name>.jpg`.
    pub name: String,
    pub bytes: Vec<u8>,
}

/// The small pictures of `maps`, drawn from the images of the layers in
/// `analysis` that go in the file (`layers`, as `plan_images` gave them),
/// found as `plan_images` found them: downloaded images first, then those
/// that came with the pack. `cancelled` is asked between maps.
pub fn make_previews(
    analysis: &Analysis,
    layers: &[LayerFacts],
    maps: &[MapFacts],
    images: &mut DirCache,
    shipped: &mut Option<DirCache>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<Preview>, Stop> {
    let mut made = Vec::new();
    if cfg!(target_os = "android") {
        return Ok(made);
    }
    let mut taken = HashSet::new();
    let mut total: u64 = 0;
    for (index, map) in maps.iter().enumerate() {
        if cancelled() {
            return Err(Stop::Cancelled);
        }
        if made.len() >= MAX_PREVIEWS {
            break;
        }
        let drawn = analysis
            .layers
            .iter()
            .filter(|layer| layer.map_id == map.id && layer.kind == TileKind::Xyz)
            .find_map(|layer| {
                let facts = layers.iter().find(|facts| facts.id == layer.id)?;
                let z = preview_level(layer, &facts.levels)?;
                let tiles = tile_files(layer, z, images, shipped);
                draw(layer, z, &tiles)
            });
        let Some(bytes) = drawn else {
            continue;
        };
        if total + bytes.len() as u64 > MAX_PREVIEW_TOTAL_BYTES {
            break;
        }
        total += bytes.len() as u64;
        made.push(Preview {
            map: index,
            name: preview_name(&map.id, &mut taken),
            bytes,
        });
    }
    Ok(made)
}

/// The entry name of a map's small picture: `preview/` and the local part
/// of its id (`<game>:map:<local>`) in lower case, every character but
/// letters, digits, `-` and `_` as `-`, at most 80 characters, and a number
/// added when another map already has that name.
pub fn preview_name(map_id: &str, taken: &mut HashSet<String>) -> String {
    let local = map_id.rsplit(':').next().unwrap_or_default();
    let mut stem: String = local
        .chars()
        .map(|c| match c.to_ascii_lowercase() {
            c @ ('a'..='z' | '0'..='9' | '_') => c,
            _ => '-',
        })
        .collect();
    stem = stem.trim_start_matches(['-', '_']).to_owned();
    stem.truncate(70);
    if stem.is_empty() {
        stem = "map".to_owned();
    }
    let mut name = format!("{PREVIEW_DIR}{stem}.jpg");
    let mut n = 2;
    while taken.contains(&name) {
        name = format!("{PREVIEW_DIR}{stem}-{n}.jpg");
        n += 1;
    }
    debug_assert!(atlas_pack::is_preview_name(&name), "{name}");
    taken.insert(name.clone());
    name
}

/// The size of level `z` of a layer, in pixels.
fn level_size(layer: &LayerInfo, z: u8) -> (u64, u64) {
    let shift = u32::from(layer.max_zoom.saturating_sub(z));
    let scale = 1u64.checked_shl(shift).unwrap_or(u64::MAX);
    (
        u64::from(layer.width).div_ceil(scale).max(1),
        u64::from(layer.height).div_ceil(scale).max(1),
    )
}

/// The level a small picture is drawn from, of the levels in the file
/// (lowest first): the lowest at least [`PREVIEW_SIDE`] on its longest
/// side, else the most detailed one within the limits.
pub fn preview_level(layer: &LayerInfo, levels: &[u8]) -> Option<u8> {
    let mut chosen = None;
    for &z in levels {
        let (columns, rows) = layer.grid(z);
        let (width, height) = level_size(layer, z);
        if columns * rows > MAX_TILES || width * height > MAX_PIXELS {
            break;
        }
        chosen = Some(z);
        if width.max(height) >= u64::from(PREVIEW_SIDE) {
            break;
        }
    }
    chosen
}

/// The tile files of level `z` that are on disk: column, row and path.
fn tile_files(
    layer: &LayerInfo,
    z: u8,
    images: &mut DirCache,
    shipped: &mut Option<DirCache>,
) -> Vec<(u64, u64, std::path::PathBuf)> {
    let (columns, rows) = layer.grid(z);
    let mut files = Vec::new();
    for y in 0..rows {
        for x in 0..columns {
            let name = layer.tile_name(z, x, y);
            let found = match images.len(&name) {
                Some(size) => Some((size, images.path(&name))),
                None => shipped
                    .as_mut()
                    .and_then(|pack| Some((pack.len(&name)?, pack.path(&name)))),
            };
            if let Some((_, path)) = found.filter(|(size, _)| *size <= MAX_TILE_BYTES) {
                files.push((x, y, path));
            }
        }
    }
    files
}

/// The longest side `side` at most, the shape kept, at least one pixel.
#[cfg(not(target_os = "android"))]
fn fitted(width: u64, height: u64, side: u64) -> (u32, u32) {
    let longest = width.max(height).max(1);
    if longest <= side {
        return (width as u32, height as u32);
    }
    let scale = |value: u64| ((value * side + longest / 2) / longest).max(1) as u32;
    (scale(width), scale(height))
}

/// Draws the small picture of level `z` from its tiles; none when no tile
/// could be read or the picture would be too large.
#[cfg(not(target_os = "android"))]
fn draw(layer: &LayerInfo, z: u8, tiles: &[(u64, u64, std::path::PathBuf)]) -> Option<Vec<u8>> {
    use image::{
        codecs::jpeg::JpegEncoder, imageops, imageops::FilterType, ExtendedColorType, ImageEncoder,
        ImageReader, Limits, Rgba, RgbaImage,
    };
    use std::io::Cursor;

    use super::MAX_PREVIEW_BYTES;

    if tiles.is_empty() {
        return None;
    }
    let (width, height) = level_size(layer, z);
    let size = layer.tile_size;
    // The backdrop of a map where it has no image (`tiles::downscale`).
    let mut canvas = RgbaImage::from_pixel(width as u32, height as u32, Rgba([38, 40, 44, 255]));
    let mut drawn = 0;
    for (x, y, path) in tiles {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let Ok(mut reader) = ImageReader::new(Cursor::new(bytes)).with_guessed_format() else {
            continue;
        };
        let mut limits = Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(128 << 20);
        reader.limits(limits);
        let Ok(tile) = reader.decode() else {
            continue;
        };
        let mut tile = tile.to_rgba8();
        if tile.width() != size || tile.height() != size {
            tile = imageops::resize(&tile, size, size, FilterType::Triangle);
        }
        imageops::overlay(
            &mut canvas,
            &tile,
            (*x * u64::from(size)) as i64,
            (*y * u64::from(size)) as i64,
        );
        drawn += 1;
    }
    if drawn == 0 {
        return None;
    }
    let (small_width, small_height) = fitted(width, height, u64::from(PREVIEW_SIDE));
    let small = if (small_width, small_height) == (canvas.width(), canvas.height()) {
        canvas
    } else {
        imageops::resize(&canvas, small_width, small_height, FilterType::Triangle)
    };
    let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
    QUALITIES.into_iter().find_map(|quality| {
        let mut out = Cursor::new(Vec::new());
        JpegEncoder::new_with_quality(&mut out, quality)
            .write_image(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                ExtendedColorType::Rgb8,
            )
            .ok()?;
        let bytes = out.into_inner();
        (bytes.len() as u64 <= MAX_PREVIEW_BYTES).then_some(bytes)
    })
}

#[cfg(target_os = "android")]
fn draw(_layer: &LayerInfo, _z: u8, _tiles: &[(u64, u64, std::path::PathBuf)]) -> Option<Vec<u8>> {
    None
}
