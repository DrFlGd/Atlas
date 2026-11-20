//! Adding a pack file, on a reader (see `library::READER`): the file is
//! kept a file. It is copied into the packs folder and read there where
//! it lies, like any pack file of that folder, rather than unpacked into
//! the maps folder as an import does.
//!
//! - The copy is written as `<name>.part` in the packs folder (a `.part`
//!   file is never read) and renamed to its name once it is complete and
//!   has passed every check an import makes ([`check_whole`]), so a
//!   failure or a cancel leaves nothing behind.
//! - A file already in the packs folder is not copied again.
//! - **The same name.** When the packs folder has a file of that name, it is
//!   the same pack file when it has the same size and the same description
//!   (the description says when the file was made, to the second): then
//!   nothing is copied. Otherwise the copy gets the first free name of
//!   `<name> (2).atlaspack`, `<name> (3).atlaspack`…, so a pack file is
//!   never replaced. Atlas never changes, renames or deletes a pack file.
//! - **The same game.** A pack file of a game (pack id) shown already is
//!   added all the same; which one is shown is the rule of one pack per id
//!   (`library.rs`): a folder of the game before any pack file, and of two
//!   pack files the one whose pack was changed last. The dialog says
//!   before and after which one that is.
//! - The person's own things a file carries (`mine/`) are taken as an
//!   import takes them, for the web app to add to theirs, kept in the maps
//!   folder by the game's id.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;

use super::{
    import::{check_whole, read_header, SPACE_MARGIN},
    iso_millis, space, Header, Mine, Progress, Stop, EXTENSION,
};
use crate::{
    library::{is_inside, same_path, Library, Listing},
    manifest::read_head,
};

/// How much is copied between two looks at Cancel.
const CHUNK: usize = 1 << 20;
/// Names tried for the copy when its own is taken.
const MAX_NAMES: u32 = 100;

/// What adding a pack file would do, for the dialog before anything is
/// written.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddInfo {
    /// The packs folder.
    pub folder: String,
    /// The name the file has in the packs folder once added.
    pub file_name: String,
    /// It is copied there. Otherwise it is there already: the file chosen
    /// is in the packs folder, or the same file is.
    pub copy: bool,
    /// Another file has the file's own name there, so the copy gets
    /// `file_name` instead.
    pub renamed: bool,
    /// Which pack of the same game is shown once it is added, when that is
    /// not simply this file.
    pub note: Option<String>,
}

/// A pack file added.
#[derive(Clone, Debug)]
pub struct Added {
    pub pack_id: String,
    pub title: String,
    pub header: Header,
    /// The file in the packs folder.
    pub path: PathBuf,
    /// It was copied there now.
    pub copied: bool,
    /// The person's own things it carries, checked to be this game's.
    pub mine: Mine,
}

/// Where the file goes.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Plan {
    /// The file is in the packs folder already.
    InPlace,
    /// The same file is in the packs folder already, at this path.
    There(PathBuf),
    /// It is copied to `target`, which is free, as is `target` + `.part`.
    Copy { target: PathBuf, renamed: bool },
}

impl Plan {
    fn path(&self, source: &Path) -> PathBuf {
        match self {
            Plan::InPlace => source.to_path_buf(),
            Plan::There(path) | Plan::Copy { target: path, .. } => path.clone(),
        }
    }
}

