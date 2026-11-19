//! Timing trial T1: can Atlas read a large pack file (`.atlaspack`) where
//! it lies, without unpacking it into a folder first?
//!
//! The program writes a made-up pack file shaped like the app's own (see
//! `apps/desktop/src-tauri/src/packfile/mod.rs` and `export.rs`): a ZIP
//! archive, ZIP64 when it needs to be, with `atlaspack.json` first, the
//! pack's JSON files deflated (one of about 20 MB, one of about 10 MB) and
//! then the map images stored as they are, at paths shaped like a layer's
//! `tiles/<layer>/{z}/{x}/{y}.webp`. The images are pseudo-random bytes from
//! a fixed seed: no clock, no real pictures, no network.
//!
//! It then times, several times each, with the median and the slowest run:
//!
//! - a. reading the description at the front without the central directory;
//! - b. opening the archive with the `zip` crate, and the memory it holds;
//! - c. random image reads by name: c1 the archive opened for each read,
//!   c2 one archive kept open behind a lock, c3 a table (name to data
//!   offset and length) read with plain positioned reads, no ZIP code on
//!   the read path; and two more: c4 a table of local header offsets (one
//!   extra small read for the data offset), c5 the zip crate's own name
//!   index without a lock, read as c4; c2 and c3 also from several threads;
//! - d. a range read of part of a stored image;
//! - e. reading and inflating the 20 MB JSON entry;
//! - f. building the table from the central directory, against writing it
//!   to a small index file and loading it back.
//!
//! Each measure runs "cold" (the pack file dropped from the system's file
//! cache before every run) where the system lets the program do that, and
//! "warm" (the file in the cache, as just after it was written).
//!
//! Settings, all optional, from environment variables:
//!
//! - `PACK_TRIAL_IMAGES`: number of map images (50000);
//! - `PACK_TRIAL_IMAGE_KB`: average size of one image in KB (20);
//! - `PACK_TRIAL_ZIP64=1`: a pack file over 4 GB with over 65,535 entries
//!   (220,000 images unless `PACK_TRIAL_IMAGES` says otherwise, images made
//!   larger if needed to pass 4 GB);
//! - `PACK_TRIAL_RUNS`: runs of each measure (5);
//! - `PACK_TRIAL_READS`: random reads in one run of c and d (1000);
//! - `PACK_TRIAL_REOPEN_READS`: reads in one run of "opened for each read"
//!   (the same as `PACK_TRIAL_READS`);
//! - `PACK_TRIAL_THREADS`: threads of the parallel read runs (4);
//! - `PACK_TRIAL_DIR`: the folder for the temporary files (the system's
//!   temporary folder); a new folder is made in it and removed at the end;
//! - `PACK_TRIAL_KEEP=1`: keep the temporary files.
//!
//! The results are printed as one table; when `GITHUB_STEP_SUMMARY` is set
//! they are also appended there as Markdown. The program exits with 1 when
//! a read returns the wrong bytes or anything fails.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    collections::HashMap,
    env,
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use zip::{
    read::read_zipfile_from_stream, write::SimpleFileOptions, CompressionMethod, DateTime,
    ZipArchive, ZipWriter,
};

// ---------------------------------------------------------------------------
// Memory: a counting allocator (live bytes, peak and number of allocations).

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);

