//! Pack files: export then import at each detail, and every refusal.

use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde_json::{json, Value};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use super::{
    export::{export, part_path, PackWriter},
    import::{entry_names, import, import_with, read_header},
    *,
};
use crate::{
    library::{BundledPack, Library, PackLock},
    packs::PackRegistry,
    removal::FileOps,
    settings::SettingsFile,
    tiles::store::tests::TempDir,
};

const ID: &str = "test-valley";

fn app() -> AppInfo {
    AppInfo {
        name: "Atlas".into(),
        version: "0.3.5".into(),
        platform: "linux".into(),
    }
}

fn put(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn put_json(path: &Path, value: &Value) {
    put(
        path,
        serde_json::to_string_pretty(value).unwrap().as_bytes(),
    );
}

/// Layer `a` (map East Field, 2048 px square): `{z}/{x}/{y}.png`, levels
/// 0-3, remote levels 1-3, so Overview is 0-1, Standard 0-2 and Full 0-3.
/// Layer `b` (map West Ridge, 1024 x 512 px): `{z}/{y}/{x}.jpg`, levels 0-2,
/// remote levels 1-2, so Overview and Standard are 0-1. Layer `c` (West
/// Ridge, made-up "relief" layer): all its images come with the pack.
fn layers_json() -> Value {
    let remote = |slug: &str, levels: &[u8]| {
        json!({
            "urlTemplate": format!("https://tiles.example.com/{slug}/{{z}}/{{x}}/{{y}}.png"),
            "levels": levels.iter().map(|&z| json!({"z": z, "sourceZ": z + 10, "offsetX": 0, "offsetY": 0})).collect::<Vec<_>>(),
        })
    };
    json!([
        {"id": format!("{ID}:layer:a"), "mapId": format!("{ID}:map:east"), "name": "Surface", "minZoom": 0, "maxZoom": 3, "tileSize": 256,
         "tiles": {"type": "xyz", "url": "tiles/a/{z}/{x}/{y}.png", "remote": remote("a", &[1, 2, 3])}},
        {"id": format!("{ID}:layer:b"), "mapId": format!("{ID}:map:west"), "name": "Surface", "minZoom": 0, "maxZoom": 2, "tileSize": 256,
         "tiles": {"type": "xyz", "url": "tiles/b/{z}/{y}/{x}.jpg", "remote": remote("b", &[1, 2])}},
        {"id": format!("{ID}:layer:c"), "mapId": format!("{ID}:map:west"), "name": "Relief", "minZoom": 0, "maxZoom": 1, "tileSize": 256,
         "tiles": {"type": "xyz", "url": "tiles/c/{z}/{x}/{y}.webp"}}
    ])
}

fn manifest(version: &str) -> Value {
    let layer = |local: &str, name: &str, max: u8| {
        json!({"id": format!("{ID}:layer:{local}"), "name": name, "minZoom": 0, "maxZoom": max, "tiles": "xyz", "downloadable": local != "c",
               "images": if local == "c" { Value::Null } else { json!({"levels": (0..=max).collect::<Vec<_>>(), "complete": true, "files": 1, "bytes": 1, "updatedAt": "2026-11-10T21:35:00Z"}) }})
    };
    let mut value = json!({
        "schemaVersion": 2,
        "gameId": ID,
        "title": "Test Valley",
        "packVersion": version,
        "gamePatch": "demo",
        "attribution": [{"name": "Demo map site (made-up test data)"}],
        "idMigrations": {},
        "created": "2026-11-01T10:00:00.000Z",
        "updated": "2026-11-10T21:32:10.000Z",
        "writtenBy": {"name": "Atlas", "version": "0.3.5"},
        "source": {
            "importer": {"id": "demo-maps", "title": "Demo map site"},
            "pages": [
                {"url": "http://127.0.0.1:4432/demo-maps/test-valley/east-field", "mapId": format!("{ID}:map:east"), "importedAt": "2026-11-10T21:30:00.000Z"},
                {"url": "http://127.0.0.1:4432/demo-maps/test-valley/west-ridge", "mapId": format!("{ID}:map:west"), "importedAt": "2026-11-02T08:00:00.000Z"}
            ]
        },
        "contents": {
            "counts": {"maps": 2, "layers": 3, "locations": 2, "categories": 1, "regions": 0, "guides": 0},
            "maps": [
                {"id": format!("{ID}:map:east"), "name": "East Field", "width": 2048, "height": 2048, "locations": 2, "layers": [layer("a", "Surface", 3)]},
                {"id": format!("{ID}:map:west"), "name": "West Ridge", "width": 1024, "height": 512, "locations": 0, "layers": [layer("b", "Surface", 2), layer("c", "Relief", 1)]}
            ]
        }
    });
    // Layer c has no image summary.
    value["contents"]["maps"][1]["layers"][1]
        .as_object_mut()
        .unwrap()
        .remove("images");
    value
}

fn status(local: &str, levels: &[u8], max: u8) -> Value {
    let native_max = (0..=max).take_while(|z| levels.contains(z)).last();
    json!({"format": "atlas-tile-status", "version": 1, "layerId": format!("{ID}:layer:{local}"), "levels": levels,
           "nativeMinZoom": native_max.map(|_| 0), "nativeMaxZoom": native_max, "complete": native_max == Some(max),
           "updatedAt": 1_794_000_000_000_u64})
}

/// The tiles of a level: (x, y).
fn grid(width: u64, height: u64, max: u8, z: u8) -> Vec<(u64, u64)> {
    let scale = 1u64 << (max - z);
    let (columns, rows) = (
        width.div_ceil(scale).div_ceil(256),
        height.div_ceil(scale).div_ceil(256),
    );
    (0..rows)
        .flat_map(|y| (0..columns).map(move |x| (x, y)))
        .collect()
}

fn tile_a(z: u8, x: u64, y: u64) -> String {
    format!("tiles/a/{z}/{x}/{y}.png")
}

fn tile_b(z: u8, x: u64, y: u64) -> String {
    format!("tiles/b/{z}/{y}/{x}.jpg")
}

fn tile_c(z: u8, x: u64, y: u64) -> String {
    format!("tiles/c/{z}/{x}/{y}.webp")
}

/// Writes the pack files (not the images) into `dir`.
fn write_pack_files(dir: &Path, version: &str) {
    put_json(&dir.join("manifest.json"), &manifest(version));
    put_json(
        &dir.join("maps.json"),
        &json!([
            {"id": format!("{ID}:map:east"), "name": "East Field", "width": 2048, "height": 2048},
            {"id": format!("{ID}:map:west"), "name": "West Ridge", "width": 1024, "height": 512}
        ]),
    );
    put_json(&dir.join("layers.json"), &layers_json());
    put_json(
        &dir.join("locations.json"),
        &json!([{"id": "x1"}, {"id": "x2"}]),
    );
    put_json(&dir.join("categories.json"), &json!([{"id": "c1"}]));
    put_json(&dir.join("checklists.json"), &json!([{"id": "l1"}]));
    put_json(&dir.join("regions.json"), &json!([]));
}

/// Writes the downloaded images, markers and status files into `root`:
/// everything of layers a and b, except one image of each top level that
/// the server did not have (a marker instead).
fn write_images(root: &Path) {
    for z in 0..=3 {
        for (x, y) in grid(2048, 2048, 3, z) {
            if (z, x, y) == (3, 7, 7) {
                put(&root.join(format!("{}.404", tile_a(z, x, y))), b"");
            } else {
                put(
                    &root.join(tile_a(z, x, y)),
                    format!("a{z}/{x}/{y}").as_bytes(),
                );
            }
        }
    }
    for z in 0..=2 {
        for (x, y) in grid(1024, 512, 2, z) {
            if (z, x, y) == (2, 3, 1) {
                put(&root.join(format!("{}.404", tile_b(z, x, y))), b"");
            } else {
                put(
                    &root.join(tile_b(z, x, y)),
                    format!("b{z}/{x}/{y}").as_bytes(),
                );
            }
        }
    }
    put_json(
        &root.join("offline-tiles/a.json"),
        &status("a", &[0, 1, 2, 3], 3),
    );
    put_json(
        &root.join("offline-tiles/b.json"),
        &status("b", &[0, 1, 2], 2),
    );
}

fn write_shipped_images(root: &Path) {
    for z in 0..=1 {
        for (x, y) in grid(1024, 512, 1, z) {
            put(
                &root.join(tile_c(z, x, y)),
                format!("c{z}/{x}/{y}").as_bytes(),
            );
        }
    }
}

/// A pack folder as the maps folder keeps it, with its images, page data
/// and the app's own files.
fn write_pack(dir: &Path, version: &str) {
    write_pack_files(dir, version);
    write_images(dir);
    write_shipped_images(dir);
    put_json(
        &dir.join("import/index.json"),
        &json!({"format": "atlas-import", "version": 1, "importer": {"id": "demo-maps", "title": "Demo map site"},
                "sources": [{"key": "east-field", "url": "http://127.0.0.1:4432/demo-maps/test-valley/east-field",
                             "importedAt": "2026-11-11T09:00:00.000Z", "mapId": format!("{ID}:map:east"), "file": "east-field.json"}]}),
    );
    put(&dir.join("import/east-field.json"), b"{\"page\":1}");
    // Style sheets kept from the pages it was read from: never in a pack file.
    put_json(
        &dir.join("import/styles/index.json"),
        &json!({"format": "atlas-styles", "version": 1,
                "sheets": [{"address": "http://127.0.0.1:4432/demo-maps/look.css", "file": "0123456789abcdef0123456789abcdef.css",
                            "bytes": 22, "keptAt": "2026-11-11T09:00:00Z", "way": "window", "mark": "22-x"}]}),
    );
    put(
        &dir.join("import/styles/0123456789abcdef0123456789abcdef.css"),
        b".box { float: right; }",
    );
    put(&dir.join(".atlas/download-job.json"), b"{}");
}

fn folder_source(dir: &Path) -> PackSource {
    PackSource {
        pack_id: ID.into(),
        root: dir.to_path_buf(),
        images: dir.to_path_buf(),
        lock: true,
        comes_with_app: false,
        own_use_pictures: false,
        smaller_pictures: false,
        group: None,
    }
}

fn run_export(
    source: &PackSource,
    detail: Detail,
    destination: &Path,
) -> Result<export::Exported, Stop> {
    let mut last = Progress::default();
    let result = export(
        source,
        &app(),
        detail,
        destination,
        &mut |done| last = done,
        &|| false,
    );
    if result.is_ok() {
        assert_eq!(last.entries_done, last.entries_total);
        assert_eq!(last.bytes_done, last.bytes_total);
    }
    result
}

fn run_import(file: &Path, maps: &Path) -> Result<import::Imported, Stop> {
    import(file, maps, &mut |_| {}, &|| false)
}

fn json_entry(file: &Path, name: &str) -> Value {
    let mut archive = ZipArchive::new(fs::File::open(file).unwrap()).unwrap();
    let entry = archive.by_name(name).unwrap();
    serde_json::from_reader(entry).unwrap()
}

/// The files under a folder, as `/` paths, with their contents.
fn files_under(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let name = path
                    .strip_prefix(root)
                    .unwrap()
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.insert(name, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn hidden_entries(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with('.'))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn exports_and_imports_at_each_detail() {
    let dir = TempDir::new("packfile-round-trip");
    let pack = dir.0.join("maps/test-valley");
    write_pack(&pack, "1.1.0");
    let source = folder_source(&pack);
    let expected_top = [
        (Detail::Overview, 1, 1),
        (Detail::Standard, 2, 1),
        (Detail::Full, 3, 2),
    ];
    for (detail, top_a, top_b) in expected_top {
        let name = default_file_name(ID, detail);
        let file = dir.0.join("out").join(&name);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let exported = run_export(&source, detail, &file).unwrap();
        assert!(!part_path(&file).exists());
        assert_eq!(exported.size, fs::metadata(&file).unwrap().len());

        let names = entry_names(&file);
        let first = {
            let archive = ZipArchive::new(fs::File::open(&file).unwrap()).unwrap();
            archive.name_for_index(0).unwrap().unwrap().into_owned()
        };
        assert_eq!(first, HEADER_FILE, "the header comes first");
        // The pack files, the images up to the detail and nothing else.
        for kept in [
            "manifest.json",
            "maps.json",
            "layers.json",
            "locations.json",
            "offline-tiles/a.json",
            "offline-tiles/b.json",
        ] {
            assert!(names.contains_key(kept), "{detail:?}: {kept}");
        }
        assert!(
            names
                .keys()
                .all(|n| !n.starts_with(".atlas") && !n.starts_with("import/")),
            "{names:?}"
        );
        for z in 0..=3 {
            assert_eq!(
                names.contains_key(&tile_a(z, 0, 0)),
                z <= top_a,
                "{detail:?} a {z}"
            );
        }
        for z in 0..=2 {
            assert_eq!(
                names.contains_key(&tile_b(z, 0, 0)),
                z <= top_b,
                "{detail:?} b {z}"
            );
        }
        // `{z}/{y}/{x}`: column 1 of row 0 at level 1.
        assert!(names.contains_key("tiles/b/1/0/1.jpg"));
        assert!(!names.contains_key("tiles/b/1/1/0.jpg"));
        // The layer whose images came with the pack is there whole.
        assert!(names.contains_key(&tile_c(1, 1, 0)));
        // Markers of the levels included only.
        assert_eq!(
            names.contains_key("tiles/a/3/7/7.png.404"),
            detail == Detail::Full
        );
        assert_eq!(
            names.contains_key("tiles/b/2/1/3.jpg.404"),
            detail == Detail::Full
        );

        // Images stored, JSON deflated.
        {
            let mut archive = ZipArchive::new(fs::File::open(&file).unwrap()).unwrap();
            assert_eq!(
                archive.by_name(&tile_a(0, 0, 0)).unwrap().compression(),
                CompressionMethod::Stored
            );
            assert_eq!(
                archive.by_name("locations.json").unwrap().compression(),
                CompressionMethod::Deflated
            );
        }

        // The status files and the manifest describe the levels included.
        let status_a: LayerStatus =
            serde_json::from_value(json_entry(&file, "offline-tiles/a.json")).unwrap();
        assert_eq!(status_a.levels, (0..=top_a).collect::<Vec<_>>());
        assert_eq!(status_a.native_max_zoom, Some(top_a));
        assert_eq!(status_a.complete, top_a == 3);
        assert_eq!(
            status_a.updated_at, 1_794_000_000_000,
            "the download time is kept"
        );
        let manifest = json_entry(&file, "manifest.json");
        let images = &manifest["contents"]["maps"][0]["layers"][0]["images"];
        assert_eq!(images["levels"], json!((0..=top_a).collect::<Vec<_>>()));
        assert_eq!(images["complete"], json!(top_a == 3));
        let files_a: u64 = (0..=top_a)
            .map(|z| grid(2048, 2048, 3, z).len() as u64)
            .sum::<u64>()
            - u64::from(top_a == 3);
        assert_eq!(images["files"], json!(files_a));
        assert_eq!(images["updatedAt"], "2026-11-10T21:35:00Z");
        assert!(manifest["contents"]["maps"][1]["layers"][1]
            .get("images")
            .is_none());
        assert_eq!(
            manifest["source"]["importer"]["id"], "demo-maps",
            "the rest is kept"
        );
        // layers.json is unchanged, so an Atlas with downloads can fetch the rest later.
        assert_eq!(
            json_entry(&file, "layers.json"),
            serde_json::from_slice::<Value>(&fs::read(pack.join("layers.json")).unwrap()).unwrap()
        );

        // The header, read alone.
        let header = read_header(&file).unwrap();
        assert_eq!(header, exported.header);
        assert_eq!(header.format, "atlas-pack-file");
        assert_eq!(header.version, 1);
        assert_eq!(
            (header.pack_id.as_str(), header.pack_version.as_str()),
            (ID, "1.1.0")
        );
        assert_eq!(header.detail, detail);
        assert_eq!(header.exported_by, app());
        assert!(iso_millis(&header.exported_at).is_some());
        assert_eq!(
            header.images.layers[0].levels,
            (0..=top_a).collect::<Vec<_>>()
        );
        assert_eq!(header.images.layers[0].files, files_a);
        assert!(header.images.layers[0].complete);
        assert_eq!(header.images.layers[0].full, top_a == 3);
        assert_eq!(
            header.images.layers[0].downloaded_at.as_deref(),
            Some("2026-11-06T21:20:00Z")
        );
        assert!(!header.images.layers[2].downloadable && header.images.layers[2].full);
        assert_eq!(header.files as usize, names.len() - 1);

        // Import into another maps folder.
        let maps = dir.0.join(format!("other-{detail:?}"));
        let imported = run_import(&file, &maps).unwrap();
        assert_eq!(imported.folder, maps.join(ID));
        assert!(!imported.replaced);
        let unpacked = files_under(&imported.folder);
        for (name, size) in names.iter().filter(|(n, _)| *n != HEADER_FILE) {
            assert_eq!(
                unpacked.get(name).map(|b| b.len() as u64),
                Some(*size),
                "{name}"
            );
        }
        assert_eq!(unpacked[&tile_a(0, 0, 0)], b"a0/0/0");
        assert!(unpacked.contains_key(".atlas/pack-file.json"));
        assert!(unpacked.keys().all(|n| !n.starts_with("import/")));
        assert!(hidden_entries(&maps).is_empty(), "nothing left behind");
        // What the Maps dialog shows about it.
        let details = pack_details(&folder_source(&imported.folder)).unwrap();
        assert_eq!(details.detail, Some(detail));
        // The style sheets kept with the pack stayed behind.
        assert_eq!(details.styles, None);
        assert_eq!(
            pack_details(&source).unwrap().styles,
            Some(crate::styles::StylesFacts {
                sheets: 1,
                bytes: 22,
                left_out: 0
            })
        );
        assert_eq!(details.pack_file.as_ref().unwrap().header, header);
        assert_eq!(details.pack_file.as_ref().unwrap().file_name, name);
    }
}

#[test]
fn the_header_says_where_the_data_came_from() {
    let dir = TempDir::new("packfile-metadata");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.1.0");
    let file = dir.0.join("valley.atlaspack");
    let header = run_export(&folder_source(&pack), Detail::Overview, &file)
        .unwrap()
        .header;
    assert_eq!(header.pack.title, "Test Valley");
    assert_eq!(header.pack.game_patch.as_deref(), Some("demo"));
    assert_eq!(header.pack.schema_version, 2);
    assert_eq!(header.pack.attribution.len(), 1);
    assert_eq!(
        header.pack.created.as_deref(),
        Some("2026-11-01T10:00:00.000Z")
    );
    assert_eq!(
        header.pack.updated.as_deref(),
        Some("2026-11-10T21:32:10.000Z")
    );
    assert_eq!(header.source.kind, SourceKind::WebPages);
    assert_eq!(
        header.source.importer.as_ref().unwrap().title,
        "Demo map site"
    );
    assert_eq!(header.source.pages.len(), 2);
    // The page data index read the east page again later than the manifest says.
    assert_eq!(
        header.source.newest_page_at.as_deref(),
        Some("2026-11-11T09:00:00.000Z")
    );
    assert_eq!(
        header.source.oldest_page_at.as_deref(),
        Some("2026-11-02T08:00:00.000Z")
    );
    assert_eq!(
        header.contents,
        Counts {
            maps: 2,
            layers: 3,
            locations: 2,
            categories: 1,
            regions: 0,
            checklists: 1,
            guides: 0
        }
    );
    // The JSON text uses the documented names.
    let raw = json_entry(&file, HEADER_FILE);
    for key in [
        "format",
        "version",
        "packId",
        "title",
        "packVersion",
        "detail",
        "exportedAt",
        "exportedBy",
        "pack",
        "source",
        "contents",
        "images",
        "files",
        "bytes",
    ] {
        assert!(raw.get(key).is_some(), "{key}");
    }
    assert_eq!(raw["exportedBy"]["platform"], "linux");
    assert_eq!(raw["source"]["kind"], "web-pages");
    assert_eq!(raw["source"]["newestPageAt"], "2026-11-11T09:00:00.000Z");
    assert_eq!(
        raw["images"]["layers"][0]["downloadedAt"],
        "2026-11-06T21:20:00Z"
    );
    // No page data and nothing personal.
    let text = serde_json::to_string(&raw).unwrap();
    assert!(!text.contains("\"page\":1"));

    // A pack that was not made from web pages says only what is known.
    let plain = dir.0.join("plain");
    write_pack_files(&plain, "1.0.0");
    write_images(&plain);
    write_shipped_images(&plain);
    let mut value = manifest("1.0.0");
    let object = value.as_object_mut().unwrap();
    for key in ["source", "created", "updated", "writtenBy"] {
        object.remove(key);
    }
    put_json(&plain.join("manifest.json"), &value);
    let mut source = folder_source(&plain);
    source.comes_with_app = true;
    let header = run_export(&source, Detail::Overview, &dir.0.join("plain.atlaspack"))
        .unwrap()
        .header;
    assert_eq!(header.source.kind, SourceKind::App);
    assert!(header.source.pages.is_empty() && header.source.newest_page_at.is_none());
    assert!(header.pack.created.is_none(), "no date is made up");
    let (_, facts) = describe_pack(&plain, false).unwrap();
    assert_eq!(facts.kind, SourceKind::Unknown);
}

#[test]
fn exports_images_from_the_overlay_of_a_pack_that_comes_with_the_app() {
    let dir = TempDir::new("packfile-overlay");
    // The app's resources hold the pack files, the images that came with
    // it, and a stale copy of one downloaded image.
    let resources = dir.0.join("resources/test-valley");
    write_pack_files(&resources, "1.0.0");
    write_shipped_images(&resources);
    put(&resources.join(tile_a(0, 0, 0)), b"shipped");
    // Downloads went to the overlay in the app's data folder.
    let overlay = dir.0.join("data/packs/test-valley");
    write_images(&overlay);
    let source = PackSource {
        pack_id: ID.into(),
        root: resources.clone(),
        images: overlay,
        lock: false,
        comes_with_app: true,
        own_use_pictures: false,
        smaller_pictures: false,
        group: None,
    };
    let options = export_options(&source).unwrap();
    assert!(options.exportable);
    assert!(options.details.iter().all(|option| option.available));
    let file = dir.0.join("out.atlaspack");
    run_export(&source, Detail::Standard, &file).unwrap();
    let mut archive = ZipArchive::new(fs::File::open(&file).unwrap()).unwrap();
    let mut read = |name: &str| {
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name(name).unwrap(), &mut text).unwrap();
        text
    };
    assert_eq!(read(&tile_a(0, 0, 0)), "a0/0/0", "the overlay comes first");
    assert_eq!(read(&tile_c(0, 0, 0)), "c0/0/0", "then the pack");
    assert_eq!(read(&tile_a(2, 1, 1)), "a2/1/1");
    assert!(
        !resources.join(".atlas").exists(),
        "nothing is written to the resources"
    );

    let maps = dir.0.join("maps");
    let imported = run_import(&file, &maps).unwrap();
    assert_eq!(
        fs::read(imported.folder.join(tile_a(0, 0, 0))).unwrap(),
        b"a0/0/0"
    );
    assert!(imported.folder.join("offline-tiles/a.json").exists());
}

#[test]
fn offers_only_details_whose_images_are_downloaded() {
    let dir = TempDir::new("packfile-options");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    // Layer a has its levels up to 2 only.
    put_json(
        &pack.join("offline-tiles/a.json"),
        &status("a", &[0, 1, 2], 3),
    );
    let options = export_options(&folder_source(&pack)).unwrap();
    assert!(options.exportable);
    let by_detail: BTreeMap<String, &DetailOption> = options
        .details
        .iter()
        .map(|o| (detail_name(o.detail).to_owned(), o))
        .collect();
    assert!(by_detail["overview"].available && by_detail["standard"].available);
    assert!(!by_detail["full"].available);
    assert_eq!(
        by_detail["full"].reason.as_deref(),
        Some("Not downloaded: Surface (East Field).")
    );
    // Overview: a 1 + 4, b 1 + 2, c 2 + 8 images.
    assert_eq!(by_detail["overview"].images, 18);
    assert_eq!(by_detail["overview"].image_bytes, 18 * 6);
    assert!(by_detail["overview"].bytes > by_detail["overview"].image_bytes);
    assert_eq!(options.whole_layers, ["Relief (West Ridge)"]);
    assert_eq!(
        options.default_names["standard"],
        "test-valley-standard.atlaspack"
    );
    let error = run_export(
        &folder_source(&pack),
        Detail::Full,
        &dir.0.join("x.atlaspack"),
    )
    .unwrap_err();
    assert!(error.message().contains("not all downloaded"), "{error:?}");
    assert!(!dir.0.join("x.atlaspack").exists());

    // Nothing downloaded at all.
    fs::remove_dir_all(pack.join("offline-tiles")).unwrap();
    let options = export_options(&folder_source(&pack)).unwrap();
    assert!(options.details.iter().all(|o| !o.available));
    assert_eq!(pack_details(&folder_source(&pack)).unwrap().detail, None);
}

#[test]
fn refuses_packs_whose_images_are_one_archive() {
    let dir = TempDir::new("packfile-pmtiles");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let mut layers = layers_json();
    layers[2]["tiles"] = json!({"type": "pmtiles", "url": "tiles/c.pmtiles"});
    put_json(&pack.join("layers.json"), &layers);
    let options = export_options(&folder_source(&pack)).unwrap();
    assert!(!options.exportable);
    assert!(options
        .reason
        .as_deref()
        .unwrap()
        .contains("Atlas for Android cannot read"));
    assert!(options.details.iter().all(|o| !o.available));
    let error = run_export(
        &folder_source(&pack),
        Detail::Overview,
        &dir.0.join("x.atlaspack"),
    )
    .unwrap_err();
    assert!(error.message().contains("one large archive file"));
    assert!(pack_details(&folder_source(&pack)).unwrap().archive);
}

#[test]
fn export_holds_the_pack_lock_and_cancel_leaves_nothing() {
    let dir = TempDir::new("packfile-export-cancel");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let file = dir.0.join("out.atlaspack");
    let held = PackLock::acquire(&pack).unwrap();
    let error = run_export(&folder_source(&pack), Detail::Full, &file).unwrap_err();
    assert!(error.message().contains("Another Atlas"), "{error:?}");
    drop(held);

    let seen = Cell::new(0);
    let result = export(
        &folder_source(&pack),
        &app(),
        Detail::Full,
        &file,
        &mut |_| {},
        &|| {
            seen.set(seen.get() + 1);
            seen.get() > 20
        },
    );
    assert_eq!(result.unwrap_err(), Stop::Cancelled);
    assert!(!file.exists() && !part_path(&file).exists());
    // While it runs, a download (which takes the lock) cannot start.
    let result = export(
        &folder_source(&pack),
        &app(),
        Detail::Overview,
        &file,
        &mut |_| {},
        &|| {
            assert!(PackLock::acquire(&pack).is_err());
            false
        },
    );
    assert!(result.is_ok());
}

/// Writes a pack file by hand: the header first, then the entries.
fn write_file(path: &Path, header: &Value, entries: &[(&str, &[u8])]) {
    let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
    let options = SimpleFileOptions::default();
    zip.start_file(HEADER_FILE, options).unwrap();
    zip.write_all(serde_json::to_string(header).unwrap().as_bytes())
        .unwrap();
    for (name, bytes) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

/// A good file's header and entries, to spoil one at a time.
fn good_file(dir: &Path) -> (Value, Vec<(String, Vec<u8>)>) {
    let pack = dir.join("good-pack");
    write_pack(&pack, "1.0.0");
    let file = dir.join("good.atlaspack");
    run_export(&folder_source(&pack), Detail::Overview, &file).unwrap();
    let mut archive = ZipArchive::new(fs::File::open(&file).unwrap()).unwrap();
    let mut entries = Vec::new();
    for i in 1..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
        entries.push((entry.name().unwrap().into_owned(), bytes));
    }
    (json_entry(&file, HEADER_FILE), entries)
}

fn import_error(dir: &Path, name: &str, header: &Value, entries: &[(String, Vec<u8>)]) -> String {
    let file = dir.join(format!("{name}.atlaspack"));
    let borrowed: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    write_file(&file, header, &borrowed);
    let maps = dir.join(format!("maps-{name}"));
    let error = run_import(&file, &maps).unwrap_err().message();
    assert!(
        !maps.join(ID).exists() && hidden_entries(&maps).is_empty(),
        "{name}: nothing is left behind"
    );
    error
}

#[test]
fn refuses_files_that_are_not_map_pack_files_or_too_new() {
    let dir = TempDir::new("packfile-refuse-format");
    let (header, entries) = good_file(&dir.0);
    let mut other = header.clone();
    other["format"] = json!("atlas-progress");
    assert!(import_error(&dir.0, "format", &other, &entries).contains("not an Atlas pack file"));
    let mut newer = header.clone();
    newer["version"] = json!(VERSION + 1);
    newer["exportedBy"] = json!({"name": "Atlas", "version": "0.9.1", "platform": "windows"});
    let error = import_error(&dir.0, "newer", &newer, &entries);
    assert!(
        error.contains("Atlas 0.9.1") && error.contains("newer"),
        "{error}"
    );
    assert_eq!(
        read_header(&dir.0.join("newer.atlaspack")).unwrap_err(),
        error
    );
    // Not a ZIP file at all, or one whose first entry is something else.
    fs::write(dir.0.join("text.atlaspack"), "hello").unwrap();
    assert!(read_header(&dir.0.join("text.atlaspack"))
        .unwrap_err()
        .contains("not an Atlas"));
    let file = dir.0.join("second.atlaspack");
    let mut zip = ZipWriter::new(fs::File::create(&file).unwrap());
    zip.start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"{}").unwrap();
    zip.finish().unwrap();
    assert!(read_header(&file).unwrap_err().contains("not an Atlas"));
}

#[test]
fn reads_the_header_without_the_rest_of_the_file() {
    let dir = TempDir::new("packfile-header-only");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let file = dir.0.join("whole.atlaspack");
    let header = run_export(&folder_source(&pack), Detail::Full, &file)
        .unwrap()
        .header;
    // Only the start of the file: the rest, with the list of contents at
    // the end, is not needed.
    let bytes = fs::read(&file).unwrap();
    let cut = dir.0.join("cut.atlaspack");
    fs::write(&cut, &bytes[..4096.min(bytes.len())]).unwrap();
    assert_eq!(read_header(&cut).unwrap(), header);
    // That file cannot be imported, and leaves nothing behind.
    let maps = dir.0.join("maps");
    assert!(run_import(&cut, &maps)
        .unwrap_err()
        .message()
        .contains("damaged"));
    assert!(hidden_entries(&maps).is_empty());
}

#[test]
fn refuses_entries_that_have_no_place_in_a_pack() {
    let dir = TempDir::new("packfile-refuse-paths");
    let (header, entries) = good_file(&dir.0);
    let bad_names = [
        "../outside.json",
        "tiles/../../outside.png",
        "/etc/passwd",
        "C:/Windows/x.png",
        "c:x.png",
        "tiles\\a\\0\\0\\0.png",
        ".atlas/lock",
        "tiles/.hidden/0.png",
        "import/index.json",
        "notes.txt",
        "tiles/a/0/0/1.png",      // outside level 0's grid
        "tiles/a/4/0/0.png",      // above the layer's top level
        "tiles/a/01/0/0.png",     // not the name the layer gives it
        "tiles/c/0/0/0.webp.404", // a marker for a layer that downloads nothing
        "offline-tiles/c.json",
        "offline-tiles/z.json",
    ];
    for (i, bad) in bad_names.iter().enumerate() {
        let mut spoiled = entries.clone();
        spoiled.push(((*bad).to_owned(), b"x".to_vec()));
        let error = import_error(&dir.0, &format!("path-{i}"), &header, &spoiled);
        assert!(
            error.contains("not part of a pack") || error.contains("outside the pack"),
            "{bad}: {error}"
        );
    }
    // A link.
    let file = dir.0.join("link.atlaspack");
    {
        let mut zip = ZipWriter::new(fs::File::create(&file).unwrap());
        zip.start_file(HEADER_FILE, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(serde_json::to_string(&header).unwrap().as_bytes())
            .unwrap();
        for (name, bytes) in entries.iter().filter(|(n, _)| *n != tile_a(1, 1, 1)) {
            zip.start_file(name.as_str(), SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.add_symlink(tile_a(1, 1, 1), "/etc/passwd", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
    }
    let maps = dir.0.join("maps-link");
    assert!(run_import(&file, &maps)
        .unwrap_err()
        .message()
        .contains("link"));
    assert!(!maps.join(ID).exists());
    // The same file twice, in another case.
    let mut twice = entries.clone();
    twice.push(("Maps.json".to_owned(), b"[]".to_vec()));
    let error = import_error(&dir.0, "twice", &header, &twice);
    assert!(
        error.contains("not part of a pack") || error.contains("twice"),
        "{error}"
    );
}

#[test]
fn refuses_the_wrong_game_and_files_too_large() {
    let dir = TempDir::new("packfile-refuse-content");
    let (header, entries) = good_file(&dir.0);
    // The manifest names another game than the header.
    let mut other = header.clone();
    other["packId"] = json!("test-hills");
    assert!(
        import_error(&dir.0, "id", &other, &entries).contains("not the one its description names")
    );
    // An id Atlas cannot use.
    let mut bad = header.clone();
    bad["packId"] = json!("../valley");
    assert!(import_error(&dir.0, "bad-id", &bad, &entries).contains("game id"));
    // A marker with content, and a status file far too large.
    let mut spoiled = entries.clone();
    spoiled.push(("tiles/a/1/1/1.png.404".to_owned(), vec![b'x'; 10]));
    spoiled.retain(|(n, _)| n != "tiles/a/1/1/1.png");
    assert!(import_error(&dir.0, "marker", &header, &spoiled).contains("too large"));
    let mut spoiled = entries.clone();
    for (name, bytes) in &mut spoiled {
        if name == "offline-tiles/a.json" {
            *bytes = vec![b' '; (1 << 20) + 1];
        }
    }
    assert!(import_error(&dir.0, "status", &header, &spoiled).contains("too large"));
    // A status file of another layer.
    let mut spoiled = entries.clone();
    for (name, bytes) in &mut spoiled {
        if name == "offline-tiles/a.json" {
            *bytes = serde_json::to_vec(&status("b", &[0, 1], 2)).unwrap();
        }
    }
    assert!(import_error(&dir.0, "status-layer", &header, &spoiled).contains("status file"));
    // A pack file that is not JSON.
    let mut spoiled = entries.clone();
    for (name, bytes) in &mut spoiled {
        if name == "locations.json" {
            *bytes = b"[1, 2".to_vec();
        }
    }
    assert!(import_error(&dir.0, "json", &header, &spoiled).contains("not valid JSON"));
}

#[test]
fn refuses_when_the_disk_is_too_full() {
    let dir = TempDir::new("packfile-space");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let file = dir.0.join("valley.atlaspack");
    run_export(&folder_source(&pack), Detail::Full, &file).unwrap();
    let maps = dir.0.join("maps");
    let error = import_with(
        &file,
        &maps,
        &FileOps::default(),
        &|_| Some(1000),
        &mut |_| {},
        &|| false,
    )
    .unwrap_err()
    .message();
    assert!(
        error.contains("not enough free space") && error.contains("1.0 KB free"),
        "{error}"
    );
    assert!(!maps.join(ID).exists() && hidden_entries(&maps).is_empty());
    // A system that cannot tell does not stop it.
    import_with(
        &file,
        &maps,
        &FileOps::default(),
        &|_| None,
        &mut |_| {},
        &|| false,
    )
    .unwrap();
}

#[test]
fn import_cancel_leaves_nothing_behind() {
    let dir = TempDir::new("packfile-import-cancel");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let file = dir.0.join("valley.atlaspack");
    run_export(&folder_source(&pack), Detail::Full, &file).unwrap();
    let maps = dir.0.join("maps");
    let asked = Cell::new(0);
    let mut reported = 0;
    let result = import(&file, &maps, &mut |_| reported += 1, &|| {
        asked.set(asked.get() + 1);
        asked.get() > 30
    });
    assert_eq!(result.unwrap_err(), Stop::Cancelled);
    assert!(reported >= 29);
    assert!(
        fs::read_dir(&maps).unwrap().next().is_none(),
        "the maps folder is as it was"
    );
}

#[test]
fn replaces_a_pack_in_its_own_folder() {
    let dir = TempDir::new("packfile-replace");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.2.0");
    let file = dir.0.join("valley.atlaspack");
    run_export(&folder_source(&pack), Detail::Standard, &file).unwrap();
    // The maps folder has an older copy of the game under another name,
    // with an image the file does not have and page data.
    let maps = dir.0.join("maps");
    let mine = maps.join("My valley");
    write_pack(&mine, "1.0.0");
    put(&mine.join("tiles/a/3/0/0.png"), b"old top level");
    put(&mine.join("notes.txt"), b"mine");
    let imported = run_import(&file, &maps).unwrap();
    assert!(imported.replaced);
    assert_eq!(imported.folder, mine, "the folder keeps its name");
    let head = crate::manifest::read_head(&mine).unwrap();
    assert_eq!(head.pack_version, "1.2.0");
    assert!(
        !mine.join("tiles/a/3/0/0.png").exists(),
        "the map images are the file's"
    );
    assert!(!mine.join("notes.txt").exists() && !mine.join("import").exists());
    assert!(hidden_entries(&maps).is_empty(), "the old folder is gone");
    assert_eq!(fs::read_dir(&maps).unwrap().count(), 1);

    // Another app working on the pack: not replaced, nothing changes.
    let held = PackLock::acquire(&mine).unwrap();
    let error = run_import(&file, &maps).unwrap_err().message();
    assert!(error.contains("Another Atlas"), "{error}");
    drop(held);
    assert!(hidden_entries(&maps).is_empty());

    // A folder with the game's id that is not this game's pack.
    let other_maps = dir.0.join("other-maps");
    put(&other_maps.join(ID).join("readme.txt"), b"mine");
    let error = run_import(&file, &other_maps).unwrap_err().message();
    assert!(error.contains("not this game's pack"), "{error}");
    assert!(other_maps.join(ID).join("readme.txt").exists());
}

#[test]
fn a_failed_swap_puts_the_old_pack_back() {
    let dir = TempDir::new("packfile-swap");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.2.0");
    let file = dir.0.join("valley.atlaspack");
    run_export(&folder_source(&pack), Detail::Overview, &file).unwrap();
    let maps = dir.0.join("maps");
    let mine = maps.join(ID);
    write_pack(&mine, "1.0.0");
    // Renaming the unpacked folder into place keeps failing.
    let ops = FileOps {
        rename: Arc::new(|from: &Path, to: &Path| {
            if from
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(".importing-"))
            {
                Err(std::io::Error::other("in use"))
            } else {
                fs::rename(from, to)
            }
        }),
        retry_waits: vec![Duration::from_millis(1)],
        ..FileOps::default()
    };
    let error = import_with(&file, &maps, &ops, &|_| None, &mut |_| {}, &|| false)
        .unwrap_err()
        .message();
    assert!(error.contains("Could not move"), "{error}");
    assert_eq!(
        crate::manifest::read_head(&mine).unwrap().pack_version,
        "1.0.0"
    );
    assert!(
        hidden_entries(&maps).is_empty(),
        "{:?}",
        hidden_entries(&maps)
    );
}

#[test]
fn start_up_removes_imports_that_did_not_finish() {
    let dir = TempDir::new("packfile-leftover");
    let maps = dir.0.join("maps");
    put(&maps.join(".importing-test-valley/tiles/a/0/0/0.png"), b"x");
    let busy = maps.join(".importing-test-hills");
    fs::create_dir_all(&busy).unwrap();
    let held = PackLock::acquire(&busy).unwrap();
    let left = crate::removal::finish_pending_deletes(&FileOps::default(), &maps);
    assert_eq!(
        left,
        std::slice::from_ref(&busy),
        "one still being unpacked stays"
    );
    assert!(!maps.join(".importing-test-valley").exists());
    drop(held);
}

#[test]
fn writes_zip64_when_there_are_many_entries() {
    // More entries than the classic ZIP end record counts (65,535): the
    // ZIP64 end record must be written, and the file read back whole.
    let mut writer = PackWriter::new(Cursor::new(Vec::new()), zip::DateTime::default());
    writer.add(HEADER_FILE, true, &mut &b"{}"[..]).unwrap();
    let count = 70_000;
    for i in 0..count {
        writer
            .add(
                &format!("tiles/a/9/{}/{}.png", i / 300, i % 300),
                false,
                &mut &b"p"[..],
            )
            .unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    let zip64_end = [0x50, 0x4b, 0x06, 0x06];
    assert!(
        bytes.windows(4).any(|w| w == zip64_end),
        "a ZIP64 end record"
    );
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert_eq!(archive.len(), count + 1);
    assert_eq!(archive.name_for_index(0).unwrap().unwrap(), HEADER_FILE);
    let mut last = archive.by_index(count).unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut last, &mut text).unwrap();
    assert_eq!(text, "p");
}

#[test]
fn reads_iso_times() {
    assert_eq!(iso_millis("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        iso_millis("2026-11-10T21:30:00.000Z"),
        iso_millis("2026-11-10T21:30:00Z")
    );
    assert_eq!(
        iso_millis("2026-11-10T22:30:00+01:00"),
        iso_millis("2026-11-10T21:30:00Z")
    );
    assert_eq!(
        iso_millis("2026-01-01T00:00:00.5Z"),
        Some(1_767_225_600_500)
    );
    for bad in [
        "",
        "yesterday",
        "2026-11-10",
        "2026-13-10T00:00:00Z",
        "2026-11-10T21:30:00",
    ] {
        assert_eq!(iso_millis(bad), None, "{bad}");
    }
    assert_eq!(millis_to_iso(1_767_225_600_999), "2026-01-01T00:00:00Z");
}

// ---------------------------------------------------------------------------
// The maps library's rules

fn library_with(dir: &Path, bundled: Vec<BundledPack>) -> (Library, PackRegistry) {
    let registry = PackRegistry::default();
    let library = Library::new(
        SettingsFile::new(dir.join("shared")),
        registry.clone(),
        bundled,
        Vec::new(),
    );
    (library, registry)
}

#[test]
fn games_that_come_with_the_app_are_imported_only_when_newer() {
    let dir = TempDir::new("packfile-bundled");
    let resources = dir.0.join("resources/test-valley");
    write_pack_files(&resources, "1.1.0");
    let downloads_dir = dir.0.join("data");
    for (downloadable, file_version, outcome) in [
        (false, "1.0.0", Err("newer than the version 1.0.0")),
        (false, "1.1.0", Err("nothing to import")),
        (false, "1.2.0", Ok(())),
        (true, "1.0.0", Err("newer than the version 1.0.0")),
        (true, "1.1.0", Ok(())),
    ] {
        let (library, registry) = library_with(
            &dir.0.join(format!("lib-{downloadable}-{file_version}")),
            vec![BundledPack {
                id: ID.into(),
                path: resources.clone(),
                downloadable,
            }],
        );
        let downloads = crate::downloads::for_tests(&registry, downloads_dir.clone());
        let mut header = read_header(&{
            let pack = dir.0.join(format!("src-{file_version}"));
            if !pack.exists() {
                write_pack(&pack, file_version);
            }
            let file = dir.0.join(format!("v{file_version}.atlaspack"));
            if !file.exists() {
                run_export(&folder_source(&pack), Detail::Overview, &file).unwrap();
            }
            file
        })
        .unwrap();
        header.pack_version = file_version.into();
        let result = shell::check_import(&library, &downloads, &header);
        match outcome {
            Ok(()) => assert!(result.is_ok(), "{downloadable} {file_version}: {result:?}"),
            Err(text) => {
                let error = result.unwrap_err();
                assert!(
                    error.contains(text),
                    "{downloadable} {file_version}: {error}"
                );
            }
        }
    }
}

#[test]
fn imports_into_the_maps_folder_and_asks_before_replacing() {
    let dir = TempDir::new("packfile-library");
    let (library, registry) = library_with(&dir.0, Vec::new());
    let downloads = crate::downloads::for_tests(&registry, dir.0.join("data"));
    let pack = dir.0.join("source");
    write_pack(&pack, "1.0.0");
    let file = dir.0.join("valley.atlaspack");
    run_export(&folder_source(&pack), Detail::Overview, &file).unwrap();

    let info = shell::inspect(&library, &downloads, &file).unwrap();
    assert!(info.installed.is_none() && !info.replaces && info.blocked.is_none());
    assert_eq!(info.header.pack_id, ID);
    let imported =
        shell::import_pack_file(&library, &downloads, &file, false, &mut |_| {}, &|| false)
            .unwrap();
    assert_eq!(imported.folder, library.maps_folder().join(ID));
    let listing = library.scan();
    assert_eq!(listing.packs.len(), 1);

    let info = shell::inspect(&library, &downloads, &file).unwrap();
    assert!(info.replaces);
    let installed = info.installed.unwrap();
    let details = installed.details.unwrap();
    assert_eq!(details.detail, Some(Detail::Overview));
    assert_eq!(details.pack_file.unwrap().header.pack_id, ID);
    // The page data is not in the file; the manifest's pages are.
    assert_eq!(
        details.source.newest_page_at.as_deref(),
        Some("2026-11-10T21:30:00.000Z")
    );
    assert_eq!(details.contents.checklists, 1);
    let error = shell::import_pack_file(&library, &downloads, &file, false, &mut |_| {}, &|| false)
        .unwrap_err();
    assert!(error.message().contains("already in the maps folder"));
    shell::import_pack_file(&library, &downloads, &file, true, &mut |_| {}, &|| false).unwrap();

    // Only `.atlaspack` files, and only files that exist.
    let renamed = dir.0.join("valley.zip");
    fs::copy(&file, &renamed).unwrap();
    assert!(shell::inspect(&library, &downloads, &renamed)
        .unwrap_err()
        .contains(".atlaspack"));
    assert!(
        shell::inspect(&library, &downloads, &PathBuf::from("/no/such.atlaspack"))
            .unwrap_err()
            .contains("cannot be found")
    );
}

/// A file read only in order, like one Android's picker opens from a cloud
/// drive: no seeking.
struct InOrder(fs::File);

impl std::io::Read for InOrder {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

#[test]
fn a_picked_file_is_read_in_order_copied_and_imported_from_the_copy() {
    use crate::picked;

    let dir = TempDir::new("packfile-picked");
    let (library, registry) = library_with(&dir.0, Vec::new());
    let downloads = crate::downloads::for_tests(&registry, dir.0.join("data"));
    let pack = dir.0.join("source");
    write_pack(&pack, "1.0.0");
    let file = dir
        .0
        .join("Download")
        .join("Test Valley (standard).atlaspack");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let exported = run_export(&folder_source(&pack), Detail::Standard, &file).unwrap();

    // What the picker step reads: the header, from the start of the file.
    let header = import::read_header_from(InOrder(fs::File::open(&file).unwrap())).unwrap();
    assert_eq!(header, exported.header);
    let size = Some(exported.size);
    assert!(picked::check_room(size, &header, Some(u64::MAX)).is_ok());
    assert!(picked::check_room(size, &header, Some(exported.size)).is_err());
    assert!(
        import::read_header_from(InOrder(fs::File::open(pack.join("manifest.json")).unwrap()))
            .unwrap_err()
            .contains("not an Atlas pack file")
    );

    // The copy keeps the picked file's name, so the import dialog and the
    // game's record name it.
    let copies = dir.0.join("cache").join(picked::COPIES_DIR);
    let name = picked::copy_name(Some("Test Valley (standard).atlaspack"));
    let mut last = 0;
    let copy = picked::copy_in(
        &mut InOrder(fs::File::open(&file).unwrap()),
        &copies,
        &name,
        &mut |done| last = done,
        &|| false,
    )
    .unwrap();
    assert_eq!(last, exported.size);
    assert_eq!(fs::read(&copy).unwrap(), fs::read(&file).unwrap());

    let info = shell::inspect(&library, &downloads, &copy).unwrap();
    assert_eq!(info.file_name, "Test Valley (standard).atlaspack");
    assert!(info.blocked.is_none() && !info.replaces);
    shell::import_pack_file(&library, &downloads, &copy, false, &mut |_| {}, &|| false).unwrap();
    // The Maps screen lists it again, then reads its details.
    assert_eq!(library.scan().packs.len(), 1);
    let details = shell::details(&library, &downloads, ID).unwrap();
    assert_eq!(details.detail, Some(Detail::Standard));
    let record = details.pack_file.unwrap();
    assert_eq!(record.file_name, "Test Valley (standard).atlaspack");
    assert_eq!(record.header.bytes, header.bytes);

    // Once the import is over the copy goes; the picked file stays.
    assert_eq!(picked::discard(&copies, &copy), Ok(true));
    assert!(!copy.exists() && file.exists());
    assert_eq!(fs::read_dir(&copies).unwrap().count(), 0);
}

// ---------------------------------------------------------------------------
// A person's own lists, locations and types in the file

fn own_lists_text(game: &str) -> String {
    json!({"format": "atlas-own-lists", "version": 1, "gameId": game, "updatedAt": "2026-11-12T09:00:00Z",
           "lists": [{"checklist": {"id": format!("{game}:checklist:own.trail")}}]})
    .to_string()
}

fn own_locations_text(game: &str) -> String {
    json!({"format": "atlas-own-locations", "version": 1, "gameId": game, "updatedAt": "2026-11-12T09:00:00Z",
           "categoryGroups": [{"id": format!("{game}:catgroup:own.mine"), "name": "My types", "order": 9}],
           "categories": [{"id": format!("{game}:cat:own.well"), "groupId": format!("{game}:catgroup:own.mine"), "name": "Well"}],
           "regions": [],
           "locations": [
               {"id": format!("{game}:loc:own.a"), "mapId": format!("{game}:map:east"), "layerId": format!("{game}:layer:a"), "x": 10, "y": 20, "categoryId": format!("{game}:cat:own.well"), "regionId": null, "name": "Old well"},
               {"id": format!("{game}:loc:own.b"), "mapId": format!("{game}:map:east"), "layerId": format!("{game}:layer:a"), "x": 30, "y": 40, "categoryId": format!("{game}:cat:own.well"), "regionId": null, "name": "New well"}
           ]})
    .to_string()
}

fn export_mine(
    source: &PackSource,
    destination: &Path,
    mine: &Mine,
) -> Result<export::Exported, Stop> {
    export::export_with_mine(
        source,
        &app(),
        Detail::Overview,
        destination,
        mine,
        &mut |_| {},
        &|| false,
    )
}

#[test]
fn carries_own_lists_and_locations_only_when_asked() {
    let dir = TempDir::new("packfile-mine");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let source = folder_source(&pack);

    // Without them: version 1, nothing under mine/, nothing handed back.
    let plain = dir.0.join("plain.atlaspack");
    let exported = run_export(&source, Detail::Overview, &plain).unwrap();
    assert_eq!(exported.header.version, VERSION_WITHOUT_MINE);
    assert_eq!(exported.header.mine, None);
    assert!(json_entry(&plain, HEADER_FILE).get("mine").is_none());
    assert!(entry_names(&plain)
        .keys()
        .all(|name| !name.starts_with("mine/")));
    let imported = run_import(&plain, &dir.0.join("maps-plain")).unwrap();
    assert!(imported.mine.is_empty());

    // With them: version 2, counted in the header, handed back as they were
    // and never written into the pack's folder.
    let mine = Mine {
        lists: Some(own_lists_text(ID)),
        locations: Some(own_locations_text(ID)),
        ..Mine::default()
    };
    let file = dir.0.join("mine.atlaspack");
    let exported = export_mine(&source, &file, &mine).unwrap();
    assert_eq!(exported.header.version, VERSION_WITH_MINE);
    assert_eq!(
        exported.header.mine,
        Some(MineFacts {
            lists: 1,
            locations: 2,
            types: 1,
            areas: 0,
            ..MineFacts::default()
        })
    );
    let names = entry_names(&file);
    assert!(names.contains_key("mine/my-lists.json"));
    assert!(names.contains_key("mine/my-locations.json"));
    assert_eq!(read_header(&file).unwrap(), exported.header);
    let maps = dir.0.join("maps-mine");
    let imported = run_import(&file, &maps).unwrap();
    assert_eq!(imported.mine, mine);
    assert!(!maps.join(ID).join("mine").exists());
    assert!(files_under(&maps).keys().all(|name| !name.contains("my-")));
    // The pack itself is the same as without them.
    let plain_pack = files_under(&dir.0.join("maps-plain").join(ID));
    let mine_pack = files_under(&maps.join(ID));
    assert_eq!(
        plain_pack
            .keys()
            .filter(|n| !n.starts_with(".atlas"))
            .collect::<Vec<_>>(),
        mine_pack
            .keys()
            .filter(|n| !n.starts_with(".atlas"))
            .collect::<Vec<_>>()
    );

    // Only lists: only that file.
    let lists_only = Mine {
        lists: Some(own_lists_text(ID)),
        ..Mine::default()
    };
    let file = dir.0.join("lists.atlaspack");
    let exported = export_mine(&source, &file, &lists_only).unwrap();
    assert_eq!(
        exported.header.mine,
        Some(MineFacts {
            lists: 1,
            ..MineFacts::default()
        })
    );
    assert!(!entry_names(&file).contains_key("mine/my-locations.json"));
    assert_eq!(
        run_import(&file, &dir.0.join("maps-lists")).unwrap().mine,
        lists_only
    );
}

#[test]
fn refuses_own_files_of_another_game() {
    let dir = TempDir::new("packfile-mine-refuse");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    // Not exported.
    let other = Mine {
        locations: Some(own_locations_text("another-game")),
        ..Mine::default()
    };
    let file = dir.0.join("other.atlaspack");
    let error = export_mine(&folder_source(&pack), &file, &other)
        .unwrap_err()
        .message();
    assert!(error.contains("not this game's"), "{error}");
    assert!(!file.exists() && !part_path(&file).exists());
    // Not imported either, and nothing is left behind.
    let (mut header, mut entries) = good_file(&dir.0);
    header["version"] = json!(VERSION);
    entries.push((
        "mine/my-locations.json".to_owned(),
        own_locations_text("another-game").into_bytes(),
    ));
    let error = import_error(&dir.0, "other-game", &header, &entries);
    assert!(error.contains("not this game's"), "{error}");
    let (header, mut entries) = good_file(&dir.0);
    entries.push(("mine/my-lists.json".to_owned(), b"not json".to_vec()));
    let error = import_error(&dir.0, "not-json", &header, &entries);
    assert!(error.contains("my-lists.json"), "{error}");
    // Anything else under mine/ has no place in a pack.
    let (header, mut entries) = good_file(&dir.0);
    entries.push(("mine/notes.json".to_owned(), b"{}".to_vec()));
    let error = import_error(&dir.0, "other-entry", &header, &entries);
    assert!(error.contains("not part of a pack"), "{error}");
}

#[test]
fn exports_the_own_files_beside_the_game() {
    let dir = TempDir::new("packfile-mine-library");
    let (library, registry) = library_with(&dir.0, Vec::new());
    let maps = library.maps_folder();
    write_pack(&maps.join(ID), "1.0.0");
    library.scan();
    crate::ownlists::LOCATIONS
        .write(&maps, ID, &own_locations_text(ID), None)
        .unwrap();
    let downloads = crate::downloads::for_tests(&registry, dir.0.join("data"));
    let export = |name: &str, include: bool| {
        shell::export_pack_with_mine(
            &library,
            &downloads,
            ID,
            &app(),
            Detail::Overview,
            &dir.0.join(name),
            include,
            false,
            false,
            &mut |_| {},
            &|| false,
        )
        .unwrap()
    };
    let with = export("with.atlaspack", true);
    assert_eq!(with.header.mine.map(|m| m.locations), Some(2));
    assert!(entry_names(&dir.0.join("with.atlaspack")).contains_key("mine/my-locations.json"));
    assert!(!entry_names(&dir.0.join("with.atlaspack")).contains_key("mine/my-lists.json"));
    let without = export("without.atlaspack", false);
    assert_eq!(without.header.mine, None);
    assert_eq!(without.header.version, VERSION_WITHOUT_MINE);
}

#[test]
fn the_game_goes_by_its_group_title_with_or_without_own_files() {
    let dir = TempDir::new("packfile-group-title");
    let (library, registry) = library_with(&dir.0, Vec::new());
    let maps = library.maps_folder();
    write_pack(&maps.join(ID), "1.0.0");
    library.scan();
    crate::gamegroups::write(
        &maps,
        &format!(
            r#"{{"format":"atlas-game-groups","version":1,"groups":[{{"id":"g","title":"Isles","members":[{{"gameId":"other"}},{{"gameId":"{ID}"}}]}}]}}"#
        ),
        None,
    )
    .unwrap();
    let downloads = crate::downloads::for_tests(&registry, dir.0.join("data"));
    let export = |name: &str, include: bool| {
        shell::export_pack_with_mine(
            &library,
            &downloads,
            ID,
            &app(),
            Detail::Overview,
            &dir.0.join(name),
            include,
            false,
            false,
            &mut |_| {},
            &|| false,
        )
        .unwrap()
    };
    // Without the person's own files the title still names the game, but
    // the group, with the other games' ids, stays out of the file.
    let without = export("without.atlaspack", false);
    assert_eq!(without.header.game.unwrap().title, "Isles");
    assert_eq!(without.header.mine, None);
    assert_eq!(without.header.version, VERSION_WITHOUT_MINE);
    assert!(!entry_names(&dir.0.join("without.atlaspack")).contains_key("mine/game-group.json"));
    // With them, the same title, and the group goes in.
    let with = export("with.atlaspack", true);
    assert_eq!(with.header.game.unwrap().title, "Isles");
    assert_eq!(with.header.version, VERSION_WITH_TITLE);
    assert!(entry_names(&dir.0.join("with.atlaspack")).contains_key("mine/game-group.json"));
    // Out of the group, the pack's own title.
    crate::gamegroups::write(
        &maps,
        r#"{"format":"atlas-game-groups","version":1,"groups":[]}"#,
        None,
    )
    .unwrap();
    let alone = export("alone.atlaspack", false);
    assert_eq!(alone.header.game.unwrap().title, "Test Valley");
}

#[test]
fn carries_own_photos_and_guide_links_when_asked() {
    let dir = TempDir::new("packfile-mine-photos");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let source = folder_source(&pack);
    let jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
    let links = format!(r#"{{"format":"atlas-guide-links","version":1,"gameId":"{ID}"}}"#);
    let mine = Mine {
        lists: Some(own_lists_text(ID)),
        guide_links: Some(links.clone()),
        pictures: vec![("own.ab12.jpg".to_owned(), jpeg.clone())],
        ..Mine::default()
    };
    let file = dir.0.join("photos.atlaspack");
    let exported = export_mine(&source, &file, &mine).unwrap();
    // Only an app that knows photos and links reads it.
    assert_eq!(exported.header.version, VERSION_WITH_PHOTOS);
    let facts = exported.header.mine.unwrap();
    assert_eq!((facts.lists, facts.photos, facts.guide_links), (1, 1, true));
    let names = entry_names(&file);
    assert!(names.contains_key("mine/pictures/own.ab12.jpg"));
    assert!(names.contains_key("mine/guide-links.json"));
    let maps = dir.0.join("maps-photos");
    let imported = run_import(&file, &maps).unwrap();
    assert_eq!(imported.mine, mine);
    // Never written into the pack's folder.
    assert!(files_under(&maps).keys().all(|name| !name.contains("own.")));

    // A photo that is not the picture its name says, or with a name no own
    // photo has, is refused; nothing is left behind.
    let (mut header, mut entries) = good_file(&dir.0);
    header["version"] = json!(VERSION);
    entries.push(("mine/pictures/own.ab12.png".to_owned(), jpeg.clone()));
    let error = import_error(&dir.0, "wrong-photo", &header, &entries);
    assert!(error.contains("not the picture"), "{error}");
    let (header, mut entries) = good_file(&dir.0);
    entries.push(("mine/pictures/gate.jpg".to_owned(), jpeg.clone()));
    let error = import_error(&dir.0, "not-own-photo", &header, &entries);
    assert!(error.contains("not part of a pack"), "{error}");
    // A photo is never exported unless it is one.
    let bad = Mine {
        pictures: vec![("own.ab12.png".to_owned(), jpeg)],
        ..Mine::default()
    };
    assert!(export_mine(&source, &dir.0.join("bad.atlaspack"), &bad).is_err());
}

#[test]
fn carries_own_pages_as_version_4_without_notes() {
    let dir = TempDir::new("packfile-mine-pages");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let source = folder_source(&pack);
    let pages = format!(
        r#"{{"format":"atlas-own-pages","version":1,"gameId":"{ID}","pages":[{{"id":"{ID}:guide:own.a","title":"A","body":"x","updatedAt":"2026-11-13T10:00:00.000Z"}}],"sections":[]}}"#
    );
    let mine = Mine {
        lists: Some(own_lists_text(ID)),
        pages: Some(pages.clone()),
        ..Mine::default()
    };
    let file = dir.0.join("pages.atlaspack");
    let exported = export_mine(&source, &file, &mine).unwrap();
    assert_eq!(exported.header.version, VERSION_WITH_PAGES);
    let facts = exported.header.mine.unwrap();
    assert_eq!((facts.lists, facts.pages, facts.sections), (1, 1, 0));
    assert!(entry_names(&file).contains_key("mine/my-pages.json"));
    let maps = dir.0.join("maps-pages");
    let imported = run_import(&file, &maps).unwrap();
    assert_eq!(imported.mine, mine);
    assert!(files_under(&maps).keys().all(|name| !name.contains("my-")));
    // Another game's pages are refused.
    let other = Mine {
        pages: Some(pages.replace(&format!("\"gameId\":\"{ID}\""), "\"gameId\":\"x\"")),
        ..Mine::default()
    };
    assert!(export_mine(&source, &dir.0.join("other.atlaspack"), &other).is_err());
    // Photos without pages stay version 3, for apps from before pages.
    assert_eq!(
        Mine {
            pictures: vec![("own.ab12.jpg".to_owned(), Vec::new())],
            ..Mine::default()
        }
        .version(),
        VERSION_WITH_PHOTOS
    );
}

#[test]
fn carries_own_notes_as_version_5() {
    let dir = TempDir::new("packfile-mine-notes");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let source = folder_source(&pack);
    let notes = format!(
        r#"{{"format":"atlas-own-notes","version":1,"gameId":"{ID}","updatedAt":"2026-11-14T10:00:00.000Z","notes":{{"{ID}:loc:a":{{"text":"x","name":"A","updatedAt":"2026-11-14T10:00:00.000Z"}},"{ID}:loc:b":{{"text":"y","name":"B","updatedAt":"2026-11-14T10:00:00.000Z"}}}}}}"#
    );
    let mine = Mine {
        notes: Some(notes.clone()),
        ..Mine::default()
    };
    let file = dir.0.join("notes.atlaspack");
    let exported = export_mine(&source, &file, &mine).unwrap();
    // Only an app that knows notes reads it.
    assert_eq!(exported.header.version, VERSION_WITH_NOTES);
    assert_eq!(exported.header.mine.unwrap().notes, 2);
    assert!(entry_names(&file).contains_key("mine/my-notes.json"));
    let maps = dir.0.join("maps-notes");
    let imported = run_import(&file, &maps).unwrap();
    assert_eq!(imported.mine, mine);
    assert!(files_under(&maps).keys().all(|name| !name.contains("my-")));
    // Another game's notes are refused.
    let other = Mine {
        notes: Some(notes.replace(&format!("\"gameId\":\"{ID}\""), "\"gameId\":\"x\"")),
        ..Mine::default()
    };
    assert!(export_mine(&source, &dir.0.join("other.atlaspack"), &other).is_err());
    // Guide links that link a page to one location alone need version 5 too;
    // other guide links stay version 3.
    let links = |version: u32| Mine {
        guide_links: Some(format!(
            r#"{{"format":"atlas-guide-links","version":{version},"gameId":"{ID}"}}"#
        )),
        ..Mine::default()
    };
    assert_eq!(links(2).version(), VERSION_WITH_NOTES);
    assert_eq!(links(1).version(), VERSION_WITH_PHOTOS);
}

#[test]
fn carries_the_title_of_the_game_as_version_6() {
    let dir = TempDir::new("packfile-mine-group");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let source = folder_source(&pack);
    // The title it shares, read from the file of the maps folder.
    let maps = dir.0.join("maps-here");
    std::fs::create_dir_all(&maps).unwrap();
    crate::gamegroups::write(
        &maps,
        &format!(
            r#"{{"format":"atlas-game-groups","version":1,"groups":[{{"id":"g","title":"Isles","members":[{{"gameId":"other"}},{{"gameId":"{ID}"}}]}}]}}"#
        ),
        None,
    )
    .unwrap();
    let mine = Mine::read(&maps, ID).unwrap();
    let group = mine.group.clone().unwrap();
    assert!(group.contains("\"format\": \"atlas-game-group\""));
    assert_eq!(mine.version(), VERSION_WITH_TITLE);
    let file = dir.0.join("group.atlaspack");
    let exported = export_mine(&source, &file, &mine).unwrap();
    // Only an app that knows titles reads it.
    assert_eq!(exported.header.version, VERSION_WITH_TITLE);
    assert!(exported.header.mine.unwrap().group);
    assert!(entry_names(&file).contains_key("mine/game-group.json"));
    let imported = run_import(&file, &dir.0.join("maps-there")).unwrap();
    assert_eq!(imported.mine.group, Some(group.clone()));
    // Another game's title is refused.
    let other = Mine {
        group: Some(group.replace(
            &format!("\"gameId\": \"{ID}\",\n  \"updatedAt"),
            "\"gameId\": \"other\",\n  \"updatedAt",
        )),
        ..Mine::default()
    };
    assert_ne!(other.group, mine.group);
    assert!(export_mine(&source, &dir.0.join("other.atlaspack"), &other).is_err());
    // Without a title, a file with notes stays version 5.
    let notes = Mine {
        notes: Some(format!(
            r#"{{"format":"atlas-own-notes","version":1,"gameId":"{ID}","notes":{{}}}}"#
        )),
        ..Mine::default()
    };
    assert_eq!(notes.version(), VERSION_WITH_NOTES);
    assert_eq!(Mine::default().version(), VERSION_WITH_MINE);
}

#[test]
fn reads_the_photos_the_own_files_name() {
    let dir = TempDir::new("packfile-mine-read");
    let maps = dir.0.join("maps");
    std::fs::create_dir_all(&maps).unwrap();
    let jpeg = [0xff, 0xd8, 0xff, 0xe0, 1];
    crate::ownpictures::write(&maps, ID, "own.a.jpg", &jpeg).unwrap();
    crate::ownpictures::write(&maps, ID, "own.unused.jpg", &jpeg).unwrap();
    let locations = own_locations_text(ID).replacen(
        "\"locations\":",
        "\"pictures\":[{\"id\":\"x:picture:own.a\",\"file\":\"pictures/own.a.jpg\",\"shareable\":true}],\"locations\":",
        1,
    );
    crate::ownlists::LOCATIONS
        .write(&maps, ID, &locations, None)
        .unwrap();
    let mine = Mine::read(&maps, ID).unwrap();
    assert_eq!(mine.pictures, vec![("own.a.jpg".to_owned(), jpeg.to_vec())]);
    // The photos the notes show too.
    crate::ownpictures::write(&maps, ID, "own.n.jpg", &jpeg).unwrap();
    let notes = format!(
        r#"{{"format":"atlas-own-notes","version":1,"gameId":"{ID}","updatedAt":"2026-11-14T10:00:00.000Z","notes":{{}},"pictures":[{{"id":"{ID}:picture:own.n","file":"pictures/own.n.jpg","shareable":true}}]}}"#
    );
    crate::ownlists::NOTES
        .write(&maps, ID, &notes, None)
        .unwrap();
    let mine = Mine::read(&maps, ID).unwrap();
    assert_eq!(mine.notes, Some(notes));
    assert_eq!(
        mine.pictures
            .iter()
            .map(|(file, _)| file.as_str())
            .collect::<Vec<_>>(),
        vec!["own.a.jpg", "own.n.jpg"]
    );
}

// ---------------------------------------------------------------------------
// A game with no map, and the pictures its guides show

/// A game of guides only: no `maps.json` or `layers.json`, three pictures:
/// one to pass on, one kept for the person's own use, and one to pass on
/// whose file is not there.
fn write_pages_pack(dir: &Path) {
    put_json(
        &dir.join(MANIFEST_FILE),
        &json!({"schemaVersion": 2, "gameId": ID, "title": "Test Pages", "packVersion": "1.0.0",
                "gamePatch": "1", "attribution": [{"name": "Example Wiki", "license": "CC BY-SA 4.0"}],
                "idMigrations": {}}),
    );
    put_json(
        &dir.join("guides.json"),
        &json!([{"id": format!("{ID}:guide:start"), "title": "Start", "locationIds": [],
                 "body": format!("![A gate]({ID}:picture:gate) ![Mine]({ID}:picture:own)")}]),
    );
    put_json(
        &dir.join("sections.json"),
        &json!([{"id": format!("{ID}:section:basics"), "title": "Basics", "items": [format!("{ID}:guide:start")]}]),
    );
    put_json(
        &dir.join("pictures.json"),
        &json!([
            {"id": format!("{ID}:picture:gate"), "file": "pictures/gate.png", "shareable": true},
            {"id": format!("{ID}:picture:own"), "file": "pictures/own.png", "shareable": false},
            {"id": format!("{ID}:picture:gone"), "file": "pictures/gone.png", "shareable": true},
            {"id": format!("{ID}:picture:far"), "file": "pictures/far.jpg", "shareable": false,
             "remote": "https://pictures.example.com/far.jpg"}
        ]),
    );
    put(&dir.join("pictures/gate.png"), b"gate picture");
    put(&dir.join("pictures/own.png"), b"my own picture");
    // Downloaded for the person's own use: listed in a file, never carried.
    put(&dir.join("pictures/far.jpg"), b"downloaded picture");
}

#[test]
fn exports_a_game_with_no_map_and_only_the_pictures_it_may_pass_on() {
    let dir = TempDir::new("packfile-pages");
    let pack = dir.0.join("pages");
    write_pages_pack(&pack);
    let options = export_options(&folder_source(&pack)).unwrap();
    assert!(options.exportable, "{:?}", options.reason);
    assert!(options.details.iter().all(|option| option.available));

    let file = dir.0.join("pages.atlaspack");
    run_export(&folder_source(&pack), Detail::Overview, &file).unwrap();
    let names = entry_names(&file);
    assert!(names.contains_key("pictures/gate.png"), "{names:?}");
    assert!(!names.keys().any(|name| name.contains("own")), "{names:?}");
    assert!(!names.contains_key("maps.json") && !names.contains_key("layers.json"));
    assert!(names.contains_key("sections.json"));
    let listed = json_entry(&file, "pictures.json");
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["file"].as_str().unwrap())
            .collect::<Vec<_>>(),
        // The picture fetched later stays listed, so it can be fetched again.
        ["pictures/gate.png", "pictures/far.jpg"]
    );
    assert!(!names.contains_key("pictures/far.jpg"));
    let header = json_entry(&file, HEADER_FILE);
    assert_eq!(header["contents"]["maps"], 0);
    assert_eq!(header["contents"]["guides"], 1);

    // Opened on another device: the game, its contents and its shared picture.
    let maps = dir.0.join("maps");
    let imported = run_import(&file, &maps).unwrap();
    let files = files_under(&imported.folder);
    assert_eq!(files["pictures/gate.png"], b"gate picture");
    assert!(!files.contains_key("pictures/own.png"));
    assert!(files.contains_key("sections.json"));
    assert!(!files.contains_key("maps.json"));
}

#[test]
fn carries_the_pictures_kept_for_own_use_only_when_asked() {
    let dir = TempDir::new("packfile-own-use");
    let pack = dir.0.join("pages");
    write_pages_pack(&pack);
    // Offered: the two pictures kept for the person's own use whose files are here.
    let options = export_options(&folder_source(&pack)).unwrap();
    assert_eq!(options.own_use_pictures, 2);
    assert_eq!(
        options.own_use_picture_bytes,
        (b"my own picture".len() + b"downloaded picture".len()) as u64
    );

    let file = dir.0.join("pages.atlaspack");
    let source = PackSource {
        own_use_pictures: true,
        ..folder_source(&pack)
    };
    run_export(&source, Detail::Overview, &file).unwrap();
    let names = entry_names(&file);
    for carried in ["pictures/gate.png", "pictures/own.png", "pictures/far.jpg"] {
        assert!(names.contains_key(carried), "{carried}: {names:?}");
    }
    assert!(!names.contains_key("pictures/gone.png"));
    // Still marked as kept for the person's own use, with where each came from.
    let listed = json_entry(&file, "pictures.json");
    let far = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["file"] == "pictures/far.jpg")
        .unwrap();
    assert_eq!(far["shareable"], false);
    assert_eq!(far["remote"], "https://pictures.example.com/far.jpg");

    // Opened on another device: the photos are there, nothing to download.
    let imported = run_import(&file, &dir.0.join("maps")).unwrap();
    let files = files_under(&imported.folder);
    assert_eq!(files["pictures/far.jpg"], b"downloaded picture");
    assert_eq!(files["pictures/own.png"], b"my own picture");

    // A pack with no pictures offers none.
    let plain = dir.0.join("plain");
    write_pack(&plain, "1.0.0");
    assert_eq!(
        export_options(&folder_source(&plain))
            .unwrap()
            .own_use_pictures,
        0
    );
}

#[test]
fn refuses_pictures_the_pack_does_not_list() {
    let dir = TempDir::new("packfile-pages-refusals");
    let pack = dir.0.join("pages");
    write_pages_pack(&pack);
    let file = dir.0.join("pages.atlaspack");
    run_export(&folder_source(&pack), Detail::Overview, &file).unwrap();
    let header = json_entry(&file, HEADER_FILE);
    let mut archive = ZipArchive::new(fs::File::open(&file).unwrap()).unwrap();
    let mut entries = Vec::new();
    for i in 1..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
        entries.push((entry.name().unwrap().into_owned(), bytes));
    }
    for (name, extra) in [
        ("unlisted", "pictures/own.png"),
        ("not-a-picture", "pictures/notes.txt"),
    ] {
        let mut spoilt = entries.clone();
        spoilt.push((extra.to_owned(), b"x".to_vec()));
        let error = import_error(&dir.0, name, &header, &spoilt);
        assert!(error.contains("not part of a pack"), "{name}: {error}");
    }
    // A picture listed with a path outside the folder is not one either.
    let mut spoilt = entries.clone();
    for (name, bytes) in &mut spoilt {
        if name == "pictures.json" {
            *bytes =
                br#"[{"id":"x","file":"pictures/../manifest.json","shareable":true}]"#.to_vec();
        }
    }
    spoilt.push(("pictures/../evil.png".to_owned(), b"x".to_vec()));
    let error = import_error(&dir.0, "outside", &header, &spoilt);
    assert!(
        error.contains("not part of a pack") || error.contains("outside"),
        "{error}"
    );
}

#[test]
fn tells_picture_paths_from_other_paths() {
    for good in [
        "pictures/a.png",
        "pictures/gate-1.jpeg",
        "pictures/x_y.z.webp",
        "pictures/9.gif",
    ] {
        assert!(is_picture_path(good), "{good}");
    }
    for bad in [
        "pictures/.png",
        "pictures/.hidden.png",
        "pictures/a.svg",
        "pictures/sub/a.png",
        "pictures/../a.png",
        "tiles/a.png",
        "pictures/a.PNG",
        "pictures/a b.png",
    ] {
        assert!(!is_picture_path(bad), "{bad}");
    }
}

/// The bytes of one entry of a pack file.
#[cfg(not(target_os = "android"))]
fn entry_bytes(file: &Path, name: &str) -> Vec<u8> {
    let mut archive = ZipArchive::new(fs::File::open(file).unwrap()).unwrap();
    let mut entry = archive.by_name(name).unwrap();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
    bytes
}

/// A game of pages with real pictures of every sort, kept at full size,
/// one of them with a copy for pages.
#[cfg(not(target_os = "android"))]
fn write_full_size_pack(dir: &Path) {
    use super::smaller::tests::{encoded, photo};
    use image::ImageFormat;
    write_pages_pack(dir);
    let pictures = [
        (
            "photo",
            "pictures/photo.png",
            photo(3000, 2000, false),
            ImageFormat::Png,
        ),
        (
            "clear",
            "pictures/clear.png",
            photo(2000, 1000, true),
            ImageFormat::Png,
        ),
        (
            "icon",
            "pictures/icon.png",
            photo(64, 64, false),
            ImageFormat::Png,
        ),
        (
            "shot",
            "pictures/shot.jpg",
            photo(2560, 1440, false),
            ImageFormat::Jpeg,
        ),
        (
            "small",
            "pictures/small.jpg",
            photo(800, 600, false),
            ImageFormat::Jpeg,
        ),
        // Its JPEG name is taken by the picture after it.
        (
            "taken",
            "pictures/taken.png",
            photo(1600, 900, false),
            ImageFormat::Png,
        ),
        (
            "other",
            "pictures/taken.jpg",
            photo(400, 300, false),
            ImageFormat::Jpeg,
        ),
    ];
    let mut list =
        serde_json::from_slice::<Vec<Value>>(&fs::read(dir.join("pictures.json")).unwrap())
            .unwrap();
    for (id, file, image, format) in pictures {
        put(&dir.join(file), &encoded(&image, format));
        list.push(
            json!({"id": format!("{ID}:picture:{id}"), "file": file, "shareable": true,
                         "width": image.width(), "height": image.height()}),
        );
    }
    list.last_mut().unwrap()["caption"] = json!("Another picture");
    // The photo has a copy for pages and was shown at another address.
    let photo = list
        .iter_mut()
        .find(|p| p["file"] == "pictures/photo.png")
        .unwrap();
    photo["pageCopy"] = json!({"file": "pictures/photo.page.png", "width": 320});
    photo["shownAt"] = json!("https://pictures.example.com/photo-small.png");
    put(
        &dir.join("pictures/photo.page.png"),
        &encoded(
            &super::smaller::tests::photo(640, 427, false),
            ImageFormat::Png,
        ),
    );
    put_json(&dir.join("pictures.json"), &Value::Array(list));
}

#[cfg(not(target_os = "android"))]
#[test]
fn makes_the_pictures_in_the_file_smaller_only_when_asked_and_never_those_here() {
    use super::smaller::tests::read;
    use image::ImageFormat;
    let dir = TempDir::new("packfile-smaller");
    let pack = dir.0.join("pages");
    write_full_size_pack(&pack);
    let before = files_under(&pack);
    let kept = |files: BTreeMap<String, Vec<u8>>| {
        files
            .into_iter()
            .filter(|(name, _)| !name.starts_with(".atlas/"))
            .collect::<BTreeMap<_, _>>()
    };
    let options = export_options(&folder_source(&pack)).unwrap();
    // Every picture to pass on whose file is here: gate and the seven above.
    assert_eq!(options.pictures, 8);
    let on_disk: u64 = [
        "photo.png",
        "clear.png",
        "icon.png",
        "shot.jpg",
        "small.jpg",
        "taken.png",
        "taken.jpg",
        "gate.png",
    ]
    .iter()
    .map(|name| {
        fs::metadata(pack.join("pictures").join(name))
            .unwrap()
            .len()
    })
    .sum();
    assert_eq!(options.picture_bytes, on_disk);

    // Full size: the files as they are; the copy for pages is never carried.
    let full = dir.0.join("full.atlaspack");
    run_export(&folder_source(&pack), Detail::Overview, &full).unwrap();
    let names = entry_names(&full);
    assert!(
        !names.keys().any(|name| name.contains(".page.")),
        "{names:?}"
    );
    assert_eq!(
        entry_bytes(&full, "pictures/photo.png"),
        before["pictures/photo.png"]
    );
    let listed = json_entry(&full, "pictures.json");
    let photo = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["file"] == "pictures/photo.png")
        .unwrap();
    assert!(photo.get("pageCopy").is_none(), "{photo}");
    assert_eq!(
        photo["shownAt"],
        "https://pictures.example.com/photo-small.png"
    );

    // Smaller.
    let small = dir.0.join("small.atlaspack");
    let source = PackSource {
        smaller_pictures: true,
        ..folder_source(&pack)
    };
    let exported = run_export(&source, Detail::Overview, &small).unwrap();
    let names = entry_names(&small);
    let listed = json_entry(&small, "pictures.json");
    let list = listed.as_array().unwrap();
    let entry = |id: &str| {
        list.iter()
            .find(|p| p["id"] == format!("{ID}:picture:{id}"))
            .unwrap()
    };
    // Each picture named in the list is the file the pack file holds, and the other way round.
    let files: Vec<&str> = list.iter().map(|p| p["file"].as_str().unwrap()).collect();
    for name in names.keys().filter(|name| name.starts_with("pictures/")) {
        assert!(files.contains(&name.as_str()), "{name} is not listed");
    }
    for (id, file, format, width, height) in [
        ("photo", "pictures/photo.jpg", ImageFormat::Jpeg, 1280, 854),
        ("clear", "pictures/clear.png", ImageFormat::Png, 1280, 640),
        ("icon", "pictures/icon.png", ImageFormat::Png, 64, 64),
        ("shot", "pictures/shot.jpg", ImageFormat::Jpeg, 1280, 720),
        ("small", "pictures/small.jpg", ImageFormat::Jpeg, 800, 600),
        ("taken", "pictures/taken.png", ImageFormat::Png, 1280, 720),
        ("other", "pictures/taken.jpg", ImageFormat::Jpeg, 400, 300),
    ] {
        let picture = entry(id);
        assert_eq!(picture["file"], file, "{id}");
        assert_eq!(
            (picture["width"].as_u64(), picture["height"].as_u64()),
            (Some(width), Some(height)),
            "{id}"
        );
        assert_eq!(
            read(&entry_bytes(&small, file)),
            (format, width as u32, height as u32),
            "{id}"
        );
    }
    assert!(!names.contains_key("pictures/photo.png"));
    // Pictures left as they are: the same bytes.
    for file in [
        "pictures/icon.png",
        "pictures/small.jpg",
        "pictures/taken.jpg",
        "pictures/gate.png",
    ] {
        assert_eq!(entry_bytes(&small, file), before[file], "{file}");
    }
    assert!(entry("photo").get("pageCopy").is_none());
    assert_eq!(entry("other")["caption"], "Another picture");
    let full_size = fs::metadata(&full).unwrap().len();
    assert!(
        exported.size * 3 < full_size,
        "{} of {full_size}",
        exported.size
    );
    eprintln!(
        "A pack file with full-size pictures: {full_size} bytes; with smaller ones: {} bytes",
        exported.size
    );

    // The files here are as they were.
    assert!(kept(files_under(&pack)) == before, "the files here changed");

    // Opened on another device: each picture is there under the name the list gives. The
    // file is the same version as one with full-size pictures, and this import is the one
    // Atlas 0.11.0 has, so that app opens it too.
    let imported = run_import(&small, &dir.0.join("maps")).unwrap();
    let files = files_under(&imported.folder);
    for file in [
        "pictures/photo.jpg",
        "pictures/clear.png",
        "pictures/taken.png",
        "pictures/taken.jpg",
    ] {
        assert!(files.contains_key(file), "{file}");
    }
    assert!(!files.contains_key("pictures/photo.png"));
    let imported_list: Value = serde_json::from_slice(&files["pictures.json"]).unwrap();
    assert_eq!(imported_list, listed);
}

#[cfg(not(target_os = "android"))]
#[test]
fn makes_the_pictures_kept_for_own_use_smaller_too_when_they_go_in() {
    use super::smaller::tests::{encoded, photo, read};
    use image::ImageFormat;
    let dir = TempDir::new("packfile-smaller-own-use");
    let pack = dir.0.join("pages");
    write_pages_pack(&pack);
    put(
        &pack.join("pictures/own.png"),
        &encoded(&photo(2400, 1600, false), ImageFormat::Png),
    );
    let file = dir.0.join("pages.atlaspack");
    let source = PackSource {
        own_use_pictures: true,
        smaller_pictures: true,
        ..folder_source(&pack)
    };
    run_export(&source, Detail::Overview, &file).unwrap();
    let listed = json_entry(&file, "pictures.json");
    let own = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == format!("{ID}:picture:own"))
        .unwrap();
    assert_eq!(own["file"], "pictures/own.jpg");
    assert_eq!(own["shareable"], false);
    assert_eq!(read(&entry_bytes(&file, "pictures/own.jpg")).1, 1280);
    // Not a real picture: carried as it is.
    assert_eq!(
        entry_bytes(&file, "pictures/far.jpg"),
        b"downloaded picture"
    );
    run_import(&file, &dir.0.join("maps")).unwrap();
}

/// A GIF of two pictures, 1 × 1 pixel each: one that moves.
#[cfg(not(target_os = "android"))]
const MOVING_GIF: &[u8] = &[
    b'G', b'I', b'F', b'8', b'9', b'a', 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff,
    // The first picture, shown a tenth of a second.
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0,
    // The second.
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0, 0x3b,
];

/// A picture kept as a GIF that moves goes into a pack file as it is, at
/// full size and smaller alike, and comes out of it as it went in.
#[cfg(not(target_os = "android"))]
#[test]
fn carries_a_gif_that_moves_as_it_is() {
    let dir = TempDir::new("packfile-gif");
    let pack = dir.0.join("pages");
    write_pages_pack(&pack);
    put(&pack.join("pictures/moving.gif"), MOVING_GIF);
    let mut list =
        serde_json::from_slice::<Vec<Value>>(&fs::read(pack.join("pictures.json")).unwrap())
            .unwrap();
    list.push(json!({"id": format!("{ID}:picture:moving"), "file": "pictures/moving.gif", "shareable": true}));
    put_json(&pack.join("pictures.json"), &Value::Array(list));
    let file = dir.0.join("pages.atlaspack");
    for smaller in [false, true] {
        let source = PackSource {
            smaller_pictures: smaller,
            ..folder_source(&pack)
        };
        run_export(&source, Detail::Overview, &file).unwrap();
        assert_eq!(entry_bytes(&file, "pictures/moving.gif"), MOVING_GIF);
        let listed = json_entry(&file, "pictures.json");
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["file"] == "pictures/moving.gif"));
    }
    let maps = dir.0.join("maps");
    run_import(&file, &maps).unwrap();
    let imported = files_under(&maps);
    assert!(
        imported
            .iter()
            .any(|(name, bytes)| name.ends_with("pictures/moving.gif") && bytes == MOVING_GIF),
        "{:?}",
        imported.keys().collect::<Vec<_>>()
    );
}

