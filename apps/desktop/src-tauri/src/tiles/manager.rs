//! Download jobs: one at a time on the computer, level by level, lowest first.
//!
//! A job fetches every remote level of every downloadable layer of a pack up
//! to the chosen detail. All layers' lowest remote level comes first, so
//! every map becomes usable early; as soon as a layer's lowest remote level
//! is complete, the levels below it are built by shrinking, and each
//! finished level is recorded in the layer's status file, which the map
//! reads to show the new levels without a restart.
//!
//! **One download at a time.** The pace settings are meant for everything
//! the computer downloads, so jobs take turns:
//!
//! - within one app, jobs queue. Only the job at the front downloads; the
//!   others are `queued` and start by themselves, in order, when it
//!   finishes, stops on an error, is cancelled or is paused. Pausing a job
//!   takes it out of the queue (once its requests in flight have finished,
//!   the next job starts); resuming puts it at the back;
//! - across apps (the viewer and other builds share the maps folder), the
//!   job at the front only downloads while it holds a computer-wide lock on
//!   `<shared folder>/download.lock` (`File::try_lock`, so it dies with the
//!   process). Without it the job is `waiting` and tries again every few
//!   seconds. The lock is let go whenever no job of this app is downloading.
//!
//! Where files go depends on how the pack is registered (see `packs.rs`):
//!
//! - a pack folder the person keeps (the maps folder or an opened location)
//!   receives the tiles itself, at the layer's own URL paths, with the
//!   `offline-tiles/<layer local id>.json` status files (see `status.rs`),
//!   and the image summaries in its `manifest.json` are kept current. The
//!   job holds the pack folder's lock (`.atlas/lock`) from the moment it is
//!   started until it ends, so another window or app cannot write the same
//!   pack at once, and an unfinished job is recorded in
//!   `.atlas/download-job.json`;
//! - a bundled pack is read only: its tiles and status files go to the
//!   overlay `<app data>/packs/<pack id>/`, and an unfinished job to
//!   `<app data>/downloads/<pack id>.json`.
//!
//! The job record is `{ "packId", "detail", "stopReason", "stopDetail" }`, so
//! the job can be offered again after the app restarts, with the full record
//! of a refusal. It is removed when the job finishes or is cancelled. Every
//! step (queueing, waiting, hand-over, levels, progress, the end) goes to
//! the activity log.

use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{sync::watch, time::Instant};

use super::{
    download::{
        host_of, http_client, wait_text, Control, Downloader, OnOutcome, Outcome, Pace, Place,
        Settings, SharedPace, Stop, StopDetail, Task,
    },
    downscale::build_lower_levels,
    measure::{Fetching, MeasureRequest, Measured, PictureCache, Pictures},
    pyramid::{read_pack_plan, relative_path, Detail, LayerPlan, PackPlan},
    status::{add_levels, read_levels},
    store::TileStore,
};
use crate::{
    activity::{ActivityLog, Area},
    library::{PackLock, JOB_FILE, META_DIR},
    manifest::{read_head, update_images, ImagesUpdate},
    packs::{PackKind, PackRegistry},
    settings::DownloadSettings,
};

// Stopping a pack's downloads for good, before its images or the pack are deleted.
pub mod stop;

/// Assumed server answer time, for estimates before a job has started.
const ASSUMED_LATENCY: Duration = Duration::from_millis(200);
/// Speed is measured over this recent span.
const SPEED_WINDOW: Duration = Duration::from_secs(20);
/// The computer-wide download lock, in the shared folder.
pub const DOWNLOAD_LOCK_FILE: &str = "download.lock";
/// How often a job waiting for another app tries the lock again.
const LOCK_RETRY: Duration = Duration::from_secs(3);
/// A progress line at most this often, or every this many images.
const PROGRESS_EVERY: Duration = Duration::from_secs(30);
const PROGRESS_IMAGES: u64 = 500;
/// Addresses of missing images listed per level in the log.
const MISSING_EXAMPLES: usize = 3;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    /// Waiting for another download of this app to finish.
    Queued,
    /// Waiting for another Atlas app on this computer to finish downloading.
    Waiting,
    Running,
    Paused,
    /// Stopped by a problem; `reason` says which.
    Stopped,
    Cancelled,
    Done,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapProgress {
    pub map_id: String,
    pub name: String,
    pub done: u64,
    pub total: u64,
}

/// The state of a job, as the web app shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub pack_id: String,
    /// The pack's title.
    pub title: String,
    pub detail: Detail,
    pub state: JobState,
    pub reason: Option<String>,
    /// The answer that stopped the job (a refusal or a web page), in full.
    pub stop_detail: Option<StopDetail>,
    /// Queued: its place in the queue, from 1.
    pub queue_position: Option<usize>,
    /// Queued or waiting: what it waits for, in words.
    pub waiting_for: Option<String>,
    pub maps: Vec<MapProgress>,
    /// Tiles dealt with (downloaded, already there, missing or failed).
    pub done: u64,
    pub total: u64,
    pub saved: u64,
    /// Not on the server: answered 404 or 410, or an object store's "access
    /// denied" for images that do not exist.
    pub missing: u64,
    /// Not asked for, because the tile above them is not on the server.
    pub not_asked: u64,
    pub failed: u64,
    pub bytes: u64,
    pub tiles_per_second: f64,
    pub bytes_per_second: f64,
    pub seconds_left: Option<f64>,
    /// Increases whenever a status file changes, so the map knows to look.
    pub status_revision: u64,
}

struct Progress {
    snapshot: Snapshot,
    /// Map index of each layer.
    layer_maps: Vec<usize>,
    /// Recent requests: when, and how many bytes.
    recent: VecDeque<(Instant, u64)>,
    started: Instant,
    /// When the job was started, for its duration.
    created: Instant,
    /// The last progress line in the log.
    logged_at: Instant,
    logged_done: u64,
    /// Of `missing`, those an object store answered "access denied" for.
    denied: u64,
}

impl Progress {
    fn record(&mut self, task: &Task, outcome: &Outcome) {
        let s = &mut self.snapshot;
        s.done += 1;
        s.maps[self.layer_maps[task.layer]].done += 1;
        let bytes = match outcome {
            Outcome::Skipped => return,
            Outcome::Saved(bytes) => {
                s.saved += 1;
                s.bytes += bytes;
                *bytes
            }
            Outcome::Missing => {
                s.missing += 1;
                0
            }
            Outcome::MissingDenied => {
                s.missing += 1;
                self.denied += 1;
                0
            }
            Outcome::NotAsked => {
                // No request was made: nothing for the speed.
                s.not_asked += 1;
                return;
            }
            Outcome::Failed(_) => {
                s.failed += 1;
                0
            }
        };
        let now = Instant::now();
        self.recent.push_back((now, bytes));
        while self
            .recent
            .front()
            .is_some_and(|(at, _)| now - *at > SPEED_WINDOW)
        {
            self.recent.pop_front();
        }
    }

    fn snapshot(&self) -> Snapshot {
        let mut snapshot = self.snapshot.clone();
        let now = Instant::now();
        let span = self
            .recent
            .front()
            .map_or(Duration::ZERO, |(at, _)| now - *at)
            .max(now - self.started)
            .min(SPEED_WINDOW)
            .as_secs_f64();
        let recent: Vec<_> = self
            .recent
            .iter()
            .filter(|(at, _)| now - *at <= SPEED_WINDOW)
            .collect();
        if span >= 1.0 && !recent.is_empty() && snapshot.state == JobState::Running {
            snapshot.tiles_per_second = recent.len() as f64 / span;
            snapshot.bytes_per_second = recent.iter().map(|(_, b)| *b as f64).sum::<f64>() / span;
            let left = snapshot.total.saturating_sub(snapshot.done) as f64;
            snapshot.seconds_left = Some(left / snapshot.tiles_per_second);
        }
        snapshot
    }

    /// The counts in words, for the log.
    fn counts(&self) -> String {
        let s = &self.snapshot;
        let present = s.done - s.saved - s.missing - s.not_asked - s.failed;
        format!(
            "{} of {} images dealt with: {} saved ({}), {} already there, {} not on the server ({} of them answered \"access denied\" by the store, as it does for images that do not exist), {} not asked for because the area above them is not on the server, {} failed",
            s.done,
            s.total,
            s.saved,
            bytes_text(s.bytes),
            present,
            s.missing,
            self.denied,
            s.not_asked,
            s.failed
        )
    }

    /// A progress line, at most every 30 s or 500 images.
    fn progress_line(&mut self) -> Option<String> {
        let now = Instant::now();
        if self.snapshot.done - self.logged_done < PROGRESS_IMAGES
            && now - self.logged_at < PROGRESS_EVERY
        {
            return None;
        }
        self.logged_at = now;
        self.logged_done = self.snapshot.done;
        let snapshot = self.snapshot();
        Some(format!(
            "Progress of {}: {}; {:.1} images/s",
            snapshot.title,
            self.counts(),
            snapshot.tiles_per_second
        ))
    }
}

