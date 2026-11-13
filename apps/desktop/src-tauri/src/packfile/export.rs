//! Writing a map pack file; see the module above for what goes in.

use std::{
    fs::{self, File},
    io::{self, BufWriter, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use zip::{write::SimpleFileOptions, CompressionMethod, DateTime, ZipWriter};

use super::{
    analyse, count_contents, describe_pack, pack_file_entries, plan_images, refusal,
    shared_pictures, unavailable, AppInfo, DirCache, Entry, EntryData, Header, ImagesFacts,
    LayerFacts, Mine, PackSource, Progress, Stop, FORMAT, HEADER_FILE, MINE_PICTURES_DIR,
    PICTURES_FILE, VERSION_WITHOUT_MINE,
};
use crate::{
    library::PackLock,
    manifest::{civil, rfc3339, MANIFEST_FILE},
    tiles::{pyramid::Detail, status::status_for},
};

/// A finished export.
#[derive(Clone, Debug)]
pub struct Exported {
    pub path: PathBuf,
    /// The file's size on disk.
    pub size: u64,
    pub header: Header,
}

/// The suffix of the file being written; it is renamed into place when complete.
pub const PART_SUFFIX: &str = ".part";

/// Exports a pack to a map pack file at `destination`, at `detail`.
///
/// The file is written to `<destination>.part` and renamed when complete;
/// on failure or cancel the part file is removed and nothing else is left.
/// The pack folder's lock is held while it is read, when the person keeps
/// it (a folder that cannot be written, such as one on a read-only drive,
/// is read without it). The caller checks that no download of the pack is
/// running. `progress` is told after each entry; `cancelled` is asked
/// between entries.
pub fn export(
    source: &PackSource,
    app: &AppInfo,
    detail: Detail,
    destination: &Path,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Exported, Stop> {
    export_with_mine(
        source,
        app,
        detail,
        destination,
        &Mine::default(),
        progress,
        cancelled,
    )
}

/// [`export`], with a person's own lists, locations and types of the game
/// when `mine` has any: then the file is version 2 (see the module).
pub fn export_with_mine(
    source: &PackSource,
    app: &AppInfo,
    detail: Detail,
    destination: &Path,
    mine: &Mine,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Exported, Stop> {
    let mine_facts = if mine.is_empty() {
        None
    } else {
        Some(mine.check(&source.pack_id)?)
    };
    let _lock = if source.lock {
        match PackLock::acquire(&source.root) {
            Ok(lock) => Some(lock),
            Err(error) if error.starts_with("Another Atlas") => return Err(Stop::Failed(error)),
            // Nobody can write to it either, so it cannot change while read.
            Err(_) => None,
        }
    } else {
        None
    };
    let analysis = analyse(source)?;
    if let Some(reason) = refusal(&analysis) {
        return Err(Stop::Failed(reason));
    }
    if let Some(reason) = unavailable(&analysis, detail) {
        return Err(Stop::Failed(format!(
            "The map images for this level of detail are not all downloaded. {reason}"
        )));
    }
    let (pack, source_facts) = describe_pack(&source.root, source.comes_with_app)?;
    let mut images = DirCache::new(&source.images);
    let mut shipped = (source.images != source.root).then(|| DirCache::new(&source.root));
    let (image_entries, layer_facts) = plan_images(&analysis, detail, &mut images, &mut shipped);

    let exported_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let exported_at = rfc3339(exported_secs);

    // The pack's JSON files, the manifest's image summaries rewritten, and
    // its pictures that may be passed on (the list cut down to them).
    let pictures = shared_pictures(&source.root, &source.images, source.own_use_pictures)?;
    let mut entries: Vec<Entry> = Vec::new();
    for entry in pack_file_entries(&source.root)? {
        if entry.name == PICTURES_FILE {
            if let Some(pictures) = &pictures {
                entries.push(Entry {
                    name: entry.name,
                    size: pictures.list.len() as u64,
                    data: EntryData::Bytes(pictures.list.clone()),
                });
            }
        } else if entry.name == MANIFEST_FILE {
            let EntryData::File(path) = &entry.data else {
                unreachable!("pack files are read from disk");
            };
            let bytes =
                fs::read(path).map_err(|error| format!("Could not read manifest.json: {error}"))?;
            let bytes = manifest_for_export(&bytes, &layer_facts, &exported_at);
            entries.push(Entry {
                name: entry.name,
                size: bytes.len() as u64,
                data: EntryData::Bytes(bytes),
            });
        } else {
            entries.push(entry);
        }
    }
    // The status files, rewritten to the levels included; their time stays
    // when the images were downloaded.
    for layer in analysis.layers.iter().filter(|layer| layer.remote) {
        let (Some(plan), Some(status), Some(facts)) = (
            analysis.plans.get(&layer.id),
            analysis.statuses.get(&layer.id),
            layer_facts.iter().find(|facts| facts.id == layer.id),
        ) else {
            continue;
        };
        let mut rewritten = status_for(plan, &facts.levels.iter().copied().collect());
        rewritten.updated_at = status.updated_at;
        let mut bytes = serde_json::to_vec_pretty(&rewritten).expect("the status serialises");
        bytes.push(b'\n');
        entries.push(Entry {
            name: layer.status_name(),
            size: bytes.len() as u64,
            data: EntryData::Bytes(bytes),
        });
    }
    entries.extend(image_entries);
    entries.extend(pictures.map(|pictures| pictures.files).unwrap_or_default());
    for (name, _, text) in mine.files() {
        entries.push(Entry {
            name: name.to_owned(),
            size: text.len() as u64,
            data: EntryData::Bytes(text.as_bytes().to_vec()),
        });
    }
    for (file, bytes) in &mine.pictures {
        entries.push(Entry {
            name: format!("{MINE_PICTURES_DIR}{file}"),
            size: bytes.len() as u64,
            data: EntryData::Bytes(bytes.clone()),
        });
    }

    let header = Header {
        format: FORMAT.to_owned(),
        version: if mine_facts.is_some() {
            mine.version()
        } else {
            VERSION_WITHOUT_MINE
        },
        pack_id: source.pack_id.clone(),
        title: pack.title.clone(),
        pack_version: pack.pack_version.clone(),
        detail,
        exported_at: exported_at.clone(),
        exported_by: app.clone(),
        pack,
        source: source_facts,
        contents: count_contents(&source.root),
        images: ImagesFacts {
            detail,
            files: layer_facts.iter().map(|layer| layer.files).sum(),
            bytes: layer_facts.iter().map(|layer| layer.bytes).sum(),
            layers: layer_facts,
        },
        files: entries.len() as u64,
        bytes: entries.iter().map(|entry| entry.size).sum(),
        mine: mine_facts,
    };
    let mut header_bytes = serde_json::to_vec_pretty(&header).expect("the header serialises");
    header_bytes.push(b'\n');

    let part = part_path(destination);
    let written = write_file(
        &part,
        &header_bytes,
        &entries,
        zip_time(exported_secs),
        progress,
        cancelled,
    );
    let size = match written {
        Ok(size) => size,
        Err(stop) => {
            let _ = fs::remove_file(&part);
            return Err(stop);
        }
    };
    if let Err(error) = fs::rename(&part, destination) {
        let _ = fs::remove_file(&part);
        return Err(Stop::Failed(format!(
            "Could not save {}: {error}",
            destination.display()
        )));
    }
    Ok(Exported {
        path: destination.to_path_buf(),
        size,
        header,
    })
}

/// `<destination>.part`.
pub fn part_path(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_owned();
    name.push(PART_SUFFIX);
    PathBuf::from(name)
}

/// The ZIP time of every entry: when the file was made (ZIP times have no
/// zone; UTC is used).
fn zip_time(seconds: u64) -> DateTime {
    let (year, month, day, hour, minute, second) = civil(seconds);
    let narrow = |value: i64| u8::try_from(value).unwrap_or(1);
    DateTime::from_date_and_time(
        u16::try_from(year).unwrap_or(1980),
        narrow(month),
        narrow(day),
        u8::try_from(hour).unwrap_or(0),
        u8::try_from(minute).unwrap_or(0),
        u8::try_from(second).unwrap_or(0),
    )
    .unwrap_or_default()
}

/// Writes the archive: the header first, then the entries. Returns the
/// file's size.
fn write_file(
    part: &Path,
    header: &[u8],
    entries: &[Entry],
    time: DateTime,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<u64, Stop> {
    let failed = |error: &dyn std::fmt::Display| {
        Stop::Failed(format!(
            "Could not write {}: {error}",
            part.with_extension("").display()
        ))
    };
    let file = File::create(part).map_err(|error| failed(&error))?;
    let mut writer = PackWriter::new(BufWriter::with_capacity(1 << 20, file), time);
    let mut done = Progress {
        entries_done: 0,
        entries_total: entries.len() as u64 + 1,
        bytes_done: 0,
        bytes_total: entries.iter().map(|entry| entry.size).sum::<u64>() + header.len() as u64,
    };
    writer
        .add(HEADER_FILE, true, &mut &header[..])
        .map_err(|error| failed(&error))?;
    done.entries_done += 1;
    done.bytes_done += header.len() as u64;
    progress(done);
    for entry in entries {
        if cancelled() {
            return Err(Stop::Cancelled);
        }
        let json = entry.name.ends_with(".json");
        match &entry.data {
            EntryData::Bytes(bytes) => writer.add(&entry.name, json, &mut &bytes[..]),
            EntryData::File(path) => {
                let mut file = File::open(path).map_err(|error| {
                    Stop::Failed(format!("Could not read {}: {error}", path.display()))
                })?;
                writer.add(&entry.name, json, &mut file)
            }
        }
        .map_err(|error| failed(&error))?;
        done.entries_done += 1;
        done.bytes_done += entry.size;
        progress(done);
    }
    if cancelled() {
        return Err(Stop::Cancelled);
    }
    let mut inner = writer.finish().map_err(|error| failed(&error))?;
    inner.flush().map_err(|error| failed(&error))?;
    let file = inner
        .into_inner()
        .map_err(|error| failed(&error.into_error()))?;
    file.sync_all().map_err(|error| failed(&error))?;
    let size = file.metadata().map_err(|error| failed(&error))?.len();
    Ok(size)
}

/// The ZIP writer of map pack files: JSON deflated, everything else (map
/// images, which are compressed already, and empty markers) stored. ZIP64
/// records are written where sizes, offsets or the number of entries need
/// them.
pub struct PackWriter<W: Write + Seek> {
    zip: ZipWriter<W>,
    json: SimpleFileOptions,
    stored: SimpleFileOptions,
}

impl<W: Write + Seek> PackWriter<W> {
    pub fn new(inner: W, time: DateTime) -> Self {
        let base = SimpleFileOptions::default()
            .last_modified_time(time)
            .unix_permissions(0o644);
        Self {
            zip: ZipWriter::new(inner),
            json: base.compression_method(CompressionMethod::Deflated),
            // A single image is never near 4 GB; `large_file` would only
            // add a ZIP64 field to every entry.
            stored: base.compression_method(CompressionMethod::Stored),
        }
    }

    /// Adds one entry, copying it from `data`.
    pub fn add(&mut self, name: &str, deflate: bool, data: &mut dyn Read) -> io::Result<()> {
        let options = if deflate { self.json } else { self.stored };
        self.zip
            .start_file(name, options)
            .map_err(io::Error::other)?;
        io::copy(data, &mut self.zip)?;
        Ok(())
    }

    /// Writes the central directory and returns the writer.
    pub fn finish(self) -> io::Result<W> {
        self.zip.finish().map_err(io::Error::other)
    }
}

/// The manifest as exported: a version 2 manifest's image summary of each
/// layer with a remote source says which levels the file holds, how many
/// images and bytes, and whether every level is there. Every other field
/// and the field order are kept; a version 1 manifest is left as it is.
fn manifest_for_export(bytes: &[u8], layers: &[LayerFacts], exported_at: &str) -> Vec<u8> {
    let Ok(mut manifest) = serde_json::from_slice::<Value>(bytes) else {
        return bytes.to_vec();
    };
    if manifest.get("schemaVersion") != Some(&json!(2)) {
        return bytes.to_vec();
    }
    let Some(maps) = manifest
        .pointer_mut("/contents/maps")
        .and_then(Value::as_array_mut)
    else {
        return bytes.to_vec();
    };
    let mut changed = false;
    for layer in maps
        .iter_mut()
        .filter_map(|map| map.get_mut("layers").and_then(Value::as_array_mut))
        .flatten()
    {
        let Some(facts) = layer.get("id").and_then(Value::as_str).and_then(|id| {
            layers
                .iter()
                .find(|facts| facts.id == id && facts.downloadable)
        }) else {
            continue;
        };
        let updated_at = layer
            .pointer("/images/updatedAt")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| facts.downloaded_at.clone())
            .unwrap_or_else(|| exported_at.to_owned());
        if let Some(object) = layer.as_object_mut() {
            object.insert(
                "images".to_owned(),
                json!({
                    "levels": facts.levels,
                    "complete": facts.full,
                    "files": facts.files,
                    "bytes": facts.bytes,
                    "updatedAt": updated_at,
                }),
            );
            changed = true;
        }
    }
    if !changed {
        return bytes.to_vec();
    }
    let mut out = serde_json::to_vec_pretty(&manifest).expect("the manifest serialises");
    out.push(b'\n');
    out
}
