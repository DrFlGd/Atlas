// Release builds on Windows run without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started as the helper of "Restart Steam and add it": it does its work
    // and ends here, before the window and the single-instance check, so a
    // running Atlas never takes its arguments (see `steam::restart`).
    if let Some(code) = atlas_desktop_lib::steam::helper_main(std::env::args_os().collect()) {
        std::process::exit(code);
    }
    atlas_desktop_lib::run();
}
