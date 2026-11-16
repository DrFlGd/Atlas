//! The Sites folder: the person's site rules files, which tell an importer
//! how to read a map, wiki or guide site (see `siteRules.ts` in the
//! importer contract), and which files are switched on.
//!
//! It sits beside the default maps folder in the folder every Atlas app on
//! this computer shares (see `settings.rs`): `%LOCALAPPDATA%\Atlas\Sites`
//! on Windows, `sites` on Linux. Only a build with downloads (Atlas
//! Importer) has its commands; this module's file handling is in every
//! build, so that its tests run there.
//!
//! A file is untrusted data, and nothing here runs or reads into it: the
//! shell keeps files of at most [`MAX_SITE_FILE_BYTES`], UTF-8 text, named
//! `<id>.atlas-site.json` or `<reader>.reader.atlas-site.json`, directly in
//! this folder (never through a link or another folder), and the web app
//! checks what they say. Which files are switched on is kept beside them in
//! `sites.json`:
//!
//! ```json
//! { "format": "atlas-sites", "version": 1,
//!   "on": { "own/example-wiki.atlas-site.json": "<the digest of its text>" },
//!   "off": ["wiki/some-site.atlas-site.json"] }
//! ```
//!
//! The keys are the web app's; the shell checks only their form and how
//! many there are. An own file is on only while its digest is that of its
//! text, so a file replaced by another of the same name is off again until
//! the person has seen its hosts and switches it on.

use std::{
    collections::BTreeMap,
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// A site rules file larger than this is not kept or read.
pub const MAX_SITE_FILE_BYTES: u64 = 64 * 1024;
/// Files of the Sites folder listed at most.
pub const MAX_SITE_FILES: usize = 200;
/// Entries of `sites.json` kept at most, `on` and `off` each.
pub const MAX_SITE_SWITCHES: usize = 1000;
const STATE_FILE: &str = "sites.json";
const STATE_FORMAT: &str = "atlas-sites";
const STATE_VERSION: u32 = 1;
const SUFFIX: &str = ".atlas-site.json";

/// The Sites folder, beside the default maps folder in the shared folder.
pub fn sites_folder(shared: &Path) -> PathBuf {
    if cfg!(target_os = "linux") {
        shared.join("sites")
    } else {
        shared.join("Sites")
    }
}

/// Whether `name` is the name of a site rules file as the Sites folder
/// keeps one: `<id>.atlas-site.json`, `<reader>.reader.atlas-site.json` or
/// `<id>.refused.atlas-site.json`, the id of 3 to 40 of `a-z`, `0-9` and `-`.
pub fn is_site_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(SUFFIX) else {
        return false;
    };
    let id = stem
        .strip_suffix(".reader")
        .or_else(|| stem.strip_suffix(".refused"))
        .unwrap_or(stem);
    let bytes = id.as_bytes();
    (3..=40).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
}

/// Whether `key` is a key of `sites.json`: letters, digits and `-._/`, at most 200.
fn is_switch_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 200
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'/'))
}

/// One file of the Sites folder: its name and text, or why it cannot be read.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteFile {
    pub name: String,
    /// Its text; none when it cannot be read (`problem` says why).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// Which files are switched on: see the module's description.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SiteSwitches {
    #[serde(default)]
    pub on: BTreeMap<String, String>,
    #[serde(default)]
    pub off: Vec<String>,
}

impl SiteSwitches {
    /// The switches as they may be kept: each key and digest in form, at most
    /// [`MAX_SITE_SWITCHES`] of each, `off` each once.
    pub fn validate(self) -> Result<Self, String> {
        if self.on.len() > MAX_SITE_SWITCHES || self.off.len() > MAX_SITE_SWITCHES {
            return Err("Too many sites are switched.".to_owned());
        }
        let digest_ok = |digest: &str| {
            !digest.is_empty()
                && digest.len() <= 128
                && digest.bytes().all(|b| b.is_ascii_hexdigit())
        };
        if !self
            .on
            .iter()
            .all(|(key, digest)| is_switch_key(key) && digest_ok(digest))
            || !self.off.iter().all(|key| is_switch_key(key))
        {
            return Err("A site's switch is not in the expected form.".to_owned());
        }
        let mut off = self.off;
        off.sort();
        off.dedup();
        Ok(Self { on: self.on, off })
    }
}

