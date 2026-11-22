//! Updating the viewer itself: Settings has "Check for updates", and Atlas
//! looks quietly a few seconds after it starts (the web app asks, see
//! `apps/web/src/state/updates.ts`). An update is found in `latest.json`
//! of the repository's newest release, downloaded, checked against the
//! public key in `tauri.conf.json` (`plugins.updater`) and installed: on
//! Windows the NSIS installer replaces Atlas and starts it again, on Linux
//! the AppImage Atlas runs from (`APPIMAGE`) is replaced where it is, under
//! the same name, and Atlas starts again from it.
//!
//! **Which copy updates itself** is decided once at the start ([`decide`]):
//!
//! - the plain viewer on Windows, and on Linux when it runs from an
//!   AppImage. On Linux it does not look at its start when Steam started it
//!   with a game: the launch line of "Start Atlas with a game in Steam"
//!   (which another app writes as well) gives `--background`, which on Linux
//!   nothing else gives, and Steam puts `SteamGameId` into what it starts,
//!   gamescope (Game Mode) `GAMESCOPE_WAYLAND_DISPLAY`, and a Steam Deck in
//!   Game Mode `SteamDeck=1` ([`started_by_steam`]). "Check for updates"
//!   in Settings still works there. `--no-update-check`, on any desktop,
//!   asks for no look at the start too.
//! - Not: the app with downloads (Atlas Importer, released on its own, with
//!   no updates from here), Linux without an AppImage (a package the
//!   system installed, which the system updates), and other systems.
//!   Settings says where their updates come from instead.
//! - The Android app has none of this: no plugin, no `updates` in
//!   `desktop_info`, and the commands answer why not.
//!
//! The updater plugin is compiled in only where Atlas can update itself
//! (`cfg(self_update)`, set by `build.rs` on Windows and Linux without the
//! `downloads` feature), used from Rust only: no capability grants the web
//! app any of its commands. The web app calls the commands below, which
//! never take an address: the only one read is the plugin's endpoint.

use std::ffi::OsString;

use serde::Serialize;
use tauri::{AppHandle, Runtime};

#[cfg(self_update)]
mod shell;
#[cfg(self_update)]
pub use shell::{plugin, Updates};

/// Where this copy of Atlas gets its updates, as the web app reads it in
/// `desktop_info`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "way", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateWay {
    /// Atlas updates itself: Settings has "Check for updates". With
    /// `at_start`, it also looks quietly when it starts, while the person's
    /// setting "Check for updates when Atlas starts" is on.
    Itself { at_start: bool },
    /// Atlas does not update itself; Settings says where updates come from.
    Elsewhere { from: UpdatesFrom },
}

/// Where the updates of a copy that does not update itself come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatesFrom {
    /// The app with downloads, made and released apart from the viewer.
    OtherApp,
    /// Linux without an AppImage: a package the system installed.
    System,
    /// A system Atlas makes no updates for: its releases page.
    Releases,
}

/// The system, as far as updates go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum System {
    Windows,
    Linux,
    Other,
}

/// This system.
pub const SYSTEM: System = if cfg!(windows) {
    System::Windows
} else if cfg!(target_os = "linux") {
    System::Linux
} else {
    System::Other
};

/// What a start tells about how Atlas may update.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StartFacts {
    /// A build with downloads.
    pub downloads: bool,
    /// Atlas runs from an AppImage (Linux).
    pub appimage: bool,
    /// Started with `--background`.
    pub background: bool,
    /// Started with `--no-update-check`.
    pub no_update_check: bool,
    /// Steam started Atlas, or it runs in Game Mode ([`started_by_steam`]).
    pub steam: bool,
}

/// Whether this copy updates itself, and whether it looks at its start.
pub fn decide(system: System, facts: StartFacts) -> UpdateWay {
    if facts.downloads {
        return UpdateWay::Elsewhere {
            from: UpdatesFrom::OtherApp,
        };
    }
    match system {
        System::Windows => UpdateWay::Itself {
            at_start: !facts.no_update_check,
        },
        System::Linux if !facts.appimage => UpdateWay::Elsewhere {
            from: UpdatesFrom::System,
        },
        // On Linux `--background` comes only from the Steam launch line.
        System::Linux => UpdateWay::Itself {
            at_start: !(facts.no_update_check || facts.background || facts.steam),
        },
        System::Other => UpdateWay::Elsewhere {
            from: UpdatesFrom::Releases,
        },
    }
}

