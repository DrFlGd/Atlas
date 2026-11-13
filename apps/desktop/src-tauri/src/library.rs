//! The maps library: where pack folders live on this computer, shared by
//! every Atlas desktop app.
//!
//! - The **maps folder** holds one sub-folder per pack. Packs imported from a
//!   web page and bundled packs whose map images are downloaded are written
//!   there. It is `<shared folder>/Maps` (see `settings.rs`) until the person
//!   chooses another one; the choice is kept in the shared settings file.
//! - **Locations** are other folders the person opened: one pack folder, or a
//!   folder of pack folders. They are remembered in the shared settings file,
//!   are read only (nothing is written into them unless the person starts a
//!   download or an import for one of their packs), and a location that has
//!   gone missing (an unplugged drive) is kept and reported.
//!
//! A pack folder is self-contained and portable: its JSON files, its
//! downloaded map images at the layers' own relative paths, the image status
//! files (`offline-tiles/`), and for an imported pack the page data it was
//! built from (`import/`). The shell's own bookkeeping (a lock file and an
//! unfinished download job) lives in `.atlas/`.
//!
//! Every folder is untrusted: pack ids come from the manifest and are
//! checked, manifests are size-capped, symbolic links in a folder of packs
//! are not followed, and the web app validates each pack in full with the
//! pack schema before showing it.
//!
//! When two folders hold packs with the same id, one is shown: a bundled
//! pack first, then the maps folder, then locations in the order they were
//! added. The others are listed as hidden, with the reason.

use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};

#[cfg(feature = "downloads")]
use crate::manifest::{update_images, ImagesUpdate};
use crate::{
    activity::{self, Area},
    manifest::{read_head, version_key, write_atomic, ManifestHead, SourcePage, MANIFEST_FILE},
    packs::{is_valid_pack_id, PackKind, PackRegistry, IMPORT_DIR},
    removal::{self, FileOps, ImagesCount, ImagesDeleted, PackDeleted},
    settings::{default_maps_folder, Location, LocationKind, SettingsFile, SharedSettings},
    tiles::images::ImagesLocation,
};

/// The shell's own files inside a pack folder; never served.
pub const META_DIR: &str = ".atlas";
const LOCK_FILE: &str = "lock";
/// An unfinished download job of a pack folder.
pub const JOB_FILE: &str = "download-job.json";
const IMPORT_INDEX: &str = "index.json";
const IMPORT_FORMAT: &str = "atlas-import";

/// The JSON files a pack may hold. Imports write exactly these.
pub const PACK_FILES: &[&str] = &[
    "manifest.json",
    "maps.json",
    "layers.json",
    "regions.json",
    "categoryGroups.json",
    "categories.json",
    "locations.json",
    "entities.json",
    "checklists.json",
    "checklistItems.json",
    "guides.json",
    "links.json",
    "presets.json",
    // Guides read as pages: their contents, and the list of their pictures.
    "sections.json",
    "pictures.json",
];
pub const MAX_PACK_FILE_BYTES: usize = 64 << 20;
pub const MAX_PACK_BYTES: usize = 256 << 20;
/// Page data larger than this is refused (the web app checks the same).
pub const MAX_PAGE_DATA_BYTES: usize = 64 << 20;

/// The app identifier of the Atlas viewer, whose data folder held downloaded
/// map images before they moved into pack folders (version 0.2.0).
pub const LEGACY_IDENTIFIER: &str = "dev.atlas.desktop";

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The URL a registered pack is served at. WebView2 on Windows and the
/// Android WebView serve custom schemes as `http://<scheme>.localhost`.
pub fn pack_url(id: &str) -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://atlas-pack.localhost/{id}/")
    } else {
        format!("atlas-pack://localhost/{id}/")
    }
}

/// Exclusive use of one pack folder, across apps and windows, for as long as
/// the value lives: downloads, imports and moves hold it. It is an operating
/// system lock on `.atlas/lock`, released when the value is dropped or the
/// app ends, however it ends.
#[derive(Debug)]
pub struct PackLock {
    _file: File,
}

impl PackLock {
    pub fn acquire(pack_dir: &Path) -> Result<Self, String> {
        let dir = pack_dir.join(META_DIR);
        fs::create_dir_all(&dir)
            .map_err(|error| format!("Cannot write to the pack folder: {error}"))?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(LOCK_FILE))
            .map_err(|error| format!("Cannot write to the pack folder: {error}"))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(fs::TryLockError::WouldBlock) => {
                activity::warn(
                    Area::Library,
                    format!(
                        "{} is locked: another Atlas window or app is working on it",
                        pack_dir.display()
                    ),
                );
                Err(
                "Another Atlas window or app is working on this map's files right now. Try again when it has finished."
                    .to_owned(),
            )
            }
            Err(fs::TryLockError::Error(error)) => {
                Err(format!("Cannot lock the pack folder: {error}"))
            }
        }
    }
}

