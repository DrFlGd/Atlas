# Atlas desktop

The desktop app is a [Tauri 2](https://v2.tauri.app/) shell around the same static build as `apps/web`. It adds one window and a small Rust protocol that serves data packs to it; the web app itself is unchanged.

## Prerequisites

All platforms need Node.js and pnpm as in the root README, plus Rust (stable, 1.90 or newer) from [rustup](https://rustup.rs/).

- **Windows 10 or 11**: Microsoft C++ Build Tools with the "Desktop development with C++" workload, and the MSVC Rust toolchain (`rustup default stable-msvc`). WebView2 ships with current Windows.
- **macOS**: Xcode, or just the Command Line Tools (`xcode-select --install`).
- **Linux (Debian or Ubuntu)**:

  ```sh
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
    libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  Other distributions: see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

## Run and build

From the repository root:

```sh
pnpm desktop:dev     # window on the Vite dev server, with hot reload
pnpm desktop:build   # release build and installers
```

`desktop:dev` starts Vite on port 1420 (`--strictPort`, so it stops rather than attach to another server) and opens the window on it; packs come from the dev server, as in the browser.

`desktop:build` builds the web app and demo pack, prepares `apps/desktop/dist` from it (`scripts/prepare-frontend.js`), compiles the Rust shell and writes installers to `apps/desktop/src-tauri/target/release/bundle/`: NSIS `.exe` on Windows, `.app` and `.dmg` on macOS, `.deb`, `.rpm` and `.AppImage` on Linux. Tauri CLI options can follow, for example `pnpm desktop:build --debug --no-bundle` for a quick debug build without installers.

Rust checks, from `apps/desktop/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`. They work on a fresh clone; nothing has to be built first.

`pnpm --filter @atlas/desktop test:e2e` starts the built app through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/), checks that the map and its tiles load and that the pack protocol answers range requests, and saves a screenshot to `apps/desktop/test-results/`. It needs `cargo install tauri-driver --locked` and, on Linux, the `webkit2gtk-driver` package (and `xvfb-run` without a display). CI runs it on Linux.

## How packs are served

PMTiles archives are read with HTTP range requests. Tauri's built-in protocol for the bundled frontend (`tauri://localhost`, or `http://tauri.localhost` on Windows) ignores the `Range` header and always answers `200` with the whole file, which the PMTiles reader rejects. So the desktop build does not embed packs in the frontend:

- `scripts/prepare-frontend.js` copies the web build without `packs/` and rewrites `config.json` so `packUrl` points at the `atlas-pack` protocol: `atlas-pack://localhost/demo/` on Linux and macOS, `http://atlas-pack.localhost/demo/` on Windows (WebView2 serves custom schemes that way).
- `src-tauri/tauri.build.conf.json` ships the web build's `packs/` folder as app resources. It is only merged in by `tauri build`, so Rust checks do not need a web build first.
- `src-tauri/src/packs.rs` registers each bundled pack folder under its folder name and serves `<scheme>/<pack id>/<file>` from it, with single byte ranges, `ETag`, CORS headers (the page and the protocol are different origins), and no access outside registered folders (no `..`, hidden files or symbolic links that leave the folder).

A pack folder anywhere on disk is served the same way: call `PackRegistry::register("<id>", path)` (the registry is in Tauri's managed state) and point the app at `<scheme>/<id>/`. Adding a user's pack later needs a way to choose the folder (dialog or settings) and a way to tell the web app its URL; the serving side needs no change.

## Security

- No IPC permissions: the web app calls no Tauri commands, so `capabilities/main.json` grants nothing.
- Content Security Policy (in `tauri.conf.json`): scripts, styles and fonts only from the app; images from the app, `data:`, `blob:` (PMTiles tiles) and the pack protocol; network requests only to the app and the pack protocol.
- Navigation is limited to the app's own pages. Links to other sites do nothing yet; opening them in the system browser needs the opener plugin.

The bundle identifier is `dev.atlas.desktop` (Tauri warns about identifiers ending in `.app` because of the macOS bundle extension). Change it before the first public release if you prefer another; installed apps keep their data under it.

## Not there yet

- Code signing and notarisation: Windows SmartScreen and macOS Gatekeeper warn about the unsigned builds.
- Auto-update.
- Native file dialogs, so no way yet to open a pack folder from disk.
- Save-file reading and sync.
- Remembering window size and position, global shortcuts and a companion window.
- A Windows run of the smoke test in CI (it needs a WebView2 WebDriver), and macOS builds in CI. The macOS bundle targets are configured but have not been built yet.
