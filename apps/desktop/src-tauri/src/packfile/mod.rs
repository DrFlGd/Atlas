//! Map pack files: a game's pack folder in one `.atlaspack` file, with its
//! map images up to a chosen level of detail, for opening the game in Atlas
//! on another device (Atlas for Android included). Every build has this,
//! also one without downloads and the Android app: copying files is not
//! downloading.
//!
//! The file is a ZIP archive (ZIP64 when it needs to be) holding the pack
//! folder's contents at its root:
//!
//! - first, `atlaspack.json`, the [`Header`]: what the file is, which game,
//!   which detail, when and by which app it was made, and where the game's
//!   data came from, so a person can tell whether a file is out of date
//!   without opening it;
//! - the pack's JSON files (`manifest.json`, `maps.json`, `layers.json` and
//!   the rest of [`PACK_FILES`]);
//! - the map images of every folder layer, at the paths the layer's own
//!   `url` gives, up to the chosen detail, with the "not on the server"
//!   markers (`.404`) of those levels and the layers' status files
//!   (`offline-tiles/<layer>.json`) rewritten to the levels included;
//! - the pictures its guides show (`pictures/`) that the pack marks as
//!   shareable, with `pictures.json` cut down to them. A picture kept for
//!   the person's own use (`shareable: false`, such as a location photo
//!   downloaded from a site) is in the file only when the person ticks
//!   "Include downloaded photos", for a file they keep to themselves; it
//!   stays marked `shareable: false` there.
//!
//! A game with no map has no `maps.json` or `layers.json`, and no images.
//!
//! The manifest's image summaries are rewritten to the levels included too,
//! so the pack opened from the file shows the top level it has enlarged when
//! zoomed in further, and an Atlas with downloads can fetch the rest later
//! (`layers.json` is unchanged, so its remote source is kept).
//!
//! Never in it: the app's lock and download records (`.atlas/`), the page
//! data kept by "Add a map" (`import/`), and found marks and other
//! progress, which stay in the browser storage and its own export file.
//!
//! Only when the person ticks "Include my lists, locations, types and
//! photos": their
//! own lists and their own locations, types and areas of the game (the files
//! beside the game's folder, see `ownlists.rs`), as `mine/my-lists.json` and
//! `mine/my-locations.json`, their links between guide pages and the map as
//! `mine/guide-links.json`, their own guide pages and changes to the
//! pack's pages as `mine/my-pages.json`, their notes on the game's
//! locations as `mine/my-notes.json`, and the photos their lists,
//! locations, pages and notes show as `mine/pictures/<file>` ([`Mine`]).
//! Such a file is version 2 of the format (version 3 when it carries photos
//! or guide links, version 4 when it carries pages, version 5 when it
//! carries notes or a guide page linked to one location alone), so an older
//! app says it needs a newer one instead of refusing an entry it does not
//! know; a file without them stays version 1. An import
//! never writes them into the pack's folder: it hands them to the web app,
//! which adds them to what the person has (see `Imported::mine`).
//!
//! Images are stored as they are (they are compressed already), JSON is
//! deflated.

pub mod export;
pub mod import;
pub mod shell;
pub mod space;

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    ffi::OsString,
    fs,
    io::{BufReader, Read},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    library::{read_import_sources, META_DIR, PACK_FILES},
    manifest::{rfc3339, MANIFEST_FILE, MAX_MANIFEST_BYTES},
    ownlists::{self, OwnFile},
    ownpictures,
    removal::is_real_dir,
    tiles::{
        pyramid::{fill_template, is_safe_segment, level_grid, relative_path, Detail, LayerPlan},
        status::{LayerStatus, STATUS_DIR, STATUS_FORMAT},
    },
};

/// `format` of the header.
pub const FORMAT: &str = "atlas-pack-file";
/// The newest version of the format this app reads and writes. Version 2
/// adds a person's own lists, locations and types ([`Mine`]); version 3
/// their photos and links between guide pages and the map; version 4 their
/// own guide pages; version 5 their notes on the game's locations, and
/// links of a guide page to one location alone (guide links version 2).
pub const VERSION: u32 = 5;
/// The version of a file with a person's own pages but no notes, which an
/// app from before version 5 reads too.
pub const VERSION_WITH_PAGES: u32 = 4;
/// The version of a file with a person's photos or guide links but no own
/// pages, which an app from before version 4 reads too.
pub const VERSION_WITH_PHOTOS: u32 = 3;
/// The version of a file with a person's own lists, locations and types
/// only, which an app from before version 3 reads too.
pub const VERSION_WITH_MINE: u32 = 2;
/// The version of a file without a person's own lists, locations and types,
/// which every app with map pack files reads.
pub const VERSION_WITHOUT_MINE: u32 = 1;
/// The header, the file's first entry.
pub const HEADER_FILE: &str = "atlaspack.json";
/// The file name extension, without the dot.
pub const EXTENSION: &str = "atlaspack";
/// In a pack folder's `.atlas/`: the header of the file the pack was
/// imported from, with when that was. Not exported and not served.
pub const IMPORTED_RECORD: &str = "pack-file.json";
/// Headers larger than this are not read.
pub const MAX_HEADER_BYTES: u64 = 4 << 20;

/// Why an export or import did not finish.
#[derive(Debug, PartialEq, Eq)]
pub enum Stop {
    /// The person cancelled it; nothing was left behind.
    Cancelled,
    /// A plain sentence that says what went wrong.
    Failed(String),
}

impl From<String> for Stop {
    fn from(message: String) -> Self {
        Stop::Failed(message)
    }
}

impl Stop {
    /// The message to show.
    pub fn message(&self) -> String {
        match self {
            Stop::Cancelled => "Cancelled. Nothing was written.".to_owned(),
            Stop::Failed(message) => message.clone(),
        }
    }
}

/// How far an export or import is: entries of the file and their bytes
/// (uncompressed).
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub entries_done: u64,
    pub entries_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

/// The app that wrote a file.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    /// `windows`, `linux`, `macos`, `android`, …
    #[serde(default)]
    pub platform: String,
}

