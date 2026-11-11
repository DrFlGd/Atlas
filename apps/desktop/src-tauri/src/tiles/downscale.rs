//! Builds the pyramid levels below the lowest downloaded one by combining
//! 2 x 2 tiles of the level above and shrinking them to one tile.

use std::{collections::HashMap, fs, io::Cursor, path::Path};

use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder},
    imageops::{self, FilterType},
    DynamicImage, ImageEncoder, Rgba, RgbaImage,
};

use super::{
    pyramid::{read_pack_plan, LayerPlan, TileFormat},
    status::read_levels,
    store::TileStore,
};

/// Fill for parts of a built tile whose source tiles do not exist: a neutral
/// dark grey that reads as "no map here" on both themes.
pub const BACKGROUND: Rgba<u8> = Rgba([38, 40, 44, 255]);

const JPEG_QUALITY: u8 = 85;

/// Draws one tile from the four tiles of the level above it, in the order
/// top-left, top-right, bottom-left, bottom-right; `None` where a tile does
/// not exist. Returns the encoded tile.
pub fn downscale(
    children: &[Option<Vec<u8>>; 4],
    tile_size: u32,
    format: TileFormat,
) -> Result<Vec<u8>, String> {
    let mut canvas = RgbaImage::from_pixel(tile_size * 2, tile_size * 2, BACKGROUND);
    for (index, child) in children.iter().enumerate() {
        let Some(bytes) = child else { continue };
        let mut image = image::load_from_memory(bytes)
            .map_err(|error| format!("could not read a tile: {error}"))?
            .to_rgba8();
        if image.width() != tile_size || image.height() != tile_size {
            image = imageops::resize(&image, tile_size, tile_size, FilterType::Triangle);
        }
        let (column, row) = (index as u32 % 2, index as u32 / 2);
        imageops::overlay(
            &mut canvas,
            &image,
            i64::from(column * tile_size),
            i64::from(row * tile_size),
        );
    }
    let small = imageops::resize(&canvas, tile_size, tile_size, FilterType::Lanczos3);
    encode(&DynamicImage::ImageRgba8(small), format)
}

fn encode(image: &DynamicImage, format: TileFormat) -> Result<Vec<u8>, String> {
    let rgb = image.to_rgb8();
    let mut out = Cursor::new(Vec::new());
    let (width, height) = rgb.dimensions();
    let result = match format {
        TileFormat::Jpeg => JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).write_image(
            rgb.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgb8,
        ),
        TileFormat::Png => PngEncoder::new(&mut out).write_image(
            rgb.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgb8,
        ),
        // The image crate writes lossless WebP only.
        TileFormat::Webp => WebPEncoder::new_lossless(&mut out).write_image(
            rgb.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgb8,
        ),
    };
    result.map_err(|error| format!("could not encode a tile: {error}"))?;
    Ok(out.into_inner())
}

/// Builds every level of `layer` below its lowest remote level, highest
/// first, writing the tiles into the overlay. Missing source tiles are drawn
/// as background; a tile with no source tiles at all is not written.
/// `keep_going` is asked between tiles; when it returns false the build stops
/// early and returns `Ok(false)`.
pub fn build_lower_levels(
    layer: &LayerPlan,
    store: &TileStore,
    mut keep_going: impl FnMut() -> bool,
) -> Result<bool, String> {
    let format = layer.format();
    for z in layer.built_levels() {
        for tile in layer.tiles_of(z) {
            if !keep_going() {
                return Ok(false);
            }
            let children = [(0, 0), (1, 0), (0, 1), (1, 1)].map(|(dx, dy)| {
                store.read(&layer.tile_path(z + 1, tile.x * 2 + dx, tile.y * 2 + dy))
            });
            if children.iter().all(Option::is_none) {
                continue;
            }
            let bytes = downscale(&children, layer.tile_size, format)?;
            store
                .write(&layer.tile_path(z, tile.x, tile.y), &bytes)
                .map_err(|error| format!("could not save a map image: {error}"))?;
        }
    }
    Ok(true)
}

