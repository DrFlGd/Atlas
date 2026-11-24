//! A game's own files on this computer, for an importer that makes 3D maps
//! from them (`ImportContext` of a game files import in the importer
//! contract, `gameFiles` of an importer). Nothing is fetched and nothing is
//! sent anywhere: the person picks the game's folder in the system's folder
//! dialog, and the web app may then list that folder and read byte ranges
//! of its files, and nothing else, until it forgets the folder or the app
//! ends. The importer turns what it read into one raw 3D model per map,
//! which it hands back in parts ([`keep_model_part`]); the model is built
//! with Atlas's one 3D builder as every other model is (`scenebuilds.rs`).
//!
//! The shell never writes, renames or deletes anything in the folder. A
//! path the web app names is relative to the folder picked, written with
//! `/`, with no empty, `.` or `..` part and no drive or root, and is never
//! followed through a link: a link inside the folder is not listed, and a
//! path through one is refused, so nothing outside the folder is read.
//!
//! An importer that can download its game's files instead (a kind of game
//! with `download` in the importer contract) gets a folder of the app's own
//! in place of one picked: `<maps folder>/.importing-game-files/<importer>/<kind>`
//! ([`GameFolders::open_kept`]), opened only once the person has confirmed
//! in the web app that they own the game. In that folder, and only there,
//! the web app may also download a file ([`GameFolders::download`]): one
//! `https` request at a time, made by the app as the app (`Atlas/<version>`,
//! no cookies, no referrer, redirects only on the same site, as
//! `pagefetch.rs` reads pages), at most [`MAX_DOWNLOAD_BYTES`]; any answer
//! but the file is an error and nothing is tried again. The file is kept at
//! the path named, so the importer reads it from there the next time.
//!
//! In a build with downloads only (the app with importers).

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read as _, Seek as _, SeekFrom, Write as _},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, PoisonError,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

/// The most bytes one read hands back.
pub const MAX_READ_BYTES: u64 = 512 << 20;
/// The most entries one listing hands back.
pub const MAX_ENTRIES: usize = 20_000;
/// The most bytes one part of a model may have.
pub const MAX_MODEL_PART_BYTES: usize = 64 << 20;
/// The most bytes one download fetches (the importer contract's
/// `GAME_FILE_MAX_DOWNLOAD`).
pub const MAX_DOWNLOAD_BYTES: u64 = 256 << 20;
/// The hidden folder of the maps folder that keeps the files importers
/// downloaded, a folder for each importer and kind of game.
pub const KEPT_FILES_DIR: &str = ".importing-game-files";
/// How long one download may take, all of it.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// One entry of a folder, as the web app reads it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    /// A folder (else a file).
    pub folder: bool,
    /// A file's size in bytes; 0 for a folder.
    pub size: u64,
}

/// A folder the person picked, as the web app knows it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickedFolder {
    /// The app's name for it, for later calls.
    pub token: String,
    /// The folder's own name (its last part), to show.
    pub name: String,
}

/// The folders picked in this run of the app, by token.
#[derive(Default)]
pub struct GameFolders {
    folders: Mutex<HashMap<String, PathBuf>>,
    /// The tokens of the app's own folders, kept for downloads.
    kept: Mutex<HashSet<String>>,
    /// Held through each download, so there is one at a time.
    downloading: tokio::sync::Mutex<()>,
}

/// Whether `id` is an importer's or a kind's id as the importer contract
/// writes them: lowercase letters, digits, `-` and `_`, from a letter or digit.
fn is_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
}

fn new_token() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_nanos());
    format!("f{:x}-{:x}", nanos, NEXT.fetch_add(1, Ordering::Relaxed))
}

