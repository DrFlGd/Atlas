//! Measuring a map's picture from its page: the import window, when the
//! person ticked "measure the map picture from the page" and the importer
//! has a page measuring step (`PageMeasure` in `packages/importer-api`).
//!
//! A map's page only loads the map images in its view, and the coarsest
//! ones when it is zoomed out all the way. So, for this one import:
//!
//! - The import window is opened as large as the screen allows
//!   (maximised, 1600 x 1000 before that), so the page's map shows as much
//!   as it can.
//! - A watching script ([`watch_script`]) is added to the page before the
//!   page's own scripts run. It shares its wrappers of `fetch` and
//!   `XMLHttpRequest` with "Save map images as I browse"
//!   (`pageview/script.rs`) and, like it, only watches: for every `GET` the
//!   page makes, it notes the address without its query or fragment (at most
//!   [`MAX_ADDRESS_CHARS`]), the status, the content type, the first
//!   [`HEAD_BYTES`] bytes of a 2xx answer (read from a copy, to tell an
//!   image from anything else) and the start of a 403 answer's body (read
//!   from a copy, at most `MAX_FAILURE_BODY` bytes, to tell an object
//!   store's "access denied" document). It keeps no bodies, at most
//!   [`MAX_ANSWERS`] answers, and counts the requests that are open, so the
//!   shell can tell when the page has settled.
//! - Once the page reader has returned the page data, each poll runs the
//!   importer's step once ([`step_script`]), only after the page's requests
//!   have settled ([`SETTLED`]; at most [`SETTLE_MAX`] of waiting), and
//!   only while the bounds allow: [`MAX_STEPS`] steps, and no step after
//!   [`MAX_TIME`]. The step may press the page's own zoom control; the shell
//!   itself never clicks, types, scrolls or navigates anything, and makes no
//!   request. After the last step it waits for the page to settle once more
//!   (at most [`SETTLE_MAX`]), takes what was watched and hands it to the
//!   web app with the page data ([`Observations`]).
//!
//! What the page was answered is classified here, with the downloader's own
//! rules: an image when a 2xx answer starts like a JPEG, PNG or WebP image
//! (`looks_like_image`), "missing" for 404 and 410, "denied" for a 403 whose
//! body is an object store's "no such object" document
//! (`is_store_no_such_object`), and "error" for anything else. What that
//! means for a map is the importer's to decide. Every step and the end are
//! written to the activity log, with counts and never the page's data.

use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::Url;

use crate::{
    activity::{self, ActivityLog, Area},
    pageview::script::{ERROR_ANSWERS, MAX_FAILURE_BODY, WRAPPERS},
    tiles::{download::is_store_no_such_object, downscale::looks_like_image},
};

/// The most times the importer's step runs for one page.
pub const MAX_STEPS: u32 = 20;
/// No step runs after this long from the first one.
pub const MAX_TIME: Duration = Duration::from_secs(90);
/// The page has settled when no request of its own is open and none has
/// started or been answered for this long...
pub const SETTLED: Duration = Duration::from_millis(1500);
/// ...or when none has started or been answered for this long, whatever is
/// still open (a request the page keeps open must not hold everything up).
pub const SETTLED_OPEN: Duration = Duration::from_secs(5);
/// The longest wait for the page to settle, before a step and after the last.
pub const SETTLE_MAX: Duration = Duration::from_secs(10);
/// Answers handed over at most, each address once.
pub const MAX_ANSWERS: usize = 4000;
/// Longer addresses are not recorded.
pub const MAX_ADDRESS_CHARS: usize = 512;
/// The importer's step is refused when longer.
pub const MAX_STEP_CHARS: usize = 64 * 1024;
/// Bytes of a 2xx answer that are looked at.
pub const HEAD_BYTES: usize = 16;
/// Answers taken out of the page in one go.
const TAKE: usize = 500;
/// Characters of the importer's note that are logged.
const NOTE_CHARS: usize = 200;

