//! Textures kept once (`textures.once`, see [`crate::cells`]), on made-up
//! models only: a town of many houses sharing a few pictures.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::*;
use crate::cells::{by_picture, PICTURE_CELL_BYTES, PICTURE_CELL_TRIANGLES};
use crate::gltf::{split_glb, Part, TextureRef, WRAP_REPEAT};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("atlas-scene-once-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn options(value: Value) -> Options {
    serde_json::from_value(value).unwrap()
}

/// A made-up noisy picture (it does not compress), `side` pixels a side.
fn noisy_png(side: u32, seed: u32) -> Vec<u8> {
    let mut data = Vec::new();
    for i in 0..side * side {
        let mut h = (i ^ seed.wrapping_mul(0x9E37_79B9)).wrapping_mul(0x85EB_CA6B);
        h ^= h >> 13;
        h = h.wrapping_mul(0xC2B2_AE35);
        h ^= h >> 16;
        data.extend(h.to_le_bytes()[..3].iter());
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, side, side);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&data).unwrap();
    }
    bytes
}

/// A level square at world (x, y), `size` a side, `height` up, in glTF's axes.
fn square(x: f64, y: f64, size: f64, height: f64, material: usize, name: &str) -> Part {
    Part {
        names: vec![name.to_owned()],
        material,
        positions: vec![
            [x, height, -y],
            [x + size, height, -y],
            [x + size, height, -y - size],
            [x, height, -y - size],
        ],
        colors: None,
        uvs: Some(vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]),
        indices: vec![0, 1, 2, 0, 2, 3],
    }
}

/// A made-up town of `n` by `n` houses 20 apart, each of a floor, a roof and
/// a wall (three pictures every house shares), and one house in four with
/// a sign of its own picture: `3 + ceil(n * n / 4)` pictures in all.
fn town(n: usize, side: u32) -> Model {
    let mut images = vec![noisy_png(side, 1), noisy_png(side, 2), noisy_png(side, 3)];
    let mut parts = Vec::new();
    for j in 0..n {
        for i in 0..n {
            let (x, y) = (i as f64 * 20.0, j as f64 * 20.0);
            let name = format!("house {i} {j}");
            parts.push(square(x, y, 8.0, 0.0, 0, &name));
            parts.push(square(x + 1.0, y + 1.0, 6.0, 4.0, 1, &name));
            parts.push(square(x + 2.0, y + 2.0, 4.0, 2.0, 2, &name));
            if (i + j * n).is_multiple_of(4) {
                images.push(noisy_png(side / 2, 100 + (i + j * n) as u32));
                parts.push(square(x + 3.0, y + 3.0, 2.0, 3.0, images.len() - 1, &name));
            }
        }
    }
    let materials = (0..images.len())
        .map(|image| Material {
            name: format!("made-up {image}"),
            textured: true,
            texture: Some(TextureRef {
                image,
                wrap: [WRAP_REPEAT, WRAP_REPEAT],
                tex_coord: 0,
            }),
            ..Material::default()
        })
        .collect();
    Model {
        materials,
        parts,
        images,
        skipped_primitives: 0,
    }
}

/// The pictures of each file of a level: per file, its pictures' bytes.
fn pictures_at(built: &Built, pack: &Path, level: u64) -> Vec<Vec<Vec<u8>>> {
    built.scene["cells"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|cell| {
            let lod = cell["lods"]
                .as_array()
                .unwrap()
                .iter()
                .find(|lod| lod["level"].as_u64() == Some(level))?;
            let bytes = fs::read(pack.join(lod["file"].as_str().unwrap())).unwrap();
            let (json, bin) = split_glb(&bytes).unwrap();
            let images = json["images"].as_array().cloned().unwrap_or_default();
            Some(
                images
                    .iter()
                    .map(|image| {
                        let view =
                            &json["bufferViews"][image["bufferView"].as_u64().unwrap() as usize];
                        let start = view["byteOffset"].as_u64().unwrap() as usize;
                        let length = view["byteLength"].as_u64().unwrap() as usize;
                        bin[start..start + length].to_vec()
                    })
                    .collect(),
            )
        })
        .collect()
}

fn build_town(model: &Model, dir: &Path, folder: &str, once: bool) -> Built {
    build(
        model,
        &options(json!({
            "folder": folder,
            "cellTriangles": 40,
            "textures": { "mode": "keep", "once": once },
        })),
        dir,
        &mut |_, _| {},
    )
    .unwrap()
}

