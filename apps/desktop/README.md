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

Four WebDriver tests drive the built app through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/). They need `cargo install tauri-driver --locked` and the platform's WebDriver: on Linux the package that provides `WebKitWebDriver` (`webkitgtk-webdriver` on newer Ubuntu and Debian releases, `webkit2gtk-driver` on older ones), `xdotool`, and `xvfb-run` without a display. They run on Linux; see below for Windows. Screenshots go to `apps/desktop/test-results/`. On Linux, both tests run the app with `XDG_DATA_HOME` and `XDG_CONFIG_HOME` in a temporary folder, so they start from a first launch and leave your own data alone, and with a stand-in system browser that only records the links it is asked to open.

- `pnpm --filter @atlas/desktop test:e2e` (smoke test, on a `pnpm desktop:build` with the demo pack): the map, its tiles and markers load; progress can be saved (IndexedDB works); the pack protocol answers range requests; the shell's commands answer. On Linux it also exports progress through the native save dialog and imports it back through the open dialog (typing into them with `xdotool`), checks that a guide link opens in the system browser while the window stays on the app, that the plain app has no "Add a map", and opens a pack folder through the native folder picker.
- `pnpm --filter @atlas/desktop test:e2e:download` (download test, Linux): downloads map images from a mock tile server on `127.0.0.1:4431` (`ATLAS_E2E_TILE_PORT` to change it) through the app's interface, over three launches: a refusing server, Standard detail, an upgrade to Full detail with pause and resume, the app closed mid-way and the job picked up after a restart, and the last game remembered. It checks every request the server saw (one per tile, the User-Agent, no cookie), the status files, and that markers sit on dots the server paints into its tiles. Build it with the test pack first:

  ```sh
  pnpm --filter @atlas/desktop e2e:pack     # writes packs/e2e-remote/ (ignored by git)
  ATLAS_BUNDLE_PACKS=e2e-remote,demo pnpm desktop:build --no-bundle
  xvfb-run -a pnpm --filter @atlas/desktop test:e2e:download
  ```

  `node apps/desktop/e2e/tileServer.js` runs the mock server on its own, to try the pack by hand.

- `pnpm --filter @atlas/desktop test:e2e:import` (maps library and import test, Linux), on the same build with the demo importer added (`ATLAS_BUNDLE_IMPORTERS=packages/importer-api/demo/demo-importer.js`). Before the first launch it writes what an earlier version and the person could have left behind: a half-done version 0.2.0 download in the old app data folder, and a shared settings file remembering a copied pack folder with its images (under a path with spaces and non-ASCII letters), a folder with a second pack of an id already shown, a folder that is gone and a folder that is not a pack. It checks that the old download moves into the pack folder and finishes without fetching anything twice, that download settings are saved to the shared file, the Maps dialog's locations and their states, the hidden duplicate and its reason, forgetting a location without deleting files, and the copied pack's own images. Then it adds maps from a made-up map site on `127.0.0.1` (`e2e/demoSite.js`): an address no importer knows, a page whose data appears after a while, a second map of the same game, the first page again after the site changed, a game that comes with the app, data in the wrong shape, cancelling, and waiting too long, and it downloads the imported game's map images into its pack folder. The made-up page tries to call the app, read its packs, open a window and leave for another site, and reports what happened; the test checks that each was refused. A second launch checks that everything is remembered and deletes the imported pack. `node apps/desktop/e2e/demoSite.js` runs the site on its own.

- `pnpm --filter @atlas/desktop test:e2e:view` ("View map page" and "Save map images as I browse" test, Linux), on any build. It needs `python3` as well, to send a window the close request its close button would (there is no window manager under Xvfb). It serves a made-up map site and its image server on `127.0.0.1` (`e2e/mapPageSite.js`; `node apps/desktop/e2e/mapPageSite.js` runs them on their own) and writes a pack made from two of the site's pages into the maps folder, with one map image already in it. It checks that the Maps dialog lists the pages, that "Open in my browser" hands the recorded address to the system browser, that addresses the pack does not record are refused, and that plain viewing writes nothing. With saving on, a page that loads its images with `fetch` and `XMLHttpRequest` while "zooming in": each image lands in the pack where the downloader puts it, byte for byte, the image already there is kept, a marker icon and a level the pack does not use are ignored, the status file, the shrunk level and the manifest are brought up to date, the pack's lock is held so a download cannot start, the page cannot call the app, read packs, open windows or leave its site, the map shows the saved images, and the image server saw every image asked for exactly once. A page that shows its images with `<img>` elements and a `no-cors` request gets "could not be saved" and nothing written, and closing its window stops saving and frees the pack.

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
- every pack shown, where it comes from (the app, the maps folder or an added folder), its folder, and **Show**, **Open folder**, **Rebuild** (imported packs, from the page data kept with them), and **Delete…** for packs in the maps folder that do not come with the app. Delete asks first, deletes the pack folder with its map images, and deletes this app's progress for the game only when that box is ticked;
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

