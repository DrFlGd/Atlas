//! Where downloaded tiles go: a per-user overlay folder for each pack.
//!
//! Bundled packs live in the app's read-only resources, so downloads are
//! written to `<app data>/packs/<pack id>/` instead, at the same relative
//! path as in the pack. The `atlas-pack` protocol serves the overlay first and
//! the pack folder second, so the web app sees one pack.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
};

/// Suffix of the empty file that records a tile the server does not have.
pub const MISSING_SUFFIX: &str = ".404";
/// Suffix of a tile being written; it is renamed into place when complete.
pub const PART_SUFFIX: &str = ".part";

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The tiles of one pack: its overlay folder (written) and its pack folder
/// (read only, may be absent).
#[derive(Clone, Debug)]
pub struct TileStore {
    pub overlay: PathBuf,
    pub bundled: Option<PathBuf>,
}

impl TileStore {
    pub fn new(overlay: PathBuf, bundled: Option<PathBuf>) -> Self {
        Self { overlay, bundled }
    }

    /// Whether a tile needs no download: it is in the overlay or the pack,
    /// or the server said it does not exist.
    pub fn is_done(&self, relative: &Path) -> bool {
        let file = self.overlay.join(relative);
        file.is_file()
            || with_suffix(&file, MISSING_SUFFIX).is_file()
            || self
                .bundled
                .as_ref()
                .is_some_and(|root| root.join(relative).is_file())
    }

    /// The tile's bytes, from the overlay or else the pack.
    pub fn read(&self, relative: &Path) -> Option<Vec<u8>> {
        fs::read(self.overlay.join(relative)).ok().or_else(|| {
            self.bundled
                .as_ref()
                .and_then(|root| fs::read(root.join(relative)).ok())
        })
    }

    /// Size of a tile in the overlay, if it is there.
    pub fn overlay_len(&self, relative: &Path) -> Option<u64> {
        fs::metadata(self.overlay.join(relative))
            .ok()
            .filter(fs::Metadata::is_file)
            .map(|meta| meta.len())
    }

    /// Writes a tile into the overlay atomically: to a `.part` file first,
    /// renamed into place once complete, so a tile on disk is always whole.
    pub fn write(&self, relative: &Path, bytes: &[u8]) -> io::Result<()> {
        let file = self.overlay.join(relative);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        let part = with_suffix(&file, PART_SUFFIX);
        fs::write(&part, bytes)?;
        fs::rename(&part, &file).inspect_err(|_| {
            let _ = fs::remove_file(&part);
        })
    }

    /// Whether the tile is recorded as not on the server.
    pub fn is_missing(&self, relative: &Path) -> bool {
        with_suffix(&self.overlay.join(relative), MISSING_SUFFIX).is_file()
    }

    /// Whether the tile is an image in the overlay (a download, not a marker).
    pub fn has_overlay_image(&self, relative: &Path) -> bool {
        self.overlay.join(relative).is_file()
    }

    /// Records that the server has no tile here, so it is not asked again.
    pub fn mark_missing(&self, relative: &Path) -> io::Result<()> {
        let file = self.overlay.join(relative);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(with_suffix(&file, MISSING_SUFFIX), b"")
    }

    /// Removes a leftover `.part` file, for example after a cancelled write.
    pub fn remove_part(&self, relative: &Path) {
        let _ = fs::remove_file(with_suffix(&self.overlay.join(relative), PART_SUFFIX));
    }

    /// The same questions answered from folder listings: for going through
    /// every tile of a layer, where one question a tile would be several
    /// trips to the disk for each of hundreds of thousands of tiles.
    pub fn listed(&self) -> ListedStore<'_> {
        ListedStore {
            store: self,
            listing: Listing::default(),
        }
    }
}

/// What a listed folder holds, by file name.
type Folder = HashMap<String, Listed>;

#[derive(Clone, Copy)]
struct Listed {
    /// Not a folder (a file, or a link to anything).
    plain: bool,
    /// Its size, when it is a regular file (a link is followed).
    len: Option<u64>,
}

