//! Maps made here becoming pack files: writing one with the person's own
//! things, writing it back over the file it was opened from, refusing a
//! newer file, a failed check, opening for editing and closing without
//! writing, the records read as untrusted, and the maker's own things
//! offered on another computer.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::json;

use super::{
    close_editing, mine_offer, note_choice, open_for_editing, plan_open, plan_write,
    read_editing_record,
    store::{Choice, Store, WrittenFile, MAX_STORE_BYTES},
    take_mine, write_made, write_made_with, EDITING_RECORD,
};
use crate::{
    library::{Library, META_DIR},
    oldfolders,
    owngame::{create_game, Cutting},
    ownlists::{LISTS, LOCATIONS},
    packfile::{
        import::read_header,
        inplace::testing as pack_file,
        tests::{app, library_with, put, put_json},
        Stop,
    },
    tiles::store::tests::TempDir,
};

const GAME: &str = "ruined-keep";

pub(crate) fn own_locations(game: &str, names: &[&str]) -> String {
    let locations: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(n, name)| {
            json!({"id": format!("{game}:loc:own.{n}"), "mapId": format!("{game}:map:courtyard"),
                   "layerId": format!("{game}:layer:courtyard"), "x": 10 + n, "y": 20,
                   "categoryId": format!("{game}:cat:own.gate"), "regionId": null, "name": name})
        })
        .collect();
    json!({"format": "atlas-own-locations", "version": 1, "gameId": game, "updatedAt": "2026-11-12T09:00:00Z",
           "categoryGroups": [{"id": format!("{game}:catgroup:own.mine"), "name": "My types", "order": 9}],
           "categories": [{"id": format!("{game}:cat:own.gate"), "groupId": format!("{game}:catgroup:own.mine"), "name": "Gate"}],
           "regions": [], "locations": locations})
    .to_string()
}

pub(crate) fn own_lists(game: &str) -> String {
    json!({"format": "atlas-own-lists", "version": 1, "gameId": game, "updatedAt": "2026-11-12T09:00:00Z",
           "lists": [{"checklist": {"id": format!("{game}:checklist:own.gates")}}, {"checklist": {"id": format!("{game}:checklist:own.halls")}}]})
    .to_string()
}

/// A maps folder of its own, with a map made here from a picture ("Ruined
/// Keep") and the person's own locations and lists of it beside it.
struct Here {
    library: Library,
    store: Store,
    dir: TempDir,
}

impl Here {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let (library, _) = library_with(&dir.0, Vec::new());
        let store = Store::new(&dir.0.join("data"));
        Self {
            library,
            store,
            dir,
        }
    }

    fn maps(&self) -> PathBuf {
        self.library.maps_folder()
    }

    /// Makes the map, with three locations and two lists of one's own.
    fn make_map(&self) -> PathBuf {
        let picture = self.dir.0.join("courtyard.png");
        image::RgbImage::from_fn(300, 200, |x, y| image::Rgb([x as u8, y as u8, 90]))
            .save(&picture)
            .unwrap();
        let mut progress = |_| {};
        let added = create_game(
            &self.maps(),
            "Ruined Keep",
            "Courtyard",
            &picture,
            &app(),
            |_| false,
            &mut Cutting {
                progress: &mut progress,
                cancelled: &|| false,
            },
        )
        .unwrap();
        assert_eq!(added.game_id, GAME);
        LOCATIONS
            .write(
                &self.maps(),
                GAME,
                &own_locations(GAME, &["North gate", "Well", "Tower"]),
                None,
            )
            .unwrap();
        LISTS
            .write(&self.maps(), GAME, &own_lists(GAME), None)
            .unwrap();
        self.library.scan();
        self.maps().join(GAME)
    }

    fn listed(&self) -> crate::library::ListedPack {
        self.library
            .scan()
            .packs
            .into_iter()
            .find(|pack| pack.id == GAME)
            .expect("the map is listed")
    }

    fn write(&self, replace_newer: bool) -> Result<super::MadeWritten, Stop> {
        write_made(
            &self.library,
            &self.store,
            GAME,
            &app(),
            replace_newer,
            &mut |_| {},
            &|| false,
        )
    }

    fn open(&self) -> Result<super::OpenedForEditing, Stop> {
        open_for_editing(&self.library, &self.store, GAME, &mut |_| {}, &|| false)
    }

    /// The pack files in the packs folder.
    fn pack_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = fs::read_dir(self.library.packs_folder())
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        files.sort();
        files
    }
}

