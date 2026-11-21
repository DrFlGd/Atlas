//! Atlas in the background, in the desktop app without downloads (see
//! `library::READER`), offered on Windows for now ([`OFFERED`]). Everything
//! is off until the person turns it on in Settings, so a person who changes
//! nothing sees no change at all.
//!
//! - **Keep Atlas running when its window is closed.** Closing the window
//!   hides it, and Atlas keeps running with an icon in the notification
//!   area (the tray), there whenever Atlas runs while this is on. A press
//!   on the icon shows or hides the window; its menu has "Show Atlas" or
//!   "Hide Atlas", "Stay above other windows" and "Quit Atlas", which ends
//!   the app as closing its window always did.
//! - **Hotkey.** A combination registered with the system only while it is
//!   switched on (see `hotkey.rs`): it brings Atlas forward, and pressed
//!   while Atlas is in front puts it away (hidden while it keeps running,
//!   else minimised). It only shows or hides Atlas's own window.
//! - **Back where you left it.** Hiding never unloads anything, so the
//!   window comes back with the same game, map, location, zoom and panel.
//!   While any of these settings is on, the window's place, size and
//!   whether it was maximised are kept from one run to the next (see
//!   `place.rs`).
//! - **Stay above other windows.**
//! - **Start Atlas when Windows starts**, for the current user only, with
//!   `--background`; the switch shows what the system says.
//! - **Start options from another program** (`--show-pack`, `--show-game`,
//!   `--background`, read in `receive/args.rs`): what they name is found
//!   here ([`find_show`]) and waits in [`Shows`] until the web app takes it
//!   (`background_take_show`), which it does at its start and when told
//!   [`SHOW_REQUESTED`]. These work in the app without downloads on every
//!   desktop.
//!
//! - **Exit Atlas** (`app_exit`), in the web app's Settings: ends Atlas as
//!   the tray's "Quit Atlas" does. On Linux it is there in every desktop
//!   app, since Game Mode on a Steam Deck gives the window no close button.
//!
//! The decisions are made without the system (`decide.rs`), and the
//! settings are kept in the app's own data folder (`store.rs`); the tray,
//! the hotkey, the start with the system and the window calls are in
//! `shell.rs`, in Rust only: the web app gets no permission to register
//! hotkeys or change what starts with the system, only these commands.
//! The app with downloads and the Android app answer each command with
//! why not, as `madepack::check_reader` does.

#[cfg(not(target_os = "android"))]
pub mod decide;
#[cfg(not(target_os = "android"))]
pub mod hotkey;
#[cfg(not(target_os = "android"))]
pub mod place;
#[cfg(not(target_os = "android"))]
pub mod shell;
#[cfg(not(target_os = "android"))]
pub mod store;
#[cfg(not(target_os = "android"))]
pub mod titles;

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
#[cfg(not(target_os = "android"))]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

/// The settings are offered: in the app without downloads, on Windows.
pub const OFFERED: bool = crate::library::READER && cfg!(windows);

/// The event that tells the web app the settings changed by themselves
/// (the tray's "Stay above other windows"), with the new state.
pub const CHANGED: &str = "background-changed";
/// The event that tells the web app a game was asked for by a second
/// start; it takes it with `background_take_show`.
pub const SHOW_REQUESTED: &str = "show-requested";

/// What the app with downloads answers.
const NOT_IN_THIS_APP: &str = "This app does not run in the background.";
/// What the app without downloads answers where the settings are not offered.
const NOT_ON_THIS_SYSTEM: &str = "Atlas runs in the background only on Windows for now.";

/// Checks the settings are offered here; the others answer why not.
pub fn check_offered() -> Result<(), String> {
    if OFFERED {
        Ok(())
    } else if !cfg!(desktop) {
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    } else if !crate::library::READER {
        Err(NOT_IN_THIS_APP.to_owned())
    } else {
        Err(NOT_ON_THIS_SYSTEM.to_owned())
    }
}

/// What the other apps answer when asked for a game another program asked for.
const NO_START_OPTIONS: &str = "This app does not take a game to show from another program.";

