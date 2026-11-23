//! Reading the raw model: a glTF 2.0 binary file (`.glb`) with everything in
//! it. Its triangle meshes are read with their positions, vertex colours and
//! materials, every node transform applied, so each part comes out in the
//! model's own coordinates (see [`crate::Axes`] for how those become the
//! world's). Normals and the rest are not read: the builder works its own
//! normals out. Each material's base colour texture is read with the
//! picture it shows (a PNG or JPEG picture in the file), its sampler's
//! wrap and its alpha mode, and each part's texture coordinates for it, for
//! a builder that keeps textures (see [`crate::textures`]).

use serde_json::Value;

/// How a material's alpha is used, as glTF's `alphaMode`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum AlphaMode {
    /// Alpha is ignored.
    #[default]
    Opaque,
    /// A cutout: drawn where alpha is at least the cutoff, not at all elsewhere.
    Mask(f32),
    /// Blended with what is behind.
    Blend,
}

/// glTF's sampler wrap: repeat.
pub const WRAP_REPEAT: u32 = 10497;
/// glTF's sampler wrap: clamp to the edge.
pub const WRAP_CLAMP: u32 = 33071;
/// glTF's sampler wrap: mirrored repeat.
pub const WRAP_MIRROR: u32 = 33648;

/// A material's base colour texture, when its picture is in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextureRef {
    /// The picture, in [`Model::images`].
    pub image: usize,
    /// The sampler's wrap along u and v (`WRAP_*`).
    pub wrap: [u32; 2],
    /// The texture coordinates it reads (`TEXCOORD_<n>`).
    pub tex_coord: usize,
}

/// A material of the raw model, as far as the builder keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct Material {
    pub name: String,
    /// Linear RGBA, 0 to 1.
    pub color: [f32; 4],
    pub double_sided: bool,
    /// It has a base colour texture. Unless the builder keeps textures
    /// ([`crate::textures`]), it is left out and the material keeps its colour.
    pub textured: bool,
    /// The average colour of its base colour texture (linear RGB), when the
    /// texture is a PNG or JPEG picture in the file that could be read; the
    /// builder may keep it in place of the texture ([`crate::textures`]).
    pub texture_color: Option<[f32; 3]>,
    /// The texture and its picture, when the picture is in the file.
    pub texture: Option<TextureRef>,
    pub alpha_mode: AlphaMode,
}

impl Default for Material {
    fn default() -> Self {
        Material {
            name: String::new(),
            color: [1.0, 1.0, 1.0, 1.0],
            double_sided: false,
            textured: false,
            texture_color: None,
            texture: None,
            alpha_mode: AlphaMode::Opaque,
        }
    }
}

/// One primitive of one node, in the model's coordinates.
#[derive(Clone, Debug, Default)]
pub struct Part {
    /// The names a drop pattern is matched against: the node's and its
    /// parents', the mesh's and the material's.
    pub names: Vec<String>,
    pub material: usize,
    pub positions: Vec<[f64; 3]>,
    /// Linear RGBA per vertex, when the primitive has `COLOR_0`.
    pub colors: Option<Vec<[f32; 4]>>,
    /// Texture coordinates per vertex, those the material's texture reads,
    /// when it has one and the primitive has them.
    pub uvs: Option<Vec<[f32; 2]>>,
    /// Three per triangle.
    pub indices: Vec<u32>,
}

/// A raw model: its materials (one more at the end for primitives without
/// one) and its parts.
#[derive(Clone, Debug, Default)]
pub struct Model {
    pub materials: Vec<Material>,
    pub parts: Vec<Part>,
    /// The pictures the materials' textures show, as they are in the file
    /// (PNG or JPEG bytes), each once.
    pub images: Vec<Vec<u8>>,
    /// Primitives that are not triangles (points, lines), left out.
    pub skipped_primitives: usize,
}

