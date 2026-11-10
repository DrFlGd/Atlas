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
//! Requests carry an honest User-Agent naming the app and its version, no
//! cookies and no browser-like headers. None of this can be changed from the
//! web app: it only starts, pauses, resumes and cancels jobs.

use std::{
    future::Future,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, AtomicUsize, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, SystemTime},
};

use reqwest::{
    header::{HeaderMap, ACCEPT, CONTENT_TYPE, RETRY_AFTER},
    Client, StatusCode,
};
use tokio::{sync::watch, task::JoinSet, time::Instant};

use super::{downscale::looks_like_image, store::TileStore};

/// The User-Agent of every tile request.
pub const USER_AGENT: &str = concat!("Atlas/", env!("CARGO_PKG_VERSION"), " (offline map viewer)");

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

/// One tile to download.
#[derive(Clone, Debug)]
pub struct Task {
    /// Index of the layer in the job, passed back with each outcome.
    pub layer: usize,
    pub url: String,
    /// Where the tile goes, relative to the overlay folder.
    pub path: PathBuf,
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

/// Downloads tiles into a store. One downloader can run several batches
/// one after another; pausing, cancelling and the 429 pause apply to all.
pub struct Downloader {
    client: Client,
    settings: Settings,
    store: TileStore,
    control: watch::Receiver<Control>,
    /// Every worker waits until this time before its next request (429).
    paused_until: Mutex<Option<Instant>>,
    consecutive_failures: AtomicU32,
    stop: Mutex<Option<Stop>>,
}

impl Downloader {
    pub fn new(
        client: Client,
        settings: Settings,
        store: TileStore,
        control: watch::Receiver<Control>,
    ) -> Self {
        Self {
            client,
            settings,
            store,
            control,
            paused_until: Mutex::new(None),
            consecutive_failures: AtomicU32::new(0),
            stop: Mutex::new(None),
        }
    }

    pub fn store(&self) -> &TileStore {
        &self.store
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
        for _ in 0..self.settings.concurrency.max(1) {
            let this = Arc::clone(self);
            let tasks = Arc::clone(&tasks);
            let next = Arc::clone(&next);
            let on_outcome = Arc::clone(&on_outcome);
            workers.spawn(async move {
                if let Err(stop) = this.work(&tasks, &next, &on_outcome).await {
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
        tasks: &[Task],
        next: &AtomicUsize,
        on_outcome: &OnOutcome,
    ) -> Result<(), Stop> {
        loop {
            if let Some(stop) = self.stopped() {
                return Err(stop);
            }
            self.wait_while_paused().await?;
            let Some(task) = tasks.get(next.fetch_add(1, Ordering::SeqCst)) else {
                return Ok(());
            };
            if self.store.is_done(&task.path) {
                on_outcome(task, &Outcome::Skipped);
                continue;
            }
            let outcome = self.fetch(task).await?;
            on_outcome(task, &outcome);
            let failures = if matches!(outcome, Outcome::Failed(_)) {
                self.consecutive_failures.fetch_add(1, Ordering::SeqCst) + 1
            } else {
                self.consecutive_failures.store(0, Ordering::SeqCst);
                0
            };
            if failures >= self.settings.max_consecutive_failures {
                return Err(Stop::TooManyFailures(failures));
            }
            self.sleep(self.settings.delay).await?;
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
            let request = self
                .client
                .get(&task.url)
                .header(ACCEPT, "image/*")
                .timeout(settings.timeout)
                .send();
            let retry_wait = match self.unless_cancelled(request).await? {
                Err(error) => {
                    last_error = network_error(&error);
                    None
                }
                Ok(response) => {
                    let status = response.status();
                    match status.as_u16() {
                        404 | 410 => {
                            self.store
                                .mark_missing(&task.path)
                                .map_err(|error| Stop::Disk(error.to_string()))?;
                            return Ok(Outcome::Missing);
                        }
                        401 | 403 => return Err(Stop::Refused(status.as_u16())),
                        429 => {
                            let wait = retry_after(response.headers())
                                .unwrap_or(delay)
                                .min(settings.max_retry_after);
                            // Slow every worker down, not just this one.
                            self.pause_everyone(wait);
                            last_error = "the server asked to slow down (HTTP 429)".to_owned();
                            Some(Duration::ZERO)
                        }
                        500..=599 => {
                            last_error = format!("server error (HTTP {})", status.as_u16());
                            Some(
                                retry_after(response.headers())
                                    .unwrap_or(delay)
                                    .min(settings.max_backoff),
                            )
                        }
                        _ if status.is_success() => match self.save(task, response).await? {
                            Ok(outcome) => return Ok(outcome),
                            Err(error) => {
                                last_error = error;
                                None
                            }
                        },
                        _ => return Ok(Outcome::Failed(http_error(status))),
                    }
                }
            };
            if attempt < settings.max_attempts {
                self.sleep(retry_wait.unwrap_or(delay)).await?;
                delay = (delay * 2).min(settings.max_backoff);
            }
        }
        Ok(Outcome::Failed(last_error))
    }

    /// Reads a successful answer and saves it if it is an image. The inner
    /// error is a network error worth retrying.
    async fn save(
        &self,
        task: &Task,
        mut response: reqwest::Response,
    ) -> Result<Result<Outcome, String>, Stop> {
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if response
            .content_length()
            .is_some_and(|len| len > self.settings.max_tile_bytes as u64)
        {
            return Ok(Ok(Outcome::Failed(
                "the answer is too large for a map image".to_owned(),
            )));
        }
        let mut body = Vec::new();
        loop {
            match self.unless_cancelled(response.chunk()).await? {
                Ok(Some(chunk)) => {
                    body.extend_from_slice(&chunk);
                    if body.len() > self.settings.max_tile_bytes {
                        return Ok(Ok(Outcome::Failed(
                            "the answer is too large for a map image".to_owned(),
                        )));
                    }
                }
                Ok(None) => break,
                Err(error) => return Ok(Err(network_error(&error))),
            }
        }
        if looks_like_image(&body) {
            self.store
                .write(&task.path, &body)
                .map_err(|error| Stop::Disk(error.to_string()))?;
            return Ok(Ok(Outcome::Saved(body.len() as u64)));
        }
        let starts_like_markup = body
            .iter()
            .find(|byte| !byte.is_ascii_whitespace())
            .is_some_and(|byte| *byte == b'<');
        if content_type.contains("html") || starts_like_markup {
            return Err(Stop::WebPage);
        }
        Ok(Ok(Outcome::Failed(format!(
            "the answer is not an image ({})",
            if content_type.is_empty() {
                "no type"
            } else {
                &content_type
            }
        ))))
    }
}

fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the server did not answer in time".to_owned()
    } else if error.is_connect() {
        "could not connect to the server".to_owned()
    } else {
        format!("network error: {error}")
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
    use std::{collections::HashMap, net::SocketAddr};
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
                .map(|i| Task {
                    layer: 0,
                    url: server.url(&format!("/t/{i}.png")),
                    path: PathBuf::from(format!("t/{i}.png")),
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