/// The watching script added to the page; `key` is the hidden name of its handle.
pub fn watch_script(key: &str) -> String {
    let key = serde_json::to_string(key).expect("a string serialises");
    format!(
        r#"(function () {{
  'use strict';
  var KEY = {key};
  if (window !== window.top || Object.prototype.hasOwnProperty.call(window, KEY)) return;
  var MAX_ANSWERS = {MAX_ANSWERS};
  var MAX_ADDRESS = {MAX_ADDRESS_CHARS};
  var MAX_BODY = {MAX_FAILURE_BODY};
  var HEAD = {HEAD_BYTES};
  var answers = [];
  var recorded = 0;
  var dropped = 0;
  var seen = new Set();
  var open = 0;
  var lastActivity = Date.now();

  function absolute(input) {{
    try {{ return new URL(String(input), document.baseURI || location.href).href; }} catch (e) {{ return null; }}
  }}
  function wanted(url) {{
    return typeof url === 'string' && (url.indexOf('https:') === 0 || url.indexOf('http:') === 0);
  }}
  function begin() {{ open++; lastActivity = Date.now(); }}
  function end() {{ if (open > 0) open--; lastActivity = Date.now(); }}
  // The address without its query or fragment, or null when it is too long.
  function address(url) {{
    try {{
      var parsed = new URL(url);
      var text = parsed.origin + parsed.pathname;
      return text.length <= MAX_ADDRESS ? text : null;
    }} catch (e) {{ return null; }}
  }}
  function observe(url, status, type, head, body) {{
    var at = address(url);
    if (!at) {{ dropped++; return; }}
    var sign = at + ' ' + status;
    if (seen.has(sign)) return;
    if (recorded >= MAX_ANSWERS) {{ dropped++; return; }}
    seen.add(sign);
    recorded++;
    answers.push({{ url: at, status: status, type: String(type || '').slice(0, 200), head: typeof head === 'string' ? head : null, body: typeof body === 'string' ? body : null }});
  }}
  function failed(url, status, type, body) {{ observe(url, status, type, null, body); }}
{ERROR_ANSWERS}
  function hex(bytes) {{
    var text = '';
    for (var i = 0; i < bytes.length && i < HEAD; i++) text += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return text;
  }}
  // The first bytes of a copy of an answer; the copy is not read further.
  function headOf(response) {{
    var copy = response.clone();
    if (!copy.body || typeof copy.body.getReader !== 'function') return Promise.resolve(null);
    var reader = copy.body.getReader();
    return reader.read().then(function (chunk) {{
      try {{ reader.cancel().then(null, function () {{}}); }} catch (e) {{}}
      return chunk.done || !chunk.value ? '' : hex(chunk.value);
    }});
  }}
  function typeOf(get) {{
    try {{ return get('content-type') || ''; }} catch (e) {{ return ''; }}
  }}
  function fromResponse(url, response) {{
    try {{
      if (!response) return;
      if (response.type === 'opaque' || response.type === 'opaqueredirect') {{ observe(url, 0, '', null, null); return; }}
      var status = response.status;
      if (isFailure(status)) {{ failureFromResponse(url, response); return; }}
      var type = typeOf(function (name) {{ return response.headers.get(name); }});
      if (status < 200 || status > 299) {{ observe(url, status, type, null, null); return; }}
      headOf(response).then(function (head) {{ observe(url, status, type, head, null); }}, function () {{ observe(url, status, type, null, null); }});
    }} catch (e) {{}}
  }}
  function fromFetchError(url) {{ observe(url, 0, '', null, null); }}
  function fromXhr(url, xhr) {{
    try {{
      var status = xhr.status;
      if (isFailure(status)) {{ failureFromXhr(url, xhr); return; }}
      var type = typeOf(function (name) {{ return xhr.getResponseHeader(name); }});
      if (status < 200 || status > 299) {{ observe(url, status, type, null, null); return; }}
      var kind = xhr.responseType;
      if (kind === 'arraybuffer' && xhr.response) {{
        observe(url, status, type, hex(new Uint8Array(xhr.response, 0, Math.min(HEAD, xhr.response.byteLength))), null);
      }} else if (kind === 'blob' && xhr.response && typeof xhr.response.slice === 'function') {{
        xhr.response.slice(0, HEAD).arrayBuffer().then(function (buffer) {{ observe(url, status, type, hex(new Uint8Array(buffer)), null); }}, function () {{ observe(url, status, type, null, null); }});
      }} else observe(url, status, type, null, null);
    }} catch (e) {{}}
  }}
  function fromXhrError(url) {{ observe(url, 0, '', null, null); }}
{WRAPPERS}
  var handle = {{
    state: function () {{
      return JSON.stringify({{ open: open, quietMs: Math.max(0, Date.now() - lastActivity) }});
    }},
    take: function (count) {{
      var taken = answers.splice(0, count);
      return JSON.stringify({{ answers: taken, more: answers.length > 0, dropped: dropped }});
    }}
  }};
  Object.defineProperty(window, KEY, {{ value: handle, configurable: false, enumerable: false, writable: false }});
}})();"#
    )
}

/// Calls a method of the page's handle; always returns a JSON string or
/// `null`, even if the page broke the handle.
fn call(key: &str, call: &str) -> String {
    let key = serde_json::to_string(key).expect("a string serialises");
    format!(
        r#"(function () {{
  try {{
    var handle = window[{key}];
    var result = handle ? handle.{call} : null;
    return typeof result === 'string' ? result : null;
  }} catch (e) {{ return null; }}
}})()"#
    )
}

/// Whether the page's requests are open, and how long it has been quiet.
pub fn state_script(key: &str) -> String {
    call(key, "state()")
}

/// Takes up to `count` answers out of the page.
pub fn take_script(key: &str, count: usize) -> String {
    call(key, &format!("take({count})"))
}

