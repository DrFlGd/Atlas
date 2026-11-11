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

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::oneshot;

use crate::library::MAX_PAGE_DATA_BYTES;

/// The label of the import window. No capability names it.
pub const IMPORT_WINDOW: &str = "import";
/// Reader source longer than this is refused.
const MAX_READER_CHARS: usize = 64 * 1024;
/// The page data is read in slices of this many UTF-16 units.
const SLICE_CHARS: usize = 1 << 20;
/// How long one evaluation may take before the page counts as busy.
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether the person may open `url` in the import window: `https`, or
/// `http` to this computer for tests; no user names or passwords.
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
fn site_of(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    Some(host.strip_prefix("www.").map(str::to_owned).unwrap_or(host))
}

/// Whether the import window may go to `next` when the person entered
/// `start`: the same site (the host or its sub-domains, with or without
/// `www.`), over the same kind of connection. Blank frames are allowed;
/// anything else is not.
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum PollResult {
    /// The data is not there yet.
    Waiting {
        /// The page is still loading.
        loading: bool,
        /// The reader's last complaint, if it threw.
        note: Option<String>,
    },
    /// The page data, as JSON text.
    Ready { data: String },
    /// The person closed the window.
    Closed,
    /// The data cannot be used.
    Failed { message: String },
}

#[derive(Default)]
struct Session {
    reader: String,
    loading: bool,
    /// A unique name for the page data while it is pulled out in slices.
    key: String,
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
async fn evaluate<R: Runtime>(window: &WebviewWindow<R>, script: String) -> Option<String> {
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
/// because exceptions do not come back from every platform's webview.
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
    return JSON.stringify({{ state: 'ready', length: text.length }});
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
    Waiting { note: Option<String> },
    Ready { length: usize },
    Failed { message: String },
}

#[derive(Deserialize)]
struct Slice {
    next: usize,
    text: String,
}

/// Decodes what `eval_with_callback` passed back for a script that returns
/// a string: the string as JSON. Anything else is `None`.
fn decode_string(result: &str) -> Option<String> {
    serde_json::from_str::<String>(result).ok()
}

impl Imports {
    /// Opens the import window on `url`, replacing an earlier import.
    pub fn open<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        url: &str,
        reader: String,
    ) -> Result<(), String> {
        let start = allowed_page_url(url)
            .ok_or_else(|| "Only https web addresses can be imported from.".to_owned())?;
        if reader.is_empty() || reader.len() > MAX_READER_CHARS {
            return Err("The importer's page reader is not usable.".to_owned());
        }
        self.close(app);
        let key = format!("__atlasImport{:016x}", rand_u64());
        *lock(&self.session) = Some(Session {
            reader,
            loading: true,
            key,
        });

        let navigation_start = start.clone();
        let session = Arc::clone(&self.session);
        let title = format!(
            "Add a map \u{2013} {}",
            start.host_str().unwrap_or_default()
        );
        WebviewWindowBuilder::new(app, IMPORT_WINDOW, WebviewUrl::External(start))
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
                    session.loading = matches!(payload.event(), PageLoadEvent::Started);
                }
            })
            .build()
            .map_err(|error| format!("Could not open the page window: {error}"))?;
        Ok(())
    }

    /// Asks the page for its data once.
    pub async fn poll<R: Runtime>(&self, app: &AppHandle<R>) -> PollResult {
        let Some(window) = app.get_webview_window(IMPORT_WINDOW) else {
            return if lock(&self.session).take().is_some() {
                PollResult::Closed
            } else {
                PollResult::Failed {
                    message: "No page is open.".to_owned(),
                }
            };
        };
        let Some((reader, key, loading)) = lock(&self.session)
            .as_ref()
            .map(|session| (session.reader.clone(), session.key.clone(), session.loading))
        else {
            return PollResult::Failed {
                message: "No page is open.".to_owned(),
            };
        };
        let answer = evaluate(&window, reader_script(&reader, &key))
            .await
            .and_then(|result| decode_string(&result))
            .and_then(|text| serde_json::from_str::<ReaderAnswer>(&text).ok());
        let length = match answer {
            None => {
                return PollResult::Waiting {
                    loading,
                    note: None,
                }
            }
            Some(ReaderAnswer::Waiting { note }) => return PollResult::Waiting { loading, note },
            Some(ReaderAnswer::Failed { message }) => {
                return PollResult::Failed {
                    message: if message == "too large" {
                        "The page holds more data than a map can have.".to_owned()
                    } else {
                        "The page's data could not be read as JSON.".to_owned()
                    },
                }
            }
            Some(ReaderAnswer::Ready { length }) => length,
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
        PollResult::Ready { data }
    }

    /// Closes the import window, if it is open.
    pub fn close<R: Runtime>(&self, app: &AppHandle<R>) {
        lock(&self.session).take();
        if let Some(window) = app.get_webview_window(IMPORT_WINDOW) {
            let _ = window.destroy();
        }
    }
}

/// A random number for the page data's name, from the standard library's
/// randomly seeded hasher.
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
            Ok(ReaderAnswer::Ready { length: 5 })
        ));
        assert!(serde_json::from_str::<ReaderAnswer>(r#"{"state":"pwned"}"#).is_err());
    }
}
