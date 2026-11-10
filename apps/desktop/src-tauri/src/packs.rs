//! Serves data packs to the webview through the `atlas-pack` URI scheme.
//!
//! The web app reads PMTiles archives with HTTP range requests. Tauri's
//! built-in protocol for the bundled frontend answers every request with the
//! whole file and a `200` status, which the PMTiles reader rejects, so packs
//! are served from folders on disk by this protocol instead, with single-range
//! support.
//!
//! A request for `<scheme URL>/<pack id>/<path>` is answered from the folder
//! registered for `<pack id>`. The URL looks different per platform:
//!
//! - Linux and macOS: `atlas-pack://localhost/<pack id>/<path>`
//! - Windows: `http://atlas-pack.localhost/<pack id>/<path>`
//!
//! Only registered folders are reachable, read-only, with no directory
//! listings and no hidden files.

use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, PoisonError, RwLock},
    time::UNIX_EPOCH,
};

use percent_encoding::percent_decode_str;
use tauri::http::{header, Method, Request, Response, StatusCode};

/// The URI scheme name registered with the webview.
pub const SCHEME: &str = "atlas-pack";

/// Pack ids name a registered folder in URLs, so they are kept URL-safe.
fn is_valid_pack_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
        && id.len() <= 64
}

/// The pack folders the protocol may serve, keyed by pack id.
///
/// Cloning is cheap and every clone sees the same registrations, so the
/// registry can live in Tauri's managed state and be handed to request
/// handlers on worker threads.
#[derive(Clone, Default)]
pub struct PackRegistry {
    roots: Arc<RwLock<HashMap<String, PathBuf>>>,
}

#[derive(Debug)]
pub enum RegisterError {
    InvalidId(String),
    NotADirectory(PathBuf, io::Error),
}

impl std::fmt::Display for RegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidId(id) => write!(
                f,
                "invalid pack id {id:?}: use 1 to 64 lowercase letters, digits, '-' or '_'"
            ),
            Self::NotADirectory(path, error) => {
                write!(f, "pack folder {} is not usable: {error}", path.display())
            }
        }
    }
}

impl std::error::Error for RegisterError {}

impl PackRegistry {
    /// Makes the folder `root` available as `<scheme URL>/<id>/`, replacing
    /// any folder registered under the same id.
    pub fn register(&self, id: &str, root: &Path) -> Result<(), RegisterError> {
        if !is_valid_pack_id(id) {
            return Err(RegisterError::InvalidId(id.to_owned()));
        }
        let canonical = root
            .canonicalize()
            .and_then(|path| {
                if path.is_dir() {
                    Ok(path)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::NotADirectory,
                        "not a directory",
                    ))
                }
            })
            .map_err(|error| RegisterError::NotADirectory(root.to_owned(), error))?;
        self.roots
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_owned(), canonical);
        Ok(())
    }

    fn root(&self, id: &str) -> Option<PathBuf> {
        self.roots
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
    }

    /// Answers one protocol request. Blocking: call it off the main thread.
    pub fn respond(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let method = request.method();
        if method == Method::OPTIONS {
            return preflight();
        }
        if method != Method::GET && method != Method::HEAD {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "GET, HEAD, OPTIONS")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .expect("valid response");
        }

        let file = match self.resolve(request.uri().path()) {
            Ok(file) => file,
            Err(status) => return error(status),
        };
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok());
        match read_file(&file, range, method == Method::HEAD) {
            Ok(response) => response,
            Err(err) if err.kind() == io::ErrorKind::NotFound => error(StatusCode::NOT_FOUND),
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR),
        }
    }

    /// Maps a URL path to a file inside a registered pack folder.
    fn resolve(&self, url_path: &str) -> Result<PathBuf, StatusCode> {
        let mut segments = url_path.strip_prefix('/').unwrap_or(url_path).split('/');
        let id = segments.next().unwrap_or_default();
        let root = self.root(id).ok_or(StatusCode::NOT_FOUND)?;

        let mut path = root.clone();
        let mut any = false;
        for segment in segments {
            let segment = percent_decode_str(segment)
                .decode_utf8()
                .map_err(|_| StatusCode::BAD_REQUEST)?;
            // Rejects traversal, hidden files, empty segments and anything a
            // platform could read as a separator, drive or device prefix.
            if segment.is_empty() || segment.starts_with('.') || segment.contains(['\\', ':', '\0'])
            {
                return Err(StatusCode::FORBIDDEN);
            }
            path.push(segment.as_ref());
            any = true;
        }
        if !any {
            return Err(StatusCode::NOT_FOUND);
        }

        // Symbolic links must not lead outside the pack folder.
        let canonical = path.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
        if !canonical.starts_with(&root) {
            return Err(StatusCode::FORBIDDEN);
        }
        if !canonical.is_file() {
            return Err(StatusCode::NOT_FOUND);
        }
        Ok(canonical)
    }
}

