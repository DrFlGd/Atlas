//! Reading a map pack file: its header alone, or the whole file into the
//! maps folder.
//!
//! The file is untrusted. Before anything is written, every entry is
//! checked: its name must be a plain relative path (no `..`, no absolute
//! path or drive letter, no hidden segment such as `.atlas`, no `\`), and
//! one of the pack's JSON files, a layer's status file, or a map image at
//! a place one of the pack's own layer templates gives (or its "not on the
//! server" marker), or a picture its `pictures.json` lists, or one of the
//! person's own files (`mine/`, checked to be this game's and kept apart,
//! never written into the pack's folder); no symbolic links; sizes within
//! limits; the manifest's pack id the header's. Then there must be room on
//! the disk for all of it.
//! The pack is unpacked into a hidden folder in the maps folder and moved
//! into place only when complete, so a failure or a cancel leaves nothing
//! half written.

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use serde_json::Value;
use zip::ZipArchive;

use super::{
    is_picture_path, parse_header, parse_layers, space, Header, ImportedRecord, LayerInfo, Mine,
    Progress, Stop, TileKind, HEADER_FILE, IMPORTED_RECORD, MAX_HEADER_BYTES, MAX_PICTURE_BYTES,
    MINE_ENTRIES, PICTURES_FILE,
};
use crate::{
    library::{packs_in, PackLock, MAX_PACK_BYTES, MAX_PACK_FILE_BYTES, META_DIR, PACK_FILES},
    manifest::{now_rfc3339, read_head, MANIFEST_FILE, MAX_MANIFEST_BYTES},
    ownlists::MAX_OWN_LISTS_BYTES,
    packs::is_valid_pack_id,
    removal::{self, is_real_dir, FileOps},
    tiles::{
        pyramid::relative_path,
        status::{LayerStatus, STATUS_DIR, STATUS_FORMAT},
        store::MISSING_SUFFIX,
    },
};

/// Name prefix of the hidden folder a pack is unpacked into.
pub const IMPORTING_PREFIX: &str = ".importing-";
/// A map image larger than this is not one (the downloader's limit).
const MAX_IMAGE_BYTES: u64 = 16 << 20;
/// A status file larger than this is not one.
const MAX_STATUS_BYTES: u64 = 1 << 20;
/// More entries than this is not a map pack file.
const MAX_ENTRIES: usize = 4_000_000;
/// Room kept free on the disk besides the unpacked files.
pub(crate) const SPACE_MARGIN: u64 = 64 << 20;

const NOT_A_PACK_FILE: &str = "This file is not an Atlas map pack file.";

/// A finished import.
#[derive(Clone, Debug)]
pub struct Imported {
    pub pack_id: String,
    pub title: String,
    /// The pack's folder in the maps folder.
    pub folder: PathBuf,
    /// A pack with this id was there and was replaced (in the same folder).
    pub replaced: bool,
    pub header: Header,
    /// The person's own lists, locations and types the file carried, checked
    /// to be this game's. They are not written anywhere: the caller adds
    /// them to what the person has.
    pub mine: Mine,
}

/// Reads a map pack file's header, its first entry, without reading the
/// rest of the file. Refuses a file that is not a map pack file, and one
/// made in a newer version of the format, with a message that names the
/// app that made it.
pub fn read_header(file: &Path) -> Result<Header, String> {
    let opened = File::open(file).map_err(|error| format!("Could not open the file: {error}"))?;
    read_header_from(opened)
}

/// [`read_header`] from the start of a file being read in order, such as
/// one Android's picker opened, which may not be able to seek: only the
/// first entry is read.
pub fn read_header_from(file: impl Read) -> Result<Header, String> {
    let mut reader = BufReader::new(file);
    let mut entry = match zip::read::read_zipfile_from_stream(&mut reader) {
        Ok(Some(entry)) => entry,
        _ => return Err(NOT_A_PACK_FILE.to_owned()),
    };
    if entry.name().ok().as_deref() != Some(HEADER_FILE) || entry.size() > MAX_HEADER_BYTES {
        return Err(NOT_A_PACK_FILE.to_owned());
    }
    let mut text = String::new();
    (&mut entry)
        .take(MAX_HEADER_BYTES)
        .read_to_string(&mut text)
        .map_err(|_| NOT_A_PACK_FILE.to_owned())?;
    parse_header(&text)
}

