//! Whole pictures of maps for an importer (`ImportContext.wholePicture` of
//! the importer contract): a site that keeps each map as one picture. The
//! web app asks for the picture as it asks for every page it reads by
//! itself (the site's rules file, `robots.txt`, the pause and stopping at
//! the first refusal are its, see `importing.ts`); this module makes the
//! one request ([`fetch_picture`], as `pagefetch.rs` does: the app's own
//! name, no cookies, redirects on the same site only), keeps the picture in
//! a hidden folder of the maps folder, and cuts it into map images with the
//! cutter of "New map from a picture" (`tiles::cut`, [`cut_picture`]). The cut stays there
//! until the import that names it is saved, which moves it into the pack
//! (`Library::save_import`), or is thrown away ([`discard`]); the folder is
//! cleared at the next start in any case, as every `.importing-` folder is
//! (see `removal::finish_pending_deletes`).
//!
//! In a build with downloads only. Android has no cutter, so it fetches
//! nothing for this.

use std::{
    io::Write as _,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::pagefetch::{request, Head};

/// The hidden folder of the maps folder that holds pictures and their cuts
/// until an import is saved. Its name begins with the prefix of folders a
/// start clears.
pub const CUTS_DIR: &str = ".importing-picture-cuts";
/// A picture larger than this, as a file, is not kept.
pub const MAX_PICTURE_BYTES: u64 = 512 << 20;
/// How long the request for one picture may take, all of it.
const TIMEOUT: Duration = Duration::from_secs(300);

/// Whether `name` is the app's name of a cut: lowercase letters, digits and
/// dashes, as the importer contract's `CUT_PICTURE_PATTERN`.
pub fn is_cut_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
}

/// A new name for a picture and its cut.
fn new_name() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_nanos());
    format!(
        "{:x}-{:x}-{:x}",
        nanos,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// The file a fetched picture is kept in until it is cut.
fn picture_file(cuts: &Path, name: &str) -> PathBuf {
    cuts.join(format!("{name}.picture"))
}

/// One answer for a picture, as the web app reads it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPicture {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    /// Lowercase, without parameters; empty when absent.
    pub content_type: String,
    /// The `Retry-After` header, when the site sent one.
    pub retry_after: Option<String>,
    /// The name the picture is kept under, for a successful answer that
    /// came whole and within [`MAX_PICTURE_BYTES`].
    pub picture: Option<String>,
    /// The answer was larger than [`MAX_PICTURE_BYTES`], so it was not kept.
    pub too_large: bool,
}

/// Fetches the picture at `address` as the app and keeps it in `cuts`.
/// Any answer is handed back with its status; only a successful one is
/// kept, under the name in [`FetchedPicture::picture`].
pub async fn fetch_picture(address: &str, cuts: &Path) -> Result<FetchedPicture, String> {
    let (url, mut response) = request(
        address,
        "image/png, image/jpeg, image/webp, image/*;q=0.8",
        TIMEOUT,
    )
    .await?;
    let head = Head::of(&response);
    let mut answer = FetchedPicture {
        url: url.to_string(),
        final_url: head.final_url,
        status: head.status,
        content_type: head.content_type,
        retry_after: head.retry_after,
        picture: None,
        too_large: false,
    };
    if !(200..300).contains(&answer.status) {
        return Ok(answer);
    }
    if response.content_length().unwrap_or(0) > MAX_PICTURE_BYTES {
        answer.too_large = true;
        return Ok(answer);
    }
    std::fs::create_dir_all(cuts)
        .map_err(|error| format!("Could not write to the maps folder: {error}"))?;
    let name = new_name();
    let path = picture_file(cuts, &name);
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&path)
            .map_err(|error| format!("Could not keep the picture: {error}"))?,
    );
    let mut written = 0u64;
    let kept: Result<bool, String> = async {
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "The picture was cut off.".to_owned())?
        {
            written += chunk.len() as u64;
            if written > MAX_PICTURE_BYTES {
                return Ok(false);
            }
            file.write_all(&chunk)
                .map_err(|error| format!("Could not keep the picture: {error}"))?;
        }
        file.flush()
            .map_err(|error| format!("Could not keep the picture: {error}"))?;
        Ok(true)
    }
    .await;
    drop(file);
    match kept {
        Ok(true) => answer.picture = Some(name),
        Ok(false) => {
            let _ = std::fs::remove_file(&path);
            answer.too_large = true;
        }
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
    }
    Ok(answer)
}

/// What cutting a kept picture gave, as the web app reads it: the facts of
/// the cut, or why there is none (`format`, `size`, `missing` or `failed`)
/// with a sentence.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PictureCut {
    pub ok: bool,
    pub width: u32,
    pub height: u32,
    pub max_zoom: u8,
    pub tile_size: u32,
    /// `jpg` or `png`.
    pub extension: String,
    pub problem: Option<String>,
    pub message: Option<String>,
}

impl PictureCut {
    fn problem(problem: &str, message: String) -> Self {
        Self {
            problem: Some(problem.to_owned()),
            message: Some(message),
            ..Self::default()
        }
    }
}

