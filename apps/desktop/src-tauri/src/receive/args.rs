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
//! Options (an argument that starts with `-`) are not known yet and are
//! left out one by one; a later version reads its own options in
//! [`read`] before the paths, without changing how a path is taken.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use crate::{activity, packfile::EXTENSION};

/// The most characters of an argument written to the activity log.
const MAX_SHOWN: usize = 200;

/// What a start asked for.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StartRequest {
    /// The pack file to show, as an absolute path.
    pub pack_file: Option<PathBuf>,
    /// What was left out, and why, one plain line each.
    pub left_out: Vec<String>,
}

/// Reads a start's arguments: `args` as the system gives them, the
/// program's own path first, and `cwd` the folder the start came from.
pub fn read(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> StartRequest {
    let mut request = StartRequest::default();
    let mut paths = Vec::new();
    for arg in args.into_iter().skip(1) {
        if arg.is_empty() {
            continue;
        }
        if arg.to_string_lossy().starts_with('-') {
            request
                .left_out
                .push(format!("{}: an option Atlas does not know", shown(&arg)));
        } else {
            paths.push(arg);
        }
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
        let request = read(args(&[file.to_str().unwrap()]), Path::new("/elsewhere"));
        assert_eq!(request.pack_file.as_deref(), Some(file.as_path()));
        assert!(request.left_out.is_empty());

        // A relative path, from the folder the start came from; the
        // extension in any case.
        fs::write(dir.0.join("RIDGE.ATLASPACK"), b"not read").unwrap();
        let request = read(args(&["RIDGE.ATLASPACK"]), &dir.0);
        assert_eq!(request.pack_file, Some(dir.0.join("RIDGE.ATLASPACK")));
        assert!(request.pack_file.unwrap().is_absolute());

        // No arguments: nothing asked, nothing left out.
        assert_eq!(read(args(&[]), &dir.0), StartRequest::default());
    }

    #[test]
    fn leaves_out_a_missing_file_a_folder_and_another_extension() {
        let dir = TempDir::new("args-bad");
        let missing = read(args(&["gone.atlaspack"]), &dir.0);
        assert_eq!(missing.pack_file, None);
        assert_eq!(
            missing.left_out,
            vec!["\u{201c}gone.atlaspack\u{201d}: no such file".to_owned()]
        );

        fs::create_dir_all(dir.0.join("folder.atlaspack")).unwrap();
        let folder = read(args(&["folder.atlaspack"]), &dir.0);
        assert_eq!(folder.pack_file, None);
        assert!(folder.left_out[0].ends_with("not a plain file"));

        for name in [
            "notes.txt",
            "valley.atlaspack.part",
            ".atlaspack",
            "valley.zip",
        ] {
            fs::write(dir.0.join(name), b"x").unwrap();
            let other = read(args(&[name]), &dir.0);
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
        let request = read(args(&["one.atlaspack", "two.atlaspack"]), &dir.0);
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
        let request = read(args(&["--show-pack", "one.atlaspack", "-x", "--"]), &dir.0);
        assert_eq!(request.pack_file, Some(dir.0.join("one.atlaspack")));
        assert_eq!(request.left_out.len(), 3);
        assert!(request.left_out[0].starts_with("\u{201c}--show-pack\u{201d}: an option"));

        // An option that looks like a pack file is still an option, and
        // text that would turn a log line around is taken out.
        let request = read(
            args(&["-one.atlaspack", "\u{202e}\nevil.atlaspack"]),
            &dir.0,
        );
        assert_eq!(request.pack_file, None);
        assert_eq!(request.left_out.len(), 2);
        assert!(request.left_out[1].ends_with("no such file"));
        assert!(!request.left_out[1].contains(['\u{202e}', '\n']));

        let long = format!("--{}", "x".repeat(500));
        let request = read(args(&[&long]), &dir.0);
        assert!(request.left_out[0].chars().count() < 300);
    }
}
