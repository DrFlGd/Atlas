//! Maps made here become pack files, on a reader (see `library::READER`):
//! a map made in the app from pictures ("New map from a picture", see
//! `owngame.rs`) is made and changed in a working folder in the maps
//! folder, and becomes a pack file when the person is done. Atlas then
//! reads it from that file, as it reads every other map.
//!
//! - **Write the pack file** ([`write_made`]). The map's folder is written
//!   as a pack file at full detail, with the person's own things of the
//!   game (`mine/`: their locations, types, areas, lists, pages, notes and
//!   photos, which on a map they made are the map's content), through a
//!   part file that is checked whole as an import checks a file
//!   (`import::check_whole`) and then renamed into place. It goes over the
//!   pack file the map was opened from (see below) when that is still
//!   there; else over the file this computer wrote of it last, when that
//!   is still the one it wrote; else into the packs folder, named from the
//!   map's title. A file there that is newer than the one opened (its
//!   `pack.updated`, then its `exportedAt`) is replaced only when the
//!   person chose Replace. Only once the written file passed its check and
//!   is in its place is the working folder removed, with the delete of a
//!   pack folder (`Library::delete_folder`); the own files beside it stay.
//!   Any failure leaves the folder as it was. When another app that reads
//!   sites uses this maps folder (`oldfolders::site_reader_here`), the
//!   folder is kept: it is that app's working folder too.
//! - **Open for editing** ([`open_for_editing`]). A map read from a pack
//!   file whose manifest says `madeInApp` is unpacked into a working folder
//!   in the maps folder with the import (`import::import_with_record`),
//!   with a record of the file it came from in the folder's `.atlas/`
//!   ([`EditingRecord`]). A folder of a game is shown before any pack file
//!   of it, so the folder is what is shown and changed from then on, until
//!   the pack file is written, or the folder is removed with **Close
//!   without writing** ([`close_editing`]), which leaves the pack file as
//!   it was.
//! - **The maker's own things on another computer** ([`mine_offer`],
//!   [`take_mine`]). A pack file of a map made in the app that carries
//!   `mine/` and is read where it lies has those things offered to the
//!   person, never taken by itself: per version of the file, until they
//!   are added or the person says no (see `store.rs`), and never on the
//!   computer that wrote that very file.
//!
//! The record and the store are read as untrusted: bounded sizes, a path
//! from them is used only when it is absolute, names a pack file outside
//! the maps folder and that file's description names the same game.

pub mod commands;
pub mod store;

#[cfg(test)]
pub(crate) mod tests;

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;

use self::store::{Choice, Store, WrittenFile};
use crate::{
    activity::{self, Area},
    library::{is_inside, same_path, Library, META_DIR},
    manifest::{now_rfc3339, read_head, ManifestHead},
    oldfolders::{is_made_here, site_reader_here},
    packfile::{
        export::{part_path, write_part, PartOptions},
        import::{check_whole, import_with_record, read_header, read_mine},
        iso_millis,
        names::{free_path, stem_from},
        space, AppInfo, Detail, Header, Mine, MineFacts, PackSource, Progress, Stop, EXTENSION,
    },
    removal::{FileOps, PackDeleted},
};

/// In a working folder's `.atlas/`: the pack file it was opened from.
pub const EDITING_RECORD: &str = "editing.json";
const EDITING_FORMAT: &str = "atlas-editing";
const EDITING_VERSION: u64 = 1;
/// A larger record is not read.
pub const MAX_RECORD_BYTES: u64 = 64 << 10;
/// The longest path a record keeps.
const MAX_PATH_CHARS: usize = 4096;

/// The waits between attempts at the rename into place: a reader of the
/// old file, such as a virus scanner, may hold it for a moment.
const RENAME_WAITS: [Duration; 4] = [
    Duration::from_millis(100),
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
];

/// Why a folder is kept after its pack file was written.
pub const FOLDER_KEPT: &str = "Another app that reads sites uses the maps folder on this computer, so the map's folder was kept there: that app changes the map in it.";

// ---------------------------------------------------------------------------
// The record of the file a map was opened from