/// The byte range a request asks for, as inclusive offsets.
#[derive(Debug, PartialEq, Eq)]
enum ByteRange {
    Whole,
    Part { start: u64, end: u64 },
    Unsatisfiable,
}

/// Parses a `Range` header for a file of `len` bytes.
///
/// Only a single `bytes` range is honoured, which is all the PMTiles reader
/// sends. Anything else is ignored and the whole file is returned, as HTTP
/// allows.
fn parse_range(header: Option<&str>, len: u64) -> ByteRange {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return ByteRange::Whole;
    };
    let Some((from, to)) = spec.trim().split_once('-') else {
        return ByteRange::Whole;
    };
    let (from, to) = (from.trim(), to.trim());

    if from.is_empty() {
        // Suffix range: the last `to` bytes.
        return match to.parse::<u64>() {
            Ok(0) => ByteRange::Unsatisfiable,
            Ok(_) if len == 0 => ByteRange::Unsatisfiable,
            Ok(suffix) => ByteRange::Part {
                start: len.saturating_sub(suffix),
                end: len - 1,
            },
            Err(_) => ByteRange::Whole,
        };
    }

    let Ok(start) = from.parse::<u64>() else {
        return ByteRange::Whole;
    };
    let end = if to.is_empty() {
        u64::MAX
    } else {
        match to.parse::<u64>() {
            Ok(end) if end >= start => end,
            _ => return ByteRange::Whole,
        }
    };
    if start >= len {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Part {
        start,
        end: end.min(len - 1),
    }
}

fn read_file(path: &Path, range: Option<&str>, head: bool) -> io::Result<Response<Vec<u8>>> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let len = metadata.len();
    // Lets the PMTiles reader notice when an archive changes on disk while open.
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let etag = format!("\"{len:x}-{modified:x}\"");

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type(path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Length, Content-Range, ETag",
        );

    let (builder, start, count) = match parse_range(range, len) {
        ByteRange::Whole => (builder.status(StatusCode::OK), 0, len),
        ByteRange::Part { start, end } => (
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")),
            start,
            end - start + 1,
        ),
        ByteRange::Unsatisfiable => {
            return Ok(builder
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .header(header::CONTENT_LENGTH, 0)
                .body(Vec::new())
                .expect("valid response"));
        }
    };

    let body = if head {
        Vec::new()
    } else {
        let mut body = Vec::with_capacity(usize::try_from(count).unwrap_or(0));
        file.seek(SeekFrom::Start(start))?;
        file.take(count).read_to_end(&mut body)?;
        body
    };
    Ok(builder
        .header(header::CONTENT_LENGTH, count)
        .body(body)
        .expect("valid response"))
}

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("json") => "application/json; charset=utf-8",
        Some("pmtiles") => "application/vnd.pmtiles",
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("md") => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Cross-origin preflight: the app page and the pack scheme are different
/// origins, and `Range` is only exempt from preflight in some engines.
fn preflight() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .body(Vec::new())
        .expect("valid response")
}

