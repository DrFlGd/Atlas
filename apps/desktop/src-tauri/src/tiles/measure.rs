//! Measuring a map's picture: which tiles of one zoom of an image set exist
//! on its server, for importers whose site does not say how large a map's
//! picture is (see `ImportContext.pictureTiles` in `packages/importer-api`).
//!
//! The web app asks during an import, from its own window only, with the
//! image set's address template (a layer's `tiles.remote.urlTemplate`), a
//! zoom and a start tile, such as the one the site's page opens on. The
//! measurement goes through the downloader in `download.rs`, with its HTTP
//! client, request headers and User-Agent, the person's pace settings and
//! its activity log, and follows its answer rules:
//!
//! - The start tile is asked for first. When it is not an image, the
//!   measurement fails and nothing is kept: an "access denied" before any
//!   image is a refusal, exactly as in a download, and a start tile that is
//!   not on the server says nothing about the picture.
//! - After an image from the host, 404 or 410, or an object store's "no
//!   such object" (see `download::is_store_no_such_object`), means the tile
//!   is not on the server. Any other answer (another 401 or 403, 429, a
//!   server error, a web page, something that is not an image, a network
//!   error) ends the measurement without an answer; nothing is tried again
//!   or around it.
//! - From the start tile outwards, ring by ring, the eight neighbours of
//!   every tile that exists are asked about, never the neighbours of one that
//!   does not, and only tiles inside the world of that zoom. At most
//!   [`MAX_REQUESTS`] requests are made; when that is not enough, the answer
//!   says it is not complete.
//!
//! **What is kept.** Everything learnt is kept in a small cache in the app's
//! data folder, `<app data>/measured/<key>/`, one folder per template and
//! zoom: `source.json` says which, and `tiles/<x>/<y>` holds each image found
//! and `tiles/<x>/<y>.404` each tile that is not on the server (written with
//! the downloader's own store, so "access denied" answers are only kept once
//! an image has followed them or the measurement has ended well). A tile in
//! the cache is never asked for again, and `cachedOnly` answers from the
//! cache alone, without any request.
//!
//! **Into the pack.** Once an import is saved, [`seed_layers`] copies the
//! cached images, and writes "not on the server" markers for the cached
//! absent tiles, into every layer whose remote source has the same template
//! and a level at that zoom, at the layer's own tile numbers and only where
//! nothing is yet. "Download map images" then asks for none of them again,
//! and the images on disk prove the host (`download::Proof::OnDisk`), so its
//! first request may be one the store answers with "access denied". No level
//! is recorded as complete by this: the status files stay as they were, and
//! the next download records levels as it always does.

use std::{
    collections::{BTreeSet, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::{
    download::{
        host_of, Control, Downloader, OnOutcome, Outcome, Place, Settings, SharedPace, Stop, Task,
    },
    pyramid::{fill_template, is_allowed_remote, PackPlan},
    store::{TileStore, MISSING_SUFFIX},
};
use crate::activity::{ActivityLog, Area};

/// The most requests one measurement makes.
pub const MAX_REQUESTS: usize = 256;
/// The highest zoom a measurement may ask about (`2^30` tiles a side).
pub const MAX_ZOOM: u8 = 30;
/// The cache's folder in the app's data folder.
pub const CACHE_DIR: &str = "measured";
/// The most tiles kept of what pages showed, for one template and zoom.
pub const MAX_PAGE_TILES: usize = 65536;
const SOURCE_FILE: &str = "source.json";
const PAGE_FILE: &str = "page.json";
const PAGE_FORMAT: &str = "atlas-picture-page";
const TILES_DIR: &str = "tiles";
const SOURCE_FORMAT: &str = "atlas-picture";
const SOURCE_VERSION: u32 = 1;
/// The label of a measurement's requests in the log.
const LABEL: &str = "measuring the picture";

/// What the web app asks: see `PictureTilesRequest` in `packages/importer-api`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureRequest {
    pub url_template: String,
    pub zoom: u8,
    /// Column and row of the start tile.
    pub start: [u64; 2],
    #[serde(default)]
    pub cached_only: bool,
    /// Tiles the import's page showed, to keep (see the module documentation).
    #[serde(default)]
    pub page: Option<PageTiles>,
}

/// Tiles a page showed: see `PageTiles` in `packages/importer-api`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct PageTiles {
    pub present: Vec<[u64; 2]>,
    pub absent: Vec<[u64; 2]>,
}

impl PageTiles {
    /// Each tile once, inside a world `size` tiles a side, at most
    /// [`MAX_PAGE_TILES`] in all.
    fn is_usable(&self, size: u64) -> bool {
        let mut seen = HashSet::new();
        self.present.len() + self.absent.len() <= MAX_PAGE_TILES
            && self
                .present
                .iter()
                .chain(&self.absent)
                .all(|&[x, y]| x < size && y < size && seen.insert((x, y)))
    }
}

/// What a measurement found: see `PictureTiles` in `packages/importer-api`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub zoom: u8,
    /// The tiles that exist, as [column, row], top to bottom, then left to right.
    pub present: Vec<[u64; 2]>,
    /// Neighbours of those that are not on the server, in the same order.
    pub absent: Vec<[u64; 2]>,
    /// Every neighbour of every tile that exists is known.
    pub complete: bool,
    /// How many of `present` are known only from what a page showed.
    #[serde(skip_serializing_if = "is_zero")]
    pub from_page: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// Whether the app may ask about an image set at this template: what the
/// downloader allows (`https`, or `http` on this computer), and no user name
/// or password in the address.
pub fn is_allowed_template(template: &str) -> bool {
    if !is_allowed_remote(template) {
        return false;
    }
    let rest = template
        .strip_prefix("https://")
        .or_else(|| template.strip_prefix("http://"))
        .unwrap_or_default();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !authority.is_empty()
        && !authority.contains('@')
        && reqwest::Url::parse(&fill_template(template, 0, 0, 0)).is_ok()
}

/// The FNV-1a hash of a text: a short, stable name for a template.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Source {
    format: String,
    version: u32,
    url_template: String,
    zoom: u8,
}

/// What the cache knows about one tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Known {
    Present,
    Absent,
    Unknown,
}

/// The cache of measurements, in the app's data folder.
#[derive(Clone, Debug)]
pub struct PictureCache {
    root: PathBuf,
}

/// What pages showed of one template and zoom, as kept in `page.json`.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct PageFile {
    format: String,
    version: u32,
    present: BTreeSet<(u64, u64)>,
    absent: BTreeSet<(u64, u64)>,
}

/// The cache of one template and zoom.
struct Entry {
    store: TileStore,
    /// What pages showed (see the module documentation).
    page: PageFile,
}

impl Entry {
    fn new(dir: &Path) -> Self {
        let page = fs::read_to_string(dir.join(PAGE_FILE))
            .ok()
            .and_then(|text| serde_json::from_str::<PageFile>(&text).ok())
            .filter(|page| {
                page.format == PAGE_FORMAT
                    && page.version == SOURCE_VERSION
                    && page.present.len() + page.absent.len() <= MAX_PAGE_TILES
            })
            .unwrap_or_default();
        Self {
            store: TileStore::new(dir.join(TILES_DIR), None),
            page,
        }
    }