/// Whether Steam started Atlas or Atlas runs in Game Mode, from the
/// environment (`var` reads one variable): `SteamGameId`, which Steam sets
/// for what it starts, a non-Steam entry too; `GAMESCOPE_WAYLAND_DISPLAY`,
/// set under gamescope; or `SteamDeck=1`, set in a Steam Deck's Game Mode.
pub fn started_by_steam(var: impl Fn(&str) -> Option<OsString>) -> bool {
    let set = |name: &str| var(name).is_some_and(|value| !value.is_empty());
    set("SteamGameId")
        || set("GAMESCOPE_WAYLAND_DISPLAY")
        || var("SteamDeck").is_some_and(|value| value == "1")
}

/// The way decided at the start, kept for `desktop_info`.
pub struct Way(pub UpdateWay);

/// Decides the way at the start, and keeps it (a desktop only).
#[cfg(desktop)]
pub fn start<R: Runtime>(
    app: &tauri::App<R>,
    flags: crate::receive::args::StartFlags,
) -> UpdateWay {
    use tauri::Manager as _;
    #[cfg(target_os = "linux")]
    let appimage = crate::linux::appimage_now().is_some();
    #[cfg(not(target_os = "linux"))]
    let appimage = false;
    let way = decide(
        SYSTEM,
        StartFacts {
            downloads: crate::downloads::Downloads::in_build(),
            appimage,
            background: flags.background,
            no_update_check: flags.no_update_check,
            steam: started_by_steam(|name| std::env::var_os(name)),
        },
    );
    crate::activity::info(crate::activity::Area::App, way_line(way));
    app.manage(Way(way));
    #[cfg(self_update)]
    app.manage(std::sync::Arc::new(Updates::default()));
    way
}

/// The activity log's line for the way decided.
#[cfg(desktop)]
fn way_line(way: UpdateWay) -> &'static str {
    match way {
        UpdateWay::Itself { at_start: true } => {
            "Atlas updates itself, and looks for an update a few seconds after it starts unless that is switched off in Settings"
        }
        UpdateWay::Itself { at_start: false } => {
            "Atlas updates itself when asked in Settings, and does not look for an update at this start"
        }
        UpdateWay::Elsewhere { .. } => "This copy of Atlas does not update itself",
    }
}

/// What "Check for updates" found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateCheck {
    /// No newer version.
    UpToDate { version: String },
    /// A newer version, with what is new in it.
    Available {
        version: String,
        current: String,
        notes: String,
        /// When it was published (RFC 3339), if the release says.
        date: Option<String>,
    },
}

/// How downloading the update goes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateProgress {
    #[default]
    Idle,
    Downloading {
        received: u64,
        total: Option<u64>,
    },
    /// Downloaded and checked: ready to install.
    Ready {
        version: String,
    },
    Failed {
        message: String,
    },
}

/// The answer of these commands where Atlas does not update itself.
pub const NOT_HERE: &str = "This copy of Atlas does not update itself.";

/// Looks for an update (Settings, and the quiet look at the start).
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> Result<UpdateCheck, String> {
    #[cfg(self_update)]
    return shell::check(&app).await;
    #[cfg(not(self_update))]
    {
        drop(app);
        Err(NOT_HERE.to_owned())
    }
}

/// Downloads the update found last and checks its signature; resolves once
/// it is ready to install. `update_progress` says how far it is.
#[tauri::command]
pub async fn update_download<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(self_update)]
    return shell::download(&app).await;
    #[cfg(not(self_update))]
    {
        drop(app);
        Err(NOT_HERE.to_owned())
    }
}

/// How the download goes.
#[tauri::command]
pub fn update_progress<R: Runtime>(app: AppHandle<R>) -> UpdateProgress {
    #[cfg(self_update)]
    return shell::progress(&app);
    #[cfg(not(self_update))]
    {
        drop(app);
        UpdateProgress::Idle
    }
}

