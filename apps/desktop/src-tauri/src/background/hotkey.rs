//! The hotkey that brings Atlas forward: reading and checking a key
//! combination, as the person presses it in Settings or as the settings
//! file keeps it, without the system.
//!
//! A combination is at least one of Ctrl, Alt, Shift or the Windows key and
//! one other key from [`KEYS`]. It is written as the person reads it
//! (`Ctrl+Alt+M`), modifiers first in that order. These are refused, each
//! with a sentence ([`check`]):
//!
//! - a key alone, or a modifier alone;
//! - Shift as the only modifier with a key that types or selects text in
//!   other programs (anything but F1 to F24);
//! - the combinations Windows keeps for itself ([`reserved`]): Ctrl+Alt+Delete,
//!   Ctrl+Shift+Esc, Ctrl+Esc, Alt+Tab, Alt+Esc, Alt+F4, Alt+Space, any
//!   combination with F12 (kept for debuggers), and the Windows key with
//!   fewer than two of Ctrl, Alt and Shift, since Windows uses nearly all of
//!   those.
//!
//! Whether the system takes a combination (another program may have it) is
//! known only when it is registered; see `shell.rs`.

use std::fmt;

/// The combination offered when the hotkey is first switched on.
pub const OFFERED: Hotkey = Hotkey {
    ctrl: true,
    alt: true,
    shift: false,
    win: false,
    key: Key("KeyM"),
};

/// The longest text of a combination that is read.
pub const MAX_TEXT_CHARS: usize = 64;

/// One key that is not a modifier, by its code (the W3C `KeyboardEvent.code`
/// the web view gives, which the system's hotkey takes as well).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key(&'static str);

/// The keys a hotkey can use: their code and the name a person reads.
pub const KEYS: &[(&str, &str)] = &[
    ("KeyA", "A"),
    ("KeyB", "B"),
    ("KeyC", "C"),
    ("KeyD", "D"),
    ("KeyE", "E"),
    ("KeyF", "F"),
    ("KeyG", "G"),
    ("KeyH", "H"),
    ("KeyI", "I"),
    ("KeyJ", "J"),
    ("KeyK", "K"),
    ("KeyL", "L"),
    ("KeyM", "M"),
    ("KeyN", "N"),
    ("KeyO", "O"),
    ("KeyP", "P"),
    ("KeyQ", "Q"),
    ("KeyR", "R"),
    ("KeyS", "S"),
    ("KeyT", "T"),
    ("KeyU", "U"),
    ("KeyV", "V"),
    ("KeyW", "W"),
    ("KeyX", "X"),
    ("KeyY", "Y"),
    ("KeyZ", "Z"),
    ("Digit0", "0"),
    ("Digit1", "1"),
    ("Digit2", "2"),
    ("Digit3", "3"),
    ("Digit4", "4"),
    ("Digit5", "5"),
    ("Digit6", "6"),
    ("Digit7", "7"),
    ("Digit8", "8"),
    ("Digit9", "9"),
    ("F1", "F1"),
    ("F2", "F2"),
    ("F3", "F3"),
    ("F4", "F4"),
    ("F5", "F5"),
    ("F6", "F6"),
    ("F7", "F7"),
    ("F8", "F8"),
    ("F9", "F9"),
    ("F10", "F10"),
    ("F11", "F11"),
    ("F12", "F12"),
    ("F13", "F13"),
    ("F14", "F14"),
    ("F15", "F15"),
    ("F16", "F16"),
    ("F17", "F17"),
    ("F18", "F18"),
    ("F19", "F19"),
    ("F20", "F20"),
    ("F21", "F21"),
    ("F22", "F22"),
    ("F23", "F23"),
    ("F24", "F24"),
    ("Numpad0", "Num 0"),
    ("Numpad1", "Num 1"),
    ("Numpad2", "Num 2"),
    ("Numpad3", "Num 3"),
    ("Numpad4", "Num 4"),
    ("Numpad5", "Num 5"),
    ("Numpad6", "Num 6"),
    ("Numpad7", "Num 7"),
    ("Numpad8", "Num 8"),
    ("Numpad9", "Num 9"),
    ("NumpadAdd", "Num Add"),
    ("NumpadSubtract", "Num Subtract"),
    ("NumpadMultiply", "Num Multiply"),
    ("NumpadDivide", "Num Divide"),
    ("NumpadDecimal", "Num Decimal"),
    ("Space", "Space"),
    ("Enter", "Enter"),
    ("Tab", "Tab"),
    ("Escape", "Esc"),
    ("Backspace", "Backspace"),
    ("Insert", "Insert"),
    ("Delete", "Delete"),
    ("Home", "Home"),
    ("End", "End"),
    ("PageUp", "Page Up"),
    ("PageDown", "Page Down"),
    ("ArrowUp", "Up"),
    ("ArrowDown", "Down"),
    ("ArrowLeft", "Left"),
    ("ArrowRight", "Right"),
    ("Minus", "-"),
    ("Equal", "="),
    ("BracketLeft", "["),
    ("BracketRight", "]"),
    ("Backslash", "\\"),
    ("Semicolon", ";"),
    ("Quote", "'"),
    ("Comma", ","),
    ("Period", "."),
    ("Slash", "/"),
    ("Backquote", "`"),
    ("PrintScreen", "Print Screen"),
    ("Pause", "Pause"),
    ("ScrollLock", "Scroll Lock"),
];

