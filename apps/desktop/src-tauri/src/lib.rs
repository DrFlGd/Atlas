//! The Atlas desktop shell: one window that shows the web app, the
//! `atlas-pack` protocol that serves data packs to it, the maps library on
//! disk, an optional window for importing a map from a web page, and the
//! commands the web app uses for files, links and maps.
//!
//! Fetching map images from other servers ("Download map images" in
//! `tiles`, and "View map page and save images as I browse" in `pageview`)
//! is only in a build with the `downloads` feature; without it that code
//! and its commands are not compiled in.
//!
//! The same shell builds the Android app (`tauri android build`, see
//! `tauri.android.conf.json`), a viewer only. On Android there are no folder
//! dialogs, no file manager to show folders in, no import window and no map
//! images from version 0.2.0 to move; the commands for those answer with an
//! error there, and `desktop_info` tells the web app not to offer them. The
//! packs that come with the Android app are part of its web build, not
//! resources (see `bundled_packs`). Its maps folder is one Android never
//! backs up, and map pack files and progress files come from the system's
//! picker as `content://` addresses, read and written through the fs plugin
//! (see `android_storage`, `picked.rs` and the progress file commands).

pub mod activity;
mod commands;
mod downloads;
pub mod gamefiles;
// A person's links between guide pages and the map, beside the game's folder.
pub mod guidelinks;
mod imports;
pub mod library;
pub mod manifest;
pub mod ownlists;
pub mod packfile;
mod packs;
#[cfg(feature = "downloads")]
mod pagefetch;
#[cfg(feature = "downloads")]
mod pagemeasure;
#[cfg(feature = "downloads")]
mod pageview;
pub mod picked;
mod removal;
pub mod saves;
pub mod settings;
pub mod tiles;

use std::{fs, path::PathBuf, sync::Arc};

use tauri::{
    http::{Response, StatusCode},
    webview::NewWindowResponse,
    App, AppHandle, Manager, Url, WebviewWindowBuilder,
};

use activity::{ActivityLog, Area};
use downloads::Downloads;
use library::{BundledPack, Library, LEGACY_IDENTIFIER};
pub use packs::{PackRegistry, SCHEME as PACK_SCHEME};
use settings::{shared_dir, SettingsFile};
#[cfg(feature = "downloads")]
use tiles::DownloadManager;

/// The label of the app's own window, the only one the pack protocol and the
/// app's commands answer.
pub const MAIN_WINDOW: &str = "main";

/// Folder under the app's resource directory that holds bundled packs, one
/// sub-folder per pack. Each is served as `<scheme URL>/<folder name>/`.
const BUNDLED_PACKS_DIR: &str = "packs";

/// The commands of every build; `build.rs` and `capabilities/main.json`
/// list the same.
macro_rules! viewer_commands {
    ($($more:tt)*) => {
        tauri::generate_handler![
            commands::desktop_info,
            commands::open_external,
            commands::save_text_file,
            commands::open_text_file,
            commands::library_list,
            commands::library_open_pack,
            commands::library_add_folder,
            commands::library_remove_location,
            commands::library_choose_maps_folder,
            commands::library_apply_maps_folder,
            commands::library_reveal,
            commands::library_delete_pack,
            commands::library_images_info,
            commands::library_delete_images,
            commands::library_import_sources,
            commands::library_save_import,
            commands::import_open,
            commands::import_poll,
            commands::import_close,
            commands::import_report,
            commands::activity_log_read,
            saves::saves_default_folder,
            saves::saves_choose_folder,
            saves::saves_choose_file,
            saves::saves_list,
            saves::saves_read,
            saves::saves_screenshot,
            saves::saves_watch,
            saves::saves_watch_status,
            saves::saves_unwatch,
            saves::saves_report,
            gamefiles::game_folder_get,
            gamefiles::game_folder_choose,
            gamefiles::game_folder_forget,
            gamefiles::game_files_scan,
            gamefiles::game_files_read,
            gamefiles::game_files_report,
            commands::packfile_options,
            commands::packfile_export,
            commands::packfile_pick,
            commands::packfile_inspect,
            commands::packfile_import,
            commands::packfile_progress,
            commands::packfile_cancel,
            commands::library_pack_details,
            commands::packfile_pick_copy,
            commands::packfile_copy_picked,
            commands::packfile_discard_copy,
            commands::own_lists_read,
            commands::own_lists_write,
            commands::own_lists_delete,
            commands::list_file_save,
            commands::list_file_open,
            guidelinks::guide_links_read,
            guidelinks::guide_links_write,
            $($more)*
        ]
    };
}