#[test]
fn each_picture_is_in_one_file_of_each_level_whatever_the_cells() {
    let dir = temp("town");
    let model = town(8, 128);
    let own: u64 = model.images.iter().map(|b| b.len() as u64).sum();

    // A grid: the pictures every house shares are in every cell's files.
    let grid = build_town(&model, &dir, "scene/grid", false);
    assert!(!grid.report.pictures_once);
    assert!(grid.report.cells >= 16, "{}", grid.report.cells);
    let grid_finest: u64 = grid.report.levels[0].texture_bytes;
    assert!(grid_finest > 5 * own, "{grid_finest} of {own}");

    // Once: each picture in one file of each level, its own bytes at the finest.
    let once = build_town(&model, &dir, "scene/once", true);
    assert!(once.report.pictures_once);
    assert!(!once.report.cells_smaller_for_textures);
    assert_eq!(
        once.report.triangles, grid.report.triangles,
        "no triangle is lost or doubled"
    );
    for level in 0..once.report.levels.len() as u64 {
        let files = pictures_at(&once, &dir, level);
        let mut seen: HashMap<Vec<u8>, usize> = HashMap::new();
        for file in &files {
            for picture in file {
                *seen.entry(picture.clone()).or_default() += 1;
            }
        }
        assert!(
            seen.values().all(|&n| n == 1),
            "level {level}: a picture is in two files"
        );
        if level == 0 {
            assert_eq!(seen.len(), model.images.len());
            for picture in seen.keys() {
                assert!(
                    model.images.contains(picture),
                    "the finest level keeps each picture's own bytes"
                );
            }
        }
    }
    assert_eq!(once.report.levels[0].texture_bytes, own);
    // The coarser levels' copies are smaller still: all levels together hold well under twice the pictures.
    assert!(
        once.report.texture_bytes < 2 * own,
        "{} of {own}",
        once.report.texture_bytes
    );
    assert!(
        once.report.bytes * 4 < grid.report.bytes,
        "{} against {}",
        once.report.bytes,
        grid.report.bytes
    );

    // The shared pictures went to one large cell, the signs to cells of their own house's size.
    let cells = once.scene["cells"].as_array().unwrap();
    let sides: Vec<f64> = cells
        .iter()
        .map(|c| c["bounds"][2].as_f64().unwrap() - c["bounds"][0].as_f64().unwrap())
        .collect();
    let largest = sides.iter().cloned().fold(0.0, f64::max);
    assert!(largest >= 148.0, "a cell over the whole town: {sides:?}");
    assert!(sides.iter().any(|&s| s < largest / 2.0), "{sides:?}");
    // Every cell's bounds hold its triangles, and are square (the build's checks passed too).
    for cell in cells {
        let b: Vec<f64> = cell["bounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert!(((b[2] - b[0]) - (b[3] - b[1])).abs() < 1e-6 * (b[2] - b[0]));
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_files_grow_with_the_pictures_not_with_the_cells() {
    // The same pictures over a town four times as large: the grid's files
    // grow with its cells, the files of pictures kept once stay as they were.
    let dir = temp("grow");
    let small = town(6, 128);
    let mut large = town(12, 128);
    // The large town's signs: the small one's pictures, so both have the same pictures.
    large.images.truncate(small.images.len());
    for material in &mut large.materials {
        if let Some(texture) = &mut material.texture {
            texture.image = texture.image.min(small.images.len() - 1);
        }
    }
    let own: u64 = small.images.iter().map(|b| b.len() as u64).sum();
    let grid_small = build_town(&small, &dir, "scene/grid-small", false);
    let grid_large = build_town(&large, &dir, "scene/grid-large", false);
    let once_small = build_town(&small, &dir, "scene/once-small", true);
    let once_large = build_town(&large, &dir, "scene/once-large", true);
    assert!(grid_large.report.cells > 2 * grid_small.report.cells);
    assert!(
        grid_large.report.levels[0].texture_bytes > 2 * grid_small.report.levels[0].texture_bytes,
        "{} against {}",
        grid_large.report.levels[0].texture_bytes,
        grid_small.report.levels[0].texture_bytes
    );
    assert_eq!(once_small.report.levels[0].texture_bytes, own);
    assert_eq!(once_large.report.levels[0].texture_bytes, own);
    let texture_bytes = |built: &Built| built.report.texture_bytes as f64;
    assert!(texture_bytes(&once_large) < 1.5 * texture_bytes(&once_small));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn heavy_cells_are_shared_out_and_crowded_pictures_stay_on_the_grid() {
    // Four pictures over the whole of a 100 by 100 ground, each as heavy as
    // half a cell may hold: two cells of the same square hold two each.
    let low = [0.0, 0.0, 0.0];
    let high = [100.0, 100.0, 0.0];
    let mut centres = Vec::new();
    let mut picture_of = Vec::new();
    for image in 0..4usize {
        for corner in [[1.0, 1.0], [99.0, 99.0], [50.0, 50.0]] {
            centres.push(corner);
            picture_of.push(Some((image, PICTURE_CELL_BYTES / 2)));
        }
    }
    centres.push([10.0, 10.0]);
    picture_of.push(None);
    let (slots, cell_of) = by_picture(&centres, &picture_of, low, high, 25.0, 4096).unwrap();
    let mut by_slot: HashMap<u32, HashSet<usize>> = HashMap::new();
    for (t, picture) in picture_of.iter().enumerate() {
        if let Some((image, _)) = picture {
            by_slot.entry(cell_of[t]).or_default().insert(*image);
        }
    }
    assert_eq!(by_slot.len(), 2, "{slots:?}");
    assert!(by_slot.values().all(|images| images.len() == 2));
    let ids: Vec<&str> = by_slot
        .keys()
        .map(|&s| slots[s as usize].id.as_str())
        .collect();
    assert!(ids.iter().all(|id| id.starts_with("t2-0-0")), "{ids:?}");
    // The triangle without a picture is in the grid's cell of its centre.
    assert_eq!(slots[*cell_of.last().unwrap() as usize].id, "c0-0");
    let unique: HashSet<&str> = slots.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(unique.len(), slots.len(), "ids are unique");

    // A picture shown by more triangles than a cell may hold stays on the grid.
    let count = PICTURE_CELL_TRIANGLES + 1;
    let centres: Vec<[f64; 2]> = (0..count)
        .map(|i| [(i % 100) as f64, ((i / 100) % 100) as f64])
        .collect();
    let picture_of = vec![Some((0usize, 1u64)); count];
    let (slots, cell_of) = by_picture(&centres, &picture_of, low, high, 25.0, 4096).unwrap();
    let used: HashSet<u32> = cell_of.iter().copied().collect();
    assert_eq!(used.len(), 16);
    assert!(used.iter().all(|&s| slots[s as usize].id.starts_with('c')));

    // Too many cells: none made, and the builder falls back to its grid.
    assert!(by_picture(&centres, &picture_of, low, high, 25.0, 4).is_none());
}

/// Not a check: the sizes of a made-up area like a large game area, built
/// both ways (`cargo test --release measure_a_made_up_area -- --ignored --nocapture`).
/// Its pictures are 128 pixels a side and the grid's `cellBytes` 1 MB, an
/// eighth a side and a 64th of the bytes of 1024-pixel pictures and the
/// default 64 MB, so its pictures' bytes are a 64th of such an area's.
#[test]
#[ignore]
fn measure_a_made_up_area() {
    let dir = temp("measure");
    // 16 by 16 houses 30 apart, each of 4 squares cut into 400 triangles each, showing 4 of 24 shared
    // pictures; one house in four with a sign of its own picture, half as large a side.
    let shared = 24;
    let mut images: Vec<Vec<u8>> = (0..shared).map(|i| noisy_png(128, i as u32 + 1)).collect();
    let mut parts = Vec::new();
    let n = 16;
    for j in 0..n {
        for i in 0..n {
            let (x, y) = (i as f64 * 30.0, j as f64 * 30.0);
            for k in 0..4 {
                let material = (i * 7 + j * 3 + k * 5) % shared;
                for a in 0..10 {
                    for b in 0..10 {
                        parts.push(square(
                            x + a as f64,
                            y + b as f64,
                            1.0,
                            k as f64 * 3.0,
                            material,
                            "house",
                        ));
                    }
                }
            }
            if (i + j * n).is_multiple_of(4) {
                images.push(noisy_png(64, 1000 + (i + j * n) as u32));
                parts.push(square(
                    x + 3.0,
                    y + 3.0,
                    2.0,
                    13.0,
                    images.len() - 1,
                    "sign",
                ));
            }
        }
    }
    let materials = (0..images.len())
        .map(|image| Material {
            textured: true,
            texture: Some(TextureRef {
                image,
                wrap: [WRAP_REPEAT, WRAP_REPEAT],
                tex_coord: 0,
            }),
            ..Material::default()
        })
        .collect();
    let model = Model {
        materials,
        parts,
        images,
        skipped_primitives: 0,
    };
    let own: u64 = model.images.iter().map(|b| b.len() as u64).sum();
    let mb = |b: u64| b as f64 / (1 << 20) as f64;
    eprintln!(
        "{} triangles, {} pictures, {:.2} MB of pictures",
        model.triangles(),
        model.images.len(),
        mb(own)
    );
    for (name, value) in [
        ("grid", json!({ "mode": "keep", "cellBytes": 1 << 20 })),
        ("once", json!({ "mode": "keep", "once": true })),
    ] {
        let built = build(
            &model,
            &options(json!({ "folder": format!("scene/{name}"), "textures": value })),
            &dir,
            &mut |_, _| {},
        )
        .unwrap();
        let r = &built.report;
        eprintln!(
            "{name}: {} cells (side {:.0}), {:.2} MB in all, {:.2} MB of pictures ({:.2} MB at the finest level)",
            r.cells,
            r.cell_size,
            mb(r.bytes),
            mb(r.texture_bytes),
            mb(r.levels[0].texture_bytes)
        );
        let _ = fs::remove_dir_all(dir.join("scene").join(name));
    }
    let _ = fs::remove_dir_all(&dir);
}
