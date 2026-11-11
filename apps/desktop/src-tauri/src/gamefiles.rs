//! The Witcher 3's own files, read-only, for the table of its map pins that
//! the web app builds (in `@atlas/saves`). Only file access is here: the
//! web app parses what it is given and keeps the table on the device.
//!
//! The shell never writes, renames or deletes anything in the game folder,
//! and sends nothing anywhere. It reads only:
//!
//! - the folder the person chose, after checking that it is The Witcher
//!   3's: it has `content\content0\bundles`, and `bin\x64\witcher3.exe` or
//!   `bin\x64_dx12\witcher3.exe`, whose size and time make the stamp that
//!   tells a patched game from the one a table was read from;
//! - the header and table of contents of each `.bundle` file under
//!   `content` and `dlc` (never through a link, at most 8 folders deep);
//! - from those bundles, only the entries the table needs, each at most
//!   64 MB: `.w2em` (a world's map pins), `.w2am` (the game's worlds) and
//!   `.reddlc` (a DLC's definition, which says which pin file belongs to
//!   which world). `.w2qm` entries (quest pins) are counted, not read.
//!
//! The folder is remembered in `<app data>/gamefiles.json`.
//!
//! A bundle (facts from public references; Atlas has not seen the game's
//! files): `POTATO70`, then u32 bundle size, u32, u32 size of the table
//! of contents, padding to 0x20; the table of contents from 0x20, an entry
//! of 0x140 bytes per file, starting with its path (0x100 bytes, Latin-1,
//! NUL-padded) and a 16-byte hash. Where the other fields are differs
//! between references, so both layouts are read and the one whose entries
//! make sense is used, bundle by bundle:
//!
//! - layout 1 (WolvenKit 7): u32 at 0x114 size, 0x118 packed size, 0x11C
//!   offset, 0x13C compression;
//! - layout 2 (the Witcher 3 Missables Tracker, read on patch 4.x files):
//!   u32 at 0x110 offset, 0x118 size, 0x11C packed size, 0x124
//!   compression.
//!
//! Compressions: 0 none, 1 zlib, 2 Snappy, 3 Doboz, 4 LZ4, 5 LZ4 HC (read
//! as LZ4). Atlas reads all but Doboz. Every entry read must unpack to its
//! listed size and start with `CR2W`, or it is refused with a reason.

use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{Instant, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, Manager as _, Runtime, State, WebviewWindow};

use crate::{
    activity::{self, Area},
    commands::{blocking, pick_folder_at},
};

/// The game whose files the shell reads, by the web app's save reader id.
pub const GAME: &str = "witcher3";
const STORE_FILE: &str = "gamefiles.json";
const MAGIC: &[u8; 8] = b"POTATO70";
const HEADER_BYTES: u64 = 0x20;
const ENTRY_BYTES: usize = 0x140;
const NAME_BYTES: usize = 0x100;
/// No table of contents of the game is this large.
pub const MAX_TOC_BYTES: u64 = 64 << 20;
/// No resource the table needs is this large.
pub const MAX_ENTRY_BYTES: u32 = 64 << 20;
const MAX_BUNDLES: usize = 4000;
const MAX_DEPTH: usize = 8;
/// Entries read for the table, by extension.
const READ: &[&str] = &["w2em", "w2am", "reddlc"];
/// Entries only counted.
const COUNTED: &[&str] = &["w2qm"];
/// The folders under `bin` with the game's executable.
const EXECUTABLES: &[&str] = &["x64", "x64_dx12"];

// ---------------------------------------------------------------------------
// The game folder

/// A child of a folder by name, regardless of case (a copied game may
/// differ from the shipped names), never a link.
fn child(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(name);
    if fs::symlink_metadata(&exact).is_ok_and(|meta| !meta.file_type().is_symlink()) {
        return Some(exact);
    }
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
                && entry.file_type().is_ok_and(|kind| !kind.is_symlink())
        })
        .map(|entry| entry.path())
}

fn descend(dir: &Path, parts: &[&str]) -> Option<PathBuf> {
    parts
        .iter()
        .try_fold(dir.to_path_buf(), |path, part| child(&path, part))
}

fn display_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.to_string_lossy().into_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// Checks that a folder is The Witcher 3's. Gives the stamp of its
/// executables (size and time), which a patch changes.
pub fn check_folder(folder: &Path) -> Result<String, String> {
    if !folder.is_dir() {
        return Err(format!("{} cannot be found.", folder.display()));
    }
    let not_the_game = || {
        format!(
            "{} is not The Witcher 3’s game folder: Atlas looks for content\\content0\\bundles and bin\\x64\\witcher3.exe in it. Choose the folder the game is installed in.",
            display_name(folder)
        )
    };
    descend(folder, &["content", "content0", "bundles"])
        .filter(|bundles| bundles.is_dir())
        .ok_or_else(not_the_game)?;
    let stamps: Vec<String> = EXECUTABLES
        .iter()
        .filter_map(|dir| {
            let exe = descend(folder, &["bin", dir, "witcher3.exe"])?;
            let meta = fs::metadata(exe).ok().filter(fs::Metadata::is_file)?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_secs());
            Some(format!("{dir}:{}:{modified}", meta.len()))
        })
        .collect();
    if stamps.is_empty() {
        return Err(not_the_game());
    }
    Ok(stamps.join("+"))
}

/// The library folders a Steam `libraryfolders.vdf` lists.
pub fn steam_libraries(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|line| {
            // `"path"		"D:\\SteamLibrary"`
            let parts: Vec<&str> = line.split('"').collect();
            (parts.len() >= 5 && parts[1].eq_ignore_ascii_case("path"))
                .then(|| PathBuf::from(parts[3].replace("\\\\", "\\")))
        })
        .collect()
}

