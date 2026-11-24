//! Reading a map's model back out of a pack folder (`atlas-scene unpack`),
//! so an app can draw the map's 2D floors again from the pack alone, with no
//! game files: the Map Maker's "Draw all areas again".
//!
//! For one map of the pack's `maps.json`, each cell's finest level whose
//! file is in the pack is read (a pack file written at standard or overview
//! detail has no level 0, so its finest is a coarser one), its buffers
//! decompressed when they use `EXT_meshopt_compression` (or the newer
//! `KHR_meshopt_compression`), every node transform applied, and its points
//! taken to the world with the scene's `axes`, `scale` and `offset`. The
//! cells together are written as one raw model, as the builder reads one
//! ([`crate::gltf::read_glb`]): a glTF binary file of plain triangle meshes,
//! one per material, with 32-bit float positions in the axes `+x`, `+z`,
//! `+y` (world x, height, world y: building it again with those axes gives
//! the same world), its vertex colours (`COLOR_0`, linear RGBA) and, where a
//! material's base colour texture is a PNG or JPEG picture in the file, the
//! picture and its texture coordinates (`TEXCOORD_0`). Each picture is
//! written once, however many cells use it. A KTX2 texture
//! (`KHR_texture_basisu`) is not read: its material keeps its colour.
//!
//! The pack is as untrusted as any: only model files whose names follow the
//! pack file format's rule are read, each at most 256 MB, and what is
//! decompressed is bounded.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::check::{check_model_file, MAX_CELLS};
use crate::gltf::{read_glb, split_glb, AlphaMode, Material};
use crate::{Options, Transform};

/// The most bytes the decompressed buffers of one model file may have.
pub const MAX_DECODED_BYTES: usize = 1 << 30;

const ARRAY_BUFFER: u64 = 34962;
const FLOAT: u32 = 5126;
const UNSIGNED_INT: u32 = 5125;

/// What `unpack` read and wrote.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpackReport {
    pub map: String,
    /// Cells read, and the cells of the scene.
    pub cells: usize,
    pub cells_in_scene: usize,
    /// How many cells were read at each level (`"0"`: the finest).
    pub levels: HashMap<String, usize>,
    pub triangles: usize,
    pub materials: usize,
    /// Pictures written (each once).
    pub textures: usize,
    /// Materials with a texture that could not be read (a KTX2 picture, say): drawn with their colour.
    pub textures_not_read: usize,
    pub bytes: u64,
    pub warnings: Vec<String>,
}