impl Key {
    /// The key with this code, if a hotkey can use it.
    pub fn from_code(code: &str) -> Option<Self> {
        KEYS.iter()
            .find(|(known, _)| *known == code)
            .map(|(known, _)| Key(known))
    }

    /// The key with this name as a person reads it, in any case.
    fn from_name(name: &str) -> Option<Self> {
        KEYS.iter()
            .find(|(_, shown)| shown.eq_ignore_ascii_case(name))
            .map(|(code, _)| Key(code))
    }

    pub fn code(self) -> &'static str {
        self.0
    }

    pub fn name(self) -> &'static str {
        KEYS.iter()
            .find(|(code, _)| *code == self.0)
            .map_or(self.0, |(_, name)| name)
    }

    fn is_function_key(self) -> bool {
        self.0.len() > 1
            && self.0.starts_with('F')
            && self.0[1..].chars().all(|c| c.is_ascii_digit())
    }
}

/// A key combination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hotkey {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The Windows key.
    pub win: bool,
    pub key: Key,
}

impl fmt::Display for Hotkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (held, name) in [
            (self.ctrl, "Ctrl"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
            (self.win, "Win"),
        ] {
            if held {
                write!(f, "{name}+")?;
            }
        }
        f.write_str(self.key.name())
    }
}

/// The keys as the web view gives them when the person presses them.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPress {
    pub code: String,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
    /// The Windows key (`metaKey` in the web view).
    #[serde(default)]
    pub win: bool,
}

/// Said when the keys pressed are not a combination Atlas can use.
pub const NEEDS_MODIFIER: &str =
    "Press at least one of Ctrl, Alt, Shift or the Windows key together with one other key.";
pub const UNKNOWN_KEY: &str =
    "Atlas cannot use this key for the hotkey. Press a letter, a digit or a function key with it.";
pub const SHIFT_ALONE: &str = "Shift alone with this key types or selects text in other programs. Add Ctrl, Alt or the Windows key, or use a function key such as F8.";
pub const WINDOWS_KEY: &str = "Windows keeps most combinations with the Windows key for itself. Add two of Ctrl, Alt and Shift, or leave the Windows key out.";
pub const F12: &str =
    "Windows keeps F12 for programs that look for errors in other programs. Choose another key.";

/// The combination the person pressed, checked.
pub fn from_press(press: &KeyPress) -> Result<Hotkey, String> {
    let key = (press.code.len() <= 32)
        .then(|| Key::from_code(&press.code))
        .flatten()
        .ok_or_else(|| {
            if is_modifier_code(&press.code) {
                NEEDS_MODIFIER.to_owned()
            } else {
                UNKNOWN_KEY.to_owned()
            }
        })?;
    let hotkey = Hotkey {
        ctrl: press.ctrl,
        alt: press.alt,
        shift: press.shift,
        win: press.win,
        key,
    };
    check(&hotkey)?;
    Ok(hotkey)
}

