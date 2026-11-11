//! "View map page": the page a pack was imported from, opened again in a
//! window of its own, just to look at it; and "Save map images as I browse",
//! which keeps the map images the person's own browsing of that page loads.
//!
//! The window is locked down like the import window (`imports.rs`): its own
//! label, which no capability names, so the app refuses every command it
//! might send; no pack protocol (it answers the main window only); a private
//! session (`incognito`); navigation kept on the site of the page; new
//! windows and downloads refused. Only addresses recorded in the pack's
//! manifest (`source.pages[].url`) can be opened, and only `https` ones (or
//! `http` on this computer, for tests).
//!
//! In plain viewing mode nothing is added to the page and nothing is read
//! from it. With saving on, a watching script is added to the page (see
//! `script.rs`) and the shell takes the image copies out of the page from
//! the Rust side, a few times a second, as the import window's data is
//! taken. The shell never clicks, scrolls, pans or zooms anything in the
//! page, never asks a server for anything, and never changes a request the
//! page makes. What it takes is checked and written by `capture.rs`.
//!
//! Saving holds the pack folder's lock (`.atlas/lock`) for as long as it is
//! on, so a download, an import or a delete of the same pack waits until it
//! stops, and it does not start while a download of the pack is running or
//! paused. One map page window at a time; opening another closes the first.

pub mod capture;
mod script;

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, Runtime, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{
    imports::{allowed_page_url, same_site},
    library::PackLock,
    manifest::{MANIFEST_FILE, MAX_MANIFEST_BYTES},
    packs::{PackKind, PackRegistry},
    tiles::{pyramid::read_pack_plan, DownloadManager},
};
use capture::{has_tile, write_tile, Pending, TileHit, TileMatcher, WriteError, Written};
use script::{Batch, NoteReason};

/// The label of the map page window. No capability names it.
pub const VIEW_WINDOW: &str = "map-page";
/// How often the shell looks for new images in the page.
const POLL: Duration = Duration::from_millis(400);
/// Base64 text taken out of the page per look, at most.
const MAX_PULL_CHARS: usize = 4 << 20;
/// Large images come out in slices of this many characters.
const SLICE_CHARS: usize = 1 << 20;
/// How long one evaluation may take before the page counts as busy.
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the status files and the manifest are brought up to date.
const FLUSH_EVERY: Duration = Duration::from_secs(4);
/// Addresses longer than this are not a map image.
const MAX_URL_CHARS: usize = 4096;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------
// The pages recorded in a pack

#[derive(Debug, Deserialize)]
struct RawManifest {
    #[serde(default)]
    source: Option<RawSource>,
}

#[derive(Debug, Deserialize)]
struct RawSource {
    #[serde(default)]
    pages: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RawMap {
    id: String,
    name: String,
}

/// A page a pack was imported from.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourcePage {
    pub url: String,
    pub map_id: Option<String>,
    pub map_name: Option<String>,
    pub imported_at: Option<String>,
}

