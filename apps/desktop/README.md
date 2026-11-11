# Atlas desktop

The desktop app is a [Tauri 2](https://v2.tauri.app/) shell around the same static build as `apps/web`. It adds one window, a small Rust protocol that serves data packs to it, a maps folder shared by every Atlas app on the computer plus pack folders the person chooses, native file dialogs for progress export and import, a downloader for packs whose map images live on a tile server, and, in builds that include importers, "Add a map" from a web page.

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

### Building another app from the shell

A build can give the app its own name and identifier, so it installs next to the plain Atlas app instead of replacing it:

```sh
ATLAS_APP_NAME="My Atlas" ATLAS_APP_IDENTIFIER=org.example.my-atlas pnpm desktop:build
```

`scripts/build.js` checks both (set both or neither; the identifier must differ from `dev.atlas.desktop`), writes them to `src-tauri/tauri.identity.conf.json` (ignored by git) and passes it to `tauri build` after the bundling config. The name becomes the product name, the window title, the installer's name and the name shown in the top bar. Such an app keeps its own app data, and so its own progress and settings of the page, but shares the maps folder and the shared settings file (below) with every other Atlas app.

Importers are added the same way, at build time: `ATLAS_BUNDLE_IMPORTERS` takes comma-separated paths of importer modules (absolute, or relative to the repository root). `scripts/prepare-frontend.js` loads each in Node to check it against the contract in `packages/importer-api` (and refuses modules that import Node built-ins), copies it to `dist/importers/<id>.js` and lists it under `importers` in `config.json`. A build without it has no importers and shows no "Add a map".

### Desktop tests

Four WebDriver tests drive the built app through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/). They need `cargo install tauri-driver --locked` and the platform's WebDriver: on Linux the package that provides `WebKitWebDriver` (`webkitgtk-webdriver` on newer Ubuntu and Debian releases, `webkit2gtk-driver` on older ones), `xdotool`, and `xvfb-run` without a display. They run on Linux; see below for Windows. Screenshots go to `apps/desktop/test-results/`. On Linux, the tests run the app with `XDG_DATA_HOME` and `XDG_CONFIG_HOME` in a temporary folder, so they start from a first launch and leave your own data alone, and with a stand-in system browser that only records the links it is asked to open.

- `pnpm --filter @atlas/desktop test:e2e` (smoke test, on a `pnpm desktop:build` with the demo pack): the map, its tiles and markers load; progress can be saved (IndexedDB works); the pack protocol answers range requests; the shell's commands answer. On Linux it also exports progress through the native save dialog and imports it back through the open dialog (typing into them with `xdotool`), checks that a guide link opens in the system browser while the window stays on the app, that the plain app has no "Add a map", and opens a pack folder through the native folder picker.
- `pnpm --filter @atlas/desktop test:e2e:download` (download test, Linux): downloads map images from a mock tile server on `127.0.0.1:4431` (`ATLAS_E2E_TILE_PORT` to change it) through the app's interface, over three launches: a refusing server (the panel names the refused image and its address, and the Activity log dialog shows the refusal and copies exactly the lines of the log file it shows), Standard detail, an upgrade to Full detail with pause and resume, the app closed mid-way and the job picked up after a restart, and the last game remembered. It checks every request the server saw (one per tile, the User-Agent, no cookie), the status files, and that markers sit on dots the server paints into its tiles. Build it with the test pack first:

  ```sh
  pnpm --filter @atlas/desktop e2e:pack     # writes packs/e2e-remote/ (ignored by git)
  ATLAS_BUNDLE_PACKS=e2e-remote,demo pnpm desktop:build --no-bundle
  xvfb-run -a pnpm --filter @atlas/desktop test:e2e:download
  ```

  `node apps/desktop/e2e/tileServer.js` runs the mock server on its own, to try the pack by hand.

