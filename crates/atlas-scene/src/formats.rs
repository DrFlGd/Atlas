//! Reading the popular 3D model files into the builder's raw model
//! ([`Model`]), so a model made from scratch or exported from a modelling
//! program becomes a 3D map like any other:
//!
//! - **glTF 2.0**: `.glb`, or `.gltf` with its buffers and pictures in files
//!   next to it or in `data:` URIs ([`crate::gltf`]); materials say whether
//!   they are seen from both sides;
//! - **Wavefront OBJ** (`.obj`) with its materials file (`.mtl`) and the
//!   pictures it names (each material's `map_Kd`), read with `tobj`;
//! - **STL** (`.stl`), binary or text;
//! - **PLY** (`.ply`), text or binary, with vertex colours and texture
//!   coordinates (per vertex, or per face corner as some programs write
//!   them) and its `TextureFile` comment.
//!
//! OBJ, STL and PLY say nothing of which side of a surface is its front,
//! and exported models often mix both windings, so their materials are seen
//! from both sides (`Options::double_sided` in the builder can say
//! otherwise). FBX and COLLADA files are refused with a message that says
//! to export the model as glTF or OBJ: no permissively licensed Rust reader
//! of them works out their node transforms (pivots, pre- and post-rotations,
//! geometric transforms) and materials reliably yet.
//!
//! A picture that is not PNG or JPEG (an OBJ's TGA or BMP texture) is
//! turned into a PNG once, so it is kept like the others. Every reader
//! refuses a model of more triangles than [`ReadOptions::max_triangles`]
//! before it holds them all, and a bad file gives a plain message, never a
//! crash.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::gltf::{self, AlphaMode, Companions, GltfNotes, Material, Model, Part, TextureRef};

/// Models of more triangles than this are refused, unless the person allows very large models.
pub const DEFAULT_MAX_TRIANGLES: usize = 5_000_000;
/// "Allow very large models": the most that is ever read.
pub const LARGEST_MAX_TRIANGLES: usize = 50_000_000;
/// A larger model file is not read.
pub const MAX_FILE_BYTES: u64 = 4 << 30;

/// The extensions of the model files that are read, and of those that are refused with a reason.
pub const EXTENSIONS: [&str; 5] = ["glb", "gltf", "obj", "stl", "ply"];

/// How to read a model file.
#[derive(Clone, Copy, Debug)]
pub struct ReadOptions {
    pub max_triangles: usize,
}

impl Default for ReadOptions {
    fn default() -> Self {
        ReadOptions {
            max_triangles: DEFAULT_MAX_TRIANGLES,
        }
    }
}

/// What a model file holds, for the person to check before a map is made of it.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// `gltf`, `obj`, `stl` or `ply`.
    pub format: String,
    /// "glTF binary", "glTF", "OBJ", "STL (binary)", …
    pub format_name: String,
    pub triangles: usize,
    pub parts: usize,
    pub materials: usize,
    /// Materials with a texture, and those whose picture was found and can be read.
    pub textured_materials: usize,
    pub textures_found: usize,
    /// Vertex colours, textures or more than one colour of material: the model has colours of its own.
    pub has_colours: bool,
    /// The axis that is most likely up for this kind of file: `+y` or `+z`.
    pub up: String,
    /// Whether the file says which materials are seen from both sides (glTF does; OBJ, STL and PLY do not).
    pub sides_given: bool,
    /// The model's box in its own units and axes.
    pub min: [f64; 3],
    pub max: [f64; 3],
    /// Files the model names that are not there (its materials file, pictures, buffers).
    pub missing_files: Vec<String>,
    pub warnings: Vec<String>,
}

