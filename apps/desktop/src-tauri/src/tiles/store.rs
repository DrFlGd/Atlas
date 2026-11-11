//! Where downloaded tiles go: a per-user overlay folder for each pack.
//!
//! Bundled packs live in the app's read-only resources, so downloads are
//! written to `<app data>/packs/<pack id>/` instead, at the same relative
//! path as in the pack. The `atlas-pack` protocol serves the overlay first and
//! the pack folder second, so the web app sees one pack.

use std::{
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
}
