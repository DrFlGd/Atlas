//! Changing the packs folder: the folder of pack files (`.atlaspack`)
//! Atlas reads where they lie, kept as `packsFolder` in the shared settings
//! file (see `settings::packs_folder`), so every Atlas app on the computer
//! uses the same one. On the desktop only: Android keeps its packs in the
//! app's own storage.
//!
//! As for the maps folder, the person picks a folder ([`Library::propose_packs_folder`],
//! or [`Library::propose_default_packs_folder`] for "Use the default
//! folder"), sees what it would do, and confirms ([`Library::apply_packs_folder`]):
//!
//! - **Move the pack files there.** The pack files Atlas reads in the old
//!   folder (as [`pack_files_in`] finds them: sub-folders included, never a
//!   `.part` file, a folder whose name begins with a dot or a pack folder)
//!   move into the new one at the same place below it, and nothing else
//!   does. On the same drive each is renamed. Across drives each is copied
//!   to a `.part` name in the new folder, checked (its size, and its
//!   description still reads), renamed to its name and only then deleted
//!   from the old folder. A file that is in use, or whose copy fails, stays
//!   where it was and is named in the result; the others move on. A file
//!   already in the new folder is never written over: the one moved gets a
//!   free name (`<name> (2).atlaspack`, as an added pack file does). The
//!   sub-folders the move emptied, and the old folder itself once empty,
//!   are removed; a folder that still holds anything stays.
//! - **Leave them where they are.** Only the setting changes. The files
//!   left in the old folder are no longer read, unless the person adds
//!   that folder under "Games in other folders".
//!
//! A path kept elsewhere that named a moved file follows it: the list of
//! pack files opened (in the shared settings), the pack file each working
//! folder of a map made in the app was opened from (`madepack`), and, by
//! the command, the files this app wrote of maps made here
//! (`made-packs.json`). The keeper of packs knows a pack by its id
//! wherever it lies (see `keep`).

use std::{
    collections::{BTreeSet, HashMap},
    fs, io,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;

use super::{comparable, is_inside, lock, overlap, pack_files_in, same_path, same_volume, Library};
use crate::{
    activity::{self, Area},
    manifest::MANIFEST_FILE,
    packfile::{import::read_header, names::free_path, EXTENSION},
    removal::FileOps,
    settings::{default_packs_folder, packs_folder, SharedSettings},
};

/// A packs folder the person picked and has not confirmed yet, with what
/// changing to it would do.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PacksFolderChoice {
    /// The folder picked.
    pub path: String,
    /// The packs folder now.
    pub current: String,
    /// The folder picked is the default packs folder.
    pub is_default: bool,
    /// The pack files Atlas reads in the packs folder now, and their size
    /// in bytes.
    pub files: usize,
    pub bytes: u64,
    /// Both folders are on one drive, so moving renames each file; else
    /// each is copied, checked, and then deleted from the old folder.
    pub same_drive: bool,
}

/// A pack file that moved under another name, because its name was taken
/// in the new folder.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenamedFile {
    pub from: String,
    pub to: String,
}

/// A pack file that stayed in the old folder, and why, in a sentence.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLeft {
    pub path: String,
    pub reason: String,
}

/// What changing the packs folder came to.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacksFolderChanged {
    /// The packs folder now.
    pub folder: String,
    /// The pack files moved, under another name or not.
    pub moved: usize,
    pub renamed: Vec<RenamedFile>,
    /// The pack files that stayed in the old folder because they could not
    /// be moved.
    pub left: Vec<FileLeft>,
    /// Where each moved file was and is now, for the paths kept elsewhere.
    #[serde(skip)]
    pub moves: MovedFiles,
}

/// Where each moved pack file was and where it is now, to find a path
/// kept elsewhere again. Paths compare by their real paths, without
/// regard to case on Windows (see `library::same_path`).
#[derive(Clone, Debug, Default)]
pub struct MovedFiles(HashMap<PathBuf, PathBuf>);

impl MovedFiles {
    fn add(&mut self, from: &Path, to: &Path) {
        self.0.insert(comparable(from), to.to_path_buf());
    }

