//! Writing one model file of a cell: a glTF 2.0 binary file (`.glb`) with one
//! node, one mesh and one primitive per material, all sharing one vertex
//! buffer: positions (32-bit floats), normals (8-bit, with
//! `KHR_mesh_quantization`), when the model has them, vertex colours
//! (16-bit), and, when textures are kept, texture coordinates (32-bit
//! floats, `TEXCOORD_0`) with each picture once in the file (PNG or JPEG,
//! see [`crate::textures`]). With `compress`, every buffer view of vertices
//! and triangles is written with
//! `EXT_meshopt_compression` (vertex codec version 0 and index codec
//! version 1, as that extension reads them), and the file needs the meshopt
//! decoder that Atlas carries.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::gltf::{AlphaMode, Material};
use crate::textures::Encoded;

/// The triangles of one material, with its picture when its texture is kept.
pub struct GlbPrimitive {
    pub material: Material,
    /// The picture of its base colour texture, read with `TEXCOORD_0`
    /// and the material's texture's wrap.
    pub texture: Option<Arc<Encoded>>,
    /// Three indices per triangle.
    pub indices: Vec<u32>,
}

/// The vertices of a cell at one level, and its triangles by material.
pub struct GlbMesh<'a> {
    pub name: &'a str,
    pub positions: Vec<[f32; 3]>,
    /// Unit length.
    pub normals: Vec<[f32; 3]>,
    /// Linear RGBA, when the model has vertex colours.
    pub colors: Option<Vec<[f32; 4]>>,
    /// Texture coordinates, when textures are kept.
    pub uvs: Option<Vec<[f32; 2]>>,
    /// Each material once.
    pub primitives: Vec<GlbPrimitive>,
}

/// What [`write_glb`] wrote.
pub struct Written {
    pub bytes: Vec<u8>,
    pub triangles: usize,
    /// The pictures in the file, and their bytes.
    pub pictures: usize,
    pub texture_bytes: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Position([f32; 3]);
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Normal([i8; 4]);
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Color([u16; 4]);
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Uv([f32; 2]);

const FLOAT: u32 = 5126;
const BYTE: u32 = 5120;
const UNSIGNED_SHORT: u32 = 5123;
const UNSIGNED_INT: u32 = 5125;
const ARRAY_BUFFER: u32 = 34962;
const ELEMENT_ARRAY_BUFFER: u32 = 34963;

fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

fn snorm8(v: f32) -> i8 {
    (v.clamp(-1.0, 1.0) * 127.0).round() as i8
}

fn unorm16(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * 65535.0).round() as u16
}

fn as_bytes<T: Copy>(items: &[T]) -> Vec<u8> {
    let size = std::mem::size_of_val(items);
    let mut out = vec![0u8; size];
    // SAFETY: T is one of this module's plain #[repr(C)] number types (no
    // padding inside: 12, 4 and 8 bytes of numbers) or a primitive number.
    unsafe { std::ptr::copy_nonoverlapping(items.as_ptr().cast::<u8>(), out.as_mut_ptr(), size) };
    out
}

/// A vertex stream encoded for `EXT_meshopt_compression`: vertex codec
/// version 0, the one that extension reads.
fn encode_vertices<T>(items: &[T], compress: bool) -> Result<Option<Vec<u8>>, String> {
    if !compress {
        return Ok(None);
    }
    meshopt::encode_vertex_buffer_level(items, 2, Some(0))
        .map(Some)
        .map_err(|error| format!("meshopt could not encode: {error}"))
}

struct View {
    /// The raw bytes of `count` elements of `stride` bytes.
    bytes: Vec<u8>,
    /// The meshopt-encoded bytes, when compressed.
    encoded: Option<Vec<u8>>,
    stride: usize,
    count: usize,
    target: u32,
}

