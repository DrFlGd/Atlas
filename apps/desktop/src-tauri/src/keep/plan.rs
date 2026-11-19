//! What to do with one game: write its pack, leave the folder's copy, or
//! say why not. A pure function of what is known, so the rules can be
//! tested on their own:
//!
//! - **No copy in the folder.** A pack this app wrote before (or found
//!   there before) was removed by the person: it stays removed, and is
//!   written again only when the person asks. A pack never written goes
//!   into `No game yet`, but only when the whole folder could be read.
//! - **A copy whose pack was changed later** (`pack.updated`) than this
//!   computer's copy: left alone, and said so.
//! - **A copy whose pack was changed earlier**: replaced where it lies.
//! - **A copy of the same change.** When it is the file this app last
//!   wrote or saw (same `exportedAt`), it is written again only when the
//!   game changed on this computer since (its fingerprint differs). When
//!   another computer wrote it since, it is written again only when the
//!   game changed here after that file was made (this computer's newest
//!   file is later than its `exportedAt`); otherwise the folder's copy is
//!   as new as this one. Either way a copy is never replaced by one with
//!   fewer map images of the same change: images deleted on this computer
//!   to make room do not leave the folder.

use super::{fingerprint::Fingerprint, folder::Copy, store::Written};

/// What is known of the game on this computer.
#[derive(Clone, Debug)]
pub struct Game<'a> {
    /// When its pack was changed last (the manifest's `updated`).
    pub updated: Option<i64>,
    pub fingerprint: &'a Fingerprint,
}

/// What to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Write a new pack into `No game yet`.
    WriteNew,
    /// Replace the copy (the first of the copies) where it lies.
    Replace,
    /// The copy is this computer's last write, and the game did not change.
    UpToDate,
    /// The copy is as new as this computer's copy, written by another
    /// computer: noted in the record, not written.
    InStep,
    /// The folder's copy is newer: left alone.
    NewerInFolder,
    /// The copy is of the same change with more map images: left alone.
    MoreImagesInFolder,
    /// Written before, and not in the folder now: removed by the person.
    NotInFolder,
    /// Not written before, and the folder could not be read whole: not
    /// written now, as its file may lie in what was not read.
    FolderNotReadWhole,
}

/// Decides for one game. `copies` are its pack files in the folder, the
/// one changed last first; `written` what the record keeps of it;
/// `folder_whole` whether the look into the folder read all of it.
pub fn decide(
    game: &Game<'_>,
    written: Option<&Written>,
    copies: &[Copy],
    folder_whole: bool,
) -> Action {
    let Some(copy) = copies.first() else {
        return if written.is_some() {
            Action::NotInFolder
        } else if folder_whole {
            Action::WriteNew
        } else {
            Action::FolderNotReadWhole
        };
    };
    // A missing time is older than any.
    let folder_updated = copy.updated();
    if folder_updated > game.updated {
        return Action::NewerInFolder;
    }
    if folder_updated < game.updated {
        return Action::Replace;
    }
    if game.fingerprint.images < copy.header.images.files {
        return Action::MoreImagesInFolder;
    }
    let ours = written.is_some_and(|written| written.exported_at == copy.header.exported_at);
    if ours {
        let written = written.expect("checked above");
        return if written.fingerprint == game.fingerprint.hash {
            Action::UpToDate
        } else {
            Action::Replace
        };
    }
    match copy.made() {
        Some(made) if game.fingerprint.changed_at > made => Action::Replace,
        Some(_) => Action::InStep,
        // A file that does not say when it was made is no newer.
        None => Action::Replace,
    }
}
