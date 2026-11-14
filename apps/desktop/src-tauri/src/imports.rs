//! The import window: a web page opened so that an importer can read the
//! data the page holds (see `@atlas/importer-api`).
//!
//! The window is a normal, visible webview with the platform's own user
//! agent, in a private session (no cookies or storage shared with the app or
//! kept after it closes). The page gets nothing from the app:
//!
//! - no app commands: the capability that grants them names the main window
//!   only, and Tauri refuses every command from a window or remote origin no
//!   capability names;
//! - no packs: the pack protocol answers the main window only;
//! - no navigation off the site of the URL the person entered, no new
//!   windows and no downloads.
//!
//! Data goes the other way only. The shell evaluates the importer's page
//! reader in the page (`eval_with_callback`), which returns a JSON string,
//! and pulls that string out in slices. Nothing the page does can send data
//! to the app; it can only shape what the reader finds. The result is
//! capped, must be JSON, and is validated by the importer and the pack
//! schema before use.
//!
//! The shell never clicks, types or retries anything in the page. If the
//! page shows a check or a sign-in, the person can deal with it in the
//! window, or close it.
//!
//! In a build with downloads, the person can also have the map's picture
//! measured from the page (see `pagemeasure.rs`): the window is then opened
//! as large as the screen allows, with a watching script added before the
//! page's own scripts, and once the page data has been read, the importer's
//! page measuring step runs a bounded number of times before the data and
//! what the page loaded are handed over.
//!
//! For a go of pages that an importer has opened in a window (a wiki whose
//! site asks its readers to confirm they are a person), the web app can
//! open the window *kept*: once a page has been read, `navigate` moves the
//! same window to the next page of the go on the same site, instead of
//! closing it and opening a new one in front of whatever the person is
//! doing. Only the first page opens the window in front; moving it does not
//! focus it or bring it to the front, and the person may put it aside or
//! minimize it. The window is the same private, visible window on the same
//! site as before, and closing it still stops the go. In a kept window the
//! reader runs only once the page asked for has finished loading, in a
//! load that started after the window was told to go there, and the data
//! is handed over only when the document's address is that page or one the
//! site led to from it, never the page shown before (see [`Visit`]). When a
//! loaded page gives no data for a while (a check that only the person may
//! answer), the window asks for the person's attention without taking the
//! focus and without being un-minimized. Map pages, and pages whose map
//! picture is measured, are never kept.
//!
//! "Browse and keep" opens the window *browsing*: the person browses the
//! site in it themselves, and the app keeps each page they open. The shell
//! never moves such a window (`navigate` refuses), notices each page the
//! person goes to from the window's own page loads, and runs the reader
//! once a page has finished loading, once per page: a page read is not read
//! again until the person goes to another page (a reload is the same
//! page). The data counts only when it comes from the page the window shows
//! now. It never asks for attention; the window stays on its site as every
//! import window does.
//!
//! There is no import window on Android, where a second window would
//! replace the app's screen and a private session is not available.

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    UserAttentionType, WebviewUrl, WebviewWindowBuilder,
};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindow};
use tokio::sync::oneshot;

use crate::library::MAX_PAGE_DATA_BYTES;

/// The label of the import window. No capability names it.
pub const IMPORT_WINDOW: &str = "import";
/// Reader source longer than this is refused.
#[cfg_attr(mobile, allow(dead_code))]
const MAX_READER_CHARS: usize = 64 * 1024;
/// The page data is read in slices of this many UTF-16 units.
const SLICE_CHARS: usize = 1 << 20;
/// How long one evaluation may take before the page counts as busy.
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a page of a kept window may give no data, after it finished
/// loading, before the window asks for the person's attention.
pub const ATTENTION_AFTER: Duration = Duration::from_secs(8);

/// Whether the person may open `url` in the import window: `https`, or
/// `http` to this computer for tests; no user names or passwords.
#[cfg_attr(mobile, allow(dead_code))]
pub fn allowed_page_url(text: &str) -> Option<Url> {
    let url = Url::parse(text.trim()).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    match url.scheme() {
        "https" => url.host_str().is_some().then_some(url),
        "http" => matches!(url.host_str(), Some("127.0.0.1" | "localhost")).then_some(url),
        _ => None,
    }
}

/// The site of a page: its host without a leading `www.`.
#[cfg_attr(mobile, allow(dead_code))]
fn site_of(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    Some(host.strip_prefix("www.").map(str::to_owned).unwrap_or(host))
}

/// Whether the import window may go to `next` when the person entered
/// `start`: the same site (the host or its sub-domains, with or without
/// `www.`), over the same kind of connection. Blank frames are allowed;
/// anything else is not.
#[cfg_attr(mobile, allow(dead_code))]
pub fn same_site(start: &Url, next: &Url) -> bool {
    if next.scheme() == "about" {
        return matches!(next.path(), "blank" | "srcdoc");
    }
    if next.scheme() != start.scheme() {
        return false;
    }
    let (Some(site), Some(host)) = (site_of(start), next.host_str()) else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == site || host.ends_with(&format!(".{site}"))
}

