//! The commands of maps made here becoming pack files (see the module):
//! what writing, opening and closing would do, doing it, and the own things
//! a pack file of a map made in the app carries. In every build; only a
//! reader does them, and the others answer why not.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use super::{store::Store, MadeWritten, MineOffer, OpenPlan, WritePlan};
use crate::{
    commands::{blocking, short, LibraryState, PackFileImported, PackFileJobs, PackFileJobsState},
    library::Listing,
    packfile::Stop,
};

pub type StoreState<'a> = State<'a, Arc<Store>>;

/// What "Write the pack file" would do for a map made here.
#[tauri::command]
pub async fn made_pack_plan(
    library: LibraryState<'_>,
    store: StoreState<'_>,
    id: String,
) -> Result<WritePlan, String> {
    super::check_reader()?;
    let (library, store) = (Arc::clone(&library), Arc::clone(&store));
    blocking(move || super::plan_write(&library, &store, &id)).await
}

/// A map written as a pack file, and the maps listed after it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MadePackWritten {
    #[serde(flatten)]
    written: MadeWritten,
    listing: Listing,
}

/// "Write the pack file": writes the pack file of a map made here, then
/// removes its working folder. With `replace_newer`, a newer file there is
/// written over (the person chose Replace). `packfile_progress` says how
/// far it is and `packfile_cancel` stops it.
#[tauri::command]
pub async fn made_pack_write<R: Runtime>(
    app: AppHandle<R>,
    library: LibraryState<'_>,
    store: StoreState<'_>,
    jobs: PackFileJobsState<'_>,
    id: String,
    replace_newer: bool,
) -> Result<MadePackWritten, String> {
    super::check_reader()?;
    let app_info = crate::commands::app_info(&app);
    let (library, store) = (Arc::clone(&library), Arc::clone(&store));
    let jobs: PackFileJobs = jobs.inner().clone();
    let turn = jobs.begin("write", &id, &id)?;
    blocking(move || {
        let result = super::write_made(
            &library,
            &store,
            &id,
            &app_info,
            replace_newer,
            &mut |done| turn.update(done),
            &|| turn.cancelled(),
        );
        match result {
            Ok(written) => Ok(MadePackWritten {
                written,
                listing: library.scan(),
            }),
            Err(Stop::Cancelled) => {
                Err("Cancelled. Nothing was written, and the map's folder is as it was.".to_owned())
            }
            Err(Stop::Failed(problem)) => {
                super::log_failure("write the pack file of", &short(&id), &problem);
                Err(problem)
            }
        }
    })
    .await
}

/// What "Open for editing" would do for a map read from a pack file.
#[tauri::command]
pub async fn made_pack_open_plan(
    library: LibraryState<'_>,
    store: StoreState<'_>,
    id: String,
) -> Result<OpenPlan, String> {
    super::check_reader()?;
    let (library, store) = (Arc::clone(&library), Arc::clone(&store));
    blocking(move || super::plan_open(&library, &store, &id)).await
}

/// "Open for editing": unpacks the pack file of a map made in the app into
/// a working folder in the maps folder. What it gives back is what an
/// import gives: the own things the file carries that this computer does
/// not have yet, for the web app to add to the person's.
#[tauri::command]
pub async fn made_pack_open(
    library: LibraryState<'_>,
    store: StoreState<'_>,
    jobs: PackFileJobsState<'_>,
    id: String,
) -> Result<PackFileImported, String> {
    super::check_reader()?;
    let (library, store) = (Arc::clone(&library), Arc::clone(&store));
    let jobs: PackFileJobs = jobs.inner().clone();
    let turn = jobs.begin("open", &id, &id)?;
    blocking(move || {
        let result = super::open_for_editing(
            &library,
            &store,
            &id,
            &mut |done| turn.update(done),
            &|| turn.cancelled(),
        );
        match result {
            Ok(opened) => Ok(PackFileImported::new(
                opened.id,
                opened.title,
                false,
                opened.header,
                library.scan(),
                opened.mine,
                None,
            )),
            Err(Stop::Cancelled) => Err("Cancelled. Nothing was opened.".to_owned()),
            Err(Stop::Failed(problem)) => {
                super::log_failure("open for editing", &short(&id), &problem);
                Err(problem)
            }
        }
    })
    .await
}

/// "Close without writing": removes the working folder of a map opened
/// for editing; its pack file stays as it was. The maps listed after it.
#[tauri::command]
pub async fn made_pack_close(library: LibraryState<'_>, id: String) -> Result<Listing, String> {
    super::check_reader()?;
    let library = Arc::clone(&library);
    blocking(move || {
        super::close_editing(&library, &id).inspect_err(|problem| {
            super::log_failure("close without writing", &short(&id), problem);
        })?;
        Ok(library.scan())
    })
    .await
}

/// The own things the pack file a map is read from carries, when they are
/// offered; none otherwise.
#[tauri::command]
pub async fn made_pack_mine_offer(
    library: LibraryState<'_>,
    store: StoreState<'_>,
    id: String,
) -> Result<Option<MineOffer>, String> {
    super::check_reader()?;
    let (library, store) = (Arc::clone(&library), Arc::clone(&store));
    blocking(move || Ok(super::mine_offer(&library, &store, &id))).await
}

/// Reads the own things of one version of the pack file a map is read
/// from, with the import's checks, in the shape an import gives them.
#[tauri::command]
pub async fn made_pack_mine_take(
    library: LibraryState<'_>,
    id: String,
    exported_at: String,
) -> Result<PackFileImported, String> {
    super::check_reader()?;
    let library = Arc::clone(&library);
    blocking(move || {
        let (header, mine) =
            super::take_mine(&library, &id, &exported_at).map_err(|stop| stop.message())?;
        Ok(PackFileImported::new(
            header.pack_id.clone(),
            header.title.clone(),
            false,
            header,
            library.scan(),
            mine,
            None,
        ))
    })
    .await
}

/// Notes that the own things of one version of a pack file were added, or
/// that the person does not want them, so they are not offered again.
#[tauri::command]
pub async fn made_pack_mine_choose(
    store: StoreState<'_>,
    id: String,
    exported_at: String,
    added: bool,
) -> Result<(), String> {
    super::check_reader()?;
    let store = Arc::clone(&store);
    blocking(move || super::note_choice(&store, &id, &exported_at, added)).await
}
