//! Old folders, on a reader (see `library::READER`): the folder maps,
//! wikis and guides in the maps folder that a reader no longer uses, now
//! that it reads every map, wiki and guide from its pack file where it
//! lies. Nothing is converted and no progress is carried over: the folders
//! are listed, with their size, and removed only when the person confirms.
//!
//! What is listed:
//!
//! - Only pack folders directly inside the maps folder (`library::packs_in`):
//!   never a folder in an added location, never a pack that comes with the
//!   app, never anything outside the maps folder, never a folder that is
//!   not a pack (such as a game's own photos beside its folder).
//! - Never a **working folder of an app that reads sites** (a build with
//!   downloads), which is what [`is_working_folder`] tells. When any folder
//!   of the maps folder is one, or the shared settings or the Sites folder
//!   show that such an app uses this computer's maps folder (see
//!   [`site_reader_here`]), nothing at all is offered.
//! - A game **made in the app on this computer** (its manifest says
//!   `madeInApp`, and it was not imported from a pack file, which leaves
//!   `.atlas/pack-file.json`) is listed apart (`made_here`), for the web
//!   app to show only when asked, and never in "Remove all listed".
//!
//! Removing one uses the delete of a pack folder (`Library::delete_folder`,
//! `removal::delete_pack_folder`): renamed to a hidden name and removed,
//! never through a link out of the folder, and finished at the next start
//! when a file is still in use. The person's own things of the game, kept
//! beside its folder by its id, stay; so do found marks, which are in the
//! app's storage.

use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::{
    activity::{self, Area},
    library::{is_inside, packs_in, same_path, Library, Listing, JOB_FILE, META_DIR},
    manifest::{read_head, ManifestHead},
    packfile::{read_imported_record, EXTENSION},
    packs::IMPORT_DIR,
    removal::{is_real_dir, PackDeleted},
    settings::LocationKind,
    sites::sites_folder,
};

/// Why nothing is offered for removal: another app that reads sites keeps
/// its maps and wikis in this maps folder.
pub const SITE_READER_HERE: &str = "The maps folder on this computer is also used by another app that reads sites and keeps its maps and wikis there as folders, so Atlas offers none of them for removal.";

/// What a reader that is not one says when asked.
const NOT_IN_THIS_APP: &str =
    "This app keeps its maps and wikis as folders, so it offers none of them for removal.";

/// The most files and folders a size counts in one folder.
pub const MAX_SIZE_ENTRIES: u64 = 1_000_000;
/// The longest a size is counted for in one folder.
pub const MAX_SIZE_TIME: Duration = Duration::from_secs(20);

/// A folder map, wiki or guide in the maps folder.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OldFolder {
    /// The folder's name in the maps folder: what a removal names.
    pub folder: String,
    /// The folder's path, to show.
    pub path: String,
    pub id: String,
    pub title: String,
    /// The pack file of the same game (same id) that Atlas reads and shows
    /// once the folder is gone, when there is one.
    pub pack_file: Option<String>,
}

/// The old folders of the maps folder.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OldFolders {
    pub maps_folder: String,
    /// An app that reads sites uses this maps folder: nothing is offered,
    /// and the lists are empty.
    pub site_reader: bool,
    /// Folder maps, wikis and guides this app no longer uses.
    pub folders: Vec<OldFolder>,
    /// Games made in the app on this computer, which exist only here unless
    /// a pack file of them is there.
    pub made_here: Vec<OldFolder>,
}

/// How much room a folder takes on the disk.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderSize {
    pub bytes: u64,
    pub files: u64,
    /// Every file was counted. Otherwise a limit stopped the count, and the
    /// folder takes at least this much.
    pub complete: bool,
}

/// A folder the person asked to remove, as the list named it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OldFolderRef {
    pub folder: String,
    pub id: String,
}

/// What came of removing one folder.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OldFolderRemoved {
    pub folder: String,
    pub id: String,
    pub removed: bool,
    /// Every file went. Otherwise some were in use and go at the next
    /// start; the folder is out of every list either way.
    pub complete: bool,
    /// Why it was not removed.
    pub problem: Option<String>,
}