// ---------------------------------------------------------------------------
// The header

/// `atlaspack.json`: what a map pack file holds, readable without
/// unpacking anything else. Every date is ISO 8601 in UTC.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format: String,
    pub version: u32,
    pub pack_id: String,
    pub title: String,
    pub pack_version: String,
    pub detail: Detail,
    pub exported_at: String,
    pub exported_by: AppInfo,
    pub pack: PackFacts,
    pub source: SourceFacts,
    pub contents: Counts,
    pub images: ImagesFacts,
    /// Entries after the header, and their size unpacked.
    pub files: u64,
    pub bytes: u64,
    /// How many of a person's own records the file carries, when it carries
    /// them (version 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mine: Option<MineFacts>,
}

/// The pack itself, from its manifest.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackFacts {
    pub id: String,
    pub title: String,
    pub pack_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_patch: Option<String>,
    pub schema_version: u32,
    #[serde(default)]
    pub attribution: Vec<Value>,
    /// When the pack was first written and last changed, if its manifest
    /// says (version 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// The tool or app that wrote the pack's files, as its manifest says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_by: Option<Value>,
}

/// Where the game's data came from.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    /// Made from web pages with an importer ("Add a map").
    WebPages,
    /// The pack comes with the app that wrote the file.
    App,
    /// Nothing is recorded.
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFacts {
    pub kind: SourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importer: Option<ImporterFacts>,
    /// Each page the pack was made from, with when it was read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<PageFacts>,
    /// The latest and earliest time a page was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_page_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest_page_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImporterFacts {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageFacts {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_at: Option<String>,
}

/// How much is in the pack.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Counts {
    pub maps: u64,
    pub layers: u64,
    pub locations: u64,
    pub categories: u64,
    pub regions: u64,
    pub checklists: u64,
    pub guides: u64,
}

/// How many of a person's own records a file carries.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MineFacts {
    pub lists: u64,
    pub locations: u64,
    pub types: u64,
    pub areas: u64,
    /// Their own photos (see `ownpictures`).
    pub photos: u64,
    /// Whether their links between guide pages and the map are in it.
    pub guide_links: bool,
    /// Their own guide pages, and the pack's pages they changed or hid
    /// (version 4).
    pub pages: u64,
    /// Their own sections of the guide pages.
    pub sections: u64,
    /// Their notes on the game's locations (version 5).
    pub notes: u64,
}

/// The entries of a person's own files, and which file each is.
pub const MINE_ENTRIES: [(&str, OwnFile); 5] = [
    ("mine/my-lists.json", ownlists::LISTS),
    ("mine/my-locations.json", ownlists::LOCATIONS),
    ("mine/guide-links.json", ownlists::GUIDE_LINKS),
    ("mine/my-pages.json", ownlists::PAGES),
    ("mine/my-notes.json", ownlists::NOTES),
];

/// Where a person's own photos are in a file: `mine/pictures/<file>`.
pub const MINE_PICTURES_DIR: &str = "mine/pictures/";
/// The most bytes of own photos one file carries.
pub const MAX_MINE_PICTURE_BYTES: u64 = 512 << 20;

/// A person's own lists, own locations, types and areas, links between
/// guide pages and the map, own guide pages, and notes on the game's
/// locations, of one game: the text of their files (see `ownlists.rs` and
/// `guidelinks.rs`), each when there is one; and the photos the lists,
/// locations, pages and notes show (see `ownpictures.rs`), by file name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Mine {
    pub lists: Option<String>,
    pub locations: Option<String>,
    pub guide_links: Option<String>,
    pub pages: Option<String>,
    pub notes: Option<String>,
    pub pictures: Vec<(String, Vec<u8>)>,
}

impl Mine {
    /// The person's files of a game in the maps folder, and the photos their
    /// lists, locations, pages and notes name.
    pub fn read(maps_folder: &Path, game_id: &str) -> Result<Self, String> {
        let lists = ownlists::LISTS.read(maps_folder, game_id)?;
        let locations = ownlists::LOCATIONS.read(maps_folder, game_id)?;
        let guide_links = crate::guidelinks::read(maps_folder, game_id)?;
        let pages = ownlists::PAGES.read(maps_folder, game_id)?;
        let notes = ownlists::NOTES.read(maps_folder, game_id)?;
        let mut pictures = Vec::new();
        let mut total = 0u64;
        let named = [&lists, &locations, &pages, &notes]
            .into_iter()
            .flatten()
            .flat_map(|text| ownpictures::named_in(text))
            .collect::<BTreeSet<_>>();
        for file in named {
            let Some(bytes) = ownpictures::read(maps_folder, game_id, &file)? else {
                continue;
            };
            total += bytes.len() as u64;
            if total > MAX_MINE_PICTURE_BYTES {
                return Err(
                    "Your photos of this game are too large to go in a map pack file together."
                        .to_owned(),
                );
            }
            pictures.push((file, bytes));
        }
        Ok(Self {
            lists,
            locations,
            guide_links,
            pages,
            notes,
            pictures,
        })
    }

    /// The version of the format a file carrying these needs: 5 with notes
    /// or a guide page linked to one location alone, 4 with own pages, 3
    /// with photos or guide links, 2 otherwise.
    pub fn version(&self) -> u32 {
        if self.notes.is_some() || self.guide_links.as_deref().is_some_and(links_one_location) {
            VERSION
        } else if self.pages.is_some() {
            VERSION_WITH_PAGES
        } else if self.guide_links.is_some() || !self.pictures.is_empty() {
            VERSION_WITH_PHOTOS
        } else {
            VERSION_WITH_MINE
        }
    }

    pub fn is_empty(&self) -> bool {
        self.lists.is_none()
            && self.locations.is_none()
            && self.guide_links.is_none()
            && self.pages.is_none()
            && self.notes.is_none()
            && self.pictures.is_empty()
    }