fn grew(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            grew(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            grew(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            if new_size >= layout.size() {
                grew(new_size - layout.size());
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Memory used by what happens between [`MemoryMark::start`] and
/// [`MemoryMark::held`].
struct MemoryMark {
    live: usize,
    allocations: u64,
}

struct MemoryUse {
    /// Bytes still allocated at the end.
    held: usize,
    /// The most allocated at any time, above the start.
    peak: usize,
    allocations: u64,
}

impl MemoryMark {
    fn start() -> Self {
        let live = LIVE.load(Ordering::Relaxed);
        PEAK.store(live, Ordering::Relaxed);
        Self {
            live,
            allocations: ALLOCATIONS.load(Ordering::Relaxed),
        }
    }

    fn held(&self) -> MemoryUse {
        MemoryUse {
            held: LIVE.load(Ordering::Relaxed).saturating_sub(self.live),
            peak: PEAK.load(Ordering::Relaxed).saturating_sub(self.live),
            allocations: ALLOCATIONS.load(Ordering::Relaxed) - self.allocations,
        }
    }
}

// ---------------------------------------------------------------------------
// Made-up content from a fixed seed.

const SEED: u64 = 0x5EED_A71A_5000_0001;

/// SplitMix64: small, fast, and the same on every platform.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The size of image `index`: between half and one and a half times the
/// average, so the total is about `count * average`.
fn image_size(index: u64, average: u64) -> u64 {
    let mut rng = Rng(SEED ^ index.wrapping_mul(0x0000_0100_0000_01B3));
    let size = (average as f64 * (0.5 + rng.unit())).round() as u64;
    size.max(64)
}

/// The first eight bytes of image `index`, checked on every read.
fn image_tag(index: u64) -> [u8; 8] {
    (index ^ 0x4154_4C41_5354_5231).to_le_bytes()
}

/// The bytes of image `index`.
fn image_bytes(index: u64, size: u64, into: &mut Vec<u8>) {
    into.clear();
    into.extend_from_slice(&image_tag(index));
    let mut rng = Rng(SEED.wrapping_add(index.wrapping_mul(0x9E37_79B9)));
    while (into.len() as u64) < size {
        into.extend_from_slice(&rng.next().to_le_bytes());
    }
    into.truncate(size as usize);
}

/// The map image paths of two layers, level by level, as an export writes
/// them.
fn image_names(count: u64) -> Vec<String> {
    let mut names = Vec::with_capacity(count as usize);
    let layers = [("surface", count - count / 2), ("depths", count / 2)];
    for (layer, wanted) in layers {
        let mut made = 0u64;
        let mut z = 0u32;
        'levels: loop {
            let side = 1u64 << z.min(30);
            for x in 0..side {
                for y in 0..side {
                    if made == wanted {
                        break 'levels;
                    }
                    names.push(format!("tiles/{layer}/{z}/{x}/{y}.webp"));
                    made += 1;
                }
            }
            z += 1;
        }
    }
    names
}

const SYLLABLES: &[&str] = &[
    "ka", "mor", "vel", "tha", "rin", "dor", "esh", "lu", "quen", "bar", "sil", "nor", "ath", "em",
    "gra", "fen", "ol", "zir", "pa", "tu",
];
const PLACES: &[&str] = &[
    "Crossing", "Hollow", "Keep", "Shrine", "Falls", "Ridge", "Camp", "Gate", "Mill", "Pass",
];
const WORDS: &[&str] = &[
    "the", "a", "path", "north", "of", "stone", "bridge", "behind", "old", "tower", "climb",
    "ledge", "chest", "under", "stairs", "near", "river", "found", "after", "door", "lever",
    "east", "wall", "cave", "small", "follow", "light", "west", "garden", "ruins",
];

fn made_up_name(rng: &mut Rng) -> String {
    let mut name = String::new();
    for _ in 0..2 + rng.below(2) {
        name.push_str(SYLLABLES[rng.below(SYLLABLES.len() as u64) as usize]);
    }
    let mut chars = name.chars();
    let first = chars.next().map(|c| c.to_ascii_uppercase()).unwrap_or('A');
    format!(
        "{first}{} {}",
        chars.as_str(),
        PLACES[rng.below(PLACES.len() as u64) as usize]
    )
}

fn sentence(rng: &mut Rng, least: u64, spread: u64) -> String {
    let words = least + rng.below(spread);
    let mut text = String::new();
    for i in 0..words {
        if i > 0 {
            text.push(' ');
        }
        text.push_str(WORDS[rng.below(WORDS.len() as u64) as usize]);
    }
    text.push('.');
    text
}

/// A locations file of about `target` bytes, one location per line.
fn locations_json(target: usize, seed: u64) -> Vec<u8> {
    let mut rng = Rng(seed);
    let mut text = String::with_capacity(target + 4096);
    text.push_str("[\n");
    let mut id = 0u64;
    while text.len() < target {
        if id > 0 {
            text.push_str(",\n");
        }
        let _ = write!(
            text,
            "  {{\"id\":\"loc-{id:06}\",\"mapId\":\"{}\",\"categoryId\":\"cat-{}\",\"name\":\"{}\",\"x\":{:.2},\"y\":{:.2},\"description\":\"{}\",\"tags\":[\"{}\",\"{}\"]}}",
            if rng.below(2) == 0 { "surface" } else { "depths" },
            rng.below(60),
            made_up_name(&mut rng),
            rng.unit() * 8192.0,
            rng.unit() * 8192.0,
            sentence(&mut rng, 6, 14),
            SYLLABLES[rng.below(SYLLABLES.len() as u64) as usize],
            WORDS[rng.below(WORDS.len() as u64) as usize],
        );
        id += 1;
    }
    text.push_str("\n]\n");
    text.into_bytes()
}

/// A guide sections file of about `target` bytes.
fn sections_json(target: usize, seed: u64) -> Vec<u8> {
    let mut rng = Rng(seed);
    let mut text = String::with_capacity(target + 4096);
    text.push_str("[\n");
    let mut id = 0u64;
    while text.len() < target {
        if id > 0 {
            text.push_str(",\n");
        }
        let mut body = String::new();
        for _ in 0..3 + rng.below(6) {
            body.push_str(&sentence(&mut rng, 8, 16));
            body.push(' ');
        }
        let _ = write!(
            text,
            "  {{\"id\":\"sec-{id:06}\",\"guideId\":\"guide-{}\",\"order\":{id},\"title\":\"{}\",\"body\":\"{}\"}}",
            rng.below(40),
            made_up_name(&mut rng),
            body.trim_end(),
        );
        id += 1;
    }
    text.push_str("\n]\n");
    text.into_bytes()
}

// ---------------------------------------------------------------------------
// The made-up pack file.

const HEADER_FILE: &str = "atlaspack.json";
const BIG_JSON: &str = "locations.json";
const BIG_JSON_BYTES: usize = 20 << 20;
const SECOND_JSON: &str = "sections.json";
const SECOND_JSON_BYTES: usize = 10 << 20;

struct Shape {
    images: u64,
    average: u64,
    zip64: bool,
}

struct Pack {
    path: PathBuf,
    names: Vec<String>,
    sizes: Vec<u64>,
    file_len: u64,
    big_json_len: u64,
    entries: usize,
}

fn small_json(name: &str, shape: &Shape) -> Vec<u8> {
    let text = match name {
        "manifest.json" => format!(
            "{{\n  \"schemaVersion\": 2,\n  \"id\": \"trial-isles\",\n  \"title\": \"Trial Isles\",\n  \"packVersion\": \"1.0.0\",\n  \"contents\": {{\"maps\": [{{\"id\": \"isles\", \"layers\": [{{\"id\": \"surface\"}}, {{\"id\": \"depths\"}}]}}]}},\n  \"images\": {{\"files\": {}, \"bytes\": {}}}\n}}\n",
            shape.images,
            shape.images * shape.average
        ),
        "maps.json" => "[{\"id\":\"isles\",\"title\":\"Trial Isles\",\"layers\":[\"surface\",\"depths\"]}]\n".to_owned(),
        "layers.json" => "[{\"id\":\"surface\",\"url\":\"tiles/surface/{z}/{x}/{y}.webp\",\"tileSize\":256},{\"id\":\"depths\",\"url\":\"tiles/depths/{z}/{x}/{y}.webp\",\"tileSize\":256}]\n".to_owned(),
        _ => {
            let mut rng = Rng(SEED ^ name.len() as u64);
            let mut text = String::from("[\n");
            for i in 0..400 {
                if i > 0 {
                    text.push_str(",\n");
                }
                let _ = write!(
                    text,
                    "  {{\"id\":\"cat-{i}\",\"title\":\"{}\",\"note\":\"{}\"}}",
                    made_up_name(&mut rng),
                    sentence(&mut rng, 10, 1)
                );
            }
            text.push_str("\n]\n");
            text
        }
    };
    text.into_bytes()
}

fn header_json(shape: &Shape) -> Vec<u8> {
    format!(
        "{{\n  \"format\": \"atlas-pack-file\",\n  \"version\": 1,\n  \"packId\": \"trial-isles\",\n  \"title\": \"Trial Isles\",\n  \"packVersion\": \"1.0.0\",\n  \"detail\": \"full\",\n  \"exportedAt\": \"2025-01-01T00:00:00Z\",\n  \"exportedBy\": {{\"name\": \"Atlas pack trial\", \"version\": \"0.1.0\", \"platform\": \"{}\"}},\n  \"images\": {{\"files\": {}, \"bytes\": {}}}\n}}\n",
        env::consts::OS,
        shape.images,
        shape.images * shape.average
    )
    .into_bytes()
}

fn zip_error(error: zip::result::ZipError) -> io::Error {
    io::Error::other(error)
}

/// Writes the pack file as the app's `PackWriter` does: JSON deflated,
/// images stored, every entry with the same time and Unix mode.
fn write_pack(path: &Path, shape: &Shape) -> io::Result<Pack> {
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(1 << 20, file));
    let time = DateTime::from_date_and_time(2025, 1, 1, 0, 0, 0).unwrap_or_default();
    let base = SimpleFileOptions::default()
        .last_modified_time(time)
        .unix_permissions(0o644);
    let json = base.compression_method(CompressionMethod::Deflated);
    let stored = base.compression_method(CompressionMethod::Stored);

    let big = locations_json(BIG_JSON_BYTES, SEED ^ 1);
    let big_json_len = big.len() as u64;
    let mut json_entries: Vec<(&str, Vec<u8>)> = vec![(HEADER_FILE, header_json(shape))];
    for name in [
        "manifest.json",
        "maps.json",
        "layers.json",
        "categories.json",
    ] {
        json_entries.push((name, small_json(name, shape)));
    }
    json_entries.push((BIG_JSON, big));
    json_entries.push((SECOND_JSON, sections_json(SECOND_JSON_BYTES, SEED ^ 2)));
    json_entries.push(("offline-tiles/surface.json", small_json("status", shape)));
    json_entries.push(("offline-tiles/depths.json", small_json("status2", shape)));
    let entries = json_entries.len();
    for (name, bytes) in json_entries {
        zip.start_file(name, json).map_err(zip_error)?;
        zip.write_all(&bytes)?;
    }

    let names = image_names(shape.images);
    let mut sizes = Vec::with_capacity(names.len());
    let mut buffer = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let size = image_size(index as u64, shape.average);
        image_bytes(index as u64, size, &mut buffer);
        zip.start_file(name.as_str(), stored).map_err(zip_error)?;
        zip.write_all(&buffer)?;
        sizes.push(size);
    }
    let mut inner = zip.finish().map_err(zip_error)?;
    inner.flush()?;
    let file = inner.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    let file_len = file.metadata()?.len();
    Ok(Pack {
        path: path.to_path_buf(),
        entries: entries + names.len(),
        names,
        sizes,
        file_len,
        big_json_len,
    })
}

// ---------------------------------------------------------------------------
// Platform pieces: positioned reads, and dropping a file from the cache.

#[cfg(unix)]
fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buffer, offset)
}

