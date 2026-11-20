//! The system's side of Atlas in the background (see the module): the tray
//! icon and its menu, the hotkey registered with the system, the entry
//! that starts Atlas with Windows, and the window calls. What each press,
//! close and start does is decided in `decide.rs`; this file only asks the
//! window how it is and does what comes back.
//!
//! None of it acts on another program: the hotkey and the tray only show,
//! hide or minimise Atlas's own window.

use std::{
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex, PoisonError},
};

use auto_launch::{AutoLaunch, AutoLaunchBuilder, WindowsEnableMode};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

use super::{
    decide::{self, CloseAction, FirstWindow, WindowAction, WindowNow},
    hotkey::{self, Hotkey, KeyPress},
    place::{self, Screen, WindowPlace},
    store::{self, Settings},
    BackgroundState, HotkeyState, StartState, CHANGED, OFFERED,
};
use crate::{
    activity::{self, Area},
    MAIN_WINDOW,
};

/// The tray icon's id, and its menu's items.
const TRAY_ID: &str = "background";
const SHOW_ITEM: &str = "show";
const ON_TOP_ITEM: &str = "on-top";
const QUIT_ITEM: &str = "quit";
/// The tray menu's tick, as Settings names it.
const ON_TOP_TEXT: &str = "Stay above other windows";
/// The option an entry that starts Atlas with Windows gives it.
const BACKGROUND_OPTION: &str = "--background";

/// Said when the system does not take a combination.
fn taken(hotkey: &Hotkey) -> String {
    format!("Another program uses {hotkey} already, so Atlas cannot. Choose another combination.")
}

/// The settings and what the system did with them, while Atlas runs.
pub struct Background {
    app_data: PathBuf,
    now: Mutex<Now>,
}

#[derive(Default)]
struct Now {
    settings: Settings,
    /// The combination registered with the system now.
    registered: Option<Hotkey>,
    /// Why the hotkey does nothing, when the system did not take it.
    hotkey_problem: Option<String>,
    /// Atlas starts with the system, as it said when last asked.
    start_with_system: bool,
    /// The window's place when it was last neither maximised nor minimised.
    place: Option<WindowPlace>,
    maximized: bool,
    /// The window started hidden or minimised and was maximised when it was
    /// put away last: it is maximised once it is on screen, since
    /// maximising it before would show it and take the focus.
    maximize_when_shown: bool,
}

impl Now {
    /// Any of the settings is on, so the window's place is kept.
    fn in_use(&self) -> bool {
        let settings = &self.settings;
        settings.keep_running || settings.hotkey_on || settings.on_top || self.start_with_system
    }
}

impl Background {
    fn now(&self) -> std::sync::MutexGuard<'_, Now> {
        self.now.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn settings(&self) -> Settings {
        self.now().settings
    }

    /// Changes the settings and keeps them; nothing changes when they
    /// cannot be kept.
    fn change(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut now = self.now();
        let mut settings = now.settings;
        change(&mut settings);
        store::write(&self.app_data, &settings)?;
        now.settings = settings;
        Ok(settings)
    }

    /// Keeps the window's place, while any setting is on.
    fn keep_place(&self) {
        let now = self.now();
        if !now.in_use() {
            return;
        }
        if let Some(place) = now.place {
            let place = WindowPlace {
                maximized: now.maximized,
                ..place
            };
            if let Err(error) = place::write(&self.app_data, &place) {
                activity::warn(
                    Area::App,
                    format!("Could not keep the place of the window: {error}"),
                );
            }
        }
    }
}

fn background<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<Background>> {
    app.try_state::<Arc<Background>>()
        .map(|state| Arc::clone(&state))
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
}

/// The hotkey plugin, with what a press does. Only where the settings are
/// offered: elsewhere the system's hotkeys are never touched.
pub fn hotkey_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event: ShortcutEvent| {
            if event.state == ShortcutState::Pressed {
                on_hotkey(app);
            }
        })
        .build()
}

