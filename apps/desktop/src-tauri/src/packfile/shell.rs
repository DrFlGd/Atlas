//! Pack files and the maps library: which packs can be exported, from
//! where, and which files may be imported, and how. The commands in
//! `commands.rs` call these.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{
    add::{self, AddInfo},
    export::{export_with_mine, Exported},
    import::{existing_folder, import, read_header, Imported},
    pack_details, pack_file_details, AppInfo, Header, Mine, PackDetails, PackSource, Progress,
    Stop, EXTENSION,
};
use crate::{
    downloads::Downloads,
    library::{Library, Origin, PACK_FILE_NO_EXPORT, READER},
    manifest::{read_head, version_key},
    packs::PackKind,
    tiles::pyramid::Detail,
};

const DOWNLOADING: &str =
    "Map images of this game are downloading. Pause or cancel that first, then try again.";

/// Where a listed pack's files and map images are.
pub fn source_for(
    library: &Library,
    downloads: &Downloads,
    id: &str,
) -> Result<PackSource, String> {
    let registry = library.registry();
    // A pack file is not read as a folder, and not exported again.
    if registry.kind(id) == Some(PackKind::File) {
        return Err(PACK_FILE_NO_EXPORT.to_owned());
    }
    let root = registry.root(id).ok_or_else(|| {
        "That game is not in the list any more. Refresh the list and try again.".to_owned()
    })?;
    let kind = registry.kind(id);
    // Downloaded images: in the pack folder, or in the overlay of a pack
    // served from the app's resources (see `tiles::images`).
    let images = downloads
        .images_location(id)
        .map_or_else(|_| root.clone(), |location| location.root);
    Ok(PackSource {
        pack_id: id.to_owned(),
        lock: kind == Some(PackKind::Folder),
        comes_with_app: library.is_bundled(id),
        own_use_pictures: false,
        type_pictures: false,
        smaller_pictures: false,
        group: None,
        root,
        images,
    })
}

/// The facts about a listed pack, for the Maps dialog.
/// For a pack read from a pack file, the facts of its description.
pub fn details(library: &Library, downloads: &Downloads, id: &str) -> Result<PackDetails, String> {
    if let Some(pack) = library.registry().pack_file(id) {
        let checked = pack.check()?;
        return Ok(pack_file_details(pack.path(), checked.header()));
    }
    pack_details(&source_for(library, downloads, id)?)
}

/// Exports a listed pack; see [`export`]. Refused while its download runs
/// or its files are being moved.
#[allow(clippy::too_many_arguments)]
pub fn export_pack(
    library: &Library,
    downloads: &Downloads,
    id: &str,
    app: &AppInfo,
    detail: Detail,
    destination: &Path,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Exported, Stop> {
    export_pack_with_mine(
        library,
        downloads,
        id,
        app,
        detail,
        destination,
        false,
        false,
        false,
        false,
        progress,
        cancelled,
    )
}

/// [`export_pack`], with the person's own lists, locations and types of the
/// game from beside its folder in the maps folder when `include_mine` is
/// set and there are any, and with the pictures downloaded for the
/// person's own use (location photos, pictures of guide pages) when
/// `own_use_pictures` is set, with the pictures of its types (the map's
/// icons) when `type_pictures` is set, and the pictures made smaller as
/// they are written when `smaller_pictures` is set.
#[allow(clippy::too_many_arguments)]
pub fn export_pack_with_mine(
    library: &Library,
    downloads: &Downloads,
    id: &str,
    app: &AppInfo,
    detail: Detail,
    destination: &Path,
    include_mine: bool,
    own_use_pictures: bool,
    type_pictures: bool,
    smaller_pictures: bool,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Exported, Stop> {
    // The title of the game's group names the game in the description
    // whether or not its file goes in too; one that cannot be read only
    // leaves the pack's own title there.
    let group = crate::gamegroups::carried(&library.maps_folder(), id)
        .ok()
        .flatten();
    let source = PackSource {
        own_use_pictures,
        type_pictures,
        smaller_pictures,
        group,
        ..source_for(library, downloads, id)?
    };
    if downloads.is_active(id) {
        return Err(Stop::Failed(DOWNLOADING.to_owned()));
    }
    library.check_not_moving(id)?;
    let mine = if include_mine {
        Mine::read(&library.maps_folder(), id)?
    } else {
        Mine::default()
    };
    export_with_mine(
        &source,
        app,
        detail,
        destination,
        &mine,
        progress,
        cancelled,
    )
}

/// What the Import dialog shows about a file before anything is written.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub file_name: String,
    /// The file's size on disk.
    pub size: u64,
    pub header: Header,
    /// The game with this id that is shown now, if any.
    pub installed: Option<Installed>,
    /// Importing replaces a pack in the maps folder (in its own folder).
    pub replaces: bool,
    /// Why this file cannot be imported here, in plain words.
    pub blocked: Option<String>,
    /// On a reader (see `library::READER`), what adding the file to the
    /// packs folder would do: there it is kept a file, never unpacked, so
    /// it replaces nothing.
    pub adds: Option<AddInfo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub title: String,
    /// `bundled`, `maps-folder` or `location`.
    pub origin: Origin,
    pub folder: Option<String>,
    pub details: Option<PackDetails>,
}

/// Whether a path names a pack file: an existing file whose name ends
/// in `.atlaspack`. Only such files are opened.
fn checked_path(path: &Path) -> Result<(), String> {
    let named = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(EXTENSION));
    if !named {
        return Err("Only Atlas pack files (.atlaspack) can be imported.".to_owned());
    }
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        _ => Err("That file cannot be found.".to_owned()),
    }
}