impl Model {
    pub fn triangles(&self) -> usize {
        self.parts.iter().map(|part| part.indices.len() / 3).sum()
    }
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// The JSON and the binary chunk of a `.glb` file.
pub fn split_glb(bytes: &[u8]) -> Result<(Value, &[u8]), String> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return Err("it is not a glTF binary file (.glb)".to_owned());
    }
    let version = u32_at(bytes, 4);
    if version != 2 {
        return Err(format!("it is glTF version {version}, not 2"));
    }
    let length = u32_at(bytes, 8) as usize;
    if length > bytes.len() || length < 20 {
        return Err("it is shorter than its header says".to_owned());
    }
    let mut at = 12;
    let mut json = None;
    let mut bin: &[u8] = &[];
    while at + 8 <= length {
        let size = u32_at(bytes, at) as usize;
        let kind = &bytes[at + 4..at + 8];
        let start = at + 8;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= length)
            .ok_or("a chunk runs past the end of the file")?;
        match kind {
            b"JSON" if json.is_none() => {
                json = Some(
                    serde_json::from_slice::<Value>(&bytes[start..end])
                        .map_err(|error| format!("its JSON cannot be read: {error}"))?,
                );
            }
            b"BIN\0" if bin.is_empty() => bin = &bytes[start..end],
            _ => {}
        }
        at = end;
    }
    Ok((json.ok_or("it has no JSON chunk")?, bin))
}

type Matrix = [f64; 16];

const IDENTITY: Matrix = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

/// Column-major product `a · b`.
fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    let mut out = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            out[column * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[column * 4 + k]).sum();
        }
    }
    out
}

fn numbers<const N: usize>(value: &Value) -> Option<[f64; N]> {
    let list = value.as_array()?;
    if list.len() != N {
        return None;
    }
    let mut out = [0.0; N];
    for (slot, item) in out.iter_mut().zip(list) {
        *slot = item.as_f64().filter(|v| v.is_finite())?;
    }
    Some(out)
}

fn node_matrix(node: &Value) -> Matrix {
    if let Some(matrix) = node.get("matrix").and_then(numbers::<16>) {
        return matrix;
    }
    let [tx, ty, tz] = node
        .get("translation")
        .and_then(numbers::<3>)
        .unwrap_or([0.0; 3]);
    let [x, y, z, w] = node
        .get("rotation")
        .and_then(numbers::<4>)
        .unwrap_or([0.0, 0.0, 0.0, 1.0]);
    let [sx, sy, sz] = node.get("scale").and_then(numbers::<3>).unwrap_or([1.0; 3]);
    // Rotation matrix of a unit quaternion, scaled per column.
    let r = [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y + z * w),
            2.0 * (x * z - y * w),
        ],
        [
            2.0 * (x * y - z * w),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z + x * w),
        ],
        [
            2.0 * (x * z + y * w),
            2.0 * (y * z - x * w),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ];
    [
        r[0][0] * sx,
        r[0][1] * sx,
        r[0][2] * sx,
        0.0,
        r[1][0] * sy,
        r[1][1] * sy,
        r[1][2] * sy,
        0.0,
        r[2][0] * sz,
        r[2][1] * sz,
        r[2][2] * sz,
        0.0,
        tx,
        ty,
        tz,
        1.0,
    ]
}

fn determinant(m: &Matrix) -> f64 {
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
        + m[8] * (m[1] * m[6] - m[5] * m[2])
}

struct Reader<'a> {
    json: &'a Value,
    bin: &'a [u8],
}

fn list<'a>(json: &'a Value, key: &str) -> &'a [Value] {
    json.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn index_of(value: &Value, key: &str) -> Option<usize> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
}