/// Runs the importer's step once. It always returns a JSON string, because
/// exceptions do not come back from every platform's webview.
pub fn step_script(step: &str, steps: u32, presses: u32) -> String {
    format!(
        r#"(function () {{
  try {{
    var result = ({step})({{ step: {steps}, presses: {presses} }});
    if (!result || typeof result !== 'object') return JSON.stringify({{ done: false, pressed: false, note: null }});
    var note = typeof result.note === 'string' ? result.note.slice(0, {NOTE_CHARS}) : null;
    return JSON.stringify({{ done: result.done === true, pressed: result.pressed === true, note: note }});
  }} catch (error) {{
    return JSON.stringify({{ done: false, pressed: false, note: 'the step stopped with an error: ' + String(error && error.message || error).slice(0, {NOTE_CHARS}) }});
  }}
}})()"#
    )
}

/// What `state` returns.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageState {
    open: u32,
    quiet_ms: u64,
}

impl PageState {
    fn settled(&self) -> bool {
        let quiet = Duration::from_millis(self.quiet_ms);
        (self.open == 0 && quiet >= SETTLED) || quiet >= SETTLED_OPEN
    }
}

/// One answer as the page noted it.
#[derive(Debug, Deserialize)]
struct Raw {
    url: String,
    status: u16,
    #[serde(rename = "type", default)]
    content_type: String,
    /// The first bytes of a 2xx answer, as hexadecimal text.
    #[serde(default)]
    head: Option<String>,
    /// The start of a 403 answer's body.
    #[serde(default)]
    body: Option<String>,
}

/// What `take` returns.
#[derive(Debug, Deserialize)]
struct Taken {
    answers: Vec<Raw>,
    more: bool,
    #[serde(default)]
    dropped: u64,
}

/// What the importer's step returned.
#[derive(Debug, Deserialize)]
struct StepAnswer {
    done: bool,
    pressed: bool,
    note: Option<String>,
}

/// What an address was answered (see `PageAnswerKind` in `packages/importer-api`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Error,
    Denied,
    Missing,
    Image,
}

/// One address and what it was answered (see `PageAnswer`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Answer {
    pub url: String,
    pub answer: Kind,
    pub status: u16,
}

/// How measuring ended (see `PageMeasureEnd`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum End {
    Done,
    Steps,
    Time,
    Closed,
}

/// What is handed to the web app with the page data (see `PageObservations`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Observations {
    pub answers: Vec<Answer>,
    pub overflow: bool,
    pub steps: u32,
    pub presses: u32,
    pub ended: End,
}

/// The address an answer is kept under: `scheme://host[:port]/path` of an
/// `http` or `https` address without user name or password, without query
/// or fragment, at most [`MAX_ADDRESS_CHARS`]. None for anything else.
fn address(text: &str) -> Option<String> {
    let url = Url::parse(text).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return None;
    }
    let address = format!("{}{}", url.origin().ascii_serialization(), url.path());
    (address.len() <= MAX_ADDRESS_CHARS).then_some(address)
}

/// Hexadecimal text as bytes; None when it is not that.
fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || text.len() > 2 * HEAD_BYTES {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// What an answer the page got means, by the downloader's rules.
fn classify(raw: &Raw) -> Kind {
    match raw.status {
        200..=299 => {
            let image = match raw.head.as_deref() {
                Some(head) => from_hex(head).is_some_and(|bytes| looks_like_image(&bytes)),
                // Bytes the page could not read: what the answer says it is.
                None => raw
                    .content_type
                    .trim()
                    .to_ascii_lowercase()
                    .starts_with("image/"),
            };
            if image {
                Kind::Image
            } else {
                Kind::Error
            }
        }
        404 | 410 => Kind::Missing,
        403 if raw
            .body
            .as_deref()
            .is_some_and(|body| is_store_no_such_object(&raw.content_type, body.as_bytes())) =>
        {
            Kind::Denied
        }
        _ => Kind::Error,
    }
}

/// The answers so far, each address once: an image over "missing" over
/// "denied" over anything else.
#[derive(Debug, Default)]
struct Answers {
    by_address: BTreeMap<String, (Kind, u16)>,
    overflow: bool,
}

impl Answers {
    fn add(&mut self, raw: &Raw) {
        let Some(address) = address(&raw.url) else {
            self.overflow |= raw.url.len() > MAX_ADDRESS_CHARS;
            return;
        };
        let kind = classify(raw);
        if let Some(known) = self.by_address.get_mut(&address) {
            if kind > known.0 {
                *known = (kind, raw.status);
            }
            return;
        }
        if self.by_address.len() >= MAX_ANSWERS {
            self.overflow = true;
            return;
        }
        self.by_address.insert(address, (kind, raw.status));
    }

    fn count(&self, kind: Kind) -> usize {
        self.by_address.values().filter(|(k, _)| *k == kind).count()
    }

    fn list(&self) -> Vec<Answer> {
        self.by_address
            .iter()
            .map(|(url, (answer, status))| Answer {
                url: url.clone(),
                answer: *answer,
                status: *status,
            })
            .collect()
    }
}

/// The page, as measuring sees it: a place to run a script that returns a
/// string, which comes back as that string (None when it did not answer).
pub trait Page {
    fn run(&self, script: String) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
}

/// What a poll of a page being measured came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Progress {
    /// Still measuring: the steps run and how many pressed.
    Measuring { steps: u32, presses: u32 },
    /// Done: what the page was answered.
    Finished(Observations),
}

