//! A polite, resumable tile downloader.
//!
//! The defaults keep the load on the tile server low: two requests in flight,
//! a 250 ms pause per worker after each request, retries with doubling waits
//! on network errors and 5xx answers, and on 429 a pause of every worker for
//! as long as `Retry-After` asks. It stops the whole job, with a reason a
//! person can read, when the server refuses access (401 or 403), when it
//! answers with a web page instead of an image, or after 10 failed tiles in a
//! row. A 404 is recorded on disk so the tile is not asked for again, and
//! tiles already on disk are skipped, so an interrupted job continues where
//! it stopped.
//!
//! The person can make it slower or a little faster within fixed bounds
//! (see `settings.rs`, "download settings"): 1 to 4 requests in flight, a
//! pause of 100 ms to 5 s, and optional caps on requests per minute and on
//! bytes per second. The pace is shared with the job and read before every
//! request, so a change applies to a running download; fewer parallel
//! downloads apply at once, more from the next level.
//!
//! Requests carry an honest User-Agent naming the app and its version, no
//! cookies and no browser-like headers. Nothing else can be changed from the
//! web app: it only starts, pauses, resumes and cancels jobs.
//!
//! Every answer that is not a success goes to the activity log (see
//! `activity.rs`) with the image's address, the attempt and what happens
//! next. A refusal or a web page that stops the job is recorded in full
//! ([`StopDetail`]): the address, the status, where the image sits in its
//! level, how many images the job had saved before it, a few response
//! headers and the start of a text body. That is for diagnosis only: the
//! job still stops at the first refusal, without retrying.

use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, SystemTime},
};

use reqwest::{
    header::{HeaderMap, ACCEPT, CONTENT_TYPE, RETRY_AFTER},
    Client, StatusCode,
};
use serde::{Deserialize, Serialize};
use tokio::{sync::watch, task::JoinSet, time::Instant};

use super::{downscale::looks_like_image, store::TileStore};
use crate::activity::{self, ActivityLog, Area};

/// The User-Agent of every tile request.
pub const USER_AGENT: &str = concat!("Atlas/", env!("CARGO_PKG_VERSION"), " (offline map viewer)");

/// Response headers recorded with a refusal or a web page, when present.
pub const RECORDED_HEADERS: &[&str] = &[
    "server",
    "content-type",
    "content-length",
    "via",
    "x-cache",
    "cf-mitigated",
    "cf-ray",
    "x-amz-request-id",
    "retry-after",
];
/// Characters of a text body recorded with a refusal or a web page.
pub const BODY_EXCERPT_CHARS: usize = 300;
/// At most this much of a refusal's body is read, to find its start.
const BODY_READ_LIMIT: usize = 16 * 1024;

/// How the downloader paces itself. The app always uses the defaults; tests
/// shorten the waits.
#[derive(Clone, Debug)]
pub struct Settings {
    /// Requests in flight at once.
    pub concurrency: usize,
    /// Pause per worker after each request.
    pub delay: Duration,
    /// Attempts per tile before it counts as failed.
    pub max_attempts: u32,
    /// First wait before a retry; doubles on each attempt.
    pub backoff: Duration,
    pub max_backoff: Duration,
    /// The longest `Retry-After` honoured as given; longer ones are capped.
    pub max_retry_after: Duration,
    /// Stop after this many tiles in a row have failed.
    pub max_consecutive_failures: u32,
    pub timeout: Duration,
    /// Larger answers are not a map tile.
    pub max_tile_bytes: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            concurrency: 2,
            delay: Duration::from_millis(250),
            max_attempts: 5,
            backoff: Duration::from_secs(2),
            max_backoff: Duration::from_secs(60),
            max_retry_after: Duration::from_secs(15 * 60),
            max_consecutive_failures: 10,
            timeout: Duration::from_secs(30),
            max_tile_bytes: 16 << 20,
        }
    }
}

/// The HTTP client for tile requests: the app's User-Agent, no cookie store
/// (reqwest keeps none unless asked), and a small redirect limit.
pub fn http_client() -> reqwest::Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(20))
        .build()
}

/// What the job should be doing, set by the app and watched by the workers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Run,
    Pause,
    Cancel,
}

/// Why a job stopped before finishing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stop {
    Cancelled,
    /// The server answered 401 or 403.
    Refused(u16),
    /// The server sent a web page instead of an image.
    WebPage,
    TooManyFailures(u32),
    Disk(String),
}

impl Stop {
    /// A sentence for the person using the app.
    pub fn message(&self) -> String {
        match self {
            Stop::Cancelled => "The download was cancelled.".to_owned(),
            Stop::Refused(status) => format!(
                "The map image server refused access (HTTP {status}), so the download stopped. \
                 It may not allow downloads; Atlas does not try to get around that."
            ),
            Stop::WebPage => "The map image server sent a web page instead of an image, so the \
                 download stopped. The server may be blocking downloads or asking for a check \
                 that only a browser can pass."
                .to_owned(),
            Stop::TooManyFailures(count) => format!(
                "{count} map images in a row could not be downloaded, so the download stopped. \
                 Check the internet connection and try again later."
            ),
            Stop::Disk(error) => format!("Atlas could not save the map images: {error}"),
        }
    }
}

/// What happened to one tile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Already on disk (or known to be missing) before this request.
    Skipped,
    /// Downloaded and saved; the number of bytes.
    Saved(u64),
    /// The server has no such tile (404 or 410); recorded on disk.
    Missing,
    /// Gave up on this tile; the reason.
    Failed(String),
}

/// Where a tile sits in its layer's pyramid level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    /// The layer's own level.
    pub z: u8,
    /// The remote zoom it is a copy of.
    pub source_z: u8,
    /// Column and row in the level, counted from 0.
    pub x: u64,
    pub y: u64,
    /// Columns and rows the level has.
    pub columns: u64,
    pub rows: u64,
}

impl Place {
    /// Whether the tile is in the first or last column or row.
    pub fn is_edge(&self) -> bool {
        self.x == 0 || self.y == 0 || self.x + 1 >= self.columns || self.y + 1 >= self.rows
    }

    /// "level 3 (remote zoom 5), column 0 of 216, row 231 of 232 (counted
    /// from 0; an edge tile)".
    pub fn describe(&self) -> String {
        format!(
            "level {} (remote zoom {}), column {} of {}, row {} of {} (counted from 0; {})",
            self.z,
            self.source_z,
            self.x,
            self.columns,
            self.y,
            self.rows,
            if self.is_edge() {
                "an edge tile"
            } else {
                "not at an edge"
            }
        )
    }
}

/// One tile to download.
#[derive(Clone, Debug)]
pub struct Task {
    /// Index of the layer in the job, passed back with each outcome.
    pub layer: usize,
    pub url: String,
    /// Where the tile goes, relative to the overlay folder.
    pub path: PathBuf,
    /// The layer and map, for the log: "Surface (Island)".
    pub label: Option<Arc<str>>,
    /// Where the tile sits in its level, for the log.
    pub place: Option<Place>,
}

impl Task {
    pub fn new(layer: usize, url: String, path: PathBuf) -> Self {
        Self {
            layer,
            url,
            path,
            label: None,
            place: None,
        }
    }
}

/// The full record of the answer that stopped a job (a refusal or a web
/// page), kept with the job and shown in the download panel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopDetail {
    /// `refused` or `web-page`.
    pub kind: String,
    pub url: String,
    pub status: u16,
    /// The layer and map: "Surface (Island)".
    pub layer: Option<String>,
    pub place: Option<Place>,
    pub attempt: u32,
    /// Images this job had saved before this answer.
    pub saved_before: u64,
    /// Of those, from the same host.
    pub saved_from_host: u64,
    pub host: String,
    /// Selected response headers, as received.
    pub headers: Vec<(String, String)>,
    /// The start of a text body, without control characters.
    pub body: Option<String>,
    /// When it happened (ISO 8601 UTC).
    pub at: String,
}

