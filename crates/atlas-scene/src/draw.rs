//! What the Map Maker needs of a model file besides its 3D map:
//!
//! - [`write_triangles`]: every triangle of the model in the world (lined up
//!   with [`crate::Transform`]), for finding its floors: 32-bit floats, nine
//!   a triangle, each corner's x (east), height and y (north), in the order
//!   of the model's parts and their triangles;
//! - [`draw_floors`]: each floor seen from straight above, in the model's
//!   own colours and textures, one transparent PNG picture per floor (what
//!   is not on that floor left clear), for the Map Maker's "Textured" map
//!   style. Which floor each triangle is on comes from the caller, one
//!   16-bit number a triangle in the same order (-1 for none); each pixel
//!   shows the highest triangle of that floor there, lit a little from the
//!   north-west, as the height shaded style is, its texture taken from a
//!   copy about as fine as the pixel (each copy half the one before);
//! - [`preview`]: a light copy of the model in its own axes and units for
//!   the Map Maker's setup screen, at most [`PREVIEW_TRIANGLES`] triangles
//!   (simplified with meshoptimizer when larger), each corner 16 bits a
//!   coordinate and each triangle a colour.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::gltf::{AlphaMode, Model};
use crate::textures::drawn_colour;
use crate::Transform;

/// The most triangles a preview holds.
pub const PREVIEW_TRIANGLES: usize = 150_000;
/// Pictures of textures are made at most this many pixels a side for drawing from above.
const DRAW_TEXTURE_SIDE: u32 = 1024;
/// The largest picture drawn.
const MAX_PIXELS: u64 = 8192 * 8192;

/// Calls `each` with every triangle of `model` in the world, in order: its
/// part, its corners' vertex numbers in the part and their world x, y and
/// height (corners turned so a mirroring transform keeps the front).
pub fn for_each_triangle(
    model: &Model,
    transform: &Transform,
    mut each: impl FnMut(usize, [usize; 3], [[f64; 3]; 3]),
) {
    let mirror = transform.mirrors();
    for (p, part) in model.parts.iter().enumerate() {
        for triangle in part.indices.as_chunks::<3>().0 {
            let mut corners = [
                triangle[0] as usize,
                triangle[1] as usize,
                triangle[2] as usize,
            ];
            if mirror {
                corners.swap(1, 2);
            }
            let world = corners.map(|c| transform.apply(&part.positions[c]));
            each(p, corners, world);
        }
    }
}

/// Writes every triangle into `output` (see the module's description);
/// returns how many and the world box (x, y, height).
pub fn write_triangles(
    model: &Model,
    transform: &Transform,
    output: &Path,
) -> Result<(usize, [f64; 3], [f64; 3]), String> {
    let file = fs::File::create(output).map_err(|e| format!("{}: {e}", output.display()))?;
    let mut out = std::io::BufWriter::new(file);
    let mut count = 0;
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    let mut failed = None;
    for_each_triangle(model, transform, |_, _, world| {
        if failed.is_some() {
            return;
        }
        let mut bytes = [0u8; 36];
        for (c, w) in world.iter().enumerate() {
            for k in 0..3 {
                low[k] = low[k].min(w[k]);
                high[k] = high[k].max(w[k]);
            }
            // East, height, north: the Map Maker's own order.
            for (j, v) in [w[0], w[2], w[1]].into_iter().enumerate() {
                let at = (c * 3 + j) * 4;
                bytes[at..at + 4].copy_from_slice(&(v as f32).to_le_bytes());
            }
        }
        if let Err(e) = out.write_all(&bytes) {
            failed = Some(e);
        }
        count += 1;
    });
    if let Some(e) = failed {
        return Err(format!("{}: {e}", output.display()));
    }
    out.flush()
        .map_err(|e| format!("{}: {e}", output.display()))?;
    if count == 0 {
        low = [0.0; 3];
        high = [0.0; 3];
    }
    Ok((count, low, high))
}

/// The picture's frame, as the Map Maker draws its floors: world x of its
/// left edge, world y (north) of its top edge, pixels per world unit, size.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub x_min: f64,
    pub z_max: f64,
    pub scale: f64,
    pub width: u32,
    pub height: u32,
}

/// How to colour the floors: with their textures, or with each material's
/// colour (times its texture's average colour).
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Colouring {
    #[default]
    Textures,
    Plain,
}

/// A texture's picture, made small enough for drawing from above.
struct Texels {
    width: usize,
    height: usize,
    /// Linear RGB and alpha 0–1.
    pixels: Vec<[f32; 4]>,
}

fn linear_table() -> [f32; 256] {
    let mut table = [0.0; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        *slot = crate::formats::srgb_to_linear(i as f32 / 255.0);
    }
    table
}