/// Decompresses the buffer views of a `.glb` file that use
/// `EXT_meshopt_compression` (or `KHR_meshopt_compression`): the file again,
/// with one plain buffer. `None` when nothing in it is compressed.
pub fn decompress_glb(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let (mut json, bin) = split_glb(bytes)?;
    let views = json
        .get("bufferViews")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let compressed = |view: &Value| -> Option<Value> {
        let extensions = view.get("extensions")?;
        extensions
            .get("EXT_meshopt_compression")
            .or_else(|| extensions.get("KHR_meshopt_compression"))
            .cloned()
    };
    if !views.iter().any(|view| compressed(view).is_some()) {
        return Ok(None);
    }
    let main_buffer_ok = json
        .get("buffers")
        .and_then(Value::as_array)
        .and_then(|buffers| buffers.first())
        .is_some_and(|buffer| buffer.get("uri").is_none());
    if !main_buffer_ok {
        return Err("the model reads a file of its own (a uri)".to_owned());
    }
    let number = |value: &Value, key: &str| -> Option<usize> {
        value
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
    };
    let slice = |offset: usize, length: usize| -> Result<&[u8], String> {
        offset
            .checked_add(length)
            .and_then(|end| bin.get(offset..end))
            .ok_or_else(|| "a buffer view runs past the end of the file".to_owned())
    };
    let mut out: Vec<u8> = Vec::new();
    let mut decoded_total = 0usize;
    let mut new_views = Vec::with_capacity(views.len());
    for view in &views {
        let data: Vec<u8> = match compressed(view) {
            Some(ext) => {
                if number(&ext, "buffer").unwrap_or(0) != 0 {
                    return Err(
                        "a compressed buffer view is not in the file's own buffer".to_owned()
                    );
                }
                let source = slice(
                    number(&ext, "byteOffset").unwrap_or(0),
                    number(&ext, "byteLength").ok_or("a compressed buffer view has no length")?,
                )?;
                let stride =
                    number(&ext, "byteStride").ok_or("a compressed buffer view has no stride")?;
                let count = number(&ext, "count").ok_or("a compressed buffer view has no count")?;
                let size = count
                    .checked_mul(stride)
                    .filter(|size| *size <= MAX_DECODED_BYTES)
                    .ok_or("a compressed buffer view is too large")?;
                decoded_total = decoded_total
                    .checked_add(size)
                    .filter(|total| *total <= MAX_DECODED_BYTES)
                    .ok_or("the model's buffers are too large once decompressed")?;
                let mode = ext.get("mode").and_then(Value::as_str).unwrap_or("");
                let filter = ext.get("filter").and_then(Value::as_str).unwrap_or("NONE");
                decode_view(source, count, stride, mode, filter)?
            }
            None => {
                if number(view, "buffer").unwrap_or(0) != 0 {
                    return Err("a buffer view reads a buffer that is not in the file".to_owned());
                }
                slice(
                    number(view, "byteOffset").unwrap_or(0),
                    number(view, "byteLength").ok_or("a buffer view has no length")?,
                )?
                .to_vec()
            }
        };
        let mut entry = json!({ "buffer": 0, "byteOffset": out.len(), "byteLength": data.len() });
        for key in ["byteStride", "target", "name"] {
            if let Some(value) = view.get(key) {
                entry[key] = value.clone();
            }
        }
        out.extend_from_slice(&data);
        out.resize(out.len().next_multiple_of(4), 0);
        new_views.push(entry);
    }
    json["bufferViews"] = Value::Array(new_views);
    json["buffers"] = json!([{ "byteLength": out.len() }]);
    for key in ["extensionsUsed", "extensionsRequired"] {
        if let Some(list) = json.get_mut(key).and_then(Value::as_array_mut) {
            list.retain(|name| {
                name != "EXT_meshopt_compression" && name != "KHR_meshopt_compression"
            });
        }
    }
    Ok(Some(glb_bytes(&json, &out)?))
}

