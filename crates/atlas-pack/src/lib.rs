//! Atlas pack files (`.atlaspack`): what another app needs to show one
//! without unpacking it.
//!
//! A pack file is one game's pack folder in a ZIP archive. Its first entry,
//! `atlaspack.json`, is the description ([`Header`]): which game, its maps
//! and its pages, where its data came from and when, and which app made the
//! file. From version 7 of the format, a small picture of each map
//! (`preview/<name>.jpg`) follows directly after it, before everything else,
//! so a card for the file can be shown by reading the start of the file only.
//!
//! This crate holds the description's types, the format's constants, the
//! checks a reader makes ([`parse_header`]), and two bounded reads of a file
//! on disk or of any stream read in order: the description
//! ([`read_header`], [`read_header_from`]) and one small picture by its
//! entry name ([`read_preview`], [`read_preview_from`]). It has no app code
//! and makes no network request. The Atlas app writes and imports pack files
//! with these same types. See `docs/pack-file-format.md` in the Atlas
//! repository for the format.

mod read;

#[cfg(test)]
mod tests;

pub use read::{read_header, read_header_from, read_preview, read_preview_from};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `format` of the description.
pub const FORMAT: &str = "atlas-pack-file";
/// The newest version of the format this crate reads. A file is written at
/// the lowest version that can hold what it carries, so an older app reads
/// every file it can, and refuses a newer one with a message.
pub const VERSION: u32 = 7;
/// A file with small pictures of its maps (`preview/`).
pub const VERSION_WITH_PREVIEWS: u32 = 7;
/// A file with the title the game is shown under with other games
/// (`mine/game-group.json`) and no small pictures.
pub const VERSION_WITH_TITLE: u32 = 6;
/// A file with a person's notes, or a guide page linked to one location
/// alone, but no title.
pub const VERSION_WITH_NOTES: u32 = 5;
/// A file with a person's own pages but no notes.
pub const VERSION_WITH_PAGES: u32 = 4;
/// A file with a person's photos or guide links but no own pages.
pub const VERSION_WITH_PHOTOS: u32 = 3;
/// A file with a person's own lists, locations and types only.
pub const VERSION_WITH_MINE: u32 = 2;
/// A file without anything of a person's own, which every app with pack
/// files reads.
pub const VERSION_WITHOUT_MINE: u32 = 1;
/// The description, the file's first entry.
pub const HEADER_FILE: &str = "atlaspack.json";
/// The file name extension, without the dot.
pub const EXTENSION: &str = "atlaspack";
/// A description larger than this is not read.
pub const MAX_HEADER_BYTES: u64 = 4 << 20;

/// Where the small pictures of the maps are: `preview/<name>.jpg`.
pub const PREVIEW_DIR: &str = "preview/";
/// The longest side of a small picture, in pixels.
pub const PREVIEW_SIDE: u32 = 512;
/// A small picture larger than this is not one.
pub const MAX_PREVIEW_BYTES: u64 = 512 << 10;
/// The most small pictures one file holds.
pub const MAX_PREVIEWS: usize = 1024;
/// The longest name of a small picture, without `preview/` and `.jpg`.
pub const MAX_PREVIEW_NAME: usize = 80;

/// Whether `name` is an entry name a small picture may have:
/// `preview/<name>.jpg`, the name 1 to [`MAX_PREVIEW_NAME`] characters of
/// lower case letters, digits, `-` and `_`, starting with a letter or a
/// digit. Lower case only, so no two names differ only by case.
pub fn is_preview_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix(PREVIEW_DIR)
        .and_then(|rest| rest.strip_suffix(".jpg"))
    else {
        return false;
    };
    (1..=MAX_PREVIEW_NAME).contains(&stem.len())
        && stem.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && stem
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// How much of a map's pyramid of images a file holds.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Detail {
    /// Two levels short of the top: a quick download, blurry close up.
    Overview,
    /// One level short of the top: about a quarter of the full download.
    Standard,
    /// Every level.
    Full,
}

impl Detail {
    pub const ALL: [Detail; 3] = [Detail::Overview, Detail::Standard, Detail::Full];

