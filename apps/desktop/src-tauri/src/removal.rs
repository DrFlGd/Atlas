//! Deleting a pack from the maps folder, or only the map images downloaded
//! for a pack, without ever touching anything outside that pack.
//!
//! **Deleting a pack.** The pack folder is first renamed to a hidden
//! `.deleting-<id>` folder next to it, so it drops out of every Atlas app's
//! list at once and is never left half deleted under its own name, and then
//! removed. On Windows a file that another program holds open (a virus
//! scanner, a file window, the other Atlas app reading it) can make the
//! rename or the removal fail for a moment, so both are tried again briefly.
//! When the removal still fails, the hidden folder stays and is removed at
//! the next start ([`finish_pending_deletes`]). When even the rename keeps
//! failing, the pack is marked (`.atlas/delete-pending`) and its manifest is
//! removed first, which also hides it from every list, and the rest is
//! removed then or at the next start.
//!
//! **Deleting downloaded images.** Only the files a download writes are
//! removed, each by its exact path: every tile of every downloadable layer
//! at the layer's own `url` (with its `.404` and `.part` companions), the
//! layer's status file in `offline-tiles/`, the record of an unfinished job,
//! and the image summary in the manifest. Folders are only removed when they
//! are empty afterwards. Nothing is ever removed recursively, so a pack's
//! own files, page data and anything else in its folder stay.
//!
//! Neither follows symbolic links or junctions: a linked folder on the way
//! to a file is skipped, and a link that is removed is removed itself, never
//! what it points to.

