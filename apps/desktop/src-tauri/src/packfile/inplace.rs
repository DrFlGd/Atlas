//! A pack file (`.atlaspack`) read where it lies, without unpacking it and
//! without writing anything beside it.
//!
//! Opening the file reads its description (the first entry, see the
//! `atlas-pack` crate) and its list of contents (the ZIP central directory,
//! ZIP64 too) once, and checks every entry with the rules an import uses
//! (see [`super::import::Rules`] and [`super::import::check_entry`]): an
//! entry with no place in a pack, an unsafe name, a link, another packing
//! method or a size over the limits refuses the whole file. What is kept is
//! a compact table, entry name to where its local header is, its stored
//! and unpacked length, its packing and its checksum; the ZIP reader is
//! dropped.
//!
//! An entry's data starts after its local header, whose length is only
//! known by reading it: that happens at its first read, and the offset is
//! kept. Stored entries (the map images and pictures) and byte ranges of
//! them are read with positioned reads on a handle opened for the request,
//! with no lock around the file. Deflated entries (the JSON files) are
//! inflated whole, within the size the table allows, checked against their
//! checksum, and kept in memory up to [`CACHE_BYTES`] in all.
//!
//! The file belongs to the person or another app, which may replace it
//! while Atlas runs (writing a `.part` file beside it and renaming that
//! over it). Every request opens the file again and compares that handle's
//! length and modified time, and the end record of its central directory
//! (which says where the directory is), with those the table was built
//! from; when they differ, the table is built again from that same handle.
//! A request is answered from one handle and the table of that handle's
//! file, so it never mixes the old file's bytes with the new one's table.
//! A file that cannot be opened is remembered with its reason until it
//! changes, so a broken file is not read again for every request.

use std::{
    collections::HashMap,
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, PoisonError, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use flate2::{read::DeflateDecoder, Crc};
use zip::{CompressionMethod, ZipArchive};

use super::{
    import::{check_count, check_entry, EntryFacts, Kind, Rules, Tally},
    Header, Stop, HEADER_FILE,
};
use crate::packs::is_valid_pack_id;

/// Inflated entries kept in memory per pack file, in bytes. An entry that
/// does not fit is inflated again at each read.
pub const CACHE_BYTES: usize = 64 << 20;

const NOT_A_PACK_FILE: &str = "This file is not an Atlas pack file.";
const DAMAGED_LIST: &str = "This pack file is damaged: its list of contents cannot be read.";
/// Signature of a ZIP local file header.
const LOCAL_HEADER: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];
/// Signature of the ZIP end of central directory record.
const END_RECORD: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const END_RECORD_LEN: usize = 22;
/// The ZIP64 end of central directory locator, right before the end record.
const ZIP64_LOCATOR_LEN: usize = 20;

/// A pack file the Library found, read in place.
#[derive(Debug)]
pub struct PackFile {
    path: PathBuf,
    state: RwLock<State>,
    /// Held while the table is built, so parallel requests build it once.
    building: Mutex<()>,
}

#[derive(Debug)]
enum State {
    Unread,
    Open(Arc<Table>),
    /// The file of this length and time cannot be used, for this reason.
    Failed {
        stamp: Stamp,
        reason: String,
    },
}

/// What tells a file apart from a changed one without reading it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn of(metadata: &std::fs::Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }

    fn nanos(&self) -> u128 {
        self.modified
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_nanos())
    }
}

/// The table of one version of a pack file.
#[derive(Debug)]
pub struct Table {
    stamp: Stamp,
    /// Where the bytes of [`Self::tail`] are: the end record of the central
    /// directory, with the ZIP64 locator before it when there is room.
    tail_at: u64,
    tail: Vec<u8>,
    /// Where the central directory starts: no entry's data goes past it.
    directory_start: u64,
    header: Header,
    entries: HashMap<Box<str>, Item>,
    cache: Mutex<Cache>,
}

/// One entry of the table.
#[derive(Debug)]
struct Item {
    /// Where its local header starts.
    header_start: u64,
    /// Its length in the file.
    stored: u64,
    /// Its length unpacked.
    size: u64,
    deflated: bool,
    crc32: u32,
    /// It is one of the files a pack folder holds (the pack's JSON files,
    /// status files, map images, markers and pictures), so it is served.
    /// The small pictures and the person's own things (`mine/`) are not.
    served: bool,
    /// Where its data starts, found at its first read.
    data_start: OnceLock<u64>,
}