/// Writes the mesh as a `.glb` file: its bytes, its triangles and the bytes of its pictures.
pub fn write_glb(mesh: GlbMesh<'_>, compress: bool, generator: &str) -> Result<Written, String> {
    let GlbMesh {
        name,
        positions,
        normals,
        colors,
        uvs,
        mut primitives,
    } = mesh;
    let vertex_count = positions.len();
    // Vertices in the order the triangles first use them, then each
    // primitive's triangles in the order a GPU's vertex cache likes.
    let all: Vec<u32> = primitives
        .iter()
        .flat_map(|p| p.indices.iter().copied())
        .collect();
    // (meshopt's own remap call cuts its table short, so the order is made here.)
    let mut remap = vec![u32::MAX; vertex_count];
    let mut used = 0usize;
    for &index in &all {
        let slot = &mut remap[index as usize];
        if *slot == u32::MAX {
            *slot = used as u32;
            used += 1;
        }
    }
    let mut new_positions = vec![Position::default(); used];
    let mut new_normals = vec![Normal::default(); used];
    let mut new_colors = colors.as_ref().map(|_| vec![Color::default(); used]);
    let mut new_uvs = uvs.as_ref().map(|_| vec![Uv::default(); used]);
    for (old, &new) in remap.iter().enumerate() {
        if new == u32::MAX {
            continue;
        }
        let new = new as usize;
        new_positions[new] = Position(positions[old]);
        let n = normals[old];
        new_normals[new] = Normal([snorm8(n[0]), snorm8(n[1]), snorm8(n[2]), 0]);
        if let (Some(out), Some(colors)) = (new_colors.as_mut(), colors.as_ref()) {
            out[new] = Color(colors[old].map(unorm16));
        }
        if let (Some(out), Some(uvs)) = (new_uvs.as_mut(), uvs.as_ref()) {
            out[new] = Uv(uvs[old]);
        }
    }
    for primitive in &mut primitives {
        for index in primitive.indices.iter_mut() {
            *index = remap[*index as usize];
        }
        meshopt::optimize_vertex_cache_in_place(&mut primitive.indices, used);
    }

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in &new_positions {
        for k in 0..3 {
            min[k] = min[k].min(p.0[k]);
            max[k] = max[k].max(p.0[k]);
        }
    }
    if used == 0 {
        min = [0.0; 3];
        max = [0.0; 3];
    }

    let mut views: Vec<View> = Vec::new();
    let mut accessors: Vec<Value> = Vec::new();
    let position_bytes = as_bytes(&new_positions);
    let encoded = encode_vertices(&new_positions, compress)?;
    views.push(View {
        bytes: position_bytes,
        encoded,
        stride: 12,
        count: used,
        target: ARRAY_BUFFER,
    });
    accessors.push(json!({
        "bufferView": 0, "componentType": FLOAT, "count": used, "type": "VEC3",
        "min": min, "max": max,
    }));
    let normal_bytes = as_bytes(&new_normals);
    let encoded = encode_vertices(&new_normals, compress)?;
    views.push(View {
        bytes: normal_bytes,
        encoded,
        stride: 4,
        count: used,
        target: ARRAY_BUFFER,
    });
    accessors.push(json!({
        "bufferView": 1, "componentType": BYTE, "normalized": true, "count": used, "type": "VEC3",
    }));
    let mut attributes = json!({ "POSITION": 0, "NORMAL": 1 });
    if let Some(colors) = &new_colors {
        let color_bytes = as_bytes(colors);
        let encoded = encode_vertices(colors, compress)?;
        views.push(View {
            bytes: color_bytes,
            encoded,
            stride: 8,
            count: used,
            target: ARRAY_BUFFER,
        });
        accessors.push(json!({
            "bufferView": views.len() - 1, "componentType": UNSIGNED_SHORT, "normalized": true, "count": used, "type": "VEC4",
        }));
        attributes["COLOR_0"] = json!(accessors.len() - 1);
    }
    if let Some(uvs) = &new_uvs {
        let uv_bytes = as_bytes(uvs);
        let encoded = encode_vertices(uvs, compress)?;
        views.push(View {
            bytes: uv_bytes,
            encoded,
            stride: 8,
            count: used,
            target: ARRAY_BUFFER,
        });
        accessors.push(json!({
            "bufferView": views.len() - 1, "componentType": FLOAT, "count": used, "type": "VEC2",
        }));
        attributes["TEXCOORD_0"] = json!(accessors.len() - 1);
    }

    let wide = used > 65535;
    let mut triangles = 0;
    let mut materials: Vec<Value> = Vec::new();
    let mut gltf_primitives: Vec<Value> = Vec::new();
    // Pictures (each once in the file), samplers (each wrap once) and textures (each pair once).
    let mut pictures: Vec<Arc<Encoded>> = Vec::new();
    let mut samplers: Vec<[u32; 2]> = Vec::new();
    let mut textures: Vec<(usize, usize)> = Vec::new();
    for primitive in &primitives {
        let (material, indices) = (&primitive.material, &primitive.indices);
        if indices.is_empty() {
            continue;
        }
        triangles += indices.len() / 3;
        let bytes = if wide {
            as_bytes(indices)
        } else {
            let short: Vec<u16> = indices.iter().map(|&i| i as u16).collect();
            as_bytes(&short)
        };
        let encoded = if compress {
            Some(
                meshopt::encode_index_buffer(indices, used)
                    .map_err(|error| format!("meshopt could not encode: {error}"))?,
            )
        } else {
            None
        };
        views.push(View {
            bytes,
            encoded,
            stride: if wide { 4 } else { 2 },
            count: indices.len(),
            target: ELEMENT_ARRAY_BUFFER,
        });
        accessors.push(json!({
            "bufferView": views.len() - 1,
            "componentType": if wide { UNSIGNED_INT } else { UNSIGNED_SHORT },
            "count": indices.len(),
            "type": "SCALAR",
        }));
        let mut m = json!({
            "pbrMetallicRoughness": {
                "baseColorFactor": material.color,
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        });
        if !material.name.is_empty() {
            m["name"] = json!(material.name);
        }
        if material.double_sided {
            m["doubleSided"] = json!(true);
        }
        if let (Some(picture), Some(texture), true) =
            (&primitive.texture, material.texture, new_uvs.is_some())
        {
            let image = match pictures.iter().position(|p| Arc::ptr_eq(p, picture)) {
                Some(at) => at,
                None => {
                    pictures.push(picture.clone());
                    pictures.len() - 1
                }
            };
            let sampler = match samplers.iter().position(|w| *w == texture.wrap) {
                Some(at) => at,
                None => {
                    samplers.push(texture.wrap);
                    samplers.len() - 1
                }
            };
            let index = match textures.iter().position(|t| *t == (image, sampler)) {
                Some(at) => at,
                None => {
                    textures.push((image, sampler));
                    textures.len() - 1
                }
            };
            m["pbrMetallicRoughness"]["baseColorTexture"] = json!({ "index": index });
            match material.alpha_mode {
                AlphaMode::Opaque => {}
                AlphaMode::Mask(cutoff) => {
                    m["alphaMode"] = json!("MASK");
                    m["alphaCutoff"] = json!(cutoff);
                }
                AlphaMode::Blend => m["alphaMode"] = json!("BLEND"),
            }
        }
        materials.push(m);
        gltf_primitives.push(json!({
            "attributes": attributes,
            "indices": accessors.len() - 1,
            "material": materials.len() - 1,
            "mode": 4,
        }));
    }

    // The binary chunk: the views' bytes (or, compressed, their encoded
    // bytes, with the plain bytes left to a fallback buffer that is never
    // stored), each from a 4-byte boundary.
    let mut bin: Vec<u8> = Vec::new();
    let mut fallback = 0usize;
    let mut buffer_views: Vec<Value> = Vec::new();
    for view in &views {
        let length = view.count * view.stride;
        let mut entry = json!({ "buffer": 0, "byteLength": length, "target": view.target });
        if view.target == ARRAY_BUFFER {
            entry["byteStride"] = json!(view.stride);
        }
        match &view.encoded {
            None => {
                entry["byteOffset"] = json!(bin.len());
                bin.extend_from_slice(&view.bytes[..length]);
            }
            Some(encoded) => {
                entry["buffer"] = json!(1);
                entry["byteOffset"] = json!(fallback);
                fallback += pad4(length);
                entry["extensions"] = json!({
                    "EXT_meshopt_compression": {
                        "buffer": 0,
                        "byteOffset": bin.len(),
                        "byteLength": encoded.len(),
                        "byteStride": view.stride,
                        "count": view.count,
                        "mode": if view.target == ARRAY_BUFFER { "ATTRIBUTES" } else { "TRIANGLES" },
                    }
                });
                bin.extend_from_slice(encoded);
            }
        }
        bin.resize(pad4(bin.len()), 0);
        buffer_views.push(entry);
    }
    // The pictures, plain (they are compressed already).
    let mut images: Vec<Value> = Vec::new();
    let mut texture_bytes = 0u64;
    for picture in &pictures {
        buffer_views.push(json!({
            "buffer": 0, "byteOffset": bin.len(), "byteLength": picture.bytes.len(),
        }));
        bin.extend_from_slice(&picture.bytes);
        bin.resize(pad4(bin.len()), 0);
        texture_bytes += picture.bytes.len() as u64;
        images.push(json!({ "bufferView": buffer_views.len() - 1, "mimeType": picture.mime }));
    }
    let mut buffers = vec![json!({ "byteLength": bin.len() })];
    let mut used_extensions = vec!["KHR_mesh_quantization"];
    if compress {
        buffers.push(json!({
            "byteLength": fallback,
            "extensions": { "EXT_meshopt_compression": { "fallback": true } },
        }));
        used_extensions.push("EXT_meshopt_compression");
    }
    let mut document = json!({
        "asset": { "version": "2.0", "generator": generator },
        "extensionsUsed": used_extensions,
        "extensionsRequired": used_extensions,
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "name": name, "mesh": 0 }],
        "meshes": [{ "name": name, "primitives": gltf_primitives }],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": buffers,
    });
    if !images.is_empty() {
        document["images"] = json!(images);
        document["samplers"] = json!(samplers
            .iter()
            .map(|[s, t]| json!({ "magFilter": 9729, "minFilter": 9987, "wrapS": s, "wrapT": t }))
            .collect::<Vec<_>>());
        document["textures"] = json!(textures
            .iter()
            .map(|(source, sampler)| json!({ "source": source, "sampler": sampler }))
            .collect::<Vec<_>>());
    }
    let mut json_bytes = serde_json::to_vec(&document).map_err(|error| error.to_string())?;
    json_bytes.resize(pad4(json_bytes.len()), b' ');
    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    Ok(Written {
        bytes: out,
        triangles,
        pictures: pictures.len(),
        texture_bytes,
    })
}
