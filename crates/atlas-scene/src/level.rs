//! Reading a whole game level, as the Map Maker's helper puts it together
//! from a level a person exported from their own game (an Unreal Engine
//! level exported with FModel, a Unity scene): an Atlas level file
//! (`.atlaslevel`, JSON) that names each mesh file once and places it as
//! often as the level does.
//!
//! ```json
//! {
//!   "atlasLevel": 1,
//!   "meshes": [
//!     { "file": "C:/Exports/Rocks/SM_Rock.glb",
//!       "base": [16 numbers, column-major],
//!       "materials": [ { "texture": "C:/Exports/T_Rock_D.png" }, null ] }
//!   ],
//!   "instances": [
//!     { "mesh": 0, "matrix": [16 numbers, column-major], "name": "Rock 23",
//!       "materials": [ null, { "color": [0.5, 0.5, 0.5, 1] } ] }
//!   ]
//! }
//! ```
//!
//! Each mesh file is any model file [`crate::formats`] reads (glTF, OBJ,
//! STL, PLY, ActorX), read once with its texture coordinates; relative paths
//! are taken from the level file's folder. `base` (identity when absent)
//! turns the mesh's own coordinates into the level's (an ActorX mesh's
//! Z-up centimetres into glTF's Y-up metres, say), and each instance's
//! `matrix` places it in the level, which is in glTF's axes: Y up, metres,
//! right-handed. A mirroring matrix turns its triangles over, so their
//! fronts stay fronts.
//!
//! `materials` give, by the index of a material in the mesh file (in the
//! order the file lists them), a picture to show (`texture`: a PNG, JPEG,
//! TGA or BMP file, read with the mesh's texture coordinates `TEXCOORD_0`)
//! and a colour (`color`, linear RGBA), on the mesh for every instance of it
//! or on one instance (a material the level sets in place of the mesh's
//! own); `null` keeps the material as the mesh file has it. Every material
//! is seen from both sides: exported game meshes do not reliably say which
//! side is their front.
//!
//! A mesh file that is missing or cannot be read is named in the model's
//! missing files or warnings, and its instances are left out; the level is
//! refused only when nothing of it can be read, or when all of its
//! instances together have more triangles than the most allowed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::formats::{ModelInfo, ReadOptions};
use crate::gltf::{Material, Model, Part, TextureRef, WRAP_REPEAT};

/// The level file's own version.
pub const VERSION: u32 = 1;

type Matrix = [f64; 16];