/// Whether two addresses are the same page: the same address without its
/// fragment.
#[cfg_attr(mobile, allow(dead_code))]
fn same_page(a: &Url, b: &Url) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.set_fragment(None);
    b.set_fragment(None);
    a == b
}

/// Where a kept import window is on its way to the page asked for, from
/// the page load events of the window. Nothing here touches a window, so
/// it is tested on its own.
///
/// The reader may run only once a page load that started after the window
/// was told to go to `asked` has finished ([`Visit::readable`]), and the
/// data counts only when the document it came from is `asked` or a page of
/// the same site the site led to from it, but never one of the addresses
/// of the page shown before ([`Visit::address_ok`]). So a poll right after
/// the window was told to move, while it still shows the page before, never
/// reads that page.
#[derive(Debug)]
#[cfg_attr(mobile, allow(dead_code))]
struct Visit {
    /// The site of the window: the first page of the go.
    start: Url,
    /// The page asked for.
    asked: Url,
    /// The addresses of the page before: never read as this one.
    before: Vec<Url>,
    /// A page load of this page has started since it was asked for.
    started: bool,
    /// When that load finished, while no other has started since.
    finished: Option<Instant>,
    /// The document address the data was last read from.
    read: Option<Url>,
    /// The person's attention was asked for, for this page.
    attention: bool,
    /// The person browses: each page they go to is a new visit, read once.
    browse: bool,
}

#[cfg_attr(mobile, allow(dead_code))]
impl Visit {
    fn new(start: Url) -> Self {
        Visit {
            asked: start.clone(),
            start,
            before: Vec::new(),
            started: false,
            finished: None,
            read: None,
            attention: false,
            browse: false,
        }
    }

    /// A window the person browses, from `start`.
    fn browsing(start: Url) -> Self {
        Visit {
            browse: true,
            ..Visit::new(start)
        }
    }

    /// The window is told to go to `next`: nothing of this page counts for it.
    fn next(&mut self, next: Url) {
        let mut before = vec![self.asked.clone()];
        before.extend(
            self.read
                .take()
                .filter(|read| !same_page(read, &self.asked)),
        );
        *self = Visit {
            start: self.start.clone(),
            asked: next,
            before,
            started: false,
            finished: None,
            read: None,
            attention: false,
            browse: self.browse,
        };
    }

    /// Whether `address` may be the page asked for: on the window's site,
    /// and the page asked for, or another page the site led to that is not
    /// the page shown before.
    fn address_ok(&self, address: &Url) -> bool {
        matches!(address.scheme(), "http" | "https")
            && same_site(&self.start, address)
            && (same_page(address, &self.asked)
                || (!self.browse && !self.before.iter().any(|before| same_page(address, before))))
    }

    /// A page load event of the window. Only loads of the page asked for
    /// (or where the site led from it) count; a load that starts again (a
    /// check that reloads the page, say) waits for its own end.
    fn page_load(&mut self, started: bool, url: &Url, now: Instant) {
        if self.browse {
            self.browsed(started, url, now);
            return;
        }
        if !self.address_ok(url) {
            return;
        }
        if started {
            self.started = true;
            self.finished = None;
        } else if self.started {
            self.finished = Some(now);
        }
    }

    /// A page load event of a window the person browses: a load of another
    /// page of the site is the person going there, a new visit; a load of
    /// the same page (a reload) is the same visit, so a page read is not
    /// read again.
    fn browsed(&mut self, started: bool, url: &Url, now: Instant) {
        if !matches!(url.scheme(), "http" | "https") || !same_site(&self.start, url) {
            return;
        }
        if !same_page(url, &self.asked) {
            self.before = vec![self.asked.clone()];
            self.asked = url.clone();
            self.read = None;
            self.started = false;
            self.finished = None;
        }
        if started {
            self.started = true;
            self.finished = None;
        } else {
            // A page the site led to finishes without its own start.
            self.started = true;
            self.finished = Some(now);
        }
    }

    /// The page asked for has finished loading: the reader may run. A page
    /// the person browsed to is read once.
    fn readable(&self) -> bool {
        self.finished.is_some() && !(self.browse && self.read.is_some())
    }

