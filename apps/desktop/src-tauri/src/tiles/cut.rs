//! A map from one picture: a large PNG, JPEG or WebP is the most detailed
//! level of a layer, cut into tiles in the folder layout the app reads
//! (`<folder>/{z}/{x}/{y}.<ext>`, [`TILE_SIZE`] pixels square), and each
//! level further out is made by halving the one above until the whole map
//! fits one tile. The level maths are those of `pyramidLevel` in
//! `@atlas/core` and of [`level_grid`]: level `z` shows the picture at scale
//! `2^(z - maxZoom)`, rounded up to whole pixels. Tiles on the right and
//! bottom edges are filled out to a whole tile: with the dark map backdrop
//! in a JPEG, transparent in a PNG.
//!
//! The picture is read and never changed. Memory is the limit that
//! matters: a picture of 16,384 pixels a side is a gigabyte once decoded.
//! So a PNG is read a band of rows at a time, and the tiles of a level are
//! cut from bands while the next level is made from the same bands at half
//! the size; only that half-size level is held whole. A JPEG or WebP is
//! decoded whole (their decoders read nothing less), cut and halved the
//! same way, and dropped as soon as its half is made. [`check_size`] sets
//! the largest picture taken; see [`MAX_PIXELS`].
//!
//! Tiles are JPEG for a picture without transparency and PNG for one with
//! it. Everything is written into a folder that must not exist yet; a
//! failure or a cancel removes it again, so no half-made map is left.
//!
//! In the desktop apps only (not Android), and in every desktop build: the
//! image crate is in every desktop build for this.

use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits,
};
use serde::Serialize;

use super::pyramid::level_grid;
use crate::packfile::Stop;

/// The edge of a tile, in pixels: what the app's other maps use.
pub const TILE_SIZE: u32 = 256;
/// The longest side a picture may have.
pub const MAX_SIDE: u32 = 20_000;
/// The most pixels a picture may have: 16,384 × 16,384. Decoded, a JPEG
/// this large takes 768 MiB and a WebP with transparency 1 GiB, with a
/// quarter of that again for the level below while it is made; a PNG is
/// read a band at a time and takes a quarter of its decoded size.
pub const MAX_PIXELS: u64 = 16_384 * 16_384;
/// The smallest side: a picture smaller than this is not a map.
pub const MIN_SIDE: u32 = 16;
/// What decoding may allocate, a little over the largest picture taken.
const MAX_DECODE_BYTES: u64 = MAX_PIXELS * 4 + (64 << 20);
/// JPEG tiles' quality.
const JPEG_QUALITY: u8 = 88;
/// What a JPEG tile is filled with outside the picture: the map's dark backdrop.
const BACKDROP: [u8; 3] = [11, 13, 18];

/// The picture formats a map can be made from.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PictureFormat {
    Png,
    Jpeg,
    Webp,
}

impl PictureFormat {
    pub fn name(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
            Self::Webp => "WebP",
        }
    }
}

/// What a picture is, read from its start without decoding it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PictureInfo {
    pub width: u32,
    pub height: u32,
    pub format: PictureFormat,
    /// The file's size.
    pub bytes: u64,
    /// Levels the map will have, and tiles in all.
    pub levels: u8,
    pub tiles: u64,
    /// Why it cannot be used, in plain words; none when it can.
    pub problem: Option<String>,
}

/// How far a cut is.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CutProgress {
    /// The picture is being read (decoded whole), before any tile is cut.
    pub reading: bool,
    pub tiles_done: u64,
    pub tiles_total: u64,
}

/// A finished cut.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cut {
    pub width: u32,
    pub height: u32,
    pub max_zoom: u8,
    /// `jpg` or `png`.
    pub extension: &'static str,
    pub tiles: u64,
    pub bytes: u64,
}

/// The pyramid's top level for a picture: the lowest level whose tiles
/// cover it at one tile pixel per picture pixel (`pyramidMaxZoom`).
pub fn max_zoom_for(width: u32, height: u32) -> u8 {
    let longest = u64::from(width.max(height));
    let mut zoom = 0u8;
    while u64::from(TILE_SIZE) << zoom < longest {
        zoom += 1;
    }
    zoom
}

/// Tiles of every level.
pub fn tiles_for(width: u32, height: u32) -> u64 {
    let top = max_zoom_for(width, height);
    (0..=top)
        .map(|z| level_grid(width, height, TILE_SIZE, top, z).tiles())
        .sum()
}