impl StopDetail {
    /// One log line with everything in it.
    pub fn log_line(&self) -> String {
        let what = if self.kind == "refused" {
            format!("the server refused access (HTTP {})", self.status)
        } else {
            format!(
                "the server sent a web page instead of an image (HTTP {})",
                self.status
            )
        };
        let mut parts = vec![format!("Stopped: {what} for {}", self.url)];
        let mut position = self.layer.clone().unwrap_or_default();
        if let Some(place) = &self.place {
            if !position.is_empty() {
                position.push_str(", ");
            }
            position.push_str(&place.describe());
        }
        if !position.is_empty() {
            parts.push(format!("layer {position}"));
        }
        parts.push(format!("attempt {}", self.attempt));
        parts.push(format!(
            "this job had saved {} images before it, {} of them from {}",
            self.saved_before, self.saved_from_host, self.host
        ));
        parts.push(if self.headers.is_empty() {
            "headers: none of interest".to_owned()
        } else {
            format!(
                "headers: {}",
                self.headers
                    .iter()
                    .map(|(name, value)| format!("{name}: {value}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        });
        parts.push(match &self.body {
            Some(body) => format!("body: {body}"),
            None => "body: none, or not text".to_owned(),
        });
        parts.push("not retried".to_owned());
        parts.join(" | ")
    }
}

/// The host (and port) of a URL, for counting and the log.
pub fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.host_str().map(|host| match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_owned(),
            })
        })
        .unwrap_or_default()
}

/// The response headers worth recording, cleaned and capped.
fn recorded_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    RECORDED_HEADERS
        .iter()
        .filter_map(|name| {
            let value = headers.get(*name)?;
            let text = String::from_utf8_lossy(value.as_bytes());
            let text: String = activity::clean(&text).chars().take(200).collect();
            Some(((*name).to_owned(), text))
        })
        .collect()
}

/// Whether a body of this type is text worth quoting.
fn is_text_type(content_type: &str) -> bool {
    ["html", "xml", "json", "text/"]
        .iter()
        .any(|kind| content_type.contains(kind))
}

/// The first characters of a text body, without control characters and
/// with runs of spaces collapsed. None when it is not text.
pub fn body_excerpt(content_type: &str, body: &[u8]) -> Option<String> {
    let text = match std::str::from_utf8(body) {
        Ok(text) => text.to_owned(),
        // Cut in the middle of a character at the read limit.
        Err(error) if error.error_len().is_none() => {
            String::from_utf8_lossy(&body[..error.valid_up_to()]).into_owned()
        }
        Err(_) if is_text_type(content_type) => String::from_utf8_lossy(body).into_owned(),
        Err(_) => return None,
    };
    if !is_text_type(content_type) && (!content_type.is_empty() || text.contains('\0')) {
        return None;
    }
    let cleaned = activity::clean(&text);
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(BODY_EXCERPT_CHARS).collect())
}

/// Called with each tile's outcome.
pub type OnOutcome = Arc<dyn Fn(&Task, &Outcome) + Send + Sync>;

/// Seconds or an HTTP date, as `Retry-After` allows.
pub fn parse_retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    httpdate::parse_http_date(value)
        .ok()
        .map(|date| date.duration_since(now).unwrap_or(Duration::ZERO))
}

fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_retry_after(value, SystemTime::now()))
}

/// A wait in words for the log: "250 ms", "4 s".
pub fn wait_text(wait: Duration) -> String {
    if wait < Duration::from_secs(1) {
        format!("{} ms", wait.as_millis())
    } else {
        format!("{} s", wait.as_secs_f64().round())
    }
}

/// How fast a job may go: chosen by the person within bounds, and read
/// before every request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pace {
    /// Requests in flight at once.
    pub concurrency: usize,
    /// Pause per worker after each request.
    pub delay: Duration,
    /// At most this many requests per minute, over all workers.
    pub requests_per_minute: Option<u32>,
    /// At most this many bytes per second, over all workers.
    pub bytes_per_second: Option<u64>,
}

impl Pace {
    /// The pace of the given download settings.
    pub fn from_settings(settings: &crate::settings::DownloadSettings) -> Self {
        let settings = settings.clamped();
        Self {
            concurrency: settings.parallel as usize,
            delay: Duration::from_millis(u64::from(settings.pause_ms)),
            requests_per_minute: settings.requests_per_minute,
            bytes_per_second: settings.kilobytes_per_second.map(|kb| u64::from(kb) * 1000),
        }
    }

    /// Rough seconds to fetch `tiles` tiles of `bytes` bytes in all, at
    /// this pace, with an assumed server answer time per request.
    pub fn estimate_seconds(&self, tiles: u64, bytes: u64, latency: Duration) -> f64 {
        let tiles_f = tiles as f64;
        let mut seconds =
            tiles_f * (self.delay + latency).as_secs_f64() / self.concurrency.max(1) as f64;
        if let Some(rpm) = self.requests_per_minute {
            seconds = seconds.max(tiles_f * 60.0 / f64::from(rpm.max(1)));
        }
        if let Some(bps) = self.bytes_per_second {
            seconds = seconds.max(bytes as f64 / bps.max(1) as f64);
        }
        seconds
    }

    /// The pace in words, for the log.
    pub fn describe(&self) -> String {
        format!(
            "{} parallel, {} pause after each image, {}, {}",
            self.concurrency,
            wait_text(self.delay),
            self.requests_per_minute
                .map_or("no cap on images a minute".to_owned(), |rpm| format!(
                    "at most {rpm} images a minute"
                )),
            self.bytes_per_second
                .map_or("no speed cap".to_owned(), |bps| format!(
                    "at most {} KB/s",
                    bps / 1000
                )),
        )
    }
}

/// A pace that every clone shares, so the app can change a running job's pace.
pub type SharedPace = Arc<Mutex<Pace>>;

/// When the next request may start under the rate caps.
#[derive(Default)]
struct Slots {
    next_request: Option<Instant>,
    next_byte: Option<Instant>,
}

/// One request in flight, counted while the value lives.
struct InFlight<'a>(&'a AtomicUsize);