/// A pack that comes with the app, in its resources.
#[derive(Clone, Debug)]
pub struct BundledPack {
    pub id: String,
    pub path: PathBuf,
    /// Its layers name remote map images, so it is installed into the maps
    /// folder where they can be downloaded.
    pub downloadable: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Bundled,
    MapsFolder,
    Location,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFrom {
    pub importer_id: String,
    pub importer_title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedPack {
    pub id: String,
    pub title: String,
    pub url: String,
    pub origin: Origin,
    /// The pack folder; none for bundled packs.
    pub path: Option<String>,
    pub pack_version: String,
    /// A pack with this id comes with the app.
    pub bundled: bool,
    pub imported: Option<ImportedFrom>,
    /// The web pages the pack was made from, as its manifest records them.
    pub pages: Vec<SourcePage>,
    /// The game was made in the app from pictures (see `owngame.rs`).
    pub made_in_app: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenPack {
    pub id: String,
    pub title: String,
    pub path: String,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocationState {
    Ok,
    /// The path does not exist (for example an unplugged drive).
    Missing,
    /// A pack location whose folder is not a usable pack.
    NotAPack,
    /// A folder location with no usable packs in it.
    NoPacks,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInfo {
    pub path: String,
    pub kind: LocationKind,
    pub state: LocationState,
    /// Pack ids found there, shown or hidden.
    pub packs: Vec<String>,
    /// A plain explanation when the state is not `ok`.
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapsFolderInfo {
    pub path: String,
    pub is_default: bool,
    pub exists: bool,
}

/// Everything the web app shows about where maps come from.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub maps_folder: MapsFolderInfo,
    pub packs: Vec<ListedPack>,
    pub hidden: Vec<HiddenPack>,
    pub locations: Vec<LocationInfo>,
    /// Packs whose files are being moved, for example from version 0.2.0.
    pub busy: Vec<String>,
}

/// A maps folder the person picked and has not confirmed yet.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderChoice {
    pub path: String,
    /// Packs in the current maps folder.
    pub packs: usize,
    /// They can be moved by renaming (same drive), so moving is quick and safe.
    pub can_move: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportIndex {
    format: String,
    version: u32,
    importer: ImporterRef,
    sources: Vec<SourceEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImporterRef {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceEntry {
    key: String,
    url: String,
    imported_at: String,
    map_id: Option<String>,
    file: String,
}

/// Page data kept with an imported pack.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSource {
    pub key: String,
    pub url: String,
    pub imported_at: String,
    pub map_id: Option<String>,
    /// The page data as JSON text.
    pub data: String,
}

/// An import the web app asks the shell to write.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImport {
    pub pack_id: String,
    pub importer: ImporterRef,
    pub source_key: String,
    pub page_url: String,
    pub imported_at: String,
    /// The map the page became; none for a page that became something else,
    /// such as a checklist.
    #[serde(default)]
    pub map_id: Option<String>,
    /// The page data as JSON text.
    pub page_data: String,
    /// Pack files by name, as JSON text.
    pub files: BTreeMap<String, String>,
    /// The pack refreshes a pack that comes with the app (its importer
    /// allows that). Without it, such packs are refused.
    #[serde(default)]
    pub refresh_bundled: bool,
}

pub struct Library {
    settings: SettingsFile,
    registry: PackRegistry,
    bundled: Vec<BundledPack>,
    /// Old app data folders whose `packs/<id>/` overlays move into pack folders.
    legacy_dirs: Vec<PathBuf>,
    busy: Mutex<HashSet<String>>,
    pending_folder: Mutex<Option<PathBuf>>,
    /// The last scan summary written to the activity log.
    logged_scan: Mutex<String>,
    /// How files are removed; tests act out files that are in use.
    file_ops: FileOps,
    /// What measuring imported maps' pictures learnt, seeded into a pack's
    /// layers when an import is saved (see `tiles::measure`).
    #[cfg(feature = "downloads")]
    picture_cache: Option<crate::tiles::measure::PictureCache>,
}

impl Library {
    pub fn new(
        settings: SettingsFile,
        registry: PackRegistry,
        bundled: Vec<BundledPack>,
        legacy_dirs: Vec<PathBuf>,
    ) -> Self {
        Self {
            settings,
            registry,
            bundled,
            legacy_dirs,
            busy: Mutex::new(HashSet::new()),
            pending_folder: Mutex::new(None),
            logged_scan: Mutex::new(String::new()),
            file_ops: FileOps::default(),
            #[cfg(feature = "downloads")]
            picture_cache: None,
        }
    }

    /// Seeds the layers of every saved import from this cache of measured
    /// pictures.
    #[cfg(feature = "downloads")]
    #[must_use]
    pub fn with_picture_cache(mut self, cache: crate::tiles::measure::PictureCache) -> Self {
        self.picture_cache = Some(cache);
        self
    }

    #[cfg(test)]
    pub fn set_file_ops(&mut self, file_ops: FileOps) {
        self.file_ops = file_ops;
    }

    pub fn settings(&self) -> &SettingsFile {
        &self.settings
    }

    /// The packs served to the map.
    pub fn registry(&self) -> &PackRegistry {
        &self.registry
    }

    /// The maps folder in use.
    pub fn maps_folder(&self) -> PathBuf {
        Self::maps_folder_of(&self.settings.read(), self.settings.dir())
    }

    fn maps_folder_of(settings: &SharedSettings, shared: &Path) -> PathBuf {
        settings
            .maps_folder
            .as_ref()
            .map_or_else(|| default_maps_folder(shared), PathBuf::from)
    }

    pub fn is_bundled(&self, id: &str) -> bool {
        self.bundled.iter().any(|pack| pack.id == id)
    }

    pub fn bundled_pack(&self, id: &str) -> Option<&BundledPack> {
        self.bundled.iter().find(|pack| pack.id == id)
    }

    /// The version of a bundled pack, as it compares; 0.0.0 when unreadable.
    fn bundled_version(&self, pack: &BundledPack) -> (u64, u64, u64) {
        read_head(&pack.path).map_or((0, 0, 0), |head| version_key(&head.pack_version))
    }

    /// Start-up: registers bundled packs, installs the downloadable ones into
    /// the maps folder when they are not anywhere yet (or the maps folder has
    /// an older version), and lists every folder.
    pub fn start(&self) -> Listing {
        let mut listing = self.scan();
        for pack in &self.bundled {
            // Packs without remote images stay in the app, unless the maps
            // folder has a copy of one (a refresh from its site).
            let has_copy = self.maps_folder_copy(&pack.id).is_some();
            let installed = (pack.downloadable || has_copy)
                && self
                    .install_bundled(pack, &listing)
                    .inspect_err(|error| {
                        activity::warn(
                            Area::Library,
                            format!("Could not install the bundled pack {}: {error}", pack.id),
                        );
                    })
                    .is_ok();
            if !installed && self.registry.kind(&pack.id) != Some(PackKind::Folder) {
                if let Err(error) = self.registry.register(&pack.id, &pack.path) {
                    activity::warn(
                        Area::Library,
                        format!("Skipping the bundled pack {}: {error}", pack.path.display()),
                    );
                }
            }
            if installed {
                listing = self.scan();
            }
        }
        self.scan()
    }

    /// The pack folder in the maps folder holding a pack with this id, and its manifest.
    fn maps_folder_copy(&self, id: &str) -> Option<(PathBuf, ManifestHead)> {
        packs_in(&self.maps_folder())
            .0
            .into_iter()
            .find(|(_, head)| head.id == id)
    }

    /// Copies a bundled pack into the maps folder when the maps folder has no
    /// pack with its id, or updates the maps folder's copy from it when the
    /// bundled one is newer, or the same version and the copy lacks the page
    /// data the bundled pack carries (`import/`, so it can be refreshed from
    /// its site). An update replaces the files the bundled pack has and its
    /// page data; map images and other files in the folder are never
    /// touched. A copy that is newer, such as one refreshed from its site,
    /// is kept. A copy in another location is then not shown, since the
    /// maps folder comes first, and the Maps dialog says so.
    fn install_bundled(&self, pack: &BundledPack, listing: &Listing) -> Result<(), String> {
        let bundled = read_head(&pack.path)?;
        let target = self.maps_folder().join(&pack.id);
        let copy = self.maps_folder_copy(&pack.id).or_else(|| {
            // A shown copy in the maps folder under another folder name.
            listing
                .packs
                .iter()
                .find(|listed| listed.id == pack.id && listed.origin == Origin::MapsFolder)
                .and_then(|listed| listed.path.as_deref().map(PathBuf::from))
                .and_then(|dir| read_head(&dir).ok().map(|head| (dir, head)))
        });
        match copy {
            Some((existing, head)) => {
                let newer = version_key(&bundled.pack_version) > version_key(&head.pack_version);
                let same = version_key(&bundled.pack_version) == version_key(&head.pack_version);
                let adds_page_data = same
                    && read_import_index(&pack.path).is_some()
                    && read_import_index(&existing).is_none();
                if !newer && !adds_page_data {
                    return Ok(());
                }
                let _lock = PackLock::acquire(&existing)?;
                // Map images of layers whose edges the new version moves are
                // set aside now and renumbered once its files are there.
                #[cfg(feature = "downloads")]
                let image_roots = {
                    let after = crate::tiles::pyramid::read_pack_plan(&pack.path).ok();
                    self.stage_images(&pack.id, &existing, after.as_ref(), Area::Library)?
                };
                let copied = copy_bundled_files(&pack.path, &existing)
                    .map_err(|error| format!("Could not update {}: {error}", pack.id));
                #[cfg(feature = "downloads")]
                self.settle_images(&pack.id, &existing, &image_roots, Area::Library);
                copied?;
                activity::info(
                    Area::Library,
                    if newer {
                        format!(
                            "Updated the pack files of {} in {} from version {} to {} (map images kept)",
                            pack.id,
                            existing.display(),
                            head.pack_version,
                            bundled.pack_version
                        )
                    } else {
                        format!(
                            "Added the page data that comes with {} (version {}) to {}, so it can be refreshed from its site",
                            pack.id,
                            bundled.pack_version,
                            existing.display()
                        )
                    },
                );
                Ok(())
            }
            None => {
                if target.join(MANIFEST_FILE).exists() {
                    return Err(format!("{} holds another pack", target.display()));
                }
                fs::create_dir_all(&target)
                    .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
                let _lock = PackLock::acquire(&target)?;
                copy_tree_missing(&pack.path, &target)
                    .map_err(|error| format!("Could not install {}: {error}", pack.id))?;
                activity::info(
                    Area::Library,
                    format!(
                        "Installed the bundled pack {} (version {}) into {}",
                        pack.id,
                        bundled.pack_version,
                        target.display()
                    ),
                );
                Ok(())
            }
        }
    }

    /// Lists every pack folder, registers the shown ones and forgets packs
    /// whose folders are gone.
    pub fn scan(&self) -> Listing {
        let settings = self.settings.read();
        let maps_folder = Self::maps_folder_of(&settings, self.settings.dir());
        let mut shown: Vec<ListedPack> = Vec::new();
        let mut hidden: Vec<HiddenPack> = Vec::new();
        let mut seen: BTreeMap<String, String> = BTreeMap::new();
        let mut folders: BTreeMap<String, PathBuf> = BTreeMap::new();

        // A bundled pack without remote images is served from the app,
        // unless the maps folder has a copy of it at least as new (one that
        // was refreshed from its site, see `save_import`).
        let in_maps_folder = packs_in(&maps_folder).0;
        for pack in &self.bundled {
            let refreshed = || {
                let bundled = self.bundled_version(pack);
                in_maps_folder.iter().any(|(_, head)| {
                    head.id == pack.id && version_key(&head.pack_version) >= bundled
                })
            };
            if !pack.downloadable && !refreshed() {
                seen.insert(pack.id.clone(), "this app".to_owned());
            }
        }

        let mut consider = |dir: &Path, head: ManifestHead, origin: Origin| -> bool {
            let path = dir.display().to_string();
            if let Some(source) = seen.get(&head.id) {
                hidden.push(HiddenPack {
                    reason: format!(
                        "A pack with the same id ({}) is already shown, from {source}. Only one pack with an id is shown at a time.",
                        head.id
                    ),
                    id: head.id,
                    title: head.title,
                    path,
                });
                return false;
            }
            seen.insert(head.id.clone(), path.clone());
            folders.insert(head.id.clone(), dir.to_path_buf());
            shown.push(ListedPack {
                url: pack_url(&head.id),
                bundled: self.is_bundled(&head.id),
                imported: head.importer.map(|(id, title)| ImportedFrom {
                    importer_id: id,
                    importer_title: title,
                }),
                id: head.id,
                title: head.title,
                origin,
                path: Some(path),
                pack_version: head.pack_version,
                pages: head.pages,
                made_in_app: head.made_in_app,
            });
            true
        };

        for (dir, head) in in_maps_folder {
            consider(&dir, head, Origin::MapsFolder);
        }

        let mut locations = Vec::new();
        for location in &settings.locations {
            let path = PathBuf::from(&location.path);
            let mut info = LocationInfo {
                path: location.path.clone(),
                kind: location.kind,
                state: LocationState::Ok,
                packs: Vec::new(),
                message: None,
            };
            if !path.is_dir() {
                info.state = LocationState::Missing;
                info.message = Some(
                    "This folder cannot be found. If it is on a drive that is not connected, connect it and refresh."
                        .to_owned(),
                );
                locations.push(info);
                continue;
            }
            match location.kind {
                LocationKind::Pack => match read_head(&path) {
                    Ok(head) => {
                        info.packs.push(head.id.clone());
                        consider(&path, head, Origin::Location);
                    }
                    Err(reason) => {
                        info.state = LocationState::NotAPack;
                        info.message = Some(format!("This folder is not a map pack: {reason}."));
                    }
                },
                LocationKind::Folder => {
                    let (packs, _) = packs_in(&path);
                    if packs.is_empty() {
                        info.state = LocationState::NoPacks;
                        info.message = Some("There are no map packs in this folder.".to_owned());
                    }
                    for (dir, head) in packs {
                        info.packs.push(head.id.clone());
                        consider(&dir, head, Origin::Location);
                    }
                }
            }
            locations.push(info);
        }

        for id in self.registry.ids(PackKind::Folder) {
            if !folders.contains_key(&id) {
                self.registry.unregister(&id);
            }
        }
        shown.retain(|pack| {
            let dir = &folders[&pack.id];
            match self.registry.register_folder(&pack.id, dir) {
                Ok(()) => true,
                Err(error) => {
                    activity::warn(
                        Area::Library,
                        format!("Cannot serve {}: {error}", dir.display()),
                    );
                    false
                }
            }
        });
        // A bundled pack whose copy in the maps folder has gone is served
        // from the app again.
        for pack in &self.bundled {
            if !pack.downloadable && self.registry.kind(&pack.id).is_none() {
                let _ = self.registry.register(&pack.id, &pack.path);
            }
        }

        let mut busy: Vec<String> = lock(&self.busy).iter().cloned().collect();
        busy.sort();
        self.log_scan(&maps_folder, &shown, &hidden, &locations);
        Listing {
            maps_folder: MapsFolderInfo {
                path: maps_folder.display().to_string(),
                is_default: settings.maps_folder.is_none(),
                exists: maps_folder.is_dir(),
            },
            packs: shown,
            hidden,
            locations,
            busy,
        }
    }

    /// Writes what a scan found to the activity log, when it differs from
    /// the last scan written.
    fn log_scan(
        &self,
        maps_folder: &Path,
        shown: &[ListedPack],
        hidden: &[HiddenPack],
        locations: &[LocationInfo],
    ) {
        let mut summary = format!(
            "Maps library: maps folder {}{} | shown: {}",
            maps_folder.display(),
            if maps_folder.is_dir() {
                ""
            } else {
                " (not created yet)"
            },
            if shown.is_empty() {
                "none".to_owned()
            } else {
                shown
                    .iter()
                    .map(|pack| format!("{} {} ({:?})", pack.id, pack.pack_version, pack.origin))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        );
        for pack in hidden {
            summary.push_str(&format!(
                " | not shown: {} in {}: {}",
                pack.id, pack.path, pack.reason
            ));
        }
        for location in locations
            .iter()
            .filter(|location| location.state != LocationState::Ok)
        {
            summary.push_str(&format!(
                " | location {} is {:?}",
                location.path, location.state
            ));
        }
        let mut logged = lock(&self.logged_scan);
        if *logged != summary {
            activity::info(Area::Library, &summary);
            *logged = summary;
        }
    }

    /// The folder of a registered pack that the person keeps (not bundled).
    pub fn pack_folder(&self, id: &str) -> Option<PathBuf> {
        (self.registry.kind(id) == Some(PackKind::Folder))
            .then(|| self.registry.root(id))
            .flatten()
    }

    /// Whether a registered pack folder is inside the maps folder.
    fn in_maps_folder(&self, dir: &Path) -> bool {
        let maps = self.maps_folder().canonicalize();
        maps.is_ok_and(|maps| dir.parent() == Some(maps.as_path()))
    }

    // -----------------------------------------------------------------------
    // Locations

    /// Remembers a pack folder the person opened.
    pub fn add_pack_location(&self, path: &Path) -> Result<String, String> {
        let head = read_head(path)
            .map_err(|reason| format!("That folder is not a map pack: {reason}."))?;
        self.remember(path, LocationKind::Pack)?;
        activity::info(
            Area::Library,
            format!("Added the pack folder {} ({})", path.display(), head.id),
        );
        Ok(head.id)
    }

    /// Remembers a folder of pack folders the person opened.
    pub fn add_folder_location(&self, path: &Path) -> Result<usize, String> {
        if read_head(path).is_ok() {
            return Err(
                "That folder is a map pack itself. Use \u{201c}Open a map pack\u{201d} for it."
                    .to_owned(),
            );
        }
        let (packs, _) = packs_in(path);
        if packs.is_empty() {
            return Err("There are no map packs in that folder.".to_owned());
        }
        self.remember(path, LocationKind::Folder)?;
        activity::info(
            Area::Library,
            format!(
                "Added the folder of packs {} ({} packs)",
                path.display(),
                packs.len()
            ),
        );
        Ok(packs.len())
    }

    fn remember(&self, path: &Path, kind: LocationKind) -> Result<(), String> {
        let text = path.display().to_string();
        if Path::new(&text) == self.maps_folder() {
            return Err("That is the maps folder, which is always shown.".to_owned());
        }
        self.settings.update(|settings| {
            settings.locations.retain(|location| location.path != text);
            settings.locations.push(Location { path: text, kind });
        })?;
        Ok(())
    }

    /// Forgets a remembered location. Never deletes anything.
    pub fn remove_location(&self, path: &str) -> Result<(), String> {
        self.settings.update(|settings| {
            settings.locations.retain(|location| location.path != path);
        })?;
        activity::info(
            Area::Library,
            format!("Forgot the location {path} (no files deleted)"),
        );
        Ok(())
    }

    /// A remembered location's path, if `path` is one.
    pub fn known_location(&self, path: &str) -> Option<PathBuf> {
        self.settings
            .read()
            .locations
            .iter()
            .find(|location| location.path == path)
            .map(|location| PathBuf::from(&location.path))
    }

    // -----------------------------------------------------------------------
    // Changing the maps folder

    /// Records a folder the person picked as the new maps folder, until they confirm.
    pub fn propose_maps_folder(&self, path: &Path) -> Result<FolderChoice, String> {
        if read_head(path).is_ok() {
            return Err(
                "That folder is a map pack. Choose the folder that should hold your map packs."
                    .to_owned(),
            );
        }
        let current = self.maps_folder();
        if path == current {
            return Err("That is the maps folder already.".to_owned());
        }
        if path.starts_with(&current) {
            return Err("Choose a folder outside the current maps folder.".to_owned());
        }
        let packs = packs_in(&current).0.len();
        let choice = FolderChoice {
            path: path.display().to_string(),
            packs,
            can_move: same_volume(&current, path),
        };
        *lock(&self.pending_folder) = Some(path.to_path_buf());
        Ok(choice)
    }

    /// Uses the proposed folder as the maps folder from now on. With
    /// `move_packs`, the pack folders of the old maps folder are moved there
    /// by renaming them (same drive only); otherwise the old folder is
    /// remembered as a location, so its maps stay visible. Returns the packs
    /// that were moved.
    pub fn apply_maps_folder(
        &self,
        move_packs: bool,
        busy_ids: &[String],
    ) -> Result<Vec<String>, String> {
        let target = lock(&self.pending_folder)
            .take()
            .ok_or_else(|| "Choose the new folder first.".to_owned())?;
        let current = self.maps_folder();
        fs::create_dir_all(&target)
            .map_err(|error| format!("Cannot use {}: {error}", target.display()))?;
        let mut moved = Vec::new();
        let mut failure = None;
        if move_packs {
            if !same_volume(&current, &target) {
                return Err("The new folder is on another drive, so the maps cannot be moved by renaming them. Choose \u{201c}Use it for new maps only\u{201d}, then move the pack folders by hand with both Atlas apps closed.".to_owned());
            }
            // Everything that can be checked first is checked before anything moves.
            let packs = packs_in(&current).0;
            let mut plan = Vec::new();
            for (dir, head) in packs {
                if busy_ids.contains(&head.id) {
                    return Err(format!(
                        "{} is downloading. Pause or cancel it first; nothing was moved.",
                        head.title
                    ));
                }
                let name = dir
                    .file_name()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(&head.id));
                let destination = target.join(name);
                if destination.exists() {
                    return Err(format!(
                        "{} already exists, so nothing was moved.",
                        destination.display()
                    ));
                }
                plan.push((dir, head, destination));
            }
            for (dir, head, destination) in plan {
                let moved_one = PackLock::acquire(&dir).and_then(|lock| {
                    drop(lock);
                    fs::rename(&dir, &destination)
                        .map_err(|error| format!("Could not move {}: {error}", head.title))
                });
                match moved_one {
                    Ok(()) => moved.push(head.id),
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            if failure.is_some() && moved.is_empty() {
                return Err(failure.unwrap_or_default());
            }
        }
        // A person's own lists, beside the pack folders, go with them: moved
        // when the packs moved, copied when the old folder stays listed.
        let lists = crate::ownlists::carry_over(&current, &target, move_packs && failure.is_none());
        if !lists.is_empty() {
            activity::info(
                Area::Library,
                format!(
                    "{} the person's own lists to the new maps folder: {}",
                    if move_packs && failure.is_none() {
                        "Moved"
                    } else {
                        "Copied"
                    },
                    lists.join(", ")
                ),
            );
        }
        // Once anything has moved, the new folder is used, and the old one is
        // listed while it still holds packs, so no pack drops out of sight.
        let target_text = target.display().to_string();
        let current_text = current.display().to_string();
        let keep_old = !packs_in(&current).0.is_empty();
        self.settings.update(|settings| {
            settings.maps_folder = Some(target_text.clone());
            settings
                .locations
                .retain(|location| location.path != target_text);
            if keep_old && !settings.locations.iter().any(|l| l.path == current_text) {
                settings.locations.push(Location {
                    path: current_text.clone(),
                    kind: LocationKind::Folder,
                });
            }
        })?;
        activity::info(
            Area::Library,
            format!(
                "The maps folder is now {target_text} (was {current_text}); {}{}",
                if move_packs {
                    format!(
                        "moved: {}",
                        if moved.is_empty() {
                            "none".to_owned()
                        } else {
                            moved.join(", ")
                        }
                    )
                } else {
                    "nothing moved".to_owned()
                },
                if keep_old {
                    "; the old folder stays listed as a folder of packs"
                } else {
                    ""
                }
            ),
        );
        if let Some(error) = failure {
            activity::warn(Area::Library, format!("Moving the maps stopped: {error}"));
            return Err(format!(
                "{error}. The maps moved so far are in the new folder; the rest stay in the old folder, which is listed under \u{201c}Map packs elsewhere\u{201d}."
            ));
        }
        Ok(moved)
    }

    // -----------------------------------------------------------------------
    // Imports

    /// Page data an importer stored with a pack.
    pub fn saved_sources(
        &self,
        pack_id: &str,
        importer_id: &str,
    ) -> Result<Vec<SavedSource>, String> {
        let Some(dir) = self.pack_folder(pack_id) else {
            return Ok(Vec::new());
        };
        let Some(index) = read_import_index(&dir) else {
            return Ok(Vec::new());
        };
        if index.importer.id != importer_id {
            return Ok(Vec::new());
        }
        let mut sources = Vec::new();
        for entry in index.sources {
            let path = dir.join(IMPORT_DIR).join(&entry.file);
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(u64::MAX);
            if size > MAX_PAGE_DATA_BYTES as u64 {
                continue;
            }
            let Ok(data) = fs::read_to_string(&path) else {
                continue;
            };
            sources.push(SavedSource {
                key: entry.key,
                url: entry.url,
                imported_at: entry.imported_at,
                map_id: entry.map_id,
                data,
            });
        }
        Ok(sources)
    }

    /// Writes an imported pack: into the folder of the pack with that id if
    /// the person keeps one, otherwise into a new folder in the maps folder.
    /// Returns the pack's folder.
    pub fn save_import(&self, request: &SaveImport) -> Result<PathBuf, String> {
        if !is_valid_pack_id(&request.pack_id) {
            return Err("The importer named an unusable pack id.".to_owned());
        }
        let bundled = self.bundled_pack(&request.pack_id);
        if (bundled.is_some() || self.registry.kind(&request.pack_id) == Some(PackKind::Bundled))
            && !request.refresh_bundled
        {
            return Err(
                "A pack with this id comes with the app, so it is not replaced.".to_owned(),
            );
        }
        if !is_slug(&request.source_key) || !is_slug(&request.importer.id) {
            return Err("The importer named an unusable page key.".to_owned());
        }
        if request.page_data.len() > MAX_PAGE_DATA_BYTES {
            return Err("The page data is too large.".to_owned());
        }
        serde_json::from_str::<serde::de::IgnoredAny>(&request.page_data)
            .map_err(|_| "The page data is not JSON.".to_owned())?;
        let mut total = 0;
        for (name, text) in &request.files {
            if !PACK_FILES.contains(&name.as_str()) {
                return Err(format!("{name} is not a pack file."));
            }
            if text.len() > MAX_PACK_FILE_BYTES {
                return Err(format!("{name} is too large."));
            }
            total += text.len();
            serde_json::from_str::<serde::de::IgnoredAny>(text)
                .map_err(|_| format!("{name} is not JSON."))?;
        }
        if total > MAX_PACK_BYTES {
            return Err("The pack is too large.".to_owned());
        }
        let manifest = request
            .files
            .get(MANIFEST_FILE)
            .ok_or_else(|| "The pack has no manifest.".to_owned())?;
        let game_id = serde_json::from_str::<serde_json::Value>(manifest)
            .ok()
            .and_then(|value| {
                value
                    .get("gameId")
                    .and_then(|id| id.as_str().map(str::to_owned))
            });
        if game_id.as_deref() != Some(request.pack_id.as_str()) {
            return Err("The pack's manifest names another pack id.".to_owned());
        }
        if let Some(pack) = bundled {
            check_bundled_refresh(pack, &request.files)?;
        }

        let dir = match self.pack_folder(&request.pack_id) {
            Some(dir) => dir,
            None => {
                let dir = self.maps_folder().join(&request.pack_id);
                if let Ok(head) = read_head(&dir) {
                    if head.id != request.pack_id {
                        return Err(format!("{} holds another pack.", dir.display()));
                    }
                }
                fs::create_dir_all(&dir)
                    .map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
                dir
            }
        };
        if let Some(index) = read_import_index(&dir) {
            if index.importer.id != request.importer.id {
                return Err(
                    "This pack was made by another importer, so it is not replaced.".to_owned(),
                );
            }
        } else if read_head(&dir).is_ok() && bundled.is_none() {
            return Err("A pack with this id that was not imported from a web page is already there, so it is not replaced.".to_owned());
        }
        let _lock = PackLock::acquire(&dir)?;
        // Where the pack kept its map images until now; see the end.
        #[cfg(feature = "downloads")]
        let mut tiles_before = crate::tiles::downscale::tile_addresses(&dir);
        if let Some(pack) = bundled {
            // A refresh of a pack that comes with the app lives in the maps
            // folder. One served from the app's resources is copied there
            // first, with everything it came with (its map images, its page
            // data); a copy already there keeps its downloaded images.
            copy_tree_missing(&pack.path, &dir).map_err(|error| {
                format!("Could not copy {} into the maps folder: {error}", pack.id)
            })?;
        }
        // Map images of layers whose edges the new files move (another size
        // or other remote levels) are set aside under their old numbers now,
        // and renumbered once the new files are written; see
        // `tiles::renumber`.
        #[cfg(feature = "downloads")]
        let image_roots = {
            let after = plan_of_files(&dir, &request.files);
            self.stage_images(&request.pack_id, &dir, after.as_ref(), Area::Import)?
        };
        let written = Self::write_import_files(&dir, request, manifest);
        #[cfg(feature = "downloads")]
        for layer in self.settle_images(&request.pack_id, &dir, &image_roots, Area::Import) {
            // Its shrunk levels were built again with its new numbers.
            tiles_before.remove(&layer);
        }
        written?;

        // An import that moves a layer's images (another address template)
        // leaves the levels Atlas made by shrinking them in the old
        // arrangement, and no download would build them again.
        #[cfg(feature = "downloads")]
        match crate::tiles::downscale::rebuild_moved_layers(&dir, &tiles_before) {
            Ok(layers) if layers.is_empty() => {}
            Ok(layers) => activity::info(
                Area::Import,
                format!(
                    "The import changed where {} keeps its map images, so the zoomed-out levels were built again from the downloaded images: {}",
                    request.pack_id,
                    layers.join(", ")
                ),
            ),
            Err(error) => activity::warn(
                Area::Import,
                format!(
                    "Could not build the zoomed-out map images of {} again: {error}",
                    request.pack_id
                ),
            ),
        }
        #[cfg(feature = "downloads")]
        if let Some(cache) = &self.picture_cache {
            seed_measured_pictures(&request.pack_id, &dir, cache);
        }
        Ok(dir)
    }

    /// Writes an import's page data and pack files into its pack folder, the
    /// manifest last.
    fn write_import_files(dir: &Path, request: &SaveImport, manifest: &str) -> Result<(), String> {
        let write = |path: &Path, text: &str| {
            write_atomic(path, text.as_bytes())
                .map_err(|error| format!("Could not write {}: {error}", path.display()))
        };

        // The page data first, so a rebuild is possible even if writing the pack fails.
        let import_dir = dir.join(IMPORT_DIR);
        fs::create_dir_all(&import_dir)
            .map_err(|error| format!("Could not write to {}: {error}", dir.display()))?;
        let file = format!("{}.json", request.source_key);
        write(&import_dir.join(&file), &request.page_data)?;
        let mut index = read_import_index(dir).unwrap_or(ImportIndex {
            format: IMPORT_FORMAT.to_owned(),
            version: 1,
            importer: request.importer.clone(),
            sources: Vec::new(),
        });
        index.importer = request.importer.clone();
        let entry = SourceEntry {
            key: request.source_key.clone(),
            url: request.page_url.clone(),
            imported_at: request.imported_at.clone(),
            map_id: request.map_id.clone(),
            file,
        };
        match index
            .sources
            .iter_mut()
            .find(|source| source.key == entry.key)
        {
            Some(existing) => *existing = entry,
            None => index.sources.push(entry),
        }
        write(
            &import_dir.join(IMPORT_INDEX),
            &serde_json::to_string_pretty(&index).map_err(|error| error.to_string())?,
        )?;

        // The manifest last: until it is written, the folder still describes the old pack.
        for (name, text) in &request.files {
            if name != MANIFEST_FILE {
                write(&dir.join(name), text)?;
            }
        }
        write(&dir.join(MANIFEST_FILE), manifest)
    }

    // -----------------------------------------------------------------------
    // Map images of layers whose edges move

    /// The folders that hold a pack's downloaded map images: its pack folder
    /// `dir`, and the overlays of the pack when it came with the app or was
    /// downloaded by an older version (`<app data>/packs/<id>/`), which move
    /// into the pack folder at the next start (see [`Library::migrate_legacy`]).
    #[cfg(feature = "downloads")]
    fn image_roots(&self, id: &str, dir: &Path) -> Vec<PathBuf> {
        let mut roots = vec![dir.to_path_buf()];
        let overlays = self.registry.overlay_folder(id).into_iter().chain(
            self.legacy_dirs
                .iter()
                .map(|legacy| legacy.join("packs").join(id)),
        );
        for overlay in overlays {
            if is_real_dir(&overlay) && !roots.iter().any(|root| same_dir(root, &overlay)) {
                roots.push(overlay);
            }
        }
        roots
    }

    /// Before the files of the pack in `dir` are replaced by a version whose
    /// layers are `after`: finishes what an earlier run left half done, then
    /// sets aside the map images of every layer whose edges move, in each of
    /// the pack's image folders (see `tiles::renumber`). Returns those
    /// folders, for [`Library::settle_images`] once the files are written.
    /// When an image cannot be moved, everything is put back and the update
    /// is refused, so no image is left at a wrong place.
    #[cfg(feature = "downloads")]
    fn stage_images(
        &self,
        id: &str,
        dir: &Path,
        after: Option<&crate::tiles::pyramid::PackPlan>,
        area: Area,
    ) -> Result<Vec<PathBuf>, String> {
        use crate::tiles::{pyramid::read_pack_plan, renumber};
        let roots = self.image_roots(id, dir);
        self.settle_images(id, dir, &roots, area);
        let (Some(after), Ok(before)) = (after, read_pack_plan(dir)) else {
            return Ok(roots);
        };
        for (from, to) in renumber::moved_layers(&before, after) {
            for root in &roots {
                if !renumber::has_files(root, &from) {
                    continue;
                }
                activity::info(
                    area,
                    format!(
                        "The new version of {id} changes the size or edges of layer {}: setting its downloaded map images in {} aside to renumber them",
                        from.layer_id,
                        root.display()
                    ),
                );
                if let Err(error) = renumber::stage(root, &from, &to) {
                    activity::warn(
                        area,
                        format!(
                            "Could not set the map images of layer {} in {} aside: {error}; putting them back",
                            from.layer_id,
                            root.display()
                        ),
                    );
                    self.settle_images(id, dir, &roots, area);
                    return Err(format!(
                        "The map images already downloaded for {} could not be moved to fit its new size ({error}), so nothing was changed.",
                        from.map_name
                    ));
                }
            }
        }
        Ok(roots)
    }

    /// Renumbers the map images set aside in `roots` to the layers the pack
    /// in `dir` has now, builds their shrunk levels again, rewrites their
    /// status files and, in the pack folder, the manifest's image summary.
    /// Also finishes what a run that stopped on the way left. Returns the
    /// ids of the layers renumbered.
    #[cfg(feature = "downloads")]
    fn settle_images(&self, id: &str, dir: &Path, roots: &[PathBuf], area: Area) -> Vec<String> {
        use crate::tiles::{
            manager::count_images,
            pyramid::{read_pack_plan, PackPlan},
            renumber,
        };
        if !roots.iter().any(|root| renumber::has_unsettled(root)) {
            return Vec::new();
        }
        let current = read_pack_plan(dir).unwrap_or_else(|error| {
            activity::warn(
                area,
                format!("The layers of {id} cannot be read ({error}), so map images set aside to renumber are removed; a download fetches them again"),
            );
            PackPlan {
                layers: Vec::new(),
                maps: Vec::new(),
            }
        });
        let mut settled = Vec::new();
        let mut summaries = Vec::new();
        for root in roots {
            if !renumber::has_unsettled(root) {
                continue;
            }
            let in_pack = same_dir(root, dir);
            for result in renumber::settle(root, in_pack.then_some(dir), &current) {
                let done = match result {
                    Ok(done) => done,
                    Err(error) => {
                        activity::warn(
                            area,
                            format!(
                                "Could not renumber the map images of {id} in {}: {error}",
                                root.display()
                            ),
                        );
                        continue;
                    }
                };
                activity::info(area, renumbered_text(id, root, &done));
                if done.dropped {
                    continue;
                }
                if in_pack {
                    if let Some(layer) = current.layers.iter().find(|l| l.layer_id == done.layer_id)
                    {
                        summaries.push((layer.clone(), done.levels.clone(), done.complete));
                    }
                }
                settled.push(done.layer_id);
            }
        }
        let updates: Vec<ImagesUpdate<'_>> = summaries
            .iter()
            .map(|(layer, levels, complete)| ImagesUpdate {
                layer_id: &layer.layer_id,
                levels: levels.iter().copied().collect(),
                complete: *complete,
                counts: Some(count_images(dir, layer)),
            })
            .collect();
        if !updates.is_empty() {
            if let Err(error) = update_images(dir, &updates) {
                activity::warn(
                    area,
                    format!(
                        "Could not update the image summary in {}: {error}",
                        dir.display()
                    ),
                );
            }
        }
        settled.sort();
        settled.dedup();
        settled
    }

    /// Finishes renumbering map images that an import or an update left
    /// half done when the app stopped on the way (see `tiles::renumber`).
    /// Run at start-up, before the images of older versions move.
    #[cfg(feature = "downloads")]
    pub fn settle_images_at_start(&self) {
        use crate::tiles::renumber::has_unsettled;
        for kind in [PackKind::Folder, PackKind::Bundled] {
            for id in self.registry.ids(kind) {
                let Some(dir) = self.registry.root(&id) else {
                    continue;
                };
                let roots = self.image_roots(&id, &dir);
                if !roots.iter().any(|root| has_unsettled(root)) {
                    continue;
                }
                // A pack that comes with the app is read only; its overlay is
                // this app's own.
                let _lock = match kind {
                    PackKind::Folder => match PackLock::acquire(&dir) {
                        Ok(lock) => Some(lock),
                        Err(_) => continue,
                    },
                    PackKind::Bundled => None,
                };
                self.settle_images(&id, &dir, &roots, Area::Library);
            }
        }
    }

    /// Whether a pack id is listed (registered to be served).
    pub fn is_listed(&self, id: &str) -> bool {
        self.registry.root(id).is_some()
    }

    pub fn check_not_moving(&self, id: &str) -> Result<(), String> {
        if lock(&self.busy).contains(id) {
            return Err("Its map images are being moved from an older version of Atlas. Try again when that has finished.".to_owned());
        }
        Ok(())
    }

    /// The folder of a pack that may be deleted from disk: one in the maps
    /// folder that does not come with the app and is not being moved.
    pub fn check_deletable(&self, id: &str) -> Result<PathBuf, String> {
        let dir = self
            .pack_folder(id)
            .ok_or_else(|| "There is no such pack in the maps folder.".to_owned())?;
        if !self.in_maps_folder(&dir) {
            return Err("Only packs in the maps folder can be deleted. This one is in a folder you added, so use \u{201c}Remove from list\u{201d} instead; its files are left alone.".to_owned());
        }
        if self.is_bundled(id) {
            return Err("This map comes with the app, so it cannot be deleted. You can delete its downloaded map images instead.".to_owned());
        }
        self.check_not_moving(id)?;
        if !removal::is_real_dir(&dir) {
            return Err("There is no such pack in the maps folder.".to_owned());
        }
        Ok(dir)
    }

    /// Deletes a pack folder from the maps folder, with its map images. Its
    /// download must have been stopped. The pack is out of every list as
    /// soon as this returns; files that are still in use are removed at the
    /// next start (see `removal.rs`).
    pub fn delete_pack(&self, id: &str) -> Result<PackDeleted, String> {
        let dir = self.check_deletable(id)?;
        let maps = dir
            .parent()
            .ok_or_else(|| "There is no such pack in the maps folder.".to_owned())?
            .to_path_buf();
        let lock = PackLock::acquire(&dir)?;
        removal::delete_pack_folder(&self.file_ops, &maps, &dir, id, lock, || {
            self.registry.unregister(id);
        })
    }

    /// Finishes deleting packs that a run before could not delete completely
    /// because some of their files were in use. Returns what is still there.
    pub fn finish_deletes(&self) -> Vec<PathBuf> {
        removal::finish_pending_deletes(&self.file_ops, &self.maps_folder())
    }

    /// The pack folder a bundled pack was installed from, when `location`
    /// is that pack's folder in the maps folder: images there came with it.
    fn shipped_images(&self, id: &str, location: &ImagesLocation) -> Option<PathBuf> {
        location.pack_folder.as_ref()?;
        self.bundled
            .iter()
            .find(|pack| pack.id == id)
            .map(|pack| pack.path.clone())
    }

    /// How many map images were downloaded for a pack. Blocking.
    pub fn count_images(&self, id: &str, location: &ImagesLocation) -> ImagesCount {
        removal::count_images(location, self.shipped_images(id, location).as_deref())
    }

    /// Deletes the map images downloaded for a pack, with their status files,
    /// unfinished job and manifest summary, and nothing else. Its download
    /// must have been stopped. Blocking.
    pub fn delete_images(
        &self,
        id: &str,
        location: &ImagesLocation,
    ) -> Result<ImagesDeleted, String> {
        self.check_not_moving(id)?;
        let _lock = match &location.pack_folder {
            Some(folder) => Some(PackLock::acquire(folder).map_err(|error| {
                if error.starts_with("Another Atlas") {
                    error
                } else {
                    "Atlas cannot change the files in this map's folder. It may be on a drive that is read-only or not connected.".to_owned()
                }
            })?),
            None => None,
        };
        removal::delete_images(
            &self.file_ops,
            location,
            self.shipped_images(id, location).as_deref(),
        )
    }

    // -----------------------------------------------------------------------
    // Map images downloaded by version 0.2.0

    /// Moves map images that an older version downloaded into its app data
    /// folder (`<app data>/packs/<id>/`) into the pack's folder in the maps
    /// folder, together with an unfinished download job. Only packs in the
    /// maps folder receive them. Safe to interrupt: each file is moved on its
    /// own, a file copied across drives is renamed into place only when
    /// complete, and the next start continues where this one stopped.
    /// Returns the packs whose images were moved.
    pub fn migrate_legacy(&self) -> Vec<String> {
        let mut moved = Vec::new();
        for legacy in &self.legacy_dirs {
            let Ok(entries) = fs::read_dir(legacy.join("packs")) else {
                activity::info(
                    Area::Migration,
                    format!(
                        "Nothing to move from version 0.2.0 in {}",
                        legacy.join("packs").display()
                    ),
                );
                continue;
            };
            for entry in entries.flatten() {
                let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let source = entry.path();
                if !is_valid_pack_id(&id) || !is_real_dir(&source) {
                    continue;
                }
                let Some(target) = self.pack_folder(&id).filter(|dir| self.in_maps_folder(dir))
                else {
                    activity::info(
                        Area::Migration,
                        format!(
                            "Left the version 0.2.0 images of {id} in {}: no pack {id} in the maps folder",
                            source.display()
                        ),
                    );
                    continue;
                };
                let Ok(_lock) = PackLock::acquire(&target) else {
                    activity::warn(
                        Area::Migration,
                        format!("The images of {id} are not moved now: its pack folder is in use; the next start tries again"),
                    );
                    continue;
                };
                activity::info(
                    Area::Migration,
                    format!(
                        "Moving the version 0.2.0 images of {id} from {} into {}",
                        source.display(),
                        target.display()
                    ),
                );
                lock(&self.busy).insert(id.clone());
                let result = migrate_overlay(
                    &source,
                    &target,
                    &legacy.join("downloads").join(format!("{id}.json")),
                );
                lock(&self.busy).remove(&id);
                match result {
                    Ok(()) => moved.push(id),
                    Err(error) => activity::error(
                        Area::Migration,
                        format!("Moving the map images of {id} stopped: {error}; the next start continues"),
                    ),
                }
            }
        }
        moved
    }
}

fn is_slug(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && text.len() <= 64
}

/// A directory, and not a symbolic link to one.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// Whether two paths name the same existing folder.
#[cfg(feature = "downloads")]
fn same_dir(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (a.canonicalize(), b.canonicalize()),
            (Ok(a), Ok(b)) if a == b
        )
}

/// The layers a pack will have once an import's files are written: its new
/// `maps.json` and `layers.json`, or the ones in `dir` that it leaves as they are.
#[cfg(feature = "downloads")]
fn plan_of_files(
    dir: &Path,
    files: &BTreeMap<String, String>,
) -> Option<crate::tiles::pyramid::PackPlan> {
    let text = |name: &str| {
        files
            .get(name)
            .cloned()
            .or_else(|| fs::read_to_string(dir.join(name)).ok())
    };
    crate::tiles::pyramid::parse_pack_plan(&text("maps.json")?, &text("layers.json")?).ok()
}

/// The activity log line for one layer's renumbered images.
/// Puts what measuring the picture learnt into the layers of the pack in
/// `dir` that were just saved: the images found, and "not on the server"
/// markers for the tiles around them, where nothing is yet, so "Download map
/// images" does not ask for them again. Status files are left as they are,
/// so no level counts as complete before a download has recorded it; the
/// manifest's image summary of each seeded layer counts the new files.
#[cfg(feature = "downloads")]
fn seed_measured_pictures(id: &str, dir: &Path, cache: &crate::tiles::measure::PictureCache) {
    use crate::tiles::{
        manager::count_images, measure::seed_layers, pyramid::read_pack_plan, status::read_levels,
    };
    let Ok(plan) = read_pack_plan(dir) else {
        return;
    };
    let seeded = match seed_layers(cache, dir, Some(dir), &plan) {
        Ok(seeded) => seeded,
        Err(error) => {
            activity::warn(
                Area::Import,
                format!("Could not put the measured map picture into {id}: {error}; a download fetches those images"),
            );
            return;
        }
    };
    let mut updates = Vec::new();
    for done in &seeded {
        activity::info(
            Area::Import,
            format!(
                "Put what measuring the map picture found into {} of {id}: {} map images, and {} tiles marked as not on the server; a download does not ask for them again",
                done.layer_id, done.images, done.markers
            ),
        );
        if let Some(layer) = plan.layers.iter().find(|l| l.layer_id == done.layer_id) {
            let levels = read_levels(dir, layer);
            updates.push(ImagesUpdate {
                layer_id: &layer.layer_id,
                complete: (layer.min_zoom..=layer.max_zoom).all(|z| levels.contains(&z)),
                levels: levels.into_iter().collect(),
                counts: Some(count_images(dir, layer)),
            });
        }
    }
    if !updates.is_empty() {
        if let Err(error) = update_images(dir, &updates) {
            activity::warn(
                Area::Import,
                format!(
                    "Could not update the image summary in {}: {error}",
                    dir.display()
                ),
            );
        }
    }
}

#[cfg(feature = "downloads")]
fn renumbered_text(id: &str, root: &Path, done: &crate::tiles::renumber::Renumbered) -> String {
    let layer = &done.layer_id;
    let place = root.display();
    if done.dropped {
        return format!(
            "The map images of layer {layer} of {id} set aside in {place} were removed: the pack no longer has that layer with the same image source; a download fetches what is needed"
        );
    }
    let levels: Vec<String> = done.levels.iter().map(u8::to_string).collect();
    let state = if done.complete {
        "every level is complete".to_owned()
    } else if levels.is_empty() {
        "no level is complete, so \"Download map images\" fetches the rest".to_owned()
    } else {
        format!(
            "complete levels: {}; \"Download map images\" fetches the rest",
            levels.join(", ")
        )
    };
    if done.put_back {
        return format!(
            "The files of {id} were not replaced, so the map images of layer {layer} set aside in {place} went back under their old numbers ({} images, {} \"not on the server\" markers); the zoomed-out levels were built again; {state}",
            done.moved, done.markers
        );
    }
    format!(
        "Renumbered the downloaded map images of layer {layer} of {id} in {place} for its new size and edges: {} images and {} \"not on the server\" markers kept under their new numbers, {} outside the new image removed, {} zoomed-out images removed and those levels built again; {state}",
        done.moved, done.markers, done.removed, done.shrunk
    )
}

/// The pack folders directly inside `dir`, with the folders that are not packs.
pub fn packs_in(dir: &Path) -> (Vec<(PathBuf, ManifestHead)>, Vec<PathBuf>) {
    let mut packs = Vec::new();
    let mut others = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return (packs, others);
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .filter(|path| is_real_dir(path))
        .collect();
    paths.sort();
    for path in paths {
        match read_head(&path) {
            Ok(head) => packs.push((path, head)),
            Err(_) => others.push(path),
        }
    }
    (packs, others)
}

fn read_import_index(dir: &Path) -> Option<ImportIndex> {
    let path = dir.join(IMPORT_DIR).join(IMPORT_INDEX);
    if fs::metadata(&path).ok()?.len() > 4 << 20 {
        return None;
    }
    let index: ImportIndex = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    (index.format == IMPORT_FORMAT
        && index.version == 1
        && index
            .sources
            .iter()
            .all(|source| is_slug(&source.key) && source.file == format!("{}.json", source.key)))
    .then_some(index)
}

/// The importer and pages recorded in a pack folder's page data index
/// (`import/index.json`), for describing where the pack came from. None
/// when the pack was not imported from web pages.
pub fn read_import_sources(dir: &Path) -> Option<crate::packfile::ImportSources> {
    let index = read_import_index(dir)?;
    Some(crate::packfile::ImportSources {
        importer: Some(crate::packfile::ImporterFacts {
            id: index.importer.id,
            title: index.importer.title,
        }),
        pages: index
            .sources
            .into_iter()
            .filter(|source| {
                source.url.starts_with("https://") || source.url.starts_with("http://")
            })
            .map(|source| crate::packfile::PageFacts {
                url: source.url,
                map_id: source.map_id,
                imported_at: Some(source.imported_at)
                    .filter(|at| crate::packfile::iso_millis(at).is_some()),
            })
            .collect(),
    })
}

/// Whether two folders are on the same drive, so one can be renamed into the other.
fn same_volume(a: &Path, b: &Path) -> bool {
    let existing = |path: &Path| {
        path.ancestors()
            .find(|ancestor| ancestor.exists())
            .and_then(|ancestor| ancestor.canonicalize().ok())
    };
    let (Some(a), Some(b)) = (existing(a), existing(b)) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!((fs::metadata(&a), fs::metadata(&b)), (Ok(x), Ok(y)) if x.dev() == y.dev())
    }
    #[cfg(not(unix))]
    {
        a.components().next() == b.components().next()
    }
}

/// The maps (`id` and `name`) of a `maps.json` text; none when unreadable.
fn map_names(text: &str) -> Vec<(String, String)> {
    #[derive(Deserialize)]
    struct Map {
        id: String,
        #[serde(default)]
        name: String,
    }
    serde_json::from_str::<Vec<Map>>(text)
        .map(|maps| maps.into_iter().map(|map| (map.id, map.name)).collect())
        .unwrap_or_default()
}

/// Checks a refresh of a pack that comes with the app: its version must be
/// above the bundled one, and it must keep every map the bundled one has,
/// so that refreshing one page never drops the others.
fn check_bundled_refresh(
    pack: &BundledPack,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    let bundled = read_head(&pack.path)?;
    let manifest: serde_json::Value = files
        .get(MANIFEST_FILE)
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let version = manifest
        .get("packVersion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let title = &bundled.title;
    if version_key(version) <= version_key(&bundled.pack_version) {
        return Err(format!(
            "{title} comes with this app, and a refreshed copy must have a newer version than the one that comes with it ({}). Nothing was changed.",
            bundled.pack_version
        ));
    }
    let bundled_maps = fs::metadata(pack.path.join("maps.json"))
        .ok()
        .filter(|metadata| metadata.len() <= MAX_PACK_FILE_BYTES as u64)
        .and_then(|_| fs::read_to_string(pack.path.join("maps.json")).ok())
        .map(|text| map_names(&text))
        .unwrap_or_default();
    let new_maps: HashSet<String> = files
        .get("maps.json")
        .map(|text| map_names(text).into_iter().map(|(id, _)| id).collect())
        .unwrap_or_default();
    let missing: Vec<String> = bundled_maps
        .into_iter()
        .filter(|(id, _)| !new_maps.contains(id))
        .map(|(id, name)| if name.trim().is_empty() { id } else { name })
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{title} comes with this app, and refreshing it from this page would leave out maps it came with: {}. Nothing was changed.",
            missing.join(", ")
        ));
    }
    Ok(())
}

/// Updates a copy of a bundled pack from it: every file the bundled pack
/// has is copied over the copy's (the manifest last), and the copy's page
/// data (`import/`) is replaced with the bundled pack's, or removed when the
/// bundled pack has none, so it is never mixed with older pages. Map images
/// and other files that only the copy has are kept.
fn copy_bundled_files(from: &Path, to: &Path) -> io::Result<()> {
    let import = to.join(IMPORT_DIR);
    if is_real_dir(&import) {
        for entry in fs::read_dir(&import)?.flatten() {
            if fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_file()) {
                fs::remove_file(entry.path())?;
            }
        }
    }
    copy_tree_replacing(from, to)?;
    write_atomic(
        &to.join(MANIFEST_FILE),
        &fs::read(from.join(MANIFEST_FILE))?,
    )
}

/// Copies every file of `from` into `to`, replacing what is there, except
/// the top-level manifest, which the caller writes last. Symbolic links in
/// `to` are not written through.
fn copy_tree_replacing(from: &Path, to: &Path) -> io::Result<()> {
    if fs::symlink_metadata(to).is_ok_and(|m| m.is_symlink()) {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree_replacing(&source, &target)?;
        } else if kind.is_file()
            && !(from.join(MANIFEST_FILE) == source)
            && !fs::symlink_metadata(&target).is_ok_and(|m| m.is_symlink())
        {
            write_atomic(&target, &fs::read(&source)?)?;
        }
    }
    Ok(())
}

/// Copies every file of `from` into `to` that `to` does not have yet.
fn copy_tree_missing(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree_missing(&source, &target)?;
        } else if kind.is_file() && !target.exists() {
            if entry.file_name() == MANIFEST_FILE {
                // Written last below, so a folder with a manifest is complete.
                continue;
            }
            write_atomic(&target, &fs::read(&source)?)?;
        }
    }
    let manifest = from.join(MANIFEST_FILE);
    if manifest.is_file() && !to.join(MANIFEST_FILE).exists() {
        write_atomic(&to.join(MANIFEST_FILE), &fs::read(manifest)?)?;
    }
    Ok(())
}