/// A location photo kept at full size, with its copy for cards beside it,
/// goes into a smaller file at most 1,280 pixels wide, and its copy for
/// cards never goes in.
#[cfg(not(target_os = "android"))]
#[test]
fn a_location_photo_kept_at_full_size_goes_in_smaller() {
    use super::smaller::tests::{encoded, photo, read};
    use image::ImageFormat;
    let dir = TempDir::new("packfile-smaller-photo");
    let pack = dir.0.join("pages");
    write_pages_pack(&pack);
    // `far` is a location's photo, downloaded at full size with its copy.
    put(
        &pack.join("pictures/far.jpg"),
        &encoded(&photo(4096, 2048, false), ImageFormat::Jpeg),
    );
    put(
        &pack.join("pictures/far.page.jpg"),
        &encoded(&photo(1280, 640, false), ImageFormat::Jpeg),
    );
    put_json(
        &pack.join("locations.json"),
        &json!([{"id": format!("{ID}:loc:a"), "photos": [{"picture": format!("{ID}:picture:far")}]}]),
    );
    let file = dir.0.join("pages.atlaspack");
    for smaller in [false, true] {
        let source = PackSource {
            own_use_pictures: true,
            smaller_pictures: smaller,
            ..folder_source(&pack)
        };
        run_export(&source, Detail::Overview, &file).unwrap();
        let width = read(&entry_bytes(&file, "pictures/far.jpg")).1;
        assert_eq!(width, if smaller { 1280 } else { 4096 });
        assert!(!entry_names(&file)
            .keys()
            .any(|name| name.contains(".page.")));
    }
}