/// Whether a pack folder is a working folder of an app that reads sites:
///
/// - it holds page data kept by "Add a map" (an `import` entry, in any
///   case, as the pack protocol refuses it), or
/// - an unfinished download (`.atlas/download-job.json`), or
/// - its manifest names an importer or the web pages it was read from
///   (`source.importer`, `source.pages`) and it was not imported from a
///   pack file (no `.atlas/pack-file.json`, which an import writes): a pack
///   read from pages here. A pack file keeps the manifest's `source` but
///   never `import/`, so a game imported from a pack file made by such an
///   app is not one.
///
/// A folder whose entries cannot be read counts as one, so nothing is
/// offered on a guess.
pub fn is_working_folder(dir: &Path, head: &ManifestHead) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return true;
    };
    let page_data = entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(IMPORT_DIR))
    });
    let download = fs::symlink_metadata(dir.join(META_DIR).join(JOB_FILE)).is_ok();
    let read_from_pages =
        (head.importer.is_some() || !head.pages.is_empty()) && read_imported_record(dir).is_none();
    page_data || download || read_from_pages
}

/// Whether the game was made in the app on this computer: its manifest
/// says `madeInApp` and it was not imported from a pack file.
pub fn is_made_here(dir: &Path, head: &ManifestHead) -> bool {
    head.made_in_app && read_imported_record(dir).is_none()
}

/// Whether the shared settings or the shared folder show that an app that
/// reads sites uses this computer's maps folder: it noted its last start
/// in the settings (`siteReaderStartedAt`), or the Sites folder of its site
/// rules files is there. Every Atlas app on a computer uses the maps folder
/// the shared settings name, so such an app uses this one.
pub fn site_reader_here(library: &Library) -> bool {
    library.settings().read().site_reader_started_at.is_some()
        || fs::symlink_metadata(sites_folder(library.settings().dir())).is_ok()
}

/// The old folders of the maps folder. Blocking: reads every pack folder's
/// manifest and looks at every folder Atlas reads again.
pub fn list(library: &Library) -> OldFolders {
    let listing = library.scan();
    let maps = library.maps_folder();
    let locations: Vec<PathBuf> = library
        .settings()
        .read()
        .locations
        .iter()
        .filter(|location| location.kind == LocationKind::Pack)
        .map(|location| PathBuf::from(&location.path))
        .collect();
    let mut site_reader = site_reader_here(library);
    let mut folders = Vec::new();
    let mut made_here = Vec::new();
    for (dir, head) in packs_in(&maps).0 {
        if library.is_bundled(&head.id) {
            continue;
        }
        // A pack folder the person added as a location of its own.
        if locations.iter().any(|location| same_path(location, &dir)) {
            continue;
        }
        if is_working_folder(&dir, &head) {
            site_reader = true;
            continue;
        }
        let Some(folder) = dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let old = OldFolder {
            folder: folder.to_owned(),
            path: dir.display().to_string(),
            pack_file: pack_file_of(&listing, &head.id),
            id: head.id.clone(),
            title: head.title.clone(),
        };
        if is_made_here(&dir, &head) {
            made_here.push(old);
        } else {
            folders.push(old);
        }
    }
    if site_reader {
        folders.clear();
        made_here.clear();
    }
    OldFolders {
        maps_folder: maps.display().to_string(),
        site_reader,
        folders,
        made_here,
    }
}

/// The pack file of a game that Atlas reads: the one shown, or, while a
/// folder of the game is shown, the first of the game's pack files not
/// shown, which is the one shown once the folder is gone (they are listed
/// in the order the rule of one pack per id ranks them).
fn pack_file_of(listing: &Listing, id: &str) -> Option<String> {
    let is_pack_file = |path: &str| {
        Path::new(path)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case(EXTENSION))
    };
    listing
        .packs
        .iter()
        .find(|pack| pack.id == id && pack.pack_file)
        .and_then(|pack| pack.path.clone())
        .or_else(|| {
            listing
                .hidden
                .iter()
                .find(|pack| pack.id == id && is_pack_file(&pack.path))
                .map(|pack| pack.path.clone())
        })
}