impl Reader<'_> {
    /// An accessor's values as numbers (normalised integers as 0 to 1, or
    /// -1 to 1), `components` per element.
    fn accessor(&self, index: usize) -> Result<(Vec<f64>, usize), String> {
        let accessor = list(self.json, "accessors")
            .get(index)
            .ok_or_else(|| format!("accessor {index} is missing"))?;
        if accessor.get("sparse").is_some() {
            return Err(format!("accessor {index} is sparse, which is not read"));
        }
        let count = index_of(accessor, "count").ok_or("an accessor has no count")?;
        let components = match accessor.get("type").and_then(Value::as_str) {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4") => 4,
            other => return Err(format!("accessor {index} has type {other:?}")),
        };
        let component_type = index_of(accessor, "componentType").unwrap_or(0);
        let size = match component_type {
            5120 | 5121 => 1,
            5122 | 5123 => 2,
            5125 | 5126 => 4,
            other => return Err(format!("accessor {index} has component type {other}")),
        };
        let normalized = accessor
            .get("normalized")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let Some(view_index) = index_of(accessor, "bufferView") else {
            // No view: all zeros, as glTF says.
            return Ok((vec![0.0; count * components], components));
        };
        let view = list(self.json, "bufferViews")
            .get(view_index)
            .ok_or_else(|| format!("buffer view {view_index} is missing"))?;
        if view.get("extensions").is_some_and(|e| {
            e.get("EXT_meshopt_compression").is_some() || e.get("KHR_meshopt_compression").is_some()
        }) {
            return Err(
                "the model's buffers are compressed; give the builder an uncompressed model"
                    .to_owned(),
            );
        }
        let buffer_index = index_of(view, "buffer").unwrap_or(0);
        let buffer = list(self.json, "buffers")
            .get(buffer_index)
            .ok_or("a buffer view names a buffer that is missing")?;
        if buffer_index != 0 || buffer.get("uri").is_some() {
            return Err(
                "the model reads a file of its own (a uri); give the builder one .glb file with everything in it"
                    .to_owned(),
            );
        }
        let view_offset = index_of(view, "byteOffset").unwrap_or(0);
        let view_length = index_of(view, "byteLength").ok_or("a buffer view has no length")?;
        let element = size * components;
        let stride = index_of(view, "byteStride").unwrap_or(element).max(element);
        let offset = index_of(accessor, "byteOffset").unwrap_or(0);
        let view_end = view_offset
            .checked_add(view_length)
            .filter(|end| *end <= self.bin.len())
            .ok_or("a buffer view runs past the end of the file")?;
        let data = &self.bin[view_offset..view_end];
        if count > 0 && offset + stride * (count - 1) + element > data.len() {
            return Err(format!("accessor {index} runs past its buffer view"));
        }
        let mut out = Vec::with_capacity(count * components);
        for i in 0..count {
            let base = offset + stride * i;
            for c in 0..components {
                let at = base + c * size;
                let b = &data[at..at + size];
                let value = match component_type {
                    5120 => {
                        let v = f64::from(b[0] as i8);
                        if normalized {
                            (v / 127.0).max(-1.0)
                        } else {
                            v
                        }
                    }
                    5121 => {
                        let v = f64::from(b[0]);
                        if normalized {
                            v / 255.0
                        } else {
                            v
                        }
                    }
                    5122 => {
                        let v = f64::from(i16::from_le_bytes([b[0], b[1]]));
                        if normalized {
                            (v / 32767.0).max(-1.0)
                        } else {
                            v
                        }
                    }
                    5123 => {
                        let v = f64::from(u16::from_le_bytes([b[0], b[1]]));
                        if normalized {
                            v / 65535.0
                        } else {
                            v
                        }
                    }
                    5125 => f64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                    _ => f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                };
                out.push(value);
            }
        }
        Ok((out, components))
    }
}

fn material_of(value: &Value) -> Material {
    let pbr = value.get("pbrMetallicRoughness");
    let color = pbr
        .and_then(|p| p.get("baseColorFactor"))
        .and_then(numbers::<4>)
        .map(|c| c.map(|v| v.clamp(0.0, 1.0) as f32))
        .unwrap_or([1.0; 4]);
    Material {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        color,
        double_sided: value
            .get("doubleSided")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        textured: pbr.and_then(|p| p.get("baseColorTexture")).is_some(),
        texture_color: None,
        texture: None,
        alpha_mode: match value.get("alphaMode").and_then(Value::as_str) {
            Some("MASK") => AlphaMode::Mask(
                value
                    .get("alphaCutoff")
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite())
                    .map_or(0.5, |v| v.clamp(0.0, 1.0) as f32),
            ),
            Some("BLEND") => AlphaMode::Blend,
            _ => AlphaMode::Opaque,
        },
    }
}

