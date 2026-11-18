//! The style sheets of a game read from a wiki's pages, kept once per game
//! as plain text in the game's folder, under `import/styles/`: an index
//! (`index.json`) and one file per text, named by the app from a hash of
//! the text (`<32 hex digits>.css`), never by the site. See `styles.ts` in
//! `@atlas/importer-api` for how the web app gets them.
//!
//! In a build with downloads the web app reads them back
//! (`library_style_texts`, `texts`) to lay the game's saved pages out as a
//! browser shows them, in a closed frame of its own that runs nothing and
//! fetches nothing, every address in a sheet made empty first (see
//! `src/layoutFrame/` in the web app). Otherwise they are data only: never
//! served (the pack protocol never serves `import/`), never loaded as a
//! style sheet of the app, never put in a pack file (only the pack's own
//! files are), and they go with the game's folder when the game is
//! deleted. Building a game again from its saved pages and deleting its map
//! images leave them alone.
//!
//! The same sheet is kept once: a sheet with an address replaces the text
//! kept for that address when its text changed, and a text kept already is
//! not written again, whatever its address. One sheet is at most
//! [`MAX_SHEET_BYTES`], all of a game's at most [`MAX_STYLES_BYTES`] and
//! [`MAX_SHEETS`] entries; a sheet left out for its size, or one that could
//! not be kept for another reason the web app gives, is noted in the index
//! (`leftOut`, the latest note per address).

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use tauri::Url;

use crate::{manifest::write_atomic, packs::IMPORT_DIR};

/// The folder of the style sheets, inside the game's `import/`.
pub const STYLES_DIR: &str = "styles";
const STYLES_INDEX: &str = "index.json";
const STYLES_FORMAT: &str = "atlas-styles";
/// One sheet's text at most (`MAX_STYLE_SHEET_BYTES` in the contract).
pub const MAX_SHEET_BYTES: usize = 4 << 20;
/// All of a game's sheets at most (`MAX_SITE_STYLES_BYTES` in the contract).
pub const MAX_STYLES_BYTES: usize = 16 << 20;
/// Sheets one game keeps at most.
pub const MAX_SHEETS: usize = 500;
/// Notes of sheets left out that the index keeps at most, the latest.
const MAX_LEFT_OUT: usize = 200;
const MAX_MARK_CHARS: usize = 200;
const MAX_ADDRESS_CHARS: usize = 2048;
/// The index is read only up to this size.
const MAX_INDEX_BYTES: u64 = 4 << 20;

/// One write at a time, so two never mix their indexes.
static WRITING: Mutex<()> = Mutex::new(());

/// How a sheet was got.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Way {
    /// Fetched by the app itself, with the rules of pages it fetches.
    Fetch,
    /// Handed over by a page read in the app's window.
    Window,
    /// Handed over by a page the person opened as they browsed.
    Browse,
}

impl Way {
    fn text(self) -> &'static str {
        match self {
            Way::Fetch => "fetched by this app",
            Way::Window => "from pages read in a window",
            Way::Browse => "from pages read as the person browsed",
        }
    }
}

/// Why a sheet is not kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// It is larger than [`MAX_SHEET_BYTES`].
    TooLarge,
    /// Keeping it would make the game's sheets larger than
    /// [`MAX_STYLES_BYTES`], or more than [`MAX_SHEETS`].
    NoRoom,
    /// It is from another address, which the page could not hand over, and
    /// this app does not fetch it (the way the pages are read, or the build).
    OtherAddress,
    /// It is on a host this app does not fetch sheets from: neither the
    /// wiki's own nor one its importer names.
    OtherHost,
    /// The site's robots.txt does not allow this app to read it.
    Robots,
    /// The site's rules file keeps this app off its address, which it
    /// never opens on its own.
    KeptOff,
    /// The site refused, asked to slow down, or answered with something
    /// that is not a style sheet (a page asking to confirm the reader is a
    /// person, say): no more sheets were asked for.
    Refused,
    /// The site could not be reached, or the sheet was not there.
    Failed,
    /// Not asked for: the session stopped, or another started.
    NotAsked,
}