impl<'a> InFlight<'a> {
    fn new(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What one attempt at a tile came to.
enum Attempt {
    Done(Outcome),
    /// Worth another try: what went wrong, and how long to wait first if
    /// not the usual backoff.
    Retry(String, Option<Duration>),
}

/// Downloads tiles into a store. One downloader can run several batches
/// one after another; pausing, cancelling and the 429 pause apply to all.
pub struct Downloader {
    client: Client,
    settings: Settings,
    pace: SharedPace,
    slots: Mutex<Slots>,
    store: TileStore,
    control: watch::Receiver<Control>,
    /// Every worker waits until this time before its next request (429).
    paused_until: Mutex<Option<Instant>>,
    consecutive_failures: AtomicU32,
    stop: Mutex<Option<Stop>>,
    /// The answer that stopped the job, recorded in full.
    stop_detail: Mutex<Option<StopDetail>>,
    log: ActivityLog,
    /// Images saved by this downloader, in all and by host.
    saved: AtomicU64,
    saved_by_host: Mutex<HashMap<String, u64>>,
    in_flight: AtomicUsize,
}

impl Downloader {
    pub fn new(
        client: Client,
        settings: Settings,
        store: TileStore,
        control: watch::Receiver<Control>,
    ) -> Self {
        let pace = Arc::new(Mutex::new(Pace {
            concurrency: settings.concurrency,
            delay: settings.delay,
            requests_per_minute: None,
            bytes_per_second: None,
        }));
        Self {
            client,
            settings,
            pace,
            slots: Mutex::new(Slots::default()),
            store,
            control,
            paused_until: Mutex::new(None),
            consecutive_failures: AtomicU32::new(0),
            stop: Mutex::new(None),
            stop_detail: Mutex::new(None),
            log: ActivityLog::global(),
            saved: AtomicU64::new(0),
            saved_by_host: Mutex::new(HashMap::new()),
            in_flight: AtomicUsize::new(0),
        }
    }

    /// Uses a pace the app can change while the job runs.
    #[must_use]
    pub fn with_pace(mut self, pace: SharedPace) -> Self {
        self.pace = pace;
        self
    }

    /// Writes to this log instead of the app's.
    #[must_use]
    pub fn with_log(mut self, log: ActivityLog) -> Self {
        self.log = log;
        self
    }

    fn pace(&self) -> Pace {
        *self.pace.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn store(&self) -> &TileStore {
        &self.store
    }

    /// The answer that stopped the job, if a refusal or a web page did.
    pub fn stop_detail(&self) -> Option<StopDetail> {
        self.stop_detail
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Waits until no request of this downloader is in flight.
    pub async fn idle(&self) {
        while self.in_flight.load(Ordering::SeqCst) > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Waits until the rate caps allow another request, and books it.
    async fn wait_for_slot(&self) -> Result<(), Stop> {
        let pace = self.pace();
        let start = {
            let mut slots = self.slots.lock().unwrap_or_else(PoisonError::into_inner);
            let now = Instant::now();
            let start = [Some(now), slots.next_request, slots.next_byte]
                .into_iter()
                .flatten()
                .max()
                .unwrap_or(now);
            slots.next_request = pace
                .requests_per_minute
                .map(|rpm| start + Duration::from_secs_f64(60.0 / f64::from(rpm.max(1))));
            start
        };
        if start > Instant::now() {
            self.unless_cancelled(tokio::time::sleep_until(start))
                .await?;
        }
        Ok(())
    }

    /// Books the time `bytes` take under the speed cap.
    fn spend_bytes(&self, bytes: u64) {
        let Some(bps) = self.pace().bytes_per_second else {
            return;
        };
        let mut slots = self.slots.lock().unwrap_or_else(PoisonError::into_inner);
        let from = slots
            .next_byte
            .map_or_else(Instant::now, |next| next.max(Instant::now()));
        slots.next_byte = Some(from + Duration::from_secs_f64(bytes as f64 / bps.max(1) as f64));
    }

    fn stopped(&self) -> Option<Stop> {
        self.stop
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set_stop(&self, stop: Stop) {
        self.stop
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert(stop);
    }

    /// Whether the job has been cancelled.
    pub fn is_cancelled_now(&self) -> bool {
        *self.control.borrow() == Control::Cancel
    }

    /// Runs `future` unless the job is cancelled first.
    async fn unless_cancelled<F: Future>(&self, future: F) -> Result<F::Output, Stop> {
        let mut control = self.control.clone();
        let cancelled = async move {
            loop {
                if *control.borrow_and_update() == Control::Cancel {
                    return;
                }
                if control.changed().await.is_err() {
                    // The app dropped the control handle: nobody can cancel any more.
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::select! {
            output = future => Ok(output),
            () = cancelled => Err(Stop::Cancelled),
        }
    }

    async fn sleep(&self, duration: Duration) -> Result<(), Stop> {
        self.unless_cancelled(tokio::time::sleep(duration)).await
    }

    /// Waits while the job is paused. Errs when it is cancelled.
    async fn wait_while_paused(&self) -> Result<(), Stop> {
        let mut control = self.control.clone();
        loop {
            match *control.borrow_and_update() {
                Control::Run => return Ok(()),
                Control::Cancel => return Err(Stop::Cancelled),
                Control::Pause => {}
            }
            if control.changed().await.is_err() {
                return Err(Stop::Cancelled);
            }
        }
    }

    /// Waits out a 429 pause set by any worker.
    async fn wait_for_server(&self) -> Result<(), Stop> {
        loop {
            let until = *self
                .paused_until
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match until {
                Some(until) if until > Instant::now() => {
                    self.unless_cancelled(tokio::time::sleep_until(until))
                        .await?;
                }
                _ => return Ok(()),
            }
        }
    }

    fn pause_everyone(&self, wait: Duration) {
        let mut until = self
            .paused_until
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let end = Instant::now() + wait;
        if until.is_none_or(|current| current < end) {
            *until = Some(end);
        }
    }

    /// Downloads every task, `concurrency` at a time, in order. Returns when
    /// all are done, or with the reason the job stopped.
    pub async fn run(
        self: &Arc<Self>,
        tasks: Arc<Vec<Task>>,
        on_outcome: OnOutcome,
    ) -> Result<(), Stop> {
        if let Some(stop) = self.stopped() {
            return Err(stop);
        }
        let next = Arc::new(AtomicUsize::new(0));
        let mut workers = JoinSet::new();
        for worker in 0..self.pace().concurrency.max(1) {
            let this = Arc::clone(self);
            let tasks = Arc::clone(&tasks);
            let next = Arc::clone(&next);
            let on_outcome = Arc::clone(&on_outcome);
            workers.spawn(async move {
                if let Err(stop) = this.work(worker, &tasks, &next, &on_outcome).await {
                    this.set_stop(stop);
                }
            });
        }
        while let Some(result) = workers.join_next().await {
            if let Err(error) = result {
                self.set_stop(Stop::Disk(format!("a download worker failed: {error}")));
            }
        }
        match self.stopped() {
            Some(stop) => Err(stop),
            None => Ok(()),
        }
    }

    async fn work(
        &self,
        worker: usize,
        tasks: &[Task],
        next: &AtomicUsize,
        on_outcome: &OnOutcome,
    ) -> Result<(), Stop> {
        loop {
            if let Some(stop) = self.stopped() {
                return Err(stop);
            }
            self.wait_while_paused().await?;
            // Fewer parallel downloads take effect at once; the rest of the
            // batch goes to the remaining workers.
            if worker > 0 && worker >= self.pace().concurrency {
                return Ok(());
            }
            let Some(task) = tasks.get(next.fetch_add(1, Ordering::SeqCst)) else {
                return Ok(());
            };
            if self.store.is_done(&task.path) {
                on_outcome(task, &Outcome::Skipped);
                continue;
            }
            let outcome = self.fetch(task).await?;
            if matches!(outcome, Outcome::Saved(_)) {
                self.saved.fetch_add(1, Ordering::SeqCst);
                *self
                    .saved_by_host
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .entry(host_of(&task.url))
                    .or_default() += 1;
            }
            on_outcome(task, &outcome);
            let failures = if matches!(outcome, Outcome::Failed(_)) {
                self.consecutive_failures.fetch_add(1, Ordering::SeqCst) + 1
            } else {
                self.consecutive_failures.store(0, Ordering::SeqCst);
                0
            };
            if failures >= self.settings.max_consecutive_failures {
                self.log.error(
                    Area::Download,
                    format!("{failures} map images in a row failed; the job stops"),
                );
                return Err(Stop::TooManyFailures(failures));
            }
            if let Outcome::Saved(bytes) = &outcome {
                self.spend_bytes(*bytes);
            }
            self.sleep(self.pace().delay).await?;
        }
    }

    /// Fetches one tile, retrying what is worth retrying.
    async fn fetch(&self, task: &Task) -> Result<Outcome, Stop> {
        let settings = &self.settings;
        let mut delay = settings.backoff;
        let mut last_error = String::new();
        for attempt in 1..=settings.max_attempts {
            if self.is_cancelled_now() {
                return Err(Stop::Cancelled);
            }
            self.wait_for_server().await?;
            self.wait_for_slot().await?;
            let retry_wait = match self.attempt(task, attempt, delay).await? {
                Attempt::Done(outcome) => return Ok(outcome),
                Attempt::Retry(error, wait) => {
                    last_error = error;
                    wait
                }
            };
            let next = (attempt < settings.max_attempts).then(|| retry_wait.unwrap_or(delay));
            self.log.warn(
                Area::Download,
                format!(
                    "{last_error} for {} (attempt {attempt} of {}); {}",
                    task.url,
                    settings.max_attempts,
                    match next {
                        Some(Duration::ZERO) => "trying again after that pause".to_owned(),
                        Some(wait) => format!("trying again in {}", wait_text(wait)),
                        None => "giving up on this image".to_owned(),
                    }
                ),
            );
            if let Some(wait) = next {
                self.sleep(wait).await?;
                delay = (delay * 2).min(settings.max_backoff);
            }
        }
        Ok(Outcome::Failed(last_error))
    }

    /// One request for a tile.
    async fn attempt(&self, task: &Task, attempt: u32, delay: Duration) -> Result<Attempt, Stop> {
        let settings = &self.settings;
        let _in_flight = InFlight::new(&self.in_flight);
        let request = self
            .client
            .get(&task.url)
            .header(ACCEPT, "image/*")
            .timeout(settings.timeout)
            .send();
        let response = match self.unless_cancelled(request).await? {
            Err(error) => return Ok(Attempt::Retry(network_error(&error), None)),
            Ok(response) => response,
        };
        let status = response.status();
        Ok(match status.as_u16() {
            404 | 410 => {
                self.store.mark_missing(&task.path).map_err(|error| {
                    self.disk_error(task, &error);
                    Stop::Disk(error.to_string())
                })?;
                Attempt::Done(Outcome::Missing)
            }
            code @ (401 | 403) => {
                // Stop the other workers at once; then record what came back.
                self.set_stop(Stop::Refused(code));
                self.record_stop("refused", task, attempt, response, None)
                    .await;
                return Err(Stop::Refused(code));
            }
            429 => {
                let header = response
                    .headers()
                    .get(RETRY_AFTER)
                    .map(|value| activity::clean(&String::from_utf8_lossy(value.as_bytes())));
                let wait = retry_after(response.headers())
                    .unwrap_or(delay)
                    .min(settings.max_retry_after);
                // Slow every worker down, not just this one.
                self.pause_everyone(wait);
                Attempt::Retry(
                    format!(
                        "The server asked to slow down (HTTP 429, Retry-After: {}); every download waits {}",
                        header.as_deref().unwrap_or("not given"),
                        wait_text(wait)
                    ),
                    Some(Duration::ZERO),
                )
            }
            500..=599 => Attempt::Retry(
                format!("Server error ({})", http_error(status)),
                Some(
                    retry_after(response.headers())
                        .unwrap_or(delay)
                        .min(settings.max_backoff),
                ),
            ),
            _ if status.is_success() => match self.save(task, attempt, response).await? {
                Ok(outcome) => Attempt::Done(outcome),
                Err(error) => Attempt::Retry(error, None),
            },
            _ => {
                let error = http_error(status);
                self.log.warn(
                    Area::Download,
                    format!(
                        "{error} for {} (attempt {attempt}); not retried, the image counts as failed",
                        task.url
                    ),
                );
                Attempt::Done(Outcome::Failed(error))
            }
        })
    }

    fn disk_error(&self, task: &Task, error: &std::io::Error) {
        self.log.error(
            Area::Download,
            format!(
                "Could not save {} to {}: {error}",
                task.url,
                self.store.overlay.join(&task.path).display()
            ),
        );
    }

    /// Records the answer that stops the job, in the log and for the panel.
    async fn record_stop(
        &self,
        kind: &str,
        task: &Task,
        attempt: u32,
        mut response: reqwest::Response,
        body: Option<Vec<u8>>,
    ) {
        let status = response.status().as_u16();
        let headers = recorded_headers(response.headers());
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let body = match body {
            Some(body) => body,
            None => {
                let mut body = Vec::new();
                while body.len() < BODY_READ_LIMIT {
                    match self.unless_cancelled(response.chunk()).await {
                        Ok(Ok(Some(chunk))) => body.extend_from_slice(&chunk),
                        _ => break,
                    }
                }
                body.truncate(BODY_READ_LIMIT);
                body
            }
        };
        let host = host_of(&task.url);
        let detail = StopDetail {
            kind: kind.to_owned(),
            url: task.url.clone(),
            status,
            layer: task.label.as_deref().map(str::to_owned),
            place: task.place,
            attempt,
            saved_before: self.saved.load(Ordering::SeqCst),
            saved_from_host: self
                .saved_by_host
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&host)
                .copied()
                .unwrap_or(0),
            host,
            headers,
            body: body_excerpt(&content_type, &body),
            at: activity::timestamp(SystemTime::now()),
        };
        self.log.error(Area::Download, detail.log_line());
        self.stop_detail
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert(detail);
    }

    /// Reads a successful answer and saves it if it is an image. The inner
    /// error is a network error worth retrying.
    async fn save(
        &self,
        task: &Task,
        attempt: u32,
        mut response: reqwest::Response,
    ) -> Result<Result<Outcome, String>, Stop> {
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let too_large = || {
            self.log.warn(
                Area::Download,
                format!(
                    "The answer for {} is too large for a map image; the image counts as failed",
                    task.url
                ),
            );
            Ok(Ok(Outcome::Failed(
                "the answer is too large for a map image".to_owned(),
            )))
        };
        if response
            .content_length()
            .is_some_and(|len| len > self.settings.max_tile_bytes as u64)
        {
            return too_large();
        }
        let mut body = Vec::new();
        loop {
            match self.unless_cancelled(response.chunk()).await? {
                Ok(Some(chunk)) => {
                    body.extend_from_slice(&chunk);
                    if body.len() > self.settings.max_tile_bytes {
                        return too_large();
                    }
                }
                Ok(None) => break,
                Err(error) => return Ok(Err(network_error(&error))),
            }
        }
        if looks_like_image(&body) {
            self.store.write(&task.path, &body).map_err(|error| {
                self.disk_error(task, &error);
                Stop::Disk(error.to_string())
            })?;
            return Ok(Ok(Outcome::Saved(body.len() as u64)));
        }
        let starts_like_markup = body
            .iter()
            .find(|byte| !byte.is_ascii_whitespace())
            .is_some_and(|byte| *byte == b'<');
        if content_type.contains("html") || starts_like_markup {
            self.set_stop(Stop::WebPage);
            self.record_stop("web-page", task, attempt, response, Some(body))
                .await;
            return Err(Stop::WebPage);
        }
        let kind = if content_type.is_empty() {
            "no type"
        } else {
            &content_type
        };
        self.log.warn(
            Area::Download,
            format!(
                "The answer for {} is not an image ({kind}, {} bytes); the image counts as failed",
                task.url,
                body.len()
            ),
        );
        Ok(Ok(Outcome::Failed(format!(
            "the answer is not an image ({kind})"
        ))))
    }
}

fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The server did not answer in time".to_owned()
    } else if error.is_connect() {
        "Could not connect to the server".to_owned()
    } else {
        format!("Network error: {error}")
    }
}

fn http_error(status: StatusCode) -> String {
    format!(
        "HTTP {} {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or_default()
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;
    use std::net::SocketAddr;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    /// A request the mock server received.
    #[derive(Clone, Debug)]
    pub struct Seen {
        pub path: String,
        pub headers: HashMap<String, String>,
        pub at: Instant,
    }

    pub struct Reply {
        pub status: u16,
        pub headers: Vec<(&'static str, String)>,
        pub body: Vec<u8>,
        pub delay: Duration,
        /// Close the connection without answering.
        pub hang_up: bool,
    }

    impl Reply {
        pub fn status(status: u16) -> Self {
            Self {
                status,
                headers: Vec::new(),
                body: Vec::new(),
                delay: Duration::ZERO,
                hang_up: false,
            }
        }

        pub fn image(body: Vec<u8>) -> Self {
            Self {
                headers: vec![("Content-Type", "image/png".to_owned())],
                body,
                ..Self::status(200)
            }
        }

        pub fn header(mut self, name: &'static str, value: &str) -> Self {
            self.headers.push((name, value.to_owned()));
            self
        }

        pub fn delayed(mut self, delay: Duration) -> Self {
            self.delay = delay;
            self
        }
    }

    /// Decides the reply from the path and how often that path was asked for
    /// before (0 the first time).
    pub type Handler = Arc<dyn Fn(&str, usize) -> Reply + Send + Sync>;

    /// A local HTTP server for tests. It answers one request per connection.
    pub struct MockServer {
        pub addr: SocketAddr,
        pub seen: Arc<Mutex<Vec<Seen>>>,
        pub in_flight_max: Arc<AtomicUsize>,
    }

    impl MockServer {
        pub async fn start(handler: Handler) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let seen = Arc::new(Mutex::new(Vec::<Seen>::new()));
            let in_flight = Arc::new(AtomicUsize::new(0));
            let in_flight_max = Arc::new(AtomicUsize::new(0));
            let server = Self {
                addr,
                seen: Arc::clone(&seen),
                in_flight_max: Arc::clone(&in_flight_max),
            };
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let (seen, handler) = (Arc::clone(&seen), Arc::clone(&handler));
                    let (in_flight, in_flight_max) =
                        (Arc::clone(&in_flight), Arc::clone(&in_flight_max));
                    tokio::spawn(async move {
                        let mut buffer = Vec::new();
                        let mut chunk = [0u8; 4096];
                        while !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                            }
                        }
                        let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                        in_flight_max.fetch_max(now, Ordering::SeqCst);
                        let text = String::from_utf8_lossy(&buffer).to_string();
                        let mut lines = text.split("\r\n");
                        let path = lines
                            .next()
                            .and_then(|line| line.split(' ').nth(1))
                            .unwrap_or_default()
                            .to_owned();
                        let headers = lines
                            .filter_map(|line| line.split_once(':'))
                            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
                            .collect();
                        let count = {
                            let mut seen = seen.lock().unwrap();
                            let count = seen.iter().filter(|s| s.path == path).count();
                            seen.push(Seen {
                                path: path.clone(),
                                headers,
                                at: Instant::now(),
                            });
                            count
                        };
                        let reply = handler(&path, count);
                        tokio::time::sleep(reply.delay).await;
                        if !reply.hang_up {
                            let mut head = format!(
                                "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                                reply.status,
                                reply.body.len()
                            );
                            for (name, value) in &reply.headers {
                                head.push_str(&format!("{name}: {value}\r\n"));
                            }
                            head.push_str("\r\n");
                            let _ = socket.write_all(head.as_bytes()).await;
                            let _ = socket.write_all(&reply.body).await;
                        }
                        let _ = socket.shutdown().await;
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            });
            server
        }

        pub fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }

        pub fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }

        pub fn count(&self, path: &str) -> usize {
            self.seen().iter().filter(|s| s.path == path).count()
        }
    }

    /// A tiny valid PNG.
    pub fn png() -> Vec<u8> {
        let image = image::RgbImage::from_pixel(4, 4, image::Rgb([10, 20, 30]));
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn fast() -> Settings {
        Settings {
            delay: Duration::from_millis(5),
            backoff: Duration::from_millis(20),
            max_backoff: Duration::from_millis(400),
            max_retry_after: Duration::from_secs(5),
            timeout: Duration::from_secs(5),
            ..Settings::default()
        }
    }

    fn tasks(server: &MockServer, count: usize) -> Arc<Vec<Task>> {
        Arc::new(
            (0..count)
                .map(|i| {
                    Task::new(
                        0,
                        server.url(&format!("/t/{i}.png")),
                        PathBuf::from(format!("t/{i}.png")),
                    )
                })
                .collect(),
        )
    }

    struct Run {
        downloader: Arc<Downloader>,
        control: watch::Sender<Control>,
        outcomes: Arc<Mutex<Vec<Outcome>>>,
    }

    fn downloader(dir: &TempDir, settings: Settings) -> Run {
        let (control, receiver) = watch::channel(Control::Run);
        let store = TileStore::new(dir.0.join("overlay"), None);
        Run {
            downloader: Arc::new(Downloader::new(
                http_client().unwrap(),
                settings,
                store,
                receiver,
            )),
            control,
            outcomes: Arc::new(Mutex::new(Vec::new())),
        }
    }

    impl Run {
        async fn run(&self, tasks: Arc<Vec<Task>>) -> Result<(), Stop> {
            let outcomes = Arc::clone(&self.outcomes);
            self.downloader
                .run(
                    tasks,
                    Arc::new(move |_, outcome| outcomes.lock().unwrap().push(outcome.clone())),
                )
                .await
        }

        fn outcomes(&self) -> Vec<Outcome> {
            self.outcomes.lock().unwrap().clone()
        }
    }

    pub fn ensure_crypto() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[test]
    fn defaults_are_polite() {
        let settings = Settings::default();
        assert_eq!(settings.concurrency, 2);
        assert_eq!(settings.delay, Duration::from_millis(250));
        assert_eq!(settings.max_consecutive_failures, 10);
        assert!(USER_AGENT.starts_with("Atlas/"));
        assert!(USER_AGENT.ends_with(" (offline map viewer)"));
        assert!(!USER_AGENT.contains("Mozilla"));
        assert_eq!(
            USER_AGENT,
            format!("Atlas/{} (offline map viewer)", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn estimates_time_under_each_cap() {
        let pace = Pace::from_settings(&crate::settings::DownloadSettings::default());
        assert_eq!(pace.concurrency, 2);
        assert_eq!(pace.delay, Duration::from_millis(250));
        let latency = Duration::from_millis(250);
        // 100 tiles, 2 at a time, 0.5 s each.
        assert!((pace.estimate_seconds(100, 0, latency) - 25.0).abs() < 1e-9);
        let capped = Pace {
            requests_per_minute: Some(60),
            ..pace
        };
        assert!((capped.estimate_seconds(100, 0, latency) - 100.0).abs() < 1e-9);
        let slow = Pace {
            bytes_per_second: Some(1000),
            ..pace
        };
        assert!((slow.estimate_seconds(100, 200_000, latency) - 200.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn keeps_to_a_requests_per_minute_cap() {
        ensure_crypto();
        let dir = TempDir::new("rpm");
        let image = png();
        let server = MockServer::start(Arc::new(move |_, _| Reply::image(image.clone()))).await;
        let mut settings = fast();
        settings.concurrency = 4;
        let run = downloader(&dir, settings);
        // 600 a minute: one request every 100 ms, whatever the workers do.
        *run.downloader.pace.lock().unwrap() = Pace {
            concurrency: 4,
            delay: Duration::from_millis(5),
            requests_per_minute: Some(600),
            bytes_per_second: None,
        };
        run.run(tasks(&server, 6)).await.unwrap();
        let seen = server.seen();
        assert_eq!(seen.len(), 6);
        let mut times: Vec<Instant> = seen.iter().map(|s| s.at).collect();
        times.sort();
        for pair in times.windows(2) {
            assert!(
                pair[1] - pair[0] >= Duration::from_millis(90),
                "{:?}",
                pair[1] - pair[0]
            );
        }
    }

    #[tokio::test]
    async fn keeps_to_a_speed_cap_and_takes_changes_while_running() {
        ensure_crypto();
        let dir = TempDir::new("bps");
        let body = png();
        let size = body.len() as u64;
        let server = MockServer::start(Arc::new(move |_, _| Reply::image(body.clone()))).await;
        let run = downloader(&dir, fast());
        let pace = Arc::new(Mutex::new(Pace {
            concurrency: 1,
            delay: Duration::from_millis(5),
            requests_per_minute: None,
            // Each image takes 150 ms of the budget.
            bytes_per_second: Some(size * 1000 / 150),
        }));
        let downloader = Arc::new(
            Downloader::new(
                http_client().unwrap(),
                fast(),
                TileStore::new(dir.0.join("paced"), None),
                run.control.subscribe(),
            )
            .with_pace(Arc::clone(&pace)),
        );
        let started = Instant::now();
        downloader
            .run(tasks(&server, 4), Arc::new(|_, _| {}))
            .await
            .unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(440),
            "{:?}",
            started.elapsed()
        );

        // Lifting the cap applies to the same downloader.
        pace.lock().unwrap().bytes_per_second = None;
        let more: Arc<Vec<Task>> = Arc::new(
            (10..14)
                .map(|i| {
                    Task::new(
                        0,
                        server.url(&format!("/t/{i}.png")),
                        PathBuf::from(format!("t/{i}.png")),
                    )
                })
                .collect(),
        );
        // Wait out what the cap booked before.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let started = Instant::now();
        downloader.run(more, Arc::new(|_, _| {})).await.unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn parses_retry_after() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        assert_eq!(
            parse_retry_after("120", now),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            parse_retry_after("Sun, 09 Sep 2001 01:47:00 GMT", now),
            Some(Duration::from_secs(20))
        );
        // A date in the past means "now".
        assert_eq!(
            parse_retry_after("Sat, 01 Jan 2000 00:00:00 GMT", now),
            Some(Duration::ZERO)
        );
        assert_eq!(parse_retry_after("soon", now), None);
    }

    #[tokio::test]
    async fn downloads_politely_with_default_pacing() {
        ensure_crypto();
        let dir = TempDir::new("polite");
        let image = png();
        let server = MockServer::start(Arc::new(move |_, _| {
            Reply::image(image.clone()).delayed(Duration::from_millis(30))
        }))
        .await;
        let run = downloader(&dir, Settings::default());
        run.run(tasks(&server, 8)).await.unwrap();

        assert_eq!(run.outcomes().len(), 8);
        assert!(run
            .outcomes()
            .iter()
            .all(|o| matches!(o, Outcome::Saved(_))));
        for i in 0..8 {
            assert_eq!(
                std::fs::read(dir.0.join(format!("overlay/t/{i}.png"))).unwrap(),
                png()
            );
        }
        assert!(server.in_flight_max.load(Ordering::SeqCst) <= 2);
        let seen = server.seen();
        for request in &seen {
            let headers = &request.headers;
            assert_eq!(headers["user-agent"], USER_AGENT);
            assert_eq!(headers["accept"], "image/*");
            for absent in [
                "cookie",
                "referer",
                "origin",
                "sec-fetch-mode",
                "accept-language",
            ] {
                assert!(!headers.contains_key(absent), "unexpected {absent} header");
            }
        }
        // Two workers, each pausing 250 ms after a request: any three
        // consecutive request starts span at least one pause.
        let mut starts: Vec<Instant> = seen.iter().map(|s| s.at).collect();
        starts.sort();
        for window in starts.windows(3) {
            let span = window[2] - window[0];
            assert!(
                span >= Duration::from_millis(240),
                "requests too close: {span:?}"
            );
        }
    }

    #[tokio::test]
    async fn records_404_and_does_not_ask_again() {
        ensure_crypto();
        let dir = TempDir::new("missing");
        let image = png();
        let server = MockServer::start(Arc::new(move |path, _| {
            if path == "/t/1.png" {
                Reply::status(404)
            } else {
                Reply::image(image.clone())
            }
        }))
        .await;
        let run = downloader(&dir, fast());
        run.run(tasks(&server, 3)).await.unwrap();
        assert!(run.outcomes().contains(&Outcome::Missing));
        assert!(dir.0.join("overlay/t/1.png.404").is_file());
        assert!(!dir.0.join("overlay/t/1.png").exists());

        // A second run (a resumed job) asks for nothing.
        let again = downloader(&dir, fast());
        again.run(tasks(&server, 3)).await.unwrap();
        assert_eq!(again.outcomes(), vec![Outcome::Skipped; 3]);
        assert_eq!(server.count("/t/1.png"), 1);
        assert_eq!(server.seen().len(), 3);
    }

    #[tokio::test]
    async fn skips_tiles_already_on_disk() {
        ensure_crypto();
        let dir = TempDir::new("resume");
        std::fs::create_dir_all(dir.0.join("overlay/t")).unwrap();
        std::fs::write(dir.0.join("overlay/t/0.png"), png()).unwrap();
        std::fs::write(dir.0.join("overlay/t/2.png"), png()).unwrap();
        let image = png();
        let server = MockServer::start(Arc::new(move |_, _| Reply::image(image.clone()))).await;
        let run = downloader(&dir, fast());
        run.run(tasks(&server, 4)).await.unwrap();
        let mut paths: Vec<String> = server.seen().into_iter().map(|s| s.path).collect();
        paths.sort();
        assert_eq!(paths, vec!["/t/1.png", "/t/3.png"]);
    }

    #[tokio::test]
    async fn honours_retry_after_and_pauses_every_worker() {
        ensure_crypto();
        let dir = TempDir::new("429");
        let image = png();
        let server = MockServer::start(Arc::new(move |path, count| {
            if path == "/t/0.png" && count == 0 {
                Reply::status(429).header("Retry-After", "1")
            } else {
                Reply::image(image.clone())
            }
        }))
        .await;
        let run = downloader(&dir, fast());
        run.run(tasks(&server, 6)).await.unwrap();
        assert!(run
            .outcomes()
            .iter()
            .all(|o| matches!(o, Outcome::Saved(_))));

        let seen = server.seen();
        let refused_at = seen.iter().find(|s| s.path == "/t/0.png").unwrap().at;
        // Requests already sent may finish, but none starts during the pause.
        let early: Vec<&Seen> = seen
            .iter()
            .filter(|s| {
                s.at > refused_at + Duration::from_millis(150)
                    && s.at < refused_at + Duration::from_millis(950)
            })
            .collect();
        assert!(early.is_empty(), "requests during the pause: {early:?}");
        let retried = seen
            .iter()
            .filter(|s| s.path == "/t/0.png")
            .nth(1)
            .unwrap()
            .at;
        assert!(retried - refused_at >= Duration::from_millis(950));
    }

    #[tokio::test]
    async fn retries_server_errors_with_doubling_waits() {
        ensure_crypto();
        let dir = TempDir::new("5xx");
        let image = png();
        let server = MockServer::start(Arc::new(move |_, count| match count {
            0 => Reply::status(503),
            1 => Reply::status(500),
            2 => Reply {
                hang_up: true,
                ..Reply::status(200)
            },
            _ => Reply::image(image.clone()),
        }))
        .await;
        let settings = Settings {
            backoff: Duration::from_millis(100),
            ..fast()
        };
        let run = downloader(&dir, settings);
        run.run(tasks(&server, 1)).await.unwrap();
        assert!(matches!(run.outcomes()[0], Outcome::Saved(_)));
        let times: Vec<Instant> = server.seen().iter().map(|s| s.at).collect();
        assert_eq!(times.len(), 4);
        let gaps: Vec<Duration> = times.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(gaps[0] >= Duration::from_millis(100), "{gaps:?}");
        assert!(gaps[1] >= Duration::from_millis(200), "{gaps:?}");
        assert!(gaps[2] >= Duration::from_millis(400), "{gaps:?}");
    }

    #[tokio::test]
    async fn gives_up_on_a_tile_after_the_last_attempt() {
        ensure_crypto();
        let dir = TempDir::new("5xx-fail");
        let server = MockServer::start(Arc::new(|_, _| Reply::status(502))).await;
        let settings = Settings {
            max_attempts: 3,
            ..fast()
        };
        let run = downloader(&dir, settings);
        run.run(tasks(&server, 1)).await.unwrap();
        assert!(matches!(run.outcomes()[0], Outcome::Failed(_)));
        assert_eq!(server.seen().len(), 3);
    }

    #[tokio::test]
    async fn stops_when_access_is_refused() {
        ensure_crypto();
        let dir = TempDir::new("403");
        let server = MockServer::start(Arc::new(|_, _| Reply::status(403))).await;
        let run = downloader(&dir, fast());
        let stop = run.run(tasks(&server, 20)).await.unwrap_err();
        assert_eq!(stop, Stop::Refused(403));
        assert!(stop.message().contains("refused access"));
        // Only the requests already in flight; no retries.
        assert!(server.seen().len() <= 2);

        let server = MockServer::start(Arc::new(|_, _| Reply::status(401))).await;
        let run = downloader(&dir, fast());
        assert_eq!(run.run(tasks(&server, 20)).await, Err(Stop::Refused(401)));
    }

    #[tokio::test]
    async fn stops_when_the_server_sends_a_web_page() {
        ensure_crypto();
        let dir = TempDir::new("html");
        let server = MockServer::start(Arc::new(|_, _| Reply {
            headers: vec![("Content-Type", "text/html; charset=utf-8".to_owned())],
            body: b"<!doctype html><title>Checking your browser</title>".to_vec(),
            ..Reply::status(200)
        }))
        .await;
        let run = downloader(&dir, fast());
        let stop = run.run(tasks(&server, 20)).await.unwrap_err();
        assert_eq!(stop, Stop::WebPage);
        assert!(stop.message().contains("web page"));
        assert!(server.seen().len() <= 2);
        assert!(!dir.0.join("overlay/t/0.png").exists());

        // Markup sent with an image type is still a web page.
        let server = MockServer::start(Arc::new(|_, _| Reply {
            headers: vec![("Content-Type", "image/png".to_owned())],
            body: b"  <html></html>".to_vec(),
            ..Reply::status(200)
        }))
        .await;
        let run = downloader(&dir, fast());
        assert_eq!(run.run(tasks(&server, 5)).await, Err(Stop::WebPage));
    }

    /// Tasks that say where each tile sits: a level of 4 x 3 tiles, row by row.
    fn placed_tasks(server: &MockServer, count: usize) -> Arc<Vec<Task>> {
        let label: Arc<str> = Arc::from("Surface (Island)");
        Arc::new(
            (0..count)
                .map(|i| Task {
                    label: Some(Arc::clone(&label)),
                    place: Some(Place {
                        z: 2,
                        source_z: 5,
                        x: i as u64 % 4,
                        y: i as u64 / 4,
                        columns: 4,
                        rows: 3,
                    }),
                    ..Task::new(
                        0,
                        server.url(&format!("/t/{i}.png")),
                        PathBuf::from(format!("t/{i}.png")),
                    )
                })
                .collect(),
        )
    }

    fn logged(dir: &TempDir) -> String {
        std::fs::read_to_string(dir.0.join("logs").join(crate::activity::LOG_FILE)).unwrap()
    }

    #[tokio::test]
    async fn records_a_refusal_in_full_and_stops_at_once() {
        ensure_crypto();
        let dir = TempDir::new("403-detail");
        let image = png();
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error>\r\n\t<Code>AccessDenied</Code>\u{7}<Message>Access Denied</Message></Error>";
        let server = MockServer::start(Arc::new(move |path, _| {
            let n: usize = path[3..path.len() - 4].parse().unwrap();
            if n < 8 {
                Reply::image(image.clone())
            } else {
                Reply {
                    body: xml.as_bytes().to_vec(),
                    ..Reply::status(403)
                }
                .header("Content-Type", "application/xml")
                .header("Server", "TestServer/1.0")
                .header("x-amz-request-id", "ABC123")
                .header("X-Unrelated", "not recorded")
            }
        }))
        .await;
        let log = ActivityLog::new(dir.0.join("logs"), "Atlas", "0.3.1");
        let (control, receiver) = watch::channel(Control::Run);
        let downloader = Arc::new(
            Downloader::new(
                http_client().unwrap(),
                Settings {
                    concurrency: 1,
                    ..fast()
                },
                TileStore::new(dir.0.join("overlay"), None),
                receiver,
            )
            .with_log(log),
        );
        let stop = downloader
            .run(placed_tasks(&server, 12), Arc::new(|_, _| {}))
            .await
            .unwrap_err();
        assert_eq!(stop, Stop::Refused(403));
        // Eight images, then the refusal; nothing after it, and no retry.
        assert_eq!(server.seen().len(), 9);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(server.seen().len(), 9);
        drop(control);

        let detail = downloader.stop_detail().unwrap();
        assert_eq!(detail.kind, "refused");
        assert_eq!(detail.url, server.url("/t/8.png"));
        assert_eq!(detail.status, 403);
        assert_eq!(detail.attempt, 1);
        assert_eq!(detail.saved_before, 8);
        assert_eq!(detail.saved_from_host, 8);
        assert_eq!(detail.host, server.addr.to_string());
        assert_eq!(detail.layer.as_deref(), Some("Surface (Island)"));
        let place = detail.place.unwrap();
        assert_eq!((place.x, place.y, place.columns, place.rows), (0, 2, 4, 3));
        assert!(place.is_edge());
        assert!(detail
            .headers
            .contains(&("server".to_owned(), "TestServer/1.0".to_owned())));
        assert!(detail
            .headers
            .contains(&("content-type".to_owned(), "application/xml".to_owned())));
        assert!(detail
            .headers
            .contains(&("x-amz-request-id".to_owned(), "ABC123".to_owned())));
        assert!(!detail.headers.iter().any(|(name, _)| name == "x-unrelated"));
        assert_eq!(
            detail.body.as_deref(),
            Some("<?xml version=\"1.0\" encoding=\"UTF-8\"?> <Error> <Code>AccessDenied</Code><Message>Access Denied</Message></Error>")
        );

        let text = logged(&dir);
        let line = text
            .lines()
            .find(|line| line.contains("refused access"))
            .unwrap();
        assert!(crate::activity::tests::well_formed(line), "{line}");
        assert!(
            line.contains("] download error: Stopped: the server refused access (HTTP 403) for ")
        );
        for part in [
            server.url("/t/8.png").as_str(),
            "layer Surface (Island), level 2 (remote zoom 5), column 0 of 4, row 2 of 3 (counted from 0; an edge tile)",
            "attempt 1",
            &format!("this job had saved 8 images before it, 8 of them from {}", server.addr),
            "server: TestServer/1.0",
            "x-amz-request-id: ABC123",
            "body: <?xml version=\"1.0\"",
            "AccessDenied",
            "not retried",
        ] {
            assert!(line.contains(part), "{part} missing from {line}");
        }
    }

    #[tokio::test]
    async fn records_a_web_page_answer_in_full() {
        ensure_crypto();
        let dir = TempDir::new("html-detail");
        let image = png();
        let server = MockServer::start(Arc::new(move |path, _| {
            if path == "/t/0.png" || path == "/t/1.png" {
                return Reply::image(image.clone());
            }
            Reply {
                headers: vec![
                    ("Content-Type", "text/html; charset=utf-8".to_owned()),
                    ("cf-mitigated", "challenge".to_owned()),
                ],
                body: format!(
                    "<!doctype html>\n<title>Checking\tyour browser</title>{}",
                    "x".repeat(500)
                )
                .into_bytes(),
                ..Reply::status(200)
            }
        }))
        .await;
        let log = ActivityLog::new(dir.0.join("logs"), "Atlas", "0.3.1");
        let (_control, receiver) = watch::channel(Control::Run);
        let downloader = Arc::new(
            Downloader::new(
                http_client().unwrap(),
                Settings {
                    concurrency: 1,
                    ..fast()
                },
                TileStore::new(dir.0.join("overlay"), None),
                receiver,
            )
            .with_log(log),
        );
        let stop = downloader
            .run(placed_tasks(&server, 6), Arc::new(|_, _| {}))
            .await
            .unwrap_err();
        assert_eq!(stop, Stop::WebPage);
        assert_eq!(server.seen().len(), 3);
        let detail = downloader.stop_detail().unwrap();
        assert_eq!(detail.kind, "web-page");
        assert_eq!(detail.status, 200);
        assert_eq!(detail.saved_before, 2);
        assert!(detail
            .headers
            .contains(&("cf-mitigated".to_owned(), "challenge".to_owned())));
        let body = detail.body.unwrap();
        assert!(body.starts_with("<!doctype html> <title>Checking your browser</title>xxx"));
        assert_eq!(body.chars().count(), BODY_EXCERPT_CHARS);
        let text = logged(&dir);
        assert!(text.contains(&format!(
            "Stopped: the server sent a web page instead of an image (HTTP 200) for {}",
            server.url("/t/2.png")
        )));
        assert!(text.contains("cf-mitigated: challenge"));
    }

    #[test]
    fn quotes_only_text_bodies() {
        assert_eq!(
            body_excerpt("application/json", br#"{"error":"forbidden"}"#).as_deref(),
            Some(r#"{"error":"forbidden"}"#)
        );
        assert_eq!(
            body_excerpt("text/plain", b"Forbidden").as_deref(),
            Some("Forbidden")
        );
        assert_eq!(
            body_excerpt("", b"plain words").as_deref(),
            Some("plain words")
        );
        assert_eq!(body_excerpt("image/png", &png()), None);
        assert_eq!(body_excerpt("", &png()), None);
        assert_eq!(body_excerpt("text/html", b"  \n "), None);
        // Cut in the middle of a character at the read limit.
        assert_eq!(
            body_excerpt("text/plain", "caf\u{e9}".as_bytes()[..4].as_ref()).as_deref(),
            Some("caf")
        );
    }

    #[tokio::test]
    async fn logs_every_failed_answer_with_its_address() {
        ensure_crypto();
        let dir = TempDir::new("log-failures");
        let image = png();
        let server = MockServer::start(Arc::new(move |path, count| match (path, count) {
            ("/t/0.png", 0) => Reply::status(503),
            ("/t/1.png", 0) => Reply::status(429).header("Retry-After", "0"),
            ("/t/2.png", _) => Reply::status(400),
            ("/t/3.png", _) => Reply {
                headers: vec![("Content-Type", "application/octet-stream".to_owned())],
                body: vec![0, 1, 2, 3],
                ..Reply::status(200)
            },
            _ => Reply::image(image.clone()),
        }))
        .await;
        let log = ActivityLog::new(dir.0.join("logs"), "Atlas", "0.3.1");
        let (_control, receiver) = watch::channel(Control::Run);
        let downloader = Arc::new(
            Downloader::new(
                http_client().unwrap(),
                Settings {
                    concurrency: 1,
                    ..fast()
                },
                TileStore::new(dir.0.join("overlay"), None),
                receiver,
            )
            .with_log(log),
        );
        downloader
            .run(placed_tasks(&server, 5), Arc::new(|_, _| {}))
            .await
            .unwrap();
        let text = logged(&dir);
        for expected in [
            format!("Server error (HTTP 503 Service Unavailable) for {} (attempt 1 of 5); trying again in", server.url("/t/0.png")),
            format!("The server asked to slow down (HTTP 429, Retry-After: 0); every download waits 0 ms for {} (attempt 1 of 5); trying again after that pause", server.url("/t/1.png")),
            format!("HTTP 400 Bad Request for {} (attempt 1); not retried", server.url("/t/2.png")),
            format!("The answer for {} is not an image (application/octet-stream, 4 bytes)", server.url("/t/3.png")),
        ] {
            assert!(text.contains(&expected), "{expected}\n{text}");
        }
        assert!(text.lines().all(crate::activity::tests::well_formed));
        // No line for an image that simply worked.
        assert!(!text.contains(&server.url("/t/4.png")));
    }

    #[tokio::test]
    async fn stops_after_ten_failures_in_a_row() {
        ensure_crypto();
        let dir = TempDir::new("failures");
        let server = MockServer::start(Arc::new(|_, _| Reply::status(400))).await;
        let run = downloader(&dir, fast());
        let stop = run.run(tasks(&server, 40)).await.unwrap_err();
        assert_eq!(stop, Stop::TooManyFailures(10));
        let requests = server.seen().len();
        assert!((10..=11).contains(&requests), "{requests} requests");
    }

    #[tokio::test]
    async fn a_success_resets_the_failure_count() {
        ensure_crypto();
        let dir = TempDir::new("failures-reset");
        let image = png();
        let server = MockServer::start(Arc::new(move |path, _| {
            // Every ninth tile works.
            let n: usize = path[3..path.len() - 4].parse().unwrap();
            if n % 9 == 8 {
                Reply::image(image.clone())
            } else {
                Reply::status(400)
            }
        }))
        .await;
        let settings = Settings {
            concurrency: 1,
            ..fast()
        };
        let run = downloader(&dir, settings);
        run.run(tasks(&server, 27)).await.unwrap();
        assert_eq!(run.outcomes().len(), 27);
    }

    #[tokio::test]
    async fn cancels_promptly_without_partial_files() {
        ensure_crypto();
        let dir = TempDir::new("cancel");
        let image = png();
        let server = MockServer::start(Arc::new(move |_, _| {
            Reply::image(image.clone()).delayed(Duration::from_secs(5))
        }))
        .await;
        let run = downloader(&dir, fast());
        let control = run.control.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            control.send(Control::Cancel).unwrap();
        });
        let started = Instant::now();
        assert_eq!(run.run(tasks(&server, 10)).await, Err(Stop::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!dir.0.join("overlay/t").exists());
    }

    #[tokio::test]
    async fn pauses_and_resumes() {
        ensure_crypto();
        let dir = TempDir::new("pause");
        let image = png();
        let server = MockServer::start(Arc::new(move |_, _| Reply::image(image.clone()))).await;
        let run = downloader(
            &dir,
            Settings {
                delay: Duration::from_millis(50),
                ..fast()
            },
        );
        let control = run.control.clone();
        let seen = Arc::clone(&server.seen);
        let checker = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            control.send(Control::Pause).unwrap();
            // Let requests in flight finish, then nothing may start.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let before = seen.lock().unwrap().len();
            tokio::time::sleep(Duration::from_millis(400)).await;
            let after = seen.lock().unwrap().len();
            control.send(Control::Run).unwrap();
            (before, after)
        });
        run.run(tasks(&server, 12)).await.unwrap();
        let (before, after) = checker.await.unwrap();
        assert_eq!(before, after, "no requests while paused");
        assert!(before < 12);
        assert_eq!(server.seen().len(), 12);
    }
}
