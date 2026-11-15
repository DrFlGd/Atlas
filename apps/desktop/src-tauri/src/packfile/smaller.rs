//! "Pictures in the file: Smaller": the pictures a map pack file carries
//! (see [`super::shared_pictures`]) made smaller as they go into the file.
//! The files on this computer are never changed; only the copies written
//! into the map pack file are.
//!
//! The rule, for each picture:
//!
//! - It is made at most [`SMALLER_WIDTH`] pixels wide and [`SMALLER_HEIGHT`]
//!   tall, its shape kept, never made larger. That width is the one Atlas
//!   kept every downloaded picture at before pictures were kept at full
//!   size, and the one the web app makes a person's own photos, so a
//!   smaller file holds pictures as an older app would have kept them. The
//!   width, not the longest side, sets the size, so a tall picture (a long
//!   table or a map drawn as one picture) stays readable.
//! - A picture with no see-through part, at least [`KEEP_TYPE_UNDER`]
//!   pixels on one side, is saved as a JPEG of quality
//!   [`SMALLER_JPEG_QUALITY`], and its file in the map pack file is named
//!   `.jpg` (in `pictures.json` too, so the file names each picture's file
//!   correctly for every app). One that has see-through parts, or a small
//!   one (an icon, whose edges a JPEG would blur), keeps its type. A JPEG is
//!   saved again only when it is made narrower.
//! - A GIF is left as it is (it may move, and not every app can read one
//!   to save it again), and so is any picture that does not get at least
//!   [`LEAST_SAVING`] percent smaller, or that cannot be read.
//!
//! The person's own photos (`mine/pictures/`) are never changed: they are
//! made at most 1280 pixels wide when they are added already.
//!
//! Not on Android, which imports map pack files but makes none.

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex, PoisonError,
    },
    time::Duration,
};

use serde_json::Value;

use super::{Entry, EntryData, Progress, SharedPictures, Stop};

/// The widest a picture is in a smaller file.
pub const SMALLER_WIDTH: u32 = 1280;
/// The tallest a picture is in a smaller file.
pub const SMALLER_HEIGHT: u32 = 4096;
/// The quality of a picture saved as a JPEG.
pub const SMALLER_JPEG_QUALITY: u8 = 85;
/// A picture smaller than this on both sides keeps its type.
pub const KEEP_TYPE_UNDER: u32 = 256;
/// A picture is changed only when it gets at least this much smaller, in percent.
pub const LEAST_SAVING: u64 = 10;

/// A picture made smaller.
#[derive(Debug)]
pub struct Made {
    pub bytes: Vec<u8>,
    /// It is a JPEG now, and was not.
    pub jpeg: bool,
    pub width: u32,
    pub height: u32,
}

/// What making a file's pictures smaller did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Saved {
    /// Pictures made smaller.
    pub pictures: u64,
    /// Their bytes before and after.
    pub before: u64,
    pub after: u64,
}