/// The usable pages recorded in a pack folder's manifest: `https` (or
/// `http` on this computer), each address once, in manifest order.
pub fn recorded_pages(root: &Path) -> Vec<SourcePage> {
    let path = root.join(MANIFEST_FILE);
    let readable = fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= MAX_MANIFEST_BYTES);
    let Some(manifest) = readable
        .then(|| fs::read_to_string(&path).ok())
        .flatten()
        .and_then(|text| {
            serde_json::from_str::<RawManifest>(text.trim_start_matches('\u{feff}')).ok()
        })
    else {
        return Vec::new();
    };
    let names: HashMap<String, String> = fs::read_to_string(root.join("maps.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<RawMap>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|map| (map.id, map.name))
        .collect();
    let mut pages: Vec<SourcePage> = Vec::new();
    for page in manifest.source.map(|s| s.pages).unwrap_or_default() {
        let text = |key: &str| page.get(key).and_then(|v| v.as_str()).map(str::to_owned);
        let Some(url) = text("url").and_then(|url| allowed_page_url(&url)) else {
            continue;
        };
        let url = url.to_string();
        if pages.iter().any(|known| known.url == url) {
            continue;
        }
        let map_id = text("mapId");
        pages.push(SourcePage {
            map_name: map_id.as_ref().and_then(|id| names.get(id).cloned()),
            map_id,
            imported_at: text("importedAt"),
            url,
        });
    }
    pages
}

/// The recorded page of a pack with this address, in its recorded form.
fn recorded_url(root: &Path, url: &str) -> Option<Url> {
    let wanted = allowed_page_url(url)?;
    recorded_pages(root)
        .into_iter()
        .find(|page| page.url == wanted.as_str())
        .and(Some(wanted))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagesInfo {
    pub pages: Vec<SourcePage>,
    /// Map images of this pack can be saved while browsing its pages.
    pub can_save: bool,
    /// Why not, in plain words.
    pub save_note: Option<String>,
}

fn pages_info(registry: &PackRegistry, pack_id: &str) -> Result<PagesInfo, String> {
    let root = registry
        .root(pack_id)
        .ok_or_else(|| "That map pack is not there any more.".to_owned())?;
    let pages = recorded_pages(&root);
    let save_note = if registry.kind(pack_id) != Some(PackKind::Folder) {
        Some("Map images can only be saved into a map pack in a folder you keep.".to_owned())
    } else {
        match read_pack_plan(&root) {
            Ok(plan) if !plan.layers.is_empty() => None,
            Ok(_) => Some("This map pack has no map images that could be saved.".to_owned()),
            Err(_) => Some("This map pack's map image settings could not be read.".to_owned()),
        }
    };
    Ok(PagesInfo {
        pages,
        can_save: save_note.is_none(),
        save_note,
    })
}

// ---------------------------------------------------------------------------
// The session

/// Counts shown while saving; each map image counts once.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub saved: u64,
    pub already_had: u64,
    pub not_saved: u64,
    /// Of `not_saved`: shown by the page in a way that cannot be copied.
    pub from_elements: u64,
    /// Of `not_saved`: everything else (unreadable, too large, not an image,
    /// too many at once, or a disk problem).
    pub other_problems: u64,
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Saved,
    AlreadyHad,
    NotSaved(Problem),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Problem {
    Element,
    Other,
}

/// What the main window shows about the map page window.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStatus {
    pub open: bool,
    pub pack_id: Option<String>,
    pub url: Option<String>,
    /// Saving map images is on.
    pub saving: bool,
    /// Saving was on at some point in this session.
    pub saved_session: bool,
    pub counts: Counts,
    /// The page started background workers, whose loading cannot be seen.
    pub uses_workers: bool,
    /// Increases when a status file changes, so the map looks again.
    pub revision: u64,
    /// A plain note, such as why saving stopped.
    pub message: Option<String>,
}

struct Saving {
    key: String,
    root: PathBuf,
    matcher: TileMatcher,
    /// Held while saving is on.
    _lock: PackLock,
    outcomes: HashMap<TileHit, Outcome>,
    bytes: u64,
    pending: Pending,
    last_flush: Instant,
}

impl Saving {
    fn counts(&self) -> Counts {
        let mut counts = Counts {
            bytes: self.bytes,
            ..Counts::default()
        };
        for outcome in self.outcomes.values() {
            match outcome {
                Outcome::Saved => counts.saved += 1,
                Outcome::AlreadyHad => counts.already_had += 1,
                Outcome::NotSaved(problem) => {
                    counts.not_saved += 1;
                    match problem {
                        Problem::Element => counts.from_elements += 1,
                        Problem::Other => counts.other_problems += 1,
                    }
                }
            }
        }
        counts
    }

    /// Records an outcome; a better one replaces a worse one, never the
    /// other way round.
    fn record(&mut self, hit: TileHit, outcome: Outcome) {
        let entry = self.outcomes.entry(hit).or_insert(outcome);
        if matches!(entry, Outcome::NotSaved(_)) {
            *entry = outcome;
        }
    }

    /// Takes in what the page handed over. Blocking: it writes files.
    fn take(&mut self, batch: &Batch, large: Vec<(String, Vec<u8>)>) {
        let items = batch
            .items
            .iter()
            .map(|item| (item.url.as_str(), capture::decode_base64(&item.data)))
            .chain(
                large
                    .iter()
                    .map(|(url, bytes)| (url.as_str(), Some(bytes.clone()))),
            );
        let mut changes = Vec::new();
        for (url, bytes) in items {
            if url.len() > MAX_URL_CHARS {
                continue;
            }
            let Some(hit) = self.matcher.find(url) else {
                continue;
            };
            if matches!(
                self.outcomes.get(&hit),
                Some(Outcome::Saved | Outcome::AlreadyHad)
            ) {
                continue;
            }
            let layer = &self.matcher.plan().layers[hit.layer];
            let outcome = match bytes {
                None => Outcome::NotSaved(Problem::Other),
                Some(bytes) => match write_tile(&self.root, layer, &hit, &bytes) {
                    Ok(Written::Saved(size)) => {
                        self.bytes += size;
                        changes.push(hit);
                        Outcome::Saved
                    }
                    Ok(Written::AlreadyHad) => Outcome::AlreadyHad,
                    Err(WriteError::Disk(error)) => {
                        eprintln!("atlas: could not save a map image: {error}");
                        Outcome::NotSaved(Problem::Other)
                    }
                    Err(_) => Outcome::NotSaved(Problem::Other),
                },
            };
            self.record(hit, outcome);
        }
        for hit in changes {
            self.pending.add(self.matcher.plan(), &hit);
        }
        for note in &batch.not_saved {
            if note.url.len() > MAX_URL_CHARS {
                continue;
            }
            let Some(hit) = self.matcher.find(&note.url) else {
                continue;
            };
            if self
                .outcomes
                .get(&hit)
                .is_some_and(|known| !matches!(known, Outcome::NotSaved(_)))
            {
                continue;
            }
            let layer = &self.matcher.plan().layers[hit.layer];
            let outcome = if has_tile(&self.root, layer, &hit) {
                Outcome::AlreadyHad
            } else if note.reason == NoteReason::Element {
                Outcome::NotSaved(Problem::Element)
            } else {
                Outcome::NotSaved(Problem::Other)
            };
            self.record(hit, outcome);
        }
    }

    /// Brings status files and the manifest up to date. Returns whether a
    /// status file changed.
    fn flush(&mut self) -> bool {
        self.last_flush = Instant::now();
        if self.pending.is_empty() {
            return false;
        }
        let Self {
            pending,
            root,
            matcher,
            ..
        } = self;
        pending.flush(root, matcher.plan())
    }
}

struct Session {
    id: u64,
    pack_id: String,
    url: String,
    site: String,
    saving: Option<Saving>,
    saved_session: bool,
    counts: Counts,
    uses_workers: bool,
    message: Option<String>,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    next_id: u64,
    revision: u64,
    /// The last session, after its window closed, so its counts stay shown.
    last: Option<ViewStatus>,
}

/// The map page window, if any. Lives in Tauri's managed state.
#[derive(Clone, Default)]
pub struct PageViews {
    inner: Arc<Mutex<Inner>>,
}

/// Evaluates a script in the window and returns its result as JSON text,
/// or `None` when it did not answer in time.
async fn evaluate<R: Runtime>(window: &WebviewWindow<R>, script: String) -> Option<String> {
    let (send, receive) = oneshot::channel();
    let send = Mutex::new(Some(send));
    window
        .eval_with_callback(script, move |result| {
            if let Some(send) = lock(&send).take() {
                let _ = send.send(result);
            }
        })
        .ok()?;
    tokio::time::timeout(EVAL_TIMEOUT, receive).await.ok()?.ok()
}

/// Runs a script that returns a JSON string and parses that string.
async fn evaluate_json<R: Runtime, T: serde::de::DeserializeOwned>(
    window: &WebviewWindow<R>,
    script: String,
) -> Option<T> {
    let result = evaluate(window, script).await?;
    let text = serde_json::from_str::<String>(&result).ok()?;
    serde_json::from_str(&text).ok()
}

/// A random number for the page handle's name.
fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(std::time::SystemTime::now())
}

