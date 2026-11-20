//! Guidebooks: published guides a person has as one file, a PDF or a CBZ
//! (a ZIP of page pictures), in a pack file of their own, one per game
//! (version 8 of the pack file format, see the `atlas-pack` crate). The
//! web app reads them where they lie, as every pack file, through the
//! pack protocol, and lists them with the guides of their game (see
//! `apps/web/src/state/guidebooks.ts`).
//!
//! **Add a guidebook…** (desktop only) is for a person with no other app
//! that sends guidebooks with their text: the person picks a PDF or
//! CBZ file ([`guidebook_pick`]), which the pack protocol then serves at an
//! address of its own (`_picked/<token>/<name>`, see `packs.rs`) so the
//! web app reads its pages and the text of a PDF with pdf.js; the web app
//! then hands over the title and that text ([`guidebook_add`]). The
//! guidebook goes into the game's guidebook pack in the packs folder, made
//! with the crate's [`atlas_pack::write_guidebook_pack`]: the pack id is
//! `guidebooks-<game id>` (`-2`, `-3`… after it when another app's pack has
//! that id), and adding a second guidebook writes that small pack again
//! with both. The game's own pack is never touched.
//!
//! **Remove this guidebook…** ([`guidebook_remove`]) writes the pack again
//! without it, or deletes the pack file when it was the last one.
//!
//! Atlas changes only the guidebook packs it wrote itself: their manifest's
//! `writtenBy.name` is [`WRITTEN_BY`]. A pack another app
//! wrote is never changed, as no other pack file is.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use atlas_pack::{
    guidebook_pages, rewrite_guidebook_pack, write_guidebook_pack, AppInfo, GuidebookPack,
    GuidebookType, NewGuidebook, MAX_GUIDEBOOK_BYTES, MAX_GUIDEBOOK_PAGES,
    MAX_GUIDEBOOK_TEXT_BYTES,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, WebviewWindow};

use crate::{
    activity::{self, Area},
    commands::{blocking, chosen_path, desktop_only, file_dialog, LibraryState},
    library::{Library, Listing},
    packfile::names::{free_path, stem_from},
    packs::{is_valid_pack_id, PackKind},
};

/// The name Atlas writes as the `writtenBy` of the guidebook packs it
/// makes, whatever the app's own name: the packs it may change.
pub const WRITTEN_BY: &str = "Atlas";
/// The start of the id of a game's guidebook pack.
pub const PACK_PREFIX: &str = "guidebooks-";

/// A file picked to add as a guidebook, for the web app: where the pack
/// protocol serves it while it is picked, and what is known of it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickedGuidebook {
    /// What [`guidebook_add`] is told, so it adds the file picked.
    pub token: String,
    /// The address the web app reads it at.
    pub url: String,
    /// The file's own name.
    pub file_name: String,
    /// The title offered: the file's name without its extension.
    pub title: String,
    #[serde(rename = "type")]
    pub file_type: GuidebookType,
    pub bytes: u64,
    /// Its pages, when they can be counted here: a CBZ's pictures, or a
    /// PDF's page tree. The web app counts a PDF's pages itself too.
    pub pages: Option<u32>,
}

/// The picked file, and its address.
#[derive(Clone, Debug)]
struct Picked {
    path: PathBuf,
    info: PickedGuidebook,
}

/// What [`guidebook_add`] is asked: the game, and the guidebook's title,
/// pages and text by page.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGuidebook {
    /// The game it is for: its pack id, and the title it is shown under.
    pub game_id: String,
    pub game_title: String,
    /// The picked file, as [`PickedGuidebook::token`] names it.
    pub token: String,
    pub title: String,
    /// Its pages, as the web app counted them; none to count them here.
    pub pages: Option<u32>,
    /// The text of each page of a PDF, as its text layer has it; none
    /// when it has no text.
    pub text: Option<Vec<String>>,
}

/// A guidebook added or removed: what to say, and the maps listed after.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidebooksChanged {
    /// The id of the game's guidebook pack.
    pub pack_id: String,
    pub message: String,
    pub listing: Listing,
}