#[cfg(not(target_os = "android"))]
#[test]
fn cancelling_while_pictures_are_made_smaller_leaves_nothing() {
    let dir = TempDir::new("packfile-smaller-cancel");
    let pack = dir.0.join("pages");
    write_full_size_pack(&pack);
    let file = dir.0.join("pages.atlaspack");
    let source = PackSource {
        smaller_pictures: true,
        ..folder_source(&pack)
    };
    let asked = Cell::new(0);
    let result = export(
        &source,
        &app(),
        Detail::Overview,
        &file,
        &mut |_| {},
        &|| {
            asked.set(asked.get() + 1);
            true
        },
    );
    assert!(matches!(result, Err(Stop::Cancelled)), "{result:?}");
    // Cancelled while the pictures were made smaller, before anything was written.
    assert_eq!(asked.get(), 1);
    assert!(!file.exists() && !part_path(&file).exists());
}

// ---------------------------------------------------------------------------
// What another app shows of a file: the card and the small pictures (version 7)

/// The entries of a file after the header, in order, with their bytes.
#[cfg(not(target_os = "android"))]
fn entries_of(file: &Path) -> Vec<(String, Vec<u8>)> {
    let mut archive = ZipArchive::new(fs::File::open(file).unwrap()).unwrap();
    (1..archive.len())
        .map(|i| {
            let mut entry = archive.by_index(i).unwrap();
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
            (entry.name().unwrap().into_owned(), bytes)
        })
        .collect()
}