#[test]
fn writes_the_pack_file_of_a_map_made_here_with_the_persons_own_things() {
    let here = Here::new("madepack-write");
    let folder = here.make_map();
    let listed = here.listed();
    assert!(listed.made_here && listed.made_in_app && !listed.pack_file);
    assert!(listed.editing.is_none());

    let plan = plan_write(&here.library, &here.store, GAME).unwrap();
    let target = here.library.packs_folder().join("Ruined Keep.atlaspack");
    assert_eq!(PathBuf::from(&plan.target), target);
    assert_eq!(plan.file_name, "Ruined Keep.atlaspack");
    assert!(!plan.replaces && !plan.opened_from && plan.removes_folder);
    assert_eq!(plan.newer, None);
    let mine = plan.mine.expect("own things go in the file");
    assert_eq!((mine.locations, mine.types, mine.lists), (3, 1, 2));

    let written = here.write(false).unwrap();
    assert_eq!(PathBuf::from(&written.path), target);
    assert!(written.folder_removed && written.folder_complete);
    assert_eq!(written.note, None);
    // Only the file, no part file left.
    assert_eq!(here.pack_files(), vec![target.clone()]);
    // The description says what it carries, as the shared crate reads it.
    let header = atlas_pack::read_header(&target).unwrap();
    assert_eq!(header.pack_id, GAME);
    let carried = header.mine.expect("the description names the own things");
    assert_eq!((carried.locations, carried.lists), (3, 2));
    assert!(header.images.files > 0);
    assert_eq!(header.images.detail, crate::packfile::Detail::Full);
    // The folder went; the own files beside it stay.
    assert!(!folder.exists());
    assert!(LOCATIONS.read(&here.maps(), GAME).unwrap().is_some());
    assert!(LISTS.read(&here.maps(), GAME).unwrap().is_some());
    // Atlas reads the map from the file now.
    let listed = here.listed();
    assert!(listed.pack_file && listed.made_in_app && !listed.made_here);
    assert_eq!(
        listed.path.as_deref().map(Path::new),
        Some(target.as_path())
    );
    // This computer remembers it wrote that file, and never offers its own
    // things back from it.
    let remembered = here.store.read();
    assert!(remembered.wrote(GAME, &header.exported_at));
    assert_eq!(mine_offer(&here.library, &here.store, GAME), None);
    // A map read from a pack file cannot be written again.
    assert!(plan_write(&here.library, &here.store, GAME).is_err());
}

#[test]
fn writes_a_map_opened_for_editing_back_over_the_file_it_came_from() {
    let here = Here::new("madepack-write-back");
    here.make_map();
    let first = here.write(false).unwrap();
    let file = PathBuf::from(&first.path);

    let plan = plan_open(&here.library, &here.store, GAME).unwrap();
    assert_eq!(PathBuf::from(&plan.path), file);
    assert_eq!(PathBuf::from(&plan.folder), here.maps().join(GAME));
    // Written here: its own things are here already.
    assert_eq!(plan.mine, None);
    let opened = here.open().unwrap();
    assert!(opened.mine.is_empty());
    let folder = opened.folder.clone();
    assert!(folder.join("manifest.json").is_file());
    let record = read_editing_record(&folder).expect("a record of the file");
    assert_eq!(record.path, file);
    assert_eq!(record.exported_at, first.header.exported_at);
    // The folder is shown, made here, and says what it was opened from.
    let listed = here.listed();
    assert!(listed.made_here && !listed.pack_file);
    assert_eq!(
        listed
            .editing
            .as_ref()
            .map(|editing| PathBuf::from(&editing.path)),
        Some(file.clone())
    );
    assert!(oldfolders::is_made_here(
        &folder,
        &crate::manifest::read_head(&folder).unwrap()
    ));
    assert_eq!(
        oldfolders::list(&here.library)
            .made_here
            .iter()
            .map(|old| old.id.as_str())
            .collect::<Vec<_>>(),
        [GAME]
    );

    // It is edited like any map made here: renamed.
    crate::owngame::rename_game(&folder, "Ruined Keep of Ash").unwrap();
    let plan = plan_write(&here.library, &here.store, GAME).unwrap();
    assert_eq!(PathBuf::from(&plan.target), file);
    assert!(plan.replaces && plan.opened_from);
    assert_eq!(plan.newer, None);
    let again = here.write(false).unwrap();
    assert_eq!(PathBuf::from(&again.path), file);
    assert!(again.folder_removed);
    assert!(!folder.exists());
    assert_eq!(here.pack_files(), vec![file.clone()]);
    assert_eq!(read_header(&file).unwrap().title, "Ruined Keep of Ash");
}

