//! The arguments Atlas is started with, read as untrusted input.
//!
//! A file manager starts Atlas with the path of the pack file the person
//! opened (`Atlas.exe "D:\Shared\Test Valley.atlaspack"`), and a second
//! start hands its arguments to the Atlas already running. Anything may
//! stand there, so only this is taken: exactly one argument that is not an
//! option, naming an existing regular file whose name ends in
//! `.atlaspack`. A relative path is read from the folder the start came
//! from. Nothing is ever run, opened or looked up because an argument
//! names it, other than that one file's metadata. Every other argument is
//! left out, with a line for the activity log.
//!
//! Options (an argument that starts with `-`) are read first, without
//! changing how a path is taken. The app without downloads takes these,
//! from another program that starts Atlas (see `background`):
//!
//! - `--show-pack <pack id>`: show the game of that pack (a pack id's
//!   syntax only; see `packs::is_valid_pack_id`);
//! - `--show-game <title>`: show the game of that title (at most
//!   [`MAX_TITLE_CHARS`] characters; see `background::titles`);
//! - `--background`: get ready without coming to the front.
//!
//! A value is the next argument, never one that starts with `--`. An option
//! missing its value, given twice, or mixed in a way that makes no sense
//! (`--show-pack` with `--show-game`, or either with a pack file path) leaves
//! out what was asked to be shown or opened, with one line. `--background`
//! still counts when it was given: a program that starts Atlas beside a
//! game and gets its request wrong must not bring Atlas in front of the
//! game. Any other option is left out by itself, with a line, as every
//! option is in the other apps.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use crate::{activity, packfile::EXTENSION};

/// The most characters of an argument written to the activity log.
const MAX_SHOWN: usize = 200;

/// The longest title `--show-game` takes.
pub const MAX_TITLE_CHARS: usize = 200;

/// The options taken (see the module).
const SHOW_PACK: &str = "--show-pack";
const SHOW_GAME: &str = "--show-game";
const BACKGROUND: &str = "--background";

/// A game asked for by another program.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Show {
    /// `--show-pack`: a pack id, checked.
    Pack(String),
    /// `--show-game`: a title, trimmed.
    Game(String),
}

/// What a start asked for.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StartRequest {
    /// The pack file to show, as an absolute path.
    pub pack_file: Option<PathBuf>,
    /// The game to show.
    pub show: Option<Show>,
    /// `--background`: get ready without coming to the front.
    pub background: bool,
    /// What was left out, and why, one plain line each.
    pub left_out: Vec<String>,
}

