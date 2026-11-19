//! The window's place on the screen from one run to the next: where it
//! was, its size and whether it was maximised, kept in the app's own data
//! folder (`window.json`) and read as untrusted. A place that is off every
//! screen now (a screen that was unplugged, a file from another computer)
//! is not used, and the window opens where it always did.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::manifest::write_atomic;

/// The file in the app's data folder.
pub const PLACE_FILE: &str = "window.json";
const FORMAT: &str = "atlas-window";
const VERSION: u64 = 1;
/// A larger file is not read.
pub const MAX_PLACE_BYTES: u64 = 4 << 10;
/// The smallest and largest window kept, in pixels of the screen.
const MIN_SIDE: i64 = 200;
const MAX_SIDE: i64 = 32_000;
/// The farthest a window's corner is kept from the first screen's.
const MAX_OFFSET: i64 = 100_000;
/// How much of the window's top edge (where it is moved by) must be on a
/// screen for the place to be used.
const TOP_STRIP: i64 = 32;
const MIN_ON_SCREEN: i64 = 100;

/// Where the window was, in pixels of the screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowPlace {
    /// The window's outer corner.
    pub x: i32,
    pub y: i32,
    /// The size of what it shows, without its frame.
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// One screen, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl WindowPlace {
    /// A place with usable numbers, or `None`.
    pub fn checked(x: i64, y: i64, width: i64, height: i64, maximized: bool) -> Option<Self> {
        let side = MIN_SIDE..=MAX_SIDE;
        let offset = -MAX_OFFSET..=MAX_OFFSET;
        (side.contains(&width)
            && side.contains(&height)
            && offset.contains(&x)
            && offset.contains(&y))
        .then_some(Self {
            x: x as i32,
            y: y as i32,
            width: width as u32,
            height: height as u32,
            maximized,
        })
    }

    /// Whether the window's top edge is on one of these screens, enough to
    /// be seen and moved.
    pub fn on_a_screen(&self, screens: &[Screen]) -> bool {
        let (left, right) = (i64::from(self.x), i64::from(self.x) + i64::from(self.width));
        let (top, bottom) = (i64::from(self.y), i64::from(self.y) + TOP_STRIP);
        screens.iter().any(|screen| {
            let (screen_left, screen_top) = (i64::from(screen.x), i64::from(screen.y));
            let screen_right = screen_left + i64::from(screen.width);
            let screen_bottom = screen_top + i64::from(screen.height);
            let across = right.min(screen_right) - left.max(screen_left);
            let down = bottom.min(screen_bottom) - top.max(screen_top);
            across >= MIN_ON_SCREEN.min(i64::from(self.width)) && down >= TOP_STRIP / 2
        })
    }
}

/// The file in an app data folder.
pub fn path(app_data: &Path) -> PathBuf {
    app_data.join(PLACE_FILE)
}

/// The place kept, or `None` when there is none that can be used.
pub fn read(app_data: &Path) -> Option<WindowPlace> {
    let path = path(app_data);
    if std::fs::metadata(&path).ok()?.len() > MAX_PLACE_BYTES {
        return None;
    }
    read_text(&std::fs::read_to_string(path).ok()?)
}

/// The place a file's text holds, read as untrusted.
pub fn read_text(text: &str) -> Option<WindowPlace> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("format")?.as_str()? != FORMAT || value.get("version")?.as_u64()? != VERSION {
        return None;
    }
    let number = |name: &str| value.get(name).and_then(Value::as_i64);
    WindowPlace::checked(
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
        value.get("maximized").and_then(Value::as_bool) == Some(true),
    )
}

