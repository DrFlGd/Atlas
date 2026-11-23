//! Steam on this computer: its folder, whether it runs, the users signed in
//! to it, and writing its files whole and with a backup first.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::vdf::{self, parse_text, Text};

#[cfg(not(windows))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// A command started without a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Steam's folder: where Steam says (Windows' registry), else the usual
/// places (on Linux its own, the `~/.steam/steam` link, and Flathub's).
/// Only a folder with `userdata` in it.
pub fn find() -> Option<PathBuf> {
    let mut tries: Vec<PathBuf> = vec![];
    #[cfg(windows)]
    {
        if let Ok(o) = command("reg")
            .args(["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"])
            .output()
        {
            let text = String::from_utf8_lossy(&o.stdout);
            if let Some(l) = text.lines().find(|l| l.contains("SteamPath")) {
                if let Some(at) = l.find("REG_SZ") {
                    tries.push(PathBuf::from(l[at + 6..].trim()));
                }
            }
        }
        tries.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
        tries.push(PathBuf::from(r"C:\Program Files\Steam"));
    }
    #[cfg(not(windows))]
    if let Some(home) = home_dir() {
        tries.push(home.join(".steam").join("steam"));
        tries.push(home.join(".local").join("share").join("Steam"));
        tries.push(home.join(FLATPAK_STEAM));
    }
    tries.into_iter().find(|p| p.join("userdata").is_dir())
}

/// Where Flathub's Steam keeps its folder, under the home folder.
#[cfg(not(windows))]
const FLATPAK_STEAM: &str = ".var/app/com.valvesoftware.Steam/.local/share/Steam";

/// Whether the Steam folder is Flathub's (Steam is then started with
/// `flatpak run`).
pub fn is_flatpak(steam: &Path) -> bool {
    steam
        .to_string_lossy()
        .contains("/.var/app/com.valvesoftware.Steam/")
}

/// Whether Steam is running (its files are written only while it is not).
pub fn running() -> bool {
    #[cfg(windows)]
    {
        command("tasklist")
            .args(["/FI", "IMAGENAME eq steam.exe", "/NH"])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .to_lowercase()
                    .contains("steam.exe")
            })
            .unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        // A process named steam that has not ended (one ended but not yet
        // reaped does not count).
        fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .flatten()
            .any(|e| {
                let Ok(stat) = fs::read_to_string(e.path().join("stat")) else {
                    return false;
                };
                let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
                    return false;
                };
                &stat[open + 1..close] == "steam"
                    && !stat[close + 1..].trim_start().starts_with(['Z', 'X'])
            })
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        command("pgrep")
            .args(["-x", "steam"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Steam's 32-bit account id from a SteamID64 (`userdata/<id>` is named by it).
pub fn account_id(steam64: &str) -> Option<u64> {
    steam64
        .parse::<u64>()
        .ok()?
        .checked_sub(76_561_197_960_265_728)
}

/// A user Steam has signed in on this computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    /// The folder name under `userdata`.
    pub id: String,
    /// The name shown in Steam, or empty.
    pub name: String,
    /// Signed in most recently.
    pub recent: bool,
    #[serde(skip)]
    pub signed_in: u64,
}

/// The users Steam has signed in on this computer: `userdata/<id>/`, named
/// from `config/loginusers.vdf`, the most recent first.
pub fn users(steam: &Path) -> Vec<User> {
    let text = fs::read_to_string(steam.join("config").join("loginusers.vdf")).unwrap_or_default();
    let top = parse_text(&text).unwrap_or_default();
    let named: Vec<(String, Text)> = match top.iter().find(|(k, _)| k.eq_ignore_ascii_case("users"))
    {
        Some((_, Text::Map(m))) => m.clone(),
        _ => vec![],
    };
    let mut v: Vec<User> = fs::read_dir(steam.join("userdata"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().into_owned();
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) || id == "0" {
                return None;
            }
            let u = named
                .iter()
                .find(|(k, _)| account_id(k).map(|a| a.to_string()).as_deref() == Some(&id))
                .map(|(_, v)| v);
            let field = |f: &str| u.and_then(|m| m.str(f)).unwrap_or_default();
            Some(User {
                name: field("PersonaName"),
                recent: field("MostRecent") == "1",
                signed_in: field("Timestamp").parse().unwrap_or(0),
                id,
            })
        })
        .collect();
    // Steam no longer always writes MostRecent: the latest sign-in is the
    // recent one then.
    if !v.iter().any(|u| u.recent) {
        if let Some(u) = v
            .iter_mut()
            .filter(|u| u.signed_in > 0)
            .max_by_key(|u| u.signed_in)
        {
            u.recent = true;
        }
    }
    v.sort_by_key(|u| {
        (
            !u.recent,
            std::cmp::Reverse(u.signed_in),
            u.name.to_lowercase(),
            u.id.clone(),
        )
    });
    v
}