/// "1,234,567".
pub fn count_text(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn too_many(max: usize) -> String {
    gltf::too_many(max)
}

/// Standard base64 (with or without padding, whitespace ignored); `None` when it is not base64.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0;
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// A URI's `%xx` escapes undone (a file name with spaces or letters beyond ASCII).
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A picture as the builder keeps it: PNG and JPEG as they are, any other
/// picture the `image` crate reads (TGA, BMP) as a PNG; `None` for one that
/// cannot be read.
pub fn picture_bytes(bytes: Vec<u8>) -> Option<Vec<u8>> {
    if bytes.starts_with(b"\x89PNG") || bytes.starts_with(&[0xFF, 0xD8]) {
        return Some(bytes);
    }
    let picture = image::load_from_memory(&bytes).ok()?.into_rgba8();
    let (width, height) = picture.dimensions();
    let mut png = Vec::new();
    image::ImageEncoder::write_image(
        image::codecs::png::PngEncoder::new(&mut png),
        &picture,
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )
    .ok()?;
    Some(png)
}

/// sRGB 0–1 to linear.
pub fn srgb_to_linear(value: f32) -> f32 {
    let v = value.clamp(0.0, 1.0);
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// The extension of `path`, lower case.
fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Reads a model file of any of the formats above, by its extension.
pub fn read_model(path: &Path, options: &ReadOptions) -> Result<(Model, ModelInfo), String> {
    let kind = extension(path);
    let refused = match kind.as_str() {
        "fbx" => Some("FBX"),
        "dae" => Some("COLLADA (.dae)"),
        "3ds" => Some("3DS"),
        "blend" => Some("Blender (.blend)"),
        "max" => Some("3ds Max (.max)"),
        "usd" | "usda" | "usdc" | "usdz" => Some("USD"),
        "skp" => Some("SketchUp (.skp)"),
        _ => None,
    };
    if let Some(name) = refused {
        return Err(format!(
            "{name} files cannot be read yet. Export the model as glTF (.glb or .gltf) or OBJ from the program you made it in, and choose that file."
        ));
    }
    if !EXTENSIONS.contains(&kind.as_str()) {
        return Err(format!(
            "{} is not a 3D model file that can be read. Choose a .glb, .gltf, .obj, .stl or .ply file.",
            display_name(path)
        ));
    }
    let size = std::fs::metadata(path)
        .map_err(|_| format!("{} cannot be opened.", path.display()))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "{} is larger than 4 GB, more than the Map Maker reads.",
            display_name(path)
        ));
    }
    if size == 0 {
        return Err(format!("{} is empty.", display_name(path)));
    }
    let folder = path.parent().unwrap_or(Path::new("."));
    let name = display_name(path);
    let mut info = ModelInfo {
        format: kind.clone(),
        up: if matches!(kind.as_str(), "stl" | "ply") {
            "+z"
        } else {
            "+y"
        }
        .to_owned(),
        ..ModelInfo::default()
    };
    let max = options.max_triangles.min(LARGEST_MAX_TRIANGLES);
    let model = match kind.as_str() {
        "glb" | "gltf" => {
            let bytes = std::fs::read(path).map_err(|e| format!("{name} cannot be read: {e}"))?;
            let companions = Companions {
                folder: Some(folder),
                model: &name,
            };
            let mut notes = GltfNotes::default();
            let binary = bytes.starts_with(b"glTF");
            let model = if binary {
                gltf::read_glb_with(&bytes, &companions, &mut notes, max)
            } else {
                gltf::read_gltf_with(&bytes, &companions, &mut notes, max)
            }?;
            info.format = "gltf".to_owned();
            info.format_name = if binary { "glTF binary" } else { "glTF" }.to_owned();
            info.sides_given = true;
            info.missing_files = notes.missing_pictures;
            if !notes.unread_extensions.is_empty() {
                info.warnings.push(format!(
                    "The model uses glTF extensions that are not read: {}",
                    notes.unread_extensions.join(", ")
                ));
            }
            model
        }
        "obj" => {
            info.format_name = "OBJ".to_owned();
            read_obj(path, max, &mut info)?
        }
        "stl" => {
            let bytes = std::fs::read(path).map_err(|e| format!("{name} cannot be read: {e}"))?;
            let (model, binary) = read_stl(&bytes, max)?;
            info.format_name = if binary { "STL (binary)" } else { "STL (text)" }.to_owned();
            model
        }
        _ => {
            let bytes = std::fs::read(path).map_err(|e| format!("{name} cannot be read: {e}"))?;
            info.format_name = "PLY".to_owned();
            read_ply(&bytes, folder, max, &mut info)?
        }
    };
    describe(&model, &mut info);
    if info.triangles == 0 {
        return Err(format!("{name} holds no triangles to make a map of."));
    }
    Ok((model, info))
}