/// The existing folder of a pack id in the maps folder, if any: one whose
/// manifest names it (whatever the folder is called), else `<id>` itself
/// when a folder or file of that name is there.
pub fn existing_folder(maps_folder: &Path, pack_id: &str) -> Result<Option<PathBuf>, String> {
    if let Some((dir, _)) = packs_in(maps_folder)
        .0
        .into_iter()
        .find(|(_, head)| head.id == pack_id)
    {
        return Ok(Some(dir));
    }
    let named = maps_folder.join(pack_id);
    if fs::symlink_metadata(&named).is_ok() {
        return Err(format!(
            "The maps folder already has a folder called {pack_id} that is not this game's map pack, so nothing was imported. Move or rename that folder first."
        ));
    }
    Ok(None)
}

/// Imports a map pack file into the maps folder.
///
/// `file` is the path of an `.atlaspack` file (a file that Android's picker
/// hands over as a `content://` address is to be copied to the app's cache
/// first, and that path passed);
/// `maps_folder` is the folder that holds one folder per pack. The pack
/// goes to `<maps folder>/<pack id>/`, or, when a pack with that id is
/// already in the maps folder, replaces that one in its own folder (same
/// id, so progress such as found marks, which is kept by pack id, stays),
/// under its lock. The caller decides whether a replace is wanted and
/// whether the pack id may be imported at all (packs that come with the
/// app, downloads that are running): see [`super::shell::check_import`].
///
/// `progress` is told after each entry; `cancelled` is asked between
/// entries. A failure or cancel leaves the maps folder as it was.
pub fn import(
    file: &Path,
    maps_folder: &Path,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Imported, Stop> {
    import_with(
        file,
        maps_folder,
        &FileOps::default(),
        &space::available,
        progress,
        cancelled,
    )
}

/// [`import`], with the file operations and the free space check given
/// (tests act out files in use and a full disk).
pub(crate) fn import_with(
    file: &Path,
    maps_folder: &Path,
    ops: &FileOps,
    free_space: &dyn Fn(&Path) -> Option<u64>,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Imported, Stop> {
    let header = read_header(file)?;
    if !is_valid_pack_id(&header.pack_id) {
        return Err(Stop::Failed(
            "This map pack file names a game id that Atlas cannot use.".to_owned(),
        ));
    }
    let opened = File::open(file).map_err(|error| format!("Could not open the file: {error}"))?;
    let mut archive = ZipArchive::new(BufReader::new(opened))
        .map_err(|_| "This map pack file is damaged: its list of contents cannot be read.")
        .map_err(str::to_owned)?;
    let checked = check_entries(&mut archive, &header)?;

    fs::create_dir_all(maps_folder)
        .map_err(|error| format!("Could not create the maps folder: {error}"))?;
    let existing = existing_folder(maps_folder, &header.pack_id)?;
    match free_space(maps_folder) {
        Some(free) if free < checked.bytes.saturating_add(SPACE_MARGIN) => {
            return Err(Stop::Failed(format!(
                "There is not enough free space for this game: it needs {} and the drive of the maps folder has {} free.",
                space::describe(checked.bytes),
                space::describe(free)
            )));
        }
        _ => {}
    }

    let mut temp = TempFolder::create(maps_folder, &header.pack_id, ops)?;
    let mut done = Progress {
        entries_done: 0,
        entries_total: checked.entries.len() as u64,
        bytes_done: 0,
        bytes_total: checked.bytes,
    };
    // Map images first, then the status files, the pack files and the
    // manifest last, so the folder is a pack only once it is complete.
    let order = |kind: &Kind| match kind {
        Kind::Image | Kind::Marker | Kind::Picture => 0,
        Kind::Status(_) => 1,
        Kind::PackFile | Kind::Mine(_) => 2,
    };
    let mut entries: Vec<&Checked> = checked.entries.iter().collect();
    entries.sort_by_key(|entry| (order(&entry.kind), entry.name == MANIFEST_FILE));
    for entry in entries {
        if cancelled() {
            return Err(Stop::Cancelled);
        }
        let target = temp.path.join(relative_path(&entry.name).expect("checked"));
        let written = match &entry.json {
            Some(bytes) => write_new(&target, &mut &bytes[..], entry.size),
            None => {
                let mut zipped = archive
                    .by_index(entry.index)
                    .map_err(|_| damaged(&entry.name))?;
                write_new(&target, &mut zipped, entry.size)
            }
        };
        written.map_err(|error| match error.kind() {
            io::ErrorKind::InvalidData => damaged(&entry.name),
            _ => Stop::Failed(format!("Could not write {}: {error}", entry.name)),
        })?;
        done.entries_done += 1;
        done.bytes_done += entry.size;
        progress(done);
    }
    if cancelled() {
        return Err(Stop::Cancelled);
    }
    let head = read_head(&temp.path)
        .map_err(|reason| format!("The game in this map pack file cannot be used: {reason}."))?;
    if head.id != header.pack_id {
        return Err(Stop::Failed(
            "The game inside this map pack file is not the one its description names.".to_owned(),
        ));
    }
    let record = ImportedRecord {
        imported_at: now_rfc3339(),
        file_name: file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        header: header.clone(),
    };
    let meta = temp.path.join(META_DIR);
    fs::create_dir_all(&meta)
        .and_then(|()| {
            fs::write(
                meta.join(IMPORTED_RECORD),
                serde_json::to_vec_pretty(&record).expect("the record serialises"),
            )
        })
        .map_err(|error| format!("Could not write the pack folder: {error}"))?;

    let (folder, replaced) = match existing {
        Some(dir) => {
            temp.replace(&dir)?;
            (dir, true)
        }
        None => {
            let dir = maps_folder.join(&header.pack_id);
            temp.move_to(&dir)?;
            (dir, false)
        }
    };
    Ok(Imported {
        pack_id: header.pack_id.clone(),
        title: head.title,
        folder,
        replaced,
        header,
        mine: checked.mine,
    })
}

fn damaged(name: &str) -> Stop {
    Stop::Failed(format!(
        "This map pack file is damaged: {} cannot be read in full.",
        crate::activity::clean(name)
    ))
}

/// Copies `size` bytes from `data` into a new file; errs with
/// `InvalidData` when there are more or fewer.
fn write_new(target: &Path, data: &mut dyn Read, size: u64) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = File::create(target)?;
    let copied = io::copy(&mut data.take(size + 1), &mut file)?;
    if copied != size {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "wrong size"));
    }
    file.flush()
}