use std::{
    collections::{BTreeSet, HashMap},
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;

use crate::{
    library::{PackLock, META_DIR},
    manifest::{clear_images, MANIFEST_FILE},
    tiles::{
        images::ImagesLocation,
        status::{status_path, STATUS_DIR},
        store::{MISSING_SUFFIX, PART_SUFFIX},
    },
};

/// Name prefix of a pack folder that is being deleted.
pub const DELETING_PREFIX: &str = ".deleting-";
/// In `.atlas/`: the pack could not be renamed and is deleted in place.
pub const PENDING_MARK: &str = "delete-pending";

type RemoveFn = Arc<dyn Fn(&Path) -> io::Result<()> + Send + Sync>;
type RenameFn = Arc<dyn Fn(&Path, &Path) -> io::Result<()> + Send + Sync>;

/// The file system operations that may fail while another program holds a
/// file, and how long to keep trying them. Tests replace them to act out a
/// held file, which cannot be done for real on every system.
#[derive(Clone)]
pub struct FileOps {
    pub rename: RenameFn,
    pub remove_tree: RemoveFn,
    pub remove_file: RemoveFn,
    /// The waits before each further attempt.
    pub retry_waits: Vec<Duration>,
}

impl Default for FileOps {
    fn default() -> Self {
        Self {
            rename: Arc::new(|from, to| fs::rename(from, to)),
            remove_tree: Arc::new(|path| fs::remove_dir_all(path)),
            remove_file: Arc::new(|path| fs::remove_file(path)),
            retry_waits: [100, 250, 500, 1000]
                .into_iter()
                .map(Duration::from_millis)
                .collect(),
        }
    }
}

impl FileOps {
    /// Runs `task` until it succeeds or every retry was used.
    fn retrying(&self, mut task: impl FnMut() -> io::Result<()>) -> io::Result<()> {
        let mut result = task();
        for wait in &self.retry_waits {
            match &result {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(_) => {}
            }
            std::thread::sleep(*wait);
            result = task();
        }
        match result {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// The outcome of deleting a pack.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackDeleted {
    /// Every file is gone. Otherwise some were in use and are removed at the
    /// next start; the pack is not listed any more either way.
    pub complete: bool,
}

const IN_USE: &str = "Some of this map's files are in use by another program, so it was not deleted. Close programs that may be using them, such as a file window showing its folder, and try again.";

/// A free hidden name for a pack folder that is being deleted.
pub(crate) fn doomed_path(ops: &FileOps, maps: &Path, id: &str) -> PathBuf {
    let first = maps.join(format!("{DELETING_PREFIX}{id}"));
    // A folder left from an earlier delete: try to finish it first.
    if is_real_dir(&first) {
        let _ = (ops.remove_tree)(&first);
    }
    if fs::symlink_metadata(&first).is_err() {
        return first;
    }
    (2..)
        .map(|n| maps.join(format!("{DELETING_PREFIX}{id}-{n}")))
        .find(|path| fs::symlink_metadata(path).is_err())
        .expect("some name is free")
}

/// Deletes a pack folder `dir` directly inside the maps folder `maps`,
/// whose lock the caller holds. `hide` is called as soon as the pack is
/// out of sight (renamed, or its manifest removed), to stop serving it.
pub fn delete_pack_folder(
    ops: &FileOps,
    maps: &Path,
    dir: &Path,
    id: &str,
    lock: PackLock,
    hide: impl FnOnce(),
) -> Result<PackDeleted, String> {
    if dir.parent() != Some(maps) || !is_real_dir(dir) {
        return Err("Only packs in the maps folder can be deleted.".to_owned());
    }
    let doomed = doomed_path(ops, maps, id);
    // A folder can be renamed while its lock file is open on most systems,
    // which keeps another app out until the end. Windows may refuse that, so
    // the lock is let go and the rename tried again for a moment.
    let mut held = Some(lock);
    let mut renamed = (ops.rename)(dir, &doomed).is_ok();
    if !renamed {
        held = None;
        renamed = ops.retrying(|| (ops.rename)(dir, &doomed)).is_ok();
    }
    if renamed {
        hide();
        drop(held);
        let removed = ops.retrying(|| (ops.remove_tree)(&doomed)).is_ok();
        return Ok(PackDeleted {
            complete: removed || fs::symlink_metadata(&doomed).is_err(),
        });
    }

    // The folder cannot be renamed. Delete it in place, manifest first, so
    // that it is not a pack any more, and mark it so that the next start
    // finishes the job.
    let lock = match held {
        Some(lock) => lock,
        None => PackLock::acquire(dir)?,
    };
    let mark = dir.join(META_DIR).join(PENDING_MARK);
    fs::write(&mark, id).map_err(|_| IN_USE.to_owned())?;
    if ops
        .retrying(|| (ops.remove_file)(&dir.join(MANIFEST_FILE)))
        .is_err()
    {
        let _ = fs::remove_file(&mark);
        return Err(IN_USE.to_owned());
    }
    hide();
    // Everything but the shell's own folder, which holds the mark and the lock.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name() != META_DIR {
                let _ = remove_entry(ops, &entry.path());
            }
        }
    }
    drop(lock);
    let removed = ops.retrying(|| (ops.remove_tree)(dir)).is_ok();
    Ok(PackDeleted {
        complete: removed || fs::symlink_metadata(dir).is_err(),
    })
}

/// Removes a file, a link (never what it points to) or a folder.
fn remove_entry(ops: &FileOps, path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        (ops.remove_tree)(path)
    } else {
        remove_link_or_file(ops, path)
    }
}

/// Removes a file or a link itself; a link to a folder on Windows (and a
/// junction) is removed as a folder entry, without entering it.
fn remove_link_or_file(ops: &FileOps, path: &Path) -> io::Result<()> {
    (ops.remove_file)(path).or_else(|error| {
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            fs::remove_dir(path)
        } else {
            Err(error)
        }
    })
}