    fn path(x: u64, y: u64) -> PathBuf {
        PathBuf::from(x.to_string()).join(y.to_string())
    }

    fn state(&self, x: u64, y: u64) -> Known {
        let path = Self::path(x, y);
        if self.store.has_overlay_image(&path) || self.page.present.contains(&(x, y)) {
            Known::Present
        } else if self.store.is_missing(&path) || self.page.absent.contains(&(x, y)) {
            Known::Absent
        } else {
            Known::Unknown
        }
    }

    /// Whether a tile is known to be there only from what a page showed.
    fn only_from_page(&self, x: u64, y: u64) -> bool {
        self.page.present.contains(&(x, y)) && !self.store.has_overlay_image(&Self::path(x, y))
    }

    /// Every tile the cache knows, as (column, row, exists).
    fn tiles(&self) -> Vec<(u64, u64, bool)> {
        let mut tiles = Vec::new();
        let Ok(columns) = fs::read_dir(&self.store.overlay) else {
            return tiles;
        };
        for column in columns.flatten() {
            let Some(x) = column.file_name().to_str().and_then(|n| n.parse().ok()) else {
                continue;
            };
            let Ok(files) = fs::read_dir(column.path()) else {
                continue;
            };
            for file in files.flatten() {
                if !file.file_type().is_ok_and(|kind| kind.is_file()) {
                    continue;
                }
                let name = file.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                let (number, present) = match name.strip_suffix(MISSING_SUFFIX) {
                    Some(number) => (number, false),
                    None => (name, true),
                };
                if let Ok(y) = number.parse::<u64>() {
                    tiles.push((x, y, present));
                }
            }
        }
        tiles.sort_unstable();
        tiles
    }

    fn has_images(&self) -> bool {
        self.tiles().iter().any(|&(_, _, present)| present)
    }
}

impl PictureCache {
    /// The cache of the app whose data folder is `app_data`.
    pub fn new(app_data: &Path) -> Self {
        Self {
            root: app_data.join(CACHE_DIR),
        }
    }

    fn dir(&self, template: &str, zoom: u8) -> PathBuf {
        self.root.join(format!("{:016x}-{zoom}", fnv1a(template)))
    }

    fn source(template: &str, zoom: u8) -> Source {
        Source {
            format: SOURCE_FORMAT.to_owned(),
            version: SOURCE_VERSION,
            url_template: template.to_owned(),
            zoom,
        }
    }

    /// The cache of a template and zoom, when there is one for exactly them.
    fn entry(&self, template: &str, zoom: u8) -> Option<Entry> {
        let dir = self.dir(template, zoom);
        let text = fs::read_to_string(dir.join(SOURCE_FILE)).ok()?;
        let source: Source = serde_json::from_str(&text).ok()?;
        (source == Self::source(template, zoom)).then(|| Entry::new(&dir))
    }

    /// The cache of a template and zoom, made when there is none. Errs when
    /// its folder holds another one (two templates with the same hash).
    fn open(&self, template: &str, zoom: u8) -> io::Result<Entry> {
        if let Some(entry) = self.entry(template, zoom) {
            return Ok(entry);
        }
        let dir = self.dir(template, zoom);
        if dir.join(SOURCE_FILE).exists() {
            return Err(io::Error::other(format!(
                "{} holds what was learnt about another image set",
                dir.display()
            )));
        }
        fs::create_dir_all(dir.join(TILES_DIR))?;
        let json = serde_json::to_string_pretty(&Self::source(template, zoom))
            .expect("the source serialises");
        let part = dir.join(format!("{SOURCE_FILE}.part"));
        fs::write(&part, format!("{json}\n"))?;
        fs::rename(&part, dir.join(SOURCE_FILE))?;
        Ok(Entry::new(&dir))
    }

    /// Keeps what a page showed of a template and zoom with what was learnt
    /// before: tiles shown as there stay there, tiles shown as not there are
    /// kept unless a page showed them as there. Returns the cache of that
    /// template and zoom with it.
    fn remember_page(&self, template: &str, zoom: u8, page: &PageTiles) -> io::Result<Entry> {
        let mut entry = self.open(template, zoom)?;
        let mut known = PageFile {
            format: PAGE_FORMAT.to_owned(),
            version: SOURCE_VERSION,
            present: entry.page.present.clone(),
            absent: entry.page.absent.clone(),
        };
        for &[x, y] in &page.present {
            known.absent.remove(&(x, y));
            known.present.insert((x, y));
        }
        for &[x, y] in &page.absent {
            if !known.present.contains(&(x, y)) {
                known.absent.insert((x, y));
            }
        }
        if known.present.len() + known.absent.len() > MAX_PAGE_TILES {
            return Err(io::Error::other(format!(
                "pages showed more than {MAX_PAGE_TILES} tiles of it"
            )));
        }
        let dir = self.dir(template, zoom);
        let json = serde_json::to_string(&known).expect("the tiles serialise");
        let part = dir.join(format!("{PAGE_FILE}.part"));
        fs::write(&part, format!("{json}\n"))?;
        fs::rename(&part, dir.join(PAGE_FILE))?;
        entry.page = known;
        Ok(entry)
    }
}

/// The neighbours of a tile inside a world `size` tiles a side, in reading order.
fn neighbours(x: u64, y: u64, size: u64) -> impl Iterator<Item = (u64, u64)> {
    (-1i64..=1).flat_map(move |dy| {
        (-1i64..=1).filter_map(move |dx| {
            if dx == 0 && dy == 0 {
                return None;
            }
            let nx = x.checked_add_signed(dx)?;
            let ny = y.checked_add_signed(dy)?;
            (nx < size && ny < size).then_some((nx, ny))
        })
    })
}

/// "column 4, row 2 at zoom 3 of https://host/…".
fn describe(request: &MeasureRequest) -> String {
    format!(
        "{} at zoom {}, starting at column {}, row {}",
        request.url_template, request.zoom, request.start[0], request.start[1]
    )
}

/// Measures pictures, one at a time; the download manager keeps one.
#[derive(Default)]
pub struct Pictures {
    /// One measurement at a time.
    busy: tokio::sync::Mutex<()>,
    /// The control of the measurement running now, to stop it.
    current: Mutex<Option<Arc<watch::Sender<Control>>>>,
}

/// What the downloader of a measurement needs.
pub struct Fetching {
    pub client: Client,
    /// The download settings; a measurement makes one attempt per tile.
    pub settings: Settings,
    pub pace: SharedPace,
}

/// How a measurement went wrong, for the log.
struct Failed(String);

/// A tile (column, row) and what the server answered for it.
type Answer = ((u64, u64), Outcome);

