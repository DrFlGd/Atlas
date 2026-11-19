//! Keeping packs up to date: the setting and the record, the fingerprint,
//! the look into the folder, the names of new files, the rules, and the
//! keeper itself writing made-up games into a folder.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde_json::{json, Value};

use super::{
    fingerprint,
    folder::{self, Copy, HeaderCache, NEW_PACKS_FOLDER, PART_ENDING},
    plan::{decide, Action, Game},
    store::{Record, Schedule, Setting, Store, Written},
    Activity, Keeper, Parts, RowState, Status, Timing, MADE_HERE,
};
use crate::{
    library::Library,
    packfile::{
        export::export,
        import::read_header,
        tests::{app, library_with, put, put_json, write_pack, ID},
        Detail, Header, PackSource,
    },
    tiles::store::tests::TempDir,
};

fn written(path: PathBuf) -> Written {
    Written {
        path,
        written_at: Some("2026-11-12T10:00:00Z".into()),
        exported_at: "2026-11-12T10:00:00Z".into(),
        pack_updated: Some("2026-11-10T21:32:10.000Z".into()),
        fingerprint: "0123456789abcdef".into(),
        images: 3,
        size: 10,
    }
}

// ---------------------------------------------------------------------------
// The setting and the record

#[test]
fn the_setting_and_the_record_are_read_as_untrusted() {
    let dir = TempDir::new("keep-store");
    let store = Store::new(&dir.0.join("data"));
    assert_eq!(store.read_setting(), Setting::default());
    assert_eq!(store.read_record(), Record::default());

    let folder = dir.0.join("Maps and Guides");
    let setting = Setting {
        on: true,
        folder: Some(folder.clone()),
        schedule: Schedule::Weekly,
    };
    store.write_setting(&setting).unwrap();
    assert_eq!(store.read_setting(), setting);

    let entry = written(folder.join("Test Valley.atlaspack"));
    let record = Record {
        folder: Some(folder.clone()),
        last_check_at: Some("2026-11-12T10:00:00Z".into()),
        packs: [(ID.to_owned(), entry.clone())].into(),
    };
    store.write_record(&record).unwrap();
    assert_eq!(store.read_record(), record);

    // Entries that cannot be used are dropped, the others kept.
    let entry_json = serde_json::to_value(&entry).unwrap();
    let mut relative = entry_json.clone();
    relative["path"] = json!("Maps and Guides");
    let mut bad_time = entry_json.clone();
    bad_time["exportedAt"] = json!("yesterday");
    let mut no_fingerprint = entry_json.clone();
    no_fingerprint
        .as_object_mut()
        .unwrap()
        .remove("fingerprint");
    put_json(
        &store.record_path(),
        &json!({"format": "atlas-kept-packs-record", "version": 1,
                "folder": folder.display().to_string(),
                "packs": {ID: entry_json, "Not An Id!": entry_json, "example-game": relative,
                          "example-site": bad_time, "test-valley-2": no_fingerprint}}),
    );
    let read = store.read_record();
    assert_eq!(read.packs.keys().collect::<Vec<_>>(), vec![ID]);
    assert_eq!(read.folder, Some(folder.clone()));

    // A damaged file, another format, a newer version or a file too large
    // counts as none.
    put(&store.record_path(), b"{ not json");
    assert_eq!(store.read_record(), Record::default());
    put_json(
        &store.record_path(),
        &json!({"format": "atlas-kept-packs-record", "version": 2, "packs": {}}),
    );
    assert_eq!(store.read_record(), Record::default());
    put_json(
        &store.setting_path(),
        &json!({"format": "something-else", "version": 1, "on": true}),
    );
    assert_eq!(store.read_setting(), Setting::default());
    put(&store.setting_path(), &vec![b' '; 65 << 10]);
    assert_eq!(store.read_setting(), Setting::default());
    // A setting with an odd schedule or folder keeps what it can.
    put_json(
        &store.setting_path(),
        &json!({"format": "atlas-kept-packs", "version": 1, "on": true, "folder": "relative", "schedule": "hourly"}),
    );
    assert_eq!(
        store.read_setting(),
        Setting {
            on: true,
            folder: None,
            schedule: Schedule::Start
        }
    );
}

// ---------------------------------------------------------------------------
// The fingerprint

