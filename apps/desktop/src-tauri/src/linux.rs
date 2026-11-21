//! Linux only: what the web view needs before it starts, and the line that
//! starts Atlas with a game in Steam.
//!
//! Atlas draws its window with WebKitGTK. Its newer way of drawing (the
//! DMA-BUF renderer, WebKitGTK 2.42 and later) leaves the window blank or
//! white on some systems: under gamescope, the compositor of Game Mode on
//! a Steam Deck, and with some graphics drivers. WebKitGTK reads
//! `WEBKIT_DISABLE_DMABUF_RENDERER` when it starts and then draws the older
//! way, which works there. So Atlas sets it at its start, before any
//! window or thread exists, unless the person set it already: a value the
//! person set (even `0`) is theirs and is left as it is.
//!
//! `WEBKIT_DISABLE_COMPOSITING_MODE=1` is not set: it turns off drawing
//! with the graphics chip altogether, which makes moving and zooming the
//! map slow, and it is not needed where the line above is enough. A person
//! whose window stays blank can still set it in the program's launch
//! options (see the README, "Atlas on Linux and the Steam Deck").
//!
//! **The Steam launch line.** Put into a game's launch options in Steam,
//! this starts Atlas with the game, as a window of that game, without
//! taking the focus (see the README, "Game Mode"):
//!
//! ```sh
//! bash -c '"<AppImage>" --background & exec "$@"' -- %command%
//! ```
//!
//! [`launch_line`] is the only place that writes it. `<AppImage>` is the
//! full path of the AppImage Atlas runs from, which the AppImage runtime
//! puts in `APPIMAGE` ([`running_appimage`]), or `$HOME/Applications/Atlas.AppImage`
//! ([`USUAL_APPIMAGE`]) when Atlas does not run from one. The path stands
//! in double quotes inside single quotes, so a path holding `'`, `"`, `$`,
//! a backtick, `\` or a control character (a line break among them) is
//! refused ([`line_can_hold`]): Settings then says why instead of showing a
//! line. The plain viewer shows the line in Settings ("Start Atlas with a
//! game in Steam", through `DesktopInfo::steam_launch`) and keeps the path
//! as `linuxAppImage` in the shared settings file for another app
//! ([`appimage_to_keep`]).

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use serde::Serialize;

/// The variables Atlas sets at its start when they are not set, with
/// their values.
pub const WEBKIT_DEFAULTS: [(&str, &str); 1] = [("WEBKIT_DISABLE_DMABUF_RENDERER", "1")];

/// The variables of [`WEBKIT_DEFAULTS`] to set, given what is set now
/// (`now` reads one variable).
pub fn webkit_to_set(now: impl Fn(&str) -> Option<OsString>) -> Vec<(&'static str, &'static str)> {
    WEBKIT_DEFAULTS
        .iter()
        .copied()
        .filter(|(name, _)| now(name).is_none())
        .collect()
}

/// Sets the variables of [`WEBKIT_DEFAULTS`] that are not set, and says
/// which it set, for the activity log. Call it first thing in `run`, while
/// Atlas has no other thread: the environment must not change while
/// another thread reads it.
pub fn prepare_web_view() -> Vec<(&'static str, &'static str)> {
    let set = webkit_to_set(|name| std::env::var_os(name));
    for (name, value) in &set {
        std::env::set_var(name, value);
    }
    set
}

/// The activity log's line for what [`prepare_web_view`] did.
pub fn web_view_line(set: &[(&str, &str)]) -> String {
    if set.is_empty() {
        "The web view's settings for Linux were set already, so Atlas left them as they are"
            .to_owned()
    } else {
        let names: Vec<String> = set
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect();
        format!(
            "Set {} for the web view, so that its window is not blank under gamescope and some graphics drivers",
            names.join(", ")
        )
    }
}

/// The AppImage path the line names when Atlas does not run from an
/// AppImage: where the trial's notes say to keep it. The shell expands
/// `$HOME` in the line.
pub const USUAL_APPIMAGE: &str = "$HOME/Applications/Atlas.AppImage";

/// The line for a game's launch options in Steam that starts the AppImage
/// at `appimage` with the game. Only for a path [`line_can_hold`]; see
/// [`steam_launch`].
pub fn launch_line(appimage: &str) -> String {
    format!("bash -c '\"{appimage}\" --background & exec \"$@\"' -- %command%")
}

