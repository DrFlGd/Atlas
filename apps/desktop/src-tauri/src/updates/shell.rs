//! The updater plugin's side of `updates` (see the module): looking,
//! downloading and installing, where Atlas updates itself.

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

use super::{UpdateCheck, UpdateProgress, NOT_HERE};
use crate::activity::{self, Area};

/// How long connecting to the server may take, and the longest wait for
/// the next part of an answer. A download as a whole has no limit.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// The longest wait for the window's place to be kept before the installer
/// ends Atlas (Windows).
#[cfg(windows)]
const BEFORE_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// The updater plugin, with its settings from `tauri.conf.json`.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

/// The update found last, and how downloading it goes.
#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Update>>,
    progress: Mutex<UpdateProgress>,
    /// The downloaded and checked update, with its version.
    ready: Mutex<Option<(String, Vec<u8>)>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn updates<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<Updates>, String> {
    match (
        app.try_state::<super::Way>().map(|way| way.0),
        app.try_state::<Arc<Updates>>(),
    ) {
        (Some(super::UpdateWay::Itself { .. }), Some(updates)) => Ok(Arc::clone(&updates)),
        _ => Err(NOT_HERE.to_owned()),
    }
}

/// The updater: Atlas's own name and version as its User-Agent, and on
/// Windows the window's place kept before the installer ends Atlas.
fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<tauri_plugin_updater::Updater, String> {
    let agent = format!("Atlas/{}", app.package_info().version);
    let builder = app.updater_builder().configure_client(move |client| {
        client
            .user_agent(agent.clone())
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
    });
    #[cfg(windows)]
    let builder = {
        let app = app.clone();
        builder.on_before_exit(move || {
            activity::info(Area::App, "Atlas ends so that the installer can update it");
            // On the main thread, as the window and the tray want, and
            // waited for, since the installer ends Atlas right after.
            let (done, wait) = std::sync::mpsc::channel();
            let main = app.clone();
            let asked = app.run_on_main_thread(move || {
                crate::background::shell::before_update(&main);
                let _ = done.send(());
            });
            if asked.is_ok() {
                let _ = wait.recv_timeout(BEFORE_EXIT_TIMEOUT);
            }
        })
    };
    builder.build().map_err(|error| problem(&error))
}

/// What went wrong, in a sentence for Settings.
fn problem(error: &Error) -> String {
    match error {
        Error::Reqwest(_) | Error::Network(_) => {
            "Atlas could not reach the update server. Check that this computer is online, then try again.".to_owned()
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "The newest version has no update for this system yet.".to_owned()
        }
        Error::ReleaseNotFound => "Atlas could not find the newest version.".to_owned(),
        Error::Minisign(_)
        | Error::SignatureUtf8(_)
        | Error::Base64(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => {
            "The update did not pass its check, so Atlas left it out.".to_owned()
        }
        Error::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            "Atlas cannot change its own file in the folder it is in. Move Atlas to a folder of your own, such as Applications in your home folder, and try again.".to_owned()
        }
        other => format!("The update did not work: {other}"),
    }
}

/// Looks for an update, and keeps what it found for `download`.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<UpdateCheck, String> {
    let updates = updates(app)?;
    let current = app.package_info().version.to_string();
    let found = updater(app)?.check().await.map_err(|error| {
        activity::warn(Area::App, format!("Could not look for an update: {error}"));
        problem(&error)
    })?;
    let answer = match &found {
        Some(update) => {
            activity::info(
                Area::App,
                format!("Atlas {} is available (this is {current})", update.version),
            );
            UpdateCheck::Available {
                version: update.version.clone(),
                current,
                notes: update.body.clone().unwrap_or_default(),
                date: update
                    .raw_json
                    .get("pub_date")
                    .and_then(|date| date.as_str())
                    .map(str::to_owned),
            }
        }
        None => UpdateCheck::UpToDate { version: current },
    };
    let mut kept = lock(&updates.found);
    // A download of another version is no longer wanted.
    if kept.as_ref().map(|update| &update.version) != found.as_ref().map(|update| &update.version) {
        lock(&updates.ready).take();
        *lock(&updates.progress) = UpdateProgress::Idle;
    }
    *kept = found;
    Ok(answer)
}

