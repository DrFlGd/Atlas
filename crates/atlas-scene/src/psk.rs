//! Reading ActorX mesh files (`.psk`, `.pskx`), as Unreal Engine export
//! programs write a game's meshes: chunks of a 32-byte header (a 20-byte
//! name, a type flag, the size of one record and the number of records),
//! of which these are read:
//!
//! - `PNTS0000`: the points, three 32-bit floats each;
//! - `VTXW0000`: the wedges (a corner: its point, its texture coordinates
//!   and material), 16 bytes each; the point is a 16-bit number unless the
//!   file has more than 65,536 points;
//! - `FACE0000` (three 16-bit wedges, material, smoothing: 12 bytes) or
//!   `FACE3200` (three 32-bit wedges: 18 bytes);
//! - `MATT0000`: the materials, by name (64 bytes, then six numbers);
//! - `VERTEXCOLOR`: a colour per wedge (four bytes, sRGB).
//!
//! Every other chunk (bones, weights, more texture coordinates, normals,
//! morphs) is skipped. The points are as the file holds them: right-handed,
//! Z up, in Unreal units (centimetres); the materials say nothing of sides,
//! so they are seen from both sides, as OBJ's are. The pictures of the
//! materials are not in the file: a level reader that knows them gives them
//! (see [`crate::level`]).

use crate::gltf::{Material, Model, Part};

const HEADER: usize = 32;

