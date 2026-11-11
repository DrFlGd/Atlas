//! The scripts that run in the map page window while "Save map images as I
//! browse" is on.
//!
//! One script is added to the page before the page's own scripts run (an
//! initialisation script). It only watches; it never makes a request:
//!
//! - It wraps `fetch` and `XMLHttpRequest` so that, when a `GET` request the
//!   page made itself to an address that starts like one of the pack's
//!   remote map image addresses has been answered with status 200, a copy of
//!   the answer's body is kept: `Response.clone()` for `fetch`, the finished
//!   `response` for an `XMLHttpRequest` that asked for binary data. The
//!   page's own call, its arguments and its answer are passed through
//!   unchanged; nothing is added to or changed in the request.
//! - Answers whose bytes the page cannot read (`no-cors` requests), text
//!   answers and anything over the limits are not kept but noted, with the
//!   address, so the person can be told.
//! - Images the page loads with `<img>` elements or style sheets cannot be
//!   read without asking the server again, so they are only noted, from the
//!   page's resource timing list (a `PerformanceObserver`). Requests made
//!   inside web workers are not visible to the page at all; the script notes
//!   that the page started a worker, so the person can be told.
//! - Kept bodies wait in the page as base64 text, at most `MAX_IMAGE_BYTES`
//!   each and `MAX_QUEUED_CHARS` in all; more is noted as "too busy".
//!
//! The shell takes them out from the Rust side with `eval_with_callback`, as
//! the import window does: `next` lists what waits (whole small items and
//! the sizes of large ones), `slice` hands over part of a large item, `drop`
//! forgets items the shell has taken, and `off` stops keeping anything. The
//! page cannot send anything to the app; everything it hands over is
//! checked by the shell (`capture.rs`).

use serde::Deserialize;

use super::capture::MAX_IMAGE_BYTES;

/// Base64 text waiting in the page, at most (about 48 MB of images).
pub const MAX_QUEUED_CHARS: usize = 64 << 20;
/// Notes the page keeps between two looks by the shell, at most.
const MAX_NOTES: usize = 2000;