// ---------------------------------------------------------------------------
// Checking the entries

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    PackFile,
    /// One of a person's own files (`mine/`), by its place in [`MINE_ENTRIES`].
    Mine(usize),
    Status(usize),
    Image,
    Marker,
    /// A picture that `pictures.json` lists.
    Picture,
}

struct Checked {
    index: usize,
    name: String,
    kind: Kind,
    size: u64,
    /// JSON files are read and checked before anything is written.
    json: Option<Vec<u8>>,
}

struct CheckedFile {
    entries: Vec<Checked>,
    bytes: u64,
    /// A person's own files, read in full and kept apart from the pack.
    mine: Mine,
}

fn refuse(message: impl Into<String>) -> Stop {
    Stop::Failed(message.into())
}

/// Reads one entry in full, at most `cap` bytes.
fn read_entry<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    index: usize,
    name: &str,
    cap: u64,
) -> Result<Vec<u8>, Stop> {
    let entry = archive.by_index(index).map_err(|_| damaged(name))?;
    if entry.size() > cap {
        return Err(refuse(format!(
            "{} in this map pack file is too large.",
            crate::activity::clean(name)
        )));
    }
    let size = entry.size();
    let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    entry
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| damaged(name))?;
    if bytes.len() as u64 != size {
        return Err(damaged(name));
    }
    Ok(bytes)
}