impl Pictures {
    /// Stops the measurement that is running, if any: it ends without an answer.
    pub fn cancel(&self) {
        if let Some(control) = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            control.send_replace(Control::Cancel);
        }
    }

    /// Measures the picture `request` names, or answers from the cache with
    /// `cached_only` (which needs no `fetching`). None when it cannot (see
    /// the module documentation).
    pub async fn measure(
        &self,
        cache: &PictureCache,
        request: &MeasureRequest,
        log: &ActivityLog,
        fetching: Option<Fetching>,
    ) -> Option<Measured> {
        let [x, y] = request.start;
        let size = 1u64.checked_shl(u32::from(request.zoom))?;
        if request.zoom > MAX_ZOOM
            || !is_allowed_template(&request.url_template)
            || x >= size
            || y >= size
            || request
                .page
                .as_ref()
                .is_some_and(|page| !page.is_usable(size))
        {
            log.warn(
                Area::Download,
                format!(
                    "Did not measure a picture at {}: the address or the start tile cannot be used",
                    activity_text(&describe(request))
                ),
            );
            return None;
        }
        let _busy = self.busy.lock().await;
        if let Some(page) = &request.page {
            match cache.remember_page(&request.url_template, request.zoom, page) {
                Ok(_) => log.info(
                    Area::Download,
                    format!(
                        "Kept what the import's page showed of the picture at {} at zoom {}: {} tiles there, {} not there. They count as known from now on, without a request; no image of them is kept",
                        request.url_template,
                        request.zoom,
                        page.present.len(),
                        page.absent.len()
                    ),
                ),
                Err(error) => log.warn(
                    Area::Download,
                    format!(
                        "Could not keep what the import's page showed of the picture at {} at zoom {}: {error}",
                        request.url_template, request.zoom
                    ),
                ),
            }
        }
        if request.cached_only {
            let Some(entry) = cache.entry(&request.url_template, request.zoom) else {
                log.info(
                    Area::Download,
                    format!(
                        "Nothing is known yet about the picture at {}, so it was not measured (only what was learnt before was asked for)",
                        describe(request)
                    ),
                );
                return None;
            };
            let answer = flood(&entry, request, None).await;
            match &answer {
                Ok(measured) => log.info(
                    Area::Download,
                    format!(
                        "The picture at {} from what was learnt before: {}",
                        describe(request),
                        summary(measured)
                    ),
                ),
                Err(Failed(reason)) => log.info(
                    Area::Download,
                    format!(
                        "The picture at {} is not known from what was learnt before: {reason}",
                        describe(request)
                    ),
                ),
            }
            return answer.ok();
        }
        let fetching = fetching?;

        let entry = match cache.open(&request.url_template, request.zoom) {
            Ok(entry) => entry,
            Err(error) => {
                log.warn(
                    Area::Download,
                    format!(
                        "Could not measure the picture at {}: {error}",
                        describe(request)
                    ),
                );
                return None;
            }
        };
        let (control, receiver) = watch::channel(Control::Run);
        let control = Arc::new(control);
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&control));
        let pace = *fetching.pace.lock().unwrap_or_else(PoisonError::into_inner);
        log.info(
            Area::Download,
            format!(
                "Measuring the picture at {}: asking which tiles exist, from there outwards, at most {MAX_REQUESTS} requests | settings: {}",
                describe(request),
                pace.describe()
            ),
        );
        let downloader = Arc::new(
            Downloader::new(
                fetching.client,
                Settings {
                    max_attempts: 1,
                    ..fetching.settings
                },
                entry.store.clone(),
                receiver,
            )
            .with_pace(fetching.pace)
            .with_log(log.clone()),
        );
        let answer = flood(&entry, request, Some((&downloader, &control))).await;
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = None;
        match &answer {
            Ok(measured) => log.info(
                Area::Download,
                format!(
                    "Measured the picture at {}: {}",
                    describe(request),
                    summary(measured)
                ),
            ),
            Err(Failed(reason)) => log.warn(
                Area::Download,
                format!(
                    "Could not measure the picture at {}: {reason}. The importer sizes the map without it",
                    describe(request)
                ),
            ),
        }
        answer.ok()
    }
}

/// The text of a request for a warning about an unusable one: cleaned and short.
fn activity_text(text: &str) -> String {
    crate::activity::clean(text).chars().take(300).collect()
}

/// What a measurement found, in words.
fn summary(measured: &Measured) -> String {
    let columns = measured.present.iter().map(|[x, _]| *x);
    let rows = measured.present.iter().map(|[_, y]| *y);
    format!(
        "{} tiles exist (columns {}-{}, rows {}-{}{}), {} next to them are not on the server{}",
        measured.present.len(),
        columns.clone().min().unwrap_or(0),
        columns.max().unwrap_or(0),
        rows.clone().min().unwrap_or(0),
        rows.max().unwrap_or(0),
        if measured.from_page > 0 {
            format!("; {} of them known only from a page", measured.from_page)
        } else {
            String::new()
        },
        measured.absent.len(),
        if measured.complete {
            ""
        } else {
            "; not every tile next to them is known, so the picture may reach further"
        }
    )
}

/// The flood from the start tile. With a downloader, tiles the cache does
/// not know are asked for; without one, they are left unknown.
async fn flood(
    entry: &Entry,
    request: &MeasureRequest,
    fetch: Option<(&Arc<Downloader>, &Arc<watch::Sender<Control>>)>,
) -> Result<Measured, Failed> {
    let size = 1u64 << request.zoom;
    let start = (request.start[0], request.start[1]);
    // Every tile a page showed as there is a starting point too.
    let seeds: Vec<(u64, u64)> = entry
        .page
        .present
        .iter()
        .copied()
        .filter(|&(x, y)| x < size && y < size)
        .collect();
    let mut asked_start = false;
    let mut start_there = false;
    match entry.state(start.0, start.1) {
        Known::Present => start_there = true,
        Known::Absent if !seeds.is_empty() => {}
        Known::Absent => {
            return Err(Failed(
                "the start tile is not on the server, as was learnt before".to_owned(),
            ))
        }
        Known::Unknown if fetch.is_none() && !seeds.is_empty() => {}
        Known::Unknown => {
            let Some((downloader, control)) = fetch else {
                return Err(Failed("the start tile was never asked for".to_owned()));
            };
            if entry.has_images() {
                // Images of this set came from the host before: its store's
                // "access denied" counts as "not on the server".
                downloader.prove_from_disk(
                    0,
                    host_of(&fill_template(
                        &request.url_template,
                        u64::from(request.zoom),
                        start.0,
                        start.1,
                    )),
                );
            }
            asked_start = true;
            let outcomes = ask(downloader, control, request, &[start]).await;
            let saved = matches!(outcomes.as_deref(), Ok([(_, Outcome::Saved(_))]));
            if !saved {
                // Nothing is kept of a start tile that is not an image.
                let marker = entry.store.overlay.join(Entry::path(start.0, start.1));
                let mut name = marker.into_os_string();
                name.push(MISSING_SUFFIX);
                let _ = fs::remove_file(PathBuf::from(name));
            }
            match outcomes {
                Err(failed) => return Err(failed),
                Ok(_) if !saved => {
                    return Err(Failed(
                        "the start tile is not an image on the server".to_owned(),
                    ))
                }
                Ok(_) => start_there = true,
            }
        }
    }

    let mut present = BTreeSet::new();
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut first = Vec::new();
    for tile in start_there.then_some(start).into_iter().chain(seeds) {
        if seen.insert(tile) {
            present.insert((tile.1, tile.0));
            first.push(tile);
        }
    }
    let mut absent = BTreeSet::new();
    let mut complete = true;
    let mut requests = usize::from(asked_start);
    let mut round: Vec<(u64, u64)> = Vec::new();
    for (x, y) in first {
        round.extend(neighbours(x, y, size).filter(|tile| seen.insert(*tile)));
    }
    while !round.is_empty() {
        let mut found = Vec::new();
        let mut unknown = Vec::new();
        for (x, y) in round {
            match entry.state(x, y) {
                Known::Present => found.push((x, y)),
                Known::Absent => {
                    absent.insert((y, x));
                }
                Known::Unknown => unknown.push((x, y)),
            }
        }
        if !unknown.is_empty() {
            match fetch {
                None => complete = false,
                Some((downloader, control)) => {
                    let budget = MAX_REQUESTS.saturating_sub(requests);
                    if unknown.len() > budget {
                        complete = false;
                        unknown.truncate(budget);
                    }
                    if !unknown.is_empty() {
                        requests += unknown.len();
                        for ((x, y), outcome) in ask(downloader, control, request, &unknown).await?
                        {
                            match outcome {
                                Outcome::Saved(_) => found.push((x, y)),
                                Outcome::Missing | Outcome::MissingDenied | Outcome::NotAsked => {
                                    absent.insert((y, x));
                                }
                                Outcome::Skipped => match entry.state(x, y) {
                                    Known::Present => found.push((x, y)),
                                    Known::Absent => {
                                        absent.insert((y, x));
                                    }
                                    Known::Unknown => complete = false,
                                },
                                Outcome::Failed(reason) => return Err(Failed(reason)),
                            }
                        }
                    }
                }
            }
        }
        // The next ring: the neighbours of what exists, in reading order.
        found.sort_unstable_by_key(|&(x, y)| (y, x));
        let mut next = Vec::new();
        for (x, y) in found {
            present.insert((y, x));
            next.extend(neighbours(x, y, size).filter(|tile| seen.insert(*tile)));
        }
        round = next;
    }
    if let Some((downloader, _)) = fetch {
        // It ended well: the store's denials since the last image were
        // tiles that do not exist.
        downloader
            .commit_pending()
            .map_err(|stop| Failed(stop_reason(&stop)))?;
    }
    let from_page = present
        .iter()
        .filter(|&&(y, x)| entry.only_from_page(x, y))
        .count();
    Ok(Measured {
        zoom: request.zoom,
        present: present.into_iter().map(|(y, x)| [x, y]).collect(),
        absent: absent.into_iter().map(|(y, x)| [x, y]).collect(),
        complete,
        from_page,
    })
}

