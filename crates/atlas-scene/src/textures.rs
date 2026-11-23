//! Textures of a model. Not built yet: this version keeps each material's
//! colour and vertex colours and leaves its textures out, counting them in
//! the report (`texturesLeftOut`), so a model made for this version is
//! plain but whole. With [`TextureMode::Average`], a material with a
//! texture keeps the texture's average colour instead (times its own), so
//! a model whose colours are all in its textures is not drawn white.
//!
//! Where they will go (a later version): the reader ([`crate::gltf`]) reads
//! each material's base colour texture and its `TEXCOORD_0`; the cells keep
//! the texture coordinates through simplification (as another weighted
//! attribute) and the welding key; this module turns each texture into KTX2
//! with Basis Universal (`KHR_texture_basisu`, which Atlas reads), at most
//! [`TextureOptions::max_size`] pixels a side, with smaller copies for the
//! coarser levels; and the writer ([`crate::glb`]) stores it in each file
//! that uses it. The budgets of the 3D view count texture bytes already.

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
}

/// How textures are to be made, once they are.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureOptions {
    #[serde(default)]
    pub mode: TextureMode,
    /// The longest side of a texture, in pixels (for later).
    #[serde(default)]
    pub max_size: Option<u32>,
}

/// The materials with a texture, which this version leaves out.
pub fn left_out(model: &Model) -> usize {
    model.materials.iter().filter(|m| m.textured).count()
}

/// The materials as the builder writes them: with [`TextureMode::Average`],
/// each textured one's colour times its texture's average colour.
pub fn materials_for(model: &Model, options: &TextureOptions) -> Vec<Material> {
    model
        .materials
        .iter()
        .map(|material| {
            let mut out = material.clone();
            if let (TextureMode::Average, Some(average)) = (options.mode, material.texture_color) {
                for k in 0..3 {
                    out.color[k] *= average[k];
                }
            }
            out
        })
        .collect()
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
