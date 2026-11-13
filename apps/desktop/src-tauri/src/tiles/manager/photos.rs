//! "Download location photos": the pictures a pack lists to be fetched
//! later (a `remote` address in `pictures.json`, see the pack format), for
//! the photos on its locations and list entries and the pictures of its
//! guide pages. Only in a build with downloads, only when the person asks,
//! and done as map images are: the job takes its turn in the same line as
//! map image downloads, with the computer-wide lock, the same honest
//! User-Agent, the same rules for redirects, errors, refusals and web pages
//! (see `download.rs`), pause, resume and cancel, and the activity log. It
//! asks for one picture at a time, with the pause of the person's download
//! settings after each.
//!
//! A picture goes where the pack names its file, as a map image does: into
//! the pack folder the person keeps, or the overlay of a pack that comes
//! with the app, so the `atlas-pack` protocol serves it from the pack. Each
//! is made at most [`PHOTO_WIDTH`] pixels wide before it is written, kept
//! in the kind its file name says. A picture is never put in an exported
//! map pack file unless the pack marks it as shareable (see `packfile`).
//!
//! The job is kept in the download manager under its own key,
//! `<pack id>#photos` ([`photos_key`]), next to the pack's map image job.

use std::{io::Cursor, path::Path, sync::Arc};

use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder},
    imageops::FilterType,
    DynamicImage, ImageEncoder, ImageFormat, ImageReader, Limits,
};
use serde_json::Value;

use super::*;
use crate::{
    library::MAX_PACK_FILE_BYTES,
    packfile::is_picture_path,
    tiles::download::{Task, Transform},
};

/// The key of a pack's photo job among the download jobs.
pub const PHOTOS_SUFFIX: &str = "#photos";

pub fn photos_key(pack_id: &str) -> String {
    format!("{pack_id}{PHOTOS_SUFFIX}")
}

/// The pack id of a job key: the key itself for a map image job.
pub fn pack_of_key(key: &str) -> &str {
    key.strip_suffix(PHOTOS_SUFFIX).unwrap_or(key)
}

/// The widest a downloaded photo is kept, in pixels.
pub const PHOTO_WIDTH: u32 = 1280;
/// The largest answer taken as a picture.
const MAX_PHOTO_BYTES: usize = 24 << 20;
/// The most memory a picture may take to decode.
const MAX_DECODE_BYTES: u64 = 256 << 20;
/// The widest or tallest picture decoded.
const MAX_SIDE: u32 = 16_384;
const JPEG_QUALITY: u8 = 85;
/// The line the photos of a job are counted under.
const PHOTOS_NAME: &str = "Location photos";

/// What the web app needs to offer "Download location photos".
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoPlan {
    pub pack_id: String,
    /// Pictures the pack lists to be fetched later.
    pub total: u64,
    /// Of those, not on this device yet.
    pub remaining: u64,
    /// The servers they come from.
    pub hosts: Vec<String>,
    /// The current or last photo job of this pack in this session.
    pub job: Option<Snapshot>,
    /// The title of another job that downloads now; a new job waits for it.
    pub busy_with: Option<String>,
}