#[cfg(windows)]
fn read_at(file: &File, mut buffer: &mut [u8], mut offset: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buffer.is_empty() {
        match file.seek_read(buffer, offset) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => {
                buffer = &mut buffer[read..];
                offset += read as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Asks the system to drop a file's pages from its cache. Returns whether
/// the request was made; [`cache_probe`] checks whether it worked.
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
fn drop_from_cache(path: &Path) -> bool {
    use std::os::fd::AsRawFd;
    extern "C" {
        fn posix_fadvise(fd: i32, offset: i64, len: i64, advice: i32) -> i32;
    }
    const POSIX_FADV_DONTNEED: i32 = 4;
    let Ok(file) = File::open(path) else {
        return false;
    };
    // SAFETY: a valid open descriptor; the call only gives advice.
    unsafe { posix_fadvise(file.as_raw_fd(), 0, 0, POSIX_FADV_DONTNEED) == 0 }
}

/// On Windows, opening a file without buffering makes the cache manager
/// flush and purge the file's cached pages when no other handle maps it.
#[cfg(windows)]
fn drop_from_cache(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_NO_BUFFERING: u32 = 0x2000_0000;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_NO_BUFFERING)
        .open(path)
        .is_ok()
}

#[cfg(not(any(all(target_os = "linux", target_pointer_width = "64"), windows)))]
fn drop_from_cache(_path: &Path) -> bool {
    false
}

/// Whether dropping the pack file from the cache works here: a 64 MB part
/// of it read just after dropping must take clearly longer than when cached.
fn cache_probe(pack: &Pack) -> (bool, String) {
    let region = pack.file_len.min(64 << 20);
    let start = (pack.file_len - region) / 2;
    let read_region = || -> io::Result<Duration> {
        let mut file = File::open(&pack.path)?;
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = vec![0u8; 1 << 20];
        let began = Instant::now();
        let mut left = region;
        while left > 0 {
            let take = left.min(buffer.len() as u64) as usize;
            file.read_exact(&mut buffer[..take])?;
            left -= take as u64;
        }
        Ok(began.elapsed())
    };
    if !drop_from_cache(&pack.path) {
        return (
            false,
            "not available on this system; only warm runs were timed".to_owned(),
        );
    }
    let (Ok(cold), Ok(warm)) = (read_region(), read_region()) else {
        return (false, "the probe read failed".to_owned());
    };
    drop_from_cache(&pack.path);
    let works = cold > warm * 2 && cold > Duration::from_millis(2);
    let mb = region as f64 / (1 << 20) as f64;
    let verdict = if works {
        "works"
    } else {
        "did not work; only warm runs were timed"
    };
    (
        works,
        format!(
            "{verdict} ({mb:.0} MB read in {} after dropping, {} when cached)",
            show(cold),
            show(warm)
        ),
    )
}

// ---------------------------------------------------------------------------
// Results.

struct Row {
    measure: String,
    cache: &'static str,
    runs: usize,
    median: Duration,
    slowest: Duration,
    note: String,
}

fn show(duration: Duration) -> String {
    let ms = duration.as_secs_f64() * 1000.0;
    if ms < 10.0 {
        format!("{ms:.3} ms")
    } else if ms < 1000.0 {
        format!("{ms:.1} ms")
    } else {
        format!("{:.2} s", ms / 1000.0)
    }
}

fn megabytes(bytes: u64) -> String {
    let mb = bytes as f64 / (1 << 20) as f64;
    if mb >= 100.0 {
        format!("{mb:.0} MB")
    } else if mb >= 1.0 {
        format!("{mb:.1} MB")
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    }
}

fn median(times: &[Duration]) -> Duration {
    let mut sorted = times.to_vec();
    sorted.sort();
    sorted[sorted.len() / 2]
}

fn slowest(times: &[Duration]) -> Duration {
    times.iter().copied().max().unwrap_or_default()
}

/// Median and slowest of single reads, for a note.
fn per_read(times: &[Duration]) -> String {
    if times.is_empty() {
        return String::new();
    }
    format!(
        "one read: median {}, slowest {}",
        show(median(times)),
        show(slowest(times))
    )
}

const COLD: &str = "cold, dropped from cache";
const WARM: &str = "warm, just written";

struct Trial {
    pack: Pack,
    runs: usize,
    cold_works: bool,
    probe: String,
    rows: Vec<Row>,
}

impl Trial {
    /// The cache states to run in: cold first (when it works), then warm.
    fn states(&self) -> Vec<bool> {
        if self.cold_works {
            vec![true, false]
        } else {
            vec![false]
        }
    }

    /// Runs `work` `runs` times. Cold: `drop` files are dropped from the
    /// cache before each run. Warm: one untimed run first.
    fn time(
        &self,
        cold: bool,
        runs: usize,
        drop: &[&Path],
        mut work: impl FnMut() -> io::Result<()>,
    ) -> io::Result<Vec<Duration>> {
        if !cold {
            work()?;
        }
        let mut times = Vec::with_capacity(runs);
        for _ in 0..runs {
            if cold {
                for path in drop {
                    drop_from_cache(path);
                }
            }
            let began = Instant::now();
            work()?;
            times.push(began.elapsed());
        }
        Ok(times)
    }

    fn add(&mut self, measure: &str, cold: bool, times: &[Duration], note: String) {
        self.rows.push(Row {
            measure: measure.to_owned(),
            cache: if cold { COLD } else { WARM },
            runs: times.len(),
            median: median(times),
            slowest: slowest(times),
            note,
        });
    }
}

fn wrong(what: &str) -> io::Error {
    io::Error::other(format!("wrong bytes: {what}"))
}

/// Checks a read image by its length and first bytes.
fn check_image(index: usize, expected_len: u64, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() as u64 != expected_len || bytes[..8] != image_tag(index as u64) {
        return Err(wrong(&format!("image {index}")));
    }
    Ok(())
}

type Table = HashMap<String, (u64, u64)>;

fn open_archive(path: &Path) -> io::Result<ZipArchive<BufReader<File>>> {
    ZipArchive::new(BufReader::new(File::open(path)?)).map_err(zip_error)
}

/// The table, built from the central directory: every entry's data offset
/// (which needs its local header read) and stored length, in archive order.
fn table_from_archive(
    archive: &mut ZipArchive<BufReader<File>>,
) -> io::Result<Vec<(String, u64, u64)>> {
    let mut entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let file = archive.by_index_raw(index).map_err(zip_error)?;
        let start = file
            .data_start()
            .ok_or_else(|| io::Error::other("no data offset"))?;
        entries.push((
            file.name().map_err(zip_error)?.into_owned(),
            start,
            file.compressed_size(),
        ));
    }
    Ok(entries)
}

const INDEX_MAGIC: &[u8; 8] = b"ATLASIDX";

/// The index file: a magic, a version, the pack file's length and central
/// directory offset (to tell a stale index), then each entry's name, data
/// offset and length.
fn index_bytes(entries: &[(String, u64, u64)], pack_len: u64, directory: u64) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(entries.len() * 64 + 32);
    bytes.extend_from_slice(INDEX_MAGIC);
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&pack_len.to_le_bytes());
    bytes.extend_from_slice(&directory.to_le_bytes());
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (name, offset, len) in entries {
        bytes.extend_from_slice(&(name.len() as u16).to_le_bytes());
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(&offset.to_le_bytes());
        bytes.extend_from_slice(&len.to_le_bytes());
    }
    bytes
}