/// Why the downloader stopped, in words that fit a measurement.
fn stop_reason(stop: &Stop) -> String {
    match stop {
        Stop::Cancelled => "it was stopped".to_owned(),
        Stop::Refused(status) => format!("the server refused access (HTTP {status})"),
        Stop::WebPage => "the server sent a web page instead of an image".to_owned(),
        Stop::TooManyFailures(count) => format!("{count} requests in a row failed"),
        Stop::DeniedInARow(count) => format!(
            "the server answered \"access denied\" {count} times in a row after it had sent images"
        ),
        Stop::Disk(error) => format!("what was learnt could not be saved: {error}"),
    }
}

/// Asks the server for `tiles` with the measurement's downloader. Any
/// answer that is neither an image nor "not on the server" stops it at once.
async fn ask(
    downloader: &Arc<Downloader>,
    control: &Arc<watch::Sender<Control>>,
    request: &MeasureRequest,
    tiles: &[(u64, u64)],
) -> Result<Vec<Answer>, Failed> {
    let size = 1u64 << request.zoom;
    let label: Arc<str> = Arc::from(LABEL);
    let tasks: Vec<Task> = tiles
        .iter()
        .map(|&(x, y)| Task {
            layer: 0,
            url: fill_template(&request.url_template, u64::from(request.zoom), x, y),
            path: Entry::path(x, y),
            label: Some(Arc::clone(&label)),
            place: Some(Place {
                z: request.zoom,
                source_z: request.zoom,
                x,
                y,
                columns: size,
                rows: size,
            }),
            parent: None,
        })
        .collect();
    let outcomes: Arc<Mutex<Vec<Answer>>> = Arc::default();
    let failure: Arc<Mutex<Option<String>>> = Arc::default();
    let on_outcome: OnOutcome = {
        let outcomes = Arc::clone(&outcomes);
        let failure = Arc::clone(&failure);
        let control = Arc::clone(control);
        Arc::new(move |task: &Task, outcome: &Outcome| {
            let place = task.place.expect("every task has its place");
            if let Outcome::Failed(reason) = outcome {
                failure
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get_or_insert_with(|| format!("{reason} for {}", task.url));
                // Not an image and not "not on the server": stop at once.
                control.send_replace(Control::Cancel);
            }
            outcomes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(((place.x, place.y), outcome.clone()));
        })
    };
    let result = downloader.run(Arc::new(tasks), on_outcome).await;
    if let Some(reason) = failure
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    {
        return Err(Failed(reason));
    }
    result.map_err(|stop| Failed(stop_reason(&stop)))?;
    let outcomes = std::mem::take(&mut *outcomes.lock().unwrap_or_else(PoisonError::into_inner));
    Ok(outcomes)
}

/// What [`seed_layers`] put into one layer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Seeded {
    pub layer_id: String,
    /// Images copied from the cache.
    pub images: u64,
    /// "Not on the server" markers written.
    pub markers: u64,
}