/// The measuring of one page.
pub struct Measuring {
    step: String,
    key: String,
    log: ActivityLog,
    started: Option<Instant>,
    last_step: Option<Instant>,
    ending: Option<(End, Instant)>,
    steps: u32,
    presses: u32,
    answers: Answers,
    /// The page dropped answers over its limit, or of too long addresses.
    dropped: bool,
    /// The page's handle did not answer.
    silent: bool,
    last_note: Option<String>,
}

impl Measuring {
    /// Measuring with the importer's `step`, whose watching script's handle is `key`.
    pub fn new(step: String, key: String, log: ActivityLog) -> Result<Self, String> {
        if step.trim().is_empty() || step.len() > MAX_STEP_CHARS {
            return Err("The importer's page measuring step is not usable.".to_owned());
        }
        Ok(Self {
            step,
            key,
            log,
            started: None,
            last_step: None,
            ending: None,
            steps: 0,
            presses: 0,
            answers: Answers::default(),
            dropped: false,
            silent: false,
            last_note: None,
        })
    }

    /// The watching script for the page.
    pub fn watch_script(&self) -> String {
        watch_script(&self.key)
    }

    fn progress(&self) -> Progress {
        Progress::Measuring {
            steps: self.steps,
            presses: self.presses,
        }
    }

    /// Takes what waits in the page, a few batches at most.
    async fn drain(&mut self, page: &impl Page) {
        for _ in 0..(MAX_ANSWERS / TAKE + 2) {
            let Some(taken) = page
                .run(take_script(&self.key, TAKE))
                .await
                .and_then(|text| serde_json::from_str::<Taken>(&text).ok())
            else {
                return;
            };
            self.dropped |= taken.dropped > 0;
            for raw in taken.answers.iter().take(TAKE) {
                self.answers.add(raw);
            }
            if !taken.more {
                return;
            }
        }
    }

    /// Whether the page has settled; a page whose handle does not answer
    /// counts as settled, as nothing can be told.
    async fn settled(&mut self, page: &impl Page) -> bool {
        match page
            .run(state_script(&self.key))
            .await
            .and_then(|text| serde_json::from_str::<PageState>(&text).ok())
        {
            Some(state) => state.settled(),
            None => {
                if !self.silent {
                    self.silent = true;
                    self.log.warn(
                        Area::Import,
                        "Measuring the map picture from the page: the watching script in the page did not answer, so this app cannot tell when the page has finished loading",
                    );
                }
                true
            }
        }
    }

    /// One poll at `now`: a step when it is time for one, or the end.
    pub async fn advance(
        &mut self,
        page: &impl Page,
        now: Instant,
        size: Option<(u32, u32)>,
    ) -> Progress {
        let started = match self.started {
            Some(started) => started,
            None => {
                self.started = Some(now);
                self.log.info(
                    Area::Import,
                    format!(
                        "Measuring the map picture from the page: started{}; the importer's script runs at most {MAX_STEPS} times within {} s, each time once the page's own requests have settled (none open and none for {} s, or none for {} s; at most {} s of waiting)",
                        size.map_or_else(String::new, |(width, height)| format!(", in a window of {width} x {height}")),
                        MAX_TIME.as_secs(),
                        SETTLED.as_secs_f64(),
                        SETTLED_OPEN.as_secs(),
                        SETTLE_MAX.as_secs(),
                    ),
                );
                now
            }
        };
        self.drain(page).await;
        let settled = self.settled(page).await;
        if let Some((end, at)) = self.ending {
            if settled || now.duration_since(at) >= SETTLE_MAX {
                self.drain(page).await;
                return Progress::Finished(self.finish(end, now));
            }
            return self.progress();
        }
        if self.steps >= MAX_STEPS {
            self.ending = Some((End::Steps, now));
            return self.progress();
        }
        if now.duration_since(started) >= MAX_TIME {
            self.ending = Some((End::Time, now));
            return self.progress();
        }
        let waited = now.duration_since(self.last_step.unwrap_or(started));
        if !settled && waited < SETTLE_MAX {
            return self.progress();
        }
        let answer = page
            .run(step_script(&self.step, self.steps, self.presses))
            .await
            .and_then(|text| serde_json::from_str::<StepAnswer>(&text).ok());
        self.steps += 1;
        self.last_step = Some(now);
        let line = match &answer {
            None => "the page did not answer".to_owned(),
            Some(answer) => {
                if answer.pressed {
                    self.presses += 1;
                }
                let note = answer.note.as_deref().map(|note| {
                    activity::clean(note)
                        .chars()
                        .take(NOTE_CHARS)
                        .collect::<String>()
                });
                if note.is_some() {
                    self.last_note.clone_from(&note);
                }
                format!(
                    "{}{}{}",
                    if answer.pressed {
                        "pressed the page's zoom control"
                    } else {
                        "pressed nothing"
                    },
                    if answer.done { ", and is done" } else { "" },
                    note.map_or_else(String::new, |note| format!(
                        " (the importer's note: {note})"
                    )),
                )
            }
        };
        self.log.info(
            Area::Import,
            format!(
                "Measuring the map picture from the page, step {} of at most {MAX_STEPS}: {line}{}",
                self.steps,
                if settled {
                    ""
                } else {
                    "; the page's requests had not settled after 10 s"
                }
            ),
        );
        if answer.is_some_and(|answer| answer.done) {
            self.ending = Some((End::Done, now));
        }
        self.progress()
    }