/// `<path>.part`.
fn part_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Where a pack file with this description goes in the packs folder.
fn plan(packs: &Path, source: &Path, header: &Header) -> Result<Plan, String> {
    if is_inside(source, packs) {
        return Ok(Plan::InPlace);
    }
    let name = source
        .file_name()
        .ok_or_else(|| "That file cannot be found.".to_owned())?;
    let size = fs::metadata(source).map_or(0, |metadata| metadata.len());
    let stem = Path::new(name)
        .file_stem()
        .map_or_else(String::new, |stem| stem.to_string_lossy().into_owned());
    let extension = Path::new(name).extension().map_or_else(
        || EXTENSION.to_owned(),
        |extension| extension.to_string_lossy().into_owned(),
    );
    for n in 1..=MAX_NAMES {
        let target = if n == 1 {
            packs.join(name)
        } else {
            packs.join(format!("{stem} ({n}).{extension}"))
        };
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if fs::symlink_metadata(part_of(&target)).is_err() {
                    return Ok(Plan::Copy {
                        target,
                        renamed: n > 1,
                    });
                }
            }
            Ok(metadata)
                if metadata.is_file()
                    && metadata.len() == size
                    && read_header(&target).is_ok_and(|there| there == *header) =>
            {
                return Ok(Plan::There(target));
            }
            _ => {}
        }
    }
    Err(format!(
        "The packs folder has too many files called like {}, so nothing was added. Rename the file and try again.",
        Path::new(name).display()
    ))
}

/// The packs folder, made when missing.
fn packs_folder(library: &Library) -> Result<PathBuf, String> {
    library.ensure_packs_folder()
}

/// What adding the pack file at `source`, with this description, would do.
pub fn info(library: &Library, source: &Path, header: &Header) -> Result<AddInfo, String> {
    let packs = packs_folder(library)?;
    let plan = plan(&packs, source, header)?;
    let path = plan.path(source);
    let listing = library.scan();
    Ok(AddInfo {
        folder: packs.display().to_string(),
        file_name: crate::commands::file_name(&path),
        copy: matches!(plan, Plan::Copy { .. }),
        renamed: matches!(plan, Plan::Copy { renamed: true, .. }),
        note: note(library, &listing, header, &path, true),
    })
}

/// Which pack of the game is shown, when it is not simply the file at
/// `path`: the copy that comes with the app, a folder of the game, or
/// another pack file of it. `before` says it of the file still to be
/// added, by the rule of one pack per id; otherwise of the listing as it is.
pub fn note(
    library: &Library,
    listing: &Listing,
    header: &Header,
    path: &Path,
    before: bool,
) -> Option<String> {
    let id = &header.pack_id;
    let Some(shown) = listing.packs.iter().find(|pack| pack.id == *id) else {
        let bundled = library.bundled_pack(id)?;
        let title = read_head(&bundled.path).map_or_else(|_| header.title.clone(), |h| h.title);
        return Some(format!(
            "{title} comes with this app, and the app’s own copy is shown before any pack file of the same game. The pack file is kept in the packs folder."
        ));
    };
    let shown_path = shown.path.clone().unwrap_or_default();
    if !shown.pack_file {
        return Some(format!(
            "{} is shown from its folder, {shown_path}, because a folder of a game is shown before any pack file of the same game. Once that folder is gone, the pack file is shown. Old folders can be removed in the settings.",
            shown.title
        ));
    }
    if same_path(Path::new(&shown_path), path) {
        return None;
    }
    let ours = (
        header.pack.updated.as_deref().and_then(iso_millis),
        iso_millis(&header.exported_at),
    );
    let theirs = shown
        .file_version
        .map_or((None, None), |version| (version.changed, version.made));
    let first = ours > theirs || (ours == theirs && path < Path::new(&shown_path));
    if before && first {
        return Some(format!(
            "It is shown in place of {shown_path}, another pack file of the same game whose pack was changed earlier. That file stays where it is."
        ));
    }
    Some(format!(
        "Another pack file of the same game, {shown_path}, is shown, because of two pack files of the same game the one whose pack was changed last is shown. This file is kept in the packs folder."
    ))
}

/// Removes a `.part` file unless it was renamed into place.
struct Part {
    path: PathBuf,
    kept: bool,
}