fn check_entries<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    header: &Header,
) -> Result<CheckedFile, Stop> {
    let count = archive.len();
    if count == 0 || count > MAX_ENTRIES {
        return Err(refuse(NOT_A_PACK_FILE));
    }
    if archive.name_for_index(0).and_then(Result::ok).as_deref() != Some(HEADER_FILE) {
        return Err(refuse(NOT_A_PACK_FILE));
    }
    let index_of = |archive: &ZipArchive<R>, name: &str| archive.index_for_name(name);
    let manifest_index = index_of(archive, MANIFEST_FILE)
        .ok_or_else(|| refuse("This map pack file has no manifest.json."))?;
    let manifest = read_entry(archive, manifest_index, MANIFEST_FILE, MAX_MANIFEST_BYTES)?;
    let manifest: Value = serde_json::from_slice(&manifest)
        .map_err(|_| refuse("The manifest.json in this map pack file is not valid JSON."))?;
    if !matches!(
        manifest.get("schemaVersion").and_then(Value::as_u64),
        Some(1 | 2)
    ) {
        return Err(refuse(
            "The game in this map pack file uses a pack format this app does not read. Install a newer version of Atlas to open it.",
        ));
    }
    let game_id = manifest.get("gameId").and_then(Value::as_str);
    if game_id != Some(header.pack_id.as_str()) {
        return Err(refuse(
            "The game inside this map pack file is not the one its description names.",
        ));
    }
    let text_of = |archive: &mut ZipArchive<R>, name: &str| -> Result<String, Stop> {
        let index = index_of(archive, name)
            .ok_or_else(|| refuse(format!("This map pack file has no {name}.")))?;
        String::from_utf8(read_entry(
            archive,
            index,
            name,
            MAX_PACK_FILE_BYTES as u64,
        )?)
        .map_err(|_| refuse(format!("The {name} in this map pack file is not text.")))
    };
    // A game with no map has neither file.
    let layers =
        if index_of(archive, "maps.json").is_none() && index_of(archive, "layers.json").is_none() {
            Vec::new()
        } else {
            let maps = text_of(archive, "maps.json")?;
            let layers_text = text_of(archive, "layers.json")?;
            parse_layers(&maps, &layers_text).map_err(refuse)?
        };
    // The pictures it lists, the only ones it may hold.
    let pictures: HashSet<String> = if index_of(archive, PICTURES_FILE).is_some() {
        let text = text_of(archive, PICTURES_FILE)?;
        let list: Vec<Value> = serde_json::from_str(&text).map_err(|_| {
            refuse(format!(
                "The {PICTURES_FILE} in this map pack file is not a list."
            ))
        })?;
        list.iter()
            .filter_map(|picture| picture.get("file").and_then(Value::as_str))
            .filter(|file| is_picture_path(file))
            .map(str::to_owned)
            .collect()
    } else {
        HashSet::new()
    };
    if layers.iter().any(|layer| layer.kind == TileKind::Pmtiles) {
        return Err(refuse(
            "The game in this map pack file keeps its map images in one archive file, which a map pack file does not carry.",
        ));
    }
    let templates: Vec<Template> = layers
        .iter()
        .map(|layer| {
            Template::compile(&layer.url).ok_or_else(|| {
                refuse(format!(
                    "The layer {} in this map pack file names its map images in a way Atlas cannot check.",
                    crate::activity::clean(&layer.label())
                ))
            })
        })
        .collect::<Result<_, _>>()?;

    let mut entries = Vec::new();
    let mut mine = Mine::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut json_bytes: u64 = 0;
    let mut bytes: u64 = 0;
    for index in 1..count {
        let (name, size, kind) = {
            let entry = archive
                .by_index_raw(index)
                .map_err(|_| refuse(NOT_A_PACK_FILE))?;
            let name = entry
                .name()
                .map_err(|_| refuse("This map pack file holds a file with an unreadable name."))?
                .into_owned();
            let shown = crate::activity::clean(&name);
            if entry.is_symlink() {
                return Err(refuse(format!(
                    "This map pack file holds a link ({shown}), which a map pack never has."
                )));
            }
            if !matches!(
                entry.compression(),
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            ) {
                return Err(refuse(format!(
                    "{shown} in this map pack file is packed in a way Atlas does not read."
                )));
            }
            if entry.is_dir() {
                // Folders are made as needed; a folder entry must still be
                // a safe path.
                let trimmed = name.trim_end_matches('/');
                if relative_path(trimmed).is_none() || name.starts_with('/') {
                    return Err(refuse(format!(
                        "This map pack file holds a file outside the pack ({shown})."
                    )));
                }
                continue;
            }
            let kind = classify(&name, &layers, &templates, &pictures).ok_or_else(|| {
                refuse(format!(
                    "This map pack file holds a file that is not part of a map pack ({shown}), so it was not imported."
                ))
            })?;
            (name, entry.size(), kind)
        };
        if !seen.insert(name.to_lowercase()) {
            return Err(refuse(format!(
                "This map pack file holds {} twice.",
                crate::activity::clean(&name)
            )));
        }
        if let Kind::Mine(which) = kind {
            let (_, own) = MINE_ENTRIES[which];
            let shown = crate::activity::clean(&name);
            let data = read_entry(archive, index, &name, MAX_OWN_LISTS_BYTES as u64)?;
            let text = String::from_utf8(data)
                .map_err(|_| refuse(format!("{shown} in this map pack file is not text.")))?;
            own.check(&header.pack_id, &text).map_err(|_| {
                refuse(format!(
                    "{shown} in this map pack file is not this game's {}.",
                    own.what
                ))
            })?;
            *mine.slot(own) = Some(text);
            continue;
        }
        let too_large = match kind {
            Kind::Mine(_) => unreachable!("taken above"),
            Kind::PackFile => size > MAX_PACK_FILE_BYTES as u64,
            Kind::Status(_) => size > MAX_STATUS_BYTES,
            Kind::Image => size > MAX_IMAGE_BYTES,
            Kind::Marker => size > 0,
            Kind::Picture => size > MAX_PICTURE_BYTES,
        };
        if too_large {
            return Err(refuse(format!(
                "{} in this map pack file is too large.",
                crate::activity::clean(&name)
            )));
        }
        let json = match kind {
            Kind::PackFile | Kind::Status(_) => {
                json_bytes += size;
                if json_bytes > MAX_PACK_BYTES as u64 {
                    return Err(refuse("The game in this map pack file is too large."));
                }
                let data = read_entry(archive, index, &name, size)?;
                let value: Value = serde_json::from_slice(&data).map_err(|_| {
                    refuse(format!(
                        "{} in this map pack file is not valid JSON.",
                        crate::activity::clean(&name)
                    ))
                })?;
                if let Kind::Status(layer) = kind {
                    let usable = serde_json::from_value::<LayerStatus>(value).is_ok_and(|status| {
                        status.format == STATUS_FORMAT && status.layer_id == layers[layer].id
                    });
                    if !usable {
                        return Err(refuse(format!(
                            "{} in this map pack file is not a usable status file.",
                            crate::activity::clean(&name)
                        )));
                    }
                }
                Some(data)
            }
            Kind::Image | Kind::Marker | Kind::Picture | Kind::Mine(_) => None,
        };
        bytes = bytes.saturating_add(size);
        entries.push(Checked {
            index,
            name,
            kind,
            size,
            json,
        });
    }
    Ok(CheckedFile {
        entries,
        bytes,
        mine,
    })
}