/// What `.atlas/editing.json` keeps of the pack file a working folder was
/// opened from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditingRecord {
    /// The pack file.
    pub path: PathBuf,
    /// When its pack was changed last (`pack.updated`), as it said.
    pub pack_updated: Option<String>,
    /// When it was made (`exportedAt`).
    pub exported_at: String,
    /// When it was opened for editing.
    pub opened_at: String,
}

impl EditingRecord {
    fn bytes(&self) -> Vec<u8> {
        let value = serde_json::json!({
            "format": EDITING_FORMAT,
            "version": EDITING_VERSION,
            "path": self.path.display().to_string(),
            "packUpdated": self.pack_updated,
            "exportedAt": self.exported_at,
            "openedAt": self.opened_at,
        });
        let mut bytes = serde_json::to_vec_pretty(&value).expect("JSON serialises");
        bytes.push(b'\n');
        bytes
    }

    /// The version of the file it was opened from, as the rule of one pack
    /// per id compares two: `pack.updated`, then `exportedAt`.
    fn version(&self) -> (Option<i64>, Option<i64>) {
        (
            self.pack_updated.as_deref().and_then(iso_millis),
            iso_millis(&self.exported_at),
        )
    }
}

/// Whether a path names a pack file by its extension.
fn is_pack_file_name(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(EXTENSION))
}

/// The record of a working folder opened from a pack file; none when there
/// is none, or it cannot be used.
pub fn read_editing_record(dir: &Path) -> Option<EditingRecord> {
    let path = dir.join(META_DIR).join(EDITING_RECORD);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let text_of = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
    if text_of("format") != Some(EDITING_FORMAT)
        || value.get("version").and_then(serde_json::Value::as_u64) != Some(EDITING_VERSION)
    {
        return None;
    }
    let file = text_of("path")
        .filter(|path| path.chars().count() <= MAX_PATH_CHARS)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && is_pack_file_name(path))?;
    let exported_at = text_of("exportedAt").filter(|at| iso_millis(at).is_some())?;
    Some(EditingRecord {
        path: file,
        pack_updated: text_of("packUpdated")
            .filter(|at| iso_millis(at).is_some())
            .map(str::to_owned),
        exported_at: exported_at.to_owned(),
        opened_at: text_of("openedAt")
            .filter(|at| iso_millis(at).is_some())
            .unwrap_or_default()
            .to_owned(),
    })
}

/// What the Library lists of a working folder opened from a pack file.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditingFacts {
    /// The pack file it was opened from.
    pub path: String,
    pub file_name: String,
}

impl From<&EditingRecord> for EditingFacts {
    fn from(record: &EditingRecord) -> Self {
        Self {
            path: record.path.display().to_string(),
            file_name: crate::commands::file_name(&record.path),
        }
    }
}

// ---------------------------------------------------------------------------
// The working folder

/// The working folder of a map made here, in the maps folder, and its
/// manifest: one listed as a folder of the maps folder (not a link), whose
/// manifest says `madeInApp` and which was made here or opened for editing
/// (see `oldfolders::is_made_here`).
fn working_folder(library: &Library, id: &str) -> Result<(PathBuf, ManifestHead), String> {
    let gone =
        || "That map is not in the list any more. Refresh the list and try again.".to_owned();
    let dir = library.pack_folder(id).ok_or_else(gone)?;
    let maps = library.maps_folder();
    let in_maps = dir.parent().is_some_and(|parent| same_path(parent, &maps));
    if !in_maps || !crate::removal::is_real_dir(&dir) || library.is_bundled(id) {
        return Err("Only a map made in Atlas whose folder is in the maps folder can be written as a pack file here.".to_owned());
    }
    let head = read_head(&dir)?;
    if head.id != id || !is_made_here(&dir, &head) {
        return Err("Only a map made in Atlas on this computer, or opened for editing here, can be written as a pack file.".to_owned());
    }
    library.check_not_moving(id)?;
    Ok((dir, head))
}

