//! Where a pack's downloaded map images are, whichever Atlas app or version
//! downloaded them. Every build needs this, also one without downloads: the
//! pack protocol serves the overlay of bundled packs, and "Delete downloaded
//! images" removes images another app downloaded.
//!
//! The places are the ones the downloader writes to (see
//! `manager.rs`): a pack folder the person keeps receives its images
//! itself, and records an unfinished download in `.atlas/download-job.json`;
//! a bundled pack, which is read only, has an overlay
//! `<app data>/packs/<pack id>/` and records it in
//! `<app data>/downloads/<pack id>.json`.

use std::path::{Path, PathBuf};

use super::pyramid::{read_pack_plan, PackPlan};
use crate::{
    library::{JOB_FILE, META_DIR},
    packs::{PackKind, PackRegistry},
};

/// Where a pack's downloaded map images and their bookkeeping are.
#[derive(Clone, Debug)]
pub struct ImagesLocation {
    /// The pack's downloadable layers, which say where each image goes.
    pub plan: PackPlan,
    /// The folder the images and their status files (`offline-tiles/`) are
    /// written to: the pack folder itself, or the overlay of a pack that
    /// comes with the app.
    pub root: PathBuf,
    /// The pack folder when the images are written into it; its manifest
    /// records them.
    pub pack_folder: Option<PathBuf>,
    /// The record of an unfinished job.
    pub job_record: PathBuf,
}

/// The overlay folder of every pack: `<app data>/packs`.
pub fn overlay_root(app_data: &Path) -> PathBuf {
    app_data.join("packs")
}

/// The record of an unfinished download of a bundled pack (one without a
/// pack folder of its own).
pub fn app_job_record(app_data: &Path, pack_id: &str) -> PathBuf {
    app_data.join("downloads").join(format!("{pack_id}.json"))
}

/// Where a registered pack's downloaded map images are. Errs for a pack
/// that is not registered or has no map images to download.
pub fn images_location(
    registry: &PackRegistry,
    app_data: &Path,
    pack_id: &str,
) -> Result<ImagesLocation, String> {
    let root = registry
        .root(pack_id)
        .ok_or_else(|| format!("There is no installed pack called {pack_id:?}."))?;
    let plan =
        read_pack_plan(&root).map_err(|error| format!("The pack cannot be downloaded: {error}"))?;
    if plan.layers.is_empty() {
        return Err("This pack has no map images to download.".to_owned());
    }
    Ok(if registry.kind(pack_id) == Some(PackKind::Folder) {
        ImagesLocation {
            plan,
            job_record: root.join(META_DIR).join(JOB_FILE),
            pack_folder: Some(root.clone()),
            root,
        }
    } else {
        ImagesLocation {
            plan,
            root: overlay_root(app_data).join(pack_id),
            pack_folder: None,
            job_record: app_job_record(app_data, pack_id),
        }
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::tiles::store::tests::TempDir;

    fn write_pack(pack: &Path) {
        fs::create_dir_all(pack).unwrap();
        fs::write(
            pack.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":512,"height":512}]"#,
        )
        .unwrap();
        fs::write(
            pack.join("layers.json"),
            r#"[{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":1,"tileSize":256,
                "tiles":{"type":"xyz","url":"tiles/a/{z}/{x}/{y}.png","remote":{
                  "urlTemplate":"https://tiles.invalid/{z}/{x}/{y}.png",
                  "levels":[{"z":1,"sourceZ":1,"offsetX":0,"offsetY":0}]}}}]"#,
        )
        .unwrap();
    }

    #[test]
    fn locates_the_images_of_folder_and_bundled_packs() {
        let dir = TempDir::new("images-locate");
        let pack = dir.0.join("pack");
        write_pack(&pack);
        // The demo world: its map images come with it.
        let plain = dir.0.join("plain");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("maps.json"), "[]").unwrap();
        fs::write(plain.join("layers.json"), "[]").unwrap();
        let registry = PackRegistry::default();
        registry.register_folder("folder", &pack).unwrap();
        registry.register("bundled", &pack).unwrap();
        registry.register_folder("plain", &plain).unwrap();
        let data = dir.0.join("data");

        let folder = images_location(&registry, &data, "folder").unwrap();
        let canonical = pack.canonicalize().unwrap();
        assert_eq!(folder.root, canonical);
        assert_eq!(folder.pack_folder.as_deref(), Some(canonical.as_path()));
        assert_eq!(
            folder.job_record,
            canonical.join(".atlas/download-job.json")
        );
        assert_eq!(folder.plan.layers.len(), 1);
        let bundled = images_location(&registry, &data, "bundled").unwrap();
        assert_eq!(bundled.root, data.join("packs/bundled"));
        assert!(bundled.pack_folder.is_none());
        assert_eq!(bundled.job_record, data.join("downloads/bundled.json"));
        assert!(images_location(&registry, &data, "nope").is_err());
        assert!(images_location(&registry, &data, "plain").is_err());
    }

    /// The downloader finds the same places, so what one build downloads
    /// another deletes.
    #[cfg(feature = "downloads")]
    #[test]
    fn agrees_with_the_downloader() {
        use crate::tiles::DownloadManager;

        let dir = TempDir::new("images-agree");
        let pack = dir.0.join("pack");
        write_pack(&pack);
        let registry = PackRegistry::default();
        registry.register_folder("folder", &pack).unwrap();
        registry.register("bundled", &pack).unwrap();
        let data = dir.0.join("data");
        let manager = DownloadManager::new(data.clone(), registry.clone());
        assert_eq!(DownloadManager::overlay_root(&data), overlay_root(&data));
        for id in ["folder", "bundled"] {
            let ours = images_location(&registry, &data, id).unwrap();
            let theirs = manager.images_location(id).unwrap();
            assert_eq!(ours.root, theirs.root, "{id}");
            assert_eq!(ours.pack_folder, theirs.pack_folder, "{id}");
            assert_eq!(ours.job_record, theirs.job_record, "{id}");
            assert_eq!(
                format!("{:?}", ours.plan),
                format!("{:?}", theirs.plan),
                "{id}"
            );
        }
    }
}
