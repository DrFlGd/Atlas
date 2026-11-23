//! A pack file (`.atlaspack`) read where it lies, without unpacking it and
//! without writing anything beside it.
//!
//! Opening the file reads its description (the first entry, see the
//! `atlas-pack` crate) and its list of contents (the ZIP central directory,
//! ZIP64 too, read from the directory alone) and checks every entry with
//! the rules an import uses (see [`super::import::Rules`] and
//! [`super::import::check_entry`]): an entry with no place in a pack, an
//! unsafe name, a link, another packing method or a size over the limits
//! refuses the whole file. The content of each file is checked at its
//! first whole read instead, as an import checks it: a JSON file must be
//! JSON and a status file one of its layer, and every entry read whole must
//! match its checksum. An entry that fails is never served, and the file is
//! remembered as unusable, with the import's sentence, until it changes. A
//! byte range of a stored entry is read as it is, not checked against its
//! checksum.
//!
//! A Library scan keeps only a light [`Checked`] state of each file: what
//! tells the file apart from a changed one, and its description. The table
//! of contents (entry name to where its local header is, its stored and
//! unpacked length, its packing and its checksum) is built again when the
//! pack is read, and only the tables of the packs read last are kept, up
//! to a number of tables and of entries in all ([`OPEN_TABLES`],
//! [`OPEN_ENTRIES`]), with one budget for unpacked JSON files across all
//! of them ([`CACHE_BYTES`]); see [`Pool`]. Nothing the checks read is
//! kept.
//!
//! An entry's data starts after its local header, whose length is only
//! known by reading it: that happens at its first read, and the offset is
//! kept. Stored entries (the map images and pictures) and byte ranges of
//! them are read with positioned reads on a handle opened for the request,
//! with no lock around the file. Deflated entries (the JSON files) are
//! unpacked whole, within the size the table allows.
//!
//! The file belongs to the person or another app, which may replace it
//! while Atlas runs (writing a `.part` file beside it and renaming that
//! over it). Every request opens the file again and compares that handle's
//! length and modified time, the end record of its central directory (with
//! the ZIP64 locator and end record when there are), and the first record
//! of the directory, which holds the description's checksum, with those
//! the table was built from; when one differs, the table is built again
//! from that same handle. A request is answered from one handle and the
//! table of that handle's file, so a replaced file is never read with the
//! old file's table. A file rewritten in place that keeps all of these
//! (its length, its time, and a description that did not change) is not
//! noticed; each file Atlas writes has its own description, which says
//! when it was made.
//!
//! A failure of the file's content is remembered until the file changes,
//! so a broken file is not read again for every request. A failure to read
//! it (a file in use, a drive that went away) is not: it is told for that
//! request or scan and tried again the next time.

use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock, PoisonError, RwLock, Weak,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use flate2::{read::DeflateDecoder, Crc};
use zip::{CompressionMethod, ZipArchive};

use super::{
    import::{check_count, check_entry, check_json, EntryFacts, Kind, PackEntries, Rules, Tally},
    Header, Stop, HEADER_FILE,
};
use crate::packs::is_valid_pack_id;

/// The most tables of contents kept, of the pack files read last.
pub const OPEN_TABLES: usize = 24;
/// The most entries in the tables kept, in all (about 120 bytes each): a
/// game's small packs stay open side by side, and a pack of many map
/// images pushes out the ones read before it. The table of the pack file
/// read last is kept whatever its size.
pub const OPEN_ENTRIES: usize = 400_000;
/// Unpacked JSON files kept in memory, in bytes, for all pack files
/// together. A file that does not fit is unpacked again at each read.
pub const CACHE_BYTES: usize = 64 << 20;

const NOT_A_PACK_FILE: &str = "This file is not an Atlas pack file.";
const DAMAGED_LIST: &str = "This pack file is damaged: its list of contents cannot be read.";
const NOT_A_PLAIN_FILE: &str = "it is not a plain file";
/// Signature of a ZIP local file header.
const LOCAL_HEADER: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];
/// Signature of a record of the ZIP central directory, and its length
/// before the name.
const DIRECTORY_RECORD: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
const DIRECTORY_RECORD_LEN: usize = 46;
/// Signature of the ZIP end of central directory record.
const END_RECORD: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const END_RECORD_LEN: usize = 22;
/// The ZIP64 end of central directory locator, right before the end record.
const ZIP64_LOCATOR: [u8; 4] = [0x50, 0x4b, 0x06, 0x07];
const ZIP64_LOCATOR_LEN: usize = 20;
/// The ZIP64 end of central directory record, its fixed part.
const ZIP64_END_RECORD: [u8; 4] = [0x50, 0x4b, 0x06, 0x06];
const ZIP64_END_RECORD_LEN: usize = 56;