/// The commands the web app can call. A build with the `downloads` feature
/// adds those for map image downloads and map pages, which `build.rs` and
/// `capabilities/downloads/` list and grant.
fn invoke_handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync {
    #[cfg(feature = "downloads")]
    return viewer_commands![
        commands::tiles_plan,
        commands::tiles_start,
        commands::tiles_pause,
        commands::tiles_resume,
        commands::tiles_cancel,
        commands::tiles_snapshot,
        commands::picture_tiles,
        commands::picture_cancel,
        commands::import_fetch,
        commands::download_settings_get,
        commands::download_settings_set,
        pageview::view_pages,
        pageview::view_open,
        pageview::view_status,
        pageview::view_stop_saving,
        pageview::view_close,
        pageview::view_open_in_browser,
    ];
    #[cfg(not(feature = "downloads"))]
    viewer_commands![]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Map image downloads use rustls with the ring provider.
    #[cfg(feature = "downloads")]
    let _ = rustls::crypto::ring::default_provider().install_default();
    let registry = PackRegistry::default();
    let protocol_registry = registry.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(registry)
        .manage(imports::Imports::default())
        .manage(commands::PackFileJobs::default())
        .manage(commands::PickedPackFiles::default());
    // On Android, files the system's dialogs give as `content://` addresses
    // are opened through the fs plugin, from Rust only: no capability grants
    // the web app any of its commands.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_fs::init());
    #[cfg(feature = "downloads")]
    let builder = builder.manage(pageview::PageViews::default());
    builder
        .invoke_handler(invoke_handler())
        .register_asynchronous_uri_scheme_protocol(PACK_SCHEME, move |ctx, request, responder| {
            // Only the app's own window reads packs; a web page in the import
            // or map page window gets nothing.
            if ctx.webview_label() != MAIN_WINDOW {
                responder.respond(
                    Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(Vec::new())
                        .expect("valid response"),
                );
                return;
            }
            let registry = protocol_registry.clone();
            // File reads block, so keep them off the webview's thread.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(registry.respond(&request));
            });
        })
        .setup(|app| {
            let paths = app.path();
            let app_data = paths.app_data_dir()?;
            let shared = shared_dir(&paths.local_data_dir()?);
            let info = app.package_info();
            ActivityLog::new(
                activity::log_dir(&shared),
                &info.name,
                &info.version.to_string(),
            )
            .install();
            let registry = app.state::<PackRegistry>().inner().clone();
            // Map images downloaded for bundled packs live here, served before
            // the pack's own files.
            registry.set_overlay_root(tiles::images::overlay_root(&app_data));
            if cfg!(mobile) {
                android_storage(app, &shared);
            }
            let legacy = legacy_dirs(app, &app_data)?;
            let bundled = bundled_packs(app);
            log_start(app, &shared, &bundled);
            let library = Library::new(
                SettingsFile::new(shared.clone()),
                registry.clone(),
                bundled,
                legacy,
            );
            // Imports are seeded with what measuring their picture learnt.
            #[cfg(feature = "downloads")]
            let library = library.with_picture_cache(tiles::measure::PictureCache::new(&app_data));
            let library = Arc::new(library);
            library.start();
            #[cfg(feature = "downloads")]
            let downloads = {
                let manager = DownloadManager::new(app_data, registry).with_shared_folder(&shared);
                manager.set_download_settings(&library.settings().read().downloads);
                let manager = Arc::new(manager);
                app.manage(Arc::clone(&manager));
                Downloads::new(manager)
            };
            #[cfg(not(feature = "downloads"))]
            let downloads = Downloads::new(registry, app_data);
            app.manage(downloads);
            app.manage(Arc::new(saves::for_app(app)));
            app.manage(Arc::new(gamefiles::for_app(app)));
            app.manage(Arc::clone(&library));
            // Map images that version 0.2.0 downloaded move into the pack
            // folders in the background; the map shows them as they arrive.
            // Packs whose files were still in use when they were deleted are
            // removed first; they are hidden already. The Android app has no
            // old folders, so nothing moves there.
            std::thread::spawn(move || {
                for left in library.finish_deletes() {
                    eprintln!(
                        "atlas: {} is still in use; it is removed at the next start",
                        left.display()
                    );
                }
                // Map images an import or update was renumbering when the
                // app stopped are put in order first (see `tiles::renumber`).
                #[cfg(feature = "downloads")]
                library.settle_images_at_start();
                let moved = library.migrate_legacy();
                if !moved.is_empty() {
                    activity::info(
                        Area::Migration,
                        format!(
                            "Moved the map images of {} into the maps folder",
                            moved.join(", ")
                        ),
                    );
                }
            });
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Atlas desktop shell");
}

/// Android start-up: moves map packs from the maps folder of version 0.3.5
/// and earlier, which Auto Backup included, to the one it never backs up
/// (see `settings::default_maps_folder`), and removes copies of picked map
/// pack files left by an import that did not finish (see `picked.rs`).
fn android_storage(app: &App, shared: &std::path::Path) {
    if SettingsFile::new(shared.to_path_buf())
        .read()
        .maps_folder
        .is_none()
    {
        let old = settings::old_android_maps_folder(shared);
        let new = settings::default_maps_folder(shared);
        match settings::move_old_maps(&old, &new) {
            Ok(moved) if moved.is_empty() => {}
            Ok(moved) => activity::info(
                Area::Library,
                format!(
                    "Moved {} from {} to {}, which Android does not back up",
                    moved.join(", "),
                    old.display(),
                    new.display()
                ),
            ),
            Err(error) => activity::warn(
                Area::Library,
                format!(
                    "Could not move the maps in {} to {}: {error}",
                    old.display(),
                    new.display()
                ),
            ),
        }
    }
    if let Ok(copies) = commands::picked_copies_dir(app.handle()) {
        picked::clear(&copies);
    }
}

/// The app data folders of earlier versions, whose downloaded map images
/// move into pack folders: version 0.2.0's (`dev.atlas.desktop`) and this
/// app's own. None on Android, which never had them.
fn legacy_dirs(app: &App, app_data: &std::path::Path) -> tauri::Result<Vec<PathBuf>> {
    if cfg!(mobile) {
        return Ok(Vec::new());
    }
    let mut legacy = vec![app.path().data_dir()?.join(LEGACY_IDENTIFIER)];
    if !legacy.iter().any(|dir| dir == app_data) {
        legacy.push(app_data.to_path_buf());
    }
    Ok(legacy)
}

/// The first lines of a run in the activity log: which app, where its maps
/// are and what it comes with.
fn log_start(app: &App, shared: &std::path::Path, bundled: &[BundledPack]) {
    let info = app.package_info();
    let settings = SettingsFile::new(shared.to_path_buf()).read();
    let maps = settings.maps_folder.clone().unwrap_or_else(|| {
        format!(
            "{} (the default)",
            settings::default_maps_folder(shared).display()
        )
    });
    let packs = if bundled.is_empty() {
        "none".to_owned()
    } else {
        bundled
            .iter()
            .map(|pack| {
                if pack.downloadable {
                    format!("{} (map images downloadable)", pack.id)
                } else {
                    pack.id.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    activity::info(
        Area::App,
        format!(
            "{} {} started on {} ({}) | maps folder: {maps} | {} other locations remembered | packs that come with the app: {packs} | importers: {} | map image downloads: {}",
            info.name,
            info.version,
            std::env::consts::OS,
            std::env::consts::ARCH,
            settings.locations.len(),
            bundled_importers(app),
            if Downloads::in_build() { "in this build" } else { "not in this build" }
        ),
    );
}

/// The importers listed in the bundled frontend's `config.json`.
fn bundled_importers(app: &App) -> String {
    let Some(asset) = app.asset_resolver().get("config.json".to_owned()) else {
        return "unknown (no bundled config.json)".to_owned();
    };
    let ids: Vec<String> = serde_json::from_slice::<serde_json::Value>(&asset.bytes)
        .ok()
        .and_then(|config| config.get("importers").cloned())
        .and_then(|importers| importers.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|importer| importer.get("id")?.as_str().map(activity::clean))
        .collect();
    if ids.is_empty() {
        "none".to_owned()
    } else {
        ids.join(", ")
    }
}

/// The packs shipped in the app's resources, one folder each.
///
/// None on Android: its resources are inside the app package rather than in
/// a folder, so they cannot be listed or served from disk. The packs that
/// come with the Android app are part of its web build instead and are
/// served with the rest of the page (see `scripts/prepare-frontend.js`).
fn bundled_packs(app: &App) -> Vec<BundledPack> {
    if cfg!(mobile) {
        return Vec::new();
    }
    let Ok(dir) = app
        .path()
        .resource_dir()
        .map(|dir| dir.join(BUNDLED_PACKS_DIR))
    else {
        return Vec::new();
    };
    // In `tauri dev` no packs are bundled; the web dev server serves them.
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut packs: Vec<BundledPack> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path: PathBuf| {
            let id = path.file_name()?.to_str()?.to_owned();
            let downloadable =
                tiles::pyramid::read_pack_plan(&path).is_ok_and(|plan| !plan.layers.is_empty());
            Some(BundledPack {
                id,
                path,
                downloadable,
            })
        })
        .collect();
    packs.sort_by(|a, b| a.id.cmp(&b.id));
    packs
}

/// Creates the window declared in `tauri.conf.json` (which has `create:
/// false`), adding a navigation guard that keeps the webview on the app and
/// sends web links to the system browser.
fn create_main_window(app: &App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .expect("tauri.conf.json declares the main window");
    let dev_url = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let navigation_app = app.handle().clone();
    let new_window_app = app.handle().clone();
    WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(move |url| {
            if is_app_url(url, dev_url.as_ref()) {
                return true;
            }
            open_link_outside(&navigation_app, url);
            false
        })
        // Links with `target="_blank"`. The web app sends the links it shows
        // to `open_external` itself; this catches any other new window.
        .on_new_window(move |url, _features| {
            open_link_outside(&new_window_app, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// Opens a web link the page tried to follow in the system browser. Other
/// schemes are ignored.
fn open_link_outside(app: &AppHandle, url: &Url) {
    if let Some(url) = commands::external_url(url.as_str()) {
        if let Err(error) = commands::open_in_browser(app, &url) {
            activity::warn(Area::App, error);
        }
    }
}

/// Whether the webview may navigate to `url`: only the app's own pages.
/// Anything else stays out of the window; web links open in the system
/// browser instead.
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        // The bundled frontend on Linux and macOS.
        "tauri" => url.host_str() == Some("localhost"),
        // The bundled frontend on Windows and Android, or the dev server
        // during `tauri dev`.
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev_url.is_some_and(|dev| dev.origin() == url.origin())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn allows_only_app_navigation() {
        let dev = url("http://localhost:1420/");
        assert!(is_app_url(&url("tauri://localhost/index.html"), None));
        assert!(is_app_url(&url("http://tauri.localhost/#@1,2,3"), None));
        assert!(is_app_url(
            &url("http://localhost:1420/?clustering=off"),
            Some(&dev)
        ));

        assert!(!is_app_url(&url("http://localhost:1420/"), None));
        assert!(!is_app_url(&url("http://localhost:5173/"), Some(&dev)));
        assert!(!is_app_url(&url("https://example.com/"), Some(&dev)));
        assert!(!is_app_url(&url("tauri://elsewhere/"), None));
        assert!(!is_app_url(&url("file:///etc/passwd"), None));
        assert!(!is_app_url(
            &url("atlas-pack://localhost/demo/manifest.json"),
            None
        ));
    }
}
