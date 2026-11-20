//! Linux only: what the web view needs before it starts.
//!
//! Atlas draws its window with WebKitGTK. Its newer way of drawing (the
//! DMA-BUF renderer, WebKitGTK 2.42 and later) leaves the window blank or
//! white on some systems: under gamescope, the compositor of Game Mode on
//! a Steam Deck, and with some graphics drivers. WebKitGTK reads
//! `WEBKIT_DISABLE_DMABUF_RENDERER` when it starts and then draws the older
//! way, which works there. So Atlas sets it at its start, before any
//! window or thread exists, unless the person set it already: a value the
//! person set (even `0`) is theirs and is left as it is.
//!
//! `WEBKIT_DISABLE_COMPOSITING_MODE=1` is not set: it turns off drawing
//! with the graphics chip altogether, which makes moving and zooming the
//! map slow, and it is not needed where the line above is enough. A person
//! whose window stays blank can still set it in the program's launch
//! options (see the README, "Atlas on Linux and the Steam Deck").

use std::ffi::OsString;

/// The variables Atlas sets at its start when they are not set, with
/// their values.
pub const WEBKIT_DEFAULTS: [(&str, &str); 1] = [("WEBKIT_DISABLE_DMABUF_RENDERER", "1")];

/// The variables of [`WEBKIT_DEFAULTS`] to set, given what is set now
/// (`now` reads one variable).
pub fn webkit_to_set(now: impl Fn(&str) -> Option<OsString>) -> Vec<(&'static str, &'static str)> {
    WEBKIT_DEFAULTS
        .iter()
        .copied()
        .filter(|(name, _)| now(name).is_none())
        .collect()
}

/// Sets the variables of [`WEBKIT_DEFAULTS`] that are not set, and says
/// which it set, for the activity log. Call it first thing in `run`, while
/// Atlas has no other thread: the environment must not change while
/// another thread reads it.
pub fn prepare_web_view() -> Vec<(&'static str, &'static str)> {
    let set = webkit_to_set(|name| std::env::var_os(name));
    for (name, value) in &set {
        std::env::set_var(name, value);
    }
    set
}

/// The activity log's line for what [`prepare_web_view`] did.
pub fn web_view_line(set: &[(&str, &str)]) -> String {
    if set.is_empty() {
        "The web view's settings for Linux were set already, so Atlas left them as they are"
            .to_owned()
    } else {
        let names: Vec<String> = set
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect();
        format!(
            "Set {} for the web view, so that its window is not blank under gamescope and some graphics drivers",
            names.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_what_is_not_set_and_leaves_what_the_person_set() {
        assert_eq!(
            webkit_to_set(|_| None),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        // Set by the person, to anything (even 0 or empty): left alone.
        for value in ["0", "1", ""] {
            assert!(webkit_to_set(
                |name| (name == "WEBKIT_DISABLE_DMABUF_RENDERER").then(|| OsString::from(value))
            )
            .is_empty());
        }
        // Another variable set changes nothing.
        assert_eq!(
            webkit_to_set(
                |name| (name == "WEBKIT_DISABLE_COMPOSITING_MODE").then(|| OsString::from("1"))
            ),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
    }

    #[test]
    fn says_what_it_did() {
        assert!(web_view_line(&[("WEBKIT_DISABLE_DMABUF_RENDERER", "1")])
            .starts_with("Set WEBKIT_DISABLE_DMABUF_RENDERER=1 for the web view"));
        assert!(web_view_line(&[]).contains("left them as they are"));
    }
}
