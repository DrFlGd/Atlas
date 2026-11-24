//! The 3D builder of Atlas: one raw model in, one 3D map out, the same way
//! for every app that makes them (the Map Maker now, the Importer later), so
//! every 3D map follows the "3D maps" section of `docs/pack-file-format.md`.
//!
//! [`build`] takes a raw model ([`gltf::read_glb`]: a glTF binary file of
//! triangle meshes with vertex colours and plain materials, or any model
//! file [`formats`] reads: glTF, OBJ, STL or PLY, as a person made or
//! exported it) and [`Options`], and writes into a pack folder:
//!
//! 1. **Lines the model up** with the game's world: [`Options::axes`],
//!    `scale` and `offset` say how the raw model's coordinates become world
//!    x, y and height (as a scene's own fields do). The files it writes use
//!    glTF's own axes around a rounded centre, so the scene it returns has
//!    only an `offset`, and lines up through the map's `worldTransform`.
//! 2. **Drops what is never seen**: every part whose node (or a parent),
//!    mesh or material name matches one of [`Options::drop`] (`*` and `?`,
//!    any case).
//! 3. Floors are not the builder's: a caller that has them writes them as
//!    its layers' `heights` (and may draw each one, step 6).
//! 4. **Cuts it into square cells** (`cellSize`, or a size that gives about
//!    `cellTriangles` each) by each triangle's centre, and makes up to
//!    [`Options::levels`] simpler levels of each cell with meshoptimizer,
//!    one primitive per material within a cell. Vertices shared with
//!    another cell (or another material) never move, so cells at different
//!    levels meet without gaps; normals are worked out on the whole model
//!    first (split where faces meet at more than `creaseAngle`), so no seam
//!    shows between cells.
//! 5. **Compresses** each file with `EXT_meshopt_compression`. Textures are
//!    left out, kept as their average colour, or kept as pictures in each
//!    file that uses them, smaller for coarser levels ([`textures`]).
//! 6. **Draws it from above** when asked ([`render`]): a picture per floor
//!    or of the whole map, cut into map image tiles.
//! 7. **Checks** the scene and its files ([`check`]) and returns the scene
//!    to put on the map in `maps.json`, with a [`Report`].
//!
//! The `atlas-scene` program does the same from the command line (see
//! "Building a 3D map" in `docs/pack-file-format.md`). [`unpack`] reads a
//! map's model back out of a pack as one raw model, so its 2D floors can be
//! drawn again from the pack alone.
//!
//! ```no_run
//! use std::path::Path;
//!
//! fn build(raw: &Path, pack: &Path) -> Result<serde_json::Value, String> {
//!     let mut options = atlas_scene::Options::new("scene/keep");
//!     options.drop = vec!["*invisible*".to_owned()];
//!     let built = atlas_scene::build_file(raw, &options, pack, &mut |fraction, step| {
//!         println!("{:.0} % {step}", fraction * 100.0);
//!     })?;
//!     Ok(built.scene)
//! }
//! ```

// Corners, components and levels are counted 0..3 and the like: indexed loops read best there.
#![allow(clippy::needless_range_loop)]

pub mod check;
pub mod draw;
pub mod formats;
mod glb;
pub mod gltf;
pub mod render;
pub mod textures;
pub mod unpack;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use gltf::{Material, Model};
use render::{RenderOptions, Rendered, Surface};
use textures::TextureOptions;

/// A cell whose finest file holds more bytes of pictures than this is named in a warning.
pub const LARGE_CELL_TEXTURES: u64 = 64 << 20;

/// The program's name and version, written into each model file.
pub const GENERATOR: &str = concat!("Atlas scene builder ", env!("CARGO_PKG_VERSION"));

/// A coarser level of detail.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Level {
    /// The share of the finest level's triangles to aim for, 0 to 1.
    pub ratio: f64,
    /// The largest change of shape allowed, as a share of a cell's side.
    pub error: f64,
}

fn default_levels() -> Vec<Level> {
    vec![
        Level {
            ratio: 0.3,
            error: 0.004,
        },
        Level {
            ratio: 0.08,
            error: 0.02,
        },
    ]
}
fn default_cell_triangles() -> usize {
    60_000
}
fn yes() -> bool {
    true
}
fn default_crease() -> f64 {
    50.0
}