impl Reason {
    fn text(self) -> &'static str {
        match self {
            Reason::TooLarge => "larger than 4 MB",
            Reason::NoRoom => "no room left in the 16 MB the wiki keeps",
            Reason::OtherAddress => "from another address, which the page could not hand over",
            Reason::OtherHost => {
                "on another host than the wiki's own or the ones its importer names"
            }
            Reason::Robots => "not allowed by the site's robots.txt",
            Reason::KeptOff => {
                "not opened, as the site's rules file keeps this app off its address"
            }
            Reason::Refused => "the site refused or did not answer with a style sheet",
            Reason::Failed => "the site could not be reached or did not have it",
            Reason::NotAsked => "not asked for, as the session stopped",
        }
    }
}

/// One sheet kept, as the index lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptSheet {
    /// Its address; none for a `<style>` block of a page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// The file holding its text, in `import/styles/`.
    pub file: String,
    pub bytes: u64,
    pub kept_at: String,
    pub way: Way,
    /// The page's mark of its text (see `PageStyleSheet.mark` in the contract).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<String>,
}

/// A sheet that was not kept, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftOut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub reason: Reason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub at: String,
    pub way: Way,
}

/// `import/styles/index.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StylesIndex {
    pub format: String,
    pub version: u32,
    pub sheets: Vec<KeptSheet>,
    #[serde(default)]
    pub left_out: Vec<LeftOut>,
}

impl Default for StylesIndex {
    fn default() -> Self {
        Self {
            format: STYLES_FORMAT.to_owned(),
            version: 1,
            sheets: Vec::new(),
            left_out: Vec::new(),
        }
    }
}

impl StylesIndex {
    /// The bytes of the distinct files the index lists.
    fn total_bytes(&self) -> u64 {
        let mut files: Vec<(&str, u64)> = self
            .sheets
            .iter()
            .map(|sheet| (sheet.file.as_str(), sheet.bytes))
            .collect();
        files.sort_unstable();
        files.dedup_by(|a, b| a.0 == b.0);
        files.iter().map(|(_, bytes)| bytes).sum()
    }

    /// The distinct files the index lists.
    fn files(&self) -> usize {
        let mut files: Vec<&str> = self
            .sheets
            .iter()
            .map(|sheet| sheet.file.as_str())
            .collect();
        files.sort_unstable();
        files.dedup();
        files.len()
    }
}

/// Sheets the web app hands over to be kept, and sheets it could not get.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepStyles {
    pub way: Way,
    #[serde(default)]
    pub sheets: Vec<GivenSheet>,
    #[serde(default)]
    pub left_out: Vec<GivenLeftOut>,
}

/// A sheet's text, with its address (none for a block of a page) and the page's mark.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GivenSheet {
    pub address: Option<String>,
    pub text: String,
    pub mark: Option<String>,
}

/// A sheet the web app could not get, and why.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GivenLeftOut {
    pub address: Option<String>,
    pub reason: Reason,
    pub bytes: Option<u64>,
}

/// What the web app needs to know of the sheets kept for a game: so that a
/// page does not hand over a sheet kept already, and the app does not fetch
/// one again.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StylesList {
    pub sheets: Vec<ListedSheet>,
    /// Distinct files, and their bytes.
    pub files: u64,
    pub bytes: u64,
    /// Sheets noted as not kept.
    pub left_out: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedSheet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mark: Option<String>,
    pub bytes: u64,
}

/// The facts the Library shows about a game's sheets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StylesFacts {
    pub sheets: u64,
    pub bytes: u64,
    pub left_out: u64,
}

/// A sheet kept for a game with its text, for laying its pages out.
#[cfg(feature = "downloads")]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetText {
    /// Its address; none for a `<style>` block of a page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub text: String,
}

/// What one keep did, for the log.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Kept {
    /// Sheets written new, and their bytes.
    pub added: usize,
    pub added_bytes: u64,
    /// Sheets whose address was kept with another text, replaced.
    pub replaced: usize,
    /// Sheets whose text was kept already.
    pub same: usize,
    /// Sheets not kept, by reason.
    pub left_out: Vec<(Reason, usize)>,
    /// The game's sheets after it: distinct files, and their bytes.
    pub files: u64,
    pub bytes: u64,
}

impl Kept {
    fn note(&mut self, reason: Reason) {
        match self.left_out.iter_mut().find(|(r, _)| *r == reason) {
            Some((_, count)) => *count += 1,
            None => self.left_out.push((reason, 1)),
        }
    }

    /// Whether anything is worth a line in the log: a sheet written, or one not kept.
    pub fn worth_noting(&self) -> bool {
        self.added > 0 || self.replaced > 0 || !self.left_out.is_empty()
    }