fn thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Why a picture of this size cannot be made into a map; none when it can.
pub fn check_size(width: u32, height: u32) -> Option<String> {
    let size = format!(
        "{} × {} pixels",
        thousands(width.into()),
        thousands(height.into())
    );
    if width < MIN_SIDE || height < MIN_SIDE {
        return Some(format!(
            "This picture is {size}, too small for a map. Choose a picture at least {MIN_SIDE} pixels a side."
        ));
    }
    if width > MAX_SIDE || height > MAX_SIDE || u64::from(width) * u64::from(height) > MAX_PIXELS {
        let megapixels = u64::from(width) * u64::from(height) / 1_000_000;
        return Some(format!(
            "This picture is {size} ({megapixels} million pixels), too large for Atlas to cut into a map on this computer. It takes pictures of up to 268 million pixels (16,384 × 16,384) and {} pixels a side: make it smaller in an image editor first.",
            thousands(MAX_SIDE.into())
        ));
    }
    None
}

/// The format of a picture, from its first bytes (never its name).
fn format_of(path: &Path) -> Result<PictureFormat, String> {
    use std::io::Read as _;
    let mut start = [0u8; 12];
    let mut file =
        File::open(path).map_err(|error| format!("Could not open the picture: {error}"))?;
    let read = file
        .read(&mut start)
        .map_err(|error| format!("Could not read the picture: {error}"))?;
    let start = &start[..read];
    if start.starts_with(&[0x89, b'P', b'N', b'G']) {
        Ok(PictureFormat::Png)
    } else if start.starts_with(&[0xff, 0xd8, 0xff]) {
        Ok(PictureFormat::Jpeg)
    } else if start.len() >= 12 && start.starts_with(b"RIFF") && &start[8..12] == b"WEBP" {
        Ok(PictureFormat::Webp)
    } else {
        Err(
            "Atlas makes a map from a PNG, JPEG or WebP picture, and this file is none of them."
                .to_owned(),
        )
    }
}

fn open_reader(path: &Path) -> Result<(PictureFormat, ImageReader<BufReader<File>>), String> {
    let format = format_of(path)?;
    let mut reader =
        ImageReader::open(path).map_err(|error| format!("Could not open the picture: {error}"))?;
    reader.set_format(match format {
        PictureFormat::Png => ImageFormat::Png,
        PictureFormat::Jpeg => ImageFormat::Jpeg,
        PictureFormat::Webp => ImageFormat::WebP,
    });
    Ok((format, reader))
}

/// Reads what a picture is from its start, without decoding it, and says
/// whether a map can be made from it.
pub fn inspect(path: &Path) -> Result<PictureInfo, String> {
    let metadata = fs::metadata(path).map_err(|_| "That picture cannot be found.".to_owned())?;
    if !metadata.is_file() {
        return Err("That is not a picture file.".to_owned());
    }
    let (format, reader) = open_reader(path)?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("This {} picture cannot be read: {error}", format.name()))?;
    Ok(PictureInfo {
        width,
        height,
        format,
        bytes: metadata.len(),
        levels: max_zoom_for(width, height) + 1,
        tiles: tiles_for(width, height),
        problem: check_size(width, height),
    })
}

// ---------------------------------------------------------------------------
// Pixels

/// One level of the picture held in memory: rows of `width` pixels of
/// `channels` bytes (3, RGB, or 4, RGBA).
struct Level {
    width: u32,
    height: u32,
    channels: usize,
    pixels: Vec<u8>,
}

/// Where the rows of a level come from, top to bottom.
trait Rows {
    fn width(&self) -> u32;
    fn height(&self) -> u32;
    fn channels(&self) -> usize;
    /// Appends the next `count` rows to `out`.
    fn next_rows(&mut self, count: u32, out: &mut Vec<u8>) -> Result<(), Stop>;
}

/// The rows of a level in memory.
struct LevelRows {
    level: Level,
    next: usize,
}

impl Rows for LevelRows {
    fn width(&self) -> u32 {
        self.level.width
    }
    fn height(&self) -> u32 {
        self.level.height
    }
    fn channels(&self) -> usize {
        self.level.channels
    }
    fn next_rows(&mut self, count: u32, out: &mut Vec<u8>) -> Result<(), Stop> {
        let row = self.level.width as usize * self.level.channels;
        let end = (self.next + count as usize * row).min(self.level.pixels.len());
        out.extend_from_slice(&self.level.pixels[self.next..end]);
        self.next = end;
        Ok(())
    }
}

/// The rows of a PNG, read as they are needed: 8 bits, gray made RGB.
struct PngRows {
    reader: png::Reader<BufReader<File>>,
    width: u32,
    height: u32,
    color: png::ColorType,
    channels: usize,
}

