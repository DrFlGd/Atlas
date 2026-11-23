//! Atlas in Steam, against a made-up Steam folder in a temporary folder.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use super::{
    files, restart,
    state::{self, Ctx, Wanted, ART, ART_DIR, TAG},
    vdf::{self, Shortcut, Vdf},
};

const USER: &str = "22202";

/// A temporary folder with a Steam folder (one user), Atlas's data folder
/// with its pictures, and Atlas's program; removed on drop.
struct Setup {
    root: PathBuf,
    steam: PathBuf,
    data: PathBuf,
    program: PathBuf,
    running: Arc<AtomicBool>,
}

impl Setup {
    fn new(name: &str) -> Setup {
        let root = std::env::temp_dir().join(format!("atlas-steam-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let steam = root.join("Steam");
        fs::create_dir_all(steam.join("userdata").join(USER).join("config")).unwrap();
        fs::create_dir_all(steam.join("config")).unwrap();
        fs::write(
            steam.join("config").join("loginusers.vdf"),
            "\"users\"\n{\n\t\"76561197960287930\"\n\t{\n\t\t\"AccountName\"\t\t\"someone\"\n\t\t\"PersonaName\"\t\t\"Someone\"\n\t\t\"MostRecent\"\t\t\"1\"\n\t}\n}\n",
        )
        .unwrap();
        let data = root.join("data");
        let art = data.join(ART_DIR);
        fs::create_dir_all(&art).unwrap();
        for (kind, file, _) in ART {
            fs::write(art.join(file), format!("atlas {kind}")).unwrap();
        }
        let program = root.join("Atlas Folder").join("Atlas.AppImage");
        fs::create_dir_all(program.parent().unwrap()).unwrap();
        fs::write(&program, b"program").unwrap();
        Setup {
            root,
            steam,
            data,
            program,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn ctx(&self) -> Ctx {
        let running = Arc::clone(&self.running);
        Ctx {
            data: self.data.clone(),
            steam: Some(self.steam.clone()),
            running: Box::new(move || running.load(Ordering::SeqCst)),
            windows: false,
        }
    }

    fn wanted(&self) -> Wanted {
        Wanted {
            program: self.program.display().to_string(),
            start_dir: state::start_dir(&self.program),
            user: String::new(),
        }
    }

    fn config(&self) -> PathBuf {
        self.steam.join("userdata").join(USER).join("config")
    }

    fn grid(&self) -> PathBuf {
        self.config().join("grid")
    }

    fn shortcuts_file(&self) -> PathBuf {
        self.config().join("shortcuts.vdf")
    }

    fn shortcuts(&self) -> Vec<Vdf> {
        vdf::shortcuts_of(&vdf::parse(&fs::read(self.shortcuts_file()).unwrap()).unwrap())
    }

    fn ours(&self) -> Vec<Vdf> {
        self.shortcuts()
            .into_iter()
            .filter(|v| vdf::is_tagged(v, TAG))
            .collect()
    }

    fn grid_files(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.grid())
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn s(k: &str, v: &str) -> (Vec<u8>, Vdf) {
    (k.as_bytes().to_vec(), Vdf::Str(v.as_bytes().to_vec()))
}

fn i(k: &str, v: u32) -> (Vec<u8>, Vdf) {
    (k.as_bytes().to_vec(), Vdf::Int(v))
}

fn tags(list: &[&str]) -> (Vec<u8>, Vdf) {
    (
        b"tags".to_vec(),
        Vdf::Map(
            list.iter()
                .enumerate()
                .map(|(n, t)| (n.to_string().into_bytes(), Vdf::Str(t.as_bytes().to_vec())))
                .collect(),
        ),
    )
}

/// Shortcuts that are not Atlas's: one of the person's, one of Game Repo
/// Go's, one of Game Repo's, with values of every kind.
fn others() -> Vec<Vdf> {
    vec![
        Vdf::Map(vec![
            i("appid", 0x9234_5678),
            s("AppName", "Someone's game é"),
            s("Exe", "\"C:\\Games\\x.exe\""),
            i("LastPlayTime", 1_700_000_000),
            (
                b"weird".to_vec(),
                Vdf::Raw(0x07, vec![1, 2, 3, 4, 5, 6, 7, 8]),
            ),
            tags(&["Favorites"]),
        ]),
        Vdf::Map(vec![
            i("appid", 0x9000_0002),
            s("AppName", "Game Repo Go"),
            s("Exe", "\"/home/deck/Applications/GameRepoGo.AppImage\""),
            tags(&["Game Repo Go"]),
        ]),
        Vdf::Map(vec![
            i("appid", 0x9000_0003),
            s("AppName", "Zeta Quest"),
            s("Exe", "\"/home/deck/Games/zeta.sh\""),
            tags(&["Game Repo"]),
        ]),
    ]
}

fn write_shortcuts(setup: &Setup, list: Vec<Vdf>) {
    let top = vdf::with_shortcuts(vec![], list);
    fs::write(setup.shortcuts_file(), vdf::write(&top)).unwrap();
}

#[test]
fn a_shortcuts_file_reads_and_writes_back_the_same() {
    let top = vdf::with_shortcuts(vec![], others());
    let bytes = vdf::write(&top);
    assert_eq!(bytes[0], 0x00);
    assert_eq!(&bytes[1..11], b"shortcuts\0");
    assert_eq!(&bytes[bytes.len() - 2..], &[0x08, 0x08]);
    assert_eq!(vdf::parse(&bytes).unwrap(), top);
    assert_eq!(vdf::write(&vdf::parse(&bytes).unwrap()), bytes);
    let first = &vdf::shortcuts_of(&top)[0];
    assert_eq!(first.str("appname").as_deref(), Some("Someone's game é"));
    assert!(!vdf::is_tagged(first, TAG));
    assert!(vdf::parse(&bytes[..bytes.len() - 3]).is_err());
    // Steam's rule for a shortcut's id.
    assert_eq!(
        vdf::shortcut_id("\"C:\\Atlas\\Atlas.exe\"", "Atlas") & 0x8000_0000,
        0x8000_0000
    );
    let program = Path::new("Atlas Folder").join("Atlas.exe");
    let shortcut = Shortcut::new("Atlas", &program, Path::new("Atlas Folder"), "");
    assert_eq!(shortcut.exe, format!("\"{}\"", program.display()));
    assert_eq!(shortcut.appid, vdf::shortcut_id(&shortcut.exe, "Atlas"));
}

#[test]
fn adds_itself_once_beside_every_other_shortcut_with_its_pictures() {
    let setup = Setup::new("add");
    write_shortcuts(&setup, others());
    let before = fs::read(setup.shortcuts_file()).unwrap();
    let ctx = setup.ctx();
    let done = state::want(&ctx, Some(setup.wanted())).unwrap();
    assert_eq!(
        done,
        Some(state::Applied::Added {
            pictures: 5,
            others: 3
        })
    );
    // Twice: still one of Atlas's.
    state::apply(&ctx).unwrap();
    state::apply(&ctx).unwrap();
    let list = setup.shortcuts();
    assert_eq!(list.len(), 4);
    assert_eq!(
        &list[..3],
        &others()[..],
        "the others are kept as they were"
    );
    let ours = setup.ours();
    assert_eq!(ours.len(), 1);
    let id = Shortcut::new("Atlas", &setup.program, setup.program.parent().unwrap(), "").appid;
    assert_eq!(ours[0].int("appid"), Some(id));
    assert_eq!(ours[0].str("AppName").as_deref(), Some("Atlas"));
    assert_eq!(
        ours[0].str("Exe"),
        Some(format!("\"{}\"", setup.program.display()))
    );
    assert_eq!(
        ours[0].str("StartDir"),
        Some(format!("\"{}\"", setup.program.parent().unwrap().display()))
    );
    let icon = setup.grid().join(format!("{id}_icon.png"));
    assert_eq!(ours[0].str("icon"), Some(icon.display().to_string()));
    assert_eq!(
        setup.grid_files(),
        [
            format!("{id}.jpg"),
            format!("{id}_hero.jpg"),
            format!("{id}_icon.png"),
            format!("{id}_logo.png"),
            format!("{id}p.jpg"),
        ]
    );
    assert_eq!(
        fs::read(setup.grid().join(format!("{id}p.jpg"))).unwrap(),
        b"atlas grid"
    );
    // Backed up first, the file as it was.
    let backups: Vec<PathBuf> = fs::read_dir(setup.config())
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().contains("shortcuts.vdf.atlas-"))
        .collect();
    assert!(!backups.is_empty() && backups.len() <= 5);
    assert!(backups.iter().any(|b| fs::read(b).unwrap() == before));
    let status = state::status(&ctx, Ok(setup.program.clone()), false);
    assert!(status.in_steam && status.wanted && !status.waiting && !status.by_hand);
    assert_eq!(status.user.as_deref(), Some(USER));
    assert_eq!(status.users[0].name, "Someone");
}

#[test]
fn taking_it_out_removes_only_what_atlas_wrote() {
    let setup = Setup::new("remove");
    write_shortcuts(&setup, others());
    let ctx = setup.ctx();
    state::want(&ctx, Some(setup.wanted())).unwrap();
    let id = state::load(&setup.data).written.unwrap().appid;
    // Another game's picture, and the person's own logo set in Steam over
    // the one Atlas wrote.
    fs::write(setup.grid().join("2345p.png"), b"another game").unwrap();
    fs::write(setup.grid().join(format!("{id}_logo.png")), b"their logo").unwrap();
    let done = state::want(&ctx, None).unwrap();
    assert_eq!(done, Some(state::Applied::Removed));
    assert_eq!(setup.shortcuts(), others(), "only Atlas's shortcut went");
    assert_eq!(
        setup.grid_files(),
        ["2345p.png".to_owned(), format!("{id}_logo.png")]
    );
    let s = state::load(&setup.data);
    assert_eq!((s.wanted, s.written), (None, None));
    assert!(!state::waiting(&ctx, &state::load(&setup.data)));
}

#[test]
fn a_shortcut_the_person_made_gets_pictures_only() {
    let setup = Setup::new("theirs");
    let program = setup.program.display().to_string();
    // Added by hand, with Steam's own id, and a cover of their own.
    let theirs = Vdf::Map(vec![
        i("appid", 0x8123_4567),
        s("AppName", "Atlas.AppImage"),
        s("Exe", &format!("\"{program}\"")),
        s("StartDir", "\"/somewhere\""),
    ]);
    let mut list = others();
    list.push(theirs.clone());
    write_shortcuts(&setup, list.clone());
    fs::create_dir_all(setup.grid()).unwrap();
    fs::write(setup.grid().join("2166572391p.png"), b"their cover").unwrap();
    let ctx = setup.ctx();
    let done = state::want(&ctx, Some(setup.wanted())).unwrap();
    assert_eq!(done, Some(state::Applied::Pictures { pictures: 4 }));
    assert_eq!(setup.shortcuts(), list, "no second Atlas, theirs unchanged");
    assert_eq!(
        setup.grid_files(),
        [
            "2166572391.jpg",
            "2166572391_hero.jpg",
            "2166572391_icon.png",
            "2166572391_logo.png",
            "2166572391p.png",
        ]
    );
    assert_eq!(
        fs::read(setup.grid().join("2166572391p.png")).unwrap(),
        b"their cover"
    );
    let status = state::status(&ctx, Ok(setup.program.clone()), false);
    assert!(status.in_steam && status.by_hand);
    assert_eq!(status.kept, ["grid"]);
    // Taken out: Atlas's pictures go, theirs and their shortcut stay.
    state::want(&ctx, None).unwrap();
    assert_eq!(setup.shortcuts(), list);
    assert_eq!(setup.grid_files(), ["2166572391p.png"]);
}

#[test]
fn a_shortcut_without_an_id_is_named_as_steam_names_it() {
    let setup = Setup::new("noid");
    let exe = format!("\"{}\"", setup.program.display());
    write_shortcuts(
        &setup,
        vec![Vdf::Map(vec![s("AppName", "My Atlas"), s("Exe", &exe)])],
    );
    let ctx = setup.ctx();
    state::want(&ctx, Some(setup.wanted())).unwrap();
    let id = vdf::shortcut_id(&exe, "My Atlas");
    assert_eq!(state::load(&setup.data).written.unwrap().appid, id);
    assert!(setup.ours().is_empty());
    assert!(setup.grid().join(format!("{id}p.jpg")).is_file());
}

#[test]
fn an_atlas_shortcut_from_before_goes_when_the_person_adds_their_own() {
    let setup = Setup::new("later");
    write_shortcuts(&setup, others());
    let ctx = setup.ctx();
    state::want(&ctx, Some(setup.wanted())).unwrap();
    assert_eq!(setup.ours().len(), 1);
    let mut list = setup.shortcuts();
    list.push(Vdf::Map(vec![
        i("appid", 0x8000_0042),
        s("AppName", "Atlas"),
        s("Exe", &setup.program.display().to_string()),
    ]));
    write_shortcuts(&setup, list);
    let s = state::load(&setup.data);
    assert!(state::waiting(&ctx, &s));
    assert_eq!(
        state::write_if_closed(&ctx).unwrap(),
        Some(state::Applied::Pictures { pictures: 5 })
    );
    assert!(setup.ours().is_empty());
    assert_eq!(setup.shortcuts().len(), 4);
}

#[test]
fn nothing_is_written_while_steam_runs() {
    let setup = Setup::new("running");
    write_shortcuts(&setup, others());
    let before = fs::read(setup.shortcuts_file()).unwrap();
    let ctx = setup.ctx();
    setup.running.store(true, Ordering::SeqCst);
    assert_eq!(state::want(&ctx, Some(setup.wanted())).unwrap(), None);
    assert_eq!(state::apply(&ctx), Err(state::STEAM_RUNNING.to_owned()));
    assert_eq!(fs::read(setup.shortcuts_file()).unwrap(), before);
    assert!(!setup.grid().exists());
    let status = state::status(&ctx, Ok(setup.program.clone()), true);
    assert!(status.wanted && status.waiting && status.running && !status.in_steam);
    // Steam closed: written.
    setup.running.store(false, Ordering::SeqCst);
    assert!(state::write_if_closed(&ctx).unwrap().is_some());
    assert_eq!(setup.ours().len(), 1);
    // Taken out while it runs: it waits, and stays in Steam until then.
    setup.running.store(true, Ordering::SeqCst);
    assert_eq!(state::want(&ctx, None).unwrap(), None);
    assert_eq!(setup.ours().len(), 1);
    assert!(state::waiting(&ctx, &state::load(&setup.data)));
    setup.running.store(false, Ordering::SeqCst);
    state::write_if_closed(&ctx).unwrap();
    assert!(setup.ours().is_empty());
}

#[test]
fn a_program_that_moved_is_followed() {
    let setup = Setup::new("moved");
    let ctx = setup.ctx();
    state::want(&ctx, Some(setup.wanted())).unwrap();
    let old = state::load(&setup.data).written.unwrap();
    let moved = setup.root.join("Elsewhere").join("Atlas.AppImage");
    let status = state::status(&ctx, Ok(moved.clone()), false);
    assert!(status.in_steam);
    let ours = setup.ours();
    assert_eq!(ours.len(), 1);
    assert_eq!(ours[0].str("Exe"), Some(format!("\"{}\"", moved.display())));
    let new = state::load(&setup.data).written.unwrap();
    assert_ne!(new.appid, old.appid);
    assert!(!setup.grid().join(format!("{}p.jpg", old.appid)).exists());
    assert!(setup.grid().join(format!("{}p.jpg", new.appid)).is_file());
}

#[test]
fn without_steam_or_a_program_it_says_so() {
    let setup = Setup::new("none");
    let ctx = Ctx {
        steam: None,
        ..setup.ctx()
    };
    let status = state::status(&ctx, Err("No AppImage.".into()), false);
    assert_eq!(status.folder, None);
    assert_eq!(status.refused.as_deref(), Some("No AppImage."));
    assert!(!status.running && !status.wanted && !status.in_steam);
    assert_eq!(
        state::place(&ctx, ""),
        Err("Steam isn't on this computer.".to_owned())
    );
}

#[test]
fn compares_programs_as_the_system_does() {
    assert!(state::same_program(
        "\"C:\\Users\\Me\\AppData\\Local\\Atlas\\Atlas.exe\"",
        "c:\\users\\me\\appdata\\local\\atlas\\ATLAS.EXE",
        true
    ));
    assert!(!state::same_program(
        "\"/home/deck/Applications/atlas.appimage\"",
        "/home/deck/Applications/Atlas.AppImage",
        false
    ));
    assert!(state::same_program(
        " \"/home/deck/Applications/Atlas.AppImage\" ",
        "/home/deck/Applications/Atlas.AppImage",
        false
    ));
    assert!(!state::same_program("\"\"", "", false));
}

#[test]
fn lists_users_the_most_recent_first() {
    let setup = Setup::new("users");
    fs::create_dir_all(setup.steam.join("userdata").join("1234")).unwrap();
    fs::create_dir_all(setup.steam.join("userdata").join("0")).unwrap();
    fs::create_dir_all(setup.steam.join("userdata").join("anonymous")).unwrap();
    let users = files::users(&setup.steam);
    let ids: Vec<&str> = users.iter().map(|u| u.id.as_str()).collect();
    assert_eq!(ids, [USER, "1234"]);
    assert!(users[0].recent && !users[1].recent);
    // Another user chosen: written there.
    let ctx = setup.ctx();
    let (_, user) = state::place(&ctx, "1234").unwrap();
    assert_eq!(user, "1234");
    assert_eq!(state::place(&ctx, "999").unwrap().1, USER);
    assert_eq!(files::account_id("76561197960287930"), Some(22202));
}

#[test]
fn keeps_five_backups() {
    let setup = Setup::new("backups");
    let file = setup.shortcuts_file();
    for n in 0..8 {
        files::backup(&file, "atlas", &format!("{n:03}"), 5).unwrap();
    }
    let count = fs::read_dir(setup.config())
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("shortcuts.vdf.atlas-")
        })
        .count();
    assert_eq!(count, 5);
}

#[test]
fn the_helper_is_asked_for_by_its_first_argument_only() {
    let data = Path::new("data folder");
    let args = |list: Vec<std::ffi::OsString>| {
        let mut all = vec![std::ffi::OsString::from("atlas")];
        all.extend(list);
        all
    };
    assert_eq!(
        restart::read_args(&args(restart::helper_args(data, true))),
        Some((data.to_path_buf(), true))
    );
    assert_eq!(
        restart::read_args(&args(restart::helper_args(data, false))),
        Some((data.to_path_buf(), false))
    );
    assert_eq!(restart::read_args(&args(vec![])), None);
    assert_eq!(
        restart::read_args(&args(vec!["--background".into(), "--steam-helper".into()])),
        None
    );
    assert_eq!(
        restart::read_args(&args(vec!["--steam-helper".into()])),
        None
    );
}
