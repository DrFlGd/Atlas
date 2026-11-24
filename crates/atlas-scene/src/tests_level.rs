//! Reading ActorX meshes and Atlas level files: made-up meshes written by
//! hand here, placed in a made-up level.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::formats::{read_model, ReadOptions};
use crate::{build_file, Options};

fn temp(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("atlas-scene level-{name}-ü-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn chunk(out: &mut Vec<u8>, name: &str, size: u32, count: u32, data: &[u8]) {
    let mut id = [0u8; 20];
    id[..name.len()].copy_from_slice(name.as_bytes());
    out.extend_from_slice(&id);
    out.extend_from_slice(&0x1e83b9u32.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(data);
}

/// A made-up ActorX mesh: a flat square 200 by 100 units (Z up) with two
/// materials, one triangle each, and a skipped chunk of bones.
fn psk() -> Vec<u8> {
    let mut out = Vec::new();
    chunk(&mut out, "ACTRHEAD", 0, 0, &[]);
    let points = [
        [0.0f32, 0.0, 0.0],
        [200.0, 0.0, 0.0],
        [200.0, 100.0, 0.0],
        [0.0, 100.0, 0.0],
    ];
    let mut data = Vec::new();
    for p in points {
        for v in p {
            data.extend_from_slice(&v.to_le_bytes());
        }
    }
    chunk(&mut out, "PNTS0000", 12, 4, &data);
    let mut data = Vec::new();
    for (i, uv) in [[0.0f32, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
        .iter()
        .enumerate()
    {
        data.extend_from_slice(&(i as u16).to_le_bytes());
        data.extend_from_slice(&[0, 0]);
        data.extend_from_slice(&uv[0].to_le_bytes());
        data.extend_from_slice(&uv[1].to_le_bytes());
        data.extend_from_slice(&[0, 0, 0, 0]);
    }
    chunk(&mut out, "VTXW0000", 16, 4, &data);
    let mut data = Vec::new();
    for (wedges, material) in [([0u16, 1, 2], 0u8), ([0, 2, 3], 1)] {
        for w in wedges {
            data.extend_from_slice(&w.to_le_bytes());
        }
        data.extend_from_slice(&[material, 0]);
        data.extend_from_slice(&1u32.to_le_bytes());
    }
    chunk(&mut out, "FACE0000", 12, 2, &data);
    let mut data = Vec::new();
    for name in ["MI_Made_Up_Stone", "MI_Made_Up_Moss"] {
        let mut raw = [0u8; 88];
        raw[..name.len()].copy_from_slice(name.as_bytes());
        data.extend_from_slice(&raw);
    }
    chunk(&mut out, "MATT0000", 88, 2, &data);
    chunk(&mut out, "REFSKELT", 120, 1, &[0u8; 120]);
    out
}

fn png_1x1(rgb: [u8; 3]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&rgb).unwrap();
    }
    bytes
}

/// An OBJ cube one metre wide, its base at 0, without a materials file.
fn write_cube(path: &Path) {
    let mut text = String::from("o Cube\n");
    for z in [0.0, 1.0] {
        for (x, y) in [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)] {
            text += &format!("v {x} {z} {y}\n");
        }
    }
    text += "vt 0 0\nvt 1 0\nvt 1 1\n";
    for f in [
        [1, 2, 3],
        [1, 3, 4],
        [5, 7, 6],
        [5, 8, 7],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 4, 8],
        [3, 8, 7],
        [4, 1, 5],
        [4, 5, 8],
    ] {
        text += &format!("f {}/1 {}/2 {}/3\n", f[0], f[1], f[2]);
    }
    fs::write(path, text).unwrap();
}

fn translate(x: f64, y: f64, z: f64) -> [f64; 16] {
    [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0,
    ]
}