fn window_title(site: &str, saving: bool) -> String {
    if saving {
        format!("Map page \u{2013} {site} \u{2013} saving map images")
    } else {
        format!("Map page \u{2013} {site}")
    }
}

impl PageViews {
    /// Opens a recorded page of a pack, replacing any map page window.
    pub fn open<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        registry: &PackRegistry,
        manager: &DownloadManager,
        pack_id: &str,
        url: &str,
        save: bool,
    ) -> Result<(), String> {
        let root = registry
            .root(pack_id)
            .ok_or_else(|| "That map pack is not there any more.".to_owned())?;
        let start = recorded_url(&root, url)
            .ok_or_else(|| "Only pages this map pack was made from can be opened.".to_owned())?;
        let saving = if save {
            Some(start_saving(registry, manager, pack_id, &root)?)
        } else {
            None
        };
        self.close(app);

        let site = start.host_str().unwrap_or_default().to_owned();
        let script = saving
            .as_ref()
            .map(|saving| script::capture_script(&saving.key, &saving.matcher.prefixes()));
        let id = {
            let mut inner = lock(&self.inner);
            inner.next_id += 1;
            let id = inner.next_id;
            inner.last = None;
            inner.session = Some(Session {
                id,
                pack_id: pack_id.to_owned(),
                url: start.to_string(),
                site: site.clone(),
                saved_session: saving.is_some(),
                saving,
                counts: Counts::default(),
                uses_workers: false,
                message: None,
            });
            id
        };

        let navigation_start = start.clone();
        let mut builder = WebviewWindowBuilder::new(app, VIEW_WINDOW, WebviewUrl::External(start))
            .title(window_title(&site, script.is_some()))
            .inner_size(1200.0, 800.0)
            .center()
            .focused(true)
            .incognito(true)
            .on_navigation(move |next| {
                let allowed = same_site(&navigation_start, next);
                if !allowed {
                    eprintln!("atlas: the map page window stays on its site; not opening {next}");
                }
                allowed
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }));
        if let Some(script) = &script {
            builder = builder.initialization_script(script);
        }
        if let Err(error) = builder.build() {
            lock(&self.inner).session = None;
            return Err(format!("Could not open the page window: {error}"));
        }
        if script.is_some() {
            let this = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move { this.run(app, id).await });
        } else {
            let this = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move { this.watch(app, id).await });
        }
        Ok(())
    }

    fn is_current(&self, id: u64) -> bool {
        lock(&self.inner)
            .session
            .as_ref()
            .is_some_and(|session| session.id == id)
    }

    /// Plain viewing: notices when the window is closed.
    async fn watch<R: Runtime>(&self, app: AppHandle<R>, id: u64) {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if !self.is_current(id) {
                return;
            }
            if app.get_webview_window(VIEW_WINDOW).is_none() {
                self.end(id, None).await;
                return;
            }
        }
    }

    /// Saving: takes images out of the page until saving stops or the
    /// window closes.
    async fn run<R: Runtime>(&self, app: AppHandle<R>, id: u64) {
        let mut ticker = tokio::time::interval(POLL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let key = {
                let inner = lock(&self.inner);
                match inner.session.as_ref() {
                    Some(session) if session.id == id => {
                        session.saving.as_ref().map(|saving| saving.key.clone())
                    }
                    _ => return,
                }
            };
            let Some(window) = app.get_webview_window(VIEW_WINDOW) else {
                self.end(id, None).await;
                return;
            };
            let Some(key) = key else {
                // Saving stopped; keep noticing when the window closes.
                return self.watch(app, id).await;
            };
            if let Some((batch, large)) = pull(&window, &key).await {
                let ids: Vec<u64> = batch
                    .items
                    .iter()
                    .map(|item| item.id)
                    .chain(batch.large.iter().map(|item| item.id))
                    .collect();
                let this = self.clone();
                let _ = tokio::task::spawn_blocking(move || this.take(id, &batch, large)).await;
                if !ids.is_empty() {
                    let _ = evaluate(&window, script::drop_script(&key, &ids)).await;
                }
            }
            let this = self.clone();
            let _ = tokio::task::spawn_blocking(move || this.flush(id, false)).await;
        }
    }

    fn take(&self, id: u64, batch: &Batch, large: Vec<(String, Vec<u8>)>) {
        let mut inner = lock(&self.inner);
        let Some(session) = inner.session.as_mut().filter(|s| s.id == id) else {
            return;
        };
        session.uses_workers |= batch.workers;
        if let Some(saving) = session.saving.as_mut() {
            saving.take(batch, large);
            session.counts = saving.counts();
        }
    }

    /// Brings the status files and manifest up to date, every few seconds or
    /// when `now`.
    fn flush(&self, id: u64, now: bool) {
        let mut inner = lock(&self.inner);
        let Some(session) = inner.session.as_mut().filter(|s| s.id == id) else {
            return;
        };
        let Some(saving) = session.saving.as_mut() else {
            return;
        };
        if !now && saving.last_flush.elapsed() < FLUSH_EVERY {
            return;
        }
        if saving.flush() {
            inner.revision += 1;
        }
    }

    /// Stops saving: brings the files up to date, releases the pack and
    /// tells the page to stop keeping copies. The window stays open.
    pub async fn stop_saving<R: Runtime>(&self, app: &AppHandle<R>) {
        let Some((key, site)) = self.finish_saving(None).await else {
            return;
        };
        if let Some(window) = app.get_webview_window(VIEW_WINDOW) {
            let _ = window.set_title(&window_title(&site, false));
            let _ = evaluate(&window, script::off_script(&key)).await;
        }
    }

    /// Ends saving in the current session, if on. Returns the page handle's
    /// name and the site.
    async fn finish_saving(&self, message: Option<String>) -> Option<(String, String)> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut inner = lock(&this.inner);
            let session = inner.session.as_mut()?;
            let mut saving = session.saving.take()?;
            saving.last_flush = Instant::now() - FLUSH_EVERY;
            let changed = saving.flush();
            session.counts = saving.counts();
            if message.is_some() {
                session.message = message;
            }
            let result = (saving.key.clone(), session.site.clone());
            drop(saving);
            if changed {
                inner.revision += 1;
            }
            Some(result)
        })
        .await
        .ok()
        .flatten()
    }

    /// The window of session `id` was closed.
    async fn end(&self, id: u64, message: Option<String>) {
        if !self.is_current(id) {
            return;
        }
        self.finish_saving(message).await;
        let mut inner = lock(&self.inner);
        if inner.session.as_ref().is_some_and(|s| s.id == id) {
            let status = status_of(inner.session.as_ref(), inner.revision);
            inner.last = Some(ViewStatus {
                open: false,
                ..status
            });
            inner.session = None;
        }
    }

    /// Closes the map page window, if it is open, saving what was taken.
    pub fn close<R: Runtime>(&self, app: &AppHandle<R>) {
        if let Some(window) = app.get_webview_window(VIEW_WINDOW) {
            let _ = window.destroy();
        }
        let mut inner = lock(&self.inner);
        if let Some(mut session) = inner.session.take() {
            let mut changed = false;
            if let Some(mut saving) = session.saving.take() {
                changed = saving.flush();
                session.counts = saving.counts();
            }
            if changed {
                inner.revision += 1;
            }
            let status = status_of(Some(&session), inner.revision);
            inner.last = Some(ViewStatus {
                open: false,
                ..status
            });
        }
    }

    pub fn status(&self) -> ViewStatus {
        let inner = lock(&self.inner);
        match (&inner.session, &inner.last) {
            (None, Some(last)) => ViewStatus {
                revision: inner.revision,
                ..last.clone()
            },
            (session, _) => status_of(session.as_ref(), inner.revision),
        }
    }
}