fn to_srgb_byte(linear: f32) -> u8 {
    let v = linear.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0).round() as u8
}

fn texels(bytes: &[u8], table: &[f32; 256]) -> Option<Texels> {
    let picture = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = picture.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let longest = w.max(h);
    let picture = if longest > DRAW_TEXTURE_SIDE {
        let nw = (u64::from(w) * u64::from(DRAW_TEXTURE_SIDE) / u64::from(longest)).max(1) as u32;
        let nh = (u64::from(h) * u64::from(DRAW_TEXTURE_SIDE) / u64::from(longest)).max(1) as u32;
        image::imageops::resize(&picture, nw, nh, image::imageops::FilterType::Triangle)
    } else {
        picture
    };
    let (w, h) = picture.dimensions();
    Some(Texels {
        width: w as usize,
        height: h as usize,
        pixels: picture
            .pixels()
            .map(|p| {
                [
                    table[p.0[0] as usize],
                    table[p.0[1] as usize],
                    table[p.0[2] as usize],
                    f32::from(p.0[3]) / 255.0,
                ]
            })
            .collect(),
    })
}

/// A texture's picture and its smaller copies, each half the size of the
/// one before, down to one pixel: a floor drawn from above takes each pixel
/// from the copy about as fine as the pixel, so a texture repeated many
/// times under one pixel shows its average colour, not one texel by chance.
struct Mips {
    levels: Vec<Texels>,
}

impl Mips {
    fn new(first: Texels) -> Mips {
        let mut levels = vec![first];
        loop {
            let last = &levels[levels.len() - 1];
            if last.width == 1 && last.height == 1 {
                break;
            }
            let (w, h) = (last.width.div_ceil(2), last.height.div_ceil(2));
            let mut pixels = Vec::with_capacity(w * h);
            for y in 0..h {
                for x in 0..w {
                    let mut sum = [0.0f32; 4];
                    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        let sx = (2 * x + dx).min(last.width - 1);
                        let sy = (2 * y + dy).min(last.height - 1);
                        let p = last.pixels[sy * last.width + sx];
                        for k in 0..4 {
                            sum[k] += p[k];
                        }
                    }
                    pixels.push(sum.map(|v| v / 4.0));
                }
            }
            levels.push(Texels {
                width: w,
                height: h,
                pixels,
            });
        }
        Mips { levels }
    }

    /// The copy for a triangle whose texture coordinates `uvs` cover
    /// `pixel_area` (twice the area, in pixels) of the picture.
    fn level(&self, uvs: [[f32; 2]; 3], pixel_area: f64) -> &Texels {
        let first = &self.levels[0];
        let a = [
            f64::from(uvs[1][0] - uvs[0][0]),
            f64::from(uvs[1][1] - uvs[0][1]),
        ];
        let b = [
            f64::from(uvs[2][0] - uvs[0][0]),
            f64::from(uvs[2][1] - uvs[0][1]),
        ];
        let texel_area =
            (a[0] * b[1] - a[1] * b[0]).abs() * first.width as f64 * first.height as f64;
        let ratio = texel_area / pixel_area.abs().max(1e-12);
        let level = if ratio > 1.0 {
            (0.5 * ratio.log2()).floor() as usize
        } else {
            0
        };
        &self.levels[level.min(self.levels.len() - 1)]
    }
}

impl Texels {
    /// The texel at texture coordinates `uv`, repeating.
    fn at(&self, uv: [f32; 2]) -> [f32; 4] {
        let wrap = |v: f32, n: usize| -> usize {
            let f = v - v.floor();
            ((f * n as f32) as usize).min(n - 1)
        };
        let x = wrap(uv[0], self.width);
        let y = wrap(uv[1], self.height);
        self.pixels[y * self.width + x]
    }
}

