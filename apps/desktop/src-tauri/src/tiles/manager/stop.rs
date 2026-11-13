//! Stopping a pack's downloads for good, before its map images or the whole
//! pack are deleted (see `removal.rs`). Kept apart from the job code, which
//! it only reads, so that both can change without getting in each other's
//! way.

use std::{fs, sync::Arc, time::Duration};

use tokio::time::Instant;

use super::{lock, DownloadManager};

/// How often [`DownloadManager::stop_and_wait`] looks whether the job has ended.
const POLL: Duration = Duration::from_millis(25);

pub use crate::tiles::images::ImagesLocation;

impl DownloadManager {
    /// Cancels a pack's running or paused job and waits until it has really
    /// ended: its workers have stopped, its last files are written and closed,
    /// and the pack folder's lock is released. Returns false when it has not
    /// ended within `timeout`. A pack that is not downloading returns at once.
    pub async fn stop_and_wait(self: &Arc<Self>, pack_id: &str, timeout: Duration) -> bool {
        if !self.is_active(pack_id) {
            return true;
        }
        // Cancelling also takes the job out of the line of waiting downloads.
        // An error only means the job ended in the meantime. Its photos stop too.
        let _ = self.cancel(pack_id);
        let photos = super::photos_key(pack_id);
        if lock(&self.schedule)
            .jobs
            .get(&photos)
            .is_some_and(|job| !job.finished)
        {
            let _ = self.cancel(&photos);
        }
        let deadline = Instant::now() + timeout;
        while self.is_active(pack_id) {
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(POLL).await;
        }
        true
    }

    /// Forgets what is kept about a pack's downloads: its last job in this
    /// session and the record of an unfinished job (in the pack folder and in
    /// the app's data folder). A job that is still running is left alone;
    /// stop it first with [`Self::stop_and_wait`]. Anything else kept per
    /// pack id, such as its place in the line of waiting downloads, goes too.
    pub fn forget(&self, pack_id: &str) {
        let mut schedule = lock(&self.schedule);
        if schedule.jobs.get(pack_id).is_some_and(|job| !job.finished) {
            return;
        }
        let photos = super::photos_key(pack_id);
        if schedule.jobs.get(&photos).is_some_and(|job| !job.finished) {
            return;
        }
        schedule.jobs.remove(pack_id);
        schedule.jobs.remove(&photos);
        schedule.queue.retain(|id| *id != pack_id && *id != photos);
        drop(schedule);
        self.remove_record(pack_id);
        let _ = fs::remove_file(
            self.app_data
                .join("downloads")
                .join(format!("{pack_id}.json")),
        );
    }