/// Finishes deletes that an earlier run could not finish, in the maps folder
/// `maps`: hidden `.deleting-*` folders, pack folders marked as being
/// deleted that have no manifest any more, and `.importing-*` folders of a
/// map pack file import that did not finish. Returns what is still there.
pub fn finish_pending_deletes(ops: &FileOps, maps: &Path) -> Vec<PathBuf> {
    let mut left = Vec::new();
    let Ok(entries) = fs::read_dir(maps) else {
        return left;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let link = metadata.file_type().is_symlink();
        let name = entry.file_name().to_string_lossy().into_owned();
        let result = if name.starts_with(DELETING_PREFIX) {
            if link {
                // Only ever the link itself.
                remove_link_or_file(ops, &path)
            } else if metadata.is_dir() {
                ops.retrying(|| (ops.remove_tree)(&path))
            } else {
                continue;
            }
        } else if name.starts_with(crate::packfile::import::IMPORTING_PREFIX)
            && !link
            && metadata.is_dir()
        {
            // A map pack file that was being unpacked when its app ended;
            // not while another app is still unpacking into it.
            let Ok(lock) = PackLock::acquire(&path) else {
                left.push(path);
                continue;
            };
            drop(lock);
            ops.retrying(|| (ops.remove_tree)(&path))
        } else if !link
            && metadata.is_dir()
            && is_real_dir(&path.join(META_DIR))
            && path.join(META_DIR).join(PENDING_MARK).is_file()
            && fs::symlink_metadata(path.join(MANIFEST_FILE)).is_err()
        {
            // Not while another app is working on it.
            let Ok(lock) = PackLock::acquire(&path) else {
                left.push(path);
                continue;
            };
            drop(lock);
            ops.retrying(|| (ops.remove_tree)(&path))
        } else {
            continue;
        };
        if result.is_err() && fs::symlink_metadata(&path).is_ok() {
            left.push(path);
        }
    }
    left.sort();
    left
}

// ---------------------------------------------------------------------------
// Downloaded map images

/// How many downloaded map images a pack has.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImagesCount {
    pub files: u64,
    pub bytes: u64,
}

/// The outcome of deleting a pack's downloaded map images.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImagesDeleted {
    pub files: u64,
    pub bytes: u64,
    /// Images that could not be removed because they were in use.
    pub left: u64,
}

/// A directory, and not a symbolic link or junction to one.
pub fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// Folders inside a root that are known to be real folders (no links on the
/// way), so that nothing outside the root is reached through them.
struct SafeDirs<'a> {
    root: &'a Path,
    known: HashMap<PathBuf, bool>,
}

impl<'a> SafeDirs<'a> {
    fn new(root: &'a Path) -> Self {
        Self {
            root,
            known: HashMap::new(),
        }
    }

    /// Whether `relative` (a folder below the root) exists and every folder
    /// on the way to it is a real folder.
    fn check(&mut self, relative: &Path) -> bool {
        let mut path = self.root.to_path_buf();
        let mut so_far = PathBuf::new();
        for component in relative.components() {
            let Component::Normal(part) = component else {
                return false;
            };
            path.push(part);
            so_far.push(part);
            let ok = *self
                .known
                .entry(so_far.clone())
                .or_insert_with(|| is_real_dir(&path));
            if !ok {
                return false;
            }
        }
        true
    }
}

/// One file a download wrote: where it is, relative to the root, and
/// whether it is an image (rather than a `.404` or `.part` companion).
struct Written {
    relative: PathBuf,
    image: bool,
    bytes: u64,
}

/// The files and links directly in one folder, read once: on Windows a
/// folder listing carries each file's size, so this is much quicker than
/// asking for every possible tile on its own.
fn listing(dir: &Path) -> HashMap<OsString, fs::DirEntry> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry
                        .file_type()
                        .is_ok_and(|kind| kind.is_file() || kind.is_symlink())
                })
                .map(|entry| (entry.file_name(), entry))
                .collect()
        })
        .unwrap_or_default()
}

/// Every file a download wrote for the location's layers, that is still
/// there. `shipped` is the pack as it comes with the app, if it does: an
/// image that is there too came with the pack and is not counted.
fn written_files(location: &ImagesLocation, shipped: Option<&Path>) -> Vec<Written> {
    let mut out = Vec::new();
    if !is_real_dir(&location.root) {
        return out;
    }
    let mut dirs = SafeDirs::new(&location.root);
    let mut listings: HashMap<PathBuf, HashMap<OsString, fs::DirEntry>> = HashMap::new();
    for layer in &location.plan.layers {
        for z in layer.min_zoom..=layer.max_zoom {
            for tile in layer.tiles_of(z) {
                let relative = layer.tile_path(tile.z, tile.x, tile.y);
                let parent = relative.parent().unwrap_or(Path::new(""));
                if !dirs.check(parent) {
                    continue;
                }
                let files = listings
                    .entry(parent.to_path_buf())
                    .or_insert_with(|| listing(&location.root.join(parent)));
                let Some(name) = relative.file_name() else {
                    continue;
                };
                for (suffix, image) in [("", true), (MISSING_SUFFIX, false), (PART_SUFFIX, false)] {
                    let mut candidate = name.to_owned();
                    candidate.push(suffix);
                    let Some(entry) = files.get(&candidate) else {
                        continue;
                    };
                    let link = entry.file_type().is_ok_and(|kind| kind.is_symlink());
                    let relative = parent.join(&candidate);
                    if image && !link && shipped.is_some_and(|pack| pack.join(&relative).is_file())
                    {
                        continue;
                    }
                    out.push(Written {
                        bytes: if image && !link {
                            entry.metadata().map_or(0, |m| m.len())
                        } else {
                            0
                        },
                        image: image && !link,
                        relative,
                    });
                }
            }
        }
    }
    out
}

