//! The commands for games made in the app (see `owngame.rs`) and for a
//! person's own locations, types and areas of any game (see `ownlists.rs`):
//! choosing a picture, making a game, adding a map or a level, how far a
//! cut is and stopping it, renaming a game and deleting one of its maps.
//!
//! The commands exist in every build; on Android, which has no picture
//! files to choose and keeps own locations in the web app's storage, they
//! answer that this is not available there.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, PoisonError,
    },
};

use serde::Serialize;
use tauri::{AppHandle, Runtime, State, WebviewWindow};

use crate::{
    activity::{self, Area},
    commands::{blocking, desktop_only, short, LibraryState},
    library::{Library, Listing},
    owngame::{self, Added},
    ownlists::LOCATIONS,
};

// ---------------------------------------------------------------------------
// The cut under way

/// The picture being cut into a map, if any: one at a time.
#[derive(Clone, Default)]
pub struct CutJobs(Arc<Mutex<Option<CutJob>>>);

struct CutJob {
    progress: CutJobProgress,
    cancel: Arc<AtomicBool>,
}

/// What `own_game_progress` says about the cut under way.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutJobProgress {
    /// `game` (a new game), `map` or `level`.
    kind: &'static str,
    /// The name of what is being made.
    name: String,
    /// The picture is being read before any tile is cut.
    reading: bool,
    tiles_done: u64,
    tiles_total: u64,
    cancelling: bool,
}

/// Clears the job when the cut ends, however it ends.
struct CutTurn {
    jobs: CutJobs,
    #[cfg_attr(target_os = "android", allow(dead_code))]
    cancel: Arc<AtomicBool>,
}

impl Drop for CutTurn {
    fn drop(&mut self) {
        *lock(&self.jobs) = None;
    }
}

fn lock(jobs: &CutJobs) -> std::sync::MutexGuard<'_, Option<CutJob>> {
    jobs.0.lock().unwrap_or_else(PoisonError::into_inner)
}

