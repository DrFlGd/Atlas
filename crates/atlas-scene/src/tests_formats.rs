//! Reading model files: a made-up two-storey box building written as each
//! format by hand here, and broken files.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::draw::{draw_floors, preview, write_triangles, Colouring, Frame};
use crate::formats::{read_model, ReadOptions};
use crate::{build_file, Options, Transform};

fn temp(name: &str) -> PathBuf {
    // A space and letters beyond ASCII, as a person's folders have.
    let dir = std::env::temp_dir().join(format!(
        "atlas-scene formats-{name}-ü-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A box building 10 by 8 metres in Z-up metres: its ground floor at 0,
/// an upper floor at 3, a flat roof at 6 and four outer walls, each
/// floor's quad facing up, as two triangles each.
fn building() -> Vec<[[f64; 3]; 3]> {
    let mut quads: Vec<[[f64; 3]; 4]> = Vec::new();
    for h in [0.0, 3.0, 6.0] {
        quads.push([[0.0, 0.0, h], [10.0, 0.0, h], [10.0, 8.0, h], [0.0, 8.0, h]]);
    }
    let corners = [[0.0, 0.0], [10.0, 0.0], [10.0, 8.0], [0.0, 8.0]];
    for i in 0..4 {
        let a = corners[i];
        let b = corners[(i + 1) % 4];
        quads.push([
            [a[0], a[1], 0.0],
            [b[0], b[1], 0.0],
            [b[0], b[1], 6.0],
            [a[0], a[1], 6.0],
        ]);
    }
    quads
        .iter()
        .flat_map(|q| [[q[0], q[1], q[2]], [q[0], q[2], q[3]]])
        .collect()
}

fn png_2x2() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&[
                200, 40, 40, 255, 40, 200, 40, 255, 40, 40, 200, 255, 200, 200, 40, 255,
            ])
            .unwrap();
    }
    bytes
}

fn write_obj(dir: &Path, name: &str, with_texture: bool) -> PathBuf {
    let mut text = String::from("# made-up building\nmtllib building materials.mtl\no Building\n");
    let triangles = building();
    for t in &triangles {
        for p in t {
            // Y up, as OBJ files usually are: (x, height, -north).
            text += &format!("v {} {} {}\n", p[0], p[2], -p[1]);
        }
    }
    text += "vt 0 0\nvt 1 0\nvt 1 1\n";
    text += "usemtl Brick\n";
    for i in 0..triangles.len() {
        let base = i * 3 + 1;
        text += &format!("f {}/1 {}/2 {}/3\n", base, base + 1, base + 2);
    }
    fs::write(dir.join(name), text).unwrap();
    let mut mtl = String::from("newmtl Brick\nKd 0.8 0.5 0.4\n");
    if with_texture {
        // A path on the computer it was made on: found by its name next to the model.
        mtl += "map_Kd C:\\Users\\someone\\textures\\brick wall.png\n";
        fs::write(dir.join("brick wall.png"), png_2x2()).unwrap();
    }
    fs::write(dir.join("building materials.mtl"), mtl).unwrap();
    dir.join(name)
}