/// The script added to the page. `key` is the hidden name of its handle,
/// `prefixes` the fixed starts of the pack's remote image addresses.
pub fn capture_script(key: &str, prefixes: &[String]) -> String {
    let key = serde_json::to_string(key).expect("a string serialises");
    let prefixes = serde_json::to_string(prefixes).expect("strings serialise");
    format!(
        r#"(function () {{
  'use strict';
  var KEY = {key};
  if (window !== window.top || Object.prototype.hasOwnProperty.call(window, KEY)) return;
  var PREFIXES = {prefixes};
  var MAX_IMAGE = {MAX_IMAGE_BYTES};
  var MAX_QUEUED = {MAX_QUEUED_CHARS};
  var MAX_NOTES = {MAX_NOTES};
  var on = true;
  var queue = [];
  var queuedChars = 0;
  var nextId = 1;
  var kept = new Set();
  var notes = [];
  var workers = false;

  function absolute(input) {{
    try {{ return new URL(String(input), document.baseURI || location.href).href; }} catch (e) {{ return null; }}
  }}
  function wanted(url) {{
    if (!on || !url) return false;
    for (var i = 0; i < PREFIXES.length; i++) if (url.indexOf(PREFIXES[i]) === 0) return true;
    return false;
  }}
  function note(url, reason) {{
    if (on && notes.length < MAX_NOTES) notes.push({{ url: url, reason: reason }});
  }}
  function toBase64(buffer) {{
    var bytes = new Uint8Array(buffer);
    var parts = [];
    for (var i = 0; i < bytes.length; i += 0x8000) {{
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }}
    return btoa(parts.join(''));
  }}
  function keep(url, buffer) {{
    if (!on || kept.has(url) || !buffer) return;
    if (buffer.byteLength === 0) {{ note(url, 'notImage'); return; }}
    if (buffer.byteLength > MAX_IMAGE) {{ note(url, 'tooLarge'); return; }}
    if (queuedChars + Math.ceil(buffer.byteLength / 3) * 4 > MAX_QUEUED) {{ note(url, 'busy'); return; }}
    var data;
    try {{ data = toBase64(buffer); }} catch (e) {{ note(url, 'unreadable'); return; }}
    if (kept.size > 200000) kept.clear();
    kept.add(url);
    queue.push({{ id: nextId++, url: url, data: data }});
    queuedChars += data.length;
  }}
  function fromResponse(url, response) {{
    try {{
      if (!on || !response) return;
      if (response.type === 'opaque' || response.type === 'opaqueredirect') {{ note(url, 'hidden'); return; }}
      if (response.status !== 200) return;
      var length = Number(response.headers.get('content-length'));
      if (length > MAX_IMAGE) {{ note(url, 'tooLarge'); return; }}
      response.clone().arrayBuffer().then(function (buffer) {{ keep(url, buffer); }}, function () {{ note(url, 'unreadable'); }});
    }} catch (e) {{ note(url, 'unreadable'); }}
  }}

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {{
    window.fetch = function fetch(input, init) {{
      var answer = originalFetch.apply(this, arguments);
      try {{
        var isRequest = typeof Request === 'function' && input instanceof Request;
        var method = (init && init.method) || (isRequest ? input.method : 'GET');
        var url = absolute(isRequest ? input.url : input);
        if (String(method).toUpperCase() === 'GET' && wanted(url) && answer && typeof answer.then === 'function') {{
          answer.then(function (response) {{ fromResponse(url, response); }}, function () {{}});
        }}
      }} catch (e) {{}}
      return answer;
    }};
  }}

  var XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function' && XHR.prototype) {{
    var requests = new WeakMap();
    var originalOpen = XHR.prototype.open;
    var originalSend = XHR.prototype.send;
    XHR.prototype.open = function open(method, url) {{
      try {{ requests.set(this, {{ method: String(method).toUpperCase(), url: absolute(url) }}); }} catch (e) {{}}
      return originalOpen.apply(this, arguments);
    }};
    XHR.prototype.send = function send() {{
      try {{
        var request = requests.get(this);
        if (request && request.method === 'GET' && wanted(request.url)) {{
          var xhr = this;
          xhr.addEventListener('load', function () {{
            try {{
              if (!on || xhr.status !== 200) return;
              var type = xhr.responseType;
              if (type === 'arraybuffer') keep(request.url, xhr.response);
              else if (type === 'blob' && xhr.response && typeof xhr.response.arrayBuffer === 'function') {{
                if (xhr.response.size > MAX_IMAGE) {{ note(request.url, 'tooLarge'); return; }}
                xhr.response.arrayBuffer().then(function (buffer) {{ keep(request.url, buffer); }}, function () {{ note(request.url, 'unreadable'); }});
              }} else note(request.url, 'text');
            }} catch (e) {{ note(request.url, 'unreadable'); }}
          }});
        }}
      }} catch (e) {{}}
      return originalSend.apply(this, arguments);
    }};
  }}

  try {{
    var observer = new PerformanceObserver(function (list) {{
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {{
        var kind = entries[i].initiatorType;
        if (kind === 'fetch' || kind === 'xmlhttprequest' || kind === 'beacon') continue;
        var url = absolute(entries[i].name);
        if (wanted(url)) note(url, 'element');
      }}
    }});
    try {{ observer.observe({{ type: 'resource', buffered: true }}); }}
    catch (e) {{ observer.observe({{ entryTypes: ['resource'] }}); }}
  }} catch (e) {{}}

  ['Worker', 'SharedWorker'].forEach(function (name) {{
    var Original = window[name];
    if (typeof Original !== 'function' || typeof Proxy !== 'function') return;
    try {{
      var proxy = new Proxy(Original, {{
        construct: function (target, args, newTarget) {{
          workers = true;
          return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
        }}
      }});
      window[name] = proxy;
    }} catch (e) {{}}
  }});

  function remove(ids) {{
    var gone = new Set(ids);
    queue = queue.filter(function (item) {{
      if (!gone.has(item.id)) return true;
      queuedChars -= item.data.length;
      return false;
    }});
  }}
  var handle = {{
    next: function (maxChars) {{
      var items = [], large = [], used = 0;
      for (var i = 0; i < queue.length && items.length + large.length < 200; i++) {{
        var item = queue[i];
        if (item.data.length > maxChars) {{ large.push({{ id: item.id, url: item.url, length: item.data.length }}); continue; }}
        if (used + item.data.length > maxChars) break;
        used += item.data.length;
        items.push({{ id: item.id, url: item.url, data: item.data }});
      }}
      var noted = notes;
      notes = [];
      return JSON.stringify({{ items: items, large: large, notSaved: noted, workers: workers, waiting: queue.length }});
    }},
    slice: function (id, start, count) {{
      for (var i = 0; i < queue.length; i++) {{
        if (queue[i].id === id) {{
          var end = Math.min(queue[i].data.length, start + count);
          return JSON.stringify({{ next: end, text: queue[i].data.slice(start, end) }});
        }}
      }}
      return null;
    }},
    drop: function (ids) {{ remove(ids); return 'ok'; }},
    off: function () {{ on = false; queue = []; queuedChars = 0; notes = []; kept.clear(); return 'ok'; }}
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

/// Lists what waits in the page, with whole items up to `max_chars`.
pub fn next_script(key: &str, max_chars: usize) -> String {
    call(key, &format!("next({max_chars})"))
}

/// Part of one large item.
pub fn slice_script(key: &str, id: u64, start: usize, count: usize) -> String {
    call(key, &format!("slice({id}, {start}, {count})"))
}

/// Forgets items the shell has taken.
pub fn drop_script(key: &str, ids: &[u64]) -> String {
    let ids = serde_json::to_string(ids).expect("numbers serialise");
    call(key, &format!("drop({ids})"))
}

/// Stops keeping anything and frees what waits.
pub fn off_script(key: &str) -> String {
    call(key, "off()")
}

/// An image the page kept, whole.
#[derive(Debug, Deserialize)]
pub struct Item {
    pub id: u64,
    pub url: String,
    pub data: String,
}

/// An image too large to come in one piece.
#[derive(Debug, Deserialize)]
pub struct LargeItem {
    pub id: u64,
    pub url: String,
    pub length: usize,
}

/// Why the page could not keep an image.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum NoteReason {
    /// Loaded by an `<img>` element or a style sheet.
    Element,
    /// A `no-cors` answer, whose bytes the page cannot read.
    Hidden,
    /// Read as text, so the bytes are lost.
    Text,
    Unreadable,
    TooLarge,
    NotImage,
    /// Too much was waiting in the page.
    Busy,
}

#[derive(Debug, Deserialize)]
pub struct Note {
    pub url: String,
    pub reason: NoteReason,
}

/// What `next` returns.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub items: Vec<Item>,
    pub large: Vec<LargeItem>,
    pub not_saved: Vec<Note>,
    pub workers: bool,
}

