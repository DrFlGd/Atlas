//! What a pack file's description says so another app can show a card for
//! the file without unpacking it: the game's title and system, whether the
//! game is kept for the person's own use, its maps, its pages as a guide or
//! a wiki, and the name of the site its pages were read from (see
//! [`site_name`]). Everything is
//! read from the pack's own files, and what they do not say is left out.
//! A file that cannot be read here only makes the description say less: it
//! never stops an export.

use std::{collections::HashMap, fs, path::Path};

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;

use super::{
    read_json_capped, GameFacts, GuideFacts, GuideType, MapFacts, RawMap, SourceFacts, SourceKind,
};
use crate::{
    library::MAX_PACK_FILE_BYTES,
    manifest::{MANIFEST_FILE, MAX_MANIFEST_BYTES},
};

/// The longest system name the description gives (as the pack schema allows).
const MAX_SYSTEM_CHARS: usize = 80;
/// The longest title or site name the description gives.
const MAX_NAME_CHARS: usize = 200;

/// What a card shows of a pack.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Card {
    pub game: GameFacts,
    pub personal_use: bool,
    /// Each map, without its small picture (see `preview`).
    pub maps: Vec<MapFacts>,
    pub guides: Vec<GuideFacts>,
    /// The site its pages were read from, as the manifest names it
    /// (`source.site`), else as its guide pages name it most; see
    /// [`site_name`] for the whole rule.
    pub site_name: Option<String>,
}

/// The card of the pack in `root`, whose own title is `pack_title`. With
/// `group`, the text of the title the game is shown under with other games
/// (`gamegroups::carried`, whether or not the file carries it as
/// `mine/game-group.json`), the game goes by that
/// title.
pub fn read_card(root: &Path, pack_title: &str, group: Option<&str>) -> Card {
    let manifest =
        read_json_capped(&root.join(MANIFEST_FILE), MAX_MANIFEST_BYTES).unwrap_or(Value::Null);
    let text = |key: &str, most: usize| {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .and_then(|value| one_line(value, most))
    };
    let title = group
        .and_then(|group| serde_json::from_str::<Value>(group).ok())
        .and_then(|group| {
            group
                .get("title")
                .and_then(Value::as_str)
                .and_then(|title| one_line(title, MAX_NAME_CHARS))
        })
        .unwrap_or_else(|| pack_title.to_owned());
    let maps = map_facts(root);
    let (guides, guides_site) = guide_facts(root, &manifest, pack_title, !maps.is_empty());
    let site_name = manifest
        .get("source")
        .and_then(|source| source.get("site"))
        .and_then(Value::as_str)
        .and_then(|site| one_line(site, MAX_NAME_CHARS))
        .or(guides_site);
    Card {
        game: GameFacts {
            title,
            system: text("system", MAX_SYSTEM_CHARS),
        },
        personal_use: manifest.get("personalUse") == Some(&Value::Bool(true)),
        maps,
        guides,
        site_name,
    }
}

/// The name of the site a pack was read from, as its description gives it
/// (`source.name`): the one its card found (the manifest's `source.site`,
/// else the site its guide pages name most), else, for a pack read from
/// web pages, the host of the first page it records, without a leading
/// `www.`; none when there is none of these. The importer's title is never
/// taken for it: one importer can read many sites.
pub fn site_name(card_site: Option<String>, source: &SourceFacts) -> Option<String> {
    card_site.or_else(|| {
        if source.kind != SourceKind::WebPages {
            return None;
        }
        let url = tauri::Url::parse(&source.pages.first()?.url).ok()?;
        let host = url.host_str()?;
        let host = host.strip_prefix("www.").unwrap_or(host);
        one_line(host, MAX_NAME_CHARS)
    })
}

/// A text from a pack as one line: trimmed, line breaks as spaces, other
/// control characters and those that change the direction of text left
/// out; none when empty or longer than `most` characters.
fn one_line(text: &str, most: usize) -> Option<String> {
    let clean = crate::activity::clean(text).trim().to_owned();
    (!clean.is_empty() && clean.chars().count() <= most).then_some(clean)
}