/// Counts and the box of a model read.
fn describe(model: &Model, info: &mut ModelInfo) {
    info.triangles = model.triangles();
    info.parts = model.parts.len();
    // The last material is the one for parts without one, when it is not used it is not counted.
    let used: std::collections::HashSet<usize> = model.parts.iter().map(|p| p.material).collect();
    info.materials = used.len();
    info.textured_materials = used
        .iter()
        .filter(|&&m| model.materials[m].textured)
        .count();
    info.textures_found = used
        .iter()
        .filter(|&&m| model.materials[m].texture.is_some())
        .count();
    let colours: std::collections::HashSet<[u32; 3]> = used
        .iter()
        .map(|&m| {
            let c = model.materials[m].color;
            [c[0].to_bits(), c[1].to_bits(), c[2].to_bits()]
        })
        .collect();
    info.has_colours = info.textures_found > 0
        || colours.len() > 1
        || model.parts.iter().any(|p| p.colors.is_some());
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for part in &model.parts {
        for p in &part.positions {
            for k in 0..3 {
                low[k] = low[k].min(p[k]);
                high[k] = high[k].max(p[k]);
            }
        }
    }
    if low[0].is_finite() {
        info.min = low;
        info.max = high;
    }
}

/// The plain material of models whose file gives none: light grey, seen from both sides.
fn plain_material() -> Material {
    Material {
        name: String::new(),
        color: [0.75, 0.75, 0.75, 1.0],
        double_sided: true,
        ..Material::default()
    }
}