fn load_index(path: &Path, pack_len: u64, directory: u64) -> io::Result<Table> {
    let bytes = fs::read(path)?;
    let bad = || io::Error::other("damaged index file");
    let mut at = 0usize;
    let mut take = |n: usize| -> io::Result<&[u8]> {
        let part = bytes.get(at..at + n).ok_or_else(bad)?;
        at += n;
        Ok(part)
    };
    let u64_of = |part: &[u8]| u64::from_le_bytes(part.try_into().expect("8 bytes"));
    if take(8)? != INDEX_MAGIC || take(4)? != 1u32.to_le_bytes() {
        return Err(bad());
    }
    if u64_of(take(8)?) != pack_len || u64_of(take(8)?) != directory {
        return Err(io::Error::other("the index is of another pack file"));
    }
    let count = u32::from_le_bytes(take(4)?.try_into().expect("4 bytes")) as usize;
    let mut table = Table::with_capacity(count);
    for _ in 0..count {
        let len = u16::from_le_bytes(take(2)?.try_into().expect("2 bytes")) as usize;
        let name = std::str::from_utf8(take(len)?)
            .map_err(|_| bad())?
            .to_owned();
        let offset = u64_of(take(8)?);
        let size = u64_of(take(8)?);
        table.insert(name, (offset, size));
    }
    Ok(table)
}