fn write_stl_binary(path: &Path) {
    let triangles = building();
    let mut bytes = vec![0u8; 80];
    bytes.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    for t in &triangles {
        bytes.extend_from_slice(&[0u8; 12]);
        for p in t {
            for v in p {
                bytes.extend_from_slice(&(*v as f32).to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0, 0]);
    }
    fs::write(path, bytes).unwrap();
}

fn write_stl_text(path: &Path) {
    let mut text = String::from("solid building\n");
    for t in building() {
        text += "  facet normal 0 0 1\n    outer loop\n";
        for p in t {
            text += &format!("      vertex {} {} {}\n", p[0], p[1], p[2]);
        }
        text += "    endloop\n  endfacet\n";
    }
    text += "endsolid building\n";
    fs::write(path, text).unwrap();
}

fn write_ply(path: &Path, binary: bool) {
    let triangles = building();
    let mut header = format!(
        "ply\nformat {} 1.0\ncomment made up\nelement vertex {}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face {}\nproperty list uchar int vertex_indices\nend_header\n",
        if binary { "binary_little_endian" } else { "ascii" },
        triangles.len() * 3,
        triangles.len()
    );
    let mut bytes = Vec::new();
    if binary {
        bytes.extend_from_slice(header.as_bytes());
        for t in &triangles {
            for p in t {
                for v in p {
                    bytes.extend_from_slice(&(*v as f32).to_le_bytes());
                }
                bytes.extend_from_slice(&[180, 120, 90]);
            }
        }
        for i in 0..triangles.len() as i32 {
            bytes.push(3);
            for k in 0..3 {
                bytes.extend_from_slice(&(i * 3 + k).to_le_bytes());
            }
        }
    } else {
        for t in &triangles {
            for p in t {
                header += &format!("{} {} {} 180 120 90\n", p[0], p[1], p[2]);
            }
        }
        for i in 0..triangles.len() {
            header += &format!("3 {} {} {}\n", i * 3, i * 3 + 1, i * 3 + 2);
        }
        bytes = header.into_bytes();
    }
    fs::write(path, bytes).unwrap();
}

/// A `.gltf` file with its buffer and picture in files next to it (names with spaces, as `%20`).
fn write_gltf(dir: &Path) -> PathBuf {
    let triangles = building();
    let mut bin = Vec::new();
    for t in &triangles {
        for p in t {
            // glTF: Y up, -Z north.
            for v in [p[0], p[2], -p[1]] {
                bin.extend_from_slice(&(v as f32).to_le_bytes());
            }
        }
    }
    let uv_offset = bin.len();
    for _ in &triangles {
        for uv in [[0.0f32, 0.0], [1.0, 0.0], [1.0, 1.0]] {
            for v in uv {
                bin.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    let count = triangles.len() * 3;
    let gltf = json!({
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "Building", "mesh": 0, "translation": [100.0, 0.0, 0.0]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "material": 0}]}],
        "materials": [{"name": "Brick", "doubleSided": false, "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
        "textures": [{"source": 0}],
        "images": [{"uri": "brick%20wall.png"}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": count, "type": "VEC3"},
            {"bufferView": 1, "componentType": 5126, "count": count, "type": "VEC2"}
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": uv_offset},
            {"buffer": 0, "byteOffset": uv_offset, "byteLength": bin.len() - uv_offset}
        ],
        "buffers": [{"uri": "building%20data.bin", "byteLength": bin.len()}]
    });
    fs::write(dir.join("building data.bin"), bin).unwrap();
    fs::write(dir.join("brick wall.png"), png_2x2()).unwrap();
    let path = dir.join("building.gltf");
    fs::write(&path, serde_json::to_string(&gltf).unwrap()).unwrap();
    path
}

fn read(path: &Path) -> Result<(crate::gltf::Model, crate::formats::ModelInfo), String> {
    read_model(path, &ReadOptions::default())
}

#[test]
fn reads_every_format_the_same() {
    let dir = temp("same");
    let count = building().len();
    let obj = write_obj(&dir, "building.obj", true);
    let stl = dir.join("building.stl");
    write_stl_binary(&stl);
    let stl_text = dir.join("building text.STL");
    write_stl_text(&stl_text);
    let ply = dir.join("building.ply");
    write_ply(&ply, false);
    let ply_binary = dir.join("building binary.ply");
    write_ply(&ply_binary, true);
    let gltf = write_gltf(&dir);

    let (model, info) = read(&obj).unwrap();
    assert_eq!(info.triangles, count);
    assert_eq!(info.format, "obj");
    assert_eq!(info.up, "+y");
    assert!(!info.sides_given);
    assert_eq!(info.textures_found, 1, "{info:?}");
    assert!(info.missing_files.is_empty(), "{info:?}");
    assert!(model.materials.iter().all(|m| m.double_sided));
    assert_eq!(info.max[1], 6.0, "Y up: the roof is 6 up");
    assert!(model.parts[0].uvs.is_some());

    for (path, format) in [(&stl, "STL (binary)"), (&stl_text, "STL (text)")] {
        let (_, info) = read(path).unwrap();
        assert_eq!(info.triangles, count);
        assert_eq!(info.format_name, format);
        assert_eq!(info.up, "+z");
        assert_eq!(info.max, [10.0, 8.0, 6.0]);
        assert!(!info.has_colours);
    }
    for path in [&ply, &ply_binary] {
        let (model, info) = read(path).unwrap();
        assert_eq!(info.triangles, count);
        assert_eq!(info.up, "+z");
        assert!(info.has_colours, "vertex colours");
        let colour = model.parts[0].colors.as_ref().unwrap()[0];
        assert!((colour[0] - crate::formats::srgb_to_linear(180.0 / 255.0)).abs() < 1e-5);
    }
    let (model, info) = read(&gltf).unwrap();
    assert_eq!(info.triangles, count);
    assert_eq!(info.format_name, "glTF");
    assert!(info.sides_given);
    assert_eq!(info.textures_found, 1);
    assert_eq!(info.min[0], 100.0, "the node's translation is applied");
    assert!(!model.materials[0].double_sided);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn says_what_is_missing_and_refuses_what_it_cannot_read() {
    let dir = temp("missing");
    let obj = write_obj(&dir, "building.obj", true);
    fs::remove_file(dir.join("brick wall.png")).unwrap();
    let (_, info) = read(&obj).unwrap();
    assert_eq!(info.missing_files, vec!["brick wall.png".to_owned()]);
    assert_eq!(info.textures_found, 0);
    fs::remove_file(dir.join("building materials.mtl")).unwrap();
    let (_, info) = read(&obj).unwrap();
    assert_eq!(
        info.missing_files,
        vec!["building materials.mtl".to_owned()]
    );

    let gltf = write_gltf(&dir);
    fs::remove_file(dir.join("building data.bin")).unwrap();
    let error = read(&gltf).unwrap_err();
    assert!(error.contains("building data.bin is missing"), "{error}");

    for (name, bytes, wanted) in [
        ("model.fbx", b"Kaydara FBX Binary".to_vec(), "Export the model as glTF"),
        ("model.dae", b"<COLLADA/>".to_vec(), "Export the model as glTF"),
        ("notes.txt", b"hello".to_vec(), "not a 3D model file"),
        ("empty.obj", Vec::new(), "is empty"),
        ("short.stl", b"\0\0\0\0".to_vec(), "too short"),
        ("bad.ply", b"ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nend_header\n1 2 3\n".to_vec(), "no x, y and z"),
        (
            "lying.ply",
            b"ply\nformat binary_little_endian 1.0\nelement vertex 4000000000\nproperty float x\nproperty float y\nproperty float z\nend_header\n\0\0\0\0".to_vec(),
            "ends before",
        ),
        ("bad.glb", b"glTF\x02\0\0\0\xff\xff\xff\xff".to_vec(), "not a glTF binary"),
        ("text.gltf", b"{not json".to_vec(), "not a glTF file"),
        ("points.ply", b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n".to_vec(), "no faces"),
    ] {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        let error = read(&path).unwrap_err();
        assert!(error.contains(wanted), "{name}: {error}");
    }
    // A model of more triangles than allowed is refused, with what to do.
    let stl = dir.join("building.stl");
    write_stl_binary(&stl);
    let error = read_model(&stl, &ReadOptions { max_triangles: 10 }).unwrap_err();
    assert!(error.contains("Allow very large models"), "{error}");
    let obj = write_obj(&dir, "again.obj", false);
    assert!(read_model(&obj, &ReadOptions { max_triangles: 10 }).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn builds_a_map_from_an_obj_with_its_texture_kept() {
    let dir = temp("build");
    let obj = write_obj(&dir, "building.obj", true);
    let pack = dir.join("pack");
    let options: Options = serde_json::from_value(json!({
        "folder": "scene/model",
        "axes": ["+x", "-z", "+y"],
        "textures": {"mode": "keep"},
        "maxTriangles": 1000,
    }))
    .unwrap();
    let built = build_file(&obj, &options, &pack, &mut |_, _| {}).unwrap();
    assert_eq!(built.report.textures_kept, 1);
    assert!(built.report.texture_bytes > 0);
    let heights = built.scene["heights"].as_array().unwrap();
    assert_eq!(heights[0], 0.0);
    assert_eq!(heights[1], 6.0);
    // The OBJ's material is seen from both sides, unless asked otherwise.
    let file = built.scene["cells"][0]["lods"][0]["file"].as_str().unwrap();
    let (json, _) = crate::gltf::split_glb(&fs::read(pack.join(file)).unwrap()).unwrap();
    assert_eq!(json["materials"][0]["doubleSided"], true);
    let one_sided: Options = serde_json::from_value(json!({
        "folder": "scene/one",
        "axes": ["+x", "-z", "+y"],
        "doubleSided": false,
    }))
    .unwrap();
    let built = build_file(&obj, &one_sided, &pack, &mut |_, _| {}).unwrap();
    let file = built.scene["cells"][0]["lods"][0]["file"].as_str().unwrap();
    let (json, _) = crate::gltf::split_glb(&fs::read(pack.join(file)).unwrap()).unwrap();
    assert!(json["materials"][0].get("doubleSided").is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn writes_triangles_and_draws_floors_from_above() {
    let dir = temp("draw");
    let obj = write_obj(&dir, "building.obj", true);
    let (model, _) = read(&obj).unwrap();
    let axes = ["+x".to_owned(), "-z".to_owned(), "+y".to_owned()];
    // Half size.
    let transform = Transform::from_parts(Some(&axes), Some(0.5), None).unwrap();
    let out = dir.join("triangles.bin");
    let (count, min, max) = write_triangles(&model, &transform, &out).unwrap();
    assert_eq!(count, building().len());
    assert_eq!(min, [0.0, 0.0, 0.0]);
    assert_eq!(max, [5.0, 4.0, 3.0]);
    let bytes = fs::read(&out).unwrap();
    assert_eq!(bytes.len(), count * 36);
    // The first triangle is the ground floor: east, height, north.
    let first: Vec<f32> = bytes[..36]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    assert_eq!(first, vec![0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 5.0, 0.0, 4.0]);

    // The ground floor on floor 0, the upper floor and roof on floor 1, walls on none.
    let floors: Vec<i16> = (0..count)
        .map(|t| match t / 2 {
            0 => 0,
            1 | 2 => 1,
            _ => -1,
        })
        .collect();
    let frame = Frame {
        x_min: -1.0,
        z_max: 5.0,
        scale: 4.0,
        width: 28,
        height: 24,
    };
    for colouring in [Colouring::Textures, Colouring::Plain] {
        let folder = dir.join(format!("drawn-{colouring:?}"));
        let files =
            draw_floors(&model, &transform, &frame, &floors, 2, colouring, &folder).unwrap();
        assert_eq!(files, vec!["floor-0.png", "floor-1.png"]);
        let picture = image::open(folder.join("floor-0.png"))
            .unwrap()
            .into_rgba8();
        assert_eq!(picture.dimensions(), (28, 24));
        // Inside the building: drawn; outside: clear.
        assert_eq!(picture.get_pixel(10, 10).0[3], 255);
        assert_eq!(picture.get_pixel(1, 1).0[3], 0);
        let inside = picture.get_pixel(10, 10).0;
        if colouring == Colouring::Plain {
            let again = picture.get_pixel(15, 15).0;
            assert_eq!(inside, again, "one colour");
        }
    }
    assert!(draw_floors(
        &model,
        &transform,
        &frame,
        &floors[1..],
        2,
        Colouring::Plain,
        &dir
    )
    .is_err());

    let small = preview(&model, 4);
    assert_eq!(small.triangles, 4);
    assert!(small.simplified || small.triangles <= 4);
    let whole = preview(&model, 1000);
    assert_eq!(whole.triangles, count);
    assert_eq!(whole.max, [10.0, 6.0, 0.0]);
    assert_eq!(
        crate::formats::base64_decode(&whole.positions)
            .unwrap()
            .len(),
        count * 18
    );
    assert_eq!(
        crate::formats::base64_decode(&whole.colours).unwrap().len(),
        count * 3
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn draws_a_texture_repeated_under_each_pixel_as_its_average() {
    // A made-up floor 10 m square, its black and white checker texture
    // repeated 64 times each way: drawn 20 pixels across, a pixel covers
    // about three repeats, so each shows the grey between, not black or white.
    let dir = temp("mips");
    let mut checker = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut checker, 2, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&[
                0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
            ])
            .unwrap();
    }
    fs::write(dir.join("checker.png"), checker).unwrap();
    fs::write(
        dir.join("floor.mtl"),
        "newmtl Floor\nKd 1 1 1\nmap_Kd checker.png\n",
    )
    .unwrap();
    fs::write(
        dir.join("floor.obj"),
        "mtllib floor.mtl\nv 0 0 0\nv 10 0 0\nv 10 0 -10\nv 0 0 -10\nvt 0 0\nvt 64 0\nvt 64 64\nvt 0 64\nusemtl Floor\nf 1/1 2/2 3/3\nf 1/1 3/3 4/4\n",
    )
    .unwrap();
    let (model, _) = read(&dir.join("floor.obj")).unwrap();
    let axes = ["+x".to_owned(), "-z".to_owned(), "+y".to_owned()];
    let transform = Transform::from_parts(Some(&axes), None, None).unwrap();
    let frame = Frame {
        x_min: 0.0,
        z_max: 10.0,
        scale: 2.0,
        width: 20,
        height: 20,
    };
    let floors = vec![0i16; model.triangles()];
    let files = draw_floors(
        &model,
        &transform,
        &frame,
        &floors,
        1,
        Colouring::Textures,
        &dir.join("drawn"),
    )
    .unwrap();
    let picture = image::open(dir.join("drawn").join(&files[0]))
        .unwrap()
        .into_rgba8();
    let values: Vec<u8> = picture.pixels().map(|p| p.0[0]).collect();
    let (low, high) = (*values.iter().min().unwrap(), *values.iter().max().unwrap());
    assert!(
        high - low <= 12,
        "even grey, not a pattern: {low} to {high}"
    );
    assert!(
        (100..=230).contains(&low),
        "grey, not black or white: {low}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn base64_and_uris() {
    for text in ["", "a", "ab", "abc", "abcd", "made-up ü"] {
        let encoded = crate::draw::base64_encode(text.as_bytes());
        assert_eq!(
            crate::formats::base64_decode(&encoded).unwrap(),
            text.as_bytes()
        );
    }
    assert_eq!(
        crate::formats::percent_decode("brick%20wall%C3%BC.png"),
        "brick wallü.png"
    );
    assert_eq!(crate::formats::percent_decode("100%"), "100%");
    assert_eq!(crate::formats::percent_decode("%zz%"), "%zz%");
    assert_eq!(crate::formats::count_text(5_000_000), "5,000,000");
}
