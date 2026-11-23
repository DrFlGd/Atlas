//! Atlas in Steam: Settings, "Atlas in Steam", adds Atlas itself to Steam
//! as a non-Steam game, with its own pictures (the grid, wide capsule,
//! hero, logo and icon that ship with it, see `apps/desktop/steam-art/`),
//! and takes it out again. In the viewer (the app without downloads) on
//! Windows and Linux; the Android app has none of this.
//!
//! The approach follows Game Repo's `gamerepo-steam` (the same author, MIT):
//! Steam's binary `userdata/<id>/config/shortcuts.vdf` is read and written
//! back with only the shortcut tagged "Atlas" changed ([`vdf`], [`files`]),
//! only while Steam is closed and backed up first (the newest five kept);
//! the pictures go into `userdata/<id>/config/grid/` named by the
//! shortcut's id; what is wanted and what was written are kept in
//! `steam.json` in the app data folder ([`state`]); and while Steam runs,
//! "Restart Steam and add it" starts a helper that closes Steam, writes and
//! starts Steam again ([`restart`]).
//!
//! The program Steam starts is Atlas's own: on Windows the program that
//! runs now, on Linux the AppImage (`APPIMAGE`). Linux without an AppImage
//! is refused: a program the system installed is not Atlas's to add.

#[cfg(not(target_os = "android"))]
pub mod files;
#[cfg(not(target_os = "android"))]
pub mod restart;
#[cfg(not(target_os = "android"))]
pub mod state;
#[cfg(not(target_os = "android"))]
pub mod vdf;

#[cfg(all(test, not(target_os = "android")))]
mod tests;

use tauri::{AppHandle, Runtime};

/// Whether Settings has "Atlas in Steam": the app without downloads, on
/// Windows and Linux.
pub const OFFERED: bool = !cfg!(feature = "downloads") && cfg!(any(windows, target_os = "linux"));

/// The answer of the commands where Atlas does not add itself to Steam.
#[cfg(not(target_os = "android"))]
const NOT_OFFERED: &str = "This Atlas does not add itself to Steam.";

/// When Atlas was started as the Steam helper (`--steam-helper`, see
/// [`restart`]): does the helper's work and gives the exit code, before
/// any window, the single-instance check or anything else of the app.
/// None for any other start.
pub fn helper_main(args: Vec<std::ffi::OsString>) -> Option<i32> {
    #[cfg(not(target_os = "android"))]
    {
        let (data, game_mode) = restart::read_args(&args)?;
        let ctx = state::Ctx::here(data);
        Some(match restart::helper(&ctx, game_mode) {
            Ok(()) => 0,
            Err(_) => 1,
        })
    }
    #[cfg(target_os = "android")]
    {
        drop(args);
        None
    }
}

/// At Atlas's start, on a thread of its own: what waited for Steam to
/// close is written when Steam is closed now, and Atlas's shortcut follows
/// an AppImage that moved.
#[cfg(not(target_os = "android"))]
pub fn at_start(data: std::path::PathBuf) {
    if !OFFERED {
        return;
    }
    std::thread::spawn(move || {
        let ctx = state::Ctx::here(data);
        let s = state::load(&ctx.data);
        if s.wanted.is_some() || s.written.is_some() {
            state::status(&ctx, own_program(), false);
        }
    });
}

/// The program Steam starts for Atlas, or why there is none.
#[cfg(not(target_os = "android"))]
fn own_program() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "linux")]
    return crate::linux::appimage_now()
        .ok_or_else(|| {
            "Atlas is not running from an AppImage, so it can't add itself to Steam. Start Atlas.AppImage and come back here.".to_owned()
        })
        .and_then(steam_can_start);
    #[cfg(windows)]
    return std::env::current_exe()
        .map_err(|e| format!("Atlas can't find its own program: {e}"))
        .and_then(steam_can_start);
    #[cfg(not(any(windows, target_os = "linux")))]
    Err(NOT_OFFERED.to_owned())
}