fn error(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(
            status
                .canonical_reason()
                .unwrap_or("Error")
                .as_bytes()
                .to_vec(),
        )
        .expect("valid response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A pack folder under the system temp directory, removed on drop.
    struct TempPack(PathBuf);

    impl TempPack {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("atlas-pack-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join("tiles")).unwrap();
            fs::write(dir.join("manifest.json"), br#"{"title":"Test"}"#).unwrap();
            fs::write(
                dir.join("tiles/base.pmtiles"),
                (0u8..=99).collect::<Vec<_>>(),
            )
            .unwrap();
            fs::write(dir.join(".hidden"), b"secret").unwrap();
            Self(dir)
        }
    }

    impl Drop for TempPack {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn registry(pack: &TempPack) -> PackRegistry {
        let registry = PackRegistry::default();
        registry.register("test", &pack.0).unwrap();
        registry
    }

    fn get(registry: &PackRegistry, uri: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let mut request = Request::builder().uri(uri);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        registry.respond(&request.body(Vec::new()).unwrap())
    }

    fn header_value(response: &Response<Vec<u8>>, name: header::HeaderName) -> &str {
        response.headers().get(name).unwrap().to_str().unwrap()
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range(None, 100), ByteRange::Whole);
        assert_eq!(
            parse_range(Some("bytes=0-9"), 100),
            ByteRange::Part { start: 0, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=90-"), 100),
            ByteRange::Part { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=50-500"), 100),
            ByteRange::Part { start: 50, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-10"), 100),
            ByteRange::Part { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-500"), 100),
            ByteRange::Part { start: 0, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=100-"), 100),
            ByteRange::Unsatisfiable
        );
        assert_eq!(parse_range(Some("bytes=-0"), 100), ByteRange::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), ByteRange::Unsatisfiable);
        // Multiple, reversed or malformed ranges fall back to the whole file.
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), ByteRange::Whole);
        assert_eq!(parse_range(Some("bytes=9-0"), 100), ByteRange::Whole);
        assert_eq!(parse_range(Some("items=0-9"), 100), ByteRange::Whole);
    }

    #[test]
    fn serves_whole_files() {
        let pack = TempPack::new("whole");
        let response = get(
            &registry(&pack),
            "atlas-pack://localhost/test/manifest.json",
            None,
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), br#"{"title":"Test"}"#);
        assert_eq!(
            header_value(&response, header::CONTENT_TYPE),
            "application/json; charset=utf-8"
        );
        assert_eq!(header_value(&response, header::CONTENT_LENGTH), "16");
    }

    #[test]
    fn serves_byte_ranges() {
        let pack = TempPack::new("range");
        let registry = registry(&pack);
        // The Windows form of the URL reaches the same file.
        for uri in [
            "atlas-pack://localhost/test/tiles/base.pmtiles",
            "http://atlas-pack.localhost/test/tiles/base.pmtiles",
        ] {
            let response = get(&registry, uri, Some("bytes=10-19"));
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.body(), &(10u8..=19).collect::<Vec<_>>());
            assert_eq!(
                header_value(&response, header::CONTENT_RANGE),
                "bytes 10-19/100"
            );
            assert_eq!(header_value(&response, header::CONTENT_LENGTH), "10");
            assert_eq!(header_value(&response, header::ACCEPT_RANGES), "bytes");
        }

        let response = get(
            &registry,
            "atlas-pack://localhost/test/tiles/base.pmtiles",
            Some("bytes=200-"),
        );
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            header_value(&response, header::CONTENT_RANGE),
            "bytes */100"
        );
    }

    #[test]
    fn answers_head_and_preflight() {
        let pack = TempPack::new("head");
        let registry = registry(&pack);
        let head = Request::builder()
            .method(Method::HEAD)
            .uri("atlas-pack://localhost/test/tiles/base.pmtiles")
            .body(Vec::new())
            .unwrap();
        let response = registry.respond(&head);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(header_value(&response, header::CONTENT_LENGTH), "100");

        let options = Request::builder()
            .method(Method::OPTIONS)
            .uri("atlas-pack://localhost/test/tiles/base.pmtiles")
            .body(Vec::new())
            .unwrap();
        let response = registry.respond(&options);
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            header_value(&response, header::ACCESS_CONTROL_ALLOW_HEADERS),
            "Range"
        );

        let post = Request::builder()
            .method(Method::POST)
            .uri("atlas-pack://localhost/test/manifest.json")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            registry.respond(&post).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[test]
    fn refuses_paths_outside_the_pack() {
        let pack = TempPack::new("escape");
        let registry = registry(&pack);
        let status = |uri: &str| get(&registry, uri, None).status();

        assert_eq!(
            status("atlas-pack://localhost/other/manifest.json"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status("atlas-pack://localhost/test/missing.json"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status("atlas-pack://localhost/test/"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(status("atlas-pack://localhost/test"), StatusCode::NOT_FOUND);
        assert_eq!(
            status("atlas-pack://localhost/test/tiles"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status("atlas-pack://localhost/test/.hidden"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status("atlas-pack://localhost/test/%2e%2e/x"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status("atlas-pack://localhost/test/tiles/%2E%2E/manifest.json"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status("atlas-pack://localhost/test/..%5Cx"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status("atlas-pack://localhost/test/C%3A%5Cx"),
            StatusCode::FORBIDDEN
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_leave_the_pack() {
        let pack = TempPack::new("symlink");
        let outside = TempPack::new("symlink-outside");
        std::os::unix::fs::symlink(outside.0.join("manifest.json"), pack.0.join("link.json"))
            .unwrap();
        let response = get(
            &registry(&pack),
            "atlas-pack://localhost/test/link.json",
            None,
        );
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn validates_registrations() {
        let pack = TempPack::new("register");
        let registry = PackRegistry::default();
        assert!(registry.register("demo", &pack.0).is_ok());
        assert!(registry.register("my-pack_2", &pack.0).is_ok());
        assert!(matches!(
            registry.register("Bad Id", &pack.0),
            Err(RegisterError::InvalidId(_))
        ));
        assert!(matches!(
            registry.register("x", &pack.0.join("manifest.json")),
            Err(RegisterError::NotADirectory(..))
        ));
        assert!(matches!(
            registry.register("x", &pack.0.join("missing")),
            Err(RegisterError::NotADirectory(..))
        ));
    }
}
