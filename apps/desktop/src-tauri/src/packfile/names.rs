//! The names Atlas gives the pack files it writes by itself: the packs kept
//! up to date in a folder (`keep`, in the app with downloads) and the pack
//! file of a map made here (`madepack`, on a reader). A name is made from
//! the game's title, safe as a Windows file name, and never one that is
//! taken in the folder.

use std::{
    fs,
    path::{Path, PathBuf},
};

use super::EXTENSION;

/// The ending of the unfinished files of the packs kept up to date:
/// `<name>.atlas-importer.part`.
pub const PART_ENDING: &str = ".atlas-importer.part";
/// The ending of the unfinished files of an export and of a written map:
/// `<name>.part`.
pub const PART_SUFFIX: &str = ".part";
/// The most characters of a new file's name before ` (2)` and the
/// extension, so that the name, its unfinished file's and the folder
/// around it stay within what Windows and the programs on it take.
pub const MAX_STEM_CHARS: usize = 100;

/// Names Windows keeps for devices, which no file may have, whatever its
/// extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A text made safe as (part of) a Windows file name: no character Windows
/// refuses (`<>:"/\|?*` and control characters), `:` and slashes made a
/// dash, spaces run together, no dot or space at the end.
fn safe_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            ':' => out.push_str(" - "),
            '/' | '\\' => out.push('-'),
            '<' | '>' | '"' | '|' | '?' | '*' => out.push(' '),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    joined
        .trim_end_matches(['.', ' '])
        .trim_start_matches(' ')
        .to_owned()
}

/// The stem of a new pack's file name, `<Game title> - <Source>`: the
/// game's title (`game.title`, else the pack's own title, else its id) and
/// the site's name (`source.name`, else the pack's own title when it
/// differs from the game's; nothing otherwise, and then the name is the
/// game's title alone). Made safe as a Windows file name, at most
/// [`MAX_STEM_CHARS`] characters, never a name Windows keeps for devices.
pub fn stem_from(game: Option<&str>, own_title: &str, source: Option<&str>, id: &str) -> String {
    let title_of = |text: &str| Some(safe_text(text)).filter(|text| !text.is_empty());
    let game = game
        .and_then(title_of)
        .or_else(|| title_of(own_title))
        .unwrap_or_else(|| id.to_owned());
    let source = source
        .and_then(title_of)
        .or_else(|| title_of(own_title).filter(|title| *title != game));
    let joined = match source {
        Some(source) if source != game => format!("{game} - {source}"),
        _ => game,
    };
    let mut stem: String = joined.chars().take(MAX_STEM_CHARS).collect();
    stem = stem.trim_end_matches(['.', ' ']).to_owned();
    if stem.is_empty() {
        id.clone_into(&mut stem);
    }
    let base = stem.split('.').next().unwrap_or_default().trim_end();
    if RESERVED.iter().any(|name| name.eq_ignore_ascii_case(base)) {
        stem.push('_');
    }
    stem
}

/// A free path for a new pack in `folder`: `<stem>.atlaspack`, else
/// `<stem> (2).atlaspack` and so on, never a name that is taken (in any
/// case, where the drive does not tell case apart) or whose unfinished file
/// (either ending) is there. None after 100 names.
pub fn free_path(folder: &Path, stem: &str) -> Option<PathBuf> {
    let taken_names: Vec<String> = fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
                .collect()
        })
        .unwrap_or_default();
    (1..=100).find_map(|n| {
        let name = if n == 1 {
            format!("{stem}.{EXTENSION}")
        } else {
            format!("{stem} ({n}).{EXTENSION}")
        };
        let lower = name.to_lowercase();
        let part = format!("{lower}{PART_ENDING}");
        let export_part = format!("{lower}{PART_SUFFIX}");
        let path = folder.join(&name);
        let taken = taken_names
            .iter()
            .any(|taken| *taken == lower || *taken == part || *taken == export_part)
            || fs::symlink_metadata(&path).is_ok();
        (!taken).then_some(path)
    })
}