static NEXT_TABLE: AtomicU64 = AtomicU64::new(1);

/// The tables of contents and unpacked files kept for the pack files of
/// one Library: the tables of the pack files read last (at most
/// [`OPEN_TABLES`], with [`OPEN_ENTRIES`] entries in all),
/// and their unpacked JSON files within one budget.
#[derive(Debug)]
pub struct Pool {
    max_tables: usize,
    max_entries: usize,
    max_bytes: usize,
    held: Mutex<Held>,
}

#[derive(Debug, Default)]
struct Held {
    /// The one read last at the back.
    tables: VecDeque<Arc<Table>>,
    /// Unpacked entries by their table's id and name.
    cache: HashMap<(u64, Box<str>), Arc<Vec<u8>>>,
    bytes: usize,
}

impl Default for Pool {
    fn default() -> Self {
        Self::with_limits(OPEN_TABLES, OPEN_ENTRIES, CACHE_BYTES)
    }
}

impl Pool {
    /// A pool with the usual limits.
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A pool of at most `max_tables` tables with `max_entries` entries in
    /// all, and `max_bytes` unpacked bytes.
    pub fn with_limits(max_tables: usize, max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_tables,
            max_entries,
            max_bytes,
            held: Mutex::new(Held::default()),
        }
    }

    /// Keeps `table` as the one read last; the one read longest ago goes
    /// when there are too many, with its unpacked files.
    fn hold(&self, table: &Arc<Table>) {
        let mut held = lock(&self.held);
        if let Some(at) = held.tables.iter().position(|it| Arc::ptr_eq(it, table)) {
            if at + 1 == held.tables.len() {
                return;
            }
            let it = held.tables.remove(at).expect("in the list");
            held.tables.push_back(it);
            return;
        }
        held.tables.push_back(Arc::clone(table));
        held.trim(self.max_tables, self.max_entries);
    }

    /// Lets go of a table and its unpacked files.
    fn release(&self, id: u64) {
        let mut held = lock(&self.held);
        held.tables.retain(|table| table.id != id);
        held.forget_cache(id);
    }

    fn cached(&self, id: u64, name: &str) -> Option<Arc<Vec<u8>>> {
        lock(&self.held).cache.get(&(id, name.into())).cloned()
    }

    /// Keeps an unpacked entry of a table that is held, while the budget
    /// has room.
    fn keep(&self, id: u64, name: &str, bytes: &Arc<Vec<u8>>) {
        let mut held = lock(&self.held);
        if !held.tables.iter().any(|table| table.id == id)
            || held.bytes + bytes.len() > self.max_bytes
        {
            return;
        }
        if held
            .cache
            .insert((id, name.into()), Arc::clone(bytes))
            .is_none()
        {
            held.bytes += bytes.len();
        }
    }

    /// The tables held.
    #[cfg(test)]
    pub(crate) fn held_tables(&self) -> usize {
        lock(&self.held).tables.len()
    }

    /// The unpacked bytes held.
    #[cfg(test)]
    pub(crate) fn held_bytes(&self) -> usize {
        lock(&self.held).bytes
    }
}

impl Held {
    /// Lets go of the tables read longest ago while there are too many, or
    /// too many entries in all; the one read last stays.
    fn trim(&mut self, max_tables: usize, max_entries: usize) {
        loop {
            let entries: usize = self.tables.iter().map(|table| table.entries.len()).sum();
            let over =
                self.tables.len() > max_tables || (self.tables.len() > 1 && entries > max_entries);
            if !over {
                return;
            }
            let old = self.tables.pop_front().expect("more than none");
            self.forget_cache(old.id);
        }
    }

    fn forget_cache(&mut self, id: u64) {
        let mut freed = 0;
        self.cache.retain(|(table, _), bytes| {
            let keep = *table != id;
            if !keep {
                freed += bytes.len();
            }
            keep
        });
        self.bytes -= freed;
    }
}

