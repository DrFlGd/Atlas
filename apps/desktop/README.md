# Atlas desktop

The desktop app is a [Tauri 2](https://v2.tauri.app/) shell around the same static build as `apps/web`. It adds one window, a small Rust protocol that serves data packs to it, native file dialogs for progress export and import, and a downloader for packs whose map images live on a tile server.

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

### Desktop tests

Two WebDriver tests drive the built app through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/). They need `cargo install tauri-driver --locked` and the platform's WebDriver: on Linux the package that provides `WebKitWebDriver` (`webkitgtk-webdriver` on newer Ubuntu and Debian releases, `webkit2gtk-driver` on older ones), `xdotool`, and `xvfb-run` without a display; on Windows, Microsoft Edge WebDriver matching the installed WebView2, on the `PATH` or named by `TAURI_NATIVE_DRIVER`. Screenshots go to `apps/desktop/test-results/`. On Linux, both tests run the app with `XDG_DATA_HOME` and `XDG_CONFIG_HOME` in a temporary folder, so they start from a first launch and leave your own data alone, and with a stand-in system browser that only records the links it is asked to open.

- `pnpm --filter @atlas/desktop test:e2e` (smoke test, on a `pnpm desktop:build` with the demo pack): the map, its tiles and markers load; progress can be saved (IndexedDB works); the pack protocol answers range requests; the shell's commands answer. On Linux it also exports progress through the native save dialog and imports it back through the open dialog (typing into them with `xdotool`), and checks that a guide link opens in the system browser while the window stays on the app.
- `pnpm --filter @atlas/desktop test:e2e:download` (download test, Linux): downloads map images from a mock tile server on `127.0.0.1:4431` (`ATLAS_E2E_TILE_PORT` to change it) through the app's interface, over three launches: a refusing server, Standard detail, an upgrade to Full detail with pause and resume, the app closed mid-way and the job picked up after a restart, and the last game remembered. It checks every request the server saw (one per tile, the User-Agent, no cookie), the status files, and that markers sit on dots the server paints into its tiles. Build it with the test pack first:

  ```sh
  pnpm --filter @atlas/desktop e2e:pack     # writes packs/e2e-remote/ (ignored by git)
  ATLAS_BUNDLE_PACKS=e2e-remote,demo pnpm desktop:build --no-bundle
  xvfb-run -a pnpm --filter @atlas/desktop test:e2e:download
  ```

  `node apps/desktop/e2e/tileServer.js` runs the mock server on its own, to try the pack by hand.

CI runs both on Linux. On Windows it runs the smoke test without the dialog and link checks, with the Edge WebDriver that the runner image ships; that step may fail when the runner's Edge and WebView2 versions differ, so it does not fail the job (see "Not there yet").

The first name in `ATLAS_BUNDLE_PACKS` is the game shown on first launch; after that the app opens the game picked last. Any pack folder in `packs/<id>/` can be bundled this way.

## How packs are served

PMTiles archives are read with HTTP range requests. Tauri's built-in protocol for the bundled frontend (`tauri://localhost`, or `http://tauri.localhost` on Windows) ignores the `Range` header and always answers `200` with the whole file, which the PMTiles reader rejects. So the desktop build does not embed packs in the frontend:

- `scripts/prepare-frontend.js` copies the web build without `packs/` and writes an explicit `packs` list into `config.json`, one entry per pack in the build's `packs/index.json` (set by `ATLAS_BUNDLE_PACKS`), each pointing at the `atlas-pack` protocol: `atlas-pack://localhost/<id>/` on Linux and macOS, `http://atlas-pack.localhost/<id>/` on Windows (WebView2 serves custom schemes that way). The app then never requests the index.
- `src-tauri/tauri.build.conf.json` ships the web build's `packs/` folder as app resources. It is only merged in by `tauri build`, so Rust checks do not need a web build first.
- `src-tauri/src/packs.rs` registers each bundled pack folder under its folder name and serves `<scheme>/<pack id>/<file>` from it, with single byte ranges, `ETag`, CORS headers (the page and the protocol are different origins), and no access outside registered folders (no `..`, hidden files or symbolic links that leave the folder).

