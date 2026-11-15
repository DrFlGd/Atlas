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
//! A picture kept at full size names the address its page showed it at
//! (`shownAt`) and a copy for pages (`pageCopy`). Its full file is asked
//! for in place of that copy and kept up to [`FULL_WIDTH`] pixels wide; the
//! copy for pages is made here from the file kept, never with a request of
//! its own. When the full file is refused, not on the server, too large or
//! cannot be read, the copy the page showed is asked for once instead (see
//! `Task::fallback`), and for the rest of the app's run that picture's
//! full file is not asked for again.
//!
//! The job is kept in the download manager under its own key,
//! `<pack id>#photos` ([`photos_key`]), next to the pack's map image job.

use std::{
    io::Cursor,
    path::Path,
    sync::{Arc, OnceLock},
};

use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder},
    imageops::FilterType,
    DynamicImage, ImageEncoder, ImageFormat, ImageReader, Limits, Rgba, RgbaImage,
};
use resvg::{tiny_skia, usvg};
use serde_json::Value;

use super::*;
use crate::{
    library::MAX_PACK_FILE_BYTES,
    packfile::is_picture_path,
    tiles::{
        download::{Task, Transform},
        downscale::looks_like_svg,
    },
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
/// The widest a picture kept at full size is kept, in pixels: wider than
/// any screen shows it, so the larger view of a picture shows it whole.
pub const FULL_WIDTH: u32 = 4096;
/// A copy for pages is made at most this many times the size pages show
/// the picture at, so it stays sharp on a fine screen.
const PAGE_COPY_SCALE: u32 = 2;
/// The largest answer taken as a picture.
const MAX_PHOTO_BYTES: usize = 24 << 20;
/// The most memory a picture may take to decode.
const MAX_DECODE_BYTES: u64 = 256 << 20;
/// The widest or tallest picture decoded.
const MAX_SIDE: u32 = 16_384;
const JPEG_QUALITY: u8 = 85;
/// The largest SVG drawing drawn.
const MAX_DRAWING_BYTES: usize = 4 << 20;
/// A drawing has no pixels of its own: it is drawn at this many times the
/// size it states, so that it stays sharp where a page shows it larger.
const DRAWING_SCALE: f32 = 4.0;
/// The longer side of a drawn drawing is never less and never more than
/// these, in pixels.
const DRAWING_MIN_SIDE: f32 = 64.0;
const DRAWING_MAX_SIDE: f32 = 1024.0;
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

/// A picture's copy for pages (`pageCopy`): where it goes, relative to the
/// pack, and the largest size pages show the picture at, in CSS pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageCopy {
    pub path: PathBuf,
    pub width: u32,
    pub height: Option<u32>,
}

/// One picture a pack lists to be fetched later.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhotoTask {
    pub url: String,
    /// Where its file goes, relative to the pack.
    pub path: PathBuf,
    /// The copy its page showed, asked for only when the full file at
    /// `url` is not kept: on the same host only.
    pub shown_at: Option<String>,
    /// The copy for pages made from the file kept.
    pub page_copy: Option<PageCopy>,
}

impl PhotoTask {
    /// A picture with no copy to fall back on or to make.
    pub fn plain(url: &str, path: &str) -> Self {
        Self {
            url: url.to_owned(),
            path: PathBuf::from(path),
            shown_at: None,
            page_copy: None,
        }
    }
}

/// A size of a copy for pages, when it is one.
fn copy_side(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .filter(|side| (1..=10_000).contains(side))
        .map(|side| side as u32)
}

/// The copy for pages a picture names, when it can be made: a picture file
/// of its own and a size.
fn page_copy_of(picture: &Value, file: &str) -> Option<PageCopy> {
    let copy = picture.get("pageCopy")?;
    let name = copy.get("file").and_then(Value::as_str)?;
    if !is_picture_path(name) || name.eq_ignore_ascii_case(file) {
        return None;
    }
    Some(PageCopy {
        path: relative_path(name)?,
        width: copy_side(copy.get("width"))?,
        height: copy_side(copy.get("height")),
    })
}