    /// The one line the log gets.
    pub fn line(&self, pack_id: &str, way: Way) -> String {
        let mut parts = Vec::new();
        if self.added > 0 {
            parts.push(format!(
                "kept {} ({})",
                sheets(self.added as u64),
                bytes_text(self.added_bytes)
            ));
        }
        if self.replaced > 0 {
            parts.push(format!(
                "replaced {} whose text changed",
                sheets(self.replaced as u64)
            ));
        }
        if self.same > 0 {
            parts.push(format!("{} kept already", sheets(self.same as u64)));
        }
        let mut line = format!(
            "Style sheets of {pack_id} {}: {}",
            way.text(),
            if parts.is_empty() {
                "none kept".to_owned()
            } else {
                parts.join(", ")
            }
        );
        if !self.left_out.is_empty() {
            let reasons: Vec<String> = self
                .left_out
                .iter()
                .map(|(reason, count)| format!("{count} {}", reason.text()))
                .collect();
            line.push_str(&format!("; not kept: {}", reasons.join("; ")));
        }
        line.push_str(&format!(
            ". The wiki has {} kept now, {} in all.",
            sheets(self.files),
            bytes_text(self.bytes)
        ));
        line
    }
}

fn sheets(n: u64) -> String {
    format!("{n} style {}", if n == 1 { "sheet" } else { "sheets" })
}

/// Bytes in words for the log.
fn bytes_text(bytes: u64) -> String {
    if bytes >= 1 << 20 {
        format!("{:.1} MB", bytes as f64 / f64::from(1u32 << 20))
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    }
}

/// The file name of a text: 128 bits of FNV-1a, in hex, with `.css`. Only
/// a name: a text is the same as a kept one only when the bytes are.
pub fn file_name(text: &str) -> String {
    const OFFSET: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;
    let mut hash = OFFSET;
    for byte in text.as_bytes() {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:032x}.css")
}