/// A pack whose East Field has real images at level 1 (512 pixels a side,
/// 2 x 2 tiles), and whose locations name their maps. West Ridge's images
/// are no pictures, so it has no small picture.
#[cfg(not(target_os = "android"))]
fn write_picture_pack(dir: &Path) {
    use super::smaller::tests::{encoded, photo};
    use image::ImageFormat;
    write_pack(dir, "1.2.0");
    for (x, y) in grid(2048, 2048, 3, 1) {
        put(
            &dir.join(tile_a(1, x, y)),
            &encoded(&photo(256, 256, x == y), ImageFormat::Png),
        );
    }
    put_json(
        &dir.join("locations.json"),
        &json!([{"id": "x1", "mapId": format!("{ID}:map:east")}, {"id": "x2", "mapId": format!("{ID}:map:east")},
                {"id": "x3", "mapId": format!("{ID}:map:west")}]),
    );
}

#[cfg(not(target_os = "android"))]
#[test]
fn writes_small_pictures_of_the_maps_first_as_version_7() {
    use super::smaller::tests::read;
    use image::ImageFormat;
    let dir = TempDir::new("packfile-previews");
    let pack = dir.0.join("pack");
    write_picture_pack(&pack);
    let file = dir.0.join("valley.atlaspack");
    let header = run_export(&folder_source(&pack), Detail::Overview, &file)
        .unwrap()
        .header;
    assert_eq!(header.version, VERSION_WITH_PREVIEWS);
    assert_eq!(
        header.maps,
        [
            MapFacts {
                id: format!("{ID}:map:east"),
                name: "East Field".into(),
                width: 2048,
                height: 2048,
                locations: 2,
                preview: Some("preview/east.jpg".into()),
            },
            // Its images are not pictures: no small picture, and no failure.
            MapFacts {
                id: format!("{ID}:map:west"),
                name: "West Ridge".into(),
                width: 1024,
                height: 512,
                locations: 1,
                preview: None,
            },
        ]
    );
    assert_eq!(header.cover.as_deref(), Some("preview/east.jpg"));

    // Right after the header, stored, a JPEG of 512 pixels at most.
    let entries = entries_of(&file);
    assert_eq!(entries[0].0, "preview/east.jpg");
    assert!(entries[1..]
        .iter()
        .all(|(name, _)| !name.starts_with("preview/")));
    let preview = &entries[0].1;
    assert!(preview.len() as u64 <= MAX_PREVIEW_BYTES);
    assert_eq!(read(preview), (ImageFormat::Jpeg, 512, 512));
    {
        let mut archive = ZipArchive::new(fs::File::open(&file).unwrap()).unwrap();
        assert_eq!(
            archive.by_name("preview/east.jpg").unwrap().compression(),
            CompressionMethod::Stored
        );
    }
    assert_eq!(header.files as usize, entries.len());
    assert_eq!(
        header.bytes,
        entries.iter().map(|(_, b)| b.len() as u64).sum::<u64>()
    );

    // Another app reads the description and the picture with the crate.
    assert_eq!(atlas_pack::read_header(&file).unwrap(), header);
    assert_eq!(
        &atlas_pack::read_preview(&file, "preview/east.jpg").unwrap(),
        preview
    );

    // Imported: the game is there, its small pictures are not.
    let maps = dir.0.join("maps");
    let imported = run_import(&file, &maps).unwrap();
    let files = files_under(&imported.folder);
    assert!(
        files.keys().all(|name| !name.contains("preview")),
        "{files:?}"
    );
    assert_eq!(imported.header, header);
    assert!(hidden_entries(&maps).is_empty());

    // A file with own lists and small pictures is version 7 too.
    let mine = Mine {
        lists: Some(own_lists_text(ID)),
        ..Mine::default()
    };
    let with_mine = dir.0.join("mine.atlaspack");
    let exported = export_mine(&folder_source(&pack), &with_mine, &mine).unwrap();
    assert_eq!(exported.header.version, VERSION_WITH_PREVIEWS);
    assert_eq!(entry_names(&with_mine).len(), entries.len() + 2);
}