/// Where the game is most likely installed, in this order: Steam's
/// libraries, GOG Galaxy, GOG's offline installer, the Epic Games store.
/// Only folders are named here; nothing is read but Steam's list of its
/// libraries.
pub fn likely_folders(
    home: Option<&Path>,
    program_files: &[PathBuf],
    system_drive: Option<&Path>,
) -> Vec<PathBuf> {
    let mut steam: Vec<PathBuf> = program_files.iter().map(|pf| pf.join("Steam")).collect();
    if let Some(home) = home {
        steam.push(home.join(".steam").join("steam"));
        steam.push(home.join(".local").join("share").join("Steam"));
        steam.push(
            [
                ".var",
                "app",
                "com.valvesoftware.Steam",
                ".local",
                "share",
                "Steam",
            ]
            .iter()
            .fold(home.to_path_buf(), |path, part| path.join(part)),
        );
        steam.push(
            home.join("Library")
                .join("Application Support")
                .join("Steam"),
        );
    }
    let mut libraries = Vec::new();
    for root in &steam {
        libraries.push(root.clone());
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        let small = fs::metadata(&vdf).is_ok_and(|meta| meta.len() < 1 << 20);
        if let Some(text) = small.then(|| fs::read_to_string(&vdf).ok()).flatten() {
            libraries.extend(steam_libraries(&text));
        }
    }
    let mut found: Vec<PathBuf> = libraries
        .iter()
        .map(|library| {
            library
                .join("steamapps")
                .join("common")
                .join("The Witcher 3")
        })
        .collect();
    const GOG: &[&str] = &[
        "The Witcher 3 Wild Hunt GOTY",
        "The Witcher 3 Wild Hunt",
        "The Witcher 3",
    ];
    for pf in program_files {
        found.extend(
            GOG.iter()
                .map(|name| pf.join("GOG Galaxy").join("Games").join(name)),
        );
    }
    if let Some(drive) = system_drive {
        found.extend(GOG.iter().map(|name| drive.join("GOG Games").join(name)));
    }
    for pf in program_files {
        found.extend(
            ["TheWitcher3", "TheWitcher3WildHunt"]
                .iter()
                .map(|name| pf.join("Epic Games").join(name)),
        );
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|path| seen.insert(path.clone()));
    found
}

// ---------------------------------------------------------------------------
// Bundles

/// The `.bundle` files under `content` and `dlc`, sorted, never through a link.
pub fn find_bundles(folder: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
        if depth > MAX_DEPTH || found.len() >= MAX_BUNDLES {
            return;
        }
        let Ok(read) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            // The entry's own type: a link is neither a folder nor a file here.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                walk(&path, depth + 1, found);
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("bundle"))
                && found.len() < MAX_BUNDLES
            {
                found.push(path);
            }
        }
    }
    let mut found = Vec::new();
    for root in ["content", "dlc"] {
        if let Some(dir) = child(folder, root) {
            walk(&dir, 0, &mut found);
        }
    }
    found.sort();
    found
}

/// Which bundle wins when several hold the same path: a DLC over a patch
/// over content, and a higher number over a lower one (`content12` over
/// `content0`). GUESSWORK until checked on the game: the game's own order.
pub fn bundle_rank(folder: &Path, bundle: &Path) -> (u8, u32, String) {
    let relative = bundle.strip_prefix(folder).unwrap_or(bundle);
    let parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let top = parts.first().map_or("", String::as_str);
    let second = parts.get(1).map_or("", String::as_str);
    let number = |prefix: &str| {
        second
            .strip_prefix(prefix)
            .and_then(|n| n.parse::<u32>().ok())
    };
    if top == "dlc" {
        (2, 0, second.to_owned())
    } else if let Some(n) = number("patch") {
        (1, n, String::new())
    } else {
        (0, number("content").unwrap_or(0), String::new())
    }
}

/// Where the fields of a table of contents entry are (see the module).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TocLayout {
    One,
    Two,
}

impl TocLayout {
    const ALL: [TocLayout; 2] = [TocLayout::One, TocLayout::Two];

    fn label(self) -> &'static str {
        match self {
            TocLayout::One => "1",
            TocLayout::Two => "2",
        }
    }

    fn entry(self, raw: &[u8], path: String) -> TocEntry {
        let at = |offset: usize| {
            u32::from_le_bytes([
                raw[offset],
                raw[offset + 1],
                raw[offset + 2],
                raw[offset + 3],
            ])
        };
        match self {
            TocLayout::One => TocEntry {
                path,
                size: at(0x114),
                packed: at(0x118),
                offset: at(0x11C),
                compression: at(0x13C),
            },
            TocLayout::Two => TocEntry {
                path,
                offset: at(0x110),
                size: at(0x118),
                packed: at(0x11C),
                compression: at(0x124),
            },
        }
    }
}

/// A file in a bundle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TocEntry {
    /// The game's path, such as `game\hub_pins\novigrad.w2em`.
    pub path: String,
    pub size: u32,
    pub packed: u32,
    pub offset: u32,
    pub compression: u32,
}

impl TocEntry {
    /// Whether the entry's fields make sense for a bundle of `length` bytes
    /// whose data starts at `data_start`.
    fn plausible(&self, data_start: u64, length: u64) -> bool {
        let offset = u64::from(self.offset);
        self.packed > 0
            && self.size > 0
            && self.compression <= 5
            && offset >= data_start
            && offset + u64::from(self.packed) <= length
            && (self.compression != 0 || self.size == self.packed)
    }
}

/// What a bundle's table of contents gave.
#[derive(Debug, Default)]
pub struct Toc {
    pub entries: usize,
    /// The layout whose entries made sense; `None` when neither did.
    pub layout: Option<TocLayout>,
    /// The entries asked for, that lie inside the bundle.
    pub wanted: Vec<TocEntry>,
    /// Entries asked for whose data would lie outside the bundle.
    pub outside: usize,
}

