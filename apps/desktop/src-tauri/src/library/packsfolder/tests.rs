//! Changing the packs folder: what is refused, moving the pack files on
//! one drive and across drives, a name taken, a file in use, the files
//! that are not pack files left alone, leaving them where they are, the
//! default folder again, and the paths kept elsewhere that follow a move.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use super::{copy_across, move_pack_files, MovedFiles, PacksFolderChanged};
use crate::{
    library::{Library, Listing, Origin},
    packfile::inplace::testing as pack_file,
    packs::PackRegistry,
    removal::FileOps,
    settings::{default_packs_folder, Location, LocationKind, SettingsFile},
    tiles::store::tests::TempDir,
};

fn library(dir: &Path) -> Library {
    Library::new(
        SettingsFile::new(dir.join("shared")),
        PackRegistry::default(),
        Vec::new(),
        Vec::new(),
    )
}

/// Writes a made-up pack file of a game with no map.
fn write_pack_file(path: &Path, id: &str) {
    pack_file::write(
        path,
        &pack_file::header(id, id, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"),
    );
}

/// The pack files listed from the packs folder, by path.
fn from_packs_folder(listing: &Listing) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = listing
        .packs
        .iter()
        .filter(|pack| pack.origin == Origin::PacksFolder)
        .filter_map(|pack| pack.path.as_deref().map(PathBuf::from))
        .collect();
    paths.sort();
    paths
}