    /// Levels left out at the top of each layer.
    pub fn levels_short(self) -> u8 {
        match self {
            Detail::Overview => 2,
            Detail::Standard => 1,
            Detail::Full => 0,
        }
    }
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
// The description

/// `atlaspack.json`: what a pack file holds, readable without unpacking
/// anything else. Every date is ISO 8601 in UTC. Fields added after
/// version 1 are optional: an older file has none of them, and an older
/// reader ignores them.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format: String,
    pub version: u32,
    pub pack_id: String,
    pub title: String,
    /// The game, as it is shown with other games.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game: Option<GameFacts>,
    pub pack_version: String,
    pub detail: Detail,
    pub exported_at: String,
    pub exported_by: AppInfo,
    pub pack: PackFacts,
    /// The pack's manifest says it is kept for the person's own use (a page
    /// of it was read under a licence the person filled in, or with none
    /// recorded). Written only when true.
    #[serde(default, skip_serializing_if = "is_false")]
    pub personal_use: bool,
    pub source: SourceFacts,
    pub contents: Counts,
    /// Each map of the pack, in the order of its `maps.json`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub maps: Vec<MapFacts>,
    /// The pages of the pack, as a guide or a wiki (at most one entry: a
    /// pack's pages are one source of pages).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guides: Vec<GuideFacts>,
    /// The entry name of the small picture to show for the file: that of
    /// the first map that has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub images: ImagesFacts,
    /// Entries after the description, and their size unpacked.
    pub files: u64,
    pub bytes: u64,
    /// How many of a person's own records the file carries, when it carries
    /// them (version 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mine: Option<MineFacts>,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl Header {
    /// The entry names of the small pictures the description lists: each
    /// map's and the cover, each once.
    pub fn previews(&self) -> Vec<&str> {
        let mut names: Vec<&str> = Vec::new();
        for name in self
            .maps
            .iter()
            .filter_map(|map| map.preview.as_deref())
            .chain(self.cover.as_deref())
        {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        names
    }

    /// Whether the description lists `name` as a small picture.
    pub fn lists_preview(&self, name: &str) -> bool {
        self.maps
            .iter()
            .any(|map| map.preview.as_deref() == Some(name))
            || self.cover.as_deref() == Some(name)
    }
}

/// The game a file is of, as a list of games shows it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameFacts {
    /// The title the game is shown under with other games when it is in a
    /// group, whether or not the file carries that group
    /// (`mine/game-group.json`); otherwise the pack's own title. Two packs
    /// of one game, read from two sites and grouped, give the same title.
    pub title: String,
    /// The system the game is for, as the pack's manifest names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
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
    /// The name of the site the pages were read from, as the pack records
    /// it (the site its guide pages name). Absent when the pack records no
    /// site's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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

/// One map of the pack.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MapFacts {
    pub id: String,
    pub name: String,
    /// The size of its most detailed image, in pixels.
    pub width: u32,
    pub height: u32,
    /// Its locations in the pack.
    pub locations: u64,
    /// The entry name of its small picture (`preview/<name>.jpg`), when the
    /// file holds one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// How a pack's pages are read.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GuideType {
    /// Read in order: each page leads on to the next.
    Guide,
    /// Read as a collection of pages.
    Wiki,
    /// A type this crate does not know (from a newer file).
    #[serde(other)]
    Other,
}

/// The pages of a pack, as one guide or one wiki.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GuideFacts {
    pub title: String,
    #[serde(rename = "type")]
    pub guide_type: GuideType,
    /// Its pages.
    pub pages: u64,
}

/// How many of a person's own records a file carries.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MineFacts {
    pub lists: u64,
    pub locations: u64,
    pub types: u64,
    pub areas: u64,
    /// Their own photos.
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
    /// Whether the title the game is shown under with other games is in it
    /// (version 6).
    pub group: bool,
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

// ---------------------------------------------------------------------------
// Reading a description

const NOT_A_PACK_FILE: &str = "This file is not an Atlas pack file.";

/// Reads a description from its JSON text: refuses another format, and a
/// newer version with a message naming the app that wrote it. The names of
/// small pictures that are not safe entry names (see [`is_preview_name`])
/// are left out, so a reader never meets one.
pub fn parse_header(text: &str) -> Result<Header, String> {
    let not_ours = || NOT_A_PACK_FILE.to_owned();
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
            "This pack file was made by {} {} in a newer format (version {version}). Install a newer version of Atlas to open it.",
            clean(name),
            clean(app_version)
        ));
    }
    if version < u64::from(VERSION_WITHOUT_MINE) {
        return Err(not_ours());
    }
    let mut header: Header = serde_json::from_value(value)
        .map_err(|error| format!("This pack file's description is damaged: {error}."))?;
    for map in &mut header.maps {
        if map
            .preview
            .as_deref()
            .is_some_and(|name| !is_preview_name(name))
        {
            map.preview = None;
        }
    }
    if header
        .cover
        .as_deref()
        .is_some_and(|name| !is_preview_name(name))
    {
        header.cover = None;
    }
    Ok(header)
}

/// A text from a file made safe to show in one line: line breaks become
/// spaces, other control characters and those that change the direction of
/// text are left out.
fn clean(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            c if c.is_control() => None,
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => None,
            c => Some(c),
        })
        .collect()
}