/// Draws each floor from above into `output/floor-<n>.png` (see the
/// module's description). `floors` holds one floor a triangle; `count` is
/// how many floors. Returns the files written, lowest floor first.
pub fn draw_floors(
    model: &Model,
    transform: &Transform,
    frame: &Frame,
    floors: &[i16],
    count: usize,
    colouring: Colouring,
    output: &Path,
) -> Result<Vec<String>, String> {
    if !(frame.scale.is_finite() && frame.scale > 0.0) || frame.width == 0 || frame.height == 0 {
        return Err("the frame must have a size and a scale above 0".to_owned());
    }
    if u64::from(frame.width) * u64::from(frame.height) > MAX_PIXELS {
        return Err("the picture would be larger than 8192 by 8192 pixels".to_owned());
    }
    if floors.len() != model.triangles() {
        return Err(format!(
            "the floors name {} triangles, and the model has {}",
            floors.len(),
            model.triangles()
        ));
    }
    if count > 64 {
        return Err("at most 64 floors are drawn".to_owned());
    }
    fs::create_dir_all(output).map_err(|e| format!("{}: {e}", output.display()))?;
    let table = linear_table();
    let mut pictures: Vec<Option<Option<Mips>>> = (0..model.images.len()).map(|_| None).collect();
    let light = {
        let l = [-0.45f64, 0.4, 0.8];
        let n = (l[0] * l[0] + l[1] * l[1] + l[2] * l[2]).sqrt();
        l.map(|v| v / n)
    };
    let (width, height) = (frame.width as usize, frame.height as usize);
    let mut files = Vec::new();
    for floor in 0..count {
        let mut depth = vec![f32::NEG_INFINITY; width * height];
        let mut colour = vec![0u8; width * height * 4];
        let mut index = 0usize;
        let mut drawn = false;
        for_each_triangle(model, transform, |p, corners, world| {
            let here = index;
            index += 1;
            if floors[here] != floor as i16 {
                return;
            }
            drawn = true;
            let part = &model.parts[p];
            let material = &model.materials[part.material];
            let texture = match (colouring, material.texture) {
                (Colouring::Textures, Some(t)) if part.uvs.is_some() => {
                    let slot = &mut pictures[t.image];
                    if slot.is_none() {
                        *slot = Some(texels(&model.images[t.image], &table).map(Mips::new));
                    }
                    slot.as_ref().and_then(Option::as_ref)
                }
                _ => None,
            };
            let base = if texture.is_some() {
                [material.color[0], material.color[1], material.color[2]]
            } else {
                drawn_colour(material)
            };
            let cutoff = match material.alpha_mode {
                AlphaMode::Mask(c) => Some(c),
                AlphaMode::Blend => Some(0.5),
                AlphaMode::Opaque => None,
            };
            // Lit as the height shaded style is: a little light from the north-west and above.
            let a = world[0];
            let u = [world[1][0] - a[0], world[1][1] - a[1], world[1][2] - a[2]];
            let v = [world[2][0] - a[0], world[2][1] - a[1], world[2][2] - a[2]];
            let mut n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if length < 1e-12 {
                return;
            }
            if n[2] < 0.0 {
                n = n.map(|c| -c);
            }
            let lit = (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / length;
            let shade = (0.78 + 0.32 * lit.clamp(0.0, 1.0)) as f32;
            // Pixel positions of the corners.
            let px = world.map(|w| {
                [
                    (w[0] - frame.x_min) * frame.scale,
                    (frame.z_max - w[1]) * frame.scale,
                ]
            });
            let area = (px[1][0] - px[0][0]) * (px[2][1] - px[0][1])
                - (px[2][0] - px[0][0]) * (px[1][1] - px[0][1]);
            if area.abs() < 1e-12 {
                return;
            }
            let x0 = px
                .iter()
                .map(|p| p[0])
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0) as usize;
            let x1 = (px
                .iter()
                .map(|p| p[0])
                .fold(f64::NEG_INFINITY, f64::max)
                .ceil() as i64)
                .clamp(0, width as i64) as usize;
            let y0 = px
                .iter()
                .map(|p| p[1])
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0) as usize;
            let y1 = (px
                .iter()
                .map(|p| p[1])
                .fold(f64::NEG_INFINITY, f64::max)
                .ceil() as i64)
                .clamp(0, height as i64) as usize;
            let colours = part.colors.as_ref().map(|c| corners.map(|i| c[i]));
            let uvs = part.uvs.as_ref().map(|t| corners.map(|i| t[i]));
            let texture = match (texture, uvs) {
                (Some(mips), Some(uvs)) => Some(mips.level(uvs, area)),
                _ => None,
            };
            for y in y0..y1 {
                let cy = y as f64 + 0.5;
                for x in x0..x1 {
                    let cx = x as f64 + 0.5;
                    let w0 = ((px[1][0] - cx) * (px[2][1] - cy)
                        - (px[2][0] - cx) * (px[1][1] - cy))
                        / area;
                    let w1 = ((px[2][0] - cx) * (px[0][1] - cy)
                        - (px[0][0] - cx) * (px[2][1] - cy))
                        / area;
                    let w2 = 1.0 - w0 - w1;
                    if w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9 {
                        continue;
                    }
                    let h = (w0 * world[0][2] + w1 * world[1][2] + w2 * world[2][2]) as f32;
                    let at = y * width + x;
                    if h <= depth[at] {
                        continue;
                    }
                    let mut c = [base[0], base[1], base[2]];
                    if let (Some(texture), Some(uvs)) = (texture, uvs) {
                        let uv = [
                            (w0 * f64::from(uvs[0][0])
                                + w1 * f64::from(uvs[1][0])
                                + w2 * f64::from(uvs[2][0])) as f32,
                            (w0 * f64::from(uvs[0][1])
                                + w1 * f64::from(uvs[1][1])
                                + w2 * f64::from(uvs[2][1])) as f32,
                        ];
                        let texel = texture.at(uv);
                        if cutoff.is_some_and(|cut| texel[3] < cut) {
                            continue;
                        }
                        for k in 0..3 {
                            c[k] *= texel[k];
                        }
                    }
                    if let Some(vc) = colours {
                        for k in 0..3 {
                            c[k] *= (w0 as f32) * vc[0][k]
                                + (w1 as f32) * vc[1][k]
                                + (w2 as f32) * vc[2][k];
                        }
                    }
                    depth[at] = h;
                    let out = &mut colour[at * 4..at * 4 + 4];
                    for k in 0..3 {
                        out[k] = to_srgb_byte(c[k] * shade);
                    }
                    out[3] = 255;
                }
            }
        });
        let _ = drawn;
        let name = format!("floor-{floor}.png");
        let path = output.join(&name);
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, frame.width, frame.height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
            writer
                .write_image_data(&colour)
                .map_err(|e| e.to_string())?;
        }
        fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        files.push(name);
    }
    Ok(files)
}