/// The pictures a pack lists to be fetched later: each address and where
/// its file goes, relative to the pack, with the copy its page showed and
/// its copy for pages where it names them. Pictures with an address Atlas
/// does not ask, or a file name no picture has, are left out; so is a copy
/// shown on another host than the full file's.
pub fn photo_tasks(root: &Path) -> Result<Vec<PhotoTask>, String> {
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
        if tasks.iter().any(|task: &PhotoTask| task.path == relative) {
            continue;
        }
        let shown_at = picture
            .get("shownAt")
            .and_then(Value::as_str)
            .filter(|shown| {
                usable_address(shown) && *shown != remote && host_text(shown) == host_text(remote)
            })
            .map(str::to_owned);
        tasks.push(PhotoTask {
            url: remote.to_owned(),
            path: relative,
            page_copy: page_copy_of(picture, file),
            shown_at,
        });
    }
    Ok(tasks)
}

/// The computer's fonts, for the text of a drawing: read once, the first
/// time a drawing with text is drawn.
fn fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    Arc::clone(FONTS.get_or_init(|| {
        let mut fonts = usvg::fontdb::Database::new();
        fonts.load_system_fonts();
        Arc::new(fonts)
    }))
}

/// An SVG drawing drawn as a picture: [`DRAWING_SCALE`] times the size it
/// states, its longer side between [`DRAWING_MIN_SIDE`] and
/// [`DRAWING_MAX_SIDE`] pixels, its shape kept. Nothing outside the drawing
/// is read: a file or address it names for a picture inside it is left
/// out, and nothing in it is run.
pub fn draw_svg(bytes: &[u8]) -> Result<DynamicImage, String> {
    if bytes.len() > MAX_DRAWING_BYTES {
        return Err("it is too large a drawing".to_owned());
    }
    let mut options = usvg::Options {
        resources_dir: None,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    if bytes.windows(5).any(|part| part == b"<text") {
        options.fontdb = fonts();
    }
    let tree = usvg::Tree::from_data(bytes, &options)
        .map_err(|error| format!("it could not be read as a drawing: {error}"))?;
    let size = tree.size();
    let longer = size.width().max(size.height());
    let scale = (longer * DRAWING_SCALE).clamp(DRAWING_MIN_SIDE, DRAWING_MAX_SIDE) / longer;
    let side = |length: f32| ((length * scale).ceil() as u32).clamp(1, DRAWING_MAX_SIDE as u32);
    let (width, height) = (side(size.width()), side(size.height()));
    let mut pixmap =
        tiny_skia::Pixmap::new(width, height).ok_or_else(|| "it could not be drawn".to_owned())?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let mut image = RgbaImage::new(width, height);
    for (to, from) in image.pixels_mut().zip(pixmap.pixels()) {
        let colour = from.demultiply();
        *to = Rgba([colour.red(), colour.green(), colour.blue(), colour.alpha()]);
    }
    Ok(DynamicImage::ImageRgba8(image))
}

/// A picture with see-through parts laid on white, for a kind of file that
/// has none (JPEG).
fn on_white(image: &DynamicImage) -> DynamicImage {
    let mut image = image.to_rgba8();
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel.0[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel.0[3] = 255;
    }
    DynamicImage::ImageRgba8(image)
}

/// A downloaded picture made ready to keep: at most [`PHOTO_WIDTH`] pixels
/// wide, its shape kept, never made larger, in the kind its file name says
/// (JPEG, PNG, or lossless WebP). One that is narrow enough and already of
/// that kind is kept as it came. An SVG drawing is drawn as a picture of
/// that kind ([`draw_svg`]), on white where the kind has no see-through
/// parts.
pub fn shrink_photo(bytes: Vec<u8>, file: &Path) -> Result<Vec<u8>, String> {
    fit_picture(bytes, file, PHOTO_WIDTH, None)
}

/// [`shrink_photo`] to at most `max_width` pixels wide and, when given,
/// `max_height` tall, its shape kept, never made larger.
pub fn fit_picture(
    bytes: Vec<u8>,
    file: &Path,
    max_width: u32,
    max_height: Option<u32>,
) -> Result<Vec<u8>, String> {
    let max_width = max_width.max(1);
    let max_height = max_height.unwrap_or(u32::MAX).max(1);
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
    if looks_like_svg(&bytes) {
        let drawn = draw_svg(&bytes)?;
        return if wanted == ImageFormat::Jpeg {
            encode(&on_white(&drawn), wanted)
        } else {
            encode(&drawn, wanted)
        };
    }
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| format!("it could not be read: {error}"))?;
    let format = reader.format();
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    reader.limits(limits);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("it could not be read: {error}"))?;
    if width <= max_width && height <= max_height && format == Some(wanted) {
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
    if image.width() > max_width || image.height() > max_height {
        let (width, height) = fitted(image.width(), image.height(), max_width, max_height);
        image = image.resize_exact(width, height, FilterType::Triangle);
    }
    encode(&image, wanted)
}