    /// The person closed the window: what was taken so far.
    pub fn closed(&mut self, now: Instant) -> Observations {
        self.finish(End::Closed, now)
    }

    fn finish(&mut self, end: End, now: Instant) -> Observations {
        let overflow = self.answers.overflow || self.dropped;
        let why = match end {
            End::Done => "the importer's script said it was done",
            End::Steps => "the step limit was reached",
            End::Time => "the time limit was reached",
            End::Closed => "the page window was closed, so what the page loaded until then is used",
        };
        let seconds = self
            .started
            .map_or(0, |started| now.duration_since(started).as_secs());
        self.log.info(
            Area::Import,
            format!(
                "Measuring the map picture from the page ended after {} steps and {} presses, in {seconds} s: {why}. The page's own requests were answered for {} addresses: {} with an image, {} \"not there\" (404 or 410), {} with a store's \"access denied\" document, {} otherwise{}{}. The importer decides which of them are map images of this map",
                self.steps,
                self.presses,
                self.answers.by_address.len(),
                self.answers.count(Kind::Image),
                self.answers.count(Kind::Missing),
                self.answers.count(Kind::Denied),
                self.answers.count(Kind::Error),
                if overflow {
                    format!("; more addresses than {MAX_ANSWERS}, or longer ones, were not recorded")
                } else {
                    String::new()
                },
                self.last_note
                    .as_deref()
                    .map_or_else(String::new, |note| format!(" | the importer's last note: {note}")),
            ),
        );
        Observations {
            answers: self.answers.list(),
            overflow,
            steps: self.steps,
            presses: self.presses,
            ended: end,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;
    use std::{
        collections::VecDeque,
        fs,
        sync::{Arc, Mutex},
    };

    const KEY: &str = "__atlasMeasure1";
    const STEP: &str = "function (state) { return { done: state.step >= 2, pressed: true }; }";
    const JPEG: &str = "ffd8ffe000104a464946";
    const XML_DENIED: &str =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>";

    /// A made-up page: answers `state` and `take` from what the test puts
    /// in, and the step by counting.
    #[derive(Default)]
    struct FakePage {
        /// Answers waiting to be taken.
        waiting: Mutex<VecDeque<serde_json::Value>>,
        /// What `state` answers: open requests and quiet milliseconds.
        state: Mutex<Option<(u32, u64)>>,
        /// What each step answers, in turn; then "not done".
        steps: Mutex<VecDeque<Option<serde_json::Value>>>,
        /// Every script run, in order.
        ran: Mutex<Vec<String>>,
        dropped: Mutex<u64>,
    }

    impl FakePage {
        fn settled() -> Arc<Self> {
            let page = Arc::new(Self::default());
            *page.state.lock().unwrap() = Some((0, 5000));
            page
        }

        fn answer(&self, value: serde_json::Value) {
            self.waiting.lock().unwrap().push_back(value);
        }

        fn ran(&self, part: &str) -> usize {
            self.ran
                .lock()
                .unwrap()
                .iter()
                .filter(|script| script.contains(part))
                .count()
        }
    }

    impl Page for Arc<FakePage> {
        fn run(&self, script: String) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            self.ran.lock().unwrap().push(script.clone());
            let answer = if script.contains("handle.state()") {
                self.state.lock().unwrap().map(|(open, quiet)| {
                    serde_json::json!({ "open": open, "quietMs": quiet }).to_string()
                })
            } else if let Some(count) = script
                .split("handle.take(")
                .nth(1)
                .and_then(|rest| rest.split(')').next())
                .and_then(|count| count.parse::<usize>().ok())
            {
                let mut waiting = self.waiting.lock().unwrap();
                let taken: Vec<_> = (0..count).filter_map(|_| waiting.pop_front()).collect();
                Some(
                    serde_json::json!({ "answers": taken, "more": !waiting.is_empty(), "dropped": *self.dropped.lock().unwrap() })
                        .to_string(),
                )
            } else {
                self.steps
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| {
                        Some(serde_json::json!({ "done": false, "pressed": false, "note": null }))
                    })
                    .map(|value| value.to_string())
            };
            Box::pin(async move { answer })
        }
    }

    fn log(dir: &TempDir) -> ActivityLog {
        ActivityLog::new(dir.0.join("logs"), "Atlas", "0.4.0")
    }

    fn logged(dir: &TempDir) -> String {
        fs::read_to_string(dir.0.join("logs").join(crate::activity::LOG_FILE)).unwrap_or_default()
    }

    fn measuring(dir: &TempDir) -> Measuring {
        Measuring::new(STEP.to_owned(), KEY.to_owned(), log(dir)).unwrap()
    }