/// What an entry is, or none when it has no place in a map pack.
fn classify(
    name: &str,
    layers: &[LayerInfo],
    templates: &[Template],
    pictures: &HashSet<String>,
) -> Option<Kind> {
    // A plain relative path: no `..`, nothing absolute, no drive letter, no
    // hidden segment (`.atlas`), no `\`.
    if name.starts_with('/') || relative_path(name).is_none() {
        return None;
    }
    if PACK_FILES.contains(&name) {
        return Some(Kind::PackFile);
    }
    if let Some(which) = MINE_ENTRIES.iter().position(|(entry, _)| *entry == name) {
        return Some(Kind::Mine(which));
    }
    if pictures.contains(name) {
        return Some(Kind::Picture);
    }
    if let Some(file) = name.strip_prefix(&format!("{STATUS_DIR}/")) {
        return layers
            .iter()
            .position(|layer| layer.remote && format!("{}.json", layer.local_id) == file)
            .map(Kind::Status);
    }
    let (tile, kind) = match name.strip_suffix(MISSING_SUFFIX) {
        Some(tile) => (tile, Kind::Marker),
        None => (name, Kind::Image),
    };
    layers
        .iter()
        .zip(templates)
        .any(|(layer, template)| {
            (kind == Kind::Image || layer.remote) && template.is_tile_of(tile, layer)
        })
        .then_some(kind)
}

