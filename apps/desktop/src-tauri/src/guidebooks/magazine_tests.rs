//! Packs of magazines (version 10 of the pack file format), which another
//! app writes with the `atlas-pack` crate: listed in the Library as no
//! game, their issues, text and covers served in parts, imported into a
//! folder as the Android app does, and never exported. Every name is made
//! up.

use std::{fs, path::Path};

use atlas_pack::{IssueGame, MagazineFacts, MagazinePack, NewIssue};
use tauri::http::{header, Request, StatusCode};

use crate::{
    library::Library, packfile::import::import, packs::PackRegistry, settings::SettingsFile,
    tiles::store::tests::TempDir,
};

/// A PDF of `pages` empty pages.
fn pdf(pages: u32) -> Vec<u8> {
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 10 + i)).collect();
    let mut text = format!(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
         2 0 obj\n<< /Type /Pages /Kids [{}] /Count {pages} >>\nendobj\n",
        kids.join(" ")
    );
    for i in 0..pages {
        text.push_str(&format!(
            "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n",
            10 + i
        ));
    }
    text.push_str("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
    text.into_bytes()
}

const COVER: &[u8] = b"\xFF\xD8\xFF\xE0 a small cover";

fn library(dir: &Path) -> Library {
    Library::new(
        SettingsFile::new(dir.join("shared")),
        PackRegistry::default(),
        Vec::new(),
        Vec::new(),
    )
}

fn get(library: &Library, uri: &str, range: Option<&str>) -> (StatusCode, Vec<u8>) {
    let mut request = Request::builder().uri(uri);
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    let response = library
        .registry()
        .respond(&request.body(Vec::new()).unwrap());
    (response.status(), response.body().clone())
}

/// A pack of one magazine's issues, written by another app into the
/// packs folder.
fn magazine_pack(library: &Library, dir: &Path) -> std::path::PathBuf {
    let file = dir.join("issue 7.pdf");
    fs::write(&file, pdf(4)).unwrap();
    let cover = dir.join("cover.jpg");
    fs::write(&cover, COVER).unwrap();
    let target = library
        .ensure_packs_folder()
        .unwrap()
        .join("Marsh Monthly.atlaspack");
    atlas_pack::write_magazine_pack(
        &MagazinePack {
            pack_id: "magazines-marsh-monthly".into(),
            magazine: MagazineFacts {
                title: "Marsh Monthly".into(),
                publisher: None,
            },
            written_by: atlas_pack::AppInfo {
                name: "Fen Shelf".into(),
                version: "3.1.0".into(),
                platform: "windows".into(),
            },
            issues: vec![NewIssue {
                file,
                title: "Issue 7".into(),
                date: Some("2026-03".into()),
                number: Some(7),
                pages: None,
                text: Some(vec![String::new(), "The heron returns to the mill.".into()]),
                cover: Some(cover),
                games: vec![IssueGame {
                    title: "Hollow Marsh".into(),
                    system: None,
                    game_id: None,
                    pages: vec![[2, 3]],
                }],
            }],
        },
        &target,
    )
    .unwrap();
    target
}

#[test]
fn lists_a_pack_of_magazines_and_serves_its_issues_in_parts() {
    let dir = TempDir::new("magazines-listed");
    let library = library(&dir.0);
    magazine_pack(&library, &dir.0);

    let listing = library.scan();
    assert!(listing.unreadable.is_empty(), "{:?}", listing.unreadable);
    let pack = listing
        .packs
        .iter()
        .find(|pack| pack.id == "magazines-marsh-monthly")
        .unwrap();
    assert!(pack.pack_file && pack.magazines && !pack.guidebooks);
    assert_eq!(pack.title, "Marsh Monthly");
    let listed = serde_json::to_value(pack).unwrap();
    assert_eq!(listed["magazines"], true);

    let base = "atlas-pack://localhost/magazines-marsh-monthly";
    let (status, list) = get(&library, &format!("{base}/magazines.json"), None);
    assert_eq!(status, StatusCode::OK);
    let list: atlas_pack::MagazineList = serde_json::from_slice(&list).unwrap();
    let issue = &list.issues[0];
    assert_eq!(issue.file, "magazines/2026-03-issue-7.pdf");
    assert_eq!(issue.games[0].pages, vec![[2, 3]]);
    let whole = pdf(4);
    let (status, part) = get(
        &library,
        &format!("{base}/{}", issue.file),
        Some("bytes=5-12"),
    );
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part, &whole[5..=12]);
    let (status, cover) = get(
        &library,
        &format!("{base}/{}", issue.cover.as_deref().unwrap()),
        None,
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cover, COVER);
    let (status, text) = get(
        &library,
        &format!("{base}/{}", issue.text.as_deref().unwrap()),
        None,
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        atlas_pack::parse_guidebook_text(&text, 4).unwrap().pages[0].page,
        2
    );
    for name in ["atlaspack.json", "magazines/other.pdf"] {
        assert_eq!(
            get(&library, &format!("{base}/{name}"), None).0,
            StatusCode::NOT_FOUND
        );
    }
}

#[test]
fn imports_a_pack_of_magazines_into_a_folder_as_the_android_app_does() {
    let dir = TempDir::new("magazines-import");
    let library = library(&dir.0);
    let pack = magazine_pack(&library, &dir.0);
    let maps = dir.0.join("maps");
    fs::create_dir_all(&maps).unwrap();
    let imported = import(&pack, &maps, &mut |_| {}, &|| false).unwrap();
    let folder = &imported.folder;
    assert_eq!(
        fs::read(folder.join("magazines/2026-03-issue-7.pdf")).unwrap(),
        pdf(4)
    );
    assert!(folder.join("magazines/2026-03-issue-7.text.json").is_file());
    assert!(folder.join("magazines/2026-03-issue-7.cover.jpg").is_file());
    assert!(folder.join("magazines.json").is_file());
    let head = crate::manifest::read_head(folder).unwrap();
    assert!(head.magazines && !head.guidebooks);
    assert_eq!(head.title, "Marsh Monthly");

    // Not exported: it is passed on as the file it came in.
    let analysis = crate::packfile::analyse(&crate::packfile::PackSource {
        pack_id: "magazines-marsh-monthly".into(),
        root: folder.clone(),
        images: folder.clone(),
        lock: true,
        comes_with_app: false,
        own_use_pictures: false,
        type_pictures: false,
        smaller_pictures: false,
        group: None,
    })
    .unwrap();
    assert_eq!(
        crate::packfile::refusal(&analysis).as_deref(),
        Some(crate::packfile::MAGAZINES_NOT_EXPORTED)
    );
}