/// Where the pack file of a map goes.
#[derive(Clone, Debug)]
enum Target {
    /// Over this pack file, whose description is `there`, as the person's
    /// copy of the version `opened` (`pack.updated`, `exportedAt`).
    Replace {
        path: PathBuf,
        there: Box<Header>,
        opened: (Option<i64>, Option<i64>),
        /// It is the file the map was opened from.
        opened_from: bool,
    },
    /// A new file at this free path.
    New(PathBuf),
}

impl Target {
    fn path(&self) -> &Path {
        match self {
            Target::Replace { path, .. } | Target::New(path) => path,
        }
    }

    /// Why the file there is newer than the version opened, in words; none
    /// when it is not.
    fn newer(&self) -> Option<String> {
        let Target::Replace {
            path,
            there,
            opened,
            ..
        } = self
        else {
            return None;
        };
        let now = (
            there.pack.updated.as_deref().and_then(iso_millis),
            iso_millis(&there.exported_at),
        );
        (now > *opened).then(|| {
            format!(
                "The pack file {} is newer than the one this map was opened from: it was written {}, after the map was opened. Replacing it loses what was changed in it since.",
                crate::commands::file_name(path),
                there.exported_at
            )
        })
    }
}

/// A pack file of game `id` at `path` that may be written over: a file
/// (not a link) outside the maps folder whose description names the game.
fn usable_file(library: &Library, path: &Path, id: &str) -> Option<Header> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || !is_pack_file_name(path) {
        return None;
    }
    if is_inside(path, &library.maps_folder()) {
        return None;
    }
    read_header(path).ok().filter(|header| header.pack_id == id)
}

/// Where the pack file of the map in `dir` goes (see the module).
fn target_of(
    library: &Library,
    store: &Store,
    dir: &Path,
    head: &ManifestHead,
) -> Result<Target, String> {
    if let Some(record) = read_editing_record(dir) {
        if let Some(there) = usable_file(library, &record.path, &head.id) {
            return Ok(Target::Replace {
                opened: record.version(),
                path: record.path,
                there: Box::new(there),
                opened_from: true,
            });
        }
    }
    if let Some(last) = store.read().last_written(&head.id) {
        if let Some(there) = usable_file(library, &last.path, &head.id) {
            if there.exported_at == last.exported_at {
                return Ok(Target::Replace {
                    opened: (
                        there.pack.updated.as_deref().and_then(iso_millis),
                        iso_millis(&there.exported_at),
                    ),
                    path: last.path.clone(),
                    there: Box::new(there),
                    opened_from: false,
                });
            }
        }
    }
    let packs = library.packs_folder();
    fs::create_dir_all(&packs)
        .map_err(|error| format!("Could not create the packs folder: {error}"))?;
    let stem = stem_from(Some(&head.title), &head.title, None, &head.id);
    free_path(&packs, &stem).map(Target::New).ok_or_else(|| {
        "The packs folder has too many files named like this map, so nothing was written. Rename the map and try again.".to_owned()
    })
}

/// What "Write the pack file" would do, for the question before anything
/// is written.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritePlan {
    pub id: String,
    pub title: String,
    /// The working folder.
    pub folder: String,
    /// The pack file to write.
    pub target: String,
    pub file_name: String,
    /// The folder it goes in.
    pub target_folder: String,
    /// A pack file is there, and is written over.
    pub replaces: bool,
    /// It is the file the map was opened from.
    pub opened_from: bool,
    /// The file there is newer than the one opened: why, in words. It is
    /// written over only when the person chooses Replace.
    pub newer: Option<String>,
    /// The working folder is removed once the file is written.
    pub removes_folder: bool,
    /// The person's own things of the map that go in the file.
    pub mine: Option<MineFacts>,
}

