//! Opening single pack files, and the listing's serial.

use std::{fs, path::Path};

use crate::{
    library::{Library, Origin, IN_MAPS_FOLDER},
    packfile::inplace::testing,
    settings::SettingsFile,
    tiles::store::tests::TempDir,
    PackRegistry,
};

fn library(dir: &TempDir) -> Library {
    Library::new(
        SettingsFile::new(dir.0.join("shared")),
        PackRegistry::default(),
        Vec::new(),
        Vec::new(),
    )
}

fn write(path: &Path, id: &str, title: &str, updated: &str) {
    testing::write(
        path,
        &testing::header(id, title, updated, "2026-11-12T09:00:00Z"),
    );
}

fn remembered(library: &Library) -> Vec<String> {
    library.settings().read().pack_files
}

#[test]
fn opens_a_pack_file_from_another_folder_and_remembers_it() {
    let dir = TempDir::new("receive-open");
    let library = library(&dir);
    let file = dir.0.join("Shared files/Test Valley.atlaspack");
    write(&file, "test-valley", "Test Valley", "2026-11-10T09:00:00Z");

    let opened = library.open_pack_file(&file);
    assert_eq!(opened.show.as_deref(), Some("test-valley"));
    assert!(opened.remembered && !opened.problem);
    assert!(
        opened.message.starts_with(
            "Showing Test Valley from Test Valley.atlaspack. Atlas reads it where it is"
        ),
        "{}",
        opened.message
    );
    assert_eq!(remembered(&library), [file.display().to_string()]);
    let listing = library.scan();
    assert_eq!(listing.packs.len(), 1);
    assert_eq!(listing.packs[0].origin, Origin::OpenedFile);
    assert!(listing.packs[0].pack_file);
    assert_eq!(listing.opened_files.len(), 1);
    assert_eq!(listing.opened_files[0].pack.as_deref(), Some("test-valley"));
    assert!(!listing.opened_files[0].missing);
    assert_eq!(library.pack_file("test-valley"), Some(file.clone()));

    // Opened again: kept once.
    assert_eq!(
        library.open_pack_file(&file).show.as_deref(),
        Some("test-valley")
    );
    assert_eq!(remembered(&library).len(), 1);

    // The next start lists it too.
    let next = self::library(&dir);
    assert_eq!(next.scan().packs[0].id, "test-valley");

    // Removed from the list: no longer shown, and the file stays.
    next.forget_pack_file(&file.display().to_string()).unwrap();
    assert!(remembered(&next).is_empty());
    let listing = next.scan();
    assert!(listing.packs.is_empty());
    assert!(listing.opened_files.is_empty());
    assert!(file.is_file());
}

#[test]
fn a_pack_file_in_a_folder_atlas_reads_is_not_remembered() {
    let dir = TempDir::new("receive-in-folder");
    let library = library(&dir);
    let file = library.packs_folder().join("valley/Test Valley.atlaspack");
    write(&file, "test-valley", "Test Valley", "2026-11-10T09:00:00Z");
    let opened = library.open_pack_file(&file);
    assert_eq!(opened.show.as_deref(), Some("test-valley"));
    assert!(!opened.remembered && !opened.problem);
    assert!(opened.message.contains("It is in a folder Atlas reads"));
    assert!(remembered(&library).is_empty());
    assert_eq!(library.scan().packs[0].origin, Origin::PacksFolder);
}

#[test]
fn a_pack_file_that_is_gone_leaves_the_list_and_one_on_a_missing_drive_stays() {
    let dir = TempDir::new("receive-gone");
    let library = library(&dir);
    let deleted = dir.0.join("downloads/valley.atlaspack");
    let away = dir.0.join("drive/ridge.atlaspack");
    write(
        &deleted,
        "test-valley",
        "Test Valley",
        "2026-11-10T09:00:00Z",
    );
    write(&away, "test-ridge", "Test Ridge", "2026-11-10T09:00:00Z");
    library.open_pack_file(&deleted);
    library.open_pack_file(&away);
    assert_eq!(remembered(&library).len(), 2);
    assert_eq!(library.scan().packs.len(), 2);

    // Deleted while its folder is there: off the list.
    fs::remove_file(&deleted).unwrap();
    // Its whole folder away, as a drive that is not connected: kept.
    fs::remove_dir_all(dir.0.join("drive")).unwrap();
    let listing = library.scan();
    assert!(listing.packs.is_empty());
    assert_eq!(remembered(&library), [away.display().to_string()]);
    assert_eq!(listing.opened_files.len(), 1);
    assert!(listing.opened_files[0].missing);
    assert_eq!(listing.opened_files[0].pack, None);

    // The drive is back: shown again.
    write(&away, "test-ridge", "Test Ridge", "2026-11-10T09:00:00Z");
    let listing = library.scan();
    assert_eq!(listing.packs[0].id, "test-ridge");
    assert!(!listing.opened_files[0].missing);
}