    /// Whether to ask for the person's attention now: the page finished
    /// loading [`ATTENTION_AFTER`] ago and gave no data, and it was not
    /// asked for this page before. Notes that it is asked.
    fn attention_due(&mut self, now: Instant) -> bool {
        let due = !self.browse
            && !self.attention
            && self
                .finished
                .is_some_and(|at| now.saturating_duration_since(at) >= ATTENTION_AFTER);
        if due {
            self.attention = true;
        }
        due
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum PollResult {
    /// The data is not there yet.
    Waiting {
        /// The page is still loading.
        loading: bool,
        /// The reader's last complaint, if it threw.
        note: Option<String>,
        /// A kept window's page has loaded and given no data for a while,
        /// and the window has asked for the person's attention.
        attention: bool,
    },
    /// The page data has been read, and the map's picture is being measured
    /// from the page: the importer's step has run `steps` times, `presses`
    /// of which pressed the page's zoom control.
    #[cfg_attr(not(feature = "downloads"), allow(dead_code))]
    Measuring { steps: u32, presses: u32 },
    /// The page data, as JSON text, and what the page loaded while it was
    /// measured, when it was.
    Ready {
        data: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        page: Option<PageObservations>,
        /// In a kept window, the address of the document the data was read from.
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<String>,
    },
    /// The person closed the window.
    Closed,
    /// The data cannot be used.
    Failed { message: String },
}

/// What the page loaded while it was measured (`pagemeasure::Observations`).
#[cfg(feature = "downloads")]
pub type PageObservations = crate::pagemeasure::Observations;
/// Nothing: a build without downloads does not measure pages.
#[cfg(not(feature = "downloads"))]
#[derive(Clone, Debug, Serialize)]
pub enum PageObservations {}

#[derive(Default)]
struct Session {
    reader: String,
    loading: bool,
    /// A unique name for the page data while it is pulled out in slices.
    key: String,
    /// Measuring the map's picture from the page, when asked for.
    #[cfg(feature = "downloads")]
    measure: Option<Measure>,
    /// Which import this is, so that a poll that overlaps the next import
    /// does not put its measuring into that one.
    #[cfg(feature = "downloads")]
    id: u64,
    /// The window is kept for the next page of the go: where it is going.
    /// None for every other import window, which works as it always has.
    kept: Option<Visit>,
}

/// Measuring the map's picture from the page: the page data, once read, waits here.
#[cfg(feature = "downloads")]
struct Measure {
    measuring: crate::pagemeasure::Measuring,
    data: Option<String>,
    id: u64,
}

/// The current import, if any. Lives in Tauri's managed state.
#[derive(Clone, Default)]
pub struct Imports {
    session: Arc<Mutex<Option<Session>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Evaluates a script in the window and returns its result as JSON text,
/// or `None` when it did not answer in time (for example while a page is
/// loading, when WebKitGTK keeps scripts until the page is ready).
pub(crate) async fn evaluate<R: Runtime>(
    window: &WebviewWindow<R>,
    script: String,
) -> Option<String> {
    let (send, receive) = oneshot::channel();
    let send = Mutex::new(Some(send));
    window
        .eval_with_callback(script, move |result| {
            if let Some(send) = lock(&send).take() {
                let _ = send.send(result);
            }
        })
        .ok()?;
    tokio::time::timeout(EVAL_TIMEOUT, receive).await.ok()?.ok()
}

/// The script that runs the reader. It always returns a JSON string,
/// because exceptions do not come back from every platform's webview. With
/// the data, it gives the address of the document it was read from.
fn reader_script(reader: &str, key: &str) -> String {
    format!(
        r#"(function () {{
  try {{
    var value = ({reader})();
    if (value === undefined || value === null) return JSON.stringify({{ state: 'waiting' }});
    var text = JSON.stringify(value);
    if (typeof text !== 'string') return JSON.stringify({{ state: 'failed', message: 'not JSON' }});
    if (text.length > {max}) return JSON.stringify({{ state: 'failed', message: 'too large' }});
    Object.defineProperty(window, {key:?}, {{ value: text, configurable: true, enumerable: false, writable: true }});
    return JSON.stringify({{ state: 'ready', length: text.length, address: String(location.href) }});
  }} catch (error) {{
    return JSON.stringify({{ state: 'waiting', note: String(error && error.message || error).slice(0, 200) }});
  }}
}})()"#,
        max = MAX_PAGE_DATA_BYTES,
    )
}

/// The script that returns one slice of the page data, never splitting a
/// surrogate pair.
fn slice_script(key: &str, start: usize) -> String {
    format!(
        r#"(function () {{
  var text = window[{key:?}];
  if (typeof text !== 'string') return null;
  var end = Math.min(text.length, {start} + {SLICE_CHARS});
  if (end < text.length) {{ var c = text.charCodeAt(end - 1); if (c >= 0xd800 && c <= 0xdbff) end -= 1; }}
  return JSON.stringify({{ next: end, text: text.slice({start}, end) }});
}})()"#
    )
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum ReaderAnswer {
    Waiting {
        note: Option<String>,
    },
    Ready {
        length: usize,
        #[serde(default)]
        address: Option<String>,
    },
    Failed {
        message: String,
    },
}

#[derive(Deserialize)]
struct Slice {
    next: usize,
    text: String,
}

/// The import window as the page measuring sees it.
#[cfg(feature = "downloads")]
impl<R: Runtime> crate::pagemeasure::Page for WebviewWindow<R> {
    fn run(
        &self,
        script: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>> {
        Box::pin(async move {
            evaluate(self, script)
                .await
                .and_then(|result| decode_string(&result))
        })
    }
}

/// Decodes what `eval_with_callback` passed back for a script that returns
/// a string: the string as JSON. Anything else is `None`.
fn decode_string(result: &str) -> Option<String> {
    serde_json::from_str::<String>(result).ok()
}

impl Imports {
    /// The import window is not available on Android.
    #[cfg(mobile)]
    pub fn open<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        _url: &str,
        _reader: String,
        _measure: Option<String>,
        _keep: bool,
        _browse: bool,
    ) -> Result<(), String> {
        Err("Maps cannot be added from web pages on this device.".to_owned())
    }