/// Reads a start's arguments: `args` as the system gives them, the
/// program's own path first, and `cwd` the folder the start came from.
/// `options`: whether this app takes the options of the module (the app
/// without downloads); the others leave them out with a line each.
pub fn read(args: impl IntoIterator<Item = OsString>, cwd: &Path, options: bool) -> StartRequest {
    let mut request = StartRequest::default();
    let mut paths = Vec::new();
    // Why what was asked to be shown or opened is left out, once known.
    let mut refused: Option<String> = None;
    let mut seen: Vec<&'static str> = Vec::new();
    let mut args = args.into_iter().skip(1).peekable();
    while let Some(arg) = args.next() {
        if arg.is_empty() {
            continue;
        }
        let text = arg.to_string_lossy();
        if !text.starts_with('-') {
            paths.push(arg);
            continue;
        }
        let Some(option) = [SHOW_PACK, SHOW_GAME, BACKGROUND]
            .into_iter()
            .find(|known| *known == text)
        else {
            request
                .left_out
                .push(format!("{}: an option Atlas does not know", shown(&arg)));
            continue;
        };
        if seen.contains(&option) {
            refused.get_or_insert_with(|| format!("{option} is given twice"));
        }
        seen.push(option);
        if option == BACKGROUND {
            request.background = true;
            continue;
        }
        // The value: the next argument, unless it is another option.
        let Some(value) = args.next_if(|value| !value.to_string_lossy().starts_with("--")) else {
            refused.get_or_insert_with(|| format!("{option} is missing its value"));
            continue;
        };
        match show_value(option, &value) {
            Ok(show) => {
                request.show.get_or_insert(show);
            }
            Err(reason) => {
                refused.get_or_insert(reason);
            }
        }
    }
    if refused.is_none() && seen.contains(&SHOW_PACK) && seen.contains(&SHOW_GAME) {
        refused = Some(format!("{SHOW_PACK} and {SHOW_GAME} are given together"));
    }
    if refused.is_none() && request.show.is_some() && !paths.is_empty() {
        refused = Some("a game to show is given with a path".to_owned());
    }
    if !options {
        for option in [SHOW_PACK, SHOW_GAME, BACKGROUND] {
            if seen.contains(&option) {
                request.left_out.push(format!(
                    "\u{201c}{option}\u{201d}: an option this app does not take"
                ));
            }
        }
        request.show = None;
        request.background = false;
    } else if let Some(reason) = refused {
        // `--background` stays as it was given (see the module).
        request.show = None;
        request.left_out.push(format!(
            "{reason}, so Atlas left out what it was asked to show or open"
        ));
        return request;
    }
    match paths.as_slice() {
        [] => {}
        [one] => match pack_file(one, cwd) {
            Ok(path) => request.pack_file = Some(path),
            Err(reason) => request.left_out.push(format!("{}: {reason}", shown(one))),
        },
        several => request.left_out.push(format!(
            "{} paths: Atlas opens one pack file at a time, so it opened none of them",
            several.len()
        )),
    }
    request
}

/// The game an option's value names, or why it does not name one.
fn show_value(option: &str, value: &OsString) -> Result<Show, String> {
    let Some(text) = value.to_str() else {
        return Err(format!("the value of {option} is not text"));
    };
    if option == SHOW_PACK {
        return if crate::packs::is_valid_pack_id(text) {
            Ok(Show::Pack(text.to_owned()))
        } else {
            Err(format!("{}: not a pack id", shown(value)))
        };
    }
    let title = text.trim();
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "the title after {option} is longer than {MAX_TITLE_CHARS} characters"
        ));
    }
    if crate::background::titles::title_key(title).is_empty() {
        return Err(format!("{}: not a title", shown(value)));
    }
    Ok(Show::Game(title.to_owned()))
}

/// The pack file one argument names, or why it is not one.
fn pack_file(arg: &OsString, cwd: &Path) -> Result<PathBuf, &'static str> {
    let path = Path::new(arg);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !name.ends_with(&format!(".{EXTENSION}")) || name.len() == EXTENSION.len() + 1 {
        return Err("not a pack file (.atlaspack)");
    }
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    // Follows a link, as opening the file does; a folder, a pipe or a
    // device is not taken.
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("not a plain file"),
        Err(_) => return Err("no such file"),
    }
    Ok(std::path::absolute(&path).unwrap_or(path))
}