fn read_by_table(file: &File, table: &Table, name: &str) -> io::Result<Vec<u8>> {
    let &(offset, len) = table.get(name).ok_or(io::ErrorKind::NotFound)?;
    let mut bytes = vec![0u8; len as usize];
    read_at(file, &mut bytes, offset)?;
    Ok(bytes)
}

/// Reads the 30-byte local header at `header` for the data offset (after
/// the name and extra field), then `len` bytes of data.
fn read_after_local_header(file: &File, header: u64, len: u64) -> io::Result<Vec<u8>> {
    let mut local = [0u8; 30];
    read_at(file, &mut local, header)?;
    if local[..4] != [0x50, 0x4B, 0x03, 0x04] {
        return Err(wrong("local header"));
    }
    let name_len = u64::from(u16::from_le_bytes([local[26], local[27]]));
    let extra_len = u64::from(u16::from_le_bytes([local[28], local[29]]));
    let mut bytes = vec![0u8; len as usize];
    read_at(file, &mut bytes, header + 30 + name_len + extra_len)?;
    Ok(bytes)
}

/// A read through a table of local header offsets: the 30-byte local
/// header gives the data offset (after the name and extra field), then the
/// data is read.
fn read_by_local_header(file: &File, headers: &Table, name: &str) -> io::Result<Vec<u8>> {
    let &(header, len) = headers.get(name).ok_or(io::ErrorKind::NotFound)?;
    read_after_local_header(file, header, len)
}

/// [`read_by_local_header`] with the local header offset from an open
/// archive's own name index, which needs no lock to look up.
fn read_by_zip_index(
    file: &File,
    archive: &ZipArchive<BufReader<File>>,
    name: &str,
) -> io::Result<Vec<u8>> {
    let index = archive
        .index_for_name(name)
        .ok_or(io::ErrorKind::NotFound)?;
    let entry = archive.by_index_data(index).map_err(zip_error)?;
    if entry.compression() != CompressionMethod::Stored {
        return Err(wrong("not stored"));
    }
    let header = entry.header_start();
    let len = entry.compressed_size();
    read_after_local_header(file, header, len)
}