#[cfg(not(target_os = "android"))]
#[test]
fn a_file_without_a_picture_of_a_map_stays_at_its_version() {
    let dir = TempDir::new("packfile-no-previews");
    // The test pack's images are not pictures: no small picture is made.
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let file = dir.0.join("valley.atlaspack");
    let header = run_export(&folder_source(&pack), Detail::Overview, &file)
        .unwrap()
        .header;
    assert_eq!(header.version, VERSION_WITHOUT_MINE);
    assert!(header.maps.iter().all(|map| map.preview.is_none()));
    assert_eq!(header.cover, None);
    assert!(entry_names(&file)
        .keys()
        .all(|name| !name.starts_with("preview/")));
    let raw = json_entry(&file, HEADER_FILE);
    assert!(raw.get("cover").is_none());
    assert!(raw["maps"][0].get("preview").is_none());
}

#[test]
fn the_description_says_what_a_card_shows() {
    let dir = TempDir::new("packfile-card");
    // A game of maps: its own title, no system, no pages of its own.
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let file = dir.0.join("valley.atlaspack");
    let header = run_export(&folder_source(&pack), Detail::Overview, &file)
        .unwrap()
        .header;
    assert_eq!(
        header.game,
        Some(GameFacts {
            title: "Test Valley".into(),
            system: None
        })
    );
    assert!(!header.personal_use && header.guides.is_empty());
    // Its site goes by the address of the first page read (see
    // `the_site_is_named_by_the_manifest_then_the_pages_then_the_address`).
    assert_eq!(header.source.name.as_deref(), Some("127.0.0.1"));
    let raw = json_entry(&file, HEADER_FILE);
    assert_eq!(raw["game"], json!({"title": "Test Valley"}));
    for key in ["personalUse", "guides"] {
        assert!(raw.get(key).is_none(), "{key}");
    }
    assert_eq!(raw["source"]["name"], "127.0.0.1");
    assert_eq!(raw["maps"][1]["name"], "West Ridge");

    // A game of pages read in order, kept for the person's own use.
    let pages = dir.0.join("pages");
    write_pages_pack(&pages);
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(pages.join(MANIFEST_FILE)).unwrap()).unwrap();
    manifest["system"] = json!(" Saltbox 64 ");
    manifest["personalUse"] = json!(true);
    manifest["pagesInOrder"] = json!(true);
    manifest["homePage"] = json!(format!("{ID}:guide:home"));
    put_json(&pages.join(MANIFEST_FILE), &manifest);
    let source = |site: &str| {
        json!({"url": "https://wiki.example.com/x", "site": site,
        "license": {"name": "CC BY-SA 4.0"}, "readAt": "2026-11-13"})
    };
    put_json(
        &pages.join("guides.json"),
        &json!([
            {"id": format!("{ID}:guide:home"), "title": "Home", "body": "x", "locationIds": [], "source": source("Example Wiki")},
            {"id": format!("{ID}:guide:start"), "title": "Start", "body": "x", "locationIds": [], "source": source("Example Wiki")},
            {"id": format!("{ID}:guide:more"), "title": "More", "body": "x", "locationIds": [], "source": source("Other Wiki")},
            {"id": format!("{ID}:guide:loose"), "title": "Not listed", "body": "x", "locationIds": []}
        ]),
    );
    put_json(
        &pages.join("sections.json"),
        &json!([
            {"id": format!("{ID}:section:basics"), "title": "Basics",
             "items": [format!("{ID}:guide:start"), format!("{ID}:section:more"), format!("{ID}:guide:gone")]},
            {"id": format!("{ID}:section:more"), "title": "More", "items": [format!("{ID}:guide:more"), format!("{ID}:guide:start")]}
        ]),
    );
    let file = dir.0.join("pages.atlaspack");
    let header = run_export(&folder_source(&pages), Detail::Overview, &file)
        .unwrap()
        .header;
    assert_eq!(header.version, VERSION_WITHOUT_MINE, "no small pictures");
    assert_eq!(
        header.game,
        Some(GameFacts {
            title: "Test Pages".into(),
            system: Some("Saltbox 64".into())
        })
    );
    assert!(header.personal_use);
    assert!(header.maps.is_empty() && header.cover.is_none());
    // The pages the contents list, however deep, and the home page.
    assert_eq!(
        header.guides,
        [GuideFacts {
            title: "Test Pages".into(),
            guide_type: GuideType::Guide,
            pages: 3
        }]
    );
    assert_eq!(header.source.name.as_deref(), Some("Example Wiki"));
    let raw = json_entry(&file, HEADER_FILE);
    assert_eq!(raw["personalUse"], true);
    assert_eq!(
        raw["guides"],
        json!([{"title": "Test Pages", "type": "guide", "pages": 3}])
    );
    assert_eq!(raw["source"]["name"], "Example Wiki");
    assert!(raw.get("maps").is_none() && raw.get("cover").is_none());

    // Read as a collection, without a contents and with no map: a wiki of
    // all its guides.
    manifest.as_object_mut().unwrap().remove("pagesInOrder");
    put_json(&pages.join(MANIFEST_FILE), &manifest);
    fs::remove_file(pages.join("sections.json")).unwrap();
    let header = run_export(
        &folder_source(&pages),
        Detail::Overview,
        &dir.0.join("wiki.atlaspack"),
    )
    .unwrap()
    .header;
    assert_eq!(header.guides[0].guide_type, GuideType::Wiki);
    assert_eq!(header.guides[0].pages, 4);
}