/// An argument as the activity log shows it: control characters and
/// characters that turn text around taken out, and cut short.
fn shown(arg: &OsString) -> String {
    let text = activity::clean(&arg.to_string_lossy());
    if text.chars().count() > MAX_SHOWN {
        format!("{}…", text.chars().take(MAX_SHOWN).collect::<String>())
    } else {
        format!("\u{201c}{text}\u{201d}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    /// Reads as the app without downloads does.
    fn read_all(args: Vec<OsString>, cwd: &Path) -> StartRequest {
        read(args, cwd, true)
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        std::iter::once("atlas")
            .chain(list.iter().copied())
            .map(OsString::from)
            .collect()
    }

    #[test]
    fn takes_one_existing_pack_file() {
        let dir = TempDir::new("args-good");
        let file = dir.0.join("Test Valley.atlaspack");
        fs::write(&file, b"not read").unwrap();
        let request = read_all(args(&[file.to_str().unwrap()]), Path::new("/elsewhere"));
        assert_eq!(request.pack_file.as_deref(), Some(file.as_path()));
        assert!(request.left_out.is_empty());

        // A relative path, from the folder the start came from; the
        // extension in any case.
        fs::write(dir.0.join("RIDGE.ATLASPACK"), b"not read").unwrap();
        let request = read_all(args(&["RIDGE.ATLASPACK"]), &dir.0);
        assert_eq!(request.pack_file, Some(dir.0.join("RIDGE.ATLASPACK")));
        assert!(request.pack_file.unwrap().is_absolute());

        // No arguments: nothing asked, nothing left out.
        assert_eq!(read_all(args(&[]), &dir.0), StartRequest::default());
    }

    #[test]
    fn leaves_out_a_missing_file_a_folder_and_another_extension() {
        let dir = TempDir::new("args-bad");
        let missing = read_all(args(&["gone.atlaspack"]), &dir.0);
        assert_eq!(missing.pack_file, None);
        assert_eq!(
            missing.left_out,
            vec!["\u{201c}gone.atlaspack\u{201d}: no such file".to_owned()]
        );

        fs::create_dir_all(dir.0.join("folder.atlaspack")).unwrap();
        let folder = read_all(args(&["folder.atlaspack"]), &dir.0);
        assert_eq!(folder.pack_file, None);
        assert!(folder.left_out[0].ends_with("not a plain file"));

        for name in [
            "notes.txt",
            "valley.atlaspack.part",
            ".atlaspack",
            "valley.zip",
        ] {
            fs::write(dir.0.join(name), b"x").unwrap();
            let other = read_all(args(&[name]), &dir.0);
            assert_eq!(other.pack_file, None, "{name}");
            assert!(
                other.left_out[0].ends_with("not a pack file (.atlaspack)"),
                "{name}"
            );
        }
    }

    #[test]
    fn opens_nothing_when_given_several_paths() {
        let dir = TempDir::new("args-several");
        for name in ["one.atlaspack", "two.atlaspack"] {
            fs::write(dir.0.join(name), b"x").unwrap();
        }
        let request = read_all(args(&["one.atlaspack", "two.atlaspack"]), &dir.0);
        assert_eq!(request.pack_file, None);
        assert_eq!(
            request.left_out,
            vec![
                "2 paths: Atlas opens one pack file at a time, so it opened none of them"
                    .to_owned()
            ]
        );
    }

    #[test]
    fn leaves_out_options_and_still_takes_the_path() {
        let dir = TempDir::new("args-options");
        fs::write(dir.0.join("one.atlaspack"), b"x").unwrap();
        let request = read_all(args(&["--show-map", "one.atlaspack", "-x", "--"]), &dir.0);
        assert_eq!(request.pack_file, Some(dir.0.join("one.atlaspack")));
        assert_eq!(request.left_out.len(), 3);
        assert!(request.left_out[0].starts_with("\u{201c}--show-map\u{201d}: an option"));

        // An option that looks like a pack file is still an option, and
        // text that would turn a log line around is taken out.
        let request = read_all(
            args(&["-one.atlaspack", "\u{202e}\nevil.atlaspack"]),
            &dir.0,
        );
        assert_eq!(request.pack_file, None);
        assert_eq!(request.left_out.len(), 2);
        assert!(request.left_out[1].ends_with("no such file"));
        assert!(!request.left_out[1].contains(['\u{202e}', '\n']));

        let long = format!("--{}", "x".repeat(500));
        let request = read_all(args(&[&long]), &dir.0);
        assert!(request.left_out[0].chars().count() < 300);
    }

    #[test]
    fn takes_a_game_to_show_and_the_background() {
        let dir = TempDir::new("args-show");
        let request = read_all(args(&["--show-pack", "test-valley"]), &dir.0);
        assert_eq!(request.show, Some(Show::Pack("test-valley".to_owned())));
        assert!(!request.background && request.left_out.is_empty());

        let request = read_all(
            args(&["--background", "--show-game", "  Ruined Keep  ", "--later"]),
            &dir.0,
        );
        assert_eq!(request.show, Some(Show::Game("Ruined Keep".to_owned())));
        assert!(request.background);
        // An unknown option is still left out by itself.
        assert_eq!(
            request.left_out,
            ["\u{201c}--later\u{201d}: an option Atlas does not know"]
        );

        // Alone, and with a pack file.
        let request = read_all(args(&["--background"]), &dir.0);
        assert!(request.background && request.show.is_none());
        fs::write(dir.0.join("one.atlaspack"), b"x").unwrap();
        let request = read_all(args(&["one.atlaspack", "--background"]), &dir.0);
        assert!(request.background);
        assert_eq!(request.pack_file, Some(dir.0.join("one.atlaspack")));

        // A title of 200 characters, which may start with one dash.
        let title = "k".repeat(MAX_TITLE_CHARS);
        let request = read_all(args(&["--show-game", &title]), &dir.0);
        assert_eq!(request.show, Some(Show::Game(title)));
        let request = read_all(args(&["--show-game", "-Keep-"]), &dir.0);
        assert_eq!(request.show, Some(Show::Game("-Keep-".to_owned())));
    }

    #[test]
    fn leaves_out_the_whole_request_when_it_makes_no_sense() {
        let dir = TempDir::new("args-refused");
        fs::write(dir.0.join("one.atlaspack"), b"x").unwrap();
        let long = "k".repeat(MAX_TITLE_CHARS + 1);
        for (list, reason) in [
            (vec!["--show-pack"], "--show-pack is missing its value"),
            (
                vec!["--show-game", "--background"],
                "--show-game is missing its value",
            ),
            (
                vec!["--show-pack", "Not An Id"],
                "\u{201c}Not An Id\u{201d}: not a pack id",
            ),
            (
                vec!["--show-pack", "../valley"],
                "\u{201c}../valley\u{201d}: not a pack id",
            ),
            (
                vec!["--show-game", " ?! "],
                "\u{201c} ?! \u{201d}: not a title",
            ),
            (
                vec!["--show-game", &long],
                "the title after --show-game is longer than 200 characters",
            ),
            (
                vec!["--background", "--background"],
                "--background is given twice",
            ),
            (
                vec!["--show-pack", "a", "--show-pack", "b"],
                "--show-pack is given twice",
            ),
            (
                vec!["--show-pack", "a", "--show-game", "A"],
                "--show-pack and --show-game are given together",
            ),
            (
                vec!["--show-game", "A", "one.atlaspack", "--background"],
                "a game to show is given with a path",
            ),
        ] {
            let request = read_all(args(&list), &dir.0);
            assert_eq!(request.show, None, "{list:?}");
            // The background still counts when it was asked for.
            assert_eq!(
                request.background,
                list.contains(&"--background"),
                "{list:?}"
            );
            assert_eq!(request.pack_file, None, "{list:?}");
            assert_eq!(
                request.left_out.last().unwrap(),
                &format!("{reason}, so Atlas left out what it was asked to show or open"),
                "{list:?}"
            );
        }
    }

    #[test]
    fn the_app_with_downloads_takes_none_of_these_options() {
        let dir = TempDir::new("args-other-app");
        fs::write(dir.0.join("one.atlaspack"), b"x").unwrap();
        let request = read(
            args(&[
                "--background",
                "one.atlaspack",
                "--show-game",
                "Ruined Keep",
            ]),
            &dir.0,
            false,
        );
        assert_eq!(request.show, None);
        assert!(!request.background);
        // The path is taken as it always was, the value is not a path.
        assert_eq!(request.pack_file, Some(dir.0.join("one.atlaspack")));
        assert_eq!(
            request.left_out,
            [
                "\u{201c}--show-game\u{201d}: an option this app does not take",
                "\u{201c}--background\u{201d}: an option this app does not take"
            ]
        );
    }
}