/// The pack folder of the maps folder a name from the list names: one
/// plain name, of a real folder (not a link) that is a pack.
fn folder_named(maps: &Path, name: &str) -> Result<PathBuf, String> {
    let mut parts = Path::new(name).components();
    let plain = matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    ) && !name.starts_with('.')
        && !name.contains(['/', '\\']);
    let gone = || "That folder is not in the maps folder any more. Look again.".to_owned();
    if !plain {
        return Err(gone());
    }
    let dir = maps.join(name);
    if !is_real_dir(&dir) || !is_inside(&dir, maps) || read_head(&dir).is_err() {
        return Err(gone());
    }
    Ok(dir)
}

/// How much room a folder of the maps folder takes, by its name in the
/// list. See [`folder_size`].
pub fn size_of(library: &Library, name: &str) -> Result<FolderSize, String> {
    let dir = folder_named(&library.maps_folder(), name)?;
    Ok(folder_size(&dir, MAX_SIZE_ENTRIES, MAX_SIZE_TIME))
}

/// How much room the files in `dir` and its sub-folders take, without
/// following a link (a link counts as nothing): at most `max_entries`
/// files and folders, for at most `max_time`. When a limit stops the
/// count, what was counted is given as not complete.
pub fn folder_size(dir: &Path, max_entries: u64, max_time: Duration) -> FolderSize {
    let started = Instant::now();
    let mut size = FolderSize {
        complete: true,
        ..FolderSize::default()
    };
    let mut seen = 0_u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(folder) = stack.pop() {
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > max_entries || started.elapsed() > max_time {
                size.complete = false;
                return size;
            }
            // Not followed when it is a link.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                size.files += 1;
                size.bytes += entry.metadata().map_or(0, |metadata| metadata.len());
            }
        }
    }
    size
}

/// Removes the old folders asked for, each only when it is still listed
/// as one (by its name and its game's id), with the delete of a pack
/// folder. `active` tells a game whose map images are downloading, which
/// is not removed. Blocking.
pub fn remove(
    library: &Library,
    wanted: &[OldFolderRef],
    active: &dyn Fn(&str) -> bool,
) -> Vec<OldFolderRemoved> {
    let now = list(library);
    let maps = library.maps_folder();
    wanted
        .iter()
        .map(|asked| {
            let mut outcome = OldFolderRemoved {
                folder: asked.folder.clone(),
                id: asked.id.clone(),
                removed: false,
                complete: false,
                problem: None,
            };
            let listed = now
                .folders
                .iter()
                .chain(&now.made_here)
                .any(|old| old.folder == asked.folder && old.id == asked.id);
            let checked = if now.site_reader {
                Err(SITE_READER_HERE.to_owned())
            } else if !listed {
                Err("That folder is not one of the old folders any more. Look again.".to_owned())
            } else if active(&asked.id) {
                Err("Map images of this game are downloading. Pause or cancel that first, then try again.".to_owned())
            } else {
                library
                    .check_not_moving(&asked.id)
                    .and_then(|()| folder_named(&maps, &asked.folder))
            };
            let deleted = checked.and_then(|dir| library.delete_folder(&dir, &asked.id));
            match deleted {
                Ok(PackDeleted { complete }) => {
                    outcome.removed = true;
                    outcome.complete = complete;
                    activity::info(
                        Area::Library,
                        format!(
                            "Removed the old folder {} ({}) from the maps folder{}",
                            activity::clean(&asked.folder),
                            activity::clean(&asked.id),
                            if complete {
                                ""
                            } else {
                                "; some files were in use and are removed at the next start"
                            }
                        ),
                    );
                }
                Err(problem) => {
                    activity::warn(
                        Area::Library,
                        format!(
                            "Did not remove the old folder {}: {problem}",
                            activity::clean(&asked.folder)
                        ),
                    );
                    outcome.problem = Some(problem);
                }
            }
            outcome
        })
        .collect()
}

/// Refuses, with the reason, in an app that is not a reader.
pub fn check_reader() -> Result<(), String> {
    if crate::library::READER {
        Ok(())
    } else if cfg!(desktop) {
        Err(NOT_IN_THIS_APP.to_owned())
    } else {
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

#[cfg(test)]
mod tests;