/// Whether an address may be asked for a picture: https, or plain http to
/// this computer only (for tests and local servers).
fn usable_address(address: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(address) else {
        return false;
    };
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

/// The pictures a pack lists to be fetched later: each address and where
/// its file goes, relative to the pack. Pictures with an address Atlas does
/// not ask, or a file name no picture has, are left out.
pub fn photo_tasks(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let path = root.join(crate::packfile::PICTURES_FILE);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(Vec::new()),
    };
    if metadata.len() > MAX_PACK_FILE_BYTES as u64 {
        return Err("The pack's list of pictures is too large.".to_owned());
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read the pack's pictures: {error}"))?;
    let Ok(Value::Array(pictures)) = serde_json::from_str(text.trim_start_matches('\u{feff}'))
    else {
        return Err("The pack's list of pictures cannot be read.".to_owned());
    };
    let mut tasks = Vec::new();
    for picture in &pictures {
        let (Some(remote), Some(file)) = (
            picture.get("remote").and_then(Value::as_str),
            picture.get("file").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !usable_address(remote) || !is_picture_path(file) {
            continue;
        }
        let Some(relative) = relative_path(file) else {
            continue;
        };
        if tasks.iter().any(|(_, path)| *path == relative) {
            continue;
        }
        tasks.push((remote.to_owned(), relative));
    }
    Ok(tasks)
}

/// A downloaded picture made ready to keep: at most [`PHOTO_WIDTH`] pixels
/// wide, its shape kept, never made larger, in the kind its file name says
/// (JPEG, PNG, or lossless WebP). One that is narrow enough and already of
/// that kind is kept as it came.
pub fn shrink_photo(bytes: Vec<u8>, file: &Path) -> Result<Vec<u8>, String> {
    let wanted = match file
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => ImageFormat::Jpeg,
        Some("png") => ImageFormat::Png,
        Some("webp") => ImageFormat::WebP,
        _ => return Err("its file is not a JPEG, PNG or WebP picture".to_owned()),
    };
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| format!("it could not be read: {error}"))?;
    let format = reader.format();
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    reader.limits(limits);
    let (width, _) = reader
        .into_dimensions()
        .map_err(|error| format!("it could not be read: {error}"))?;
    if width <= PHOTO_WIDTH && format == Some(wanted) {
        return Ok(bytes);
    }
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| format!("it could not be read: {error}"))?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    reader.limits(limits);
    let mut image = reader
        .decode()
        .map_err(|error| format!("it could not be read: {error}"))?;
    drop(bytes);
    if image.width() > PHOTO_WIDTH {
        let height = (u64::from(image.height()) * u64::from(PHOTO_WIDTH))
            .div_ceil(u64::from(image.width()))
            .max(1) as u32;
        image = image.resize_exact(PHOTO_WIDTH, height, FilterType::Triangle);
    }
    encode(&image, wanted)
}

fn encode(image: &DynamicImage, format: ImageFormat) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    let result = match format {
        ImageFormat::Jpeg => {
            let rgb = image.to_rgb8();
            JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).write_image(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
        }
        ImageFormat::Png => {
            let rgba = image.to_rgba8();
            PngEncoder::new(&mut out).write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
        }
        _ => {
            let rgba = image.to_rgba8();
            WebPEncoder::new_lossless(&mut out).write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
        }
    };
    result.map_err(|error| format!("it could not be made smaller: {error}"))?;
    Ok(out.into_inner())
}

fn host_text(address: &str) -> String {
    reqwest::Url::parse(address)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default()
}

impl DownloadManager {
    /// How many pictures a pack lists to be fetched later, how many are not
    /// here yet, and its photo job. Blocking: it looks at every file.
    pub fn photos_plan(&self, pack_id: &str) -> Result<PhotoPlan, String> {
        let store = self.store(pack_id)?;
        let root = store.bundled.clone().expect("set by store()");
        let tasks = photo_tasks(&root)?;
        let remaining = tasks
            .iter()
            .filter(|(_, path)| !store.is_done(path))
            .count() as u64;
        let mut hosts: Vec<String> = tasks.iter().map(|(url, _)| host_text(url)).collect();
        hosts.sort();
        hosts.dedup();
        let key = photos_key(pack_id);
        let schedule = lock(&self.schedule);
        let job = schedule
            .jobs
            .get(&key)
            .map(|job| Self::snapshot_in(&schedule, job));
        let busy_with = schedule
            .holder
            .as_ref()
            .filter(|id| **id != key)
            .and_then(|id| schedule.jobs.get(id))
            .map(|job| job.title.clone());
        Ok(PhotoPlan {
            pack_id: pack_id.to_owned(),
            total: tasks.len() as u64,
            remaining,
            hosts,
            job,
            busy_with,
        })
    }

    /// The current or last photo job of a pack.
    pub fn photos_snapshot(&self, pack_id: &str) -> Option<Snapshot> {
        self.snapshot(&photos_key(pack_id))
    }