/// Checks the app takes the start options of another program (the app
/// without downloads, on every desktop); the others answer why not.
fn check_start_options() -> Result<(), String> {
    if crate::library::READER {
        Ok(())
    } else if cfg!(desktop) {
        Err(NO_START_OPTIONS.to_owned())
    } else {
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// The settings as the web app shows them.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundState {
    pub keep_running: bool,
    pub on_top: bool,
    pub hotkey: HotkeyState,
    pub start_with_system: StartState,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyState {
    pub on: bool,
    /// The combination, as a person reads it (`Ctrl+Alt+M`).
    pub keys: String,
    /// The combination offered.
    pub offered: String,
    /// Why the hotkey does nothing now, if it does not.
    pub problem: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartState {
    /// What the system says: Atlas starts with it. None when it could not
    /// be read.
    pub on: Option<bool>,
    /// Why it could not be read or changed.
    pub problem: Option<String>,
}

/// A game asked for by another program, waiting for the web app.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowRequest {
    /// The games it names, in the Library's order: one for `--show-pack`.
    pub packs: Vec<String>,
    /// The person's titles that hold several of them (see `titles.rs`).
    #[cfg(not(target_os = "android"))]
    pub groups: Vec<titles::FoundGroup>,
}

/// The game asked for last, until the web app takes it: only the newest
/// counts.
#[derive(Debug, Default)]
pub struct Shows(Mutex<Option<ShowRequest>>);

impl Shows {
    pub fn put(&self, request: ShowRequest) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(request);
    }

    pub fn take(&self) -> Option<ShowRequest> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

/// What the start options name in the Library, or `None` when Atlas has
/// nothing for them; one line in the activity log either way.
#[cfg(not(target_os = "android"))]
pub fn find_show(
    library: &crate::library::Library,
    show: &receive_args::Show,
) -> Option<ShowRequest> {
    use crate::activity::{self, Area};
    let listing = library.scan();
    let (request, asked) = match show {
        receive_args::Show::Pack(id) => (
            listing
                .packs
                .iter()
                .any(|pack| &pack.id == id)
                .then(|| ShowRequest {
                    packs: vec![id.clone()],
                    groups: Vec::new(),
                }),
            format!("the game of the pack {id}"),
        ),
        receive_args::Show::Game(title) => {
            let groups = crate::gamegroups::read(&library.maps_folder())
                .ok()
                .flatten()
                .map(|text| titles::read_groups(&text))
                .unwrap_or_default();
            let listed: Vec<titles::Listed<'_>> = listing
                .packs
                .iter()
                .map(|pack| titles::Listed {
                    id: &pack.id,
                    title: &pack.title,
                    game_title: pack.game_title.as_deref(),
                })
                .collect();
            let found = titles::find(title, &listed, &groups);
            (
                (!found.packs.is_empty()).then_some(ShowRequest {
                    packs: found.packs,
                    groups: found.groups,
                }),
                format!(
                    "the game titled \u{201c}{}\u{201d}",
                    crate::activity::clean(title)
                ),
            )
        }
    };
    match &request {
        Some(request) => activity::info(
            Area::App,
            format!(
                "Another program asked to show {asked}: {}",
                request.packs.join(", ")
            ),
        ),
        None => activity::info(
            Area::App,
            format!("Another program asked to show {asked}, which Atlas does not have, so it did nothing"),
        ),
    }
    request
}

#[cfg(not(target_os = "android"))]
use crate::receive::args as receive_args;

/// The settings now.
#[tauri::command]
pub async fn background_state<R: Runtime>(app: AppHandle<R>) -> Result<BackgroundState, String> {
    check_offered()?;
    #[cfg(not(target_os = "android"))]
    return shell::state(&app);
    #[cfg(target_os = "android")]
    {
        drop(app);
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// Switches one setting on or off: `keepRunning`, `hotkey`, `onTop` or
/// `startWithSystem`. The settings after it, or why it could not be done
/// (and nothing changed).
#[tauri::command]
pub async fn background_set<R: Runtime>(
    app: AppHandle<R>,
    setting: String,
    on: bool,
) -> Result<BackgroundState, String> {
    check_offered()?;
    #[cfg(not(target_os = "android"))]
    return shell::set(&app, &setting, on);
    #[cfg(target_os = "android")]
    {
        drop((app, setting, on));
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// Sets the hotkey's combination to the keys the person pressed. Refused,
/// with a sentence, when it cannot be used or the system does not take it;
/// the old one is kept then.
#[tauri::command]
pub async fn background_set_hotkey<R: Runtime>(
    app: AppHandle<R>,
    keys: KeyPressArg,
) -> Result<BackgroundState, String> {
    check_offered()?;
    #[cfg(not(target_os = "android"))]
    return shell::set_hotkey(&app, &keys);
    #[cfg(target_os = "android")]
    {
        drop((app, keys));
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// While the person presses the keys they want in Settings, the hotkey
/// does nothing, so pressing the combination it has now does not hide the
/// window; `paused: false` registers it again.
#[tauri::command]
pub async fn background_pause_hotkey<R: Runtime>(
    app: AppHandle<R>,
    paused: bool,
) -> Result<BackgroundState, String> {
    check_offered()?;
    #[cfg(not(target_os = "android"))]
    return shell::pause_hotkey(&app, paused);
    #[cfg(target_os = "android")]
    {
        drop((app, paused));
        Err(crate::commands::NOT_ON_THIS_DEVICE.to_owned())
    }
}

/// The game another program asked for last, if the web app has not taken
/// it yet. In the app without downloads, on every desktop.
#[tauri::command]
pub fn background_take_show<R: Runtime>(app: AppHandle<R>) -> Result<Option<ShowRequest>, String> {
    check_start_options()?;
    #[cfg(not(target_os = "android"))]
    return Ok(app
        .try_state::<std::sync::Arc<Shows>>()
        .and_then(|shows| shows.take()));
    #[cfg(target_os = "android")]
    {
        drop(app);
        Ok(None)
    }
}

/// "Exit Atlas": ends the app as the tray's "Quit Atlas" does, keeping the
/// window's place first while a setting keeps it. The web app offers it
/// where the window may have no close button or closing it only hides it:
/// on Linux always (Game Mode on a Steam Deck shows no window frame, see
/// `DesktopInfo::exit`), and on Windows while Atlas keeps running when its
/// window is closed. Every desktop takes it; the Android app answers why not.
#[tauri::command]
pub fn app_exit<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::commands::desktop_only()?;
    #[cfg(not(target_os = "android"))]
    shell::quit(&app);
    #[cfg(target_os = "android")]
    drop(app);
    Ok(())
}

/// The keys pressed, as the web app sends them.
#[cfg(not(target_os = "android"))]
pub type KeyPressArg = hotkey::KeyPress;
#[cfg(target_os = "android")]
pub type KeyPressArg = serde_json::Value;

#[cfg(test)]
#[cfg(not(target_os = "android"))]
mod tests;
