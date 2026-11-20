//! Guidebook packs in the Library, served in parts, imported into a folder,
//! and Add a guidebook and Remove this guidebook. The PDF and CBZ files are
//! tiny ones made here; every name is made up.

use std::{fs, io::Write, path::Path};

use atlas_pack::{read_header, GuidebookPack, NewGuidebook};
use serde_json::json;
use tauri::http::{header, Request, StatusCode};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use super::*;
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

fn cbz(pictures: u32) -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for i in 1..=pictures {
        zip.start_file(format!("page{i}.png"), options).unwrap();
        zip.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn app() -> AppInfo {
    AppInfo {
        name: "Atlas".into(),
        version: "0.25.0".into(),
        platform: "linux".into(),
    }
}

fn library(dir: &Path) -> Library {
    Library::new(
        SettingsFile::new(dir.join("shared")),
        PackRegistry::default(),
        Vec::new(),
        Vec::new(),
    )
}

/// A pack of guidebooks another app wrote, in the packs folder.
fn other_apps_pack(library: &Library, id: &str, file: &Path) -> std::path::PathBuf {
    let folder = library.ensure_packs_folder().unwrap();
    let target = folder.join("Hollow Marsh - Other App.atlaspack");
    let mut book = NewGuidebook {
        file: file.to_owned(),
        title: "Official Guide".into(),
        pages: None,
        text: Some(vec!["The heron sleeps at the mill.".into()]),
    };
    book.pages = Some(3);
    atlas_pack::write_guidebook_pack(
        &GuidebookPack {
            pack_id: id.into(),
            game_title: "Hollow Marsh".into(),
            written_by: AppInfo {
                name: "Other App".into(),
                version: "2.0.0".into(),
                platform: "windows".into(),
            },
            guidebooks: vec![book],
        },
        &target,
    )
    .unwrap();
    target
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

fn request(game_id: &str, title: &str, token: &str) -> AddGuidebook {
    AddGuidebook {
        game_id: game_id.into(),
        game_title: "Hollow Marsh".into(),
        token: token.into(),
        title: title.into(),
        pages: None,
        text: None,
    }
}

#[test]
fn lists_a_pack_of_guidebooks_and_serves_its_guidebooks_in_parts() {
    let dir = TempDir::new("guidebooks-listed");
    let library = library(&dir.0);
    let file = dir.0.join("guide.pdf");
    fs::write(&file, pdf(3)).unwrap();
    other_apps_pack(&library, "guidebooks-1234", &file);

    let listing = library.scan();
    assert!(listing.unreadable.is_empty(), "{:?}", listing.unreadable);
    let pack = listing
        .packs
        .iter()
        .find(|pack| pack.id == "guidebooks-1234")
        .unwrap();
    assert!(pack.pack_file && pack.guidebooks);
    // Another app wrote it: Atlas does not change it.
    assert!(!pack.guidebooks_by_atlas);
    assert_eq!(pack.title, "Hollow Marsh");
    let listed = serde_json::to_value(pack).unwrap();
    assert_eq!(listed["guidebooks"], true);
    assert!(listed.get("guidebooksByAtlas").is_none());

    let base = "atlas-pack://localhost/guidebooks-1234";
    let (status, list) = get(&library, &format!("{base}/guidebooks.json"), None);
    assert_eq!(status, StatusCode::OK);
    let list: atlas_pack::GuidebookList = serde_json::from_slice(&list).unwrap();
    assert_eq!(list.guidebooks[0].file, "guidebooks/official-guide.pdf");
    // The guidebook, read in parts as pdf.js reads it.
    let whole = pdf(3);
    let (status, part) = get(
        &library,
        &format!("{base}/guidebooks/official-guide.pdf"),
        Some("bytes=5-12"),
    );
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part, &whole[5..=12]);
    let (status, text) = get(
        &library,
        &format!("{base}/guidebooks/official-guide.text.json"),
        None,
    );
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        atlas_pack::parse_guidebook_text(&text, 3).unwrap().pages[0].text,
        "The heron sleeps at the mill."
    );
    // Its description is never served, nor a name it does not list.
    for name in ["atlaspack.json", "guidebooks/other.pdf"] {
        assert_eq!(
            get(&library, &format!("{base}/{name}"), None).0,
            StatusCode::NOT_FOUND
        );
    }
}