impl PngRows {
    fn open(path: &Path) -> Result<Option<Self>, Stop> {
        let file = File::open(path)
            .map_err(|error| Stop::Failed(format!("Could not open the picture: {error}")))?;
        let mut decoder = png::Decoder::new(BufReader::with_capacity(1 << 20, file));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        decoder.set_limits(png::Limits {
            bytes: usize::try_from(MAX_DECODE_BYTES).unwrap_or(usize::MAX),
        });
        let reader = decoder
            .read_info()
            .map_err(|error| Stop::Failed(format!("This PNG picture cannot be read: {error}")))?;
        if reader.info().interlaced {
            // Its rows come in passes: read it whole instead.
            return Ok(None);
        }
        let (color, _) = reader.output_color_type();
        let channels = match color {
            png::ColorType::Grayscale | png::ColorType::Rgb => 3,
            _ => 4,
        };
        let (width, height) = reader.info().size();
        Ok(Some(Self {
            reader,
            width,
            height,
            color,
            channels,
        }))
    }
}

impl Rows for PngRows {
    fn width(&self) -> u32 {
        self.width
    }
    fn height(&self) -> u32 {
        self.height
    }
    fn channels(&self) -> usize {
        self.channels
    }
    fn next_rows(&mut self, count: u32, out: &mut Vec<u8>) -> Result<(), Stop> {
        for _ in 0..count {
            let row = self
                .reader
                .next_row()
                .map_err(|error| Stop::Failed(format!("This PNG picture is damaged: {error}")))?
                .ok_or_else(|| Stop::Failed("This PNG picture ends early.".to_owned()))?;
            let data = row.data();
            match self.color {
                png::ColorType::Grayscale => {
                    for &v in data {
                        out.extend_from_slice(&[v, v, v]);
                    }
                }
                png::ColorType::GrayscaleAlpha => {
                    for pair in data.chunks_exact(2) {
                        out.extend_from_slice(&[pair[0], pair[0], pair[0], pair[1]]);
                    }
                }
                _ => out.extend_from_slice(data),
            }
        }
        Ok(())
    }
}

/// Decodes a whole picture into RGB or RGBA.
fn decode_whole(path: &Path) -> Result<Level, Stop> {
    let (_, mut reader) = open_reader(path).map_err(Stop::Failed)?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| Stop::Failed(format!("The picture cannot be read: {error}")))?;
    let (width, height) = (image.width(), image.height());
    let (channels, pixels) = if image.color().has_alpha() {
        (4, image.into_rgba8().into_raw())
    } else {
        (3, image.into_rgb8().into_raw())
    };
    Ok(Level {
        width,
        height,
        channels,
        pixels,
    })
}