- `pnpm --filter @atlas/desktop test:e2e:import` (maps library and import test, Linux), on the same build with the demo importer added (`ATLAS_BUNDLE_IMPORTERS=packages/importer-api/demo/demo-importer.js`). Before the first launch it writes what an earlier version and the person could have left behind: a half-done version 0.2.0 download in the old app data folder, and a shared settings file remembering a copied pack folder with its images (under a path with spaces and non-ASCII letters), a folder with a second pack of an id already shown, a folder that is gone and a folder that is not a pack. It checks that the old download moves into the pack folder and finishes without fetching anything twice, that download settings are saved to the shared file, the Maps dialog's locations and their states, the hidden duplicate and its reason, forgetting a location without deleting files, and the copied pack's own images. Then it adds maps from a made-up map site on `127.0.0.1` (`e2e/demoSite.js`): an address no importer knows, a page whose data appears after a while, a second map of the same game, the first page again after the site changed, a game that comes with the app, data in the wrong shape, cancelling, and waiting too long, and it downloads the imported game's map images into its pack folder. The made-up page tries to call the app, read its packs, open a window and leave for another site, and reports what happened; the test checks that each was refused. A second launch checks that everything is remembered and deletes the imported pack. `node apps/desktop/e2e/demoSite.js` runs the site on its own.

- `pnpm --filter @atlas/desktop test:e2e:delete` (delete test, Linux), on the same build as the download test. Before the first launch it puts a made-up game "My Game" into the maps folder and a `.deleting-*` folder as a delete leaves behind when a file stays in use. It checks that the left-over folder is removed at start; that **Delete downloaded images…** on the bundled test pack says how many images go, removes them and only them, and the map asks for them again; that **Delete…** on "My Game" during a slow download says the download is stopped first, deletes the folder mid-download with nothing left behind and no request after it, and that the app goes on working; and, after a restart, that both stay that way. `ATLAS_E2E_SHOTS=<folder>` also copies the pictures of both confirmations there.

CI runs all four on Linux. On Windows, CI runs `pnpm --filter @atlas/desktop test:e2e:windows` instead (`e2e/windows.js`): it starts the built app with a temporary WebView2 profile and checks from outside that the window opens with the app's title, that the embedded browser starts the app's page, and that the app is still running and responding ten seconds later. It saves a picture of the desktop to `apps/desktop/test-results/desktop-windows.png`, which CI uploads, for a person to look at. It does not look inside the page: an Edge WebDriver has to match the installed WebView2 exactly, and both it and a direct DevTools connection rely on `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which WebView2 does not apply to an app that passes browser arguments of its own, as Tauri does.

The first name in `ATLAS_BUNDLE_PACKS` is the game shown on first launch; after that the app opens the game picked last. Any pack folder in `packs/<id>/` can be bundled this way.

## How packs are served

PMTiles archives are read with HTTP range requests. Tauri's built-in protocol for the bundled frontend (`tauri://localhost`, or `http://tauri.localhost` on Windows) ignores the `Range` header and always answers `200` with the whole file, which the PMTiles reader rejects. So the desktop build does not embed packs in the frontend:

- `scripts/prepare-frontend.js` copies the web build without `packs/` and writes an explicit `packs` list into `config.json`, one entry per pack in the build's `packs/index.json` (set by `ATLAS_BUNDLE_PACKS`), each pointing at the `atlas-pack` protocol: `atlas-pack://localhost/<id>/` on Linux and macOS, `http://atlas-pack.localhost/<id>/` on Windows (WebView2 serves custom schemes that way). The app then never requests the index.
- `src-tauri/tauri.build.conf.json` ships the web build's `packs/` folder as app resources. It is only merged in by `tauri build`, so Rust checks do not need a web build first.
- `src-tauri/src/packs.rs` registers each bundled pack folder under its folder name and serves `<scheme>/<pack id>/<file>` from it, with single byte ranges, `ETag`, CORS headers (the page and the protocol are different origins), and no access outside registered folders (no `..`, hidden files or symbolic links that leave the folder).

Pack folders in the maps folder and in locations the person added are registered the same way, under their pack id, and served from the folder itself. Only the main window may use the protocol: requests from any other webview (such as the import window) are answered with 403. The first path segment `import/` (any case) is never served, so page data kept by "Add a map" stays out of what the map loads. Nothing is listed, and nothing is written through the protocol.

A pack that comes with the app and has no remote map images (the demo world) is served from the app's resources, which are never written to. If something has to be added to such a pack, it goes to an **overlay** folder in the app's data folder, `<app data>/packs/<pack id>/`, which the protocol looks at first. Packs whose map images can be downloaded are installed into the maps folder instead (see below), so their images end up in their own folder. `<app data>` is `~/.local/share/<identifier>` on Linux, `%APPDATA%\<identifier>` on Windows and `~/Library/Application Support/<identifier>` on macOS.