/// Where a file a model names is: as named (from `folder`), or by its name
/// alone in `folder` or a `textures` folder beside it (exported models
/// often name a path on the computer they were made on).
fn find_companion(named: &str, folders: &[&Path]) -> Option<PathBuf> {
    let cleaned = named.trim().trim_matches('"');
    let unix = cleaned.replace('\\', "/");
    let base = unix.rsplit('/').next().unwrap_or(&unix).to_owned();
    let mut candidates = Vec::new();
    for folder in folders {
        candidates.push(folder.join(cleaned));
        candidates.push(folder.join(&unix));
        candidates.push(folder.join(&base));
        for sub in ["textures", "Textures", "maps", "images"] {
            candidates.push(folder.join(sub).join(&base));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Adds a picture file as a material's texture; `false` when it is missing
/// or cannot be read.
fn add_texture(
    model: &mut Model,
    pictures: &mut HashMap<PathBuf, Option<usize>>,
    material: usize,
    path: &Path,
) -> bool {
    let index = *pictures.entry(path.to_path_buf()).or_insert_with(|| {
        let bytes = std::fs::read(path).ok().and_then(picture_bytes)?;
        model.images.push(bytes);
        Some(model.images.len() - 1)
    });
    let Some(index) = index else {
        return false;
    };
    let average = crate::textures::average_colour(&model.images[index]);
    let entry = &mut model.materials[material];
    entry.texture_color = average;
    if average.is_some() {
        entry.texture = Some(TextureRef {
            image: index,
            wrap: [gltf::WRAP_REPEAT, gltf::WRAP_REPEAT],
            tex_coord: 0,
        });
    }
    average.is_some()
}

fn obj_error(error: tobj::LoadError) -> String {
    use tobj::LoadError::*;
    match error {
        OpenFileFailed => "the file cannot be opened".to_owned(),
        ReadError => "the file cannot be read".to_owned(),
        UnrecognizedCharacter => "it holds something that is not OBJ text".to_owned(),
        PositionParseError | NormalParseError | TexcoordParseError | FaceParseError => {
            "one of its lines cannot be read as OBJ".to_owned()
        }
        FaceVertexOutOfBounds
        | FaceTexCoordOutOfBounds
        | FaceNormalOutOfBounds
        | FaceColorOutOfBounds => "a face names a corner the file does not have".to_owned(),
        other => format!("it cannot be read as OBJ ({other})"),
    }
}

/// An OBJ file with its materials and pictures.
fn read_obj(path: &Path, max: usize, info: &mut ModelInfo) -> Result<Model, String> {
    let name = display_name(path);
    let folder = path.parent().unwrap_or(Path::new("."));
    let file = std::fs::File::open(path).map_err(|e| format!("{name} cannot be opened: {e}"))?;
    let mut reader = BufReader::new(file);
    let missing: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let library_folders: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
    let load_options = tobj::LoadOptions {
        single_index: true,
        triangulate: true,
        ignore_points: true,
        ignore_lines: true,
    };
    let (models, materials) = tobj::load_obj_buf(&mut reader, &load_options, |library| {
        let named = library.to_string_lossy();
        match find_companion(&named, &[folder]) {
            Some(found) => {
                if let Some(parent) = found.parent() {
                    library_folders.borrow_mut().push(parent.to_path_buf());
                }
                tobj::load_mtl(&found)
            }
            None => {
                missing.borrow_mut().push(named.into_owned());
                Err(tobj::LoadError::OpenFileFailed)
            }
        }
    })
    .map_err(|e| format!("{name} cannot be read: {}", obj_error(e)))?;
    let mut missing = missing.into_inner();
    let materials = materials.unwrap_or_default();
    let triangles: usize = models.iter().map(|m| m.mesh.indices.len() / 3).sum();
    if triangles > max {
        return Err(too_many(max));
    }
    let mut model = Model::default();
    let mut pictures = HashMap::new();
    let mut folders: Vec<PathBuf> = library_folders.into_inner();
    folders.push(folder.to_path_buf());
    let folders: Vec<&Path> = folders.iter().map(PathBuf::as_path).collect();
    for material in &materials {
        let colour = material.diffuse.unwrap_or([0.8, 0.8, 0.8]);
        let alpha = material.dissolve.unwrap_or(1.0).clamp(0.0, 1.0);
        let index = model.materials.len();
        model.materials.push(Material {
            name: material.name.clone(),
            // Kd is written as the colour shown (sRGB), as modelling programs and viewers take it.
            color: [
                srgb_to_linear(colour[0]),
                srgb_to_linear(colour[1]),
                srgb_to_linear(colour[2]),
                alpha,
            ],
            double_sided: true,
            textured: material.diffuse_texture.is_some(),
            alpha_mode: if alpha < 0.999 {
                AlphaMode::Blend
            } else {
                AlphaMode::Opaque
            },
            ..Material::default()
        });
        if let Some(texture) = &material.diffuse_texture {
            // The picture's name is the last word, after any options (-s 1 1 1, -clamp on, …).
            let found = find_companion(texture, &folders).or_else(|| {
                texture
                    .split_whitespace()
                    .last()
                    .and_then(|last| find_companion(last, &folders))
            });
            let kept = match found {
                Some(path) => add_texture(&mut model, &mut pictures, index, &path),
                None => false,
            };
            if !kept {
                // Its name: the whole of it, or the last word after options.
                let shown = if texture.trim_start().starts_with('-') {
                    texture.split_whitespace().last().unwrap_or(texture)
                } else {
                    texture.trim()
                };
                let shown = shown.replace('\\', "/");
                let shown = shown.rsplit('/').next().unwrap_or(&shown).to_owned();
                if !missing.contains(&shown) {
                    missing.push(shown);
                }
            }
        }
    }
    let fallback = model.materials.len();
    model.materials.push(plain_material());
    for obj in models {
        let mesh = obj.mesh;
        if mesh.indices.len() < 3 {
            continue;
        }
        let material = mesh
            .material_id
            .filter(|m| *m < fallback)
            .unwrap_or(fallback);
        let count = mesh.positions.len() / 3;
        let positions: Vec<[f64; 3]> = mesh
            .positions
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])])
            .collect();
        let colors = (mesh.vertex_color.len() == count * 3).then(|| {
            mesh.vertex_color
                .as_chunks::<3>()
                .0
                .iter()
                .map(|c| {
                    [
                        srgb_to_linear(c[0]),
                        srgb_to_linear(c[1]),
                        srgb_to_linear(c[2]),
                        1.0,
                    ]
                })
                .collect()
        });
        let uvs = (model.materials[material].texture.is_some()
            && mesh.texcoords.len() == count * 2)
            .then(|| {
                mesh.texcoords
                    .as_chunks::<2>()
                    .0
                    .iter()
                    // OBJ counts v from the bottom of the picture, glTF from the top.
                    .map(|uv| [uv[0], 1.0 - uv[1]])
                    .collect()
            });
        let mut indices = mesh.indices;
        indices.truncate(indices.len() / 3 * 3);
        if indices.iter().any(|&i| i as usize >= count) {
            return Err(format!(
                "{name}: a face names a corner the file does not have"
            ));
        }
        let mut names = Vec::new();
        if !obj.name.is_empty() {
            names.push(obj.name);
        }
        if !model.materials[material].name.is_empty() {
            names.push(model.materials[material].name.clone());
        }
        model.parts.push(Part {
            names,
            material,
            positions,
            colors,
            uvs,
            indices,
        });
    }
    info.missing_files = missing;
    Ok(model)
}