#[test]
fn never_writes_over_a_newer_file_unless_the_person_chooses_replace() {
    let here = Here::new("madepack-newer");
    here.make_map();
    let file = PathBuf::from(&here.write(false).unwrap().path);
    let folder = here.open().unwrap().folder;
    // Another computer wrote a newer version of the file meanwhile.
    pack_file::write(
        &file,
        &pack_file::header(
            GAME,
            "Ruined Keep",
            "2099-01-01T00:00:00Z",
            "2099-01-02T00:00:00Z",
        ),
    );
    let newer = fs::read(&file).unwrap();

    let plan = plan_write(&here.library, &here.store, GAME).unwrap();
    assert!(plan.replaces && plan.opened_from);
    assert!(plan.newer.as_deref().unwrap().contains("newer"), "{plan:?}");
    let refused = here.write(false).unwrap_err();
    assert!(
        matches!(&refused, Stop::Failed(text) if text.contains("newer") && text.contains("Replace")),
        "{refused:?}"
    );
    assert_eq!(fs::read(&file).unwrap(), newer);
    assert!(folder.join("manifest.json").is_file());

    // Chosen: written over it.
    let written = here.write(true).unwrap();
    assert_eq!(PathBuf::from(&written.path), file);
    assert_ne!(fs::read(&file).unwrap(), newer);
    assert!(!folder.exists());
}

#[test]
fn a_file_that_fails_its_check_leaves_the_folder_untouched() {
    let here = Here::new("madepack-check");
    let folder = here.make_map();
    let before = fs::read(folder.join("manifest.json")).unwrap();
    let failed = write_made_with(
        &here.library,
        &here.store,
        GAME,
        &app(),
        false,
        &|part| {
            // Damaged on the disk before it is checked.
            let bytes = fs::read(part).unwrap();
            fs::write(part, &bytes[..bytes.len() / 2]).unwrap();
        },
        &mut |_| {},
        &|| false,
    )
    .unwrap_err();
    assert!(
        matches!(&failed, Stop::Failed(text) if text.contains("did not pass the check")),
        "{failed:?}"
    );
    assert!(here.pack_files().is_empty(), "{:?}", here.pack_files());
    assert_eq!(fs::read(folder.join("manifest.json")).unwrap(), before);
    assert!(here.listed().made_here);
    assert!(here.store.read().written.is_empty());
    // A cancel leaves it too.
    let cancelled = write_made(
        &here.library,
        &here.store,
        GAME,
        &app(),
        false,
        &mut |_| {},
        &|| true,
    )
    .unwrap_err();
    assert_eq!(cancelled, Stop::Cancelled);
    assert!(here.pack_files().is_empty());
    assert!(folder.join("manifest.json").is_file());
}

#[test]
fn opens_for_editing_and_closes_without_writing() {
    let here = Here::new("madepack-close");
    here.make_map();
    let file = PathBuf::from(&here.write(false).unwrap().path);
    let bytes = fs::read(&file).unwrap();
    let folder = here.open().unwrap().folder;
    assert!(here.listed().editing.is_some());
    // Opening again is refused while the folder is there.
    assert!(plan_open(&here.library, &here.store, GAME).is_err());

    close_editing(&here.library, GAME).unwrap();
    assert!(!folder.exists());
    assert_eq!(fs::read(&file).unwrap(), bytes);
    let listed = here.listed();
    assert!(listed.pack_file && listed.editing.is_none());

    // With the pack file gone, closing would lose the map: refused.
    let folder = here.open().unwrap().folder;
    let away = here.dir.0.join("elsewhere.atlaspack");
    fs::rename(&file, &away).unwrap();
    let refused = close_editing(&here.library, GAME).unwrap_err();
    assert!(refused.contains("not there any more"), "{refused}");
    assert!(folder.join("manifest.json").is_file());
    // Written instead: into the packs folder, as a new file.
    let written = here.write(false).unwrap();
    assert_eq!(
        PathBuf::from(&written.path),
        here.library.packs_folder().join("Ruined Keep.atlaspack")
    );

    // A map made here, never opened from a file, cannot be closed so.
    let made = Here::new("madepack-close-made");
    made.make_map();
    assert!(close_editing(&made.library, GAME)
        .unwrap_err()
        .contains("not opened for editing"));
}