/// A size `width` x `height` made to fit `max_width` x `max_height`, its
/// shape kept; at least one pixel each way.
pub fn fitted(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    let (width, height) = (u64::from(width.max(1)), u64::from(height.max(1)));
    let (max_width, max_height) = (u64::from(max_width.max(1)), u64::from(max_height.max(1)));
    if width <= max_width && height <= max_height {
        return (width as u32, height as u32);
    }
    // The side that has to shrink most sets the scale.
    if width * max_height >= height * max_width {
        (
            max_width as u32,
            (height * max_width).div_ceil(width).max(1) as u32,
        )
    } else {
        (
            (width * max_height).div_ceil(height).max(1) as u32,
            max_height as u32,
        )
    }
}

/// What a photo job does with each picture it downloads: the file kept at
/// most [`PHOTO_WIDTH`] pixels wide, or [`FULL_WIDTH`] for one kept at full
/// size; and for a picture with a copy for pages, that copy, made from the
/// file kept at most [`PAGE_COPY_SCALE`] times the size pages show it at
/// and written beside it. A copy that cannot be made is left out: pages
/// then show the file.
fn photo_transform(tasks: &[PhotoTask], store: TileStore) -> Transform {
    let extras: HashMap<PathBuf, (bool, Option<PageCopy>)> = tasks
        .iter()
        .map(|task| {
            (
                task.path.clone(),
                (task.shown_at.is_some(), task.page_copy.clone()),
            )
        })
        .collect();
    Arc::new(move |task: &Task, bytes: Vec<u8>| {
        let (full, copy) = extras.get(&task.path).cloned().unwrap_or((false, None));
        let width = if full { FULL_WIDTH } else { PHOTO_WIDTH };
        let kept = fit_picture(bytes, &task.path, width, None)?;
        if let Some(copy) = copy {
            let made = fit_picture(
                kept.clone(),
                &copy.path,
                copy.width.saturating_mul(PAGE_COPY_SCALE),
                copy.height
                    .map(|height| height.saturating_mul(PAGE_COPY_SCALE)),
            );
            if let Ok(made) = made {
                let _ = store.write(&copy.path, &made);
            }
        }
        Ok(kept)
    })
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
            .filter(|task| !store.is_done(&task.path))
            .count() as u64;
        let mut hosts: Vec<String> = tasks.iter().map(|task| host_text(&task.url)).collect();
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
                finished_at: None,
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
        let transform = photo_transform(&all, store.clone());
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
        let mut hosts: Vec<String> = all.iter().map(|task| host_text(&task.url)).collect();
        hosts.sort();
        hosts.dedup();
        // A full file not kept earlier in this run of the app: only the
        // copy its page showed is asked for.
        let not_kept = lock(&self.full_not_kept).clone();
        let tasks: Vec<Task> = all
            .into_iter()
            .map(|task| {
                let (url, fallback) = match task.shown_at {
                    Some(shown) if not_kept.contains(&task.url) => (shown, None),
                    shown => (task.url, shown),
                };
                Task {
                    label: Some(Arc::clone(&label)),
                    fallback,
                    ..Task::new(0, url, task.path)
                }
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
            lock(&this.full_not_kept).extend(downloader.fell_back());
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

    fn gif_picture(width: u32, height: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut out, ImageFormat::Gif)
            .unwrap();
        out.into_inner()
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
                PhotoTask::plain("https://pictures.example.com/a.png", "pictures/a.jpg"),
                PhotoTask::plain("http://127.0.0.1:9/e.png", "pictures/e.png"),
            ]
        );
        assert!(photo_tasks(&dir.0.join("none")).unwrap().is_empty());
    }

    #[test]
    fn reads_the_copy_shown_and_the_copy_for_pages_of_a_picture_kept_at_full_size() {
        let dir = TempDir::new("photo-full-tasks");
        fs::write(
            dir.0.join("pictures.json"),
            r#"[
              {"id":"t:picture:a","file":"pictures/a.png","shareable":false,"remote":"https://wiki.example.org/files/A.png?1",
               "shownAt":"https://wiki.example.org/files/small/40/A.png?1","pageCopy":{"file":"pictures/a.page.png","width":40,"height":30}},
              {"id":"t:picture:b","file":"pictures/b.png","shareable":false,"remote":"https://wiki.example.org/files/B.png",
               "shownAt":"https://elsewhere.example.com/B.png","pageCopy":{"file":"pictures/b.png","width":40}},
              {"id":"t:picture:c","file":"pictures/c.png","shareable":false,"remote":"https://wiki.example.org/files/C.png",
               "shownAt":"ftp://wiki.example.org/C.png","pageCopy":{"file":"../c.page.png","width":0}}
            ]"#,
        )
        .unwrap();
        let tasks = photo_tasks(&dir.0).unwrap();
        assert_eq!(
            tasks[0],
            PhotoTask {
                url: "https://wiki.example.org/files/A.png?1".to_owned(),
                path: PathBuf::from("pictures/a.png"),
                shown_at: Some("https://wiki.example.org/files/small/40/A.png?1".to_owned()),
                page_copy: Some(PageCopy {
                    path: PathBuf::from("pictures/a.page.png"),
                    width: 40,
                    height: Some(30),
                }),
            }
        );
        // A copy shown on another host is never asked for; a copy for pages
        // that is the file itself, outside the folder or of no size is not made.
        assert_eq!(
            tasks[1],
            PhotoTask::plain("https://wiki.example.org/files/B.png", "pictures/b.png")
        );
        assert_eq!(
            tasks[2],
            PhotoTask::plain("https://wiki.example.org/files/C.png", "pictures/c.png")
        );
    }

    #[test]
    fn fits_a_size_into_a_box_keeping_its_shape() {
        assert_eq!(fitted(2000, 1000, 1280, u32::MAX), (1280, 640));
        assert_eq!(fitted(400, 300, 80, 60), (80, 60));
        assert_eq!(fitted(300, 400, 80, 60), (45, 60));
        assert_eq!(fitted(50, 40, 80, 60), (50, 40));
        assert_eq!(fitted(10_000, 1, 100, 100), (100, 1));
        assert_eq!(fitted(0, 0, 0, 0), (1, 1));
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

    const DRAWING: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10">
  <rect width="10" height="10" fill="#ff0000"/>
  <image href="https://pictures.example.com/inside.png" width="5" height="5"/>
  <image href="/etc/hostname" width="5" height="5"/>
</svg>"##;

    #[test]
    fn draws_a_drawing_as_a_picture() {
        // Four times its stated size; the left half red, the right see-through.
        let drawn = draw_svg(DRAWING.as_bytes()).unwrap().to_rgba8();
        assert_eq!((drawn.width(), drawn.height()), (80, 40));
        assert_eq!(drawn.get_pixel(10, 20).0, [255, 0, 0, 255]);
        assert_eq!(drawn.get_pixel(70, 20).0[3], 0);
        // A small one is drawn large enough, a large one no larger than the limit.
        let small = r#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>"#;
        let drawn = draw_svg(small.as_bytes()).unwrap();
        assert_eq!((drawn.width(), drawn.height()), (64, 32));
        let large = r#"<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="60000"/>"#;
        let drawn = draw_svg(large.as_bytes()).unwrap();
        assert_eq!((drawn.width(), drawn.height()), (52, 1024));
        // One with text is drawn too, with whatever fonts the computer has.
        let text = r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text x="2" y="15">Ab</text></svg>"#;
        assert_eq!(draw_svg(text.as_bytes()).unwrap().width(), 160);
        // Not a drawing, and one too large to draw.
        assert!(draw_svg(b"<svg").is_err());
        let mut huge = small.as_bytes().to_vec();
        huge.resize(MAX_DRAWING_BYTES + 1, b' ');
        assert!(draw_svg(&huge).is_err());

        // A GIF picture is kept as its first frame, in the kind its file says.
        let gif = gif_picture(30, 20);
        assert!(crate::tiles::downscale::looks_like_gif(&gif));
        let kept = shrink_photo(gif, Path::new("pictures/g.png")).unwrap();
        assert!(kept.starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(size_of(&kept), (30, 20));

        // Kept in the kind its file says: see-through as PNG, on white as JPEG.
        let png = shrink_photo(DRAWING.as_bytes().to_vec(), Path::new("pictures/a.png")).unwrap();
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(size_of(&png), (80, 40));
        let jpeg = shrink_photo(DRAWING.as_bytes().to_vec(), Path::new("pictures/a.jpg")).unwrap();
        assert!(jpeg.starts_with(&[0xff, 0xd8, 0xff]));
        let pixels = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        let right = pixels.get_pixel(70, 20).0;
        assert!(right.iter().all(|channel| *channel > 240), "{right:?}");
        let left = pixels.get_pixel(10, 20).0;
        assert!(left[0] > 200 && left[1] < 60 && left[2] < 60, "{left:?}");
    }

    #[tokio::test]
    async fn keeps_a_drawing_among_the_pictures_and_goes_on() {
        ensure_crypto();
        let png = picture(20, 20, ImageFormat::Png);
        let gif = gif_picture(30, 20);
        let server = MockServer::start(Arc::new(move |path: &str, _| match path {
            "/media/a.png" => Reply {
                headers: vec![("Content-Type", "image/svg+xml".to_owned())],
                body: DRAWING.as_bytes().to_vec(),
                ..Reply::status(200)
            },
            // A drawing that cannot be read counts as failed, no more.
            "/media/b.png" => Reply {
                headers: vec![("Content-Type", "image/svg+xml".to_owned())],
                body: b"<svg xmlns=\"http://www.w3.org/2000/svg\"><g></svg>".to_vec(),
                ..Reply::status(200)
            },
            "/media/c.png" => Reply {
                headers: vec![("Content-Type", "image/gif".to_owned())],
                body: gif.clone(),
                ..Reply::status(200)
            },
            _ => Reply::image(png.clone()),
        }))
        .await;
        let dir = TempDir::new("photo-drawing");
        let pack_dir = dir.0.join("pack");
        pack(&pack_dir, &server);
        let manager = manager(&dir, &pack_dir);
        manager.start_photos("t").unwrap();
        let done = wait_done(&manager, "t").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        assert_eq!((done.saved, done.failed), (2, 1));
        let a = fs::read(pack_dir.join("pictures/a.jpg")).unwrap();
        assert!(a.starts_with(&[0xff, 0xd8, 0xff]));
        assert_eq!(size_of(&a), (80, 40));
        assert!(!pack_dir.join("pictures/b.jpg").exists());
        // The GIF picture is kept as a PNG, as its file says.
        let c = fs::read(pack_dir.join("pictures/c.png")).unwrap();
        assert!(c.starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(size_of(&c), (30, 20));
        // Nothing the drawing names was asked for.
        assert_eq!(server.seen().len(), 3);
    }

    /// A pack with one picture kept at full size, `remote` and `shown` on `server`.
    fn full_pack(dir: &Path, server: &MockServer, copy_height: Option<u32>) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            r#"{"schemaVersion":2,"gameId":"t","title":"Test Isle","packVersion":"1.0.0"}"#,
        )
        .unwrap();
        let height = copy_height.map_or(String::new(), |h| format!(r#","height":{h}"#));
        fs::write(
            dir.join("pictures.json"),
            format!(
                r#"[{{"id":"t:picture:m","file":"pictures/m.png","shareable":false,"remote":"{}",
                     "shownAt":"{}","pageCopy":{{"file":"pictures/m.page.png","width":40{height}}}}}]"#,
                server.url("/files/Map.png?7"),
                server.url("/files/small/40/Map.png?7"),
            ),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn keeps_the_full_file_with_one_request_and_makes_the_copy_for_pages() {
        ensure_crypto();
        let large = picture(2000, 1500, ImageFormat::Png);
        let server = MockServer::start(Arc::new(move |path: &str, _| match path {
            "/files/Map.png?7" | "/files/Map.png" => Reply::image(large.clone()),
            _ => Reply::status(500),
        }))
        .await;
        let dir = TempDir::new("photo-full");
        let pack_dir = dir.0.join("pack");
        full_pack(&pack_dir, &server, Some(30));
        let manager = manager(&dir, &pack_dir);
        manager.start_photos("t").unwrap();
        let done = wait_done(&manager, "t").await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        assert_eq!(done.saved, 1);
        // The full file, wider than a photo is kept, and a copy for pages
        // twice the size the page shows it at, from the same answer.
        assert_eq!(
            size_of(&fs::read(pack_dir.join("pictures/m.png")).unwrap()),
            (2000, 1500)
        );
        assert_eq!(
            size_of(&fs::read(pack_dir.join("pictures/m.page.png")).unwrap()),
            (80, 60)
        );
        assert_eq!(server.seen().len(), 1);
        assert_eq!(manager.photos_plan("t").unwrap().remaining, 0);
    }

    #[test]
    fn keeps_a_full_file_wider_than_the_limit_at_the_limit() {
        let wide = picture(FULL_WIDTH + 904, 500, ImageFormat::Png);
        let task = PhotoTask {
            shown_at: Some("https://wiki.example.org/s.png".to_owned()),
            page_copy: None,
            ..PhotoTask::plain("https://wiki.example.org/f.png", "pictures/f.png")
        };
        let dir = TempDir::new("photo-full-wide");
        let transform = photo_transform(
            std::slice::from_ref(&task),
            TileStore::new(dir.0.clone(), None),
        );
        let kept = transform(
            &Task::new(0, task.url.clone(), task.path.clone()),
            wide.clone(),
        )
        .unwrap();
        assert_eq!(size_of(&kept).0, FULL_WIDTH);
        // A picture not kept at full size is a photo, as before.
        let plain = photo_transform(&[], TileStore::new(dir.0.clone(), None));
        let kept = plain(&Task::new(0, task.url, task.path), wide).unwrap();
        assert_eq!(size_of(&kept).0, PHOTO_WIDTH);
    }

    #[tokio::test]
    async fn falls_back_once_to_the_copy_shown_and_not_again_in_this_run() {
        ensure_crypto();
        let small = picture(40, 30, ImageFormat::Png);
        let not_a_picture = || Reply {
            headers: vec![("Content-Type", "application/octet-stream".to_owned())],
            body: b"not a picture at all".to_vec(),
            ..Reply::status(200)
        };
        let too_large = || Reply::image(vec![0u8; MAX_PHOTO_BYTES + 1]);
        type Answer = fn() -> Reply;
        let cases: [(&str, Answer); 4] = [
            ("missing", || Reply::status(404)),
            ("refused", || Reply::status(403)),
            ("not a picture", not_a_picture),
            ("too large", too_large),
        ];
        for (case, full) in cases {
            let small = small.clone();
            let server = MockServer::start(Arc::new(move |path: &str, _| match path {
                "/files/small/40/Map.png?7" => Reply::image(small.clone()),
                _ => full(),
            }))
            .await;
            let dir = TempDir::new("photo-fallback");
            let pack_dir = dir.0.join("pack");
            full_pack(&pack_dir, &server, None);
            let manager = manager(&dir, &pack_dir);
            manager.start_photos("t").unwrap();
            let done = wait_done(&manager, "t").await;
            assert_eq!(done.state, JobState::Done, "{case}: {:?}", done.reason);
            assert_eq!(done.saved, 1, "{case}");
            assert_eq!(
                size_of(&fs::read(pack_dir.join("pictures/m.png")).unwrap()),
                (40, 30),
                "{case}"
            );
            // Its copy for pages too, so pages never miss it.
            assert!(pack_dir.join("pictures/m.page.png").exists(), "{case}");
            let asked: Vec<String> = server.seen().into_iter().map(|seen| seen.path).collect();
            assert_eq!(
                asked,
                vec![
                    "/files/Map.png?7".to_owned(),
                    "/files/small/40/Map.png?7".to_owned()
                ],
                "{case}"
            );
            assert!(!pack_dir.join("pictures/m.png.404").exists(), "{case}");
            // Asked again in this run (its file deleted): the copy shown only.
            fs::remove_file(pack_dir.join("pictures/m.png")).unwrap();
            manager.start_photos("t").unwrap();
            assert_eq!(wait_done(&manager, "t").await.state, JobState::Done);
            assert_eq!(server.seen().len(), 3, "{case}");
            assert_eq!(server.seen()[2].path, "/files/small/40/Map.png?7", "{case}");
        }
    }

    #[tokio::test]
    async fn stops_when_the_copy_shown_is_refused_too_and_records_a_missing_one() {
        ensure_crypto();
        let server = MockServer::start(Arc::new(|_: &str, _| Reply::status(403))).await;
        let dir = TempDir::new("photo-fallback-refused");
        let pack_dir = dir.0.join("pack");
        full_pack(&pack_dir, &server, None);
        let first = manager(&dir, &pack_dir);
        first.start_photos("t").unwrap();
        let stopped = wait_done(&first, "t").await;
        assert_eq!(stopped.state, JobState::Stopped);
        assert!(stopped.reason.unwrap().contains("refused"));
        // The full file, then the copy shown once: no third request.
        assert_eq!(server.seen().len(), 2);

        let server = MockServer::start(Arc::new(|_: &str, _| Reply::status(404))).await;
        let dir = TempDir::new("photo-fallback-missing");
        let pack_dir = dir.0.join("pack");
        full_pack(&pack_dir, &server, None);
        let second = manager(&dir, &pack_dir);
        second.start_photos("t").unwrap();
        let done = wait_done(&second, "t").await;
        assert_eq!((done.state, done.missing), (JobState::Done, 1));
        assert_eq!(server.seen().len(), 2);
        // Recorded as not on the server: not asked again.
        assert_eq!(second.photos_plan("t").unwrap().remaining, 0);
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
