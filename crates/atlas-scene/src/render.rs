//! Drawing the model from straight above, one picture per floor (or one of
//! the whole map), cut into the map image tiles every Atlas app reads, so a
//! 3D map works in 2D too, and its 2D side matches the model.
//!
//! Each pixel shows the highest surface below the floor's top (`heights[1]`),
//! in its vertex colour (times its material's colour) with a little light
//! from the north-west; what lies below the floor's bottom shows faintly
//! (`lowerOpacity`), and where nothing is, the background. Seen from above,
//! right is world +x and up is world +y, so the map's `worldTransform` is
//! `x = e + px / s`, `y = f - py / s` for `s` pixels per world unit.
//!
//! The tiles follow `@atlas/core`'s pyramid: the top level is the smallest
//! whose tiles cover the picture at one tile pixel per picture pixel
//! (`ceil(log2(longest side / tile size))`, at least 0), each level below
//! halves the picture (its size rounded up), and tiles past the picture's
//! right and bottom edges are filled with the background. PNG for now.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// How to draw the map images.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderOptions {
    /// Where the tiles go in the pack folder: `<folder>/<floor>/{z}/{x}/{y}.png`.
    pub folder: String,
    #[serde(default = "default_pixels_per_unit")]
    pub pixels_per_unit: f64,
    /// The longest side of a picture; a larger map is drawn at a smaller scale.
    #[serde(default = "default_max_size")]
    pub max_size: u32,
    #[serde(default = "default_tile_size")]
    pub tile_size: u32,
    /// World units around the model.
    #[serde(default = "default_margin")]
    pub margin: f64,
    /// `#rrggbb`.
    #[serde(default = "default_background")]
    pub background: String,
    /// How strongly what lies below a floor shows through, 0 to 1.
    #[serde(default = "default_lower_opacity")]
    pub lower_opacity: f32,
    /// One picture per floor; none draws the whole map once, as `all`.
    #[serde(default)]
    pub floors: Vec<RenderFloor>,
}

fn default_pixels_per_unit() -> f64 {
    4.0
}
fn default_max_size() -> u32 {
    4096
}
fn default_tile_size() -> u32 {
    256
}
fn default_margin() -> f64 {
    8.0
}
fn default_background() -> String {
    "#161a20".to_owned()
}
fn default_lower_opacity() -> f32 {
    0.4
}

/// A floor to draw: its id (a folder name) and the heights it shows.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderFloor {
    pub id: String,
    pub heights: [f64; 2],
}

/// The pictures drawn: their size and transform, and each floor's tiles.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub width: u32,
    pub height: u32,
    pub pixels_per_unit: f64,
    /// Map pixel to world x, y, in the order `maps.json` writes it.
    pub world_transform: WorldTransform,
    pub layers: Vec<RenderedLayer>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct WorldTransform {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedLayer {
    pub id: String,
    /// `<folder>/<id>/{z}/{x}/{y}.png`, as a layer's `tiles.url`.
    pub url: String,
    pub min_zoom: u32,
    pub max_zoom: u32,
    pub tile_size: u32,
    pub files: usize,
    pub bytes: u64,
}

/// What is drawn: triangles in world x, y and height, with a colour per
/// vertex (linear RGB, the material's colour already applied).
pub struct Surface<'a> {
    pub points: &'a [[f64; 3]],
    pub colors: &'a [[f32; 3]],
    pub triangles: &'a [[u32; 3]],
}

fn colour(hex: &str) -> Result<[u8; 3], String> {
    let ok =
        hex.len() == 7 && hex.starts_with('#') && hex[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !ok {
        return Err(format!("the background {hex} is not a #rrggbb colour"));
    }
    let value = u32::from_str_radix(&hex[1..], 16).map_err(|e| e.to_string())?;
    Ok([(value >> 16) as u8, (value >> 8) as u8, value as u8])
}

fn is_segment(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn is_folder(folder: &str) -> bool {
    !folder.is_empty() && folder.split('/').all(is_segment)
}

fn to_srgb(linear: f32) -> f32 {
    let v = linear.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// The highest level of the tile pyramid of a picture.
pub fn pyramid_max_zoom(width: u32, height: u32, tile_size: u32) -> u32 {
    let longest = f64::from(width.max(height));
    ((longest / f64::from(tile_size)).log2() - 1e-9)
        .ceil()
        .max(0.0) as u32
}

struct Picture {
    width: usize,
    height: usize,
    rgb: Vec<u8>,
}

impl Picture {
    /// Half the size (rounded up), each pixel the mean of the up to four it covers.
    fn half(&self) -> Picture {
        let width = self.width.div_ceil(2);
        let height = self.height.div_ceil(2);
        let mut rgb = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let mut sum = [0u32; 3];
                let mut n = 0;
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let (sx, sy) = (2 * x + dx, 2 * y + dy);
                    if sx < self.width && sy < self.height {
                        let at = (sy * self.width + sx) * 3;
                        for k in 0..3 {
                            sum[k] += u32::from(self.rgb[at + k]);
                        }
                        n += 1;
                    }
                }
                let at = (y * width + x) * 3;
                for k in 0..3 {
                    rgb[at + k] = ((sum[k] + n / 2) / n) as u8;
                }
            }
        }
        Picture { width, height, rgb }
    }
}