/// A picture's file made smaller by the rule above, given its bytes and the
/// type its name says (`png`, `jpg`, `jpeg`, `webp` or `gif`); `jpeg_name`
/// says whether it may become a JPEG (its file can be named `.jpg`). None
/// when it is left as it is.
#[cfg(not(target_os = "android"))]
pub fn smaller_picture(bytes: &[u8], extension: &str, jpeg_name: bool) -> Option<Made> {
    use image::{
        codecs::{
            jpeg::JpegEncoder,
            png::{CompressionType, FilterType as PngFilter, PngEncoder},
            webp::WebPEncoder,
        },
        imageops::FilterType,
        ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits,
    };
    use std::io::Cursor;

    let named = match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "webp" => ImageFormat::WebP,
        _ => return None,
    };
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    // A file that is not of the type its name says is left alone.
    if reader.format() != Some(named) {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(256 << 20);
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    reader.limits(limits);
    let mut image = reader.decode().ok()?;
    let narrower = image.width() > SMALLER_WIDTH || image.height() > SMALLER_HEIGHT;
    if narrower {
        let (width, height) = fitted(image.width(), image.height());
        image = image.resize_exact(width, height, FilterType::CatmullRom);
    }
    let opaque = !image.color().has_alpha() || image.to_rgba8().pixels().all(|p| p[3] == 255);
    let large = image.width() >= KEEP_TYPE_UNDER || image.height() >= KEEP_TYPE_UNDER;
    let to_jpeg = named != ImageFormat::Jpeg && opaque && large && jpeg_name;
    if !narrower && !to_jpeg {
        return None;
    }
    let mut out = Cursor::new(Vec::new());
    let (width, height) = (image.width(), image.height());
    let written = if to_jpeg || named == ImageFormat::Jpeg {
        let rgb = image.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, SMALLER_JPEG_QUALITY).write_image(
            rgb.as_raw(),
            width,
            height,
            ExtendedColorType::Rgb8,
        )
    } else {
        let rgba = image.to_rgba8();
        if named == ImageFormat::Png {
            PngEncoder::new_with_quality(&mut out, CompressionType::Best, PngFilter::Adaptive)
                .write_image(rgba.as_raw(), width, height, ExtendedColorType::Rgba8)
        } else {
            WebPEncoder::new_lossless(&mut out).write_image(
                rgba.as_raw(),
                width,
                height,
                ExtendedColorType::Rgba8,
            )
        }
    };
    written.ok()?;
    let made = out.into_inner();
    let most = bytes.len() as u64 * (100 - LEAST_SAVING) / 100;
    (made.len() as u64 <= most).then_some(Made {
        bytes: made,
        jpeg: to_jpeg,
        width,
        height,
    })
}

#[cfg(target_os = "android")]
pub fn smaller_picture(_bytes: &[u8], _extension: &str, _jpeg_name: bool) -> Option<Made> {
    None
}

/// `width` x `height` made to fit [`SMALLER_WIDTH`] x [`SMALLER_HEIGHT`],
/// its shape kept; at least one pixel each way.
pub fn fitted(width: u32, height: u32) -> (u32, u32) {
    let (width, height) = (u64::from(width.max(1)), u64::from(height.max(1)));
    let (most_w, most_h) = (u64::from(SMALLER_WIDTH), u64::from(SMALLER_HEIGHT));
    if width <= most_w && height <= most_h {
        return (width as u32, height as u32);
    }
    if width * most_h >= height * most_w {
        (
            most_w as u32,
            (height * most_w).div_ceil(width).max(1) as u32,
        )
    } else {
        (
            (width * most_h).div_ceil(height).max(1) as u32,
            most_h as u32,
        )
    }
}

/// How many pictures are made smaller at once: each may take a few hundred
/// megabytes while it is read, so no more than this.
const AT_ONCE: usize = 4;

