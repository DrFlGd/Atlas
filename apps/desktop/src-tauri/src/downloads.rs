//! What the maps library needs to know about this app's map image
//! downloads: which packs are downloading, stopping a pack's download before
//! its files are deleted or moved, forgetting it afterwards, and where a
//! pack's downloaded images are.
//!
//! A build with the `downloads` feature asks its download manager. A build
//! without it downloads nothing, so no pack is ever downloading in it; the
//! images that an earlier version or another Atlas app downloaded are still
//! found where the downloader puts them (`tiles::images`), so they are shown
//! and can be deleted.

#[cfg(any(not(feature = "downloads"), test))]
use std::path::PathBuf;
#[cfg(feature = "downloads")]
use std::sync::Arc;
use std::time::Duration;

#[cfg(any(not(feature = "downloads"), test))]
use crate::packs::PackRegistry;
use crate::tiles::images::ImagesLocation;
#[cfg(feature = "downloads")]
use crate::tiles::DownloadManager;

/// This app's downloads, as the maps library sees them. Cheap to clone.
#[derive(Clone)]
pub struct Downloads {
    #[cfg(feature = "downloads")]
    manager: Arc<DownloadManager>,
    #[cfg(not(feature = "downloads"))]
    registry: PackRegistry,
    #[cfg(not(feature = "downloads"))]
    app_data: PathBuf,
}

impl Downloads {
    /// The downloads of this app, which its download manager runs.
    #[cfg(feature = "downloads")]
    pub fn new(manager: Arc<DownloadManager>) -> Self {
        Self { manager }
    }

    /// A build without downloads: only images already on disk, in the packs
    /// of `registry` and the overlays in the app's data folder `app_data`.
    #[cfg(not(feature = "downloads"))]
    pub fn new(registry: PackRegistry, app_data: PathBuf) -> Self {
        Self { registry, app_data }
    }

    /// Whether this build downloads map images.
    pub const fn in_build() -> bool {
        cfg!(feature = "downloads")
    }

    /// Whether a pack's download is running, paused, queued or waiting.
    pub fn is_active(&self, pack_id: &str) -> bool {
        #[cfg(feature = "downloads")]
        return self.manager.is_active(pack_id);
        #[cfg(not(feature = "downloads"))]
        {
            let _ = pack_id;
            false
        }
    }

    /// The packs with a download that is not over.
    pub fn active_packs(&self) -> Vec<String> {
        #[cfg(feature = "downloads")]
        return self.manager.active_packs();
        #[cfg(not(feature = "downloads"))]
        Vec::new()
    }

    /// Stops a pack's running or paused download and waits until it has let
    /// go of the pack's files. False when it did not stop within `timeout`.
    pub async fn stop_and_wait(&self, pack_id: &str, timeout: Duration) -> bool {
        #[cfg(feature = "downloads")]
        return self.manager.stop_and_wait(pack_id, timeout).await;
        #[cfg(not(feature = "downloads"))]
        {
            let _ = (pack_id, timeout);
            true
        }
    }

    /// Forgets what is kept about a pack's downloads, such as the record of
    /// an unfinished one, after its images or the pack were deleted.
    pub fn forget(&self, pack_id: &str) {
        #[cfg(feature = "downloads")]
        self.manager.forget(pack_id);
        // The record another app or an earlier version may have left for a
        // pack without a folder of its own; a pack folder's record goes with
        // its images.
        #[cfg(not(feature = "downloads"))]
        let _ = std::fs::remove_file(crate::tiles::images::app_job_record(
            &self.app_data,
            pack_id,
        ));
    }

    /// Where a pack's downloaded map images are. Errs for a pack that is not
    /// listed or has no map images to download.
    pub fn images_location(&self, pack_id: &str) -> Result<ImagesLocation, String> {
        #[cfg(feature = "downloads")]
        return self.manager.images_location(pack_id);
        #[cfg(not(feature = "downloads"))]
        crate::tiles::images::images_location(&self.registry, &self.app_data, pack_id)
    }
}

/// The downloads of a test: a download manager with short waits in a build
/// with downloads, the images on disk without.
#[cfg(test)]
pub fn for_tests(registry: &PackRegistry, app_data: PathBuf) -> Downloads {
    #[cfg(feature = "downloads")]
    return Downloads::new(Arc::new(DownloadManager::with_settings(
        app_data,
        registry.clone(),
        crate::tiles::download::Settings {
            delay: Duration::from_millis(1),
            ..crate::tiles::download::Settings::default()
        },
    )));
    #[cfg(not(feature = "downloads"))]
    Downloads::new(registry.clone(), app_data)
}