/// An STL file, binary or text; `true` when binary.
pub fn read_stl(bytes: &[u8], max: usize) -> Result<(Model, bool), String> {
    let binary_count = (bytes.len() >= 84)
        .then(|| u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize);
    let exact_binary = binary_count
        .is_some_and(|n| n.checked_mul(50).and_then(|b| b.checked_add(84)) == Some(bytes.len()));
    let looks_text = bytes
        .iter()
        .skip_while(|b| b.is_ascii_whitespace())
        .take(5)
        .copied()
        .collect::<Vec<u8>>()
        .eq_ignore_ascii_case(b"solid");
    let mut positions: Vec<[f64; 3]> = Vec::new();
    let binary = exact_binary || !looks_text;
    if binary {
        let count = binary_count.ok_or("it is too short to be an STL file")?;
        if count
            .checked_mul(50)
            .and_then(|b| b.checked_add(84))
            .is_none_or(|end| end > bytes.len())
        {
            return Err(
                "it is not an STL file: it is shorter than its triangle count says".to_owned(),
            );
        }
        if count > max {
            return Err(too_many(max));
        }
        positions.reserve(count * 3);
        for t in 0..count {
            let at = 84 + 50 * t + 12;
            for corner in 0..3 {
                let base = at + corner * 12;
                let value = |k: usize| {
                    let b = &bytes[base + 4 * k..base + 4 * k + 4];
                    f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                };
                positions.push([value(0), value(1), value(2)]);
            }
        }
    } else {
        let text = String::from_utf8_lossy(bytes);
        let mut words = text.split_ascii_whitespace();
        while let Some(word) = words.next() {
            if word.eq_ignore_ascii_case("vertex") {
                let mut p = [0.0; 3];
                for slot in &mut p {
                    *slot = words
                        .next()
                        .and_then(|w| w.parse::<f64>().ok())
                        .filter(|v| v.is_finite())
                        .ok_or("one of its vertices cannot be read as three numbers")?;
                }
                positions.push(p);
                if positions.len() / 3 > max {
                    return Err(too_many(max));
                }
            }
        }
        if !positions.len().is_multiple_of(3) {
            return Err(
                "it is not a whole STL file: a triangle has fewer than three corners".to_owned(),
            );
        }
    }
    if positions.iter().any(|p| p.iter().any(|v| !v.is_finite())) {
        positions.retain(|p| p.iter().all(|v| v.is_finite()));
        positions.truncate(positions.len() / 3 * 3);
    }
    let indices = (0..positions.len() as u32).collect();
    let model = Model {
        materials: vec![plain_material()],
        parts: vec![Part {
            names: Vec::new(),
            material: 0,
            positions,
            colors: None,
            uvs: None,
            indices,
        }],
        images: Vec::new(),
        skipped_primitives: 0,
    };
    Ok((model, binary))
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Scalar {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl Scalar {
    fn parse(name: &str) -> Option<Scalar> {
        Some(match name {
            "char" | "int8" => Scalar::I8,
            "uchar" | "uint8" => Scalar::U8,
            "short" | "int16" => Scalar::I16,
            "ushort" | "uint16" => Scalar::U16,
            "int" | "int32" => Scalar::I32,
            "uint" | "uint32" => Scalar::U32,
            "float" | "float32" => Scalar::F32,
            "double" | "float64" => Scalar::F64,
            _ => return None,
        })
    }
    fn size(self) -> usize {
        match self {
            Scalar::I8 | Scalar::U8 => 1,
            Scalar::I16 | Scalar::U16 => 2,
            Scalar::I32 | Scalar::U32 | Scalar::F32 => 4,
            Scalar::F64 => 8,
        }
    }
}

#[derive(Clone, Debug)]
struct Property {
    name: String,
    /// The count's type, for a list.
    list: Option<Scalar>,
    scalar: Scalar,
}

#[derive(Clone, Debug)]
struct Element {
    name: String,
    count: usize,
    properties: Vec<Property>,
}

#[derive(Clone, Copy, PartialEq)]
enum PlyFormat {
    Text,
    Little,
    Big,
}

/// Reads PLY values one at a time, from text or binary.
struct PlyValues<'a> {
    format: PlyFormat,
    bytes: &'a [u8],
    at: usize,
}

impl PlyValues<'_> {
    fn next(&mut self, scalar: Scalar) -> Result<f64, String> {
        if self.format == PlyFormat::Text {
            while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() {
                self.at += 1;
            }
            let start = self.at;
            while self.at < self.bytes.len() && !self.bytes[self.at].is_ascii_whitespace() {
                self.at += 1;
            }
            if start == self.at {
                return Err("it ends before all its elements are there".to_owned());
            }
            return std::str::from_utf8(&self.bytes[start..self.at])
                .ok()
                .and_then(|w| w.parse::<f64>().ok())
                .ok_or_else(|| "one of its values is not a number".to_owned());
        }
        let size = scalar.size();
        let b = self
            .bytes
            .get(self.at..self.at + size)
            .ok_or("it ends before all its elements are there")?;
        self.at += size;
        let mut raw = [0u8; 8];
        raw[..size].copy_from_slice(b);
        if self.format == PlyFormat::Big {
            raw[..size].reverse();
        }
        Ok(match scalar {
            Scalar::I8 => f64::from(raw[0] as i8),
            Scalar::U8 => f64::from(raw[0]),
            Scalar::I16 => f64::from(i16::from_le_bytes([raw[0], raw[1]])),
            Scalar::U16 => f64::from(u16::from_le_bytes([raw[0], raw[1]])),
            Scalar::I32 => f64::from(i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])),
            Scalar::U32 => f64::from(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])),
            Scalar::F32 => f64::from(f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])),
            Scalar::F64 => f64::from_le_bytes(raw),
        })
    }
}

