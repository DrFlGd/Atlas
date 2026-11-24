//! Textures of a model, in one of three modes ([`TextureMode`]):
//!
//! - **leave out** (the default): each material keeps its colour and
//!   vertex colours, and its texture is left out, counted in the report
//!   (`texturesLeftOut`), so the model is plain but whole;
//! - **average**: a material with a texture keeps the texture's average
//!   colour instead (times its own), so a model whose colours are all in
//!   its textures is not drawn white;
//! - **keep**: each material's base colour texture is kept in the model
//!   files, with its texture coordinates (`TEXCOORD_0`), its sampler's wrap
//!   and its alpha mode (`MASK` with its cutoff, or `BLEND`). The finest
//!   level of detail keeps each picture at its own size and fidelity: the
//!   picture's own bytes as they are in the raw model (PNG, or JPEG when
//!   that is what the model holds), never made smaller or written again,
//!   unless [`TextureOptions::max_size`] is given (off by default), and then
//!   a larger picture is made that many pixels a side and written as PNG,
//!   which loses nothing more. Each coarser level gets a copy half the size
//!   of the level before (at least [`MIN_LEVEL_SIZE`] pixels a side),
//!   written as PNG, or as JPEG when it has no transparent pixel and the
//!   JPEG is smaller. A picture is made once for each level and goes into
//!   every file that uses it: each cell's file holds the pictures its
//!   materials use, once each, so a cell is shown by itself as every model
//!   file is. A pack file written at full detail carries the finest level,
//!   so the pictures as the model had them; standard and overview detail
//!   carry the smaller copies only. The report says how many bytes of
//!   pictures each cell's files hold (`cellTextures`). So that no cell's
//!   finest file grows too heavy with pictures, the builder makes its cells
//!   smaller (when it chooses their size) until each cell's pictures come to
//!   at most [`TextureOptions::cell_bytes`] (64 MB when not given) or the
//!   cells reach [`MIN_TEXTURED_CELL`] a side. A model kept whole
//!   ([`crate::Options::one_cell`]) is one cell, so each picture is in
//!   each of its files once.
//!
//! A later step may write the pictures as KTX2 with Basis Universal
//! (`KHR_texture_basisu`, which Atlas reads already): [`encode`] is where
//! a picture's bytes are made, and the writer ([`crate::glb`]) takes any
//! picture with its media type.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;

use crate::gltf::{Material, Model};

/// What to do with a model's textures.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextureMode {
    /// Leave them out; keep each material's colour.
    #[default]
    LeaveOut,
    /// Leave them out; each material with a PNG or JPEG texture in the file
    /// keeps the texture's average colour, times its own.
    Average,
    /// Keep each material's base colour texture, at most `maxSize` pixels a side.
    Keep,
}

/// The smallest and largest `maxSize`.
pub const MIN_MAX_SIZE: u32 = 16;
pub const MAX_MAX_SIZE: u32 = 8192;
/// A coarser level's copy of a picture is never made smaller than this a side.
pub const MIN_LEVEL_SIZE: u32 = 32;
/// Cells are never made smaller than this a side (in world units) to hold fewer pictures.
pub const MIN_TEXTURED_CELL: f64 = 8.0;

/// How textures are to be made.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureOptions {
    #[serde(default)]
    pub mode: TextureMode,
    /// The longest side of a kept picture at the finest level, in pixels: a
    /// power of two from 16 to 8192. Absent (the default), each picture
    /// keeps its own size there.
    #[serde(default)]
    pub max_size: Option<u32>,
    /// The most bytes of pictures a cell's finest file should hold: when
    /// the builder chooses the cells' size (no `cellSize`), it makes them
    /// smaller until each holds no more (64 MB when absent).
    #[serde(default)]
    pub cell_bytes: Option<u64>,
}

impl TextureOptions {
    /// The longest side of a kept picture at the finest level (`None`: its
    /// own), or why the option is not one.
    pub fn max_side(&self) -> Result<Option<u32>, String> {
        match self.max_size {
            None => Ok(None),
            Some(size)
                if size.is_power_of_two() && (MIN_MAX_SIZE..=MAX_MAX_SIZE).contains(&size) =>
            {
                Ok(Some(size))
            }
            Some(size) => Err(format!(
                "textures.maxSize must be a power of two from {MIN_MAX_SIZE} to {MAX_MAX_SIZE}, not {size}"
            )),
        }
    }

