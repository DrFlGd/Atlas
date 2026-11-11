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

use crate::{
    manifest::{read_head, version_key, write_atomic, ManifestHead, MANIFEST_FILE},
    packs::{is_valid_pack_id, PackKind, PackRegistry, IMPORT_DIR},
    removal::{self, FileOps, ImagesCount, ImagesDeleted, PackDeleted},
    settings::{default_maps_folder, Location, LocationKind, SettingsFile, SharedSettings},
    tiles::manager::stop::ImagesLocation,
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
];
const MAX_PACK_FILE_BYTES: usize = 64 << 20;
const MAX_PACK_BYTES: usize = 256 << 20;
/// Page data larger than this is refused (the web app checks the same).
pub const MAX_PAGE_DATA_BYTES: usize = 64 << 20;

/// The app identifier of the Atlas viewer, whose data folder held downloaded
/// map images before they moved into pack folders (version 0.2.0).
pub const LEGACY_IDENTIFIER: &str = "dev.atlas.desktop";

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The URL a registered pack is served at.
pub fn pack_url(id: &str) -> String {
    if cfg!(windows) {
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
            Err(fs::TryLockError::WouldBlock) => Err(
                "Another Atlas window or app is working on this map's files right now. Try again when it has finished."
                    .to_owned(),
            ),
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
    pub map_id: String,
    /// The page data as JSON text.
    pub page_data: String,
    /// Pack files by name, as JSON text.
    pub files: BTreeMap<String, String>,
}

pub struct Library {
    settings: SettingsFile,
    registry: PackRegistry,
    bundled: Vec<BundledPack>,
    /// Old app data folders whose `packs/<id>/` overlays move into pack folders.
    legacy_dirs: Vec<PathBuf>,
    busy: Mutex<HashSet<String>>,
    pending_folder: Mutex<Option<PathBuf>>,
    /// How files are removed; tests act out files that are in use.
    file_ops: FileOps,
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
            file_ops: FileOps::default(),
        }
    }

    #[cfg(test)]
    pub fn set_file_ops(&mut self, file_ops: FileOps) {
        self.file_ops = file_ops;
    }

    pub fn settings(&self) -> &SettingsFile {
        &self.settings
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

    /// Start-up: registers bundled packs, installs the downloadable ones into
    /// the maps folder when they are not anywhere yet (or the maps folder has
    /// an older version), and lists every folder.
    pub fn start(&self) -> Listing {
        let mut listing = self.scan();
        for pack in &self.bundled {
            let installed = pack.downloadable && self.install_bundled(pack, &listing).is_ok();
            if !installed && self.registry.kind(&pack.id) != Some(PackKind::Folder) {
                if let Err(error) = self.registry.register(&pack.id, &pack.path) {
                    eprintln!(
                        "atlas: skipping bundled pack {}: {error}",
                        pack.path.display()
                    );
                }
            }
            if installed {
                listing = self.scan();
            }
        }
        self.scan()
    }

    /// Copies a bundled pack into the maps folder when the maps folder has no
    /// pack with its id, or updates the pack files of the maps folder's copy
    /// when the bundled one is newer. Map images and other files in the folder
    /// are never touched. A copy in another location is then not shown, since
    /// the maps folder comes first, and the Maps dialog says so.
    fn install_bundled(&self, pack: &BundledPack, listing: &Listing) -> Result<(), String> {
        let bundled = read_head(&pack.path)?;
        let shown = listing.packs.iter().find(|listed| listed.id == pack.id);
        let target = self.maps_folder().join(&pack.id);
        match shown {
            Some(listed) if listed.origin == Origin::MapsFolder => {
                let existing = listed.path.as_deref().map(PathBuf::from).unwrap_or(target);
                if version_key(&bundled.pack_version) <= version_key(&listed.pack_version) {
                    return Ok(());
                }
                let _lock = PackLock::acquire(&existing)?;
                copy_pack_files(&pack.path, &existing, true)
                    .map_err(|error| format!("Could not update {}: {error}", pack.id))
            }
            _ => {
                if target.join(MANIFEST_FILE).exists() {
                    return Err(format!("{} holds another pack", target.display()));
                }
                fs::create_dir_all(&target)
                    .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
                let _lock = PackLock::acquire(&target)?;
                copy_tree_missing(&pack.path, &target)
                    .map_err(|error| format!("Could not install {}: {error}", pack.id))
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

        for pack in &self.bundled {
            if !pack.downloadable {
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
            });
            true
        };

        for (dir, head) in packs_in(&maps_folder).0 {
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
                    eprintln!("atlas: cannot serve {}: {error}", dir.display());
                    false
                }
            }
        });

        let mut busy: Vec<String> = lock(&self.busy).iter().cloned().collect();
        busy.sort();
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
        if let Some(error) = failure {
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
        if self.is_bundled(&request.pack_id)
            || self.registry.kind(&request.pack_id) == Some(PackKind::Bundled)
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
        } else if read_head(&dir).is_ok() {
            return Err("A pack with this id that was not imported from a web page is already there, so it is not replaced.".to_owned());
        }
        let _lock = PackLock::acquire(&dir)?;
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
        let mut index = read_import_index(&dir).unwrap_or(ImportIndex {
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
            map_id: Some(request.map_id.clone()),
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
        write(&dir.join(MANIFEST_FILE), manifest)?;
        Ok(dir)
    }

    /// Whether a pack id is listed (registered to be served).
    pub fn is_listed(&self, id: &str) -> bool {
        self.registry.root(id).is_some()
    }

    fn check_not_moving(&self, id: &str) -> Result<(), String> {
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
                    continue;
                };
                let Ok(_lock) = PackLock::acquire(&target) else {
                    continue;
                };
                lock(&self.busy).insert(id.clone());
                let result = migrate_overlay(
                    &source,
                    &target,
                    &legacy.join("downloads").join(format!("{id}.json")),
                );
                lock(&self.busy).remove(&id);
                match result {
                    Ok(()) => moved.push(id),
                    Err(error) => eprintln!("atlas: moving the map images of {id}: {error}"),
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

/// Copies the top-level pack files of `from` into `to`, replacing them when
/// `replace` is set. Map images and other folders are not touched.
fn copy_pack_files(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    for name in PACK_FILES {
        let source = from.join(name);
        if !source.is_file() {
            continue;
        }
        let target = to.join(name);
        if replace || !target.exists() {
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
            map_id: format!("{pack_id}:map:{key}"),
            page_data: r#"{"page":1}"#.into(),
            files: [
                ("manifest.json".to_owned(), manifest),
                ("maps.json".to_owned(), "[]".to_owned()),
            ]
            .into(),
        }
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
}