/// A layer's tile URL template, to tell whether a name is one of its tiles.
#[derive(Debug)]
struct Template {
    parts: Vec<Part>,
}

#[derive(Debug, PartialEq, Eq)]
enum Part {
    Text(String),
    Z,
    X,
    Y,
}

impl Template {
    /// None for a template whose placeholders follow each other with
    /// nothing in between, which cannot be read back.
    fn compile(url: &str) -> Option<Self> {
        let mut parts = Vec::new();
        let mut rest = url;
        while !rest.is_empty() {
            let next = ["{z}", "{x}", "{y}"]
                .iter()
                .filter_map(|tag| rest.find(tag).map(|at| (at, *tag)))
                .min();
            match next {
                Some((0, tag)) => {
                    if !matches!(parts.last(), None | Some(Part::Text(_))) {
                        return None;
                    }
                    parts.push(match tag {
                        "{z}" => Part::Z,
                        "{x}" => Part::X,
                        _ => Part::Y,
                    });
                    rest = &rest[3..];
                }
                Some((at, _)) => {
                    parts.push(Part::Text(rest[..at].to_owned()));
                    rest = &rest[at..];
                }
                None => {
                    parts.push(Part::Text(rest.to_owned()));
                    rest = "";
                }
            }
        }
        Some(Self { parts })
    }

    /// Whether `name` is exactly a tile of `layer` inside its pyramid.
    fn is_tile_of(&self, name: &str, layer: &LayerInfo) -> bool {
        let mut values: [Option<u64>; 3] = [None; 3];
        let mut rest = name;
        for part in &self.parts {
            let slot = match part {
                Part::Text(text) => {
                    let Some(after) = rest.strip_prefix(text.as_str()) else {
                        return false;
                    };
                    rest = after;
                    continue;
                }
                Part::Z => 0,
                Part::X => 1,
                Part::Y => 2,
            };
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 || digits > 12 {
                return false;
            }
            let Ok(value) = rest[..digits].parse::<u64>() else {
                return false;
            };
            if values[slot].is_some_and(|known| known != value) {
                return false;
            }
            values[slot] = Some(value);
            rest = &rest[digits..];
        }
        let [Some(z), Some(x), Some(y)] = values else {
            return false;
        };
        if !rest.is_empty() {
            return false;
        }
        let Ok(z) = u8::try_from(z) else {
            return false;
        };
        if z < layer.min_zoom || z > layer.max_zoom {
            return false;
        }
        let (columns, rows) = layer.grid(z);
        // The same name the layer gives this tile (no leading zeros).
        x < columns && y < rows && layer.tile_name(z, x, y) == name
    }
}

// ---------------------------------------------------------------------------
// The hidden folder

/// The hidden folder a pack is unpacked into, under its own lock, removed
/// unless it was moved into place. A folder left by an app that ended
/// mid-way is removed at the next start (see `removal::finish_pending_deletes`).
struct TempFolder {
    path: PathBuf,
    lock: Option<PackLock>,
    ops: FileOps,
    kept: bool,
}