/// Bytes in words for the log.
fn bytes_text(bytes: u64) -> String {
    if bytes >= 1 << 20 {
        format!("{:.1} MB", bytes as f64 / f64::from(1u32 << 20))
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

/// A duration in words for the log.
fn duration_text(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds >= 3600 {
        format!("{} h {} min", seconds / 3600, (seconds % 3600) / 60)
    } else if seconds >= 60 {
        format!("{} min {} s", seconds / 60, seconds % 60)
    } else {
        format!("{:.1} s", duration.as_secs_f64())
    }
}

/// Rough cost of fetching `tiles` tiles of `bytes` bytes in all at a pace.
fn estimate_seconds(pace: &Pace, tiles: u64, bytes: u64) -> f64 {
    pace.estimate_seconds(tiles, bytes, ASSUMED_LATENCY)
}

/// One choice in the detail picker.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailOption {
    pub detail: Detail,
    /// Remote tiles up to this detail.
    pub tiles: u64,
    /// Of those, not on disk yet.
    pub remaining: u64,
    pub estimated_seconds: f64,
    pub estimated_bytes: u64,
    /// Whether every level up to this detail is ready.
    pub installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unfinished {
    pub detail: Detail,
    pub reason: Option<String>,
    pub stop_detail: Option<StopDetail>,
}

/// A download of this app that is not over, in queue order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub pack_id: String,
    pub title: String,
    pub state: JobState,
}

/// What the web app needs to offer a download.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    pub pack_id: String,
    pub options: Vec<DetailOption>,
    pub recommended: Detail,
    /// A job that was interrupted, for example by closing the app.
    pub unfinished: Option<Unfinished>,
    /// The current or last job of this pack in this session.
    pub job: Option<Snapshot>,
    /// The title of another pack whose job downloads now; a new job waits for it.
    pub busy_with: Option<String>,
    /// Every download of this app that is not over: the one downloading
    /// first, then the queue in order, then paused ones.
    pub queue: Vec<QueueEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobRecord {
    pack_id: String,
    detail: Detail,
    stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stop_detail: Option<StopDetail>,
}

struct Job {
    pack_id: String,
    title: String,
    control: watch::Sender<Control>,
    progress: Arc<Mutex<Progress>>,
    downloader: Arc<Downloader>,
    finished: bool,
    /// The person paused it: it is out of the queue until resumed.
    paused: bool,
    /// Held from start to end, for a pack folder.
    lock: Option<PackLock>,
}

/// The computer-wide download lock, while held. Without a file (when the
/// shared folder cannot be written), downloads go ahead unlocked.
struct ComputerLock {
    _file: Option<fs::File>,
}

#[derive(Default)]
struct Schedule {
    jobs: HashMap<String, Job>,
    /// The job that may download now.
    holder: Option<String>,
    /// Jobs waiting for their turn, in order.
    queue: VecDeque<String>,
    /// Held while `holder` is set.
    computer: Option<ComputerLock>,
    /// A retry of the computer-wide lock is scheduled.
    retry_pending: bool,
}

/// Runs and tracks download jobs. Lives in Tauri's managed state.
pub struct DownloadManager {
    app_data: PathBuf,
    registry: PackRegistry,
    settings: Settings,
    /// The person's download settings; running jobs read them too.
    pace: SharedPace,
    schedule: Mutex<Schedule>,
    lock_path: PathBuf,
    lock_retry: Duration,
    log: ActivityLog,
    /// Measuring pictures for imports (see `measure`).
    pictures: Pictures,
    picture_cache: PictureCache,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl DownloadManager {
    pub fn new(app_data: PathBuf, registry: PackRegistry) -> Self {
        Self::with_settings(app_data, registry, Settings::default())
    }

    /// Tests shorten the waits; the app always uses the defaults.
    pub(crate) fn with_settings(
        app_data: PathBuf,
        registry: PackRegistry,
        settings: Settings,
    ) -> Self {
        let pace = Arc::new(Mutex::new(Pace {
            concurrency: settings.concurrency,
            delay: settings.delay,
            requests_per_minute: None,
            bytes_per_second: None,
        }));
        Self {
            lock_path: app_data.join(DOWNLOAD_LOCK_FILE),
            picture_cache: PictureCache::new(&app_data),
            pictures: Pictures::default(),
            app_data,
            registry,
            settings,
            pace,
            schedule: Mutex::new(Schedule::default()),
            lock_retry: LOCK_RETRY,
            log: ActivityLog::global(),
        }
    }

    /// Uses the computer-wide download lock in `shared` (the folder every
    /// Atlas app shares).
    #[must_use]
    pub fn with_shared_folder(mut self, shared: &Path) -> Self {
        self.lock_path = shared.join(DOWNLOAD_LOCK_FILE);
        self
    }

    /// Writes to this log instead of the app's.
    #[must_use]
    pub fn with_log(mut self, log: ActivityLog) -> Self {
        self.log = log;
        self
    }

    #[cfg(test)]
    fn with_lock_retry(mut self, retry: Duration) -> Self {
        self.lock_retry = retry;
        self
    }

    /// Applies the person's download settings, to running jobs too.
    pub fn set_download_settings(&self, settings: &DownloadSettings) {
        let pace = Pace::from_settings(settings);
        *lock(&self.pace) = pace;
        self.log.info(
            Area::Download,
            format!("Download settings are now: {}", pace.describe()),
        );
    }

    fn current_pace(&self) -> Pace {
        *lock(&self.pace)
    }

    /// Whether a pack's job is running, paused, queued or waiting.
    pub fn is_active(&self, pack_id: &str) -> bool {
        lock(&self.schedule)
            .jobs
            .get(pack_id)
            .is_some_and(|job| !job.finished)
    }

    /// The packs with a job that is not over.
    pub fn active_packs(&self) -> Vec<String> {
        lock(&self.schedule)
            .jobs
            .values()
            .filter(|job| !job.finished)
            .map(|job| job.pack_id.clone())
            .collect()
    }

    /// A pack folder the person keeps, written in place; none for bundled packs.
    fn pack_folder(&self, pack_id: &str) -> Option<PathBuf> {
        (self.registry.kind(pack_id) == Some(PackKind::Folder))
            .then(|| self.registry.root(pack_id))
            .flatten()
    }

    /// The overlay folder of every pack: `<app data>/packs`.
    pub fn overlay_root(app_data: &Path) -> PathBuf {
        app_data.join("packs")
    }

    fn store(&self, pack_id: &str) -> Result<TileStore, String> {
        let root = self
            .registry
            .root(pack_id)
            .ok_or_else(|| format!("There is no installed pack called {pack_id:?}."))?;
        if self.registry.kind(pack_id) == Some(PackKind::Folder) {
            return Ok(TileStore::new(root.clone(), Some(root)));
        }
        Ok(TileStore::new(
            Self::overlay_root(&self.app_data).join(pack_id),
            Some(root),
        ))
    }

    fn plan(&self, pack_id: &str) -> Result<(PackPlan, TileStore), String> {
        let store = self.store(pack_id)?;
        let plan = read_pack_plan(store.bundled.as_deref().expect("set by store()"))
            .map_err(|error| format!("The pack cannot be downloaded: {error}"))?;
        if plan.layers.is_empty() {
            return Err("This pack has no map images to download.".to_owned());
        }
        Ok((plan, store))
    }

    fn record_path(&self, pack_id: &str) -> PathBuf {
        match self.pack_folder(pack_id) {
            Some(folder) => folder.join(META_DIR).join(JOB_FILE),
            None => self
                .app_data
                .join("downloads")
                .join(format!("{pack_id}.json")),
        }
    }

    fn write_record(&self, record: &JobRecord) {
        let path = self.record_path(&record.pack_id);
        let write = || -> std::io::Result<()> {
            fs::create_dir_all(path.parent().expect("has a parent"))?;
            let json = serde_json::to_string_pretty(record).expect("serialises");
            fs::write(path.with_extension("json.part"), json)?;
            fs::rename(path.with_extension("json.part"), &path)
        };
        if let Err(error) = write() {
            self.log.warn(
                Area::Download,
                format!(
                    "Could not record the download job in {}: {error}",
                    path.display()
                ),
            );
        }
    }

    fn read_record(&self, pack_id: &str) -> Option<JobRecord> {
        let text = fs::read_to_string(self.record_path(pack_id)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn remove_record(&self, pack_id: &str) {
        let _ = fs::remove_file(self.record_path(pack_id));
    }

    /// A job's snapshot, with its place in the queue.
    fn snapshot_in(schedule: &Schedule, job: &Job) -> Snapshot {
        let mut snapshot = lock(&job.progress).snapshot();
        let title_of = |id: &str| {
            schedule
                .jobs
                .get(id)
                .map_or_else(|| id.to_owned(), |job| job.title.clone())
        };
        match snapshot.state {
            JobState::Queued => {
                snapshot.queue_position = schedule
                    .queue
                    .iter()
                    .position(|id| *id == job.pack_id)
                    .map(|index| index + 1);
                let ahead = schedule
                    .holder
                    .clone()
                    .or_else(|| schedule.queue.front().cloned())
                    .filter(|id| *id != job.pack_id);
                snapshot.waiting_for = ahead.map(|id| title_of(&id));
            }
            JobState::Waiting => {
                snapshot.queue_position = Some(1);
                snapshot.waiting_for = Some("another Atlas app on this computer".to_owned());
            }
            _ => {}
        }
        snapshot
    }

    /// The current or last job of a pack.
    pub fn snapshot(&self, pack_id: &str) -> Option<Snapshot> {
        let schedule = lock(&self.schedule);
        schedule
            .jobs
            .get(pack_id)
            .map(|job| Self::snapshot_in(&schedule, job))
    }

    /// Every job that is not over, in queue order.
    fn queue_entries(schedule: &Schedule) -> Vec<QueueEntry> {
        let mut order: Vec<&String> = schedule.holder.iter().collect();
        order.extend(schedule.queue.iter());
        let mut paused: Vec<&Job> = schedule
            .jobs
            .values()
            .filter(|job| !job.finished && !order.contains(&&job.pack_id))
            .collect();
        paused.sort_by(|a, b| a.title.cmp(&b.title));
        order
            .into_iter()
            .filter_map(|id| schedule.jobs.get(id))
            .chain(paused)
            .filter(|job| !job.finished)
            .map(|job| QueueEntry {
                pack_id: job.pack_id.clone(),
                title: job.title.clone(),
                state: lock(&job.progress).snapshot.state,
            })
            .collect()
    }

    /// The detail options of a pack with their sizes, and any job.
    /// Blocking: it looks at every tile on disk.
    pub fn plan_info(&self, pack_id: &str) -> Result<PlanInfo, String> {
        let (plan, store) = self.plan(pack_id)?;
        let pace = self.current_pace();
        let details = plan.details();
        let mut options = Vec::new();
        for &detail in &details {
            let (mut tiles, mut remaining, mut bytes) = (0u64, 0u64, 0u64);
            let mut installed = true;
            for layer in &plan.layers {
                let top = layer.top_for(detail);
                let (mut samples, mut sampled_bytes) = (0u64, 0u64);
                let mut layer_remaining = 0u64;
                for level in layer.remote_levels(top) {
                    for tile in layer.tiles_of(level.z) {
                        tiles += 1;
                        let path = layer.tile_path(tile.z, tile.x, tile.y);
                        if let Some(len) = store.overlay_len(&path) {
                            samples += 1;
                            sampled_bytes += len;
                        } else if !store.is_done(&path) {
                            layer_remaining += 1;
                        }
                    }
                }
                let per_tile = if samples >= 10 {
                    sampled_bytes / samples
                } else {
                    layer.format().typical_bytes()
                };
                remaining += layer_remaining;
                bytes += layer_remaining * per_tile;
                let levels = read_levels(&store.overlay, layer);
                installed &= (layer.min_zoom..=top).all(|z| levels.contains(&z));
            }
            options.push(DetailOption {
                detail,
                tiles,
                remaining,
                estimated_seconds: estimate_seconds(&pace, remaining, bytes),
                estimated_bytes: bytes,
                installed,
            });
        }
        let recommended = if details.contains(&Detail::Standard) {
            Detail::Standard
        } else {
            *details.last().expect("at least Full")
        };
        let schedule = lock(&self.schedule);
        let job = schedule
            .jobs
            .get(pack_id)
            .map(|job| Self::snapshot_in(&schedule, job));
        let active = job.as_ref().is_some_and(|job| {
            !matches!(
                job.state,
                JobState::Stopped | JobState::Cancelled | JobState::Done
            )
        });
        let busy_with = schedule
            .holder
            .as_ref()
            .filter(|id| *id != pack_id)
            .and_then(|id| schedule.jobs.get(id))
            .map(|job| job.title.clone());
        let queue = Self::queue_entries(&schedule);
        drop(schedule);
        let unfinished = if active {
            None
        } else {
            self.read_record(pack_id).map(|record| Unfinished {
                detail: record.detail,
                reason: record.stop_reason,
                stop_detail: record.stop_detail,
            })
        };
        Ok(PlanInfo {
            pack_id: pack_id.to_owned(),
            options,
            recommended,
            unfinished,
            job,
            busy_with,
            queue,
        })
    }

    /// Starts (or restarts) the download of a pack at a detail. Tiles
    /// already on disk are skipped, so this also resumes an interrupted job
    /// and upgrades to more detail without fetching anything twice. When
    /// another job is downloading, the new one queues behind it.
    pub fn start(self: &Arc<Self>, pack_id: &str, detail: Detail) -> Result<Snapshot, String> {
        let (plan, store) = self.plan(pack_id)?;
        if !plan.details().contains(&detail) && detail != Detail::Full {
            return Err("That detail level is not offered for this pack.".to_owned());
        }
        let client =
            http_client().map_err(|error| format!("Could not start downloading: {error}"))?;
        let folder = self.pack_folder(pack_id);
        let title = store
            .bundled
            .as_deref()
            .and_then(|root| read_head(root).ok())
            .map_or_else(|| pack_id.to_owned(), |head| head.title);
        let mut schedule = lock(&self.schedule);
        if let Some(job) = schedule.jobs.get(pack_id).filter(|job| !job.finished) {
            return Err(if job.paused {
                "This download is paused. Resume it instead.".to_owned()
            } else {
                "This pack is already downloading or waiting its turn.".to_owned()
            });
        }

        let mut maps: Vec<MapProgress> = plan
            .maps
            .iter()
            .map(|(id, name)| MapProgress {
                map_id: id.clone(),
                name: name.clone(),
                done: 0,
                total: 0,
            })
            .collect();
        let layer_maps: Vec<usize> = plan
            .layers
            .iter()
            .map(|layer| {
                plan.maps
                    .iter()
                    .position(|(id, _)| *id == layer.map_id)
                    .expect("every layer's map is listed")
            })
            .collect();
        for (layer, &map) in plan.layers.iter().zip(&layer_maps) {
            maps[map].total += layer.remote_tile_count(layer.top_for(detail));
        }
        let total = maps.iter().map(|map| map.total).sum();
        let pack_lock = match &folder {
            Some(folder) => Some(PackLock::acquire(folder)?),
            None => None,
        };
        let pace = self.current_pace();
        let typical_bytes: u64 = plan
            .layers
            .iter()
            .map(|layer| {
                layer.remote_tile_count(layer.top_for(detail)) * layer.format().typical_bytes()
            })
            .sum();
        let status_revision = schedule
            .jobs
            .get(pack_id)
            .map_or(0, |job| lock(&job.progress).snapshot.status_revision);
        let now = Instant::now();
        let progress = Arc::new(Mutex::new(Progress {
            snapshot: Snapshot {
                pack_id: pack_id.to_owned(),
                title: title.clone(),
                detail,
                state: JobState::Queued,
                reason: None,
                stop_detail: None,
                queue_position: None,
                waiting_for: None,
                maps,
                done: 0,
                total,
                saved: 0,
                missing: 0,
                not_asked: 0,
                failed: 0,
                bytes: 0,
                tiles_per_second: 0.0,
                bytes_per_second: 0.0,
                seconds_left: Some(estimate_seconds(&pace, total, typical_bytes)),
                status_revision,
            },
            layer_maps,
            recent: VecDeque::new(),
            started: now,
            created: now,
            logged_at: now,
            logged_done: 0,
            denied: 0,
        }));
        // Every job starts paused; the schedule lets it run when it is its turn.
        let (control, receiver) = watch::channel(Control::Pause);
        let downloader = Arc::new(
            Downloader::new(client, self.settings.clone(), store, receiver)
                .with_pace(Arc::clone(&self.pace))
                .with_log(self.log.clone()),
        );
        schedule.jobs.insert(
            pack_id.to_owned(),
            Job {
                pack_id: pack_id.to_owned(),
                title: title.clone(),
                control,
                progress: Arc::clone(&progress),
                downloader: Arc::clone(&downloader),
                finished: false,
                paused: false,
                lock: pack_lock,
            },
        );
        schedule.queue.push_back(pack_id.to_owned());
        drop(schedule);
        self.write_record(&JobRecord {
            pack_id: pack_id.to_owned(),
            detail,
            stop_reason: None,
            stop_detail: None,
        });

        let this = Arc::clone(self);
        let pack = pack_id.to_owned();
        tokio::spawn(async move {
            let counting = {
                let (plan, store) = (plan.clone(), downloader.store().clone());
                tokio::task::spawn_blocking(move || {
                    (
                        count_present(&plan, detail, &store),
                        layers_with_images(&plan, &store),
                    )
                })
            };
            let (present, with_images) = counting.await.unwrap_or_default();
            for (index, layer) in plan.layers.iter().enumerate() {
                if with_images.get(index).copied().unwrap_or(false) {
                    downloader.prove_from_disk(index, layer_host(layer));
                }
            }
            this.log_start(&pack, &plan, detail, total, present);
            let result = run_job(
                &plan,
                detail,
                &downloader,
                &progress,
                folder.as_deref(),
                &this.log,
            )
            .await;
            if let Some(folder) = &folder {
                let plan = plan.clone();
                let folder = folder.clone();
                let store = downloader.store().clone();
                let log = this.log.clone();
                // Counting every image file takes a moment for a large pack.
                let _ = tokio::task::spawn_blocking(move || {
                    record_images(&folder, &plan, &store, true, &log)
                })
                .await;
            }
            this.finish(&pack, detail, result);
        });
        self.dispatch();
        let snapshot = self.snapshot(pack_id).expect("just added");
        if snapshot.state == JobState::Queued {
            self.log.info(
                Area::Download,
                format!(
                    "Download of {title} ({pack_id}) is queued, number {} in line, behind {}",
                    snapshot.queue_position.unwrap_or(0),
                    snapshot
                        .waiting_for
                        .as_deref()
                        .unwrap_or("another download")
                ),
            );
        }
        Ok(snapshot)
    }

    /// The "download started" line: what the job covers and how it goes.
    fn log_start(&self, pack_id: &str, plan: &PackPlan, detail: Detail, total: u64, present: u64) {
        let layers = plan
            .layers
            .iter()
            .map(|layer| {
                let top = layer.top_for(detail);
                format!(
                    "{} ({}) levels {}-{} from remote zooms {}",
                    layer.layer_name,
                    layer.map_name,
                    layer.first_remote_z(),
                    top,
                    layer
                        .remote_levels(top)
                        .map(|level| level.source_z.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        let mut hosts: Vec<String> = plan.layers.iter().map(layer_host).collect();
        hosts.sort();
        hosts.dedup();
        let snapshot = self.snapshot(pack_id);
        let state = match snapshot.as_ref().map(|s| s.state) {
            Some(JobState::Running) => "downloading now".to_owned(),
            Some(JobState::Queued) => format!(
                "queued behind {}",
                snapshot
                    .as_ref()
                    .and_then(|s| s.waiting_for.clone())
                    .unwrap_or_default()
            ),
            Some(JobState::Waiting) => "waiting for another Atlas app".to_owned(),
            Some(other) => format!("{other:?}").to_lowercase(),
            None => "unknown".to_owned(),
        };
        self.log.info(
            Area::Download,
            format!(
                "Download started: {} ({pack_id}), {detail:?} detail | layers: {layers} | {total} images planned, {present} already there, {} to fetch | from {} | settings: {} | {state}",
                snapshot.as_ref().map_or(pack_id, |s| s.title.as_str()),
                total.saturating_sub(present),
                hosts.join(", "),
                self.current_pace().describe(),
            ),
        );
    }

    /// Lets the next job in line download, if none is downloading: when it
    /// can have the computer-wide lock; otherwise it waits and tries again.
    fn dispatch(self: &Arc<Self>) {
        let mut schedule = lock(&self.schedule);
        if schedule.holder.is_some() {
            return;
        }
        let next = loop {
            let Some(front) = schedule.queue.front().cloned() else {
                // Nothing to download: let other apps have their turn.
                schedule.computer = None;
                return;
            };
            if schedule
                .jobs
                .get(&front)
                .is_some_and(|job| !job.finished && !job.paused)
            {
                break front;
            }
            schedule.queue.pop_front();
        };
        if schedule.computer.is_none() {
            match self.try_computer_lock() {
                Some(computer) => schedule.computer = Some(computer),
                None => {
                    let job = schedule.jobs.get(&next).expect("checked above");
                    let mut progress = lock(&job.progress);
                    if progress.snapshot.state != JobState::Waiting {
                        progress.snapshot.state = JobState::Waiting;
                        self.log.info(
                            Area::Download,
                            format!(
                                "Download of {} waits: another Atlas app on this computer is downloading map images; trying again every {}",
                                job.title,
                                wait_text(self.lock_retry)
                            ),
                        );
                    }
                    drop(progress);
                    if !schedule.retry_pending {
                        schedule.retry_pending = true;
                        let this = Arc::clone(self);
                        let wait = self.lock_retry;
                        tokio::spawn(async move {
                            tokio::time::sleep(wait).await;
                            lock(&this.schedule).retry_pending = false;
                            this.dispatch();
                        });
                    }
                    return;
                }
            }
        }
        schedule.queue.pop_front();
        schedule.holder = Some(next.clone());
        let job = schedule.jobs.get(&next).expect("checked above");
        let mut progress = lock(&job.progress);
        let waited = progress.created.elapsed();
        let was = progress.snapshot.state;
        progress.snapshot.state = JobState::Running;
        progress.recent.clear();
        progress.started = Instant::now();
        drop(progress);
        job.control.send_replace(Control::Run);
        self.log.info(
            Area::Download,
            format!(
                "Download of {} has its turn and downloads now{} | settings: {}",
                job.title,
                match was {
                    JobState::Queued | JobState::Waiting if waited > Duration::from_millis(100) =>
                        format!(" (it was {was:?} for {})", duration_text(waited)).to_lowercase(),
                    _ => String::new(),
                },
                self.current_pace().describe()
            ),
        );
    }

    /// The cache of measured pictures, which an import's layers are seeded from.
    pub fn picture_cache(&self) -> &PictureCache {
        &self.picture_cache
    }

    /// Measures the picture of an import (see `measure`), or answers from
    /// what was learnt before when the request says `cachedOnly`. A
    /// measurement asks the server, so it only goes ahead while no download
    /// of this app or of another Atlas app on this computer is under way:
    /// the pace settings are meant for everything the computer downloads.
    /// It holds the computer-wide download lock while it runs, so a download
    /// started meanwhile waits for it. None when it cannot be measured.
    pub async fn measure_picture(&self, request: &MeasureRequest) -> Option<Measured> {
        if request.cached_only {
            // No request is made: no client or lock is needed.
            return self
                .pictures
                .measure(&self.picture_cache, request, &self.log, None)
                .await;
        }
        let client = match http_client() {
            Ok(client) => client,
            Err(error) => {
                self.log.warn(
                    Area::Download,
                    format!("Could not measure the picture of an import: {error}"),
                );
                return None;
            }
        };
        let held = {
            let schedule = lock(&self.schedule);
            match &schedule.holder {
                Some(holder) => Err(schedule
                    .jobs
                    .get(holder)
                    .map_or_else(|| holder.clone(), |job| job.title.clone())),
                None if schedule.computer.is_some() => Err("another download".to_owned()),
                None => Ok(self.try_computer_lock()),
            }
        };
        let _computer = match held {
            Ok(Some(computer)) => computer,
            Ok(None) => {
                self.log.info(
                    Area::Download,
                    "Did not measure the picture of an import: another Atlas app on this computer is downloading map images, and the computer downloads one thing at a time. The importer sizes the map without it",
                );
                return self.answer_from_page(request).await;
            }
            Err(title) => {
                self.log.info(
                    Area::Download,
                    format!("Did not measure the picture of an import: the download of {title} is under way, and the computer downloads one thing at a time. The importer sizes the map without it"),
                );
                return self.answer_from_page(request).await;
            }
        };
        let fetching = Fetching {
            client,
            settings: self.settings.clone(),
            pace: Arc::clone(&self.pace),
        };
        self.pictures
            .measure(&self.picture_cache, request, &self.log, Some(fetching))
            .await
    }

    /// When a measurement cannot ask the server: with tiles the import's
    /// page showed, those are still kept, and the answer is what is known
    /// without a request; otherwise none.
    async fn answer_from_page(&self, request: &MeasureRequest) -> Option<Measured> {
        request.page.as_ref()?;
        let cached = MeasureRequest {
            cached_only: true,
            ..request.clone()
        };
        self.pictures
            .measure(&self.picture_cache, &cached, &self.log, None)
            .await
    }

    /// Stops a measurement that is running; it ends without an answer.
    pub fn cancel_measuring(&self) {
        self.pictures.cancel();
    }

    /// The computer-wide download lock, if no other app holds it.
    fn try_computer_lock(&self) -> Option<ComputerLock> {
        let open = || -> std::io::Result<fs::File> {
            if let Some(parent) = self.lock_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&self.lock_path)
        };
        match open() {
            Ok(file) => match file.try_lock() {
                Ok(()) => Some(ComputerLock { _file: Some(file) }),
                Err(fs::TryLockError::WouldBlock) => None,
                Err(fs::TryLockError::Error(error)) => {
                    self.log.warn(
                        Area::Download,
                        format!(
                            "Cannot lock {}: {error}; downloading without the computer-wide lock",
                            self.lock_path.display()
                        ),
                    );
                    Some(ComputerLock { _file: None })
                }
            },
            Err(error) => {
                self.log.warn(
                    Area::Download,
                    format!(
                        "Cannot open {}: {error}; downloading without the computer-wide lock",
                        self.lock_path.display()
                    ),
                );
                Some(ComputerLock { _file: None })
            }
        }
    }

    fn finish(self: &Arc<Self>, pack_id: &str, detail: Detail, result: Result<(), Stop>) {
        let mut schedule = lock(&self.schedule);
        let Some(job) = schedule.jobs.get_mut(pack_id) else {
            return;
        };
        let stop_detail = job.downloader.stop_detail();
        let mut progress = lock(&job.progress);
        let duration = progress.created.elapsed();
        let counts = progress.counts();
        let snapshot = &mut progress.snapshot;
        snapshot.seconds_left = None;
        snapshot.tiles_per_second = 0.0;
        snapshot.bytes_per_second = 0.0;
        let line = match &result {
            Ok(()) => {
                snapshot.state = JobState::Done;
                if snapshot.failed > 0 {
                    snapshot.reason = Some(format!(
                        "{} map images could not be downloaded. Download again to retry them.",
                        snapshot.failed
                    ));
                }
                self.remove_record(pack_id);
                format!(
                    "Download of {} finished after {}: {counts}",
                    job.title,
                    duration_text(duration)
                )
            }
            Err(Stop::Cancelled) => {
                snapshot.state = JobState::Cancelled;
                self.remove_record(pack_id);
                format!(
                    "Download of {} cancelled after {}: {counts}",
                    job.title,
                    duration_text(duration)
                )
            }
            Err(stop) => {
                snapshot.state = JobState::Stopped;
                snapshot.reason = Some(stop.message());
                let stop_detail = stop_detail.filter(|_| {
                    matches!(
                        stop,
                        Stop::Refused(_) | Stop::WebPage | Stop::DeniedInARow(_)
                    )
                });
                snapshot.stop_detail = stop_detail.clone();
                self.write_record(&JobRecord {
                    pack_id: pack_id.to_owned(),
                    detail,
                    stop_reason: Some(stop.message()),
                    stop_detail,
                });
                format!(
                    "Download of {} stopped after {}: {} | {counts}",
                    job.title,
                    duration_text(duration),
                    stop.message()
                )
            }
        };
        drop(progress);
        job.finished = true;
        job.paused = false;
        // Lets go of the pack folder: nothing of this job keeps a file open.
        job.lock = None;
        if schedule.holder.as_deref() == Some(pack_id) {
            schedule.holder = None;
            schedule.computer = None;
        }
        schedule.queue.retain(|id| id != pack_id);
        drop(schedule);
        if result.as_ref().is_err_and(|stop| *stop != Stop::Cancelled) {
            self.log.error(Area::Download, line);
        } else {
            self.log.info(Area::Download, line);
        }
        self.dispatch();
    }

    /// Pauses a job: it stops downloading and leaves the queue, so the next
    /// job can run once its requests in flight have finished.
    pub fn pause(self: &Arc<Self>, pack_id: &str) -> Result<Snapshot, String> {
        let mut schedule = lock(&self.schedule);
        let job = schedule
            .jobs
            .get_mut(pack_id)
            .filter(|job| !job.finished)
            .ok_or_else(|| "This pack is not downloading.".to_owned())?;
        if !job.paused {
            job.paused = true;
            job.control.send_replace(Control::Pause);
            lock(&job.progress).snapshot.state = JobState::Paused;
            self.log
                .info(Area::Download, format!("Download of {} paused", job.title));
        }
        let downloader = Arc::clone(&job.downloader);
        schedule.queue.retain(|id| id != pack_id);
        let holder = schedule.holder.as_deref() == Some(pack_id);
        let snapshot = Self::snapshot_in(&schedule, &schedule.jobs[pack_id]);
        drop(schedule);
        if holder {
            // Hand over once this job's last requests have come back.
            let this = Arc::clone(self);
            let pack = pack_id.to_owned();
            tokio::spawn(async move {
                downloader.idle().await;
                {
                    let mut schedule = lock(&this.schedule);
                    let still_paused = schedule.jobs.get(&pack).is_some_and(|job| job.paused);
                    if schedule.holder.as_deref() == Some(pack.as_str()) && still_paused {
                        schedule.holder = None;
                        schedule.computer = None;
                        if !schedule.queue.is_empty() {
                            this.log.info(
                                Area::Download,
                                "The paused download lets the next one in line run",
                            );
                        }
                    }
                }
                this.dispatch();
            });
        } else {
            self.dispatch();
        }
        Ok(snapshot)
    }

    /// Resumes a paused job: at once if it still has its turn, otherwise at
    /// the back of the queue.
    pub fn resume(self: &Arc<Self>, pack_id: &str) -> Result<Snapshot, String> {
        let mut schedule = lock(&self.schedule);
        let holder = schedule.holder.as_deref() == Some(pack_id);
        let job = schedule
            .jobs
            .get_mut(pack_id)
            .filter(|job| !job.finished)
            .ok_or_else(|| "This pack is not downloading.".to_owned())?;
        if job.paused {
            job.paused = false;
            let mut progress = lock(&job.progress);
            if holder {
                progress.snapshot.state = JobState::Running;
                progress.recent.clear();
                progress.started = Instant::now();
                job.control.send_replace(Control::Run);
            } else {
                progress.snapshot.state = JobState::Queued;
            }
            drop(progress);
            self.log
                .info(Area::Download, format!("Download of {} resumed", job.title));
            if !holder {
                schedule.queue.push_back(pack_id.to_owned());
            }
        }
        drop(schedule);
        self.dispatch();
        Ok(self.snapshot(pack_id).expect("checked above"))
    }

    /// Cancels a job (running, paused, queued or waiting), or forgets an
    /// interrupted one. Tiles already downloaded are kept, so a later
    /// download continues from them.
    pub fn cancel(self: &Arc<Self>, pack_id: &str) -> Result<(), String> {
        let mut schedule = lock(&self.schedule);
        match schedule.jobs.get(pack_id).filter(|job| !job.finished) {
            Some(job) => {
                job.control.send_replace(Control::Cancel);
                self.log.info(
                    Area::Download,
                    format!("Download of {} cancelled", job.title),
                );
                schedule.queue.retain(|id| id != pack_id);
            }
            None => {
                drop(schedule);
                if self.read_record(pack_id).is_some() {
                    self.log.info(
                        Area::Download,
                        format!("The unfinished download of {pack_id} is forgotten"),
                    );
                }
                self.remove_record(pack_id);
            }
        }
        Ok(())
    }

    /// Forgets every job as if the app had ended, letting go of every lock.
    #[cfg(test)]
    fn forget_everything(&self) {
        let mut schedule = lock(&self.schedule);
        for job in schedule.jobs.values() {
            job.control.send_replace(Control::Cancel);
        }
        *schedule = Schedule::default();
    }
}

/// How many of a job's remote tiles are already on disk or known missing.
fn count_present(plan: &PackPlan, detail: Detail, store: &TileStore) -> u64 {
    plan.layers
        .iter()
        .map(|layer| {
            layer
                .remote_levels(layer.top_for(detail))
                .flat_map(|level| layer.tiles_of(level.z))
                .filter(|tile| store.is_done(&layer.tile_path(tile.z, tile.x, tile.y)))
                .count() as u64
        })
        .sum()
}

/// The host (and port) a layer's images come from.
fn layer_host(layer: &LayerPlan) -> String {
    host_of(&layer.url_template.replace(['{', '}'], ""))
}

/// For each layer, whether any of its remote tiles is an image on disk (not
/// a marker): proof that its host has sent images of it before.
fn layers_with_images(plan: &PackPlan, store: &TileStore) -> Vec<bool> {
    plan.layers
        .iter()
        .map(|layer| {
            layer.levels.iter().any(|level| {
                layer
                    .tiles_of(level.z)
                    .any(|tile| store.has_overlay_image(&layer.tile_path(tile.z, tile.x, tile.y)))
            })
        })
        .collect()
}

/// What happened to the tiles of one level, for the log.
#[derive(Clone, Default)]
struct Tally {
    saved: u64,
    present: u64,
    missing: u64,
    denied: u64,
    not_asked: u64,
    failed: u64,
    bytes: u64,
    missing_examples: Vec<String>,
    denied_examples: Vec<String>,
}

/// Downloads a pack's levels in order and builds the levels below.
async fn run_job(
    plan: &PackPlan,
    detail: Detail,
    downloader: &Arc<Downloader>,
    progress: &Arc<Mutex<Progress>>,
    folder: Option<&Path>,
    log: &ActivityLog,
) -> Result<(), Stop> {
    let store = downloader.store().clone();
    let tops: Vec<u8> = plan
        .layers
        .iter()
        .map(|layer| layer.top_for(detail))
        .collect();
    let ranks = plan
        .layers
        .iter()
        .zip(&tops)
        .map(|(layer, &top)| layer.remote_levels(top).count())
        .max()
        .unwrap_or(0);
    let labels: Vec<Arc<str>> = plan
        .layers
        .iter()
        .map(|layer| Arc::from(format!("{} ({})", layer.layer_name, layer.map_name)))
        .collect();

    for rank in 0..ranks {
        // The rank-th remote level of each layer, fetched together.
        let mut tasks = Vec::new();
        let mut levels = Vec::new();
        for (index, (layer, &top)) in plan.layers.iter().zip(&tops).enumerate() {
            let Some(level) = layer.remote_levels(top).nth(rank) else {
                continue;
            };
            levels.push((index, *level));
            let grid = layer.grid(level.z);
            // The middle of the map first, a parent's tiles together.
            tasks.extend(layer.tiles_centre_out(level).into_iter().map(|tile| {
                Task {
                    layer: index,
                    url: layer.remote_url(level, tile.x, tile.y),
                    path: layer.tile_path(tile.z, tile.x, tile.y),
                    label: Some(Arc::clone(&labels[index])),
                    place: Some(Place {
                        z: level.z,
                        source_z: level.source_z,
                        x: tile.x,
                        y: tile.y,
                        columns: grid.columns,
                        rows: grid.rows,
                    }),
                    parent: layer
                        .parent_of(level, tile.x, tile.y)
                        .map(|parent| layer.tile_path(parent.z, parent.x, parent.y)),
                }
            }));
        }
        let tallies: Arc<Mutex<HashMap<usize, Tally>>> = Arc::default();
        let on_outcome: OnOutcome = {
            let progress = Arc::clone(progress);
            let tallies = Arc::clone(&tallies);
            let log = log.clone();
            Arc::new(move |task: &Task, outcome: &Outcome| {
                {
                    let mut tallies = lock(&tallies);
                    let tally = tallies.entry(task.layer).or_default();
                    match outcome {
                        Outcome::Skipped => tally.present += 1,
                        Outcome::Saved(bytes) => {
                            tally.saved += 1;
                            tally.bytes += bytes;
                        }
                        Outcome::Missing => {
                            tally.missing += 1;
                            if tally.missing_examples.len() < MISSING_EXAMPLES {
                                tally.missing_examples.push(task.url.clone());
                            }
                        }
                        Outcome::MissingDenied => {
                            tally.denied += 1;
                            if tally.denied_examples.len() < MISSING_EXAMPLES {
                                tally.denied_examples.push(task.url.clone());
                            }
                        }
                        Outcome::NotAsked => tally.not_asked += 1,
                        Outcome::Failed(_) => tally.failed += 1,
                    }
                }
                let line = {
                    let mut progress = lock(&progress);
                    progress.record(task, outcome);
                    progress.progress_line()
                };
                if let Some(line) = line {
                    log.info(Area::Download, line);
                }
            })
        };
        let result = downloader.run(Arc::new(tasks), on_outcome).await;
        let tallies = std::mem::take(&mut *lock(&tallies));
        for (index, level) in &levels {
            let tally = tallies.get(index).cloned().unwrap_or_default();
            let layer = &plan.layers[*index];
            let images = layer.grid(level.z).tiles();
            let mut line = format!(
                "Level {} (remote zoom {}) of {} {}: {images} images, {} saved ({}), {} already there, {} not on the server (404/410), {} not on the server (the store answered \"access denied\", as it does for images that do not exist), {} not asked for, because the area above them is not on the server, {} failed",
                level.z,
                level.source_z,
                labels[*index],
                if result.is_ok() { "complete" } else { "ended early" },
                tally.saved,
                bytes_text(tally.bytes),
                tally.present,
                tally.missing,
                tally.denied,
                tally.not_asked,
                tally.failed
            );
            if !tally.missing_examples.is_empty() {
                line.push_str(&format!(
                    " | not on the server, for example: {}",
                    tally.missing_examples.join(", ")
                ));
            }
            if !tally.denied_examples.is_empty() {
                line.push_str(&format!(
                    " | answered \"access denied\", for example: {}",
                    tally.denied_examples.join(", ")
                ));
            }
            if tally.failed > 0 || result.is_err() {
                log.warn(Area::Download, line);
            } else {
                log.info(Area::Download, line);
            }
        }
        result?;

        for (index, level) in levels {
            let layer = &plan.layers[index];
            let mut finished = vec![level.z];
            if rank == 0 {
                let recorded = read_levels(&store.overlay, layer);
                let saved_here = tallies.get(&index).is_some_and(|t| t.saved > 0);
                let stale =
                    saved_here || layer.built_levels().any(|built| !recorded.contains(&built));
                if stale && layer.built_levels().next().is_some() {
                    build_levels_below(layer, &store, downloader).await?;
                    log.info(
                        Area::Download,
                        format!(
                            "Built levels {}-{} of {} by shrinking level {}",
                            layer.min_zoom,
                            level.z.saturating_sub(1),
                            labels[index],
                            level.z
                        ),
                    );
                }
                finished.extend(layer.built_levels());
            }
            add_levels(&store.overlay, layer, finished).map_err(|error| {
                log.error(
                    Area::Download,
                    format!(
                        "Could not write the status file of {}: {error}",
                        labels[index]
                    ),
                );
                Stop::Disk(error.to_string())
            })?;
            lock(progress).snapshot.status_revision += 1;
        }
        if let Some(folder) = folder {
            record_images(folder, plan, &store, false, log);
        }
    }
    // The job ended well: the store's denials since the last image were
    // images that do not exist.
    downloader.commit_pending()
}

/// Records the complete levels of each layer in the pack's manifest, and
/// with `count` the number and size of its image files.
fn record_images(
    folder: &Path,
    plan: &PackPlan,
    store: &TileStore,
    count: bool,
    log: &ActivityLog,
) {
    let updates: Vec<ImagesUpdate<'_>> = plan
        .layers
        .iter()
        .map(|layer| {
            let levels = read_levels(&store.overlay, layer);
            ImagesUpdate {
                layer_id: &layer.layer_id,
                complete: (layer.min_zoom..=layer.max_zoom).all(|z| levels.contains(&z)),
                levels: levels.into_iter().collect(),
                counts: count.then(|| count_images(folder, layer)),
            }
        })
        .collect();
    if let Err(error) = update_images(folder, &updates) {
        log.warn(
            Area::Download,
            format!(
                "Could not update the image summary in {}: {error}",
                folder.display()
            ),
        );
    }
}

/// The image files of a layer in a pack folder, and their bytes.
pub(crate) fn count_images(folder: &Path, layer: &LayerPlan) -> (u64, u64) {
    fn walk(dir: &Path, totals: &mut (u64, u64)) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&entry.path(), totals);
            } else if kind.is_file() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.ends_with(".404") && !name.ends_with(".part") {
                    totals.0 += 1;
                    totals.1 += entry.metadata().map_or(0, |m| m.len());
                }
            }
        }
    }
    let prefix = layer.url.split("{z}").next().unwrap_or_default();
    let mut totals = (0, 0);
    if let Some(relative) = relative_path(prefix.trim_end_matches('/')) {
        walk(&folder.join(relative), &mut totals);
    }
    totals
}

async fn build_levels_below(
    layer: &LayerPlan,
    store: &TileStore,
    downloader: &Arc<Downloader>,
) -> Result<(), Stop> {
    if layer.built_levels().next().is_none() {
        return Ok(());
    }
    let (layer, store) = (layer.clone(), store.clone());
    let downloader = Arc::clone(downloader);
    let finished = tokio::task::spawn_blocking(move || {
        build_lower_levels(&layer, &store, || !downloader.is_cancelled_now())
    })
    .await
    .map_err(|error| Stop::Disk(error.to_string()))?
    .map_err(Stop::Disk)?;
    if finished {
        Ok(())
    } else {
        Err(Stop::Cancelled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::ActivityLog;
    use crate::tiles::{
        download::tests::{ensure_crypto, no_such_object, Handler, MockServer, Reply},
        store::tests::TempDir,
    };
    use image::{Rgb, RgbImage};

    /// A tile whose colour encodes its remote address, so tests can tell
    /// which tile went where.
    fn coloured_tile(z: u8, x: u8, y: u8) -> Vec<u8> {
        let image = RgbImage::from_pixel(
            256,
            256,
            Rgb([z.wrapping_mul(20), x.wrapping_mul(40), y.wrapping_mul(40)]),
        );
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    /// A pack with one 1000 x 600 map whose levels 1 and 2 come from a mock
    /// server (remote zooms 4 and 5, offset by 1 and 2 tiles).
    fn write_pack(dir: &Path, server: &MockServer) {
        write_pack_at(dir, server, "/remote");
    }

    /// The same pack, with its images at `prefix` on the server.
    fn write_pack_at(dir: &Path, server: &MockServer, prefix: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":1000,"height":600}]"#,
        )
        .unwrap();
        let template = server.url(&format!("{prefix}/{{z}}/{{x}}/{{y}}.png"));
        fs::write(
            dir.join("layers.json"),
            format!(
                r#"[{{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":2,"tileSize":256,
                  "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{x}}/{{y}}.png","remote":{{
                    "urlTemplate":"{template}",
                    "levels":[{{"z":1,"sourceZ":4,"offsetX":1,"offsetY":2}},
                              {{"z":2,"sourceZ":5,"offsetX":2,"offsetY":4}}]}}}}}}]"#
            ),
        )
        .unwrap();
    }

    fn tile_server() -> Handler {
        Arc::new(|path, _| {
            let parts: Vec<u8> = path
                .trim_end_matches(".png")
                .rsplit('/')
                .take(3)
                .map(|n| n.parse().unwrap())
                .collect::<Vec<u8>>()
                .into_iter()
                .rev()
                .collect();
            Reply::image(coloured_tile(parts[0], parts[1], parts[2]))
        })
    }

    async fn wait_for(manager: &DownloadManager, pack: &str) -> Snapshot {
        for _ in 0..400 {
            let snapshot = manager.snapshot(pack).unwrap();
            if !matches!(
                snapshot.state,
                JobState::Running | JobState::Paused | JobState::Queued | JobState::Waiting
            ) {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the job did not finish");
    }

    fn manager(dir: &TempDir, pack: &Path) -> Arc<DownloadManager> {
        let registry = PackRegistry::default();
        registry.register("test", pack).unwrap();
        Arc::new(DownloadManager::with_settings(
            dir.0.join("data"),
            registry,
            Settings {
                delay: Duration::from_millis(1),
                backoff: Duration::from_millis(10),
                ..Settings::default()
            },
        ))
    }

    fn read_status(dir: &TempDir) -> serde_json::Value {
        let text = fs::read_to_string(dir.0.join("data/packs/test/offline-tiles/a.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn downloads_standard_then_upgrades_to_full() {
        ensure_crypto();
        let dir = TempDir::new("manager");
        let server = MockServer::start(tile_server()).await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let manager = manager(&dir, &pack);

        let info = manager.plan_info("test").unwrap();
        let details: Vec<Detail> = info.options.iter().map(|o| o.detail).collect();
        assert_eq!(details, vec![Detail::Standard, Detail::Full]);
        assert_eq!(info.recommended, Detail::Standard);
        // Level 1: 500 x 300 px = 2 x 2 tiles; level 2: 1000 x 600 = 4 x 3.
        assert_eq!(info.options[0].tiles, 4);
        assert_eq!(info.options[1].tiles, 16);
        assert_eq!(info.options[1].remaining, 16);
        assert!(info.options[1].estimated_seconds > 0.0);
        assert!(info.options[1].estimated_bytes > 0);
        assert!(!info.options[0].installed);

        manager.start("test", Detail::Standard).unwrap();
        let done = wait_for(&manager, "test").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        assert_eq!((done.done, done.saved, done.total), (4, 4, 4));
        assert_eq!(done.maps[0].name, "Island");
        assert_eq!(done.maps[0].done, 4);
        assert!(done.status_revision >= 1);
        assert_eq!(server.seen().len(), 4);
        // The layer's tile (1, 1, 0) is the remote tile (4, 2, 2), unchanged.
        let overlay = dir.0.join("data/packs/test/tiles/a");
        assert_eq!(
            fs::read(overlay.join("1/1/0.png")).unwrap(),
            coloured_tile(4, 2, 2)
        );
        // Level 0 was built from level 1.
        let built = image::open(overlay.join("0/0/0.png")).unwrap().to_rgb8();
        assert_eq!(built.dimensions(), (256, 256));
        assert_eq!(built.get_pixel(10, 10).0, [80, 40, 80]);
        let status = read_status(&dir);
        assert_eq!(status["levels"], serde_json::json!([0, 1]));
        assert_eq!(status["nativeMaxZoom"], 1);
        assert_eq!(status["complete"], false);
        assert!(
            !manager.record_path("test").exists(),
            "a finished job is forgotten"
        );
        let info = manager.plan_info("test").unwrap();
        assert!(info.options[0].installed);
        assert_eq!(info.options[1].remaining, 12);

        // Full detail fetches only the top level.
        manager.start("test", Detail::Full).unwrap();
        let done = wait_for(&manager, "test").await;
        assert_eq!(done.state, JobState::Done);
        assert_eq!((done.saved, done.done, done.total), (12, 16, 16));
        assert_eq!(server.seen().len(), 16);
        assert_eq!(
            fs::read(overlay.join("2/3/2.png")).unwrap(),
            coloured_tile(5, 5, 6)
        );
        let status = read_status(&dir);
        assert_eq!(status["levels"], serde_json::json!([0, 1, 2]));
        assert_eq!(status["complete"], true);
        assert!(manager.plan_info("test").unwrap().options[1].installed);
        // Nothing was written into the pack folder.
        assert!(!pack.join("tiles").exists());
    }

    /// A source that names its images by zoom, row, column: the pack says so
    /// in both templates, and every image is saved under the address it was
    /// fetched from.
    #[tokio::test(flavor = "multi_thread")]
    async fn follows_templates_with_the_row_before_the_column() {
        ensure_crypto();
        let dir = TempDir::new("manager-row-first");
        // The colour encodes the address as the server reads it: z, row, column.
        let server = MockServer::start(Arc::new(|path, _| {
            let parts: Vec<u8> = path
                .trim_end_matches(".png")
                .rsplit('/')
                .take(3)
                .map(|n| n.parse().unwrap())
                .collect();
            let (column, row, z) = (parts[0], parts[1], parts[2]);
            Reply::image(coloured_tile(z, column, row))
        }))
        .await;
        let pack = dir.0.join("pack");
        fs::create_dir_all(&pack).unwrap();
        fs::write(
            pack.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":1000,"height":600}]"#,
        )
        .unwrap();
        let template = server.url("/remote/{z}/{y}/{x}.png");
        fs::write(
            pack.join("layers.json"),
            format!(
                r#"[{{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":2,"tileSize":256,
                  "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{y}}/{{x}}.png","remote":{{
                    "urlTemplate":"{template}",
                    "levels":[{{"z":1,"sourceZ":4,"offsetX":1,"offsetY":2}},
                              {{"z":2,"sourceZ":5,"offsetX":2,"offsetY":4}}]}}}}}}]"#
            ),
        )
        .unwrap();
        let manager = manager(&dir, &pack);
        manager.start("test", Detail::Standard).unwrap();
        let done = wait_for(&manager, "test").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        let mut seen: Vec<String> = server.seen().into_iter().map(|s| s.path).collect();
        seen.sort();
        assert_eq!(
            seen,
            [
                "/remote/4/2/1.png",
                "/remote/4/2/2.png",
                "/remote/4/3/1.png",
                "/remote/4/3/2.png"
            ]
        );
        // The layer's tile in column 0, row 1 is the remote tile in column 1,
        // row 3, saved as `1/<row>/<column>.png`.
        let overlay = dir.0.join("data/packs/test/tiles/a");
        assert_eq!(
            fs::read(overlay.join("1/1/0.png")).unwrap(),
            coloured_tile(4, 1, 3)
        );
        assert_eq!(
            fs::read(overlay.join("1/0/1.png")).unwrap(),
            coloured_tile(4, 2, 2)
        );
        // Level 0 has each of them in its own quarter: top right, bottom left.
        let built = image::open(overlay.join("0/0/0.png")).unwrap().to_rgb8();
        assert_eq!(built.get_pixel(10, 10).0, [80, 40, 80]);
        assert_eq!(built.get_pixel(200, 10).0, [80, 80, 80]);
        assert_eq!(built.get_pixel(10, 200).0, [80, 40, 120]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn downloads_into_a_pack_folder_in_place() {
        ensure_crypto();
        let dir = TempDir::new("manager-folder");
        let server = MockServer::start(tile_server()).await;
        let pack = dir.0.join("maps/Test pack ü");
        write_pack(&pack, &server);
        fs::write(
            pack.join("manifest.json"),
            r#"{"schemaVersion":2,"gameId":"test","title":"T","packVersion":"1.0.0","gamePatch":"1","attribution":[],"idMigrations":{},
               "contents":{"counts":{"maps":1,"layers":1,"locations":0,"categories":0,"regions":0,"guides":0},
               "maps":[{"id":"t:map:a","name":"Island","width":1000,"height":600,"locations":0,
               "layers":[{"id":"t:layer:a","name":"Surface","minZoom":0,"maxZoom":2,"tiles":"xyz","downloadable":true}]}]}}"#,
        )
        .unwrap();
        let registry = PackRegistry::default();
        registry.register_folder("test", &pack).unwrap();
        let manager = Arc::new(DownloadManager::with_settings(
            dir.0.join("data"),
            registry,
            Settings {
                delay: Duration::from_millis(1),
                ..Settings::default()
            },
        ));
        manager.start("test", Detail::Standard).unwrap();
        // The pack folder is locked while the job runs.
        assert!(crate::library::PackLock::acquire(&pack).is_err());
        let done = wait_for(&manager, "test").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        assert!(crate::library::PackLock::acquire(&pack).is_ok());
        assert_eq!(
            fs::read(pack.join("tiles/a/1/1/0.png")).unwrap(),
            coloured_tile(4, 2, 2)
        );
        assert!(pack.join("offline-tiles/a.json").exists());
        assert!(
            !dir.0.join("data/packs").exists(),
            "no overlay for a pack folder"
        );
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(pack.join("manifest.json")).unwrap()).unwrap();
        let images = &manifest["contents"]["maps"][0]["layers"][0]["images"];
        assert_eq!(images["levels"], serde_json::json!([0, 1]));
        assert_eq!(images["complete"], false);
        assert_eq!(images["files"], 5, "4 downloaded and 1 built");
        assert!(images["bytes"].as_u64().unwrap() > 0);

        // An unfinished job is recorded in the pack folder, so it travels with it.
        let server_403 = MockServer::start(Arc::new(|_, _| Reply::status(403))).await;
        write_pack(&pack, &server_403);
        manager.start("test", Detail::Full).unwrap();
        assert_eq!(wait_for(&manager, "test").await.state, JobState::Stopped);
        assert!(pack.join(".atlas/download-job.json").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn estimates_follow_the_download_settings() {
        ensure_crypto();
        let dir = TempDir::new("manager-pace");
        let server = MockServer::start(tile_server()).await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let manager = manager(&dir, &pack);
        let fast = manager.plan_info("test").unwrap().options[1].estimated_seconds;
        manager.set_download_settings(&DownloadSettings {
            parallel: 1,
            pause_ms: 5000,
            requests_per_minute: None,
            kilobytes_per_second: None,
        });
        let slow = manager.plan_info("test").unwrap().options[1].estimated_seconds;
        assert!(slow > fast * 5.0, "{fast} -> {slow}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stopped_job_is_offered_again() {
        ensure_crypto();
        let dir = TempDir::new("manager-stop");
        let server = MockServer::start(Arc::new(|_, _| Reply::status(403))).await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let manager = manager(&dir, &pack);
        manager.start("test", Detail::Full).unwrap();
        let stopped = wait_for(&manager, "test").await;
        assert_eq!(stopped.state, JobState::Stopped);
        assert!(stopped.reason.unwrap().contains("refused access"));

        // After a restart (a new manager), the job is offered again.
        let restarted = self::manager(&dir, &pack);
        let info = restarted.plan_info("test").unwrap();
        let unfinished = info.unfinished.unwrap();
        assert_eq!(unfinished.detail, Detail::Full);
        assert!(unfinished.reason.unwrap().contains("refused access"));
        restarted.cancel("test").unwrap();
        assert!(restarted.plan_info("test").unwrap().unfinished.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pauses_resumes_and_cancels_a_job() {
        ensure_crypto();
        let dir = TempDir::new("manager-control");
        let base = tile_server();
        let server = MockServer::start(Arc::new(move |path, count| {
            base(path, count).delayed(Duration::from_millis(60))
        }))
        .await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let manager = manager(&dir, &pack);
        manager.start("test", Detail::Full).unwrap();
        assert!(
            manager.start("test", Detail::Full).is_err(),
            "one job at a time"
        );

        let paused = manager.pause("test").unwrap();
        assert_eq!(paused.state, JobState::Paused);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let count = server.seen().len();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(server.seen().len(), count, "no requests while paused");
        // An interrupted job is recorded while it runs or is paused.
        assert!(manager.record_path("test").exists());

        manager.resume("test").unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        manager.cancel("test").unwrap();
        let cancelled = wait_for(&manager, "test").await;
        assert_eq!(cancelled.state, JobState::Cancelled);
        assert!(cancelled.done < 16);
        assert!(!manager.record_path("test").exists());
        assert!(manager.pause("test").is_err());
    }

    /// Two packs, `one` and `two`, whose images come from `/one/…` and
    /// `/two/…` on the server.
    fn two_packs(dir: &TempDir, server: &MockServer, data: &str) -> Arc<DownloadManager> {
        let registry = PackRegistry::default();
        for id in ["one", "two"] {
            let pack = dir.0.join(id);
            write_pack_at(&pack, server, &format!("/{id}"));
            registry.register(id, &pack).unwrap();
        }
        Arc::new(
            DownloadManager::with_settings(
                dir.0.join(data),
                registry,
                Settings {
                    delay: Duration::from_millis(1),
                    ..Settings::default()
                },
            )
            .with_shared_folder(&dir.0.join("shared"))
            .with_lock_retry(Duration::from_millis(100))
            .with_log(ActivityLog::new(dir.0.join("logs"), "Atlas", "0.3.1")),
        )
    }

    fn slow_tiles(delay: Duration) -> Handler {
        let base = tile_server();
        Arc::new(move |path, count| base(path, count).delayed(delay))
    }

    /// When the requests for a pack's images came in.
    fn times(server: &MockServer, pack: &str) -> Vec<Instant> {
        let prefix = format!("/{pack}/");
        server
            .seen()
            .into_iter()
            .filter(|seen| seen.path.starts_with(&prefix))
            .map(|seen| seen.at)
            .collect()
    }

    fn logged(dir: &TempDir) -> String {
        fs::read_to_string(dir.0.join("logs").join(crate::activity::LOG_FILE)).unwrap_or_default()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refusal_is_recorded_with_the_job_and_offered_again() {
        ensure_crypto();
        let dir = TempDir::new("manager-refusal");
        let base = tile_server();
        // Level 1 (remote zoom 4) downloads; level 2 (remote zoom 5) is
        // refused, with a store's error that does not mean "no such image".
        let server = MockServer::start(Arc::new(move |path, count| {
            if path.starts_with("/remote/5/") {
                Reply {
                    body: b"<Error><Code>AllAccessDisabled</Code></Error>".to_vec(),
                    ..Reply::status(403)
                }
                .header("Content-Type", "application/xml")
            } else {
                base(path, count)
            }
        }))
        .await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let registry = PackRegistry::default();
        registry.register("test", &pack).unwrap();
        let manager = Arc::new(
            DownloadManager::with_settings(
                dir.0.join("data"),
                registry,
                Settings {
                    delay: Duration::from_millis(1),
                    ..Settings::default()
                },
            )
            .with_log(ActivityLog::new(dir.0.join("logs"), "Atlas", "0.3.1")),
        );
        manager.start("test", Detail::Full).unwrap();
        let stopped = wait_for(&manager, "test").await;
        assert_eq!(stopped.state, JobState::Stopped);
        // Four images of level 1, then the first refusal of level 2 (two in flight at most).
        let requests = server.seen().len();
        assert!((5..=6).contains(&requests), "{requests}");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(server.seen().len(), requests, "nothing after the refusal");
        let detail = stopped.stop_detail.unwrap();
        assert_eq!(detail.status, 403);
        assert!(detail.url.starts_with(&server.url("/remote/5/")));
        assert_eq!(detail.saved_before, 4);
        assert_eq!(detail.saved_from_host, 4);
        assert_eq!(detail.layer.as_deref(), Some("Surface (Island)"));
        let place = detail.place.unwrap();
        assert_eq!(
            (place.z, place.source_z, place.columns, place.rows),
            (2, 5, 4, 3)
        );
        assert_eq!(
            detail.body.as_deref(),
            Some("<Error><Code>AllAccessDisabled</Code></Error>")
        );

        // The record keeps it, so a restarted app shows it again.
        let record = fs::read_to_string(manager.record_path("test")).unwrap();
        assert!(record.contains("\"stopDetail\""), "{record}");
        let restarted = self::manager(&dir, &pack);
        let unfinished = restarted.plan_info("test").unwrap().unfinished.unwrap();
        assert_eq!(unfinished.stop_detail, Some(detail.clone()));

        let log = logged(&dir);
        assert!(
            log.contains("Download started: test (test), Full detail"),
            "{log}"
        );
        assert!(log.contains("16 images planned, 0 already there, 16 to fetch"));
        assert!(
            log.contains("Level 1 (remote zoom 4) of Surface (Island) complete: 4 images, 4 saved")
        );
        assert!(log.contains(&format!(
            "Stopped: the server refused access (HTTP 403) for {}",
            detail.url
        )));
        assert!(log.contains("this job had saved 4 images before it, 4 of them from"));
        assert!(log.contains("Download of test stopped after"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn downloads_one_pack_at_a_time_in_order() {
        ensure_crypto();
        let dir = TempDir::new("manager-queue");
        let delay = Duration::from_millis(40);
        let server = MockServer::start(slow_tiles(delay)).await;
        let manager = two_packs(&dir, &server, "data");
        let first = manager.start("one", Detail::Full).unwrap();
        assert_eq!(first.state, JobState::Running);
        let second = manager.start("two", Detail::Full).unwrap();
        assert_eq!(second.state, JobState::Queued);
        assert_eq!(second.queue_position, Some(1));
        assert_eq!(second.waiting_for.as_deref(), Some("one"));
        let info = manager.plan_info("two").unwrap();
        assert_eq!(info.busy_with.as_deref(), Some("one"));
        let order: Vec<(&str, JobState)> = info
            .queue
            .iter()
            .map(|entry| (entry.pack_id.as_str(), entry.state))
            .collect();
        assert_eq!(
            order,
            vec![("one", JobState::Running), ("two", JobState::Queued)]
        );
        // A queued job is recorded, so it is offered again after a restart.
        assert!(manager.record_path("two").exists());

        assert_eq!(wait_for(&manager, "one").await.state, JobState::Done);
        assert_eq!(wait_for(&manager, "two").await.state, JobState::Done);
        let (one, two) = (times(&server, "one"), times(&server, "two"));
        assert_eq!((one.len(), two.len()), (16, 16));
        let last_one = *one.iter().max().unwrap();
        let first_two = *two.iter().min().unwrap();
        assert!(
            first_two >= last_one + delay - Duration::from_millis(5),
            "the second pack started {:?} after the first one's last request",
            first_two.saturating_duration_since(last_one)
        );
        let log = logged(&dir);
        assert!(log.contains("Download of two (two) is queued, number 1 in line, behind one"));
        assert!(log.contains("has its turn and downloads now (it was queued for"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_queued_job_can_be_cancelled() {
        ensure_crypto();
        let dir = TempDir::new("manager-queue-cancel");
        let server = MockServer::start(slow_tiles(Duration::from_millis(30))).await;
        let manager = two_packs(&dir, &server, "data");
        manager.start("one", Detail::Full).unwrap();
        manager.start("two", Detail::Full).unwrap();
        manager.cancel("two").unwrap();
        assert_eq!(wait_for(&manager, "two").await.state, JobState::Cancelled);
        assert!(!manager.record_path("two").exists());
        assert!(manager.plan_info("one").unwrap().queue.len() == 1);
        assert_eq!(wait_for(&manager, "one").await.state, JobState::Done);
        assert!(
            times(&server, "two").is_empty(),
            "the cancelled job asked for nothing"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pausing_lets_the_next_job_run() {
        ensure_crypto();
        let dir = TempDir::new("manager-queue-pause");
        let delay = Duration::from_millis(40);
        let server = MockServer::start(slow_tiles(delay)).await;
        let manager = two_packs(&dir, &server, "data");
        manager.start("one", Detail::Full).unwrap();
        manager.start("two", Detail::Full).unwrap();
        while manager.snapshot("one").unwrap().done < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let paused_at = Instant::now();
        assert_eq!(manager.pause("one").unwrap().state, JobState::Paused);
        // The second job starts once the first one's requests are back.
        for _ in 0..100 {
            if manager.snapshot("two").unwrap().state == JobState::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(manager.snapshot("two").unwrap().state, JobState::Running);
        // Resuming puts the first job at the back of the queue.
        let resumed = manager.resume("one").unwrap();
        assert_eq!(resumed.state, JobState::Queued);
        assert_eq!(resumed.waiting_for.as_deref(), Some("two"));
        assert_eq!(wait_for(&manager, "two").await.state, JobState::Done);
        assert_eq!(wait_for(&manager, "one").await.state, JobState::Done);
        // No request of the first job was in flight while the second ran.
        let one_after_pause: Vec<Instant> = times(&server, "one")
            .into_iter()
            .filter(|at| *at > paused_at)
            .collect();
        let two = times(&server, "two");
        let (two_first, two_last) = (*two.iter().min().unwrap(), *two.iter().max().unwrap());
        assert!(one_after_pause
            .iter()
            .all(|at| *at + delay <= two_first + Duration::from_millis(5)
                || *at >= two_last + delay - Duration::from_millis(5)));
        assert_eq!(times(&server, "one").len(), 16);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_apps_take_turns_with_the_computer_wide_lock() {
        ensure_crypto();
        let dir = TempDir::new("manager-two-apps");
        let delay = Duration::from_millis(40);
        let server = MockServer::start(slow_tiles(delay)).await;
        // Two apps: their own app data, the same shared folder.
        let viewer = two_packs(&dir, &server, "viewer");
        let other = two_packs(&dir, &server, "other");
        assert_eq!(
            viewer.start("one", Detail::Full).unwrap().state,
            JobState::Running
        );
        let waiting = other.start("two", Detail::Full).unwrap();
        assert_eq!(waiting.state, JobState::Waiting);
        assert_eq!(
            waiting.waiting_for.as_deref(),
            Some("another Atlas app on this computer")
        );
        assert_eq!(wait_for(&viewer, "one").await.state, JobState::Done);
        assert_eq!(wait_for(&other, "two").await.state, JobState::Done);
        let (one, two) = (times(&server, "one"), times(&server, "two"));
        assert_eq!((one.len(), two.len()), (16, 16));
        assert!(
            *two.iter().min().unwrap()
                >= *one.iter().max().unwrap() + delay - Duration::from_millis(5)
        );
        // The lock is free again: the viewer can download at once.
        fs::remove_dir_all(dir.0.join("one/tiles")).ok();
        let again = viewer.start("one", Detail::Full).unwrap();
        assert_eq!(again.state, JobState::Running);
        assert!(logged(&dir)
            .contains("waits: another Atlas app on this computer is downloading map images"));
        viewer.cancel("one").unwrap();
        wait_for(&viewer, "one").await;
    }

    #[test]
    fn running_and_queued_jobs_are_offered_again_after_a_restart() {
        ensure_crypto();
        let dir = TempDir::new("manager-restart");
        let main = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let first = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let server = main.block_on(MockServer::start(slow_tiles(Duration::from_millis(60))));
        let before = two_packs(&dir, &server, "data");
        {
            let _context = first.enter();
            before.start("one", Detail::Full).unwrap();
            before.start("two", Detail::Full).unwrap();
        }
        main.block_on(async {
            while before.snapshot("one").unwrap().saved < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        assert_eq!(before.snapshot("two").unwrap().state, JobState::Queued);
        // The app closes: its tasks end and its locks go with it.
        first.shutdown_background();
        before.forget_everything();
        drop(before);

        let after = two_packs(&dir, &server, "data");
        main.block_on(async {
            for id in ["one", "two"] {
                let unfinished = after.plan_info(id).unwrap().unfinished.unwrap();
                assert_eq!(unfinished.detail, Detail::Full);
                assert_eq!(unfinished.reason, None);
            }
            assert_eq!(
                after.start("one", Detail::Full).unwrap().state,
                JobState::Running
            );
            assert_eq!(
                after.start("two", Detail::Full).unwrap().state,
                JobState::Queued
            );
            assert_eq!(wait_for(&after, "one").await.state, JobState::Done);
            assert_eq!(wait_for(&after, "two").await.state, JobState::Done);
        });
        assert!(!after.record_path("one").exists());
        assert!(!after.record_path("two").exists());
        // Images saved before the restart were not fetched again (one in flight may be).
        let one = main.block_on(async { times(&server, "one").len() });
        assert!(one <= 16 + 2, "{one}");
    }

    #[test]
    fn refuses_unknown_packs() {
        let dir = TempDir::new("manager-unknown");
        let manager = DownloadManager::new(dir.0.clone(), PackRegistry::default());
        assert!(manager.plan_info("nope").is_err());
    }

    /// A pack with one 1536 x 1536 map: level 1 has 3 x 3 tiles (remote
    /// zoom 4, offset 1 and 2), level 2 has 6 x 6 (remote zoom 5, offset 2
    /// and 4), so level 2 tile (x, y) lies under level 1 tile (x / 2, y / 2).
    fn write_square_pack(dir: &Path, server: &MockServer) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":1536,"height":1536}]"#,
        )
        .unwrap();
        let template = server.url("/remote/{z}/{x}/{y}.png");
        fs::write(
            dir.join("layers.json"),
            format!(
                r#"[{{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":2,"tileSize":256,
                  "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{x}}/{{y}}.png","remote":{{
                    "urlTemplate":"{template}",
                    "levels":[{{"z":1,"sourceZ":4,"offsetX":1,"offsetY":2}},
                              {{"z":2,"sourceZ":5,"offsetX":2,"offsetY":4}}]}}}}}}]"#
            ),
        )
        .unwrap();
    }

    fn logged_manager(dir: &TempDir, pack: &Path) -> Arc<DownloadManager> {
        let registry = PackRegistry::default();
        registry.register("test", pack).unwrap();
        Arc::new(
            DownloadManager::with_settings(
                dir.0.join("data"),
                registry,
                Settings {
                    delay: Duration::from_millis(1),
                    ..Settings::default()
                },
            )
            .with_log(ActivityLog::new(dir.0.join("logs"), "Atlas", "0.3.2")),
        )
    }

    fn missing_marker(dir: &TempDir, z: u8, x: u8, y: u8) -> bool {
        dir.0
            .join(format!("data/packs/test/tiles/a/{z}/{x}/{y}.png.404"))
            .is_file()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn asks_for_the_middle_first_and_never_below_missing_tiles() {
        ensure_crypto();
        let dir = TempDir::new("manager-centre");
        let base = tile_server();
        // Level 1: the top-left corner (0, 0) answers 404; the bottom-right
        // corner (2, 2) answers like a store without the image.
        let server = MockServer::start(Arc::new(move |path, count| match path {
            "/remote/4/1/2.png" => Reply::status(404),
            "/remote/4/3/4.png" => no_such_object(),
            _ => base(path, count),
        }))
        .await;
        let pack = dir.0.join("pack");
        write_square_pack(&pack, &server);
        let manager = logged_manager(&dir, &pack);
        manager.start("test", Detail::Full).unwrap();
        let done = wait_for(&manager, "test").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);

        let asked: Vec<String> = server.seen().into_iter().map(|s| s.path).collect();
        // The middle of level 1 first (two requests go out together, so
        // either may arrive first), all of level 1 before level 2, and the
        // middle of level 2 first.
        assert!(
            asked[..2].contains(&"/remote/4/2/3.png".to_owned()),
            "{asked:?}"
        );
        assert!(asked[..9].iter().all(|path| path.starts_with("/remote/4/")));
        assert!(
            asked[9..11].contains(&"/remote/5/4/6.png".to_owned()),
            "{asked:?}"
        );
        // Level 2 tiles under the two missing ones are never asked for.
        for x in 0..2 {
            for y in 0..2 {
                for (lx, ly) in [(x, y), (x + 4, y + 4)] {
                    let path = format!("/remote/5/{}/{}.png", lx + 2, ly + 4);
                    assert!(!asked.contains(&path), "{path} was asked for");
                    assert!(missing_marker(&dir, 2, lx, ly), "{lx},{ly} is not marked");
                }
            }
        }
        assert_eq!(asked.len(), 9 + 36 - 8);
        let mut distinct = asked.clone();
        distinct.sort();
        distinct.dedup();
        assert_eq!(distinct.len(), asked.len(), "nothing asked for twice");
        assert!(missing_marker(&dir, 1, 0, 0) && missing_marker(&dir, 1, 2, 2));
        assert_eq!(
            (done.saved, done.missing, done.not_asked, done.failed),
            (35, 2, 8, 0)
        );
        assert_eq!((done.done, done.total), (45, 45));

        let log = logged(&dir);
        assert!(
            log.contains("Level 1 (remote zoom 4) of Surface (Island) complete: 9 images, 7 saved"),
            "{log}"
        );
        assert!(log.contains("1 not on the server (404/410), 1 not on the server (the store answered \"access denied\", as it does for images that do not exist), 0 not asked for"));
        assert!(
            log.contains("28 saved")
                && log
                    .contains("8 not asked for, because the area above them is not on the server")
        );
        assert!(log.contains(&format!(
            "answered \"access denied\", for example: {}",
            server.url("/remote/4/3/4.png")
        )));
        assert!(log.contains("2 not on the server (1 of them answered \"access denied\" by the store, as it does for images that do not exist), 8 not asked for because the area above them is not on the server, 0 failed"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_picture_is_not_measured_while_a_download_is_under_way() {
        use crate::tiles::measure::MeasureRequest;
        ensure_crypto();
        let dir = TempDir::new("manager-measure-busy");
        let base = tile_server();
        let server = MockServer::start(Arc::new(move |path, count| {
            base(path, count).delayed(Duration::from_millis(100))
        }))
        .await;
        let pack = dir.0.join("pack");
        write_square_pack(&pack, &server);
        let manager = logged_manager(&dir, &pack);
        let request = MeasureRequest {
            url_template: server.url("/remote/{z}/{x}/{y}.png"),
            zoom: 4,
            start: [2, 3],
            cached_only: false,
            page: None,
        };
        manager.start("test", Detail::Full).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let asked = server.seen().len();
        assert_eq!(manager.measure_picture(&request).await, None);
        assert!(
            logged(&dir).contains("is under way, and the computer downloads one thing at a time")
        );
        manager.cancel("test").unwrap();
        // No request of the measurement reached the server.
        assert!(server.seen().len() <= asked + 2);
        assert!(!dir.0.join("data/measured").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn what_a_page_showed_is_kept_while_a_download_is_under_way() {
        use crate::tiles::measure::{MeasureRequest, PageTiles};
        ensure_crypto();
        let dir = TempDir::new("manager-measure-busy-page");
        let base = tile_server();
        let server = MockServer::start(Arc::new(move |path, count| {
            base(path, count).delayed(Duration::from_millis(100))
        }))
        .await;
        let pack = dir.0.join("pack");
        write_square_pack(&pack, &server);
        let manager = logged_manager(&dir, &pack);
        let request = MeasureRequest {
            url_template: server.url("/remote/{z}/{x}/{y}.png"),
            zoom: 4,
            start: [2, 3],
            cached_only: false,
            page: Some(PageTiles {
                present: vec![[2, 3]],
                absent: vec![
                    [1, 2],
                    [2, 2],
                    [3, 2],
                    [1, 3],
                    [3, 3],
                    [1, 4],
                    [2, 4],
                    [3, 4],
                ],
            }),
        };
        manager.start("test", Detail::Full).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let asked = server.seen().len();
        let answer = manager.measure_picture(&request).await.expect("an answer");
        manager.cancel("test").unwrap();
        assert_eq!(answer.present, [[2, 3]]);
        assert!(answer.complete);
        assert_eq!(answer.from_page, 1);
        assert!(server.seen().len() <= asked + 2);
        assert!(logged(&dir).contains("Kept what the import's page showed of the picture"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_store_denial_first_still_stops_the_job() {
        ensure_crypto();
        let dir = TempDir::new("manager-store-first");
        let server = MockServer::start(Arc::new(|_, _| no_such_object())).await;
        let pack = dir.0.join("pack");
        write_square_pack(&pack, &server);
        let manager = logged_manager(&dir, &pack);
        manager.start("test", Detail::Full).unwrap();
        let stopped = wait_for(&manager, "test").await;
        assert_eq!(stopped.state, JobState::Stopped);
        assert_eq!(stopped.reason, Some(Stop::Refused(403).message()));
        let asked: Vec<String> = server.seen().into_iter().map(|s| s.path).collect();
        assert!(asked.len() <= 2, "{asked:?}");
        assert!(asked.contains(&"/remote/4/2/3.png".to_owned()), "{asked:?}");
        let detail = stopped.stop_detail.unwrap();
        assert!(asked.iter().any(|path| detail.url == server.url(path)));
        assert_eq!((detail.saved_before, detail.denied_in_a_row), (0, None));
        assert_eq!(stopped.missing, 0);
        assert!(!missing_marker(&dir, 1, 1, 1));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn images_on_disk_prove_the_host_after_a_restart() {
        ensure_crypto();
        let dir = TempDir::new("manager-store-resume");
        let base = tile_server();
        // The first tile of level 2 to be asked for is not on the store; the
        // second, asked for at the same time, is slow, so no image of this
        // download arrives before the denial.
        let server = MockServer::start(Arc::new(move |path, count| match path {
            "/remote/5/4/6.png" => no_such_object(),
            "/remote/5/5/6.png" => base(path, count).delayed(Duration::from_millis(300)),
            _ => base(path, count),
        }))
        .await;
        let pack = dir.0.join("pack");
        write_square_pack(&pack, &server);
        let first = logged_manager(&dir, &pack);
        first.start("test", Detail::Standard).unwrap();
        assert_eq!(wait_for(&first, "test").await.state, JobState::Done);
        assert_eq!(server.seen().len(), 9);

        // After a restart, only level 2 is fetched: no image comes before
        // the denial, but the images on disk prove the host.
        let restarted = logged_manager(&dir, &pack);
        restarted.start("test", Detail::Full).unwrap();
        let done = wait_for(&restarted, "test").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        let asked: Vec<String> = server.seen().into_iter().map(|s| s.path).collect();
        assert!(
            asked[9..11].contains(&"/remote/5/4/6.png".to_owned()),
            "{asked:?}"
        );
        assert_eq!((done.saved, done.missing), (35, 1));
        assert!(missing_marker(&dir, 2, 2, 2));
        assert!(logged(&dir).contains("images of this layer from it are on disk"));
    }

    /// The pack of [`a_layer_that_grows_keeps_its_images_and_fetches_only_the_new_ones`]:
    /// one layer of `tiles` x `tiles` tiles at the top level, with the
    /// remote levels given as (z, sourceZ, offset).
    fn write_grown_pack(dir: &Path, server: &MockServer, tiles: u32, levels: &[(u8, u8, u64)]) {
        fs::create_dir_all(dir).unwrap();
        let size = tiles * 256;
        fs::write(
            dir.join("maps.json"),
            format!(r#"[{{"id":"t:map:a","name":"Island","width":{size},"height":{size}}}]"#),
        )
        .unwrap();
        let template = server.url("/remote/{z}/{x}/{y}.png");
        let max_zoom = levels.last().unwrap().0;
        let levels: Vec<String> = levels
            .iter()
            .map(|(z, source, offset)| {
                format!(r#"{{"z":{z},"sourceZ":{source},"offsetX":{offset},"offsetY":{offset}}}"#)
            })
            .collect();
        fs::write(
            dir.join("layers.json"),
            format!(
                r#"[{{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":{max_zoom},"tileSize":256,
                  "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{x}}/{{y}}.png","remote":{{
                    "urlTemplate":"{template}","levels":[{}]}}}}}}]"#,
                levels.join(",")
            ),
        )
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_layer_that_grows_keeps_its_images_and_fetches_only_the_new_ones() {
        use crate::tiles::{
            measure::{seed_layers, MeasureRequest},
            renumber,
        };
        ensure_crypto();
        let dir = TempDir::new("manager-grown");
        // The server's picture is the remote zoom 5 tiles 8-11 x 8-10 (so
        // zoom 4 tiles 4-5 x 4-5 and the one zoom 3 tile 2, 2); everything
        // else it answers like a store without the image.
        let server = MockServer::start(Arc::new(|path, _| {
            let parts: Vec<u64> = path
                .trim_end_matches(".png")
                .rsplit('/')
                .take(3)
                .map(|n| n.parse().unwrap())
                .collect();
            let (z, x, y) = (parts[2], parts[1], parts[0]);
            let shift = 5 - z;
            if (8 >> shift..=11 >> shift).contains(&x) && (8 >> shift..=10 >> shift).contains(&y) {
                Reply::image(coloured_tile(z as u8, x as u8, y as u8))
            } else {
                no_such_object()
            }
        }))
        .await;
        let pack = dir.0.join("pack");
        let root = dir.0.join("data/packs/test");
        let tile = |z: u8, x: u8, y: u8| root.join(format!("tiles/a/{z}/{x}/{y}.png"));

        // The first version of the pack ends its image around the places:
        // zoom 5 tiles 8-10 x 8-10, without the last column of the picture.
        write_grown_pack(&pack, &server, 3, &[(1, 4, 4), (2, 5, 8)]);
        let before = read_pack_plan(&pack).unwrap();
        let first = logged_manager(&dir, &pack);
        first.start("test", Detail::Full).unwrap();
        let done = wait_for(&first, "test").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        assert_eq!((done.saved, done.missing), (4 + 9, 0));
        assert_eq!(server.seen().len(), 13);
        assert_eq!(fs::read(tile(2, 2, 1)).unwrap(), coloured_tile(5, 10, 9));

        // The next version grows the image to whole coarse tiles: the zoom 3
        // tiles 1-2 x 1-2, of which only 2, 2 has picture, and its levels
        // start at zoom 3. An update renumbers the images in between.
        write_grown_pack(&pack, &server, 8, &[(1, 3, 1), (2, 4, 2), (3, 5, 4)]);
        let after = read_pack_plan(&pack).unwrap();
        let moved = renumber::moved_layers(&before, &after);
        assert_eq!(moved.len(), 1);
        renumber::stage(&root, &moved[0].0, &moved[0].1).unwrap();
        let settled = renumber::settle(&root, None, &after)
            .pop()
            .unwrap()
            .unwrap();
        assert_eq!((settled.moved, settled.removed), (13, 0));
        assert_eq!(fs::read(tile(3, 6, 5)).unwrap(), coloured_tile(5, 10, 9));
        assert_eq!(fs::read(tile(2, 2, 2)).unwrap(), coloured_tile(4, 4, 4));
        // Nothing is complete, and the new lowest levels have no image yet:
        // the map shows the two levels that were kept.
        assert_eq!(settled.shown, Some((2, 3)));
        let status = read_status(&dir);
        assert_eq!(
            (&status["nativeMinZoom"], &status["nativeMaxZoom"]),
            (&serde_json::json!(2), &serde_json::json!(3))
        );
        assert_eq!(status["complete"], false);

        // The import that made this version measured the picture at zoom 3
        // from the tile the page opens on: 2, 2 exists, the eight around it
        // do not (the first of them the store denies after an image). Once
        // the import was saved, the layer was seeded from that: the image
        // and three of the markers fall inside its new zoom 3 level.
        let second = logged_manager(&dir, &pack);
        let measured = second
            .measure_picture(&MeasureRequest {
                url_template: server.url("/remote/{z}/{x}/{y}.png"),
                zoom: 3,
                start: [2, 2],
                cached_only: false,
                page: None,
            })
            .await
            .unwrap();
        assert_eq!(measured.present, [[2, 2]]);
        assert_eq!(measured.absent.len(), 8);
        assert!(measured.complete);
        assert_eq!(server.seen().len(), 13 + 9);
        let seeded = seed_layers(second.picture_cache(), &root, Some(&pack), &after).unwrap();
        assert_eq!(
            seeded
                .iter()
                .map(|s| (s.images, s.markers))
                .collect::<Vec<_>>(),
            [(1, 3)]
        );
        assert_eq!(fs::read(tile(1, 1, 1)).unwrap(), coloured_tile(3, 2, 2));
        assert!(root.join("tiles/a/1/0/0.png.404").is_file());
        // Seeding records no level as complete.
        assert_eq!(read_status(&dir), status);

        // The next download asks for none of the measured tiles: above them
        // only for what is new inside the one that exists, the picture's
        // last column (three images) and the row below it (four tiles that
        // do not exist). The first answer is a denial; the images on disk
        // prove the host.
        second.start("test", Detail::Full).unwrap();
        let done = wait_for(&second, "test").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        let asked: Vec<String> = server.seen().into_iter().map(|s| s.path).collect();
        let mut new: Vec<&str> = asked[13 + 9..].iter().map(String::as_str).collect();
        new.sort_unstable();
        assert_eq!(
            new,
            [
                "/remote/5/10/11.png",
                "/remote/5/11/10.png",
                "/remote/5/11/11.png",
                "/remote/5/11/8.png",
                "/remote/5/11/9.png",
                "/remote/5/8/11.png",
                "/remote/5/9/11.png",
            ]
        );
        let mut distinct = asked.clone();
        distinct.sort();
        distinct.dedup();
        assert_eq!(distinct.len(), asked.len(), "nothing asked for twice");
        assert_eq!(
            (done.saved, done.missing, done.not_asked, done.failed),
            (3, 4, 12 + 48, 0)
        );
        assert_eq!((done.done, done.total), (84, 84));
        // The picture's last column is there now, and every level is complete.
        assert_eq!(fs::read(tile(3, 7, 4)).unwrap(), coloured_tile(5, 11, 8));
        assert!(tile(0, 0, 0).is_file());
        let status = read_status(&dir);
        assert_eq!(status["levels"], serde_json::json!([0, 1, 2, 3]));
        assert_eq!(status["complete"], true);
        assert_eq!(status["nativeMinZoom"], 0);
    }
}