/// Start-up, before the window is made: reads the settings and says how
/// the window starts and where. Without the settings offered, the window
/// starts as it always did, unless the start asked for the background.
pub fn prepare<R: Runtime>(
    app: &tauri::App<R>,
    app_data: &Path,
    background: bool,
) -> (FirstWindow, Option<WindowPlace>) {
    if !OFFERED {
        return (
            decide::at_start(background, false, decide::OUT_OF_SIGHT_AT_START),
            None,
        );
    }
    let settings = store::read(app_data);
    let start_with_system = launcher(app.handle())
        .and_then(|launcher| launcher.is_enabled().map_err(|error| error.to_string()))
        .unwrap_or(false);
    let mut now = Now {
        settings,
        start_with_system,
        ..Now::default()
    };
    let place = if now.in_use() {
        place::read(app_data)
    } else {
        None
    };
    if let Some(place) = place {
        now.place = Some(place);
        now.maximized = place.maximized;
    }
    app.manage(Arc::new(Background {
        app_data: app_data.to_path_buf(),
        now: Mutex::new(now),
    }));
    (
        decide::at_start(
            background,
            settings.keep_running,
            decide::OUT_OF_SIGHT_AT_START,
        ),
        place,
    )
}

/// The window builder, for how the window starts: made hidden when it is
/// not shown at once or is first moved to its place, and without the
/// focus in the background.
pub fn build_window<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    first: FirstWindow,
    place: Option<&WindowPlace>,
) -> WebviewWindowBuilder<'a, R, M> {
    match first {
        FirstWindow::Shown if place.is_none() => builder,
        FirstWindow::Shown => builder.visible(false),
        FirstWindow::Hidden | FirstWindow::Minimized => builder.visible(false).focused(false),
        // Shown at once, but without taking the focus (on Linux, tao gives
        // the window the focus back after it is first drawn, so it can be
        // used as soon as the person turns to it).
        FirstWindow::Unfocused if place.is_none() => builder.focused(false),
        FirstWindow::Unfocused => builder.visible(false).focused(false),
    }
}

/// Start-up, once the window is made: puts it in its place, shows it as
/// asked, and turns on what the settings say.
pub fn start<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    first: FirstWindow,
    place: Option<WindowPlace>,
) {
    if let Some(place) = place {
        let screens: Vec<Screen> = window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|monitor| Screen {
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
            })
            .collect();
        if place.on_a_screen(&screens) {
            let _ = window.set_position(PhysicalPosition::new(place.x, place.y));
            let _ = window.set_size(PhysicalSize::new(place.width, place.height));
            if place.maximized {
                if first == FirstWindow::Shown {
                    let _ = window.maximize();
                } else if let Some(background) = background(app) {
                    background.now().maximize_when_shown = true;
                }
            }
        }
    }
    match first {
        FirstWindow::Shown => {
            if place.is_some() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        FirstWindow::Hidden => {}
        FirstWindow::Unfocused => {
            if place.is_some() {
                let _ = window.show();
            }
        }
        FirstWindow::Minimized => {
            let _ = window.minimize();
            if !window.is_visible().unwrap_or(true) {
                let _ = window.show();
                let _ = window.minimize();
            }
        }
    }
    let Some(background) = background(app) else {
        return;
    };
    let settings = background.settings();
    if settings.on_top {
        let _ = window.set_always_on_top(true);
    }
    if settings.keep_running {
        tray_on(app, &settings);
    }
    if settings.hotkey_on {
        if let Err(problem) = register(app, &background, settings.hotkey) {
            activity::warn(Area::App, format!("The hotkey does nothing: {problem}"));
            background.now().hotkey_problem = Some(problem);
        }
    }
}

/// The window's own events: closing it, and where it is.
pub fn window_event<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    event: &WindowEvent,
) {
    let Some(background) = background(app) else {
        return;
    };
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            note_place(&background, window);
            background.keep_place();
            if decide::on_close(background.settings().keep_running) == CloseAction::Hide {
                api.prevent_close();
                let _ = window.hide();
                tray_text(app);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            maximize_if_due(&background, window);
            note_place(&background, window);
        }
        WindowEvent::Focused(_) => {
            maximize_if_due(&background, window);
            tray_text(app);
        }
        _ => {}
    }
}

/// Maximises the window once it is on screen, when it was maximised when
/// Atlas ended last and started without coming to the front.
fn maximize_if_due<R: Runtime>(background: &Background, window: &WebviewWindow<R>) {
    if !background.now().maximize_when_shown || !window_now(window).on_screen() {
        return;
    }
    background.now().maximize_when_shown = false;
    let _ = window.maximize();
}