impl TempFolder {
    fn create(maps_folder: &Path, pack_id: &str, ops: &FileOps) -> Result<Self, Stop> {
        let first = maps_folder.join(format!("{IMPORTING_PREFIX}{pack_id}"));
        let path = std::iter::once(first)
            .chain((2..).map(|n| maps_folder.join(format!("{IMPORTING_PREFIX}{pack_id}-{n}"))))
            .take(100)
            .find(|path| {
                if fs::symlink_metadata(path).is_err() {
                    return true;
                }
                // Left by an earlier import that did not finish, unless
                // another one is unpacking into it now.
                is_real_dir(path)
                    && PackLock::acquire(path)
                        .map(drop)
                        .is_ok_and(|()| fs::remove_dir_all(path).is_ok())
            })
            .ok_or_else(|| refuse("The maps folder cannot be written."))?;
        fs::create_dir_all(&path)
            .map_err(|error| format!("Could not write to the maps folder: {error}"))?;
        let lock = PackLock::acquire(&path)?;
        Ok(Self {
            path,
            lock: Some(lock),
            ops: ops.clone(),
            kept: false,
        })
    }

    /// Renames the folder to `target`, which does not exist. Some systems
    /// refuse to rename a folder with an open file in it, so the lock is let
    /// go and the rename tried again for a moment.
    fn move_to(&mut self, target: &Path) -> Result<(), Stop> {
        let mut renamed = (self.ops.rename)(&self.path, target).is_ok();
        if !renamed {
            self.lock = None;
            renamed = retrying(&self.ops, || (self.ops.rename)(&self.path, target)).is_ok();
        }
        if !renamed {
            return Err(refuse(format!(
                "Could not move the imported game into {}. Another program may be using the maps folder; try again in a moment.",
                target.display()
            )));
        }
        self.kept = true;
        self.lock = None;
        Ok(())
    }

    /// Puts the folder in place of the pack folder `existing`, under its
    /// lock: the old folder is renamed to a hidden name and removed once
    /// the new one is in place, or renamed back if that fails.
    fn replace(&mut self, existing: &Path) -> Result<(), Stop> {
        let maps = existing
            .parent()
            .ok_or_else(|| refuse("The game's folder cannot be replaced."))?;
        let id = existing
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let lock = PackLock::acquire(existing)?;
        let doomed = removal::doomed_path(&self.ops, maps, &id);
        let mut held = Some(lock);
        let mut renamed = (self.ops.rename)(existing, &doomed).is_ok();
        if !renamed {
            held = None;
            renamed = retrying(&self.ops, || (self.ops.rename)(existing, &doomed)).is_ok();
        }
        if !renamed {
            return Err(refuse(
                "Some of this game's files are in use by another program, so it was not replaced. Close programs that may be using them, such as a file window showing its folder, and try again.",
            ));
        }
        if let Err(stop) = self.move_to(existing) {
            let _ = retrying(&self.ops, || (self.ops.rename)(&doomed, existing));
            return Err(stop);
        }
        drop(held);
        // What stays in use is removed at the next start, like a delete.
        let _ = retrying(&self.ops, || (self.ops.remove_tree)(&doomed));
        Ok(())
    }
}

impl Drop for TempFolder {
    fn drop(&mut self) {
        if self.kept {
            return;
        }
        self.lock = None;
        let _ = retrying(&self.ops, || (self.ops.remove_tree)(&self.path));
    }
}

fn retrying(ops: &FileOps, mut task: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut result = task();
    for wait in &ops.retry_waits {
        if result.is_ok() {
            return result;
        }
        std::thread::sleep(*wait);
        result = task();
    }
    result
}

/// The entries of a map pack file and what each is, for tests and tools.
#[cfg(test)]
pub(crate) fn entry_names(file: &Path) -> std::collections::BTreeMap<String, u64> {
    let mut archive = ZipArchive::new(BufReader::new(File::open(file).unwrap())).unwrap();
    (0..archive.len())
        .map(|i| {
            let entry = archive.by_index(i).unwrap();
            (entry.name().unwrap().into_owned(), entry.size())
        })
        .collect()
}