/// Whether a path can stand in the line as it is: inside double quotes
/// inside single quotes, nothing in it may end the quotes or be expanded
/// by the shell (`'`, `"`, `$`, a backtick, `\`), and the line is one line
/// (no control character, a line break among them).
pub fn line_can_hold(path: &str) -> bool {
    !path.is_empty()
        && !path
            .chars()
            .any(|c| matches!(c, '\'' | '"' | '$' | '`' | '\\') || c.is_control())
}

/// The line for Settings, as the web app shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SteamLaunch {
    /// Atlas runs from the AppImage at `path`, and `line` names it.
    AppImage { path: String, line: String },
    /// Atlas does not run from an AppImage: `line` names [`USUAL_APPIMAGE`].
    Usual { line: String },
    /// Atlas runs from the AppImage at `path` (as text, any character that
    /// is not one replaced), which the line cannot hold: no line.
    Refused { path: String },
}

/// The line for the AppImage Atlas runs from (see [`running_appimage`]), or
/// for [`USUAL_APPIMAGE`] when there is none.
pub fn steam_launch(appimage: Option<&Path>) -> SteamLaunch {
    let Some(path) = appimage else {
        return SteamLaunch::Usual {
            line: launch_line(USUAL_APPIMAGE),
        };
    };
    match path.to_str() {
        Some(text) if line_can_hold(text) => SteamLaunch::AppImage {
            path: text.to_owned(),
            line: launch_line(text),
        },
        _ => SteamLaunch::Refused {
            path: path.to_string_lossy().into_owned(),
        },
    }
}

/// The AppImage Atlas runs from, from the value of `APPIMAGE` (which the
/// AppImage runtime sets to the AppImage file's full path): only a full
/// path to a file that exists (`is_file`). None when it is not set, or not
/// such a path (Atlas was not started from an AppImage, or the variable
/// came from elsewhere).
pub fn running_appimage(
    value: Option<OsString>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let path = PathBuf::from(value?);
    (path.is_absolute() && is_file(&path)).then_some(path)
}

/// The AppImage Atlas runs from now, read from the environment.
pub fn appimage_now() -> Option<PathBuf> {
    running_appimage(std::env::var_os("APPIMAGE"), Path::is_file)
}