fn status_of(session: Option<&Session>, revision: u64) -> ViewStatus {
    match session {
        None => ViewStatus {
            open: false,
            pack_id: None,
            url: None,
            saving: false,
            saved_session: false,
            counts: Counts::default(),
            uses_workers: false,
            revision,
            message: None,
        },
        Some(session) => ViewStatus {
            open: true,
            pack_id: Some(session.pack_id.clone()),
            url: Some(session.url.clone()),
            saving: session.saving.is_some(),
            saved_session: session.saved_session,
            counts: session.counts.clone(),
            uses_workers: session.uses_workers,
            revision,
            message: session.message.clone(),
        },
    }
}

/// Checks that a pack can take saved images now, and prepares saving.
fn start_saving(
    registry: &PackRegistry,
    manager: &DownloadManager,
    pack_id: &str,
    root: &Path,
) -> Result<Saving, String> {
    if registry.kind(pack_id) != Some(PackKind::Folder) {
        return Err(
            "Map images can only be saved into a map pack in a folder you keep.".to_owned(),
        );
    }
    if manager.is_active(pack_id) {
        return Err(
            "Map images of this game are downloading. Pause and cancel that download first, or wait until it has finished."
                .to_owned(),
        );
    }
    let plan = read_pack_plan(root)
        .map_err(|_| "This map pack's map image settings could not be read.".to_owned())?;
    if plan.layers.is_empty() {
        return Err("This map pack has no map images that could be saved.".to_owned());
    }
    let pack_lock = PackLock::acquire(root)?;
    Ok(Saving {
        key: format!("__atlasView{:016x}", rand_u64()),
        root: root.to_path_buf(),
        matcher: TileMatcher::new(plan),
        _lock: pack_lock,
        outcomes: HashMap::new(),
        bytes: 0,
        pending: Pending::default(),
        last_flush: Instant::now(),
    })
}