struct Chunk<'a> {
    name: String,
    size: usize,
    count: usize,
    data: &'a [u8],
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn f32_at(b: &[u8], at: usize) -> f32 {
    f32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn chunks(bytes: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + HEADER <= bytes.len() {
        let raw = &bytes[at..at + 20];
        let end = raw.iter().position(|&b| b == 0).unwrap_or(20);
        let name = String::from_utf8_lossy(&raw[..end]).trim().to_owned();
        let size = u32_at(bytes, at + 24) as usize;
        let count = u32_at(bytes, at + 28) as usize;
        let length = size
            .checked_mul(count)
            .ok_or("a chunk of the file is impossibly large")?;
        let start = at + HEADER;
        let stop = start
            .checked_add(length)
            .filter(|stop| *stop <= bytes.len())
            .ok_or_else(|| format!("its {name} chunk runs past the end of the file"))?;
        out.push(Chunk {
            name,
            size,
            count,
            data: &bytes[start..stop],
        });
        at = stop;
    }
    Ok(out)
}

/// Whether the bytes look like an ActorX file: they start with its header chunk.
pub fn is_psk(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER && bytes.starts_with(b"ACTRHEAD")
}

/// Reads an ActorX mesh file; refuses one of more than `max` triangles.
pub fn read_psk(bytes: &[u8], max: usize) -> Result<Model, String> {
    if !is_psk(bytes) {
        return Err("it is not an ActorX mesh file (.psk or .pskx)".to_owned());
    }
    let chunks = chunks(bytes)?;
    let find = |names: &[&str]| chunks.iter().find(|c| names.contains(&c.name.as_str()));
    let points = find(&["PNTS0000"]).ok_or("it has no points (PNTS0000)")?;
    if points.size < 12 {
        return Err("its points are not three numbers each".to_owned());
    }
    let positions: Vec<[f64; 3]> = (0..points.count)
        .map(|i| {
            let at = i * points.size;
            [0, 4, 8].map(|k| f64::from(f32_at(points.data, at + k)))
        })
        .collect();
    let wedges = find(&["VTXW0000"]).ok_or("it has no corners (VTXW0000)")?;
    if wedges.size < 16 {
        return Err("its corners (VTXW0000) are too short".to_owned());
    }
    let wide_points = positions.len() > 65_536;
    let mut wedge_point = Vec::with_capacity(wedges.count);
    let mut wedge_uv = Vec::with_capacity(wedges.count);
    for i in 0..wedges.count {
        let at = i * wedges.size;
        let point = if wide_points {
            u32_at(wedges.data, at) as usize
        } else {
            usize::from(u16_at(wedges.data, at))
        };
        if point >= positions.len() {
            return Err("a corner names a point the file does not have".to_owned());
        }
        wedge_point.push(point);
        wedge_uv.push([f32_at(wedges.data, at + 4), f32_at(wedges.data, at + 8)]);
    }
    let colours = find(&["VERTEXCOLOR"])
        .filter(|c| c.size >= 4 && c.count == wedges.count)
        .map(|c| {
            (0..c.count)
                .map(|i| {
                    let b = &c.data[i * c.size..i * c.size + 4];
                    [
                        crate::formats::srgb_to_linear(f32::from(b[0]) / 255.0),
                        crate::formats::srgb_to_linear(f32::from(b[1]) / 255.0),
                        crate::formats::srgb_to_linear(f32::from(b[2]) / 255.0),
                        f32::from(b[3]) / 255.0,
                    ]
                })
                .collect::<Vec<[f32; 4]>>()
        });
    let (faces, wide) = match (find(&["FACE3200"]), find(&["FACE0000"])) {
        (Some(faces), _) => (faces, true),
        (None, Some(faces)) => (faces, false),
        (None, None) => return Err("it has no faces (FACE0000)".to_owned()),
    };
    if faces.size < if wide { 13 } else { 7 } {
        return Err("its faces are too short".to_owned());
    }
    if faces.count > max {
        return Err(crate::gltf::too_many(max));
    }
    let names: Vec<String> = find(&["MATT0000"])
        .map(|m| {
            (0..m.count)
                .map(|i| {
                    let raw = &m.data[i * m.size..i * m.size + m.size.min(64)];
                    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
                    String::from_utf8_lossy(&raw[..end]).trim().to_owned()
                })
                .collect()
        })
        .unwrap_or_default();
    // A part per material, with the wedges it uses as its vertices.
    let material_count = names.len().max(1);
    let mut parts: Vec<Part> = (0..material_count)
        .map(|m| Part {
            names: names.get(m).cloned().into_iter().collect(),
            material: m,
            ..Part::default()
        })
        .collect();
    let mut slot: Vec<Vec<u32>> = vec![Vec::new(); material_count];
    for i in 0..faces.count {
        let at = i * faces.size;
        let corners: [usize; 3] = if wide {
            [0, 4, 8].map(|k| u32_at(faces.data, at + k) as usize)
        } else {
            [0, 2, 4].map(|k| usize::from(u16_at(faces.data, at + k)))
        };
        let material = usize::from(faces.data[at + if wide { 12 } else { 6 }]);
        let material = if material < material_count {
            material
        } else {
            0
        };
        if corners.iter().any(|&w| w >= wedge_point.len()) {
            return Err("a face names a corner the file does not have".to_owned());
        }
        let part = &mut parts[material];
        let map = &mut slot[material];
        for wedge in corners {
            if map.is_empty() {
                *map = vec![u32::MAX; wedge_point.len()];
            }
            if map[wedge] == u32::MAX {
                map[wedge] = part.positions.len() as u32;
                part.positions.push(positions[wedge_point[wedge]]);
                part.uvs.get_or_insert_with(Vec::new).push(wedge_uv[wedge]);
                if let Some(colours) = &colours {
                    part.colors
                        .get_or_insert_with(Vec::new)
                        .push(colours[wedge]);
                }
            }
            part.indices.push(map[wedge]);
        }
    }
    parts.retain(|part| !part.indices.is_empty());
    let mut materials: Vec<Material> = (0..material_count)
        .map(|m| Material {
            name: names.get(m).cloned().unwrap_or_default(),
            color: [0.75, 0.75, 0.75, 1.0],
            double_sided: true,
            ..Material::default()
        })
        .collect();
    materials.push(Material {
        double_sided: true,
        ..Material::default()
    });
    Ok(Model {
        materials,
        parts,
        images: Vec::new(),
        skipped_primitives: 0,
    })
}