/// Moves an old overlay folder into a pack folder; see [`Library::migrate_legacy`].
fn migrate_overlay(source: &Path, target: &Path, job_record: &Path) -> io::Result<()> {
    // Status files last: they say which levels are complete.
    let status = source.join("offline-tiles");
    if let Ok(entries) = fs::read_dir(source) {
        for entry in entries.flatten() {
            if entry.path() != status {
                move_tree(&entry.path(), &target.join(entry.file_name()))?;
            }
        }
    }
    if status.exists() {
        move_tree(&status, &target.join("offline-tiles"))?;
    }
    if job_record.is_file() {
        let destination = target.join(META_DIR).join(JOB_FILE);
        if destination.exists() {
            fs::remove_file(job_record)?;
        } else {
            fs::create_dir_all(destination.parent().expect("has a parent"))?;
            move_file(job_record, &destination)?;
        }
    }
    fs::remove_dir_all(source)
}

/// Moves a file or folder, merging into an existing folder. A file that is
/// already at the target stays, and the source copy is removed.
fn move_tree(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_symlink() {
        return fs::remove_file(source);
    }
    if metadata.is_dir() {
        if !target.exists() && fs::rename(source, target).is_ok() {
            return Ok(());
        }
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            move_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        return fs::remove_dir(source);
    }
    if target.exists() {
        return fs::remove_file(source);
    }
    move_file(source, target)
}