/// A user's config folder (`userdata/<id>/config`).
pub fn config_dir(steam: &Path, user: &str) -> Result<PathBuf, String> {
    if user.is_empty() || !user.chars().all(|c| c.is_ascii_digit()) {
        return Err("Atlas does not know which Steam user to use.".into());
    }
    let d = steam.join("userdata").join(user).join("config");
    if !d.parent().is_some_and(Path::is_dir) {
        return Err(format!("Steam has no user {user} on this computer."));
    }
    Ok(d)
}

/// Writes a file whole or not at all: to a file beside it, then put in its
/// place.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d).map_err(|e| format!("{} cannot be made: {e}", d.display()))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".atlas-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(|e| format!("{} cannot be written: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{} cannot be written: {e}", path.display())
    })
}

/// A copy of `file` as it is now (empty when there is none),
/// `<name>.<prefix>-<stamp>` beside it, keeping the newest `keep` of that
/// prefix.
pub fn backup(file: &Path, prefix: &str, stamp: &str, keep: usize) -> Result<PathBuf, String> {
    let dir = file
        .parent()
        .ok_or_else(|| format!("{} has no folder", file.display()))?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let start = format!("{name}.{prefix}-");
    let b = dir.join(format!("{start}{stamp}"));
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(&b, fs::read(file).unwrap_or_default())
        .map_err(|e| format!("The backup {} cannot be written: {e}", b.display()))?;
    let mut all: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(&start))
        })
        .collect();
    all.sort();
    while all.len() > keep {
        let _ = fs::remove_file(all.remove(0));
    }
    Ok(b)
}

/// A user's shortcuts.vdf as it is now: its top level, empty when there is
/// no file. A file that cannot be read is an error, so it is never written
/// over.
pub fn read_shortcuts(steam: &Path, user: &str) -> Result<vdf::Top, String> {
    let file = config_dir(steam, user)?.join("shortcuts.vdf");
    match fs::read(&file) {
        Ok(b) => vdf::parse(&b).map_err(|e| {
            format!("Steam's list of non-Steam games cannot be read ({e}), so Atlas leaves it as it is.")
        }),
        Err(_) => Ok(vec![]),
    }
}

/// Puts `tag`'s shortcut into a user's shortcuts.vdf: the ones with that
/// tag go, `own` comes (when given), and every other shortcut stays exactly
/// as it was. Backed up first (`prefix`, `stamp`, the newest five kept).
/// Gives the number of others kept.
pub fn put_shortcut(
    steam: &Path,
    user: &str,
    tag: &str,
    own: Option<&vdf::Shortcut>,
    prefix: &str,
    stamp: &str,
) -> Result<usize, String> {
    let file = config_dir(steam, user)?.join("shortcuts.vdf");
    let top = read_shortcuts(steam, user)?;
    backup(&file, prefix, stamp, 5)?;
    let mut all: Vec<vdf::Vdf> = vdf::shortcuts_of(&top)
        .into_iter()
        .filter(|v| !vdf::is_tagged(v, tag))
        .collect();
    let others = all.len();
    if let Some(s) = own {
        all.push(s.to_vdf(tag));
    }
    write_atomic(&file, &vdf::write(&vdf::with_shortcuts(top, all)))?;
    Ok(others)
}