#[derive(Serialize, Deserialize)]
struct StateFile {
    format: String,
    version: u32,
    #[serde(flatten)]
    switches: SiteSwitches,
}

/// What the Sites folder holds: its path, its files in name order, and the switches.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SitesListing {
    pub folder: String,
    pub files: Vec<SiteFile>,
    pub switches: SiteSwitches,
}

/// Reads at most [`MAX_SITE_FILE_BYTES`] of a file as UTF-8 text.
fn read_limited(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("It cannot be read: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_SITE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("It cannot be read: {error}"))?;
    if bytes.len() as u64 > MAX_SITE_FILE_BYTES {
        return Err(format!(
            "It is larger than {} KB, so it is not read.",
            MAX_SITE_FILE_BYTES / 1024
        ));
    }
    String::from_utf8(bytes).map_err(|_| "It is not a text file in UTF-8.".to_owned())
}

/// The switches kept in the folder; none when there is no usable `sites.json`.
pub fn read_switches(folder: &Path) -> SiteSwitches {
    let path = folder.join(STATE_FILE);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return SiteSwitches::default();
    };
    if !meta.is_file() || meta.len() > 1 << 20 {
        return SiteSwitches::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|text| {
            serde_json::from_str::<StateFile>(text.trim_start_matches('\u{feff}')).ok()
        })
        .filter(|state| state.format == STATE_FORMAT && state.version == STATE_VERSION)
        .and_then(|state| state.switches.validate().ok())
        .unwrap_or_default()
}

/// Writes `contents` to `name` in `folder` through a `.part` file, so that a
/// file is never half written.
fn write_atomically(folder: &Path, name: &str, contents: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(folder)?;
    let part = folder.join(format!("{name}.part"));
    let mut file = fs::File::create(&part)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&part, folder.join(name))
}

/// Keeps the switches, checked.
pub fn write_switches(folder: &Path, switches: SiteSwitches) -> Result<SiteSwitches, String> {
    let switches = switches.validate()?;
    let state = StateFile {
        format: STATE_FORMAT.to_owned(),
        version: STATE_VERSION,
        switches: switches.clone(),
    };
    let text = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    write_atomically(folder, STATE_FILE, format!("{text}\n").as_bytes())
        .map_err(|error| format!("Could not save which sites are on: {error}"))?;
    Ok(switches)
}

/// The files of the Sites folder (only regular files directly in it, with
/// the name of a site rules file, at most [`MAX_SITE_FILES`]) and the
/// switches. A folder that is not there yet holds nothing.
pub fn list(folder: &Path) -> SitesListing {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(folder) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| is_site_file_name(name))
            .collect();
        names.sort();
        names.truncate(MAX_SITE_FILES);
        for name in names {
            let read = read_limited(&folder.join(&name));
            files.push(SiteFile {
                name,
                text: read.as_ref().ok().cloned(),
                problem: read.err(),
            });
        }
    }
    SitesListing {
        folder: folder.display().to_string(),
        files,
        switches: read_switches(folder),
    }
}

/// Keeps a file the person added under `name`, in place of one of that
/// name; it is off until they switch it on.
pub fn add(folder: &Path, name: &str, text: &str) -> Result<(), String> {
    if !is_site_file_name(name) {
        return Err("A site rules file is named <site id>.atlas-site.json.".to_owned());
    }
    if text.len() as u64 > MAX_SITE_FILE_BYTES {
        return Err(format!(
            "A site rules file may be at most {} KB.",
            MAX_SITE_FILE_BYTES / 1024
        ));
    }
    let target = folder.join(name);
    if fs::symlink_metadata(&target).is_ok_and(|meta| !meta.is_file()) {
        return Err(format!("{name} in the Sites folder is not a file."));
    }
    write_atomically(folder, name, text.as_bytes())
        .map_err(|error| format!("Could not keep {name}: {error}"))
}

/// Removes a file of the Sites folder, and its switch. Whether it was there.
pub fn remove(folder: &Path, name: &str, key: &str) -> Result<bool, String> {
    if !is_site_file_name(name) {
        return Err("That is not a site rules file of the Sites folder.".to_owned());
    }
    let path = folder.join(name);
    let removed = match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => {
            fs::remove_file(&path).map_err(|error| format!("Could not remove {name}: {error}"))?;
            true
        }
        Ok(_) => return Err(format!("{name} in the Sites folder is not a file.")),
        Err(_) => false,
    };
    let mut switches = read_switches(folder);
    if switches.on.remove(key).is_some() {
        write_switches(folder, switches)?;
    }
    Ok(removed)
}

