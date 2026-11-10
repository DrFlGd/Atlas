//! The Atlas desktop shell: one window that shows the web app, the
//! `atlas-pack` protocol that serves data packs to it, and the commands the
//! web app uses for files, links and map image downloads.

mod commands;
mod packs;
pub mod tiles;

use std::{fs, sync::Arc};

use tauri::{webview::NewWindowResponse, App, AppHandle, Manager, Url, WebviewWindowBuilder};

pub use packs::{PackRegistry, SCHEME as PACK_SCHEME};
use tiles::DownloadManager;

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
        ])
        .register_asynchronous_uri_scheme_protocol(PACK_SCHEME, move |_ctx, request, responder| {
            let registry = protocol_registry.clone();
            // File reads block, so keep them off the webview's thread.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(registry.respond(&request));
            });
        })
        .setup(|app| {
            register_bundled_packs(app);
            let app_data = app.path().app_data_dir()?;
            let registry = app.state::<PackRegistry>().inner().clone();
            // Downloaded map images live here, served before the pack's own files.
            registry.set_overlay_root(DownloadManager::overlay_root(&app_data));
            app.manage(Arc::new(DownloadManager::new(app_data, registry)));
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Atlas desktop shell");
}

/// Registers every pack folder shipped in the app's resources.
fn register_bundled_packs(app: &App) {
    let registry = app.state::<PackRegistry>();
    let Ok(dir) = app
        .path()
        .resource_dir()
        .map(|dir| dir.join(BUNDLED_PACKS_DIR))
    else {
        return;
    };
    // In `tauri dev` no packs are bundled; the web dev server serves them.
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Err(error) = registry.register(id, &path) {
            eprintln!("atlas: skipping bundled pack {}: {error}", path.display());
        }
    }
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
        .find(|window| window.label == "main")
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
        // Links with `target="_blank"`, such as those in guides.
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
            eprintln!("atlas: {error}");
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