/// Takes what waits in the page: whole small images, and large ones slice by
/// slice. `None` when the page did not answer.
async fn pull<R: Runtime>(
    window: &WebviewWindow<R>,
    key: &str,
) -> Option<(Batch, Vec<(String, Vec<u8>)>)> {
    let batch: Batch = evaluate_json(window, script::next_script(key, MAX_PULL_CHARS)).await?;
    let mut large = Vec::new();
    for item in &batch.large {
        // Base64 of an image at the limit, at most.
        if item.length > capture::MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            continue;
        }
        let mut text = String::with_capacity(item.length);
        while text.len() < item.length {
            let slice: Option<script::Slice> = evaluate_json(
                window,
                script::slice_script(key, item.id, text.len(), SLICE_CHARS),
            )
            .await;
            match slice {
                Some(slice) if slice.next > text.len() && slice.next <= item.length => {
                    text.push_str(&slice.text);
                }
                _ => break,
            }
        }
        if text.len() == item.length {
            if let Some(bytes) = capture::decode_base64(&text) {
                large.push((item.url.clone(), bytes));
            }
        }
    }
    Some((batch, large))
}

// ---------------------------------------------------------------------------
// Commands (granted to the main window in `capabilities/main.json`)

/// The pages a pack was imported from, and whether its map images can be
/// saved while browsing them.
#[tauri::command]
pub async fn view_pages(
    registry: State<'_, PackRegistry>,
    pack_id: String,
) -> Result<PagesInfo, String> {
    let registry = registry.inner().clone();
    tokio::task::spawn_blocking(move || pages_info(&registry, &pack_id))
        .await
        .map_err(|error| error.to_string())?
}