fn is_modifier_code(code: &str) -> bool {
    matches!(
        code,
        "ControlLeft"
            | "ControlRight"
            | "AltLeft"
            | "AltRight"
            | "ShiftLeft"
            | "ShiftRight"
            | "MetaLeft"
            | "MetaRight"
            | "OSLeft"
            | "OSRight"
    )
}

/// A combination as its text says (`Ctrl+Alt+M`), checked: what the
/// settings file keeps, read as untrusted. `None` when it cannot be used.
pub fn parse(text: &str) -> Option<Hotkey> {
    if text.chars().count() > MAX_TEXT_CHARS {
        return None;
    }
    let mut parts: Vec<&str> = text.split('+').map(str::trim).collect();
    let key = Key::from_name(parts.pop()?)?;
    let mut hotkey = Hotkey {
        ctrl: false,
        alt: false,
        shift: false,
        win: false,
        key,
    };
    for part in parts {
        let held = match part.to_ascii_lowercase().as_str() {
            "ctrl" => &mut hotkey.ctrl,
            "alt" => &mut hotkey.alt,
            "shift" => &mut hotkey.shift,
            "win" => &mut hotkey.win,
            _ => return None,
        };
        if *held {
            return None;
        }
        *held = true;
    }
    check(&hotkey).ok()?;
    Some(hotkey)
}

/// Whether a combination can be used, or the sentence that says why not.
pub fn check(hotkey: &Hotkey) -> Result<(), String> {
    let others = [hotkey.ctrl, hotkey.alt, hotkey.shift]
        .iter()
        .filter(|held| **held)
        .count();
    if others == 0 && !hotkey.win {
        return Err(NEEDS_MODIFIER.to_owned());
    }
    if let Some(reason) = reserved(hotkey) {
        return Err(reason);
    }
    if hotkey.shift && !hotkey.ctrl && !hotkey.alt && !hotkey.win && !hotkey.key.is_function_key() {
        return Err(SHIFT_ALONE.to_owned());
    }
    Ok(())
}

