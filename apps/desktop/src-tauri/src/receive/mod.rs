//! Receiving pack files: the person, or another app, puts or replaces a
//! pack file (`.atlaspack`) and Atlas shows it without being told to
//! refresh.
//!
//! - **Opening a pack file.** The file manager starts Atlas with a pack
//!   file's path (the installer registers the file type; see
//!   `tauri.windows.conf.json`), or the path is given on the command line.
//!   The path is read as untrusted input (see `args.rs`), and the file is
//!   read where it lies, never copied or imported (see
//!   `Library::open_pack_file`). What came of it waits here
//!   ([`Opened`]) until the web app takes it (`library_take_opened`),
//!   which it does at its start and when told [`PACK_FILE_OPENED`].
//! - **One Atlas at a time.** A second start hands its arguments to the
//!   Atlas running (`tauri-plugin-single-instance`), which comes to the
//!   front and shows the pack file, and the second start ends (see
//!   [`second_start`]).
//! - **Noticing what arrives, changes or goes** in the folders Atlas reads
//!   (see `watch.rs`); a listing that changed is sent to the web app as
//!   [`LIBRARY_CHANGED`].
//!
//! None of this is on Android, which opens no file by type, runs one app
//! by itself and has no folders of pack files to follow: there the queue
//! stays empty.

#[cfg(not(target_os = "android"))]
pub mod args;
#[cfg(not(target_os = "android"))]
mod drives;
#[cfg(test)]
mod tests;
#[cfg(not(target_os = "android"))]
pub mod watch;

use std::sync::{Arc, Mutex, PoisonError};

use tauri::State;

use crate::{
    commands::{blocking, LibraryState},
    library::PackFileOpened,
};

/// The event that brings the web app the Library's listing when it
/// changed by itself (a pack file arrived, changed or went).
pub const LIBRARY_CHANGED: &str = "library-changed";
/// The event that tells the web app that a pack file was opened; it takes
/// what came of it with `library_take_opened`.
pub const PACK_FILE_OPENED: &str = "pack-file-opened";

/// What opening pack files came to, until the web app takes it.
#[derive(Debug, Default)]
pub struct Opened(Mutex<Vec<PackFileOpened>>);

impl Opened {
    pub fn push(&self, opened: PackFileOpened) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(opened);
    }

    pub fn take(&self) -> Vec<PackFileOpened> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// What opening pack files came to since the web app last asked, oldest
/// first.
#[tauri::command]
pub fn library_take_opened(opened: State<'_, Arc<Opened>>) -> Vec<PackFileOpened> {
    opened.take()
}

/// Takes a pack file off the list of single pack files opened. The file is
/// left as it is.
#[tauri::command]
pub async fn library_forget_pack_file(
    library: LibraryState<'_>,
    path: String,
) -> Result<(), String> {
    let library = Arc::clone(&library);
    blocking(move || library.forget_pack_file(&path)).await
}

#[cfg(not(target_os = "android"))]
pub use desktop::{focus_changed, follow, open_at_start, second_start};

#[cfg(not(target_os = "android"))]
mod desktop {
    use std::{
        ffi::OsString,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use tauri::{AppHandle, Emitter, Manager, Runtime};

    use super::{
        args::{self, StartRequest},
        watch::{Receiver, Timing},
        Opened, LIBRARY_CHANGED, PACK_FILE_OPENED,
    };
    use crate::{
        activity::{self, Area},
        library::Library,
        MAIN_WINDOW,
    };

    /// Start-up: the pack file Atlas was started with, if any, read before
    /// the window is made; the web app takes it at its start.
    pub fn open_at_start<R: Runtime>(app: &AppHandle<R>, library: &Library) {
        let cwd = std::env::current_dir().unwrap_or_default();
        open(
            app,
            library,
            args::read(std::env::args_os(), &cwd),
            "started",
        );
    }

    /// A second start handed over its arguments and the folder it was
    /// started from: brings the window to the front and shows the pack
    /// file they name, on a thread of its own (the second start waits for
    /// this to return). Anything else in them is left out.
    pub fn second_start<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: String) {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        let app = app.clone();
        std::thread::spawn(move || {
            let request = args::read(args.into_iter().map(OsString::from), &PathBuf::from(cwd));
            let Some(library) = app.try_state::<Arc<Library>>() else {
                return;
            };
            let library = Arc::clone(&library);
            if open(&app, &library, request, "started again") {
                let _ = app.emit_to(MAIN_WINDOW, PACK_FILE_OPENED, ());
                if let Some(receiver) = app.try_state::<Arc<Receiver>>() {
                    receiver.look();
                }
            }
        });
    }

    /// Writes what was left out to the activity log and opens the pack
    /// file asked for; whether there was one.
    fn open<R: Runtime>(
        app: &AppHandle<R>,
        library: &Library,
        request: StartRequest,
        how: &str,
    ) -> bool {
        for line in &request.left_out {
            activity::info(
                Area::App,
                format!("Left out an argument Atlas was {how} with: {line}"),
            );
        }
        let Some(path) = request.pack_file else {
            return false;
        };
        let opened = library.open_pack_file(Path::new(&path));
        activity::info(
            Area::Library,
            format!("Opened the pack file {}: {}", opened.path, opened.message),
        );
        if let Some(queue) = app.try_state::<Arc<Opened>>() {
            queue.push(opened);
        }
        true
    }

    /// Starts following the folders the Library reads; a listing that
    /// changed goes to the window.
    pub fn follow<R: Runtime>(app: &AppHandle<R>, library: Arc<Library>) {
        let handle = app.clone();
        let receiver = Receiver::start(library, Timing::default(), move |listing| {
            let _ = handle.emit_to(MAIN_WINDOW, LIBRARY_CHANGED, listing);
        });
        app.manage(Arc::new(receiver));
    }

    /// The window got or lost the focus.
    pub fn focus_changed<R: Runtime>(app: &AppHandle<R>, focused: bool) {
        if let Some(receiver) = app.try_state::<Arc<Receiver>>() {
            receiver.focused(focused);
        }
    }
}