    /// Where the file once at `path` is now, when it moved.
    pub fn new_place(&self, path: &Path) -> Option<&Path> {
        if self.0.is_empty() {
            return None;
        }
        self.0.get(&comparable(path)).map(PathBuf::as_path)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Library {
    /// Records a folder the person picked as the new packs folder, until
    /// they confirm; what changing to it would do. Refused, with a
    /// sentence that says why: the packs folder itself, a file, a pack
    /// folder or a folder inside one, the maps folder or a folder inside it
    /// or around it, a folder that is or lies in one listed under "Games
    /// in other folders", one inside the packs folder now, and one Atlas
    /// cannot write to.
    pub fn propose_packs_folder(&self, path: &Path) -> Result<PacksFolderChoice, String> {
        let settings = self.settings.read();
        let current = packs_folder(&settings, self.settings.dir());
        self.check_new_packs_folder(path, &current, &settings)?;
        let maps = self.maps_folder().canonicalize().ok();
        let files = pack_files_in(&current, maps.as_deref()).files;
        let bytes = files
            .iter()
            .filter_map(|file| fs::symlink_metadata(file).ok())
            .map(|metadata| metadata.len())
            .sum();
        let choice = PacksFolderChoice {
            path: path.display().to_string(),
            current: current.display().to_string(),
            is_default: same_path(path, &default_packs_folder(self.settings.dir())),
            files: files.len(),
            bytes,
            same_drive: same_volume(&current, path),
        };
        *lock(&self.pending_packs_folder) = Some(path.to_path_buf());
        Ok(choice)
    }

    /// [`Library::propose_packs_folder`] for the default packs folder
    /// ("Use the default folder").
    pub fn propose_default_packs_folder(&self) -> Result<PacksFolderChoice, String> {
        let default = default_packs_folder(self.settings.dir());
        self.propose_packs_folder(&default)
    }

    /// Uses the proposed folder as the packs folder from now on, in the
    /// shared settings (none when it is the default one); with
    /// `move_files`, moves the pack files of the old folder there (see the
    /// module). The folder is checked again first, as it may have changed
    /// since it was picked.
    pub fn apply_packs_folder(&self, move_files: bool) -> Result<PacksFolderChanged, String> {
        let target = lock(&self.pending_packs_folder)
            .take()
            .ok_or_else(|| "Choose the new folder first.".to_owned())?;
        let settings = self.settings.read();
        let current = packs_folder(&settings, self.settings.dir());
        self.check_new_packs_folder(&target, &current, &settings)?;
        let default = same_path(&target, &default_packs_folder(self.settings.dir()));
        let target_text = target.display().to_string();
        // The setting first: from now on every app reads the new folder,
        // and each file shows there as it arrives.
        self.settings.update(|settings| {
            settings.packs_folder = (!default).then(|| target_text.clone());
        })?;
        let mut changed = PacksFolderChanged {
            folder: target_text.clone(),
            ..PacksFolderChanged::default()
        };
        if move_files {
            let maps = self.maps_folder();
            let maps_real = maps.canonicalize().ok();
            move_pack_files(
                &current,
                &target,
                maps_real.as_deref(),
                &self.file_ops,
                &mut changed,
            );
            if !changed.moves.is_empty() {
                self.follow_moves(&maps, &changed.moves);
            }
        }
        activity::info(
            Area::Library,
            format!(
                "The packs folder is now {target_text}{} (was {}); {}",
                if default { ", the default" } else { "" },
                current.display(),
                if move_files {
                    format!(
                        "moved {} pack files, {} of them under another name, {} left in the old folder",
                        changed.moved,
                        changed.renamed.len(),
                        changed.left.len()
                    )
                } else {
                    "the pack files were left in the old folder".to_owned()
                }
            ),
        );
        for left in &changed.left {
            activity::warn(
                Area::Library,
                format!("Did not move the pack file {}: {}", left.path, left.reason),
            );
        }
        Ok(changed)
    }

    /// Updates the paths kept of moved files that the Library can reach:
    /// the list of pack files opened, and the file each working folder of
    /// a map made in the app was opened from.
    fn follow_moves(&self, maps: &Path, moves: &MovedFiles) {
        let mut followed = 0;
        let updated = self.settings.update(|settings| {
            for file in &mut settings.pack_files {
                if let Some(new) = moves.new_place(Path::new(file.as_str())) {
                    *file = new.display().to_string();
                    followed += 1;
                }
            }
        });
        if let Err(error) = updated {
            activity::warn(
                Area::Library,
                format!("Could not update the list of pack files opened after the move: {error}"),
            );
        }
        followed += crate::madepack::follow_moved_files(maps, moves);
        if followed > 0 {
            activity::info(
                Area::Library,
                format!("Updated {followed} kept paths of pack files that moved"),
            );
        }
    }

    /// The checks of a folder picked as the new packs folder.
    fn check_new_packs_folder(
        &self,
        path: &Path,
        current: &Path,
        settings: &SharedSettings,
    ) -> Result<(), String> {
        if !path.is_absolute() {
            return Err("Choose a folder on this computer.".to_owned());
        }
        if fs::metadata(path).is_ok_and(|metadata| !metadata.is_dir()) {
            let pack_file = path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case(EXTENSION));
            return Err(if pack_file {
                "That is a pack file. Choose the folder that should hold your pack files."
                    .to_owned()
            } else {
                "That is a file. Choose the folder that should hold your pack files.".to_owned()
            });
        }
        if same_path(path, current) {
            return Err("That is the packs folder already.".to_owned());
        }
        if path.join(MANIFEST_FILE).is_file() {
            return Err(
                "That folder is a map pack. Choose the folder that should hold your pack files."
                    .to_owned(),
            );
        }
        if path
            .ancestors()
            .skip(1)
            .any(|folder| folder.join(MANIFEST_FILE).is_file())
        {
            return Err(
                "That folder is inside a map pack. Choose a folder that is not part of a map pack."
                    .to_owned(),
            );
        }
        if overlap(path, &Self::maps_folder_of(settings, self.settings.dir())) {
            return Err("That folder is the maps folder, is inside it or holds it. Atlas changes the map packs in the maps folder, so choose another folder for pack files.".to_owned());
        }
        for location in &settings.locations {
            let listed = Path::new(&location.path);
            if same_path(path, listed) {
                return Err("That folder is listed under Games in other folders already. Remove it from that list first, then choose it again.".to_owned());
            }
            if is_inside(path, listed) {
                return Err(format!(
                    "That folder is inside {}, which is listed under Games in other folders. Remove that folder from the list first, then choose this one again.",
                    location.path
                ));
            }
        }
        if is_inside(path, current) {
            return Err(
                "That folder is inside the packs folder now. Choose a folder outside it."
                    .to_owned(),
            );
        }
        check_writable(path).map_err(|error| {
            format!("Atlas cannot write to that folder ({error}). Choose another folder.")
        })
    }
}

/// Makes the folder when it is missing, and writes and removes a small
/// file in it.
fn check_writable(folder: &Path) -> io::Result<()> {
    fs::create_dir_all(folder)?;
    let probe = folder.join(format!(".atlas-write-check-{}.part", std::process::id()));
    fs::write(&probe, b"Atlas")?;
    fs::remove_file(&probe)
}

/// Why a file could not be moved, in a sentence.
fn left_reason(error: &io::Error) -> String {
    // On Windows a file another program holds open: a sharing or lock
    // violation, or access denied.
    let in_use = matches!(error.raw_os_error(), Some(32 | 33) if cfg!(windows))
        || error.kind() == io::ErrorKind::PermissionDenied;
    if in_use {
        "It is in use by another program or cannot be changed, so it stays in the old folder. Close the program that uses it, then move it by hand or change the folder again.".to_owned()
    } else {
        format!("It could not be moved ({error}), so it stays in the old folder.")
    }
}

/// Runs `task`, and again after each of the waits while it fails: a file
/// may be held for a moment, as by a virus scanner.
fn retrying(file_ops: &FileOps, mut task: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut result = task();
    for wait in &file_ops.retry_waits {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(*wait);
        result = task();
    }
    result
}

/// Moves the pack files Atlas reads in `old` into `new` (see the module),
/// noting each in `changed`.
pub(crate) fn move_pack_files(
    old: &Path,
    new: &Path,
    maps_real: Option<&Path>,
    file_ops: &FileOps,
    changed: &mut PacksFolderChanged,
) {
    let files = pack_files_in(old, maps_real).files;
    let same_drive = same_volume(old, new);
    // Folders this move made in the new folder, and those it took a file
    // out of in the old one: each is removed below once it is empty.
    let mut made: BTreeSet<PathBuf> = BTreeSet::new();
    let mut emptied: BTreeSet<PathBuf> = BTreeSet::new();
    for file in files {
        let Ok(relative) = file.strip_prefix(old) else {
            continue;
        };
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            continue;
        }
        let shown = file.display().to_string();
        let (Some(name), Some(sub)) = (relative.file_name(), relative.parent()) else {
            continue;
        };
        let folder = new.join(sub);
        for above in folder.ancestors() {
            if above == new || above.exists() {
                break;
            }
            made.insert(above.to_path_buf());
        }
        if let Err(error) = fs::create_dir_all(&folder) {
            changed.left.push(FileLeft {
                path: shown,
                reason: format!(
                    "Its folder could not be made in the new folder ({error}), so it stays in the old folder."
                ),
            });
            continue;
        }
        let Some(target) = free_target(&folder, name) else {
            changed.left.push(FileLeft {
                path: shown,
                reason: "The new folder has too many files named like it, so it stays in the old folder.".to_owned(),
            });
            continue;
        };
        let moved = if same_drive {
            match retrying(file_ops, || (file_ops.rename)(&file, &target)) {
                Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                    copy_across(&file, &target, file_ops)
                }
                other => other.map_err(|error| left_reason(&error)),
            }
        } else {
            copy_across(&file, &target, file_ops)
        };
        match moved {
            Ok(()) => {
                changed.moved += 1;
                if target.file_name() != Some(name) {
                    changed.renamed.push(RenamedFile {
                        from: shown,
                        to: target.display().to_string(),
                    });
                }
                changed.moves.add(&file, &target);
                if let Some(parent) = file.parent() {
                    emptied.insert(parent.to_path_buf());
                }
            }
            Err(reason) => changed.left.push(FileLeft {
                path: shown,
                reason,
            }),
        }
    }
    // The deepest first, so a folder emptied of its sub-folders goes too.
    let by_depth = |folders: BTreeSet<PathBuf>| {
        let mut folders: Vec<PathBuf> = folders.into_iter().collect();
        folders.sort_by_key(|folder| std::cmp::Reverse(folder.components().count()));
        folders
    };
    for folder in by_depth(made) {
        let _ = fs::remove_dir(folder);
    }
    let mut above_emptied = BTreeSet::new();
    for folder in &emptied {
        for above in folder.ancestors() {
            if !above.starts_with(old) {
                break;
            }
            above_emptied.insert(above.to_path_buf());
        }
    }
    for folder in by_depth(above_emptied) {
        // Only when empty: a folder that holds anything stays.
        let _ = fs::remove_dir(folder);
    }
}