/// Why Windows keeps a combination for itself, if it does.
pub fn reserved(hotkey: &Hotkey) -> Option<String> {
    let key = hotkey.key.code();
    if key == "F12" {
        return Some(F12.to_owned());
    }
    let others = [hotkey.ctrl, hotkey.alt, hotkey.shift]
        .iter()
        .filter(|held| **held)
        .count();
    if hotkey.win && (others < 2 || (key == "KeyB" && hotkey.ctrl && hotkey.shift)) {
        return Some(WINDOWS_KEY.to_owned());
    }
    let only = |ctrl: bool, alt: bool, shift: bool| {
        hotkey.ctrl == ctrl && hotkey.alt == alt && hotkey.shift == shift && !hotkey.win
    };
    let kept = match key {
        "Delete" => hotkey.ctrl && hotkey.alt,
        "Escape" => hotkey.ctrl || hotkey.alt,
        "Tab" => hotkey.alt,
        "F4" => only(false, true, false),
        "Space" => only(false, true, false),
        _ => false,
    };
    kept.then(|| format!("Windows keeps {hotkey} for itself. Choose another combination."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(code: &str, ctrl: bool, alt: bool, shift: bool, win: bool) -> KeyPress {
        KeyPress {
            code: code.to_owned(),
            ctrl,
            alt,
            shift,
            win,
        }
    }

    #[test]
    fn reads_what_the_person_pressed() {
        let hotkey = from_press(&press("KeyM", true, true, false, false)).unwrap();
        assert_eq!(hotkey, OFFERED);
        assert_eq!(hotkey.to_string(), "Ctrl+Alt+M");
        assert_eq!(
            from_press(&press("F8", false, false, true, false))
                .unwrap()
                .to_string(),
            "Shift+F8"
        );
        assert_eq!(
            from_press(&press("Numpad5", true, false, true, false))
                .unwrap()
                .to_string(),
            "Ctrl+Shift+Num 5"
        );
        assert_eq!(
            from_press(&press("KeyK", true, true, false, true))
                .unwrap()
                .to_string(),
            "Ctrl+Alt+Win+K"
        );
    }

    #[test]
    fn refuses_plain_keys_and_what_windows_keeps() {
        let refused = |code: &str, ctrl, alt, shift, win| {
            from_press(&press(code, ctrl, alt, shift, win)).unwrap_err()
        };
        assert_eq!(refused("KeyM", false, false, false, false), NEEDS_MODIFIER);
        // A modifier alone.
        assert_eq!(
            refused("ControlLeft", true, false, false, false),
            NEEDS_MODIFIER
        );
        assert_eq!(refused("KeyM", false, false, true, false), SHIFT_ALONE);
        assert_eq!(refused("ArrowUp", false, false, true, false), SHIFT_ALONE);
        assert_eq!(refused("KeyD", false, false, false, true), WINDOWS_KEY);
        assert_eq!(refused("KeyL", true, false, false, true), WINDOWS_KEY);
        assert_eq!(refused("KeyB", true, false, true, true), WINDOWS_KEY);
        assert_eq!(refused("F12", true, true, false, false), F12);
        assert_eq!(
            refused("Delete", true, true, false, false),
            "Windows keeps Ctrl+Alt+Delete for itself. Choose another combination."
        );
        assert_eq!(
            refused("Tab", false, true, false, false),
            "Windows keeps Alt+Tab for itself. Choose another combination."
        );
        assert!(refused("Tab", false, true, true, false).starts_with("Windows keeps Alt+Shift+Tab"));
        assert!(
            refused("Escape", true, false, true, false).starts_with("Windows keeps Ctrl+Shift+Esc")
        );
        assert!(refused("Escape", true, false, false, false).starts_with("Windows keeps Ctrl+Esc"));
        assert!(refused("F4", false, true, false, false).starts_with("Windows keeps Alt+F4"));
        assert!(refused("Space", false, true, false, false).starts_with("Windows keeps Alt+Space"));
        assert_eq!(
            refused("MediaPlayPause", true, false, false, false),
            UNKNOWN_KEY
        );
        assert_eq!(
            refused(&"K".repeat(500), true, false, false, false),
            UNKNOWN_KEY
        );
        // Others with those keys are free.
        assert!(from_press(&press("F4", true, true, false, false)).is_ok());
        assert!(from_press(&press("Space", true, true, false, false)).is_ok());
    }

    #[test]
    fn reads_the_text_the_settings_keep() {
        assert_eq!(parse("Ctrl+Alt+M"), Some(OFFERED));
        assert_eq!(parse(" alt + ctrl + m "), Some(OFFERED));
        assert_eq!(parse("Ctrl+Shift+Num 5").unwrap().key.code(), "Numpad5");
        assert_eq!(parse("Ctrl+Alt+Page Down").unwrap().key.code(), "PageDown");
        for bad in [
            "",
            "M",
            "Ctrl",
            "Ctrl+Ctrl+M",
            "Ctrl+Hyper+M",
            "Ctrl+Alt+Delete",
            "Win+D",
            "Shift+M",
            "Ctrl+Alt+Mm",
            "Ctrl++M",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        assert_eq!(parse(&format!("Ctrl+{}", "Alt+".repeat(40))), None);
        // Every combination's text reads back as itself.
        for (code, _) in KEYS {
            let hotkey = Hotkey {
                ctrl: true,
                alt: true,
                shift: false,
                win: false,
                key: Key::from_code(code).unwrap(),
            };
            if check(&hotkey).is_ok() {
                assert_eq!(parse(&hotkey.to_string()), Some(hotkey), "{code}");
            }
        }
    }

    #[test]
    fn every_key_is_one_the_system_hotkey_knows() {
        use std::str::FromStr;
        for (code, name) in KEYS {
            assert!(
                tauri_plugin_global_shortcut::Code::from_str(code).is_ok(),
                "{code}"
            );
            assert!(!name.contains('+'), "{name}");
        }
    }
}