/// File names as they are compared: Windows folders ignore case.
fn listed_name(name: &std::ffi::OsStr) -> String {
    let name = name.to_string_lossy();
    if cfg!(windows) {
        name.to_ascii_lowercase()
    } else {
        name.into_owned()
    }
}

/// Which files exist, read a whole folder at a time and remembered: asking
/// about every tile of a level then costs one listing for each folder, not
/// several requests to the disk for each tile, most of which are not there.
/// A listing is as the folder was when it was first asked about; [`forget`]
/// lets go of them.
///
/// [`forget`]: Listing::forget
#[derive(Default)]
pub struct Listing {
    folders: HashMap<PathBuf, Option<Folder>>,
}

impl Listing {
    fn folder(&mut self, dir: &Path) -> Option<&Folder> {
        if !self.folders.contains_key(dir) {
            let listed = fs::read_dir(dir).ok().map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| {
                        let kind = entry.file_type().ok()?;
                        let listed = if kind.is_symlink() {
                            Listed {
                                plain: true,
                                len: fs::metadata(entry.path())
                                    .ok()
                                    .filter(fs::Metadata::is_file)
                                    .map(|meta| meta.len()),
                            }
                        } else if kind.is_file() {
                            Listed {
                                plain: true,
                                len: Some(entry.metadata().map_or(0, |meta| meta.len())),
                            }
                        } else {
                            Listed {
                                plain: !kind.is_dir(),
                                len: None,
                            }
                        };
                        Some((listed_name(&entry.file_name()), listed))
                    })
                    .collect()
            });
            self.folders.insert(dir.to_owned(), listed);
        }
        self.folders.get(dir)?.as_ref()
    }

    fn entry(&mut self, path: &Path) -> Option<Listed> {
        let name = listed_name(path.file_name()?);
        self.folder(path.parent()?)?.get(&name).copied()
    }

    /// The size of the regular file at `path`, like `fs::metadata`.
    pub fn file_len(&mut self, path: &Path) -> Option<u64> {
        self.entry(path)?.len
    }

    /// Whether a regular file is at `path`, like `Path::is_file`.
    pub fn is_file(&mut self, path: &Path) -> bool {
        self.file_len(path).is_some()
    }

    /// Whether anything but a folder is at `path` (a link is not followed).
    pub fn is_plain(&mut self, path: &Path) -> bool {
        self.entry(path).is_some_and(|listed| listed.plain)
    }

    /// Lets go of every listing, so that folders are read again.
    pub fn forget(&mut self) {
        self.folders.clear();
    }
}

/// A [`TileStore`] asked through a [`Listing`]; see [`TileStore::listed`].
pub struct ListedStore<'a> {
    store: &'a TileStore,
    listing: Listing,
}