    /// Each file there is, with its entry's name and kind.
    pub fn files(&self) -> impl Iterator<Item = (&'static str, OwnFile, &str)> {
        MINE_ENTRIES
            .into_iter()
            .zip([
                &self.lists,
                &self.locations,
                &self.guide_links,
                &self.pages,
                &self.notes,
            ])
            .filter_map(|((name, kind), text)| text.as_deref().map(|text| (name, kind, text)))
    }

    fn slot(&mut self, kind: OwnFile) -> &mut Option<String> {
        if kind.suffix == ownlists::LISTS.suffix {
            &mut self.lists
        } else if kind.suffix == ownlists::LOCATIONS.suffix {
            &mut self.locations
        } else if kind.suffix == ownlists::PAGES.suffix {
            &mut self.pages
        } else if kind.suffix == ownlists::NOTES.suffix {
            &mut self.notes
        } else {
            &mut self.guide_links
        }
    }

    /// Checks that each file is the game's and each photo one, and counts
    /// what is in them.
    pub fn check(&self, game_id: &str) -> Result<MineFacts, String> {
        let mut facts = MineFacts::default();
        for (_, kind, text) in self.files() {
            kind.check(game_id, text)?;
            let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
            let count =
                |key: &str| value.get(key).and_then(Value::as_array).map_or(0, Vec::len) as u64;
            if kind.suffix == ownlists::LISTS.suffix {
                facts.lists = count("lists");
            } else if kind.suffix == ownlists::LOCATIONS.suffix {
                facts.locations = count("locations");
                facts.types = count("categories");
                facts.areas = count("regions");
            } else if kind.suffix == ownlists::PAGES.suffix {
                facts.pages = count("pages");
                facts.sections = count("sections");
            } else if kind.suffix == ownlists::NOTES.suffix {
                facts.notes = value
                    .get("notes")
                    .and_then(Value::as_object)
                    .map_or(0, serde_json::Map::len) as u64;
            } else {
                facts.guide_links = true;
            }
        }
        for (file, bytes) in &self.pictures {
            if !ownpictures::is_own_picture_name(file)
                || !ownpictures::bytes_match_name(file, bytes)
            {
                return Err("One of your photos is not a picture Atlas keeps.".to_owned());
            }
        }
        facts.photos = self.pictures.len() as u64;
        Ok(facts)
    }
}

/// Whether a guide links file links a page to one location alone, which
/// only an app that reads guide links version 2 knows (see `guideLinks.ts`
/// in the schema package).
fn links_one_location(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("version").and_then(Value::as_u64))
        .is_some_and(|version| version >= 2)
}

/// The map images in the file.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImagesFacts {
    pub detail: Detail,
    pub files: u64,
    pub bytes: u64,
    pub layers: Vec<LayerFacts>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayerFacts {
    pub id: String,
    pub name: String,
    pub map_name: String,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// The pyramid levels included.
    pub levels: Vec<u8>,
    pub files: u64,
    pub bytes: u64,
    /// Every level up to the detail's top is included.
    pub complete: bool,
    /// Every level of the layer is included (nothing left out at the top).
    pub full: bool,
    /// Its images can be downloaded from a remote source, so the detail
    /// limits it. A layer whose images all came with the pack is included
    /// whole at every detail.
    pub downloadable: bool,
    /// When its images were last downloaded (its status file's time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloaded_at: Option<String>,
}

/// What `.atlas/pack-file.json` keeps about the file a pack was imported from.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedRecord {
    pub imported_at: String,
    pub file_name: String,
    pub header: Header,
}

/// Reads a header from its JSON text: refuses another format, and a newer
/// version with a message naming the app that wrote it.
pub fn parse_header(text: &str) -> Result<Header, String> {
    let not_ours = || "This file is not an Atlas map pack file.".to_owned();
    let value: Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| not_ours())?;
    if value.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(not_ours());
    }
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version > u64::from(VERSION) {
        let by = value.get("exportedBy");
        let name = by
            .and_then(|by| by.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Atlas");
        let app_version = by
            .and_then(|by| by.get("version"))
            .and_then(Value::as_str)
            .unwrap_or("a newer version");
        return Err(format!(
            "This map pack file was made by {} {} in a newer format (version {version}). Install a newer version of Atlas to open it.",
            crate::activity::clean(name),
            crate::activity::clean(app_version)
        ));
    }
    if version < u64::from(VERSION_WITHOUT_MINE) {
        return Err(not_ours());
    }
    serde_json::from_value(value)
        .map_err(|error| format!("This map pack file's description is damaged: {error}."))
}

// ---------------------------------------------------------------------------
// What a pack folder records about itself

/// The pack facts and where its data came from, from a pack folder's
/// manifest and the page data index kept by "Add a map". Nothing is made
/// up: what is not recorded is left out.
pub fn describe_pack(
    root: &Path,
    comes_with_app: bool,
) -> Result<(PackFacts, SourceFacts), String> {
    let manifest = read_json_capped(&root.join(MANIFEST_FILE), MAX_MANIFEST_BYTES)?;
    Ok(describe_manifest(
        &manifest,
        read_import_sources(root),
        comes_with_app,
    ))
}

/// The pages recorded by "Add a map" in `import/index.json`.
#[derive(Clone, Debug, Default)]
pub struct ImportSources {
    pub importer: Option<ImporterFacts>,
    pub pages: Vec<PageFacts>,
}