/// A PLY file: its vertices (with colours and texture coordinates), faces
/// (polygons cut into triangles) and the picture its `TextureFile` comment names.
pub fn read_ply(
    bytes: &[u8],
    folder: &Path,
    max: usize,
    info: &mut ModelInfo,
) -> Result<Model, String> {
    let header_end = bytes
        .windows(10)
        .position(|w| w == b"end_header")
        .ok_or("it is not a PLY file: it has no end_header")?;
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header.lines();
    if lines.next().map(str::trim) != Some("ply") {
        return Err("it is not a PLY file".to_owned());
    }
    let mut format = None;
    let mut elements: Vec<Element> = Vec::new();
    let mut texture_file: Option<String> = None;
    for line in lines {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            ["format", kind, ..] => {
                format = Some(match *kind {
                    "ascii" => PlyFormat::Text,
                    "binary_little_endian" => PlyFormat::Little,
                    "binary_big_endian" => PlyFormat::Big,
                    other => return Err(format!("its PLY format {other} is not known")),
                })
            }
            ["comment", key, rest @ ..]
                if key.eq_ignore_ascii_case("texturefile") && !rest.is_empty() =>
            {
                texture_file = Some(rest.join(" "));
            }
            ["element", name, count] => elements.push(Element {
                name: (*name).to_owned(),
                count: count
                    .parse()
                    .map_err(|_| "an element's count is not a number")?,
                properties: Vec::new(),
            }),
            ["property", "list", count, item, name] => {
                let element = elements
                    .last_mut()
                    .ok_or("a property comes before any element")?;
                element.properties.push(Property {
                    name: (*name).to_owned(),
                    list: Some(Scalar::parse(count).ok_or("a list's count type is not known")?),
                    scalar: Scalar::parse(item).ok_or("a list's item type is not known")?,
                });
            }
            ["property", kind, name] => {
                let element = elements
                    .last_mut()
                    .ok_or("a property comes before any element")?;
                element.properties.push(Property {
                    name: (*name).to_owned(),
                    list: None,
                    scalar: Scalar::parse(kind).ok_or("a property's type is not known")?,
                });
            }
            _ => {}
        }
    }
    let format = format.ok_or("it is not a PLY file: it has no format line")?;
    // The data starts after the line break that ends the header.
    let mut at = header_end + 10;
    while at < bytes.len() && bytes[at] != b'\n' {
        at += 1;
    }
    let mut values = PlyValues {
        format,
        bytes,
        at: at + 1,
    };
    let mut positions: Vec<[f64; 3]> = Vec::new();
    let mut colours: Vec<[f32; 4]> = Vec::new();
    let mut vertex_uvs: Vec<[f32; 2]> = Vec::new();
    // Triangles: corners by vertex, and texture coordinates per corner when the faces give them.
    let mut corners: Vec<u32> = Vec::new();
    let mut corner_uvs: Vec<[f32; 2]> = Vec::new();
    let mut seen_vertices = false;
    for element in &elements {
        // At most as many as the bytes left could hold, so a lying count cannot ask for all the memory.
        let room = bytes.len().saturating_sub(values.at);
        if element.name == "vertex" && !seen_vertices {
            seen_vertices = true;
            let find = |names: &[&str]| {
                element
                    .properties
                    .iter()
                    .position(|p| p.list.is_none() && names.contains(&p.name.as_str()))
            };
            let xyz = [find(&["x"]), find(&["y"]), find(&["z"])];
            let [Some(x), Some(y), Some(z)] = xyz else {
                return Err("its vertices have no x, y and z".to_owned());
            };
            let rgb = [
                find(&["red", "r", "diffuse_red"]),
                find(&["green", "g", "diffuse_green"]),
                find(&["blue", "b", "diffuse_blue"]),
            ];
            let alpha = find(&["alpha", "a", "diffuse_alpha"]);
            let uv = [
                find(&["s", "u", "texture_u", "texcoord_u"]),
                find(&["t", "v", "texture_v", "texcoord_v"]),
            ];
            let has_rgb = rgb.iter().all(Option::is_some);
            let has_uv = uv.iter().all(Option::is_some);
            positions.reserve(element.count.min(room));
            let mut row = vec![0.0f64; element.properties.len()];
            for _ in 0..element.count {
                for (k, property) in element.properties.iter().enumerate() {
                    row[k] = match property.list {
                        Some(count) => {
                            let n = values.next(count)? as usize;
                            for _ in 0..n {
                                values.next(property.scalar)?;
                            }
                            0.0
                        }
                        None => values.next(property.scalar)?,
                    };
                }
                positions.push([row[x], row[y], row[z]]);
                if has_rgb {
                    let channel = |index: Option<usize>| -> f32 {
                        let Some(i) = index else { return 1.0 };
                        let v = row[i] as f32;
                        match element.properties[i].scalar {
                            Scalar::F32 | Scalar::F64 => v,
                            Scalar::U16 => v / 65535.0,
                            _ => v / 255.0,
                        }
                    };
                    colours.push([
                        srgb_to_linear(channel(rgb[0])),
                        srgb_to_linear(channel(rgb[1])),
                        srgb_to_linear(channel(rgb[2])),
                        channel(alpha).clamp(0.0, 1.0),
                    ]);
                }
                if has_uv {
                    let (u, v) = (uv[0].unwrap_or(0), uv[1].unwrap_or(0));
                    // PLY counts v from the bottom of the picture, glTF from the top.
                    vertex_uvs.push([row[u] as f32, 1.0 - row[v] as f32]);
                }
            }
            continue;
        }
        if element.name == "face" {
            let indices = element.properties.iter().position(|p| {
                p.list.is_some() && (p.name == "vertex_indices" || p.name == "vertex_index")
            });
            let Some(indices) = indices else {
                return Err("its faces have no vertex_indices".to_owned());
            };
            let texcoords = element
                .properties
                .iter()
                .position(|p| p.list.is_some() && p.name == "texcoord");
            corners.reserve(element.count.min(room) * 3);
            let mut polygon: Vec<u32> = Vec::new();
            let mut polygon_uvs: Vec<f32> = Vec::new();
            for _ in 0..element.count {
                polygon.clear();
                polygon_uvs.clear();
                for (k, property) in element.properties.iter().enumerate() {
                    match property.list {
                        Some(count) => {
                            let n = values.next(count)?;
                            if !(0.0..=1_000_000.0).contains(&n) {
                                return Err("a face has a count that cannot be right".to_owned());
                            }
                            for _ in 0..n as usize {
                                let value = values.next(property.scalar)?;
                                if k == indices {
                                    if !(0.0..f64::from(u32::MAX)).contains(&value) {
                                        return Err("a face names a corner the file does not have"
                                            .to_owned());
                                    }
                                    polygon.push(value as u32);
                                } else if Some(k) == texcoords {
                                    polygon_uvs.push(value as f32);
                                }
                            }
                        }
                        None => {
                            values.next(property.scalar)?;
                        }
                    }
                }
                if polygon.len() < 3 {
                    continue;
                }
                let with_uvs = polygon_uvs.len() == polygon.len() * 2;
                for i in 1..polygon.len() - 1 {
                    for corner in [0, i, i + 1] {
                        corners.push(polygon[corner]);
                        if with_uvs {
                            corner_uvs
                                .push([polygon_uvs[2 * corner], 1.0 - polygon_uvs[2 * corner + 1]]);
                        } else if texcoords.is_some() {
                            corner_uvs.push([0.0, 0.0]);
                        }
                    }
                }
                if corners.len() / 3 > max {
                    return Err(too_many(max));
                }
            }
            continue;
        }
        // Any other element (edges, materials, …) is read past.
        for _ in 0..element.count {
            for property in &element.properties {
                match property.list {
                    Some(count) => {
                        let n = values.next(count)?;
                        if !(0.0..=1_000_000.0).contains(&n) {
                            return Err("a list has a count that cannot be right".to_owned());
                        }
                        for _ in 0..n as usize {
                            values.next(property.scalar)?;
                        }
                    }
                    None => {
                        values.next(property.scalar)?;
                    }
                }
            }
        }
    }
    if corners.iter().any(|&c| c as usize >= positions.len()) {
        return Err("a face names a corner the file does not have".to_owned());
    }
    let mut model = Model::default();
    let mut pictures = HashMap::new();
    model.materials.push(plain_material());
    if let Some(texture) = texture_file {
        model.materials[0].textured = true;
        let kept = match find_companion(&texture, &[folder]) {
            Some(path) => add_texture(&mut model, &mut pictures, 0, &path),
            None => false,
        };
        if kept {
            // A texture is shown as it is, not tinted grey.
            model.materials[0].color = [1.0; 4];
        } else {
            info.missing_files.push(texture);
        }
    }
    let textured = model.materials[0].texture.is_some();
    let colors = (colours.len() == positions.len() && !colours.is_empty()).then_some(colours);
    let part = if textured && corner_uvs.len() == corners.len() && !corner_uvs.is_empty() {
        // Texture coordinates per face corner: each corner a vertex of its own.
        Part {
            names: Vec::new(),
            material: 0,
            positions: corners.iter().map(|&c| positions[c as usize]).collect(),
            colors: colors.map(|c| corners.iter().map(|&i| c[i as usize]).collect()),
            uvs: Some(corner_uvs),
            indices: (0..corners.len() as u32).collect(),
        }
    } else {
        Part {
            names: Vec::new(),
            material: 0,
            uvs: (textured && vertex_uvs.len() == positions.len()).then_some(vertex_uvs),
            positions,
            colors,
            indices: corners,
        }
    };
    if part.indices.is_empty() {
        return Err("it has no faces: a cloud of points cannot be made into a map".to_owned());
    }
    model.parts.push(part);
    Ok(model)
}