/// Opens a recorded page of a pack in the map page window, to look at, or
/// with `save` to keep the map images the person's browsing loads.
#[tauri::command]
pub async fn view_open<R: Runtime>(
    app: AppHandle<R>,
    views: State<'_, PageViews>,
    registry: State<'_, PackRegistry>,
    manager: State<'_, Arc<DownloadManager>>,
    pack_id: String,
    url: String,
    save: bool,
) -> Result<ViewStatus, String> {
    views.open(&app, &registry, &manager, &pack_id, &url, save)?;
    Ok(views.status())
}

/// What the map page window is doing, with the counts while saving.
#[tauri::command]
pub async fn view_status(views: State<'_, PageViews>) -> Result<ViewStatus, String> {
    let views = views.inner().clone();
    tokio::task::spawn_blocking(move || views.status())
        .await
        .map_err(|error| error.to_string())
}

/// Stops saving map images; the window stays open for looking.
#[tauri::command]
pub async fn view_stop_saving<R: Runtime>(
    app: AppHandle<R>,
    views: State<'_, PageViews>,
) -> Result<ViewStatus, String> {
    views.stop_saving(&app).await;
    Ok(views.status())
}

/// Closes the map page window.
#[tauri::command]
pub async fn view_close<R: Runtime>(
    app: AppHandle<R>,
    views: State<'_, PageViews>,
) -> Result<ViewStatus, String> {
    let views = views.inner().clone();
    let closer = views.clone();
    tokio::task::spawn_blocking(move || closer.close(&app))
        .await
        .map_err(|error| error.to_string())?;
    Ok(views.status())
}