impl CutJobs {
    #[cfg_attr(target_os = "android", allow(dead_code))]
    fn begin(&self, kind: &'static str, name: &str) -> Result<CutTurn, String> {
        let mut job = lock(self);
        if job.is_some() {
            return Err(
                "Another picture is being made into a map. Wait until it has finished.".to_owned(),
            );
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *job = Some(CutJob {
            progress: CutJobProgress {
                kind,
                name: name.to_owned(),
                reading: true,
                tiles_done: 0,
                tiles_total: 0,
                cancelling: false,
            },
            cancel: Arc::clone(&cancel),
        });
        Ok(CutTurn {
            jobs: self.clone(),
            cancel,
        })
    }
}

#[cfg(not(target_os = "android"))]
impl CutTurn {
    fn update(&self, progress: crate::tiles::cut::CutProgress) {
        if let Some(job) = lock(&self.jobs).as_mut() {
            job.progress.reading = progress.reading;
            job.progress.tiles_done = progress.tiles_done;
            job.progress.tiles_total = progress.tiles_total;
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

type CutJobsState<'a> = State<'a, CutJobs>;

/// How far the picture being made into a map is; `None` when none is.
#[tauri::command]
pub fn own_game_progress(jobs: CutJobsState<'_>) -> Option<CutJobProgress> {
    lock(&jobs).as_ref().map(|job| job.progress.clone())
}

/// Stops the picture being made into a map; it leaves nothing behind.
#[tauri::command]
pub fn own_game_cancel(jobs: CutJobsState<'_>) {
    if let Some(job) = lock(&jobs).as_mut() {
        job.cancel.store(true, Ordering::Relaxed);
        job.progress.cancelling = true;
    }
}

// ---------------------------------------------------------------------------
// Pictures

/// A picture the person chose for a map.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedPicture {
    path: String,
    file_name: String,
    #[cfg(not(target_os = "android"))]
    #[serde(flatten)]
    info: crate::tiles::cut::PictureInfo,
}

/// Asks for a picture to make a map from (PNG, JPEG or WebP) and says how
/// large it is and whether it can be used. `None` when the dialog is closed.
#[tauri::command]
pub async fn map_picture_pick<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<PickedPicture>, String> {
    desktop_only()?;
    #[cfg(target_os = "android")]
    {
        let _ = window;
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let dialog = crate::commands::file_dialog(&window, "Choose a picture for the map")
            .add_filter("Picture", &["png", "jpg", "jpeg", "webp"]);
        let Some(path) = crate::commands::chosen_path(|done| dialog.pick_file(done)).await? else {
            return Ok(None);
        };
        blocking(move || picked(path)).await.map(Some)
    }
}

#[cfg(not(target_os = "android"))]
fn picked(path: PathBuf) -> Result<PickedPicture, String> {
    let info = crate::tiles::cut::inspect(&path)?;
    Ok(PickedPicture {
        file_name: crate::commands::file_name(&path),
        path: path.display().to_string(),
        info,
    })
}

// ---------------------------------------------------------------------------
// Games made in the app

/// What a change to a game made in the app gives back: what was added, and
/// the games listed now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnGameChanged {
    added: Option<Added>,
    listing: Listing,
}

/// The folder of a game made in the app, listed in the maps folder.
fn own_game_folder(library: &Library, game_id: &str) -> Result<PathBuf, String> {
    library.check_not_moving(game_id)?;
    let folder = library.pack_folder(game_id).ok_or_else(|| {
        "That game is not in the list any more. Refresh the list and try again.".to_owned()
    })?;
    owngame::check_made_in_app(&folder)?;
    Ok(folder)
}

/// Runs a cut on a worker thread and reports how it ended.
#[cfg(not(target_os = "android"))]
async fn cut_job(
    library: Arc<Library>,
    jobs: CutJobs,
    kind: &'static str,
    name: String,
    what: String,
    task: impl FnOnce(&Library, &mut owngame::Cutting<'_>) -> Result<Added, crate::packfile::Stop>
        + Send
        + 'static,
) -> Result<OwnGameChanged, String> {
    let turn = jobs.begin(kind, &name)?;
    blocking(move || {
        activity::info(Area::Library, format!("Making {what} from a picture"));
        let result = {
            let mut progress = |p| turn.update(p);
            let cancelled = || turn.cancelled();
            task(
                &library,
                &mut owngame::Cutting {
                    progress: &mut progress,
                    cancelled: &cancelled,
                },
            )
        };
        drop(turn);
        match result {
            Ok(added) => {
                activity::info(
                    Area::Library,
                    format!("Made {what}: {}", short(&added.layer_id)),
                );
                Ok(OwnGameChanged {
                    added: Some(added),
                    listing: library.scan(),
                })
            }
            Err(crate::packfile::Stop::Cancelled) => {
                activity::info(
                    Area::Library,
                    format!("Cancelled making {what}; nothing was kept"),
                );
                Err("Cancelled. Nothing was made.".to_owned())
            }
            Err(crate::packfile::Stop::Failed(error)) => {
                activity::warn(Area::Library, format!("Could not make {what}: {error}"));
                Err(error)
            }
        }
    })
    .await
}

/// Makes a new game in the maps folder from its name and its first map's
/// picture. `own_game_progress` says how far it is and `own_game_cancel`
/// stops it; a cancel leaves nothing behind.
#[tauri::command]
pub async fn own_game_create<R: Runtime>(
    app: AppHandle<R>,
    library: LibraryState<'_>,
    jobs: CutJobsState<'_>,
    title: String,
    map_name: String,
    picture: String,
) -> Result<OwnGameChanged, String> {
    desktop_only()?;
    #[cfg(target_os = "android")]
    {
        let _ = (app, library, jobs, title, map_name, picture);
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let app_info = crate::commands::app_info(&app);
        let what = format!("the new game {}", short(&title));
        cut_job(
            Arc::clone(&library),
            jobs.inner().clone(),
            "game",
            title.clone(),
            what,
            move |library, how| {
                let listing = library.scan();
                let taken = |id: &str| {
                    listing.packs.iter().any(|p| p.id == id)
                        || listing.hidden.iter().any(|p| p.id == id)
                        || library.is_bundled(id)
                };
                owngame::create_game(
                    &library.maps_folder(),
                    &title,
                    &map_name,
                    &PathBuf::from(picture),
                    &app_info,
                    taken,
                    how,
                )
            },
        )
        .await
    }
}

/// Adds a map to a game made in the app, from a picture.
#[tauri::command]
pub async fn own_game_add_map(
    library: LibraryState<'_>,
    jobs: CutJobsState<'_>,
    game_id: String,
    map_name: String,
    picture: String,
) -> Result<OwnGameChanged, String> {
    desktop_only()?;
    #[cfg(target_os = "android")]
    {
        let _ = (library, jobs, game_id, map_name, picture);
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let folder = own_game_folder(&library, &game_id)?;
        let what = format!("the map {} of {}", short(&map_name), short(&game_id));
        cut_job(
            Arc::clone(&library),
            jobs.inner().clone(),
            "map",
            map_name.clone(),
            what,
            move |_, how| {
                owngame::add_map(&folder, &game_id, &map_name, &PathBuf::from(picture), how)
            },
        )
        .await
    }
}

/// Adds a level to a map of a game made in the app, from a picture of the
/// map's size.
#[tauri::command]
pub async fn own_game_add_level(
    library: LibraryState<'_>,
    jobs: CutJobsState<'_>,
    game_id: String,
    map_id: String,
    level_name: String,
    picture: String,
) -> Result<OwnGameChanged, String> {
    desktop_only()?;
    #[cfg(target_os = "android")]
    {
        let _ = (library, jobs, game_id, map_id, level_name, picture);
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let folder = own_game_folder(&library, &game_id)?;
        let what = format!("the level {} of {}", short(&level_name), short(&map_id));
        cut_job(
            Arc::clone(&library),
            jobs.inner().clone(),
            "level",
            level_name.clone(),
            what,
            move |_, how| {
                owngame::add_level(
                    &folder,
                    &game_id,
                    &map_id,
                    &level_name,
                    &PathBuf::from(picture),
                    how,
                )
            },
        )
        .await
    }
}

/// Renames a game made in the app.
#[tauri::command]
pub async fn own_game_rename(
    library: LibraryState<'_>,
    game_id: String,
    title: String,
) -> Result<OwnGameChanged, String> {
    desktop_only()?;
    let folder = own_game_folder(&library, &game_id)?;
    let library = Arc::clone(&library);
    blocking(move || {
        let title = owngame::rename_game(&folder, &title)?;
        activity::info(
            Area::Library,
            format!("Renamed the game {} to {}", short(&game_id), short(&title)),
        );
        Ok(OwnGameChanged {
            added: None,
            listing: library.scan(),
        })
    })
    .await
}

/// Deletes a map of a game made in the app, with its levels' tiles.
#[tauri::command]
pub async fn own_game_delete_map(
    library: LibraryState<'_>,
    game_id: String,
    map_id: String,
) -> Result<OwnGameChanged, String> {
    desktop_only()?;
    let folder = own_game_folder(&library, &game_id)?;
    let library = Arc::clone(&library);
    blocking(move || {
        let name = owngame::delete_map(&folder, &map_id)?;
        activity::info(
            Area::Library,
            format!("Deleted the map {} of {}", short(&name), short(&game_id)),
        );
        Ok(OwnGameChanged {
            added: None,
            listing: library.scan(),
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Own locations, types and areas

/// A person's own locations, types and areas of a game, from their file
/// beside the game's folder (see `ownlists::LOCATIONS`); `None` when there
/// is none yet. Not on Android, where the web app keeps them itself.
#[tauri::command]
pub async fn own_locations_read(
    library: LibraryState<'_>,
    game_id: String,
) -> Result<Option<String>, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || LOCATIONS.read(&maps, &game_id)).await
}

/// Writes a person's own locations of a game, whole and at once; with
/// `keep_copy` (a time), the file as it was is kept beside it first.
#[tauri::command]
pub async fn own_locations_write(
    library: LibraryState<'_>,
    game_id: String,
    contents: String,
    keep_copy: Option<String>,
) -> Result<Option<String>, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || {
        let kept = LOCATIONS.write(&maps, &game_id, &contents, keep_copy.as_deref())?;
        if let Some(name) = &kept {
            activity::info(
                Area::Library,
                format!(
                    "Kept a copy of the own locations of {game_id} as {name} before saving them"
                ),
            );
        }
        Ok(kept)
    })
    .await
}

/// Deletes a person's own locations of a game, when they ask for it as they
/// delete the game. Whether there were any.
#[tauri::command]
pub async fn own_locations_delete(
    library: LibraryState<'_>,
    game_id: String,
) -> Result<bool, String> {
    desktop_only()?;
    let maps = library.maps_folder();
    blocking(move || {
        let deleted = LOCATIONS.delete(&maps, &game_id)?;
        if deleted {
            activity::info(
                Area::Library,
                format!("Deleted the own locations of {game_id}, as asked with the game"),
            );
        }
        Ok(deleted)
    })
    .await
}