/// Installs the downloaded update and starts Atlas again. The web app has
/// saved what the person changed first. On Windows the installer ends
/// Atlas at once; on Linux Atlas ends and starts again from the new
/// AppImage.
#[tauri::command]
pub async fn update_install<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(self_update)]
    return shell::install(app).await;
    #[cfg(not(self_update))]
    {
        drop(app);
        Err(NOT_HERE.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOWS: System = System::Windows;
    const LINUX: System = System::Linux;

    fn itself(at_start: bool) -> UpdateWay {
        UpdateWay::Itself { at_start }
    }

    #[test]
    fn the_viewer_on_windows_updates_itself_and_looks_at_its_start() {
        assert_eq!(decide(WINDOWS, StartFacts::default()), itself(true));
        // Started with Windows, or by another program beside a game.
        let background = StartFacts {
            background: true,
            ..StartFacts::default()
        };
        assert_eq!(decide(WINDOWS, background), itself(true));
        let asked = StartFacts {
            no_update_check: true,
            ..StartFacts::default()
        };
        assert_eq!(decide(WINDOWS, asked), itself(false));
    }

    #[test]
    fn an_appimage_updates_itself_but_not_at_a_start_by_steam() {
        let appimage = StartFacts {
            appimage: true,
            ..StartFacts::default()
        };
        assert_eq!(decide(LINUX, appimage), itself(true));
        for facts in [
            // The Steam launch line.
            StartFacts {
                background: true,
                ..appimage
            },
            StartFacts {
                steam: true,
                ..appimage
            },
            StartFacts {
                no_update_check: true,
                ..appimage
            },
        ] {
            assert_eq!(decide(LINUX, facts), itself(false), "{facts:?}");
        }
    }

    #[test]
    fn other_copies_say_where_updates_come_from() {
        // Linux without an AppImage: a package.
        assert_eq!(
            decide(LINUX, StartFacts::default()),
            UpdateWay::Elsewhere {
                from: UpdatesFrom::System
            }
        );
        // The app with downloads, on every system, an AppImage too.
        for system in [WINDOWS, LINUX, System::Other] {
            let facts = StartFacts {
                downloads: true,
                appimage: true,
                ..StartFacts::default()
            };
            assert_eq!(
                decide(system, facts),
                UpdateWay::Elsewhere {
                    from: UpdatesFrom::OtherApp
                }
            );
        }
        assert_eq!(
            decide(System::Other, StartFacts::default()),
            UpdateWay::Elsewhere {
                from: UpdatesFrom::Releases
            }
        );
    }

    #[test]
    fn tells_a_start_by_steam_from_the_environment() {
        let only = |name: &'static str, value: &'static str| {
            move |asked: &str| (asked == name).then(|| OsString::from(value))
        };
        assert!(!started_by_steam(|_| None));
        assert!(started_by_steam(only("SteamGameId", "12345678")));
        assert!(started_by_steam(only(
            "GAMESCOPE_WAYLAND_DISPLAY",
            "gamescope-0"
        )));
        assert!(started_by_steam(only("SteamDeck", "1")));
        // Empty, or another value: not.
        assert!(!started_by_steam(only("SteamGameId", "")));
        assert!(!started_by_steam(only("SteamDeck", "0")));
        assert!(!started_by_steam(only("STEAM_RUNTIME", "1")));
    }

    #[test]
    fn the_web_app_reads_the_way_and_the_answers() {
        assert_eq!(
            serde_json::to_value(itself(false)).unwrap(),
            serde_json::json!({ "way": "itself", "atStart": false })
        );
        assert_eq!(
            serde_json::to_value(UpdateWay::Elsewhere {
                from: UpdatesFrom::OtherApp
            })
            .unwrap(),
            serde_json::json!({ "way": "elsewhere", "from": "otherApp" })
        );
        assert_eq!(
            serde_json::to_value(UpdateCheck::Available {
                version: "0.27.0".into(),
                current: "0.26.0".into(),
                notes: "- Routes".into(),
                date: None,
            })
            .unwrap(),
            serde_json::json!({
                "state": "available",
                "version": "0.27.0",
                "current": "0.26.0",
                "notes": "- Routes",
                "date": null,
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading {
                received: 10,
                total: Some(20)
            })
            .unwrap(),
            serde_json::json!({ "state": "downloading", "received": 10, "total": 20 })
        );
    }
}