fn encode_png(rgb: &[u8], size: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, size, size);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgb).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

/// Writes the tile pyramid of a picture under `folder`; returns its top
/// level, its files and their bytes.
fn write_pyramid(
    picture: Picture,
    folder: &Path,
    tile: u32,
    background: [u8; 3],
) -> Result<(u32, usize, u64), String> {
    let max_zoom = pyramid_max_zoom(picture.width as u32, picture.height as u32, tile);
    let t = tile as usize;
    let mut blank = vec![0u8; t * t * 3];
    for pixel in blank.chunks_exact_mut(3) {
        pixel.copy_from_slice(&background);
    }
    let blank_png = encode_png(&blank, tile)?;
    let mut files = 0;
    let mut bytes = 0u64;
    let mut level = picture;
    for zoom in (0..=max_zoom).rev() {
        if zoom < max_zoom {
            level = level.half();
        }
        let columns = level.width.div_ceil(t);
        let rows = level.height.div_ceil(t);
        for x in 0..columns {
            let column = folder.join(zoom.to_string()).join(x.to_string());
            fs::create_dir_all(&column).map_err(|e| format!("{}: {e}", column.display()))?;
            for y in 0..rows {
                let mut data = blank.clone();
                let mut empty = true;
                for row in 0..t {
                    let sy = y * t + row;
                    if sy >= level.height {
                        break;
                    }
                    let sx0 = x * t;
                    let sx1 = (sx0 + t).min(level.width);
                    let from =
                        &level.rgb[(sy * level.width + sx0) * 3..(sy * level.width + sx1) * 3];
                    let to = &mut data[row * t * 3..row * t * 3 + from.len()];
                    to.copy_from_slice(from);
                    if empty && from.chunks_exact(3).any(|p| p != background) {
                        empty = false;
                    }
                }
                let encoded = if empty {
                    blank_png.clone()
                } else {
                    encode_png(&data, tile)?
                };
                let path = column.join(format!("{y}.png"));
                fs::write(&path, &encoded).map_err(|e| format!("{}: {e}", path.display()))?;
                files += 1;
                bytes += encoded.len() as u64;
            }
        }
    }
    Ok((max_zoom, files, bytes))
}