/// Opens a recorded page of a pack in the system browser.
#[tauri::command]
pub async fn view_open_in_browser<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, PackRegistry>,
    pack_id: String,
    url: String,
) -> Result<(), String> {
    let root = registry
        .root(&pack_id)
        .ok_or_else(|| "That map pack is not there any more.".to_owned())?;
    let url = recorded_url(&root, &url)
        .ok_or_else(|| "Only pages this map pack was made from can be opened.".to_owned())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open the page: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    fn write_pack(root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE),
            r#"{"schemaVersion":2,"gameId":"my-game","title":"My Game","packVersion":"1.0.0",
               "source":{"importer":{"id":"demo-maps","title":"Demo"},"pages":[
                 {"url":"https://maps.example.com/my-game/world","mapId":"my-game:map:world","importedAt":"2026-01-01T00:00:00Z"},
                 {"url":"http://127.0.0.1:4500/my-game/caves","importedAt":"2026-01-02T00:00:00Z"},
                 {"url":"https://maps.example.com/my-game/world","mapId":"my-game:map:world","importedAt":"2026-01-03T00:00:00Z"},
                 {"url":"http://maps.example.com/plain"},
                 {"url":"javascript:alert(1)"},
                 {"url":"file:///etc/passwd"},
                 {"nothing":true}
               ]}}"#,
        )
        .unwrap();
        fs::write(
            root.join("maps.json"),
            r#"[{"id":"my-game:map:world","name":"World","width":512,"height":512}]"#,
        )
        .unwrap();
    }

    #[test]
    fn lists_only_usable_recorded_pages() {
        let dir = TempDir::new("pageview-pages");
        let root = dir.0.join("pack");
        write_pack(&root);
        let pages = recorded_pages(&root);
        assert_eq!(
            pages,
            vec![
                SourcePage {
                    url: "https://maps.example.com/my-game/world".into(),
                    map_id: Some("my-game:map:world".into()),
                    map_name: Some("World".into()),
                    imported_at: Some("2026-01-01T00:00:00Z".into()),
                },
                SourcePage {
                    url: "http://127.0.0.1:4500/my-game/caves".into(),
                    map_id: None,
                    map_name: None,
                    imported_at: Some("2026-01-02T00:00:00Z".into()),
                },
            ]
        );
        assert!(recorded_url(&root, "https://maps.example.com/my-game/world").is_some());
        assert!(recorded_url(&root, " http://127.0.0.1:4500/my-game/caves ").is_some());
        for other in [
            "https://maps.example.com/my-game/other",
            "https://maps.example.com/my-game/world?x=1",
            "http://maps.example.com/plain",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "",
        ] {
            assert!(recorded_url(&root, other).is_none(), "{other}");
        }
        // No manifest, or one without pages: nothing.
        assert!(recorded_pages(&dir.0).is_empty());
        fs::write(root.join(MANIFEST_FILE), r#"{"schemaVersion":1}"#).unwrap();
        assert!(recorded_pages(&root).is_empty());
    }

    #[test]
    fn says_when_images_cannot_be_saved() {
        let dir = TempDir::new("pageview-info");
        let root = dir.0.join("pack");
        write_pack(&root);
        fs::write(root.join("layers.json"), "[]").unwrap();
        let registry = PackRegistry::default();
        registry.register("my-game", &root).unwrap();
        let info = pages_info(&registry, "my-game").unwrap();
        assert_eq!(info.pages.len(), 2);
        assert!(
            !info.can_save,
            "a pack that comes with the app is read only"
        );
        registry.register_folder("my-game", &root).unwrap();
        let info = pages_info(&registry, "my-game").unwrap();
        assert!(!info.can_save);
        assert!(info.save_note.unwrap().contains("no map images"));
        assert!(pages_info(&registry, "other").is_err());
    }

    #[test]
    fn refuses_to_save_while_the_pack_is_locked() {
        let dir = TempDir::new("pageview-start");
        let root = dir.0.join("pack");
        write_pack(&root);
        fs::write(
            root.join("layers.json"),
            r#"[{"id":"my-game:layer:world","mapId":"my-game:map:world","name":"World","minZoom":0,"maxZoom":1,"tileSize":256,
                "tiles":{"type":"xyz","url":"tiles/world/{z}/{x}/{y}.png","remote":{
                  "urlTemplate":"https://tiles.example.com/{z}/{x}/{y}.png",
                  "levels":[{"z":1,"sourceZ":1,"offsetX":0,"offsetY":0}]}}}]"#,
        )
        .unwrap();
        let registry = PackRegistry::default();
        registry.register_folder("my-game", &root).unwrap();
        let manager = DownloadManager::new(dir.0.join("data"), registry.clone());
        let saving = start_saving(&registry, &manager, "my-game", &root).unwrap();
        assert_eq!(
            saving.matcher.prefixes(),
            vec!["https://tiles.example.com/"]
        );
        // Saving holds the pack: a download (or a second saving) cannot start.
        assert!(PackLock::acquire(&root).is_err());
        let again = start_saving(&registry, &manager, "my-game", &root);
        assert!(again.is_err());
        drop(saving);
        assert!(PackLock::acquire(&root).is_ok());
    }

    #[test]
    fn counts_each_image_once_and_never_downgrades() {
        let dir = TempDir::new("pageview-counts");
        let root = dir.0.join("pack");
        write_pack(&root);
        fs::write(
            root.join("layers.json"),
            r#"[{"id":"my-game:layer:world","mapId":"my-game:map:world","name":"World","minZoom":0,"maxZoom":1,"tileSize":256,
                "tiles":{"type":"xyz","url":"tiles/world/{z}/{x}/{y}.png","remote":{
                  "urlTemplate":"https://tiles.example.com/{z}/{x}/{y}.png",
                  "levels":[{"z":1,"sourceZ":1,"offsetX":0,"offsetY":0}]}}}]"#,
        )
        .unwrap();
        let registry = PackRegistry::default();
        registry.register_folder("my-game", &root).unwrap();
        let manager = DownloadManager::new(dir.0.join("data"), registry.clone());
        let mut saving = start_saving(&registry, &manager, "my-game", &root).unwrap();
        let png = {
            let image = image::RgbImage::from_pixel(256, 256, image::Rgb([5, 6, 7]));
            let mut out = std::io::Cursor::new(Vec::new());
            image.write_to(&mut out, image::ImageFormat::Png).unwrap();
            out.into_inner()
        };
        let encode = |bytes: &[u8]| {
            // Standard base64, as the page's btoa writes it.
            const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let b = [
                    chunk[0],
                    *chunk.get(1).unwrap_or(&0),
                    *chunk.get(2).unwrap_or(&0),
                ];
                let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                for i in 0..4 {
                    if i <= chunk.len() {
                        out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
                    } else {
                        out.push('=');
                    }
                }
            }
            out
        };
        let batch: Batch = serde_json::from_value(serde_json::json!({
            "items": [
                {"id": 1, "url": "https://tiles.example.com/1/0/0.png", "data": encode(&png)},
                {"id": 2, "url": "https://tiles.example.com/1/0/0.png", "data": encode(&png)},
                {"id": 3, "url": "https://tiles.example.com/icons/pin.png", "data": encode(&png)},
                {"id": 4, "url": "https://tiles.example.com/1/1/0.png", "data": encode(b"<html>")},
            ],
            "large": [],
            "notSaved": [
                {"url": "https://tiles.example.com/1/0/1.png", "reason": "element"},
                {"url": "https://tiles.example.com/1/0/1.png", "reason": "element"},
                {"url": "https://tiles.example.com/1/0/0.png", "reason": "element"},
                {"url": "https://elsewhere.example.com/1/0/1.png", "reason": "element"},
            ],
            "workers": true,
        }))
        .unwrap();
        saving.take(&batch, Vec::new());
        assert_eq!(
            saving.counts(),
            Counts {
                saved: 1,
                already_had: 0,
                not_saved: 2,
                from_elements: 1,
                other_problems: 1,
                bytes: png.len() as u64,
            }
        );
        assert_eq!(
            fs::read(root.join("tiles/world/1/0/0.png")).unwrap(),
            png,
            "saved where the downloader saves it"
        );
        assert!(!root.join("tiles/icons").exists());
        // The page later loads the tile it showed with an element by fetch.
        let later: Batch = serde_json::from_value(serde_json::json!({
            "items": [{"id": 5, "url": "https://tiles.example.com/1/0/1.png", "data": encode(&png)}],
            "large": [], "notSaved": [], "workers": false,
        }))
        .unwrap();
        saving.take(&later, Vec::new());
        assert_eq!(saving.counts().saved, 2);
        assert_eq!(saving.counts().from_elements, 0);
        assert!(!saving.flush(), "no level is complete yet");
        let status: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(root.join("offline-tiles/world.json")).unwrap_or_default(),
        )
        .unwrap_or_default();
        assert_eq!(
            status,
            serde_json::Value::Null,
            "level 1 is not complete yet"
        );
        assert!(
            root.join("tiles/world/0/0/0.png").exists(),
            "level 0 was built"
        );
    }

    #[test]
    fn titles_say_when_saving() {
        assert_eq!(
            window_title("maps.example.com", false),
            "Map page \u{2013} maps.example.com"
        );
        assert!(window_title("maps.example.com", true).ends_with("saving map images"));
    }
}