#[test]
fn a_pack_file_not_made_in_the_app_is_never_opened_for_editing() {
    let here = Here::new("madepack-not-made");
    let file = here.library.packs_folder().join("Test Valley.atlaspack");
    pack_file::write(
        &file,
        &pack_file::header(
            "test-valley",
            "Test Valley",
            "2026-11-10T00:00:00Z",
            "2026-11-11T00:00:00Z",
        ),
    );
    here.library.scan();
    let refused = plan_open(&here.library, &here.store, "test-valley").unwrap_err();
    assert!(refused.contains("Only a map made in Atlas"), "{refused}");
    assert!(open_for_editing(
        &here.library,
        &here.store,
        "test-valley",
        &mut |_| {},
        &|| false
    )
    .is_err());
    assert!(!here.maps().join("test-valley").exists());
    assert_eq!(mine_offer(&here.library, &here.store, "test-valley"), None);
}

#[test]
fn the_records_are_read_as_untrusted() {
    let dir = TempDir::new("madepack-records");
    let folder = dir.0.join("ruined-keep");
    let record = folder.join(META_DIR).join(EDITING_RECORD);
    let absolute = dir.0.join("Ruined Keep.atlaspack");
    let good = json!({"format": "atlas-editing", "version": 1, "path": absolute.display().to_string(),
                      "packUpdated": "2026-11-10T00:00:00Z", "exportedAt": "2026-11-11T00:00:00Z",
                      "openedAt": "2026-11-12T00:00:00Z"});
    put_json(&record, &good);
    let read = read_editing_record(&folder).unwrap();
    assert_eq!(read.path, absolute);
    assert_eq!(read.pack_updated.as_deref(), Some("2026-11-10T00:00:00Z"));

    let mut cases = Vec::new();
    for (key, value) in [
        ("format", json!("something-else")),
        ("version", json!(2)),
        ("path", json!("Ruined Keep.atlaspack")),
        ("path", json!(dir.0.join("notes.txt").display().to_string())),
        ("path", json!(42)),
        ("exportedAt", json!("yesterday")),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        cases.push(bad.to_string().into_bytes());
    }
    cases.push(b"{ not json".to_vec());
    cases.push(vec![b' '; 65 << 10]);
    for bytes in cases {
        put(&record, &bytes);
        assert_eq!(
            read_editing_record(&folder),
            None,
            "{}",
            String::from_utf8_lossy(&bytes[..bytes.len().min(80)])
        );
    }
    // A bad packUpdated is left out, the rest kept.
    let mut odd = good.clone();
    odd["packUpdated"] = json!("soon");
    put_json(&record, &odd);
    assert_eq!(read_editing_record(&folder).unwrap().pack_updated, None);
    // A folder in its place is not read.
    fs::remove_file(&record).unwrap();
    fs::create_dir_all(&record).unwrap();
    assert_eq!(read_editing_record(&folder), None);

    // What this computer remembers.
    let store = Store::new(&dir.0.join("data"));
    assert!(store.read().written.is_empty());
    store
        .note_written(WrittenFile {
            pack_id: GAME.into(),
            exported_at: "2026-11-11T00:00:00Z".into(),
            path: absolute.clone(),
        })
        .unwrap();
    store
        .note_choice(GAME, "2026-11-11T00:00:00Z", Choice::Dismissed)
        .unwrap();
    store
        .note_choice(GAME, "2026-11-11T00:00:00Z", Choice::Added)
        .unwrap();
    let read = store.read();
    assert!(read.wrote(GAME, "2026-11-11T00:00:00Z"));
    assert_eq!(read.offered.len(), 1);
    assert_eq!(
        read.choice(GAME, "2026-11-11T00:00:00Z"),
        Some(Choice::Added)
    );
    // Entries that cannot be used are dropped, the others kept.
    put_json(
        store.path(),
        &json!({"format": "atlas-made-packs", "version": 1,
                "written": [{"packId": GAME, "exportedAt": "2026-11-11T00:00:00Z", "path": absolute.display().to_string()},
                            {"packId": "Not An Id!", "exportedAt": "2026-11-11T00:00:00Z", "path": absolute.display().to_string()},
                            {"packId": GAME, "exportedAt": "2026-11-11T00:00:00Z", "path": "relative.atlaspack"},
                            {"packId": GAME, "exportedAt": "never", "path": absolute.display().to_string()}],
                "offered": [{"packId": GAME, "exportedAt": "2026-11-11T00:00:00Z", "choice": "maybe"},
                            {"packId": GAME, "exportedAt": "2026-11-11T00:00:00Z", "choice": "dismissed"}]}),
    );
    let read = store.read();
    assert_eq!(read.written.len(), 1);
    assert_eq!(
        read.choice(GAME, "2026-11-11T00:00:00Z"),
        Some(Choice::Dismissed)
    );
    // Another format, a newer version, damage or a file too large counts as none.
    for bytes in [
        json!({"format": "other", "version": 1, "written": []})
            .to_string()
            .into_bytes(),
        json!({"format": "atlas-made-packs", "version": 2, "written": []})
            .to_string()
            .into_bytes(),
        b"[1, 2".to_vec(),
        vec![b' '; usize::try_from(MAX_STORE_BYTES).unwrap() + 1],
    ] {
        put(store.path(), &bytes);
        assert!(store.read().written.is_empty());
        assert!(store.read().offered.is_empty());
    }
    // A choice for something that cannot be named is refused.
    assert!(note_choice(&store, "Not An Id!", "2026-11-11T00:00:00Z", true).is_err());
    assert!(note_choice(&store, GAME, "later", true).is_err());
}