/// What `slice` returns.
#[derive(Debug, Deserialize)]
pub struct Slice {
    pub next: usize,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_name_the_handle_and_never_request_anything() {
        let script = capture_script(
            "__atlasView1",
            &["https://tiles.example.com/w/".to_owned(), "a\"b".to_owned()],
        );
        assert!(script.contains(r#"var KEY = "__atlasView1";"#));
        assert!(script.contains(r#"["https://tiles.example.com/w/","a\"b"]"#));
        // Watching only: no request is ever started by the script itself.
        for forbidden in [
            "originalFetch(",
            "new XHR(",
            "new Image",
            "createElement",
            ".src =",
            "sendBeacon(",
            "location.",
            "setRequestHeader",
            "click(",
            "dispatchEvent",
            "scroll",
        ] {
            assert!(
                !script.replace("location.href", "").contains(forbidden),
                "{forbidden}"
            );
        }
        // The page's own calls go through unchanged.
        assert!(script.contains("originalFetch.apply(this, arguments)"));
        assert!(script.contains("originalOpen.apply(this, arguments)"));
        assert!(script.contains("originalSend.apply(this, arguments)"));
        assert!(script.contains("response.clone().arrayBuffer()"));
        assert!(next_script("__atlasView1", 10).contains(r#"window["__atlasView1"]"#));
        assert!(next_script("__atlasView1", 10).contains("handle.next(10)"));
        assert!(slice_script("k", 3, 5, 7).contains("handle.slice(3, 5, 7)"));
        assert!(drop_script("k", &[1, 2]).contains("handle.drop([1,2])"));
        assert!(off_script("k").contains("handle.off()"));
    }

    #[test]
    fn reads_batches() {
        let batch: Batch = serde_json::from_str(
            r#"{"items":[{"id":1,"url":"https://t.example.com/1/0/0.png","data":"TWFu"}],
                "large":[{"id":2,"url":"https://t.example.com/1/1/0.png","length":9000000}],
                "notSaved":[{"url":"https://t.example.com/1/0/1.png","reason":"element"}],
                "workers":true,"waiting":2}"#,
        )
        .unwrap();
        assert_eq!(batch.items[0].id, 1);
        assert_eq!(batch.large[0].length, 9_000_000);
        assert_eq!(batch.not_saved[0].reason, NoteReason::Element);
        assert!(batch.workers);
        assert!(serde_json::from_str::<Batch>(
            r#"{"items":[],"large":[],"notSaved":[{"url":"x","reason":"pwned"}],"workers":false}"#
        )
        .is_err());
    }
}