/// The path a file called `name` moves to in `folder`: its own name when
/// no file there has it (or is being written under it as a `.part`), else
/// a free one (`<stem> (2).atlaspack` and so on).
fn free_target(folder: &Path, name: &std::ffi::OsStr) -> Option<PathBuf> {
    let target = folder.join(name);
    let mut part = name.to_os_string();
    part.push(".part");
    if fs::symlink_metadata(&target).is_err() && fs::symlink_metadata(folder.join(part)).is_err() {
        return Some(target);
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    free_path(folder, &stem)
}

/// Moves a file to another drive: a copy to a `.part` name beside the
/// target, checked (the same size, and its description reads), renamed to
/// the target, and then the original deleted. When the original cannot be
/// deleted, the copy is removed again, so the file is in one place only.
fn copy_across(file: &Path, target: &Path, file_ops: &FileOps) -> Result<(), String> {
    let mut part_name = target.file_name().unwrap_or_default().to_os_string();
    part_name.push(".atlas-moving.part");
    let part = target.with_file_name(part_name);
    let copied = (|| -> Result<(), String> {
        let size = fs::metadata(file)
            .map_err(|error| left_reason(&error))?
            .len();
        fs::copy(file, &part).map_err(|error| {
            format!("Its copy in the new folder failed ({error}), so it stays in the old folder.")
        })?;
        let whole = fs::metadata(&part).is_ok_and(|metadata| metadata.len() == size)
            && read_header(&part).is_ok();
        if !whole {
            return Err(
                "Its copy in the new folder was not whole, so it stays in the old folder."
                    .to_owned(),
            );
        }
        if fs::symlink_metadata(target).is_ok() {
            return Err("A file of the same name arrived in the new folder meanwhile, so it stays in the old folder.".to_owned());
        }
        fs::rename(&part, target).map_err(|error| {
            format!("Its copy in the new folder could not be named ({error}), so it stays in the old folder.")
        })
    })();
    if let Err(reason) = copied {
        let _ = fs::remove_file(&part);
        return Err(reason);
    }
    let removed = retrying(file_ops, || match (file_ops.remove_file)(file) {
        // Gone already: the copy is the only one, and stays.
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    });
    if let Err(error) = removed {
        let _ = fs::remove_file(target);
        return Err(left_reason(&error));
    }
    Ok(())
}

#[cfg(all(test, not(target_os = "android")))]
mod tests;
