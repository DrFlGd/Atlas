//! Writing one pack into the folder.
//!
//! The pack file is written beside its target as
//! `<name>.atlas-importer.part`, at full detail with every map image on
//! this computer and the photos kept for the person's own use when the game
//! has them; with the person's own things (`mine/`) for a map made in the
//! app here and never for another game (the caller says which); there must
//! be room for it first. The finished file is checked as an import checks a
//! file (`import::check_whole`): the description and its id, every entry's
//! name, type and size, every entry read to its end against its checksum,
//! and the game in its manifest. Only then, and only when `ready` agrees
//! (the game did not change meanwhile, and no newer copy arrived), is it
//! renamed over the target: one rule for the same drive, another drive and
//! a network share, so no pack is ever half written under its name, and
//! there are never two. A reader may hold the old file open: a rename
//! that fails is tried again a few times with short waits, then given up
//! for this run. Whatever stops it, the unfinished file is removed.

use std::{fs, path::Path, thread, time::Duration};

use super::folder::part_of;
use crate::packfile::{
    export::{write_part, PartOptions},
    import::check_whole,
    AppInfo, Detail, Header, Mine, PackSource, Progress, Stop,
};

/// The waits between attempts at the rename: about 7 seconds in all.
pub const RENAME_WAITS: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(3),
];

/// Which part of a write is under way, for its progress.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Writing,
    Checking,
}

/// A written pack: its description and size.
#[derive(Clone, Debug)]
pub struct Done {
    pub header: Header,
    pub size: u64,
}

/// Writes `source` as a pack file at `target` (see the module). `ready` is
/// asked just before the rename; an error from it stops the write.
#[allow(clippy::too_many_arguments)]
pub fn write_pack(
    source: &PackSource,
    mine: &Mine,
    app: &AppInfo,
    target: &Path,
    progress: &mut dyn FnMut(Phase, Progress),
    cancelled: &dyn Fn() -> bool,
    ready: &dyn Fn() -> Result<(), Stop>,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<Done, Stop> {
    let part = part_of(target);
    let result = write_and_check(source, mine, app, &part, progress, cancelled).and_then(|done| {
        ready()?;
        rename_with_retries(&part, target, rename)?;
        Ok(done)
    });
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

fn write_and_check(
    source: &PackSource,
    mine: &Mine,
    app: &AppInfo,
    part: &Path,
    progress: &mut dyn FnMut(Phase, Progress),
    cancelled: &dyn Fn() -> bool,
) -> Result<Done, Stop> {
    let (size, header) = write_part(
        source,
        app,
        Detail::Full,
        part,
        mine,
        PartOptions {
            partial: true,
            check_space: true,
        },
        &mut |done| progress(Phase::Writing, done),
        cancelled,
    )?;
    let checked = check_whole(part, &mut |done| progress(Phase::Checking, done), cancelled)
        .map_err(|stop| match stop {
            Stop::Cancelled => Stop::Cancelled,
            Stop::Failed(reason) => Stop::Failed(format!(
                "The pack file written did not pass the check, so it was not used: {reason}"
            )),
        })?;
    if checked.header.pack_id != source.pack_id || checked.mine.is_empty() != mine.is_empty() {
        return Err(Stop::Failed(
            "The pack file written is not the one meant, so it was not used.".to_owned(),
        ));
    }
    Ok(Done { header, size })
}

/// Renames `part` over `target`, trying again after each of
/// [`RENAME_WAITS`] when it fails (a file held open on Windows, a share
/// that is slow).
fn rename_with_retries(
    part: &Path,
    target: &Path,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), Stop> {
    let mut waits = RENAME_WAITS.iter();
    loop {
        match rename(part, target) {
            Ok(()) => return Ok(()),
            Err(error) => match waits.next() {
                Some(wait) => thread::sleep(*wait),
                None => {
                    return Err(Stop::Failed(format!(
                        "The pack file could not replace {}: {error}. Another program may hold it open; it is tried again at the next check.",
                        target.display()
                    )))
                }
            },
        }
    }
}