    /// Starts downloading the pictures a pack lists to be fetched later
    /// that are not here yet. When another job is downloading, it queues
    /// behind it.
    pub fn start_photos(self: &Arc<Self>, pack_id: &str) -> Result<Snapshot, String> {
        let store = self.store(pack_id)?;
        let root = store.bundled.clone().expect("set by store()");
        let all = photo_tasks(&root)?;
        if all.is_empty() {
            return Err("This pack lists no photos to download.".to_owned());
        }
        let client =
            http_client().map_err(|error| format!("Could not start downloading: {error}"))?;
        let folder = self.pack_folder(pack_id);
        let title = read_head(&root).map_or_else(|_| pack_id.to_owned(), |head| head.title);
        let key = photos_key(pack_id);
        let mut schedule = lock(&self.schedule);
        if let Some(job) = schedule.jobs.get(&key).filter(|job| !job.finished) {
            return Err(if job.paused {
                "This download is paused. Resume it instead.".to_owned()
            } else {
                "The photos of this pack are already downloading or waiting their turn.".to_owned()
            });
        }
        let pack_lock = match &folder {
            Some(folder) => Some(PackLock::acquire(folder)?),
            None => None,
        };
        let total = all.len() as u64;
        let status_revision = schedule
            .jobs
            .get(&key)
            .map_or(0, |job| lock(&job.progress).snapshot.status_revision);
        let now = Instant::now();
        let pace = self.current_pace();
        let progress = Arc::new(Mutex::new(Progress {
            snapshot: Snapshot {
                pack_id: pack_id.to_owned(),
                title: title.clone(),
                detail: Detail::Full,
                state: JobState::Queued,
                reason: None,
                stop_detail: None,
                queue_position: None,
                waiting_for: None,
                maps: vec![MapProgress {
                    map_id: "photos".to_owned(),
                    name: PHOTOS_NAME.to_owned(),
                    done: 0,
                    total,
                }],
                done: 0,
                total,
                saved: 0,
                missing: 0,
                not_asked: 0,
                failed: 0,
                bytes: 0,
                tiles_per_second: 0.0,
                bytes_per_second: 0.0,
                seconds_left: Some(estimate_seconds(
                    &Pace {
                        concurrency: 1,
                        ..pace
                    },
                    total,
                    total * 200_000,
                )),
                status_revision,
            },
            layer_maps: vec![0],
            recent: VecDeque::new(),
            started: now,
            created: now,
            logged_at: now,
            logged_done: 0,
            denied: 0,
        }));
        // One picture at a time, with the person's pause after each.
        let photo_pace: SharedPace = Arc::new(Mutex::new(Pace {
            concurrency: 1,
            ..pace
        }));
        let settings = Settings {
            concurrency: 1,
            max_tile_bytes: MAX_PHOTO_BYTES,
            ..self.settings.clone()
        };
        let transform: Transform =
            Arc::new(|task: &Task, bytes: Vec<u8>| shrink_photo(bytes, &task.path));
        let (control, receiver) = watch::channel(Control::Pause);
        let downloader = Arc::new(
            Downloader::new(client, settings, store, receiver)
                .with_pace(photo_pace)
                .with_log(self.log.clone())
                .with_transform(transform),
        );
        schedule.jobs.insert(
            key.clone(),
            Job {
                pack_id: key.clone(),
                title: format!("{PHOTOS_NAME} of {title}"),
                control,
                progress: Arc::clone(&progress),
                downloader: Arc::clone(&downloader),
                finished: false,
                paused: false,
                lock: pack_lock,
                photos: true,
            },
        );
        schedule.queue.push_back(key.clone());
        drop(schedule);

        let this = Arc::clone(self);
        let label: Arc<str> = Arc::from(PHOTOS_NAME);
        let mut hosts: Vec<String> = all.iter().map(|(url, _)| host_text(url)).collect();
        hosts.sort();
        hosts.dedup();
        let tasks: Vec<Task> = all
            .into_iter()
            .map(|(url, path)| Task {
                label: Some(Arc::clone(&label)),
                ..Task::new(0, url, path)
            })
            .collect();
        let job_key = key.clone();
        let job_title = title.clone();
        tokio::spawn(async move {
            let title = job_title;
            let present = {
                let (store, paths) = (
                    downloader.store().clone(),
                    tasks
                        .iter()
                        .map(|task| task.path.clone())
                        .collect::<Vec<_>>(),
                );
                tokio::task::spawn_blocking(move || {
                    paths.iter().filter(|path| store.is_done(path)).count() as u64
                })
                .await
                .unwrap_or(0)
            };
            this.log.info(
                Area::Download,
                format!(
                    "Download started: {PHOTOS_NAME} of {title} ({}), {total} pictures listed, {present} already there, {} to fetch, one at a time | from {} | settings: {}",
                    pack_of_key(&job_key),
                    total.saturating_sub(present),
                    hosts.join(", "),
                    this.current_pace().describe(),
                ),
            );
            let on_outcome: OnOutcome = {
                let progress = Arc::clone(&progress);
                let log = this.log.clone();
                Arc::new(move |task: &Task, outcome: &Outcome| {
                    let line = {
                        let mut progress = lock(&progress);
                        progress.record(task, outcome);
                        if matches!(outcome, Outcome::Saved(_)) {
                            progress.snapshot.status_revision += 1;
                        }
                        progress.progress_line()
                    };
                    if let Some(line) = line {
                        log.info(Area::Download, line);
                    }
                })
            };
            let mut result = downloader.run(Arc::new(tasks), on_outcome).await;
            if result.is_ok() {
                result = downloader.commit_pending();
            }
            this.finish(&job_key, Detail::Full, result);
        });
        self.dispatch();
        let snapshot = self.snapshot(&key).expect("just added");
        if snapshot.state == JobState::Queued {
            self.log.info(
                Area::Download,
                format!(
                    "Download of the photos of {title} ({pack_id}) is queued, number {} in line",
                    snapshot.queue_position.unwrap_or(0),
                ),
            );
        }
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use image::{Rgb, RgbImage};

    use super::*;
    use crate::tiles::{
        download::{
            tests::{ensure_crypto, MockServer, Reply},
            Settings,
        },
        store::tests::TempDir,
    };

    fn picture(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let image =
            DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([90, 140, 60])));
        encode(&image, format).unwrap()
    }

    fn size_of(bytes: &[u8]) -> (u32, u32) {
        ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap()
    }

    #[test]
    fn makes_a_wide_photo_smaller_and_keeps_a_narrow_one() {
        let wide = picture(2560, 1440, ImageFormat::Png);
        let small = shrink_photo(wide, Path::new("pictures/a.jpg")).unwrap();
        assert!(small.starts_with(&[0xff, 0xd8, 0xff]));
        assert_eq!(size_of(&small), (1280, 720));
        let narrow = picture(640, 400, ImageFormat::Jpeg);
        assert_eq!(
            shrink_photo(narrow.clone(), Path::new("pictures/b.jpg")).unwrap(),
            narrow
        );
        // Kept in the kind its file name says, never made larger.
        let png = shrink_photo(narrow, Path::new("pictures/b.png")).unwrap();
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(size_of(&png), (640, 400));
        let webp =
            shrink_photo(picture(1500, 300, ImageFormat::Png), Path::new("p/c.webp")).unwrap();
        assert_eq!(&webp[8..12], b"WEBP");
        assert_eq!(size_of(&webp), (1280, 256));
        assert!(shrink_photo(b"not a picture".to_vec(), Path::new("p/d.jpg")).is_err());
        assert!(shrink_photo(picture(10, 10, ImageFormat::Png), Path::new("p/e.gif")).is_err());
    }

    #[test]
    fn lists_only_pictures_it_may_ask_for() {
        let dir = TempDir::new("photo-tasks");
        fs::write(
            dir.0.join("pictures.json"),
            r#"[
              {"id":"t:picture:a","file":"pictures/a.jpg","shareable":false,"remote":"https://pictures.example.com/a.png"},
              {"id":"t:picture:b","file":"pictures/b.jpg","shareable":true},
              {"id":"t:picture:c","file":"pictures/c.jpg","remote":"http://pictures.example.com/c.png"},
              {"id":"t:picture:d","file":"../d.jpg","remote":"https://pictures.example.com/d.png"},
              {"id":"t:picture:e","file":"pictures/e.png","remote":"http://127.0.0.1:9/e.png"},
              {"id":"t:picture:f","file":"pictures/f.png","remote":"ftp://pictures.example.com/f.png"}
            ]"#,
        )
        .unwrap();
        let tasks = photo_tasks(&dir.0).unwrap();
        assert_eq!(
            tasks,
            vec![
                (
                    "https://pictures.example.com/a.png".to_owned(),
                    PathBuf::from("pictures/a.jpg")
                ),
                (
                    "http://127.0.0.1:9/e.png".to_owned(),
                    PathBuf::from("pictures/e.png")
                ),
            ]
        );
        assert!(photo_tasks(&dir.0.join("none")).unwrap().is_empty());
    }

    fn pack(dir: &Path, server: &MockServer) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            r#"{"schemaVersion":2,"gameId":"t","title":"Test Isle","packVersion":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("pictures.json"),
            format!(
                r#"[{{"id":"t:picture:a","file":"pictures/a.jpg","shareable":false,"remote":"{}"}},
                    {{"id":"t:picture:b","file":"pictures/b.jpg","shareable":false,"remote":"{}"}},
                    {{"id":"t:picture:c","file":"pictures/c.png","shareable":false,"remote":"{}"}}]"#,
                server.url("/media/a.png"),
                server.url("/media/b.png"),
                server.url("/media/c.png"),
            ),
        )
        .unwrap();
    }

    fn manager(dir: &TempDir, pack_dir: &Path) -> Arc<DownloadManager> {
        let registry = PackRegistry::default();
        registry.register_folder("t", pack_dir).unwrap();
        Arc::new(
            DownloadManager::with_settings(
                dir.0.join("data"),
                registry,
                Settings {
                    delay: Duration::from_millis(1),
                    backoff: Duration::from_millis(1),
                    ..Settings::default()
                },
            )
            .with_log(ActivityLog::new(dir.0.join("logs"), "Atlas", "0.4.4")),
        )
    }

    async fn wait_done(manager: &DownloadManager, pack_id: &str) -> Snapshot {
        for _ in 0..400 {
            let snapshot = manager.photos_snapshot(pack_id).unwrap();
            if !matches!(
                snapshot.state,
                JobState::Queued | JobState::Waiting | JobState::Running
            ) {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the photo job did not end");
    }

    #[tokio::test]
    async fn downloads_listed_pictures_one_at_a_time_and_makes_them_smaller() {
        ensure_crypto();
        let wide = picture(2000, 1000, ImageFormat::Png);
        let server = MockServer::start(Arc::new(move |path: &str, _| match path {
            "/media/a.png" | "/media/c.png" => Reply::image(wide.clone()),
            _ => Reply::status(404),
        }))
        .await;
        let dir = TempDir::new("photo-job");
        let pack_dir = dir.0.join("pack");
        pack(&pack_dir, &server);
        let manager = manager(&dir, &pack_dir);
        let plan = manager.photos_plan("t").unwrap();
        assert_eq!((plan.total, plan.remaining), (3, 3));
        manager.start_photos("t").unwrap();
        assert!(manager.is_active("t"));
        assert_eq!(manager.active_packs(), vec!["t".to_owned()]);
        let done = wait_done(&manager, "t").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        assert_eq!((done.saved, done.missing), (2, 1));
        let a = fs::read(pack_dir.join("pictures/a.jpg")).unwrap();
        assert!(a.starts_with(&[0xff, 0xd8, 0xff]));
        assert_eq!(size_of(&a), (1280, 640));
        assert_eq!(
            size_of(&fs::read(pack_dir.join("pictures/c.png")).unwrap()),
            (1280, 640)
        );
        // One request at a time, every one with the app's own name only.
        assert!(
            server
                .in_flight_max
                .load(std::sync::atomic::Ordering::SeqCst)
                <= 1
        );
        let seen = server.seen();
        assert_eq!(seen.len(), 3);
        for request in &seen {
            assert_eq!(
                request.headers.get("user-agent").map(String::as_str),
                Some(crate::tiles::download::USER_AGENT)
            );
        }
        // Nothing left to fetch: the one not on the server is remembered.
        assert_eq!(manager.photos_plan("t").unwrap().remaining, 0);
        // No job record is left for a photo job.
        assert!(!pack_dir.join(META_DIR).join(JOB_FILE).exists());
    }

    #[tokio::test]
    async fn stops_on_a_refusal() {
        ensure_crypto();
        let server = MockServer::start(Arc::new(|_: &str, _| Reply::status(403))).await;
        let dir = TempDir::new("photo-refused");
        let pack_dir = dir.0.join("pack");
        pack(&pack_dir, &server);
        let manager = manager(&dir, &pack_dir);
        manager.start_photos("t").unwrap();
        let stopped = wait_done(&manager, "t").await;
        assert_eq!(stopped.state, JobState::Stopped);
        assert!(stopped.reason.unwrap().contains("refused"));
        assert_eq!(server.seen().len(), 1);
        assert!(!pack_dir.join("pictures").exists());
    }

    #[tokio::test]
    async fn can_be_paused_and_cancelled() {
        ensure_crypto();
        let png = picture(20, 20, ImageFormat::Png);
        let server = MockServer::start(Arc::new(move |_: &str, _| {
            Reply::image(png.clone()).delayed(Duration::from_millis(60))
        }))
        .await;
        let dir = TempDir::new("photo-pause");
        let pack_dir = dir.0.join("pack");
        pack(&pack_dir, &server);
        let manager = manager(&dir, &pack_dir);
        manager.start_photos("t").unwrap();
        let key = photos_key("t");
        let paused = manager.pause(&key).unwrap();
        assert_eq!(paused.state, JobState::Paused);
        assert_eq!(paused.pack_id, "t");
        assert!(manager.start_photos("t").is_err());
        manager.resume(&key).unwrap();
        assert!(manager.stop_and_wait("t", Duration::from_secs(5)).await);
        assert!(!manager.is_active("t"));
        manager.forget("t");
        assert!(manager.photos_snapshot("t").is_none());
    }

    #[tokio::test]
    async fn stops_for_a_write_of_the_pack_and_starts_again() {
        ensure_crypto();
        let png = picture(20, 20, ImageFormat::Png);
        let server = MockServer::start(Arc::new(move |_: &str, _| {
            Reply::image(png.clone()).delayed(Duration::from_millis(60))
        }))
        .await;
        let dir = TempDir::new("photo-write");
        let pack_dir = dir.0.join("pack");
        pack(&pack_dir, &server);
        let manager = manager(&dir, &pack_dir);
        // None under way: nothing to stop, nothing to start again.
        assert_eq!(
            manager
                .stop_photos_and_wait("t", Duration::from_secs(5))
                .await,
            Some(false)
        );
        manager.start_photos("t").unwrap();
        // The photos do not count as a download of map images.
        assert!(manager.is_active("t"));
        assert!(!manager.images_active("t"));
        assert_eq!(
            manager
                .stop_photos_and_wait("t", Duration::from_secs(5))
                .await,
            Some(true)
        );
        assert!(!manager.is_active("t"));
        // The pack's files can be written now; the download then carries on.
        manager.start_photos("t").unwrap();
        assert_eq!(wait_done(&manager, "t").await.state, JobState::Done);
        assert!(pack_dir.join("pictures/a.jpg").exists());
        // One the person paused is stopped too, but not started again.
        fs::remove_file(pack_dir.join("pictures/a.jpg")).unwrap();
        manager.start_photos("t").unwrap();
        manager.pause(&photos_key("t")).unwrap();
        assert_eq!(
            manager
                .stop_photos_and_wait("t", Duration::from_secs(5))
                .await,
            Some(false)
        );
        assert!(!manager.is_active("t"));
    }
}