/// Downloads the update found last and checks its signature.
pub async fn download<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updates = updates(app)?;
    let update = lock(&updates.found)
        .clone()
        .ok_or_else(|| "Look for an update first.".to_owned())?;
    {
        let mut progress = lock(&updates.progress);
        match &*progress {
            UpdateProgress::Downloading { .. } => {
                return Err("The update is being downloaded already.".to_owned())
            }
            UpdateProgress::Ready { version } if *version == update.version => return Ok(()),
            _ => {}
        }
        *progress = UpdateProgress::Downloading {
            received: 0,
            total: None,
        };
    }
    activity::info(Area::App, format!("Downloading Atlas {}", update.version));
    let result = update
        .download(
            |chunk, total| {
                if let UpdateProgress::Downloading {
                    received,
                    total: all,
                } = &mut *lock(&updates.progress)
                {
                    *received += chunk as u64;
                    *all = total;
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            *lock(&updates.ready) = Some((update.version.clone(), bytes));
            *lock(&updates.progress) = UpdateProgress::Ready {
                version: update.version.clone(),
            };
            Ok(())
        }
        Err(error) => {
            activity::warn(
                Area::App,
                format!("Could not download Atlas {}: {error}", update.version),
            );
            let message = problem(&error);
            *lock(&updates.progress) = UpdateProgress::Failed {
                message: message.clone(),
            };
            Err(message)
        }
    }
}

pub fn progress<R: Runtime>(app: &AppHandle<R>) -> UpdateProgress {
    updates(app)
        .map(|updates| lock(&updates.progress).clone())
        .unwrap_or_default()
}

/// Installs the downloaded update, then starts Atlas again (on Windows the
/// installer does, after it ended Atlas).
pub async fn install<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let updates = updates(&app)?;
    let update = lock(&updates.found).clone();
    let (version, bytes) = lock(&updates.ready)
        .take()
        .ok_or_else(|| "Download the update first.".to_owned())?;
    let Some(update) = update.filter(|update| update.version == version) else {
        return Err("Download the update first.".to_owned());
    };
    activity::info(Area::App, format!("Installing Atlas {version}"));
    // Writing the new AppImage, or starting the installer, waits on the disk.
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(&bytes))
        .await
        .map_err(|error| format!("The update did not work: {error}"))?;
    if let Err(error) = installed {
        activity::warn(
            Area::App,
            format!("Could not install Atlas {version}: {error}"),
        );
        *lock(&updates.progress) = UpdateProgress::Failed {
            message: problem(&error),
        };
        return Err(problem(&error));
    }
    // Linux: the AppImage holds the new version; start it.
    activity::info(Area::App, format!("Installed Atlas {version}; starting it"));
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQwN0EzRUJBQjNCNDNDQzEKUldUQlBMU3p1ajU2ME9zVTlKaHhwWXNJVUFweCtQRXVYeHB0czc5V3BFOE51a1ZxNGxoSks1dTQK";

    /// The plugin reads its settings from `tauri.conf.json` when Atlas
    /// starts; settings it cannot read would stop the start.
    #[test]
    fn reads_its_settings_from_the_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        let read: tauri_plugin_updater::Config =
            serde_json::from_value(updater.clone()).expect("the updater's settings");
        assert_eq!(
            read.endpoints
                .iter()
                .map(|url| url.as_str())
                .collect::<Vec<_>>(),
            ["https://github.com/DrFlGd/Atlas/releases/latest/download/latest.json"]
        );
        assert!(!read.dangerous_insecure_transport_protocol);
        assert!(!read.dangerous_accept_invalid_certs);
        // The project's update key (minisign key id D07A3EBAB3B43CC1), in
        // base64 as Tauri writes it.
        assert_eq!(read.pubkey, PUBLIC_KEY);
        assert_eq!(updater["windows"]["installMode"], "passive");
    }

    #[test]
    fn says_what_went_wrong_in_a_sentence() {
        assert!(problem(&Error::Network("down".into())).starts_with("Atlas could not reach"));
        assert!(
            problem(&Error::TargetsNotFound(vec!["linux-x86_64".into()]))
                .contains("no update for this system")
        );
        assert!(problem(&Error::MissingSignedVersion).contains("did not pass its check"));
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(problem(&Error::Io(denied)).contains("Move Atlas to a folder of your own"));
    }
}