/// Keeps the place, written whole through a part file.
pub fn write(app_data: &Path, place: &WindowPlace) -> std::io::Result<()> {
    let text = json!({
        "format": FORMAT,
        "version": VERSION,
        "x": place.x,
        "y": place.y,
        "width": place.width,
        "height": place.height,
        "maximized": place.maximized,
    });
    std::fs::create_dir_all(app_data)?;
    write_atomic(
        &path(app_data),
        serde_json::to_string_pretty(&text)
            .unwrap_or_default()
            .as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    const SCREEN: Screen = Screen {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    const LEFT_SCREEN: Screen = Screen {
        x: -1280,
        y: 0,
        width: 1280,
        height: 1024,
    };

    fn place(x: i32, y: i32) -> WindowPlace {
        WindowPlace {
            x,
            y,
            width: 1280,
            height: 800,
            maximized: false,
        }
    }

    #[test]
    fn keeps_and_reads_a_place() {
        let dir = TempDir::new("background-place");
        assert_eq!(read(&dir.0), None);
        let kept = WindowPlace {
            maximized: true,
            ..place(-1200, 40)
        };
        write(&dir.0, &kept).unwrap();
        assert_eq!(read(&dir.0), Some(kept));
    }

    #[test]
    fn reads_the_file_as_untrusted() {
        let good =
            r#"{"format":"atlas-window","version":1,"x":10,"y":20,"width":900,"height":700}"#;
        assert_eq!(
            read_text(good),
            Some(WindowPlace {
                x: 10,
                y: 20,
                width: 900,
                height: 700,
                maximized: false
            })
        );
        for bad in [
            "",
            "[]",
            "not json",
            r#"{"format":"atlas-other","version":1,"x":10,"y":20,"width":900,"height":700}"#,
            r#"{"format":"atlas-window","version":2,"x":10,"y":20,"width":900,"height":700}"#,
            r#"{"format":"atlas-window","version":1,"x":"10","y":20,"width":900,"height":700}"#,
            r#"{"format":"atlas-window","version":1,"x":10,"y":20,"width":5,"height":700}"#,
            r#"{"format":"atlas-window","version":1,"x":10,"y":20,"width":900,"height":99999999}"#,
            r#"{"format":"atlas-window","version":1,"x":-9999999,"y":20,"width":900,"height":700}"#,
            r#"{"format":"atlas-window","version":1,"x":1.5,"y":20,"width":900,"height":700}"#,
            r#"{"format":"atlas-window","version":1,"y":20,"width":900,"height":700}"#,
        ] {
            assert_eq!(read_text(bad), None, "{bad}");
        }
        // Anything but true is not maximised.
        let odd = r#"{"format":"atlas-window","version":1,"x":10,"y":20,"width":900,"height":700,"maximized":"yes"}"#;
        assert!(!read_text(odd).unwrap().maximized);

        // A file too large is not read.
        let dir = TempDir::new("background-place-large");
        std::fs::write(path(&dir.0), " ".repeat(10_000) + good).unwrap();
        assert_eq!(read(&dir.0), None);
    }

    #[test]
    fn a_place_off_every_screen_is_not_used() {
        assert!(place(100, 100).on_a_screen(&[SCREEN]));
        // Partly off the screen, with enough of its top edge on it.
        assert!(place(1800, 1040).on_a_screen(&[SCREEN]));
        assert!(place(-1150, 0).on_a_screen(&[SCREEN]));
        assert!(!place(-1230, 0).on_a_screen(&[SCREEN]));
        // On a screen to the left, which is there, or is not any more.
        assert!(place(-1200, 40).on_a_screen(&[SCREEN, LEFT_SCREEN]));
        assert!(!place(-1200, 40).on_a_screen(&[SCREEN]));
        // Below or right of every screen, or with only its frame's edge on one.
        assert!(!place(100, 1070).on_a_screen(&[SCREEN]));
        assert!(!place(1900, 100).on_a_screen(&[SCREEN]));
        assert!(!place(100, -30).on_a_screen(&[SCREEN]));
        // A minimised window's place.
        assert!(!place(-32000, -32000).on_a_screen(&[SCREEN, LEFT_SCREEN]));
        // No screens known.
        assert!(!place(100, 100).on_a_screen(&[]));
    }
}