impl ListedStore<'_> {
    /// [`TileStore::is_done`].
    pub fn is_done(&mut self, relative: &Path) -> bool {
        let file = self.store.overlay.join(relative);
        self.listing.is_file(&file)
            || self.listing.is_file(&with_suffix(&file, MISSING_SUFFIX))
            || self
                .store
                .bundled
                .as_ref()
                .is_some_and(|root| self.listing.is_file(&root.join(relative)))
    }

    /// [`TileStore::overlay_len`].
    pub fn overlay_len(&mut self, relative: &Path) -> Option<u64> {
        self.listing.file_len(&self.store.overlay.join(relative))
    }

    /// [`TileStore::has_overlay_image`].
    pub fn has_overlay_image(&mut self, relative: &Path) -> bool {
        self.overlay_len(relative).is_some()
    }

    /// Whether the tile is an image in the overlay or in the pack.
    pub fn has_image(&mut self, relative: &Path) -> bool {
        self.has_overlay_image(relative)
            || self
                .store
                .bundled
                .as_ref()
                .is_some_and(|root| self.listing.is_file(&root.join(relative)))
    }

    /// Lets go of the listings, for example between the levels of a layer.
    pub fn forget(&mut self) {
        self.listing.forget();
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A temporary folder, removed on drop.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("atlas-tiles-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_atomically_and_reads_overlay_first() {
        let dir = TempDir::new("store");
        let bundled = dir.0.join("pack");
        fs::create_dir_all(bundled.join("t/0/0")).unwrap();
        fs::write(bundled.join("t/0/0/0.jpg"), b"bundled").unwrap();
        fs::write(bundled.join("t/0/0/1.jpg"), b"bundled-1").unwrap();
        let store = TileStore::new(dir.0.join("overlay"), Some(bundled));
        let tile = Path::new("t/0/0/0.jpg");

        assert!(store.is_done(tile), "a bundled tile needs no download");
        assert_eq!(store.read(tile).unwrap(), b"bundled");
        store.write(tile, b"downloaded").unwrap();
        assert_eq!(store.read(tile).unwrap(), b"downloaded");
        assert_eq!(store.overlay_len(tile), Some(10));
        assert!(!dir.0.join("overlay/t/0/0/0.jpg.part").exists());
        assert_eq!(store.read(Path::new("t/0/0/1.jpg")).unwrap(), b"bundled-1");

        let missing = Path::new("t/1/0/0.jpg");
        assert!(!store.is_done(missing));
        store.mark_missing(missing).unwrap();
        assert!(store.is_done(missing));
        assert_eq!(store.read(missing), None);
    }

    #[test]
    fn a_listed_store_answers_as_the_store_does() {
        let dir = TempDir::new("store-listed");
        let bundled = dir.0.join("pack");
        fs::create_dir_all(bundled.join("t/0/0")).unwrap();
        fs::write(bundled.join("t/0/0/0.jpg"), b"bundled").unwrap();
        let store = TileStore::new(dir.0.join("overlay"), Some(bundled));
        store
            .write(Path::new("t/0/1/0.jpg"), b"downloaded")
            .unwrap();
        store.mark_missing(Path::new("t/0/1/1.jpg")).unwrap();
        // A folder where an image would be, and a part file, are no images.
        fs::create_dir_all(dir.0.join("overlay/t/0/1/2.jpg")).unwrap();
        fs::write(dir.0.join("overlay/t/0/1/3.jpg.part"), b"half").unwrap();

        let mut listed = store.listed();
        for name in [
            "t/0/0/0.jpg",
            "t/0/1/0.jpg",
            "t/0/1/1.jpg",
            "t/0/1/2.jpg",
            "t/0/1/3.jpg",
            "t/0/2/0.jpg",
            "nowhere/0.jpg",
        ] {
            let tile = Path::new(name);
            assert_eq!(listed.is_done(tile), store.is_done(tile), "{name}");
            assert_eq!(listed.overlay_len(tile), store.overlay_len(tile), "{name}");
            assert_eq!(
                listed.has_overlay_image(tile),
                store.has_overlay_image(tile),
                "{name}"
            );
        }
        assert!(listed.has_image(Path::new("t/0/0/0.jpg")), "in the pack");
        assert!(!listed.has_image(Path::new("t/0/1/1.jpg")), "a marker");

        // A listing is as the folder was when it was first asked about.
        let late = Path::new("t/0/1/4.jpg");
        store.write(late, b"late").unwrap();
        assert!(!listed.is_done(late));
        listed.forget();
        assert!(listed.is_done(late));
    }

    #[test]
    fn a_listing_tells_files_from_folders() {
        let dir = TempDir::new("store-listing");
        fs::create_dir_all(dir.0.join("a/folder")).unwrap();
        fs::write(dir.0.join("a/file.png"), b"12345").unwrap();
        fs::write(dir.0.join("a/file.png.404"), b"").unwrap();
        let mut listing = Listing::default();
        assert_eq!(listing.file_len(&dir.0.join("a/file.png")), Some(5));
        assert_eq!(listing.file_len(&dir.0.join("a/file.png.404")), Some(0));
        assert!(listing.is_plain(&dir.0.join("a/file.png")));
        assert!(!listing.is_plain(&dir.0.join("a/folder")));
        assert!(!listing.is_file(&dir.0.join("a/folder")));
        assert!(!listing.is_plain(&dir.0.join("a/other.png")));
        assert!(!listing.is_plain(&dir.0.join("b/file.png")));
    }
}