/// Puts what the cache knows into the layers of `plan` whose images live
/// in `root` (with `bundled`, the read-only pack folder, consulted as the
/// downloader does): for each layer whose remote source has a cached
/// template and a level at a cached zoom, every cached image and "not on
/// the server" marker that falls inside that level, at the layer's own
/// tile number, where no image or marker is yet. Returns the layers that
/// got anything; a file that cannot be written is left for the download.
pub fn seed_layers(
    cache: &PictureCache,
    root: &Path,
    bundled: Option<&Path>,
    plan: &PackPlan,
) -> Result<Vec<Seeded>, String> {
    let store = TileStore::new(root.to_path_buf(), bundled.map(Path::to_path_buf));
    let mut seeded = Vec::new();
    for layer in &plan.layers {
        let mut done = Seeded {
            layer_id: layer.layer_id.clone(),
            ..Seeded::default()
        };
        for level in &layer.levels {
            let Some(entry) = cache.entry(&layer.url_template, level.source_z) else {
                continue;
            };
            let grid = layer.grid(level.z);
            for (x, y, present) in entry.tiles() {
                let (Some(lx), Some(ly)) =
                    (x.checked_sub(level.offset_x), y.checked_sub(level.offset_y))
                else {
                    continue;
                };
                if lx >= grid.columns || ly >= grid.rows {
                    continue;
                }
                let path = layer.tile_path(level.z, lx, ly);
                if store.is_done(&path) {
                    continue;
                }
                let fail =
                    |error: io::Error| format!("{}: {error}", store.overlay.join(&path).display());
                if present {
                    let Some(bytes) = entry.store.read(&Entry::path(x, y)) else {
                        continue;
                    };
                    store.write(&path, &bytes).map_err(fail)?;
                    done.images += 1;
                } else {
                    store.mark_missing(&path).map_err(fail)?;
                    done.markers += 1;
                }
            }
        }
        if done.images + done.markers > 0 {
            seeded.push(done);
        }
    }
    Ok(seeded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::{
        download::{
            http_client,
            tests::{ensure_crypto, no_such_object, png, MockServer, Reply},
            Pace,
        },
        pyramid::read_pack_plan,
        store::tests::TempDir,
    };
    use std::{collections::BTreeSet, time::Duration};

    /// The column, row and zoom of a request to `/p/<z>/<x>/<y>.png`.
    fn tile_of(path: &str) -> (u8, u64, u64) {
        let parts: Vec<u64> = path
            .trim_end_matches(".png")
            .rsplit('/')
            .take(3)
            .map(|n| n.parse().unwrap())
            .collect();
        (parts[2] as u8, parts[1], parts[0])
    }

    /// A server whose picture is `tiles` at zoom `zoom`. Every other tile
    /// gets `outside`, unless `special` answers first.
    async fn picture_server(
        zoom: u8,
        tiles: BTreeSet<(u64, u64)>,
        outside: fn() -> Reply,
        special: fn(u64, u64) -> Option<Reply>,
    ) -> MockServer {
        let image = png();
        MockServer::start(Arc::new(move |path, _| {
            let (z, x, y) = tile_of(path);
            if let Some(reply) = special(x, y) {
                return reply;
            }
            if z == zoom && tiles.contains(&(x, y)) {
                Reply::image(image.clone())
            } else {
                outside()
            }
        }))
        .await
    }

    fn not_found() -> Reply {
        Reply::status(404)
    }

    fn nothing_special(_: u64, _: u64) -> Option<Reply> {
        None
    }

    struct Setup {
        dir: TempDir,
        cache: PictureCache,
        pictures: Pictures,
        log: ActivityLog,
    }

    impl Setup {
        fn new(name: &str) -> Self {
            let dir = TempDir::new(&format!("measure-{name}"));
            Self {
                cache: PictureCache::new(&dir.0.join("data")),
                pictures: Pictures::default(),
                log: ActivityLog::new(dir.0.join("logs"), "Atlas", "0.4.0"),
                dir,
            }
        }

        fn fetching() -> Fetching {
            let settings = Settings {
                delay: Duration::from_millis(1),
                timeout: Duration::from_secs(5),
                ..Settings::default()
            };
            Fetching {
                client: http_client().unwrap(),
                pace: Arc::new(Mutex::new(Pace {
                    concurrency: settings.concurrency,
                    delay: settings.delay,
                    requests_per_minute: None,
                    bytes_per_second: None,
                })),
                settings,
            }
        }

        async fn measure(&self, request: &MeasureRequest) -> Option<Measured> {
            self.pictures
                .measure(&self.cache, request, &self.log, Some(Self::fetching()))
                .await
        }

        async fn cached_answer(&self, request: &MeasureRequest) -> Option<Measured> {
            let request = MeasureRequest {
                cached_only: true,
                ..request.clone()
            };
            self.pictures
                .measure(&self.cache, &request, &self.log, None)
                .await
        }

        fn logged(&self) -> String {
            fs::read_to_string(self.dir.0.join("logs").join(crate::activity::LOG_FILE))
                .unwrap_or_default()
        }

        /// The files of the cache, as "x/y" and "x/y.404".
        fn cached(&self, request: &MeasureRequest) -> Vec<String> {
            let Some(entry) = self.cache.entry(&request.url_template, request.zoom) else {
                return Vec::new();
            };
            entry
                .tiles()
                .into_iter()
                .map(|(x, y, present)| format!("{x}/{y}{}", if present { "" } else { ".404" }))
                .collect()
        }
    }

    fn request(server: &MockServer, zoom: u8, start: [u64; 2]) -> MeasureRequest {
        MeasureRequest {
            url_template: server.url("/p/{z}/{x}/{y}.png"),
            zoom,
            start,
            cached_only: false,
            page: None,
        }
    }

    fn asked(server: &MockServer) -> Vec<(u64, u64)> {
        server
            .seen()
            .into_iter()
            .map(|seen| {
                let (_, x, y) = tile_of(&seen.path);
                (x, y)
            })
            .collect()
    }

    fn distinct(tiles: &[(u64, u64)]) -> bool {
        tiles.iter().collect::<HashSet<_>>().len() == tiles.len()
    }

    fn pairs(tiles: &[[u64; 2]]) -> BTreeSet<(u64, u64)> {
        tiles.iter().map(|&[x, y]| (x, y)).collect()
    }

    /// The frame of the box 3-7 x 3-7 (its middle is empty) and one tile
    /// that only touches its corner: an island with a lagoon.
    fn lagoon() -> BTreeSet<(u64, u64)> {
        let mut tiles: BTreeSet<(u64, u64)> = (3..=7)
            .flat_map(|x| (3..=7).map(move |y| (x, y)))
            .filter(|&(x, y)| !(4..=6).contains(&x) || !(4..=6).contains(&y))
            .collect();
        tiles.insert((8, 8));
        tiles
    }

    /// Every tile next to one of `tiles` (inside a world `size` a side) that
    /// is not one of them.
    fn around(tiles: &BTreeSet<(u64, u64)>, size: u64) -> BTreeSet<(u64, u64)> {
        tiles
            .iter()
            .flat_map(|&(x, y)| neighbours(x, y, size))
            .filter(|tile| !tiles.contains(tile))
            .collect()
    }

    #[test]
    fn takes_only_addresses_the_downloader_may_use() {
        assert!(is_allowed_template("https://tiles.example/{z}/{x}/{y}.png"));
        assert!(is_allowed_template("https://tiles.example/{z}/{y}/{x}.jpg"));
        assert!(is_allowed_template("http://127.0.0.1:4000/{z}/{x}/{y}.png"));
        assert!(!is_allowed_template("http://tiles.example/{z}/{x}/{y}.png"));
        assert!(!is_allowed_template("https://tiles.example/{z}/{x}.png"));
        assert!(!is_allowed_template(
            "https://me:secret@tiles.example/{z}/{x}/{y}.png"
        ));
        assert!(!is_allowed_template("file:///{z}/{x}/{y}.png"));
        assert!(!is_allowed_template("https:///{z}/{x}/{y}.png"));
    }

    #[test]
    fn neighbours_stay_inside_the_world() {
        assert_eq!(
            neighbours(0, 0, 4).collect::<Vec<_>>(),
            [(1, 0), (0, 1), (1, 1)]
        );
        assert_eq!(neighbours(3, 1, 4).count(), 5);
        assert_eq!(neighbours(1, 1, 4).count(), 8);
        assert_eq!(neighbours(0, 0, 1).count(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn floods_a_picture_whose_middle_is_empty() {
        ensure_crypto();
        let setup = Setup::new("lagoon");
        // Tiles that do not exist answer like an object store, which counts
        // once the start tile has come back as an image.
        let server = picture_server(4, lagoon(), no_such_object, nothing_special).await;
        let request = request(&server, 4, [3, 3]);
        let measured = setup.measure(&request).await.expect("measured");

        assert_eq!(pairs(&measured.present), lagoon());
        assert_eq!(pairs(&measured.absent), around(&lagoon(), 16));
        // The edge of the lagoon is known not to be there. Its centre is
        // next to no tile of the picture, so it is never asked about.
        assert!(pairs(&measured.absent).contains(&(4, 4)));
        assert!(!pairs(&measured.absent).contains(&(5, 5)));
        assert!(measured.complete);
        assert_eq!(measured.zoom, 4);
        // Top to bottom, then left to right.
        assert_eq!(measured.present[..3], [[3, 3], [4, 3], [5, 3]]);

        let asked = asked(&server);
        assert!(distinct(&asked), "nothing asked for twice: {asked:?}");
        assert_eq!(asked.len(), lagoon().len() + around(&lagoon(), 16).len());
        assert_eq!(asked[0], (3, 3), "the start tile first");
        // The neighbours of tiles that do not exist are never asked about.
        assert!(!asked.contains(&(1, 1)) && !asked.contains(&(5, 5)));

        // Everything is kept, the store's denials too.
        let cached = setup.cached(&request);
        assert!(cached.contains(&"3/3".to_owned()) && cached.contains(&"4/4.404".to_owned()));
        assert_eq!(cached.len(), asked.len());
        let log = setup.logged();
        assert!(
            log.contains("Measuring the picture at http://127.0.0.1"),
            "{log}"
        );
        assert!(
            log.contains("Measured the picture at")
                && log.contains("17 tiles exist (columns 3-8, rows 3-8)"),
            "{log}"
        );

        // Measured again, nothing is asked: the cache knows it all.
        assert_eq!(setup.measure(&request).await, Some(measured.clone()));
        assert_eq!(server.seen().len(), asked.len());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_picture_at_the_edge_of_the_world_asks_nothing_outside_it() {
        ensure_crypto();
        let setup = Setup::new("edge");
        // The left half of zoom 2 (4 x 4 tiles).
        let half: BTreeSet<(u64, u64)> = (0..2).flat_map(|x| (0..4).map(move |y| (x, y))).collect();
        let server = picture_server(2, half.clone(), not_found, nothing_special).await;
        let measured = setup.measure(&request(&server, 2, [0, 0])).await.unwrap();
        assert_eq!(pairs(&measured.present), half);
        assert_eq!(
            pairs(&measured.absent),
            (0..4).map(|y| (2, y)).collect::<BTreeSet<_>>()
        );
        assert!(measured.complete);
        let asked = asked(&server);
        assert_eq!(asked.len(), 12);
        assert!(asked.iter().all(|&(x, y)| x < 4 && y < 4));

        // Zoom 0 is one tile: nothing around it.
        let whole = picture_server(0, BTreeSet::from([(0, 0)]), not_found, nothing_special).await;
        let measured = setup.measure(&request(&whole, 0, [0, 0])).await.unwrap();
        assert_eq!((measured.present, measured.absent), (vec![[0, 0]], vec![]));
        assert!(measured.complete);
        assert_eq!(whole.seen().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_start_tile_that_is_not_an_image_gives_no_answer_and_keeps_nothing() {
        ensure_crypto();
        for (name, reply) in [
            ("denied", no_such_object as fn() -> Reply),
            ("refused", || Reply::status(403)),
            ("absent", not_found),
            ("page", || {
                Reply {
                    body: b"<html>check</html>".to_vec(),
                    ..Reply::status(200)
                }
                .header("Content-Type", "text/html")
            }),
        ] {
            let setup = Setup::new(&format!("start-{name}"));
            let server = MockServer::start(Arc::new(move |_, _| reply())).await;
            let request = request(&server, 4, [3, 3]);
            assert_eq!(setup.measure(&request).await, None, "{name}");
            assert_eq!(
                server.seen().len(),
                1,
                "{name}: only the start tile is asked for"
            );
            assert_eq!(setup.cached(&request), Vec::<String>::new(), "{name}");
            assert!(
                setup.logged().contains("Could not measure the picture at"),
                "{name}"
            );
            // Nothing was kept, so the cache cannot answer either.
            assert_eq!(setup.cached_answer(&request).await, None, "{name}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unexpected_answer_on_the_way_gives_no_answer_and_is_not_tried_again() {
        ensure_crypto();
        // The picture is 3-7 x 3-7; the tile right of the start answers
        // something that is neither an image nor "not on the server".
        let square: BTreeSet<(u64, u64)> =
            (3..=7).flat_map(|x| (3..=7).map(move |y| (x, y))).collect();
        for (name, special) in [
            (
                "server error",
                (|x, y| ((x, y) == (6, 5)).then(|| Reply::status(500)))
                    as fn(u64, u64) -> Option<Reply>,
            ),
            ("slow down", |x, y| {
                ((x, y) == (6, 5)).then(|| Reply::status(429).header("Retry-After", "1"))
            }),
            ("refused", |x, y| {
                ((x, y) == (6, 5)).then(|| Reply::status(401))
            }),
            ("not a store's denial", |x, y| {
                ((x, y) == (6, 5)).then(|| Reply::status(403))
            }),
            ("web page", |x, y| {
                ((x, y) == (6, 5)).then(|| {
                    Reply {
                        body: b"<!doctype html><p>Are you a robot?</p>".to_vec(),
                        ..Reply::status(200)
                    }
                    .header("Content-Type", "text/html")
                })
            }),
            ("not an image", |x, y| {
                ((x, y) == (6, 5)).then(|| {
                    Reply {
                        body: b"{}".to_vec(),
                        ..Reply::status(200)
                    }
                    .header("Content-Type", "application/json")
                })
            }),
        ] {
            let setup = Setup::new(&format!("midway-{}", name.replace(' ', "-")));
            let server = picture_server(4, square.clone(), not_found, special).await;
            let request = request(&server, 4, [5, 5]);
            assert_eq!(setup.measure(&request).await, None, "{name}");
            let asked = asked(&server);
            assert_eq!(
                asked.iter().filter(|tile| **tile == (6, 5)).count(),
                1,
                "{name}: not tried again"
            );
            // Nothing beyond the first ring.
            assert!(
                asked
                    .iter()
                    .all(|&(x, y)| x.abs_diff(5) <= 1 && y.abs_diff(5) <= 1),
                "{name}: {asked:?}"
            );
            assert!(
                !setup.cached(&request).contains(&"6/5".to_owned()),
                "{name}"
            );
            let log = setup.logged();
            assert!(
                log.contains("Could not measure the picture at"),
                "{name}: {log}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stops_at_the_request_cap_and_says_the_answer_is_not_complete() {
        ensure_crypto();
        let setup = Setup::new("cap");
        // All of zoom 5 (32 x 32 tiles) is picture.
        let world: BTreeSet<(u64, u64)> =
            (0..32).flat_map(|x| (0..32).map(move |y| (x, y))).collect();
        let server = picture_server(5, world, not_found, nothing_special).await;
        let request = request(&server, 5, [16, 16]);
        let measured = setup.measure(&request).await.unwrap();
        assert!(!measured.complete);
        assert_eq!(server.seen().len(), MAX_REQUESTS);
        assert_eq!(measured.present.len(), MAX_REQUESTS);
        assert!(measured.absent.is_empty());
        assert!(setup
            .logged()
            .contains("not every tile next to them is known"));

        // From the cache: the same, without a request.
        assert_eq!(setup.cached_answer(&request).await, Some(measured.clone()));
        assert_eq!(server.seen().len(), MAX_REQUESTS);

        // Measured again, it goes on from what it knows and asks nothing twice.
        let more = setup.measure(&request).await.unwrap();
        assert!(more.present.len() > measured.present.len());
        let asked = asked(&server);
        assert!(asked.len() <= 2 * MAX_REQUESTS);
        assert!(distinct(&asked));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cached_only_answers_from_what_was_learnt_without_a_request() {
        ensure_crypto();
        let setup = Setup::new("cached");
        let server = picture_server(4, lagoon(), not_found, nothing_special).await;
        let fresh = request(&server, 4, [3, 3]);

        // Nothing learnt yet: no answer, and no request.
        assert_eq!(setup.cached_answer(&fresh).await, None);
        assert!(server.seen().is_empty());
        assert!(setup
            .logged()
            .contains("Nothing is known yet about the picture at"));

        let measured = setup.measure(&fresh).await.unwrap();
        let count = server.seen().len();
        assert_eq!(setup.cached_answer(&fresh).await, Some(measured.clone()));
        // Any tile of the picture leads to the same answer.
        let elsewhere = MeasureRequest {
            start: [8, 8],
            ..fresh.clone()
        };
        assert_eq!(setup.cached_answer(&elsewhere).await, Some(measured));
        // A start tile known not to be there, or never asked about, gives none.
        for start in [[5, 5], [12, 12]] {
            let request = MeasureRequest {
                start,
                ..fresh.clone()
            };
            assert_eq!(setup.cached_answer(&request).await, None);
        }
        // Another zoom of the same images is another cache.
        assert_eq!(
            setup
                .cached_answer(&MeasureRequest {
                    zoom: 5,
                    ..fresh.clone()
                })
                .await,
            None
        );
        assert_eq!(server.seen().len(), count);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_requests_it_cannot_use_without_asking() {
        ensure_crypto();
        let setup = Setup::new("unusable");
        let server = picture_server(4, lagoon(), not_found, nothing_special).await;
        let good = request(&server, 4, [3, 3]);
        for bad in [
            MeasureRequest {
                start: [16, 3],
                ..good.clone()
            },
            MeasureRequest {
                zoom: MAX_ZOOM + 1,
                ..good.clone()
            },
            MeasureRequest {
                zoom: 64,
                ..good.clone()
            },
            MeasureRequest {
                url_template: "http://tiles.example/{z}/{x}/{y}.png".to_owned(),
                ..good.clone()
            },
            MeasureRequest {
                url_template: server.url("/p/{z}/{x}.png"),
                ..good.clone()
            },
        ] {
            assert_eq!(setup.measure(&bad).await, None, "{bad:?}");
        }
        assert!(server.seen().is_empty());
        assert!(setup.logged().contains("Did not measure a picture at"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_measurement_can_be_stopped() {
        ensure_crypto();
        let setup = Arc::new(Setup::new("stop"));
        let image = png();
        let server = MockServer::start(Arc::new(move |_, _| {
            Reply::image(image.clone()).delayed(Duration::from_millis(200))
        }))
        .await;
        let request = request(&server, 4, [3, 3]);
        let running = {
            let setup = Arc::clone(&setup);
            let request = request.clone();
            tokio::spawn(async move { setup.measure(&request).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        setup.pictures.cancel();
        assert_eq!(running.await.unwrap(), None);
        assert!(server.seen().len() < 9);
        assert!(setup.logged().contains("it was stopped"));
    }

    /// The tiles of the box `x0..=x1` x `y0..=y1`.
    fn square(x0: u64, x1: u64, y0: u64, y1: u64) -> BTreeSet<(u64, u64)> {
        (x0..=x1)
            .flat_map(|x| (y0..=y1).map(move |y| (x, y)))
            .collect()
    }

    fn listed(tiles: &BTreeSet<(u64, u64)>) -> Vec<[u64; 2]> {
        tiles.iter().map(|&(x, y)| [x, y]).collect()
    }

    fn with_page(
        request: &MeasureRequest,
        present: &BTreeSet<(u64, u64)>,
        absent: &BTreeSet<(u64, u64)>,
    ) -> MeasureRequest {
        MeasureRequest {
            cached_only: true,
            page: Some(PageTiles {
                present: listed(present),
                absent: listed(absent),
            }),
            ..request.clone()
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn keeps_what_a_page_showed_and_answers_from_it_without_a_request() {
        ensure_crypto();
        let setup = Setup::new("page");
        // A store that refuses every request of the app's own.
        let server = MockServer::start(Arc::new(|_, _| Reply::status(403))).await;
        let fresh = request(&server, 4, [5, 5]);
        let picture = square(3, 7, 3, 7);
        let around = around(&picture, 16);

        // The page showed the whole picture and everything around it.
        let answer = setup
            .pictures
            .measure(
                &setup.cache,
                &with_page(&fresh, &picture, &around),
                &setup.log,
                None,
            )
            .await
            .expect("an answer from what the page showed");
        assert_eq!(pairs(&answer.present), picture);
        assert_eq!(pairs(&answer.absent), around);
        assert!(answer.complete);
        assert_eq!(answer.from_page, picture.len());
        assert!(server.seen().is_empty(), "no request at all");
        let json = serde_json::to_value(&answer).unwrap();
        assert_eq!(json["fromPage"], picture.len());
        assert!(setup
            .logged()
            .contains("Kept what the import's page showed of the picture at"));
        assert!(setup.logged().contains("25 of them known only from a page"));

        // Later answers know it too, without the page: from the cache, from a
        // start tile nothing is known about, and when the server is asked.
        assert_eq!(setup.cached_answer(&fresh).await, Some(answer.clone()));
        let elsewhere = MeasureRequest {
            start: [12, 12],
            ..fresh.clone()
        };
        assert_eq!(setup.cached_answer(&elsewhere).await, Some(answer.clone()));
        let outside = MeasureRequest {
            start: [2, 2],
            ..fresh.clone()
        };
        assert_eq!(setup.cached_answer(&outside).await, Some(answer.clone()));
        assert_eq!(setup.measure(&fresh).await, Some(answer.clone()));
        assert!(server.seen().is_empty(), "every tile around it is known");

        // Nothing of it goes into a pack: no image of it is kept.
        assert!(setup.cached(&fresh).is_empty());
        let file = setup.cache.dir(&fresh.url_template, 4).join(PAGE_FILE);
        assert!(file.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_that_did_not_show_everything_gives_an_answer_that_is_not_complete() {
        ensure_crypto();
        let setup = Setup::new("page-part");
        let server = MockServer::start(Arc::new(|_, _| Reply::status(403))).await;
        let fresh = request(&server, 4, [5, 5]);
        // The page's window showed columns 3-7, rows 3-5 of a taller picture,
        // and only what lies above and beside that.
        let seen = square(3, 7, 3, 5);
        let above: BTreeSet<(u64, u64)> = around(&seen, 16)
            .into_iter()
            .filter(|&(_, y)| y <= 5)
            .collect();
        let answer = setup
            .pictures
            .measure(
                &setup.cache,
                &with_page(&fresh, &seen, &above),
                &setup.log,
                None,
            )
            .await
            .unwrap();
        assert_eq!(pairs(&answer.present), seen);
        assert!(!answer.complete);

        // A later page shows the rest: the two are joined, and a tile once
        // shown as there stays so even when a page says otherwise.
        let rest = square(3, 7, 6, 7);
        let mut below = around(&square(3, 7, 3, 7), 16);
        below.insert((5, 5));
        let answer = setup
            .pictures
            .measure(
                &setup.cache,
                &with_page(&fresh, &rest, &below),
                &setup.log,
                None,
            )
            .await
            .unwrap();
        assert_eq!(pairs(&answer.present), square(3, 7, 3, 7));
        assert!(answer.complete);
        assert!(!pairs(&answer.absent).contains(&(5, 5)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_server_is_asked_only_about_what_no_page_showed() {
        ensure_crypto();
        let setup = Setup::new("page-and-server");
        // The server has the picture 3-8 x 3-7, and answers.
        let picture = square(3, 8, 3, 7);
        let server = picture_server(4, picture.clone(), not_found, nothing_special).await;
        let fresh = request(&server, 4, [5, 5]);
        // The page showed columns 3-7 and what is around them, but not column 8.
        let shown = square(3, 7, 3, 7);
        let around_shown: BTreeSet<(u64, u64)> = around(&shown, 16)
            .into_iter()
            .filter(|&(x, _)| x < 8)
            .collect();
        setup
            .pictures
            .measure(
                &setup.cache,
                &with_page(&fresh, &shown, &around_shown),
                &setup.log,
                None,
            )
            .await
            .unwrap();
        let measured = setup.measure(&fresh).await.unwrap();
        assert_eq!(pairs(&measured.present), picture);
        assert!(measured.complete);
        assert_eq!(measured.from_page, shown.len());
        let asked = asked(&server);
        assert!(
            asked
                .iter()
                .all(|tile| !shown.contains(tile) && !around_shown.contains(tile)),
            "{asked:?}"
        );
        assert!(asked.contains(&(8, 5)));
        // Images found by asking are kept as before; the page's are not.
        assert!(setup.cached(&fresh).contains(&"8/5".to_owned()));
        assert!(!setup.cached(&fresh).contains(&"5/5".to_owned()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_page_tiles_it_cannot_use() {
        ensure_crypto();
        let setup = Setup::new("page-bad");
        let server = MockServer::start(Arc::new(|_, _| Reply::status(404))).await;
        let fresh = request(&server, 2, [1, 1]);
        for (present, absent) in [
            (vec![[4, 1]], vec![]),
            (vec![[1, 1]], vec![[1, 1]]),
            (vec![[1, 1], [1, 1]], vec![]),
        ] {
            let bad = MeasureRequest {
                cached_only: true,
                page: Some(PageTiles { present, absent }),
                ..fresh.clone()
            };
            assert_eq!(
                setup
                    .pictures
                    .measure(&setup.cache, &bad, &setup.log, None)
                    .await,
                None
            );
        }
        assert!(!setup.cache.dir(&fresh.url_template, 2).exists());
        assert!(setup.logged().contains("Did not measure a picture at"));
    }

    #[test]
    fn an_image_on_disk_wins_over_a_page() {
        let dir = TempDir::new("measure-page-disk");
        let cache = PictureCache::new(&dir.0.join("data"));
        let template = "https://tiles.example/{z}/{x}/{y}.png";
        let entry = cache.open(template, 3).unwrap();
        entry.store.write(&Entry::path(2, 2), b"cached").unwrap();
        let entry = cache
            .remember_page(
                template,
                3,
                &PageTiles {
                    present: vec![[1, 1]],
                    absent: vec![[2, 2], [3, 3]],
                },
            )
            .unwrap();
        assert_eq!(entry.state(2, 2), Known::Present);
        assert!(!entry.only_from_page(2, 2));
        assert_eq!(entry.state(1, 1), Known::Present);
        assert!(entry.only_from_page(1, 1));
        assert_eq!(entry.state(3, 3), Known::Absent);
        assert_eq!(entry.state(4, 4), Known::Unknown);
        // Read back from disk the same.
        let again = cache.entry(template, 3).unwrap();
        assert_eq!(again.page, entry.page);
        // A page file that is not one is ignored.
        fs::write(
            cache.dir(template, 3).join(PAGE_FILE),
            "{\"format\":\"other\"}",
        )
        .unwrap();
        assert_eq!(cache.entry(template, 3).unwrap().page, PageFile::default());
    }

    #[test]
    fn seeds_a_layer_only_where_nothing_is_yet() {
        let dir = TempDir::new("measure-seed");
        let cache = PictureCache::new(&dir.0.join("data"));
        let template = "https://tiles.example/{z}/{x}/{y}.png";
        let entry = cache.open(template, 3).unwrap();
        // The cache knows 2, 2 (an image) and 1, 2 and 3, 3 (not there).
        entry.store.write(&Entry::path(2, 2), b"cached").unwrap();
        entry.store.mark_missing(&Entry::path(1, 2)).unwrap();
        entry.store.mark_missing(&Entry::path(3, 3)).unwrap();

        // A pack whose level 1 copies zoom 3 from tile 1, 1 (2 x 2 tiles).
        let pack = dir.0.join("pack");
        fs::create_dir_all(&pack).unwrap();
        fs::write(
            pack.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":512,"height":512}]"#,
        )
        .unwrap();
        fs::write(
            pack.join("layers.json"),
            format!(
                r#"[{{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":1,"tileSize":256,
                  "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{x}}/{{y}}.png","remote":{{
                    "urlTemplate":"{template}","levels":[{{"z":1,"sourceZ":3,"offsetX":1,"offsetY":1}}]}}}}}}]"#
            ),
        )
        .unwrap();
        // An image the pack has already is kept.
        let store = TileStore::new(pack.clone(), Some(pack.clone()));
        store
            .write(Path::new("tiles/a/1/0/1.png"), b"mine")
            .unwrap();
        let plan = read_pack_plan(&pack).unwrap();

        let seeded = seed_layers(&cache, &pack, Some(&pack), &plan).unwrap();
        assert_eq!(
            seeded,
            [Seeded {
                layer_id: "t:layer:a".to_owned(),
                images: 1,
                markers: 0,
            }]
        );
        assert_eq!(
            store.read(Path::new("tiles/a/1/1/1.png")).unwrap(),
            b"cached"
        );
        assert_eq!(store.read(Path::new("tiles/a/1/0/1.png")).unwrap(), b"mine");
        // 3, 3 is outside the level: no marker at 2, 2.
        assert!(!store.is_missing(Path::new("tiles/a/1/2/2.png")));
        // Seeding again changes nothing.
        assert!(seed_layers(&cache, &pack, Some(&pack), &plan)
            .unwrap()
            .is_empty());

        // Another template, or none cached at that zoom, seeds nothing.
        let other = PictureCache::new(&dir.0.join("elsewhere"));
        assert!(seed_layers(&other, &pack, Some(&pack), &plan)
            .unwrap()
            .is_empty());
    }
}