/// How to build a model.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    /// Where the model files go in the pack: `scene/` and one to three
    /// folder names (the map's, say). Its files are `<folder>/<cell>/lod<n>.glb`;
    /// whatever was in it before is replaced.
    pub folder: String,
    /// Which axis of the raw model gives world x, world y and height, as a
    /// scene's `axes` (`["+x", "-z", "+y"]`, glTF's own, when absent).
    #[serde(default)]
    pub axes: Option<[String; 3]>,
    /// World units per raw model unit; 1 when absent.
    #[serde(default)]
    pub scale: Option<f64>,
    /// Added after scaling, `[x, y, height]`; none when absent.
    #[serde(default)]
    pub offset: Option<[f64; 3]>,
    /// Name patterns of parts never seen in game (invisible walls, debug
    /// shapes, clutter): `*` any run of characters, `?` one, any case.
    #[serde(default)]
    pub drop: Vec<String>,
    /// A cell's side in world units; chosen from `cellTriangles` when absent.
    #[serde(default)]
    pub cell_size: Option<f64>,
    /// About how many triangles a cell's finest level holds, when `cellSize`
    /// is absent.
    #[serde(default = "default_cell_triangles")]
    pub cell_triangles: usize,
    /// The coarser levels, finest first; a level that saves little is left out.
    #[serde(default = "default_levels")]
    pub levels: Vec<Level>,
    /// Write the files with `EXT_meshopt_compression`.
    #[serde(default = "yes")]
    pub compress: bool,
    /// Faces meeting at more than this angle (degrees) get a hard edge.
    #[serde(default = "default_crease")]
    pub crease_angle: f64,
    #[serde(default)]
    pub textures: TextureOptions,
    /// Passed on to the scene: `#rrggbb`.
    #[serde(default)]
    pub sky: Option<String>,
    /// Passed on to the scene: the height of open water.
    #[serde(default)]
    pub water: Option<f64>,
    /// Passed on to the scene: where the 3D view starts.
    #[serde(default)]
    pub camera: Option<Value>,
    /// Draw the model from above into map image tiles.
    #[serde(default)]
    pub render: Option<RenderOptions>,
    /// Every material seen from both sides (`true`) or from its front only
    /// (`false`); absent, as each material says (a glTF material's
    /// `doubleSided`; OBJ, STL and PLY materials are seen from both sides).
    #[serde(default)]
    pub double_sided: Option<bool>,
    /// A model file of more triangles is refused
    /// ([`formats::LARGEST_MAX_TRIANGLES`] when absent).
    #[serde(default)]
    pub max_triangles: Option<usize>,
}

impl Options {
    /// The options with every default, for `folder`.
    pub fn new(folder: &str) -> Options {
        serde_json::from_value(json!({ "folder": folder })).expect("defaults")
    }
}

/// One level of detail over all cells.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelReport {
    pub level: u32,
    pub cells: usize,
    pub triangles: usize,
    pub bytes: u64,
    /// The bytes of pictures in those files (part of `bytes`).
    pub texture_bytes: u64,
}

/// The pictures of one cell's file at one level, when textures are kept.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellTextures {
    pub cell: String,
    pub level: u32,
    /// How many pictures the file holds.
    pub pictures: usize,
    /// Their bytes.
    pub bytes: u64,
}

/// How a build went.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Triangles of the raw model.
    pub triangles_in: usize,
    /// Triangles of the parts dropped by name, and how many parts.
    pub triangles_dropped: usize,
    pub parts_dropped: usize,
    /// Triangles left out as flat, or as a copy of another.
    pub triangles_cleaned: usize,
    /// Triangles of the finest level, all cells together.
    pub triangles: usize,
    pub levels: Vec<LevelReport>,
    pub cells: usize,
    pub cell_size: f64,
    pub files: usize,
    pub bytes: u64,
    pub seconds: f64,
    pub compressed: bool,
    /// Materials with a texture that is not kept as one.
    pub textures_left_out: usize,
    /// Materials whose texture is kept (textures `keep`).
    pub textures_kept: usize,
    /// The bytes of pictures in all files.
    pub texture_bytes: u64,
    /// The pictures of each cell's file at each level (textures `keep`).
    pub cell_textures: Vec<CellTextures>,
    /// The cells were made smaller than the triangles alone ask, so that
    /// each holds fewer pictures (textures `keep`, `cellBytes`).
    pub cells_smaller_for_textures: bool,
    /// Primitives that are not triangles.
    pub primitives_skipped: usize,
    pub warnings: Vec<String>,
}

/// The result: the scene for `maps.json`, the report, and the pictures when drawn.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub scene: Value,
    pub report: Report,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered: Option<Rendered>,
}

/// The raw model's coordinates to the world's.
#[derive(Clone, Copy, Debug)]
pub struct Transform {
    /// world[row] = sign[row] * scale * p[column[row]] + offset[row]
    column: [usize; 3],
    sign: [f64; 3],
    scale: f64,
    offset: [f64; 3],
}

impl Transform {
    fn new(options: &Options) -> Result<Transform, String> {
        Transform::from_parts(options.axes.as_ref(), options.scale, options.offset)
    }