/// The picture a material's base colour texture shows, when it is in the
/// file's binary chunk: its image's index and bytes, the sampler's wrap
/// along u and v, and the texture coordinates it reads.
fn texture_of<'a>(
    json: &Value,
    bin: &'a [u8],
    material: &Value,
) -> Option<(usize, &'a [u8], [u32; 2], usize)> {
    let info = material
        .get("pbrMetallicRoughness")?
        .get("baseColorTexture")?;
    let texture = info.get("index")?.as_u64()? as usize;
    let tex_coord = index_of(info, "texCoord").unwrap_or(0);
    let texture = list(json, "textures").get(texture)?;
    let image = texture.get("source")?.as_u64()? as usize;
    let sampler = index_of(texture, "sampler").and_then(|s| list(json, "samplers").get(s));
    let wrap_of = |key: &str| {
        sampler
            .and_then(|s| s.get(key))
            .and_then(Value::as_u64)
            .and_then(|w| u32::try_from(w).ok())
            .filter(|w| [WRAP_REPEAT, WRAP_CLAMP, WRAP_MIRROR].contains(w))
            .unwrap_or(WRAP_REPEAT)
    };
    let view = list(json, "images")
        .get(image)?
        .get("bufferView")?
        .as_u64()? as usize;
    let view = list(json, "bufferViews").get(view)?;
    if view.get("buffer").and_then(Value::as_u64).unwrap_or(0) != 0 {
        return None;
    }
    let offset = view.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let length = view.get("byteLength")?.as_u64()? as usize;
    let bytes = bin.get(offset..offset.checked_add(length)?)?;
    Some((
        image,
        bytes,
        [wrap_of("wrapS"), wrap_of("wrapT")],
        tex_coord,
    ))
}