/// Draws the surface from above, once per floor, and writes the tiles into
/// the pack folder `pack`.
pub fn render(
    surface: &Surface<'_>,
    options: &RenderOptions,
    pack: &Path,
    progress: &mut dyn FnMut(f64, &str),
) -> Result<Rendered, String> {
    if !is_folder(&options.folder) {
        return Err(format!(
            "the tiles' folder {} must be folder names of a-z, 0-9, _ and -",
            options.folder
        ));
    }
    let background = colour(&options.background)?;
    if !(64..=1024).contains(&options.tile_size) || !options.tile_size.is_power_of_two() {
        return Err("the tile size must be 64, 128, 256, 512 or 1024".to_owned());
    }
    if !(options.pixels_per_unit.is_finite() && options.pixels_per_unit > 0.0) {
        return Err("pixelsPerUnit must be above 0".to_owned());
    }
    let floors: Vec<RenderFloor> = if options.floors.is_empty() {
        vec![RenderFloor {
            id: "all".to_owned(),
            heights: [f64::NEG_INFINITY, f64::INFINITY],
        }]
    } else {
        options.floors.clone()
    };
    for floor in &floors {
        if !is_segment(&floor.id) {
            return Err(format!(
                "the floor id {} must be a-z, 0-9, _ and -",
                floor.id
            ));
        }
    }

    // The frame: every point plus the margin.
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for p in surface.points {
        for k in 0..2 {
            min[k] = min[k].min(p[k]);
            max[k] = max[k].max(p[k]);
        }
    }
    if surface.points.is_empty() {
        min = [0.0, 0.0];
        max = [1.0, 1.0];
    }
    let margin = options.margin.max(0.0);
    let (x0, y1) = (min[0] - margin, max[1] + margin);
    let extent = (max[0] - min[0] + 2.0 * margin)
        .max(max[1] - min[1] + 2.0 * margin)
        .max(1e-6);
    let scale = options
        .pixels_per_unit
        .min(f64::from(options.max_size.max(1)) / extent);
    let width = (((max[0] - min[0] + 2.0 * margin) * scale).ceil() as usize)
        .clamp(1, options.max_size as usize);
    let height = (((max[1] - min[1] + 2.0 * margin) * scale).ceil() as usize)
        .clamp(1, options.max_size as usize);

    let light = {
        let l = [-0.45f64, 0.4, 0.8];
        let n = (l[0] * l[0] + l[1] * l[1] + l[2] * l[2]).sqrt();
        [l[0] / n, l[1] / n, l[2] / n]
    };
    // Per triangle: its pixel corners, heights, colours and its light.
    let pixel = |p: &[f64; 3]| [(p[0] - x0) * scale, (y1 - p[1]) * scale];
    let mut layers = Vec::new();
    for (number, floor) in floors.iter().enumerate() {
        progress(
            number as f64 / floors.len() as f64,
            &format!("drawing {} from above", floor.id),
        );
        let [bottom, top] = floor.heights;
        let mut depth = vec![f32::NEG_INFINITY; width * height];
        let mut rgb = vec![0f32; width * height * 3];
        for triangle in surface.triangles {
            let [a, b, c] = triangle.map(|i| &surface.points[i as usize]);
            if a[2].min(b[2]).min(c[2]) > top {
                continue;
            }
            let [pa, pb, pc] = [pixel(a), pixel(b), pixel(c)];
            let area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
            if area.abs() < 1e-12 {
                continue;
            }
            // The face's normal in world x, y, height, turned to face up.
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let mut n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-12);
            if n[2] < 0.0 {
                n = n.map(|x| -x);
            }
            let shade = (0.78
                + 0.32 * ((n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / length).max(0.0))
                as f32;
            let colours = triangle.map(|i| surface.colors[i as usize]);
            let xs = [pa[0], pb[0], pc[0]];
            let ys = [pa[1], pb[1], pc[1]];
            let left = (xs
                .iter()
                .cloned()
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0)) as usize;
            let right = (xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max).ceil() as isize)
                .clamp(0, width as isize) as usize;
            let upper = (ys
                .iter()
                .cloned()
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0)) as usize;
            let lower = (ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max).ceil() as isize)
                .clamp(0, height as isize) as usize;
            for py in upper..lower {
                let sy = py as f64 + 0.5;
                for px in left..right {
                    let sx = px as f64 + 0.5;
                    let w0 = ((pb[0] - sx) * (pc[1] - sy) - (pc[0] - sx) * (pb[1] - sy)) / area;
                    let w1 = ((pc[0] - sx) * (pa[1] - sy) - (pa[0] - sx) * (pc[1] - sy)) / area;
                    let w2 = 1.0 - w0 - w1;
                    if w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9 {
                        continue;
                    }
                    let h = w0 * a[2] + w1 * b[2] + w2 * c[2];
                    if h > top {
                        continue;
                    }
                    let at = py * width + px;
                    if (h as f32) <= depth[at] {
                        continue;
                    }
                    depth[at] = h as f32;
                    for k in 0..3 {
                        let linear = w0 as f32 * colours[0][k]
                            + w1 as f32 * colours[1][k]
                            + w2 as f32 * colours[2][k];
                        rgb[at * 3 + k] = to_srgb(linear) * shade;
                    }
                }
            }
        }
        let opacity = options.lower_opacity.clamp(0.0, 1.0);
        let mut out = vec![0u8; width * height * 3];
        for at in 0..width * height {
            let h = depth[at];
            for k in 0..3 {
                let back = f32::from(background[k]) / 255.0;
                let value = if h == f32::NEG_INFINITY {
                    back
                } else if f64::from(h) < bottom {
                    back + (rgb[at * 3 + k] - back) * opacity
                } else {
                    rgb[at * 3 + k]
                };
                out[at * 3 + k] = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        }
        drop(depth);
        drop(rgb);
        let folder = pack.join(&options.folder).join(&floor.id);
        if folder.exists() {
            fs::remove_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
        }
        let picture = Picture {
            width,
            height,
            rgb: out,
        };
        let (max_zoom, files, bytes) =
            write_pyramid(picture, &folder, options.tile_size, background)?;
        layers.push(RenderedLayer {
            id: floor.id.clone(),
            url: format!("{}/{}/{{z}}/{{x}}/{{y}}.png", options.folder, floor.id),
            min_zoom: 0,
            max_zoom,
            tile_size: options.tile_size,
            files,
            bytes,
        });
    }
    Ok(Rendered {
        width: width as u32,
        height: height as u32,
        pixels_per_unit: scale,
        world_transform: WorldTransform {
            a: 1.0 / scale,
            b: 0.0,
            c: 0.0,
            d: -1.0 / scale,
            e: x0,
            f: y1,
        },
        layers,
    })
}