/// A program Steam can start: its path in quotes holds no quotation mark.
#[cfg(any(windows, target_os = "linux"))]
fn steam_can_start(program: std::path::PathBuf) -> Result<std::path::PathBuf, String> {
    if program.to_string_lossy().contains('"') {
        return Err(format!(
            "Atlas runs from {}, and Steam can't start a program whose path has a quotation mark in it. Move Atlas to another folder first.",
            program.display()
        ));
    }
    Ok(program)
}

/// The program to start as the helper: the AppImage on Linux, which keeps
/// working after this Atlas (and the AppImage's mount it runs from) ends.
#[cfg(not(target_os = "android"))]
fn helper_program() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "linux")]
    if let Some(appimage) = crate::linux::appimage_now() {
        return Ok(appimage);
    }
    std::env::current_exe().map_err(|e| format!("Atlas can't find its own program: {e}"))
}

#[cfg(not(target_os = "android"))]
fn context<R: Runtime>(app: &AppHandle<R>) -> Result<state::Ctx, String> {
    use tauri::Manager;
    if !OFFERED {
        return Err(NOT_OFFERED.to_owned());
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Atlas can't find its data folder: {e}"))?;
    Ok(state::Ctx::here(data))
}

/// Where Atlas's pictures for Steam are: its resources, or in a
/// development build the repository's folder.
#[cfg(not(target_os = "android"))]
fn art_source<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join(state::ART_DIR));
    if let Some(dir) = bundled.filter(|d| d.join(state::ART[0].1).is_file()) {
        return Some(dir);
    }
    #[cfg(debug_assertions)]
    {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("steam-art");
        if repo.join(state::ART[0].1).is_file() {
            return Some(repo);
        }
    }
    None
}

/// What Settings shows of Atlas in Steam.
#[tauri::command]
pub async fn steam_status<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "android"))]
    {
        let ctx = context(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let status = state::status(&ctx, own_program(), restart::game_mode());
            serde_json::to_value(status).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "android")]
    {
        drop(app);
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// "Add Atlas to Steam" (`on`, for `user` when one is chosen) or "Take
/// Atlas out of Steam": written at once while Steam is closed, else it
/// waits. Gives what Settings shows then.
#[tauri::command]
pub async fn steam_set<R: Runtime>(
    app: AppHandle<R>,
    on: bool,
    user: Option<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "android"))]
    {
        use crate::activity::{self, Area};
        let ctx = context(&app)?;
        let art = art_source(&app);
        tauri::async_runtime::spawn_blocking(move || {
            let program = own_program();
            let wanted = if on {
                let p = program.clone()?;
                match &art {
                    Some(from) => {
                        state::copy_art(from, &ctx.data);
                    }
                    None => activity::warn(
                        Area::App,
                        "Atlas's pictures for Steam are not in this app, so it is added without them",
                    ),
                }
                Some(state::Wanted {
                    program: p.display().to_string(),
                    start_dir: state::start_dir(&p),
                    user: user.unwrap_or_default(),
                })
            } else {
                None
            };
            match state::want(&ctx, wanted) {
                Ok(Some(done)) => activity::info(Area::App, done.line()),
                Ok(None) => activity::info(
                    Area::App,
                    if on {
                        "Atlas waits for Steam to close to add itself to Steam"
                    } else {
                        "Atlas waits for Steam to close to take itself out of Steam"
                    },
                ),
                Err(e) => {
                    activity::warn(Area::App, format!("Atlas in Steam: {e}"));
                    return Err(e);
                }
            }
            let status = state::status(&ctx, program, restart::game_mode());
            serde_json::to_value(status).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "android")]
    {
        drop((app, on, user));
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// "Restart Steam and add it": starts the helper, which closes Steam,
/// writes what waits and starts Steam again (in Game Mode Steam comes back
/// by itself).
#[tauri::command]
pub async fn steam_restart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let ctx = context(&app)?;
        let program = helper_program()?;
        let args = restart::helper_args(&ctx.data, restart::game_mode());
        crate::activity::info(
            crate::activity::Area::App,
            "Restarting Steam to write Atlas in Steam",
        );
        restart::start(&program, &args)
    }
    #[cfg(target_os = "android")]
    {
        drop(app);
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}
