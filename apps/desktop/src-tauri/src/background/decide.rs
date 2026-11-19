//! What a close, a hotkey press, a press on the tray icon and a start do
//! to the window, in each state, without the system: `shell.rs` asks the
//! window how it is, asks here, and does what comes back.

/// How the window is now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WindowNow {
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
}

impl WindowNow {
    /// The window can be seen: shown and not minimised.
    pub fn on_screen(self) -> bool {
        self.visible && !self.minimized
    }

    /// The window is in front of every other: on screen and with the focus.
    pub fn in_front(self) -> bool {
        self.on_screen() && self.focused
    }
}

/// What to do to the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowAction {
    /// Show it, take it out of the taskbar if minimised, and give it the
    /// focus.
    BringForward,
    /// Hide it: Atlas keeps running, with its icon in the notification area.
    Hide,
    Minimize,
    Nothing,
}

/// What closing the window does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAction {
    /// Hidden instead, as "Keep Atlas running when its window is closed" asks.
    Hide,
    /// Closed, and Atlas ends, as it always did.
    Close,
}

pub fn on_close(keep_running: bool) -> CloseAction {
    if keep_running {
        CloseAction::Hide
    } else {
        CloseAction::Close
    }
}

/// Puts the window away: hidden while Atlas keeps running without it, else
/// minimised, since a hidden window with no icon could not be found again.
fn put_away(keep_running: bool) -> WindowAction {
    if keep_running {
        WindowAction::Hide
    } else {
        WindowAction::Minimize
    }
}

/// The hotkey was pressed: brings Atlas forward, or puts it away when it
/// is in front already.
pub fn on_hotkey(now: WindowNow, keep_running: bool) -> WindowAction {
    if now.in_front() {
        put_away(keep_running)
    } else {
        WindowAction::BringForward
    }
}

/// The tray icon was pressed: shows the window, or hides it when it can be
/// seen. The press takes the focus from the window, so whether it had it
/// does not count. The icon is there only while Atlas keeps running.
pub fn on_tray_press(now: WindowNow, keep_running: bool) -> WindowAction {
    if now.on_screen() {
        put_away(keep_running)
    } else {
        WindowAction::BringForward
    }
}

/// The text of the tray menu's first item, for a window that can be seen or not.
pub fn show_item_text(now: WindowNow, app_name: &str) -> String {
    if now.on_screen() {
        format!("Hide {app_name}")
    } else {
        format!("Show {app_name}")
    }
}

/// How the window starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FirstWindow {
    /// As it always did: shown, in front.
    Shown,
    /// Not shown at all, the tray icon and the hotkey bring it.
    Hidden,
    /// In the taskbar, without the focus.
    Minimized,
}

/// The first start: with `--background`, the window is made without
/// coming to the front.
pub fn at_start(background: bool, keep_running: bool) -> FirstWindow {
    match (background, keep_running) {
        (false, _) => FirstWindow::Shown,
        (true, true) => FirstWindow::Hidden,
        (true, false) => FirstWindow::Minimized,
    }
}

/// A second start handed over its request: the window comes forward,
/// unless it asked for `--background`, or asked to show a game Atlas does
/// not have (then nothing at all happens).
pub fn on_second_start(background: bool, nothing_to_show: bool) -> WindowAction {
    if background || nothing_to_show {
        WindowAction::Nothing
    } else {
        WindowAction::BringForward
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HIDDEN: WindowNow = WindowNow {
        visible: false,
        minimized: false,
        focused: false,
    };
    const MINIMIZED: WindowNow = WindowNow {
        visible: true,
        minimized: true,
        focused: false,
    };
    const BEHIND: WindowNow = WindowNow {
        visible: true,
        minimized: false,
        focused: false,
    };
    const IN_FRONT: WindowNow = WindowNow {
        visible: true,
        minimized: false,
        focused: true,
    };

    #[test]
    fn closing_hides_only_while_atlas_keeps_running() {
        assert_eq!(on_close(true), CloseAction::Hide);
        assert_eq!(on_close(false), CloseAction::Close);
    }

    #[test]
    fn the_hotkey_brings_atlas_forward_and_puts_it_away() {
        for keep_running in [true, false] {
            for now in [HIDDEN, MINIMIZED, BEHIND] {
                assert_eq!(
                    on_hotkey(now, keep_running),
                    WindowAction::BringForward,
                    "{now:?}"
                );
            }
        }
        assert_eq!(on_hotkey(IN_FRONT, true), WindowAction::Hide);
        assert_eq!(on_hotkey(IN_FRONT, false), WindowAction::Minimize);
    }

    #[test]
    fn the_tray_icon_shows_or_hides() {
        assert_eq!(on_tray_press(HIDDEN, true), WindowAction::BringForward);
        assert_eq!(on_tray_press(MINIMIZED, true), WindowAction::BringForward);
        assert_eq!(on_tray_press(BEHIND, true), WindowAction::Hide);
        assert_eq!(on_tray_press(IN_FRONT, true), WindowAction::Hide);
        assert_eq!(on_tray_press(IN_FRONT, false), WindowAction::Minimize);
        assert_eq!(show_item_text(HIDDEN, "Atlas"), "Show Atlas");
        assert_eq!(show_item_text(MINIMIZED, "Atlas"), "Show Atlas");
        assert_eq!(show_item_text(BEHIND, "Atlas"), "Hide Atlas");
    }

    #[test]
    fn a_start_in_the_background_takes_no_focus() {
        assert_eq!(at_start(false, false), FirstWindow::Shown);
        assert_eq!(at_start(false, true), FirstWindow::Shown);
        assert_eq!(at_start(true, true), FirstWindow::Hidden);
        assert_eq!(at_start(true, false), FirstWindow::Minimized);
        assert_eq!(on_second_start(false, false), WindowAction::BringForward);
        assert_eq!(on_second_start(true, false), WindowAction::Nothing);
        assert_eq!(on_second_start(false, true), WindowAction::Nothing);
    }
}