## Maps folder and other locations

Every Atlas app on a computer reads one **maps folder**, wherever it was built and whatever its identifier:

| System  | Default maps folder                                       | Shared settings file                                |
| ------- | --------------------------------------------------------- | --------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Atlas\Maps`                               | `%LOCALAPPDATA%\Atlas\settings.json`                |
| macOS   | `~/Library/Application Support/Atlas/Maps`                | `~/Library/Application Support/Atlas/settings.json` |
| Linux   | `$XDG_DATA_HOME/atlas/maps` (`~/.local/share/atlas/maps`) | `$XDG_DATA_HOME/atlas/settings.json`                |

The defaults are local folders, not ones that a cloud service syncs. Each entry of the maps folder is a complete pack folder: the pack files, the map images downloaded for it at its layers' own tile paths, their status files (`offline-tiles/`), page data kept by an import (`import/`), and the app's lock and unfinished-download record (`.atlas/`). Nothing in it names the computer, the user or an app, so a pack folder can be copied elsewhere, or to another computer, and opened there.

The **Maps** button (folder icon in the top bar) opens a dialog that shows:

- the maps folder, with **Change…** and **Open folder**. Changing it never silently moves gigabytes: after choosing a folder the app offers **Move my maps there** when the packs can be moved by renaming (same drive; every pack is checked before any moves, and a pack that is downloading stops it), and **Use it for new maps only** otherwise or when preferred, in which case the old folder stays listed as a folder of packs and can be moved by hand;
- every pack shown, where it comes from (the app, the maps folder or an added folder), its folder, and **Show**, **Open folder**, **Rebuild** (imported packs, from the page data kept with them), **Delete downloaded images…** for every pack with a folder, and **Delete…** for packs in the maps folder that do not come with the app (see "Deleting maps and map images" below);
- packs that are not shown, and why;
- **Map packs elsewhere**: pack folders added with **Open a map pack…** (one pack folder anywhere) and folders of packs added with **Choose maps folder…**. They are remembered between runs and between apps. A location that is gone (for example an unplugged drive) stays listed as "Not found" with a plain message, and comes back when the drive does; a folder that is not a pack, or holds none, says so. **Remove from list** forgets a location and never deletes files.

Packs are read as untrusted: only folders whose `manifest.json` is a pack manifest of version 1 or 2 with a usable id are listed (at most 4 MB), the web app validates every file with the pack schema, symbolic links are not followed out of a folder, hidden folders are skipped, and the protocol's path checks apply. Nothing is written into a pack folder that was opened for viewing unless the person starts a download or an import for it.

**One pack per id.** When two folders hold packs with the same id, one is shown: a pack that comes with the app and has no remote images first, then the maps folder, then the added locations in the order they were added. The others are listed under "Not shown" with the folder that won. Packs are never merged.

**Packs that come with the app.** An app whose bundled packs have remote map images (built with such packs in `ATLAS_BUNDLE_PACKS`) installs them into the maps folder at start-up, when the maps folder has no pack with that id, or replaces only their pack files when the bundled version is newer (map images and other files are never touched). The demo world stays in the app's resources.

**Locks.** Downloads, imports, moves and the start-up move from version 0.2.0 hold an operating system lock on the pack folder's `.atlas/lock` (`File::try_lock`), so two apps or windows never write the same pack at once; the second gets a plain message. The lock is released however the app ends. The map keeps reading a pack while another app downloads into it.

**The shared settings file** holds the maps folder, the remembered locations and the download settings, as JSON:

```json
{
  "format": "atlas-settings",
  "version": 1,
  "mapsFolder": null,
  "locations": [
    { "path": "E:\\Maps\\My Game", "kind": "pack" },
    { "path": "D:\\More maps", "kind": "folder" }
  ],
  "downloads": {
    "parallel": 2,
    "pauseMs": 250,
    "requestsPerMinute": null,
    "kilobytesPerSecond": null
  }
}
```

`mapsFolder` null means the default. Every change reads the file again first and writes it through a `.part` file and a rename, so two apps changing different settings do not undo each other; a file that cannot be read counts as the defaults and is replaced on the next change. Progress is not in it: each app keeps progress in its own web storage.

### Deleting maps and map images

Both actions ask first, in plain words: what goes, how many map images and roughly how large (counted from the files on disk), that a running download is stopped first, and what stays. The result, or why nothing was deleted, is said in plain words too.

- **Delete…** (`library_delete_pack`) works whatever state the pack's download is in: unfinished, paused, stopped by a refusal or running. A running or paused download is cancelled and the shell waits until it has really stopped (its last files written and closed, the pack's lock released; at most a minute) before anything is deleted; the job, its record of an unfinished download and anything else kept for the pack id are forgotten. The pack folder is renamed to a hidden `.deleting-<id>` folder next to it, so no Atlas app lists it any more, and then removed. On Windows a file that another program holds open (a virus scanner, a file window, the other Atlas app reading it) can make the rename or the removal fail for a moment, so both are tried again for about two seconds. A folder that is still held stays hidden and is removed when an Atlas app next starts. If even the rename keeps failing, the pack's manifest is removed first (so it is not a pack any more and drops out of every list), the folder is marked with `.atlas/delete-pending`, what can go goes, and the next start removes the rest. Only packs directly inside the maps folder can be deleted, not packs that come with the app (they would be installed again at the next start) and not packs in other locations (use **Remove from list** for those, which deletes nothing). A pack that another Atlas window or app holds (its lock) is not deleted; the dialog says so.
- **Delete downloaded images…** (`library_delete_images`) removes only what a download wrote and keeps the pack, its places, checklists and progress: every tile of every downloadable layer at the layer's own path (with its `.404` and `.part` companions), the layers' status files in `offline-tiles/`, the record of an unfinished download, and the image summaries in the manifest. Folders are removed only when they are empty afterwards; nothing is deleted recursively, and images that came with a bundled pack stay. It works for every listed pack whose folder can be written, including a game that comes with the app and was installed into the maps folder, and stops a download of the pack first in the same way. Images that stay in use are left and counted in the result.

Neither follows a symbolic link or junction out of the pack folder: a linked folder on the way to a file is skipped, and a link is removed itself, never what it points to. The start-up clean-up looks only at entries directly inside the maps folder: `.deleting-*` folders, and marked folders without a manifest that no app holds.

### Two apps, one maps folder

The plain build of this repository is "Atlas" (`dev.atlas.desktop`). Another build of the same shell, with its own name and identifier and with importers (see "Building another app from the shell"), installs next to it. Both list the same maps folder and the same remembered locations, so a game added or downloaded in one shows up in the other after a restart or **Refresh**. Progress stays per app.

### From version 0.2.0

Version 0.2.0 kept downloaded map images in an overlay in its app data folder, `<app data of dev.atlas.desktop>/packs/<pack id>/` (`tiles/`, `offline-tiles/`), and unfinished jobs in `<app data>/downloads/<pack id>.json`. At start-up, every app looks in that folder explicitly (whatever its own identifier) and moves each overlay into the pack folder of the same id in the maps folder, which the bundled pack has just been installed into: files are moved one by one by renaming, or copied to a `.migrating.part` file and renamed when on another drive, status files last; the job record becomes `.atlas/download-job.json`; the old folder is removed when empty. It holds the pack's lock while it works, is safe to interrupt and continues on the next start; files already in the pack folder are kept. Overlays of packs that are not in the maps folder (for example the demo world) stay where they are. While a pack's images are being moved, the Maps dialog says so.

## Downloading map images

A pack may ship without its map images when its `xyz` layers name a remote source (`tiles.remote` in `layers.json`: an `https` URL template and, per pyramid level, which remote zoom and tile offset it maps to). The desktop app then offers **Download map images** on the map's "not installed" notice, and a **Map images** button once some are there. The plain web build never shows either.

- **Detail**: Overview, Standard or Full, the top level minus 2, 1 or 0 (never below the lowest remote level). Each choice shows its image count, what is left to fetch, and a rough size and time from typical tile sizes and the polite pace below. Choosing more detail later fetches only the new levels.
- **Order**: the lowest remote level of every layer first, so each map is usable early; then upwards. Levels below the lowest remote level are built from it by 2×2 downscaling (Lanczos3), with a neutral dark background where a child tile is missing; JPEG (quality 85), PNG and WebP (lossless) tiles are written in the layer's own format.
- **Where**: tiles go into the pack's own folder at the layer's own `url` filled in, for example `<maps folder>/<pack id>/tiles/<map>/<z>/<x>/<y>.jpg`, each written to a `.part` file first and renamed when complete. After each level, and when the job ends, a version 2 manifest's `contents.maps[].layers[].images` is updated (levels, complete, file count and bytes); every other field and the field order are kept, and version 1 manifests are left alone. A tile the server answers with 404 leaves an empty `<tile>.404` marker and is never asked for again.
- **Status file**: one per layer at `<pack folder>/offline-tiles/<layer local id>.json`, served as `<pack URL>offline-tiles/<layer local id>.json`:

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

- **Resuming**: tiles already on disk are skipped. Pause, resume and cancel act at once; cancel keeps what was downloaded. A job that was stopped or interrupted, by an error or by closing the app, is recorded in `<pack folder>/.atlas/download-job.json` (`{ "packId", "detail", "stopReason" }`, plus `stopDetail` after a refusal or a web page, see below; for a bundled pack served from resources, `<app data>/downloads/<pack id>.json`) and offered again after a restart, by any Atlas app; the record is removed when the job finishes or is cancelled.
- **One download at a time**: a download started while another one runs, in the same app, waits in line ("Waiting for <game> to finish"); the panel shows the line, and a waiting download can be cancelled. The next one starts when the running one finishes, stops, is cancelled or is paused (after its requests in flight have ended); a paused download that is resumed runs at once if nothing has started meanwhile, or joins the end of the line. Across apps, the running download holds a lock on `download.lock` in the shared folder (`File::try_lock`); a download whose turn has come while another Atlas app holds it waits ("Another Atlas app is downloading") and tries again every 3 seconds. The lock is let go when the download finishes, stops, is cancelled or paused, and by the system when the app ends, however it ends. Waiting downloads are recorded like unfinished ones, so after a restart each is offered again. If the lock file cannot be opened at all, the download goes ahead and says so in the activity log.
- **Download settings**, in the panel and shared by every Atlas app through the settings file, so they pace everything this computer downloads: parallel downloads (1 to 4, default 2), the pause after each request per parallel download (100 ms to 5 s, default 250 ms), and optional caps on requests per minute (10 to 600) and on speed (50 to 50,000 KB/s). There is no unlimited setting; values outside the bounds are refused, and a hand-edited file is pulled back into them. The size and time estimates follow the settings. A running download follows a change at once (pause, caps and fewer parallel downloads), except that more parallel downloads start with its next level.
- **Polite by design**, whatever the settings: an honest `User-Agent: Atlas/<version> (offline map viewer)` with `Accept: image/*`, no cookies and no browser-imitating headers; network errors and 5xx answers retried up to 5 times with doubling waits (2 s up to 60 s); a 429 answer pauses every worker for its `Retry-After` (up to 15 minutes); the job stops with a plain reason on 401 or 403 (no way to bypass a refusal), on an HTML answer (a login or error page), when the disk refuses a write, or after 10 failures in a row (an answer over 16 MB or that is not an image counts as a failure). Remote sources must be `https`; plain `http` is accepted only for `127.0.0.1` and `localhost`, for tests.
- **When the server refuses**: on 401, 403 or a web page, the panel says which image it was (layer, level, column and row, counted from 0, and whether it is at an edge of the map), shows its address to copy, how many images this download had saved before it and what the server answered (selected headers and the start of a text body), with **View log**. This is kept in the job record as `stopDetail`, so it is shown again after a restart. Nothing about the request changes: the job still stops at the first refusal and does not retry.

The Rust side is `src-tauri/src/tiles/` (`pyramid.rs` tile maths matching `pyramidLevel` in `@atlas/core`, `download.rs` the polite downloader, `downscale.rs`, `status.rs`, `store.rs` the overlay, `manager.rs` jobs and progress); the web side is `apps/web/src/desktop.ts`, `state/downloads.ts` and `components/DownloadPanel.tsx`.

## Adding maps from web pages

In a build with importers, the **Add a map** button (map icon in the top bar) asks for the address of a map page. The importer contract is in `packages/importer-api` (`src/index.ts`, with a made-up example in `demo/demo-importer.js`): an importer has an id, a title, `matches(url)`, a `pageReader` (the source text of a function that reads what it needs from the page) and `convert(pageData, context)`, which turns the page data into a pack.

1. The address must be `https` (or `http` on `127.0.0.1`/`localhost`, for tests), with no user name or password, and an importer must recognise it; otherwise the dialog says so.
2. The shell opens the page in a separate, visible window titled "Add a map – <site>", with the platform's own browser engine and user agent, in a private session (`incognito`: no cookies or storage kept from or shared with anything else). Tauri's own start-up script is present in every webview, but the window has no capability, so every command it might send is refused ("not allowed by ACL"), and the pack protocol answers it with 403.
3. Every two seconds the shell evaluates the page reader in the page (`eval_with_callback`), wrapped so an exception counts as "not there yet". When it returns a value, the value is kept in the page as JSON text and the shell pulls it out in slices of one million characters, capped at 64 MB in all, and checks that it is JSON. The page is never given a way to send anything to the app; the app only pulls the reader's result out.
4. The dialog shows that it is waiting, for how long, and after 20 seconds explains that the page may be asking the person to sign in, to confirm they are a person or to wait, which they can do in that window, or cancel. The app does not click, retry, reload, hide the window or change anything about it to get past such a check. When the importer's wait (300 s unless it sets 30 to 900 s) runs out, or the person closes the window, the import ends with a plain explanation and nothing is written.
5. The page data goes to the importer's `convert` in the app's window. What it returns is checked (`checkOutcome`): its shape, the pack against the pack schema and its integrity rules, the pack id against the manifest. Packs that come with the app are refused. The shell checks the pack id, the file names (only the pack's own JSON files), sizes and JSON again, takes the pack's lock, writes the page data (`import/<page key>.json`, listed in `import/index.json` with its address, time and map) and the pack files, the manifest last, into `<maps folder>/<pack id>/` or into the folder the imported pack already has. It refuses to replace a pack that was not imported, or that another importer made.
6. The new pack is listed, its game and the imported map are shown, and the result lists the game, the map and the counts, with **Download map images…**.

The import window's navigation stays on the site of the entered address (the same host or its subdomains, ignoring a leading `www.`, and the same scheme); new windows and downloads are refused. On Windows (WebView2) only top-level navigations are checked; on Linux (WebKitGTK) frames are checked too.

One pack per game: each page becomes a map of its game's pack, so importing a second map of a game adds it to the same pack, and importing a page again replaces that map's data in place (each importer decides how, from the page data kept with the pack, which `context.savedSources` hands back). The manifest's `source` lists every page. **Rebuild** in the Maps dialog runs `convert` again on the kept page data, without visiting the page.

## Activity log

Every Atlas desktop app on the computer writes what it does to one log file in the shared folder, next to `settings.json`:

| System  | Log file                                                              |
| ------- | --------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Atlas\logs\atlas.log`                                 |
| macOS   | `~/Library/Application Support/Atlas/logs/atlas.log`                  |
| Linux   | `$XDG_DATA_HOME/atlas/logs/atlas.log` (`~/.local/share/atlas/logs/…`) |

One event per line: the time in UTC (ISO 8601, milliseconds), the app's name and version, the area (`app`, `download`, `import`, `library`, `migration`), the level (`info`, `warn`, `error`) and a message, for example

```text
2026-11-11T09:12:03.123Z [Atlas 0.3.1] download error: Stopped: the server refused access (HTTP 403) for https://tiles.example.com/5/0/231.jpg | layer Surface (Island), level 2 (remote zoom 5), column 0 of 216, row 231 of 232 (counted from 0; an edge tile) | attempt 1 | this job had saved 4120 images before it, 4120 of them from tiles.example.com | headers: server: example; content-type: application/xml; content-length: 40 | body: <Error><Code>AccessDenied</Code></Error> | not retried
```

Line breaks and control characters in messages are replaced, so a line is always one event. When the file would pass 2 MB it is renamed to `atlas.1.log` (replacing the one before) and a new file is started. Apps append under a lock on `atlas.log.lock`, so lines from two apps never mix. If the folder cannot be written, the app carries on and writes to standard error only; every line also goes to standard error.

What is in it: the app starting (version, system, maps folder, packs and importers it comes with); each download (pack, layers, detail, images planned, already there and to fetch, the host and the pace), its pauses, resumptions, cancelling, waiting in line or for another app, progress every 30 seconds or 500 images, each level completed (with a few addresses of missing images) and its totals; every answer that was not an image (the address, the attempt and what happens next), and a refusal or web page in full, as above; adding maps (the host and path of the page, not its query, the importer, waiting, timing out or closing, and the outcome with its counts or the error); the maps library (what a scan found, changes to locations and the maps folder, packs installed or updated, packs in use by another app) and moving a version 0.2.0 download. Not in it: progress, the contents of files or of the pages maps were added from, and anything from web storage.

**To send it** with a question: open **Maps**, then **View activity log** (or **View log** in the download panel), choose the area and level, and **Copy all shown**; or **Open log folder** and attach `atlas.log` (and `atlas.1.log` if the problem is older). Check it first: it holds the addresses of the map images and pages, and the path of the maps folder.

The dialog reads the last 2,000 lines (at most 512 KB) through `activity_log_read`, shows them as plain text, and is not in the plain web build. The Rust side is `src-tauri/src/activity.rs`; other modules log with `activity::info(Area::Download, "…")`, `activity::warn` or `activity::error`.

## Security

- IPC: the web app calls only the shell's own commands, each listed in `build.rs` and granted in `capabilities/main.json` to the main window only: `desktop_info`, `open_external`, `save_text_file`, `open_text_file`; `tiles_plan`, `tiles_start`, `tiles_pause`, `tiles_resume`, `tiles_cancel`, `tiles_snapshot`; `download_settings_get`, `download_settings_set`; `library_list`, `library_open_pack`, `library_add_folder`, `library_remove_location`, `library_choose_maps_folder`, `library_apply_maps_folder`, `library_reveal`, `library_delete_pack`, `library_images_info`, `library_delete_images`, `library_import_sources`, `library_save_import`; `import_open`, `import_poll`, `import_close`, `import_report`; `activity_log_read`. No plugin permissions are granted to the page; the dialog and opener plugins are used from Rust only. Folders are chosen in native dialogs, so the page never names a folder to open, and `library_reveal` opens only the maps folder, a listed pack's folder, a remembered location or the activity log's folder. `activity_log_read` returns only the end of the log file, and `import_report` only writes the outcome of adding a map (importer id, counts, a short message) to it. The web app finds the shell through `window.__TAURI_INTERNALS__` and has no Tauri dependency, so the plain web build runs without it.
- Files: `save_text_file` and `open_text_file` go through the native save and open dialogs ("Export progress", "Import progress"), so the page never names a path; opened files are limited to 64 MB of UTF-8 text.
- Content Security Policy (in `tauri.conf.json`): scripts, styles and fonts only from the app; images from the app, `data:`, `blob:` (PMTiles tiles) and the pack protocol; network requests only to the app and the pack protocol. Map images are downloaded by the Rust shell, not the page.
- The import window (see below) gets no commands, no pack protocol and no way to reach the app.
- Links: navigation is limited to the app's own pages. `http` and `https` links to other sites, including guide links with `target="_blank"`, open in the system browser (`open_external`); any other scheme is ignored.

The bundle identifier is `dev.atlas.desktop` (Tauri warns about identifiers ending in `.app` because of the macOS bundle extension). Change it before the first public release if you prefer another; installed apps keep their data under it.

## Not there yet

- Code signing and notarisation: Windows SmartScreen and macOS Gatekeeper warn about the unsigned builds.
- Auto-update.
- Save-file reading and sync.
- Remembering window size and position, global shortcuts and a companion window.
- Tests that look inside the window on Windows. The map, pack protocol, dialogs, links, map image downloads, the maps folder and "Add a map" (including the import window's limits) are tested in the window on Linux only; on Windows the start-up test covers the app coming up, the Rust unit tests cover the shell's code, and the page itself is checked by eye from the saved picture. macOS builds in CI: the macOS bundle targets are configured but have not been built yet.