impl GameFolders {
    /// Remembers a folder the person picked, for this run of the app.
    pub fn add(&self, folder: &Path) -> Result<PickedFolder, String> {
        let root = fs::canonicalize(folder)
            .map_err(|_| format!("{} cannot be opened.", folder.display()))?;
        if !root.is_dir() {
            return Err(format!("{} is not a folder.", folder.display()));
        }
        let name = root.file_name().map_or_else(
            || root.to_string_lossy().into_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        let token = new_token();
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(token.clone(), root);
        Ok(PickedFolder { token, name })
    }

    /// Opens the app's own folder for the files an importer downloads for
    /// a kind of game, made when it is not there yet.
    pub fn open_kept(
        &self,
        maps: &Path,
        importer: &str,
        kind: &str,
    ) -> Result<PickedFolder, String> {
        if !is_id(importer) || !is_id(kind) {
            return Err("That is not a kind of game an importer reads.".to_owned());
        }
        let dir = maps.join(KEPT_FILES_DIR).join(importer).join(kind);
        fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not write to the maps folder: {error}"))?;
        let picked = self.add(&dir)?;
        self.kept
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(picked.token.clone());
        Ok(picked)
    }

    /// Forgets a folder.
    pub fn forget(&self, token: &str) {
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(token);
        self.kept
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(token);
    }

    /// Downloads the file at `url` into the app's own folder `token`, at
    /// `path`, and hands its bytes back: one download at a time, and only
    /// into a folder [`open_kept`](Self::open_kept) opened.
    pub async fn download(&self, token: &str, url: &str, path: &str) -> Result<Vec<u8>, String> {
        self.download_at_most(token, url, path, MAX_DOWNLOAD_BYTES)
            .await
    }

    async fn download_at_most(
        &self,
        token: &str,
        url: &str,
        path: &str,
        max: u64,
    ) -> Result<Vec<u8>, String> {
        let kept = self
            .kept
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(token);
        if !kept {
            return Err(
                "This app downloads only into its own folder for a game's files.".to_owned(),
            );
        }
        let root = self.root(token)?;
        if path.is_empty() {
            return Err("No file was named to keep the download in.".to_owned());
        }
        inside(&root, path)?;
        let _turn = self.downloading.lock().await;
        let bytes = fetch_file(url, max).await?;
        let keep_root = root.clone();
        let keep_path = path.to_owned();
        let kept_bytes = bytes.clone();
        tokio::task::spawn_blocking(move || keep_file(&keep_root, &keep_path, &kept_bytes))
            .await
            .map_err(|_| "The downloaded file could not be kept.".to_owned())??;
        Ok(bytes)
    }

    fn root(&self, token: &str) -> Result<PathBuf, String> {
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(token)
            .cloned()
            .ok_or_else(|| "That folder is not open any more; choose it again.".to_owned())
    }

    /// The entries of a folder inside the picked one (`""` for itself),
    /// sorted by name, without links.
    pub fn list(&self, token: &str, path: &str) -> Result<Vec<FolderEntry>, String> {
        let dir = inside(&self.root(token)?, path)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(&dir)
            .map_err(|_| format!("The folder {} cannot be read.", shown(path)))?
            .flatten()
        {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() || !(kind.is_dir() || kind.is_file()) {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let size = if kind.is_file() {
                entry.metadata().map_or(0, |meta| meta.len())
            } else {
                0
            };
            entries.push(FolderEntry {
                name,
                folder: kind.is_dir(),
                size,
            });
            if entries.len() >= MAX_ENTRIES {
                break;
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    /// Up to `length` bytes of a file inside the picked folder, from `start`.
    pub fn read(
        &self,
        token: &str,
        path: &str,
        start: u64,
        length: u64,
    ) -> Result<Vec<u8>, String> {
        if length > MAX_READ_BYTES {
            return Err("That is more than this app reads at once.".to_owned());
        }
        let file_path = inside(&self.root(token)?, path)?;
        let mut file = File::open(&file_path)
            .map_err(|_| format!("The file {} cannot be read.", shown(path)))?;
        let size = file.metadata().map_or(0, |meta| meta.len());
        if !file.metadata().is_ok_and(|meta| meta.is_file()) {
            return Err(format!("{} is not a file.", shown(path)));
        }
        let length = length.min(size.saturating_sub(start));
        let mut bytes = vec![0u8; length as usize];
        file.seek(SeekFrom::Start(start))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|_| format!("The file {} could not be read to its end.", shown(path)))?;
        Ok(bytes)
    }
}

/// The file at `address`, fetched as the app (see `pagefetch::request`):
/// its bytes when the answer is the file (200), else why not; never more
/// than `max` bytes.
async fn fetch_file(address: &str, max: u64) -> Result<Vec<u8>, String> {
    let (_, mut response) = crate::pagefetch::request(address, "*/*", DOWNLOAD_TIMEOUT).await?;
    let status = response.status();
    if status.as_u16() != 200 {
        let reason = status
            .canonical_reason()
            .map_or_else(String::new, |reason| format!(" ({reason})"));
        return Err(format!(
            "The server answered {}{reason}, so the file was not downloaded.",
            status.as_u16()
        ));
    }
    let too_large = || "The file is larger than this app downloads.".to_owned();
    if response.content_length().is_some_and(|length| length > max) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The download was cut off.".to_owned())?
    {
        if (body.len() + chunk.len()) as u64 > max {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Keeps a downloaded file at `path` inside `root`: written beside it
/// first, then put in its place, so a file cut short is never kept.
fn keep_file(root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
    let target = inside(root, path)?;
    let could_not =
        |error: std::io::Error| format!("The downloaded file could not be kept: {error}");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(could_not)?;
    }
    // Made since the check: checked again, so nothing is written through a link.
    let target = inside(root, path)?;
    let mut partial = target.clone().into_os_string();
    partial.push(".part");
    let partial = PathBuf::from(partial);
    let written = fs::write(&partial, bytes).and_then(|()| fs::rename(&partial, &target));
    if let Err(error) = written {
        let _ = fs::remove_file(&partial);
        return Err(could_not(error));
    }
    Ok(())
}

fn shown(path: &str) -> String {
    if path.is_empty() {
        "you chose".to_owned()
    } else {
        path.chars().take(200).collect()
    }
}

/// `path` inside `root`: relative, `/` between parts, no empty, `.` or
/// `..` part, no drive, root, `\` or `:`, and never through a link.
pub fn inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Ok(root.to_path_buf());
    }
    let refused = || "This app reads only inside the folder you chose.".to_owned();
    if path.len() > 1024 || path.contains('\\') || path.contains(':') || path.contains('\0') {
        return Err(refused());
    }
    let mut out = root.to_path_buf();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(refused());
        }
        let mut components = Path::new(part).components();
        if !matches!(
            (components.next(), components.next()),
            (Some(Component::Normal(_)), None)
        ) {
            return Err(refused());
        }
        out.push(part);
        if fs::symlink_metadata(&out).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(refused());
        }
    }
    Ok(out)
}

/// Adds a part of a raw model the importer made (a glTF binary file, sent
/// in parts in order) to the build `build`, or to a new build when none is
/// given; returns the build's name. A model larger than the app keeps is
/// refused.
pub fn keep_model_part(builds: &Path, build: Option<&str>, part: &[u8]) -> Result<String, String> {
    use crate::scenebuilds::{build_dir, is_build_name, MAX_MODEL_BYTES, MODEL_FILE};
    if part.len() > MAX_MODEL_PART_BYTES {
        return Err("That part of the model is larger than this app takes at once.".to_owned());
    }
    let name = match build {
        Some(name) if is_build_name(name) => name.to_owned(),
        Some(_) => return Err("That model is not one this app kept.".to_owned()),
        None => format!("local-{}", new_token().trim_start_matches('f')),
    };
    let dir = build_dir(builds, &name);
    if build.is_some() && !dir.is_dir() {
        return Err("That model is not kept any more.".to_owned());
    }
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not write to the maps folder: {error}"))?;
    let path = dir.join(MODEL_FILE);
    let before = fs::metadata(&path).map_or(0, |meta| meta.len());
    if before + part.len() as u64 > MAX_MODEL_BYTES {
        return Err("The model is larger than this app keeps.".to_owned());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Could not keep the model: {error}"))?;
    file.write_all(part)
        .map_err(|error| format!("Could not keep the model: {error}"))?;
    Ok(name)
}

/// The folders a game is most likely in, to open the dialog at: each
/// Steam library's `steamapps/common` that is there.
pub fn likely_start(home: Option<&Path>, program_files: &[PathBuf]) -> Option<PathBuf> {
    let mut steam: Vec<PathBuf> = program_files.iter().map(|pf| pf.join("Steam")).collect();
    if let Some(home) = home {
        steam.push(home.join(".steam").join("steam"));
        steam.push(home.join(".local").join("share").join("Steam"));
    }
    let mut libraries = Vec::new();
    for root in &steam {
        libraries.push(root.clone());
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        let small = fs::metadata(&vdf).is_ok_and(|meta| meta.len() < 1 << 20);
        if let Some(text) = small.then(|| fs::read_to_string(&vdf).ok()).flatten() {
            libraries.extend(crate::gamefiles::steam_libraries(&text));
        }
    }
    libraries
        .into_iter()
        .map(|library| library.join("steamapps").join("common"))
        .find(|common| common.is_dir())
}

pub mod commands {
    //! The commands of game folders (a build with downloads only).

    use std::{path::PathBuf, sync::Arc};

    use tauri::{ipc::Response, Manager as _, Runtime, State, WebviewWindow};

    use super::{FolderEntry, GameFolders, PickedFolder};
    use crate::commands::{blocking, pick_folder_at};
    use crate::library::Library;

    type Folders<'a> = State<'a, Arc<GameFolders>>;

    fn main_only<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
        if window.label() == crate::MAIN_WINDOW {
            Ok(())
        } else {
            Err("Only the app's own window can read a game's files.".to_owned())
        }
    }

    /// Asks for a game's folder; `None` when the dialog was closed.
    #[tauri::command]
    pub async fn import_folder_pick<R: Runtime>(
        window: WebviewWindow<R>,
        folders: Folders<'_>,
    ) -> Result<Option<PickedFolder>, String> {
        main_only(&window)?;
        let paths = window.path();
        let program_files: Vec<PathBuf> = ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"]
            .iter()
            .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
            .collect();
        let start = super::likely_start(paths.home_dir().ok().as_deref(), &program_files);
        let Some(path) = pick_folder_at(&window, "Choose the game's folder", start).await? else {
            return Ok(None);
        };
        let folders = Arc::clone(&folders);
        blocking(move || folders.add(&path).map(Some)).await
    }

    /// The entries of a folder inside a picked game folder.
    #[tauri::command]
    pub async fn import_folder_list<R: Runtime>(
        window: WebviewWindow<R>,
        folders: Folders<'_>,
        token: String,
        path: String,
    ) -> Result<Vec<FolderEntry>, String> {
        main_only(&window)?;
        let folders = Arc::clone(&folders);
        blocking(move || folders.list(&token, &path)).await
    }

    /// Bytes of a file inside a picked game folder.
    #[tauri::command]
    pub async fn import_folder_read<R: Runtime>(
        window: WebviewWindow<R>,
        folders: Folders<'_>,
        token: String,
        path: String,
        start: u64,
        length: u64,
    ) -> Result<Response, String> {
        main_only(&window)?;
        let folders = Arc::clone(&folders);
        blocking(move || {
            folders
                .read(&token, &path, start, length)
                .map(Response::new)
        })
        .await
    }

    /// Opens the app's own folder for the files `importer` downloads for
    /// its kind of game `kind` (the web app asks only once the person has
    /// confirmed they own the game).
    #[tauri::command]
    pub async fn import_files_open<R: Runtime>(
        window: WebviewWindow<R>,
        folders: Folders<'_>,
        library: State<'_, Arc<Library>>,
        importer: String,
        kind: String,
    ) -> Result<PickedFolder, String> {
        main_only(&window)?;
        let folders = Arc::clone(&folders);
        let maps = library.maps_folder();
        blocking(move || folders.open_kept(&maps, &importer, &kind)).await
    }

    /// Downloads a file into the app's own folder for a game's files, keeps
    /// it at `path` there, and answers its bytes.
    #[tauri::command]
    pub async fn import_files_download<R: Runtime>(
        window: WebviewWindow<R>,
        folders: Folders<'_>,
        token: String,
        url: String,
        path: String,
    ) -> Result<Response, String> {
        main_only(&window)?;
        let folders = Arc::clone(&folders);
        crate::keep::reading();
        folders
            .download(&token, &url, &path)
            .await
            .map(Response::new)
    }

    /// Forgets a picked game folder.
    #[tauri::command]
    pub async fn import_folder_close<R: Runtime>(
        window: WebviewWindow<R>,
        folders: Folders<'_>,
        token: String,
    ) -> Result<(), String> {
        main_only(&window)?;
        folders.forget(&token);
        Ok(())
    }

    /// A part of a raw model an importer made from a game's files: the
    /// request's body is the part's bytes, and its `x-atlas-build` header
    /// names the build to add it to (none for a new one). Answers the
    /// build's name, for `import_build_scene`.
    #[tauri::command]
    pub async fn import_keep_model<R: Runtime>(
        window: WebviewWindow<R>,
        library: State<'_, Arc<Library>>,
        request: tauri::ipc::Request<'_>,
    ) -> Result<String, String> {
        main_only(&window)?;
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
            return Err("The model was not sent as bytes.".to_owned());
        };
        let build = request
            .headers()
            .get("x-atlas-build")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let bytes = bytes.clone();
        let builds = library.maps_folder().join(crate::scenebuilds::BUILDS_DIR);
        crate::keep::reading();
        blocking(move || super::keep_model_part(&builds, build.as_deref(), &bytes)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    #[test]
    fn lists_and_reads_only_inside_the_folder_picked() {
        let dir = TempDir::new("game-folders");
        let game = dir.0.join("Made Up Game");
        fs::create_dir_all(game.join("mod").join("maps")).unwrap();
        fs::write(game.join("mod").join("gameinfo.txt"), b"\"GameInfo\" {}").unwrap();
        fs::write(
            game.join("mod").join("maps").join("one.bsp"),
            b"VBSP0123456789",
        )
        .unwrap();
        fs::write(dir.0.join("outside.txt"), b"not for the app").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.0.join("outside.txt"), game.join("link.txt")).unwrap();

        let folders = GameFolders::default();
        let picked = folders.add(&game).unwrap();
        assert_eq!(picked.name, "Made Up Game");
        let top = folders.list(&picked.token, "").unwrap();
        assert_eq!(
            top,
            vec![FolderEntry {
                name: "mod".into(),
                folder: true,
                size: 0
            }]
        );
        let maps = folders.list(&picked.token, "mod/maps").unwrap();
        assert_eq!(maps[0].name, "one.bsp");
        assert_eq!(maps[0].size, 14);
        assert_eq!(
            folders
                .read(&picked.token, "mod/maps/one.bsp", 4, 4)
                .unwrap(),
            b"0123"
        );
        // A read past the end gives what there is.
        assert_eq!(
            folders
                .read(&picked.token, "mod/maps/one.bsp", 12, 100)
                .unwrap(),
            b"89"
        );
        for bad in [
            "../outside.txt",
            "mod/../../outside.txt",
            "/etc/passwd",
            "mod//maps",
            "./mod",
            "C:/x",
            "mod\\maps",
            "link.txt",
        ] {
            assert!(folders.read(&picked.token, bad, 0, 4).is_err(), "{bad}");
        }
        assert!(folders
            .read(&picked.token, "mod/maps/one.bsp", 0, MAX_READ_BYTES + 1)
            .is_err());
        folders.forget(&picked.token);
        assert!(folders.list(&picked.token, "").is_err());
    }

    #[tokio::test]
    async fn downloads_into_its_own_folder_only_one_file_as_the_app() {
        use crate::tiles::download::tests::{MockServer, Reply};
        use std::sync::Arc;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let server = MockServer::start(Arc::new(|path, _| match path {
            "/Game/01_arc.crg1?cache_bust=3" => Reply {
                body: b"made up archive".to_vec(),
                ..Reply::status(200)
            }
            .header("Set-Cookie", "session=1"),
            "/Game/large.bin" => Reply {
                body: vec![7; 64],
                ..Reply::status(200)
            },
            "/away" => Reply::status(302).header("Location", "https://elsewhere.invalid/x"),
            _ => Reply::status(404),
        }))
        .await;
        let dir = TempDir::new("game-files-kept");
        let folders = GameFolders::default();
        for (importer, kind) in [
            ("", "x"),
            ("gamefiles", "../up"),
            ("Game", "x"),
            ("a", "b/c"),
        ] {
            assert!(
                folders.open_kept(&dir.0, importer, kind).is_err(),
                "{importer} {kind}"
            );
        }
        let kept = folders
            .open_kept(&dir.0, "gamefiles", "made-up-game")
            .unwrap();
        assert_eq!(kept.name, "made-up-game");
        assert!(dir
            .0
            .join(KEPT_FILES_DIR)
            .join("gamefiles")
            .join("made-up-game")
            .is_dir());

        let bytes = folders
            .download(
                &kept.token,
                &server.url("/Game/01_arc.crg1?cache_bust=3"),
                "Game/01_arc.crg1",
            )
            .await
            .unwrap();
        assert_eq!(bytes, b"made up archive");
        assert_eq!(
            folders
                .read(&kept.token, "Game/01_arc.crg1", 0, 100)
                .unwrap(),
            b"made up archive"
        );
        assert_eq!(
            folders.list(&kept.token, "Game").unwrap(),
            vec![FolderEntry {
                name: "01_arc.crg1".into(),
                folder: false,
                size: 15
            }]
        );
        // Asked again, it is downloaded again: the importer reads what is kept first.
        folders
            .download(
                &kept.token,
                &server.url("/Game/01_arc.crg1?cache_bust=3"),
                "Game/01_arc.crg1",
            )
            .await
            .unwrap();

        // Anything but the file is an error, and nothing is kept.
        let missing = folders
            .download(
                &kept.token,
                &server.url("/Game/02_arc.crg1"),
                "Game/02_arc.crg1",
            )
            .await
            .unwrap_err();
        assert!(missing.contains("404 (Not Found)"), "{missing}");
        let away = folders
            .download(&kept.token, &server.url("/away"), "Game/away")
            .await
            .unwrap_err();
        assert!(away.contains("302"), "{away}");
        let large = folders
            .download_at_most(
                &kept.token,
                &server.url("/Game/large.bin"),
                "Game/large.bin",
                10,
            )
            .await
            .unwrap_err();
        assert!(large.contains("larger"), "{large}");
        assert_eq!(folders.list(&kept.token, "Game").unwrap().len(), 1);

        // Never outside the folder, never over plain http elsewhere, never into a folder picked.
        for path in ["", "../x", "Game/../../x", "/x", "C:/x"] {
            assert!(
                folders
                    .download(
                        &kept.token,
                        &server.url("/Game/01_arc.crg1?cache_bust=3"),
                        path
                    )
                    .await
                    .is_err(),
                "{path}"
            );
        }
        assert!(folders
            .download(&kept.token, "http://example.org/x", "x")
            .await
            .is_err());
        let picked = folders.add(&dir.0).unwrap();
        assert!(folders
            .download(
                &picked.token,
                &server.url("/Game/01_arc.crg1?cache_bust=3"),
                "x"
            )
            .await
            .is_err());
        folders.forget(&kept.token);
        assert!(folders
            .download(
                &kept.token,
                &server.url("/Game/01_arc.crg1?cache_bust=3"),
                "x"
            )
            .await
            .is_err());

        // Each request as the app: no cookie carried, no referrer, no browser's headers.
        let seen = server.seen();
        assert_eq!(seen.len(), 5);
        for seen in seen {
            assert_eq!(
                seen.headers["user-agent"],
                crate::tiles::download::USER_AGENT
            );
            for absent in ["cookie", "referer", "origin", "sec-fetch-mode"] {
                assert!(!seen.headers.contains_key(absent), "{absent} was sent");
            }
        }
    }

    #[test]
    fn keeps_a_model_sent_in_parts() {
        let dir = TempDir::new("keep-model");
        let builds = dir.0.join(crate::scenebuilds::BUILDS_DIR);
        let name = keep_model_part(&builds, None, b"glTF one ").unwrap();
        assert!(crate::scenebuilds::is_build_name(&name), "{name}");
        assert_eq!(keep_model_part(&builds, Some(&name), b"two").unwrap(), name);
        let kept = fs::read(
            crate::scenebuilds::build_dir(&builds, &name).join(crate::scenebuilds::MODEL_FILE),
        )
        .unwrap();
        assert_eq!(kept, b"glTF one two");
        assert!(keep_model_part(&builds, Some("../x"), b"x").is_err());
        assert!(keep_model_part(&builds, Some("gone"), b"x").is_err());
    }
}