/// The id of the guidebook pack of the game `game_id` that Atlas writes
/// to: the one it wrote already, else the first of `guidebooks-<game id>`,
/// `guidebooks-<game id>-2`… that no pack has. A game id too long for the
/// prefix is cut, with a short checksum of it after, so the id stays
/// stable. A game that is a guidebook pack Atlas wrote is its own.
pub fn pack_id_for(game_id: &str, taken: &dyn Fn(&str) -> Option<bool>) -> String {
    if game_id.starts_with(PACK_PREFIX) && taken(game_id) == Some(true) {
        return game_id.to_owned();
    }
    let base = {
        let whole = format!("{PACK_PREFIX}{game_id}");
        if whole.len() <= 58 {
            whole
        } else {
            let sum = game_id.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
                (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
            });
            let cut: String = whole.chars().take(49).collect();
            format!("{}-{sum:08x}", cut.trim_end_matches(['-', '_']))
        }
    };
    let mut candidate = base.clone();
    for n in 2..=100 {
        match taken(&candidate) {
            // Atlas wrote it: added to.
            Some(true) | None => return candidate,
            Some(false) => candidate = format!("{base}-{n}"),
        }
    }
    candidate
}

/// The app that writes a guidebook pack: always named [`WRITTEN_BY`].
fn writer(app: &AppInfo) -> AppInfo {
    AppInfo {
        name: WRITTEN_BY.to_owned(),
        version: app.version.clone(),
        platform: app.platform.clone(),
    }
}

/// Whether the pack file at `path` is a guidebook pack Atlas wrote.
fn written_here(path: &Path) -> Result<bool, String> {
    let header =
        atlas_pack::read_header(path).map_err(|refusal| crate::packfile::refusal_text(&refusal))?;
    let by = header
        .pack
        .written_by
        .as_ref()
        .and_then(|by| by.get("name"))
        .and_then(serde_json::Value::as_str);
    Ok(!header.guidebooks.is_empty() && by == Some(WRITTEN_BY))
}

/// Whether a listed pack id is taken, for [`pack_id_for`]: none when no
/// pack has it, `Some(true)` for a guidebook pack Atlas wrote, which is
/// added to, and `Some(false)` for any other.
fn taken_in(library: &Library) -> impl Fn(&str) -> Option<bool> + '_ {
    move |id: &str| match library.registry().kind(id) {
        None => None,
        Some(PackKind::File) => Some(
            library
                .pack_file(id)
                .is_some_and(|path| written_here(&path).unwrap_or(false)),
        ),
        Some(_) => Some(false),
    }
}

/// Checks a picked file: a PDF or CBZ by its name, not empty and not too
/// large, starting as its type does; and counts its pages when it can.
pub fn inspect(path: &Path) -> Result<(GuidebookType, u64, Option<u32>), String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let file_type = GuidebookType::of_file_name(&name).ok_or_else(|| {
        format!("{name} is not a PDF or CBZ file. Only PDF and CBZ files can be guidebooks.")
    })?;
    let metadata = fs::metadata(path).map_err(|error| format!("Could not read {name}: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(format!("{name} is empty."));
    }
    if metadata.len() > MAX_GUIDEBOOK_BYTES {
        return Err(format!(
            "{name} is larger than 16 GB, the most a guidebook can be."
        ));
    }
    let pages = match guidebook_pages(path) {
        Ok(pages) => Some(pages),
        // The web app counts a PDF's pages as it reads it.
        Err(_) if file_type == GuidebookType::Pdf && starts_as_pdf(path) => None,
        Err(error) => return Err(error.to_string()),
    };
    Ok((file_type, metadata.len(), pages))
}

fn starts_as_pdf(path: &Path) -> bool {
    use std::io::Read;
    let mut start = Vec::with_capacity(1024);
    fs::File::open(path)
        .and_then(|file| file.take(1024).read_to_end(&mut start))
        .is_ok()
        && start.windows(5).any(|window| window == b"%PDF-")
}

/// The title offered for a picked file: its name without its extension,
/// with `_` as space.
pub fn title_of_file(name: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let title = stem.replace('_', " ");
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    title
        .chars()
        .take(atlas_pack::MAX_GUIDEBOOK_TITLE)
        .collect()
}