/// The most bytes of a saved page the Sites screen tries a file on.
pub const MAX_SAVED_PAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Reads a saved page the person chose to try a file on: at most
/// [`MAX_SAVED_PAGE_BYTES`], UTF-8 text (a byte that is not is replaced).
/// Its size is checked before it is read. Nothing of it is kept.
pub fn read_saved_page(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|error| format!("The page cannot be read: {error}"))?;
    if !meta.is_file() {
        return Err("That is not a file.".to_owned());
    }
    if meta.len() > MAX_SAVED_PAGE_BYTES {
        return Err(format!(
            "The page is {} MB, and a page to try a file on may be at most {} MB.",
            meta.len().div_ceil(1024 * 1024),
            MAX_SAVED_PAGE_BYTES / (1024 * 1024)
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_SAVED_PAGE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("The page cannot be read: {error}"))?;
    if bytes.len() as u64 > MAX_SAVED_PAGE_BYTES {
        return Err(format!(
            "The page is larger than {} MB.",
            MAX_SAVED_PAGE_BYTES / (1024 * 1024)
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads a file the person chose to add: at most [`MAX_SITE_FILE_BYTES`],
/// UTF-8 text. Its size is checked before it is read.
pub fn read_chosen(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|error| format!("The file cannot be read: {error}"))?;
    if !meta.is_file() {
        return Err("That is not a file.".to_owned());
    }
    if meta.len() > MAX_SITE_FILE_BYTES {
        return Err(format!(
            "The file is {} KB, and a site rules file may be at most {} KB, so it was not added.",
            meta.len().div_ceil(1024),
            MAX_SITE_FILE_BYTES / 1024
        ));
    }
    read_limited(path).map_err(|problem| format!("The file was not added. {problem}"))
}

/// The commands of the Sites screen, in a build with downloads only.
#[cfg(feature = "downloads")]
pub mod commands {
    use super::{
        add, list, read_chosen, read_saved_page, remove, sites_folder, write_switches,
        SiteSwitches, SitesListing,
    };
    use crate::commands::{
        blocking, desktop_only, file_name, save_text, LibraryState, SavedFile, TextFileKind,
    };
    use serde::Serialize;
    use tauri::{AppHandle, Runtime, WebviewWindow};

    fn folder_of(library: &LibraryState<'_>) -> std::path::PathBuf {
        sites_folder(library.settings().dir())
    }

    /// The Sites folder's files and which are switched on.
    #[tauri::command]
    pub async fn sites_list(library: LibraryState<'_>) -> Result<SitesListing, String> {
        desktop_only()?;
        let folder = folder_of(&library);
        blocking(move || Ok(list(&folder))).await
    }

    /// A file the person chose: its name and text.
    #[derive(Serialize)]
    pub struct ChosenSiteFile {
        name: String,
        text: String,
    }

    /// Asks for a site rules file and reads it, after checking its size; the
    /// web app checks what it says before it is kept. `None` when the
    /// dialog was closed.
    #[tauri::command]
    pub async fn sites_pick<R: Runtime>(
        window: WebviewWindow<R>,
    ) -> Result<Option<ChosenSiteFile>, String> {
        desktop_only()?;
        let dialog = crate::commands::file_dialog(&window, "Add a rules file")
            .add_filter("Site rules file", &["json"]);
        let Some(path) = crate::commands::chosen_path(|done| dialog.pick_file(done)).await? else {
            return Ok(None);
        };
        blocking(move || {
            let text = read_chosen(&path)?;
            Ok(Some(ChosenSiteFile {
                name: file_name(&path),
                text,
            }))
        })
        .await
    }

    /// Asks for a page the person saved (`.html`), or a map's data file
    /// (`.json`), and reads it, after checking its size, to try a site
    /// rules file on ("Try on a saved page"). Nothing of it is kept. `None`
    /// when the dialog was closed.
    #[tauri::command]
    pub async fn sites_pick_page<R: Runtime>(
        window: WebviewWindow<R>,
    ) -> Result<Option<ChosenSiteFile>, String> {
        desktop_only()?;
        let dialog = crate::commands::file_dialog(&window, "Try on a saved page")
            .add_filter("Saved page or data file", &["html", "htm", "json"]);
        let Some(path) = crate::commands::chosen_path(|done| dialog.pick_file(done)).await? else {
            return Ok(None);
        };
        blocking(move || {
            let text = read_saved_page(&path)?;
            Ok(Some(ChosenSiteFile {
                name: file_name(&path),
                text,
            }))
        })
        .await
    }

    /// Keeps a checked file in the Sites folder under `name`.
    #[tauri::command]
    pub async fn sites_add(
        library: LibraryState<'_>,
        name: String,
        text: String,
    ) -> Result<(), String> {
        desktop_only()?;
        let folder = folder_of(&library);
        blocking(move || {
            add(&folder, &name, &text)?;
            crate::activity::info(
                crate::activity::Area::Library,
                format!("Added the site rules file {name}"),
            );
            Ok(())
        })
        .await
    }

    /// Removes a file of the Sites folder, and its switch `key`.
    #[tauri::command]
    pub async fn sites_remove(
        library: LibraryState<'_>,
        name: String,
        key: String,
    ) -> Result<bool, String> {
        desktop_only()?;
        let folder = folder_of(&library);
        blocking(move || {
            let removed = remove(&folder, &name, &key)?;
            if removed {
                crate::activity::info(
                    crate::activity::Area::Library,
                    format!("Removed the site rules file {name}"),
                );
            }
            Ok(removed)
        })
        .await
    }

    /// The guide to writing a site rules file, saved where the person chooses.
    const GUIDE_FILE: TextFileKind = TextFileKind {
        save_title: "Save the guide",
        open_title: "Open the guide",
        filter: "Markdown",
        extensions: &["md"],
        what: "the guide",
        fallback_name: "atlas-site-rules.md",
    };

    /// The JSON Schema of site rules files, saved where the person chooses.
    const SCHEMA_FILE: TextFileKind = TextFileKind {
        save_title: "Save the schema",
        open_title: "Open the schema",
        filter: "JSON Schema",
        extensions: &["json"],
        what: "the schema",
        fallback_name: "atlas-site-rules.schema.json",
    };

    /// Asks where to save the guide (`what` is `guide`) or the schema
    /// (`schema`) and saves the text the web app gives. `None` when the
    /// dialog was closed.
    #[tauri::command]
    pub async fn sites_save<R: Runtime>(
        app: AppHandle<R>,
        window: WebviewWindow<R>,
        what: String,
        contents: String,
    ) -> Result<Option<SavedFile>, String> {
        desktop_only()?;
        let kind = match what.as_str() {
            "guide" => &GUIDE_FILE,
            "schema" => &SCHEMA_FILE,
            _ => return Err("Only the guide or the schema can be saved here.".to_owned()),
        };
        if contents.len() > 4 << 20 {
            return Err("That is too large to save.".to_owned());
        }
        save_text(app, window, kind, kind.fallback_name.to_owned(), contents).await
    }

    /// Keeps which files are switched on.
    #[tauri::command]
    pub async fn sites_switch(
        library: LibraryState<'_>,
        switches: SiteSwitches,
    ) -> Result<SiteSwitches, String> {
        desktop_only()?;
        let folder = folder_of(&library);
        blocking(move || write_switches(&folder, switches)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    #[test]
    fn knows_the_names_of_site_files() {
        assert!(is_site_file_name("example-wiki.atlas-site.json"));
        assert!(is_site_file_name("example-engine.reader.atlas-site.json"));
        assert!(is_site_file_name("example-farm.refused.atlas-site.json"));
        assert!(!is_site_file_name("ab.refused.atlas-site.json"));
        assert!(!is_site_file_name("ab.atlas-site.json"));
        assert!(!is_site_file_name("-ab.atlas-site.json"));
        assert!(!is_site_file_name("Example.atlas-site.json"));
        assert!(!is_site_file_name("../x/abc.atlas-site.json"));
        assert!(!is_site_file_name("abc.json"));
        assert!(!is_site_file_name("sites.json"));
        assert!(!is_site_file_name(&format!(
            "{}.atlas-site.json",
            "a".repeat(41)
        )));
    }

    #[test]
    fn keeps_lists_and_removes_files_with_their_switch() {
        let dir = TempDir::new("sites");
        let folder = sites_folder(&dir.0);
        assert_eq!(list(&folder).files, Vec::new());
        add(&folder, "example-wiki.atlas-site.json", "{}").unwrap();
        // Not a site file, a folder and a file too large: left out, or listed with why.
        fs::write(folder.join("notes.txt"), "x").unwrap();
        fs::create_dir_all(folder.join("other.atlas-site.json")).unwrap();
        fs::write(
            folder.join("large-one.atlas-site.json"),
            vec![b' '; (MAX_SITE_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        let listed = list(&folder);
        assert_eq!(
            listed
                .files
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            vec!["example-wiki.atlas-site.json", "large-one.atlas-site.json"]
        );
        assert_eq!(listed.files[0].text.as_deref(), Some("{}"));
        assert!(listed.files[1].text.is_none());
        assert!(listed.files[1]
            .problem
            .as_deref()
            .unwrap()
            .contains("64 KB"));

        let mut switches = SiteSwitches::default();
        switches
            .on
            .insert("own/example-wiki.atlas-site.json".into(), "ab12".into());
        switches.off = vec![
            "wiki/b.atlas-site.json".into(),
            "wiki/b.atlas-site.json".into(),
        ];
        let kept = write_switches(&folder, switches).unwrap();
        assert_eq!(kept.off, vec!["wiki/b.atlas-site.json".to_owned()]);
        assert_eq!(read_switches(&folder), kept);

        assert!(remove(
            &folder,
            "example-wiki.atlas-site.json",
            "own/example-wiki.atlas-site.json"
        )
        .unwrap());
        assert!(read_switches(&folder).on.is_empty());
        assert!(!remove(&folder, "example-wiki.atlas-site.json", "x").unwrap());
        assert!(remove(&folder, "../settings.json", "x").is_err());
        assert!(remove(&folder, "other.atlas-site.json", "x").is_err());
    }

    #[test]
    fn refuses_what_is_not_a_site_file_or_too_large() {
        let dir = TempDir::new("sites-refused");
        let folder = sites_folder(&dir.0);
        assert!(add(&folder, "../escape.atlas-site.json", "{}").is_err());
        assert!(add(&folder, "x.json", "{}").is_err());
        let large = " ".repeat((MAX_SITE_FILE_BYTES + 1) as usize);
        assert!(add(&folder, "example-wiki.atlas-site.json", &large).is_err());
        let chosen = dir.0.join("chosen.json");
        fs::write(&chosen, &large).unwrap();
        assert!(read_chosen(&chosen).unwrap_err().contains("at most 64 KB"));
        fs::write(&chosen, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_chosen(&chosen).unwrap_err().contains("UTF-8"));
        fs::write(&chosen, "{}").unwrap();
        assert_eq!(read_chosen(&chosen).unwrap(), "{}");
    }

    #[test]
    fn reads_a_saved_page_within_its_size() {
        let dir = TempDir::new("sites-page");
        let page = dir.0.join("page.html");
        fs::write(&page, b"<p>Saved \xff page</p>").unwrap();
        assert_eq!(
            read_saved_page(&page).unwrap(),
            "<p>Saved \u{fffd} page</p>"
        );
        let large = dir.0.join("large.html");
        fs::write(&large, vec![b' '; (MAX_SAVED_PAGE_BYTES + 1) as usize]).unwrap();
        assert!(read_saved_page(&large)
            .unwrap_err()
            .contains("at most 8 MB"));
        assert!(read_saved_page(&dir.0).is_err());
    }

    #[test]
    fn checks_the_switches() {
        let mut bad = SiteSwitches::default();
        bad.on.insert("own/a b".into(), "ab".into());
        assert!(bad.validate().is_err());
        let mut bad = SiteSwitches::default();
        bad.on.insert("own/a".into(), "not hex".into());
        assert!(bad.validate().is_err());
        let dir = TempDir::new("sites-switches");
        let folder = sites_folder(&dir.0);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join(STATE_FILE),
            "{\"format\":\"other\",\"version\":1}",
        )
        .unwrap();
        assert_eq!(read_switches(&folder), SiteSwitches::default());
    }
}