    /// The import window is not available on Android.
    #[cfg(mobile)]
    pub fn navigate<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        _url: &str,
        _reader: String,
    ) -> Result<Navigated, String> {
        Err("Maps cannot be added from web pages on this device.".to_owned())
    }

    /// Opens the import window on `url`, replacing an earlier import. With
    /// `measure`, the importer's page measuring step, the map's picture is
    /// measured from the page once its data has been read. With `keep`, the
    /// window is kept for the next page of a go on the same site
    /// ([`Imports::navigate`]); a page that is measured cannot be kept. With
    /// `browse`, the person browses the site in the window and each page they
    /// open is read once (see the module's notes); the window is never moved.
    #[cfg(desktop)]
    pub fn open<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        url: &str,
        reader: String,
        measure: Option<String>,
        keep: bool,
        browse: bool,
    ) -> Result<(), String> {
        let start = allowed_page_url(url)
            .ok_or_else(|| "Only https web addresses can be imported from.".to_owned())?;
        check_reader(&reader)?;
        if (keep || browse) && measure.is_some() {
            return Err(
                "A page whose map picture is measured cannot be kept open for the next page."
                    .to_owned(),
            );
        }
        #[cfg(not(feature = "downloads"))]
        if measure.is_some() {
            return Err("This app does not measure map pictures from pages.".to_owned());
        }
        #[cfg(feature = "downloads")]
        let measure = measure
            .map(|step| {
                crate::pagemeasure::Measuring::new(
                    step,
                    format!("__atlasMeasure{:016x}", rand_u64()),
                    crate::activity::ActivityLog::global(),
                )
            })
            .transpose()?;
        self.close(app);
        let key = format!("__atlasImport{:016x}", rand_u64());
        #[cfg(feature = "downloads")]
        let watch = measure.as_ref().map(|measuring| measuring.watch_script());
        #[cfg(feature = "downloads")]
        let id = {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(1);
            NEXT.fetch_add(1, Ordering::Relaxed)
        };
        *lock(&self.session) = Some(Session {
            reader,
            loading: true,
            key,
            #[cfg(feature = "downloads")]
            measure: measure.map(|measuring| Measure {
                measuring,
                data: None,
                id,
            }),
            #[cfg(feature = "downloads")]
            id,
            kept: if browse {
                Some(Visit::browsing(start.clone()))
            } else {
                keep.then(|| Visit::new(start.clone()))
            },
        });

        let navigation_start = start.clone();
        let session = Arc::clone(&self.session);
        let title = format!(
            "{} \u{2013} {}",
            if browse {
                "Browse and keep"
            } else {
                "Add a map"
            },
            start.host_str().unwrap_or_default()
        );
        let builder = WebviewWindowBuilder::new(app, IMPORT_WINDOW, WebviewUrl::External(start))
            .title(title)
            .inner_size(1100.0, 760.0)
            .center()
            .focused(true)
            .incognito(true)
            .on_navigation(move |next| {
                let allowed = same_site(&navigation_start, next);
                if !allowed {
                    crate::activity::warn(
                        crate::activity::Area::Import,
                        format!(
                            "The import window stays on its site; not opening {}{}",
                            next.origin().ascii_serialization(),
                            next.path()
                        ),
                    );
                }
                allowed
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }))
            .on_page_load(move |_, payload| {
                if let Some(session) = lock(&session).as_mut() {
                    let started = matches!(payload.event(), PageLoadEvent::Started);
                    session.loading = started;
                    if let Some(visit) = session.kept.as_mut() {
                        visit.page_load(started, payload.url(), Instant::now());
                    }
                }
            });
        // A page's map only loads the images in its view: as large as the
        // screen allows while it is measured.
        #[cfg(feature = "downloads")]
        let builder = match &watch {
            Some(script) => builder
                .inner_size(1600.0, 1000.0)
                .maximized(true)
                .initialization_script(script),
            None => builder,
        };
        if let Err(error) = builder.build() {
            lock(&self.session).take();
            return Err(format!("Could not open the page window: {error}"));
        }
        Ok(())
    }

    /// Moves a kept import window to the next page of the go, `url`, on the
    /// same site, to be read with `reader`. The window is not focused, not
    /// brought to the front and not un-minimized. Nothing of the page it
    /// showed is read for the new one (see [`Visit`]). When the person has
    /// closed the window, nothing is opened and the answer says so.
    #[cfg(desktop)]
    pub fn navigate<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        url: &str,
        reader: String,
    ) -> Result<Navigated, String> {
        let next = allowed_page_url(url)
            .ok_or_else(|| "Only https web addresses can be imported from.".to_owned())?;
        check_reader(&reader)?;
        let Some(window) = app.get_webview_window(IMPORT_WINDOW) else {
            return if lock(&self.session).take().is_some() {
                Ok(Navigated::Closed)
            } else {
                Err("No page window is open.".to_owned())
            };
        };
        {
            let mut guard = lock(&self.session);
            let session = guard
                .as_mut()
                .ok_or_else(|| "No page window is open.".to_owned())?;
            let visit = session
                .kept
                .as_mut()
                .ok_or_else(|| "The page window is not kept for the next page.".to_owned())?;
            // The person browses: the app never moves the window.
            if visit.browse {
                return Err(
                    "The person browses in this window, so this app does not move it.".to_owned(),
                );
            }
            // The window stays on its site; another site gets a window of its own.
            if !same_site(&visit.start, &next) {
                return Err(
                    "The next page is on another site, so it is not opened in this window."
                        .to_owned(),
                );
            }
            visit.next(next.clone());
            session.reader = reader;
            session.key = format!("__atlasImport{:016x}", rand_u64());
            session.loading = true;
        }
        // Asking for the person's attention ends with the page it was for.
        stop_attention(&window);
        window
            .navigate(next)
            .map_err(|error| format!("Could not move the page window to the next page: {error}"))?;
        Ok(Navigated::Navigated)
    }

    /// Asks the page for its data once; once it has been read, measures the
    /// map's picture from the page one step at a time when that was asked for.
    pub async fn poll<R: Runtime>(&self, app: &AppHandle<R>) -> PollResult {
        #[cfg(feature = "downloads")]
        if let Some(result) = self.poll_measuring(app).await {
            return result;
        }
        let Some(window) = app.get_webview_window(IMPORT_WINDOW) else {
            return if lock(&self.session).take().is_some() {
                PollResult::Closed
            } else {
                PollResult::Failed {
                    message: "No page is open.".to_owned(),
                }
            };
        };
        let Some((reader, key, loading, kept, browse)) =
            lock(&self.session).as_ref().map(|session| {
                (
                    session.reader.clone(),
                    session.key.clone(),
                    session.loading,
                    session.kept.is_some(),
                    session.kept.as_ref().is_some_and(|visit| visit.browse),
                )
            })
        else {
            return PollResult::Failed {
                message: "No page is open.".to_owned(),
            };
        };
        // A kept window is read only once the page asked for has loaded; a
        // page the person browsed to, only once.
        if kept && !self.kept_readable() {
            return PollResult::Waiting {
                // A browsed page read waits for the person, not for a load.
                loading: !browse || loading,
                note: None,
                attention: false,
            };
        }
        let answer = evaluate(&window, reader_script(&reader, &key))
            .await
            .and_then(|result| decode_string(&result))
            .and_then(|text| serde_json::from_str::<ReaderAnswer>(&text).ok());
        let (length, address) = match answer {
            None => return self.waiting(&window, loading, None),
            Some(ReaderAnswer::Waiting { note }) => return self.waiting(&window, loading, note),
            Some(ReaderAnswer::Failed { message }) => {
                return PollResult::Failed {
                    message: if message == "too large" {
                        "The page holds more data than a map can have.".to_owned()
                    } else {
                        "The page's data could not be read as JSON.".to_owned()
                    },
                }
            }
            Some(ReaderAnswer::Ready { length, address }) => (length, address),
        };
        // A kept window's data counts only from the page asked for.
        let address = if kept {
            let mut guard = lock(&self.session);
            let Some(visit) = guard.as_mut().and_then(|session| session.kept.as_mut()) else {
                return PollResult::Failed {
                    message: "No page is open.".to_owned(),
                };
            };
            let parsed = address.as_deref().and_then(|text| Url::parse(text).ok());
            match parsed {
                Some(parsed) if visit.readable() && visit.address_ok(&parsed) => {
                    visit.read = Some(parsed);
                    address
                }
                _ => {
                    let _ = window.eval(format!("delete window[{key:?}];"));
                    return PollResult::Waiting {
                        loading: !visit.readable(),
                        note: Some("the window does not show the page asked for yet".to_owned()),
                        attention: visit.attention,
                    };
                }
            }
        } else {
            None
        };
        let mut data = String::with_capacity(length.min(MAX_PAGE_DATA_BYTES));
        let mut start = 0;
        while start < length {
            let slice = evaluate(&window, slice_script(&key, start))
                .await
                .and_then(|result| decode_string(&result))
                .and_then(|text| serde_json::from_str::<Slice>(&text).ok());
            let Some(slice) = slice.filter(|slice| slice.next > start && slice.next <= length)
            else {
                return PollResult::Waiting {
                    loading,
                    note: Some("the page changed while it was read".to_owned()),
                    attention: false,
                };
            };
            data.push_str(&slice.text);
            if data.len() > MAX_PAGE_DATA_BYTES {
                return PollResult::Failed {
                    message: "The page holds more data than a map can have.".to_owned(),
                };
            }
            start = slice.next;
        }
        let _ = window.eval(format!("delete window[{key:?}];"));
        if serde_json::from_str::<serde::de::IgnoredAny>(&data).is_err() {
            return PollResult::Failed {
                message: "The page's data could not be read as JSON.".to_owned(),
            };
        }
        #[cfg(feature = "downloads")]
        {
            let mut session = lock(&self.session);
            if let Some(measure) = session
                .as_mut()
                .and_then(|session| session.measure.as_mut())
            {
                measure.data = Some(data);
                return PollResult::Measuring {
                    steps: 0,
                    presses: 0,
                };
            }
        }
        if kept {
            // The attention asked for, if it was, is no longer needed.
            stop_attention(&window);
        }
        PollResult::Ready {
            data,
            page: None,
            address,
        }
    }

    /// Whether the page a kept window was asked for has finished loading.
    fn kept_readable(&self) -> bool {
        lock(&self.session)
            .as_ref()
            .and_then(|session| session.kept.as_ref())
            .is_some_and(Visit::readable)
    }

    /// The data is not there yet. A kept window's page that has loaded and
    /// given no data for a while asks for the person's attention, once: in
    /// the task bar or the dock, without taking the focus, coming to the
    /// front or being un-minimized.
    fn waiting<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        loading: bool,
        note: Option<String>,
    ) -> PollResult {
        let (due, attention) = match lock(&self.session)
            .as_mut()
            .and_then(|session| session.kept.as_mut())
        {
            Some(visit) => (visit.attention_due(Instant::now()), visit.attention),
            None => (false, false),
        };
        if due {
            ask_attention(window);
        }
        PollResult::Waiting {
            loading,
            note,
            attention,
        }
    }

    /// One poll of a page whose data has been read and whose map picture is
    /// being measured; None when that is not the case.
    #[cfg(feature = "downloads")]
    async fn poll_measuring<R: Runtime>(&self, app: &AppHandle<R>) -> Option<PollResult> {
        use crate::pagemeasure::Progress;
        let (mut measure, data) = {
            let mut session = lock(&self.session);
            let slot = &mut session.as_mut()?.measure;
            slot.as_ref()?.data.as_ref()?;
            let mut measure = slot.take()?;
            let data = measure.data.take()?;
            (measure, data)
        };
        let now = std::time::Instant::now();
        let Some(window) = app.get_webview_window(IMPORT_WINDOW) else {
            // Closed while it was measured: the data, and what was seen.
            lock(&self.session).take();
            return Some(PollResult::Ready {
                data,
                page: Some(measure.measuring.closed(now)),
                address: None,
            });
        };
        let size = window.inner_size().ok().map(|size| {
            let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
            (
                (f64::from(size.width) / scale).round() as u32,
                (f64::from(size.height) / scale).round() as u32,
            )
        });
        match measure.measuring.advance(&window, now, size).await {
            // The session goes on, with the data handed over.
            Progress::Finished(observations) => Some(PollResult::Ready {
                data,
                page: Some(observations),
                address: None,
            }),
            Progress::Measuring { steps, presses } => {
                if let Some(current) = lock(&self.session)
                    .as_mut()
                    .filter(|current| current.measure.is_none() && current.id == measure.id)
                {
                    measure.data = Some(data);
                    current.measure = Some(measure);
                }
                Some(PollResult::Measuring { steps, presses })
            }
        }
    }

    /// Closes the import window, if it is open.
    pub fn close<R: Runtime>(&self, app: &AppHandle<R>) {
        lock(&self.session).take();
        if let Some(window) = app.get_webview_window(IMPORT_WINDOW) {
            let _ = window.destroy();
        }
    }
}