/// Where each layer of the pack in `pack_root` keeps its tiles: the `url`
/// template of its `layers.json` entry, by layer id. Empty when the pack has
/// no readable `layers.json`.
pub fn tile_addresses(pack_root: &Path) -> HashMap<String, String> {
    let Some(layers) = fs::read_to_string(pack_root.join("layers.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<serde_json::Value>>(&text).ok())
    else {
        return HashMap::new();
    };
    layers
        .iter()
        .filter_map(|layer| {
            let id = layer.get("id")?.as_str()?;
            let url = layer.get("tiles")?.get("url")?.as_str()?;
            Some((id.to_owned(), url.to_owned()))
        })
        .collect()
}

/// Builds the shrunk levels again for the layers of the pack folder
/// `pack_root` whose tile address template is no longer the one in `before`
/// (see [`tile_addresses`]), for example after an importer corrected the
/// order of `{x}` and `{y}`. The downloaded images of such a layer are read
/// at their new addresses, so the levels made from them earlier show the old
/// arrangement. Layers without recorded shrunk levels are left alone.
/// Returns the ids of the layers that were built again.
pub fn rebuild_moved_layers(
    pack_root: &Path,
    before: &HashMap<String, String>,
) -> Result<Vec<String>, String> {
    if before.is_empty() {
        return Ok(Vec::new());
    }
    let Ok(plan) = read_pack_plan(pack_root) else {
        return Ok(Vec::new());
    };
    let store = TileStore::new(pack_root.to_owned(), Some(pack_root.to_owned()));
    let mut rebuilt = Vec::new();
    for layer in &plan.layers {
        if before
            .get(&layer.layer_id)
            .is_none_or(|url| *url == layer.url)
        {
            continue;
        }
        let recorded = read_levels(&store.overlay, layer);
        if !layer.built_levels().any(|z| recorded.contains(&z)) {
            continue;
        }
        build_lower_levels(layer, &store, || true)?;
        rebuilt.push(layer.layer_id.clone());
    }
    Ok(rebuilt)
}

/// Whether bytes start like a JPEG, PNG or WebP image.
pub fn looks_like_image(data: &[u8]) -> bool {
    data.starts_with(&[0xff, 0xd8, 0xff])
        || data.starts_with(&[0x89, b'P', b'N', b'G'])
        || (data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn tile(color: [u8; 3], size: u32, format: TileFormat) -> Vec<u8> {
        let image = RgbImage::from_pixel(size, size, Rgb(color));
        encode(&DynamicImage::ImageRgb8(image), format).unwrap()
    }

    fn pixel(bytes: &[u8], x: u32, y: u32) -> [u8; 3] {
        image::load_from_memory(bytes)
            .unwrap()
            .to_rgb8()
            .get_pixel(x, y)
            .0
    }

    fn close(a: [u8; 3], b: [u8; 3]) -> bool {
        a.iter().zip(b).all(|(a, b)| a.abs_diff(b) <= 6)
    }

    #[test]
    fn combines_four_tiles_into_one() {
        for format in [TileFormat::Jpeg, TileFormat::Png, TileFormat::Webp] {
            let children = [
                Some(tile([255, 0, 0], 64, format)),
                Some(tile([0, 255, 0], 64, format)),
                Some(tile([0, 0, 255], 64, format)),
                None,
            ];
            let out = downscale(&children, 64, format).unwrap();
            assert!(looks_like_image(&out), "{format:?}");
            let decoded = image::load_from_memory(&out).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (64, 64));
            // Each quadrant is the shrunk child; the missing one is background.
            assert!(close(pixel(&out, 8, 8), [255, 0, 0]), "{format:?}");
            assert!(close(pixel(&out, 56, 8), [0, 255, 0]), "{format:?}");
            assert!(close(pixel(&out, 8, 56), [0, 0, 255]), "{format:?}");
            let [r, g, b, _] = BACKGROUND.0;
            assert!(close(pixel(&out, 56, 56), [r, g, b]), "{format:?}");
        }
    }

    #[test]
    fn resizes_children_of_another_size() {
        let children = [
            Some(tile([200, 200, 0], 128, TileFormat::Png)),
            None,
            None,
            None,
        ];
        let out = downscale(&children, 64, TileFormat::Png).unwrap();
        assert!(close(pixel(&out, 10, 10), [200, 200, 0]));
    }

    #[test]
    fn rejects_broken_children() {
        let children = [Some(b"not an image".to_vec()), None, None, None];
        assert!(downscale(&children, 64, TileFormat::Jpeg).is_err());
    }

    #[test]
    fn recognises_images() {
        assert!(looks_like_image(&tile([1, 2, 3], 8, TileFormat::Jpeg)));
        assert!(looks_like_image(&tile([1, 2, 3], 8, TileFormat::Png)));
        assert!(looks_like_image(&tile([1, 2, 3], 8, TileFormat::Webp)));
        assert!(!looks_like_image(b"<!doctype html>"));
        assert!(!looks_like_image(b""));
    }
}