#[test]
fn the_fingerprint_changes_with_the_game_and_only_then() {
    let dir = TempDir::new("keep-fingerprint");
    let game = dir.0.join(ID);
    write_pack(&game, "1.0.0");
    let first = fingerprint::take(&game, None);
    assert!(first.complete);
    assert_eq!(first.hash.len(), 16);
    assert!(first.images > 0);
    assert_eq!(fingerprint::take(&game, None), first);

    // Page data, the app's own files and unfinished files do not count.
    put(&game.join("import").join("west-ridge.json"), b"{}");
    put(&game.join(".atlas").join("download-job.json"), b"{\"a\":1}");
    put(&game.join("tiles").join("a").join("9.png.part"), b"part");
    assert_eq!(fingerprint::take(&game, None).hash, first.hash);

    // A new image, a file rewritten, or another title shown, does.
    put(
        &game
            .join("tiles")
            .join("a")
            .join("3")
            .join("9")
            .join("9.png"),
        b"new",
    );
    let more = fingerprint::take(&game, None);
    assert_ne!(more.hash, first.hash);
    assert_eq!(more.images, first.images + 1);
    put_json(&game.join("locations.json"), &json!([{"id": "x1"}]));
    let rewritten = fingerprint::take(&game, None);
    assert_ne!(rewritten.hash, more.hash);
    assert_ne!(
        fingerprint::take(&game, Some("Example Game")).hash,
        rewritten.hash
    );

    // A folder that cannot be read gives an incomplete fingerprint.
    assert!(!fingerprint::take(&dir.0.join("missing"), None).complete);
}

// ---------------------------------------------------------------------------
// The folder

fn source(dir: &Path) -> PackSource {
    PackSource {
        pack_id: ID.into(),
        root: dir.to_path_buf(),
        images: dir.to_path_buf(),
        lock: false,
        comes_with_app: false,
        own_use_pictures: false,
        smaller_pictures: false,
        group: None,
    }
}

/// Writes the made-up game as a pack file at `file`, and gives its header.
fn pack_file(game: &Path, file: &Path) -> Header {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    export(
        &source(game),
        &app(),
        Detail::Overview,
        file,
        &mut |_| {},
        &|| false,
    )
    .unwrap();
    read_header(file).unwrap()
}