    /// The longest side of a picture whose own longest side is `own` at
    /// a level of detail: its own (or `maxSize` when that is smaller) for
    /// the finest, half for each coarser level, never below
    /// [`MIN_LEVEL_SIZE`] (nor above its own).
    pub fn side_at(&self, own: u32, level: usize) -> u32 {
        let finest = match self.max_side() {
            Ok(Some(max)) => max.min(own),
            _ => own,
        };
        let shift = level.min(16) as u32;
        (finest >> shift).max(MIN_LEVEL_SIZE).min(own)
    }
}

/// The materials with a texture that are not kept as textures.
pub fn left_out(model: &Model, options: &TextureOptions) -> usize {
    model
        .materials
        .iter()
        .filter(|m| m.textured && !(options.mode == TextureMode::Keep && m.texture.is_some()))
        .count()
}

/// The materials as the builder writes them: with [`TextureMode::Average`],
/// each textured one's colour times its texture's average colour; with
/// [`TextureMode::Keep`], a material whose texture is kept keeps its colour
/// as it is (the texture is multiplied by it when shown), and one whose
/// texture cannot be kept gets the average as with `Average`.
pub fn materials_for(model: &Model, options: &TextureOptions) -> Vec<Material> {
    model
        .materials
        .iter()
        .map(|material| {
            let mut out = material.clone();
            let kept = options.mode == TextureMode::Keep && material.texture.is_some();
            if !kept {
                out.texture = None;
                if options.mode != TextureMode::LeaveOut {
                    if let Some(average) = material.texture_color {
                        for k in 0..3 {
                            out.color[k] *= average[k];
                        }
                    }
                }
            }
            out
        })
        .collect()
}

/// The colour a material is drawn with from above: its colour, times its
/// texture's average colour when it has one (in any mode, so a model whose
/// colours are in its textures is not drawn white in its pictures).
pub fn drawn_colour(material: &Material) -> [f32; 3] {
    let mut colour = [material.color[0], material.color[1], material.color[2]];
    if let Some(average) = material.texture_color {
        for k in 0..3 {
            colour[k] *= average[k];
        }
    }
    colour
}

/// A picture as written into a model file.
#[derive(Debug)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    /// `image/png` or `image/jpeg`.
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// The pictures of a build, each made once for each level it is asked at.
pub struct Pictures<'a> {
    model: &'a Model,
    options: TextureOptions,
    made: HashMap<(usize, usize), Option<Arc<Encoded>>>,
    /// Pictures that could not be read, by image.
    pub unreadable: Vec<usize>,
}

impl<'a> Pictures<'a> {
    pub fn new(model: &'a Model, options: TextureOptions) -> Self {
        Pictures {
            model,
            options,
            made: HashMap::new(),
            unreadable: Vec::new(),
        }
    }

    /// The picture `image` as level `level` has it; `None` when it cannot be read.
    pub fn at(&mut self, image: usize, level: usize) -> Option<Arc<Encoded>> {
        if let Some(found) = self.made.get(&(image, level)) {
            return found.clone();
        }
        let options = self.options;
        let made = self
            .model
            .images
            .get(image)
            .and_then(|bytes| picture_at(bytes, &options, level))
            .map(Arc::new);
        if made.is_none() && !self.unreadable.contains(&image) {
            self.unreadable.push(image);
        }
        self.made.insert((image, level), made.clone());
        made
    }
}

/// A picture's media type by its first bytes: PNG or JPEG, else `None`.
fn mime_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        Some("image/jpeg")
    } else {
        None
    }
}

/// A PNG or JPEG picture as level `level` keeps it (see the module's
/// description): at the finest level its own bytes when it is no larger
/// than `maxSize` (or none is given), else made smaller; `None` for a
/// picture that cannot be read.
pub fn picture_at(bytes: &[u8], options: &TextureOptions, level: usize) -> Option<Encoded> {
    let mime = mime_of(bytes)?;
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    let own = width.max(height);
    let side = options.side_at(own, level);
    if level == 0 && side >= own {
        // Its own pixels, as the model has them; read once to be sure it can be.
        image::load_from_memory(bytes).ok()?;
        return Some(Encoded {
            bytes: bytes.to_vec(),
            mime,
            width,
            height,
        });
    }
    encode(bytes, side, level > 0)
}