- **Resuming**: tiles already on disk are skipped. Pause, resume and cancel act at once; cancel keeps what was downloaded. A job that was stopped or interrupted, by an error or by closing the app, is recorded in `<pack folder>/.atlas/download-job.json` (`{ "packId", "detail", "stopReason" }`; for a bundled pack served from resources, `<app data>/downloads/<pack id>.json`) and offered again after a restart, by any Atlas app; the record is removed when the job finishes or is cancelled.
- **Download settings**, in the panel and shared by every Atlas app through the settings file: parallel downloads (1 to 4, default 2), the pause after each request per parallel download (100 ms to 5 s, default 250 ms), and optional caps on requests per minute (10 to 600) and on speed (50 to 50,000 KB/s). There is no unlimited setting; values outside the bounds are refused, and a hand-edited file is pulled back into them. The size and time estimates follow the settings. A running download follows a change at once (pause, caps and fewer parallel downloads), except that more parallel downloads start with its next level.
- **Polite by design**, whatever the settings: an honest `User-Agent: Atlas/<version> (offline map viewer)` with `Accept: image/*`, no cookies and no browser-imitating headers; network errors and 5xx answers retried up to 5 times with doubling waits (2 s up to 60 s); a 429 answer pauses every worker for its `Retry-After` (up to 15 minutes); the job stops with a plain reason on 401 or 403 (no way to bypass a refusal), on an HTML answer (a login or error page), when the disk refuses a write, or after 10 failures in a row (an answer over 16 MB or that is not an image counts as a failure). Remote sources must be `https`; plain `http` is accepted only for `127.0.0.1` and `localhost`, for tests.

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

## Viewing a map page and saving its images as you browse

A pack added from a web page records its pages in its manifest (`source.pages[].url`). In the Maps dialog, such a pack has **Map page…**, which lists each page with:

- **View map page**: opens the page in a window of the app, just to look at it. Nothing is added to the page and nothing is read from it.
- **View map page and save images as I browse**: the same window, and while the person pans and zooms the page's map by hand, the map images that their own browsing loads are kept in the pack, exactly where **Download map images** would put them. A card over Atlas's map counts what was saved, what the pack already had, and what could not be saved, with **Stop saving** and **Close the map page**. Closing the window also stops saving.
- **Open in my browser**: the system's default browser.

Only addresses recorded in that pack's manifest can be opened (`https`, or `http` on `127.0.0.1`/`localhost` for tests); the shell reads them from the manifest itself and refuses anything else. The window has the import window's limits: its own label (`map-page`), no capability (every command it might send is refused), no pack protocol, a private session, navigation kept on the site of the page, new windows and downloads refused. One map page window at a time; opening another closes the first. It is separate from the import window, so "Add a map" works as before, also while a map page is open.

**What saving does, and what it never does.** With saving on, a script is added to the page before its own scripts run (`src-tauri/src/pageview/script.rs`). It wraps `fetch` and `XMLHttpRequest` and, when a `GET` request the page made itself has been answered with status 200 and its address starts like one of the pack's remote image addresses, keeps a copy of the answer's body (`Response.clone()`, or the finished binary `XMLHttpRequest` response). The page's calls, their arguments and their answers pass through unchanged. Saving never makes a request, never asks again, never adds or changes a header or the user agent, and never clicks, scrolls, pans or zooms anything. The copies wait in the page, at most 16 MB per image and about 48 MB in all; more is noted as "too many at once". The shell takes them out from the Rust side with `eval_with_callback`, a few times a second, as it takes an import's page data, so the page still cannot send anything to the app.