fn describe_manifest(
    manifest: &Value,
    index: Option<ImportSources>,
    comes_with_app: bool,
) -> (PackFacts, SourceFacts) {
    let text = |key: &str| manifest.get(key).and_then(Value::as_str).map(str::to_owned);
    let pack = PackFacts {
        id: text("gameId").unwrap_or_default(),
        title: text("title").unwrap_or_default().trim().to_owned(),
        pack_version: text("packVersion").unwrap_or_default(),
        game_patch: text("gamePatch"),
        schema_version: manifest
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0),
        attribution: manifest
            .get("attribution")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        created: text("created").filter(|t| iso_millis(t).is_some()),
        updated: text("updated").filter(|t| iso_millis(t).is_some()),
        written_by: manifest
            .get("writtenBy")
            .filter(|value| value.is_object())
            .cloned(),
    };

    let recorded = manifest.get("source");
    let mut importer = recorded
        .and_then(|source| source.get("importer"))
        .and_then(|importer| {
            Some(ImporterFacts {
                id: importer.get("id")?.as_str()?.to_owned(),
                title: importer.get("title")?.as_str()?.to_owned(),
            })
        });
    let mut pages: Vec<PageFacts> = recorded
        .and_then(|source| source.get("pages"))
        .and_then(Value::as_array)
        .map(|pages| {
            pages
                .iter()
                .filter_map(|page| {
                    let url = page.get("url")?.as_str()?;
                    (url.starts_with("https://") || url.starts_with("http://")).then(|| PageFacts {
                        url: url.to_owned(),
                        map_id: page.get("mapId").and_then(Value::as_str).map(str::to_owned),
                        imported_at: page
                            .get("importedAt")
                            .and_then(Value::as_str)
                            .filter(|t| iso_millis(t).is_some())
                            .map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(index) = index {
        if importer.is_none() {
            importer = index.importer;
        }
        // The page data index records every page read, the manifest the
        // pages the pack is made of; a page in both keeps its later time.
        for page in index.pages {
            match pages.iter_mut().find(|known| known.url == page.url) {
                Some(known) => {
                    if later(page.imported_at.as_deref(), known.imported_at.as_deref()) {
                        known.imported_at = page.imported_at;
                    }
                    if known.map_id.is_none() {
                        known.map_id = page.map_id;
                    }
                }
                None => pages.push(page),
            }
        }
    }
    let times: Vec<&str> = pages
        .iter()
        .filter_map(|page| page.imported_at.as_deref())
        .collect();
    let newest = times
        .iter()
        .copied()
        .max_by_key(|t| iso_millis(t))
        .map(str::to_owned);
    let oldest = times
        .iter()
        .copied()
        .min_by_key(|t| iso_millis(t))
        .map(str::to_owned);
    let kind = if importer.is_some() || !pages.is_empty() {
        SourceKind::WebPages
    } else if comes_with_app {
        SourceKind::App
    } else {
        SourceKind::Unknown
    };
    (
        pack,
        SourceFacts {
            kind,
            importer,
            pages,
            newest_page_at: newest,
            oldest_page_at: oldest,
        },
    )
}

/// Whether time `a` is later than `b` (a missing time is never later).
fn later(a: Option<&str>, b: Option<&str>) -> bool {
    match (a.and_then(iso_millis), b.and_then(iso_millis)) {
        (Some(a), Some(b)) => a > b,
        (Some(_), None) => true,
        _ => false,
    }
}

/// Milliseconds since 1970 of an ISO 8601 date and time with `Z` or an
/// offset (`2026-11-10T21:30:00.000Z`); `None` for anything else.
pub fn iso_millis(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &fraction[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && rest.as_bytes()[3] == b':' => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hours: i64 = rest[1..3].parse().ok()?;
            let minutes: i64 = rest[4..6].parse().ok()?;
            sign * (hours * 60 + minutes)
        }
        _ => return None,
    };
    // Days since 1970-01-01 (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

/// Milliseconds since 1970 as ISO 8601 in UTC.
pub fn millis_to_iso(millis: u64) -> String {
    rfc3339(millis / 1000)
}

/// Counts the entries of the pack's list files.
pub fn count_contents(root: &Path) -> Counts {
    let count = |name: &str| count_array(&root.join(name));
    Counts {
        maps: count("maps.json"),
        layers: count("layers.json"),
        locations: count("locations.json"),
        categories: count("categories.json"),
        regions: count("regions.json"),
        checklists: count("checklists.json"),
        guides: count("guides.json"),
    }
}

/// The number of entries of a JSON array file; 0 when absent or unreadable.
fn count_array(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_file() || metadata.len() > crate::library::MAX_PACK_FILE_BYTES as u64 {
        return 0;
    }
    fs::File::open(path)
        .ok()
        .and_then(|file| {
            serde_json::from_reader::<_, Vec<serde::de::IgnoredAny>>(BufReader::new(file)).ok()
        })
        .map_or(0, |items| items.len() as u64)
}

// ---------------------------------------------------------------------------
// Pictures: the pack's `pictures/` folder, which guides show by id

/// The list of a pack's pictures (see the pack format).
pub const PICTURES_FILE: &str = "pictures.json";
/// A picture larger than this is not one.
pub const MAX_PICTURE_BYTES: u64 = 16 << 20;

/// Whether `path` names a picture as the pack format allows:
/// `pictures/<name>.<png|jpg|jpeg|webp|gif>`, the name plain letters,
/// digits, `_`, `.` and `-`, starting with a letter or digit.
pub fn is_picture_path(path: &str) -> bool {
    let Some(name) = path.strip_prefix("pictures/") else {
        return false;
    };
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-');
    name.len() <= 121 + extension.len()
        && stem.starts_with(|c: char| c.is_ascii_alphanumeric())
        && stem.chars().all(plain)
        && matches!(extension, "png" | "jpg" | "jpeg" | "webp" | "gif")
}

/// The pictures a map pack file carries: those the pack marks as shareable
/// and whose file is there, in the pack folder or (downloaded for a pack
/// that comes with the app) its overlay `images`; with `own_use`, which the
/// person asks for, those kept for their own use (`shareable: false`) too,
/// still marked so. `list` is the pack's `pictures.json` cut down to them,
/// and to the pictures fetched later (with a `remote` address) whose files
/// are not carried, so another app with downloads can fetch them for
/// itself; none when the pack has no pictures.
pub struct SharedPictures {
    pub list: Vec<u8>,
    pub files: Vec<Entry>,
}

/// How many pictures kept for the person's own use have their file here,
/// and their bytes: what "Include downloaded photos" would add to a file.
pub fn own_use_pictures(root: &Path, images: &Path) -> Result<(u64, u64), String> {
    let Some(all) = shared_pictures(root, images, true)? else {
        return Ok((0, 0));
    };
    let shared = shared_pictures(root, images, false)?.map_or(Vec::new(), |shared| shared.files);
    let bytes = |files: &[Entry]| files.iter().map(|entry| entry.size).sum::<u64>();
    Ok((
        (all.files.len() - shared.len()) as u64,
        bytes(&all.files) - bytes(&shared),
    ))
}

pub fn shared_pictures(
    root: &Path,
    images: &Path,
    own_use: bool,
) -> Result<Option<SharedPictures>, String> {
    let path = root.join(PICTURES_FILE);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    let Value::Array(pictures) =
        read_json_capped(&path, crate::library::MAX_PACK_FILE_BYTES as u64)?
    else {
        return Err(format!("The pack's {PICTURES_FILE} is not a list."));
    };
    let mut kept = Vec::new();
    let mut files = Vec::new();
    for picture in pictures {
        let shareable = picture.get("shareable").and_then(Value::as_bool) == Some(true);
        let remote = picture.get("remote").and_then(Value::as_str).is_some();
        let Some(file) = picture.get("file").and_then(Value::as_str) else {
            continue;
        };
        if !is_picture_path(file) {
            continue;
        }
        let Some(relative) = relative_path(file) else {
            continue;
        };
        let found = if shareable || own_use {
            [root.join(&relative), images.join(&relative)]
                .into_iter()
                .find_map(|on_disk| match fs::symlink_metadata(&on_disk) {
                    Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_PICTURE_BYTES => {
                        Some((on_disk, metadata.len()))
                    }
                    _ => None,
                })
        } else {
            None
        };
        match found {
            Some((on_disk, size)) => {
                files.push(Entry {
                    name: file.to_owned(),
                    data: EntryData::File(on_disk),
                    size,
                });
                kept.push(picture);
            }
            // Listed without its file: fetched later, where downloads are.
            None if remote => kept.push(picture),
            None => {}
        }
    }
    let mut list = serde_json::to_vec_pretty(&Value::Array(kept)).expect("JSON serialises");
    list.push(b'\n');
    Ok(Some(SharedPictures { list, files }))
}

/// Reads a JSON file of at most `cap` bytes.
fn read_json_capped(path: &Path, cap: u64) -> Result<Value, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let metadata = fs::symlink_metadata(path).map_err(|_| format!("The pack has no {name}."))?;
    if !metadata.is_file() {
        return Err(format!("The pack's {name} is not a file."));
    }
    if metadata.len() > cap {
        return Err(format!("The pack's {name} is too large."));
    }
    let text =
        fs::read_to_string(path).map_err(|error| format!("Could not read {name}: {error}"))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| format!("The pack's {name} is not valid JSON."))
}

// ---------------------------------------------------------------------------
// Layers

/// How a layer's tiles are stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileKind {
    /// One PMTiles archive: cannot be cut to a detail, and the Android
    /// WebView cannot read it.
    Pmtiles,
    /// A folder of tiles at a `{z}/{x}/{y}` template (any order).
    Xyz,
}

/// One tile layer of a pack, as far as a map pack file needs it.
#[derive(Clone, Debug)]
pub struct LayerInfo {
    pub id: String,
    pub local_id: String,
    pub name: String,
    pub map_name: String,
    pub kind: TileKind,
    /// The tile URL template, relative to the pack root.
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// Its images can be downloaded (`tiles.remote`), so a status file says
    /// which levels are there.
    pub remote: bool,
}

impl LayerInfo {
    /// "Surface (Island)".
    pub fn label(&self) -> String {
        if self.map_name.is_empty() || self.map_name == self.name {
            self.name.clone()
        } else {
            format!("{} ({})", self.name, self.map_name)
        }
    }

    /// Columns and rows of level `z`.
    pub fn grid(&self, z: u8) -> (u64, u64) {
        let grid = level_grid(self.width, self.height, self.tile_size, self.max_zoom, z);
        (grid.columns, grid.rows)
    }

    /// Where a tile lives, relative to the pack root, as a `/` path.
    pub fn tile_name(&self, z: u8, x: u64, y: u64) -> String {
        fill_template(&self.url, u64::from(z), x, y)
    }

    /// The status file of the layer, as a `/` path.
    pub fn status_name(&self) -> String {
        format!("{STATUS_DIR}/{}.json", self.local_id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLayer {
    id: String,
    map_id: String,
    name: String,
    tiles: Value,
    min_zoom: u8,
    max_zoom: u8,
    tile_size: u32,
}

#[derive(Deserialize)]
struct RawMap {
    id: String,
    #[serde(default)]
    name: String,
    width: u32,
    height: u32,
}

/// The tile layers of a pack, from the text of its `maps.json` and
/// `layers.json`. Errs for a layer whose tiles could not be placed safely.
pub fn parse_layers(maps_json: &str, layers_json: &str) -> Result<Vec<LayerInfo>, String> {
    let bad = |what: &str| format!("The pack's {what} is not usable.");
    let maps: Vec<RawMap> = serde_json::from_str(maps_json.trim_start_matches('\u{feff}'))
        .map_err(|_| bad("maps.json"))?;
    let layers: Vec<RawLayer> = serde_json::from_str(layers_json.trim_start_matches('\u{feff}'))
        .map_err(|_| bad("layers.json"))?;
    let mut out = Vec::new();
    for layer in layers {
        let map = maps
            .iter()
            .find(|map| map.id == layer.map_id)
            .ok_or_else(|| bad("layers.json"))?;
        let kind = match layer.tiles.get("type").and_then(Value::as_str) {
            Some("pmtiles") => TileKind::Pmtiles,
            Some("xyz") => TileKind::Xyz,
            _ => return Err(bad("layers.json")),
        };
        let url = layer
            .tiles
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let local_id = layer.id.rsplit(':').next().unwrap_or_default().to_owned();
        let usable = is_safe_segment(&local_id)
            && layer.min_zoom <= layer.max_zoom
            && layer.max_zoom <= 24
            && layer.tile_size.is_power_of_two()
            && (64..=1024).contains(&layer.tile_size)
            && map.width > 0
            && map.height > 0
            && (kind == TileKind::Pmtiles
                || (["{z}", "{x}", "{y}"].iter().all(|part| url.contains(part))
                    && relative_path(&fill_template(&url, 0, 0, 0)).is_some()));
        if !usable {
            return Err(format!(
                "The pack's layer {} cannot be placed safely in a folder.",
                crate::activity::clean(&layer.name)
            ));
        }
        out.push(LayerInfo {
            remote: kind == TileKind::Xyz && layer.tiles.get("remote").is_some(),
            id: layer.id,
            local_id,
            name: layer.name,
            map_name: map.name.clone(),
            kind,
            url,
            width: map.width,
            height: map.height,
            tile_size: layer.tile_size,
            min_zoom: layer.min_zoom,
            max_zoom: layer.max_zoom,
        });
    }
    Ok(out)
}

/// Reads a layer's status file from `images_root`; none when there is no
/// usable one.
pub fn read_status(images_root: &Path, layer: &LayerInfo) -> Option<LayerStatus> {
    let path = images_root
        .join(STATUS_DIR)
        .join(format!("{}.json", layer.local_id));
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 1 << 20 {
        return None;
    }
    serde_json::from_str::<LayerStatus>(&fs::read_to_string(path).ok()?)
        .ok()
        .filter(|status| status.layer_id == layer.id && status.format == STATUS_FORMAT)
}

// ---------------------------------------------------------------------------
// Files on disk

/// The sizes of the regular files in the folders under a root, read one
/// folder listing at a time (on Windows a listing carries each file's
/// size, so this is much quicker than asking for every tile), without
/// following symbolic links or junctions on the way.
pub struct DirCache {
    root: PathBuf,
    real: HashMap<PathBuf, bool>,
    listings: HashMap<PathBuf, Option<HashMap<OsString, u64>>>,
}

impl DirCache {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            real: HashMap::new(),
            listings: HashMap::new(),
        }
    }

    /// Whether `relative` is a folder below the root reached through real
    /// folders only.
    fn is_real(&mut self, relative: &Path) -> bool {
        if !*self
            .real
            .entry(PathBuf::new())
            .or_insert_with(|| is_real_dir(&self.root))
        {
            return false;
        }
        let mut so_far = PathBuf::new();
        for component in relative.components() {
            let Component::Normal(part) = component else {
                return false;
            };
            so_far.push(part);
            let path = self.root.join(&so_far);
            if !*self
                .real
                .entry(so_far.clone())
                .or_insert_with(|| is_real_dir(&path))
            {
                return false;
            }
        }
        true
    }

    /// The size of the regular file at `relative` (a `/` path), if there is one.
    pub fn len(&mut self, relative: &str) -> Option<u64> {
        let (parent, name) = match relative.rsplit_once('/') {
            Some((parent, name)) => (relative_path(parent)?, name),
            None => (PathBuf::new(), relative),
        };
        if !self.listings.contains_key(&parent) {
            let listing = self.is_real(&parent).then(|| {
                fs::read_dir(self.root.join(&parent))
                    .map(|entries| {
                        entries
                            .flatten()
                            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                            .map(|entry| {
                                let size = entry.metadata().map_or(0, |m| m.len());
                                (entry.file_name(), size)
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            });
            self.listings.insert(parent.clone(), listing);
        }
        self.listings
            .get(&parent)?
            .as_ref()?
            .get(std::ffi::OsStr::new(name))
            .copied()
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative_path(relative).unwrap_or_default())
    }
}

// ---------------------------------------------------------------------------
// What an export holds

/// A pack to export: its folder, and where its downloaded map images are
/// (see `TileStore`: the overlay first, then the pack).
#[derive(Clone, Debug)]
pub struct PackSource {
    pub pack_id: String,
    /// The pack's folder: its JSON files, and images that came with it.
    pub root: PathBuf,
    /// Where downloaded map images and their status files are: the pack
    /// folder itself, or the overlay of a pack served from the app's
    /// resources.
    pub images: PathBuf,
    /// The pack folder is one the person keeps, so its lock is held while
    /// it is read.
    pub lock: bool,
    /// The pack comes with the app that exports it.
    pub comes_with_app: bool,
    /// The person asked for the pictures downloaded for their own use
    /// (`shareable: false`, such as location photos) to go in the file
    /// too: it is then a file to keep, not to pass on.
    pub own_use_pictures: bool,
}

/// One entry of the file.
#[derive(Debug)]
pub struct Entry {
    pub name: String,
    pub data: EntryData,
    pub size: u64,
}

#[derive(Debug)]
pub enum EntryData {
    File(PathBuf),
    Bytes(Vec<u8>),
}

/// The pack's layers and what is recorded about their images.
pub struct Analysis {
    pub layers: Vec<LayerInfo>,
    /// The download plans of the layers with a remote source, by layer id.
    pub plans: BTreeMap<String, LayerPlan>,
    /// Their status files, by layer id.
    pub statuses: BTreeMap<String, LayerStatus>,
}

/// Why a pack cannot be exported at all, in plain words; none when it can.
pub fn refusal(analysis: &Analysis) -> Option<String> {
    let archives: Vec<String> = analysis
        .layers
        .iter()
        .filter(|layer| layer.kind == TileKind::Pmtiles)
        .map(LayerInfo::label)
        .collect();
    if archives.is_empty() {
        None
    } else {
        Some(format!(
            "This game's map images are kept in one large archive file ({}), which cannot be cut down to a level of detail and which Atlas for Android cannot read, so it cannot be exported as a map pack file. Copy its pack folder instead.",
            archives.join(", ")
        ))
    }
}

/// Reads a pack's layers, their download plans and status files.
pub fn analyse(source: &PackSource) -> Result<Analysis, String> {
    let read = |name: &str| {
        let path = source.root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() && m.len() <= crate::library::MAX_PACK_FILE_BYTES as u64 => {
                fs::read_to_string(&path).map_err(|error| format!("Could not read {name}: {error}"))
            }
            _ => Err(format!("The pack's {name} cannot be read.")),
        }
    };
    // A game with no map has neither file; one without the other is damaged.
    let present = |name: &str| fs::symlink_metadata(source.root.join(name)).is_ok();
    let layers = if !present("maps.json") && !present("layers.json") {
        Vec::new()
    } else {
        parse_layers(&read("maps.json")?, &read("layers.json")?)?
    };
    let mut plans = BTreeMap::new();
    if layers.iter().any(|layer| layer.remote) {
        let plan = crate::tiles::pyramid::read_pack_plan(&source.root)
            .map_err(|error| format!("The pack's map images cannot be placed: {error}."))?;
        for layer in plan.layers {
            plans.insert(layer.layer_id.clone(), layer);
        }
    }
    let statuses = layers
        .iter()
        .filter(|layer| layer.remote)
        .filter_map(|layer| Some((layer.id.clone(), read_status(&source.images, layer)?)))
        .collect();
    Ok(Analysis {
        layers,
        plans,
        statuses,
    })
}

/// The levels of a layer a file at `detail` holds: up to the detail's top
/// for a layer with a remote source (as downloads count it), every level
/// for a layer whose images all came with the pack (nothing says which of
/// its levels are there, so the map would show missing tiles as blank).
pub fn levels_for(analysis: &Analysis, layer: &LayerInfo, detail: Detail) -> BTreeSet<u8> {
    let top = analysis
        .plans
        .get(&layer.id)
        .map_or(layer.max_zoom, |plan| plan.top_for(detail));
    (layer.min_zoom..=top).collect()
}

/// Why `detail` cannot be exported (its images are not all downloaded);
/// none when it can.
pub fn unavailable(analysis: &Analysis, detail: Detail) -> Option<String> {
    let missing: Vec<String> = analysis
        .layers
        .iter()
        .filter(|layer| layer.remote)
        .filter(|layer| {
            let recorded: BTreeSet<u8> = analysis
                .statuses
                .get(&layer.id)
                .map(|status| status.levels.iter().copied().collect())
                .unwrap_or_default();
            !levels_for(analysis, layer, detail).is_subset(&recorded)
        })
        .map(LayerInfo::label)
        .collect();
    (!missing.is_empty()).then(|| format!("Not downloaded: {}.", missing.join(", ")))
}

/// The map image entries of a file at `detail`, and what they hold per
/// layer. Looks at the files on disk without reading them: downloaded
/// images first, then those that came with the pack.
pub fn plan_images(
    analysis: &Analysis,
    detail: Detail,
    images: &mut DirCache,
    shipped: &mut Option<DirCache>,
) -> (Vec<Entry>, Vec<LayerFacts>) {
    let mut entries = Vec::new();
    let mut facts = Vec::new();
    let marker = crate::tiles::store::MISSING_SUFFIX;
    for layer in analysis
        .layers
        .iter()
        .filter(|layer| layer.kind == TileKind::Xyz)
    {
        let levels = levels_for(analysis, layer, detail);
        let (mut files, mut bytes) = (0, 0);
        for &z in &levels {
            let (columns, rows) = layer.grid(z);
            for y in 0..rows {
                for x in 0..columns {
                    // The layer's own path (`fill_template`, as the
                    // downloader's `tile_path`), whatever its order of
                    // placeholders, so the tiles are where the map asks.
                    let name = layer.tile_name(z, x, y);
                    if let Some(size) = images.len(&name) {
                        entries.push(Entry {
                            data: EntryData::File(images.path(&name)),
                            name,
                            size,
                        });
                        files += 1;
                        bytes += size;
                        continue;
                    }
                    if let Some(size) = shipped.as_mut().and_then(|pack| pack.len(&name)) {
                        let path = shipped.as_ref().map(|pack| pack.path(&name));
                        entries.push(Entry {
                            data: EntryData::File(path.unwrap_or_default()),
                            name,
                            size,
                        });
                        files += 1;
                        bytes += size;
                        continue;
                    }
                    let missing = format!("{name}{marker}");
                    if layer.remote && images.len(&missing).is_some() {
                        entries.push(Entry {
                            name: missing,
                            data: EntryData::Bytes(Vec::new()),
                            size: 0,
                        });
                    }
                }
            }
        }
        let status = analysis.statuses.get(&layer.id);
        facts.push(LayerFacts {
            id: layer.id.clone(),
            name: layer.name.clone(),
            map_name: layer.map_name.clone(),
            min_zoom: layer.min_zoom,
            max_zoom: layer.max_zoom,
            complete: !layer.remote
                || status.is_some_and(|status| levels.iter().all(|z| status.levels.contains(z))),
            full: levels.last() == Some(&layer.max_zoom),
            levels: levels.into_iter().collect(),
            files,
            bytes,
            downloadable: layer.remote,
            downloaded_at: status
                .filter(|status| status.updated_at > 0)
                .map(|status| millis_to_iso(status.updated_at)),
        });
    }
    (entries, facts)
}

/// The pack's JSON files that are there, as entries (the manifest read
/// in full, to be rewritten).
pub fn pack_file_entries(root: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for name in PACK_FILES {
        let path = root.join(name);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > crate::library::MAX_PACK_FILE_BYTES as u64 {
            return Err(format!("The pack's {name} is too large."));
        }
        entries.push(Entry {
            name: (*name).to_owned(),
            data: EntryData::File(path),
            size: metadata.len(),
        });
    }
    if !entries.iter().any(|entry| entry.name == MANIFEST_FILE) {
        return Err("The pack has no manifest.json.".to_owned());
    }
    Ok(entries)
}

// ---------------------------------------------------------------------------
// The Export dialog's choices

/// One detail in the Export dialog.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetailOption {
    pub detail: Detail,
    /// Every image it needs is downloaded.
    pub available: bool,
    /// Why not, in plain words.
    pub reason: Option<String>,
    /// Map images and their bytes.
    pub images: u64,
    pub image_bytes: u64,
    /// The whole file, unpacked: images, pack files and status files.
    pub bytes: u64,
}

/// What the Export dialog offers for a pack.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub pack_id: String,
    pub title: String,
    /// The pack can be exported at all.
    pub exportable: bool,
    /// Why not, in plain words.
    pub reason: Option<String>,
    pub details: Vec<DetailOption>,
    /// Layers whose images all came with the pack: they are exported whole
    /// at every detail.
    pub whole_layers: Vec<String>,
    /// The file name the save dialog suggests for each detail is
    /// `<packId>-<detail>.atlaspack`.
    pub default_names: BTreeMap<String, String>,
    /// The pictures downloaded for the person's own use (location photos,
    /// pictures of guide pages) that "Include downloaded photos" would add,
    /// and their bytes; 0 when there are none to offer.
    pub own_use_pictures: u64,
    pub own_use_picture_bytes: u64,
}

/// The default file name of an export.
pub fn default_file_name(pack_id: &str, detail: Detail) -> String {
    format!("{pack_id}-{}.{EXTENSION}", detail_name(detail))
}

pub fn detail_name(detail: Detail) -> &'static str {
    match detail {
        Detail::Overview => "overview",
        Detail::Standard => "standard",
        Detail::Full => "full",
    }
}

/// The choices and sizes for the Export dialog, worked out from the files'
/// sizes on disk, without reading any image.
pub fn export_options(source: &PackSource) -> Result<ExportOptions, String> {
    let (pack, _) = describe_pack(&source.root, source.comes_with_app)?;
    let analysis = analyse(source)?;
    let reason = refusal(&analysis);
    let json_bytes: u64 = pack_file_entries(&source.root)?
        .iter()
        .map(|entry| entry.size)
        .sum();
    let mut images = DirCache::new(&source.images);
    let mut shipped = (source.images != source.root).then(|| DirCache::new(&source.root));
    let mut details = Vec::new();
    for detail in Detail::ALL {
        let (entries, facts) = if reason.is_none() {
            plan_images(&analysis, detail, &mut images, &mut shipped)
        } else {
            (Vec::new(), Vec::new())
        };
        let image_bytes: u64 = facts.iter().map(|layer| layer.bytes).sum();
        let missing = unavailable(&analysis, detail);
        details.push(DetailOption {
            detail,
            available: reason.is_none() && missing.is_none(),
            reason: missing,
            images: facts.iter().map(|layer| layer.files).sum(),
            image_bytes,
            // Status files are a few hundred bytes each.
            bytes: entries.iter().map(|entry| entry.size).sum::<u64>()
                + json_bytes
                + 512 * analysis.statuses.len() as u64,
        });
    }
    let (own_use_pictures, own_use_picture_bytes) = own_use_pictures(&source.root, &source.images)?;
    Ok(ExportOptions {
        own_use_pictures,
        own_use_picture_bytes,
        pack_id: source.pack_id.clone(),
        title: pack.title,
        exportable: reason.is_none(),
        reason,
        details,
        whole_layers: analysis
            .layers
            .iter()
            .filter(|layer| layer.kind == TileKind::Xyz && !layer.remote)
            .map(LayerInfo::label)
            .collect(),
        default_names: Detail::ALL
            .iter()
            .map(|&detail| {
                (
                    detail_name(detail).to_owned(),
                    default_file_name(&source.pack_id, detail),
                )
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// An installed pack, for the Maps dialog

/// One layer of an installed pack, for the Maps dialog.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledLayer {
    pub id: String,
    pub name: String,
    pub map_name: String,
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub downloadable: bool,
    /// The complete levels recorded (downloadable layers).
    pub levels: Vec<u8>,
    pub downloaded_at: Option<String>,
}

/// What is known about an installed pack: the same facts a map pack file
/// carries.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackDetails {
    pub pack: PackFacts,
    pub source: SourceFacts,
    pub contents: Counts,
    pub layers: Vec<InstalledLayer>,
    /// The highest detail whose map images are all downloaded; none when
    /// not even the overview is, or nothing can be downloaded.
    pub detail: Option<Detail>,
    /// The latest time any of its map images were downloaded.
    pub images_at: Option<String>,
    /// Its images are in one archive (it cannot be exported).
    pub archive: bool,
    /// The map pack file it was imported from, if it was.
    pub pack_file: Option<ImportedRecord>,
}

/// The facts about an installed pack.
pub fn pack_details(source: &PackSource) -> Result<PackDetails, String> {
    let (pack, source_facts) = describe_pack(&source.root, source.comes_with_app)?;
    let analysis = analyse(source)?;
    let detail = analysis
        .layers
        .iter()
        .any(|layer| layer.remote)
        .then(|| {
            Detail::ALL
                .into_iter()
                .rev()
                .find(|&detail| unavailable(&analysis, detail).is_none())
        })
        .flatten();
    let layers: Vec<InstalledLayer> = analysis
        .layers
        .iter()
        .map(|layer| {
            let status = analysis.statuses.get(&layer.id);
            InstalledLayer {
                id: layer.id.clone(),
                name: layer.name.clone(),
                map_name: layer.map_name.clone(),
                min_zoom: layer.min_zoom,
                max_zoom: layer.max_zoom,
                downloadable: layer.remote,
                levels: status.map(|s| s.levels.clone()).unwrap_or_default(),
                downloaded_at: status
                    .filter(|s| s.updated_at > 0)
                    .map(|s| millis_to_iso(s.updated_at)),
            }
        })
        .collect();
    let images_at = analysis
        .statuses
        .values()
        .map(|status| status.updated_at)
        .filter(|&at| at > 0)
        .max()
        .map(millis_to_iso);
    Ok(PackDetails {
        pack,
        source: source_facts,
        contents: count_contents(&source.root),
        archive: refusal(&analysis).is_some(),
        layers,
        detail,
        images_at,
        pack_file: read_imported_record(&source.root),
    })
}

/// The record of the map pack file a pack folder was imported from.
pub fn read_imported_record(root: &Path) -> Option<ImportedRecord> {
    let path = root.join(META_DIR).join(IMPORTED_RECORD);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_HEADER_BYTES {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path).ok()?.read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests;