/// A pack file the Library found, read in place.
#[derive(Debug)]
pub struct PackFile {
    path: PathBuf,
    pool: Arc<Pool>,
    state: Arc<RwLock<State>>,
    /// Held while the table is built, so parallel requests build it once.
    building: Mutex<()>,
}

#[derive(Debug)]
enum State {
    Unread,
    /// The file passed the checks; its table, while the pool keeps it.
    Known {
        checked: Arc<Checked>,
        table: Weak<Table>,
    },
    /// The file with this length, time and marks cannot be used, for this
    /// reason (its content, never a failure to read it).
    Failed {
        stamp: Stamp,
        marks: Option<Marks>,
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
    fn of(metadata: &fs::Metadata) -> Self {
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

/// Bytes at fixed places of the file that change with its list of
/// contents: the end record (with the ZIP64 locator before it), the ZIP64
/// end record when there is one, and the first record of the central
/// directory, which holds the description's checksum.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Marks(Vec<(u64, Box<[u8]>)>);

impl Marks {
    /// Whether `file` has the same bytes at the same places.
    fn found_in(&self, file: &File) -> bool {
        self.0.iter().all(|(at, bytes)| {
            let mut read = vec![0; bytes.len()];
            read_exact_at(file, &mut read, *at).is_ok() && read[..] == bytes[..]
        })
    }
}

/// A pack file that passed the checks: what tells it apart from a changed
/// one, and its description. What the Library keeps of a file not read.
#[derive(Debug)]
pub struct Checked {
    stamp: Stamp,
    marks: Marks,
    header: Header,
    /// Its manifest says the game was made in the app (`madeInApp`), which
    /// the description does not say.
    made_in_app: bool,
}

impl Checked {
    /// The pack file's description.
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// Whether its manifest says the game was made in the app.
    pub fn made_in_app(&self) -> bool {
        self.made_in_app
    }
}

/// Why a file cannot be opened.
enum Fault {
    /// Its content: remembered until it changes.
    Content(String),
    /// Reading it: told, and tried again next time.
    Io(io::Error),
}

/// What is known of a file a handle reads.
enum Lookup {
    Table(Arc<Table>),
    Checked(Arc<Checked>),
    Failed(String),
    Unknown,
}

/// The table of one version of a pack file.
#[derive(Debug)]
pub struct Table {
    /// Its key in the pool.
    id: u64,
    checked: Arc<Checked>,
    /// Where the central directory starts: no entry's data goes past it.
    directory_start: u64,
    entries: HashMap<Box<str>, Item>,
    /// The ids of the pack's layers, for its status files.
    layer_ids: Vec<String>,
    /// The state of its pack file, told when its content fails.
    owner: Weak<RwLock<State>>,
    pool: Weak<Pool>,
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
    serve: Serve,
    /// Where its data starts, found at its first read.
    data_start: OnceLock<u64>,
}

/// Whether an entry is served, and what its content must be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Serve {
    /// The small pictures, the person's own things (`mine/`) and the
    /// description: not files a pack folder holds.
    No,
    /// A map image, a marker or a picture.
    Bytes,
    /// One of the pack's JSON files.
    Json,
    /// The status file of the layer at this place in `layer_ids`.
    Status(u32),
}

impl PackFile {
    pub fn new(path: PathBuf, pool: Arc<Pool>) -> Self {
        Self {
            path,
            pool,
            state: Arc::new(RwLock::new(State::Unread)),
            building: Mutex::new(()),
        }
    }

    /// The pack file's path, as it was found.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Opens the file for one request, with the table of the file that
    /// handle reads. Builds the table again when the file changed or the
    /// pool let it go. Errs with `NotFound` when the file is gone,
    /// `InvalidData` with a plain sentence when it cannot be used, and the
    /// error of reading it when that failed.
    pub fn open(&self) -> io::Result<Opened> {
        let file = open_plain(&self.path)?;
        let stamp = Stamp::of(&file.metadata()?);
        let mut lookup = self.lookup(&file, &stamp);
        if matches!(lookup, Lookup::Checked(_) | Lookup::Unknown) {
            let _building = lock(&self.building);
            // Another request may have built it from the same file meanwhile.
            lookup = self.lookup(&file, &stamp);
            if matches!(lookup, Lookup::Checked(_) | Lookup::Unknown) {
                let table = self
                    .build(&file, stamp, true)
                    .map_err(|fault| match fault {
                        Fault::Content(reason) => unusable(reason),
                        Fault::Io(error) => error,
                    })?;
                return Ok(Opened { file, table });
            }
        }
        match lookup {
            Lookup::Table(table) => {
                self.pool.hold(&table);
                Ok(Opened { file, table })
            }
            Lookup::Failed(reason) => Err(unusable(reason)),
            Lookup::Checked(_) | Lookup::Unknown => unreachable!("built above"),
        }
    }

    /// Checks the file as it is now, for the Library: its description, or
    /// why it cannot be used, in a plain sentence. No table is kept.
    pub fn check(&self) -> Result<Arc<Checked>, String> {
        let opened = open_plain(&self.path).and_then(|file| {
            let stamp = Stamp::of(&file.metadata()?);
            Ok((file, stamp))
        });
        let (file, stamp) = opened.map_err(|error| read_failure(&error))?;
        let mut lookup = self.lookup(&file, &stamp);
        if matches!(lookup, Lookup::Unknown) {
            let _building = lock(&self.building);
            lookup = self.lookup(&file, &stamp);
            if matches!(lookup, Lookup::Unknown) {
                return match self.build(&file, stamp, false) {
                    Ok(table) => Ok(Arc::clone(&table.checked)),
                    Err(Fault::Content(reason)) => Err(reason),
                    Err(Fault::Io(error)) => Err(read_failure(&error)),
                };
            }
        }
        match lookup {
            Lookup::Table(table) => Ok(Arc::clone(&table.checked)),
            Lookup::Checked(checked) => Ok(checked),
            Lookup::Failed(reason) => Err(reason),
            Lookup::Unknown => unreachable!("built above"),
        }
    }

    /// Whether the pool keeps a table of this file.
    #[cfg(test)]
    pub(crate) fn holds_table(&self) -> bool {
        matches!(&*read(&self.state), State::Known { table, .. } if table.strong_count() > 0)
    }

    /// What is known of the file `file` reads.
    fn lookup(&self, file: &File, stamp: &Stamp) -> Lookup {
        enum Seen {
            Known(Arc<Checked>, Weak<Table>),
            Failed(Option<Marks>, String),
        }
        let seen = match &*read(&self.state) {
            State::Unread => return Lookup::Unknown,
            State::Known { checked, table } if checked.stamp == *stamp => {
                Seen::Known(Arc::clone(checked), Weak::clone(table))
            }
            State::Failed {
                stamp: failed,
                marks,
                reason,
            } if failed == stamp => Seen::Failed(marks.clone(), reason.clone()),
            State::Known { .. } | State::Failed { .. } => return Lookup::Unknown,
        };
        // Read outside the lock.
        match seen {
            Seen::Known(checked, table) if checked.marks.found_in(file) => table
                .upgrade()
                .map_or(Lookup::Checked(checked), Lookup::Table),
            Seen::Failed(marks, reason) if marks.as_ref().is_none_or(|it| it.found_in(file)) => {
                Lookup::Failed(reason)
            }
            Seen::Known(..) | Seen::Failed(..) => Lookup::Unknown,
        }
    }

    /// Builds the table of the file `file` reads and remembers the
    /// outcome; with `keep`, the pool keeps the table.
    fn build(&self, file: &File, stamp: Stamp, keep: bool) -> Result<Arc<Table>, Fault> {
        let mut marks = None;
        match Table::build(file, stamp.clone(), &mut marks) {
            Ok(mut table) => {
                if keep {
                    table.owner = Arc::downgrade(&self.state);
                    table.pool = Arc::downgrade(&self.pool);
                }
                let table = Arc::new(table);
                let held = if keep {
                    Arc::downgrade(&table)
                } else {
                    Weak::new()
                };
                self.set(State::Known {
                    checked: Arc::clone(&table.checked),
                    table: held,
                });
                if keep {
                    self.pool.hold(&table);
                }
                Ok(table)
            }
            Err(Fault::Content(reason)) => {
                self.set(State::Failed {
                    stamp,
                    marks,
                    reason: reason.clone(),
                });
                Err(Fault::Content(reason))
            }
            Err(fault) => Err(fault),
        }
    }

    /// Replaces the state; the pool lets go of the table of the old one.
    fn set(&self, state: State) {
        let old = std::mem::replace(&mut *write(&self.state), state);
        if let State::Known { table, .. } = old {
            if let Some(table) = table.upgrade() {
                self.pool.release(table.id);
            }
        }
    }
}

impl Table {
    /// Reads the file's description and list of contents and checks every
    /// entry; `marks` gets what tells this file from a changed one as soon
    /// as it is known.
    fn build(file: &File, stamp: Stamp, marks: &mut Option<Marks>) -> Result<Self, Fault> {
        let content = |reason: &str| Fault::Content(reason.to_owned());
        let mut at = At::new(file, 0, stamp.len);
        let header = match super::import::read_header_from(&mut at) {
            Ok(header) => header,
            Err(reason) => {
                return Err(at.os_error.take().map_or(Fault::Content(reason), Fault::Io))
            }
        };
        if !is_valid_pack_id(&header.pack_id) {
            return Err(content(
                "This pack file names a game id that Atlas cannot use.",
            ));
        }
        let (tail_at, tail) = find_tail(file, stamp.len)?;

        let mut at = At::new(file, 0, stamp.len);
        let archive = match ZipArchive::new(BufReader::new(&mut at)) {
            Ok(archive) => archive,
            Err(_) => return Err(at.os_error.take().map_or(content(DAMAGED_LIST), Fault::Io)),
        };
        // The description is the first entry, at the very start: nothing
        // comes before the archive.
        if archive.offset() != 0 {
            return Err(content(NOT_A_PACK_FILE));
        }
        let count = archive.len();
        check_count(count).map_err(|stop| Fault::Content(stop.message()))?;
        if archive.has_duplicate_names() {
            return Err(content("This pack file holds a file twice."));
        }
        let directory_start = archive.central_directory_start();
        let mut raw = Vec::with_capacity(count);
        for index in 0..count {
            // From the central directory alone; no local header is read.
            let entry = archive
                .by_index_data(index)
                .map_err(|_| content(DAMAGED_LIST))?;
            let name = entry.name().map_err(|_| unreadable_name())?;
            // The name as the local header has it: one that is not UTF-8
            // as it stands is not read (Atlas writes UTF-8 names).
            if name.as_bytes() != entry.name_raw() {
                return Err(unreadable_name());
            }
            // The description the directory lists first is the one read
            // from the start of the file.
            if index == 0 && (name != HEADER_FILE || entry.header_start() != 0) {
                return Err(content(NOT_A_PACK_FILE));
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
        let found = Marks::read(file, tail_at, tail, directory_start)?;
        *marks = Some(found.clone());

        let mut entries: HashMap<Box<str>, Item> = HashMap::with_capacity(count);
        for entry in &raw {
            if entry.header_start >= directory_start {
                return Err(content(DAMAGED_LIST));
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
                    serve: Serve::No,
                    data_start: OnceLock::new(),
                },
            );
        }
        let mut table = Self {
            id: NEXT_TABLE.fetch_add(1, Ordering::Relaxed),
            checked: Arc::new(Checked {
                stamp,
                marks: found,
                header,
                made_in_app: false,
            }),
            directory_start,
            entries,
            layer_ids: Vec::new(),
            owner: Weak::new(),
            pool: Weak::new(),
        };

        // The pack's own files say what else it may hold.
        let mut reading = TableEntries {
            table: &table,
            file,
            os_error: None,
        };
        let rules = match Rules::read(&table.checked.header, &mut reading) {
            Ok(rules) => rules,
            Err(stop) => {
                return Err(reading
                    .os_error
                    .take()
                    .map_or_else(|| Fault::Content(stop.message()), Fault::Io))
            }
        };
        table.layer_ids = rules.layers.iter().map(|layer| layer.id.clone()).collect();
        // Not shared yet while the table is built.
        if let Some(checked) = Arc::get_mut(&mut table.checked) {
            checked.made_in_app = rules.made_in_app;
        }
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
            let kind = check_entry(&rules, &mut tally, &facts)
                .map_err(|stop| Fault::Content(stop.message()))?;
            let Some(kind) = kind else {
                continue;
            };
            let item = table
                .entries
                .get_mut(entry.name.as_str())
                .expect("every file entry is in the table");
            // A stored entry is as long in the file as unpacked.
            if !item.deflated && item.stored != item.size {
                return Err(Fault::Content(damaged(&entry.name)));
            }
            item.serve = match kind {
                Kind::PackFile => Serve::Json,
                Kind::Status(layer) => {
                    Serve::Status(u32::try_from(layer).map_err(|_| content(NOT_A_PACK_FILE))?)
                }
                Kind::Image
                | Kind::Marker
                | Kind::Picture
                | Kind::Scene
                | Kind::Guidebook
                | Kind::GuidebookText => Serve::Bytes,
                Kind::Mine(_) | Kind::MinePicture | Kind::Preview => Serve::No,
            };
        }
        Ok(table)
    }

    /// Where an entry's data starts, from its local header at the first
    /// read. The local header must name the same entry with the same
    /// packing, and the data must end before the central directory.
    fn data_start(&self, file: &File, name: &str, item: &Item) -> Result<u64, Fault> {
        if let Some(&start) = item.data_start.get() {
            return Ok(start);
        }
        let mut local = vec![0u8; 30 + name.len()];
        read_exact_at(file, &mut local, item.header_start)
            .map_err(|error| read_fault(error, damaged(name)))?;
        let u16_at = |at: usize| u64::from(u16::from_le_bytes([local[at], local[at + 1]]));
        let method = if item.deflated { 8 } else { 0 };
        if local[..4] != LOCAL_HEADER
            || u16_at(8) != method
            || u16_at(26) != name.len() as u64
            || &local[30..] != name.as_bytes()
        {
            return Err(Fault::Content(damaged(name)));
        }
        let start = item.header_start + 30 + u16_at(26) + u16_at(28);
        if start
            .checked_add(item.stored)
            .is_none_or(|end| end > self.directory_start)
        {
            return Err(Fault::Content(damaged(name)));
        }
        Ok(*item.data_start.get_or_init(|| start))
    }

    /// An entry's bytes, unpacked and checked against its checksum, and a
    /// JSON file's content as an import checks it; a JSON file is kept
    /// while this table is held and the pool's budget has room.
    fn whole(&self, file: &File, name: &str, item: &Item) -> Result<Arc<Vec<u8>>, Fault> {
        let json = matches!(item.serve, Serve::Json | Serve::Status(_));
        let pool = self.pool.upgrade();
        if json {
            if let Some(bytes) = pool.as_ref().and_then(|pool| pool.cached(self.id, name)) {
                return Ok(bytes);
            }
        }
        let start = self.data_start(file, name, item)?;
        let capacity = usize::try_from(item.size).map_err(|_| Fault::Content(damaged(name)))?;
        let mut bytes = Vec::with_capacity(capacity);
        let mut stored = At::new(file, start, start + item.stored);
        let read = if item.deflated {
            DeflateDecoder::new(&mut stored)
                .take(item.size + 1)
                .read_to_end(&mut bytes)
        } else {
            (&mut stored).take(item.size + 1).read_to_end(&mut bytes)
        };
        if read.is_err() {
            return Err(stored
                .os_error
                .take()
                .map_or_else(|| Fault::Content(damaged(name)), Fault::Io));
        }
        let mut crc = Crc::new();
        crc.update(&bytes);
        if bytes.len() as u64 != item.size || crc.sum() != item.crc32 {
            return Err(Fault::Content(damaged(name)));
        }
        let checked = match item.serve {
            Serve::Json => check_json(name, &bytes, None),
            Serve::Status(layer) => check_json(
                name,
                &bytes,
                self.layer_ids.get(layer as usize).map(String::as_str),
            ),
            Serve::No | Serve::Bytes => Ok(()),
        };
        checked.map_err(|stop| Fault::Content(stop.message()))?;
        let bytes = Arc::new(bytes);
        if json {
            if let Some(pool) = pool {
                pool.keep(self.id, name, &bytes);
            }
        }
        Ok(bytes)
    }

    /// The error a request gets for `fault`. A failure of the content is
    /// remembered for this version of the file, so it is never served and
    /// the next scan lists it with the reason; the pool lets go of the
    /// table.
    fn failed(&self, fault: Fault) -> io::Error {
        let reason = match fault {
            Fault::Io(error) => return error,
            Fault::Content(reason) => reason,
        };
        if let Some(owner) = self.owner.upgrade() {
            let mut state = write(&owner);
            if matches!(&*state, State::Known { checked, .. } if Arc::ptr_eq(checked, &self.checked))
            {
                *state = State::Failed {
                    stamp: self.checked.stamp.clone(),
                    marks: Some(self.checked.marks.clone()),
                    reason: reason.clone(),
                };
            }
        }
        if let Some(pool) = self.pool.upgrade() {
            pool.release(self.id);
        }
        unusable(reason)
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

/// The entries of a table being built, for the rules.
struct TableEntries<'a> {
    table: &'a Table,
    file: &'a File,
    /// A failure to read the file, which is not its content's.
    os_error: Option<io::Error>,
}

impl PackEntries for TableEntries<'_> {
    fn has(&mut self, name: &str) -> bool {
        self.table.entries.contains_key(name)
    }

    fn read(&mut self, name: &str, cap: u64) -> Result<Vec<u8>, Stop> {
        let item = self
            .table
            .entries
            .get(name)
            .ok_or_else(|| Stop::Failed(damaged(name)))?;
        if item.size > cap {
            return Err(Stop::Failed(format!(
                "{} in this pack file is too large.",
                crate::activity::clean(name)
            )));
        }
        match self.table.whole(self.file, name, item) {
            Ok(bytes) => Ok(Arc::try_unwrap(bytes).unwrap_or_else(|bytes| bytes.to_vec())),
            Err(Fault::Content(reason)) => Err(Stop::Failed(reason)),
            Err(Fault::Io(error)) => {
                self.os_error = Some(error);
                Err(Stop::Failed(damaged(name)))
            }
        }
    }
}

impl Marks {
    /// The marks of a file whose end record is `tail` at `tail_at` and
    /// whose central directory starts at `directory_start`.
    fn read(file: &File, tail_at: u64, tail: Vec<u8>, directory_start: u64) -> Result<Self, Fault> {
        let mut marks = Vec::with_capacity(3);
        if tail.len() == ZIP64_LOCATOR_LEN + END_RECORD_LEN && tail[..4] == ZIP64_LOCATOR {
            let at = u64::from_le_bytes(tail[8..16].try_into().expect("eight bytes"));
            let mut record = vec![0; ZIP64_END_RECORD_LEN];
            match read_exact_at(file, &mut record, at) {
                Ok(()) if record[..4] == ZIP64_END_RECORD => {
                    marks.push((at, record.into_boxed_slice()));
                }
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {}
                Err(error) => return Err(Fault::Io(error)),
            }
        }
        marks.push((tail_at, tail.into_boxed_slice()));
        let mut first = vec![0; DIRECTORY_RECORD_LEN];
        read_exact_at(file, &mut first, directory_start)
            .map_err(|error| read_fault(error, DAMAGED_LIST.to_owned()))?;
        if first[..4] != DIRECTORY_RECORD {
            return Err(Fault::Content(DAMAGED_LIST.to_owned()));
        }
        marks.push((directory_start, first.into_boxed_slice()));
        Ok(Self(marks))
    }
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
        &self.table.checked.header
    }

    /// The unpacked length of an entry that is served; none for another
    /// name.
    pub fn size(&self, name: &str) -> Option<u64> {
        self.served(name).map(|item| item.size)
    }

    /// A tag that changes when the entry or the file does.
    pub fn etag(&self, name: &str) -> String {
        let (at, crc) = self
            .table
            .entries
            .get(name)
            .map_or((0, 0), |item| (item.header_start, item.crc32));
        let stamp = &self.table.checked.stamp;
        format!("\"{:x}-{:x}-{at:x}-{crc:08x}\"", stamp.len, stamp.nanos())
    }

    fn served(&self, name: &str) -> Option<&Item> {
        self.table
            .entries
            .get(name)
            .filter(|item| item.serve != Serve::No)
    }

    /// `count` bytes of a served entry from `start` (within its length).
    /// A JSON file and a deflated entry are read whole and checked; a
    /// stored entry read whole is checked against its checksum, and a byte
    /// range of one is read as it is, with one positioned read.
    pub fn read(&self, name: &str, start: u64, count: u64) -> io::Result<Vec<u8>> {
        let item = self.served(name).ok_or(io::ErrorKind::NotFound)?;
        let end = start
            .checked_add(count)
            .filter(|&end| end <= item.size)
            .ok_or_else(|| invalid("a read past the end of an entry"))?;
        if item.deflated || item.serve != Serve::Bytes || (start == 0 && end == item.size) {
            let whole = self
                .table
                .whole(&self.file, name, item)
                .map_err(|fault| self.table.failed(fault))?;
            let part = usize::try_from(start)
                .ok()
                .zip(usize::try_from(end).ok())
                .and_then(|(start, end)| whole.get(start..end))
                .ok_or_else(|| invalid("a read past the end of an entry"))?;
            return Ok(part.to_vec());
        }
        let data = self
            .table
            .data_start(&self.file, name, item)
            .map_err(|fault| self.table.failed(fault))?;
        let mut bytes =
            vec![0u8; usize::try_from(count).map_err(|_| invalid("a read is too large"))?];
        read_exact_at(&self.file, &mut bytes, data + start)?;
        Ok(bytes)
    }
}

/// Opens a pack file that is a plain file. A pipe or a device put in its
/// place is not opened: opening or reading one could wait for ever.
fn open_plain(path: &Path) -> io::Result<File> {
    let not_plain = || io::Error::new(io::ErrorKind::InvalidInput, NOT_A_PLAIN_FILE);
    if !fs::metadata(path)?.is_file() {
        return Err(not_plain());
    }
    let file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(not_plain());
    }
    Ok(file)
}