/// Makes the pictures a map pack file carries smaller (see the module),
/// in the file's entries and in its `pictures.json` alike: a picture saved
/// as a JPEG is named `.jpg` in both, unless another picture of the list
/// has that name already (it then keeps its type, or stays as it is), and
/// the width and height the list gives are those of the smaller picture.
/// Up to [`AT_ONCE`] pictures are made at a time; `progress` is told how
/// many are done (`pictures_done` of `pictures_total`), and `cancelled` is
/// asked while they are made.
pub fn make_smaller(
    pictures: &mut SharedPictures,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Saved, Stop> {
    // Every name the list gives, so a renamed file never takes another's.
    let mut names: HashSet<String> = pictures
        .list
        .iter()
        .flat_map(|picture| {
            [
                picture.get("file").and_then(Value::as_str),
                picture.pointer("/pageCopy/file").and_then(Value::as_str),
            ]
        })
        .flatten()
        .map(str::to_ascii_lowercase)
        .collect();
    // The pictures to look at: their entry, file, type and JPEG name.
    let jobs: Vec<(usize, PathBuf, String, String)> = pictures
        .files
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let EntryData::File(path) = &entry.data else {
                return None;
            };
            let (stem, extension) = entry.name.rsplit_once('.')?;
            Some((
                index,
                path.clone(),
                extension.to_owned(),
                format!("{stem}.jpg"),
            ))
        })
        .collect();
    let total = jobs.len() as u64;
    if total == 0 {
        return Ok(Saved::default());
    }
    let results: Vec<Mutex<Option<(u64, Made)>>> = jobs.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let done = AtomicU64::new(0);
    let stop = AtomicBool::new(false);
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .clamp(1, AT_ONCE)
        .min(jobs.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                while !stop.load(Ordering::Relaxed) {
                    let at = next.fetch_add(1, Ordering::Relaxed);
                    let Some((_, path, extension, jpeg_name)) = jobs.get(at) else {
                        break;
                    };
                    let renamable =
                        matches!(extension.to_ascii_lowercase().as_str(), "jpg" | "jpeg")
                            || !names.contains(&jpeg_name.to_ascii_lowercase());
                    let made = std::fs::read(path).ok().and_then(|bytes| {
                        smaller_picture(&bytes, extension, renamable)
                            .map(|made| (bytes.len() as u64, made))
                    });
                    *results[at].lock().unwrap_or_else(PoisonError::into_inner) = made;
                    done.fetch_add(1, Ordering::Relaxed);
                }
            });
        }
        loop {
            let finished = done.load(Ordering::Relaxed);
            progress(Progress {
                pictures_done: finished,
                pictures_total: total,
                ..Progress::default()
            });
            if finished >= total {
                break;
            }
            if cancelled() {
                stop.store(true, Ordering::Relaxed);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    if stop.load(Ordering::Relaxed) {
        return Err(Stop::Cancelled);
    }
    let mut saved = Saved::default();
    for ((index, _, _, jpeg_name), result) in jobs.into_iter().zip(results) {
        let Some((before, made)) = result.into_inner().unwrap_or_else(PoisonError::into_inner)
        else {
            continue;
        };
        let entry = &mut pictures.files[index];
        let name = if made.jpeg {
            // Two pictures that would both take this name: the first does.
            if !names.insert(jpeg_name.to_ascii_lowercase()) {
                continue;
            }
            jpeg_name
        } else {
            entry.name.clone()
        };
        saved.pictures += 1;
        saved.before += before;
        saved.after += made.bytes.len() as u64;
        for picture in pictures.list.iter_mut().filter(|picture| {
            picture.get("file").and_then(Value::as_str) == Some(entry.name.as_str())
        }) {
            let Some(object) = picture.as_object_mut() else {
                continue;
            };
            object.insert("file".to_owned(), Value::String(name.clone()));
            for (key, value) in [("width", made.width), ("height", made.height)] {
                if object.contains_key(key) {
                    object.insert(key.to_owned(), Value::from(value));
                }
            }
        }
        *entry = Entry {
            name,
            size: made.bytes.len() as u64,
            data: EntryData::Bytes(made.bytes),
        };
    }
    Ok(saved)
}

#[cfg(all(test, not(target_os = "android")))]
pub(crate) mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, ImageFormat, ImageReader, Rgb, RgbImage, Rgba, RgbaImage};

    use super::*;

    /// A picture like a photo: smooth colours with fine grain, which a
    /// lossless file keeps at a high cost.
    pub(crate) fn photo(width: u32, height: u32, see_through: bool) -> DynamicImage {
        let mut seed: u32 = 0x9e37_79b9;
        let mut grain = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed % 24) as u8
        };
        let colour = |x: u32, y: u32, grain: u8| {
            [
                (x * 200 / width.max(1)) as u8 + grain,
                (y * 200 / height.max(1)) as u8 + grain,
                ((x + y) * 100 / (width + height).max(1)) as u8 + grain,
            ]
        };
        if see_through {
            DynamicImage::ImageRgba8(RgbaImage::from_fn(width, height, |x, y| {
                let [r, g, b] = colour(x, y, grain());
                Rgba([r, g, b, if x < width / 4 { 0 } else { 255 }])
            }))
        } else {
            DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
                Rgb(colour(x, y, grain()))
            }))
        }
    }

    pub(crate) fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        match format {
            ImageFormat::Jpeg => DynamicImage::ImageRgb8(image.to_rgb8())
                .write_to(&mut out, format)
                .unwrap(),
            _ => image.write_to(&mut out, format).unwrap(),
        }
        out.into_inner()
    }

    pub(crate) fn read(bytes: &[u8]) -> (ImageFormat, u32, u32) {
        let reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .unwrap();
        let format = reader.format().unwrap();
        let (width, height) = reader.into_dimensions().unwrap();
        (format, width, height)
    }

    #[test]
    fn a_large_photo_becomes_a_narrower_jpeg() {
        let png = encoded(&photo(3000, 2000, false), ImageFormat::Png);
        let made = smaller_picture(&png, "png", true).unwrap();
        assert!(made.jpeg);
        assert_eq!((made.width, made.height), (1280, 854));
        assert_eq!(read(&made.bytes), (ImageFormat::Jpeg, 1280, 854));
        assert!(
            made.bytes.len() * 4 < png.len(),
            "{} of {}",
            made.bytes.len(),
            png.len()
        );
    }

    #[test]
    fn a_picture_with_see_through_parts_keeps_its_type() {
        let png = encoded(&photo(2000, 1000, true), ImageFormat::Png);
        let made = smaller_picture(&png, "png", true).unwrap();
        assert!(!made.jpeg);
        assert_eq!(read(&made.bytes), (ImageFormat::Png, 1280, 640));
        let webp = encoded(&photo(1600, 400, true), ImageFormat::WebP);
        let made = smaller_picture(&webp, "webp", true).unwrap();
        assert_eq!(read(&made.bytes), (ImageFormat::WebP, 1280, 320));
    }

    #[test]
    fn a_narrow_photo_becomes_a_jpeg_of_the_same_size_only_where_it_may_be_named_so() {
        let png = encoded(&photo(900, 600, false), ImageFormat::Png);
        let made = smaller_picture(&png, "png", true).unwrap();
        assert_eq!(read(&made.bytes), (ImageFormat::Jpeg, 900, 600));
        // Another picture has the name it would take: it stays as it is.
        assert!(smaller_picture(&png, "png", false).is_none());
    }

    #[test]
    fn a_jpeg_is_saved_again_only_when_made_narrower() {
        let wide = encoded(&photo(2560, 1440, false), ImageFormat::Jpeg);
        let made = smaller_picture(&wide, "jpg", true).unwrap();
        assert!(!made.jpeg, "it was a JPEG already");
        assert_eq!(read(&made.bytes), (ImageFormat::Jpeg, 1280, 720));
        let narrow = encoded(&photo(1200, 800, false), ImageFormat::Jpeg);
        assert!(smaller_picture(&narrow, "jpeg", true).is_none());
    }

    #[test]
    fn a_tall_picture_keeps_its_width_until_it_is_very_tall() {
        assert_eq!(fitted(1000, 6000), (683, 4096));
        assert_eq!(fitted(1000, 4000), (1000, 4000));
        assert_eq!(fitted(2000, 8000), (1024, 4096));
        assert_eq!(fitted(5000, 10), (1280, 3));
        assert_eq!(fitted(100_000, 1), (1280, 1));
    }

    #[test]
    fn leaves_icons_gifs_odd_files_and_what_would_not_get_smaller() {
        // An icon keeps its type and size.
        let icon = encoded(&photo(64, 64, false), ImageFormat::Png);
        assert!(smaller_picture(&icon, "png", true).is_none());
        // A GIF, which may move, is never read.
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0xd0, 0x07, 0xd0, 0x07, 0, 0, 0]);
        gif.resize(1 << 20, 0);
        assert!(smaller_picture(&gif, "gif", true).is_none());
        // A file whose name says another type, or that is no picture.
        let png = encoded(&photo(2000, 1000, false), ImageFormat::Png);
        assert!(smaller_picture(&png, "jpg", true).is_none());
        assert!(smaller_picture(b"not a picture", "png", true).is_none());
        // A flat drawing a PNG keeps in a few bytes: a JPEG of it is no smaller.
        let flat = DynamicImage::ImageRgb8(RgbImage::from_pixel(1000, 600, Rgb([30, 60, 90])));
        let flat = encoded(&flat, ImageFormat::Png);
        assert!(smaller_picture(&flat, "png", true).is_none());
    }
}
