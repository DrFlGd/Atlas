//! What Atlas wants in Steam (itself, or nothing) and what it wrote there,
//! kept in `steam.json` in its app data folder, and writing it into Steam's
//! files while Steam is closed.
//!
//! Turning it off takes out exactly what Atlas wrote: its own shortcut (the
//! one tagged [`TAG`]) and the grid pictures it copied, each only while it
//! is still the file Atlas wrote (the person may have set their own picture
//! in its place since). When the person added Atlas to Steam by hand
//! already, Atlas adds no second shortcut: it puts its pictures under that
//! shortcut's id, never over a picture that is there.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    files::{self, User},
    vdf::{self, Shortcut},
};

/// The tag on Atlas's own shortcut. Shortcuts with another tag (Game Repo's
/// "Game Repo" and "Game Repo Go", anyone else's) or none are never changed.
pub const TAG: &str = "Atlas";
/// The name of Atlas's shortcut in Steam.
pub const NAME: &str = "Atlas";
/// Backups of shortcuts.vdf are named `shortcuts.vdf.atlas-<time>`.
const BACKUP: &str = "atlas";
/// The state file in the app data folder.
const STATE_FILE: &str = "steam.json";
/// Atlas's pictures, copied from its resources into the app data folder,
/// so a helper started from another copy of Atlas finds them too.
pub const ART_DIR: &str = "steam-art";

/// Atlas's pictures: their kind, the file that ships with Atlas, and the
/// end of their name in Steam's grid folder (`<appid><end>.<ext>`).
pub const ART: [(&str, &str, &str); 5] = [
    ("grid", "atlas-steam-grid-600x900.jpg", "p"),
    ("wide", "atlas-steam-wide-920x430.jpg", ""),
    ("hero", "atlas-steam-hero-3840x1240.jpg", "_hero"),
    ("logo", "atlas-steam-logo-1280x720.png", "_logo"),
    ("icon", "atlas-steam-icon-512.png", "_icon"),
];

/// The kinds of picture file Steam reads from its grid folder: a picture
/// of one of these under an id and end is there already.
const PICTURE_TYPES: [&str; 5] = ["png", "jpg", "jpeg", "webp", "ico"];

/// Atlas in Steam, as the person wants it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Wanted {
    /// The program Steam starts: Atlas.exe, or the AppImage.
    pub program: String,
    /// Its folder.
    pub start_dir: String,
    /// The Steam user chosen, or empty: the one signed in most recently.
    pub user: String,
}

/// A grid picture Atlas wrote: its name, and the CRC32 of its bytes.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct GridFile {
    pub name: String,
    pub crc: u32,
}

/// What Atlas last wrote into Steam.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Written {
    pub steam: String,
    pub user: String,
    pub program: String,
    /// The id the pictures are named by.
    pub appid: u32,
    /// Atlas wrote its own shortcut; false: the person's own shortcut to
    /// Atlas was there, and only pictures were added.
    pub own: bool,
    /// The grid pictures Atlas wrote.
    pub grid: Vec<GridFile>,
    /// The kinds of picture left as the person's own.
    pub kept: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub wanted: Option<Wanted>,
    pub written: Option<Written>,
}

/// Where Atlas works: its data folder, Steam's folder, whether Steam runs
/// (asked each time; a test says), and whether program paths are compared
/// without case (Windows).
pub struct Ctx {
    pub data: PathBuf,
    pub steam: Option<PathBuf>,
    pub running: Box<dyn Fn() -> bool + Send + Sync>,
    pub windows: bool,
}

impl Ctx {
    /// This computer.
    pub fn here(data: PathBuf) -> Ctx {
        Ctx {
            data,
            steam: files::find(),
            running: Box::new(files::running),
            windows: cfg!(windows),
        }
    }

    fn running(&self) -> bool {
        (self.running)()
    }
}

/// What the web app is told when Steam's files cannot be written now.
pub const STEAM_RUNNING: &str =
    "Steam is running. Atlas writes to Steam only while Steam is closed.";