/// Reads a `.glb` file's triangle meshes, every node transform applied.
pub fn read_glb(bytes: &[u8]) -> Result<Model, String> {
    let (json, bin) = split_glb(bytes)?;
    let reader = Reader { json: &json, bin };
    let mut model = Model {
        materials: list(&json, "materials").iter().map(material_of).collect(),
        ..Model::default()
    };
    // Each texture's average colour and its picture, each picture read once.
    let mut averages: std::collections::HashMap<usize, (usize, Option<[f32; 3]>)> =
        std::collections::HashMap::new();
    for (material, value) in model.materials.iter_mut().zip(list(&json, "materials")) {
        if let Some((image, bytes, wrap, tex_coord)) = texture_of(&json, bin, value) {
            let (index, average) = *averages.entry(image).or_insert_with(|| {
                model.images.push(bytes.to_vec());
                (
                    model.images.len() - 1,
                    crate::textures::average_colour(bytes),
                )
            });
            material.texture_color = average;
            // Only a picture the builder can read is kept as a texture.
            if average.is_some() {
                material.texture = Some(TextureRef {
                    image: index,
                    wrap,
                    tex_coord,
                });
            }
        }
    }
    let fallback_material = model.materials.len();
    model.materials.push(Material::default());

    let nodes = list(&json, "nodes");
    let scene = index_of(&json, "scene").unwrap_or(0);
    let roots: Vec<usize> = match list(&json, "scenes").get(scene) {
        Some(scene) => list(scene, "nodes")
            .iter()
            .filter_map(Value::as_u64)
            .map(|n| n as usize)
            .collect(),
        // No scene: every node that is no other node's child.
        None => {
            let mut child = vec![false; nodes.len()];
            for node in nodes {
                for c in list(node, "children").iter().filter_map(Value::as_u64) {
                    if let Some(slot) = child.get_mut(c as usize) {
                        *slot = true;
                    }
                }
            }
            (0..nodes.len()).filter(|i| !child[*i]).collect()
        }
    };
    // Depth first, with each node's matrix and the names along the way; a
    // node is visited at most once, so a cycle cannot hang the reader.
    let mut visited = vec![false; nodes.len()];
    let mut stack: Vec<(usize, Matrix, Vec<String>)> = roots
        .into_iter()
        .rev()
        .map(|n| (n, IDENTITY, Vec::new()))
        .collect();
    while let Some((index, parent, mut names)) = stack.pop() {
        let Some(node) = nodes.get(index) else {
            continue;
        };
        if std::mem::replace(&mut visited[index], true) {
            continue;
        }
        let matrix = multiply(&parent, &node_matrix(node));
        if let Some(name) = node.get("name").and_then(Value::as_str) {
            names.push(name.to_owned());
        }
        for child in list(node, "children")
            .iter()
            .rev()
            .filter_map(Value::as_u64)
        {
            stack.push((child as usize, matrix, names.clone()));
        }
        let Some(mesh) = index_of(node, "mesh").and_then(|m| list(&json, "meshes").get(m)) else {
            continue;
        };
        let flip = determinant(&matrix) < 0.0;
        for primitive in list(mesh, "primitives") {
            if index_of(primitive, "mode").unwrap_or(4) != 4 {
                model.skipped_primitives += 1;
                continue;
            }
            let attributes = primitive.get("attributes");
            let Some(position) = attributes.and_then(|a| index_of(a, "POSITION")) else {
                model.skipped_primitives += 1;
                continue;
            };
            let (raw, components) = reader.accessor(position)?;
            if components != 3 {
                return Err("a mesh's positions are not three numbers each".to_owned());
            }
            let positions: Vec<[f64; 3]> = raw
                .as_chunks::<3>()
                .0
                .iter()
                .map(|p| {
                    let m = &matrix;
                    [
                        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
                        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
                        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
                    ]
                })
                .collect();
            let colors = match attributes.and_then(|a| index_of(a, "COLOR_0")) {
                Some(color) => {
                    let (raw, components) = reader.accessor(color)?;
                    if components != 3 && components != 4 {
                        return Err("a mesh's colours are not three or four numbers".to_owned());
                    }
                    let colors: Vec<[f32; 4]> = raw
                        .chunks_exact(components)
                        .map(|c| {
                            [
                                c[0] as f32,
                                c[1] as f32,
                                c[2] as f32,
                                if components == 4 { c[3] as f32 } else { 1.0 },
                            ]
                        })
                        .collect();
                    (colors.len() == positions.len()).then_some(colors)
                }
                None => None,
            };
            let material = index_of(primitive, "material")
                .filter(|m| *m < fallback_material)
                .unwrap_or(fallback_material);
            let uvs = match model.materials[material].texture.map(|t| t.tex_coord) {
                Some(set) => match attributes.and_then(|a| index_of(a, &format!("TEXCOORD_{set}")))
                {
                    Some(accessor) => {
                        let (raw, components) = reader.accessor(accessor)?;
                        if components != 2 {
                            return Err(
                                "a mesh's texture coordinates are not two numbers each".to_owned()
                            );
                        }
                        let uvs: Vec<[f32; 2]> = raw
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|uv| [uv[0] as f32, uv[1] as f32])
                            .collect();
                        (uvs.len() == positions.len()).then_some(uvs)
                    }
                    None => None,
                },
                None => None,
            };
            let mut indices: Vec<u32> = match index_of(primitive, "indices") {
                Some(accessor) => reader
                    .accessor(accessor)?
                    .0
                    .into_iter()
                    .map(|v| v as u32)
                    .collect(),
                None => (0..positions.len() as u32).collect(),
            };
            indices.truncate(indices.len() / 3 * 3);
            if indices.iter().any(|&i| i as usize >= positions.len()) {
                return Err("a mesh names a vertex it does not have".to_owned());
            }
            if flip {
                for triangle in indices.as_chunks_mut::<3>().0 {
                    triangle.swap(1, 2);
                }
            }
            let mut part_names = names.clone();
            if let Some(name) = mesh.get("name").and_then(Value::as_str) {
                part_names.push(name.to_owned());
            }
            if !model.materials[material].name.is_empty() {
                part_names.push(model.materials[material].name.clone());
            }
            model.parts.push(Part {
                names: part_names,
                material,
                positions,
                colors,
                uvs,
                indices,
            });
        }
    }
    Ok(model)
}