    /// From a scene's `axes`, `scale` and `offset` (see [`Options`]).
    pub fn from_parts(
        axes: Option<&[String; 3]>,
        scale: Option<f64>,
        offset: Option<[f64; 3]>,
    ) -> Result<Transform, String> {
        let axes = axes
            .cloned()
            .unwrap_or_else(|| ["+x".to_owned(), "-z".to_owned(), "+y".to_owned()]);
        let mut column = [0; 3];
        let mut sign = [1.0; 3];
        for (row, axis) in axes.iter().enumerate() {
            let (s, c) = match axis.as_str() {
                "+x" => (1.0, 0),
                "-x" => (-1.0, 0),
                "+y" => (1.0, 1),
                "-y" => (-1.0, 1),
                "+z" => (1.0, 2),
                "-z" => (-1.0, 2),
                other => {
                    return Err(format!(
                        "axes: {other} is not one of +x, -x, +y, -y, +z, -z"
                    ))
                }
            };
            column[row] = c;
            sign[row] = s;
        }
        if column.iter().collect::<HashSet<_>>().len() != 3 {
            return Err("axes must name each of x, y and z once".to_owned());
        }
        let scale = scale.unwrap_or(1.0);
        if !(scale.is_finite() && scale > 0.0) {
            return Err("scale must be above 0".to_owned());
        }
        let offset = offset.unwrap_or([0.0; 3]);
        if offset.iter().any(|v| !v.is_finite()) {
            return Err("offset must be three numbers".to_owned());
        }
        Ok(Transform {
            column,
            sign,
            scale,
            offset,
        })
    }

    /// World x, y and height of a raw model point.
    pub fn apply(&self, p: &[f64; 3]) -> [f64; 3] {
        [0, 1, 2].map(|row| self.sign[row] * self.scale * p[self.column[row]] + self.offset[row])
    }

    /// Whether it turns the model inside out (a mirror), counted with the
    /// turn from the world to the files' glTF axes, which is none.
    pub fn mirrors(&self) -> bool {
        // The sign of the permutation times the signs of the axes.
        let [a, b, c] = self.column;
        let inversions = usize::from(a > b) + usize::from(a > c) + usize::from(b > c);
        let parity = if inversions % 2 == 0 { 1.0 } else { -1.0 };
        parity * self.sign[0] * self.sign[1] * self.sign[2] < 0.0
    }
}

