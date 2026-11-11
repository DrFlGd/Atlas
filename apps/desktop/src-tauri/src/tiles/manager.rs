//! Download jobs: one pack at a time, level by level, lowest first.
//!
//! A job fetches every remote level of every downloadable layer of a pack up
//! to the chosen detail. All layers' lowest remote level comes first, so
//! every map becomes usable early; as soon as a layer's lowest remote level
//! is complete, the levels below it are built by shrinking, and each
//! finished level is recorded in the layer's status file, which the map
//! reads to show the new levels without a restart.
//!
//! Where files go depends on how the pack is registered (see `packs.rs`):
//!
//! - a pack folder the person keeps (the maps folder or an opened location)
//!   receives the tiles itself, at the layer's own URL paths, with the
//!   `offline-tiles/<layer local id>.json` status files (see `status.rs`),
//!   and the image summaries in its `manifest.json` are kept current. The
//!   job holds the pack folder's lock (`.atlas/lock`) while it runs, so
//!   another window or app cannot write the same pack at once, and an
//!   unfinished job is recorded in `.atlas/download-job.json`;
//! - a bundled pack is read only: its tiles and status files go to the
//!   overlay `<app data>/packs/<pack id>/`, and an unfinished job to
//!   `<app data>/downloads/<pack id>.json`.
//!
//! The job record is `{ "packId", "detail", "stopReason" }`, so the job can
//! be offered again after the app restarts. It is removed when the job
//! finishes or is cancelled.

use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{sync::watch, time::Instant};

use super::{
    download::{
        http_client, Control, Downloader, OnOutcome, Outcome, Pace, Settings, SharedPace, Stop,
        Task,
    },
    downscale::build_lower_levels,
    pyramid::{read_pack_plan, Detail, LayerPlan, PackPlan},
    status::{add_levels, read_levels},
    store::TileStore,
};
use crate::{
    library::{PackLock, JOB_FILE, META_DIR},
    manifest::{update_images, ImagesUpdate},
    packs::{PackKind, PackRegistry},
    settings::DownloadSettings,
};

// Stopping a pack's downloads for good, before its images or the pack are deleted.
pub mod stop;

/// Assumed server answer time, for estimates before a job has started.
const ASSUMED_LATENCY: Duration = Duration::from_millis(200);
/// Speed is measured over this recent span.
const SPEED_WINDOW: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
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
    pub detail: Detail,
    pub state: JobState,
    pub reason: Option<String>,
    pub maps: Vec<MapProgress>,
    /// Tiles dealt with (downloaded, already there, missing or failed).
    pub done: u64,
    pub total: u64,
    pub saved: u64,
    pub missing: u64,
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
    /// Another pack's job that is running now, which blocks a new one.
    pub busy_with: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobRecord {
    pack_id: String,
    detail: Detail,
    stop_reason: Option<String>,
}

struct Job {
    pack_id: String,
    control: watch::Sender<Control>,
    progress: Arc<Mutex<Progress>>,
    finished: bool,
    /// Held while the job runs, for a pack folder.
    lock: Option<PackLock>,
}