#[test]
fn the_site_is_named_by_the_manifest_then_the_pages_then_the_address() {
    let dir = TempDir::new("packfile-site-name");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    // Only the pages the manifest records: none from the page data.
    fs::remove_dir_all(pack.join("import")).unwrap();
    let mut manifest = manifest("1.0.0");
    let importer = json!({"id": "demo-maps", "title": "Demo map site"});
    manifest["source"] = json!({"importer": importer, "pages": [
        {"url": "https://www.maps.example.org/test-valley/east", "importedAt": "2026-11-10T09:00:00.000Z"},
        {"url": "https://other.example.net/test-valley/west", "importedAt": "2026-11-11T09:00:00.000Z"}
    ]});
    put_json(&pack.join(MANIFEST_FILE), &manifest);
    let mut runs = 0;
    let mut name = || {
        runs += 1;
        run_export(
            &folder_source(&pack),
            Detail::Overview,
            &dir.0.join(format!("{runs}.atlaspack")),
        )
        .unwrap()
        .header
        .source
        .name
    };
    // Last: the host of the first page it records, without `www.`.
    assert_eq!(name().as_deref(), Some("maps.example.org"));
    // Before that: the site its guide pages name most.
    let guide = |id: &str, site: &str| {
        json!({"id": format!("{ID}:guide:{id}"), "title": id, "body": "x", "locationIds": [],
               "source": {"url": "https://wiki.example.com/x", "site": site,
                          "license": {"name": "CC BY-SA 4.0"}, "readAt": "2026-11-13"}})
    };
    put_json(
        &pack.join("guides.json"),
        &json!([
            guide("a", "Example Map Wiki"),
            guide("b", "Example Map Wiki"),
            guide("c", "Other Wiki")
        ]),
    );
    assert_eq!(name().as_deref(), Some("Example Map Wiki"));
    // First: the name the manifest records for the site.
    manifest["source"]["site"] = json!(" Example Maps ");
    put_json(&pack.join(MANIFEST_FILE), &manifest);
    assert_eq!(name().as_deref(), Some("Example Maps"));
    // A name that is no name is passed over.
    manifest["source"]["site"] = json!("   ");
    put_json(&pack.join(MANIFEST_FILE), &manifest);
    assert_eq!(name().as_deref(), Some("Example Map Wiki"));
    // Never the importer's title: with no page, no guide and no name, none.
    fs::remove_file(pack.join("guides.json")).unwrap();
    manifest["source"] = json!({"importer": importer, "pages": []});
    put_json(&pack.join(MANIFEST_FILE), &manifest);
    assert_eq!(name(), None);
    // And none for a pack not read from a site.
    manifest.as_object_mut().unwrap().remove("source");
    put_json(&pack.join(MANIFEST_FILE), &manifest);
    assert_eq!(name(), None);
}