#[test]
fn offers_the_makers_own_things_on_another_computer_once() {
    let maker = Here::new("madepack-offer-maker");
    maker.make_map();
    let written = maker.write(false).unwrap();
    let exported_at = written.header.exported_at.clone();

    // The same file in the packs folder of another computer.
    let other = Here::new("madepack-offer-other");
    fs::create_dir_all(other.library.packs_folder()).unwrap();
    let file = other.library.packs_folder().join("Ruined Keep.atlaspack");
    fs::copy(&written.path, &file).unwrap();
    other.library.scan();
    let offer = mine_offer(&other.library, &other.store, GAME).expect("offered");
    assert_eq!(offer.exported_at, exported_at);
    assert_eq!((offer.facts.locations, offer.facts.lists), (3, 2));
    assert_eq!(PathBuf::from(&offer.path), file);
    // Taken with the import's checks: what an import would give.
    let (header, mine) = take_mine(&other.library, GAME, &exported_at).unwrap();
    assert_eq!(header.exported_at, exported_at);
    assert!(mine.locations.as_deref().unwrap().contains("North gate"));
    assert!(mine.lists.is_some());
    // Another version than the one offered is refused.
    assert!(take_mine(&other.library, GAME, "2026-01-01T00:00:00Z").is_err());
    // Nothing was written by reading it.
    assert!(LOCATIONS.read(&other.maps(), GAME).unwrap().is_none());
    // Once added (or dismissed), it is not offered again for this version.
    note_choice(&other.store, GAME, &exported_at, true).unwrap();
    assert_eq!(mine_offer(&other.library, &other.store, GAME), None);
    // Opening it for editing there does not hand them over again either.
    assert_eq!(
        plan_open(&other.library, &other.store, GAME).unwrap().mine,
        None
    );

    // A third computer that said no to it is not asked again; opening it
    // for editing still hands them over, as the question says.
    let third = Here::new("madepack-offer-third");
    fs::create_dir_all(third.library.packs_folder()).unwrap();
    fs::copy(
        &written.path,
        third.library.packs_folder().join("Ruined Keep.atlaspack"),
    )
    .unwrap();
    third.library.scan();
    note_choice(&third.store, GAME, &exported_at, false).unwrap();
    assert_eq!(mine_offer(&third.library, &third.store, GAME), None);
    let plan = plan_open(&third.library, &third.store, GAME).unwrap();
    assert_eq!(plan.mine.map(|facts| facts.locations), Some(3));
    let opened = third.open().unwrap();
    assert!(opened.mine.locations.is_some());

    // A damaged own file in a pack file is refused as an import refuses it.
    let damaged = Here::new("madepack-offer-damaged");
    let bad = damaged.library.packs_folder().join("Bad.atlaspack");
    let mut header = pack_file::header(
        "bad-keep",
        "Bad Keep",
        "2026-11-10T00:00:00Z",
        "2026-11-11T00:00:00Z",
    );
    header["version"] = json!(2);
    header["mine"] = json!({"locations": 1});
    pack_file::write_with(
        &bad,
        &header,
        &[(
            "mine/my-locations.json",
            own_locations("another-game", &["Elsewhere"]),
        )],
    );
    assert!(crate::packfile::import::read_mine(&bad).is_err());
}