/// What "Write the pack file" would do for the map `id`. Blocking.
pub fn plan_write(library: &Library, store: &Store, id: &str) -> Result<WritePlan, String> {
    let (dir, head) = working_folder(library, id)?;
    let target = target_of(library, store, &dir, &head)?;
    let mine = Mine::read(&library.maps_folder(), id)?;
    let mine = if mine.is_empty() {
        None
    } else {
        Some(mine.check(id)?)
    };
    let path = target.path().to_path_buf();
    Ok(WritePlan {
        id: id.to_owned(),
        title: head.title,
        folder: dir.display().to_string(),
        target: path.display().to_string(),
        file_name: crate::commands::file_name(&path),
        target_folder: path
            .parent()
            .map(|parent| parent.display().to_string())
            .unwrap_or_default(),
        replaces: matches!(target, Target::Replace { .. }),
        opened_from: matches!(
            target,
            Target::Replace {
                opened_from: true,
                ..
            }
        ),
        newer: target.newer(),
        removes_folder: !site_reader_here(library),
        mine,
    })
}

/// A map written as a pack file.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MadeWritten {
    pub id: String,
    pub path: String,
    pub file_name: String,
    /// The file's size on disk.
    pub size: u64,
    pub header: Header,
    /// The working folder was removed.
    pub folder_removed: bool,
    /// Every file of it went; otherwise some go at the next start.
    pub folder_complete: bool,
    /// What else to know: why the folder was kept.
    pub note: Option<String>,
}