fn read_by_archive(archive: &mut ZipArchive<BufReader<File>>, name: &str) -> io::Result<Vec<u8>> {
    let mut file = archive.by_name(name).map_err(zip_error)?;
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The part of an image a range read asks for: from a quarter in, up to
/// 4 KB.
fn range_of(size: u64) -> (u64, u64) {
    let start = size / 4;
    (start, (size - start).min(4096))
}

fn run(trial: &mut Trial, reads: usize, reopen_reads: usize, threads: usize) -> io::Result<()> {
    let path = trial.pack.path.clone();
    let runs = trial.runs;
    let count = trial.pack.names.len();
    let mut rng = Rng(SEED ^ 0xC0FF_EE00);
    let picks: Vec<usize> = (0..reads.max(reopen_reads))
        .map(|_| rng.below(count as u64) as usize)
        .collect();
    let names = trial.pack.names.clone();
    let sizes = trial.pack.sizes.clone();
    let p: &[&Path] = &[&path];

    // A handle kept open throughout, as a reader in the app would keep one,
    // opened before the cache probe so that the probe sees the file as the
    // measures do (on Windows, open handles can keep pages cached).
    let file = File::open(&path)?;
    let (cold_works, probe) = cache_probe(&trial.pack);
    trial.cold_works = cold_works;
    trial.probe = probe;

    // a. The description at the front, read in order like the app's
    //    `read_header_from`, without the central directory.
    for cold in trial.states() {
        let times = trial.time(cold, runs, p, || {
            let mut reader = BufReader::new(File::open(&path)?);
            let mut entry = read_zipfile_from_stream(&mut reader)
                .map_err(zip_error)?
                .ok_or_else(|| wrong("no first entry"))?;
            if entry.name().ok().as_deref() != Some(HEADER_FILE) {
                return Err(wrong("first entry"));
            }
            let mut text = String::new();
            entry.read_to_string(&mut text)?;
            if !text.contains("atlas-pack-file") {
                return Err(wrong("description"));
            }
            Ok(())
        })?;
        trial.add(
            "a. Read the description at the front (no central directory)",
            cold,
            &times,
            String::new(),
        );
    }

    // b. Opening the archive: reading the central directory.
    let mark = MemoryMark::start();
    let archive = open_archive(&path)?;
    let memory = mark.held();
    let directory = archive.central_directory_start();
    let entries = archive.len();
    drop(archive);
    let directory_len = trial.pack.file_len - directory;
    for cold in trial.states() {
        let times = trial.time(cold, runs, p, || {
            let archive = open_archive(&path)?;
            if archive.len() != entries {
                return Err(wrong("entry count"));
            }
            Ok(())
        })?;
        trial.add(
            "b. Open the archive with the zip crate (read the central directory)",
            cold,
            &times,
            format!(
                "{entries} entries, central directory {}; the open archive holds {} in {} allocations (peak {})",
                megabytes(directory_len),
                megabytes(memory.held as u64),
                memory.allocations,
                megabytes(memory.peak as u64)
            ),
        );
    }

    // The table for the reads below, built once (timed in f).
    let mut archive = open_archive(&path)?;
    let ordered = table_from_archive(&mut archive)?;
    let mark = MemoryMark::start();
    let table: Table = ordered
        .iter()
        .map(|(name, offset, len)| (name.clone(), (*offset, *len)))
        .collect();
    let table_memory = mark.held();
    // The table of local header offsets from the central directory alone
    // (timed in f2), for c4.
    let mut headers = Table::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive.by_index_data(index).map_err(zip_error)?;
        headers.insert(
            entry.name().map_err(zip_error)?.into_owned(),
            (entry.header_start(), entry.compressed_size()),
        );
    }
    let plain_headers = ordered
        .iter()
        .filter(|(name, start, _)| {
            headers
                .get(name)
                .is_some_and(|&(header, _)| header + 30 + name.len() as u64 == *start)
        })
        .count();
    let shared = Mutex::new(archive);

    // c. Random image reads by name, three ways.
    let reopen_picks = &picks[..reopen_reads];
    for cold in trial.states() {
        let mut each = Vec::new();
        let times = trial.time(cold, runs.min(3), p, || {
            for &index in reopen_picks {
                let began = Instant::now();
                let mut archive = open_archive(&path)?;
                let bytes = read_by_archive(&mut archive, &names[index])?;
                each.push(began.elapsed());
                check_image(index, sizes[index], &bytes)?;
            }
            Ok(())
        })?;
        trial.add(
            &format!("c1. {reopen_reads} image reads, archive opened for each read"),
            cold,
            &times,
            per_read(&each),
        );
    }
    let picks_c = &picks[..reads];
    for cold in trial.states() {
        let mut each = Vec::new();
        let times = trial.time(cold, runs, p, || {
            for &index in picks_c {
                let began = Instant::now();
                let bytes = {
                    let mut archive = shared.lock().unwrap_or_else(|e| e.into_inner());
                    read_by_archive(&mut archive, &names[index])?
                };
                each.push(began.elapsed());
                check_image(index, sizes[index], &bytes)?;
            }
            Ok(())
        })?;
        trial.add(
            &format!("c2. {reads} image reads, one archive kept open behind a lock"),
            cold,
            &times,
            per_read(&each),
        );
    }
    for cold in trial.states() {
        let mut each = Vec::new();
        let times = trial.time(cold, runs, p, || {
            for &index in picks_c {
                let began = Instant::now();
                let bytes = read_by_table(&file, &table, &names[index])?;
                each.push(began.elapsed());
                check_image(index, sizes[index], &bytes)?;
            }
            Ok(())
        })?;
        trial.add(
            &format!("c3. {reads} image reads, table and positioned reads"),
            cold,
            &times,
            per_read(&each),
        );
    }
    for cold in trial.states() {
        let mut each = Vec::new();
        let times = trial.time(cold, runs, p, || {
            for &index in picks_c {
                let began = Instant::now();
                let bytes = read_by_local_header(&file, &headers, &names[index])?;
                each.push(began.elapsed());
                check_image(index, sizes[index], &bytes)?;
            }
            Ok(())
        })?;
        trial.add(
            &format!(
                "c4. {reads} image reads, table of local header offsets (two positioned reads)"
            ),
            cold,
            &times,
            per_read(&each),
        );
    }
    // c5. No table of our own: the zip crate's name index of an archive
    //     shared read-only (no lock), then c4's two positioned reads.
    let lookup = open_archive(&path)?;
    for cold in trial.states() {
        let mut each = Vec::new();
        let times = trial.time(cold, runs, p, || {
            for &index in picks_c {
                let began = Instant::now();
                let bytes = read_by_zip_index(&file, &lookup, &names[index])?;
                each.push(began.elapsed());
                check_image(index, sizes[index], &bytes)?;
            }
            Ok(())
        })?;
        trial.add(
            &format!(
                "c5. {reads} image reads, the zip crate's name index without a lock, then as c4"
            ),
            cold,
            &times,
            per_read(&each),
        );
    }
    drop(lookup);
    // The same reads from several threads at once, as the webview asks for
    // many map images together.
    let chunk = reads.div_ceil(threads.max(1));
    for cold in trial.states() {
        let times = trial.time(cold, runs, p, || {
            thread::scope(|scope| {
                let workers: Vec<_> = picks_c
                    .chunks(chunk)
                    .map(|part| {
                        let (shared, names, sizes) = (&shared, &names, &sizes);
                        scope.spawn(move || -> io::Result<()> {
                            for &index in part {
                                let bytes = {
                                    let mut archive =
                                        shared.lock().unwrap_or_else(|e| e.into_inner());
                                    read_by_archive(&mut archive, &names[index])?
                                };
                                check_image(index, sizes[index], &bytes)?;
                            }
                            Ok(())
                        })
                    })
                    .collect();
                workers
                    .into_iter()
                    .try_for_each(|worker| worker.join().expect("reader thread"))
            })
        })?;
        trial.add(
            &format!("c2t. Same as c2 from {threads} threads"),
            cold,
            &times,
            String::new(),
        );
    }
    for cold in trial.states() {
        let times = trial.time(cold, runs, p, || {
            thread::scope(|scope| {
                let workers: Vec<_> = picks_c
                    .chunks(chunk)
                    .map(|part| {
                        let (file, table, names, sizes) = (&file, &table, &names, &sizes);
                        scope.spawn(move || -> io::Result<()> {
                            for &index in part {
                                let bytes = read_by_table(file, table, &names[index])?;
                                check_image(index, sizes[index], &bytes)?;
                            }
                            Ok(())
                        })
                    })
                    .collect();
                workers
                    .into_iter()
                    .try_for_each(|worker| worker.join().expect("reader thread"))
            })
        })?;
        trial.add(
            &format!("c3t. Same as c3 from {threads} threads (one shared file handle)"),
            cold,
            &times,
            String::new(),
        );
    }

    // d. Range reads of part of a stored image.
    for cold in trial.states() {
        let mut each = Vec::new();
        let times = trial.time(cold, runs, p, || {
            for &index in picks_c {
                let began = Instant::now();
                let &(offset, len) = table.get(&names[index]).ok_or(io::ErrorKind::NotFound)?;
                let (start, count) = range_of(len);
                let mut bytes = vec![0u8; count as usize];
                read_at(&file, &mut bytes, offset + start)?;
                each.push(began.elapsed());
            }
            Ok(())
        })?;
        trial.add(
            &format!("d1. {reads} range reads (4 KB of an image), table"),
            cold,
            &times,
            per_read(&each),
        );
    }
    for cold in trial.states() {
        let mut each = Vec::new();
        let times = trial.time(cold, runs, p, || {
            for &index in picks_c {
                let began = Instant::now();
                let mut archive = shared.lock().unwrap_or_else(|e| e.into_inner());
                let mut entry = archive.by_name_seek(&names[index]).map_err(zip_error)?;
                let (start, count) = range_of(sizes[index]);
                entry.seek(SeekFrom::Start(start))?;
                let mut bytes = vec![0u8; count as usize];
                entry.read_exact(&mut bytes)?;
                each.push(began.elapsed());
            }
            Ok(())
        })?;
        trial.add(
            &format!("d2. {reads} range reads (4 KB of an image), archive kept open"),
            cold,
            &times,
            per_read(&each),
        );
    }

    // e. Reading and inflating the 20 MB JSON entry.
    let big_len = trial.pack.big_json_len;
    let packed_len = {
        let mut archive = shared.lock().unwrap_or_else(|e| e.into_inner());
        let entry = archive.by_name(BIG_JSON).map_err(zip_error)?;
        entry.compressed_size()
    };
    for cold in trial.states() {
        let times = trial.time(cold, runs, p, || {
            let mut archive = shared.lock().unwrap_or_else(|e| e.into_inner());
            let mut entry = archive.by_name(BIG_JSON).map_err(zip_error)?;
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes)?;
            if bytes.len() as u64 != big_len || !bytes.starts_with(b"[\n") {
                return Err(wrong(BIG_JSON));
            }
            Ok(())
        })?;
        let rate = big_len as f64 / (1 << 20) as f64 / median(&times).as_secs_f64();
        trial.add(
            "e. Read and inflate the 20 MB JSON entry",
            cold,
            &times,
            format!(
                "{} from {} deflated, {rate:.0} MB/s",
                megabytes(big_len),
                megabytes(packed_len)
            ),
        );
    }

    // f. The table: from the central directory, or from an index file.
    for cold in trial.states() {
        let times = trial.time(cold, runs, p, || {
            let mut archive = open_archive(&path)?;
            let built = table_from_archive(&mut archive)?;
            let table: Table = built
                .into_iter()
                .map(|(name, offset, len)| (name, (offset, len)))
                .collect();
            if table.len() != entries {
                return Err(wrong("table"));
            }
            Ok(())
        })?;
        trial.add(
            "f1. Build the table from the central directory (reads every local header)",
            cold,
            &times,
            format!(
                "the table holds {} in {} allocations",
                megabytes(table_memory.held as u64),
                table_memory.allocations
            ),
        );
    }
    for cold in trial.states() {
        let times = trial.time(cold, runs, p, || {
            let archive = open_archive(&path)?;
            let mut table = HashMap::with_capacity(archive.len());
            for index in 0..archive.len() {
                let entry = archive.by_index_data(index).map_err(zip_error)?;
                table.insert(
                    entry.name().map_err(zip_error)?.into_owned(),
                    (entry.header_start(), entry.compressed_size()),
                );
            }
            if table.len() != entries {
                return Err(wrong("table"));
            }
            Ok(())
        })?;
        trial.add(
            "f2. Build a table of local header offsets from the central directory alone",
            cold,
            &times,
            format!(
                "the table c4 reads with; data right after the local header and name in {plain_headers} of {entries} entries"
            ),
        );
    }
    let index_path = path.with_extension("atlasindex");
    let index = index_bytes(&ordered, trial.pack.file_len, directory);
    let times = trial.time(false, runs, &[], || fs::write(&index_path, &index))?;
    trial.add(
        "f3. Write the table to an index file",
        false,
        &times,
        format!("index file {}", megabytes(index.len() as u64)),
    );
    if let Some(row) = trial.rows.last_mut() {
        row.cache = "not applicable, a write";
    }
    let pack_len = trial.pack.file_len;
    for cold in trial.states() {
        let times = trial.time(cold, runs, &[&index_path], || {
            let loaded = load_index(&index_path, pack_len, directory)?;
            if loaded.len() != entries || loaded.get(&names[0]) != table.get(&names[0]) {
                return Err(wrong("index file"));
            }
            Ok(())
        })?;
        trial.add(
            "f4. Load the table from the index file",
            cold,
            &times,
            format!("index file {}", megabytes(index.len() as u64)),
        );
    }
    fs::remove_file(&index_path)?;

    // Every byte of a sample of images and of their ranges, both ways,
    // outside the timings.
    let mut expected = Vec::new();
    for &index in picks.iter().take(50) {
        image_bytes(index as u64, sizes[index], &mut expected);
        if read_by_table(&file, &table, &names[index])? != expected {
            return Err(wrong(&format!("image {index} in full")));
        }
        let (start, count) = range_of(sizes[index]);
        let part = &expected[start as usize..(start + count) as usize];
        let &(offset, _) = table.get(&names[index]).ok_or(io::ErrorKind::NotFound)?;
        let mut bytes = vec![0u8; count as usize];
        read_at(&file, &mut bytes, offset + start)?;
        if bytes != part {
            return Err(wrong(&format!("range of image {index}, table")));
        }
        let mut archive = shared.lock().unwrap_or_else(|e| e.into_inner());
        let mut entry = archive.by_name_seek(&names[index]).map_err(zip_error)?;
        entry.seek(SeekFrom::Start(start))?;
        entry.read_exact(&mut bytes)?;
        if bytes != part {
            return Err(wrong(&format!("range of image {index}, archive")));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings, output and main.

fn setting(name: &str, default: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(text) if !text.trim().is_empty() => text
            .trim()
            .replace([',', '_'], "")
            .parse::<u64>()
            .map_err(|_| format!("{name} must be a whole number, not {text:?}")),
        _ => Ok(default),
    }
}

fn is_on(name: &str) -> bool {
    env::var(name).is_ok_and(|value| matches!(value.trim(), "1" | "true" | "yes"))
}

const COLUMNS: [&str; 6] = ["Measure", "Cache", "Runs", "Median", "Slowest", "Notes"];

fn cells(row: &Row) -> [String; 6] {
    [
        row.measure.clone(),
        row.cache.to_owned(),
        row.runs.to_string(),
        show(row.median),
        show(row.slowest),
        row.note.clone(),
    ]
}

fn plain_table(rows: &[Row]) -> String {
    let all: Vec<[String; 6]> = rows.iter().map(cells).collect();
    let mut widths = COLUMNS.map(str::len);
    for row in &all {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.len());
        }
    }
    let line = |cells: &[String]| -> String {
        let mut text = String::new();
        for (i, cell) in cells.iter().enumerate() {
            if i == cells.len() - 1 {
                text.push_str(cell);
            } else if (2..=4).contains(&i) {
                let _ = write!(text, "{cell:>width$}  ", width = widths[i]);
            } else {
                let _ = write!(text, "{cell:<width$}  ", width = widths[i]);
            }
        }
        text.trim_end().to_owned() + "\n"
    };
    let mut text = line(&COLUMNS.map(str::to_owned));
    text.push_str(&line(&widths.map(|w| "-".repeat(w))));
    for row in &all {
        text.push_str(&line(row));
    }
    text
}

