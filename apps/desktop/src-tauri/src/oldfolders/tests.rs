//! Old folders: what is listed, what is never offered, sizes and removal.

use std::{fs, path::Path, time::Duration};

use serde_json::json;

use super::*;
use crate::{
    library::{BundledPack, Library, Origin},
    packfile::inplace::testing as pack_file,
    packs::PackRegistry,
    settings::SettingsFile,
    tiles::store::tests::TempDir,
};

fn put(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A pack folder with a manifest that says `more` besides.
fn write_pack(dir: &Path, id: &str, title: &str, more: serde_json::Value) {
    let mut manifest = json!({"schemaVersion": 2, "gameId": id, "title": title, "packVersion": "1.0.0",
                              "gamePatch": "1", "attribution": [], "idMigrations": {}});
    for (key, value) in more.as_object().unwrap() {
        manifest[key] = value.clone();
    }
    put(&dir.join("manifest.json"), &manifest.to_string());
    put(&dir.join("maps.json"), "[]");
}

/// A pack file of a game in `path`.
fn write_pack_file(path: &Path, id: &str, title: &str) {
    pack_file::write(
        path,
        &pack_file::header(id, title, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z"),
    );
}

fn library(dir: &Path, bundled: Vec<BundledPack>) -> Library {
    Library::new(
        SettingsFile::new(dir.join("shared")),
        PackRegistry::default(),
        bundled,
        Vec::new(),
    )
}

fn folders(old: &[OldFolder]) -> Vec<&str> {
    old.iter().map(|folder| folder.folder.as_str()).collect()
}

fn asked(folder: &str, id: &str) -> OldFolderRef {
    OldFolderRef {
        folder: folder.to_owned(),
        id: id.to_owned(),
    }
}

/// A maps folder as a reader leaves it: a game imported from a pack file
/// (whose pack file is in the packs folder too), a folder of unknown
/// origin, a game made here, the person's own things beside them, and what
/// is never offered.
fn reader_maps_folder(dir: &Path) -> Library {
    let resource = dir.join("resources/demo");
    write_pack(&resource, "demo", "Demo World", json!({}));
    let library = library(
        dir,
        vec![BundledPack {
            id: "demo".into(),
            path: resource,
            downloadable: false,
        }],
    );
    let maps = library.maps_folder();
    // Imported from a pack file: the import leaves `.atlas/pack-file.json`.
    let file = dir.join("Downloads/Test Valley.atlaspack");
    write_pack_file(&file, "test-valley", "Test Valley");
    crate::packfile::import::import(&file, &maps, &mut |_| {}, &|| false).unwrap();
    fs::create_dir_all(library.packs_folder()).unwrap();
    fs::copy(&file, library.packs_folder().join("Test Valley.atlaspack")).unwrap();
    // Copied in by hand, from somewhere.
    write_pack(
        &maps.join("Hand Copied"),
        "hand-copied",
        "Hand Copied",
        json!({}),
    );
    put(&maps.join("Hand Copied/tiles/0/0/0.png"), "12345");
    // Made here.
    write_pack(
        &maps.join("my-island"),
        "my-island",
        "My Island",
        json!({"madeInApp": true}),
    );
    // A copy of the game that comes with the app, refreshed from its site.
    write_pack(&maps.join("demo"), "demo", "Demo World", json!({}));
    // The person's own things beside the games, and a folder that is no pack.
    put(&maps.join("test-valley.my-lists.json"), "{}");
    put(&maps.join("test-valley.my-pictures/own.abc.png"), "png");
    put(&maps.join("notes/readme.txt"), "not a pack");
    library
}

#[test]
fn lists_the_folders_a_reader_no_longer_uses() {
    let dir = TempDir::new("oldfolders-list");
    let library = reader_maps_folder(&dir.0);
    let old = list(&library);
    assert!(!old.site_reader);
    assert_eq!(folders(&old.folders), ["Hand Copied", "test-valley"]);
    assert_eq!(folders(&old.made_here), ["my-island"]);
    let valley = &old.folders[1];
    assert_eq!(valley.id, "test-valley");
    assert_eq!(valley.title, "Test Valley");
    assert_eq!(
        valley.pack_file.as_deref().map(Path::new),
        Some(
            library
                .packs_folder()
                .join("Test Valley.atlaspack")
                .as_path()
        )
    );
    assert_eq!(old.folders[0].pack_file, None);

    let size = size_of(&library, "Hand Copied").unwrap();
    assert_eq!((size.files, size.complete), (3, true));
    assert_eq!(
        size.bytes,
        ["manifest.json", "maps.json", "tiles/0/0/0.png"]
            .iter()
            .map(|name| {
                fs::metadata(library.maps_folder().join("Hand Copied").join(name))
                    .unwrap()
                    .len()
            })
            .sum::<u64>()
    );
    // Only a folder the list names.
    for name in [
        "..",
        ".",
        "notes",
        "Hand Copied/tiles",
        "../shared",
        "gone",
        "",
    ] {
        assert!(size_of(&library, name).is_err(), "{name}");
    }
}

#[test]
fn removes_a_folder_and_shows_the_game_from_its_pack_file() {
    let dir = TempDir::new("oldfolders-remove");
    let library = reader_maps_folder(&dir.0);
    let maps = library.maps_folder();
    let listing = library.scan();
    let shown = listing
        .packs
        .iter()
        .find(|pack| pack.id == "test-valley")
        .unwrap();
    assert_eq!(shown.origin, Origin::MapsFolder);

    let removed = remove(
        &library,
        &[
            asked("test-valley", "test-valley"),
            // Not this game's folder: refused.
            asked("Hand Copied", "test-valley"),
            // Never offered.
            asked("demo", "demo"),
            asked("notes", "notes"),
            asked("../shared", "test-valley"),
        ],
        &|_| false,
    );
    assert!(removed[0].removed && removed[0].complete, "{removed:?}");
    assert!(removed[1..]
        .iter()
        .all(|done| !done.removed && done.problem.is_some()));
    assert!(!maps.join("test-valley").exists());
    assert!(maps.join("Hand Copied/manifest.json").exists());
    assert!(maps.join("demo/manifest.json").exists());
    // The person's own things stay, by the game's id.
    assert!(maps.join("test-valley.my-lists.json").exists());
    assert!(maps.join("test-valley.my-pictures/own.abc.png").exists());
    // The game is shown from its pack file now.
    let listing = library.scan();
    let shown = listing
        .packs
        .iter()
        .find(|pack| pack.id == "test-valley")
        .unwrap();
    assert!(shown.pack_file);
    assert_eq!(shown.origin, Origin::PacksFolder);
    assert_eq!(folders(&list(&library).folders), ["Hand Copied"]);

    // A game made here goes only when asked by name; one downloading never.
    let removed = remove(&library, &[asked("my-island", "my-island")], &|id| {
        id == "my-island"
    });
    assert!(!removed[0].removed);
    assert!(maps.join("my-island/manifest.json").exists());
    let removed = remove(&library, &[asked("my-island", "my-island")], &|_| false);
    assert!(removed[0].removed);
    assert!(!maps.join("my-island").exists());
}

#[test]
fn offers_nothing_where_an_app_that_reads_sites_keeps_its_folders() {
    // A folder with page data kept by "Add a map".
    let dir = TempDir::new("oldfolders-page-data");
    let library = reader_maps_folder(&dir.0);
    put(
        &library.maps_folder().join("Wiki/import/index.json"),
        r#"{"format":"atlas-import","version":1}"#,
    );
    write_pack(
        &library.maps_folder().join("Wiki"),
        "wiki",
        "Wiki",
        json!({}),
    );
    let old = list(&library);
    assert!(old.site_reader);
    assert!(old.folders.is_empty() && old.made_here.is_empty());
    let removed = remove(&library, &[asked("Hand Copied", "hand-copied")], &|_| false);
    assert_eq!(removed[0].problem.as_deref(), Some(SITE_READER_HERE));
    assert!(library.maps_folder().join("Hand Copied").exists());

    // A pack read from pages here: its manifest names an importer, and it
    // was not imported from a pack file.
    let dir = TempDir::new("oldfolders-read-here");
    let library = reader_maps_folder(&dir.0);
    let from_pages = json!({"source": {"importer": {"id": "demo-maps", "title": "Demo map site"},
                                       "pages": [{"url": "https://maps.example.com/a", "mapId": "a"}]}});
    write_pack(
        &library.maps_folder().join("From Pages"),
        "from-pages",
        "From Pages",
        from_pages.clone(),
    );
    assert!(list(&library).site_reader);
    // The same, imported from a pack file, is an old folder like any.
    fs::create_dir_all(library.maps_folder().join("From Pages/.atlas")).unwrap();
    fs::copy(
        library
            .maps_folder()
            .join("test-valley/.atlas/pack-file.json"),
        library
            .maps_folder()
            .join("From Pages/.atlas/pack-file.json"),
    )
    .unwrap();
    let old = list(&library);
    assert!(!old.site_reader);
    assert!(folders(&old.folders).contains(&"From Pages"));
    // An unfinished download.
    put(
        &library
            .maps_folder()
            .join("Hand Copied/.atlas/download-job.json"),
        "{}",
    );
    assert!(list(&library).site_reader);

    // The shared settings say such an app started on this computer.
    let dir = TempDir::new("oldfolders-settings");
    let library = reader_maps_folder(&dir.0);
    library
        .settings()
        .update(|settings| {
            settings.site_reader_started_at = Some("2026-11-19T08:00:00Z".to_owned());
        })
        .unwrap();
    assert!(list(&library).site_reader);
    // And the marker stays when this app writes the settings.
    library
        .settings()
        .update(|settings| settings.pack_files.clear())
        .unwrap();
    assert!(library.settings().read().site_reader_started_at.is_some());

    // Its Sites folder is there.
    let dir = TempDir::new("oldfolders-sites");
    let library = reader_maps_folder(&dir.0);
    fs::create_dir_all(crate::sites::sites_folder(library.settings().dir())).unwrap();
    assert!(list(&library).site_reader);
}

#[test]
fn never_offers_a_folder_added_as_a_location() {
    let dir = TempDir::new("oldfolders-location");
    let library = reader_maps_folder(&dir.0);
    let hand = library.maps_folder().join("Hand Copied");
    library
        .settings()
        .update(|settings| {
            settings.locations.push(crate::settings::Location {
                path: hand.display().to_string(),
                kind: LocationKind::Pack,
            });
        })
        .unwrap();
    assert_eq!(folders(&list(&library).folders), ["test-valley"]);
}

#[test]
fn counts_a_size_within_its_limits_without_following_links() {
    let dir = TempDir::new("oldfolders-size");
    let folder = dir.0.join("pack");
    for n in 0..10 {
        put(
            &folder.join("tiles").join(n.to_string()).join("0.png"),
            "1234",
        );
    }
    let whole = folder_size(&folder, MAX_SIZE_ENTRIES, MAX_SIZE_TIME);
    assert_eq!(
        whole,
        FolderSize {
            bytes: 40,
            files: 10,
            complete: true
        }
    );
    let cut = folder_size(&folder, 5, MAX_SIZE_TIME);
    assert!(!cut.complete && cut.files < 10);
    let late = folder_size(&folder, MAX_SIZE_ENTRIES, Duration::ZERO);
    assert!(!late.complete);
    #[cfg(unix)]
    {
        let outside = dir.0.join("outside");
        put(&outside.join("big.bin"), &"x".repeat(10_000));
        std::os::unix::fs::symlink(&outside, folder.join("link")).unwrap();
        assert_eq!(folder_size(&folder, MAX_SIZE_ENTRIES, MAX_SIZE_TIME), whole);
    }
}