    fn raw(url: &str, status: u16, head: Option<&str>) -> serde_json::Value {
        serde_json::json!({ "url": url, "status": status, "type": "", "head": head, "body": null })
    }

    #[test]
    fn scripts_watch_and_never_request_anything() {
        let script = watch_script(KEY);
        assert!(script.contains(r#"var KEY = "__atlasMeasure1";"#));
        assert!(script.contains("var MAX_ANSWERS = 4000;"));
        assert!(script.contains("var MAX_ADDRESS = 512;"));
        assert!(script.contains("var MAX_BODY = 2048;"));
        // The shared wrappers and error readers.
        assert!(script.contains(WRAPPERS) && script.contains(ERROR_ANSWERS));
        assert!(script.contains("originalFetch.apply(this, arguments)"));
        assert!(script.contains("originalSend.apply(this, arguments)"));
        // Only the start of an answer is read, from a copy; the query is left out.
        assert!(script.contains("var copy = response.clone();"));
        assert!(script.contains("parsed.origin + parsed.pathname"));
        for forbidden in [
            "originalFetch(",
            "new XHR(",
            "new Image",
            "createElement",
            ".src =",
            "sendBeacon(",
            "location.assign",
            "location.href =",
            "setRequestHeader",
            "click(",
            "dispatchEvent",
            "scroll",
            "localStorage",
            "sessionStorage",
            "document.cookie",
            "arrayBuffer().then(function (buffer) { keep",
        ] {
            assert!(!script.contains(forbidden), "{forbidden}");
        }
        assert!(state_script(KEY).contains(r#"window["__atlasMeasure1"]"#));
        assert!(take_script(KEY, 7).contains("handle.take(7)"));
        let step = step_script(STEP, 3, 2);
        assert!(step.contains(&format!("({STEP})({{ step: 3, presses: 2 }})")));
        assert!(step.contains("catch (error)"));
    }

    #[test]
    fn classifies_answers_by_the_downloaders_rules() {
        let kind = |status, content_type: &str, head: Option<&str>, body: Option<&str>| {
            classify(&Raw {
                url: "https://tiles.example.com/1/0/0.jpg".to_owned(),
                status,
                content_type: content_type.to_owned(),
                head: head.map(str::to_owned),
                body: body.map(str::to_owned),
            })
        };
        assert_eq!(kind(200, "image/jpeg", Some(JPEG), None), Kind::Image);
        assert_eq!(kind(200, "", Some("89504e470d0a1a0a"), None), Kind::Image);
        assert_eq!(
            kind(200, "", Some("524946460000000057454250"), None),
            Kind::Image
        );
        assert_eq!(kind(206, "", Some(JPEG), None), Kind::Image);
        // Bytes that are not an image, whatever the answer says.
        assert_eq!(
            kind(200, "image/jpeg", Some("3c68746d6c3e"), None),
            Kind::Error
        );
        assert_eq!(kind(200, "image/jpeg", Some(""), None), Kind::Error);
        assert_eq!(kind(200, "image/jpeg", Some("zz"), None), Kind::Error);
        // Bytes the page could not read: the type says.
        assert_eq!(kind(200, " Image/PNG", None, None), Kind::Image);
        assert_eq!(kind(200, "text/html", None, None), Kind::Error);
        assert_eq!(kind(404, "", None, None), Kind::Missing);
        assert_eq!(kind(410, "", None, None), Kind::Missing);
        assert_eq!(
            kind(403, "application/xml", None, Some(XML_DENIED)),
            Kind::Denied
        );
        assert_eq!(kind(403, "text/html", None, Some(XML_DENIED)), Kind::Error);
        assert_eq!(kind(403, "application/xml", None, None), Kind::Error);
        assert_eq!(
            kind(
                403,
                "application/xml",
                None,
                Some("<Error><Code>Other</Code></Error>")
            ),
            Kind::Error
        );
        for status in [0, 304, 401, 429, 500, 503] {
            assert_eq!(
                kind(status, "image/jpeg", Some(JPEG), None),
                Kind::Error,
                "{status}"
            );
        }
    }

    #[test]
    fn keeps_each_address_once_without_query_and_within_bounds() {
        let mut answers = Answers::default();
        let add = |answers: &mut Answers, url: &str, status, head: Option<&str>| {
            answers.add(&Raw {
                url: url.to_owned(),
                status,
                content_type: String::new(),
                head: head.map(str::to_owned),
                body: None,
            });
        };
        add(
            &mut answers,
            "https://tiles.example.com/1/0/0.jpg?token=x",
            0,
            None,
        );
        add(
            &mut answers,
            "https://tiles.example.com/1/0/0.jpg#y",
            200,
            Some(JPEG),
        );
        add(
            &mut answers,
            "https://tiles.example.com/1/0/0.jpg",
            404,
            None,
        );
        add(
            &mut answers,
            "https://tiles.example.com:443/1/1/0.jpg",
            404,
            None,
        );
        add(
            &mut answers,
            "https://tiles.example.com/1/1/0.jpg",
            500,
            None,
        );
        for bad in [
            "file:///etc/passwd",
            "https://me:secret@tiles.example.com/1/0/1.jpg",
            "javascript:alert(1)",
            "nonsense",
        ] {
            add(&mut answers, bad, 200, Some(JPEG));
        }
        assert_eq!(
            answers.list(),
            [
                Answer {
                    url: "https://tiles.example.com/1/0/0.jpg".to_owned(),
                    answer: Kind::Image,
                    status: 200,
                },
                Answer {
                    url: "https://tiles.example.com/1/1/0.jpg".to_owned(),
                    answer: Kind::Missing,
                    status: 404,
                },
            ]
        );
        assert!(!answers.overflow);
        add(
            &mut answers,
            &format!(
                "https://tiles.example.com/{}",
                "a".repeat(MAX_ADDRESS_CHARS)
            ),
            200,
            None,
        );
        assert!(answers.overflow);

        let mut many = Answers::default();
        for i in 0..=MAX_ANSWERS {
            add(
                &mut many,
                &format!("https://tiles.example.com/9/{i}/0.jpg"),
                404,
                None,
            );
        }
        assert_eq!(many.list().len(), MAX_ANSWERS);
        assert!(many.overflow);
    }

    #[tokio::test]
    async fn steps_after_the_page_settles_until_the_script_is_done() {
        let dir = TempDir::new("pagemeasure-done");
        let mut measuring = measuring(&dir);
        let page = FakePage::settled();
        page.answer(raw(
            "https://tiles.example.com/2/1/1.jpg?v=3",
            200,
            Some(JPEG),
        ));
        page.answer(raw("https://tiles.example.com/2/0/1.jpg", 404, None));
        page.answer(serde_json::json!({
            "url": "https://tiles.example.com/2/2/1.jpg", "status": 403,
            "type": "application/xml", "head": null, "body": XML_DENIED
        }));
        *page.steps.lock().unwrap() = VecDeque::from([
            Some(serde_json::json!({ "done": false, "pressed": true, "note": "zoom 3" })),
            Some(
                serde_json::json!({ "done": true, "pressed": false, "note": "the button is disabled" }),
            ),
        ]);
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        assert_eq!(
            measuring.advance(&page, at(0), Some((1600, 1000))).await,
            Progress::Measuring {
                steps: 1,
                presses: 1
            }
        );
        assert_eq!(
            measuring.advance(&page, at(2), None).await,
            Progress::Measuring {
                steps: 2,
                presses: 1
            }
        );
        // Done: the next poll waits for the page to settle, then hands over.
        page.answer(raw("https://tiles.example.com/2/1/2.jpg", 200, Some(JPEG)));
        let Progress::Finished(observed) = measuring.advance(&page, at(4), None).await else {
            panic!("not finished");
        };
        assert_eq!(observed.steps, 2);
        assert_eq!(observed.presses, 1);
        assert_eq!(observed.ended, End::Done);
        assert!(!observed.overflow);
        let kinds: Vec<_> = observed
            .answers
            .iter()
            .map(|a| (a.url.as_str(), a.answer))
            .collect();
        assert_eq!(
            kinds,
            [
                ("https://tiles.example.com/2/0/1.jpg", Kind::Missing),
                ("https://tiles.example.com/2/1/1.jpg", Kind::Image),
                ("https://tiles.example.com/2/1/2.jpg", Kind::Image),
                ("https://tiles.example.com/2/2/1.jpg", Kind::Denied),
            ]
        );
        // Handed over as the web app expects it.
        let json = serde_json::to_value(&observed).unwrap();
        assert_eq!(json["ended"], "done");
        assert_eq!(json["answers"][0]["answer"], "missing");
        assert_eq!(json["answers"][0]["status"], 404);
        let log = logged(&dir);
        assert!(
            log.contains(
                "Measuring the map picture from the page: started, in a window of 1600 x 1000"
            ),
            "{log}"
        );
        assert!(log.contains("step 1 of at most 20: pressed the page's zoom control (the importer's note: zoom 3)"), "{log}");
        assert!(log.contains("step 2 of at most 20: pressed nothing, and is done (the importer's note: the button is disabled)"), "{log}");
        assert!(
            log.contains(
                "ended after 2 steps and 1 presses, in 4 s: the importer's script said it was done"
            ),
            "{log}"
        );
        assert!(log.contains("answered for 4 addresses: 2 with an image, 1 \"not there\" (404 or 410), 1 with a store's \"access denied\" document, 0 otherwise"), "{log}");
        assert!(!log.contains("v=3"), "no query is logged");
    }

    #[tokio::test]
    async fn waits_for_the_page_to_settle_but_not_forever() {
        let dir = TempDir::new("pagemeasure-settle");
        let mut measuring = measuring(&dir);
        let page = Arc::new(FakePage::default());
        // Requests open and the page busy.
        *page.state.lock().unwrap() = Some((2, 100));
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        for ms in [0, 2000, 9000] {
            assert_eq!(
                measuring.advance(&page, at(ms), None).await,
                Progress::Measuring {
                    steps: 0,
                    presses: 0
                }
            );
        }
        assert_eq!(page.ran("({ step:"), 0);
        // After 10 s the step runs anyway, and the log says so.
        assert_eq!(
            measuring.advance(&page, at(10_000), None).await,
            Progress::Measuring {
                steps: 1,
                presses: 0
            }
        );
        assert!(logged(&dir).contains("had not settled after 10 s"));
        // Quiet for 1.5 s with nothing open, or 5 s with something open, is settled.
        assert!(PageState {
            open: 0,
            quiet_ms: 1500
        }
        .settled());
        assert!(!PageState {
            open: 1,
            quiet_ms: 4999
        }
        .settled());
        assert!(PageState {
            open: 1,
            quiet_ms: 5000
        }
        .settled());
        assert!(!PageState {
            open: 0,
            quiet_ms: 1499
        }
        .settled());
    }

    #[tokio::test]
    async fn stops_at_the_step_limit() {
        let dir = TempDir::new("pagemeasure-steps");
        let mut measuring = measuring(&dir);
        let page = FakePage::settled();
        // A step that presses every time and is never done.
        *page.steps.lock().unwrap() = (0..100)
            .map(|_| Some(serde_json::json!({ "done": false, "pressed": true, "note": null })))
            .collect();
        let start = Instant::now();
        let mut finished = None;
        for poll in 0..40u64 {
            if let Progress::Finished(observed) = measuring
                .advance(&page, start + Duration::from_secs(poll), None)
                .await
            {
                finished = Some(observed);
                break;
            }
        }
        let observed = finished.expect("finished");
        assert_eq!((observed.steps, observed.presses), (MAX_STEPS, MAX_STEPS));
        assert_eq!(observed.ended, End::Steps);
        assert_eq!(page.ran("({ step:"), MAX_STEPS as usize);
        assert!(logged(&dir).contains("the step limit was reached"));
    }

    #[tokio::test]
    async fn stops_at_the_time_limit_and_counts_unanswered_steps() {
        let dir = TempDir::new("pagemeasure-time");
        let mut measuring = measuring(&dir);
        let page = FakePage::settled();
        *page.steps.lock().unwrap() = VecDeque::from([None, None]);
        let start = Instant::now();
        assert_eq!(
            measuring.advance(&page, start, None).await,
            Progress::Measuring {
                steps: 1,
                presses: 0
            }
        );
        assert!(logged(&dir).contains("step 1 of at most 20: the page did not answer"));
        assert_eq!(
            measuring.advance(&page, start + MAX_TIME, None).await,
            Progress::Measuring {
                steps: 1,
                presses: 0
            }
        );
        let Progress::Finished(observed) = measuring
            .advance(&page, start + MAX_TIME + Duration::from_secs(2), None)
            .await
        else {
            panic!("not finished");
        };
        assert_eq!(observed.ended, End::Time);
        assert_eq!(page.ran("({ step:"), 1);
        assert!(logged(&dir).contains("the time limit was reached"));
    }

    #[tokio::test]
    async fn hands_over_what_was_seen_when_the_window_is_closed() {
        let dir = TempDir::new("pagemeasure-closed");
        let mut measuring = measuring(&dir);
        let page = FakePage::settled();
        page.answer(raw("https://tiles.example.com/2/1/1.jpg", 200, Some(JPEG)));
        *page.dropped.lock().unwrap() = 3;
        let start = Instant::now();
        measuring.advance(&page, start, None).await;
        let observed = measuring.closed(start + Duration::from_secs(1));
        assert_eq!(observed.ended, End::Closed);
        assert_eq!(observed.answers.len(), 1);
        assert!(observed.overflow, "the page dropped answers");
        assert!(logged(&dir).contains("the page window was closed"));
    }

    #[tokio::test]
    async fn a_page_whose_handle_is_gone_still_ends() {
        let dir = TempDir::new("pagemeasure-silent");
        let mut measuring = measuring(&dir);
        let page = Arc::new(FakePage::default());
        *page.steps.lock().unwrap() = VecDeque::from([Some(
            serde_json::json!({ "done": true, "pressed": false, "note": null }),
        )]);
        let start = Instant::now();
        assert_eq!(
            measuring.advance(&page, start, None).await,
            Progress::Measuring {
                steps: 1,
                presses: 0
            }
        );
        let Progress::Finished(observed) = measuring.advance(&page, start, None).await else {
            panic!("not finished");
        };
        assert!(observed.answers.is_empty());
        assert!(logged(&dir).contains("the watching script in the page did not answer"));
    }

    #[test]
    fn refuses_an_unusable_step() {
        let dir = TempDir::new("pagemeasure-refuse");
        assert!(Measuring::new(String::new(), KEY.to_owned(), log(&dir)).is_err());
        assert!(Measuring::new(" ".repeat(3), KEY.to_owned(), log(&dir)).is_err());
        assert!(Measuring::new("x".repeat(MAX_STEP_CHARS + 1), KEY.to_owned(), log(&dir)).is_err());
    }
}