#[test]
fn reads_actorx_meshes() {
    let dir = temp("psk");
    let path = dir.join("SM_Made Up Slab.pskx");
    fs::write(&path, psk()).unwrap();
    let (model, info) = read_model(&path, &ReadOptions::default()).unwrap();
    assert_eq!(info.format, "psk");
    assert_eq!(info.up, "+z");
    assert_eq!(info.triangles, 2);
    assert_eq!(model.parts.len(), 2, "a part per material");
    assert_eq!(model.materials[0].name, "MI_Made_Up_Stone");
    assert!(model.materials[0].double_sided);
    assert_eq!(info.max, [200.0, 100.0, 0.0]);
    assert!(
        model.parts.iter().all(|p| p.uvs.is_none()),
        "no pictures, so no texture coordinates"
    );

    let mut short = psk();
    short.truncate(100);
    let error = read_model(&path.with_file_name("short.psk"), &ReadOptions::default());
    assert!(error.is_err());
    fs::write(dir.join("short.psk"), short).unwrap();
    let error = read_model(&dir.join("short.psk"), &ReadOptions::default()).unwrap_err();
    assert!(error.contains("runs past the end"), "{error}");
    fs::write(dir.join("not.psk"), b"something else entirely, not ActorX").unwrap();
    let error = read_model(&dir.join("not.psk"), &ReadOptions::default()).unwrap_err();
    assert!(error.contains("not an ActorX"), "{error}");
    let error = read_model(&path, &ReadOptions { max_triangles: 1 }).unwrap_err();
    assert!(error.contains("million triangles"), "{error}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn places_each_mesh_of_a_level() {
    let dir = temp("level");
    let meshes = dir.join("Made Up Meshes ü");
    fs::create_dir_all(&meshes).unwrap();
    fs::write(meshes.join("SM_Slab.pskx"), psk()).unwrap();
    write_cube(&meshes.join("Cube.obj"));
    fs::write(meshes.join("T_Stone_D.png"), png_1x1([200, 100, 50])).unwrap();
    // The ActorX slab: Z-up centimetres turned into Y-up metres ((x, y, z) to (x, z, -y) / 100).
    let base = [
        0.01, 0.0, 0.0, 0.0, 0.0, 0.0, -0.01, 0.0, 0.0, 0.01, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    // A mirrored cube: x turned over.
    let mut mirrored = translate(-10.0, 0.0, 0.0);
    mirrored[0] = -1.0;
    let level = json!({
        "atlasLevel": 1,
        "meshes": [
            {"file": "Made Up Meshes ü/SM_Slab.pskx", "base": base,
             "materials": [{"texture": meshes.join("T_Stone_D.png")}, null]},
            {"file": "Made Up Meshes ü/Cube.obj"},
            {"file": "Made Up Meshes ü/Not There.glb"},
            {"file": "Made Up Meshes ü/Never Placed.glb"}
        ],
        "instances": [
            {"mesh": 0, "name": "Slab A"},
            {"mesh": 0, "name": "Slab B", "matrix": translate(0.0, 3.0, 0.0),
             "materials": [null, {"color": [0.0, 0.5, 0.0, 1.0]}]},
            {"mesh": 1, "name": "Crate", "matrix": translate(5.0, 0.0, -5.0)},
            {"mesh": 1, "name": "Mirrored crate", "matrix": mirrored},
            {"mesh": 2, "name": "Lost"}
        ]
    });
    let path = dir.join("level.atlaslevel");
    fs::write(&path, serde_json::to_string(&level).unwrap()).unwrap();
    let (model, info) = read_model(&path, &ReadOptions::default()).unwrap();
    assert_eq!(info.format, "level");
    assert_eq!(info.up, "+y");
    assert!(!info.sides_given);
    assert_eq!(info.missing_files, vec!["Not There.glb".to_owned()]);
    assert_eq!(info.triangles, 2 * 2 + 2 * 12);
    assert_eq!(info.textures_found, 1);
    assert!(info.has_colours);
    // The slab, 2 by 1 metres, flat at height 0 and lifted to 3.
    let slab: Vec<_> = model
        .parts
        .iter()
        .filter(|p| p.names[0] == "Slab A")
        .collect();
    assert_eq!(slab.len(), 2);
    let points: Vec<[f64; 3]> = slab.iter().flat_map(|p| p.positions.clone()).collect();
    assert!(points.iter().all(|p| p[1].abs() < 1e-9));
    assert!(points
        .iter()
        .any(|p| (p[0] - 2.0).abs() < 1e-9 && (p[2] + 1.0).abs() < 1e-9));
    let lifted = model.parts.iter().find(|p| p.names[0] == "Slab B").unwrap();
    assert!(lifted.positions.iter().all(|p| (p[1] - 3.0).abs() < 1e-9));
    // The stone material shows its picture, with the slab's texture coordinates; the moss of slab B is green.
    let stone = &model.materials[slab[0].material];
    assert!(stone.texture.is_some() && stone.double_sided);
    assert!(slab[0].uvs.is_some());
    assert!(slab[1].uvs.is_none(), "no picture, no texture coordinates");
    let moss = model
        .parts
        .iter()
        .filter(|p| p.names[0] == "Slab B")
        .map(|p| &model.materials[p.material])
        .find(|m| m.name == "MI_Made_Up_Moss")
        .unwrap();
    assert_eq!(moss.color, [0.0, 0.5, 0.0, 1.0]);
    // A mirrored instance has its triangles turned over, so they still face out.
    let normal_of = |name: &str| {
        let part = model.parts.iter().find(|p| p.names[0] == name).unwrap();
        // The cube's top: the triangle whose corners are all at height 1.
        let top = part
            .indices
            .as_chunks::<3>()
            .0
            .iter()
            .find(|t| {
                t.iter()
                    .all(|&i| (part.positions[i as usize][1] - 1.0).abs() < 1e-9)
            })
            .unwrap();
        let [a, b, c] = top.map(|i| part.positions[i as usize]);
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        u[2] * v[0] - u[0] * v[2]
    };
    assert!(normal_of("Crate") > 0.0, "the top faces up");
    assert!(
        normal_of("Mirrored crate") > 0.0,
        "and still does when mirrored"
    );

    // Built into a 3D map like any model.
    let pack = dir.join("pack");
    let mut options = Options::new("scene/model");
    options.textures = serde_json::from_value(json!({"mode": "keep"})).unwrap();
    let built = build_file(&path, &options, &pack, &mut |_, _| {}).unwrap();
    assert!(built.report.triangles > 0);

    // Too many triangles over all its instances: refused before they are placed.
    let error = read_model(&path, &ReadOptions { max_triangles: 20 }).unwrap_err();
    assert!(error.contains("million triangles"), "{error}");
    // Nothing that can be read.
    fs::write(
        &path,
        serde_json::to_string(
            &json!({"atlasLevel": 1, "meshes": [{"file": "gone.glb"}], "instances": [{"mesh": 0}]}),
        )
        .unwrap(),
    )
    .unwrap();
    let error = read_model(&path, &ReadOptions::default()).unwrap_err();
    assert!(error.contains("none of the meshes"), "{error}");
    fs::write(&path, "{\"atlasLevel\": 9}").unwrap();
    assert!(read_model(&path, &ReadOptions::default())
        .unwrap_err()
        .contains("version 9"));
    let _ = fs::remove_dir_all(&dir);
}