/// Half of a band of rows of a level (`rows` rows of `width` pixels),
/// appended to `out`: each pixel the mean of the two by two it covers, as
/// many of them as there are at the right and bottom edges. Colours are
/// weighed by their opacity, so transparent pixels leave no dark rim.
fn halve_band(band: &[u8], width: u32, rows: u32, channels: usize, out: &mut Vec<u8>) {
    let width = width as usize;
    let half_width = width.div_ceil(2);
    let stride = width * channels;
    for y in (0..rows as usize).step_by(2) {
        let lower = y + 1 < rows as usize;
        for x in 0..half_width {
            let right = 2 * x + 1 < width;
            let mut cells = [0usize; 4];
            let mut count = 0;
            for (dx, dy, ok) in [
                (0, 0, true),
                (1, 0, right),
                (0, 1, lower),
                (1, 1, right && lower),
            ] {
                if ok {
                    cells[count] = (y + dy) * stride + (2 * x + dx) * channels;
                    count += 1;
                }
            }
            let cells = &cells[..count];
            if channels == 4 {
                let alpha: u32 = cells.iter().map(|&at| u32::from(band[at + 3])).sum();
                for c in 0..3 {
                    let weighed: u32 = cells
                        .iter()
                        .map(|&at| u32::from(band[at + c]) * u32::from(band[at + 3]))
                        .sum();
                    let value = (weighed + alpha / 2).checked_div(alpha).unwrap_or(0);
                    out.push(value as u8);
                }
                out.push(((alpha + count as u32 / 2) / count as u32) as u8);
            } else {
                for c in 0..channels {
                    let sum: u32 = cells.iter().map(|&at| u32::from(band[at + c])).sum();
                    out.push(((sum + count as u32 / 2) / count as u32) as u8);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tiles

/// Cuts one tile out of a band and encodes it.
fn encode_tile(
    band: &[u8],
    width: u32,
    rows: u32,
    channels: usize,
    column: u32,
) -> Result<Vec<u8>, String> {
    let size = TILE_SIZE as usize;
    let left = (column * TILE_SIZE) as usize;
    let used_width = (width as usize - left).min(size);
    let used_rows = (rows as usize).min(size);
    let stride = width as usize * channels;
    let mut tile = vec![0u8; size * size * channels];
    if channels == 3 {
        for pixel in tile.chunks_exact_mut(3) {
            pixel.copy_from_slice(&BACKDROP);
        }
    }
    for y in 0..used_rows {
        let from = y * stride + left * channels;
        let to = y * size * channels;
        tile[to..to + used_width * channels]
            .copy_from_slice(&band[from..from + used_width * channels]);
    }
    let mut out = Vec::new();
    let result = if channels == 3 {
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).write_image(
            &tile,
            TILE_SIZE,
            TILE_SIZE,
            ExtendedColorType::Rgb8,
        )
    } else {
        PngEncoder::new(&mut out).write_image(&tile, TILE_SIZE, TILE_SIZE, ExtendedColorType::Rgba8)
    };
    result.map_err(|error| format!("could not make a map tile: {error}"))?;
    Ok(out)
}

fn write_tile(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = BufWriter::new(File::create(path)?);
    file.write_all(bytes)?;
    file.flush()
}

/// What every level's cutting shares.
struct Job<'a> {
    out: &'a Path,
    extension: &'static str,
    workers: usize,
    done: AtomicU64,
    bytes: AtomicU64,
    total: u64,
    stop: AtomicBool,
    cancelled: &'a (dyn Fn() -> bool + Sync),
}

impl Job<'_> {
    /// Cuts the tiles of one band of level `z` (tile row `row`), on several
    /// threads.
    fn cut_band(
        &self,
        z: u8,
        row: u32,
        band: &[u8],
        width: u32,
        rows: u32,
        channels: usize,
    ) -> Result<(), Stop> {
        let columns = width.div_ceil(TILE_SIZE);
        let next = AtomicU64::new(0);
        let failure = std::sync::Mutex::new(None::<String>);
        std::thread::scope(|scope| {
            for _ in 0..self.workers.min(columns as usize).max(1) {
                scope.spawn(|| loop {
                    if self.stop.load(Ordering::Relaxed) {
                        return;
                    }
                    if (self.cancelled)() {
                        self.stop.store(true, Ordering::Relaxed);
                        return;
                    }
                    let column = next.fetch_add(1, Ordering::Relaxed);
                    if column >= u64::from(columns) {
                        return;
                    }
                    let column = column as u32;
                    let path = self
                        .out
                        .join(z.to_string())
                        .join(column.to_string())
                        .join(format!("{row}.{}", self.extension));
                    let result =
                        encode_tile(band, width, rows, channels, column).and_then(|bytes| {
                            write_tile(&path, &bytes)
                                .map(|()| bytes.len() as u64)
                                .map_err(|error| format!("could not save a map tile: {error}"))
                        });
                    match result {
                        Ok(size) => {
                            self.bytes.fetch_add(size, Ordering::Relaxed);
                            self.done.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            self.stop.store(true, Ordering::Relaxed);
                            *failure
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
                            return;
                        }
                    }
                });
            }
        });
        if let Some(error) = failure
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            return Err(Stop::Failed(format!("The map could not be made: {error}.")));
        }
        if self.stop.load(Ordering::Relaxed) {
            return Err(Stop::Cancelled);
        }
        Ok(())
    }

    /// Cuts level `z` from its rows, and makes the level below while doing so
    /// (none at level 0).
    fn cut_level(
        &self,
        z: u8,
        source: &mut dyn Rows,
        progress: &mut dyn FnMut(CutProgress),
    ) -> Result<Option<Level>, Stop> {
        let (width, height, channels) = (source.width(), source.height(), source.channels());
        for column in 0..width.div_ceil(TILE_SIZE) {
            fs::create_dir_all(self.out.join(z.to_string()).join(column.to_string()))
                .map_err(|error| Stop::Failed(format!("Could not write the map: {error}")))?;
        }
        let mut below = (z > 0).then(|| Level {
            width: width.div_ceil(2),
            height: height.div_ceil(2),
            channels,
            pixels: Vec::with_capacity(
                width.div_ceil(2) as usize * height.div_ceil(2) as usize * channels,
            ),
        });
        let mut band = Vec::with_capacity(width as usize * TILE_SIZE as usize * channels);
        let mut last = Instant::now();
        for row in 0..height.div_ceil(TILE_SIZE) {
            let rows = (height - row * TILE_SIZE).min(TILE_SIZE);
            band.clear();
            source.next_rows(rows, &mut band)?;
            self.cut_band(z, row, &band, width, rows, channels)?;
            if let Some(below) = &mut below {
                halve_band(&band, width, rows, channels, &mut below.pixels);
            }
            if last.elapsed() > Duration::from_millis(100) {
                last = Instant::now();
                progress(CutProgress {
                    reading: false,
                    tiles_done: self.done.load(Ordering::Relaxed),
                    tiles_total: self.total,
                });
            }
        }
        Ok(below)
    }
}

/// A folder removed when dropped, unless kept.
struct Unfinished<'a> {
    path: &'a Path,
    kept: bool,
}