/// Counts a pack's downloaded map images. Blocking: it looks at every tile.
pub fn count_images(location: &ImagesLocation, shipped: Option<&Path>) -> ImagesCount {
    written_files(location, shipped)
        .iter()
        .filter(|file| file.image)
        .fold(ImagesCount::default(), |count, file| ImagesCount {
            files: count.files + 1,
            bytes: count.bytes + file.bytes,
        })
}

/// Deletes a pack's downloaded map images and their bookkeeping, and
/// nothing else; see the module documentation. The caller holds the pack's
/// lock and has stopped its download. Images that are in use are tried
/// again for a moment and then left, and counted in `left`.
pub fn delete_images(
    ops: &FileOps,
    location: &ImagesLocation,
    shipped: Option<&Path>,
) -> Result<ImagesDeleted, String> {
    let root = &location.root;
    let mut result = ImagesDeleted::default();
    let files = written_files(location, shipped);
    let mut folders: BTreeSet<PathBuf> = BTreeSet::new();
    let mut held: Vec<&Written> = Vec::new();
    for file in &files {
        for folder in file.relative.ancestors().skip(1) {
            if folder.as_os_str().is_empty() {
                break;
            }
            folders.insert(folder.to_path_buf());
        }
        match remove_link_or_file(ops, &root.join(&file.relative)) {
            Ok(()) => {
                if file.image {
                    result.files += 1;
                    result.bytes += file.bytes;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => held.push(file),
        }
    }
    // Files that were in use: once more after a moment, a few times.
    for wait in &ops.retry_waits {
        if held.is_empty() {
            break;
        }
        std::thread::sleep(*wait);
        held.retain(
            |file| match remove_link_or_file(ops, &root.join(&file.relative)) {
                Ok(()) => {
                    if file.image {
                        result.files += 1;
                        result.bytes += file.bytes;
                    }
                    false
                }
                Err(error) => error.kind() != io::ErrorKind::NotFound,
            },
        );
    }
    result.left = held.iter().filter(|file| file.image).count() as u64;

    // Bookkeeping: the layers' status files and the unfinished job.
    if is_real_dir(&root.join(STATUS_DIR)) {
        for layer in &location.plan.layers {
            let status = status_path(root, layer);
            for path in [status.clone(), status.with_extension("json.part")] {
                let _ = remove_link_or_file(ops, &path);
            }
        }
        let _ = fs::remove_dir(root.join(STATUS_DIR));
    }
    let record = &location.job_record;
    if record.parent().is_some_and(is_real_dir) {
        for path in [record.clone(), record.with_extension("json.part")] {
            let _ = remove_link_or_file(ops, &path);
        }
    }
    // Folders that are empty now, deepest first; never the root itself.
    let mut folders: Vec<PathBuf> = folders.into_iter().collect();
    folders.sort_by_key(|folder| std::cmp::Reverse(folder.components().count()));
    let mut dirs = SafeDirs::new(root);
    for folder in folders {
        if dirs.check(&folder) {
            let _ = fs::remove_dir(root.join(folder));
        }
    }
    if let Some(folder) = &location.pack_folder {
        let ids: Vec<&str> = location
            .plan
            .layers
            .iter()
            .map(|layer| layer.layer_id.as_str())
            .collect();
        if let Err(error) = clear_images(folder, &ids) {
            eprintln!("atlas: {error}");
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::tiles::{pyramid::read_pack_plan, store::tests::TempDir};

    fn quick() -> FileOps {
        FileOps {
            retry_waits: vec![Duration::from_millis(1); 3],
            ..FileOps::default()
        }
    }

    fn write_layers(dir: &Path, url: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":512,"height":512}]"#,
        )
        .unwrap();
        fs::write(
            dir.join("layers.json"),
            format!(
                r#"[{{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":1,"tileSize":256,
                "tiles":{{"type":"xyz","url":"{url}","remote":{{
                  "urlTemplate":"https://tiles.invalid/{{z}}/{{x}}/{{y}}.png",
                  "levels":[{{"z":1,"sourceZ":1,"offsetX":0,"offsetY":0}}]}}}}}}]"#
            ),
        )
        .unwrap();
    }

    fn location(dir: &Path) -> ImagesLocation {
        ImagesLocation {
            plan: read_pack_plan(dir).unwrap(),
            root: dir.to_path_buf(),
            pack_folder: Some(dir.to_path_buf()),
            job_record: dir.join(".atlas/download-job.json"),
        }
    }

    fn put(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn deletes_only_downloaded_images_and_their_bookkeeping() {
        let dir = TempDir::new("removal-images");
        let pack = dir.0.join("pack");
        write_layers(&pack, "tiles/a/{z}/{x}/{y}.png");
        fs::write(
            pack.join("manifest.json"),
            r#"{"schemaVersion":2,"gameId":"t","title":"T","packVersion":"1.0.0",
               "contents":{"maps":[{"id":"t:map:a","layers":[{"id":"t:layer:a","images":{"levels":[0,1],"complete":true}}]}]}}"#,
        )
        .unwrap();
        fs::write(pack.join("locations.json"), "[]").unwrap();
        fs::write(pack.join("checklists.json"), "[]").unwrap();
        put(&pack.join("import/page.json"), b"{}");
        put(&pack.join("tiles/a/0/0/0.png"), b"zero");
        put(&pack.join("tiles/a/1/0/0.png"), b"one-0-0");
        put(&pack.join("tiles/a/1/1/1.png"), b"one-1-1");
        put(&pack.join("tiles/a/1/1/0.png.404"), b"");
        put(&pack.join("tiles/a/1/0/1.png.part"), b"half");
        // Not a tile of the layer: kept, with its folder.
        put(&pack.join("tiles/a/1/0/notes.txt"), b"mine");
        put(&pack.join("tiles/a/9/0/0.png"), b"beyond max zoom");
        put(&pack.join("tiles/b/0/0/0.png"), b"another layer's folder");
        put(&pack.join("offline-tiles/a.json"), b"{}");
        put(&pack.join("offline-tiles/other.json"), b"{}");
        put(&pack.join(".atlas/download-job.json"), b"{}");
        put(&pack.join(".atlas/lock"), b"");
        let location = location(&pack);

        assert_eq!(
            count_images(&location, None),
            ImagesCount {
                files: 3,
                bytes: 18
            }
        );
        let deleted = delete_images(&quick(), &location, None).unwrap();
        assert_eq!(
            deleted,
            ImagesDeleted {
                files: 3,
                bytes: 18,
                left: 0
            }
        );
        for gone in [
            "tiles/a/0",
            "tiles/a/1/1",
            "tiles/a/1/0/0.png",
            "tiles/a/1/0/1.png.part",
            "offline-tiles/a.json",
            ".atlas/download-job.json",
        ] {
            assert!(!pack.join(gone).exists(), "{gone} is deleted");
        }
        for kept in [
            "manifest.json",
            "maps.json",
            "layers.json",
            "locations.json",
            "checklists.json",
            "import/page.json",
            "tiles/a/1/0/notes.txt",
            "tiles/a/9/0/0.png",
            "tiles/b/0/0/0.png",
            "offline-tiles/other.json",
            ".atlas/lock",
        ] {
            assert!(pack.join(kept).exists(), "{kept} is kept");
        }
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(pack.join("manifest.json")).unwrap()).unwrap();
        assert!(manifest["contents"]["maps"][0]["layers"][0]
            .get("images")
            .is_none());
        assert_eq!(count_images(&location, None), ImagesCount::default());
    }

    #[test]
    fn removes_empty_folders_but_never_the_pack_folder() {
        let dir = TempDir::new("removal-root-tiles");
        let pack = dir.0.join("pack");
        // Tiles straight in the pack folder: `{z}/{x}/{y}.png`.
        write_layers(&pack, "{z}/{x}/{y}.png");
        put(&pack.join("0/0/0.png"), b"zero");
        put(&pack.join("1/0/0.png"), b"one");
        put(&pack.join("1/notes.txt"), b"kept");
        delete_images(&quick(), &location(&pack), None).unwrap();
        assert!(!pack.join("0").exists());
        assert!(!pack.join("1/0").exists());
        assert!(pack.join("1/notes.txt").exists());
        assert!(pack.join("maps.json").exists());
        assert!(pack.is_dir());
    }

    #[test]
    fn keeps_images_that_come_with_the_app() {
        let dir = TempDir::new("removal-shipped");
        let shipped = dir.0.join("resources/valley");
        write_layers(&shipped, "tiles/a/{z}/{x}/{y}.png");
        put(&shipped.join("tiles/a/0/0/0.png"), b"shipped");
        let pack = dir.0.join("maps/valley");
        write_layers(&pack, "tiles/a/{z}/{x}/{y}.png");
        put(&pack.join("tiles/a/0/0/0.png"), b"shipped");
        put(&pack.join("tiles/a/1/0/0.png"), b"downloaded");
        let location = location(&pack);
        assert_eq!(count_images(&location, Some(&shipped)).files, 1);
        let deleted = delete_images(&quick(), &location, Some(&shipped)).unwrap();
        assert_eq!(deleted.files, 1);
        assert!(pack.join("tiles/a/0/0/0.png").exists());
        assert!(!pack.join("tiles/a/1").exists());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_links_out_of_the_pack() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new("removal-links");
        let outside = dir.0.join("outside");
        put(&outside.join("0/0.png"), b"precious");
        put(&outside.join("secret.png"), b"precious");
        let pack = dir.0.join("pack");
        write_layers(&pack, "tiles/a/{z}/{x}/{y}.png");
        fs::create_dir_all(pack.join("tiles/a")).unwrap();
        // A level folder that is a link to a folder outside the pack.
        symlink(&outside, pack.join("tiles/a/0")).unwrap();
        // A tile that is a link to a file outside the pack.
        fs::create_dir_all(pack.join("tiles/a/1/0")).unwrap();
        symlink(outside.join("secret.png"), pack.join("tiles/a/1/0/0.png")).unwrap();
        let location = location(&pack);
        assert_eq!(
            count_images(&location, None).files,
            0,
            "links are not images"
        );
        delete_images(&quick(), &location, None).unwrap();
        assert_eq!(fs::read(outside.join("0/0.png")).unwrap(), b"precious");
        assert_eq!(fs::read(outside.join("secret.png")).unwrap(), b"precious");
        // The link to a file is removed itself; the linked folder is left.
        assert!(fs::symlink_metadata(pack.join("tiles/a/1/0/0.png")).is_err());
        assert!(fs::symlink_metadata(pack.join("tiles/a/0")).is_ok());

        // A status folder that is a link is not entered either.
        let elsewhere = dir.0.join("elsewhere");
        put(&elsewhere.join("a.json"), b"{}");
        symlink(&elsewhere, pack.join("offline-tiles")).unwrap();
        delete_images(&quick(), &location, None).unwrap();
        assert!(elsewhere.join("a.json").exists());
    }

    #[test]
    fn refuses_layer_paths_that_leave_the_pack() {
        let dir = TempDir::new("removal-escape");
        let pack = dir.0.join("pack");
        for url in [
            "../outside/{z}/{x}/{y}.png",
            "tiles/../../{z}/{x}/{y}.png",
            "/abs/{z}/{x}/{y}.png",
            "C:/x/{z}/{x}/{y}.png",
            "tiles/.hidden/{z}/{x}/{y}.png",
        ] {
            write_layers(&pack, url);
            assert!(read_pack_plan(&pack).is_err(), "{url} is refused");
        }
    }

    #[test]
    fn leaves_images_that_stay_in_use_and_says_so() {
        let dir = TempDir::new("removal-held-images");
        let pack = dir.0.join("pack");
        write_layers(&pack, "tiles/a/{z}/{x}/{y}.png");
        put(&pack.join("tiles/a/0/0/0.png"), b"held");
        put(&pack.join("tiles/a/1/0/0.png"), b"free");
        put(&pack.join("offline-tiles/a.json"), b"{}");
        let held = pack.join("tiles/a/0/0/0.png");
        let ops = FileOps {
            remove_file: Arc::new(move |path| {
                if path == held {
                    Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"))
                } else {
                    fs::remove_file(path)
                }
            }),
            ..quick()
        };
        let deleted = delete_images(&ops, &location(&pack), None).unwrap();
        assert_eq!((deleted.files, deleted.left), (1, 1));
        assert!(pack.join("tiles/a/0/0/0.png").exists());
        assert!(!pack.join("offline-tiles/a.json").exists());
    }

    fn pack_with_lock(maps: &Path, id: &str) -> (PathBuf, PackLock) {
        let dir = maps.join(id);
        write_layers(&dir, "tiles/a/{z}/{x}/{y}.png");
        fs::write(dir.join("manifest.json"), "{}").unwrap();
        put(&dir.join("tiles/a/0/0/0.png"), b"image");
        let lock = PackLock::acquire(&dir).unwrap();
        (dir, lock)
    }

    #[test]
    fn deletes_a_pack_folder_through_a_hidden_name() {
        let dir = TempDir::new("removal-pack");
        let maps = dir.0.join("maps");
        let (pack, lock) = pack_with_lock(&maps, "valley");
        let hidden = AtomicUsize::new(0);
        let deleted = delete_pack_folder(&quick(), &maps, &pack, "valley", lock, || {
            hidden.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        assert!(deleted.complete);
        assert_eq!(hidden.load(Ordering::SeqCst), 1);
        assert!(!pack.exists());
        assert!(!maps.join(".deleting-valley").exists());
        assert!(maps.is_dir(), "the maps folder stays");
    }

    #[test]
    fn leaves_a_held_pack_hidden_and_finishes_at_the_next_start() {
        let dir = TempDir::new("removal-held-pack");
        let maps = dir.0.join("maps");
        let (pack, lock) = pack_with_lock(&maps, "valley");
        let neighbour = maps.join("hill");
        put(
            &neighbour.join("manifest.json"),
            br#"{"schemaVersion":1,"gameId":"hill","title":"Hill","packVersion":"1.0.0"}"#,
        );
        let tries = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&tries);
        // Something holds a file: every removal fails, as on Windows.
        let held = FileOps {
            remove_tree: Arc::new(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"))
            }),
            ..quick()
        };
        let deleted = delete_pack_folder(&held, &maps, &pack, "valley", lock, || {}).unwrap();
        assert!(!deleted.complete);
        assert_eq!(tries.load(Ordering::SeqCst), 4, "tried again briefly");
        assert!(!pack.exists(), "out of sight at once");
        assert!(maps.join(".deleting-valley/manifest.json").exists());
        let (listed, _) = crate::library::packs_in(&maps);
        assert_eq!(listed.len(), 1, "only the neighbour is a listed pack");

        // A second delete of a pack with the same id while the first is
        // still held gets a name of its own.
        let (again, lock) = pack_with_lock(&maps, "valley");
        delete_pack_folder(&held, &maps, &again, "valley", lock, || {}).unwrap();
        assert!(maps.join(".deleting-valley-2").exists());

        // Still held at the next start: reported, kept.
        assert_eq!(finish_pending_deletes(&held, &maps).len(), 2);
        // Released: removed. The neighbour stays.
        assert!(finish_pending_deletes(&quick(), &maps).is_empty());
        assert!(!maps.join(".deleting-valley").exists());
        assert!(!maps.join(".deleting-valley-2").exists());
        assert!(neighbour.join("manifest.json").exists());
    }

    #[test]
    fn deletes_in_place_when_the_folder_cannot_be_renamed() {
        let dir = TempDir::new("removal-no-rename");
        let maps = dir.0.join("maps");
        let (pack, lock) = pack_with_lock(&maps, "valley");
        let renames = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&renames);
        let ops = FileOps {
            rename: Arc::new(move |_, _| {
                counted.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"))
            }),
            remove_tree: Arc::new(|path| {
                // The folder's own files are in use; what is inside goes.
                if path.file_name().is_some_and(|name| name == "valley") {
                    Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"))
                } else {
                    fs::remove_dir_all(path)
                }
            }),
            ..quick()
        };
        let deleted = delete_pack_folder(&ops, &maps, &pack, "valley", lock, || {}).unwrap();
        assert!(!deleted.complete);
        assert_eq!(
            renames.load(Ordering::SeqCst),
            5,
            "with and without the lock"
        );
        assert!(!pack.join("manifest.json").exists(), "not a pack any more");
        assert!(!pack.join("tiles").exists());
        assert!(pack.join(".atlas/delete-pending").exists());
        assert!(crate::library::packs_in(&maps).0.is_empty());
        // The next start finishes it.
        assert!(finish_pending_deletes(&quick(), &maps).is_empty());
        assert!(!pack.exists());
    }

    #[test]
    fn says_so_when_even_the_manifest_is_in_use() {
        let dir = TempDir::new("removal-in-use");
        let maps = dir.0.join("maps");
        let (pack, lock) = pack_with_lock(&maps, "valley");
        let ops = FileOps {
            rename: Arc::new(|_, _| Err(io::Error::new(io::ErrorKind::PermissionDenied, "x"))),
            remove_file: Arc::new(|_| Err(io::Error::new(io::ErrorKind::PermissionDenied, "x"))),
            ..quick()
        };
        let error = delete_pack_folder(&ops, &maps, &pack, "valley", lock, || panic!("not hidden"))
            .unwrap_err();
        assert!(error.contains("in use by another program"), "{error}");
        assert!(pack.join("manifest.json").exists(), "nothing was deleted");
        assert!(!pack.join(".atlas/delete-pending").exists());
        assert!(finish_pending_deletes(&quick(), &maps).is_empty());
        assert!(
            pack.join("manifest.json").exists(),
            "a whole pack is never removed at start"
        );
    }

    #[test]
    fn refuses_folders_outside_the_maps_folder() {
        let dir = TempDir::new("removal-outside");
        let maps = dir.0.join("maps");
        fs::create_dir_all(&maps).unwrap();
        let (pack, lock) = pack_with_lock(&dir.0.join("elsewhere"), "valley");
        assert!(delete_pack_folder(&quick(), &maps, &pack, "valley", lock, || {}).is_err());
        assert!(pack.join("manifest.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn start_up_clean_up_never_follows_links() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new("removal-start-links");
        let maps = dir.0.join("maps");
        let outside = dir.0.join("outside");
        put(&outside.join("keep.txt"), b"precious");
        put(&outside.join(".atlas/delete-pending"), b"x");
        fs::create_dir_all(&maps).unwrap();
        symlink(&outside, maps.join(".deleting-evil")).unwrap();
        symlink(&outside, maps.join("evil")).unwrap();
        // A folder with a mark but still a manifest is a pack: left alone.
        put(&maps.join("kept/manifest.json"), b"{}");
        put(&maps.join("kept/.atlas/delete-pending"), b"x");
        // A hidden folder that is not ours is left alone.
        put(&maps.join(".other/file"), b"x");
        assert!(finish_pending_deletes(&quick(), &maps).is_empty());
        assert!(fs::symlink_metadata(maps.join(".deleting-evil")).is_err());
        assert!(fs::symlink_metadata(maps.join("evil")).is_ok());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"precious");
        assert!(maps.join("kept/manifest.json").exists());
        assert!(maps.join(".other/file").exists());
    }

    #[test]
    fn start_up_clean_up_waits_for_a_pack_another_app_holds() {
        let dir = TempDir::new("removal-start-locked");
        let maps = dir.0.join("maps");
        put(&maps.join("valley/.atlas/delete-pending"), b"valley");
        put(&maps.join("valley/tiles/a/0/0/0.png"), b"x");
        let other_app = PackLock::acquire(&maps.join("valley")).unwrap();
        assert_eq!(finish_pending_deletes(&quick(), &maps).len(), 1);
        assert!(maps.join("valley").exists());
        drop(other_app);
        assert!(finish_pending_deletes(&quick(), &maps).is_empty());
        assert!(!maps.join("valley").exists());
    }
}