fn extension_of(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Reads a bundle's table of contents and keeps the entries `wanted` takes.
pub fn read_toc(bundle: &Path, wanted: impl Fn(&str) -> bool) -> Result<Toc, String> {
    let mut file = File::open(bundle).map_err(|error| format!("cannot be opened: {error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0u8; HEADER_BYTES as usize];
    file.read_exact(&mut header)
        .map_err(|_| "is too short to be a bundle".to_owned())?;
    if &header[..8] != MAGIC {
        return Err("is not a bundle Atlas knows (it does not start with POTATO70)".to_owned());
    }
    let toc_bytes = u64::from(u32::from_le_bytes([
        header[16], header[17], header[18], header[19],
    ]));
    if toc_bytes > MAX_TOC_BYTES || HEADER_BYTES + toc_bytes > length {
        return Err("has a table of contents that does not fit in it".to_owned());
    }
    let mut toc = vec![0u8; usize::try_from(toc_bytes).unwrap_or(0)];
    file.read_exact(&mut toc)
        .map_err(|error| format!("could not be read: {error}"))?;
    let data_start = HEADER_BYTES + toc_bytes;
    let mut result = Toc::default();
    let mut plausible = [0usize; 2];
    let mut chosen: Vec<(String, &[u8])> = Vec::new();
    for raw in toc.as_chunks::<ENTRY_BYTES>().0 {
        let raw: &[u8] = raw;
        result.entries += 1;
        for (count, layout) in plausible.iter_mut().zip(TocLayout::ALL) {
            if layout
                .entry(raw, String::new())
                .plausible(data_start, length)
            {
                *count += 1;
            }
        }
        let end = raw[..NAME_BYTES]
            .iter()
            .position(|&byte| byte == 0)
            .unwrap_or(NAME_BYTES);
        let path: String = raw[..end].iter().map(|&byte| char::from(byte)).collect();
        if wanted(&path) {
            chosen.push((path, raw));
        }
    }
    // The layout most entries make sense in, when that is most of them.
    let (best, count) = if plausible[1] > plausible[0] {
        (TocLayout::Two, plausible[1])
    } else {
        (TocLayout::One, plausible[0])
    };
    if result.entries > 0 && count * 2 >= result.entries {
        result.layout = Some(best);
        for (path, raw) in chosen {
            let entry = best.entry(raw, path);
            if entry.plausible(data_start, length) {
                result.wanted.push(entry);
            } else {
                result.outside += 1;
            }
        }
    }
    Ok(result)
}

/// A compression's name for people and the log.
pub fn compression_name(id: u32) -> &'static str {
    match id {
        0 => "none",
        1 => "zlib",
        2 => "Snappy",
        3 => "Doboz",
        4 => "LZ4",
        5 => "LZ4 HC",
        _ => "unknown",
    }
}

/// Unpacks an entry's bytes, and checks it is a CR2W file of the listed size.
pub fn unpack(packed: &[u8], size: u32, compression: u32) -> Result<Vec<u8>, String> {
    let wanted = usize::try_from(size).unwrap_or(usize::MAX);
    let bytes = match compression {
        0 => packed.to_vec(),
        1 => {
            let mut out = Vec::with_capacity(wanted.min(MAX_ENTRY_BYTES as usize));
            flate2::read::ZlibDecoder::new(packed)
                .take(u64::from(size) + 1)
                .read_to_end(&mut out)
                .map_err(|error| format!("its zlib data is damaged ({error})"))?;
            out
        }
        2 => {
            let length = snap::raw::decompress_len(packed)
                .map_err(|error| format!("its Snappy data is damaged ({error})"))?;
            if length != wanted {
                return Err(format!(
                    "its Snappy data unpacks to {length} bytes, not the {size} its bundle lists"
                ));
            }
            snap::raw::Decoder::new()
                .decompress_vec(packed)
                .map_err(|error| format!("its Snappy data is damaged ({error})"))?
        }
        3 => return Err("it is packed with Doboz, a compression Atlas cannot read yet".to_owned()),
        4 | 5 => lz4_flex::block::decompress(packed, wanted)
            .map_err(|error| format!("its LZ4 data is damaged ({error})"))?,
        other => {
            return Err(format!(
                "it is packed with a compression Atlas does not know (number {other})"
            ))
        }
    };
    if bytes.len() != wanted {
        return Err(format!(
            "it unpacks to {} bytes, not the {size} its bundle lists",
            bytes.len()
        ));
    }
    if !bytes.starts_with(b"CR2W") {
        return Err(
            "it does not unpack to a CR2W file, so the bundle layout is not the one Atlas expects"
                .to_owned(),
        );
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Scanning and reading

/// A file the web app may ask for, as `game_files_scan` lists it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameFileEntry {
    pub index: usize,
    pub path: String,
    pub size: u32,
    pub compression: String,
}

/// What a scan of the game folder found, in counts and game paths only.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameScan {
    pub stamp: String,
    pub bundles: usize,
    /// Entries in every table of contents.
    pub entries: usize,
    /// The files to read, lowest precedence first: a later file of the
    /// same pins wins.
    pub files: Vec<GameFileEntry>,
    /// Map files by extension, `.w2qm` (not read) included.
    pub extensions: BTreeMap<String, usize>,
    /// The files to read, by compression.
    pub compressions: BTreeMap<String, usize>,
    /// Bundles by table of contents layout, `unknown` for neither.
    pub layouts: BTreeMap<String, usize>,
    /// Map files found in more than one bundle.
    pub duplicates: usize,
    /// Map files whose data would lie outside their bundle.
    pub outside: usize,
    /// Bundles that could not be read.
    pub unreadable: usize,
}

struct Scanned {
    files: Vec<(PathBuf, TocEntry)>,
}

/// Scans a game folder's bundles for the map files.
pub fn scan_folder(folder: &Path, stamp: String) -> (GameScan, Vec<(PathBuf, TocEntry)>) {
    let bundles = find_bundles(folder);
    let mut scan = GameScan {
        stamp,
        bundles: bundles.len(),
        ..GameScan::default()
    };
    let map_file = |path: &str| {
        let ext = extension_of(path);
        READ.contains(&ext.as_str()) || COUNTED.contains(&ext.as_str())
    };
    // The winning entry of each path, with its bundle's rank.
    type Winner = ((u8, u32, String), PathBuf, TocEntry);
    let mut winners: HashMap<String, Winner> = HashMap::new();
    for bundle in &bundles {
        let toc = match read_toc(bundle, map_file) {
            Ok(toc) => toc,
            Err(problem) => {
                scan.unreadable += 1;
                activity::warn(
                    Area::GameFiles,
                    format!("The bundle {} {problem}", display_name(bundle)),
                );
                continue;
            }
        };
        scan.entries += toc.entries;
        scan.outside += toc.outside;
        let layout = toc.layout.map_or("unknown", TocLayout::label);
        *scan.layouts.entry(layout.to_owned()).or_default() += 1;
        let rank = bundle_rank(folder, bundle);
        for entry in toc.wanted {
            let key = entry.path.to_lowercase().replace('/', "\\");
            match winners.get(&key) {
                Some((known, _, _)) => {
                    scan.duplicates += 1;
                    if rank >= *known {
                        winners.insert(key, (rank.clone(), bundle.clone(), entry));
                    }
                }
                None => {
                    winners.insert(key, (rank.clone(), bundle.clone(), entry));
                }
            }
        }
    }
    let mut chosen: Vec<Winner> = winners.into_values().collect();
    chosen.sort_by(|a, b| (&a.0, a.2.path.to_lowercase()).cmp(&(&b.0, b.2.path.to_lowercase())));
    let mut files = Vec::new();
    for (_, bundle, entry) in chosen {
        let ext = extension_of(&entry.path);
        *scan.extensions.entry(ext.clone()).or_default() += 1;
        if !READ.contains(&ext.as_str()) {
            continue;
        }
        *scan
            .compressions
            .entry(compression_name(entry.compression).to_owned())
            .or_default() += 1;
        scan.files.push(GameFileEntry {
            index: files.len(),
            path: entry.path.clone(),
            size: entry.size,
            compression: compression_name(entry.compression).to_owned(),
        });
        files.push((bundle, entry));
    }
    (scan, files)
}

/// Reads and unpacks one entry of a bundle.
pub fn read_entry(bundle: &Path, entry: &TocEntry) -> Result<Vec<u8>, String> {
    if entry.size > MAX_ENTRY_BYTES || entry.packed > MAX_ENTRY_BYTES {
        return Err("it is larger than any map file can be".to_owned());
    }
    let mut file =
        File::open(bundle).map_err(|error| format!("its bundle cannot be opened: {error}"))?;
    file.seek(SeekFrom::Start(u64::from(entry.offset)))
        .map_err(|error| format!("its bundle could not be read: {error}"))?;
    let mut packed = vec![0u8; entry.packed as usize];
    file.read_exact(&mut packed)
        .map_err(|error| format!("its bundle could not be read: {error}"))?;
    unpack(&packed, entry.size, entry.compression)
}

/// The game folders the person chose, by game, as kept in `gamefiles.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct Remembered {
    folders: BTreeMap<String, String>,
}

struct Inner {
    remembered: Remembered,
    scanned: Option<Scanned>,
}

/// The chosen game folder, as the web app sees it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameFolder {
    pub path: Option<String>,
    pub name: Option<String>,
    /// It is the game's folder, and it is there.
    pub valid: bool,
    /// The executables' size and time; changes when the game is patched.
    pub stamp: Option<String>,
    /// Why it cannot be used, in plain words.
    pub problem: Option<String>,
}

