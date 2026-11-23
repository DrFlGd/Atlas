//! The 3D builder of Atlas: one raw model in, one 3D map out, the same way
//! for every app that makes them (the Map Maker now, the Importer later), so
//! every 3D map follows the "3D maps" section of `docs/pack-file-format.md`.
//!
//! [`build`] takes a raw model ([`gltf::read_glb`]: a glTF binary file of
//! triangle meshes with vertex colours and plain materials) and [`Options`],
//! and writes into a pack folder:
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
//!    left out for now ([`textures`]).
//! 6. **Draws it from above** when asked ([`render`]): a picture per floor
//!    or of the whole map, cut into map image tiles.
//! 7. **Checks** the scene and its files ([`check`]) and returns the scene
//!    to put on the map in `maps.json`, with a [`Report`].
//!
//! The `atlas-scene` program does the same from the command line (see
//! "Building a 3D map" in `docs/pack-file-format.md`).
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
mod glb;
pub mod gltf;
pub mod render;
pub mod textures;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use gltf::{Material, Model};
use render::{RenderOptions, Rendered, Surface};
use textures::TextureOptions;

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
    /// Materials with a texture, left out in this version.
    pub textures_left_out: usize,
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
struct Transform {
    /// world[row] = sign[row] * scale * p[column[row]] + offset[row]
    column: [usize; 3],
    sign: [f64; 3],
    scale: f64,
    offset: [f64; 3],
}

impl Transform {
    fn new(options: &Options) -> Result<Transform, String> {
        let axes = options
            .axes
            .clone()
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
        let scale = options.scale.unwrap_or(1.0);
        if !(scale.is_finite() && scale > 0.0) {
            return Err("scale must be above 0".to_owned());
        }
        let offset = options.offset.unwrap_or([0.0; 3]);
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

    fn apply(&self, p: &[f64; 3]) -> [f64; 3] {
        [0, 1, 2].map(|row| self.sign[row] * self.scale * p[self.column[row]] + self.offset[row])
    }

    /// Whether it turns the model inside out (a mirror), counted with the
    /// turn from the world to the files' glTF axes, which is none.
    fn mirrors(&self) -> bool {
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
/// triangles and works out the normals.
fn weld(model: &Model, kept: &[usize], transform: &Transform, crease_angle: f64) -> Welded {
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
            faces.push(Face {
                place,
                colors,
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

    // Vertices: a place, a colour and a normal (8 bits a component, as written).
    let mut vertex_of: HashMap<(u32, [u32; 4], [i8; 3]), u32> = HashMap::new();
    let mut welded = Welded {
        origin,
        positions: Vec::new(),
        normals: Vec::new(),
        colors: Vec::new(),
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
            let key = (p as u32, color.map(bits), quantized);
            triangle[corner] = *vertex_of.entry(key).or_insert_with(|| {
                welded.positions.push(places[p].map(|v| v as f32));
                welded.normals.push(normal.map(|v| v as f32));
                welded.colors.push(color);
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
    let mut report = Report {
        triangles_in: model.triangles(),
        compressed: options.compress,
        textures_left_out: textures::left_out(model),
        primitives_skipped: model.skipped_primitives,
        ..Report::default()
    };
    let averaged = options.textures.mode == textures::TextureMode::Average;
    if report.textures_left_out > 0 {
        report.warnings.push(if averaged {
            format!(
                "{} materials have a texture; textures come in a later version, so they keep their texture's average colour",
                report.textures_left_out
            )
        } else {
            format!(
                "{} materials have a texture; textures come in a later version, so they keep their colour only",
                report.textures_left_out
            )
        });
    }
    let materials = textures::materials_for(model, &options.textures);

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
    let welded = weld(model, &kept, &transform, options.crease_angle);
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
        let attributes: Vec<f32> = (0..vertices.len())
            .flat_map(|i| {
                let c = colors[i];
                let n = normals[i];
                [c[0], c[1], c[2], n[0], n[1], n[2]]
            })
            .collect();
        let weights = [
            color_weight,
            color_weight,
            color_weight,
            normal_weight,
            normal_weight,
            normal_weight,
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
                            6 * 4,
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
            let name = format!("{id} level {level}");
            let (file_bytes, written) = glb::write_glb(
                glb::GlbMesh {
                    name: &name,
                    positions: positions.clone(),
                    normals: normals.clone(),
                    colors: has_colors.then(|| colors.clone()),
                    primitives,
                },
                options.compress,
                GENERATOR,
            )?;
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
                    let base = materials[welded.materials[t] as usize].color;
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
    let bytes = fs::read(input).map_err(|e| format!("{}: {e}", input.display()))?;
    let model = gltf::read_glb(&bytes).map_err(|e| format!("{}: {e}", input.display()))?;
    drop(bytes);
    build(&model, options, pack, progress)
}

#[cfg(test)]
mod tests;
