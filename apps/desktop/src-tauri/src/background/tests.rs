//! Finding the game another program asks for, in a Library.

use std::{fs, path::Path};

use super::{find_show, titles::FoundGroup, ShowRequest};
use crate::{
    library::Library, packfile::inplace::testing, receive::args::Show, settings::SettingsFile,
    tiles::store::tests::TempDir, PackRegistry,
};

fn library(dir: &TempDir) -> Library {
    Library::new(
        SettingsFile::new(dir.0.join("shared")),
        PackRegistry::default(),
        Vec::new(),
        Vec::new(),
    )
}

fn write(path: &Path, id: &str, title: &str) {
    testing::write(
        path,
        &testing::header(id, title, "2026-11-10T09:00:00Z", "2026-11-12T09:00:00Z"),
    );
}

#[test]
fn finds_a_game_by_its_pack_id_or_title() {
    let dir = TempDir::new("background-find");
    let library = library(&dir);
    let packs = library.packs_folder();
    write(&packs.join("a.atlaspack"), "keep-map", "Ruined Keep");
    write(&packs.join("b.atlaspack"), "valley", "Test Valley");
    write(&packs.join("c.atlaspack"), "keep-wiki", "Keep wiki");
    library.scan();

    assert_eq!(
        find_show(&library, &Show::Pack("valley".to_owned())),
        Some(ShowRequest {
            packs: vec!["valley".to_owned()],
            groups: Vec::new()
        })
    );
    // Nothing for a pack Atlas does not have.
    assert_eq!(find_show(&library, &Show::Pack("gone".to_owned())), None);

    let found = find_show(&library, &Show::Game("ruined KEEP".to_owned())).unwrap();
    assert_eq!(found.packs, ["keep-map"]);
    assert_eq!(find_show(&library, &Show::Game("Ruined".to_owned())), None);

    // Under one title of the person's.
    let maps = library.maps_folder();
    fs::create_dir_all(&maps).unwrap();
    fs::write(
        crate::gamegroups::path(&maps),
        r#"{"format":"atlas-game-groups","version":1,"groups":[
            {"id":"keep","title":"Ruined Keep","members":[{"gameId":"keep-wiki"},{"gameId":"keep-map"}]}
        ]}"#,
    )
    .unwrap();
    let found = find_show(&library, &Show::Game(" Ruined-Keep ".to_owned())).unwrap();
    let mut packs = found.packs.clone();
    packs.sort();
    assert_eq!(packs, ["keep-map", "keep-wiki"]);
    assert_eq!(
        found.groups,
        [FoundGroup {
            id: "keep".to_owned(),
            members: vec!["keep-wiki".to_owned(), "keep-map".to_owned()]
        }]
    );
}

#[test]
fn finds_a_game_by_the_title_its_pack_file_gives() {
    let dir = TempDir::new("background-find-file");
    let library = library(&dir);
    let mut header = testing::header(
        "keep-pages",
        "Keep pages",
        "2026-11-10T09:00:00Z",
        "2026-11-12T09:00:00Z",
    );
    header["game"] = serde_json::json!({ "title": "Ruined Keep" });
    testing::write(&library.packs_folder().join("pages.atlaspack"), &header);
    assert_eq!(library.scan().packs.len(), 1);
    let found = find_show(&library, &Show::Game("ruined keep".to_owned())).unwrap();
    assert_eq!(found.packs, ["keep-pages"]);
}

#[test]
fn says_where_it_works_and_why_not_elsewhere() {
    use crate::library::READER;
    assert_eq!(super::OFFERED, READER && cfg!(windows));
    assert_eq!(super::check_offered().is_ok(), super::OFFERED);
    if let Err(why) = super::check_offered() {
        let expected = if READER {
            "Atlas runs in the background only on Windows for now."
        } else {
            "This app does not run in the background."
        };
        assert_eq!(why, expected);
    }
    assert_eq!(super::check_start_options().is_ok(), READER);
    if let Err(why) = super::check_start_options() {
        assert_eq!(
            why,
            "This app does not take a game to show from another program."
        );
    }
}