/// Whether `name` is a file name this app gives a sheet.
fn is_file_name(name: &str) -> bool {
    name.len() == 36
        && name.ends_with(".css")
        && name[..32]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Whether a sheet may have this address: `https`, or `http` on this computer (tests).
fn is_address(text: &str) -> bool {
    if text.len() > MAX_ADDRESS_CHARS {
        return false;
    }
    let Ok(url) = Url::parse(text) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some_and(|host| !host.is_empty()),
        "http" => matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        _ => false,
    }
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

fn styles_dir(pack_dir: &Path) -> PathBuf {
    pack_dir.join(IMPORT_DIR).join(STYLES_DIR)
}

/// The index of a game's sheets, if it has one that can be read.
pub fn read_index(pack_dir: &Path) -> Option<StylesIndex> {
    let dir = styles_dir(pack_dir);
    if !is_real_dir(&dir) {
        return None;
    }
    let path = dir.join(STYLES_INDEX);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_INDEX_BYTES {
        return None;
    }
    let index: StylesIndex = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    (index.format == STYLES_FORMAT).then_some(index)
}

/// What the web app needs to know of a game's sheets; nothing for a game without any.
pub fn list(pack_dir: &Path) -> StylesList {
    let Some(index) = read_index(pack_dir) else {
        return StylesList::default();
    };
    StylesList {
        sheets: index
            .sheets
            .iter()
            .map(|sheet| ListedSheet {
                address: sheet.address.clone(),
                mark: sheet.mark.clone(),
                bytes: sheet.bytes,
            })
            .collect(),
        files: index.files() as u64,
        bytes: index.total_bytes(),
        left_out: index.left_out.len() as u64,
    }
}

/// The facts the Library shows; none for a game without sheets.
pub fn facts(pack_dir: &Path) -> Option<StylesFacts> {
    let index = read_index(pack_dir)?;
    (!index.sheets.is_empty()).then(|| StylesFacts {
        sheets: index.files() as u64,
        bytes: index.total_bytes(),
        left_out: index.left_out.len() as u64,
    })
}

/// The text of a sheet's file, if it is a plain file within [`MAX_SHEET_BYTES`] and is text.
#[cfg(feature = "downloads")]
fn sheet_text(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_SHEET_BYTES as u64 {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// The sheets kept for a game with their texts, in the order the index
/// lists them, for the web app to lay the game's saved pages out with:
/// only files named as this app names them, each read once, at most
/// [`MAX_SHEET_BYTES`] each and [`MAX_STYLES_BYTES`] in all; a file that
/// cannot be read is left out. None for a game without sheets.
#[cfg(feature = "downloads")]
pub fn texts(pack_dir: &Path) -> Vec<SheetText> {
    let Some(index) = read_index(pack_dir) else {
        return Vec::new();
    };
    let dir = styles_dir(pack_dir);
    let mut read: Vec<(String, Option<String>)> = Vec::new();
    let mut total: u64 = 0;
    let mut out = Vec::new();
    for sheet in &index.sheets {
        if !is_file_name(&sheet.file) {
            continue;
        }
        let at = match read.iter().position(|(file, _)| *file == sheet.file) {
            Some(at) => at,
            None => {
                let text = sheet_text(&dir.join(&sheet.file)).filter(|text| {
                    total += text.len() as u64;
                    total <= MAX_STYLES_BYTES as u64
                });
                read.push((sheet.file.clone(), text));
                read.len() - 1
            }
        };
        if let Some(text) = &read[at].1 {
            out.push(SheetText {
                address: sheet.address.clone(),
                text: text.clone(),
            });
        }
    }
    out
}

/// Whether `file` in `dir` holds exactly `text`.
fn holds(dir: &Path, file: &str, text: &str) -> bool {
    let path = dir.join(file);
    fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() == text.len() as u64)
        && fs::read(&path).is_ok_and(|bytes| bytes == text.as_bytes())
}

/// Keeps the sheets of `request` with the game in `pack_dir`, and notes
/// those it could not get or keep. The game's page data must be there
/// (`import/`): nothing is made outside it.
pub fn keep(pack_dir: &Path, request: &KeepStyles, now: &str) -> Result<Kept, String> {
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    let import = pack_dir.join(IMPORT_DIR);
    if !is_real_dir(&import) {
        return Err("The game has no saved pages, so its style sheets are not kept.".to_owned());
    }
    let dir = styles_dir(pack_dir);
    match fs::create_dir(&dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && is_real_dir(&dir) => {}
        Err(error) => return Err(format!("Could not write to {}: {error}", dir.display())),
    }
    let mut index = read_index(pack_dir).unwrap_or_default();
    let before = index.clone();
    let mut kept = Kept::default();
    let way = request.way;
    let note = |index: &mut StylesIndex,
                kept: &mut Kept,
                address: Option<&String>,
                reason: Reason,
                bytes: Option<u64>| {
        kept.note(reason);
        // The latest note per address; a sheet kept under it needs none.
        if address.is_some() && index.sheets.iter().any(|s| s.address.as_ref() == address) {
            return;
        }
        index
            .left_out
            .retain(|left| left.address.is_none() || left.address.as_ref() != address);
        index.left_out.push(LeftOut {
            address: address.cloned(),
            reason,
            bytes,
            at: now.to_owned(),
            way,
        });
    };

    for sheet in &request.sheets {
        if sheet
            .address
            .as_deref()
            .is_some_and(|text| !is_address(text))
            || sheet
                .mark
                .as_ref()
                .is_some_and(|mark| mark.is_empty() || mark.chars().count() > MAX_MARK_CHARS)
        {
            continue;
        }
        let bytes = sheet.text.len() as u64;
        if sheet.text.len() > MAX_SHEET_BYTES {
            note(
                &mut index,
                &mut kept,
                sheet.address.as_ref(),
                Reason::TooLarge,
                Some(bytes),
            );
            continue;
        }
        let file = file_name(&sheet.text);
        let at_address = sheet.address.as_ref().and_then(|address| {
            index
                .sheets
                .iter()
                .position(|s| s.address.as_ref() == Some(address))
        });
        let file_kept =
            index.sheets.iter().any(|s| s.file == file) && holds(&dir, &file, &sheet.text);
        // The same text under the same address, or a block kept already.
        let same = match at_address {
            Some(at) => index.sheets[at].file == file && file_kept,
            None => sheet.address.is_none() && file_kept,
        };
        if same {
            kept.same += 1;
            if let Some(at) = at_address {
                if index.sheets[at].mark.is_none() {
                    index.sheets[at].mark.clone_from(&sheet.mark);
                }
            }
            continue;
        }
        // The room it takes: its file, unless kept already, less the file it replaces.
        let replaced = at_address.map(|at| index.sheets[at].clone());
        let mut after = index.clone();
        if let Some(at) = at_address {
            after.sheets.remove(at);
        }
        after.sheets.push(KeptSheet {
            address: sheet.address.clone(),
            file: file.clone(),
            bytes,
            kept_at: now.to_owned(),
            way,
            mark: sheet.mark.clone(),
        });
        if after.total_bytes() > MAX_STYLES_BYTES as u64 || after.sheets.len() > MAX_SHEETS {
            note(
                &mut index,
                &mut kept,
                sheet.address.as_ref(),
                Reason::NoRoom,
                Some(bytes),
            );
            continue;
        }
        if !file_kept {
            let path = dir.join(&file);
            if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
                continue;
            }
            write_atomic(&path, sheet.text.as_bytes())
                .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        }
        index = after;
        if let Some(address) = &sheet.address {
            index
                .left_out
                .retain(|left| left.address.as_ref() != Some(address));
        }
        match replaced {
            Some(old) => {
                kept.replaced += 1;
                if old.file != file
                    && !index.sheets.iter().any(|s| s.file == old.file)
                    && is_file_name(&old.file)
                {
                    let _ = fs::remove_file(dir.join(&old.file));
                }
            }
            None => {
                kept.added += 1;
                if !file_kept {
                    kept.added_bytes += bytes;
                }
            }
        }
    }
    for left in &request.left_out {
        if left
            .address
            .as_deref()
            .is_some_and(|text| !is_address(text))
        {
            continue;
        }
        note(
            &mut index,
            &mut kept,
            left.address.as_ref(),
            left.reason,
            left.bytes,
        );
    }
    let overflow = index.left_out.len().saturating_sub(MAX_LEFT_OUT);
    index.left_out.drain(..overflow);

    if index != before {
        let path = dir.join(STYLES_INDEX);
        let text = serde_json::to_string_pretty(&index).map_err(|error| error.to_string())?;
        write_atomic(&path, text.as_bytes())
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    }
    kept.files = index.files() as u64;
    kept.bytes = index.total_bytes();
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    const NOW: &str = "2026-11-14T09:00:00Z";
    const LATER: &str = "2026-11-14T10:00:00Z";
    const SHEET: &str = "https://wiki.example.org/load.css?only=styles";

    fn game(name: &str) -> TempDir {
        let dir = TempDir::new(name);
        fs::create_dir_all(dir.0.join(IMPORT_DIR)).unwrap();
        dir
    }

    fn sheet(address: Option<&str>, text: &str) -> GivenSheet {
        GivenSheet {
            address: address.map(str::to_owned),
            text: text.to_owned(),
            mark: Some(format!("{}-mark", text.len())),
        }
    }

    fn request(way: Way, sheets: Vec<GivenSheet>) -> KeepStyles {
        KeepStyles {
            way,
            sheets,
            left_out: Vec::new(),
        }
    }

    fn css_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(styles_dir(dir))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".css"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn takes_a_sheet_kept_off_by_the_site_rules_file_as_a_reason() {
        let reason: Reason = serde_json::from_str("\"kept-off\"").unwrap();
        assert_eq!(reason, Reason::KeptOff);
        assert_eq!(serde_json::to_string(&reason).unwrap(), "\"kept-off\"");
        assert!(reason.text().contains("rules file"));
    }

    #[test]
    fn keeps_each_sheet_once_by_address_and_by_text() {
        let dir = game("styles-once");
        let first = request(
            Way::Window,
            vec![
                sheet(Some(SHEET), ".box { float: right; }"),
                sheet(None, ".cols { column-count: 2; }"),
            ],
        );
        let kept = keep(&dir.0, &first, NOW).unwrap();
        assert_eq!((kept.added, kept.same, kept.files), (2, 0, 2));
        let written = css_files(&dir.0);
        assert_eq!(written.len(), 2);
        assert!(written.iter().all(|name| is_file_name(name)));
        assert_eq!(
            fs::read_to_string(styles_dir(&dir.0).join(file_name(".box { float: right; }")))
                .unwrap(),
            ".box { float: right; }"
        );

        // The same again, from another page: nothing is written.
        let again = keep(&dir.0, &first, LATER).unwrap();
        assert_eq!((again.added, again.replaced, again.same), (0, 0, 2));
        assert!(!again.worth_noting());
        let index = read_index(&dir.0).unwrap();
        assert!(index.sheets.iter().all(|s| s.kept_at == NOW));

        // The same text under another address: listed, but stored once.
        let elsewhere = request(
            Way::Fetch,
            vec![sheet(
                Some("https://wiki.example.org/other.css"),
                ".box { float: right; }",
            )],
        );
        let kept = keep(&dir.0, &elsewhere, LATER).unwrap();
        assert_eq!((kept.added, kept.added_bytes), (1, 0));
        assert_eq!(css_files(&dir.0).len(), 2);
        let listed = list(&dir.0);
        assert_eq!(listed.sheets.len(), 3);
        assert_eq!(listed.files, 2);
        assert_eq!(
            listed.bytes,
            (".box { float: right; }".len() + ".cols { column-count: 2; }".len()) as u64
        );
        assert_eq!(
            facts(&dir.0),
            Some(StylesFacts {
                sheets: 2,
                bytes: listed.bytes,
                left_out: 0
            })
        );
        assert_eq!(
            listed.sheets[0].mark.as_deref(),
            Some(format!("{}-mark", ".box { float: right; }".len()).as_str())
        );
    }

    #[test]
    fn replaces_the_text_of_an_address_when_it_changes() {
        let dir = game("styles-refresh");
        keep(
            &dir.0,
            &request(Way::Window, vec![sheet(Some(SHEET), ".a { color: red; }")]),
            NOW,
        )
        .unwrap();
        let old = file_name(".a { color: red; }");
        let kept = keep(
            &dir.0,
            &request(Way::Window, vec![sheet(Some(SHEET), ".a { color: blue; }")]),
            LATER,
        )
        .unwrap();
        assert_eq!((kept.added, kept.replaced), (0, 1));
        assert!(kept.worth_noting());
        // The old text is gone: one sheet for the address.
        assert_eq!(css_files(&dir.0), vec![file_name(".a { color: blue; }")]);
        assert!(!styles_dir(&dir.0).join(old).exists());
        let index = read_index(&dir.0).unwrap();
        assert_eq!(index.sheets.len(), 1);
        assert_eq!(index.sheets[0].kept_at, LATER);
    }

    #[test]
    fn never_grows_past_its_limits_and_says_what_was_left_out() {
        let dir = game("styles-caps");
        let big = "a".repeat(MAX_SHEET_BYTES + 1);
        let kept = keep(
            &dir.0,
            &request(Way::Fetch, vec![sheet(Some(SHEET), &big)]),
            NOW,
        )
        .unwrap();
        assert_eq!(kept.added, 0);
        assert_eq!(kept.left_out, vec![(Reason::TooLarge, 1)]);
        let index = read_index(&dir.0).unwrap();
        assert!(index.sheets.is_empty());
        assert_eq!(index.left_out[0].reason, Reason::TooLarge);
        assert_eq!(index.left_out[0].bytes, Some(big.len() as u64));
        assert!(css_files(&dir.0).is_empty());

        // Four sheets of 4 MB fill the 16 MB; a fifth has no room.
        let filled: Vec<GivenSheet> = (0..5)
            .map(|n| {
                let mut text = format!("/* {n} */");
                text.push_str(&"b".repeat(MAX_SHEET_BYTES - text.len()));
                sheet(Some(&format!("https://wiki.example.org/{n}.css")), &text)
            })
            .collect();
        let kept = keep(&dir.0, &request(Way::Fetch, filled), LATER).unwrap();
        assert_eq!(kept.added, 4);
        assert_eq!(kept.left_out, vec![(Reason::NoRoom, 1)]);
        assert_eq!(kept.bytes, MAX_STYLES_BYTES as u64);
        assert_eq!(css_files(&dir.0).len(), 4);
        let index = read_index(&dir.0).unwrap();
        assert!(index
            .left_out
            .iter()
            .any(|left| left.reason == Reason::NoRoom
                && left.address.as_deref() == Some("https://wiki.example.org/4.css")));
        let line = kept.line("example-wiki", Way::Fetch);
        assert!(line.contains("kept 4 style sheets (16.0 MB)"), "{line}");
        assert!(line.contains("1 no room left in the 16 MB"), "{line}");
    }

    #[test]
    fn notes_sheets_it_could_not_get_and_forgets_the_note_once_kept() {
        let dir = game("styles-left-out");
        let other = "https://files.example.net/skin.css";
        let mut asked = request(Way::Window, vec![]);
        asked.left_out.push(GivenLeftOut {
            address: Some(other.to_owned()),
            reason: Reason::OtherAddress,
            bytes: None,
        });
        let kept = keep(&dir.0, &asked, NOW).unwrap();
        assert_eq!(kept.left_out, vec![(Reason::OtherAddress, 1)]);
        assert!(kept
            .line("example-wiki", Way::Window)
            .contains("not kept: 1 from another address"));
        // The same address again: one note, the latest.
        keep(&dir.0, &asked, LATER).unwrap();
        let index = read_index(&dir.0).unwrap();
        assert_eq!(index.left_out.len(), 1);
        assert_eq!(index.left_out[0].at, LATER);
        // Kept later (fetched from a host the importer names): the note goes.
        keep(
            &dir.0,
            &request(Way::Fetch, vec![sheet(Some(other), ".skin {}")]),
            LATER,
        )
        .unwrap();
        assert!(read_index(&dir.0).unwrap().left_out.is_empty());
        assert_eq!(facts(&dir.0).unwrap().left_out, 0);
    }

    #[test]
    fn takes_only_usable_addresses_and_never_writes_outside_the_saved_pages() {
        let dir = game("styles-refuse");
        let kept = keep(
            &dir.0,
            &request(
                Way::Fetch,
                vec![
                    sheet(Some("javascript:alert(1)"), ".x {}"),
                    sheet(Some("http://wiki.example.org/plain.css"), ".y {}"),
                    sheet(Some("https://user:pw@wiki.example.org/a.css"), ".z {}"),
                    sheet(Some("../../escape.css"), ".w {}"),
                ],
            ),
            NOW,
        )
        .unwrap();
        assert_eq!((kept.added, kept.same), (0, 0));
        assert!(css_files(&dir.0).is_empty());

        // A folder with no saved pages: nothing is made.
        let empty = TempDir::new("styles-no-pages");
        assert!(keep(
            &empty.0,
            &request(Way::Window, vec![sheet(None, ".x {}")]),
            NOW
        )
        .is_err());
        assert!(!empty.0.join(IMPORT_DIR).exists());
        assert!(facts(&empty.0).is_none());
        assert_eq!(list(&empty.0), StylesList::default());
    }

    #[cfg(feature = "downloads")]
    #[test]
    fn gives_the_texts_back_in_order_each_file_read_once() {
        let dir = game("styles-texts");
        assert!(texts(&dir.0).is_empty());
        keep(
            &dir.0,
            &request(
                Way::Fetch,
                vec![
                    sheet(Some(SHEET), ".cards { display: flex; }"),
                    sheet(None, ".cols { column-count: 3; }"),
                    sheet(
                        Some("https://wiki.example.org/same.css"),
                        ".cards { display: flex; }",
                    ),
                ],
            ),
            NOW,
        )
        .unwrap();
        let given = texts(&dir.0);
        assert_eq!(
            given,
            vec![
                SheetText {
                    address: Some(SHEET.to_owned()),
                    text: ".cards { display: flex; }".to_owned()
                },
                SheetText {
                    address: None,
                    text: ".cols { column-count: 3; }".to_owned()
                },
                SheetText {
                    address: Some("https://wiki.example.org/same.css".to_owned()),
                    text: ".cards { display: flex; }".to_owned()
                },
            ]
        );
        // A file gone, or one not named as this app names them, is left out.
        fs::remove_file(styles_dir(&dir.0).join(file_name(".cols { column-count: 3; }"))).unwrap();
        let mut index = read_index(&dir.0).unwrap();
        index.sheets[0].file = "../index.json".to_owned();
        fs::write(
            styles_dir(&dir.0).join(STYLES_INDEX),
            serde_json::to_string(&index).unwrap(),
        )
        .unwrap();
        let given = texts(&dir.0);
        assert_eq!(given.len(), 1);
        assert_eq!(
            given[0].address.as_deref(),
            Some("https://wiki.example.org/same.css")
        );
    }

    #[test]
    fn names_files_by_their_text_only() {
        assert_eq!(file_name(".a {}"), file_name(".a {}"));
        assert_ne!(file_name(".a {}"), file_name(".a { }"));
        assert!(is_file_name(&file_name("")));
        assert!(!is_file_name("../index.json"));
        assert!(!is_file_name("0123456789abcdef0123456789ABCDEF.css"));
    }
}