#[test]
fn the_address_of_a_page_names_its_site_by_its_host() {
    use super::card::site_name;
    let facts = |kind: SourceKind, urls: &[&str]| SourceFacts {
        kind,
        pages: urls
            .iter()
            .map(|url| PageFacts {
                url: (*url).to_owned(),
                ..PageFacts::default()
            })
            .collect(),
        ..SourceFacts::default()
    };
    let web = |urls: &[&str]| site_name(None, &facts(SourceKind::WebPages, urls));
    assert_eq!(
        web(&["https://WWW.Maps.Example.org:8443/a?b#c"]).as_deref(),
        Some("maps.example.org")
    );
    assert_eq!(
        web(&["https://wwwmaps.example.org/a"]).as_deref(),
        Some("wwwmaps.example.org")
    );
    assert_eq!(
        web(&["http://guides.example.net/", "https://maps.example.org/"]).as_deref(),
        Some("guides.example.net")
    );
    assert_eq!(web(&["not an address"]), None);
    assert_eq!(web(&[]), None);
    // A name already found is kept, and only a pack read from pages has a host.
    assert_eq!(
        site_name(
            Some("Example Maps".into()),
            &facts(SourceKind::WebPages, &["https://maps.example.org/"])
        )
        .as_deref(),
        Some("Example Maps")
    );
    assert_eq!(
        site_name(
            None,
            &facts(SourceKind::App, &["https://maps.example.org/"])
        ),
        None
    );
}