pub fn load(data: &Path) -> State {
    fs::read(data.join(STATE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(data: &Path, s: &State) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    files::write_atomic(&data.join(STATE_FILE), &text)
}

/// Steam's folder and the user to write for: the one chosen when Steam
/// still has it, else the one signed in most recently.
pub fn place(ctx: &Ctx, chosen: &str) -> Result<(PathBuf, String), String> {
    let steam = ctx.steam.clone().ok_or("Steam isn't on this computer.")?;
    let users = files::users(&steam);
    let user = users
        .iter()
        .find(|u| !chosen.is_empty() && u.id == chosen)
        .or_else(|| users.first())
        .map(|u| u.id.clone())
        .ok_or("Nobody has signed in to Steam on this computer yet.")?;
    Ok((steam, user))
}

/// Whether two program paths are the same program, quotes and spaces
/// around them left out; on Windows without case.
pub fn same_program(a: &str, b: &str, windows: bool) -> bool {
    let clean = |s: &str| s.trim().trim_matches('"').trim().to_owned();
    let (a, b) = (clean(a), clean(b));
    !a.is_empty()
        && if windows {
            a.replace('/', "\\").to_lowercase() == b.replace('/', "\\").to_lowercase()
        } else {
            a == b
        }
}

/// The id of a shortcut to `program` the person made (any shortcut without
/// Atlas's tag): its `appid`, or worked out from its program and name when
/// it has none.
pub fn theirs(top: &vdf::Top, program: &str, windows: bool) -> Option<u32> {
    vdf::shortcuts_of(top).iter().find_map(|v| {
        if vdf::is_tagged(v, TAG) {
            return None;
        }
        let exe = v.str("Exe")?;
        same_program(&exe, program, windows).then(|| {
            v.int("appid")
                .unwrap_or_else(|| vdf::shortcut_id(&exe, &v.str("AppName").unwrap_or_default()))
        })
    })
}

fn tagged_ids(top: &vdf::Top) -> Vec<u32> {
    vdf::shortcuts_of(top)
        .iter()
        .filter(|v| vdf::is_tagged(v, TAG))
        .filter_map(|v| v.int("appid"))
        .collect()
}

fn crc(bytes: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(bytes);
    h.finalize()
}

/// Whether what is wanted differs from what was last written, or what was
/// written is no longer in Steam's files.
pub fn waiting(ctx: &Ctx, s: &State) -> bool {
    match (&s.wanted, &s.written) {
        (None, None) => false,
        (None, Some(_)) | (Some(_), None) => true,
        (Some(w), Some(x)) => {
            let Ok((steam, user)) = place(ctx, &w.user) else {
                return false;
            };
            if x.steam != steam.display().to_string() || x.user != user || x.program != w.program {
                return true;
            }
            let Ok(top) = files::read_shortcuts(&steam, &user) else {
                return false;
            };
            if x.own {
                !tagged_ids(&top).contains(&x.appid)
                    || theirs(&top, &w.program, ctx.windows).is_some()
            } else {
                theirs(&top, &w.program, ctx.windows) != Some(x.appid)
            }
        }
    }
}

/// What [`apply`] did, for the activity log.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// Atlas's own shortcut written, with this many pictures, beside this
    /// many other shortcuts.
    Added { pictures: usize, others: usize },
    /// The person's own shortcut to Atlas given this many pictures.
    Pictures { pictures: usize },
    /// Taken out.
    Removed,
    /// Nothing was wanted or written.
    Nothing,
}

impl Applied {
    pub fn line(&self) -> String {
        match self {
            Applied::Added { pictures, others } => format!(
                "Added Atlas to Steam with {pictures} pictures; the {others} other non-Steam games were kept as they were"
            ),
            Applied::Pictures { pictures } => format!(
                "Atlas was in Steam already (added by hand), so Atlas only added {pictures} pictures to it"
            ),
            Applied::Removed => "Took Atlas and its pictures out of Steam".to_owned(),
            Applied::Nothing => "Nothing to write into Steam".to_owned(),
        }
    }
}

fn stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default()
}