/// What moving a kept window to the next page did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(mobile, allow(dead_code))]
pub enum Navigated {
    /// The window is on its way to the next page.
    Navigated,
    /// The person had closed the window: nothing was opened.
    Closed,
}

/// Checks the importer's page reader before it is run in a page.
#[cfg_attr(mobile, allow(dead_code))]
fn check_reader(reader: &str) -> Result<(), String> {
    if reader.is_empty() || reader.len() > MAX_READER_CHARS {
        return Err("The importer's page reader is not usable.".to_owned());
    }
    Ok(())
}

/// Asks for the person's attention in the window's task bar button or dock
/// icon until they look at it. It never focuses, raises or un-minimizes it.
#[cfg(desktop)]
fn ask_attention<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.request_user_attention(Some(UserAttentionType::Critical));
}

/// Stops asking for the person's attention, where the platform can.
#[cfg(desktop)]
fn stop_attention<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.request_user_attention(None);
}

/// No import window on Android.
#[cfg(mobile)]
fn ask_attention<R: Runtime>(_window: &WebviewWindow<R>) {}

/// No import window on Android.
#[cfg(mobile)]
fn stop_attention<R: Runtime>(_window: &WebviewWindow<R>) {}

/// A random number for the page data's name, from the standard library's
/// randomly seeded hasher.
#[cfg_attr(mobile, allow(dead_code))]
fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(std::time::SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn accepts_https_and_loopback_pages_only() {
        assert!(allowed_page_url("https://maps.example.com/game/map?x=1").is_some());
        assert!(allowed_page_url(" http://127.0.0.1:4432/demo-maps/a/b ").is_some());
        assert!(allowed_page_url("http://localhost/x").is_some());
        for bad in [
            "http://example.com/",
            "http://127.0.0.2/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "https://user:pass@example.com/",
            "atlas-pack://localhost/demo/manifest.json",
            "tauri://localhost/",
            "nonsense",
        ] {
            assert!(allowed_page_url(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn keeps_navigation_on_the_site() {
        let start = url("https://www.example.com/game/maps/one");
        for ok in [
            "https://www.example.com/game/maps/two",
            "https://example.com/login",
            "https://cdn.example.com/check",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(same_site(&start, &url(ok)), "{ok}");
        }
        for bad in [
            "http://www.example.com/",
            "https://example.com.evil.net/",
            "https://notexample.com/",
            "https://other.org/",
            "file:///etc/passwd",
            "atlas-pack://localhost/demo/manifest.json",
            "javascript:alert(1)",
            "data:text/html,hi",
        ] {
            assert!(!same_site(&start, &url(bad)), "{bad}");
        }
        let local = url("http://127.0.0.1:4432/demo-maps/a/b");
        assert!(same_site(&local, &url("http://127.0.0.1:4432/other")));
        assert!(!same_site(&local, &url("http://localhost:4432/other")));
        assert!(!same_site(&local, &url("https://example.com/")));
    }

    #[test]
    fn builds_scripts_that_always_return_strings() {
        let script = reader_script("function () { return 1; }", "__atlasImport1");
        assert!(script.contains("JSON.stringify({ state: 'waiting' })"));
        assert!(script.contains("\"__atlasImport1\""));
        assert!(script.contains("catch (error)"));
        let slice = slice_script("__atlasImport1", 5);
        assert!(slice.contains("text.slice(5, end)"));
    }

    #[test]
    fn decodes_answers() {
        assert_eq!(
            decode_string(r#""{\"state\":\"waiting\"}""#).as_deref(),
            Some(r#"{"state":"waiting"}"#)
        );
        assert_eq!(decode_string(""), None);
        assert_eq!(decode_string("null"), None);
        assert_eq!(decode_string("{}"), None);
        assert!(matches!(
            serde_json::from_str::<ReaderAnswer>(r#"{"state":"ready","length":5}"#),
            Ok(ReaderAnswer::Ready {
                length: 5,
                address: None
            })
        ));
        assert!(matches!(
            serde_json::from_str::<ReaderAnswer>(
                r#"{"state":"ready","length":5,"address":"https://wiki.example.org/wiki/A"}"#
            ),
            Ok(ReaderAnswer::Ready { length: 5, address: Some(address) })
                if address == "https://wiki.example.org/wiki/A"
        ));
        assert!(serde_json::from_str::<ReaderAnswer>(r#"{"state":"pwned"}"#).is_err());
        assert!(reader_script("function () { return 1; }", "__atlasImport1")
            .contains("address: String(location.href)"));
    }

    #[test]
    fn says_what_a_poll_found_in_the_shape_the_web_app_reads() {
        let waiting = PollResult::Waiting {
            loading: false,
            note: None,
            attention: true,
        };
        assert_eq!(
            serde_json::to_value(waiting).unwrap(),
            serde_json::json!({ "state": "waiting", "loading": false, "note": null, "attention": true })
        );
        let ready = PollResult::Ready {
            data: "{}".to_owned(),
            page: None,
            address: None,
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            serde_json::json!({ "state": "ready", "data": "{}" })
        );
        let kept = PollResult::Ready {
            data: "{}".to_owned(),
            page: None,
            address: Some("https://wiki.example.org/wiki/B".to_owned()),
        };
        assert_eq!(
            serde_json::to_value(kept).unwrap(),
            serde_json::json!({ "state": "ready", "data": "{}", "address": "https://wiki.example.org/wiki/B" })
        );
        assert_eq!(
            serde_json::to_value(Navigated::Navigated).unwrap(),
            serde_json::json!("navigated")
        );
        assert_eq!(
            serde_json::to_value(Navigated::Closed).unwrap(),
            serde_json::json!("closed")
        );
    }

    const A: &str = "https://wiki.example.org/wiki/A";
    const B: &str = "https://wiki.example.org/wiki/B";

    /// A kept window that read page A and was then told to go to B.
    fn moved_to_b(at: Instant) -> Visit {
        let mut visit = Visit::new(url(A));
        visit.page_load(true, &url(A), at);
        visit.page_load(false, &url(A), at);
        assert!(visit.readable());
        visit.read = Some(url(A));
        visit.next(url(B));
        visit
    }

    #[test]
    fn reads_the_first_page_only_once_it_has_loaded() {
        let at = Instant::now();
        let mut visit = Visit::new(url(A));
        assert!(!visit.readable());
        // A load that ends without having started for this page does not count.
        visit.page_load(false, &url(A), at);
        assert!(!visit.readable());
        visit.page_load(true, &url(A), at);
        assert!(!visit.readable());
        visit.page_load(false, &url(A), at);
        assert!(visit.readable());
    }

    #[test]
    fn never_reads_the_page_shown_before_after_moving() {
        let at = Instant::now();
        let mut visit = moved_to_b(at);
        // Straight after the move the window still shows A: not readable.
        assert!(!visit.readable());
        // A late end of A's load, or a new load of A, does not count for B.
        visit.page_load(false, &url(A), at);
        assert!(!visit.readable());
        visit.page_load(true, &url(A), at);
        visit.page_load(false, &url(A), at);
        assert!(!visit.readable());
        assert!(!visit.address_ok(&url(A)));
        assert!(!visit.address_ok(&url("https://wiki.example.org/wiki/A#Section")));
        // B's own load.
        visit.page_load(true, &url(B), at);
        assert!(!visit.readable());
        visit.page_load(false, &url(B), at);
        assert!(visit.readable());
        assert!(visit.address_ok(&url(B)));
        assert!(visit.address_ok(&url("https://wiki.example.org/wiki/B#History")));
    }

    #[test]
    fn allows_the_sites_own_redirects_on_the_same_site_only() {
        let at = Instant::now();
        let mut visit = moved_to_b(at);
        // The site leads from B to another of its pages.
        let redirected = url("https://wiki.example.org/wiki/B_(page)");
        visit.page_load(true, &redirected, at);
        visit.page_load(false, &redirected, at);
        assert!(visit.readable());
        assert!(visit.address_ok(&redirected));
        assert!(visit.address_ok(&url("https://www.wiki.example.org/wiki/Other")));
        // Never another site, and never anything but a web page.
        for bad in [
            "https://other.example.net/wiki/B",
            "http://wiki.example.org/wiki/B",
            "about:blank",
            "data:text/html,B",
        ] {
            assert!(!visit.address_ok(&url(bad)), "{bad}");
        }
        // A load of another site does not count as B's.
        let mut other = moved_to_b(at);
        other.page_load(true, &url("https://other.example.net/wiki/B"), at);
        other.page_load(false, &url("https://other.example.net/wiki/B"), at);
        assert!(!other.readable());
    }

    #[test]
    fn a_page_that_loads_again_waits_for_its_new_load() {
        let at = Instant::now();
        let mut visit = moved_to_b(at);
        visit.page_load(true, &url(B), at);
        visit.page_load(false, &url(B), at);
        assert!(visit.readable());
        // The site's check reloads the page once the person has answered it.
        visit.page_load(true, &url(B), at);
        assert!(!visit.readable());
        visit.page_load(false, &url(B), at + Duration::from_secs(1));
        assert!(visit.readable());
    }

    #[test]
    fn asks_for_attention_once_a_page_has_given_nothing_for_a_while() {
        let at = Instant::now();
        let mut visit = moved_to_b(at);
        // Not while it loads.
        assert!(!visit.attention_due(at + ATTENTION_AFTER * 2));
        visit.page_load(true, &url(B), at);
        visit.page_load(false, &url(B), at);
        assert!(!visit.attention_due(at + ATTENTION_AFTER - Duration::from_millis(1)));
        assert!(!visit.attention);
        assert!(visit.attention_due(at + ATTENTION_AFTER));
        assert!(visit.attention);
        // Once per page.
        assert!(!visit.attention_due(at + ATTENTION_AFTER * 3));
        // The next page starts afresh.
        visit.read = Some(url(B));
        visit.next(url("https://wiki.example.org/wiki/C"));
        assert!(!visit.attention);
        assert_eq!(visit.before, vec![url(B)]);
    }

    #[test]
    fn a_browsed_window_reads_each_page_the_person_opens_once() {
        let at = Instant::now();
        let mut visit = Visit::browsing(url(A));
        assert!(!visit.readable());
        visit.page_load(true, &url(A), at);
        assert!(!visit.readable());
        visit.page_load(false, &url(A), at);
        assert!(visit.readable());
        assert!(visit.address_ok(&url(A)));
        visit.read = Some(url(A));
        // Read once: not again, not even when the page loads again.
        assert!(!visit.readable());
        visit.page_load(true, &url(A), at);
        visit.page_load(false, &url(A), at);
        assert!(!visit.readable());
        // The person goes to B: a new visit, read once its load has finished.
        visit.page_load(true, &url(B), at);
        assert_eq!(visit.asked, url(B));
        assert!(!visit.readable());
        // A's data never counts for B.
        assert!(!visit.address_ok(&url(A)));
        visit.page_load(false, &url(B), at);
        assert!(visit.readable());
        assert!(visit.address_ok(&url("https://wiki.example.org/wiki/B#Notes")));
        visit.read = Some(url(B));
        // Back to A: a new visit of A, read again in this visit.
        visit.page_load(true, &url(A), at);
        visit.page_load(false, &url(A), at);
        assert!(visit.readable());
        // A page the site led to finishes without a start of its own.
        visit.read = Some(url(A));
        visit.page_load(false, &url("https://wiki.example.org/wiki/C"), at);
        assert!(visit.readable());
        // Never another site, and never attention: the person is there.
        visit.page_load(true, &url("https://other.example.net/wiki/D"), at);
        assert_eq!(visit.asked, url("https://wiki.example.org/wiki/C"));
        assert!(!visit.attention_due(at + ATTENTION_AFTER * 2));
    }

    #[test]
    fn remembers_where_the_page_before_was_read() {
        let at = Instant::now();
        let mut visit = Visit::new(url(A));
        visit.page_load(true, &url(A), at);
        visit.page_load(false, &url(A), at);
        // A was read where the site had led: both addresses are A's.
        visit.read = Some(url("https://wiki.example.org/wiki/A_(page)"));
        visit.next(url(B));
        assert!(!visit.address_ok(&url(A)));
        assert!(!visit.address_ok(&url("https://wiki.example.org/wiki/A_(page)")));
        assert!(visit.address_ok(&url(B)));
    }
}