/// The Library's sentence for a pack file that could not be read.
fn read_failure(error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "The pack file cannot be found.".to_owned(),
        io::ErrorKind::InvalidInput => {
            "This is not a plain file, so Atlas does not read it as a pack file.".to_owned()
        }
        _ => format!(
            "The pack file cannot be read just now ({error}). Atlas tries again at the next refresh."
        ),
    }
}

/// A failure to read: the file ended early is its content's fault, any
/// other is reading's.
fn read_fault(error: io::Error, reason: String) -> Fault {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        Fault::Content(reason)
    } else {
        Fault::Io(error)
    }
}

/// Finds the end record of the central directory: the last 22 to 65,557
/// bytes of the file hold it, with a comment of the length it says after
/// it. Its bytes, and the ZIP64 locator's before it, are among what tells
/// this version of the file from a changed one.
fn find_tail(file: &File, len: u64) -> Result<(u64, Vec<u8>), Fault> {
    let not_ours = || Fault::Content(NOT_A_PACK_FILE.to_owned());
    let window = len.min(END_RECORD_LEN as u64 + u64::from(u16::MAX));
    if window < END_RECORD_LEN as u64 {
        return Err(not_ours());
    }
    let mut bytes = vec![0u8; usize::try_from(window).map_err(|_| not_ours())?];
    read_exact_at(file, &mut bytes, len - window)
        .map_err(|error| read_fault(error, NOT_A_PACK_FILE.to_owned()))?;
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

/// Reads the file from `at` up to `end` with positioned reads, and keeps
/// the first failure to read that is not the file ending early.
struct At<'a> {
    file: &'a File,
    at: u64,
    end: u64,
    os_error: Option<io::Error>,
}