/// Notes where the window is, when it is neither maximised nor minimised.
fn note_place<R: Runtime>(background: &Background, window: &WebviewWindow<R>) {
    let minimized = window.is_minimized().unwrap_or(true);
    let maximized = window.is_maximized().unwrap_or(false);
    if minimized || !window.is_visible().unwrap_or(false) {
        return;
    }
    let mut now = background.now();
    now.maximized = maximized;
    if maximized {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    if let Some(place) = WindowPlace::checked(
        position.x.into(),
        position.y.into(),
        size.width.into(),
        size.height.into(),
        false,
    ) {
        now.place = Some(place);
    }
}

fn window_now<R: Runtime>(window: &WebviewWindow<R>) -> WindowNow {
    WindowNow {
        visible: window.is_visible().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(false),
        focused: window.is_focused().unwrap_or(false),
    }
}

/// Does what was decided to the window.
pub fn act<R: Runtime>(app: &AppHandle<R>, action: WindowAction) {
    let Some(window) = main_window(app) else {
        return;
    };
    if matches!(action, WindowAction::Hide | WindowAction::Minimize) {
        if let Some(background) = background(app) {
            note_place(&background, &window);
            background.keep_place();
        }
    }
    match action {
        WindowAction::BringForward => {
            let _ = window.unminimize();
            let _ = window.show();
            if let Some(background) = background(app) {
                maximize_if_due(&background, &window);
            }
            let _ = window.set_focus();
        }
        WindowAction::Hide => {
            let _ = window.hide();
        }
        WindowAction::Minimize => {
            let _ = window.minimize();
        }
        WindowAction::Nothing => {}
    }
    tray_text(app);
}

fn on_hotkey<R: Runtime>(app: &AppHandle<R>) {
    let (Some(background), Some(window)) = (background(app), main_window(app)) else {
        return;
    };
    let action = decide::on_hotkey(window_now(&window), background.settings().keep_running);
    act(app, action);
}

fn on_tray_press<R: Runtime>(app: &AppHandle<R>) {
    let (Some(background), Some(window)) = (background(app), main_window(app)) else {
        return;
    };
    let action = decide::on_tray_press(window_now(&window), background.settings().keep_running);
    act(app, action);
}

/// "Quit Atlas": keeps the window's place and ends the app, as closing
/// its window does when Atlas does not keep running.
fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let (Some(background), Some(window)) = (background(app), main_window(app)) {
        note_place(&background, &window);
        background.keep_place();
    }
    app.exit(0);
}

/// The tray menu's items that change.
struct TrayItems<R: Runtime> {
    show: MenuItem<R>,
    on_top: CheckMenuItem<R>,
}

/// The tray menu's items, while the icon is there.
struct Tray<R: Runtime>(Mutex<Option<TrayItems<R>>>);

fn tray_items<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, Tray<R>>> {
    app.try_state::<Tray<R>>()
}

/// Puts the icon in the notification area, unless it is there.
fn tray_on<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    if app.tray_by_id(TRAY_ID).is_some() {
        return;
    }
    if let Err(error) = make_tray(app, settings) {
        activity::warn(
            Area::App,
            format!("Could not put the icon in the notification area: {error}"),
        );
    }
}