**What cannot be saved.** Images a page shows with `<img>` elements or style sheets cannot be read without asking the server again, which Atlas does not do; neither can answers to `no-cors` requests, or binary data a page reads as text. The script only notes their addresses (from the page's resource timing list), and the card says plainly that some images on the page could not be saved this way and that **Download map images** can fetch them. Requests made inside web workers are not visible to the page at all; the card says when the page started a worker. Only the page's top frame is watched.

**How images are matched and written** (`src-tauri/src/pageview/capture.rs`). An address is a map image only when it is exactly an address the downloader would request: one of the pack's layers' `tiles.remote.urlTemplate`, filled in with whole numbers, for a remote level the layer lists, inside the layer's tile grid (both compared in the standard form browsers use for web addresses). That gives the layer and the tile, and so the file: the layer's own `url` filled in, as the downloader writes it. Everything else is ignored. The bytes must be a JPEG, PNG or WebP image whose header can be read (at most 4096 px a side). A tile already on disk that is a readable image is never replaced, so a good file is never overwritten with a smaller or broken one; a broken file at that place is replaced, and a "missing on the server" marker is removed. Files are written through a `.part` file and a rename, only inside the pack folder and never through a symbolic link. Every few seconds and when saving stops, the levels the downloader builds by shrinking are built above the saved tiles, newly complete levels are recorded in the layer's status file, and the manifest's image summary is updated, as the downloader does. A later **Download map images** then skips what was saved. Tip shown in the dialog: start zoomed out, so the whole map is saved first.

**Downloads and other apps.** Saving holds the pack folder's lock for as long as it is on, so a download, an import, a move or a delete of that pack, from this app or another Atlas app, waits until it stops (with the usual "another Atlas window or app is working on this map's files" message), and saving does not start while a download of the pack is running or paused. It only saves into a pack folder the person keeps (the maps folder or an added location).

## Security

- IPC: the web app calls only the shell's own commands, each listed in `build.rs` and granted in `capabilities/main.json` to the main window only: `desktop_info`, `open_external`, `save_text_file`, `open_text_file`; `tiles_plan`, `tiles_start`, `tiles_pause`, `tiles_resume`, `tiles_cancel`, `tiles_snapshot`; `download_settings_get`, `download_settings_set`; `library_list`, `library_open_pack`, `library_add_folder`, `library_remove_location`, `library_choose_maps_folder`, `library_apply_maps_folder`, `library_reveal`, `library_delete_pack`, `library_import_sources`, `library_save_import`; `import_open`, `import_poll`, `import_close`. No plugin permissions are granted to the page; the dialog and opener plugins are used from Rust only. Folders are chosen in native dialogs, so the page never names a folder to open, and `library_reveal` opens only the maps folder, a listed pack's folder or a remembered location. The web app finds the shell through `window.__TAURI_INTERNALS__` and has no Tauri dependency, so the plain web build runs without it.
- Files: `save_text_file` and `open_text_file` go through the native save and open dialogs ("Export progress", "Import progress"), so the page never names a path; opened files are limited to 64 MB of UTF-8 text.
- Content Security Policy (in `tauri.conf.json`): scripts, styles and fonts only from the app; images from the app, `data:`, `blob:` (PMTiles tiles) and the pack protocol; network requests only to the app and the pack protocol. Map images are downloaded by the Rust shell, not the page.
- The import window (see below) gets no commands, no pack protocol and no way to reach the app.
- The map page window gets the same: no commands, no pack protocol, no way to reach the app. The main window's commands for it are `view_pages`, `view_open`, `view_status`, `view_stop_saving`, `view_close` and `view_open_in_browser`, listed in `build.rs` and granted in `capabilities/main.json` like the others; `view_open` and `view_open_in_browser` open only addresses recorded in the pack's manifest.
- Links: navigation is limited to the app's own pages. `http` and `https` links to other sites, including guide links with `target="_blank"`, open in the system browser (`open_external`); any other scheme is ignored.

The bundle identifier is `dev.atlas.desktop` (Tauri warns about identifiers ending in `.app` because of the macOS bundle extension). Change it before the first public release if you prefer another; installed apps keep their data under it.

## Not there yet

- Code signing and notarisation: Windows SmartScreen and macOS Gatekeeper warn about the unsigned builds.
- Auto-update.
- Save-file reading and sync.
- Remembering window size and position, global shortcuts and a companion window.
- Tests that look inside the window on Windows. The map, pack protocol, dialogs, links, map image downloads, the maps folder and "Add a map" (including the import window's limits) are tested in the window on Linux only; on Windows the start-up test covers the app coming up, the Rust unit tests cover the shell's code, and the page itself is checked by eye from the saved picture. macOS builds in CI: the macOS bundle targets are configured but have not been built yet.