/// Runs and tracks download jobs. Lives in Tauri's managed state.
pub struct DownloadManager {
    app_data: PathBuf,
    registry: PackRegistry,
    settings: Settings,
    /// The person's download settings; running jobs read them too.
    pace: SharedPace,
    jobs: Mutex<HashMap<String, Job>>,
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
            app_data,
            registry,
            settings,
            pace,
            jobs: Mutex::new(HashMap::new()),
        }
    }

    /// Applies the person's download settings, to running jobs too.
    pub fn set_download_settings(&self, settings: &DownloadSettings) {
        *lock(&self.pace) = Pace::from_settings(settings);
    }

    fn current_pace(&self) -> Pace {
        *lock(&self.pace)
    }

    /// Whether a pack's job is running or paused.
    pub fn is_active(&self, pack_id: &str) -> bool {
        lock(&self.jobs)
            .get(pack_id)
            .is_some_and(|job| !job.finished)
    }

    /// The packs with a running or paused job.
    pub fn active_packs(&self) -> Vec<String> {
        lock(&self.jobs)
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
            eprintln!("atlas: could not record the download job: {error}");
        }
    }

    fn read_record(&self, pack_id: &str) -> Option<JobRecord> {
        let text = fs::read_to_string(self.record_path(pack_id)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn remove_record(&self, pack_id: &str) {
        let _ = fs::remove_file(self.record_path(pack_id));
    }

    /// The current or last job of a pack.
    pub fn snapshot(&self, pack_id: &str) -> Option<Snapshot> {
        lock(&self.jobs)
            .get(pack_id)
            .map(|job| lock(&job.progress).snapshot())
    }

    fn running_pack(&self) -> Option<String> {
        lock(&self.jobs)
            .values()
            .find(|job| !job.finished)
            .map(|job| job.pack_id.clone())
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
        let job = self.snapshot(pack_id);
        let running = self.running_pack();
        let unfinished = if running.as_deref() == Some(pack_id) {
            None
        } else {
            self.read_record(pack_id).map(|record| Unfinished {
                detail: record.detail,
                reason: record.stop_reason,
            })
        };
        Ok(PlanInfo {
            pack_id: pack_id.to_owned(),
            options,
            recommended,
            unfinished,
            job,
            busy_with: running.filter(|id| id != pack_id),
        })
    }

    /// Starts (or restarts) the download of a pack at a detail. Tiles
    /// already on disk are skipped, so this also resumes an interrupted job
    /// and upgrades to more detail without fetching anything twice.
    pub fn start(self: &Arc<Self>, pack_id: &str, detail: Detail) -> Result<Snapshot, String> {
        let (plan, store) = self.plan(pack_id)?;
        if !plan.details().contains(&detail) && detail != Detail::Full {
            return Err("That detail level is not offered for this pack.".to_owned());
        }
        let client =
            http_client().map_err(|error| format!("Could not start downloading: {error}"))?;
        let folder = self.pack_folder(pack_id);
        let mut jobs = lock(&self.jobs);
        if let Some(job) = jobs.values().find(|job| !job.finished) {
            return Err(if job.pack_id == pack_id {
                "This pack is already downloading.".to_owned()
            } else {
                "Another pack is downloading. Pause or cancel it first.".to_owned()
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
        let status_revision = jobs
            .get(pack_id)
            .map_or(0, |job| lock(&job.progress).snapshot.status_revision);
        let progress = Arc::new(Mutex::new(Progress {
            snapshot: Snapshot {
                pack_id: pack_id.to_owned(),
                detail,
                state: JobState::Running,
                reason: None,
                maps,
                done: 0,
                total,
                saved: 0,
                missing: 0,
                failed: 0,
                bytes: 0,
                tiles_per_second: 0.0,
                bytes_per_second: 0.0,
                seconds_left: Some(estimate_seconds(&pace, total, typical_bytes)),
                status_revision,
            },
            layer_maps,
            recent: VecDeque::new(),
            started: Instant::now(),
        }));
        let (control, receiver) = watch::channel(Control::Run);
        let downloader = Arc::new(
            Downloader::new(client, self.settings.clone(), store, receiver)
                .with_pace(Arc::clone(&self.pace)),
        );
        jobs.insert(
            pack_id.to_owned(),
            Job {
                pack_id: pack_id.to_owned(),
                control,
                progress: Arc::clone(&progress),
                finished: false,
                lock: pack_lock,
            },
        );
        drop(jobs);
        self.write_record(&JobRecord {
            pack_id: pack_id.to_owned(),
            detail,
            stop_reason: None,
        });

        let this = Arc::clone(self);
        let pack = pack_id.to_owned();
        tokio::spawn(async move {
            let result = run_job(&plan, detail, &downloader, &progress, folder.as_deref()).await;
            if let Some(folder) = &folder {
                let plan = plan.clone();
                let folder = folder.clone();
                let store = downloader.store().clone();
                // Counting every image file takes a moment for a large pack.
                let _ = tokio::task::spawn_blocking(move || {
                    record_images(&folder, &plan, &store, true)
                })
                .await;
            }
            this.finish(&pack, detail, result);
        });
        Ok(self.snapshot(pack_id).expect("just added"))
    }

    fn finish(&self, pack_id: &str, detail: Detail, result: Result<(), Stop>) {
        let jobs = lock(&self.jobs);
        let Some(job) = jobs.get(pack_id) else { return };
        let mut progress = lock(&job.progress);
        let snapshot = &mut progress.snapshot;
        snapshot.seconds_left = None;
        snapshot.tiles_per_second = 0.0;
        snapshot.bytes_per_second = 0.0;
        match result {
            Ok(()) => {
                snapshot.state = JobState::Done;
                if snapshot.failed > 0 {
                    snapshot.reason = Some(format!(
                        "{} map images could not be downloaded. Download again to retry them.",
                        snapshot.failed
                    ));
                }
                self.remove_record(pack_id);
            }
            Err(Stop::Cancelled) => {
                snapshot.state = JobState::Cancelled;
                self.remove_record(pack_id);
            }
            Err(stop) => {
                snapshot.state = JobState::Stopped;
                snapshot.reason = Some(stop.message());
                self.write_record(&JobRecord {
                    pack_id: pack_id.to_owned(),
                    detail,
                    stop_reason: Some(stop.message()),
                });
            }
        }
        drop(progress);
        drop(jobs);
        if let Some(job) = lock(&self.jobs).get_mut(pack_id) {
            job.finished = true;
            job.lock = None;
        }
    }

    fn set_control(&self, pack_id: &str, control: Control) -> Result<Snapshot, String> {
        let jobs = lock(&self.jobs);
        let job = jobs
            .get(pack_id)
            .filter(|job| !job.finished)
            .ok_or_else(|| "This pack is not downloading.".to_owned())?;
        job.control.send_replace(control);
        let mut progress = lock(&job.progress);
        match control {
            Control::Pause => progress.snapshot.state = JobState::Paused,
            Control::Run => {
                progress.snapshot.state = JobState::Running;
                progress.recent.clear();
                progress.started = Instant::now();
            }
            Control::Cancel => {}
        }
        Ok(progress.snapshot())
    }

    pub fn pause(&self, pack_id: &str) -> Result<Snapshot, String> {
        self.set_control(pack_id, Control::Pause)
    }

    pub fn resume(&self, pack_id: &str) -> Result<Snapshot, String> {
        self.set_control(pack_id, Control::Run)
    }

    /// Cancels a running job, or forgets an interrupted one. Tiles already
    /// downloaded are kept, so a later download continues from them.
    pub fn cancel(&self, pack_id: &str) -> Result<(), String> {
        match self.set_control(pack_id, Control::Cancel) {
            Ok(_) => Ok(()),
            Err(_) => {
                self.remove_record(pack_id);
                Ok(())
            }
        }
    }
}

/// Downloads a pack's levels in order and builds the levels below.
async fn run_job(
    plan: &PackPlan,
    detail: Detail,
    downloader: &Arc<Downloader>,
    progress: &Arc<Mutex<Progress>>,
    folder: Option<&Path>,
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

    for rank in 0..ranks {
        // The rank-th remote level of each layer, fetched together.
        let mut tasks = Vec::new();
        let mut levels = Vec::new();
        for (index, (layer, &top)) in plan.layers.iter().zip(&tops).enumerate() {
            let Some(level) = layer.remote_levels(top).nth(rank) else {
                continue;
            };
            levels.push((index, level.z));
            tasks.extend(layer.tiles_of(level.z).map(|tile| Task {
                layer: index,
                url: layer.remote_url(level, tile.x, tile.y),
                path: layer.tile_path(tile.z, tile.x, tile.y),
            }));
        }
        let saved_layers = Arc::new(Mutex::new(BTreeSet::new()));
        let on_outcome: OnOutcome = {
            let progress = Arc::clone(progress);
            let saved_layers = Arc::clone(&saved_layers);
            Arc::new(move |task: &Task, outcome: &Outcome| {
                if matches!(outcome, Outcome::Saved(_)) {
                    lock(&saved_layers).insert(task.layer);
                }
                lock(&progress).record(task, outcome);
            })
        };
        downloader.run(Arc::new(tasks), on_outcome).await?;

        for (index, z) in levels {
            let layer = &plan.layers[index];
            let mut finished = vec![z];
            if rank == 0 {
                let recorded = read_levels(&store.overlay, layer);
                let stale = lock(&saved_layers).contains(&index)
                    || layer.built_levels().any(|built| !recorded.contains(&built));
                if stale {
                    build_levels_below(layer, &store, downloader).await?;
                }
                finished.extend(layer.built_levels());
            }
            add_levels(&store.overlay, layer, finished)
                .map_err(|error| Stop::Disk(error.to_string()))?;
            lock(progress).snapshot.status_revision += 1;
        }
        if let Some(folder) = folder {
            record_images(folder, plan, &store, false);
        }
    }
    Ok(())
}

/// Records the complete levels of each layer in the pack's manifest, and
/// with `count` the number and size of its image files.
fn record_images(folder: &Path, plan: &PackPlan, store: &TileStore, count: bool) {
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
        eprintln!("atlas: {error}");
    }
}

/// The image files of a layer in a pack folder, and their bytes.
fn count_images(folder: &Path, layer: &LayerPlan) -> (u64, u64) {
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
    if let Some(relative) = crate::tiles::pyramid::relative_path(prefix.trim_end_matches('/')) {
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
    use crate::tiles::{
        download::tests::{ensure_crypto, Handler, MockServer, Reply},
        store::tests::TempDir,
    };
    use image::{Rgb, RgbImage};

    /// A tile whose colour encodes its remote address, so tests can tell
    /// which tile went where.
    fn coloured_tile(z: u8, x: u8, y: u8) -> Vec<u8> {
        let image = RgbImage::from_pixel(256, 256, Rgb([z * 20, x * 40, y * 40]));
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    /// A pack with one 1000 x 600 map whose levels 1 and 2 come from a mock
    /// server (remote zooms 4 and 5, offset by 1 and 2 tiles).
    fn write_pack(dir: &Path, server: &MockServer) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":1000,"height":600}]"#,
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

    fn tile_server() -> Handler {
        Arc::new(|path, _| {
            let parts: Vec<u8> = path
                .trim_start_matches("/remote/")
                .trim_end_matches(".png")
                .split('/')
                .map(|n| n.parse().unwrap())
                .collect();
            Reply::image(coloured_tile(parts[0], parts[1], parts[2]))
        })
    }

    async fn wait_for(manager: &DownloadManager, pack: &str) -> Snapshot {
        for _ in 0..400 {
            let snapshot = manager.snapshot(pack).unwrap();
            if !matches!(snapshot.state, JobState::Running | JobState::Paused) {
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

    #[test]
    fn refuses_unknown_packs() {
        let dir = TempDir::new("manager-unknown");
        let manager = DownloadManager::new(dir.0.clone(), PackRegistry::default());
        assert!(manager.plan_info("nope").is_err());
    }
}