/// What to keep as `linuxAppImage` in the shared settings, given what is
/// kept (`kept`) and the AppImage Atlas runs from: `Some(new value)` when it
/// changes, None when it stays. The AppImage Atlas runs from is kept when
/// the line can hold its path; without one, a kept path whose file is gone
/// (`is_file`) is taken out, and any other kept path stays (Atlas may run
/// from elsewhere this time, as in development, while the AppImage is
/// still there).
pub fn appimage_to_keep(
    kept: Option<&str>,
    running: Option<&Path>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<Option<String>> {
    let usable = running
        .and_then(Path::to_str)
        .filter(|text| line_can_hold(text));
    match (usable, kept) {
        (Some(path), Some(old)) if path == old => None,
        (Some(path), _) => Some(Some(path.to_owned())),
        (None, Some(old)) if !is_file(Path::new(old)) => Some(None),
        (None, _) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_what_is_not_set_and_leaves_what_the_person_set() {
        assert_eq!(
            webkit_to_set(|_| None),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        // Set by the person, to anything (even 0 or empty): left alone.
        for value in ["0", "1", ""] {
            assert!(webkit_to_set(
                |name| (name == "WEBKIT_DISABLE_DMABUF_RENDERER").then(|| OsString::from(value))
            )
            .is_empty());
        }
        // Another variable set changes nothing.
        assert_eq!(
            webkit_to_set(
                |name| (name == "WEBKIT_DISABLE_COMPOSITING_MODE").then(|| OsString::from("1"))
            ),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
    }

    #[test]
    fn says_what_it_did() {
        assert!(web_view_line(&[("WEBKIT_DISABLE_DMABUF_RENDERER", "1")])
            .starts_with("Set WEBKIT_DISABLE_DMABUF_RENDERER=1 for the web view"));
        assert!(web_view_line(&[]).contains("left them as they are"));
    }

    const DECK: &str = "/home/deck/Applications/Atlas.AppImage";

    #[test]
    fn writes_the_launch_line_for_a_path() {
        assert_eq!(
            steam_launch(Some(Path::new(DECK))),
            SteamLaunch::AppImage {
                path: DECK.to_owned(),
                line: r#"bash -c '"/home/deck/Applications/Atlas.AppImage" --background & exec "$@"' -- %command%"#.to_owned(),
            }
        );
    }

    #[test]
    fn keeps_spaces_inside_the_quotes() {
        let path = "/home/deck/My Games/Atlas Viewer.AppImage";
        assert_eq!(
            steam_launch(Some(Path::new(path))),
            SteamLaunch::AppImage {
                path: path.to_owned(),
                line: r#"bash -c '"/home/deck/My Games/Atlas Viewer.AppImage" --background & exec "$@"' -- %command%"#.to_owned(),
            }
        );
    }

    #[test]
    fn refuses_what_would_end_the_quotes_or_be_expanded() {
        for path in [
            "/home/deck/it's/Atlas.AppImage",
            "/home/deck/\"q\"/Atlas.AppImage",
            "/home/deck/$USER/Atlas.AppImage",
            "/home/deck/`id`/Atlas.AppImage",
            "/home/deck/back\\slash/Atlas.AppImage",
            "/home/deck/two\nlines/Atlas.AppImage",
            "/home/deck/tab\there/Atlas.AppImage",
        ] {
            assert!(!line_can_hold(path), "{path:?}");
            assert_eq!(
                steam_launch(Some(Path::new(path))),
                SteamLaunch::Refused {
                    path: path.to_owned()
                }
            );
        }
        assert!(!line_can_hold(""));
        assert!(line_can_hold(
            "/home/deck/Games (new)/Atlas-1.0 & more.AppImage"
        ));
    }

    #[test]
    fn names_the_usual_folder_without_an_appimage() {
        assert_eq!(
            steam_launch(None),
            SteamLaunch::Usual {
                line: r#"bash -c '"$HOME/Applications/Atlas.AppImage" --background & exec "$@"' -- %command%"#.to_owned(),
            }
        );
        // As the shell gives it to the web app.
        assert_eq!(
            serde_json::to_value(steam_launch(Some(Path::new(DECK)))).unwrap(),
            serde_json::json!({
                "state": "appImage",
                "path": DECK,
                "line": launch_line(DECK),
            })
        );
        assert_eq!(
            serde_json::to_value(steam_launch(None)).unwrap()["state"],
            "usual"
        );
    }

    #[test]
    fn reads_only_a_full_path_to_a_file_from_appimage() {
        let exists = |path: &Path| path == Path::new(DECK);
        assert_eq!(
            running_appimage(Some(OsString::from(DECK)), exists),
            Some(PathBuf::from(DECK))
        );
        // Not set, empty, not a full path, or no such file: none.
        assert_eq!(running_appimage(None, exists), None);
        assert_eq!(running_appimage(Some(OsString::new()), |_| true), None);
        assert_eq!(
            running_appimage(Some(OsString::from("Applications/Atlas.AppImage")), |_| {
                true
            }),
            None
        );
        assert_eq!(
            running_appimage(Some(OsString::from("/tmp/gone.AppImage")), exists),
            None
        );
    }

    #[test]
    fn keeps_the_appimage_path_for_another_app() {
        let deck = Some(Path::new(DECK));
        let there = |_: &Path| true;
        let gone = |_: &Path| false;
        // Started from an AppImage: kept, once.
        assert_eq!(
            appimage_to_keep(None, deck, there),
            Some(Some(DECK.to_owned()))
        );
        assert_eq!(appimage_to_keep(Some(DECK), deck, there), None);
        assert_eq!(
            appimage_to_keep(Some("/old/Atlas.AppImage"), deck, there),
            Some(Some(DECK.to_owned()))
        );
        // A path the line cannot hold is not kept; one kept stays while its file is there.
        let odd = Some(Path::new("/home/deck/$odd/Atlas.AppImage"));
        assert_eq!(appimage_to_keep(None, odd, there), None);
        assert_eq!(appimage_to_keep(Some(DECK), odd, there), None);
        // Not from an AppImage: a kept path stays while its file is there, and goes with it.
        assert_eq!(appimage_to_keep(Some(DECK), None, there), None);
        assert_eq!(appimage_to_keep(Some(DECK), None, gone), Some(None));
        assert_eq!(appimage_to_keep(None, None, gone), None);
    }
}