impl<'a> At<'a> {
    fn new(file: &'a File, at: u64, end: u64) -> Self {
        Self {
            file,
            at,
            end,
            os_error: None,
        }
    }
}

impl Read for At<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let left = usize::try_from(self.end.saturating_sub(self.at)).unwrap_or(usize::MAX);
        let want = buffer.len().min(left).min(64 << 10);
        if want == 0 {
            return Ok(0);
        }
        if let Err(error) = read_exact_at(self.file, &mut buffer[..want], self.at) {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                return Err(error);
            }
            let told = error.raw_os_error().map_or_else(
                || io::Error::new(error.kind(), error.to_string()),
                io::Error::from_raw_os_error,
            );
            self.os_error.get_or_insert(error);
            return Err(told);
        }
        self.at += want as u64;
        Ok(want)
    }
}

impl Seek for At<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let at = match to {
            SeekFrom::Start(at) => Some(at),
            SeekFrom::End(by) => self.end.checked_add_signed(by),
            SeekFrom::Current(by) => self.at.checked_add_signed(by),
        };
        self.at = at.ok_or(io::ErrorKind::InvalidInput)?;
        Ok(self.at)
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

fn read<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}

fn unusable(reason: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("The pack file is damaged: {what}."),
    )
}

fn unreadable_name() -> Fault {
    Fault::Content("This pack file holds a file with an unreadable name.".to_owned())
}

fn damaged(name: &str) -> String {
    format!(
        "This pack file is damaged: {} cannot be read in full.",
        crate::activity::clean(name)
    )
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
        write_with(path, header, &[]);
    }

    /// [`write`], with more JSON files after the others.
    pub(crate) fn write_with(path: &Path, header: &Value, more: &[(&str, String)]) {
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
        for (name, text) in entries
            .iter()
            .map(|(name, text)| (*name, text))
            .chain(more.iter().map(|(name, text)| (*name, text)))
        {
            zip.start_file(name, options).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
}