/// Adds a guidebook to the guidebook pack of a game in the packs folder,
/// writing it new or again (see the module). Returns the pack's id and
/// what to say.
pub fn add(
    library: &Library,
    request: &AddGuidebook,
    file: &Path,
    app: &AppInfo,
) -> Result<(String, String), String> {
    if !is_valid_pack_id(&request.game_id) {
        return Err("This game cannot be found.".to_owned());
    }
    if request.text.as_ref().is_some_and(|pages| {
        pages.iter().map(String::len).sum::<usize>() as u64 > MAX_GUIDEBOOK_TEXT_BYTES
    }) {
        return Err(
            "The text of this guidebook is larger than 64 MB, the most a guidebook's text can be."
                .to_owned(),
        );
    }
    if request
        .pages
        .is_some_and(|pages| pages == 0 || pages > MAX_GUIDEBOOK_PAGES)
    {
        return Err("This guidebook has no pages that can be read.".to_owned());
    }
    let pack_id = pack_id_for(&request.game_id, &taken_in(library));
    let pack = GuidebookPack {
        pack_id: pack_id.clone(),
        game_title: request.game_title.clone(),
        written_by: writer(app),
        guidebooks: vec![NewGuidebook {
            file: file.to_owned(),
            title: request.title.clone(),
            pages: request.pages,
            text: request.text.clone(),
        }],
    };
    let title = request.title.trim();
    let existing = library
        .pack_file(&pack_id)
        .filter(|path| written_here(path).unwrap_or(false));
    match existing {
        Some(path) => {
            rewrite_guidebook_pack(&path, &|_| true, &pack, &path).map_err(String::from)?;
            Ok((
                pack_id,
                format!(
                    "{title} was added to the guidebooks of {}.",
                    pack.game_title.trim()
                ),
            ))
        }
        None => {
            let folder = library.ensure_packs_folder()?;
            let name = format!("{} guidebooks", pack.game_title.trim());
            let stem = stem_from(Some(&name), &name, None, &pack_id);
            let target = free_path(&folder, &stem).ok_or_else(|| {
                "There is no free name for the guidebooks' pack file in the packs folder."
                    .to_owned()
            })?;
            write_guidebook_pack(&pack, &target).map_err(String::from)?;
            Ok((
                pack_id,
                format!(
                    "{title} was added to the guidebooks of {}. Its pack file is in the packs folder.",
                    pack.game_title.trim()
                ),
            ))
        }
    }
}

/// Removes the guidebook `file` from the guidebook pack `pack_id`, which
/// Atlas must have written: the pack is written again without it, or
/// deleted when it was its last guidebook.
pub fn remove(
    library: &Library,
    pack_id: &str,
    file: &str,
    app: &AppInfo,
) -> Result<String, String> {
    let path = library
        .pack_file(pack_id)
        .ok_or_else(|| "These guidebooks cannot be found any more.".to_owned())?;
    let header = atlas_pack::read_header(&path)
        .map_err(|refusal| crate::packfile::refusal_text(&refusal))?;
    if !written_here(&path)? {
        return Err(
            "These guidebooks came from another app, and Atlas never changes them.".to_owned(),
        );
    }
    let Some(gone) = header.guidebooks.iter().find(|facts| facts.file == file) else {
        return Err("This guidebook cannot be found any more.".to_owned());
    };
    let title = gone.title.clone();
    if header.guidebooks.len() == 1 {
        fs::remove_file(&path)
            .map_err(|error| format!("Could not remove the guidebook: {error}"))?;
    } else {
        let pack = GuidebookPack {
            pack_id: pack_id.to_owned(),
            game_title: header
                .game
                .as_ref()
                .map_or_else(|| header.title.clone(), |game| game.title.clone()),
            written_by: writer(app),
            guidebooks: Vec::new(),
        };
        rewrite_guidebook_pack(&path, &|facts| facts.file != file, &pack, &path)
            .map_err(String::from)?;
    }
    Ok(format!("{} was removed.", title.trim()))
}

// ---------------------------------------------------------------------------
// Commands

/// The file picked for "Add a guidebook…", until it is added or forgotten.
#[derive(Default)]
pub struct PickedGuidebooks(std::sync::Mutex<Option<Picked>>);