/// One compressed buffer view, decoded (and its filter undone).
fn decode_view(
    source: &[u8],
    count: usize,
    stride: usize,
    mode: &str,
    filter: &str,
) -> Result<Vec<u8>, String> {
    let mut data = vec![0u8; count * stride];
    if count == 0 {
        return Ok(data);
    }
    // The decoder's own limits, checked first: it must never be handed a size it does not take.
    let code = match mode {
        "ATTRIBUTES" => {
            if stride == 0 || stride > 256 || !stride.is_multiple_of(4) {
                return Err(format!(
                    "a compressed vertex stream has a stride of {stride}"
                ));
            }
            // SAFETY: `data` holds `count * stride` bytes; the decoder writes at most that and reads
            // at most `source.len()` bytes of `source`.
            unsafe {
                meshopt::ffi::meshopt_decodeVertexBuffer(
                    data.as_mut_ptr().cast(),
                    count,
                    stride,
                    source.as_ptr(),
                    source.len(),
                )
            }
        }
        "TRIANGLES" | "INDICES" => {
            if stride != 2 && stride != 4 {
                return Err(format!("compressed indices have a stride of {stride}"));
            }
            if mode == "TRIANGLES" && !count.is_multiple_of(3) {
                return Err("compressed triangles are not three indices each".to_owned());
            }
            // SAFETY: as above.
            unsafe {
                if mode == "TRIANGLES" {
                    meshopt::ffi::meshopt_decodeIndexBuffer(
                        data.as_mut_ptr().cast(),
                        count,
                        stride,
                        source.as_ptr(),
                        source.len(),
                    )
                } else {
                    meshopt::ffi::meshopt_decodeIndexSequence(
                        data.as_mut_ptr().cast(),
                        count,
                        stride,
                        source.as_ptr(),
                        source.len(),
                    )
                }
            }
        }
        other => return Err(format!("a compressed buffer view has the mode {other:?}")),
    };
    if code != 0 {
        return Err("a compressed buffer view cannot be decoded".to_owned());
    }
    if mode == "ATTRIBUTES" {
        let ok = match filter {
            "NONE" => true,
            "OCTAHEDRAL" => stride == 4 || stride == 8,
            "QUATERNION" => stride == 8,
            "EXPONENTIAL" => stride.is_multiple_of(4),
            "COLOR" => stride == 4 || stride == 8,
            other => return Err(format!("a compressed buffer view has the filter {other:?}")),
        };
        if !ok {
            return Err(format!(
                "the filter {filter} does not take a stride of {stride}"
            ));
        }
        // SAFETY: `data` holds `count` elements of `stride` bytes, a size each filter takes (checked above).
        unsafe {
            let at = data.as_mut_ptr().cast();
            match filter {
                "OCTAHEDRAL" => meshopt::ffi::meshopt_decodeFilterOct(at, count, stride),
                "QUATERNION" => meshopt::ffi::meshopt_decodeFilterQuat(at, count, stride),
                "EXPONENTIAL" => meshopt::ffi::meshopt_decodeFilterExp(at, count, stride),
                "COLOR" => meshopt::ffi::meshopt_decodeFilterColor(at, count, stride),
                _ => {}
            }
        }
    } else if filter != "NONE" {
        return Err(format!("compressed indices have the filter {filter}"));
    }
    Ok(data)
}

fn glb_bytes(json: &Value, bin: &[u8]) -> Result<Vec<u8>, String> {
    let mut text = serde_json::to_vec(json).map_err(|error| error.to_string())?;
    text.resize(text.len().next_multiple_of(4), b' ');
    let total = 12 + 8 + text.len() + 8 + bin.len();
    let total = u32::try_from(total).map_err(|_| "the model is over 4 GB".to_owned())?;
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&total.to_le_bytes());
    out.extend_from_slice(&(text.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&text);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(bin);
    Ok(out)
}

/// One material of the raw model written, with what was put under it.
struct Group {
    material: Material,
    /// The picture of its texture, in `pictures`.
    picture: Option<usize>,
    positions: Vec<[f32; 3]>,
    colors: Vec<[f32; 4]>,
    uvs: Vec<[f32; 2]>,
    has_colors: bool,
    indices: Vec<u32>,
}

/// A material's identity across cells: its picture, wrap and the bits of its numbers.
fn material_key(material: &Material, picture: Option<usize>) -> String {
    let alpha = match material.alpha_mode {
        AlphaMode::Opaque => "o".to_owned(),
        AlphaMode::Mask(cutoff) => format!("m{}", cutoff.to_bits()),
        AlphaMode::Blend => "b".to_owned(),
    };
    format!(
        "{}|{:?}|{}|{}|{:?}|{:?}",
        material.name,
        material.color.map(f32::to_bits),
        material.double_sided,
        alpha,
        picture,
        material.texture.map(|t| t.wrap),
    )
}

fn mime_of(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        "image/jpeg"
    }
}