A pack folder anywhere on disk is served the same way: call `PackRegistry::register("<id>", path)` (the registry is in Tauri's managed state) and point the app at `<scheme>/<id>/`. Adding a user's pack later needs a way to choose the folder (dialog or settings) and a way to tell the web app its URL; the serving side needs no change.

Each pack also has an **overlay** folder in the app's data folder, `<app data>/packs/<pack id>/`, for files the app adds to a pack: downloaded map images and their status files. The protocol looks there first and then in the pack folder, with the same path checks in both (symbolic links that leave the overlay are refused). Bundled resources are never written to. `<app data>` is `~/.local/share/dev.atlas.desktop` on Linux, `%APPDATA%\dev.atlas.desktop` on Windows and `~/Library/Application Support/dev.atlas.desktop` on macOS.

## Downloading map images

A pack may ship without its map images when its `xyz` layers name a remote source (`tiles.remote` in `layers.json`: an `https` URL template and, per pyramid level, which remote zoom and tile offset it maps to). The desktop app then offers **Download map images** on the map's "not installed" notice, and a **Map images** button once some are there. The plain web build never shows either.

- **Detail**: Overview, Standard or Full, the top level minus 2, 1 or 0 (never below the lowest remote level). Each choice shows its image count, what is left to fetch, and a rough size and time from typical tile sizes and the polite pace below. Choosing more detail later fetches only the new levels.
- **Order**: the lowest remote level of every layer first, so each map is usable early; then upwards. Levels below the lowest remote level are built from it by 2×2 downscaling (Lanczos3), with a neutral dark background where a child tile is missing; JPEG (quality 85), PNG and WebP (lossless) tiles are written in the layer's own format.
- **Where**: tiles go to the overlay at the layer's own `url` filled in, for example `<app data>/packs/<pack id>/tiles/<map>/<z>/<x>/<y>.jpg`, each written to a `.part` file first and renamed when complete. A tile the server answers with 404 leaves an empty `<tile>.404` marker and is never asked for again.
- **Status file**: one per layer at `<app data>/packs/<pack id>/offline-tiles/<layer local id>.json`, served as `<pack URL>offline-tiles/<layer local id>.json`:

  ```json
  {
    "format": "atlas-tile-status",
    "version": 1,
    "layerId": "demo:layer:surface",
    "levels": [0, 1, 2, 3],
    "nativeMinZoom": 0,
    "nativeMaxZoom": 3,
    "complete": false,
    "updatedAt": 1767225600000
  }
  ```

  `levels` lists every complete level; `nativeMinZoom` to `nativeMaxZoom` is the unbroken run from the layer's `minZoom` (null while the lowest level is not ready), which the map passes to Leaflet as `minNativeZoom` and `maxNativeZoom` and uses in place of its tile probe. The map rereads it while a download runs, so new levels show without a restart, and a later upgrade fetches only what is missing.

- **Resuming**: tiles already on disk (in the overlay or in the pack) are skipped. Pause, resume and cancel act at once; cancel keeps what was downloaded. A job that was stopped or interrupted, by an error or by closing the app, is recorded in `<app data>/downloads/<pack id>.json` (`{ "packId", "detail", "stopReason" }`) and offered again after a restart; the record is removed when the job finishes or is cancelled.
- **Polite by design**, with no setting to change any of it: two requests at a time and a 250 ms pause after each, per worker; an honest `User-Agent: Atlas/<version> (offline map viewer)` with `Accept: image/*`, no cookies and no browser-imitating headers; network errors and 5xx answers retried up to 5 times with doubling waits (2 s up to 60 s); a 429 answer pauses every worker for its `Retry-After` (up to 15 minutes); the job stops with a plain reason on 401 or 403 (no way to bypass a refusal), on an HTML answer (a login or error page), when the disk refuses a write, or after 10 failures in a row (an answer over 16 MB or that is not an image counts as a failure). Remote sources must be `https`; plain `http` is accepted only for `127.0.0.1` and `localhost`, for tests.

The Rust side is `src-tauri/src/tiles/` (`pyramid.rs` tile maths matching `pyramidLevel` in `@atlas/core`, `download.rs` the polite downloader, `downscale.rs`, `status.rs`, `store.rs` the overlay, `manager.rs` jobs and progress); the web side is `apps/web/src/desktop.ts`, `state/downloads.ts` and `components/DownloadPanel.tsx`.

## Security

- IPC: the web app calls only the shell's own commands, each listed in `build.rs` and granted in `capabilities/main.json`: `desktop_info`, `open_external`, `save_text_file`, `open_text_file` and `tiles_plan`, `tiles_start`, `tiles_pause`, `tiles_resume`, `tiles_cancel`, `tiles_snapshot`. No plugin permissions are granted to the page; the dialog and opener plugins are used from Rust only. The web app finds the shell through `window.__TAURI_INTERNALS__` and has no Tauri dependency, so the plain web build runs without it.
- Files: `save_text_file` and `open_text_file` go through the native save and open dialogs ("Export progress", "Import progress"), so the page never names a path; opened files are limited to 64 MB of UTF-8 text.
- Content Security Policy (in `tauri.conf.json`): scripts, styles and fonts only from the app; images from the app, `data:`, `blob:` (PMTiles tiles) and the pack protocol; network requests only to the app and the pack protocol. Map images are downloaded by the Rust shell, not the page.
- Links: navigation is limited to the app's own pages. `http` and `https` links to other sites, including guide links with `target="_blank"`, open in the system browser (`open_external`); any other scheme is ignored.

The bundle identifier is `dev.atlas.desktop` (Tauri warns about identifiers ending in `.app` because of the macOS bundle extension). Change it before the first public release if you prefer another; installed apps keep their data under it.

## Not there yet

- Code signing and notarisation: Windows SmartScreen and macOS Gatekeeper warn about the unsigned builds.
- Auto-update.
- Opening a pack folder from disk (the dialogs exist now; choosing and remembering a folder does not).
- Save-file reading and sync.
- Remembering window size and position, global shortcuts and a companion window.
- A verified Windows run of the smoke test: the CI step exists but has not been seen to pass, and it is allowed to fail, because the runner's Edge WebDriver follows Edge, not WebView2. The dialog and link checks and the download test run on Linux only; on Windows the download code is covered by the Rust unit tests, not by a window test. macOS builds in CI: the macOS bundle targets are configured but have not been built yet.
