//! Tests on made-up models only: a rolling ground of squares, boxes and
//! hand-written glTF files.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::*;
use crate::gltf::{read_glb, split_glb, Part};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("atlas-scene-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn quiet() -> impl FnMut(f64, &str) {
    |_, _| {}
}

/// A rolling ground of `n` by `n` squares of one unit, in glTF's own axes
/// (Y up, so a world point (x, y, h) is (x, h, -y)), with a colour by height.
fn ground(n: usize, names: &[&str]) -> Part {
    let mut positions = Vec::new();
    let mut colors = Vec::new();
    for j in 0..=n {
        for i in 0..=n {
            let (x, y) = (i as f64, j as f64);
            let h = 2.0 * (x / 7.0).sin() * (y / 9.0).cos() + 0.05 * x;
            positions.push([x, h, -y]);
            let t = ((h + 2.0) / 8.0) as f32;
            colors.push([0.2 + 0.5 * t, 0.4, 0.3, 1.0]);
        }
    }
    let mut indices = Vec::new();
    let at = |i: usize, j: usize| (j * (n + 1) + i) as u32;
    for j in 0..n {
        for i in 0..n {
            // Seen from +Y (above), counter-clockwise: up is +Y, so -Z is world +y.
            indices.extend([at(i, j), at(i + 1, j), at(i + 1, j + 1)]);
            indices.extend([at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
    }
    Part {
        names: names.iter().map(|s| s.to_string()).collect(),
        material: 0,
        positions,
        colors: Some(colors),
        indices,
    }
}

fn model(parts: Vec<Part>) -> Model {
    Model {
        materials: vec![Material::default()],
        parts,
        skipped_primitives: 0,
    }
}

fn options(value: Value) -> Options {
    serde_json::from_value(value).unwrap()
}

#[test]
fn patterns_match_names_in_any_case() {
    assert!(matches("invisible*", "InvisibleWall_01"));
    assert!(matches("*debug*", "a_DEBUG_box"));
    assert!(matches("h??01", "h0001"));
    assert!(!matches("h??01", "h00001"));
    assert!(matches("*", ""));
    assert!(!matches("wall", "walls"));
    assert!(matches("*a*b*c", "xxaybzzc"));
}

#[test]
fn builds_cells_with_levels_that_meet() {
    let dir = temp("cells");
    let built = build(
        &model(vec![ground(64, &["ground"])]),
        &options(json!({ "folder": "scene/test", "cellSize": 16, "compress": false })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    let scene = &built.scene;
    let cells = scene["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 16);
    assert_eq!(built.report.triangles_in, 64 * 64 * 2);
    assert_eq!(built.report.triangles, 64 * 64 * 2);
    assert!(built.report.levels.len() >= 2, "{:?}", built.report.levels);
    assert!(built.report.levels[1].triangles < built.report.levels[0].triangles / 2);
    assert!(check::check_scene(scene, Some(&dir), &mut HashSet::new()).is_empty());
    // The offset is the model's rounded centre; the bounds are world x, y.
    assert_eq!(scene["offset"], json!([32.0, 32.0, scene["offset"][2]]));
    assert_eq!(cells[0]["bounds"], json!([0.0, 0.0, 16.0, 16.0]));

    // Along the line x = 16 between cells c0-0 and c1-0, every level has the
    // vertices of the finest one, so no gap opens between them.
    let offset: Vec<f64> = scene["offset"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let edge = |file: &str| -> HashSet<(i64, i64)> {
        let model = read_glb(&fs::read(dir.join(file)).unwrap()).unwrap();
        model
            .parts
            .iter()
            .flat_map(|part| {
                part.indices
                    .iter()
                    .map(|&i| part.positions[i as usize])
                    .collect::<Vec<_>>()
            })
            .filter(|p| ((p[0] + offset[0]) - 16.0).abs() < 1e-4)
            .map(|p| {
                (
                    (-p[2] + offset[1]).round() as i64,
                    ((p[1] + offset[2]) * 1000.0).round() as i64,
                )
            })
            .collect()
    };
    let cell = |id: &str| cells.iter().find(|c| c["id"] == id).unwrap();
    for id in ["c0-0", "c1-0"] {
        let lods = cell(id)["lods"].as_array().unwrap();
        let finest = edge(lods[0]["file"].as_str().unwrap());
        assert_eq!(finest.len(), 17, "{id}");
        for lod in lods {
            assert_eq!(
                edge(lod["file"].as_str().unwrap()),
                finest,
                "{id} level {}",
                lod["level"]
            );
        }
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compressed_files_say_so_and_are_smaller() {
    let dir = temp("compress");
    let plain = build(
        &model(vec![ground(32, &[])]),
        &options(json!({ "folder": "scene/plain", "cellSize": 64, "compress": false })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    let packed = build(
        &model(vec![ground(32, &[])]),
        &options(json!({ "folder": "scene/packed", "cellSize": 64 })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    assert_eq!(plain.report.triangles, packed.report.triangles);
    assert!(
        packed.report.bytes * 2 < plain.report.bytes,
        "{} {}",
        packed.report.bytes,
        plain.report.bytes
    );
    let file = packed.scene["cells"][0]["lods"][0]["file"]
        .as_str()
        .unwrap();
    let bytes = fs::read(dir.join(file)).unwrap();
    let (json, bin) = split_glb(&bytes).unwrap();
    let required: Vec<&str> = json["extensionsRequired"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(required.contains(&"EXT_meshopt_compression"));
    let view = &json["bufferViews"][0]["extensions"]["EXT_meshopt_compression"];
    assert_eq!(view["mode"], "ATTRIBUTES");
    // Vertex codec version 0, as EXT_meshopt_compression reads it.
    let at = view["byteOffset"].as_u64().unwrap() as usize;
    assert_eq!(bin[at], 0xa0);
    // The reader refuses a compressed model, with a reason.
    let error = read_glb(&fs::read(dir.join(file)).unwrap()).unwrap_err();
    assert!(error.contains("compressed"), "{error}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn drops_parts_by_name() {
    let dir = temp("drop");
    let mut wall = ground(4, &["Area", "InvisibleWall_01"]);
    for p in &mut wall.positions {
        p[1] += 10.0;
    }
    let built = build(
        &model(vec![ground(8, &["Area", "floor"]), wall]),
        &options(json!({ "folder": "scene/drop", "drop": ["invisible*", "  "] })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    assert_eq!(built.report.parts_dropped, 1);
    assert_eq!(built.report.triangles_dropped, 32);
    assert_eq!(built.report.triangles, 128);
    let heights = built.scene["heights"].as_array().unwrap();
    assert!(
        heights[1].as_f64().unwrap() < 5.0,
        "the wall was not dropped"
    );
    // Everything dropped is refused.
    let error = build(
        &model(vec![ground(2, &["debug"])]),
        &options(json!({ "folder": "scene/none", "drop": ["DEBUG"] })),
        &dir,
        &mut quiet(),
    )
    .unwrap_err();
    assert!(error.contains("nothing is left"), "{error}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn lines_a_z_up_model_up_with_the_world() {
    // A game whose height is its Y axis and whose map's y is its Z axis, as
    // the Map Maker writes Dark Souls: world (x, y, h) = raw (x, z, y). Seen
    // from above (raw +Y), the square is counter-clockwise in the raw
    // model's own right-handed axes, so its normals point up.
    let dir = temp("axes");
    let square = Part {
        names: vec![],
        material: 0,
        positions: vec![
            [100.0, 5.0, 200.0],
            [110.0, 5.0, 200.0],
            [110.0, 5.0, 210.0],
            [100.0, 5.0, 210.0],
        ],
        colors: None,
        indices: vec![0, 2, 1, 0, 3, 2],
    };
    let built = build(
        &model(vec![square]),
        &options(json!({ "folder": "scene/axes", "axes": ["+x", "+z", "+y"], "compress": false })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    let scene = &built.scene;
    assert_eq!(scene["offset"], json!([105.0, 205.0, 5.0]));
    assert_eq!(scene["heights"], json!([5.0, 5.0]));
    let bounds: Vec<f64> = scene["cells"][0]["bounds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    assert_eq!(bounds[0], 100.0);
    assert_eq!(bounds[1], 200.0);
    assert!((bounds[2] - bounds[0] - (bounds[3] - bounds[1])).abs() < 1e-9);
    let file = scene["cells"][0]["lods"][0]["file"].as_str().unwrap();
    let bytes = fs::read(dir.join(file)).unwrap();
    let read = read_glb(&bytes).unwrap();
    // In the file (glTF axes around the offset): world (110, 210, 5) is (5, 0, -5).
    let points: Vec<[i64; 3]> = read.parts[0]
        .positions
        .iter()
        .map(|p| p.map(|v| v.round() as i64))
        .collect();
    assert!(points.contains(&[5, 0, -5]), "{points:?}");
    assert!(points.contains(&[-5, 0, 5]), "{points:?}");
    // The normals face up (+Y in the file), and the triangles turn the same way.
    let (json, bin) = split_glb(&bytes).unwrap();
    let normals = &json["bufferViews"][1];
    let at = normals["byteOffset"].as_u64().unwrap() as usize;
    for v in 0..4 {
        assert_eq!(bin[at + v * 4 + 1] as i8, 127);
    }
    let part = &read.parts[0];
    for t in part.indices.as_chunks::<3>().0 {
        let [a, b, c] = [0, 1, 2].map(|k| part.positions[t[k] as usize]);
        let up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
        assert!(up > 0.0, "a triangle faces down");
    }
    let _ = fs::remove_dir_all(&dir);
}

/// A glTF binary file of two nodes: one plain, one moved and mirrored.
fn hand_written_glb() -> Vec<u8> {
    let positions: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0];
    let colors: [u8; 12] = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255];
    let indices: [u16; 4] = [0, 1, 2, 0];
    let mut bin = Vec::new();
    for v in positions {
        bin.extend(v.to_le_bytes());
    }
    bin.extend(colors);
    for i in indices {
        bin.extend(i.to_le_bytes());
    }
    let document = json!({
        "asset": { "version": "2.0" },
        "scene": 0,
        "scenes": [{ "nodes": [0, 1] }],
        "nodes": [
            { "name": "Plain", "mesh": 0 },
            { "name": "Group", "children": [2] },
            { "name": "Mirrored", "mesh": 0, "translation": [10, 0, 0], "scale": [-1, 1, 1] },
        ],
        "meshes": [{ "name": "Triangle", "primitives": [{
            "attributes": { "POSITION": 0, "COLOR_0": 1 }, "indices": 2, "material": 0
        }] }],
        "materials": [{ "name": "Stone", "pbrMetallicRoughness": { "baseColorFactor": [0.5, 0.5, 0.5, 1] } }],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3" },
            { "bufferView": 1, "componentType": 5121, "normalized": true, "count": 3, "type": "VEC4" },
            { "bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR" },
        ],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": 36 },
            { "buffer": 0, "byteOffset": 36, "byteLength": 12 },
            { "buffer": 0, "byteOffset": 48, "byteLength": 8 },
        ],
        "buffers": [{ "byteLength": bin.len() }],
    });
    let mut json_bytes = serde_json::to_vec(&document).unwrap();
    while !json_bytes.len().is_multiple_of(4) {
        json_bytes.push(b' ');
    }
    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((json_bytes.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json_bytes);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

#[test]
fn reads_nodes_names_colours_and_mirrors() {
    let model = read_glb(&hand_written_glb()).unwrap();
    assert_eq!(model.parts.len(), 2);
    assert_eq!(model.materials.len(), 2);
    assert_eq!(model.materials[0].color, [0.5, 0.5, 0.5, 1.0]);
    let plain = &model.parts[0];
    assert_eq!(plain.names, vec!["Plain", "Triangle", "Stone"]);
    assert_eq!(plain.indices, vec![0, 1, 2]);
    assert_eq!(plain.colors.as_ref().unwrap()[1], [0.0, 1.0, 0.0, 1.0]);
    let mirrored = &model.parts[1];
    assert_eq!(
        mirrored.names,
        vec!["Group", "Mirrored", "Triangle", "Stone"]
    );
    assert_eq!(mirrored.positions[1], [9.0, 0.0, 0.0]);
    // Mirrored, so its corners are put the other way round.
    assert_eq!(mirrored.indices, vec![0, 2, 1]);
    assert!(read_glb(b"not a model at all").is_err());
}

#[test]
fn draws_each_floor_from_above_into_tiles() {
    let dir = temp("render");
    let mut upper = ground(16, &["upper"]);
    for p in &mut upper.positions {
        p[1] = 10.0;
        p[0] += 8.0;
    }
    let built = build(
        &model(vec![ground(48, &["lower"]), upper]),
        &options(json!({
            "folder": "scene/floors",
            "render": {
                "folder": "tiles/floors",
                "pixelsPerUnit": 8,
                "margin": 2,
                "floors": [
                    { "id": "f0", "heights": [-5, 6] },
                    { "id": "f1", "heights": [6, 12] },
                ],
            },
        })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    let rendered = built.rendered.unwrap();
    assert_eq!(rendered.layers.len(), 2);
    assert_eq!(rendered.width, (52 * 8) as u32);
    assert_eq!(rendered.layers[0].max_zoom, 1);
    assert_eq!(rendered.layers[0].url, "tiles/floors/f0/{z}/{x}/{y}.png");
    assert_eq!(rendered.layers[0].files, 4 + 1);
    let t = rendered.world_transform;
    assert_eq!((t.a, t.d, t.e, t.f), (0.125, -0.125, -2.0, 50.0));
    // The upper floor's picture shows the roof where the lower one shows ground.
    let read_tile = |floor: &str| -> Vec<u8> {
        let file = fs::File::open(dir.join(format!("tiles/floors/{floor}/1/0/0.png"))).unwrap();
        let mut reader = png::Decoder::new(std::io::BufReader::new(file))
            .read_info()
            .unwrap();
        let mut data = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut data).unwrap();
        data
    };
    let (lower, roof) = (read_tile("f0"), read_tile("f1"));
    // World (12, 46) is in the roof: pixel ((12 + 2) * 8, (50 - 46) * 8).
    let at = ((4 * 8 * 256) + 14 * 8) * 3;
    assert_ne!(&lower[at..at + 3], &roof[at..at + 3]);
    // Outside the model, the background.
    assert_eq!(&lower[0..3], &[0x16, 0x1a, 0x20]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn checks_find_what_is_wrong() {
    let mut files = HashSet::new();
    let scene = json!({
        "axes": ["+x", "+x", "+y"],
        "extra": 1,
        "cells": [
            { "id": "a", "bounds": [0, 0, 10, 20], "lods": [{ "level": 0, "file": "scene/a.glb", "triangles": 5 }, { "level": 1, "file": "scene/b.glb", "triangles": 9 }] },
            { "id": "a", "bounds": [0, 0, 10, 10], "lods": [{ "level": 1, "file": "scene/a.glb" }, { "level": 0, "file": "scene/C.glb" }] },
        ],
    });
    let problems = check::check_scene(&scene, None, &mut files).join("\n");
    for expected in [
        "axes must name",
        "not in the format: extra",
        "not a square",
        "two cells have this id",
        "more triangles",
        "named twice",
        "finest first",
        "scene/C.glb is not a model file name",
    ] {
        assert!(problems.contains(expected), "{expected} in {problems}");
    }
    let dir = temp("check");
    fs::write(dir.join("maps.json"), r#"[{"id":"m","scene":{"cells":[{"id":"c","bounds":[0,0,1,1],"lods":[{"level":0,"file":"scene/c.glb"}]}]}}]"#).unwrap();
    fs::write(dir.join("layers.json"), r#"[{"id":"l","heights":[3,1]}]"#).unwrap();
    fs::write(
        dir.join("locations.json"),
        r#"[{"id":"p","height":"high"},{"id":"q","height":2}]"#,
    )
    .unwrap();
    let checked = check::check_pack(&dir);
    let all = checked.problems.join("\n");
    assert!(all.contains("worldTransform"), "{all}");
    assert!(all.contains("scene/c.glb is missing"), "{all}");
    assert!(
        all.contains("layer l: heights: its min is above its max"),
        "{all}"
    );
    assert!(all.contains("location p: height must be a number"), "{all}");
    assert_eq!((checked.scenes, checked.floors, checked.heights), (1, 1, 2));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn textures_are_left_out_with_a_warning() {
    let dir = temp("textures");
    let mut model = model(vec![ground(4, &[])]);
    model.materials[0].textured = true;
    let built = build(&model, &Options::new("scene/t"), &dir, &mut quiet()).unwrap();
    assert_eq!(built.report.textures_left_out, 1);
    assert!(built.report.warnings[0].contains("later version"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn refuses_bad_options() {
    let dir = temp("bad");
    let m = model(vec![ground(2, &[])]);
    for (value, expected) in [
        (json!({ "folder": "tiles/x" }), "must be scene/"),
        (json!({ "folder": "scene" }), "must be scene/"),
        (json!({ "folder": "scene/A" }), "must be scene/"),
        (
            json!({ "folder": "scene/x", "axes": ["+x", "+x", "+y"] }),
            "each of x, y and z",
        ),
        (json!({ "folder": "scene/x", "scale": 0 }), "scale"),
        (
            json!({ "folder": "scene/x", "levels": [{ "ratio": 1.5, "error": 0 }] }),
            "ratio",
        ),
    ] {
        let error = build(&m, &options(value), &dir, &mut quiet()).unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
    assert!(
        serde_json::from_value::<Options>(json!({ "folder": "scene/x", "colour": 1 })).is_err()
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_large_model_gets_cells_of_about_the_wanted_size() {
    let dir = temp("auto");
    let built = build(
        &model(vec![ground(100, &[])]),
        &options(json!({ "folder": "scene/auto", "cellTriangles": 5000 })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    // 20,000 triangles at about 5,000 a cell: 2 by 2 cells of 50.
    assert_eq!(built.report.cell_size, 50.0);
    let ids: HashMap<String, usize> = built.scene["cells"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].as_str().unwrap().to_owned(),
                c["lods"].as_array().unwrap().len(),
            )
        })
        .collect();
    assert!(ids.len() >= 4, "{ids:?}");
    let _ = fs::remove_dir_all(Path::new(&dir));
}

/// A made-up PNG of `width` by `height` pixels of `colours` (RGBA), row by row.
fn png_of(width: u32, height: u32, colours: &[[u8; 4]]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&colours.concat()).unwrap();
    }
    bytes
}

/// A made-up model of one triangle whose material's colour is in a texture.
fn textured_glb(picture: &[u8]) -> Vec<u8> {
    let positions: [f32; 9] = [0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 0.0, 0.0, -4.0];
    let indices: [u16; 4] = [0, 1, 2, 0];
    let mut bin = Vec::new();
    for v in positions {
        bin.extend(v.to_le_bytes());
    }
    for i in indices {
        bin.extend(i.to_le_bytes());
    }
    let image_at = bin.len();
    bin.extend(picture);
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let document = json!({
        "asset": { "version": "2.0" },
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "name": "Floor", "mesh": 0 }],
        "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 }, "indices": 1, "material": 0 }] }],
        "materials": [{ "name": "Tiles", "pbrMetallicRoughness": {
            "baseColorTexture": { "index": 0 }, "baseColorFactor": [1, 1, 0.5, 1] } }],
        "textures": [{ "source": 0 }],
        "images": [{ "bufferView": 2, "mimeType": "image/png" }],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3" },
            { "bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR" },
        ],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": 36 },
            { "buffer": 0, "byteOffset": 36, "byteLength": 6 },
            { "buffer": 0, "byteOffset": image_at, "byteLength": picture.len() },
        ],
        "buffers": [{ "byteLength": bin.len() }],
    });
    let mut json_bytes = serde_json::to_vec(&document).unwrap();
    while !json_bytes.len().is_multiple_of(4) {
        json_bytes.push(b' ');
    }
    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((json_bytes.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json_bytes);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

#[test]
fn keeps_a_textures_average_colour_when_asked() {
    // Half white, half black: the average is half the light, in linear terms.
    let picture = png_of(2, 1, &[[255, 255, 255, 255], [0, 0, 0, 255]]);
    let average = textures::average_colour(&picture).unwrap();
    assert!(
        average.iter().all(|v| (v - 0.5).abs() < 1e-3),
        "{average:?}"
    );
    // A transparent pixel counts for nothing.
    let clear = png_of(2, 1, &[[255, 0, 0, 255], [0, 0, 255, 0]]);
    assert_eq!(textures::average_colour(&clear).unwrap(), [1.0, 0.0, 0.0]);
    assert_eq!(textures::average_colour(b"not a picture"), None);

    let model = read_glb(&textured_glb(&picture)).unwrap();
    assert!(model.materials[0].textured);
    let kept = model.materials[0].texture_color.unwrap();
    assert!((kept[0] - 0.5).abs() < 1e-3);

    let dir = temp("textures");
    let colour_of = |built: &Built| -> Vec<f64> {
        let file = built.scene["cells"][0]["lods"][0]["file"].as_str().unwrap();
        let bytes = fs::read(dir.join(file)).unwrap();
        let (json, _) = split_glb(&bytes).unwrap();
        json["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    // Left out: the material's own colour.
    let plain = build(
        &model,
        &options(json!({ "folder": "scene/plain" })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    assert_eq!(colour_of(&plain)[..3], [1.0, 1.0, 0.5]);
    assert!(plain.report.warnings[0].contains("keep their colour only"));
    // Averaged: times the texture's average colour.
    let averaged = build(
        &model,
        &options(json!({ "folder": "scene/averaged", "textures": { "mode": "average" } })),
        &dir,
        &mut quiet(),
    )
    .unwrap();
    let colour = colour_of(&averaged);
    assert!(
        (colour[0] - 0.5).abs() < 1e-3 && (colour[2] - 0.25).abs() < 1e-3,
        "{colour:?}"
    );
    assert!(averaged.report.warnings[0].contains("average colour"));
}

/// A made-up JPEG: 8 by 8 pixels of one orange (200, 100, 50), as hex.
const ORANGE_JPEG: &[&str] = &[
    "ffd8ffe000104a46494600010100000100010000ffdb0043000201010101010201010102020202020403020202020504",
    "040304060506060605060606070908060709070606080b08090a0a0a0a0a06080b0c0b0a0c090a0a0affdb0043010202",
    "02020202050303050a0706070a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
    "0a0a0a0a0a0a0a0a0a0a0a0a0a0affc00011080008000803012200021101031101ffc4001f0000010501010101010100",
    "000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d010203000411051221",
    "31410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a",
    "434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a9293949596979899",
    "9aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1",
    "f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100",
    "020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f015",
    "6272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a63646566676869",
    "6a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4",
    "c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00cf",
    "a28a2bf95cfed83fffd9",
];

#[test]
fn reads_a_jpeg_textures_average_colour() {
    let hex: String = ORANGE_JPEG.concat();
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    let average = textures::average_colour(&bytes).unwrap();
    // sRGB 200, 100 and 50, in linear terms, within what JPEG keeps.
    for (got, srgb) in average.iter().zip([200.0f32, 100.0, 50.0]) {
        let want = ((srgb / 255.0 + 0.055) / 1.055).powf(2.4);
        assert!((got - want).abs() < 0.02, "{average:?}");
    }
}