/// Renames a file, or copies it across drives through a `.part` file and
/// removes the original.
fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }
    let part = target.with_extension("migrating.part");
    fs::copy(source, &part)?;
    fs::rename(&part, target)?;
    fs::remove_file(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    fn write_pack(dir: &Path, id: &str, title: &str, version: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join(MANIFEST_FILE),
            format!(r#"{{"schemaVersion":1,"gameId":"{id}","title":"{title}","packVersion":"{version}","gamePatch":"1","attribution":[],"idMigrations":{{}}}}"#),
        )
        .unwrap();
        fs::write(dir.join("maps.json"), "[]").unwrap();
    }

    struct Setup {
        dir: TempDir,
        registry: PackRegistry,
        library: Library,
    }

    fn setup(name: &str, bundled: Vec<BundledPack>) -> Setup {
        let dir = TempDir::new(name);
        let registry = PackRegistry::default();
        let library = Library::new(
            SettingsFile::new(dir.0.join("shared")),
            registry.clone(),
            bundled,
            vec![dir.0.join("legacy")],
        );
        Setup {
            dir,
            registry,
            library,
        }
    }

    fn ids(listing: &Listing) -> Vec<&str> {
        listing.packs.iter().map(|pack| pack.id.as_str()).collect()
    }

    #[test]
    fn lists_the_maps_folder_and_locations() {
        let s = setup("library-list", Vec::new());
        let maps = s.dir.0.join("shared").join(if cfg!(target_os = "linux") {
            "maps"
        } else {
            "Maps"
        });
        write_pack(&maps.join("valley"), "valley", "Valley", "1.0.0");
        fs::create_dir_all(maps.join("not-a-pack")).unwrap();
        fs::create_dir_all(maps.join(".hidden")).unwrap();
        let usb = s.dir.0.join("USB drive/Kärten und Maps");
        write_pack(&usb.join("Island copy"), "island", "Island", "1.0.0");
        // The same id as in the maps folder: hidden, with the reason.
        write_pack(&usb.join("valley"), "valley", "Valley (old copy)", "0.9.0");
        assert_eq!(s.library.add_folder_location(&usb).unwrap(), 2);
        let single = s.dir.0.join("single pack ünïcode");
        write_pack(&single, "single", "Single", "1.0.0");
        assert_eq!(s.library.add_pack_location(&single).unwrap(), "single");

        let listing = s.library.scan();
        assert_eq!(ids(&listing), ["valley", "island", "single"]);
        assert_eq!(listing.packs[0].origin, Origin::MapsFolder);
        assert_eq!(listing.packs[1].origin, Origin::Location);
        assert_eq!(listing.hidden.len(), 1);
        assert!(listing.hidden[0].reason.contains("same id"));
        assert_eq!(listing.hidden[0].title, "Valley (old copy)");
        assert_eq!(
            s.registry.root("island").unwrap(),
            usb.join("Island copy").canonicalize().unwrap()
        );
        assert_eq!(s.registry.kind("island"), Some(PackKind::Folder));
        assert!(listing
            .locations
            .iter()
            .all(|l| l.state == LocationState::Ok));
        assert!(listing.maps_folder.is_default);

        // An unplugged drive: reported, remembered, and its packs no longer served.
        fs::rename(&usb, s.dir.0.join("unplugged")).unwrap();
        let listing = s.library.scan();
        assert_eq!(ids(&listing), ["valley", "single"]);
        assert_eq!(listing.locations[0].state, LocationState::Missing);
        assert!(s.registry.root("island").is_none());
        assert_eq!(s.library.settings().read().locations.len(), 2);
        // It comes back when the drive does.
        fs::rename(s.dir.0.join("unplugged"), &usb).unwrap();
        assert_eq!(ids(&s.library.scan()), ["valley", "island", "single"]);

        // Removing a location forgets it and deletes nothing.
        s.library
            .remove_location(&usb.display().to_string())
            .unwrap();
        assert_eq!(ids(&s.library.scan()), ["valley", "single"]);
        assert!(usb.join("Island copy/manifest.json").exists());
    }

    #[test]
    fn refuses_folders_that_are_not_packs() {
        let s = setup("library-refuse", Vec::new());
        let empty = s.dir.0.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(s
            .library
            .add_pack_location(&empty)
            .unwrap_err()
            .contains("not a map pack"));
        assert!(s
            .library
            .add_folder_location(&empty)
            .unwrap_err()
            .contains("no map packs"));
        let pack = s.dir.0.join("pack");
        write_pack(&pack, "p", "P", "1.0.0");
        assert!(s
            .library
            .add_folder_location(&pack)
            .unwrap_err()
            .contains("is a map pack itself"));
        fs::write(
            pack.join(MANIFEST_FILE),
            r#"{"schemaVersion":1,"gameId":"Bad Id","title":"x","packVersion":"1.0.0"}"#,
        )
        .unwrap();
        assert!(s.library.add_pack_location(&pack).is_err());
        // A location that stopped being a pack is reported.
        write_pack(&pack, "p", "P", "1.0.0");
        s.library.add_pack_location(&pack).unwrap();
        fs::remove_file(pack.join(MANIFEST_FILE)).unwrap();
        assert_eq!(s.library.scan().locations[0].state, LocationState::NotAPack);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_in_a_folder_of_packs() {
        let s = setup("library-symlink", Vec::new());
        let outside = s.dir.0.join("outside");
        write_pack(&outside, "secret", "Secret", "1.0.0");
        let folder = s.dir.0.join("folder");
        write_pack(&folder.join("real"), "real", "Real", "1.0.0");
        std::os::unix::fs::symlink(&outside, folder.join("link")).unwrap();
        s.library.add_folder_location(&folder).unwrap();
        assert_eq!(ids(&s.library.scan()), ["real"]);
    }

    #[test]
    fn installs_downloadable_bundled_packs_into_the_maps_folder() {
        let dir = TempDir::new("library-bundled-src");
        let resource = dir.0.join("valley");
        write_pack(&resource, "valley", "Valley", "1.0.0");
        let plain = dir.0.join("demo");
        write_pack(&plain, "demo", "Demo", "1.0.0");
        let bundled = vec![
            BundledPack {
                id: "valley".into(),
                path: resource.clone(),
                downloadable: true,
            },
            BundledPack {
                id: "demo".into(),
                path: plain.clone(),
                downloadable: false,
            },
        ];
        let s = setup("library-bundled", bundled.clone());
        let listing = s.library.start();
        assert_eq!(ids(&listing), ["valley"]);
        assert!(listing.packs[0].bundled);
        assert_eq!(s.registry.kind("demo"), Some(PackKind::Bundled));
        assert_eq!(s.registry.kind("valley"), Some(PackKind::Folder));
        let installed = s.library.maps_folder().join("valley");
        // Downloaded images in the folder are kept when a newer bundled version arrives.
        fs::create_dir_all(installed.join("tiles/a/0/0")).unwrap();
        fs::write(installed.join("tiles/a/0/0/0.jpg"), b"image").unwrap();
        write_pack(&resource, "valley", "Valley v2", "1.1.0");
        let s2 = Library::new(
            SettingsFile::new(s.dir.0.join("shared")),
            s.registry.clone(),
            bundled,
            Vec::new(),
        );
        assert_eq!(s2.start().packs[0].title, "Valley v2");
        assert_eq!(
            fs::read(installed.join("tiles/a/0/0/0.jpg")).unwrap(),
            b"image"
        );
        // An older bundled version changes nothing.
        write_pack(&resource, "valley", "Valley old", "0.5.0");
        assert_eq!(s2.start().packs[0].title, "Valley v2");
    }

    #[test]
    fn installs_bundled_packs_even_when_another_folder_has_a_copy() {
        let dir = TempDir::new("library-bundled-copy-src");
        let resource = dir.0.join("valley");
        write_pack(&resource, "valley", "Valley", "1.0.0");
        let bundled = vec![BundledPack {
            id: "valley".into(),
            path: resource,
            downloadable: true,
        }];
        let s = setup("library-bundled-copy", bundled);
        let usb = s.dir.0.join("usb");
        write_pack(&usb.join("valley"), "valley", "Valley on a stick", "1.0.0");
        s.library.add_folder_location(&usb).unwrap();
        let listing = s.library.start();
        assert_eq!(listing.packs.len(), 1);
        assert_eq!(listing.packs[0].origin, Origin::MapsFolder);
        assert_eq!(listing.hidden.len(), 1);
        assert_eq!(listing.hidden[0].title, "Valley on a stick");
    }

    #[test]
    fn moves_map_images_of_version_0_2_0_into_the_pack_folder() {
        let s = setup("library-migrate", Vec::new());
        let pack = s.library.maps_folder().join("valley");
        write_pack(&pack, "valley", "Valley", "1.0.0");
        // A v0.2.0 overlay with images, status files and an unfinished job.
        let old = s.dir.0.join("legacy/packs/valley");
        fs::create_dir_all(old.join("tiles/east/3/1")).unwrap();
        fs::create_dir_all(old.join("offline-tiles")).unwrap();
        fs::write(old.join("tiles/east/3/1/2.jpg"), b"tile").unwrap();
        fs::write(old.join("tiles/east/3/1/3.jpg.404"), b"").unwrap();
        fs::write(old.join("offline-tiles/east.json"), b"{}").unwrap();
        fs::create_dir_all(s.dir.0.join("legacy/downloads")).unwrap();
        fs::write(
            s.dir.0.join("legacy/downloads/valley.json"),
            br#"{"packId":"valley"}"#,
        )
        .unwrap();
        // An overlay of a pack that is not in the maps folder stays where it is.
        fs::create_dir_all(s.dir.0.join("legacy/packs/demo/tiles")).unwrap();
        // Part of the images moved already, as after an interrupted start.
        fs::create_dir_all(pack.join("tiles/east/3/1")).unwrap();
        fs::write(pack.join("tiles/east/3/1/2.jpg"), b"tile").unwrap();

        s.library.scan();
        assert_eq!(s.library.migrate_legacy(), ["valley"]);
        assert_eq!(
            fs::read(pack.join("tiles/east/3/1/2.jpg")).unwrap(),
            b"tile"
        );
        assert!(pack.join("tiles/east/3/1/3.jpg.404").exists());
        assert!(pack.join("offline-tiles/east.json").exists());
        assert!(pack.join(".atlas/download-job.json").exists());
        assert!(!old.exists());
        assert!(!s.dir.0.join("legacy/downloads/valley.json").exists());
        assert!(s.dir.0.join("legacy/packs/demo").exists());
        // Nothing left to do on the next start.
        assert!(s.library.migrate_legacy().is_empty());
    }

    #[test]
    fn locks_a_pack_folder_once() {
        let dir = TempDir::new("library-lock");
        let first = PackLock::acquire(&dir.0).unwrap();
        assert!(PackLock::acquire(&dir.0)
            .unwrap_err()
            .contains("Another Atlas"));
        drop(first);
        assert!(PackLock::acquire(&dir.0).is_ok());
    }

    fn import(pack_id: &str, key: &str) -> SaveImport {
        let manifest = format!(
            r#"{{"schemaVersion":2,"gameId":"{pack_id}","title":"Imported","packVersion":"1.0.0"}}"#
        );
        SaveImport {
            pack_id: pack_id.into(),
            importer: ImporterRef {
                id: "demo-maps".into(),
                title: "Demo".into(),
            },
            source_key: key.into(),
            page_url: format!("http://127.0.0.1/demo-maps/{pack_id}/{key}"),
            imported_at: "2026-11-10T00:00:00Z".into(),
            map_id: Some(format!("{pack_id}:map:{key}")),
            page_data: r#"{"page":1}"#.into(),
            files: [
                ("manifest.json".to_owned(), manifest),
                ("maps.json".to_owned(), "[]".to_owned()),
            ]
            .into(),
            refresh_bundled: false,
        }
    }

    #[test]
    fn keeps_a_game_with_no_map_read_from_pages() {
        let s = setup("library-pages", Vec::new());
        let mut request = import("pages", "start");
        request.map_id = None;
        request.files.remove("maps.json");
        request.files.insert(
            "guides.json".into(),
            r#"[{"id":"pages:guide:start","title":"Start","body":"Hello","locationIds":[]}]"#
                .into(),
        );
        request.files.insert(
            "sections.json".into(),
            r#"[{"id":"pages:section:a","title":"A","items":["pages:guide:start"]}]"#.into(),
        );
        request.files.insert("pictures.json".into(), "[]".into());
        let dir = s.library.save_import(&request).unwrap();
        assert!(dir.join("sections.json").exists() && dir.join("pictures.json").exists());
        assert!(!dir.join("maps.json").exists());
        assert_eq!(ids(&s.library.scan()), ["pages"]);
        let details = crate::packfile::pack_details(&crate::packfile::PackSource {
            pack_id: "pages".into(),
            root: dir.clone(),
            images: dir.clone(),
            lock: false,
            comes_with_app: false,
        })
        .unwrap();
        assert_eq!((details.contents.maps, details.contents.guides), (0, 1));
        assert!(details.layers.is_empty() && details.detail.is_none());
    }

    #[test]
    fn saves_imports_with_their_page_data() {
        let s = setup(
            "library-import",
            vec![BundledPack {
                id: "bundled".into(),
                path: PathBuf::from("/nowhere"),
                downloadable: true,
            }],
        );
        let dir = s.library.save_import(&import("valley", "east")).unwrap();
        assert!(dir.join("manifest.json").exists());
        s.library.scan();
        s.library.save_import(&import("valley", "west")).unwrap();
        let sources = s.library.saved_sources("valley", "demo-maps").unwrap();
        assert_eq!(
            sources.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(),
            ["east", "west"]
        );
        assert_eq!(sources[0].data, r#"{"page":1}"#);
        assert!(s
            .library
            .saved_sources("valley", "other")
            .unwrap()
            .is_empty());
        let listing = s.library.scan();
        assert_eq!(
            listing.packs[0]
                .imported
                .as_ref()
                .map(|i| i.importer_id.as_str()),
            None
        );

        let mut bad = import("valley", "east");
        bad.files.insert("../escape.json".into(), "{}".into());
        assert!(s.library.save_import(&bad).is_err());
        let mut bad = import("valley", "../x");
        bad.source_key = "../x".into();
        assert!(s.library.save_import(&bad).is_err());
        let mut bad = import("valley", "east");
        bad.files.insert("maps.json".into(), "not json".into());
        assert!(s.library.save_import(&bad).is_err());
        let mut bad = import("valley", "east");
        bad.pack_id = "other".into();
        assert!(s
            .library
            .save_import(&bad)
            .unwrap_err()
            .contains("another pack id"));
        assert!(s
            .library
            .save_import(&import("bundled", "x"))
            .unwrap_err()
            .contains("comes with the app"));
        let mut other_importer = import("valley", "east");
        other_importer.importer.id = "someone-else".into();
        assert!(s
            .library
            .save_import(&other_importer)
            .unwrap_err()
            .contains("another importer"));

        // A pack that was not imported is not replaced.
        write_pack(
            &s.library.maps_folder().join("handmade"),
            "handmade",
            "Hand",
            "1.0.0",
        );
        s.library.scan();
        assert!(s.library.save_import(&import("handmade", "x")).is_err());

        s.library.delete_pack("valley").unwrap();
        assert!(!dir.exists());
        assert!(s.registry.root("valley").is_none());
    }

    #[cfg(feature = "downloads")]
    #[test]
    fn builds_the_shrunk_levels_again_when_an_import_moves_the_images() {
        use image::{Rgb, RgbImage};
        const RED: [u8; 3] = [200, 0, 0];
        const BLUE: [u8; 3] = [0, 0, 200];
        const GREY: [u8; 3] = [90, 90, 90];
        let tile = |colour: [u8; 3]| {
            let mut out = io::Cursor::new(Vec::new());
            RgbImage::from_pixel(64, 64, Rgb(colour))
                .write_to(&mut out, image::ImageFormat::Png)
                .unwrap();
            out.into_inner()
        };
        // One 128 x 128 map: level 1 is 2 x 2 downloaded tiles, level 0 is
        // one tile that Atlas makes by shrinking them.
        let with_tiles_at = |url: &str| {
            let mut request = import("valley", "east");
            request.files.insert(
                "maps.json".into(),
                r#"[{"id":"valley:map:a","name":"Valley","width":128,"height":128}]"#.into(),
            );
            request.files.insert(
                "layers.json".into(),
                format!(
                    r#"[{{"id":"valley:layer:a","mapId":"valley:map:a","name":"Surface","minZoom":0,"maxZoom":1,"tileSize":64,
                      "tiles":{{"type":"xyz","url":"{url}","remote":{{
                        "urlTemplate":"https://tiles.invalid/{{z}}/{{x}}/{{y}}.png",
                        "levels":[{{"z":1,"sourceZ":1,"offsetX":0,"offsetY":0}}]}}}}}}]"#
                ),
            );
            request
        };
        let s = setup("library-moved-images", Vec::new());
        let dir = s
            .library
            .save_import(&with_tiles_at("tiles/a/{z}/{x}/{y}.png"))
            .unwrap();
        s.library.scan();
        // The downloaded images, and the level made from them while the pack
        // said column before row: `1/1/0.png` (blue) was the top right tile.
        let tiles = dir.join("tiles/a");
        for (path, colour) in [
            ("1/0/0.png", GREY),
            ("1/1/0.png", BLUE),
            ("1/0/1.png", RED),
            ("1/1/1.png", GREY),
        ] {
            fs::create_dir_all(tiles.join(path).parent().unwrap()).unwrap();
            fs::write(tiles.join(path), tile(colour)).unwrap();
        }
        fs::create_dir_all(tiles.join("0/0")).unwrap();
        fs::write(tiles.join("0/0/0.png"), b"the old arrangement").unwrap();

        // Without a record of the shrunk level, nothing is built.
        s.library
            .save_import(&with_tiles_at("tiles/a/{z}/{y}/{x}.png"))
            .unwrap();
        assert_eq!(
            fs::read(tiles.join("0/0/0.png")).unwrap(),
            b"the old arrangement"
        );
        s.library
            .save_import(&with_tiles_at("tiles/a/{z}/{x}/{y}.png"))
            .unwrap();
        fs::create_dir_all(dir.join("offline-tiles")).unwrap();
        fs::write(
            dir.join("offline-tiles/a.json"),
            r#"{"format":"atlas-tile-status","version":1,"layerId":"valley:layer:a","levels":[0,1],
                "nativeMinZoom":0,"nativeMaxZoom":1,"complete":true,"updatedAt":0}"#,
        )
        .unwrap();

        // The same addresses again: nothing is built.
        s.library
            .save_import(&with_tiles_at("tiles/a/{z}/{x}/{y}.png"))
            .unwrap();
        assert_eq!(
            fs::read(tiles.join("0/0/0.png")).unwrap(),
            b"the old arrangement"
        );

        // Row before column: `1/0/1.png` (red) is now the top right tile and
        // `1/1/0.png` (blue) the bottom left one, and level 0 follows.
        s.library
            .save_import(&with_tiles_at("tiles/a/{z}/{y}/{x}.png"))
            .unwrap();
        let built = image::open(tiles.join("0/0/0.png")).unwrap().to_rgb8();
        assert_eq!(built.dimensions(), (64, 64));
        let close = |x: u32, y: u32, colour: [u8; 3]| {
            let pixel = built.get_pixel(x, y).0;
            assert!(
                pixel.iter().zip(colour).all(|(a, b)| a.abs_diff(b) <= 6),
                "({x}, {y}) is {pixel:?}, not {colour:?}"
            );
        };
        close(16, 16, GREY);
        close(48, 16, RED);
        close(16, 48, BLUE);
        close(48, 48, GREY);
        // The images themselves and their record are untouched.
        assert_eq!(fs::read(tiles.join("1/0/1.png")).unwrap(), tile(RED));
        assert!(dir.join("offline-tiles/a.json").exists());
    }

    /// A 64 px tile whose colour says which remote tile it is.
    #[cfg(feature = "downloads")]
    fn remote_tile(z: u64, x: u64, y: u64) -> Vec<u8> {
        use image::{Rgb, RgbImage};
        let mut out = io::Cursor::new(Vec::new());
        RgbImage::from_pixel(
            64,
            64,
            Rgb([(z * 10) as u8, (x % 25 * 10) as u8, (y % 25 * 10) as u8]),
        )
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
        out.into_inner()
    }

    /// The `layers.json` of a layer `id` of 64 px tiles, at `url` in the
    /// pack, whose levels 2 and 3 are remote zooms 12 and 13 of `template`,
    /// level 3 at `offset`.
    #[cfg(feature = "downloads")]
    fn remote_layer(id: &str, map: &str, url: &str, template: &str, offset: (u64, u64)) -> String {
        let (x, y) = offset;
        format!(
            r#"{{"id":"{id}","mapId":"{map}","name":"Surface","minZoom":0,"maxZoom":3,"tileSize":64,
              "tiles":{{"type":"xyz","url":"{url}","remote":{{"urlTemplate":"{template}",
                "levels":[{{"z":2,"sourceZ":12,"offsetX":{},"offsetY":{}}},{{"z":3,"sourceZ":13,"offsetX":{x},"offsetY":{y}}}]}}}}}}"#,
            x / 2,
            y / 2
        )
    }

    /// An import of `valley` with two maps of `size` px: `a`, whose layer
    /// comes from `template` (see [`remote_layer`]), and `b`, whose layer has
    /// no remote source.
    #[cfg(feature = "downloads")]
    fn valley(template: &str, size: (u32, u32), offset: (u64, u64)) -> SaveImport {
        let (width, height) = size;
        let mut request = import("valley", "east");
        request.files.insert(
            "maps.json".into(),
            format!(
                r#"[{{"id":"valley:map:a","name":"Valley","width":{width},"height":{height}}},
                    {{"id":"valley:map:b","name":"Caves","width":{width},"height":{height}}}]"#
            ),
        );
        let a = remote_layer(
            "valley:layer:a",
            "valley:map:a",
            "tiles/a/{z}/{x}/{y}.png",
            template,
            offset,
        );
        request.files.insert(
            "layers.json".into(),
            format!(
                r#"[{a},{{"id":"valley:layer:b","mapId":"valley:map:b","name":"Caves","minZoom":0,"maxZoom":3,"tileSize":64,
                    "tiles":{{"type":"xyz","url":"tiles/b/{{z}}/{{x}}/{{y}}.png"}}}}]"#
            ),
        );
        request
    }

    #[cfg(feature = "downloads")]
    async fn finished(manager: &crate::tiles::DownloadManager) -> crate::tiles::manager::Snapshot {
        use crate::tiles::manager::JobState;
        for _ in 0..800 {
            let snapshot = manager.snapshot("valley").unwrap();
            if !matches!(
                snapshot.state,
                JobState::Running | JobState::Paused | JobState::Queued | JobState::Waiting
            ) {
                return snapshot;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("the download did not finish");
    }

    /// An update that enlarges a layer east and south keeps every image
    /// downloaded, says that the layer is no longer complete, and the next
    /// download fetches only the new images.
    #[cfg(feature = "downloads")]
    #[tokio::test(flavor = "multi_thread")]
    async fn keeps_the_downloaded_images_when_an_update_enlarges_a_layer() {
        use crate::tiles::{
            download::{
                tests::{ensure_crypto, MockServer, Reply},
                Settings,
            },
            manager::JobState,
            pyramid::Detail,
            DownloadManager,
        };
        use std::{collections::HashSet, sync::Arc, time::Duration};
        ensure_crypto();
        let server = MockServer::start(Arc::new(|path, _| {
            let numbers: Vec<u64> = path
                .trim_end_matches(".png")
                .rsplit('/')
                .take(3)
                .map(|n| n.parse().unwrap())
                .collect();
            Reply::image(remote_tile(numbers[2], numbers[1], numbers[0]))
        }))
        .await;
        let template = server.url("/r/{z}/{x}/{y}.png");
        let s = setup("library-renumber-grow", Vec::new());
        // 320 x 320 px: level 3 is 5 x 5 tiles, level 2 is 3 x 3.
        let dir = s
            .library
            .save_import(&valley(&template, (320, 320), (40, 80)))
            .unwrap();
        s.library.scan();
        fs::create_dir_all(dir.join("tiles/b/3/4")).unwrap();
        fs::write(dir.join("tiles/b/3/4/4.png"), b"the caves' own image").unwrap();
        let manager = Arc::new(DownloadManager::with_settings(
            s.dir.0.join("data"),
            s.registry.clone(),
            Settings {
                delay: Duration::from_millis(1),
                ..Settings::default()
            },
        ));
        manager.start("valley", Detail::Full).unwrap();
        let done = finished(&manager).await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        assert_eq!(server.seen().len(), 25 + 9);
        let first: HashSet<String> = server.seen().into_iter().map(|seen| seen.path).collect();
        let status = || -> serde_json::Value {
            serde_json::from_str(&fs::read_to_string(dir.join("offline-tiles/a.json")).unwrap())
                .unwrap()
        };
        assert_eq!(status()["complete"], true);

        // Two more columns on the east and two more rows on the south at
        // level 3, one more at level 2: 448 x 448 px, the same offsets.
        s.library
            .save_import(&valley(&template, (448, 448), (40, 80)))
            .unwrap();
        assert!(!dir.join(".atlas/renumber").exists());
        for (z, x, y, remote) in [
            (3, 0, 0, (13, 40, 80)),
            (3, 4, 4, (13, 44, 84)),
            (2, 2, 1, (12, 22, 41)),
        ] {
            assert_eq!(
                fs::read(dir.join(format!("tiles/a/{z}/{x}/{y}.png"))).unwrap(),
                remote_tile(remote.0, remote.1, remote.2),
                "{z}/{x}/{y}"
            );
        }
        assert!(dir.join("tiles/a/0/0/0.png").exists(), "built again");
        assert!(!dir.join("tiles/a/3/5/0.png").exists());
        assert_eq!(status()["levels"], serde_json::json!([]));
        assert_eq!(status()["complete"], false);
        // The layer without a remote source is left alone.
        assert_eq!(
            fs::read(dir.join("tiles/b/3/4/4.png")).unwrap(),
            b"the caves' own image"
        );
        // The download offers exactly the new images.
        let info = manager.plan_info("valley").unwrap();
        let full = info
            .options
            .iter()
            .find(|option| option.detail == Detail::Full)
            .unwrap();
        assert_eq!((full.tiles, full.remaining), (49 + 16, 24 + 7));
        assert!(!full.installed);

        manager.start("valley", Detail::Full).unwrap();
        let done = finished(&manager).await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        let again: Vec<String> = server.seen()[34..]
            .iter()
            .map(|seen| seen.path.clone())
            .collect();
        assert_eq!(again.len(), 24 + 7);
        assert!(
            again.iter().all(|path| !first.contains(path)),
            "nothing twice"
        );
        assert_eq!(status()["levels"], serde_json::json!([0, 1, 2, 3]));
        assert_eq!(status()["complete"], true);
        assert!(manager
            .plan_info("valley")
            .unwrap()
            .options
            .iter()
            .all(|o| o.installed));

        // A new image source: nothing can be mapped, so nothing is moved
        // (the zoomed-out levels are not built again either, as before).
        let other = server.url("/v2/{z}/{x}/{y}.png");
        let before = fs::read(dir.join("tiles/a/3/6/6.png")).unwrap();
        s.library
            .save_import(&valley(&other, (320, 320), (38, 78)))
            .unwrap();
        assert_eq!(fs::read(dir.join("tiles/a/3/6/6.png")).unwrap(), before);
        assert_eq!(status()["complete"], true);
        assert!(!dir.join(".atlas/renumber").exists());
    }

    /// An import whose picture was measured is saved with what the
    /// measurement found, and the first download asks for none of it.
    #[cfg(feature = "downloads")]
    #[tokio::test(flavor = "multi_thread")]
    async fn an_import_is_seeded_with_its_measured_picture() {
        use crate::tiles::{
            download::{
                tests::{ensure_crypto, MockServer, Reply},
                Settings,
            },
            manager::JobState,
            measure::{MeasureRequest, PictureCache},
            pyramid::Detail,
            DownloadManager,
        };
        use std::{sync::Arc, time::Duration};
        ensure_crypto();
        // The picture is the remote zoom 12 tiles 20-21 x 40-41, and the zoom
        // 13 tiles under them; nothing else is on the server.
        let server = MockServer::start(Arc::new(|path, _| {
            let numbers: Vec<u64> = path
                .trim_end_matches(".png")
                .rsplit('/')
                .take(3)
                .map(|n| n.parse().unwrap())
                .collect();
            let (z, x, y) = (numbers[2], numbers[1], numbers[0]);
            let shift = 13 - z;
            if (40 >> shift..=43 >> shift).contains(&x) && (80 >> shift..=83 >> shift).contains(&y)
            {
                Reply::image(remote_tile(z, x, y))
            } else {
                Reply::status(404)
            }
        }))
        .await;
        let template = server.url("/r/{z}/{x}/{y}.png");
        let s = setup("library-seed-measured", Vec::new());
        let data = s.dir.0.join("data");
        let manager = Arc::new(DownloadManager::with_settings(
            data.clone(),
            s.registry.clone(),
            Settings {
                delay: Duration::from_millis(1),
                ..Settings::default()
            },
        ));
        let measured = manager
            .measure_picture(&MeasureRequest {
                url_template: template.clone(),
                zoom: 12,
                start: [20, 40],
                cached_only: false,
                page: None,
            })
            .await
            .unwrap();
        assert_eq!((measured.present.len(), measured.absent.len()), (4, 12));
        assert_eq!(server.seen().len(), 16);

        // Level 2 of the pack (3 x 3 tiles) copies zoom 12 from 20, 40.
        let library = s.library.with_picture_cache(PictureCache::new(&data));
        let dir = library
            .save_import(&valley(&template, (320, 320), (40, 80)))
            .unwrap();
        library.scan();
        assert_eq!(
            fs::read(dir.join("tiles/a/2/1/1.png")).unwrap(),
            remote_tile(12, 21, 41)
        );
        for (x, y) in [(2, 0), (2, 1), (0, 2), (1, 2), (2, 2)] {
            assert!(dir.join(format!("tiles/a/2/{x}/{y}.png.404")).is_file());
        }
        // No level counts as complete before a download has recorded it.
        assert!(!dir.join("offline-tiles/a.json").exists());
        // The download asks only for the zoom 13 tiles under the picture.
        manager.start("valley", Detail::Full).unwrap();
        let done = finished(&manager).await;
        assert_eq!(done.state, JobState::Done, "{:?}", done.reason);
        let asked: Vec<String> = server.seen()[16..]
            .iter()
            .map(|seen| seen.path.clone())
            .collect();
        assert_eq!(asked.len(), 16, "{asked:?}");
        assert!(asked.iter().all(|path| path.starts_with("/r/13/")));
        assert_eq!((done.saved, done.not_asked, done.failed), (16, 9, 0));
    }

    /// A game that comes with the app and is served from its resources keeps
    /// its downloaded images in the app's overlay folder; a refresh that moves
    /// a layer's edges renumbers them there.
    #[cfg(feature = "downloads")]
    #[test]
    fn renumbers_the_images_of_a_game_that_comes_with_the_app_in_its_overlay() {
        let src = TempDir::new("library-renumber-overlay-src");
        let resource = src.0.join("isles");
        write_pack(&resource, "isles", "Isles", "1.0.0");
        let template = "https://tiles.invalid/{z}/{x}/{y}.png";
        let north = |size: u32, offset: (u64, u64)| {
            (
                format!(
                    r#"[{{"id":"isles:map:north","name":"North","width":{size},"height":{size}}}]"#
                ),
                format!(
                    "[{}]",
                    remote_layer(
                        "isles:layer:north",
                        "isles:map:north",
                        "tiles/north/{z}/{x}/{y}.png",
                        template,
                        offset
                    )
                ),
            )
        };
        let (maps, layers) = north(320, (40, 80));
        fs::write(resource.join("maps.json"), maps).unwrap();
        fs::write(resource.join("layers.json"), layers).unwrap();
        let s = setup(
            "library-renumber-overlay",
            vec![BundledPack {
                id: "isles".into(),
                path: resource.clone(),
                downloadable: false,
            }],
        );
        let overlays = s.dir.0.join("data/packs");
        s.registry.set_overlay_root(overlays.clone());
        s.library.start();
        assert_eq!(s.registry.kind("isles"), Some(PackKind::Bundled));
        // Images downloaded into the overlay: level 3 (remote zoom 13, from
        // 40, 80) and level 2 (remote zoom 12, from 20, 40), one of them not
        // on the server, and a status file.
        let overlay = overlays.join("isles");
        let tile = |z: u8, x: u64, y: u64| overlay.join(format!("tiles/north/{z}/{x}/{y}.png"));
        for (z, columns, (dx, dy)) in [(3u8, 5u64, (40u64, 80u64)), (2, 3, (20, 40))] {
            for y in 0..columns {
                for x in 0..columns {
                    fs::create_dir_all(tile(z, x, y).parent().unwrap()).unwrap();
                    if (z, x, y) == (3, 1, 1) {
                        fs::write(format!("{}.404", tile(z, x, y).display()), b"").unwrap();
                    } else {
                        fs::write(tile(z, x, y), remote_tile(z as u64 + 10, x + dx, y + dy))
                            .unwrap();
                    }
                }
            }
        }
        fs::create_dir_all(overlay.join("offline-tiles")).unwrap();
        fs::write(
            overlay.join("offline-tiles/north.json"),
            r#"{"format":"atlas-tile-status","version":1,"layerId":"isles:layer:north","levels":[0,1,2,3],
                "nativeMinZoom":0,"nativeMaxZoom":3,"complete":true,"updatedAt":0}"#,
        )
        .unwrap();

        // The refresh moves the image's corner two tiles up and left at level 3.
        let mut request = refresh("1.1.0", &["north"]);
        let (maps, layers) = north(448, (38, 78));
        request.files.insert("maps.json".into(), maps);
        request.files.insert("layers.json".into(), layers);
        let dir = s.library.save_import(&request).unwrap();
        assert_eq!(dir, s.library.maps_folder().join("isles"));
        assert!(!overlay.join(".atlas/renumber").exists());
        // The old tile (0, 0) of level 3 is (2, 2) now, its marker (1, 1) is
        // at (3, 3), and the old (2, 2) is at (4, 4).
        assert_eq!(fs::read(tile(3, 2, 2)).unwrap(), remote_tile(13, 40, 80));
        assert_eq!(fs::read(tile(3, 4, 4)).unwrap(), remote_tile(13, 42, 82));
        assert!(!tile(3, 0, 0).exists());
        assert!(Path::new(&format!("{}.404", tile(3, 3, 3).display())).exists());
        assert!(!Path::new(&format!("{}.404", tile(3, 1, 1).display())).exists());
        assert_eq!(fs::read(tile(2, 1, 1)).unwrap(), remote_tile(12, 20, 40));
        assert!(tile(0, 0, 0).exists(), "built again in the overlay");
        let status: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(overlay.join("offline-tiles/north.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(status["levels"], serde_json::json!([]));
        assert_eq!(status["complete"], false);
        // Nothing was written into the app's own copy or the new pack folder.
        assert!(!resource.join("tiles").exists());
        assert!(!dir.join("tiles").exists());
    }

    /// A newer version of a game that comes with the app replaces the pack
    /// files of its copy in the maps folder; images of a layer whose edges it
    /// moves are renumbered there.
    #[cfg(feature = "downloads")]
    #[test]
    fn renumbers_the_images_when_a_newer_bundled_version_moves_a_layer() {
        let src = TempDir::new("library-renumber-bundled-src");
        let resource = src.0.join("isles");
        let write_version = |version: &str, size: u32, offset: (u64, u64)| {
            write_pack(&resource, "isles", "Isles", version);
            fs::write(
                resource.join("maps.json"),
                format!(
                    r#"[{{"id":"isles:map:north","name":"North","width":{size},"height":{size}}}]"#
                ),
            )
            .unwrap();
            fs::write(
                resource.join("layers.json"),
                format!(
                    "[{}]",
                    remote_layer(
                        "isles:layer:north",
                        "isles:map:north",
                        "tiles/north/{z}/{x}/{y}.png",
                        "https://tiles.invalid/{z}/{x}/{y}.png",
                        offset
                    )
                ),
            )
            .unwrap();
        };
        write_version("1.0.0", 320, (40, 80));
        let bundled = vec![BundledPack {
            id: "isles".into(),
            path: resource.clone(),
            downloadable: true,
        }];
        let s = setup("library-renumber-bundled", bundled.clone());
        s.library.start();
        let copy = s.library.maps_folder().join("isles");
        let tile = |x: u64, y: u64| copy.join(format!("tiles/north/3/{x}/{y}.png"));
        for y in 0..5 {
            for x in 0..5 {
                fs::create_dir_all(tile(x, y).parent().unwrap()).unwrap();
                fs::write(tile(x, y), remote_tile(13, x + 40, y + 80)).unwrap();
            }
        }
        // The same version again changes nothing.
        Library::new(
            SettingsFile::new(s.dir.0.join("shared")),
            s.registry.clone(),
            bundled.clone(),
            Vec::new(),
        )
        .start();
        assert_eq!(fs::read(tile(0, 0)).unwrap(), remote_tile(13, 40, 80));

        // Version 2.0.0 moves the corner two tiles up and left.
        write_version("2.0.0", 448, (38, 78));
        let listing = Library::new(
            SettingsFile::new(s.dir.0.join("shared")),
            s.registry.clone(),
            bundled,
            Vec::new(),
        )
        .start();
        assert_eq!(listing.packs[0].pack_version, "2.0.0");
        assert!(!copy.join(".atlas/renumber").exists());
        assert_eq!(fs::read(tile(2, 2)).unwrap(), remote_tile(13, 40, 80));
        assert_eq!(fs::read(tile(6, 6)).unwrap(), remote_tile(13, 44, 84));
        assert!(!tile(0, 0).exists());
        let status: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(copy.join("offline-tiles/north.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(status["complete"], false);
    }

    #[test]
    fn a_pack_with_files_in_use_is_hidden_at_once_and_removed_at_the_next_start() {
        let mut s = setup("library-delete-held", Vec::new());
        let maps = s.library.maps_folder();
        write_pack(&maps.join("my-game"), "my-game", "My Game", "1.0.0");
        write_pack(&maps.join("other"), "other", "Other", "1.0.0");
        fs::create_dir_all(maps.join("my-game/tiles/a/0/0")).unwrap();
        fs::write(maps.join("my-game/tiles/a/0/0/0.png"), b"image").unwrap();
        assert_eq!(ids(&s.library.scan()), ["my-game", "other"]);
        // A file in the pack stays in use, as another program can do on Windows.
        s.library.set_file_ops(FileOps {
            remove_tree: std::sync::Arc::new(|_| {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "in use"))
            }),
            retry_waits: vec![std::time::Duration::from_millis(1)],
            ..FileOps::default()
        });
        let deleted = s.library.delete_pack("my-game").unwrap();
        assert!(!deleted.complete);
        assert_eq!(
            ids(&s.library.scan()),
            ["other"],
            "gone from the list at once"
        );
        assert!(s.registry.root("my-game").is_none());
        assert!(maps.join(".deleting-my-game").is_dir());
        assert_eq!(s.library.finish_deletes().len(), 1, "still in use");

        // The next start, with the file released.
        let next = Library::new(
            SettingsFile::new(s.dir.0.join("shared")),
            s.registry.clone(),
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(ids(&next.start()), ["other"]);
        assert!(next.finish_deletes().is_empty());
        assert!(!maps.join(".deleting-my-game").exists());
        assert!(maps.join("other/manifest.json").exists());
    }

    #[test]
    fn refuses_to_delete_packs_that_come_with_the_app_or_live_elsewhere() {
        let dir = TempDir::new("library-delete-refuse-src");
        let resource = dir.0.join("valley");
        write_pack(&resource, "valley", "Valley", "1.0.0");
        let s = setup(
            "library-delete-refuse",
            vec![BundledPack {
                id: "valley".into(),
                path: resource,
                downloadable: true,
            }],
        );
        s.library.start();
        assert!(s
            .library
            .delete_pack("valley")
            .unwrap_err()
            .contains("comes with the app"));
        let usb = s.dir.0.join("usb/My Game");
        write_pack(&usb, "my-game", "My Game", "1.0.0");
        s.library.add_pack_location(&usb).unwrap();
        s.library.scan();
        assert!(s
            .library
            .delete_pack("my-game")
            .unwrap_err()
            .contains("Remove from list"));
        assert!(usb.join("manifest.json").exists());
        assert!(s
            .library
            .maps_folder()
            .join("valley/manifest.json")
            .exists());
    }

    #[test]
    fn changes_the_maps_folder_with_or_without_moving() {
        let s = setup("library-move", Vec::new());
        write_pack(
            &s.library.maps_folder().join("valley"),
            "valley",
            "Valley",
            "1.0.0",
        );
        let target = s.dir.0.join("new maps");
        let choice = s.library.propose_maps_folder(&target).unwrap();
        assert_eq!(choice.packs, 1);
        assert!(choice.can_move);
        assert_eq!(s.library.apply_maps_folder(true, &[]).unwrap(), ["valley"]);
        assert!(target.join("valley/manifest.json").exists());
        assert_eq!(s.library.maps_folder(), target);
        assert_eq!(ids(&s.library.scan()), ["valley"]);

        // Without moving, the old folder stays visible as a location.
        let third = s.dir.0.join("third");
        s.library.propose_maps_folder(&third).unwrap();
        assert!(s.library.apply_maps_folder(false, &[]).unwrap().is_empty());
        let listing = s.library.scan();
        assert_eq!(listing.packs[0].origin, Origin::Location);
        assert!(
            s.library.apply_maps_folder(false, &[]).is_err(),
            "needs a new choice"
        );
    }

    #[test]
    fn takes_the_persons_own_lists_along_when_the_maps_folder_changes() {
        let s = setup("library-move-lists", Vec::new());
        let old = s.library.maps_folder();
        write_pack(&old.join("valley"), "valley", "Valley", "1.0.0");
        let lists = r#"{"format":"atlas-own-lists","version":1,"gameId":"valley","lists":[]}"#;
        crate::ownlists::write(&old, "valley", lists, None).unwrap();

        // Moved with the packs.
        let target = s.dir.0.join("new maps");
        s.library.propose_maps_folder(&target).unwrap();
        s.library.apply_maps_folder(true, &[]).unwrap();
        assert!(!old.join("valley.my-lists.json").exists());
        assert_eq!(
            crate::ownlists::read(&target, "valley").unwrap().as_deref(),
            Some(lists)
        );

        // Copied when the old folder stays listed with its packs.
        let third = s.dir.0.join("third");
        s.library.propose_maps_folder(&third).unwrap();
        s.library.apply_maps_folder(false, &[]).unwrap();
        assert!(target.join("valley.my-lists.json").exists());
        assert_eq!(
            crate::ownlists::read(&third, "valley").unwrap().as_deref(),
            Some(lists)
        );
    }

    /// A bundled pack with two maps, and, when asked, the page data it was made from.
    fn write_bundled(dir: &Path, id: &str, version: &str, page_data: bool) {
        write_pack(dir, id, "Isles", version);
        fs::write(
            dir.join("maps.json"),
            format!(r#"[{{"id":"{id}:map:north","name":"North"}},{{"id":"{id}:map:south","name":"South"}}]"#),
        )
        .unwrap();
        if page_data {
            fs::create_dir_all(dir.join("import")).unwrap();
            fs::write(dir.join("import/north.json"), r#"{"page":"north"}"#).unwrap();
            fs::write(dir.join("import/south.json"), r#"{"page":"south"}"#).unwrap();
            fs::write(
                dir.join("import/index.json"),
                r#"{"format":"atlas-import","version":1,"importer":{"id":"demo-maps","title":"Demo"},"sources":[
                  {"key":"north","url":"http://127.0.0.1/demo-maps/isles/north","importedAt":"2026-01-01T00:00:00Z","mapId":"isles:map:north","file":"north.json"},
                  {"key":"south","url":"http://127.0.0.1/demo-maps/isles/south","importedAt":"2026-01-01T00:00:00Z","mapId":"isles:map:south","file":"south.json"}]}"#,
            )
            .unwrap();
        }
    }

    /// A refresh of the bundled pack `isles` with the given version and maps.
    fn refresh(version: &str, maps: &[&str]) -> SaveImport {
        let mut request = import("isles", "north");
        request.refresh_bundled = true;
        request.files.insert(
            "manifest.json".into(),
            format!(
                r#"{{"schemaVersion":2,"gameId":"isles","title":"Isles refreshed","packVersion":"{version}","source":{{"importer":{{"id":"demo-maps","title":"Demo"}},"pages":[{{"url":"http://127.0.0.1/demo-maps/isles/north"}}]}}}}"#
            ),
        );
        let maps: Vec<String> = maps
            .iter()
            .map(|map| format!(r#"{{"id":"isles:map:{map}","name":"{map}"}}"#))
            .collect();
        request
            .files
            .insert("maps.json".into(), format!("[{}]", maps.join(",")));
        request
    }

    #[test]
    fn refreshes_a_bundled_pack_with_downloaded_images_in_the_maps_folder() {
        let src = TempDir::new("library-refresh-dl-src");
        let resource = src.0.join("isles");
        write_bundled(&resource, "isles", "1.0.0", true);
        let bundled = vec![BundledPack {
            id: "isles".into(),
            path: resource.clone(),
            downloadable: true,
        }];
        let s = setup("library-refresh-dl", bundled.clone());
        s.library.start();
        let copy = s.library.maps_folder().join("isles");
        // Installed with the page data it came with, so it can be refreshed.
        assert_eq!(
            s.library.saved_sources("isles", "demo-maps").unwrap().len(),
            2
        );
        fs::create_dir_all(copy.join("tiles/north/0/0")).unwrap();
        fs::write(copy.join("tiles/north/0/0/0.png"), b"downloaded").unwrap();

        // Not without the importer's say-so, not at the same version, not without a map.
        let mut plain = refresh("1.1.0", &["north", "south"]);
        plain.refresh_bundled = false;
        assert!(s
            .library
            .save_import(&plain)
            .unwrap_err()
            .contains("comes with the app"));
        assert!(s
            .library
            .save_import(&refresh("1.0.0", &["north", "south"]))
            .unwrap_err()
            .contains("newer version"));
        let error = s
            .library
            .save_import(&refresh("1.1.0", &["north"]))
            .unwrap_err();
        assert!(
            error.contains("leave out maps it came with: South"),
            "{error}"
        );
        assert_eq!(read_head(&copy).unwrap().pack_version, "1.0.0");

        let dir = s
            .library
            .save_import(&refresh("1.1.0", &["north", "south"]))
            .unwrap();
        assert_eq!(dir, copy.canonicalize().unwrap());
        let listing = s.library.scan();
        assert_eq!(listing.packs[0].title, "Isles refreshed");
        assert!(listing.packs[0].bundled);
        assert_eq!(listing.packs[0].pages.len(), 1);
        assert_eq!(
            fs::read(copy.join("tiles/north/0/0/0.png")).unwrap(),
            b"downloaded"
        );
        let sources = s.library.saved_sources("isles", "demo-maps").unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].data, r#"{"page":1}"#, "the page read now");
        assert_eq!(
            sources[1].data, r#"{"page":"south"}"#,
            "the page it came with"
        );

        // A start-up keeps the refresh while it is at least the bundled version.
        let again = || {
            Library::new(
                SettingsFile::new(s.dir.0.join("shared")),
                s.registry.clone(),
                bundled.clone(),
                Vec::new(),
            )
        };
        assert_eq!(again().start().packs[0].title, "Isles refreshed");
        // An app whose bundled pack is newer replaces it, page data too, and keeps the images.
        write_bundled(&resource, "isles", "2.0.0", true);
        fs::write(resource.join("import/north.json"), r#"{"page":"north v2"}"#).unwrap();
        let listing = again().start();
        assert_eq!(listing.packs[0].title, "Isles");
        assert_eq!(listing.packs[0].pack_version, "2.0.0");
        let sources = s.library.saved_sources("isles", "demo-maps").unwrap();
        assert_eq!(sources[0].data, r#"{"page":"north v2"}"#);
        assert_eq!(
            fs::read(copy.join("tiles/north/0/0/0.png")).unwrap(),
            b"downloaded"
        );
    }

    #[test]
    fn adds_the_page_data_a_bundled_pack_comes_with_to_an_older_install() {
        let src = TempDir::new("library-refresh-add-src");
        let resource = src.0.join("isles");
        write_bundled(&resource, "isles", "1.0.0", false);
        let bundled = vec![BundledPack {
            id: "isles".into(),
            path: resource.clone(),
            downloadable: true,
        }];
        let s = setup("library-refresh-add", bundled.clone());
        s.library.start();
        assert!(s
            .library
            .saved_sources("isles", "demo-maps")
            .unwrap()
            .is_empty());
        // The same version, now with page data.
        write_bundled(&resource, "isles", "1.0.0", true);
        Library::new(
            SettingsFile::new(s.dir.0.join("shared")),
            s.registry.clone(),
            bundled,
            Vec::new(),
        )
        .start();
        assert_eq!(
            s.library.saved_sources("isles", "demo-maps").unwrap().len(),
            2
        );
    }

    #[test]
    fn refreshes_a_bundled_pack_served_from_the_app_into_the_maps_folder() {
        let src = TempDir::new("library-refresh-app-src");
        let resource = src.0.join("isles");
        write_bundled(&resource, "isles", "1.0.0", true);
        fs::create_dir_all(resource.join("tiles")).unwrap();
        fs::write(resource.join("tiles/north.pmtiles"), b"shipped").unwrap();
        let bundled = vec![BundledPack {
            id: "isles".into(),
            path: resource.clone(),
            downloadable: false,
        }];
        let s = setup("library-refresh-app", bundled.clone());
        assert!(s.library.start().packs.is_empty());
        assert_eq!(s.registry.kind("isles"), Some(PackKind::Bundled));
        // Its page data is not read from the app's own folder.
        assert!(s
            .library
            .saved_sources("isles", "demo-maps")
            .unwrap()
            .is_empty());

        let dir = s
            .library
            .save_import(&refresh("1.1.0", &["north", "south"]))
            .unwrap();
        let copy = s.library.maps_folder().join("isles");
        assert_eq!(dir, copy);
        assert_eq!(
            fs::read(copy.join("tiles/north.pmtiles")).unwrap(),
            b"shipped"
        );
        let listing = s.library.scan();
        assert_eq!(ids(&listing), ["isles"]);
        assert_eq!(listing.packs[0].origin, Origin::MapsFolder);
        assert_eq!(s.registry.kind("isles"), Some(PackKind::Folder));
        assert_eq!(
            s.library.saved_sources("isles", "demo-maps").unwrap().len(),
            2
        );
        assert!(
            resource.join("manifest.json").exists(),
            "the app's copy is untouched"
        );
        assert_eq!(read_head(&resource).unwrap().pack_version, "1.0.0");

        // Kept at the next start; replaced by a newer bundled version.
        let again = || {
            Library::new(
                SettingsFile::new(s.dir.0.join("shared")),
                s.registry.clone(),
                bundled.clone(),
                Vec::new(),
            )
        };
        assert_eq!(again().start().packs[0].title, "Isles refreshed");
        write_bundled(&resource, "isles", "1.2.0", true);
        fs::write(resource.join("tiles/north.pmtiles"), b"shipped v2").unwrap();
        let listing = again().start();
        assert_eq!(listing.packs[0].pack_version, "1.2.0");
        assert_eq!(listing.packs[0].origin, Origin::MapsFolder);
        assert_eq!(
            fs::read(copy.join("tiles/north.pmtiles")).unwrap(),
            b"shipped v2"
        );
        // An older copy (from a newer app's refresh being replaced) never wins over the app.
        write_pack(&copy, "isles", "Old copy", "0.1.0");
        let listing = s.library.scan();
        assert!(listing.packs.is_empty());
        assert_eq!(listing.hidden.len(), 1);
        assert_eq!(s.registry.kind("isles"), Some(PackKind::Bundled));
    }
}