/// Reads the model of map `map_id` in the pack folder `pack` (see the
/// module) and returns it as a raw model's `.glb` bytes, with a report.
pub fn unpack(pack: &Path, map_id: &str) -> Result<(Vec<u8>, UnpackReport), String> {
    let text = fs::read_to_string(pack.join("maps.json"))
        .map_err(|error| format!("maps.json cannot be read: {error}"))?;
    let maps: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("maps.json is not JSON: {error}"))?;
    let map = maps
        .as_array()
        .and_then(|maps| {
            maps.iter()
                .find(|m| m.get("id").and_then(Value::as_str) == Some(map_id))
        })
        .ok_or_else(|| format!("the pack has no map {map_id}"))?;
    let scene = map
        .get("scene")
        .ok_or_else(|| format!("the map {map_id} has no 3D model"))?;
    let mut options = Options::new("scene/unpack");
    if let Some(axes) = scene.get("axes") {
        options.axes = Some(
            serde_json::from_value::<[String; 3]>(axes.clone())
                .map_err(|_| "the scene's axes are not three names".to_owned())?,
        );
    }
    options.scale = scene.get("scale").and_then(Value::as_f64);
    if let Some(offset) = scene.get("offset") {
        options.offset = Some(
            serde_json::from_value::<[f64; 3]>(offset.clone())
                .map_err(|_| "the scene's offset is not three numbers".to_owned())?,
        );
    }
    let transform = Transform::new(&options)?;
    // World (x, y, height) is written as (x, height, y), a mirror: with a
    // transform that is none, the corners go the other way round to keep
    // each front a front.
    let swap = !transform.mirrors();
    let cells = scene
        .get("cells")
        .and_then(Value::as_array)
        .ok_or("the scene has no cells")?;
    if cells.len() > MAX_CELLS {
        return Err(format!("the scene has more than {MAX_CELLS} cells"));
    }
    let mut report = UnpackReport {
        map: map_id.to_owned(),
        cells_in_scene: cells.len(),
        ..UnpackReport::default()
    };
    let mut pictures: Vec<Vec<u8>> = Vec::new();
    let mut groups: Vec<Group> = Vec::new();
    let mut group_of: HashMap<String, usize> = HashMap::new();
    for cell in cells {
        let id = cell.get("id").and_then(Value::as_str).unwrap_or("?");
        let mut lods: Vec<(u64, &str)> = cell
            .get("lods")
            .and_then(Value::as_array)
            .map(|lods| {
                lods.iter()
                    .filter_map(|lod| {
                        Some((lod.get("level")?.as_u64()?, lod.get("file")?.as_str()?))
                    })
                    .collect()
            })
            .unwrap_or_default();
        lods.sort_by_key(|(level, _)| *level);
        let mut read = None;
        let mut problem = None;
        for (level, file) in lods {
            if !atlas_pack::is_scene_file_name(file) {
                problem = Some(format!("{file} is not a model file name"));
                continue;
            }
            let path = pack.join(file);
            if let Err(error) = check_model_file(&path) {
                problem = Some(format!("{file} {error}"));
                continue;
            }
            let bytes =
                fs::read(&path).map_err(|error| format!("{file} cannot be read: {error}"))?;
            let plain = decompress_glb(&bytes).map_err(|error| format!("{file}: {error}"))?;
            let model = read_glb(plain.as_deref().unwrap_or(&bytes))
                .map_err(|error| format!("{file}: {error}"))?;
            report.bytes += bytes.len() as u64;
            read = Some((level, model, bytes));
            break;
        }
        let Some((level, model, bytes)) = read else {
            report.warnings.push(format!(
                "cell {id}: no level could be read{}",
                problem.map(|p| format!(" ({p})")).unwrap_or_default()
            ));
            continue;
        };
        drop(bytes);
        report.cells += 1;
        *report.levels.entry(level.to_string()).or_default() += 1;
        // This file's pictures, each once in all.
        let picture_of: Vec<usize> = model
            .images
            .iter()
            .map(|image| match pictures.iter().position(|p| p == image) {
                Some(at) => at,
                None => {
                    pictures.push(image.clone());
                    pictures.len() - 1
                }
            })
            .collect();
        for part in &model.parts {
            let material = &model.materials[part.material];
            let picture = material.texture.map(|t| picture_of[t.image]);
            let key = material_key(material, picture);
            let at = *group_of.entry(key).or_insert_with(|| {
                groups.push(Group {
                    material: material.clone(),
                    picture,
                    positions: Vec::new(),
                    colors: Vec::new(),
                    uvs: Vec::new(),
                    has_colors: false,
                    indices: Vec::new(),
                });
                groups.len() - 1
            });
            let group = &mut groups[at];
            let base = u32::try_from(group.positions.len())
                .map_err(|_| "the model has too many vertices".to_owned())?;
            for (i, p) in part.positions.iter().enumerate() {
                let [x, y, h] = transform.apply(p);
                group.positions.push([x as f32, h as f32, y as f32]);
                group.colors.push(
                    part.colors
                        .as_ref()
                        .and_then(|c| c.get(i).copied())
                        .unwrap_or([1.0; 4]),
                );
                group.uvs.push(
                    part.uvs
                        .as_ref()
                        .and_then(|u| u.get(i).copied())
                        .unwrap_or([0.0; 2]),
                );
            }
            group.has_colors |= part.colors.is_some();
            for triangle in part.indices.as_chunks::<3>().0 {
                let [a, b, c] = triangle.map(|i| base + i);
                if swap {
                    group.indices.extend([a, c, b]);
                } else {
                    group.indices.extend([a, b, c]);
                }
            }
            report.triangles += part.indices.len() / 3;
        }
        report.textures_not_read += model
            .materials
            .iter()
            .filter(|m| m.textured && m.texture.is_none())
            .count();
    }
    if report.cells == 0 {
        return Err(format!("no cell of the map {map_id} could be read"));
    }
    if report.textures_not_read > 0 {
        report.warnings.push(format!(
            "{} textures could not be read (only PNG and JPEG pictures are): those surfaces keep their colour",
            report.textures_not_read
        ));
    }
    report.materials = groups.len();
    report.textures = pictures.len();
    Ok((write_raw(&groups, &pictures)?, report))
}