#[derive(Debug, Default)]
struct Cache {
    bytes: usize,
    entries: HashMap<Box<str>, Arc<Vec<u8>>>,
}

impl PackFile {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: RwLock::new(State::Unread),
            building: Mutex::new(()),
        }
    }

    /// The pack file's path, as it was found.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Opens the file for one request, with the table of the file that
    /// handle reads. Builds the table again when the file changed. Errs
    /// with `NotFound` when the file is gone, and `InvalidData` with a
    /// plain sentence when it cannot be used.
    pub fn open(&self) -> io::Result<Opened> {
        let file = File::open(&self.path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::ErrorKind::NotFound.into());
        }
        let stamp = Stamp::of(&metadata);
        if let Some(table) = self.matching(&file, &stamp) {
            return Ok(Opened { file, table });
        }
        let _building = self.building.lock().unwrap_or_else(PoisonError::into_inner);
        // Another request may have built it from the same file meanwhile.
        if let Some(table) = self.matching(&file, &stamp) {
            return Ok(Opened { file, table });
        }
        if let State::Failed {
            stamp: failed,
            reason,
        } = &*self.state.read().unwrap_or_else(PoisonError::into_inner)
        {
            if *failed == stamp {
                return Err(io::Error::new(io::ErrorKind::InvalidData, reason.clone()));
            }
        }
        match Table::build(&file, stamp.clone()) {
            Ok(table) => {
                let table = Arc::new(table);
                *self.state.write().unwrap_or_else(PoisonError::into_inner) =
                    State::Open(Arc::clone(&table));
                Ok(Opened { file, table })
            }
            Err(stop) => {
                let reason = stop.message();
                *self.state.write().unwrap_or_else(PoisonError::into_inner) = State::Failed {
                    stamp,
                    reason: reason.clone(),
                };
                Err(io::Error::new(io::ErrorKind::InvalidData, reason))
            }
        }
    }

    /// The table of the file as it is now, or why the file cannot be used,
    /// in a plain sentence: what the Library lists.
    pub fn check(&self) -> Result<Arc<Table>, String> {
        match self.open() {
            Ok(opened) => Ok(opened.table),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Err("The pack file cannot be found.".to_owned())
            }
            Err(error) if error.kind() == io::ErrorKind::InvalidData => Err(error
                .into_inner()
                .map_or_else(|| NOT_A_PACK_FILE.to_owned(), |inner| inner.to_string())),
            Err(error) => Err(format!("The pack file cannot be read: {error}")),
        }
    }

    /// The table, when it was built from the file `file` reads.
    fn matching(&self, file: &File, stamp: &Stamp) -> Option<Arc<Table>> {
        let table = match &*self.state.read().unwrap_or_else(PoisonError::into_inner) {
            State::Open(table) => Arc::clone(table),
            State::Unread | State::Failed { .. } => return None,
        };
        (table.stamp == *stamp && table.tail_matches(file)).then_some(table)
    }
}

impl Table {
    /// The pack file's description.
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// Whether the end record read through `file` is the one this table
    /// was built from.
    fn tail_matches(&self, file: &File) -> bool {
        let mut bytes = vec![0; self.tail.len()];
        read_exact_at(file, &mut bytes, self.tail_at).is_ok() && bytes == self.tail
    }

    /// Reads the file's description and list of contents and checks every
    /// entry. `file` is read from its start; its position is left anywhere.
    fn build(file: &File, stamp: Stamp) -> Result<Self, Stop> {
        let mut reader = file;
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|error| Stop::Failed(format!("The pack file cannot be read: {error}")))?;
        let header = atlas_pack::read_header_from(reader)?;
        if !is_valid_pack_id(&header.pack_id) {
            return Err(Stop::Failed(
                "This pack file names a game id that Atlas cannot use.".to_owned(),
            ));
        }
        let (tail_at, tail) = find_tail(file, stamp.len)?;