/// Takes out the grid pictures Atlas wrote that are still as it wrote them.
fn remove_grid(steam: &Path, user: &str, grid: &[GridFile]) {
    let Ok(dir) = files::config_dir(steam, user).map(|d| d.join("grid")) else {
        return;
    };
    for g in grid {
        // A name of Atlas's own making only: no folder in it.
        if g.name.contains(['/', '\\']) || g.name.starts_with('.') {
            continue;
        }
        let path = dir.join(&g.name);
        if fs::read(&path).is_ok_and(|b| crc(&b) == g.crc) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Whether a grid picture `<stem>.<any picture type>` is there.
fn picture_there(dir: &Path, stem: &str) -> Option<PathBuf> {
    PICTURE_TYPES
        .iter()
        .map(|t| dir.join(format!("{stem}.{t}")))
        .find(|p| p.is_file())
}

/// Writes what is wanted into Steam: only while Steam is closed.
pub fn apply(ctx: &Ctx) -> Result<Applied, String> {
    if ctx.running() {
        return Err(STEAM_RUNNING.into());
    }
    let mut s = load(&ctx.data);
    let target = match &s.wanted {
        Some(w) => Some((place(ctx, &w.user)?, w.clone())),
        None => None,
    };
    let stamp = stamp();
    // What was written before goes first: its pictures always (they are
    // written again), its shortcut when it is somewhere else now or not
    // wanted.
    let had = s.written.is_some();
    if let Some(old) = s.written.take() {
        let old_steam = PathBuf::from(&old.steam);
        remove_grid(&old_steam, &old.user, &old.grid);
        let elsewhere = target
            .as_ref()
            .is_none_or(|((steam, user), _)| *steam != old_steam || *user != old.user);
        if elsewhere {
            let has_ours = files::read_shortcuts(&old_steam, &old.user)
                .is_ok_and(|top| !tagged_ids(&top).is_empty());
            if has_ours {
                files::put_shortcut(&old_steam, &old.user, TAG, None, BACKUP, &stamp)?;
            }
        }
        save(&ctx.data, &s)?;
    }
    let Some(((steam, user), w)) = target else {
        return Ok(if had {
            Applied::Removed
        } else {
            Applied::Nothing
        });
    };
    let dir = files::config_dir(&steam, &user)?;
    let top = files::read_shortcuts(&steam, &user)?;
    let program = PathBuf::from(&w.program);
    let found = theirs(&top, &w.program, ctx.windows);
    let mine = Shortcut::new(NAME, &program, Path::new(&w.start_dir), "");
    let appid = found.unwrap_or(mine.appid);
    // The pictures, never over one that is there.
    let grid_dir = dir.join("grid");
    let art = ctx.data.join(ART_DIR);
    let mut grid = vec![];
    let mut kept = vec![];
    let mut icon = String::new();
    for (kind, file, end) in ART {
        let src = art.join(file);
        let stem = format!("{appid}{end}");
        if let Some(there) = picture_there(&grid_dir, &stem) {
            kept.push(kind.to_owned());
            if kind == "icon" {
                icon = there.display().to_string();
            }
            continue;
        }
        let Ok(bytes) = fs::read(&src) else { continue };
        let ext = Path::new(file)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "png".into());
        let name = format!("{stem}.{ext}");
        let to = grid_dir.join(&name);
        files::write_atomic(&to, &bytes)?;
        if kind == "icon" {
            icon = to.display().to_string();
        }
        grid.push(GridFile {
            name,
            crc: crc(&bytes),
        });
    }
    let pictures = grid.len();
    let applied = if found.is_some() {
        // The person's own shortcut stays as it is; one of Atlas's from
        // before goes, so Atlas is not in Steam twice.
        if !tagged_ids(&top).is_empty() {
            files::put_shortcut(&steam, &user, TAG, None, BACKUP, &stamp)?;
        }
        Applied::Pictures { pictures }
    } else {
        let own = Shortcut { icon, ..mine };
        let others = files::put_shortcut(&steam, &user, TAG, Some(&own), BACKUP, &stamp)?;
        Applied::Added { pictures, others }
    };
    s.written = Some(Written {
        steam: steam.display().to_string(),
        user,
        program: w.program.clone(),
        appid,
        own: found.is_none(),
        grid,
        kept,
    });
    save(&ctx.data, &s)?;
    Ok(applied)
}

/// Wants Atlas in Steam (`Some`) or not (`None`), then writes it at once
/// when Steam is closed. Gives what was written, if anything.
pub fn want(ctx: &Ctx, wanted: Option<Wanted>) -> Result<Option<Applied>, String> {
    let mut s = load(&ctx.data);
    s.wanted = wanted;
    save(&ctx.data, &s)?;
    write_if_closed(ctx)
}

/// Writes what waits, when Steam is closed.
pub fn write_if_closed(ctx: &Ctx) -> Result<Option<Applied>, String> {
    let s = load(&ctx.data);
    if waiting(ctx, &s) && !ctx.running() {
        return apply(ctx).map(Some);
    }
    Ok(None)
}

/// Copies Atlas's pictures from `from` (its resources) into the data
/// folder. Gives how many were there to copy.
pub fn copy_art(from: &Path, data: &Path) -> usize {
    let to = data.join(ART_DIR);
    let _ = fs::create_dir_all(&to);
    ART.iter()
        .filter(|(_, file, _)| {
            fs::read(from.join(file))
                .is_ok_and(|bytes| files::write_atomic(&to.join(file), &bytes).is_ok())
        })
        .count()
}

/// For Settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Steam's folder, when Steam is on this computer.
    pub folder: Option<String>,
    pub running: bool,
    /// The Steam Deck's Game Mode: Steam comes back by itself after it is
    /// closed.
    pub game_mode: bool,
    /// The users signed in to Steam here, the most recent first.
    pub users: Vec<User>,
    /// The user Atlas writes for.
    pub user: Option<String>,
    /// Why Atlas cannot add itself here, if it cannot.
    pub refused: Option<String>,
    /// The person wants Atlas in Steam.
    pub wanted: bool,
    /// What is wanted is not written yet (Steam is running).
    pub waiting: bool,
    /// Atlas is in Steam as wanted.
    pub in_steam: bool,
    /// Atlas was in Steam already (added by hand): only pictures were added.
    pub by_hand: bool,
    /// The kinds of picture left as the person's own.
    pub kept: Vec<String>,
}

