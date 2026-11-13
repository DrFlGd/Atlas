//! Map pack files: export then import at each detail, and every refusal.

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
    put(&dir.join(".atlas/download-job.json"), b"{}");
}

fn folder_source(dir: &Path) -> PackSource {
    PackSource {
        pack_id: ID.into(),
        root: dir.to_path_buf(),
        images: dir.to_path_buf(),
        lock: true,
        comes_with_app: false,
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

/// Writes a map pack file by hand: the header first, then the entries.
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
    assert!(import_error(&dir.0, "format", &other, &entries).contains("not an Atlas map pack file"));
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
            error.contains("not part of a map pack") || error.contains("outside the pack"),
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
        error.contains("not part of a map pack") || error.contains("twice"),
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
    assert!(error.contains("not this game's map pack"), "{error}");
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
            .contains("not an Atlas map pack file")
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
    };
    let file = dir.0.join("mine.atlaspack");
    let exported = export_mine(&source, &file, &mine).unwrap();
    assert_eq!(exported.header.version, VERSION);
    assert_eq!(
        exported.header.mine,
        Some(MineFacts {
            lists: 1,
            locations: 2,
            types: 1,
            areas: 0
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
        locations: None,
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
        lists: None,
        locations: Some(own_locations_text("another-game")),
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
    assert!(error.contains("not part of a map pack"), "{error}");
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
            {"id": format!("{ID}:picture:gone"), "file": "pictures/gone.png", "shareable": true}
        ]),
    );
    put(&dir.join("pictures/gate.png"), b"gate picture");
    put(&dir.join("pictures/own.png"), b"my own picture");
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
        ["pictures/gate.png"]
    );
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
        assert!(error.contains("not part of a map pack"), "{name}: {error}");
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
        error.contains("not part of a map pack") || error.contains("outside"),
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