        let archive = ZipArchive::new(BufReader::new(file))
            .map_err(|_| Stop::Failed(DAMAGED_LIST.to_owned()))?;
        // The description is the first entry, at the very start: nothing
        // comes before the archive.
        if archive.offset() != 0 {
            return Err(Stop::Failed(NOT_A_PACK_FILE.to_owned()));
        }
        let count = archive.len();
        check_count(count)?;
        if archive.has_duplicate_names() {
            return Err(Stop::Failed(
                "This pack file holds a file twice.".to_owned(),
            ));
        }
        let directory_start = archive.central_directory_start();
        let mut raw = Vec::with_capacity(count);
        for index in 0..count {
            let entry = archive
                .by_index_data(index)
                .map_err(|_| Stop::Failed(DAMAGED_LIST.to_owned()))?;
            let name = entry.name().map_err(|_| unreadable_name())?;
            // The name as the local header has it: one that is not UTF-8
            // as it stands is not read (Atlas writes UTF-8 names).
            if name.as_bytes() != entry.name_raw() {
                return Err(unreadable_name());
            }
            if index == 0 && name != HEADER_FILE {
                return Err(Stop::Failed(NOT_A_PACK_FILE.to_owned()));
            }
            raw.push(Raw {
                name: name.into_owned(),
                header_start: entry.header_start(),
                stored: entry.compressed_size(),
                size: entry.size(),
                compression: entry.compression(),
                crc32: entry.crc32(),
                symlink: entry.is_symlink(),
                dir: entry.is_dir(),
            });
        }
        // Only the table is kept.
        drop(archive);

        let mut entries: HashMap<Box<str>, Item> = HashMap::with_capacity(count);
        for entry in &raw {
            if entry.header_start >= directory_start {
                return Err(Stop::Failed(DAMAGED_LIST.to_owned()));
            }
            if entry.dir || entry.symlink {
                continue;
            }
            entries.insert(
                entry.name.clone().into_boxed_str(),
                Item {
                    header_start: entry.header_start,
                    stored: entry.stored,
                    size: entry.size,
                    deflated: entry.compression == CompressionMethod::Deflated,
                    crc32: entry.crc32,
                    served: false,
                    data_start: OnceLock::new(),
                },
            );
        }
        let mut table = Self {
            stamp,
            tail_at,
            tail,
            directory_start,
            header,
            entries,
            cache: Mutex::new(Cache::default()),
        };

        // The pack's own files say what else it may hold.
        let rules = Rules::read(&table.header, &mut |name, cap| {
            if !table.entries.contains_key(name) {
                return Ok(None);
            }
            let item = &table.entries[name];
            if item.size > cap {
                return Err(Stop::Failed(format!(
                    "{} in this pack file is too large.",
                    crate::activity::clean(name)
                )));
            }
            table
                .whole(file, name, item)
                .map(|bytes| Some(bytes.to_vec()))
                .map_err(|_| damaged(name))
        })?;
        let mut tally = Tally::default();
        for (index, entry) in raw.iter().enumerate().skip(1) {
            let facts = EntryFacts {
                index,
                name: &entry.name,
                size: entry.size,
                symlink: entry.symlink,
                dir: entry.dir,
                compression: entry.compression,
            };
            let Some(kind) = check_entry(&rules, &mut tally, &facts)? else {
                continue;
            };
            let item = table
                .entries
                .get_mut(entry.name.as_str())
                .expect("every file entry is in the table");
            // A stored entry is as long in the file as unpacked.
            if !item.deflated && item.stored != item.size {
                return Err(damaged(&entry.name));
            }
            item.served = matches!(
                kind,
                Kind::PackFile | Kind::Status(_) | Kind::Image | Kind::Marker | Kind::Picture
            );
        }
        Ok(table)
    }

    /// Where an entry's data starts, from its local header at the first
    /// read. The local header must name the same entry with the same
    /// packing, and the data must end before the central directory.
    fn data_start(&self, file: &File, name: &str, item: &Item) -> io::Result<u64> {
        if let Some(&start) = item.data_start.get() {
            return Ok(start);
        }
        let mut local = vec![0u8; 30 + name.len()];
        read_exact_at(file, &mut local, item.header_start)?;
        let u16_at = |at: usize| u64::from(u16::from_le_bytes([local[at], local[at + 1]]));
        let method = if item.deflated { 8 } else { 0 };
        if local[..4] != LOCAL_HEADER
            || u16_at(8) != method
            || u16_at(26) != name.len() as u64
            || &local[30..] != name.as_bytes()
        {
            return Err(invalid(
                "a local header does not match the list of contents",
            ));
        }
        let start = item.header_start + 30 + u16_at(26) + u16_at(28);
        if start
            .checked_add(item.stored)
            .is_none_or(|end| end > self.directory_start)
        {
            return Err(invalid("an entry goes past the list of contents"));
        }
        Ok(*item.data_start.get_or_init(|| start))
    }

    /// An entry's bytes, unpacked and checked against its checksum; a
    /// deflated one is kept while the cache has room.
    fn whole(&self, file: &File, name: &str, item: &Item) -> io::Result<Arc<Vec<u8>>> {
        if item.deflated {
            if let Some(bytes) = lock(&self.cache).entries.get(name) {
                return Ok(Arc::clone(bytes));
            }
        }
        let start = self.data_start(file, name, item)?;
        let capacity = usize::try_from(item.size).map_err(|_| invalid("an entry is too large"))?;
        let mut bytes = Vec::with_capacity(capacity);
        let stored = At {
            file,
            at: start,
            end: start + item.stored,
        };
        if item.deflated {
            DeflateDecoder::new(stored)
                .take(item.size + 1)
                .read_to_end(&mut bytes)?;
        } else {
            stored.take(item.size + 1).read_to_end(&mut bytes)?;
        }
        if bytes.len() as u64 != item.size {
            return Err(invalid(
                "an entry is not as long as the list of contents says",
            ));
        }
        let mut crc = Crc::new();
        crc.update(&bytes);
        if crc.sum() != item.crc32 {
            return Err(invalid("an entry does not match its checksum"));
        }
        let bytes = Arc::new(bytes);
        if item.deflated {
            let mut cache = lock(&self.cache);
            if cache.bytes + bytes.len() <= CACHE_BYTES && !cache.entries.contains_key(name) {
                cache.bytes += bytes.len();
                cache.entries.insert(name.into(), Arc::clone(&bytes));
            }
        }
        Ok(bytes)
    }
}