impl Drop for Part {
    fn drop(&mut self) {
        if !self.kept {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Adds the pack file at `source` (an existing `.atlaspack` file): copies
/// it into the packs folder through a `.part` file unless it is there
/// already, checks the copy as an import checks a file, and renames it to
/// its name. `progress` is told how far the copy is (in bytes, with no
/// entries) and then the check (by entries); `cancelled` is asked between
/// steps. A failure or a cancel leaves nothing in the packs folder.
pub fn add(
    library: &Library,
    source: &Path,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Added, Stop> {
    add_with(
        library,
        source,
        &space::available,
        &[100, 250, 500, 1000].map(Duration::from_millis),
        progress,
        cancelled,
    )
}

/// [`add`], with the free space check and the waits before a rename is
/// tried again given (tests act out a full disk).
pub(crate) fn add_with(
    library: &Library,
    source: &Path,
    free_space: &dyn Fn(&Path) -> Option<u64>,
    retry_waits: &[Duration],
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Added, Stop> {
    let header = read_header(source)?;
    let packs = packs_folder(library)?;
    let plan = plan(&packs, source, &header)?;
    let Plan::Copy { target, .. } = plan else {
        // There already: checked for the person's own things it carries.
        let path = plan.path(source);
        let checked = check_whole(&path, progress, cancelled)?;
        return Ok(Added {
            pack_id: checked.header.pack_id.clone(),
            title: checked.title,
            header: checked.header,
            path,
            copied: false,
            mine: checked.mine,
        });
    };
    let size = fs::metadata(source)
        .map_err(|error| format!("Could not open the file: {error}"))?
        .len();
    match free_space(&packs) {
        Some(free) if free < size.saturating_add(SPACE_MARGIN) => {
            return Err(Stop::Failed(format!(
                "There is not enough free space for this pack file: it needs {} and the drive of the packs folder has {} free.",
                space::describe(size),
                space::describe(free)
            )));
        }
        _ => {}
    }
    let part_path = part_of(&target);
    let mut from =
        File::open(source).map_err(|error| format!("Could not open the file: {error}"))?;
    let mut to = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part_path)
        .map_err(|error| format!("Could not write to the packs folder: {error}"))?;
    let mut part = Part {
        path: part_path,
        kept: false,
    };
    let mut buffer = vec![0; CHUNK];
    let mut copied = 0_u64;
    let at = |bytes_done: u64| Progress {
        bytes_done,
        bytes_total: size.max(bytes_done),
        ..Progress::default()
    };
    progress(at(0));
    loop {
        if cancelled() {
            return Err(Stop::Cancelled);
        }
        let read = from
            .read(&mut buffer)
            .map_err(|error| format!("Could not read the file: {error}"))?;
        if read == 0 {
            break;
        }
        to.write_all(&buffer[..read])
            .map_err(|error| format!("Could not write to the packs folder: {error}"))?;
        copied += read as u64;
        progress(at(copied));
    }
    to.sync_all()
        .map_err(|error| format!("Could not write to the packs folder: {error}"))?;
    drop(to);
    drop(from);
    let changed = || {
        Stop::Failed(
            "The file changed while it was being copied, so nothing was added. Try again."
                .to_owned(),
        )
    };
    if copied != size {
        return Err(changed());
    }
    let checked = check_whole(&part.path, progress, cancelled)?;
    if checked.header != header {
        return Err(changed());
    }
    if cancelled() {
        return Err(Stop::Cancelled);
    }
    // Never over a file that arrived meanwhile.
    if fs::symlink_metadata(&target).is_ok() {
        return Err(Stop::Failed(format!(
            "A file called {} arrived in the packs folder meanwhile, so nothing was added. Try again.",
            crate::commands::file_name(&target)
        )));
    }
    // A virus scanner may hold a file it has just seen for a moment.
    let mut renamed = fs::rename(&part.path, &target);
    for wait in retry_waits {
        if renamed.is_ok() || fs::symlink_metadata(&target).is_ok() {
            break;
        }
        std::thread::sleep(*wait);
        renamed = fs::rename(&part.path, &target);
    }
    renamed.map_err(|error| format!("Could not put the pack file in the packs folder: {error}"))?;
    part.kept = true;
    Ok(Added {
        pack_id: checked.header.pack_id.clone(),
        title: checked.title,
        header: checked.header,
        path: target,
        copied: true,
        mine: checked.mine,
    })
}
