//! The Atlas desktop shell: one window that shows the web app, plus the
//! `atlas-pack` protocol that serves data packs to it.

mod packs;

use std::fs;

use tauri::{App, Manager, Url, WebviewWindowBuilder};

pub use packs::{PackRegistry, SCHEME as PACK_SCHEME};

/// Folder under the app's resource directory that holds bundled packs, one
/// sub-folder per pack. Each is served as `<scheme URL>/<folder name>/`.
const BUNDLED_PACKS_DIR: &str = "packs";

pub fn run() {
    let registry = PackRegistry::default();
    let protocol_registry = registry.clone();

    tauri::Builder::default()
        .manage(registry)
        .register_asynchronous_uri_scheme_protocol(PACK_SCHEME, move |_ctx, request, responder| {
            let registry = protocol_registry.clone();
            // File reads block, so keep them off the webview's thread.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(registry.respond(&request));
            });
        })
        .setup(|app| {
            register_bundled_packs(app);
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
/// false`), adding a navigation guard that keeps the webview on the app.
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
    WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(move |url| is_app_url(url, dev_url.as_ref()))
        .build()?;
    Ok(())
}

/// Whether the webview may navigate to `url`: only the app's own pages.
/// Links to other sites are blocked rather than opened in the window; opening
/// them in the system browser needs the opener plugin, which is not used yet.
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