/// An entry as the central directory gives it, while the table is built.
struct Raw {
    name: String,
    header_start: u64,
    stored: u64,
    size: u64,
    compression: CompressionMethod,
    crc32: u32,
    symlink: bool,
    dir: bool,
}

/// A pack file opened for one request, with the table of the file this
/// handle reads.
#[derive(Debug)]
pub struct Opened {
    file: File,
    table: Arc<Table>,
}

impl Opened {
    pub fn header(&self) -> &Header {
        &self.table.header
    }

    /// The unpacked length of an entry that is served; none for another
    /// name.
    pub fn size(&self, name: &str) -> Option<u64> {
        self.table
            .entries
            .get(name)
            .filter(|item| item.served)
            .map(|item| item.size)
    }

    /// A tag that changes when the entry or the file does.
    pub fn etag(&self, name: &str) -> String {
        let at = self
            .table
            .entries
            .get(name)
            .map_or(0, |item| item.header_start);
        format!(
            "\"{:x}-{:x}-{at:x}\"",
            self.table.stamp.len,
            self.table.stamp.nanos()
        )
    }

    /// `count` bytes of a served entry from `start` (within its length).
    /// A stored entry is read with one positioned read, and checked
    /// against its checksum when it is read whole.
    pub fn read(&self, name: &str, start: u64, count: u64) -> io::Result<Vec<u8>> {
        let item = self
            .table
            .entries
            .get(name)
            .filter(|item| item.served)
            .ok_or(io::ErrorKind::NotFound)?;
        let end = start
            .checked_add(count)
            .filter(|&end| end <= item.size)
            .ok_or_else(|| invalid("a read past the end of an entry"))?;
        if item.deflated || (start == 0 && end == item.size) {
            let whole = self.table.whole(&self.file, name, item)?;
            let part = usize::try_from(start)
                .ok()
                .zip(usize::try_from(end).ok())
                .and_then(|(start, end)| whole.get(start..end))
                .ok_or_else(|| invalid("a read past the end of an entry"))?;
            return Ok(part.to_vec());
        }
        let data = self.table.data_start(&self.file, name, item)?;
        let mut bytes =
            vec![0u8; usize::try_from(count).map_err(|_| invalid("a read is too large"))?];
        read_exact_at(&self.file, &mut bytes, data + start)?;
        Ok(bytes)
    }
}