fn markdown_table(rows: &[Row]) -> String {
    let mut text = format!("| {} |\n", COLUMNS.join(" | "));
    text.push_str("| --- | --- | ---: | ---: | ---: | --- |\n");
    for row in rows {
        text.push_str(&format!("| {} |\n", cells(row).join(" | ")));
    }
    text
}

fn platform() -> String {
    format!("{} {}", env::consts::OS, env::consts::ARCH)
}

fn main() -> ExitCode {
    match main_result() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("Pack trial failed: {message}");
            ExitCode::FAILURE
        }
    }
}

fn main_result() -> Result<(), String> {
    let zip64 = is_on("PACK_TRIAL_ZIP64");
    let mut shape = Shape {
        images: setting("PACK_TRIAL_IMAGES", if zip64 { 220_000 } else { 50_000 })?,
        average: setting("PACK_TRIAL_IMAGE_KB", 20)? * 1024,
        zip64,
    };
    if shape.images == 0 || shape.average == 0 {
        return Err("PACK_TRIAL_IMAGES and PACK_TRIAL_IMAGE_KB must be above 0".to_owned());
    }
    // Past 4 GB with room to spare, whatever the image count.
    let zip64_bytes = (4u64 << 30) + (256 << 20);
    if shape.zip64 && shape.images * shape.average < zip64_bytes {
        shape.average = zip64_bytes.div_ceil(shape.images);
    }
    let runs = setting("PACK_TRIAL_RUNS", 5)?.max(1) as usize;
    let reads = setting("PACK_TRIAL_READS", 1000)?.max(1) as usize;
    let reopen_reads =
        setting("PACK_TRIAL_REOPEN_READS", reads as u64)?.clamp(1, reads as u64) as usize;
    let threads = setting("PACK_TRIAL_THREADS", 4)?.max(1) as usize;

    let base = env::var_os("PACK_TRIAL_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let folder = base.join(format!("atlas-pack-trial-{}", std::process::id()));
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Could not make {}: {error}", folder.display()))?;
    let path = folder.join("trial-isles.atlaspack");

    println!(
        "Pack trial on {}: writing {} images of about {} KB ({}) to {}",
        platform(),
        shape.images,
        shape.average / 1024,
        megabytes(shape.images * shape.average),
        path.display()
    );
    let result = (|| -> Result<String, String> {
        let began = Instant::now();
        let pack = write_pack(&path, &shape)
            .map_err(|error| format!("Could not write the pack file: {error}"))?;
        let written_in = began.elapsed();
        let over_4gb = pack.file_len > u32::MAX as u64;
        let mut lines = vec![
            format!("Platform: {}", platform()),
            format!(
                "Pack file: {} images of about {} KB, {} entries in all, {} on disk, written in {}",
                pack.names.len(),
                shape.average / 1024,
                pack.entries,
                megabytes(pack.file_len),
                show(written_in)
            ),
            format!(
                "ZIP64: {}",
                if over_4gb || pack.entries > 65_535 {
                    format!(
                        "yes (over 4 GB: {}, over 65,535 entries: {})",
                        if over_4gb { "yes" } else { "no" },
                        if pack.entries > 65_535 { "yes" } else { "no" }
                    )
                } else {
                    "not needed".to_owned()
                }
            ),
            format!(
                "Runs: {runs} of each measure (3 at most for c1); {reads} random reads in each run of c and d, {reopen_reads} in c1"
            ),
        ];
        let mut trial = Trial {
            pack,
            runs,
            cold_works: false,
            probe: String::new(),
            rows: Vec::new(),
        };
        run(&mut trial, reads, reopen_reads, threads)
            .map_err(|error| format!("A measure failed: {error}"))?;
        lines.insert(
            3,
            format!("Dropping the file from the cache: {}", trial.probe),
        );
        lines.push("All reads returned the expected bytes.".to_owned());

        println!();
        for line in &lines {
            println!("{line}");
        }
        println!();
        print!("{}", plain_table(&trial.rows));

        let mut markdown = format!("### Pack file timing trial on {}\n\n", platform());
        for line in &lines {
            markdown.push_str(&format!("- {line}\n"));
        }
        markdown.push('\n');
        markdown.push_str(&markdown_table(&trial.rows));
        markdown.push('\n');
        Ok(markdown)
    })();

    if is_on("PACK_TRIAL_KEEP") {
        println!("Kept the files in {}", folder.display());
    } else if let Err(error) = fs::remove_dir_all(&folder) {
        eprintln!("Could not remove {}: {error}", folder.display());
    }
    let markdown = result?;
    if let Some(summary) = env::var_os("GITHUB_STEP_SUMMARY").filter(|s| !s.is_empty()) {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&summary)
            .and_then(|mut file| file.write_all(markdown.as_bytes()))
            .map_err(|error| format!("Could not write the step summary: {error}"))?;
    }
    Ok(())
}