fn folder_status(path: &Path) -> GameFolder {
    let checked = check_folder(path);
    GameFolder {
        path: Some(path.to_string_lossy().into_owned()),
        name: Some(display_name(path)),
        valid: checked.is_ok(),
        stamp: checked.as_ref().ok().cloned(),
        problem: checked.err(),
    }
}

/// The game folders the person chose, and the last scan of one.
pub struct GameFiles {
    store: Option<PathBuf>,
    likely: Vec<PathBuf>,
    inner: Mutex<Inner>,
}

fn known_game(game: &str) -> Result<(), String> {
    if game == GAME {
        Ok(())
    } else {
        Err("Atlas cannot read that game’s files.".to_owned())
    }
}

impl GameFiles {
    /// `app_data` holds `gamefiles.json`; `likely` are the folders the
    /// folder dialog may start in (see [`likely_folders`]).
    pub fn new(app_data: Option<PathBuf>, likely: Vec<PathBuf>) -> Self {
        let store = app_data.map(|dir| dir.join(STORE_FILE));
        let remembered = store
            .as_deref()
            .and_then(|file| fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            store,
            likely,
            inner: Mutex::new(Inner {
                remembered,
                scanned: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn remembered(&self, game: &str) -> Option<PathBuf> {
        self.lock().remembered.folders.get(game).map(PathBuf::from)
    }

    /// The chosen folder of a game, checked again now.
    pub fn folder(&self, game: &str) -> Result<GameFolder, String> {
        known_game(game)?;
        Ok(self
            .remembered(game)
            .map(|path| folder_status(&path))
            .unwrap_or_default())
    }

    pub fn remember(&self, game: &str, folder: &Path) {
        let mut inner = self.lock();
        inner
            .remembered
            .folders
            .insert(game.to_owned(), folder.to_string_lossy().into_owned());
        inner.scanned = None;
        let remembered = inner.remembered.clone();
        drop(inner);
        self.store(&remembered);
    }

    pub fn forget(&self, game: &str) {
        let mut inner = self.lock();
        inner.remembered.folders.remove(game);
        inner.scanned = None;
        let remembered = inner.remembered.clone();
        drop(inner);
        self.store(&remembered);
    }

    fn store(&self, remembered: &Remembered) {
        let Some(file) = &self.store else { return };
        let written = file
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| {
                fs::write(
                    file,
                    serde_json::to_vec_pretty(remembered).unwrap_or_default(),
                )
            });
        if let Err(error) = written {
            activity::warn(
                Area::GameFiles,
                format!("Could not remember the game folder: {error}"),
            );
        }
    }

    /// Where the folder dialog starts: the chosen folder, else the first
    /// likely folder that is the game's, else the first likely folder's
    /// parent that is there (such as Steam's `common`).
    pub fn dialog_start(&self, game: &str) -> Option<PathBuf> {
        if let Some(folder) = self.remembered(game).filter(|folder| folder.is_dir()) {
            return Some(folder);
        }
        self.likely
            .iter()
            .find(|folder| check_folder(folder).is_ok())
            .cloned()
            .or_else(|| {
                self.likely
                    .iter()
                    .filter_map(|folder| folder.parent())
                    .find(|parent| parent.is_dir())
                    .map(Path::to_path_buf)
            })
    }

    /// Scans the chosen folder's bundles for the map files.
    pub fn scan(&self, game: &str) -> Result<GameScan, String> {
        known_game(game)?;
        let folder = self
            .remembered(game)
            .ok_or_else(|| "Choose the game’s folder first.".to_owned())?;
        let stamp = check_folder(&folder)?;
        let started = Instant::now();
        let (scan, files) = scan_folder(&folder, stamp);
        activity::info(
            Area::GameFiles,
            format!(
                "{} ({} ms)",
                scan_line(&scan),
                started.elapsed().as_millis()
            ),
        );
        self.lock().scanned = Some(Scanned { files });
        Ok(scan)
    }

    /// The unpacked bytes of a file of the last scan.
    pub fn read(&self, game: &str, index: usize) -> Result<Vec<u8>, String> {
        known_game(game)?;
        let (bundle, entry) = {
            let inner = self.lock();
            let scanned = inner
                .scanned
                .as_ref()
                .ok_or_else(|| "Read the game folder again first.".to_owned())?;
            scanned
                .files
                .get(index)
                .cloned()
                .ok_or_else(|| "That file is not one Atlas found in the game.".to_owned())?
        };
        read_entry(&bundle, &entry).map_err(|problem| {
            let message = format!(
                "Could not read {} ({}, in {}): {problem}.",
                entry.path,
                compression_name(entry.compression),
                display_name(&bundle)
            );
            activity::warn(Area::GameFiles, &message);
            message
        })
    }
}

/// The scan in one line of the log: counts and game paths only.
pub fn scan_line(scan: &GameScan) -> String {
    let join = |counts: &BTreeMap<String, usize>, prefix: &str| {
        if counts.is_empty() {
            "none".to_owned()
        } else {
            counts
                .iter()
                .map(|(key, count)| format!("{prefix}{key} {count}"))
                .collect::<Vec<_>>()
                .join(", ")
        }
    };
    format!(
        "Scanned the game folder: {} bundles (table of contents layout: {}), {} entries | map files: {} | to read by compression: {} | {} in several bundles, {} outside their bundle, {} bundles not readable",
        scan.bundles,
        join(&scan.layouts, ""),
        scan.entries,
        join(&scan.extensions, "."),
        join(&scan.compressions, ""),
        scan.duplicates,
        scan.outside,
        scan.unreadable,
    )
}

// ---------------------------------------------------------------------------
// The report of the table, from the web app

/// How building or using the table went, from the web app, for the
/// activity log: counts, game world ids and game pin types only, never a
/// pin's name or where it is.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameFilesReport {
    /// `table` after building the table, `match` after using it with a save.
    kind: String,
    // The table.
    files: u32,
    read_failed: u32,
    parsed: u32,
    failed: u32,
    versions: BTreeMap<String, u32>,
    pin_files: u32,
    pin_files_with_pins: u32,
    area_worlds: u32,
    mounters: u32,
    worlds: BTreeMap<String, WorldPins>,
    unassigned: u32,
    without_position: u32,
    duplicates: u32,
    // A save matched with it.
    save_tags: u32,
    save_tags_found: u32,
    fits: BTreeMap<String, FitCounts>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct WorldPins {
    pins: u32,
    types: BTreeMap<String, u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct FitCounts {
    kinds: String,
    inliers: u32,
    candidates: u32,
    places: u32,
    rms: f64,
    radius: f64,
    passed: bool,
}

/// A world id or pin type as the log shows it: letters, digits and `_()-`, short.
fn key(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '(' | ')' | '-'))
        .take(40)
        .collect();
    if kept.is_empty() {
        "?".to_owned()
    } else {
        kept
    }
}

pub fn report_line(report: &GameFilesReport) -> String {
    if report.kind == "match" {
        let mut line = format!(
            "Used the game's map places with a save: {} of {} map pin tags of the save found in the table",
            report.save_tags_found, report.save_tags
        );
        for (world, fit) in report.fits.iter().take(20) {
            line += &format!(
                " | {}: from {}, {} of {} pins landed on {} places, {:.1} px apart on average (radius {:.1} px), {}",
                key(world),
                if fit.kinds == "first" { "signposts" } else { "every kind that never moves" },
                fit.inliers,
                fit.candidates,
                fit.places,
                fit.rms,
                fit.radius,
                if fit.passed { "lined up" } else { "not good enough" }
            );
        }
        return line;
    }
    let versions = report
        .versions
        .iter()
        .take(10)
        .map(|(version, count)| format!("{}: {count}", key(version)))
        .collect::<Vec<_>>()
        .join(", ");
    let worlds = report
        .worlds
        .iter()
        .take(40)
        .map(|(world, pins)| {
            let types = pins
                .types
                .iter()
                .take(60)
                .map(|(kind, count)| format!("{} {count}", key(kind)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{} {} ({types})", key(world), pins.pins)
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!(
        "Read the game's map places: {} files ({} could not be unpacked), {} read as CR2W (versions {}), {} not | {} pin files ({} with pins), {} worlds in world.w2am, {} DLC mounters | pins by world: {} | {} in files of no known world, {} with no position, {} replaced by a later file",
        report.files,
        report.read_failed,
        report.parsed,
        if versions.is_empty() { "none".to_owned() } else { versions },
        report.failed,
        report.pin_files,
        report.pin_files_with_pins,
        report.area_worlds,
        report.mounters,
        if worlds.is_empty() { "none".to_owned() } else { worlds },
        report.unassigned,
        report.without_position,
        report.duplicates,
    )
}

// ---------------------------------------------------------------------------
// Commands

type GameFilesState<'a> = State<'a, Arc<GameFiles>>;

/// The game folder chosen for a game, checked now.
#[tauri::command]
pub async fn game_folder_get(
    files: GameFilesState<'_>,
    game: String,
) -> Result<GameFolder, String> {
    let files = Arc::clone(&files);
    blocking(move || files.folder(&game)).await
}

/// Asks for the game's folder; `None` when the person closes the dialog.
/// A folder that is not the game's is answered with its problem and not
/// remembered.
#[tauri::command]
pub async fn game_folder_choose<R: Runtime>(
    window: WebviewWindow<R>,
    files: GameFilesState<'_>,
    game: String,
) -> Result<Option<GameFolder>, String> {
    known_game(&game)?;
    let start = {
        let files = Arc::clone(&files);
        let game = game.clone();
        blocking(move || Ok(files.dialog_start(&game))).await?
    };
    let Some(folder) = pick_folder_at(
        &window,
        "Choose the folder The Witcher 3 is installed in",
        start,
    )
    .await?
    else {
        return Ok(None);
    };
    let files = Arc::clone(&files);
    blocking(move || {
        let status = folder_status(&folder);
        if status.valid {
            files.remember(&game, &folder);
            activity::info(
                Area::GameFiles,
                format!("Chose the game folder {}", display_name(&folder)),
            );
        } else {
            activity::warn(
                Area::GameFiles,
                format!(
                    "Chose a folder that is not the game's: {}",
                    status.problem.as_deref().unwrap_or("")
                ),
            );
        }
        Ok(Some(status))
    })
    .await
}

#[tauri::command]
pub async fn game_folder_forget(files: GameFilesState<'_>, game: String) -> Result<(), String> {
    known_game(&game)?;
    let files = Arc::clone(&files);
    blocking(move || {
        files.forget(&game);
        activity::info(Area::GameFiles, "Forgot the game folder");
        Ok(())
    })
    .await
}

/// Reads the tables of contents of the chosen folder's bundles and lists
/// the map files in them.
#[tauri::command]
pub async fn game_files_scan(files: GameFilesState<'_>, game: String) -> Result<GameScan, String> {
    let files = Arc::clone(&files);
    blocking(move || files.scan(&game)).await
}

/// The unpacked bytes of a map file of the last scan.
#[tauri::command]
pub async fn game_files_read(
    files: GameFilesState<'_>,
    game: String,
    index: usize,
) -> Result<Response, String> {
    let files = Arc::clone(&files);
    blocking(move || files.read(&game, index).map(Response::new)).await
}

#[tauri::command]
pub fn game_files_report(report: GameFilesReport) {
    let line = report_line(&report);
    activity::info(Area::GameFiles, line);
}

/// The game files service for the app: `gamefiles.json` in the app's data
/// folder, and the folders the game is most likely in on this computer.
pub fn for_app<R: Runtime>(app: &tauri::App<R>) -> GameFiles {
    let paths = app.path();
    let program_files: Vec<PathBuf> = ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .collect();
    let system_drive = std::env::var_os("SystemDrive").map(|drive| {
        let mut drive = PathBuf::from(drive);
        drive.push(std::path::MAIN_SEPARATOR_STR);
        drive
    });
    let home = paths.home_dir().ok();
    let likely = likely_folders(home.as_deref(), &program_files, system_drive.as_deref());
    GameFiles::new(paths.app_data_dir().ok(), likely)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;
    use std::io::Write as _;

    /// A made-up CR2W file: the magic and some bytes. Nothing of the game.
    fn cr2w(fill: u8, len: usize) -> Vec<u8> {
        let mut bytes = b"CR2W".to_vec();
        bytes.resize(len, fill);
        bytes
    }

    fn zlib(bytes: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    struct TestEntry {
        path: &'static str,
        compression: u32,
        packed: Vec<u8>,
        size: u32,
    }

    fn entry(path: &'static str, compression: u32, plain: &[u8]) -> TestEntry {
        let packed = match compression {
            0 | 3 => plain.to_vec(),
            1 => zlib(plain),
            2 => snap::raw::Encoder::new().compress_vec(plain).unwrap(),
            _ => lz4_flex::block::compress(plain),
        };
        TestEntry {
            path,
            compression,
            packed,
            size: u32::try_from(plain.len()).unwrap(),
        }
    }

    /// Writes a bundle in a layout, the way `read_toc` reads it.
    fn bundle(layout: TocLayout, entries: &[TestEntry]) -> Vec<u8> {
        let toc = entries.len() * ENTRY_BYTES;
        let start = HEADER_BYTES as usize + toc;
        let mut out = vec![0u8; start];
        out[..8].copy_from_slice(MAGIC);
        let put = |out: &mut Vec<u8>, at: usize, value: u32| {
            out[at..at + 4].copy_from_slice(&value.to_le_bytes());
        };
        put(&mut out, 16, u32::try_from(toc).unwrap());
        let mut offset = start;
        for (i, item) in entries.iter().enumerate() {
            let at = HEADER_BYTES as usize + i * ENTRY_BYTES;
            out[at..at + item.path.len()].copy_from_slice(item.path.as_bytes());
            let packed = u32::try_from(item.packed.len()).unwrap();
            let offset32 = u32::try_from(offset).unwrap();
            match layout {
                TocLayout::One => {
                    put(&mut out, at + 0x114, item.size);
                    put(&mut out, at + 0x118, packed);
                    put(&mut out, at + 0x11C, offset32);
                    put(&mut out, at + 0x13C, item.compression);
                }
                TocLayout::Two => {
                    put(&mut out, at + 0x110, offset32);
                    put(&mut out, at + 0x118, item.size);
                    put(&mut out, at + 0x11C, packed);
                    put(&mut out, at + 0x124, item.compression);
                }
            }
            offset += item.packed.len();
        }
        for item in entries {
            out.extend_from_slice(&item.packed);
        }
        let size = u32::try_from(out.len()).unwrap();
        put(&mut out, 8, size);
        out
    }

    /// A made-up game folder with an executable of `exe` bytes.
    fn game_folder(dir: &Path, exe: &[u8]) -> PathBuf {
        let game = dir.join("The Witcher 3");
        fs::create_dir_all(game.join("content").join("content0").join("bundles")).unwrap();
        fs::create_dir_all(game.join("bin").join("x64")).unwrap();
        fs::write(game.join("bin").join("x64").join("witcher3.exe"), exe).unwrap();
        game
    }

    #[test]
    fn knows_the_game_folder_by_its_bundles_and_executable() {
        let dir = TempDir::new("gamefiles-folder");
        let game = game_folder(&dir.0, b"exe");
        let stamp = check_folder(&game).unwrap();
        assert!(stamp.starts_with("x64:3:"), "{stamp}");
        // A patch changes the stamp.
        fs::write(
            game.join("bin").join("x64").join("witcher3.exe"),
            b"patched",
        )
        .unwrap();
        assert_ne!(check_folder(&game).unwrap(), stamp);
        // Names in another case are found too.
        let other = dir.0.join("copy");
        fs::create_dir_all(other.join("Content").join("Content0").join("Bundles")).unwrap();
        fs::create_dir_all(other.join("BIN").join("x64_dx12")).unwrap();
        fs::write(
            other.join("BIN").join("x64_dx12").join("Witcher3.exe"),
            b"x",
        )
        .unwrap();
        assert!(check_folder(&other).unwrap().starts_with("x64_dx12:1:"));

        let error = check_folder(&dir.0).unwrap_err();
        assert!(
            error.contains("is not The Witcher 3’s game folder"),
            "{error}"
        );
        fs::remove_file(game.join("bin").join("x64").join("witcher3.exe")).unwrap();
        assert!(check_folder(&game).is_err());
        assert!(check_folder(&dir.0.join("missing"))
            .unwrap_err()
            .contains("cannot be found"));
    }

    #[test]
    fn finds_steam_libraries_and_the_likely_folders() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t\t\"label\"\t\t\"\"\n\t}\n}\n";
        assert_eq!(
            steam_libraries(vdf),
            [
                PathBuf::from("C:\\Program Files (x86)\\Steam"),
                PathBuf::from("D:\\SteamLibrary")
            ]
        );

        let dir = TempDir::new("gamefiles-likely");
        let home = dir.0.join("home");
        let steam = home.join(".local").join("share").join("Steam");
        let library = dir.0.join("library");
        fs::create_dir_all(steam.join("steamapps")).unwrap();
        fs::write(
            steam.join("steamapps").join("libraryfolders.vdf"),
            format!("\"path\" \"{}\"\n", library.display()),
        )
        .unwrap();
        let likely = likely_folders(Some(&home), &[dir.0.join("pf")], Some(&dir.0));
        let installed = library
            .join("steamapps")
            .join("common")
            .join("The Witcher 3");
        assert!(likely.contains(&installed));
        assert!(likely.contains(
            &dir.0
                .join("pf")
                .join("GOG Galaxy")
                .join("Games")
                .join("The Witcher 3 Wild Hunt GOTY")
        ));
        assert!(likely.contains(&dir.0.join("GOG Games").join("The Witcher 3 Wild Hunt")));

        // The dialog starts in the folder that is the game's.
        let files = GameFiles::new(None, likely.clone());
        assert_eq!(files.dialog_start(GAME), None);
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        assert_eq!(
            files.dialog_start(GAME),
            installed.parent().map(Path::to_path_buf)
        );
        let game = game_folder(installed.parent().unwrap(), b"exe");
        assert_eq!(game, installed);
        assert_eq!(files.dialog_start(GAME), Some(installed));
    }

    #[test]
    fn finds_bundles_under_content_and_dlc_only() {
        let dir = TempDir::new("gamefiles-bundles");
        let game = game_folder(&dir.0, b"exe");
        let content = game.join("content").join("content0").join("bundles");
        fs::write(content.join("blob.bundle"), b"").unwrap();
        fs::write(content.join("metadata.store"), b"").unwrap();
        let dlc = game.join("dlc").join("bob").join("content").join("bundles");
        fs::create_dir_all(&dlc).unwrap();
        fs::write(dlc.join("Blob.BUNDLE"), b"").unwrap();
        fs::create_dir_all(game.join("mods").join("modX").join("content")).unwrap();
        fs::write(
            game.join("mods")
                .join("modX")
                .join("content")
                .join("blob.bundle"),
            b"",
        )
        .unwrap();
        let found = find_bundles(&game);
        assert_eq!(
            found,
            [content.join("blob.bundle"), dlc.join("Blob.BUNDLE")]
        );

        #[cfg(unix)]
        {
            let outside = dir.0.join("outside");
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("secret.bundle"), b"").unwrap();
            std::os::unix::fs::symlink(&outside, game.join("dlc").join("linked")).unwrap();
            std::os::unix::fs::symlink(
                outside.join("secret.bundle"),
                content.join("linked.bundle"),
            )
            .unwrap();
            assert_eq!(find_bundles(&game).len(), 2);
        }
    }

    #[test]
    fn ranks_dlc_over_patches_over_content() {
        let game = Path::new("game");
        let rank = |parts: &[&str]| {
            bundle_rank(
                game,
                &parts
                    .iter()
                    .fold(game.to_path_buf(), |path, part| path.join(part)),
            )
        };
        let content0 = rank(&["content", "content0", "bundles", "blob.bundle"]);
        let content12 = rank(&["content", "content12", "bundles", "blob.bundle"]);
        let patch0 = rank(&["content", "patch0", "bundles", "blob.bundle"]);
        let dlc = rank(&["dlc", "bob", "content", "bundles", "blob.bundle"]);
        assert!(content0 < content12);
        assert!(content12 < patch0);
        assert!(patch0 < dlc);
    }

    #[test]
    fn reads_both_table_of_contents_layouts_and_every_compression_but_doboz() {
        let plain = cr2w(7, 3000);
        for layout in TocLayout::ALL {
            let dir = TempDir::new(&format!("gamefiles-toc-{}", layout.label()));
            let path = dir.0.join("blob.bundle");
            let entries = [
                entry("game\\hub_pins\\novigrad.w2em", 0, &plain),
                entry("game\\hub_pins\\skellige.w2em", 1, &plain),
                entry("game\\hub_pins\\kaer_morhen.w2em", 2, &plain),
                entry("game\\world.w2am", 4, &plain),
                entry("dlc\\bob\\data\\bob.reddlc", 5, &plain),
                entry("game\\hub_pins\\the_spiral.w2em", 3, &plain),
                entry("characters\\models\\geralt.w2ent", 1, &plain),
            ];
            fs::write(&path, bundle(layout, &entries)).unwrap();
            let toc = read_toc(&path, |name| {
                name.ends_with(".w2em") || name.ends_with(".w2am") || name.ends_with(".reddlc")
            })
            .unwrap();
            assert_eq!(toc.layout, Some(layout));
            assert_eq!(toc.entries, 7);
            assert_eq!(toc.wanted.len(), 6);
            for found in &toc.wanted {
                let read = read_entry(&path, found);
                if found.compression == 3 {
                    assert!(read.unwrap_err().contains("Doboz"));
                } else {
                    assert_eq!(read.unwrap(), plain, "{} {}", found.path, found.compression);
                }
            }
        }
    }

    #[test]
    fn refuses_entries_that_are_not_cr2w_or_not_their_size() {
        assert!(unpack(b"POTATO70", 8, 0)
            .unwrap_err()
            .contains("does not unpack to a CR2W file"));
        assert!(unpack(&zlib(&cr2w(1, 100)), 99, 1)
            .unwrap_err()
            .contains("not the 99"));
        assert!(unpack(b"\x00\x01garbage", 50, 1)
            .unwrap_err()
            .contains("zlib"));
        assert!(unpack(b"CR2W", 4, 9).unwrap_err().contains("number 9"));
        assert!(unpack(&[0xff; 8], 64, 4).unwrap_err().contains("LZ4"));
    }

    #[test]
    fn refuses_what_is_not_a_bundle() {
        let dir = TempDir::new("gamefiles-notbundle");
        let path = dir.0.join("x.bundle");
        fs::write(&path, b"short").unwrap();
        assert!(read_toc(&path, |_| true).unwrap_err().contains("too short"));
        fs::write(&path, [b"NOTABUND".as_slice(), &[0; 40]].concat()).unwrap();
        assert!(read_toc(&path, |_| true).unwrap_err().contains("POTATO70"));
        let mut huge = bundle(TocLayout::One, &[]);
        huge[16..20].copy_from_slice(&1000u32.to_le_bytes());
        fs::write(&path, huge).unwrap();
        assert!(read_toc(&path, |_| true)
            .unwrap_err()
            .contains("does not fit"));
    }

    #[test]
    fn scans_a_game_folder_and_reads_the_winning_entries() {
        let dir = TempDir::new("gamefiles-scan");
        let game = game_folder(&dir.0, b"exe");
        let content0 = game.join("content").join("content0").join("bundles");
        let patch0 = game.join("content").join("patch0").join("bundles");
        let dlc = game.join("dlc").join("bob").join("content").join("bundles");
        fs::create_dir_all(&patch0).unwrap();
        fs::create_dir_all(&dlc).unwrap();
        let old = cr2w(1, 500);
        let new = cr2w(2, 600);
        fs::write(
            content0.join("blob.bundle"),
            bundle(
                TocLayout::One,
                &[
                    entry("game\\hub_pins\\novigrad.w2em", 1, &old),
                    entry("game\\world.w2am", 0, &old),
                    entry("game\\hub_pins\\novigrad.w2qm", 1, &old),
                    entry("environment\\sky.w2ent", 1, &old),
                ],
            ),
        )
        .unwrap();
        fs::write(
            patch0.join("blob.bundle"),
            bundle(
                TocLayout::Two,
                &[entry("game\\hub_pins\\novigrad.w2em", 4, &new)],
            ),
        )
        .unwrap();
        fs::write(
            dlc.join("blob.bundle"),
            bundle(
                TocLayout::Two,
                &[entry("dlc\\bob\\data\\bob.reddlc", 2, &new)],
            ),
        )
        .unwrap();
        fs::write(dlc.join("broken.bundle"), b"POTATO7").unwrap();

        let files = GameFiles::new(Some(dir.0.join("app")), Vec::new());
        assert!(files.scan(GAME).unwrap_err().contains("Choose the game"));
        files.remember(GAME, &game);
        let scan = files.scan(GAME).unwrap();
        assert_eq!(scan.bundles, 4);
        assert_eq!(scan.entries, 6);
        assert_eq!(scan.unreadable, 1);
        assert_eq!(scan.duplicates, 1);
        assert_eq!(
            scan.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            [
                "game\\world.w2am",
                "game\\hub_pins\\novigrad.w2em",
                "dlc\\bob\\data\\bob.reddlc"
            ]
        );
        assert_eq!(
            scan.extensions,
            BTreeMap::from([
                ("reddlc".to_owned(), 1),
                ("w2am".to_owned(), 1),
                ("w2em".to_owned(), 1),
                ("w2qm".to_owned(), 1)
            ])
        );
        assert_eq!(
            scan.compressions,
            BTreeMap::from([
                ("LZ4".to_owned(), 1),
                ("Snappy".to_owned(), 1),
                ("none".to_owned(), 1)
            ])
        );
        assert_eq!(
            scan.layouts,
            BTreeMap::from([("1".to_owned(), 1), ("2".to_owned(), 2)])
        );
        // The patch's file wins over the base game's.
        assert_eq!(files.read(GAME, 1).unwrap(), new);
        assert_eq!(files.read(GAME, 0).unwrap(), old);
        assert!(files.read(GAME, 9).is_err());
        assert!(files.read("other", 0).is_err());
        assert!(scan_line(&scan).contains("map files: .reddlc 1, .w2am 1, .w2em 1, .w2qm 1"));

        // Remembered after a restart; forgotten when asked.
        let restarted = GameFiles::new(Some(dir.0.join("app")), Vec::new());
        let folder = restarted.folder(GAME).unwrap();
        assert!(folder.valid);
        assert_eq!(folder.name.as_deref(), Some("The Witcher 3"));
        assert!(folder.stamp.is_some());
        restarted.forget(GAME);
        let again = GameFiles::new(Some(dir.0.join("app")), Vec::new());
        assert!(again.folder(GAME).unwrap().path.is_none());
        assert!(again.folder("other").is_err());
    }

    #[test]
    fn reports_counts_and_types_only() {
        let table: GameFilesReport = serde_json::from_value(serde_json::json!({
            "kind": "table",
            "files": 14,
            "readFailed": 1,
            "parsed": 12,
            "failed": 1,
            "versions": { "163": 12 },
            "pinFiles": 10,
            "pinFilesWithPins": 9,
            "areaWorlds": 9,
            "mounters": 2,
            "worlds": {
                "novigrad": { "pins": 1200, "types": { "RoadSign": 80, "MonsterNest": 40 } },
                "bob\nfake line": { "pins": 3, "types": {} }
            },
            "unassigned": 0,
            "withoutPosition": 2,
            "duplicates": 5
        }))
        .unwrap();
        assert_eq!(
            report_line(&table),
            "Read the game's map places: 14 files (1 could not be unpacked), 12 read as CR2W (versions 163: 12), 1 not | 10 pin files (9 with pins), 9 worlds in world.w2am, 2 DLC mounters | pins by world: bobfakeline 3 (); novigrad 1200 (MonsterNest 40, RoadSign 80) | 0 in files of no known world, 2 with no position, 5 replaced by a later file"
        );
        let used: GameFilesReport = serde_json::from_value(serde_json::json!({
            "kind": "match",
            "saveTags": 14,
            "saveTagsFound": 12,
            "fits": {
                "novigrad": { "kinds": "first", "inliers": 118, "candidates": 140, "places": 130, "rms": 1.84, "radius": 9.3, "passed": true }
            }
        }))
        .unwrap();
        assert_eq!(
            report_line(&used),
            "Used the game's map places with a save: 12 of 14 map pin tags of the save found in the table | novigrad: from signposts, 118 of 140 pins landed on 130 places, 1.8 px apart on average (radius 9.3 px), lined up"
        );
    }
}