#[test]
fn says_which_one_is_shown_when_the_id_is_shown_already() {
    let dir = TempDir::new("receive-hidden");
    let library = library(&dir);
    let in_folder = library.packs_folder().join("valley.atlaspack");
    write(
        &in_folder,
        "test-valley",
        "Test Valley",
        "2026-11-10T09:00:00Z",
    );
    let older = dir.0.join("elsewhere/older.atlaspack");
    write(
        &older,
        "test-valley",
        "Older Valley",
        "2026-11-01T09:00:00Z",
    );

    let opened = library.open_pack_file(&older);
    assert_eq!(opened.show.as_deref(), Some("test-valley"));
    assert!(!opened.problem && opened.remembered);
    assert!(
        opened.message.starts_with(
            "older.atlaspack holds Older Valley, but the one shown is read from another file or folder. Another pack file of the same game (test-valley) is shown, from "
        ),
        "{}",
        opened.message
    );
    assert!(opened
        .message
        .contains("the one whose pack was changed last is shown"));
    assert_eq!(library.scan().packs[0].title, "Test Valley");

    // A newer file opened is the one shown, by the same rule.
    let newer = dir.0.join("elsewhere/newer.atlaspack");
    write(
        &newer,
        "test-valley",
        "Newer Valley",
        "2026-11-18T09:00:00Z",
    );
    let opened = library.open_pack_file(&newer);
    assert!(opened
        .message
        .starts_with("Showing Newer Valley from newer.atlaspack."));
    assert_eq!(library.pack_file("test-valley"), Some(newer));

    // A pack folder of the game wins over every pack file.
    let folder = library.maps_folder().join("test-valley");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("manifest.json"),
        r#"{"schemaVersion":2,"gameId":"test-valley","title":"Folder Valley","packVersion":"1.0.0","gamePatch":"1","attribution":[],"idMigrations":{}}"#,
    )
    .unwrap();
    let opened = library.open_pack_file(&older);
    assert_eq!(opened.show.as_deref(), Some("test-valley"));
    assert!(
        opened
            .message
            .contains("A pack with the same id (test-valley) is already shown, from "),
        "{}",
        opened.message
    );
}

#[test]
fn refuses_a_pack_file_in_the_maps_folder_and_lists_a_broken_one() {
    let dir = TempDir::new("receive-refused");
    let library = library(&dir);
    let in_maps = library.maps_folder().join("stray.atlaspack");
    write(
        &in_maps,
        "test-valley",
        "Test Valley",
        "2026-11-10T09:00:00Z",
    );
    let opened = library.open_pack_file(&in_maps);
    assert!(opened.problem && !opened.remembered);
    assert_eq!(opened.show, None);
    assert_eq!(
        opened.message,
        format!("Atlas does not open stray.atlaspack. {IN_MAPS_FOLDER}")
    );
    assert!(remembered(&library).is_empty());

    let broken = dir.0.join("elsewhere/broken.atlaspack");
    fs::create_dir_all(broken.parent().unwrap()).unwrap();
    fs::write(&broken, b"not a pack file at all").unwrap();
    let opened = library.open_pack_file(&broken);
    assert!(opened.problem && opened.remembered);
    assert_eq!(opened.show, None);
    assert_eq!(
        opened.message,
        "Atlas could not open broken.atlaspack. This file is not an Atlas pack file."
    );
    let listing = library.scan();
    assert_eq!(listing.unreadable.len(), 1);
    assert_eq!(listing.unreadable[0].path, broken.display().to_string());
    assert_eq!(listing.opened_files[0].pack, None);
}

#[test]
fn a_listing_has_a_new_serial_only_when_it_changed() {
    let dir = TempDir::new("receive-serial");
    let library = library(&dir);
    let first = library.scan();
    assert_eq!(library.scan().serial, first.serial);
    assert!(library.scan_changed().is_none());

    write(
        &library.packs_folder().join("valley.atlaspack"),
        "test-valley",
        "Test Valley",
        "2026-11-10T09:00:00Z",
    );
    let changed = library.scan_changed().expect("a pack file arrived");
    assert_eq!(changed.serial, first.serial + 1);
    assert_eq!(changed.packs[0].id, "test-valley");
    assert!(library.scan_changed().is_none());
    assert_eq!(library.scan().serial, changed.serial);
}