#[test]
fn refuses_a_pack_whose_guidebook_is_deflated_or_not_its_size() {
    let dir = TempDir::new("guidebooks-damaged");
    let library = library(&dir.0);
    let folder = library.ensure_packs_folder().unwrap();
    let write = |name: &str, deflate: bool, bytes: u64| {
        let header = json!({
            "format": "atlas-pack-file", "version": 8, "packId": format!("guidebooks-{name}"),
            "title": "Hollow Marsh", "packVersion": "1.0.0", "detail": "full",
            "exportedAt": "2026-11-19T09:30:00Z",
            "exportedBy": {"name": "Other App", "version": "2.0.0", "platform": "windows"},
            "pack": {"id": format!("guidebooks-{name}"), "title": "Hollow Marsh", "packVersion": "1.0.0",
                     "schemaVersion": 2, "attribution": []},
            "source": {"kind": "unknown", "origin": "guidebooks"},
            "contents": {}, "images": {"detail": "full", "files": 0, "bytes": 0, "layers": []},
            "files": 2, "bytes": 0,
            "guidebooks": [{"file": "guidebooks/guide.pdf", "title": "Guide", "pages": 3, "bytes": bytes}]
        });
        let manifest = json!({"schemaVersion": 2, "gameId": format!("guidebooks-{name}"),
                              "title": "Hollow Marsh", "packVersion": "1.0.0", "gamePatch": "any",
                              "attribution": [], "idMigrations": {}});
        let path = folder.join(format!("{name}.atlaspack"));
        let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file("atlaspack.json", options).unwrap();
        zip.write_all(header.to_string().as_bytes()).unwrap();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        let method = if deflate {
            CompressionMethod::Deflated
        } else {
            CompressionMethod::Stored
        };
        zip.start_file("guidebooks/guide.pdf", options.compression_method(method))
            .unwrap();
        zip.write_all(&pdf(3)).unwrap();
        zip.finish().unwrap();
        path
    };
    let size = pdf(3).len() as u64;
    write("deflated", true, size);
    write("shorter", false, size + 1);
    write("fine", false, size);
    let listing = library.scan();
    let reasons: Vec<&str> = listing
        .unreadable
        .iter()
        .map(|file| file.reason.as_str())
        .collect();
    assert_eq!(reasons.len(), 2, "{reasons:?}");
    assert!(reasons.iter().any(|reason| reason
        == &"guidebooks/guide.pdf in this pack file is packed in a way Atlas does not read."));
    assert!(listing
        .packs
        .iter()
        .any(|pack| pack.id == "guidebooks-fine"));
}

#[test]
fn imports_a_pack_of_guidebooks_into_a_folder_as_the_android_app_does() {
    let dir = TempDir::new("guidebooks-import");
    let library = library(&dir.0);
    let file = dir.0.join("guide.pdf");
    fs::write(&file, pdf(3)).unwrap();
    let pack = other_apps_pack(&library, "guidebooks-1234", &file);
    let maps = dir.0.join("maps");
    fs::create_dir_all(&maps).unwrap();
    let imported = import(&pack, &maps, &mut |_| {}, &|| false).unwrap();
    assert_eq!(
        fs::read(imported.folder.join("guidebooks/official-guide.pdf")).unwrap(),
        pdf(3)
    );
    assert!(imported
        .folder
        .join("guidebooks/official-guide.text.json")
        .is_file());
    let head = crate::manifest::read_head(&imported.folder).unwrap();
    assert!(head.guidebooks);
    assert_eq!(head.written_by.as_deref(), Some("Other App"));
    assert_eq!(head.title, "Hollow Marsh");
}