impl Drop for Unfinished<'_> {
    fn drop(&mut self) {
        if !self.kept {
            let _ = fs::remove_dir_all(self.path);
        }
    }
}

/// Cuts a picture into a map's tiles in `out`, a folder that must not exist
/// yet (see the module). `progress` is told how far it is now and then;
/// `cancelled` is asked between tiles. On a failure or cancel, `out` is
/// removed again.
pub fn cut(
    picture: &Path,
    out: &Path,
    progress: &mut dyn FnMut(CutProgress),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<Cut, Stop> {
    let info = inspect(picture)?;
    if let Some(problem) = info.problem {
        return Err(Stop::Failed(problem));
    }
    if fs::symlink_metadata(out).is_ok() {
        return Err(Stop::Failed(format!(
            "{} is there already, so the map was not made.",
            out.display()
        )));
    }
    fs::create_dir_all(out)
        .map_err(|error| Stop::Failed(format!("Could not write the map: {error}")))?;
    let mut unfinished = Unfinished {
        path: out,
        kept: false,
    };
    let (width, height) = (info.width, info.height);
    let top = max_zoom_for(width, height);
    let total = tiles_for(width, height);
    progress(CutProgress {
        reading: true,
        tiles_done: 0,
        tiles_total: total,
    });

    let streamed = match info.format {
        PictureFormat::Png => PngRows::open(picture)?,
        _ => None,
    };
    // The top level, from the picture's rows as they are read, or from the
    // picture decoded whole, which is let go as soon as it is cut.
    let (channels, mut below, mut done, mut bytes) = {
        let (channels, mut rows): (usize, Box<dyn Rows>) = match streamed {
            Some(rows) => (rows.channels, Box::new(rows)),
            None => {
                let whole = decode_whole(picture)?;
                if (cancelled)() {
                    return Err(Stop::Cancelled);
                }
                (
                    whole.channels,
                    Box::new(LevelRows {
                        level: whole,
                        next: 0,
                    }),
                )
            }
        };
        let job = job(out, channels, total, cancelled);
        let below = job.cut_level(top, rows.as_mut(), progress)?;
        (
            channels,
            below,
            job.done.into_inner(),
            job.bytes.into_inner(),
        )
    };
    // Each level further out, from the one above, held whole at a quarter
    // of its size.
    let mut z = top;
    while let Some(level) = below.take() {
        z -= 1;
        let job = Job {
            done: AtomicU64::new(done),
            ..job(out, channels, total, cancelled)
        };
        let mut rows = LevelRows { level, next: 0 };
        below = job.cut_level(z, &mut rows, progress)?;
        done = job.done.into_inner();
        bytes += job.bytes.into_inner();
    }
    if (cancelled)() {
        return Err(Stop::Cancelled);
    }
    progress(CutProgress {
        reading: false,
        tiles_done: done,
        tiles_total: total,
    });
    unfinished.kept = true;
    Ok(Cut {
        width,
        height,
        max_zoom: top,
        extension: extension_for(channels),
        tiles: done,
        bytes,
    })
}

fn extension_for(channels: usize) -> &'static str {
    if channels == 4 {
        "png"
    } else {
        "jpg"
    }
}

fn job<'a>(
    out: &'a Path,
    channels: usize,
    total: u64,
    cancelled: &'a (dyn Fn() -> bool + Sync),
) -> Job<'a> {
    Job {
        out,
        extension: extension_for(channels),
        workers: std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 8)),
        done: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        total,
        stop: AtomicBool::new(false),
        cancelled,
    }
}

/// The tile file extension a picture will be cut to, without decoding it:
/// `png` for a picture with transparency, else `jpg`.
pub fn extension_of(picture: &Path) -> Result<&'static str, String> {
    let (format, reader) = open_reader(picture)?;
    let decoder = reader
        .into_decoder()
        .map_err(|error| format!("This {} picture cannot be read: {error}", format.name()))?;
    use image::ImageDecoder as _;
    Ok(if decoder.color_type().has_alpha() {
        "png"
    } else {
        "jpg"
    })
}