    /// Where a pack's downloaded map images are. Errs for a pack that is not
    /// listed or has no map images to download.
    pub fn images_location(&self, pack_id: &str) -> Result<ImagesLocation, String> {
        let (plan, store) = self.plan(pack_id)?;
        Ok(ImagesLocation {
            plan,
            root: store.overlay,
            pack_folder: self.pack_folder(pack_id),
            job_record: self.record_path(pack_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use super::*;
    use crate::{
        library::PackLock,
        packs::PackRegistry,
        tiles::{
            download::{
                tests::{ensure_crypto, MockServer, Reply},
                Settings,
            },
            manager::JobState,
            pyramid::Detail,
            store::tests::TempDir,
        },
    };

    fn write_pack(dir: &Path, server: &MockServer) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("maps.json"),
            r#"[{"id":"t:map:a","name":"Island","width":4096,"height":4096}]"#,
        )
        .unwrap();
        let template = server.url("/remote/{z}/{x}/{y}.png");
        fs::write(
            dir.join("layers.json"),
            format!(
                r#"[{{"id":"t:layer:a","mapId":"t:map:a","name":"Surface","minZoom":0,"maxZoom":4,"tileSize":256,
                  "tiles":{{"type":"xyz","url":"tiles/a/{{z}}/{{x}}/{{y}}.png","remote":{{
                    "urlTemplate":"{template}",
                    "levels":[{{"z":3,"sourceZ":3,"offsetX":0,"offsetY":0}},
                              {{"z":4,"sourceZ":4,"offsetX":0,"offsetY":0}}]}}}}}}]"#
            ),
        )
        .unwrap();
    }

    fn slow_server() -> crate::tiles::download::tests::Handler {
        Arc::new(|_, _| {
            Reply::image(crate::tiles::download::tests::png()).delayed(Duration::from_millis(80))
        })
    }

    fn manager(dir: &TempDir, pack: &Path) -> Arc<DownloadManager> {
        let registry = PackRegistry::default();
        registry.register_folder("test", pack).unwrap();
        Arc::new(DownloadManager::with_settings(
            dir.0.join("data"),
            registry,
            Settings {
                delay: Duration::from_millis(1),
                ..Settings::default()
            },
        ))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stops_a_running_job_and_waits_until_its_lock_is_released() {
        ensure_crypto();
        let dir = TempDir::new("stop-running");
        let server = MockServer::start(slow_server()).await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let manager = manager(&dir, &pack);
        manager.start("test", Detail::Full).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(manager.is_active("test"));
        assert!(PackLock::acquire(&pack).is_err(), "the job holds the lock");

        assert!(manager.stop_and_wait("test", Duration::from_secs(10)).await);
        assert!(!manager.is_active("test"));
        assert_eq!(manager.snapshot("test").unwrap().state, JobState::Cancelled);
        // The lock is released and no request is made any more.
        assert!(PackLock::acquire(&pack).is_ok());
        let seen = server.seen().len();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(server.seen().len(), seen, "no requests after stopping");
        // No half-written image is left behind.
        let mut parts = Vec::new();
        let mut stack = vec![pack.clone()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().flatten() {
                if entry.file_type().unwrap().is_dir() {
                    stack.push(entry.path());
                } else if entry.file_name().to_string_lossy().ends_with(".part") {
                    parts.push(entry.path());
                }
            }
        }
        assert!(parts.is_empty(), "{parts:?}");

        manager.forget("test");
        assert!(manager.snapshot("test").is_none());
        assert!(!pack.join(".atlas/download-job.json").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stops_a_paused_job_and_forgets_an_unfinished_one() {
        ensure_crypto();
        let dir = TempDir::new("stop-paused");
        let server = MockServer::start(slow_server()).await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let manager = manager(&dir, &pack);
        manager.start("test", Detail::Full).unwrap();
        manager.pause("test").unwrap();
        assert!(manager.stop_and_wait("test", Duration::from_secs(10)).await);
        assert!(!manager.is_active("test"));

        // A job left unfinished by an earlier run is forgotten too, wherever
        // it was recorded.
        fs::create_dir_all(pack.join(".atlas")).unwrap();
        fs::write(
            pack.join(".atlas/download-job.json"),
            r#"{"packId":"test","detail":"full","stopReason":"refused"}"#,
        )
        .unwrap();
        fs::create_dir_all(dir.0.join("data/downloads")).unwrap();
        fs::write(dir.0.join("data/downloads/test.json"), "{}").unwrap();
        assert!(manager.plan_info("test").unwrap().unfinished.is_some());
        manager.forget("test");
        assert!(manager.plan_info("test").unwrap().unfinished.is_none());
        assert!(!dir.0.join("data/downloads/test.json").exists());
        // Nothing to stop returns at once.
        assert!(manager.stop_and_wait("test", Duration::ZERO).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn does_not_forget_a_running_job() {
        ensure_crypto();
        let dir = TempDir::new("stop-forget-running");
        let server = MockServer::start(slow_server()).await;
        let pack = dir.0.join("pack");
        write_pack(&pack, &server);
        let manager = manager(&dir, &pack);
        manager.start("test", Detail::Full).unwrap();
        manager.forget("test");
        assert!(manager.is_active("test"));
        assert!(manager.stop_and_wait("test", Duration::from_secs(10)).await);
    }

    #[test]
    fn locates_the_images_of_folder_and_bundled_packs() {
        let dir = TempDir::new("stop-locate");
        let pack = dir.0.join("pack");
        fs::create_dir_all(&pack).unwrap();
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
        let registry = PackRegistry::default();
        registry.register_folder("folder", &pack).unwrap();
        registry.register("bundled", &pack).unwrap();
        let manager = DownloadManager::new(dir.0.join("data"), registry);
        let folder = manager.images_location("folder").unwrap();
        let canonical = pack.canonicalize().unwrap();
        assert_eq!(folder.root, canonical);
        assert_eq!(folder.pack_folder.as_deref(), Some(canonical.as_path()));
        assert_eq!(
            folder.job_record,
            canonical.join(".atlas/download-job.json")
        );
        let bundled = manager.images_location("bundled").unwrap();
        assert_eq!(bundled.root, dir.0.join("data/packs/bundled"));
        assert!(bundled.pack_folder.is_none());
        assert_eq!(
            bundled.job_record,
            dir.0.join("data/downloads/bundled.json")
        );
        assert!(manager.images_location("nope").is_err());
    }
}