/// Cuts the picture kept under `name` into map images in `cuts/<name>/`
/// (see `tiles::cut`), and removes the picture. A picture the cutter cannot
/// take is not cut: one that is no PNG, JPEG or WebP, or one too large or
/// too small (with its size).
#[cfg(not(target_os = "android"))]
pub fn cut_picture(cuts: &Path, name: &str) -> PictureCut {
    use crate::{
        packfile::Stop,
        tiles::cut::{cut, inspect, is_picture, TILE_SIZE},
    };
    if !is_cut_name(name) {
        return PictureCut::problem("failed", "That picture is not one this app kept.".into());
    }
    let picture = picture_file(cuts, name);
    if !picture.is_file() {
        return PictureCut::problem("missing", "That picture is not kept any more.".into());
    }
    let done = (|| {
        if !is_picture(&picture) {
            return PictureCut::problem(
                "format",
                "It is not a PNG, JPEG or WebP picture.".to_owned(),
            );
        }
        let info = match inspect(&picture) {
            Ok(info) => info,
            Err(error) => return PictureCut::problem("failed", error),
        };
        if let Some(problem) = info.problem {
            return PictureCut {
                width: info.width,
                height: info.height,
                ..PictureCut::problem("size", problem)
            };
        }
        let out = cuts.join(name);
        let _ = std::fs::remove_dir_all(&out);
        match cut(&picture, &out, &mut |_| {}, &|| false) {
            Ok(done) => PictureCut {
                ok: true,
                width: done.width,
                height: done.height,
                max_zoom: done.max_zoom,
                tile_size: TILE_SIZE,
                extension: done.extension.to_owned(),
                problem: None,
                message: None,
            },
            Err(Stop::Failed(error)) => PictureCut::problem("failed", error),
            Err(Stop::Cancelled) => PictureCut::problem("failed", "The cut was stopped.".into()),
        }
    })();
    let _ = std::fs::remove_file(&picture);
    done
}

/// Removes kept pictures and cuts no saved import named.
pub fn discard(cuts: &Path, names: &[String]) {
    for name in names.iter().filter(|name| is_cut_name(name)) {
        let _ = std::fs::remove_file(picture_file(cuts, name));
        let _ = std::fs::remove_dir_all(cuts.join(name));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::tiles::{
        download::tests::{MockServer, Reply},
        store::tests::TempDir,
    };

    fn ensure_crypto() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[test]
    fn names_of_cuts() {
        assert!(is_cut_name("18f3a-4c1-0"));
        for bad in ["", "-a", "A", "a/b", "a.b", &"a".repeat(65)] {
            assert!(!is_cut_name(bad), "{bad}");
        }
        assert_ne!(new_name(), new_name());
        assert!(is_cut_name(&new_name()));
    }

    #[tokio::test]
    async fn fetches_a_picture_as_the_app_and_keeps_only_a_successful_answer() {
        ensure_crypto();
        let png = {
            let mut bytes = Vec::new();
            image::DynamicImage::ImageRgb8(image::RgbImage::new(300, 40))
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .unwrap();
            bytes
        };
        let served = png.clone();
        let server = MockServer::start(Arc::new(move |path, _| match path {
            "/maps/strip.png" => Reply {
                body: served.clone(),
                ..Reply::status(200)
            }
            .header("Content-Type", "image/png"),
            "/maps/text.png" => Reply {
                body: b"not a picture".to_vec(),
                ..Reply::status(200)
            },
            "/slow" => Reply::status(429).header("Retry-After", "60"),
            _ => Reply::status(404),
        }))
        .await;
        let dir = TempDir::new("picture-cuts");
        let cuts = dir.0.join(CUTS_DIR);
        let got = fetch_picture(&server.url("/maps/strip.png"), &cuts)
            .await
            .unwrap();
        assert_eq!((got.status, got.content_type.as_str()), (200, "image/png"));
        let name = got.picture.unwrap();
        assert_eq!(std::fs::read(picture_file(&cuts, &name)).unwrap(), png);
        for seen in server.seen() {
            assert_eq!(
                seen.headers["user-agent"],
                crate::tiles::download::USER_AGENT
            );
            assert!(!seen.headers.contains_key("cookie"));
        }
        let slow = fetch_picture(&server.url("/slow"), &cuts).await.unwrap();
        assert_eq!(
            (slow.status, slow.retry_after.as_deref(), slow.picture),
            (429, Some("60"), None)
        );
        assert_eq!(
            fetch_picture(&server.url("/gone.png"), &cuts)
                .await
                .unwrap()
                .status,
            404
        );

        // The kept picture is cut, and the picture let go.
        #[cfg(not(target_os = "android"))]
        {
            let cut = cut_picture(&cuts, &name);
            assert!(cut.ok, "{cut:?}");
            assert_eq!(
                (cut.width, cut.height, cut.max_zoom, cut.tile_size),
                (300, 40, 1, 256)
            );
            assert_eq!(cut.extension, "jpg");
            assert!(cuts.join(&name).join("1/1/0.jpg").is_file());
            assert!(!picture_file(&cuts, &name).exists());
            // A file that is no picture is named as such, and let go too.
            let text = fetch_picture(&server.url("/maps/text.png"), &cuts)
                .await
                .unwrap()
                .picture
                .unwrap();
            let refused = cut_picture(&cuts, &text);
            assert_eq!(refused.problem.as_deref(), Some("format"));
            assert!(!picture_file(&cuts, &text).exists());
            discard(&cuts, &[name.clone(), "../x".to_owned()]);
            assert!(!cuts.join(&name).exists());
        }
    }
}