/// A hidden folder beside `target` to cut into, named after it.
pub fn work_folder(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!(".cutting-{name}"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;
    use image::{DynamicImage, Rgb, RgbImage, Rgba, RgbaImage};

    /// A picture whose colour tells where each pixel is: red across, green down.
    pub fn gradient(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| {
            Rgb([
                (x * 255 / width.max(1)) as u8,
                (y * 255 / height.max(1)) as u8,
                128,
            ])
        })
    }

    pub fn save(image: &DynamicImage, path: &Path, format: ImageFormat) {
        image.save_with_format(path, format).unwrap();
    }

    fn never() -> bool {
        false
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(at) = stack.pop() {
            for entry in fs::read_dir(&at).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(
                        path.strip_prefix(dir)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        out.sort();
        out
    }

    fn pixel(path: &Path, x: u32, y: u32) -> [u8; 4] {
        image::open(path).unwrap().to_rgba8().get_pixel(x, y).0
    }

    fn close(a: [u8; 4], b: [u8; 4]) -> bool {
        a.iter().zip(b).all(|(a, b)| a.abs_diff(b) <= 12)
    }

    #[test]
    fn works_out_levels_like_the_app() {
        assert_eq!(max_zoom_for(256, 256), 0);
        assert_eq!(max_zoom_for(100, 50), 0);
        assert_eq!(max_zoom_for(600, 300), 2);
        assert_eq!(max_zoom_for(8192, 8192), 5);
        assert_eq!(max_zoom_for(8193, 100), 6);
        assert_eq!(max_zoom_for(16_384, 16_384), 6);
        // 600 x 300: 3 x 2 tiles at the top, 2 x 1, then 1.
        assert_eq!(tiles_for(600, 300), 6 + 2 + 1);
        assert_eq!(
            tiles_for(16_384, 16_384),
            4096 + 1024 + 256 + 64 + 16 + 4 + 1
        );
    }

    #[test]
    fn refuses_pictures_too_large_or_too_small_with_a_clear_message() {
        assert_eq!(check_size(16_384, 16_384), None);
        assert_eq!(check_size(20_000, 10_000), None);
        let large = check_size(16_385, 16_384).unwrap();
        assert!(large.contains("16,385 × 16,384 pixels"), "{large}");
        assert!(large.contains("268 million pixels"), "{large}");
        assert!(check_size(20_001, 100).is_some());
        assert!(check_size(8, 600).unwrap().contains("too small"));
    }

    #[test]
    fn cuts_a_png_into_every_level_with_edge_tiles_filled_out() {
        let dir = TempDir::new("cut-png");
        let picture = dir.0.join("map.png");
        save(
            &DynamicImage::ImageRgb8(gradient(600, 300)),
            &picture,
            ImageFormat::Png,
        );
        let before = fs::read(&picture).unwrap();
        let out = dir.0.join("tiles");
        let mut seen = Vec::new();
        let cut = cut(&picture, &out, &mut |p| seen.push(p), &never).unwrap();
        assert_eq!(
            cut,
            Cut {
                width: 600,
                height: 300,
                max_zoom: 2,
                extension: "jpg",
                tiles: 9,
                bytes: cut.bytes,
            }
        );
        assert_eq!(
            files(&out),
            [
                "0/0/0.jpg",
                "1/0/0.jpg",
                "1/1/0.jpg",
                "2/0/0.jpg",
                "2/0/1.jpg",
                "2/1/0.jpg",
                "2/1/1.jpg",
                "2/2/0.jpg",
                "2/2/1.jpg"
            ]
        );
        // The picture is not changed.
        assert_eq!(fs::read(&picture).unwrap(), before);
        assert_eq!(seen.last().unwrap().tiles_done, 9);
        // Every tile is a whole tile.
        for name in files(&out) {
            let tile = image::open(out.join(&name)).unwrap();
            assert_eq!(
                (tile.width(), tile.height()),
                (TILE_SIZE, TILE_SIZE),
                "{name}"
            );
        }
        // The top level is the picture at full size: the tile at column 2,
        // row 1 starts at (512, 256); past (600, 300) it is the backdrop.
        let source = gradient(600, 300);
        let at = |x: u32, y: u32| {
            let [r, g, b] = source.get_pixel(x, y).0;
            [r, g, b, 255]
        };
        assert!(close(pixel(&out.join("2/2/1.jpg"), 10, 10), at(522, 266)));
        assert!(close(
            pixel(&out.join("2/2/1.jpg"), 200, 100),
            [11, 13, 18, 255]
        ));
        // Level 1 is half: 300 x 150, its pixel (100, 100) is (200, 200) above.
        assert!(close(pixel(&out.join("1/0/0.jpg"), 100, 100), at(201, 201)));
        assert!(close(
            pixel(&out.join("1/1/0.jpg"), 100, 100),
            [11, 13, 18, 255]
        ));
        // Level 0 is a quarter, 150 x 75.
        assert!(close(pixel(&out.join("0/0/0.jpg"), 50, 50), at(202, 202)));
        assert!(close(
            pixel(&out.join("0/0/0.jpg"), 200, 50),
            [11, 13, 18, 255]
        ));
    }

    #[test]
    fn cuts_jpeg_and_webp_too_and_keeps_transparency_in_png_tiles() {
        let dir = TempDir::new("cut-formats");
        let rgb = DynamicImage::ImageRgb8(gradient(513, 257));
        for (name, format) in [
            ("map.jpg", ImageFormat::Jpeg),
            ("map.webp", ImageFormat::WebP),
        ] {
            let picture = dir.0.join(name);
            save(&rgb, &picture, format);
            let out = dir.0.join(format!("tiles-{name}"));
            let cut = cut(&picture, &out, &mut |_| {}, &never).unwrap();
            // 513 x 257: 3 x 2 at level 2, 2 x 1 at level 1, 1 at level 0.
            assert_eq!(
                (cut.max_zoom, cut.tiles, cut.extension),
                (2, 9, "jpg"),
                "{name}"
            );
            assert_eq!(files(&out).len(), 9, "{name}");
            assert!(close(pixel(&out.join("2/0/0.jpg"), 100, 100), {
                let [r, g, b] = gradient(513, 257).get_pixel(100, 100).0;
                [r, g, b, 255]
            }));
        }
        // A picture with transparency: PNG tiles, transparent outside it,
        // and its transparent parts stay so when shrunk.
        let clear = RgbaImage::from_fn(300, 300, |x, _| {
            if x < 150 {
                Rgba([200, 40, 40, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        for (name, format) in [
            ("clear.png", ImageFormat::Png),
            ("clear.webp", ImageFormat::WebP),
        ] {
            let picture = dir.0.join(name);
            save(&DynamicImage::ImageRgba8(clear.clone()), &picture, format);
            let out = dir.0.join(format!("tiles-{name}"));
            let cut = cut(&picture, &out, &mut |_| {}, &never).unwrap();
            assert_eq!((cut.max_zoom, cut.extension), (1, "png"), "{name}");
            assert_eq!(pixel(&out.join("1/0/0.png"), 10, 10), [200, 40, 40, 255]);
            assert_eq!(pixel(&out.join("1/0/0.png"), 200, 10)[3], 0);
            assert_eq!(pixel(&out.join("1/1/1.png"), 100, 100)[3], 0);
            // Shrunk: the red half keeps its colour up to the edge.
            assert_eq!(pixel(&out.join("0/0/0.png"), 74, 10), [200, 40, 40, 255]);
            assert_eq!(pixel(&out.join("0/0/0.png"), 76, 10)[3], 0);
        }
    }

    #[test]
    fn cuts_odd_sizes_gray_and_sixteen_bit_pictures() {
        let dir = TempDir::new("cut-odd");
        for (width, height) in [(16, 16), (257, 999), (1001, 17)] {
            let picture = dir.0.join(format!("{width}x{height}.png"));
            let gray =
                image::GrayImage::from_fn(width, height, |x, _| image::Luma([(x % 256) as u8]));
            save(&DynamicImage::ImageLuma8(gray), &picture, ImageFormat::Png);
            let out = dir.0.join(format!("tiles-{width}x{height}"));
            let cut = cut(&picture, &out, &mut |_| {}, &never).unwrap();
            assert_eq!(cut.max_zoom, max_zoom_for(width, height));
            assert_eq!(cut.tiles, tiles_for(width, height));
            assert_eq!(files(&out).len() as u64, cut.tiles);
            for z in 0..=cut.max_zoom {
                let grid = level_grid(width, height, TILE_SIZE, cut.max_zoom, z);
                let last = out
                    .join(z.to_string())
                    .join((grid.columns - 1).to_string())
                    .join(format!("{}.jpg", grid.rows - 1));
                assert!(last.is_file(), "{}", last.display());
            }
        }
        // Sixteen bits a channel: read as eight.
        let deep =
            image::ImageBuffer::<Rgb<u16>, _>::from_pixel(300, 200, Rgb([65_535u16, 0, 32_768]));
        let picture = dir.0.join("deep.png");
        save(&DynamicImage::ImageRgb16(deep), &picture, ImageFormat::Png);
        let out = dir.0.join("tiles-deep");
        cut(&picture, &out, &mut |_| {}, &never).unwrap();
        assert!(close(
            pixel(&out.join("1/0/0.jpg"), 5, 5),
            [255, 0, 128, 255]
        ));
    }

    #[test]
    fn a_cancel_or_failure_leaves_nothing_behind() {
        let dir = TempDir::new("cut-cancel");
        let picture = dir.0.join("map.png");
        save(
            &DynamicImage::ImageRgb8(gradient(1500, 1100)),
            &picture,
            ImageFormat::Png,
        );
        let out = dir.0.join("tiles");
        let asked = AtomicU64::new(0);
        let cancel_soon = || asked.fetch_add(1, Ordering::Relaxed) > 10;
        let result = cut(&picture, &out, &mut |_| {}, &cancel_soon);
        assert_eq!(result, Err(Stop::Cancelled));
        assert!(!out.exists());
        // Cancelled while the picture is read.
        let jpeg = dir.0.join("map.jpg");
        save(
            &DynamicImage::ImageRgb8(gradient(600, 600)),
            &jpeg,
            ImageFormat::Jpeg,
        );
        assert_eq!(
            cut(&jpeg, &out, &mut |_| {}, &|| true),
            Err(Stop::Cancelled)
        );
        assert!(!out.exists());
        // A damaged picture.
        let broken = dir.0.join("broken.png");
        let mut bytes = fs::read(&picture).unwrap();
        bytes.truncate(bytes.len() / 2);
        fs::write(&broken, bytes).unwrap();
        assert!(matches!(
            cut(&broken, &out, &mut |_| {}, &never),
            Err(Stop::Failed(_))
        ));
        assert!(!out.exists());
        // Not a picture at all, and a folder there already.
        let text = dir.0.join("notes.png");
        fs::write(&text, "not a picture").unwrap();
        assert!(inspect(&text).unwrap_err().contains("PNG, JPEG or WebP"));
        fs::create_dir_all(&out).unwrap();
        assert!(matches!(
            cut(&picture, &out, &mut |_| {}, &never),
            Err(Stop::Failed(_))
        ));
        assert!(out.exists());
    }

    #[test]
    fn inspects_a_picture_without_decoding_it() {
        let dir = TempDir::new("cut-inspect");
        let picture = dir.0.join("map.webp");
        save(
            &DynamicImage::ImageRgb8(gradient(600, 300)),
            &picture,
            ImageFormat::WebP,
        );
        let info = inspect(&picture).unwrap();
        assert_eq!(
            (
                info.width,
                info.height,
                info.format,
                info.levels,
                info.tiles,
                info.problem
            ),
            (600, 300, PictureFormat::Webp, 3, 9, None)
        );
        assert_eq!(extension_of(&picture).unwrap(), "jpg");
        let tiny = dir.0.join("tiny.png");
        save(
            &DynamicImage::ImageRgb8(gradient(8, 8)),
            &tiny,
            ImageFormat::Png,
        );
        assert!(inspect(&tiny).unwrap().problem.is_some());
        assert!(matches!(
            cut(&tiny, &dir.0.join("t"), &mut |_| {}, &never),
            Err(Stop::Failed(_))
        ));
        assert_eq!(
            work_folder(Path::new("/maps/game/tiles/surface")),
            PathBuf::from("/maps/game/tiles/.cutting-surface")
        );
    }

    /// Times cutting the picture `ATLAS_CUT_PICTURE` and reports the peak
    /// memory of this process. Run alone, in release, so nothing else
    /// counts: `ATLAS_CUT_PICTURE=... cargo test --release measure_a_cut
    /// -- --ignored --nocapture`.
    #[test]
    #[ignore = "a measurement, run by hand"]
    fn measure_a_cut() {
        let Some(picture) = std::env::var_os("ATLAS_CUT_PICTURE") else {
            return;
        };
        let picture = PathBuf::from(picture);
        let dir = TempDir::new("cut-measure");
        let out = dir.0.join("tiles");
        let started = Instant::now();
        let cut = cut(&picture, &out, &mut |_| {}, &never).unwrap();
        let seconds = started.elapsed().as_secs_f64();
        #[cfg(unix)]
        let peak = {
            // SAFETY: getrusage only writes the struct it is given.
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
            usage.ru_maxrss / 1024
        };
        #[cfg(not(unix))]
        let peak = 0;
        println!(
            "MEASURED {} {}x{}: {} tiles, {} MB of tiles, {seconds:.1} s, peak {peak} MB",
            picture.display(),
            cut.width,
            cut.height,
            cut.tiles,
            cut.bytes >> 20
        );
    }
}