/// Every file under `dir`, relative to it, with `/` between names.
fn files_under(dir: &Path) -> Vec<String> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, out);
            } else {
                let relative = path.strip_prefix(base).unwrap();
                out.push(
                    relative
                        .components()
                        .map(|part| part.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

#[test]
fn refuses_folders_that_cannot_be_the_packs_folder() {
    let dir = TempDir::new("packs-folder-refused");
    let library = library(&dir.0);
    let packs = library.packs_folder();
    fs::create_dir_all(&packs).unwrap();
    let maps = library.maps_folder();
    fs::create_dir_all(maps.join("valley")).unwrap();
    let refused = |path: &Path, says: &str| {
        let error = library.propose_packs_folder(path).unwrap_err();
        assert!(error.contains(says), "{}: {error}", path.display());
    };

    refused(&packs, "That is the packs folder already.");
    // A pack folder, a folder inside one, a pack file and another file.
    let pack = dir.0.join("Elsewhere").join("ridge");
    fs::create_dir_all(pack.join("tiles")).unwrap();
    fs::write(pack.join("manifest.json"), b"{}").unwrap();
    refused(&pack, "That folder is a map pack.");
    refused(&pack.join("tiles"), "That folder is inside a map pack.");
    let file = dir.0.join("Elsewhere").join("valley.atlaspack");
    write_pack_file(&file, "valley");
    refused(&file, "That is a pack file.");
    fs::write(dir.0.join("notes.txt"), b"notes").unwrap();
    refused(&dir.0.join("notes.txt"), "That is a file.");
    // The maps folder, a folder inside it and one that holds it.
    refused(&maps, "That folder is the maps folder");
    refused(&maps.join("valley"), "That folder is the maps folder");
    refused(maps.parent().unwrap(), "That folder is the maps folder");
    // A folder listed under Games in other folders, or one inside it.
    let listed = dir.0.join("Games");
    fs::create_dir_all(listed.join("More")).unwrap();
    library
        .settings()
        .update(|settings| {
            settings.locations.push(Location {
                path: listed.display().to_string(),
                kind: LocationKind::Folder,
            });
        })
        .unwrap();
    refused(&listed, "Remove it from that list first");
    refused(
        &listed.join("More"),
        "Remove that folder from the list first",
    );
    // A folder inside the packs folder now.
    refused(&packs.join("inside"), "inside the packs folder now");
    // A folder Atlas cannot write to: one that cannot be made, below a file.
    refused(
        &dir.0.join("notes.txt").join("Packs"),
        "Atlas cannot write to that folder",
    );
    // Nothing was changed, and nothing waits for a confirmation.
    assert_eq!(library.packs_folder(), packs);
    assert!(library.apply_packs_folder(true).is_err());

    // A folder that can be used: what changing to it would do.
    write_pack_file(&packs.join("valley.atlaspack"), "valley");
    write_pack_file(&packs.join("North").join("ridge.atlaspack"), "ridge");
    fs::write(packs.join("readme.txt"), b"not a pack file").unwrap();
    let new = dir.0.join("New Packs");
    let choice = library.propose_packs_folder(&new).unwrap();
    assert_eq!(PathBuf::from(&choice.path), new);
    assert_eq!(PathBuf::from(&choice.current), packs);
    assert_eq!(choice.files, 2);
    let bytes = fs::metadata(packs.join("valley.atlaspack")).unwrap().len()
        + fs::metadata(packs.join("North/ridge.atlaspack"))
            .unwrap()
            .len();
    assert_eq!(choice.bytes, bytes);
    assert!(choice.same_drive);
    assert!(!choice.is_default);
    // Its check made the folder, and left nothing in it.
    assert!(new.is_dir());
    assert_eq!(fs::read_dir(&new).unwrap().count(), 0);
}

#[test]
fn moves_the_pack_files_and_nothing_else_and_keeps_both_of_a_name_taken() {
    let dir = TempDir::new("packs-folder-move");
    let mut library = library(&dir.0);
    let old = library.packs_folder();
    write_pack_file(&old.join("valley.atlaspack"), "valley");
    write_pack_file(&old.join("Ridge").join("ridge.atlaspack"), "ridge");
    write_pack_file(
        &old.join("Deep").join("Deeper").join("cave.atlaspack"),
        "cave",
    );
    // Not pack files Atlas reads: left where they are.
    fs::write(old.join("readme.txt"), b"notes").unwrap();
    fs::write(old.join("Ridge").join("next.atlaspack.part"), b"half").unwrap();
    write_pack_file(&old.join(".hidden").join("secret.atlaspack"), "secret");
    // A file in use, which cannot be moved.
    write_pack_file(&old.join("held.atlaspack"), "held");
    library.set_file_ops(FileOps {
        rename: Arc::new(|from: &Path, to: &Path| {
            if from
                .file_name()
                .is_some_and(|name| name == "held.atlaspack")
            {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"))
            } else {
                fs::rename(from, to)
            }
        }),
        retry_waits: vec![Duration::from_millis(1)],
        ..FileOps::default()
    });
    // A file of the same name in the new folder already, and one being
    // written there by another program.
    let new = dir.0.join("Elsewhere").join("Packs");
    write_pack_file(&new.join("valley.atlaspack"), "other-valley");
    fs::create_dir_all(new.join("Ridge")).unwrap();
    fs::write(new.join("Ridge").join("ridge.atlaspack.part"), b"half").unwrap();
    let before = library.scan();
    assert_eq!(from_packs_folder(&before).len(), 4);

    library.propose_packs_folder(&new).unwrap();
    let changed = library.apply_packs_folder(true).unwrap();
    assert_eq!(PathBuf::from(&changed.folder), new);
    assert_eq!(changed.moved, 3);
    assert_eq!(changed.left.len(), 1);
    assert_eq!(
        PathBuf::from(&changed.left[0].path),
        old.join("held.atlaspack")
    );
    assert!(changed.left[0].reason.contains("in use"));
    let mut renamed: Vec<(String, String)> = changed
        .renamed
        .iter()
        .map(|file| {
            (
                Path::new(&file.from)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                Path::new(&file.to)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            )
        })
        .collect();
    renamed.sort();
    assert_eq!(
        renamed,
        [
            (
                "ridge.atlaspack".to_owned(),
                "ridge (2).atlaspack".to_owned()
            ),
            (
                "valley.atlaspack".to_owned(),
                "valley (2).atlaspack".to_owned()
            ),
        ]
    );
    assert_eq!(
        files_under(&new),
        [
            "Deep/Deeper/cave.atlaspack",
            "Ridge/ridge (2).atlaspack",
            "Ridge/ridge.atlaspack.part",
            "valley (2).atlaspack",
            "valley.atlaspack",
        ]
    );
    // Both of a name taken are whole, and neither was written over.
    assert_eq!(
        crate::packfile::import::read_header(&new.join("valley.atlaspack"))
            .unwrap()
            .pack_id,
        "other-valley"
    );
    assert_eq!(
        crate::packfile::import::read_header(&new.join("valley (2).atlaspack"))
            .unwrap()
            .pack_id,
        "valley"
    );
    // What was not moved stays; the folders the move emptied went, and
    // the old folder, which still holds files, stays.
    assert_eq!(
        files_under(&old),
        [
            ".hidden/secret.atlaspack",
            "Ridge/next.atlaspack.part",
            "held.atlaspack",
            "readme.txt",
        ]
    );
    assert!(!old.join("Deep").exists());
    assert!(old.join("Ridge").is_dir());

    // The setting says the new folder, and the Library reads it at once.
    assert_eq!(library.packs_folder(), new);
    assert_eq!(
        library.settings().read().packs_folder.as_deref(),
        Some(new.display().to_string().as_str())
    );
    let listing = library.scan();
    assert_eq!(PathBuf::from(&listing.packs_folder.path), new);
    assert!(!listing.packs_folder.is_default);
    assert_eq!(
        from_packs_folder(&listing),
        [
            new.join("Deep/Deeper/cave.atlaspack"),
            new.join("Ridge/ridge (2).atlaspack"),
            new.join("valley (2).atlaspack"),
            new.join("valley.atlaspack"),
        ]
    );
    // The file left in the old folder is not read any more.
    assert!(!listing.packs.iter().any(|pack| pack.id == "held"));

    // The moves, to follow the paths kept elsewhere.
    assert_eq!(
        changed.moves.new_place(&old.join("valley.atlaspack")),
        Some(new.join("valley (2).atlaspack").as_path())
    );
    assert_eq!(changed.moves.new_place(&old.join("held.atlaspack")), None);
}

#[test]
fn the_old_folder_goes_once_the_move_empties_it() {
    let dir = TempDir::new("packs-folder-emptied");
    let library = library(&dir.0);
    let old = library.packs_folder();
    write_pack_file(&old.join("a").join("b").join("valley.atlaspack"), "valley");
    let new = dir.0.join("New");
    library.propose_packs_folder(&new).unwrap();
    let changed = library.apply_packs_folder(true).unwrap();
    assert_eq!((changed.moved, changed.left.len()), (1, 0));
    assert!(!old.exists(), "the empty old folder is removed");
    assert_eq!(files_under(&new), ["a/b/valley.atlaspack"]);

    // A folder the move did not empty stays.
    let other = dir.0.join("Other");
    fs::create_dir_all(new.join("empty")).unwrap();
    library.propose_packs_folder(&other).unwrap();
    library.apply_packs_folder(true).unwrap();
    assert!(new.join("empty").is_dir());
    assert!(!new.join("a").exists());
    assert_eq!(files_under(&other), ["a/b/valley.atlaspack"]);
}

#[test]
fn leaves_the_files_where_they_are_and_goes_back_to_the_default() {
    let dir = TempDir::new("packs-folder-leave");
    let library = library(&dir.0);
    let default = library.packs_folder();
    assert_eq!(default, default_packs_folder(library.settings().dir()));
    write_pack_file(&default.join("valley.atlaspack"), "valley");
    assert!(library.scan().packs_folder.is_default);
    // "Use the default folder" is refused while it is the default.
    assert!(library.propose_default_packs_folder().is_err());

    let new = dir.0.join("New");
    library.propose_packs_folder(&new).unwrap();
    let changed = library.apply_packs_folder(false).unwrap();
    assert_eq!((changed.moved, changed.left.len()), (0, 0));
    assert!(default.join("valley.atlaspack").is_file());
    let listing = library.scan();
    assert!(!listing.packs.iter().any(|pack| pack.id == "valley"));
    assert_eq!(library.packs_folder(), new);

    // Back to the default: the setting is taken out of the file.
    let choice = library.propose_default_packs_folder().unwrap();
    assert!(choice.is_default);
    assert_eq!(PathBuf::from(&choice.path), default);
    assert_eq!(choice.files, 0);
    library.apply_packs_folder(false).unwrap();
    assert_eq!(library.settings().read().packs_folder, None);
    assert!(!fs::read_to_string(library.settings().path())
        .unwrap()
        .contains("packsFolder"));
    let listing = library.scan();
    assert!(listing.packs_folder.is_default);
    assert!(listing.packs.iter().any(|pack| pack.id == "valley"));

    // The default folder picked in the dialog is the default too.
    library.propose_packs_folder(&new).unwrap();
    library.apply_packs_folder(false).unwrap();
    library.propose_packs_folder(&default).unwrap();
    library.apply_packs_folder(false).unwrap();
    assert_eq!(library.settings().read().packs_folder, None);
}

#[test]
fn follows_the_pack_files_opened_and_the_working_folders_after_a_move() {
    let dir = TempDir::new("packs-folder-follow");
    let library = library(&dir.0);
    let old = library.packs_folder();
    let file = old.join("Shared").join("valley.atlaspack");
    write_pack_file(&file, "valley");
    // In the list of pack files opened (as another app may have put it).
    library
        .settings()
        .update(|settings| {
            settings.pack_files.push(file.display().to_string());
            settings
                .pack_files
                .push("/somewhere/else.atlaspack".to_owned());
        })
        .unwrap();
    // A working folder of a map made in the app, opened from it.
    let working = library.maps_folder().join("valley");
    fs::create_dir_all(working.join(".atlas")).unwrap();
    fs::write(
        working.join("manifest.json"),
        br#"{"schemaVersion":2,"gameId":"valley","title":"Valley","packVersion":"1.0.0","gamePatch":"1","attribution":[],"idMigrations":{}}"#,
    )
    .unwrap();
    fs::write(
        working.join(".atlas").join("editing.json"),
        serde_json::json!({"format": "atlas-editing", "version": 1,
            "path": file.display().to_string(), "packUpdated": "2026-11-01T00:00:00Z",
            "exportedAt": "2026-11-02T00:00:00Z", "openedAt": "2026-11-03T00:00:00Z"})
        .to_string(),
    )
    .unwrap();

    let new = dir.0.join("New");
    library.propose_packs_folder(&new).unwrap();
    let changed = library.apply_packs_folder(true).unwrap();
    let moved = new.join("Shared").join("valley.atlaspack");
    assert!(moved.is_file());
    assert_eq!(
        library.settings().read().pack_files,
        [
            moved.display().to_string(),
            "/somewhere/else.atlaspack".to_owned()
        ]
    );
    let record = crate::madepack::read_editing_record(&working).unwrap();
    assert_eq!(record.path, moved);
    assert_eq!(record.exported_at, "2026-11-02T00:00:00Z");
    // This app's own record of the files it wrote follows too.
    let store = crate::madepack::store::Store::new(&dir.0.join("data"));
    store
        .note_written(crate::madepack::store::WrittenFile {
            pack_id: "valley".into(),
            exported_at: "2026-11-02T00:00:00Z".into(),
            path: file.clone(),
        })
        .unwrap();
    assert_eq!(store.follow_moves(&changed.moves), Ok(1));
    assert_eq!(store.read().last_written("valley").unwrap().path, moved);
    assert_eq!(store.follow_moves(&MovedFiles::default()), Ok(0));
}

#[test]
fn a_move_across_drives_copies_checks_and_then_deletes() {
    let dir = TempDir::new("packs-folder-across");
    let old = dir.0.join("old");
    let new = dir.0.join("new");
    fs::create_dir_all(&new).unwrap();
    let file = old.join("valley.atlaspack");
    write_pack_file(&file, "valley");
    let bytes = fs::read(&file).unwrap();
    let target = new.join("valley.atlaspack");
    copy_across(&file, &target, &FileOps::default()).unwrap();
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert!(!file.exists());
    assert_eq!(files_under(&new), ["valley.atlaspack"]);

    // A file that does not read as a pack file is not taken: it stays,
    // and no part file is left.
    let broken = old.join("broken.atlaspack");
    fs::write(&broken, b"not a pack file").unwrap();
    let error =
        copy_across(&broken, &new.join("broken.atlaspack"), &FileOps::default()).unwrap_err();
    assert!(error.contains("not whole"), "{error}");
    assert!(broken.is_file());
    assert_eq!(files_under(&new), ["valley.atlaspack"]);

    // An original in use, which cannot be deleted: the copy goes again, so
    // the file is in one place only.
    let held = old.join("held.atlaspack");
    write_pack_file(&held, "held");
    let in_use = FileOps {
        remove_file: Arc::new(|_: &Path| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"))
        }),
        retry_waits: vec![Duration::from_millis(1)],
        ..FileOps::default()
    };
    let error = copy_across(&held, &new.join("held.atlaspack"), &in_use).unwrap_err();
    assert!(error.contains("in use"), "{error}");
    assert!(held.is_file());
    assert_eq!(files_under(&new), ["valley.atlaspack"]);
}

#[test]
fn the_move_reports_each_file_it_could_not_move_and_goes_on() {
    let dir = TempDir::new("packs-folder-failing");
    let old = dir.0.join("old");
    let new = dir.0.join("new");
    for name in ["a", "b", "c"] {
        write_pack_file(&old.join(format!("{name}.atlaspack")), name);
    }
    let failing = FileOps {
        rename: Arc::new(|from: &Path, to: &Path| {
            if from.file_name().is_some_and(|name| name == "b.atlaspack") {
                Err(io::Error::other("the disk said no"))
            } else {
                fs::rename(from, to)
            }
        }),
        retry_waits: vec![Duration::from_millis(1)],
        ..FileOps::default()
    };
    let mut changed = PacksFolderChanged::default();
    move_pack_files(&old, &new, None, &failing, &mut changed);
    assert_eq!(changed.moved, 2);
    assert_eq!(changed.left.len(), 1);
    assert!(
        changed.left[0].reason.contains("the disk said no"),
        "{:?}",
        changed.left
    );
    assert_eq!(files_under(&old), ["b.atlaspack"]);
    assert_eq!(files_under(&new), ["a.atlaspack", "c.atlaspack"]);
}
