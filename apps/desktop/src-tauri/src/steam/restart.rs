//! "Restart Steam and add it": Steam's files are written only while Steam
//! is closed, so a helper closes Steam, writes what waits and starts Steam
//! again. The helper is Atlas itself, started with `--steam-helper <data
//! folder>` (and `--game-mode`): it does this and ends without a window,
//! before the app or its single-instance check starts (see `main.rs`). It
//! is started apart from Atlas, so it outlives both Steam and this Atlas
//! (which Steam closes with it in Game Mode): on Linux as a unit of the
//! user's own systemd, which Steam's closing does not reach, else in a
//! session of its own; on Windows as a detached process. What it did goes
//! in `steam-restart.log` in the data folder.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use super::{files, state};

/// The argument that makes Atlas the helper.
pub const HELPER: &str = "--steam-helper";
/// Given after the data folder: Steam is in Game Mode, which starts it again by itself.
pub const GAME_MODE: &str = "--game-mode";
/// The helper's log, in the data folder.
pub const LOG: &str = "steam-restart.log";

/// Whether this is the Steam Deck's Game Mode (or Steam's Big Picture in
/// gamescope on another Linux computer): Steam says so to what it starts,
/// and gamescope to what runs in it.
pub fn game_mode() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    env("SteamGamepadUI") == "1"
        || env("XDG_CURRENT_DESKTOP").eq_ignore_ascii_case("gamescope")
        || !env("GAMESCOPE_WAYLAND_DISPLAY").is_empty()
}

/// The helper's arguments, after the program.
pub fn helper_args(data: &Path, game_mode: bool) -> Vec<OsString> {
    let mut args = vec![OsString::from(HELPER), data.as_os_str().to_owned()];
    if game_mode {
        args.push(GAME_MODE.into());
    }
    args
}

/// What a start's arguments ask of the helper: the data folder and Game
/// Mode, or None when Atlas was not started as the helper.
pub fn read_args(args: &[OsString]) -> Option<(PathBuf, bool)> {
    if args.get(1).is_none_or(|a| a != HELPER) {
        return None;
    }
    let data = PathBuf::from(args.get(2)?);
    let game_mode = args.get(3).is_some_and(|a| a == GAME_MODE);
    Some((data, game_mode))
}

/// Starts the helper, `program` with `args`, apart from this Atlas.
pub fn start(program: &Path, args: &[OsString]) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        // Out of the job Steam started this Atlas in, where the job allows
        // it, so closing Steam does not end the helper with it.
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | files::CREATE_NO_WINDOW;
        let spawn = |flags: u32| {
            std::process::Command::new(program)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(flags)
                .spawn()
        };
        spawn(flags | CREATE_BREAKAWAY_FROM_JOB)
            .or_else(|_| spawn(flags))
            .map(drop)
            .map_err(|e| format!("Atlas could not restart Steam: {e}"))
    }
    #[cfg(not(windows))]
    {
        let unit = format!("atlas-steam-restart-{}", std::process::id());
        // The unit gets the user manager's surroundings, not Atlas's: what
        // finding and starting Steam needs is passed on.
        let mut run: Vec<OsString> = ["--user", "--collect", "--quiet", "-p", "KillMode=process"]
            .into_iter()
            .map(OsString::from)
            .collect();
        run.push(format!("--unit={unit}").into());
        for k in [
            "PATH",
            "HOME",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XAUTHORITY",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_TYPE",
        ] {
            if let Some(v) = std::env::var_os(k) {
                let mut set = OsString::from(format!("--setenv={k}="));
                set.push(v);
                run.push(set);
            }
        }
        run.push(program.as_os_str().to_owned());
        run.extend(args.iter().cloned());
        let mut setsid: Vec<OsString> = vec!["-f".into(), program.as_os_str().to_owned()];
        setsid.extend(args.iter().cloned());
        for (cmd, a) in [("systemd-run", run), ("setsid", setsid)] {
            let started = std::process::Command::new(cmd)
                .args(&a)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if started.is_ok_and(|s| s.success()) {
                return Ok(());
            }
        }
        std::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(drop)
            .map_err(|e| format!("Atlas could not restart Steam: {e}"))
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Steam's own program, with `arg` (`-shutdown`, or nothing to start it).
fn steam_command(steam: Option<&Path>, arg: Option<&str>) -> std::process::Command {
    let mut c = match steam {
        Some(folder) if cfg!(windows) => files::command(folder.join("steam.exe")),
        Some(folder) if files::is_flatpak(folder) => {
            let mut c = files::command("flatpak");
            c.args(["run", "com.valvesoftware.Steam"]);
            c
        }
        _ => files::command("steam"),
    };
    c.args(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    c
}

/// Starts Steam, apart from the helper.
fn start_steam(steam: Option<&Path>) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        let _ = steam_command(steam, None)
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let plain = steam_command(steam, None);
        let mut setsid = std::process::Command::new("setsid");
        setsid
            .arg("-f")
            .arg(plain.get_program())
            .args(plain.get_args())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if !setsid.status().is_ok_and(|s| s.success()) {
            let _ = steam_command(steam, None).spawn();
        }
    }
}

/// The helper: closes Steam, writes what waits, and starts Steam again
/// (not in Game Mode, which brings it back by itself).
pub fn helper(ctx: &state::Ctx, in_game_mode: bool) -> Result<(), String> {
    let log_path = ctx.data.join(LOG);
    let log = |line: &str| {
        let text = format!("{} {line}\n", now());
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()));
    };
    log(&format!("Restarting Steam (Game Mode: {in_game_mode})"));
    if (ctx.running)() {
        if let Err(e) = steam_command(ctx.steam.as_deref(), Some("-shutdown")).spawn() {
            log(&format!("Steam could not be asked to close: {e}"));
        }
        let end = Instant::now() + Duration::from_secs(90);
        while (ctx.running)() {
            if Instant::now() > end {
                log("Steam did not close within 90 seconds: nothing written");
                return Err("Steam did not close.".into());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    // A moment for Steam's last writes.
    std::thread::sleep(Duration::from_secs(2));
    let r = state::apply(ctx);
    match &r {
        Ok(done) => log(&done.line()),
        Err(e) => log(&format!("Nothing written: {e}")),
    }
    if !in_game_mode {
        start_steam(ctx.steam.as_deref());
        log("Steam started again");
    }
    r.map(drop)
}