fn make_tray<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    let now = main_window(app)
        .map(|window| window_now(&window))
        .unwrap_or_default();
    let show = MenuItem::with_id(
        app,
        SHOW_ITEM,
        decide::show_item_text(now, &name),
        true,
        None::<&str>,
    )?;
    let on_top = CheckMenuItem::with_id(
        app,
        ON_TOP_ITEM,
        ON_TOP_TEXT,
        true,
        settings.on_top,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, QUIT_ITEM, format!("Quit {name}"), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &on_top, &separator, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(&name)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ITEM => {
                if let Some(window) = main_window(app) {
                    let keep_running = background(app)
                        .is_some_and(|background| background.settings().keep_running);
                    act(
                        app,
                        decide::on_tray_press(window_now(&window), keep_running),
                    );
                }
            }
            ON_TOP_ITEM => {
                let on = background(app).is_some_and(|background| !background.settings().on_top);
                match set_on_top(app, on) {
                    Ok(()) => {
                        if let Ok(state) = state(app) {
                            let _ = app.emit_to(MAIN_WINDOW, CHANGED, state);
                        }
                    }
                    Err(problem) => activity::warn(Area::App, problem),
                }
            }
            QUIT_ITEM => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                on_tray_press(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    if tray_items(app).is_none() {
        app.manage(Tray::<R>(Mutex::new(None)));
    }
    if let Some(tray) = tray_items(app) {
        *tray.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(TrayItems { show, on_top });
    }
    Ok(())
}

fn tray_off<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = tray_items(app) {
        tray.0.lock().unwrap_or_else(PoisonError::into_inner).take();
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

/// The tray menu says what it would do to the window now.
fn tray_text<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let text = decide::show_item_text(window_now(&window), &app.package_info().name);
    with_tray(app, |items| {
        let _ = items.show.set_text(text);
    });
}

/// Does something with the tray menu's items, while the icon is there.
fn with_tray<R: Runtime>(app: &AppHandle<R>, act: impl FnOnce(&TrayItems<R>)) {
    if let Some(tray) = tray_items(app) {
        let items = tray.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(items) = items.as_ref() {
            act(items);
        }
    }
}

/// The system's hotkey for a combination.
fn shortcut(hotkey: Hotkey) -> Option<Shortcut> {
    let code = Code::from_str(hotkey.key.code()).ok()?;
    let mut modifiers = Modifiers::empty();
    for (held, modifier) in [
        (hotkey.ctrl, Modifiers::CONTROL),
        (hotkey.alt, Modifiers::ALT),
        (hotkey.shift, Modifiers::SHIFT),
        (hotkey.win, Modifiers::SUPER),
    ] {
        if held {
            modifiers |= modifier;
        }
    }
    Some(Shortcut::new(Some(modifiers), code))
}

/// Registers a combination with the system in place of the one registered
/// now, which is kept when the system does not take the new one.
fn register<R: Runtime>(
    app: &AppHandle<R>,
    background: &Background,
    hotkey: Hotkey,
) -> Result<(), String> {
    let registered = background.now().registered;
    if registered == Some(hotkey) {
        return Ok(());
    }
    let wanted = shortcut(hotkey).ok_or_else(|| hotkey::UNKNOWN_KEY.to_owned())?;
    let shortcuts = app.global_shortcut();
    if let Err(error) = shortcuts.register(wanted) {
        activity::info(
            Area::App,
            format!("The system did not take the hotkey {hotkey}: {error}"),
        );
        return Err(taken(&hotkey));
    }
    if let Some(old) = registered.and_then(shortcut) {
        let _ = shortcuts.unregister(old);
    }
    let mut now = background.now();
    now.registered = Some(hotkey);
    now.hotkey_problem = None;
    Ok(())
}

/// Takes the hotkey off the system at once.
fn unregister<R: Runtime>(app: &AppHandle<R>, background: &Background) {
    if let Some(old) = background.now().registered.take() {
        if let Some(shortcut) = shortcut(old) {
            let _ = app.global_shortcut().unregister(shortcut);
        }
    }
}

/// The entry that starts Atlas with the system: the current user's only,
/// with `--background`, the program's path in quotes. It is named by the
/// app's identifier, not its name, so that an entry of another program
/// that happens to share the name is never read as this one, written over
/// or removed.
fn launcher<R: Runtime>(app: &AppHandle<R>) -> Result<AutoLaunch, String> {
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    AutoLaunchBuilder::new()
        .set_app_name(&app.config().identifier)
        .set_app_path(&format!("\"{}\"", program.display()))
        .set_args(&[BACKGROUND_OPTION])
        .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
        .build()
        .map_err(|error| error.to_string())
}

/// What the system says about starting Atlas with it.
fn start_state<R: Runtime>(app: &AppHandle<R>) -> StartState {
    match launcher(app)
        .and_then(|launcher| launcher.is_enabled().map_err(|error| error.to_string()))
    {
        Ok(on) => StartState {
            on: Some(on),
            problem: None,
        },
        Err(error) => StartState {
            on: None,
            problem: Some(format!(
                "Atlas could not read whether it starts when Windows starts: {error}"
            )),
        },
    }
}

/// The settings now, with what the system says.
pub fn state<R: Runtime>(app: &AppHandle<R>) -> Result<BackgroundState, String> {
    let background = background(app).ok_or_else(|| super::NOT_ON_THIS_SYSTEM.to_owned())?;
    let start_with_system = start_state(app);
    let mut now = background.now();
    if let Some(on) = start_with_system.on {
        now.start_with_system = on;
    }
    Ok(BackgroundState {
        keep_running: now.settings.keep_running,
        on_top: now.settings.on_top,
        hotkey: HotkeyState {
            on: now.settings.hotkey_on,
            keys: now.settings.hotkey.to_string(),
            offered: hotkey::OFFERED.to_string(),
            problem: now.hotkey_problem.clone(),
        },
        start_with_system,
    })
}

fn set_on_top<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
    let background = background(app).ok_or_else(|| super::NOT_ON_THIS_SYSTEM.to_owned())?;
    background.change(|settings| settings.on_top = on)?;
    if let Some(window) = main_window(app) {
        let _ = window.set_always_on_top(on);
    }
    with_tray(app, |items| {
        let _ = items.on_top.set_checked(on);
    });
    Ok(())
}