#[test]
fn the_look_knows_packs_by_their_id_wherever_they_lie() {
    let dir = TempDir::new("keep-look");
    let game = dir.0.join("game");
    write_pack(&game, "1.0.0");
    let repo = dir.0.join("Maps and Guides");
    pack_file(&game, &repo.join("Example Site").join("any name.ATLASPACK"));
    pack_file(&game, &repo.join("second.atlaspack"));
    // Not looked into: a folder whose name begins with a dot, a pack folder.
    pack_file(&game, &repo.join(".hidden").join("hidden.atlaspack"));
    write_pack(&repo.join("a pack folder"), "1.0.0");
    pack_file(&game, &repo.join("a pack folder").join("inside.atlaspack"));
    // Left alone: other files, other unfinished files, a broken pack file.
    put(&repo.join("notes.txt"), b"notes");
    put(&repo.join("other.atlaspack.part"), b"someone else's");
    put(&repo.join("broken.atlaspack"), b"not a zip");
    let ours = repo.join(format!("new.atlaspack{PART_ENDING}"));
    put(&ours, b"unfinished");

    let mut cache = HeaderCache::default();
    let found = folder::look(&repo, &mut cache);
    assert!(!found.incomplete);
    let copies = &found.copies[ID];
    let mut names: Vec<String> = copies
        .iter()
        .map(|copy| {
            copy.path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    assert_eq!(names, vec!["any name.ATLASPACK", "second.atlaspack"]);
    assert_eq!(found.copies.len(), 1);
    assert_eq!(found.parts, vec![ours.clone()]);
    assert_eq!(found.unreadable.len(), 1);
    assert!(found.unreadable[0].0.ends_with("broken.atlaspack"));

    // A missing folder is not read whole.
    assert!(folder::look(&dir.0.join("gone"), &mut cache).incomplete);

    // Only this app's own unfinished files, and only old ones, are cleared.
    assert!(folder::clear_leftovers(&found.parts, SystemTime::now()).is_empty());
    assert!(ours.exists());
    let later = SystemTime::now() + folder::LEFTOVER_AGE + Duration::from_secs(1);
    let other = repo.join("other.atlaspack.part");
    assert_eq!(
        folder::clear_leftovers(&[ours.clone(), other.clone()], later),
        vec![ours.clone()]
    );
    assert!(!ours.exists());
    assert!(other.exists());
    assert!(repo.join("notes.txt").exists());
    assert_eq!(
        folder::part_of(&repo.join("a.atlaspack")),
        repo.join(format!("a.atlaspack{PART_ENDING}"))
    );
}

#[test]
fn new_file_names_are_safe_on_windows() {
    use folder::stem_from;
    assert_eq!(
        stem_from(Some("Test Valley"), "Test Valley", Some("Example Site"), ID),
        "Test Valley - Example Site"
    );
    // No site: the pack's own title when it differs, else the game alone.
    assert_eq!(
        stem_from(Some("Example Game"), "Test Valley", None, ID),
        "Example Game - Test Valley"
    );
    assert_eq!(
        stem_from(Some("Example Game"), "Example Game", None, ID),
        "Example Game"
    );
    assert_eq!(stem_from(None, "  ", None, ID), ID);
    assert_eq!(
        stem_from(
            Some("Test: Valley <2>?"),
            "x",
            Some("Example/Site\\Wiki"),
            ID
        ),
        "Test - Valley 2 - Example-Site-Wiki"
    );
    assert_eq!(stem_from(Some("Valley... "), "Valley", None, ID), "Valley");
    assert_eq!(stem_from(Some("con"), "con", None, ID), "con_");
    assert_eq!(
        stem_from(Some("LPT1.txt"), "LPT1.txt", None, ID),
        "LPT1.txt_"
    );
    assert_eq!(stem_from(Some("..."), "...", None, ID), ID);
    let long = stem_from(Some(&"Valley ".repeat(40)), "x", Some("Example Site"), ID);
    assert!(long.chars().count() <= folder::MAX_STEM_CHARS);
    assert!(!long.ends_with(' '));

    let dir = TempDir::new("keep-names");
    assert_eq!(
        folder::free_path(&dir.0, "Test Valley"),
        Some(dir.0.join("Test Valley.atlaspack"))
    );
    put(&dir.0.join("test valley.ATLASPACK"), b"taken");
    put(
        &dir.0
            .join(format!("Test Valley (2).atlaspack{PART_ENDING}")),
        b"being written",
    );
    assert_eq!(
        folder::free_path(&dir.0, "Test Valley"),
        Some(dir.0.join("Test Valley (3).atlaspack"))
    );
}

// ---------------------------------------------------------------------------
// The rules

#[test]
fn never_replaces_a_pack_with_an_older_one() {
    let dir = TempDir::new("keep-plan");
    let game = dir.0.join("game");
    write_pack(&game, "1.0.0");
    let path = dir.0.join("repo").join("Test Valley.atlaspack");
    let header = pack_file(&game, &path);
    let copy_with = |updated: Option<&str>, exported_at: &str, images: u64| {
        let mut header = header.clone();
        header.pack.updated = updated.map(str::to_owned);
        header.exported_at = exported_at.to_owned();
        header.images.files = images;
        Copy {
            path: path.clone(),
            header,
        }
    };
    let ours = fingerprint::Fingerprint {
        hash: "0123456789abcdef".into(),
        images: 10,
        image_bytes: 100,
        // 2026-11-12T12:00:00Z
        changed_at: 1_794_484_800_000,
        complete: true,
    };
    let at = |text: &str| crate::packfile::iso_millis(text);
    let game_of = |updated: &str| Game {
        updated: at(updated),
        fingerprint: &ours,
    };
    let same = game_of("2026-11-10T21:32:10Z");
    let record = Written {
        fingerprint: ours.hash.clone(),
        ..written(path.clone())
    };

    // Nothing in the folder.
    assert_eq!(decide(&same, None, &[], true), Action::WriteNew);
    assert_eq!(decide(&same, None, &[], false), Action::FolderNotReadWhole);
    assert_eq!(decide(&same, Some(&record), &[], true), Action::NotInFolder);

    // The pack in the folder was changed later, or earlier.
    let newer = copy_with(Some("2026-11-11T00:00:00Z"), "2026-11-11T00:00:00Z", 10);
    assert_eq!(
        decide(&same, Some(&record), &[newer], true),
        Action::NewerInFolder
    );
    let older = copy_with(Some("2026-11-01T00:00:00Z"), "2026-11-12T10:00:00Z", 10);
    assert_eq!(
        decide(&same, Some(&record), std::slice::from_ref(&older), true),
        Action::Replace
    );
    let no_time = copy_with(None, "2026-11-12T10:00:00Z", 10);
    assert_eq!(decide(&same, None, &[no_time], true), Action::Replace);
    let none_here = Game {
        updated: None,
        fingerprint: &ours,
    };
    assert_eq!(
        decide(&none_here, None, &[older], true),
        Action::NewerInFolder
    );

    // The same change: this computer's last write.
    let last = copy_with(Some("2026-11-10T21:32:10Z"), "2026-11-12T10:00:00Z", 10);
    assert_eq!(
        decide(&same, Some(&record), std::slice::from_ref(&last), true),
        Action::UpToDate
    );
    let changed = Written {
        fingerprint: "fedcba9876543210".into(),
        ..record.clone()
    };
    assert_eq!(
        decide(&same, Some(&changed), &[last], true),
        Action::Replace
    );
    // Another computer's file of the same change, made before or after
    // this computer's copy last changed.
    let before = copy_with(Some("2026-11-10T21:32:10Z"), "2026-11-12T11:00:00Z", 10);
    assert_eq!(
        decide(&same, Some(&record), &[before], true),
        Action::Replace
    );
    let after = copy_with(Some("2026-11-10T21:32:10Z"), "2026-11-12T13:00:00Z", 10);
    assert_eq!(decide(&same, None, &[after], true), Action::InStep);
    // More map images of the same change stay in the folder.
    let more = copy_with(Some("2026-11-10T21:32:10Z"), "2026-11-12T10:00:00Z", 11);
    assert_eq!(
        decide(&same, Some(&changed), &[more], true),
        Action::MoreImagesInFolder
    );
}

// ---------------------------------------------------------------------------
// The keeper

/// A state the keeper told of the game, and why.
type Seen = (RowState, Option<String>);

/// A keeper of a maps folder holding the made-up game, writing into
/// `Maps and Guides`.
struct World {
    keeper: Arc<Keeper>,
    activity: Arc<Mutex<Activity>>,
    /// Running then not: how many runs ended.
    runs: Arc<Mutex<(bool, u64)>>,
    /// What the keeper told of the game, in order.
    seen: Arc<Mutex<Vec<Seen>>>,
    /// Changes the game the first time its pack is being written.
    change_while_writing: Arc<AtomicBool>,
    /// The rename fails, as for a file held open.
    held_open: Arc<AtomicBool>,
    library: Arc<Library>,
    game: PathBuf,
    repo: PathBuf,
    data: PathBuf,
    dir: TempDir,
}

impl World {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let (library, registry) = library_with(&dir.0, Vec::new());
        let library = Arc::new(library);
        let game = library.maps_folder().join(ID);
        write_pack(&game, "1.0.0");
        // A game made in the app gets no pack.
        put_json(
            &library
                .maps_folder()
                .join("example-game")
                .join("manifest.json"),
            &json!({"schemaVersion": 2, "gameId": "example-game", "title": "Example Game",
                    "packVersion": "1.0.0", "madeInApp": true}),
        );
        library.scan();
        let repo = dir.0.join("Maps and Guides");
        fs::create_dir_all(&repo).unwrap();
        let data = dir.0.join("data");
        let activity = Arc::new(Mutex::new(Activity::default()));
        let runs = Arc::new(Mutex::new((false, 0)));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let change_while_writing = Arc::new(AtomicBool::new(false));
        let held_open = Arc::new(AtomicBool::new(false));
        let probe = {
            let activity = Arc::clone(&activity);
            Box::new(move || activity.lock().unwrap().clone())
        };
        let tell = {
            let runs = Arc::clone(&runs);
            let seen = Arc::clone(&seen);
            let change = Arc::clone(&change_while_writing);
            let game = game.clone();
            Box::new(move |status: &Status| {
                {
                    let mut runs = runs.lock().unwrap();
                    if runs.0 && !status.running {
                        runs.1 += 1;
                    }
                    runs.0 = status.running;
                }
                if let Some(row) = status.games.iter().find(|row| row.id == ID) {
                    let mut seen = seen.lock().unwrap();
                    let now = (row.state, row.reason.clone());
                    if seen.last() != Some(&now) {
                        seen.push(now);
                    }
                }
                if status.writing.is_some() && change.swap(false, Ordering::SeqCst) {
                    put_json(
                        &game.join("checklists.json"),
                        &json!([{"id": "l1"}, {"id": "l2"}]),
                    );
                }
            })
        };
        let rename = {
            let held_open = Arc::clone(&held_open);
            Box::new(move |from: &Path, to: &Path| {
                if held_open.load(Ordering::SeqCst) {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "held open",
                    ))
                } else {
                    fs::rename(from, to)
                }
            })
        };
        let keeper = Keeper::start_with(
            Parts {
                app_data: data.clone(),
                shared_dir: dir.0.join("shared"),
                library: Arc::clone(&library),
                downloads: crate::downloads::for_tests(&registry, data.clone()),
                app: app(),
                timing: Timing {
                    tick: Duration::from_millis(20),
                    quiet: Duration::from_millis(100),
                    start_delay: Duration::ZERO,
                    retry: Duration::from_millis(300),
                },
                probe,
                tell,
            },
            rename,
        );
        Self {
            keeper,
            activity,
            runs,
            seen,
            change_while_writing,
            held_open,
            library,
            repo,
            game,
            data,
            dir,
        }
    }

    fn runs(&self) -> u64 {
        self.runs.lock().unwrap().1
    }

    /// Waits until no run is under way and `done` holds.
    fn wait(&self, what: &str, done: impl Fn(&Status) -> bool) -> Status {
        let start = Instant::now();
        loop {
            let status = self.keeper.status();
            if !status.running && done(&status) {
                return status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(60),
                "{what}: {status:#?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Does `trigger` and waits for a run to end.
    fn after_run(&self, trigger: impl FnOnce()) -> Status {
        let before = self.runs();
        trigger();
        self.wait("a run", |_| self.runs() > before)
    }

    fn turn_on(&self, folder: &Path) -> Status {
        self.after_run(|| {
            self.keeper
                .set(Setting {
                    on: true,
                    folder: Some(folder.to_path_buf()),
                    schedule: Schedule::Start,
                })
                .unwrap();
        })
    }

    fn row(status: &Status) -> super::Row {
        status
            .games
            .iter()
            .find(|row| row.id == ID)
            .cloned()
            .unwrap_or_else(|| panic!("no row for the game: {status:#?}"))
    }

    fn record(&self) -> Record {
        Store::new(&self.data).read_record()
    }

    /// Every pack file under the folder, and every unfinished one.
    fn files(&self) -> (Vec<PathBuf>, Vec<PathBuf>) {
        fn walk(dir: &Path, packs: &mut Vec<PathBuf>, parts: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if path.is_dir() {
                    walk(&path, packs, parts);
                } else if name.ends_with(".part") {
                    parts.push(path);
                } else if name.ends_with(".atlaspack") {
                    packs.push(path);
                }
            }
        }
        let (mut packs, mut parts) = (Vec::new(), Vec::new());
        walk(&self.repo, &mut packs, &mut parts);
        packs.sort();
        (packs, parts)
    }
}

#[test]
fn writes_a_new_pack_and_keeps_it_where_the_person_puts_it() {
    let world = World::new("keep-new");
    let status = world.turn_on(&world.repo);
    assert!(status.problem.is_none(), "{status:#?}");
    let row = World::row(&status);
    assert_eq!(row.state, RowState::UpToDate, "{status:#?}");
    let new = world.repo.join(NEW_PACKS_FOLDER);
    let (packs, parts) = world.files();
    assert_eq!(packs.len(), 1);
    assert!(parts.is_empty());
    let first = packs[0].clone();
    assert_eq!(first.parent(), Some(new.as_path()));
    let name = first.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("Test Valley"), "{name}");
    assert_eq!(row.path, Some(first.display().to_string()));
    let header = read_header(&first).unwrap();
    assert_eq!(header.pack_id, ID);
    assert!(header.mine.is_none());
    let record = world.record();
    assert_eq!(record.packs[ID].path, first);
    assert_eq!(record.folder.as_deref(), Some(world.repo.as_path()));

    // A game made in the app is listed with why it gets no pack.
    let made = status
        .games
        .iter()
        .find(|row| row.id == "example-game")
        .unwrap();
    assert_eq!(made.state, RowState::LeftOut);
    assert_eq!(made.reason.as_deref(), Some(MADE_HERE));

    // The person moves and renames it: it is known where it lies now, and
    // not written again.
    let moved = world.repo.join("Example Site").join("my copy.atlaspack");
    fs::create_dir_all(moved.parent().unwrap()).unwrap();
    fs::rename(&first, &moved).unwrap();
    let status = world.after_run(|| {
        world.keeper.write_all();
    });
    let row = World::row(&status);
    assert_eq!(row.state, RowState::UpToDate, "{status:#?}");
    assert_eq!(row.path, Some(moved.display().to_string()));
    assert_eq!(world.files().0, vec![moved.clone()]);

    // The game changes: its pack is written again where it lies.
    let before = world.record().packs[ID].fingerprint.clone();
    put_json(
        &world.game.join("locations.json"),
        &json!([{"id": "x1"}, {"id": "x2"}, {"id": "x3"}]),
    );
    world.after_run(|| world.keeper.changed(ID));
    let status = world.wait("written again", |status| {
        World::row(status).state == RowState::UpToDate
    });
    let record = world.record();
    assert_ne!(record.packs[ID].fingerprint, before, "{status:#?}");
    assert_eq!(record.packs[ID].path, moved);
    let (packs, parts) = world.files();
    assert_eq!(packs, vec![moved.clone()]);
    assert!(parts.is_empty());

    // A copy of it elsewhere in the folder is listed, not written.
    let extra = world.repo.join("extra.atlaspack");
    fs::copy(&moved, &extra).unwrap();
    let status = world.after_run(|| {
        world.keeper.write_all();
    });
    let row = World::row(&status);
    assert_eq!(row.state, RowState::UpToDate, "{status:#?}");
    assert_eq!(row.extra_copies.len(), 1);
    assert_eq!(world.files().0.len(), 2);
}