#[test]
fn adds_a_guidebook_to_a_games_own_pack_and_removes_it() {
    let dir = TempDir::new("guidebooks-add");
    let library = library(&dir.0);
    let first = dir.0.join("Official_Guide.pdf");
    fs::write(&first, pdf(3)).unwrap();
    let second = dir.0.join("Marsh Maps.cbz");
    fs::write(&second, cbz(2)).unwrap();

    let mut asked = request("hollow-marsh", "Official Guide", "t");
    asked.pages = Some(3);
    asked.text = Some(vec!["The heron".into(), String::new(), "The mill".into()]);
    let (pack_id, message) = add(&library, &asked, &first, &app()).unwrap();
    assert_eq!(pack_id, "guidebooks-hollow-marsh");
    assert_eq!(
        message,
        "Official Guide was added to the guidebooks of Hollow Marsh. Its pack file is in the packs folder."
    );
    let folder = library.packs_folder();
    let path = folder.join("Hollow Marsh guidebooks.atlaspack");
    let header = read_header(&path).unwrap();
    assert_eq!(header.guidebooks.len(), 1);
    assert_eq!(header.guidebooks[0].pages, 3);
    assert!(header.guidebooks[0].text.is_some());
    assert_eq!(header.pack.written_by.as_ref().unwrap()["name"], "Atlas");
    let listing = library.scan();
    let listed = listing
        .packs
        .iter()
        .find(|pack| pack.id == pack_id)
        .unwrap();
    assert!(listed.guidebooks && listed.guidebooks_by_atlas);

    // A second one writes the same small pack again, with both.
    let (again, message) = add(
        &library,
        &request("hollow-marsh", "Marsh Maps", "t"),
        &second,
        &app(),
    )
    .unwrap();
    assert_eq!(again, pack_id);
    assert_eq!(
        message,
        "Marsh Maps was added to the guidebooks of Hollow Marsh."
    );
    let header = read_header(&path).unwrap();
    assert_eq!(
        header
            .guidebooks
            .iter()
            .map(|g| (g.title.as_str(), g.pages))
            .collect::<Vec<_>>(),
        [("Official Guide", 3), ("Marsh Maps", 2)]
    );
    assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);

    // Removing one writes it again without it; the last deletes the file.
    library.scan();
    let removed = remove(&library, &pack_id, "guidebooks/official-guide.pdf", &app()).unwrap();
    assert_eq!(removed, "Official Guide was removed.");
    assert_eq!(read_header(&path).unwrap().guidebooks.len(), 1);
    library.scan();
    assert_eq!(
        remove(&library, &pack_id, "guidebooks/official-guide.pdf", &app()).unwrap_err(),
        "This guidebook cannot be found any more."
    );
    remove(&library, &pack_id, "guidebooks/marsh-maps.cbz", &app()).unwrap();
    assert!(!path.exists());
    library.scan();
    assert_eq!(
        remove(&library, &pack_id, "guidebooks/marsh-maps.cbz", &app()).unwrap_err(),
        "These guidebooks cannot be found any more."
    );
}

#[test]
fn never_changes_a_pack_of_guidebooks_another_app_wrote() {
    let dir = TempDir::new("guidebooks-other");
    let library = library(&dir.0);
    let file = dir.0.join("guide.pdf");
    fs::write(&file, pdf(3)).unwrap();
    let theirs = other_apps_pack(&library, "guidebooks-hollow-marsh", &file);
    let before = fs::read(&theirs).unwrap();
    library.scan();

    assert_eq!(
        remove(
            &library,
            "guidebooks-hollow-marsh",
            "guidebooks/official-guide.pdf",
            &app()
        )
        .unwrap_err(),
        "These guidebooks came from another app, and Atlas never changes them."
    );
    // Adding goes into a pack of Atlas's own, beside it.
    let mut asked = request("hollow-marsh", "My Notes", "t");
    asked.pages = Some(3);
    let (pack_id, _) = add(&library, &asked, &file, &app()).unwrap();
    assert_eq!(pack_id, "guidebooks-hollow-marsh-2");
    assert_eq!(fs::read(&theirs).unwrap(), before);
    let listing = library.scan();
    assert_eq!(
        listing.packs.iter().filter(|pack| pack.guidebooks).count(),
        2
    );
}