/// Reads a pack file's header and says what importing it would do.
pub fn inspect(library: &Library, downloads: &Downloads, path: &Path) -> Result<FileInfo, String> {
    checked_path(path)?;
    let header = read_header(path)?;
    let id = header.pack_id.clone();
    let listing = library.scan();
    let installed = listing
        .packs
        .iter()
        .find(|pack| pack.id == id)
        .map(|pack| Installed {
            title: pack.title.clone(),
            origin: pack.origin,
            folder: pack.path.clone(),
            details: details(library, downloads, &id).ok(),
        });
    // A pack that comes with the app and is served from it is not listed.
    let installed = installed.or_else(|| {
        library.bundled_pack(&id).map(|pack| Installed {
            title: read_head(&pack.path)
                .map(|head| head.title)
                .unwrap_or_else(|_| id.clone()),
            origin: Origin::Bundled,
            folder: None,
            details: details(library, downloads, &id).ok(),
        })
    });
    let (replaces, blocked, adds) = if READER {
        (false, None, Some(add::info(library, path, &header)?))
    } else {
        match check_import(library, downloads, &header) {
            Ok(existing) => (existing.is_some(), None, None),
            Err(reason) => (false, Some(reason), None),
        }
    };
    Ok(FileInfo {
        path: path.display().to_string(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: std::fs::metadata(path).map_or(0, |m| m.len()),
        header,
        installed,
        replaces,
        blocked,
        adds,
    })
}

/// Whether a file with this header may be imported here, and the pack
/// folder in the maps folder it would replace.
///
/// A game that comes with this app is imported only in a version at least
/// as new as the app's (an older one would be overwritten or hidden at the
/// next start), and, when the app serves it from its own files (its map
/// images all come with it), only in a newer version: the same version
/// would just put a second copy of what the app already shows into the
/// maps folder. An accepted one goes into the maps folder like a game
/// refreshed from its site, and is shown in place of the app's.
pub fn check_import(
    library: &Library,
    downloads: &Downloads,
    header: &Header,
) -> Result<Option<PathBuf>, String> {
    let id = &header.pack_id;
    if let Some(pack) = library.bundled_pack(id) {
        let ours = read_head(&pack.path)?;
        let (file, app) = (
            version_key(&header.pack_version),
            version_key(&ours.pack_version),
        );
        if file < app {
            return Err(format!(
                "{} comes with this app in version {}, which is newer than the version {} in this file, so it was not imported.",
                ours.title, ours.pack_version, header.pack_version
            ));
        }
        if file == app && !pack.downloadable {
            return Err(format!(
                "{} comes with this app in the same version ({}), with all its map images, so there is nothing to import.",
                ours.title, ours.pack_version
            ));
        }
    }
    if downloads.is_active(id) {
        return Err(DOWNLOADING.to_owned());
    }
    library.check_not_moving(id)?;
    existing_folder(&library.maps_folder(), id)
}

/// Imports a pack file into the maps folder; see [`import`]. With
/// `replace` false, a game already in the maps folder is not replaced (the
/// Import dialog asks first).
pub fn import_pack_file(
    library: &Library,
    downloads: &Downloads,
    path: &Path,
    replace: bool,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Imported, Stop> {
    checked_path(path)?;
    let header = read_header(path)?;
    let existing = check_import(library, downloads, &header)?;
    if existing.is_some() && !replace {
        return Err(Stop::Failed(format!(
            "{} is already in the maps folder. Choose to replace it to import this file.",
            header.title
        )));
    }
    import(path, &library.maps_folder(), progress, cancelled)
}

/// Adds a pack file on a reader: a copy in the packs folder, read where
/// it lies; see [`add::add`].
pub fn add_pack_file(
    library: &Library,
    path: &Path,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<add::Added, Stop> {
    checked_path(path)?;
    add::add(library, path, progress, cancelled)
}