/// A light copy of a model for a preview (see the module's description).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub triangles: usize,
    /// The box the corners are counted in, in the model's own units and axes.
    pub min: [f64; 3],
    pub max: [f64; 3],
    /// Each corner's x, y and z as 16-bit steps from `min` to `max`, little-endian, base64.
    pub positions: String,
    /// Each triangle's colour (sRGB, three bytes), base64.
    pub colours: String,
    /// Whether it was made simpler than the model.
    pub simplified: bool,
}

/// Standard base64 with padding.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The preview of `model`, at most `most` triangles.
pub fn preview(model: &Model, most: usize) -> Preview {
    // Every corner welded on its place, with a colour: its material's (times
    // its texture's average) times its own.
    let mut place_of: std::collections::HashMap<[u32; 3], u32> = std::collections::HashMap::new();
    let mut points: Vec<[f32; 3]> = Vec::new();
    let mut colours: Vec<[f32; 3]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    for part in &model.parts {
        let base = drawn_colour(&model.materials[part.material]);
        let ids: Vec<u32> = part
            .positions
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let point = p.map(|v| v as f32);
                let key = point.map(|v| if v == 0.0 { 0 } else { v.to_bits() });
                *place_of.entry(key).or_insert_with(|| {
                    points.push(point);
                    let own = part.colors.as_ref().map_or([1.0; 4], |c| c[i]);
                    colours.push([base[0] * own[0], base[1] * own[1], base[2] * own[2]]);
                    (points.len() - 1) as u32
                })
            })
            .collect();
        for t in part.indices.as_chunks::<3>().0 {
            indices.extend(t.iter().map(|&c| ids[c as usize]));
        }
    }
    drop(place_of);
    let mut simplified = false;
    if indices.len() / 3 > most && !points.is_empty() {
        let bytes: Vec<u8> = points
            .iter()
            .flat_map(|p| p.iter().flat_map(|v| v.to_le_bytes()))
            .collect();
        if let Ok(adapter) = meshopt::VertexDataAdapter::new(&bytes, 12, 0) {
            let fewer = meshopt::simplify_sloppy(&indices, &adapter, most * 3, 1.0, None);
            if !fewer.is_empty() {
                indices = fewer;
                simplified = true;
            }
        }
        indices.truncate(most * 3);
    }
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for p in &points {
        for k in 0..3 {
            low[k] = low[k].min(f64::from(p[k]));
            high[k] = high[k].max(f64::from(p[k]));
        }
    }
    if !low[0].is_finite() {
        low = [0.0; 3];
        high = [0.0; 3];
    }
    let mut corner_bytes = Vec::with_capacity(indices.len() * 6);
    for &i in &indices {
        let p = points[i as usize];
        for k in 0..3 {
            let span = high[k] - low[k];
            let t = if span > 0.0 {
                (f64::from(p[k]) - low[k]) / span
            } else {
                0.0
            };
            let step = (t.clamp(0.0, 1.0) * 65535.0).round() as u16;
            corner_bytes.extend_from_slice(&step.to_le_bytes());
        }
    }
    let mut colour_bytes = Vec::with_capacity(indices.len());
    for t in indices.as_chunks::<3>().0 {
        for k in 0..3 {
            let c =
                (colours[t[0] as usize][k] + colours[t[1] as usize][k] + colours[t[2] as usize][k])
                    / 3.0;
            colour_bytes.push(to_srgb_byte(c));
        }
    }
    Preview {
        triangles: indices.len() / 3,
        min: low,
        max: high,
        positions: base64_encode(&corner_bytes),
        colours: base64_encode(&colour_bytes),
        simplified,
    }
}