/// Switches one setting (see `background_set`).
pub fn set<R: Runtime>(
    app: &AppHandle<R>,
    setting: &str,
    on: bool,
) -> Result<BackgroundState, String> {
    let background = background(app).ok_or_else(|| super::NOT_ON_THIS_SYSTEM.to_owned())?;
    match setting {
        "keepRunning" => {
            let settings = background.change(|settings| settings.keep_running = on)?;
            if on {
                tray_on(app, &settings);
            } else {
                tray_off(app);
                // A window hidden with no icon to bring it back is shown.
                if let Some(window) = main_window(app) {
                    if !window.is_visible().unwrap_or(true) {
                        act(app, WindowAction::BringForward);
                    }
                }
            }
        }
        "hotkey" => {
            let hotkey = background.settings().hotkey;
            if on {
                register(app, &background, hotkey)?;
            } else {
                unregister(app, &background);
                background.now().hotkey_problem = None;
            }
            if let Err(problem) = background.change(|settings| settings.hotkey_on = on) {
                // Kept as it was.
                if on {
                    unregister(app, &background);
                }
                return Err(problem);
            }
        }
        "onTop" => set_on_top(app, on)?,
        "startWithSystem" => {
            let launcher = launcher(app)?;
            let done = if on {
                launcher.enable()
            } else {
                launcher.disable()
            };
            let now = start_state(app);
            if let Err(error) = done {
                return Err(format!(
                    "Atlas could not change whether it starts when Windows starts: {error}"
                ));
            }
            if now.on.is_some_and(|is| is != on) {
                return Err(if on {
                    "Atlas wrote the entry that starts it with Windows, but Windows does not use it. It may be switched off in the list of programs started with Windows.".to_owned()
                } else {
                    "Atlas removed its own entry, but another entry still starts it with Windows, one for every user of this computer that only an administrator can remove.".to_owned()
                });
            }
        }
        _ => return Err("Atlas has no such setting.".to_owned()),
    }
    state(app)
}

/// Sets the hotkey's combination (see `background_set_hotkey`).
pub fn set_hotkey<R: Runtime>(
    app: &AppHandle<R>,
    keys: &KeyPress,
) -> Result<BackgroundState, String> {
    let background = background(app).ok_or_else(|| super::NOT_ON_THIS_SYSTEM.to_owned())?;
    let hotkey = hotkey::from_press(keys)?;
    let settings = background.settings();
    if settings.hotkey_on {
        if let Err(problem) = register(app, &background, hotkey) {
            // The old one is kept, registered again if a pause took it off.
            let _ = register(app, &background, settings.hotkey);
            return Err(problem);
        }
    }
    if let Err(problem) = background.change(|settings| settings.hotkey = hotkey) {
        if settings.hotkey_on {
            let _ = register(app, &background, settings.hotkey);
        }
        return Err(problem);
    }
    state(app)
}

/// Pauses the hotkey while the person presses keys in Settings (see
/// `background_pause_hotkey`).
pub fn pause_hotkey<R: Runtime>(
    app: &AppHandle<R>,
    paused: bool,
) -> Result<BackgroundState, String> {
    let background = background(app).ok_or_else(|| super::NOT_ON_THIS_SYSTEM.to_owned())?;
    let settings = background.settings();
    if paused {
        unregister(app, &background);
    } else if settings.hotkey_on {
        if let Err(problem) = register(app, &background, settings.hotkey) {
            background.now().hotkey_problem = Some(problem);
        }
    }
    state(app)
}