#[test]
fn the_game_goes_by_the_title_the_file_carries() {
    let dir = TempDir::new("packfile-card-title");
    let pack = dir.0.join("pack");
    write_pack(&pack, "1.0.0");
    let group = format!(
        r#"{{"format":"atlas-game-group","version":1,"gameId":"{ID}","updatedAt":"2026-11-14T10:00:00Z","title":" Isles ","members":[{{"gameId":"other"}},{{"gameId":"{ID}"}}]}}"#
    );
    let mine = Mine {
        group: Some(group),
        ..Mine::default()
    };
    let exported = export_mine(&folder_source(&pack), &dir.0.join("g.atlaspack"), &mine).unwrap();
    assert_eq!(exported.header.version, VERSION_WITH_TITLE);
    assert_eq!(exported.header.game.unwrap().title, "Isles");
    // Without it, the pack's own title.
    let plain = run_export(
        &folder_source(&pack),
        Detail::Overview,
        &dir.0.join("p.atlaspack"),
    )
    .unwrap();
    assert_eq!(plain.header.game.unwrap().title, "Test Valley");
}

#[test]
fn names_and_levels_of_small_pictures() {
    use super::preview::{preview_level, preview_name};
    let mut taken = std::collections::HashSet::new();
    for (id, name) in [
        ("test-valley:map:east", "preview/east.jpg"),
        ("test-valley:map:East", "preview/east-2.jpg"),
        (
            "test-valley:map:West Ridge (2)",
            "preview/west-ridge--2-.jpg",
        ),
        ("test-valley:map:...", "preview/map.jpg"),
        ("test-valley:map:_x", "preview/x.jpg"),
        ("test-valley:map:../../up", "preview/up.jpg"),
    ] {
        let made = preview_name(id, &mut taken);
        assert_eq!(made, name, "{id}");
        assert!(is_preview_name(&made));
    }
    let long = preview_name(&format!("g:map:{}", "a".repeat(300)), &mut taken);
    assert!(is_preview_name(&long), "{long}");

    let layers = parse_layers(
        &json!([{"id": "g:map:big", "name": "Big", "width": 20_000, "height": 10_000}]).to_string(),
        &json!([{"id": "g:layer:a", "mapId": "g:map:big", "name": "A", "minZoom": 0, "maxZoom": 7, "tileSize": 256,
                 "tiles": {"type": "xyz", "url": "tiles/a/{z}/{x}/{y}.png"}}])
        .to_string(),
    )
    .unwrap();
    let layer = &layers[0];
    assert_eq!(layer.map_id, "g:map:big");
    // Level 2 is 625 pixels wide: the lowest at least 512.
    assert_eq!(preview_level(layer, &[0, 1, 2, 3, 4, 5, 6, 7]), Some(2));
    // Only lower levels in the file: the most detailed of them.
    assert_eq!(preview_level(layer, &[0, 1]), Some(1));
    // Levels of too many tiles are never drawn.
    assert_eq!(preview_level(layer, &[6, 7]), None);
}

#[test]
fn imports_a_version_6_file() {
    let dir = TempDir::new("packfile-version-6");
    let (mut header, entries) = good_file(&dir.0);
    header["version"] = json!(VERSION_WITH_TITLE);
    let file = dir.0.join("six.atlaspack");
    let borrowed: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    write_file(&file, &header, &borrowed);
    assert_eq!(read_header(&file).unwrap().version, 6);
    assert!(run_import(&file, &dir.0.join("maps")).is_ok());
}

#[cfg(not(target_os = "android"))]
#[test]
fn refuses_small_pictures_that_are_not_listed_or_out_of_place() {
    let dir = TempDir::new("packfile-previews-refused");
    let pack = dir.0.join("pack");
    write_picture_pack(&pack);
    let file = dir.0.join("valley.atlaspack");
    run_export(&folder_source(&pack), Detail::Overview, &file).unwrap();
    let header = json_entry(&file, HEADER_FILE);
    let entries = entries_of(&file);
    let jpeg = entries[0].1.clone();
    // Written again by hand as it is, it imports.
    let sound = dir.0.join("sound.atlaspack");
    let borrowed: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    write_file(&sound, &header, &borrowed);
    assert!(run_import(&sound, &dir.0.join("maps-sound")).is_ok());

    // One the header does not list, and one with a name no small picture has.
    for (i, name) in [
        "preview/west.jpg",
        "preview/../east.jpg",
        "preview/East.jpg",
    ]
    .into_iter()
    .enumerate()
    {
        let mut spoilt = entries.clone();
        spoilt.insert(1, (name.to_owned(), jpeg.clone()));
        let error = import_error(&dir.0, &format!("unlisted-{i}"), &header, &spoilt);
        assert!(
            error.contains("not part of a pack") || error.contains("outside the pack"),
            "{name}: {error}"
        );
    }
    // A header that lists an unsafe name: the name is dropped, so the entry
    // has no place.
    let mut unsafe_header = header.clone();
    unsafe_header["maps"][1]["preview"] = json!("preview/../../evil.jpg");
    let mut spoilt = entries.clone();
    spoilt.insert(1, ("preview/../../evil.jpg".to_owned(), jpeg.clone()));
    let error = import_error(&dir.0, "unsafe", &unsafe_header, &spoilt);
    assert!(
        error.contains("not part of a pack") || error.contains("outside the pack"),
        "{error}"
    );
    // Listed, but in a file of a version without small pictures.
    let mut older = header.clone();
    older["version"] = json!(VERSION_WITH_TITLE);
    let error = import_error(&dir.0, "older", &older, &entries);
    assert!(error.contains("not part of a pack"), "{error}");
    // Listed, but not right after the header.
    let mut moved = entries.clone();
    let first = moved.remove(0);
    moved.push(first);
    let error = import_error(&dir.0, "moved", &header, &moved);
    assert!(error.contains("out of its place"), "{error}");
    // Too large, and not a JPEG.
    let mut large = entries.clone();
    large[0].1.resize(MAX_PREVIEW_BYTES as usize + 1, 0);
    let error = import_error(&dir.0, "large", &header, &large);
    assert!(error.contains("too large"), "{error}");
    let mut png = entries.clone();
    png[0].1 = b"\x89PNG\r\n\x1a\n".to_vec();
    let error = import_error(&dir.0, "png", &header, &png);
    assert!(error.contains("not the picture"), "{error}");
}