/// What Settings shows. `program` is Atlas's own program, or why there is
/// none. When it moved (an AppImage moved), what is wanted follows it.
/// What waits is written first when Steam is closed.
pub fn status(ctx: &Ctx, program: Result<PathBuf, String>, game_mode: bool) -> Status {
    let mut s = load(&ctx.data);
    if let (Some(w), Ok(p)) = (s.wanted.as_mut(), program.as_ref()) {
        let now = p.display().to_string();
        if w.program != now {
            w.program = now;
            w.start_dir = start_dir(p);
            let _ = save(&ctx.data, &s);
        }
    }
    // What waits is written as soon as Steam is closed (the person may have
    // closed it themselves).
    match write_if_closed(ctx) {
        Ok(Some(done)) => crate::activity::info(crate::activity::Area::App, done.line()),
        Ok(None) => {}
        Err(e) => crate::activity::warn(crate::activity::Area::App, format!("Atlas in Steam: {e}")),
    }
    s = load(&ctx.data);
    let chosen = s
        .wanted
        .as_ref()
        .map(|w| w.user.clone())
        .unwrap_or_default();
    let users = ctx.steam.as_deref().map(files::users).unwrap_or_default();
    let user = place(ctx, &chosen).ok().map(|(_, u)| u);
    let waiting = waiting(ctx, &s);
    let in_steam = s.wanted.is_some() && s.written.is_some() && !waiting;
    let written = s.written.clone().unwrap_or_default();
    Status {
        folder: ctx.steam.as_ref().map(|p| p.display().to_string()),
        running: ctx.steam.is_some() && ctx.running(),
        game_mode,
        users,
        user,
        refused: program.err(),
        wanted: s.wanted.is_some(),
        waiting,
        in_steam,
        by_hand: in_steam && !written.own,
        kept: if in_steam { written.kept } else { vec![] },
    }
}

/// The folder a program starts in: its own.
pub fn start_dir(program: &Path) -> String {
    program
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

/// The names of the grid pictures Atlas wrote, for tests.
#[cfg(test)]
pub fn grid_names(s: &State) -> std::collections::BTreeSet<String> {
    s.written
        .iter()
        .flat_map(|w| w.grid.iter().map(|g| g.name.clone()))
        .collect()
}