#[test]
fn a_removed_pack_stays_removed_until_it_is_written_again() {
    let world = World::new("keep-removed");
    world.turn_on(&world.repo);
    let (packs, _) = world.files();
    assert_eq!(packs.len(), 1);
    let first = packs[0].clone();

    fs::remove_file(&first).unwrap();
    let status = world.after_run(|| {
        world.keeper.write_all();
    });
    let row = World::row(&status);
    assert_eq!(row.state, RowState::NotInFolder, "{status:#?}");
    assert_eq!(row.path, Some(first.display().to_string()));
    assert!(world.files().0.is_empty());
    // A change to the game does not bring it back either.
    put_json(&world.game.join("locations.json"), &json!([{"id": "x9"}]));
    let status = world.after_run(|| world.keeper.changed(ID));
    assert_eq!(World::row(&status).state, RowState::NotInFolder);
    assert!(world.files().0.is_empty());

    // Written again by hand: where it lay.
    world.after_run(|| {
        world.keeper.write_again(ID);
    });
    let status = world.wait("written again", |status| {
        World::row(status).state == RowState::UpToDate
    });
    assert_eq!(world.files().0, vec![first], "{status:#?}");
}

#[test]
fn leaves_a_newer_pack_in_the_folder_alone() {
    let world = World::new("keep-newer");
    world.turn_on(&world.repo);
    let first = world.files().0[0].clone();
    let bytes = fs::read(&first).unwrap();

    // This computer's copy is older than the pack in the folder.
    let manifest = world.game.join("manifest.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    value["updated"] = json!("2026-11-05T00:00:00.000Z");
    put_json(&manifest, &value);
    world.after_run(|| world.keeper.changed(ID));
    let status = world.wait("left alone", |status| {
        World::row(status).state == RowState::NewerInFolder
    });
    assert_eq!(World::row(&status).path, Some(first.display().to_string()));
    assert_eq!(fs::read(&first).unwrap(), bytes);
}

#[test]
fn a_missing_folder_writes_nothing_and_says_so_once() {
    let world = World::new("keep-missing");
    let gone = world.dir.0.join("Unplugged").join("Maps and Guides");
    let status = world.turn_on(&gone);
    let problem = status.problem.clone().expect("a problem");
    assert!(problem.contains("cannot be found"), "{problem}");
    let notice = status.notice.clone().expect("a notice");
    assert!(!gone.exists());
    assert!(world.record().packs.is_empty());

    let status = world.after_run(|| {
        world.keeper.write_all();
    });
    assert_eq!(status.problem, Some(problem));
    assert_eq!(status.notice, Some(notice.clone()));

    // Once the folder is there again, the packs are written by themselves.
    fs::create_dir_all(&gone).unwrap();
    let status = world.wait("written once the folder is back", |status| {
        status.problem.is_none() && World::row(status).state == RowState::UpToDate
    });
    assert_eq!(status.notice, Some(notice));
    assert!(world.record().packs.contains_key(ID));

    // The maps folder, or one inside it, is refused too.
    let inside = world.library.maps_folder().join("Maps and Guides");
    fs::create_dir_all(&inside).unwrap();
    let status = world.turn_on(&inside);
    let problem = status.problem.clone().expect("a problem");
    assert!(problem.contains("the maps folder"), "{problem}");
    assert!(fs::read_dir(&inside).unwrap().next().is_none());
}

#[test]
fn waits_for_a_change_to_finish() {
    let world = World::new("keep-busy");
    world
        .activity
        .lock()
        .unwrap()
        .downloads
        .insert(ID.to_owned());
    let status = world.turn_on(&world.repo);
    let row = World::row(&status);
    assert_eq!(row.state, RowState::Waiting, "{status:#?}");
    assert_eq!(row.reason.as_deref(), Some("Its download is not over yet."));
    assert!(world.files().0.is_empty());

    // The download ends; the pack is written once the game is quiet.
    world.activity.lock().unwrap().downloads.clear();
    let status = world.wait("written", |status| {
        World::row(status).state == RowState::UpToDate
    });
    assert_eq!(world.files().0.len(), 1, "{status:#?}");

    // A change made while the pack is written: the file is not used, and
    // the pack is written again once the change is finished.
    world.change_while_writing.store(true, Ordering::SeqCst);
    put_json(&world.game.join("locations.json"), &json!([{"id": "x7"}]));
    world.after_run(|| world.keeper.changed(ID));
    let status = world.wait("written after the change", |status| {
        World::row(status).state == RowState::UpToDate
            && world
                .seen
                .lock()
                .unwrap()
                .iter()
                .any(|(_, reason)| reason.as_deref() == Some(super::CHANGED))
    });
    let fingerprint = fingerprint::take(&world.game, None);
    assert_eq!(
        world.record().packs[ID].fingerprint,
        fingerprint.hash,
        "{status:#?}"
    );
    assert!(world.files().1.is_empty());
}

#[test]
fn a_pack_held_open_is_tried_again_at_the_next_check() {
    let world = World::new("keep-held");
    world.turn_on(&world.repo);
    let first = world.files().0[0].clone();
    let bytes = fs::read(&first).unwrap();

    world.held_open.store(true, Ordering::SeqCst);
    put_json(&world.game.join("locations.json"), &json!([{"id": "x5"}]));
    world.after_run(|| world.keeper.changed(ID));
    let status = world.wait("failed", |status| {
        World::row(status).state == RowState::Failed
    });
    let row = World::row(&status);
    assert!(
        row.reason
            .as_deref()
            .unwrap_or_default()
            .contains("held open"),
        "{status:#?}"
    );
    assert!(status.problem.is_none());
    assert_eq!(fs::read(&first).unwrap(), bytes);
    assert!(world.files().1.is_empty());

    world.held_open.store(false, Ordering::SeqCst);
    let status = world.after_run(|| {
        world.keeper.write_all();
    });
    assert_eq!(World::row(&status).state, RowState::UpToDate, "{status:#?}");
    assert_ne!(fs::read(&first).unwrap(), bytes);
}

#[test]
fn turned_off_it_writes_nothing() {
    let world = World::new("keep-off");
    world.keeper.write_all();
    world.keeper.changed(ID);
    thread::sleep(Duration::from_millis(400));
    let status = world.keeper.status();
    assert!(!status.on);
    assert!(status.games.is_empty());
    assert!(world.files().0.is_empty());
    assert!(!world.data.join(super::store::RECORD_FILE).exists());
}
