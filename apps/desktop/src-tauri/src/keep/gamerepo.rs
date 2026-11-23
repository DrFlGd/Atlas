//! Where Game Repo, another app, reads pack files on this computer: the
//! `Maps and Guides` folder of its open library. The keeper writes there
//! when no folder is chosen (see `mod.rs`).
//!
//! Game Repo keeps its settings in `config.json` in its own folder of the
//! system's settings: `%APPDATA%\io.github.drflgd.gamerepo` on Windows
//! (`%USERPROFILE%\AppData\Roaming` when `APPDATA` is not set),
//! `~/Library/Application Support/io.github.drflgd.gamerepo` on macOS and
//! `$XDG_CONFIG_HOME/io.github.drflgd.gamerepo` elsewhere (`~/.config`
//! when that is not set). Its field `library` is the library open there, a
//! full path; without one, Game Repo uses `Game Repo` in the home folder.
//!
//! The file is read as untrusted, fresh each time, so a library Game Repo
//! switches to is followed: at most 1 MB, a JSON object, and only
//! `library` is looked at. No file that can be read means Game Repo is not
//! on this computer; a `library` that is not a full path Atlas can use
//! means it is, but its library cannot be used.

use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;

/// Game Repo's own folder in the system's settings.
pub const APP_FOLDER: &str = "io.github.drflgd.gamerepo";
pub const CONFIG_FILE: &str = "config.json";
/// The folder of the library Game Repo reads pack files from, the same
/// name on every system.
pub const MAPS_AND_GUIDES: &str = "Maps and Guides";
/// The library Game Repo opens when its settings name none, in the home
/// folder.
pub const DEFAULT_LIBRARY: &str = "Game Repo";
/// A settings file larger than this is not one.
const MAX_CONFIG_BYTES: u64 = 1 << 20;
/// The longest library path used.
const MAX_PATH_CHARS: usize = 4096;

/// Where to look for Game Repo: its settings file and the home folder.
/// The app takes them from the system once ([`Paths::of_this_computer`]);
/// tests name their own.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Paths {
    pub config: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl Paths {
    /// Where Game Repo keeps its settings on this computer.
    pub fn of_this_computer() -> Self {
        Self::from_env(|name| std::env::var_os(name))
    }

    /// Where Game Repo keeps its settings, from the environment `var`
    /// gives. A value that is empty or not a full path counts as not set.
    pub fn from_env(var: impl Fn(&str) -> Option<OsString>) -> Self {
        let var = |name: &str| {
            var(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        let (home, settings): (Option<PathBuf>, Option<PathBuf>) = if cfg!(windows) {
            let home = var("USERPROFILE");
            let settings = var("APPDATA").or_else(|| {
                home.as_ref()
                    .map(|home| home.join("AppData").join("Roaming"))
            });
            (home, settings)
        } else if cfg!(target_os = "macos") {
            let home = var("HOME");
            let settings = home
                .as_ref()
                .map(|home| home.join("Library").join("Application Support"));
            (home, settings)
        } else if cfg!(any(target_os = "android", target_os = "ios")) {
            // Game Repo is a desktop app.
            (None, None)
        } else {
            let home = var("HOME");
            let settings =
                var("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|home| home.join(".config")));
            (home, settings)
        };
        Self {
            config: settings.map(|settings| settings.join(APP_FOLDER).join(CONFIG_FILE)),
            home,
        }
    }
}

/// What was found of Game Repo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameRepo {
    /// Not on this computer: no settings file that can be read.
    NotHere,
    /// Its `Maps and Guides` folder, in its library (either may be
    /// missing: a drive that is not connected, a page not opened yet).
    Here { library: PathBuf, folder: PathBuf },
    /// On this computer, but its library cannot be used: why.
    Unusable(String),
}

/// Looks for Game Repo, reading its settings file now.
pub fn find(paths: &Paths) -> GameRepo {
    let Some(config) = paths.config.as_deref() else {
        return GameRepo::NotHere;
    };
    let Some(settings) = read_object(config) else {
        return GameRepo::NotHere;
    };
    let library = match settings.get("library") {
        None | Some(Value::Null) => match &paths.home {
            Some(home) => home.join(DEFAULT_LIBRARY),
            None => {
                return GameRepo::Unusable(
                    "Game Repo's settings name no library, and the home folder, where its library then is, is not known."
                        .to_owned(),
                )
            }
        },
        Some(value) => match library_of(value) {
            Some(library) => library,
            None => {
                return GameRepo::Unusable(format!(
                    "Game Repo's library in its settings ({}) is not a full path Atlas can use.",
                    describe(value)
                ))
            }
        },
    };
    GameRepo::Here {
        folder: library.join(MAPS_AND_GUIDES),
        library,
    }
}

/// The settings file as a JSON object; none when it is missing, cannot be
/// read, is too large or is not one.
fn read_object(path: &Path) -> Option<serde_json::Map<String, Value>> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()? {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

/// A library path Atlas can use: text, not empty, a full path, no `..`,
/// at most 4,096 characters and no NUL.
fn library_of(value: &Value) -> Option<PathBuf> {
    let text = value.as_str()?;
    if text.is_empty() || text.contains('\0') || text.chars().count() > MAX_PATH_CHARS {
        return None;
    }
    let path = PathBuf::from(text);
    (path.is_absolute() && !path.components().any(|part| part == Component::ParentDir))
        .then_some(path)
}

/// A value of the settings, short, for the activity log.
fn describe(value: &Value) -> String {
    match value {
        Value::String(text) => {
            let mut shown: String = text
                .chars()
                .take(120)
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect();
            if text.chars().count() > 120 {
                shown.push('…');
            }
            format!("\"{shown}\"")
        }
        Value::Bool(_) | Value::Number(_) => format!("{value}"),
        Value::Array(_) => "a list".to_owned(),
        Value::Object(_) => "an object".to_owned(),
        Value::Null => "none".to_owned(),
    }
}