/// The raw model: a node and mesh per material group, plain buffers.
fn write_raw(groups: &[Group], pictures: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    let mut bin: Vec<u8> = Vec::new();
    let mut views: Vec<Value> = Vec::new();
    let mut accessors: Vec<Value> = Vec::new();
    let mut push = |bytes: &[u8], target: Option<u64>, stride: Option<usize>| -> usize {
        let mut view = json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": bytes.len() });
        if let Some(target) = target {
            view["target"] = json!(target);
        }
        if let Some(stride) = stride {
            view["byteStride"] = json!(stride);
        }
        bin.extend_from_slice(bytes);
        bin.resize(bin.len().next_multiple_of(4), 0);
        views.push(view);
        views.len() - 1
    };
    let floats = |items: &mut dyn Iterator<Item = f32>| -> Vec<u8> {
        items.flat_map(f32::to_le_bytes).collect()
    };
    let mut images = Vec::new();
    for picture in pictures {
        let view = push(picture, None, None);
        images.push(json!({ "bufferView": view, "mimeType": mime_of(picture) }));
    }
    let mut samplers: Vec<[u32; 2]> = Vec::new();
    let mut textures: Vec<(usize, usize)> = Vec::new();
    let mut materials = Vec::new();
    let mut meshes = Vec::new();
    let mut nodes = Vec::new();
    for group in groups.iter().filter(|g| !g.indices.is_empty()) {
        let count = group.positions.len();
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for p in &group.positions {
            for k in 0..3 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        let view = push(
            &floats(&mut group.positions.iter().flatten().copied()),
            Some(ARRAY_BUFFER),
            Some(12),
        );
        accessors.push(json!({
            "bufferView": view, "componentType": FLOAT, "count": count, "type": "VEC3", "min": min, "max": max,
        }));
        let mut attributes = json!({ "POSITION": accessors.len() - 1 });
        if group.has_colors {
            let view = push(
                &floats(&mut group.colors.iter().flatten().copied()),
                Some(ARRAY_BUFFER),
                Some(16),
            );
            accessors.push(json!({ "bufferView": view, "componentType": FLOAT, "count": count, "type": "VEC4" }));
            attributes["COLOR_0"] = json!(accessors.len() - 1);
        }
        let mut material = json!({
            "pbrMetallicRoughness": {
                "baseColorFactor": group.material.color,
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        });
        if !group.material.name.is_empty() {
            material["name"] = json!(group.material.name);
        }
        if group.material.double_sided {
            material["doubleSided"] = json!(true);
        }
        match group.material.alpha_mode {
            AlphaMode::Opaque => {}
            AlphaMode::Mask(cutoff) => {
                material["alphaMode"] = json!("MASK");
                material["alphaCutoff"] = json!(cutoff);
            }
            AlphaMode::Blend => material["alphaMode"] = json!("BLEND"),
        }
        if let (Some(picture), Some(texture)) = (group.picture, group.material.texture) {
            let view = push(
                &floats(&mut group.uvs.iter().flatten().copied()),
                Some(ARRAY_BUFFER),
                Some(8),
            );
            accessors.push(json!({ "bufferView": view, "componentType": FLOAT, "count": count, "type": "VEC2" }));
            attributes["TEXCOORD_0"] = json!(accessors.len() - 1);
            let sampler = match samplers.iter().position(|w| *w == texture.wrap) {
                Some(at) => at,
                None => {
                    samplers.push(texture.wrap);
                    samplers.len() - 1
                }
            };
            let index = match textures.iter().position(|t| *t == (picture, sampler)) {
                Some(at) => at,
                None => {
                    textures.push((picture, sampler));
                    textures.len() - 1
                }
            };
            material["pbrMetallicRoughness"]["baseColorTexture"] = json!({ "index": index });
        }
        let index_bytes: Vec<u8> = group.indices.iter().flat_map(|i| i.to_le_bytes()).collect();
        let view = push(&index_bytes, Some(34963), None);
        accessors.push(json!({
            "bufferView": view, "componentType": UNSIGNED_INT, "count": group.indices.len(), "type": "SCALAR",
        }));
        materials.push(material);
        let name = if group.material.name.is_empty() {
            format!("material {}", materials.len() - 1)
        } else {
            group.material.name.clone()
        };
        meshes.push(json!({
            "name": name,
            "primitives": [{
                "attributes": attributes,
                "indices": accessors.len() - 1,
                "material": materials.len() - 1,
                "mode": 4,
            }],
        }));
        nodes.push(json!({ "name": name, "mesh": meshes.len() - 1 }));
    }
    let mut document = json!({
        "asset": { "version": "2.0", "generator": concat!("Atlas scene builder ", env!("CARGO_PKG_VERSION"), " (unpacked)") },
        "scene": 0,
        "scenes": [{ "nodes": (0..nodes.len()).collect::<Vec<_>>() }],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{ "byteLength": bin.len() }],
    });
    if !images.is_empty() {
        document["images"] = json!(images);
        document["samplers"] = json!(samplers
            .iter()
            .map(|[s, t]| json!({ "wrapS": s, "wrapT": t }))
            .collect::<Vec<_>>());
        document["textures"] = json!(textures
            .iter()
            .map(|(source, sampler)| json!({ "source": source, "sampler": sampler }))
            .collect::<Vec<_>>());
    }
    glb_bytes(&document, &bin)
}

/// `unpack`, written to `output`: through a `.part` file beside it, renamed once whole.
pub fn unpack_to_file(pack: &Path, map_id: &str, output: &Path) -> Result<UnpackReport, String> {
    let (bytes, report) = unpack(pack, map_id)?;
    let partial = output.with_extension("glb.part");
    fs::write(&partial, &bytes)
        .map_err(|error| format!("{} cannot be written: {error}", partial.display()))?;
    fs::rename(&partial, output).map_err(|error| {
        let _ = fs::remove_file(&partial);
        format!("{} cannot be written: {error}", output.display())
    })?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gltf::{Part, TextureRef, WRAP_CLAMP, WRAP_REPEAT};
    use crate::{build, Model};

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("atlas-scene-unpack-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Two level squares of `n` by `n` units, one at height 0 and one at
    /// height 5 over its west half, in the raw axes `+x`, `+z`, `+y` (x,
    /// height, y), counter-clockwise from above, coloured by height.
    fn storeys(n: usize) -> Model {
        let mut positions = Vec::new();
        let mut colors = Vec::new();
        let mut indices = Vec::new();
        for (h, width) in [(0.0, n), (5.0, n / 2)] {
            for j in 0..n {
                for i in 0..width {
                    let base = positions.len() as u32;
                    let (x, y) = (i as f64, j as f64);
                    positions.extend([
                        [x, h, y],
                        [x + 1.0, h, y],
                        [x + 1.0, h, y + 1.0],
                        [x, h, y + 1.0],
                    ]);
                    colors.extend([[h as f32 / 5.0, 0.5, 0.2, 1.0]; 4]);
                    indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
                }
            }
        }
        Model {
            materials: vec![Material::default()],
            parts: vec![Part {
                names: vec!["ground".to_owned()],
                material: 0,
                positions,
                colors: Some(colors),
                uvs: None,
                indices,
            }],
            images: Vec::new(),
            skipped_primitives: 0,
        }
    }

    fn pack_with(model: &Model, options: Value, dir: &Path) -> Value {
        let options: Options = serde_json::from_value(options).unwrap();
        let built = build(model, &options, dir, &mut |_, _| {}).unwrap();
        let maps = json!([{ "id": "made-up:map:m1", "name": "Made up", "width": 10, "height": 10,
            "worldTransform": { "a": 1, "b": 0, "c": 0, "d": -1, "e": 0, "f": 10 }, "scene": built.scene }]);
        fs::write(dir.join("maps.json"), serde_json::to_string(&maps).unwrap()).unwrap();
        built.scene
    }

    fn world_triangles(model: &Model) -> Vec<[[i64; 3]; 3]> {
        let mut out: Vec<[[i64; 3]; 3]> = model
            .parts
            .iter()
            .flat_map(|part| {
                part.indices.as_chunks::<3>().0.iter().map(|t| {
                    let mut corners =
                        t.map(|i| part.positions[i as usize].map(|v| (v * 100.0).round() as i64));
                    // The same triangle whichever corner it starts at.
                    let first = (0..3).min_by_key(|&k| corners[k]).unwrap();
                    corners.rotate_left(first);
                    corners
                })
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_compressed_pack_unpacks_to_the_world_it_was_built_from() {
        let dir = temp("round-trip");
        let model = storeys(12);
        pack_with(
            &model,
            json!({ "folder": "scene/m1", "axes": ["+x", "+z", "+y"], "cellSize": 6, "compress": true }),
            &dir,
        );
        let (bytes, report) = unpack(&dir, "made-up:map:m1").unwrap();
        assert_eq!(report.cells, report.cells_in_scene);
        assert_eq!(report.levels.get("0"), Some(&report.cells));
        assert_eq!(report.triangles, model.triangles());
        let back = read_glb(&bytes).unwrap();
        // Every triangle in the world where it was, its corners the same way round.
        assert_eq!(world_triangles(&back), world_triangles(&model));
        // The colours came through (16-bit in the files).
        let colors = back.parts[0].colors.as_ref().unwrap();
        assert!(colors.iter().all(|c| (c[1] - 0.5).abs() < 1e-3));
        // Built again with the same axes, the model is the same world.
        let again = temp("round-trip-again");
        pack_with(
            &back,
            json!({ "folder": "scene/m1", "axes": ["+x", "+z", "+y"], "cellSize": 6, "compress": false }),
            &again,
        );
        let (bytes, _) = unpack(&again, "made-up:map:m1").unwrap();
        assert_eq!(
            world_triangles(&read_glb(&bytes).unwrap()),
            world_triangles(&model)
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&again);
    }

    #[test]
    fn a_missing_finest_level_falls_back_to_a_coarser_one() {
        let dir = temp("coarser");
        let scene = pack_with(
            &storeys(40),
            json!({ "folder": "scene/m1", "axes": ["+x", "+z", "+y"], "cellSize": 40, "compress": true }),
            &dir,
        );
        let lods = scene["cells"][0]["lods"].as_array().unwrap();
        assert!(lods.len() >= 2, "{lods:?}");
        fs::remove_file(dir.join(lods[0]["file"].as_str().unwrap())).unwrap();
        let (_, report) = unpack(&dir, "made-up:map:m1").unwrap();
        assert_eq!(report.levels.get("1"), Some(&1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn textures_come_through_once() {
        let dir = temp("textures");
        let mut model = storeys(12);
        let picture = {
            let mut bytes = Vec::new();
            let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(png::ColorType::Rgba);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&[200, 30, 30, 255].repeat(4))
                .unwrap();
            drop(writer);
            bytes
        };
        model.images = vec![picture.clone()];
        model.materials[0] = Material {
            name: "brick".to_owned(),
            textured: true,
            texture_color: Some([0.6, 0.0, 0.0]),
            texture: Some(TextureRef {
                image: 0,
                wrap: [WRAP_REPEAT, WRAP_CLAMP],
                tex_coord: 0,
            }),
            ..Material::default()
        };
        let count = model.parts[0].positions.len();
        model.parts[0].uvs = Some((0..count).map(|i| [(i % 2) as f32, 0.5]).collect());
        pack_with(
            &model,
            json!({ "folder": "scene/m1", "axes": ["+x", "+z", "+y"], "cellSize": 6,
                    "textures": { "mode": "keep" } }),
            &dir,
        );
        let (bytes, report) = unpack(&dir, "made-up:map:m1").unwrap();
        assert!(report.cells > 1);
        assert_eq!(
            (report.textures, report.textures_not_read, report.materials),
            (1, 0, 1)
        );
        let back = read_glb(&bytes).unwrap();
        assert_eq!(back.images, vec![picture]);
        let texture = back.materials[0].texture.unwrap();
        assert_eq!(texture.wrap, [WRAP_REPEAT, WRAP_CLAMP]);
        assert!(back.parts[0].uvs.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        let dir = temp("refuses");
        assert!(unpack(&dir, "x").unwrap_err().contains("maps.json"));
        fs::write(
            dir.join("maps.json"),
            json!([{ "id": "a", "name": "A" }, { "id": "b", "scene": { "cells": [
                { "id": "c", "bounds": [0, 0, 1, 1], "lods": [{ "level": 0, "file": "../escape.glb" }] },
            ] } }])
            .to_string(),
        )
        .unwrap();
        assert!(unpack(&dir, "a").unwrap_err().contains("no 3D model"));
        assert!(unpack(&dir, "z").unwrap_err().contains("no map"));
        let error = unpack(&dir, "b").unwrap_err();
        assert!(error.contains("no cell"), "{error}");
        // A bad stride is refused before the decoder sees it.
        assert!(decode_view(&[0; 16], 1, 6, "ATTRIBUTES", "NONE").is_err());
        assert!(decode_view(&[0; 16], 3, 3, "TRIANGLES", "NONE").is_err());
        assert!(decode_view(&[0; 16], 1, 4, "ATTRIBUTES", "OCTAHEDRAL").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