/// A list file of the pack, read as `T`; none when it is not there, too
/// large or not such a list.
fn read_list<T: DeserializeOwned>(root: &Path, name: &str) -> Option<Vec<T>> {
    let path = root.join(name);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_PACK_FILE_BYTES as u64 {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// The maps of `maps.json`, in its order, with their locations counted in
/// `locations.json`.
fn map_facts(root: &Path) -> Vec<MapFacts> {
    #[derive(Deserialize)]
    struct Located {
        #[serde(rename = "mapId", default)]
        map_id: Option<String>,
    }
    let Some(maps) = read_list::<RawMap>(root, "maps.json") else {
        return Vec::new();
    };
    let mut counts: HashMap<String, u64> = HashMap::new();
    for location in read_list::<Located>(root, "locations.json").unwrap_or_default() {
        if let Some(map_id) = location.map_id {
            *counts.entry(map_id).or_default() += 1;
        }
    }
    maps.into_iter()
        .map(|map| MapFacts {
            locations: counts.get(&map.id).copied().unwrap_or(0),
            name: one_line(&map.name, MAX_NAME_CHARS).unwrap_or_default(),
            id: map.id,
            width: map.width,
            height: map.height,
            preview: None,
            // Set by the export from what the file carries.
            scene: false,
        })
        .collect()
}

/// The pack's pages as Guides shows them, and the site they were read
/// from. A pack's pages are one source of pages, so there is one entry at
/// most: titled with the pack's title, a guide when the manifest says its
/// pages are read in order (`pagesInOrder`), a wiki otherwise, with the
/// pages its contents list (`sections.json`, however deep, and its home
/// page), or, with no contents and no map, all its guides. A pack with a
/// map and no contents has none: its guides are the notes of its locations
/// and the walkthroughs of its lists. The site is the one its guides name
/// most (`source.site`), the first of those named as often.
fn guide_facts(
    root: &Path,
    manifest: &Value,
    title: &str,
    has_map: bool,
) -> (Vec<GuideFacts>, Option<String>) {
    #[derive(Deserialize)]
    struct Guide {
        id: String,
        #[serde(default)]
        source: Option<Value>,
    }
    #[derive(Deserialize)]
    struct Section {
        #[serde(default)]
        items: Vec<Value>,
    }
    let Some(guides) = read_list::<Guide>(root, "guides.json") else {
        return (Vec::new(), None);
    };
    // The site its guides name most.
    let mut sites: Vec<(String, usize)> = Vec::new();
    for site in guides.iter().filter_map(|guide| {
        guide
            .source
            .as_ref()?
            .get("site")?
            .as_str()
            .and_then(|site| one_line(site, MAX_NAME_CHARS))
    }) {
        match sites.iter_mut().find(|(known, _)| *known == site) {
            Some((_, count)) => *count += 1,
            None => sites.push((site, 1)),
        }
    }
    let most = sites.iter().map(|(_, count)| *count).max().unwrap_or(0);
    let site_name = sites
        .into_iter()
        .find(|(_, count)| *count == most)
        .map(|(site, _)| site);

    let ids: std::collections::HashSet<&str> =
        guides.iter().map(|guide| guide.id.as_str()).collect();
    let sections = read_list::<Section>(root, "sections.json").unwrap_or_default();
    let pages = if !sections.is_empty() {
        let mut listed: std::collections::HashSet<&str> = sections
            .iter()
            .flat_map(|section| section.items.iter().filter_map(Value::as_str))
            .filter(|id| ids.contains(id))
            .collect();
        if let Some(home) = manifest
            .get("homePage")
            .and_then(Value::as_str)
            .filter(|id| ids.contains(id))
        {
            listed.insert(home);
        }
        listed.len() as u64
    } else if !has_map {
        ids.len() as u64
    } else {
        0
    };
    let entry = (pages > 0).then(|| GuideFacts {
        title: one_line(title, MAX_NAME_CHARS).unwrap_or_else(|| title.to_owned()),
        guide_type: if manifest.get("pagesInOrder") == Some(&Value::Bool(true)) {
            GuideType::Guide
        } else {
            GuideType::Wiki
        },
        pages,
    });
    (entry.into_iter().collect(), site_name)
}
