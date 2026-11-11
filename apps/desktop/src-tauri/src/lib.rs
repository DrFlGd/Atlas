//! The Atlas desktop shell: one window that shows the web app, the
//! `atlas-pack` protocol that serves data packs to it, the maps library on
//! disk, an optional window for importing a map from a web page, and the
//! commands the web app uses for files, links, maps and map image downloads.

pub mod activity;
mod commands;
mod imports;
pub mod library;
pub mod manifest;
mod packs;
mod removal;
pub mod settings;
pub mod tiles;

use std::{fs, path::PathBuf, sync::Arc};

use tauri::{
    http::{Response, StatusCode},
    webview::NewWindowResponse,
    App, AppHandle, Manager, Url, WebviewWindowBuilder,
};

use activity::{ActivityLog, Area};
use library::{BundledPack, Library, LEGACY_IDENTIFIER};
pub use packs::{PackRegistry, SCHEME as PACK_SCHEME};
use settings::{shared_dir, SettingsFile};
use tiles::DownloadManager;

/// The label of the app's own window, the only one the pack protocol and the
/// app's commands answer.
pub const MAIN_WINDOW: &str = "main";

/// Folder under the app's resource directory that holds bundled packs, one
/// sub-folder per pack. Each is served as `<scheme URL>/<folder name>/`.
const BUNDLED_PACKS_DIR: &str = "packs";

pub fn run() {
    // Map image downloads use rustls with the ring provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let registry = PackRegistry::default();
    let protocol_registry = registry.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(registry)
        .manage(imports::Imports::default())
        .invoke_handler(tauri::generate_handler![
            commands::desktop_info,
            commands::open_external,
            commands::save_text_file,
            commands::open_text_file,
            commands::tiles_plan,
            commands::tiles_start,
            commands::tiles_pause,
            commands::tiles_resume,
            commands::tiles_cancel,
            commands::tiles_snapshot,
            commands::download_settings_get,
            commands::download_settings_set,
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
        ])
        .register_asynchronous_uri_scheme_protocol(PACK_SCHEME, move |ctx, request, responder| {
            // Only the app's own window reads packs; a web page in the import
            // window gets nothing.
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
            registry.set_overlay_root(DownloadManager::overlay_root(&app_data));
            let mut legacy = vec![paths.data_dir()?.join(LEGACY_IDENTIFIER)];
            if !legacy.contains(&app_data) {
                legacy.push(app_data.clone());
            }
            let bundled = bundled_packs(app);
            log_start(app, &shared, &bundled);
            let library = Arc::new(Library::new(
                SettingsFile::new(shared.clone()),
                registry.clone(),
                bundled,
                legacy,
            ));
            library.start();
            let manager = DownloadManager::new(app_data, registry).with_shared_folder(&shared);
            manager.set_download_settings(&library.settings().read().downloads);
            app.manage(Arc::new(manager));
            app.manage(Arc::clone(&library));
            // Map images that version 0.2.0 downloaded move into the pack
            // folders in the background; the map shows them as they arrive.
            // Packs whose files were still in use when they were deleted are
            // removed first; they are hidden already.
            std::thread::spawn(move || {
                for left in library.finish_deletes() {
                    eprintln!(
                        "atlas: {} is still in use; it is removed at the next start",
                        left.display()
                    );
                }
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
            "{} {} started on {} ({}) | maps folder: {maps} | {} other locations remembered | packs that come with the app: {packs} | importers: {}",
            info.name,
            info.version,
            std::env::consts::OS,
            std::env::consts::ARCH,
            settings.locations.len(),
            bundled_importers(app)
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
fn bundled_packs(app: &App) -> Vec<BundledPack> {
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
        // The bundled frontend on Windows, or the dev server during `tauri dev`.
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