/// Whether `name` matches `pattern` (`*`, `?`, any case).
pub fn matches(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut i, mut j) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while j < n.len() {
        if i < p.len() && (p[i] == '?' || p[i] == n[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == '*' {
            star = Some((i, j));
            i += 1;
        } else if let Some((si, sj)) = star {
            i = si + 1;
            j = sj + 1;
            star = Some((si, sj + 1));
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == '*' {
        i += 1;
    }
    i == p.len()
}

fn bits(v: f32) -> u32 {
    // -0 and 0 are one place.
    if v == 0.0 {
        0
    } else {
        v.to_bits()
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn length(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

/// A welded model in the files' coordinates (glTF axes around `origin`).
struct Welded {
    origin: [f64; 3],
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    colors: Vec<[f32; 4]>,
    /// Texture coordinates, when they are kept (all zero otherwise).
    uvs: Vec<[f32; 2]>,
    /// The position each vertex stands on (vertices split at a crease or a
    /// change of colour share one).
    place: Vec<u32>,
    places: usize,
    triangles: Vec<[u32; 3]>,
    materials: Vec<u32>,
    cleaned: usize,
}

impl Welded {
    /// World x, y and height of a vertex.
    fn world(&self, vertex: usize) -> [f64; 3] {
        let p = self.positions[vertex];
        [
            f64::from(p[0]) + self.origin[0],
            -f64::from(p[2]) + self.origin[1],
            f64::from(p[1]) + self.origin[2],
        ]
    }
}

/// Lines the parts up, welds their vertices, leaves out flat and repeated
/// triangles and works out the normals. With `keep_uvs`, a vertex keeps its
/// texture coordinates too (vertices that differ in them are not joined).
fn weld(
    model: &Model,
    kept: &[usize],
    transform: &Transform,
    crease_angle: f64,
    keep_uvs: bool,
) -> Welded {
    let mirror = transform.mirrors();
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    let world: Vec<Vec<[f64; 3]>> = kept
        .iter()
        .map(|&p| {
            model.parts[p]
                .positions
                .iter()
                .map(|q| {
                    let w = transform.apply(q);
                    for k in 0..3 {
                        low[k] = low[k].min(w[k]);
                        high[k] = high[k].max(w[k]);
                    }
                    w
                })
                .collect()
        })
        .collect();
    let origin = if low[0].is_finite() {
        [0, 1, 2].map(|k| ((low[k] + high[k]) / 2.0).round())
    } else {
        [0.0; 3]
    };
    // Positions welded on their exact place in the files' coordinates.
    let mut place_of: HashMap<[u32; 3], u32> = HashMap::new();
    let mut places: Vec<[f64; 3]> = Vec::new();
    struct Face {
        place: [u32; 3],
        colors: [[f32; 4]; 3],
        uvs: [[f32; 2]; 3],
        material: u32,
    }
    let mut faces: Vec<Face> = Vec::new();
    let mut seen: HashSet<([u32; 3], u32)> = HashSet::new();
    let mut cleaned = 0;
    for (k, &p) in kept.iter().enumerate() {
        let part = &model.parts[p];
        let ids: Vec<u32> = world[k]
            .iter()
            .map(|w| {
                let file = [
                    (w[0] - origin[0]) as f32,
                    (w[2] - origin[2]) as f32,
                    -(w[1] - origin[1]) as f32,
                ];
                let key = file.map(bits);
                *place_of.entry(key).or_insert_with(|| {
                    places.push(file.map(f64::from));
                    (places.len() - 1) as u32
                })
            })
            .collect();
        for triangle in part.indices.as_chunks::<3>().0 {
            let mut corners = [
                triangle[0] as usize,
                triangle[1] as usize,
                triangle[2] as usize,
            ];
            if mirror {
                corners.swap(1, 2);
            }
            let place = corners.map(|c| ids[c]);
            if place[0] == place[1] || place[1] == place[2] || place[0] == place[2] {
                cleaned += 1;
                continue;
            }
            let [a, b, c] = place.map(|i| places[i as usize]);
            if length(cross(sub(b, a), sub(c, a))) < 1e-10 {
                cleaned += 1;
                continue;
            }
            let mut sorted = place;
            sorted.sort_unstable();
            if !seen.insert((sorted, part.material as u32)) {
                cleaned += 1;
                continue;
            }
            let colors = match &part.colors {
                Some(colors) => corners.map(|c| colors[c]),
                None => [[1.0; 4]; 3],
            };
            let uvs = match (&part.uvs, keep_uvs) {
                (Some(uvs), true) => corners.map(|c| uvs[c]),
                _ => [[0.0; 2]; 3],
            };
            faces.push(Face {
                place,
                colors,
                uvs,
                material: part.material as u32,
            });
        }
    }
    drop(world);
    drop(seen);
    drop(place_of);

    // Face normals (unit) and areas, and the faces at each place.
    let face_normal: Vec<([f64; 3], f64)> = faces
        .iter()
        .map(|f| {
            let [a, b, c] = f.place.map(|i| places[i as usize]);
            let n = cross(sub(b, a), sub(c, a));
            let l = length(n);
            ([n[0] / l, n[1] / l, n[2] / l], l / 2.0)
        })
        .collect();
    let mut start = vec![0u32; places.len() + 1];
    for f in &faces {
        for &p in &f.place {
            start[p as usize + 1] += 1;
        }
    }
    for i in 0..places.len() {
        start[i + 1] += start[i];
    }
    let mut fill = start.clone();
    let mut around = vec![0u32; start[places.len()] as usize];
    for (index, f) in faces.iter().enumerate() {
        for &p in &f.place {
            around[fill[p as usize] as usize] = index as u32;
            fill[p as usize] += 1;
        }
    }
    let limit = crease_angle.clamp(0.0, 180.0).to_radians().cos();

    // Vertices: a place, a colour, a normal (8 bits a component, as
    // written) and texture coordinates.
    type VertexKey = (u32, [u32; 4], [i8; 3], [u32; 2]);
    let mut vertex_of: HashMap<VertexKey, u32> = HashMap::new();
    let mut welded = Welded {
        origin,
        positions: Vec::new(),
        normals: Vec::new(),
        colors: Vec::new(),
        uvs: Vec::new(),
        place: Vec::new(),
        places: places.len(),
        triangles: Vec::with_capacity(faces.len()),
        materials: Vec::with_capacity(faces.len()),
        cleaned,
    };
    for (index, face) in faces.iter().enumerate() {
        let own = face_normal[index].0;
        let mut triangle = [0u32; 3];
        for corner in 0..3 {
            let p = face.place[corner] as usize;
            let mut sum = [0.0; 3];
            for &g in &around[start[p] as usize..start[p + 1] as usize] {
                let (n, area) = face_normal[g as usize];
                if dot(n, own) >= limit {
                    for k in 0..3 {
                        sum[k] += n[k] * area;
                    }
                }
            }
            let l = length(sum);
            let normal = if l > 1e-12 { sum.map(|v| v / l) } else { own };
            let quantized = normal.map(|v| (v.clamp(-1.0, 1.0) * 127.0).round() as i8);
            let color = face.colors[corner];
            let uv = face.uvs[corner];
            let key = (p as u32, color.map(bits), quantized, uv.map(bits));
            triangle[corner] = *vertex_of.entry(key).or_insert_with(|| {
                welded.positions.push(places[p].map(|v| v as f32));
                welded.normals.push(normal.map(|v| v as f32));
                welded.colors.push(color);
                welded.uvs.push(uv);
                welded.place.push(p as u32);
                (welded.positions.len() - 1) as u32
            });
        }
        welded.triangles.push(triangle);
        welded.materials.push(face.material);
    }
    welded
}

/// The bytes of positions, for meshopt.
fn position_bytes(positions: &[[f32; 3]]) -> Vec<u8> {
    positions
        .iter()
        .flat_map(|p| p.iter().flat_map(|v| v.to_le_bytes()))
        .collect()
}

/// The side of cells (at most `side`) whose finest files each hold at most
/// `textures.cellBytes` of pictures (each picture counted once a cell, at
/// its own bytes): `side` made smaller step by step, never below
/// [`textures::MIN_TEXTURED_CELL`] nor into more than [`check::MAX_CELLS`]
/// cells.
fn fit_cells_to_pictures(
    model: &Model,
    welded: &Welded,
    world: &[[f64; 3]],
    low: [f64; 3],
    side: f64,
    options: &Options,
    grid: &dyn Fn(f64) -> (usize, usize),
) -> f64 {
    let budget = options
        .textures
        .cell_bytes
        .unwrap_or(LARGE_CELL_TEXTURES)
        .max(1);
    let pictures: Vec<Option<(usize, u64)>> = model
        .materials
        .iter()
        .map(|m| {
            m.texture.map(|t| {
                (
                    t.image,
                    model.images.get(t.image).map_or(0, |b| b.len() as u64),
                )
            })
        })
        .collect();
    let centres: Vec<[f64; 2]> = welded
        .triangles
        .iter()
        .map(|t| [0, 1].map(|k| t.iter().map(|&v| world[v as usize][k]).sum::<f64>() / 3.0))
        .collect();
    let heaviest = |side: f64| -> u64 {
        let (columns, rows) = grid(side);
        let mut seen: HashSet<(usize, usize)> = HashSet::new();
        let mut bytes: HashMap<usize, u64> = HashMap::new();
        for (t, centre) in centres.iter().enumerate() {
            let Some(Some((image, size))) = pictures.get(welded.materials[t] as usize) else {
                continue;
            };
            let cx = (((centre[0] - low[0]) / side).floor().max(0.0) as usize).min(columns - 1);
            let cy = (((centre[1] - low[1]) / side).floor().max(0.0) as usize).min(rows - 1);
            let cell = cy * columns + cx;
            if seen.insert((cell, *image)) {
                *bytes.entry(cell).or_default() += size;
            }
        }
        bytes.values().copied().max().unwrap_or(0)
    };
    let mut side = side;
    while side > textures::MIN_TEXTURED_CELL && heaviest(side) > budget {
        let next = (side * 0.7).max(textures::MIN_TEXTURED_CELL);
        let (columns, rows) = grid(next);
        if columns * rows > check::MAX_CELLS {
            break;
        }
        side = next;
    }
    side
}

/// Builds the model into the pack folder `pack`; see the crate's description.
pub fn build(
    model: &Model,
    options: &Options,
    pack: &Path,
    progress: &mut dyn FnMut(f64, &str),
) -> Result<Built, String> {
    let started = Instant::now();
    let transform = Transform::new(options)?;
    let folder = options.folder.trim_end_matches('/');
    if !atlas_pack::is_scene_file_name(&format!("{folder}/c/lod0.glb")) || folder == "scene" {
        return Err(format!(
            "the folder {folder} must be scene/ and one to three folder names of a-z, 0-9, _, . and -"
        ));
    }
    if !(options.crease_angle.is_finite()) {
        return Err("creaseAngle must be a number".to_owned());
    }
    for level in &options.levels {
        if !(level.ratio > 0.0
            && level.ratio < 1.0
            && level.error >= 0.0
            && level.error.is_finite())
        {
            return Err(
                "each level needs a ratio between 0 and 1 and an error of 0 or more".to_owned(),
            );
        }
    }
    if options.levels.len() > check::MAX_LEVEL as usize {
        return Err("a cell has at most 7 coarser levels".to_owned());
    }
    options.textures.max_side()?;
    let keeping = options.textures.mode == textures::TextureMode::Keep;
    let mut report = Report {
        triangles_in: model.triangles(),
        compressed: options.compress,
        textures_left_out: textures::left_out(model, &options.textures),
        textures_kept: if keeping {
            model
                .materials
                .iter()
                .filter(|m| m.texture.is_some())
                .count()
        } else {
            0
        },
        primitives_skipped: model.skipped_primitives,
        ..Report::default()
    };
    if report.textures_left_out > 0 {
        report.warnings.push(match options.textures.mode {
            textures::TextureMode::Average => format!(
                "{} materials have a texture; textures are not kept in this build, so they keep their texture's average colour",
                report.textures_left_out
            ),
            textures::TextureMode::Keep => format!(
                "{} materials have a texture whose picture is not a PNG or JPEG picture in the file, so they keep their colour only",
                report.textures_left_out
            ),
            textures::TextureMode::LeaveOut => format!(
                "{} materials have a texture; textures are not kept in this build, so they keep their colour only",
                report.textures_left_out
            ),
        });
    }
    let mut materials = textures::materials_for(model, &options.textures);
    if let Some(both) = options.double_sided {
        for material in &mut materials {
            material.double_sided = both;
        }
    }
    let mut pictures = textures::Pictures::new(model, options.textures);

    // 2. What is never seen.
    progress(0.02, "leaving out what is never seen");
    let patterns: Vec<&str> = options
        .drop
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    let mut kept = Vec::new();
    for (index, part) in model.parts.iter().enumerate() {
        if part
            .names
            .iter()
            .any(|name| patterns.iter().any(|p| matches(p, name)))
        {
            report.parts_dropped += 1;
            report.triangles_dropped += part.indices.len() / 3;
        } else {
            kept.push(index);
        }
    }

    // 1. Lined up with the world; welded, with normals.
    progress(0.05, "lining the model up and joining its vertices");
    let welded = weld(model, &kept, &transform, options.crease_angle, keeping);
    report.triangles_cleaned = welded.cleaned;
    if welded.triangles.is_empty() {
        return Err("nothing is left of the model to show".to_owned());
    }
    let has_colors = kept.iter().any(|&p| model.parts[p].colors.is_some());

    // 4. Cells: a square grid over the model, each triangle in the cell of its centre.
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    let world: Vec<[f64; 3]> = (0..welded.positions.len())
        .map(|v| welded.world(v))
        .collect();
    for w in &world {
        for k in 0..3 {
            low[k] = low[k].min(w[k]);
            high[k] = high[k].max(w[k]);
        }
    }
    let extent = (high[0] - low[0]).max(high[1] - low[1]).max(1e-3);
    let mut side = match options.cell_size {
        Some(size) if size.is_finite() && size > 0.0 => size,
        Some(_) => return Err("cellSize must be above 0".to_owned()),
        None => {
            let wanted =
                (welded.triangles.len() as f64 / options.cell_triangles.max(1) as f64).sqrt();
            let across = wanted.ceil().clamp(1.0, 16.0);
            (extent / across).max(extent.min(16.0)).ceil()
        }
    };
    let grid = |side: f64| {
        (
            (((high[0] - low[0]) / side).floor() as usize + 1).max(1),
            (((high[1] - low[1]) / side).floor() as usize + 1).max(1),
        )
    };
    if keeping && options.cell_size.is_none() {
        let fitted = fit_cells_to_pictures(model, &welded, &world, low, side, options, &grid);
        report.cells_smaller_for_textures = fitted < side;
        side = fitted;
    }
    while grid(side).0 * grid(side).1 > check::MAX_CELLS {
        side *= 1.25;
    }
    let (columns, rows) = grid(side);
    report.cell_size = side;
    let cell_of: Vec<u32> = welded
        .triangles
        .iter()
        .map(|t| {
            let centre = [0, 1].map(|k| t.iter().map(|&v| world[v as usize][k]).sum::<f64>() / 3.0);
            let cx = (((centre[0] - low[0]) / side).floor().max(0.0) as usize).min(columns - 1);
            let cy = (((centre[1] - low[1]) / side).floor().max(0.0) as usize).min(rows - 1);
            (cy * columns + cx) as u32
        })
        .collect();
    // Places shared by two cells or two materials never move.
    let mut place_cell = vec![u32::MAX; welded.places];
    let mut place_material = vec![u32::MAX; welded.places];
    let mut locked = vec![false; welded.places];
    for (index, triangle) in welded.triangles.iter().enumerate() {
        for &v in triangle {
            let p = welded.place[v as usize] as usize;
            for (slot, value) in [
                (&mut place_cell[p], cell_of[index]),
                (&mut place_material[p], welded.materials[index]),
            ] {
                if *slot == u32::MAX {
                    *slot = value;
                } else if *slot != value {
                    locked[p] = true;
                }
            }
        }
    }
    drop(place_cell);
    drop(place_material);

    let mut order: Vec<u32> = (0..welded.triangles.len() as u32).collect();
    order.sort_by_key(|&t| (cell_of[t as usize], welded.materials[t as usize]));

    let target = pack.join(folder);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    let materials: &[Material] = &materials;
    let mut cells: Vec<Value> = Vec::new();
    let mut local = vec![u32::MAX; welded.positions.len()];
    let mut level_reports: Vec<LevelReport> = (0..=options.levels.len())
        .map(|level| LevelReport {
            level: level as u32,
            ..LevelReport::default()
        })
        .collect();
    let groups: Vec<&[u32]> = order
        .chunk_by(|a, b| cell_of[*a as usize] == cell_of[*b as usize])
        .collect();
    for (number, group) in groups.iter().enumerate() {
        let cell = cell_of[group[0] as usize] as usize;
        let (cx, cy) = (cell % columns, cell / columns);
        let id = format!("c{cx}-{cy}");
        progress(
            0.1 + 0.8 * number as f64 / groups.len() as f64,
            &format!(
                "cell {} of {}: making its levels of detail",
                number + 1,
                groups.len()
            ),
        );
        // The cell's own vertices.
        let mut vertices: Vec<u32> = Vec::new();
        let mut by_material: Vec<(u32, Vec<u32>)> = Vec::new();
        for &t in group.iter() {
            let material = welded.materials[t as usize];
            if by_material.last().is_none_or(|(m, _)| *m != material) {
                by_material.push((material, Vec::new()));
            }
            let list = &mut by_material.last_mut().expect("pushed").1;
            for &v in &welded.triangles[t as usize] {
                if local[v as usize] == u32::MAX {
                    local[v as usize] = vertices.len() as u32;
                    vertices.push(v);
                }
                list.push(local[v as usize]);
            }
        }
        for &v in &vertices {
            local[v as usize] = u32::MAX;
        }
        let positions: Vec<[f32; 3]> = vertices
            .iter()
            .map(|&v| welded.positions[v as usize])
            .collect();
        let normals: Vec<[f32; 3]> = vertices
            .iter()
            .map(|&v| welded.normals[v as usize])
            .collect();
        let colors: Vec<[f32; 4]> = vertices
            .iter()
            .map(|&v| welded.colors[v as usize])
            .collect();
        let uvs: Vec<[f32; 2]> = if keeping {
            vertices.iter().map(|&v| welded.uvs[v as usize]).collect()
        } else {
            Vec::new()
        };
        let locks: Vec<bool> = vertices
            .iter()
            .map(|&v| locked[welded.place[v as usize] as usize])
            .collect();
        let heights = vertices
            .iter()
            .fold([f64::INFINITY, f64::NEG_INFINITY], |[lo, hi], &v| {
                let h = world[v as usize][2];
                [lo.min(h), hi.max(h)]
            });
        let bytes = position_bytes(&positions);
        let adapter = meshopt::VertexDataAdapter::new(&bytes, 12, 0).map_err(|e| e.to_string())?;
        let color_weight = (0.05 * side) as f32;
        let normal_weight = (0.01 * side) as f32;
        // Texture coordinates, when kept, weigh as a hundredth of the side per repeat.
        let uv_weight = if keeping { (0.01 * side) as f32 } else { 0.0 };
        let attributes: Vec<f32> = (0..vertices.len())
            .flat_map(|i| {
                let c = colors[i];
                let n = normals[i];
                let uv = uvs.get(i).copied().unwrap_or([0.0; 2]);
                [c[0], c[1], c[2], n[0], n[1], n[2], uv[0], uv[1]]
            })
            .collect();
        let weights = [
            color_weight,
            color_weight,
            color_weight,
            normal_weight,
            normal_weight,
            normal_weight,
            uv_weight,
            uv_weight,
        ];
        let mut lods: Vec<Value> = Vec::new();
        let mut previous = usize::MAX;
        for level in 0..=options.levels.len() {
            let primitives: Vec<(Material, Vec<u32>)> = if level == 0 {
                by_material
                    .iter()
                    .map(|(m, i)| (materials[*m as usize].clone(), i.clone()))
                    .collect()
            } else {
                let settings = options.levels[level - 1];
                let mut flags = meshopt::SimplifyOptions::ErrorAbsolute;
                if by_material.len() > 1 {
                    flags |= meshopt::SimplifyOptions::Sparse;
                }
                by_material
                    .iter()
                    .map(|(m, indices)| {
                        let goal = ((indices.len() / 3) as f64 * settings.ratio) as usize * 3;
                        let simpler = meshopt::simplify_with_attributes_and_locks(
                            indices,
                            &adapter,
                            &attributes,
                            &weights,
                            8 * 4,
                            &locks,
                            goal,
                            (settings.error * side) as f32,
                            flags,
                            None,
                        );
                        (materials[*m as usize].clone(), simpler)
                    })
                    .collect()
            };
            let triangles: usize = primitives.iter().map(|(_, i)| i.len() / 3).sum();
            if level > 0 && (triangles == 0 || triangles as f64 > 0.85 * previous as f64) {
                break;
            }
            let primitives: Vec<glb::GlbPrimitive> = primitives
                .into_iter()
                .map(|(material, indices)| glb::GlbPrimitive {
                    texture: material
                        .texture
                        .and_then(|texture| pictures.at(texture.image, level)),
                    material,
                    indices,
                })
                .collect();
            let name = format!("{id} level {level}");
            let written_file = glb::write_glb(
                glb::GlbMesh {
                    name: &name,
                    positions: positions.clone(),
                    normals: normals.clone(),
                    colors: has_colors.then(|| colors.clone()),
                    uvs: keeping.then(|| uvs.clone()),
                    primitives,
                },
                options.compress,
                GENERATOR,
            )?;
            let file_bytes = written_file.bytes;
            let written = written_file.triangles;
            if keeping && written_file.texture_bytes > 0 {
                report.texture_bytes += written_file.texture_bytes;
                report.cell_textures.push(CellTextures {
                    cell: id.clone(),
                    level: level as u32,
                    pictures: written_file.pictures,
                    bytes: written_file.texture_bytes,
                });
            }
            if file_bytes.len() as u64 > check::MAX_FILE_BYTES {
                return Err(format!(
                    "cell {id} level {level} would be over 256 MB; give a smaller cellSize"
                ));
            }
            let file = format!("{folder}/{id}/lod{level}.glb");
            let path = pack.join(&file);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            fs::write(&path, &file_bytes).map_err(|e| format!("{}: {e}", path.display()))?;
            report.files += 1;
            report.bytes += file_bytes.len() as u64;
            let entry = &mut level_reports[level];
            entry.cells += 1;
            entry.triangles += written;
            entry.bytes += file_bytes.len() as u64;
            entry.texture_bytes += written_file.texture_bytes;
            lods.push(json!({ "level": level, "file": file, "triangles": written }));
            previous = written;
        }
        let x0 = low[0] + cx as f64 * side;
        let y0 = low[1] + cy as f64 * side;
        cells.push(json!({
            "id": id,
            "bounds": [x0, y0, x0 + side, y0 + side],
            "heights": heights,
            "lods": lods,
        }));
    }
    report.cells = cells.len();
    report.triangles = level_reports[0].triangles;
    if !pictures.unreadable.is_empty() {
        report.warnings.push(format!(
            "{} pictures of textures could not be read, so the materials that show them keep their colour only",
            pictures.unreadable.len()
        ));
    }
    if let Some(largest) = report
        .cell_textures
        .iter()
        .filter(|c| c.level == 0)
        .max_by_key(|c| c.bytes)
        .filter(|c| c.bytes > LARGE_CELL_TEXTURES)
    {
        report.warnings.push(format!(
            "cell {} holds {} MB of pictures at its finest level; a smaller textures.maxSize makes it lighter",
            largest.cell,
            largest.bytes.div_ceil(1 << 20)
        ));
    }
    report.levels = level_reports.into_iter().filter(|l| l.cells > 0).collect();

    let mut scene = json!({
        "offset": welded.origin,
        "heights": [low[2], high[2]],
        "cells": cells,
    });
    if let Some(sky) = &options.sky {
        scene["sky"] = json!(sky);
    }
    if let Some(water) = options.water {
        scene["water"] = json!(water);
    }
    if let Some(camera) = &options.camera {
        scene["camera"] = camera.clone();
    }

    // 6. The pictures from above.
    let rendered = match &options.render {
        Some(render_options) => {
            let colors: Vec<[f32; 3]> = {
                let mut out = vec![[1.0f32; 3]; welded.positions.len()];
                let mut done = vec![false; welded.positions.len()];
                for (t, triangle) in welded.triangles.iter().enumerate() {
                    let m = welded.materials[t] as usize;
                    // A kept texture is drawn from above as its average colour.
                    let base = if keeping {
                        let c = textures::drawn_colour(&model.materials[m]);
                        [c[0], c[1], c[2], 1.0]
                    } else {
                        materials[m].color
                    };
                    for &v in triangle {
                        if !std::mem::replace(&mut done[v as usize], true) {
                            let c = welded.colors[v as usize];
                            out[v as usize] = [c[0] * base[0], c[1] * base[1], c[2] * base[2]];
                        }
                    }
                }
                out
            };
            let mut told = |fraction: f64, text: &str| progress(0.9 + 0.08 * fraction, text);
            Some(render::render(
                &Surface {
                    points: &world,
                    colors: &colors,
                    triangles: &welded.triangles,
                },
                render_options,
                pack,
                &mut told,
            )?)
        }
        None => None,
    };

    // 7. Checked as the format says.
    progress(0.98, "checking the scene and its files");
    let problems = check::check_scene(&scene, Some(pack), &mut HashSet::new());
    if !problems.is_empty() {
        return Err(format!(
            "the scene does not pass its checks: {}",
            problems.join("; ")
        ));
    }
    report.seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    progress(1.0, "done");
    Ok(Built {
        scene,
        report,
        rendered,
    })
}

/// Reads a raw model file and builds it; see [`build`].
pub fn build_file(
    input: &Path,
    options: &Options,
    pack: &Path,
    progress: &mut dyn FnMut(f64, &str),
) -> Result<Built, String> {
    progress(0.0, "reading the model");
    let read = formats::ReadOptions {
        // A raw model another app wrote is read whatever its size; the Map Maker names the most for a model file.
        max_triangles: options
            .max_triangles
            .unwrap_or(formats::LARGEST_MAX_TRIANGLES),
    };
    let (model, _) = read_model(input, &read)?;
    build(&model, options, pack, progress)
}

/// Reads a model file of any format the builder reads ([`formats`]): a file
/// that is not `.glb` by name but holds a glTF binary (a raw model written
/// by another app) is read as one too.
pub fn read_model(
    input: &Path,
    read: &formats::ReadOptions,
) -> Result<(Model, formats::ModelInfo), String> {
    let extension = input
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !formats::EXTENSIONS.contains(&extension.as_str()) {
        let start = fs::File::open(input)
            .and_then(|mut file| {
                let mut head = [0u8; 4];
                std::io::Read::read_exact(&mut file, &mut head).map(|_| head)
            })
            .unwrap_or_default();
        if &start == b"glTF" {
            let bytes = fs::read(input).map_err(|e| format!("{}: {e}", input.display()))?;
            let model = gltf::read_glb(&bytes).map_err(|e| format!("{}: {e}", input.display()))?;
            return Ok((model, formats::ModelInfo::default()));
        }
    }
    formats::read_model(input, read)
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_formats;