impl PickedGuidebooks {
    fn take_path(&self, token: &str) -> Option<PathBuf> {
        let held = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        held.as_ref()
            .filter(|picked| picked.info.token == token)
            .map(|picked| picked.path.clone())
    }

    fn set(&self, picked: Option<Picked>) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = picked;
    }
}

type PickedState<'a> = tauri::State<'a, PickedGuidebooks>;

/// A token no one guesses from the one before.
fn new_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let mut hash = 0xcbf2_9ce4_8422_2325_u64 ^ u64::from(std::process::id());
    for byte in nanos.to_le_bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// "Add a guidebook…": asks for a PDF or CBZ file, checks it, and serves it
/// to the web app until it is added or forgotten. `None` when the person
/// closes the dialog. Desktop only.
#[tauri::command]
pub async fn guidebook_pick<R: Runtime>(
    window: WebviewWindow<R>,
    library: LibraryState<'_>,
    picked: PickedState<'_>,
) -> Result<Option<PickedGuidebook>, String> {
    desktop_only()?;
    let dialog = file_dialog(&window, "Add a guidebook")
        .add_filter("Guidebook (PDF or CBZ)", &["pdf", "PDF", "cbz", "CBZ"]);
    let Some(path) = chosen_path(|done| dialog.pick_file(done)).await? else {
        return Ok(None);
    };
    let checked = {
        let path = path.clone();
        blocking(move || inspect(&path)).await?
    };
    let (file_type, bytes, pages) = checked;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let token = new_token();
    let url = library.registry().set_picked(
        &token,
        &format!("guidebook.{}", file_type.extension()),
        path.clone(),
    );
    let info = PickedGuidebook {
        token,
        url,
        title: title_of_file(&file_name),
        file_name,
        file_type,
        bytes,
        pages,
    };
    picked.set(Some(Picked {
        path,
        info: info.clone(),
    }));
    Ok(Some(info))
}

/// Forgets the picked file: it is no longer served.
#[tauri::command]
pub fn guidebook_forget_picked(library: LibraryState<'_>, picked: PickedState<'_>) {
    picked.set(None);
    library.registry().forget_picked();
}

/// Adds the picked file to the game's guidebook pack (see [`add`]), then
/// forgets it. Desktop only.
#[tauri::command]
pub async fn guidebook_add<R: Runtime>(
    app: AppHandle<R>,
    library: LibraryState<'_>,
    picked: PickedState<'_>,
    request: AddGuidebook,
) -> Result<GuidebooksChanged, String> {
    desktop_only()?;
    let file = picked
        .take_path(&request.token)
        .ok_or_else(|| "Pick the guidebook's file again.".to_owned())?;
    let app_info = crate::commands::app_info(&app);
    let library = Arc::clone(&library);
    let result = blocking({
        let library = Arc::clone(&library);
        move || {
            add(&library, &request, &file, &app_info).inspect_err(|problem| {
                activity::warn(
                    Area::Library,
                    format!("Could not add the guidebook {}: {problem}", file.display()),
                );
            })
        }
    })
    .await;
    if result.is_ok() {
        picked.set(None);
        library.registry().forget_picked();
    }
    let (pack_id, message) = result?;
    let listing = blocking(move || Ok(library.scan())).await?;
    Ok(GuidebooksChanged {
        pack_id,
        message,
        listing,
    })
}

/// "Remove this guidebook…": takes a guidebook out of a guidebook pack
/// Atlas wrote (see [`remove`]). Desktop only.
#[tauri::command]
pub async fn guidebook_remove<R: Runtime>(
    app: AppHandle<R>,
    library: LibraryState<'_>,
    pack_id: String,
    file: String,
) -> Result<GuidebooksChanged, String> {
    desktop_only()?;
    let app_info = crate::commands::app_info(&app);
    let library = Arc::clone(&library);
    blocking(move || {
        let message = remove(&library, &pack_id, &file, &app_info)?;
        Ok(GuidebooksChanged {
            pack_id,
            message,
            listing: library.scan(),
        })
    })
    .await
}

#[cfg(all(test, not(target_os = "android")))]
mod tests;