/// Finds the end record of the central directory: the last 22 to 65,557
/// bytes of the file hold it, with a comment of the length it says after
/// it. Its bytes, and the ZIP64 locator's before it, are what tells this
/// version of the file from a changed one.
fn find_tail(file: &File, len: u64) -> Result<(u64, Vec<u8>), Stop> {
    let not_ours = || Stop::Failed(NOT_A_PACK_FILE.to_owned());
    let window = len.min(END_RECORD_LEN as u64 + u64::from(u16::MAX));
    if window < END_RECORD_LEN as u64 {
        return Err(not_ours());
    }
    let mut bytes = vec![0u8; usize::try_from(window).map_err(|_| not_ours())?];
    read_exact_at(file, &mut bytes, len - window).map_err(|_| not_ours())?;
    let found = (0..=bytes.len() - END_RECORD_LEN)
        .rev()
        .find(|&at| {
            bytes[at..at + 4] == END_RECORD && {
                let comment = usize::from(u16::from_le_bytes([bytes[at + 20], bytes[at + 21]]));
                at + END_RECORD_LEN + comment == bytes.len()
            }
        })
        .ok_or_else(not_ours)?;
    let from = found.saturating_sub(ZIP64_LOCATOR_LEN);
    Ok((
        len - window + from as u64,
        bytes[from..found + END_RECORD_LEN].to_vec(),
    ))
}

/// Reads stored bytes of the file from `at` up to `end`, with positioned
/// reads.
struct At<'a> {
    file: &'a File,
    at: u64,
    end: u64,
}

impl Read for At<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let left = usize::try_from(self.end - self.at).unwrap_or(usize::MAX);
        let want = buffer.len().min(left).min(64 << 10);
        if want == 0 {
            return Ok(0);
        }
        read_exact_at(self.file, &mut buffer[..want], self.at)?;
        self.at += want as u64;
        Ok(want)
    }
}

/// Fills `buffer` from `offset` of the file, without moving a shared
/// position, so requests read one file at once with no lock.
#[cfg(unix)]
pub fn read_exact_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buffer, offset)
}

/// Fills `buffer` from `offset` of the file. `seek_read` moves the handle's
/// position too, which no reader here uses.
#[cfg(windows)]
pub fn read_exact_at(file: &File, mut buffer: &mut [u8], mut offset: u64) -> io::Result<()> {
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

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("The pack file is damaged: {what}."),
    )
}

fn unreadable_name() -> Stop {
    Stop::Failed("This pack file holds a file with an unreadable name.".to_owned())
}

fn damaged(name: &str) -> Stop {
    Stop::Failed(format!(
        "This pack file is damaged: {} cannot be read in full.",
        crate::activity::clean(name)
    ))
}

/// Small made-up pack files for tests elsewhere.
#[cfg(test)]
pub(crate) mod testing {
    use std::{io::Write, path::Path};

    use serde_json::{json, Value};
    use zip::{write::SimpleFileOptions, ZipWriter};

    /// The description of a made-up pack file of a game with no map.
    pub(crate) fn header(id: &str, title: &str, updated: &str, exported_at: &str) -> Value {
        json!({
            "format": "atlas-pack-file", "version": 1, "packId": id, "title": title,
            "packVersion": "1.0.0", "detail": "full", "exportedAt": exported_at,
            "exportedBy": {"name": "Atlas", "version": "0.22.0", "platform": "linux"},
            "pack": {"id": id, "title": title, "packVersion": "1.0.0", "schemaVersion": 2,
                     "attribution": [], "updated": updated},
            "source": {"kind": "unknown"},
            "contents": {"locations": 1},
            "images": {"detail": "full", "files": 0, "bytes": 0, "layers": []},
            "files": 4, "bytes": 100
        })
    }

    /// Writes a pack file with this description and a game with no map:
    /// its manifest, empty map and layer lists and one location.
    pub(crate) fn write(path: &Path, header: &Value) {
        let id = header["packId"].as_str().unwrap();
        let title = header["title"].as_str().unwrap();
        let manifest = json!({"schemaVersion": 2, "gameId": id, "title": title, "packVersion": "1.0.0",
                              "gamePatch": "1", "attribution": [], "idMigrations": {}});
        let entries: [(&str, String); 4] = [
            ("manifest.json", manifest.to_string()),
            ("maps.json", "[]".to_owned()),
            ("layers.json", "[]".to_owned()),
            (
                "locations.json",
                json!([{"id": format!("{id}:location:well")}]).to_string(),
            ),
        ];
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file(super::HEADER_FILE, options).unwrap();
        zip.write_all(header.to_string().as_bytes()).unwrap();
        for (name, text) in entries {
            zip.start_file(name, options).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
}