/// A PNG or JPEG picture made at most `side` pixels a side (its shape
/// kept), written as PNG, or, when `lossy` and it has no transparent pixel,
/// as JPEG when that is smaller. `None` for a picture that cannot be read.
pub fn encode(bytes: &[u8], side: u32, lossy: bool) -> Option<Encoded> {
    use image::ImageEncoder as _;
    let picture = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (width, height) = picture.dimensions();
    if width == 0 || height == 0 {
        return None;
    }
    let longest = width.max(height);
    let picture = if longest > side {
        let w = ((u64::from(width) * u64::from(side)) / u64::from(longest)).max(1) as u32;
        let h = ((u64::from(height) * u64::from(side)) / u64::from(longest)).max(1) as u32;
        image::imageops::resize(&picture, w, h, image::imageops::FilterType::Triangle)
    } else {
        picture
    };
    let (width, height) = picture.dimensions();
    let opaque = picture.pixels().all(|p| p.0[3] == 255);
    let mut png = Vec::new();
    if opaque {
        let rgb = image::DynamicImage::ImageRgba8(picture.clone()).into_rgb8();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
            .ok()?;
        if lossy {
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85)
                .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
                .ok()?;
            if jpeg.len() < png.len() {
                return Some(Encoded {
                    bytes: jpeg,
                    mime: "image/jpeg",
                    width,
                    height,
                });
            }
        }
    } else {
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&picture, width, height, image::ExtendedColorType::Rgba8)
            .ok()?;
    }
    Some(Encoded {
        bytes: png,
        mime: "image/png",
        width,
        height,
    })
}

/// sRGB 0–255 to linear 0–1.
fn linear(value: u8) -> f32 {
    let v = f32::from(value) / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// The average of pixels of `channels` bytes each (RGB first, alpha
/// fourth when there are four, grey with one or two), in linear RGB,
/// weighted by alpha, reading at most about 65,536 of them.
fn average_of(pixels: &[u8], channels: usize) -> Option<[f32; 3]> {
    let count = pixels.len() / channels;
    if count == 0 {
        return None;
    }
    let step = (count / 65_536).max(1);
    let mut sum = [0.0f64; 3];
    let mut weight = 0.0f64;
    for i in (0..count).step_by(step) {
        let p = &pixels[i * channels..(i + 1) * channels];
        let (rgb, alpha) = match channels {
            1 => ([p[0]; 3], 255),
            2 => ([p[0]; 3], p[1]),
            3 => ([p[0], p[1], p[2]], 255),
            _ => ([p[0], p[1], p[2]], p[3]),
        };
        let a = f64::from(alpha) / 255.0;
        for k in 0..3 {
            sum[k] += f64::from(linear(rgb[k])) * a;
        }
        weight += a;
    }
    (weight > 0.0).then(|| sum.map(|s| (s / weight) as f32))
}

/// The average colour of a PNG or JPEG picture, in linear RGB; `None` for
/// any other file, or one that cannot be read.
pub fn average_colour(bytes: &[u8]) -> Option<[f32; 3]> {
    if bytes.starts_with(b"\x89PNG") {
        let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut reader = decoder.read_info().ok()?;
        let mut buffer = vec![0; reader.output_buffer_size()?];
        let frame = reader.next_frame(&mut buffer).ok()?;
        let channels = frame.color_type.samples();
        average_of(&buffer[..frame.buffer_size()], channels)
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        let options = zune_core::options::DecoderOptions::default()
            .jpeg_set_out_colorspace(zune_core::colorspace::ColorSpace::RGB);
        let mut decoder = zune_jpeg::JpegDecoder::new_with_options(
            zune_core::bytestream::ZCursor::new(bytes),
            options,
        );
        let pixels = decoder.decode().ok()?;
        average_of(&pixels, 3)
    } else {
        None
    }
}