/// Writes the pack file of the map `id` (see the module). With
/// `replace_newer`, a file there that is newer than the one opened is
/// written over; otherwise that refuses. `progress` is told how far the
/// writing and then the check are; `cancelled` is asked between entries.
/// Blocking.
pub fn write_made(
    library: &Library,
    store: &Store,
    id: &str,
    app: &AppInfo,
    replace_newer: bool,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<MadeWritten, Stop> {
    write_made_with(
        library,
        store,
        id,
        app,
        replace_newer,
        &|_| {},
        progress,
        cancelled,
    )
}

/// [`write_made`], with `written` called on the part file once it is
/// written and before it is checked (tests damage it there).
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_made_with(
    library: &Library,
    store: &Store,
    id: &str,
    app: &AppInfo,
    replace_newer: bool,
    written: &dyn Fn(&Path),
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<MadeWritten, Stop> {
    let (dir, head) = working_folder(library, id)?;
    let target = target_of(library, store, &dir, &head)?;
    if let Some(newer) = target.newer().filter(|_| !replace_newer) {
        return Err(Stop::Failed(format!(
            "{newer} Choose Replace to write over it, or Cancel to leave it."
        )));
    }
    let maps = library.maps_folder();
    let mine = Mine::read(&maps, id)?;
    let source = PackSource {
        pack_id: id.to_owned(),
        root: dir.clone(),
        images: dir.clone(),
        lock: true,
        comes_with_app: false,
        // A photo kept for the person's own use is the map's too: nothing of
        // the folder is lost when it goes.
        own_use_pictures: true,
        smaller_pictures: false,
        group: crate::gamegroups::carried(&maps, id).ok().flatten(),
    };
    let path = target.path().to_path_buf();
    let part = part_path(&path);
    if fs::symlink_metadata(&part).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(Stop::Failed(format!(
            "Something that is not a file is in the way of {}, so nothing was written.",
            part.display()
        )));
    }
    let (size, header) = write_part(
        &source,
        app,
        Detail::Full,
        &part,
        &mine,
        PartOptions {
            partial: false,
            check_space: true,
        },
        progress,
        cancelled,
    )?;
    let outcome = check_and_place(
        &part, &path, &target, &header, &mine, written, progress, cancelled,
    );
    if outcome.is_err() {
        let _ = fs::remove_file(&part);
    }
    outcome?;
    activity::info(
        Area::Library,
        format!(
            "Wrote the pack file of the map {} ({id}) to {}: {}",
            activity::clean(&head.title),
            path.display(),
            space::describe(size)
        ),
    );
    if let Err(error) = store.note_written(WrittenFile {
        pack_id: id.to_owned(),
        exported_at: header.exported_at.clone(),
        path: path.clone(),
    }) {
        activity::warn(Area::Library, error);
    }
    let mut made = MadeWritten {
        id: id.to_owned(),
        path: path.display().to_string(),
        file_name: crate::commands::file_name(&path),
        size,
        header,
        folder_removed: false,
        folder_complete: false,
        note: None,
    };
    if site_reader_here(library) {
        made.note = Some(FOLDER_KEPT.to_owned());
        return Ok(made);
    }
    match library.delete_folder(&dir, id) {
        Ok(PackDeleted { complete }) => {
            made.folder_removed = true;
            made.folder_complete = complete;
            activity::info(
                Area::Library,
                format!(
                    "Removed the working folder {} of {id}, now read from its pack file{}",
                    dir.display(),
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
                    "Wrote the pack file of {id}, but could not remove its working folder: {problem}"
                ),
            );
            made.note = Some(format!(
                "The pack file was written, but the map's folder could not be removed: {problem} The folder is shown until it is gone. Try Write the pack file again later."
            ));
        }
    }
    Ok(made)
}

/// Checks the part file whole, puts it in its place and reads it back
/// there. The place is checked again just before: a file that arrived or
/// changed there meanwhile is not written over.
#[allow(clippy::too_many_arguments)]
fn check_and_place(
    part: &Path,
    path: &Path,
    target: &Target,
    header: &Header,
    mine: &Mine,
    written: &dyn Fn(&Path),
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Stop> {
    written(part);
    let checked = check_whole(part, progress, cancelled).map_err(|stop| match stop {
        Stop::Cancelled => Stop::Cancelled,
        Stop::Failed(reason) => Stop::Failed(format!(
            "The pack file written did not pass the check, so it was not used and the map's folder was left as it was: {reason}"
        )),
    })?;
    if checked.header != *header || checked.mine.is_empty() != mine.is_empty() {
        return Err(Stop::Failed(
            "The pack file written is not the one meant, so it was not used and the map's folder was left as it was.".to_owned(),
        ));
    }
    if cancelled() {
        return Err(Stop::Cancelled);
    }
    match target {
        Target::Replace { there, .. } => {
            let now = read_header(path).ok();
            if now.as_ref() != Some(there.as_ref()) {
                return Err(Stop::Failed(format!(
                    "The pack file {} changed while the map was written, so nothing was replaced. Try again.",
                    path.display()
                )));
            }
        }
        Target::New(_) => {
            if fs::symlink_metadata(path).is_ok() {
                return Err(Stop::Failed(format!(
                    "A file called {} arrived meanwhile, so nothing was written. Try again.",
                    crate::commands::file_name(path)
                )));
            }
        }
    }
    let mut renamed = fs::rename(part, path);
    for wait in RENAME_WAITS {
        if renamed.is_ok() {
            break;
        }
        std::thread::sleep(wait);
        renamed = fs::rename(part, path);
    }
    renamed.map_err(|error| {
        Stop::Failed(format!(
            "Could not put the pack file in its place, {}: {error}. Another program may hold it open. The map's folder was left as it was.",
            path.display()
        ))
    })?;
    // Read back where it belongs.
    match read_header(path) {
        Ok(there) if there == *header => Ok(()),
        _ => Err(Stop::Failed(format!(
            "The pack file {} could not be read back once written, so the map's folder was left as it was.",
            path.display()
        ))),
    }
}

// ---------------------------------------------------------------------------
// Open for editing, and close without writing

/// The pack file a listed map made in the app is read from, and its
/// description; why not, when it is not one.
fn made_pack_file(library: &Library, id: &str) -> Result<(PathBuf, Header), String> {
    let listing = library.scan();
    let listed = listing
        .packs
        .iter()
        .find(|pack| pack.id == id)
        .ok_or_else(|| {
            "That map is not in the list any more. Refresh the list and try again.".to_owned()
        })?;
    if !listed.pack_file {
        return Err("This map is not read from a pack file.".to_owned());
    }
    if !listed.made_in_app {
        return Err("Only a map made in Atlas can be opened for editing. This one is read from its pack file, and Atlas never changes a pack file.".to_owned());
    }
    let path = library.pack_file(id).ok_or_else(|| {
        "That map is not in the list any more. Refresh the list and try again.".to_owned()
    })?;
    let header = read_header(&path)?;
    if header.pack_id != id {
        return Err("The pack file changed meanwhile. Refresh the list and try again.".to_owned());
    }
    Ok((path, header))
}

/// What "Open for editing" would do, for the question before anything is
/// written.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenPlan {
    pub id: String,
    pub title: String,
    /// The pack file.
    pub path: String,
    pub file_name: String,
    /// The working folder it is unpacked into.
    pub folder: String,
    /// The own things the file carries that are not on this computer
    /// already (it was not written here, nor were they added from this
    /// version): opening it adds them to the person's, so the pack file
    /// written later keeps them.
    pub mine: Option<MineFacts>,
}

/// What "Open for editing" would do for the map `id`. Blocking.
pub fn plan_open(library: &Library, store: &Store, id: &str) -> Result<OpenPlan, String> {
    let (path, header) = made_pack_file(library, id)?;
    let folder = library.maps_folder().join(id);
    if crate::packfile::import::existing_folder(&library.maps_folder(), id)?.is_some() {
        return Err("The maps folder has a folder of this map already. Remove it in the settings, under old folders, first.".to_owned());
    }
    Ok(OpenPlan {
        id: id.to_owned(),
        title: header.title.clone(),
        path: path.display().to_string(),
        file_name: crate::commands::file_name(&path),
        folder: folder.display().to_string(),
        mine: unknown_mine(store, &header),
    })
}

/// The own things a file carries that this computer does not have yet.
fn unknown_mine(store: &Store, header: &Header) -> Option<MineFacts> {
    let facts = header.mine?;
    if facts == MineFacts::default() {
        return None;
    }
    let remembered = store.read();
    let known = remembered.wrote(&header.pack_id, &header.exported_at)
        || remembered.choice(&header.pack_id, &header.exported_at) == Some(Choice::Added);
    (!known).then_some(facts)
}

/// A map opened for editing.
#[derive(Clone, Debug)]
pub struct OpenedForEditing {
    pub id: String,
    pub title: String,
    pub folder: PathBuf,
    pub header: Header,
    /// The own things the file carries that this computer does not have
    /// yet, checked to be this game's, for the web app to add to the
    /// person's as an import's (it notes them added after).
    pub mine: Mine,
}

/// Unpacks the pack file of the map `id` into a working folder in the maps
/// folder (see the module). Blocking.
pub fn open_for_editing(
    library: &Library,
    store: &Store,
    id: &str,
    progress: &mut dyn FnMut(Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<OpenedForEditing, Stop> {
    let (path, header) = made_pack_file(library, id)?;
    let maps = library.maps_folder();
    if crate::packfile::import::existing_folder(&maps, id)?.is_some() {
        return Err(Stop::Failed(
            "The maps folder has a folder of this map already. Remove it in the settings, under old folders, first.".to_owned(),
        ));
    }
    let record = EditingRecord {
        path: path.clone(),
        pack_updated: header.pack.updated.clone(),
        exported_at: header.exported_at.clone(),
        opened_at: now_rfc3339(),
    };
    let bytes = record.bytes();
    let imported = import_with_record(
        &path,
        &maps,
        &FileOps::default(),
        &space::available,
        Some((EDITING_RECORD, &bytes)),
        progress,
        cancelled,
    )?;
    if imported.header != header {
        // Another file arrived at that path meanwhile: the folder is of it,
        // and the record names what it is now.
        let record = EditingRecord {
            pack_updated: imported.header.pack.updated.clone(),
            exported_at: imported.header.exported_at.clone(),
            ..record
        };
        let _ = crate::manifest::write_atomic(
            &imported.folder.join(META_DIR).join(EDITING_RECORD),
            &record.bytes(),
        );
    }
    activity::info(
        Area::Library,
        format!(
            "Opened the map {} ({id}) for editing from {} into {}",
            activity::clean(&imported.title),
            path.display(),
            imported.folder.display()
        ),
    );
    let mine = if unknown_mine(store, &imported.header).is_some() {
        imported.mine
    } else {
        Mine::default()
    };
    library.scan();
    Ok(OpenedForEditing {
        id: id.to_owned(),
        title: imported.title,
        folder: imported.folder,
        header: imported.header,
        mine,
    })
}

/// Removes the working folder of a map opened for editing, without writing
/// its pack file, which stays as it was. Refused when that file is not
/// there any more: the folder is then the only copy of the map. Blocking.
pub fn close_editing(library: &Library, id: &str) -> Result<PackDeleted, String> {
    let (dir, _) = working_folder(library, id)?;
    let record = read_editing_record(&dir)
        .ok_or_else(|| "This map was not opened for editing from a pack file, so its folder is the map itself. Write the pack file instead.".to_owned())?;
    if usable_file(library, &record.path, id).is_none() {
        return Err(format!(
            "The pack file this map was opened from, {}, is not there any more, so closing without writing would lose the map. Write the pack file instead.",
            record.path.display()
        ));
    }
    let deleted = library.delete_folder(&dir, id)?;
    activity::info(
        Area::Library,
        format!(
            "Closed the map {id} without writing: removed its working folder {}; its pack file {} stays as it was",
            dir.display(),
            record.path.display()
        ),
    );
    library.scan();
    Ok(deleted)
}

// ---------------------------------------------------------------------------
// The maker's own things, offered from a pack file read where it lies

/// The own things a pack file of a map made in the app carries, offered to
/// the person.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MineOffer {
    pub id: String,
    pub title: String,
    pub path: String,
    /// The version of the file offered from.
    pub exported_at: String,
    pub facts: MineFacts,
}

/// The offer of the own things the pack file the map `id` is read from
/// carries; none when it is not read from a pack file, was not made in the
/// app, carries none, was written on this computer, or the person added
/// them or said no for this version already. Blocking.
pub fn mine_offer(library: &Library, store: &Store, id: &str) -> Option<MineOffer> {
    let (path, header) = made_pack_file(library, id).ok()?;
    let facts = unknown_mine(store, &header)?;
    if store.read().choice(id, &header.exported_at).is_some() {
        return None;
    }
    Some(MineOffer {
        id: id.to_owned(),
        title: header.title.clone(),
        path: path.display().to_string(),
        exported_at: header.exported_at,
        facts,
    })
}

/// Reads the own things of the version `exported_at` of the pack file the
/// map `id` is read from, with the import's checks, for the web app to add
/// to the person's (it notes them added after, see [`note_choice`]).
/// Blocking.
pub fn take_mine(library: &Library, id: &str, exported_at: &str) -> Result<(Header, Mine), Stop> {
    let (path, header) = made_pack_file(library, id)?;
    if header.exported_at != exported_at {
        return Err(Stop::Failed(
            "Another version of this pack file arrived meanwhile. Look at what it carries and try again.".to_owned(),
        ));
    }
    let (read, mine) = read_mine(&path)?;
    if read != header {
        return Err(Stop::Failed(
            "The pack file changed while it was read. Try again.".to_owned(),
        ));
    }
    Ok((read, mine))
}

/// Notes that the own things of one version of a game's pack file were
/// added or not wanted.
pub fn note_choice(store: &Store, id: &str, exported_at: &str, added: bool) -> Result<(), String> {
    if !crate::packs::is_valid_pack_id(id) || iso_millis(exported_at).is_none() {
        return Err("That pack file cannot be named.".to_owned());
    }
    store.note_choice(
        id,
        exported_at,
        if added {
            Choice::Added
        } else {
            Choice::Dismissed
        },
    )
}

/// Checks the app is a reader (see `library::READER`); the others answer
/// why not.
pub fn check_reader() -> Result<(), String> {
    if crate::library::READER {
        Ok(())
    } else if cfg!(desktop) {
        Err(NOT_IN_THIS_APP.to_owned())
    } else {
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// What the app with downloads answers.
const NOT_IN_THIS_APP: &str = "This app keeps the maps made in it as folders in the maps folder, so it writes no pack file of them and opens none for editing.";

/// What a write, an open or a close tells the activity log of a failure.
pub fn log_failure(what: &str, id: &str, problem: &str) {
    activity::warn(
        Area::Library,
        format!("Could not {what} {}: {problem}", activity::clean(id)),
    );
}