const IDENTITY: Matrix = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialChange {
    #[serde(default)]
    pub texture: Option<PathBuf>,
    #[serde(default)]
    pub color: Option<[f32; 4]>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelMesh {
    pub file: PathBuf,
    #[serde(default)]
    pub base: Option<Matrix>,
    #[serde(default)]
    pub materials: Vec<Option<MaterialChange>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub mesh: usize,
    #[serde(default)]
    pub matrix: Option<Matrix>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub materials: Vec<Option<MaterialChange>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub atlas_level: u32,
    #[serde(default)]
    pub meshes: Vec<LevelMesh>,
    #[serde(default)]
    pub instances: Vec<Instance>,
}

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

fn determinant(m: &Matrix) -> f64 {
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
        + m[8] * (m[1] * m[6] - m[5] * m[2])
}

fn apply(m: &Matrix, p: &[f64; 3]) -> [f64; 3] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// What one mesh file gave: its model, or why it could not be read.
type Read = Result<Model, String>;

/// Pictures by file, read once: their index in the model and average colour, or None when they cannot be read.
type Pictures = HashMap<PathBuf, Option<(usize, Option<[f32; 3]>)>>;

/// Reads an Atlas level file: every instance of every mesh, placed.
pub fn read_level(
    path: &Path,
    options: &ReadOptions,
    info: &mut ModelInfo,
) -> Result<Model, String> {
    let name = file_name(path);
    let bytes = std::fs::read(path).map_err(|e| format!("{name} cannot be read: {e}"))?;
    let level: Level =
        serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes))
            .map_err(|e| format!("{name} is not an Atlas level file: {e}"))?;
    if level.atlas_level == 0 || level.atlas_level > VERSION {
        return Err(format!(
            "{name} is an Atlas level file of version {}, which this builder does not read",
            level.atlas_level
        ));
    }
    let folder = path.parent().unwrap_or(Path::new("."));
    let max = options
        .max_triangles
        .min(crate::formats::LARGEST_MAX_TRIANGLES);

    // Each mesh that is placed at least once, read once.
    let mut placed = vec![0usize; level.meshes.len()];
    for instance in &level.instances {
        if let Some(count) = placed.get_mut(instance.mesh) {
            *count += 1;
        }
    }
    let mut reads: Vec<Option<Read>> = Vec::with_capacity(level.meshes.len());
    for (mesh, count) in level.meshes.iter().zip(&placed) {
        if *count == 0 {
            reads.push(None);
            continue;
        }
        let file = folder.join(&mesh.file);
        let read = if file.is_file() {
            let own = ReadOptions { max_triangles: max };
            crate::formats::read_mesh_file(&file, &own, true).map(|(model, mesh_info)| {
                for missing in mesh_info.missing_files {
                    if !info.missing_files.contains(&missing) {
                        info.missing_files.push(missing);
                    }
                }
                model
            })
        } else {
            Err(String::new())
        };
        match &read {
            Err(reason) if reason.is_empty() => {
                let missing = file_name(&file);
                if !info.missing_files.contains(&missing) {
                    info.missing_files.push(missing);
                }
            }
            Err(reason) => info
                .warnings
                .push(format!("{} could not be read: {reason}", file_name(&file))),
            Ok(_) => {}
        }
        reads.push(Some(read));
    }
    let total: usize = level
        .instances
        .iter()
        .filter_map(|i| match reads.get(i.mesh) {
            Some(Some(Ok(model))) => Some(model.triangles()),
            _ => None,
        })
        .fold(0usize, usize::saturating_add);
    if total > max {
        return Err(crate::gltf::too_many(max));
    }

    let mut model = Model::default();
    let mut pictures: Pictures = HashMap::new();
    // Each mesh's own pictures, by their index in the mesh, once in the level.
    let mut own_pictures: HashMap<(usize, usize), usize> = HashMap::new();
    // Materials by mesh, material and change, once in the level.
    let mut materials: HashMap<(usize, usize, String), usize> = HashMap::new();
    let mut missing_pictures: Vec<String> = Vec::new();

    for instance in &level.instances {
        let Some(Some(Ok(mesh_model))) = reads.get(instance.mesh) else {
            continue;
        };
        let mesh = &level.meshes[instance.mesh];
        let matrix = multiply(
            &instance.matrix.unwrap_or(IDENTITY),
            &mesh.base.unwrap_or(IDENTITY),
        );
        if matrix.iter().any(|v| !v.is_finite()) || determinant(&matrix).abs() < 1e-18 {
            info.warnings.push(format!(
                "{} is placed with a transform that flattens it, so it is left out",
                instance.name.as_deref().unwrap_or("A mesh")
            ));
            continue;
        }
        let flip = determinant(&matrix) < 0.0;
        for part in &mesh_model.parts {
            let own = part.material;
            let change = instance
                .materials
                .get(own)
                .cloned()
                .flatten()
                .or_else(|| mesh.materials.get(own).cloned().flatten());
            let key = (
                instance.mesh,
                own,
                change
                    .as_ref()
                    .map(|c| format!("{:?}|{:?}", c.texture, c.color))
                    .unwrap_or_default(),
            );
            let material = match materials.get(&key) {
                Some(&index) => index,
                None => {
                    let mut made = mesh_model.materials.get(own).cloned().unwrap_or_default();
                    made.double_sided = true;
                    if let Some(texture) = made.texture {
                        let index = *own_pictures
                            .entry((instance.mesh, texture.image))
                            .or_insert_with(|| {
                                model.images.push(mesh_model.images[texture.image].clone());
                                model.images.len() - 1
                            });
                        made.texture = Some(TextureRef {
                            image: index,
                            ..texture
                        });
                    }
                    if let Some(change) = &change {
                        apply_change(
                            &mut made,
                            change,
                            folder,
                            &mut model,
                            &mut pictures,
                            &mut missing_pictures,
                        );
                    }
                    model.materials.push(made);
                    materials.insert(key, model.materials.len() - 1);
                    model.materials.len() - 1
                }
            };
            let mut indices = part.indices.clone();
            if flip {
                for triangle in indices.as_chunks_mut::<3>().0 {
                    triangle.swap(1, 2);
                }
            }
            let mut names = Vec::with_capacity(part.names.len() + 1);
            if let Some(name) = &instance.name {
                names.push(name.clone());
            }
            names.extend(part.names.iter().cloned());
            let textured = model.materials[material].texture.is_some();
            model.parts.push(Part {
                names,
                material,
                positions: part.positions.iter().map(|p| apply(&matrix, p)).collect(),
                colors: part.colors.clone(),
                uvs: if textured { part.uvs.clone() } else { None },
                indices,
            });
        }
        model.skipped_primitives += mesh_model.skipped_primitives;
    }
    for missing in missing_pictures {
        if !info.missing_files.contains(&missing) {
            info.missing_files.push(missing);
        }
    }
    if model.parts.is_empty() {
        let reason = if level.instances.is_empty() {
            "it places no meshes".to_owned()
        } else {
            "none of the meshes it places could be read".to_owned()
        };
        return Err(format!(
            "{name} holds no triangles to make a map of: {reason}"
        ));
    }
    model.materials.push(Material {
        double_sided: true,
        ..Material::default()
    });
    Ok(model)
}

fn apply_change(
    material: &mut Material,
    change: &MaterialChange,
    folder: &Path,
    model: &mut Model,
    pictures: &mut Pictures,
    missing: &mut Vec<String>,
) {
    if let Some(color) = change.color {
        if color.iter().all(|v| v.is_finite()) {
            material.color = color.map(|v| v.clamp(0.0, 1.0));
        }
    }
    let Some(texture) = &change.texture else {
        return;
    };
    let path = folder.join(texture);
    let found = *pictures.entry(path.clone()).or_insert_with(|| {
        let bytes = std::fs::read(&path)
            .ok()
            .and_then(crate::formats::picture_bytes)?;
        let average = crate::textures::average_colour(&bytes);
        model.images.push(bytes);
        Some((model.images.len() - 1, average))
    });
    material.textured = true;
    match found {
        Some((image, Some(average))) => {
            material.texture_color = Some(average);
            material.texture = Some(TextureRef {
                image,
                wrap: [WRAP_REPEAT, WRAP_REPEAT],
                tex_coord: 0,
            });
        }
        _ => {
            let shown = file_name(&path);
            if !missing.contains(&shown) {
                missing.push(shown);
            }
        }
    }
}