#[test]
fn refuses_what_cannot_be_added() {
    let dir = TempDir::new("guidebooks-refuse");
    let library = library(&dir.0);
    let notes = dir.0.join("notes.txt");
    fs::write(&notes, "notes").unwrap();
    assert_eq!(
        inspect(&notes).unwrap_err(),
        "notes.txt is not a PDF or CBZ file. Only PDF and CBZ files can be guidebooks."
    );
    let empty = dir.0.join("empty.pdf");
    fs::write(&empty, "").unwrap();
    assert_eq!(inspect(&empty).unwrap_err(), "empty.pdf is empty.");
    let fake = dir.0.join("fake.cbz");
    fs::write(&fake, pdf(1)).unwrap();
    assert_eq!(
        inspect(&fake).unwrap_err(),
        "fake.cbz is not the CBZ file its name says it is."
    );
    // A PDF whose pages are not read here is still offered: pdf.js counts them.
    let blank = dir.0.join("blank.pdf");
    fs::write(&blank, "%PDF-1.7\n%%EOF\n").unwrap();
    assert_eq!(inspect(&blank).unwrap(), (GuidebookType::Pdf, 15, None));
    let comic = dir.0.join("comic.cbz");
    fs::write(&comic, cbz(4)).unwrap();
    assert_eq!(
        inspect(&comic).unwrap(),
        (GuidebookType::Cbz, cbz(4).len() as u64, Some(4))
    );
    let pdf_file = dir.0.join("guide.pdf");
    fs::write(&pdf_file, pdf(2)).unwrap();
    assert_eq!(inspect(&pdf_file).unwrap().2, Some(2));

    assert_eq!(
        add(
            &library,
            &request("Not an id", "Guide", "t"),
            &pdf_file,
            &app()
        )
        .unwrap_err(),
        "This game cannot be found."
    );
    let mut zero = request("hollow-marsh", "Guide", "t");
    zero.pages = Some(0);
    assert_eq!(
        add(&library, &zero, &pdf_file, &app()).unwrap_err(),
        "This guidebook has no pages that can be read."
    );
    assert_eq!(
        add(
            &library,
            &request("hollow-marsh", " ", "t"),
            &pdf_file,
            &app()
        )
        .unwrap_err(),
        "The title of a guidebook must be 1 to 200 characters."
    );
    assert!(!library
        .packs_folder()
        .join("Hollow Marsh guidebooks.atlaspack")
        .exists());
}

#[test]
fn serves_the_picked_file_under_its_token_only() {
    let dir = TempDir::new("guidebooks-picked");
    let library = library(&dir.0);
    let file = dir.0.join("guide.pdf");
    fs::write(&file, pdf(2)).unwrap();
    let url = library
        .registry()
        .set_picked("abc123", "guidebook.pdf", file.clone());
    assert!(url.ends_with("_picked/abc123/guidebook.pdf"), "{url}");
    let at = |path: &str| format!("atlas-pack://localhost/{path}");
    let (status, part) = get(
        &library,
        &at("_picked/abc123/guidebook.pdf"),
        Some("bytes=0-4"),
    );
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part, b"%PDF-");
    for wrong in [
        "_picked/abc124/guidebook.pdf",
        "_picked/abc123/other.pdf",
        "_picked/abc123",
        "_picked/abc123/guidebook.pdf/more",
    ] {
        assert_eq!(
            get(&library, &at(wrong), None).0,
            StatusCode::NOT_FOUND,
            "{wrong}"
        );
    }
    assert_eq!(library.registry().picked("abc123"), Some(file));
    library.registry().forget_picked();
    assert_eq!(
        get(&library, &at("_picked/abc123/guidebook.pdf"), None).0,
        StatusCode::NOT_FOUND
    );
}

#[test]
fn names_the_pack_of_a_game_and_offers_the_files_title() {
    let none = |_: &str| None;
    assert_eq!(
        pack_id_for("hollow-marsh", &none),
        "guidebooks-hollow-marsh"
    );
    let long = "a".repeat(64);
    let id = pack_id_for(&long, &none);
    assert!(crate::packs::is_valid_pack_id(&id), "{id}");
    assert_eq!(id, pack_id_for(&long, &none));
    assert_ne!(id, pack_id_for(&format!("{}b", "a".repeat(63)), &none));
    // A guidebook pack Atlas wrote is its own; another app's is passed by.
    let ours = |id: &str| (id == "guidebooks-1").then_some(true);
    assert_eq!(pack_id_for("guidebooks-1", &ours), "guidebooks-1");
    let theirs =
        |id: &str| (id == "guidebooks-marsh" || id == "guidebooks-marsh-2").then_some(false);
    assert_eq!(pack_id_for("marsh", &theirs), "guidebooks-marsh-3");

    assert_eq!(title_of_file("Official_Guide  2.pdf"), "Official Guide 2");
    assert_eq!(title_of_file("maps.v2.cbz"), "maps.v2");
}
