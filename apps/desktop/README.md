# Atlas desktop

The desktop app is a [Tauri 2](https://v2.tauri.app/) shell around the same static build as `apps/web`. It adds one window, a small Rust protocol that serves data packs to it, a maps folder shared by every Atlas app on the computer plus pack folders the person chooses, native file dialogs for progress export and import, and, in builds that include importers, "Add a map" from a web page. It shows the map images that are in a pack's folder, wherever they came from. The plain Atlas app is a viewer: it cannot fetch map images from other servers. A downloader for packs whose map images live on a tile server, and saving them from a map page, are only in builds made with `ATLAS_ENABLE_DOWNLOADS=1` (see "Building another app from the shell").

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

`desktop:dev` starts Vite on port 1420 (`--strictPort`, so it stops rather than attach to another server) and opens the window on it; packs come from the dev server, as in the browser. For a window with map image downloads, run `ATLAS_ENABLE_DOWNLOADS=1 pnpm desktop:dev --features downloads` (the variable is for the web app, the feature for the shell).

`desktop:build` builds the web app and demo pack, prepares `apps/desktop/dist` from it (`scripts/prepare-frontend.js`), compiles the Rust shell and writes installers to `apps/desktop/src-tauri/target/release/bundle/`: NSIS `.exe` on Windows, `.app` and `.dmg` on macOS, `.deb`, `.rpm` and `.AppImage` on Linux. Tauri CLI options can follow, for example `pnpm desktop:build --debug --no-bundle` for a quick debug build without installers.

Rust checks, from `apps/desktop/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`, and the last two again with `--features downloads` for the code of a build with downloads. They work on a fresh clone; nothing has to be built first.

### Building another app from the shell

A build can give the app its own name and identifier, so it installs next to the plain Atlas app instead of replacing it:

```sh
ATLAS_APP_NAME="My Atlas" ATLAS_APP_IDENTIFIER=org.example.my-atlas pnpm desktop:build
```

`scripts/build.js` checks both (set both or neither; the identifier must differ from `dev.atlas.desktop`), writes them to `src-tauri/tauri.identity.conf.json` (ignored by git) and passes it to `tauri build` after the bundling config. The name becomes the product name, the window title, the installer's name and the name shown in the top bar. Such an app keeps its own app data, and so its own progress and settings of the page, but shares the maps folder and the shared settings file (below) with every other Atlas app.

Map image downloads are switched on the same way, at build time, with `ATLAS_ENABLE_DOWNLOADS=1` (unset or `0` leaves them off, anything else is refused):

```sh
ATLAS_ENABLE_DOWNLOADS=1 ATLAS_APP_NAME="My Atlas" ATLAS_APP_IDENTIFIER=org.example.my-atlas pnpm desktop:build
```

It turns on "Download map images" and "View map page and save images as I browse" (see the sections below), in every layer at once:

- `scripts/build.js` passes `--features downloads` to `tauri build`. Only with the shell's `downloads` Cargo feature is that code compiled in (`src/tiles/download.rs`, `downscale.rs`, `manager.rs`, `src/pageview/`, and the HTTP client): without it the binary has none of it, and its commands (`tiles_*`, `download_settings_*`, `view_*`) do not exist.
- `build.rs` lists those commands only with the feature, and only then reads `capabilities/downloads/main-downloads.json`, which grants them to the main window; `capabilities/main.json` grants the commands of every build. A capability that names a command the build does not have would stop the build, so the file is chosen at build time.
- The web build that `tauri build` runs first reads the same variable (`apps/web/vite.config.ts`) and folds it into the bundle as the constant `__ATLAS_DOWNLOADS__`. Without it the download panel, its settings, the map page actions and their card are left out of the bundle, not only hidden: a map without its images just says that its image is not installed, and the Maps dialog offers neither downloading nor saving.
- `desktop_info` says whether the shell has downloads (`downloads`), and the web app offers them only when both agree.

Without it, the default, the app still shows map images already in a pack's folder (downloaded by an earlier version or by a build with downloads), moves those of version 0.2.0, counts them and deletes them ("Delete downloaded images…"), deletes maps and keeps the activity log. `node scripts/check-binary.js [binary]` checks a built binary: it fails when a viewer holds download code (the names of its commands, the downloader's User-Agent or the saving script), or when a build with downloads lacks it. Which one it expects is what `ATLAS_ENABLE_DOWNLOADS` says when set, else what the last `pnpm desktop:build` recorded in `src-tauri/atlas-build.json` (ignored by git), else a viewer; the smoke and Windows start-up tests check the same way, so a builder sets the variable for the build only. CI and the release workflow run it.

Importers are added the same way, at build time: `ATLAS_BUNDLE_IMPORTERS` takes comma-separated paths of importer modules (absolute, or relative to the repository root). `scripts/prepare-frontend.js` loads each in Node to check it against the contract in `packages/importer-api` (and refuses modules that import Node built-ins), copies it to `dist/importers/<id>.js` and lists it under `importers` in `config.json`. A build without it has no importers and shows no "Add a map".

### Desktop tests

Five WebDriver tests drive the built app through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/). They need `cargo install tauri-driver --locked` and the platform's WebDriver: on Linux the package that provides `WebKitWebDriver` (`webkitgtk-webdriver` on newer Ubuntu and Debian releases, `webkit2gtk-driver` on older ones), `xdotool`, and `xvfb-run` without a display. They run on Linux; see below for Windows. Screenshots go to `apps/desktop/test-results/`. On Linux, the tests run the app with `XDG_DATA_HOME` and `XDG_CONFIG_HOME` in a temporary folder, so they start from a first launch and leave your own data alone, and with a stand-in system browser that only records the links it is asked to open.

- `pnpm --filter @atlas/desktop test:e2e` (smoke test, on a `pnpm desktop:build` with the demo pack and without downloads): the map, its tiles and markers load; progress can be saved (IndexedDB works); the pack protocol answers range requests; the shell's commands answer. It checks that the binary holds no download code, that `desktop_info` says so and that the download and map page commands are refused. On Linux it also exports progress through the native save dialog and imports it back through the open dialog (typing into them with `xdotool`), checks that a guide link opens in the system browser while the window stays on the app, that the plain app has no "Add a map", and opens a pack folder through the native folder picker; that pack has no map images, and the notice only says so, with no download; and the Maps dialog, which also lists a pack added from a web page, offers no download, no map page and no saving. It expects downloads when the last `pnpm desktop:build` recorded them in `src-tauri/atlas-build.json`, or as `ATLAS_ENABLE_DOWNLOADS` says when it is set (a stale `src-tauri/target/release/packs/e2e-remote` from a build for the other tests makes it fail: rebuild without it).
- `pnpm --filter @atlas/desktop test:e2e:download` (download test, Linux, on a build with downloads): downloads map images from a mock tile server on `127.0.0.1:4431` (`ATLAS_E2E_TILE_PORT` to change it) through the app's interface, over three launches: the middle of the map asked for first, a refusing server (the panel names the refused image and its address, and the Activity log dialog shows the refusal and copies exactly the lines of the log file it shows), Standard detail with one corner answered the way an object store answers for an image it does not have (counted as not on the server, the four tiles under it never asked for), an upgrade to Full detail with pause and resume, the app closed mid-way and the job picked up after a restart, and the last game remembered. It checks every request the server saw (one per tile, the User-Agent, no cookie), the status files, and that markers sit on dots the server paints into its tiles. Build it with the test pack first:

  ```sh
  pnpm --filter @atlas/desktop e2e:pack     # writes packs/e2e-remote/ and packs/test-isles/ (ignored by git)
  ATLAS_ENABLE_DOWNLOADS=1 ATLAS_BUNDLE_PACKS=e2e-remote,demo pnpm desktop:build --no-bundle
  xvfb-run -a pnpm --filter @atlas/desktop test:e2e:download
  ```

  `node apps/desktop/e2e/tileServer.js` runs the mock server on its own, to try the pack by hand.

- `pnpm --filter @atlas/desktop test:e2e:import` (maps library and import test, Linux), on the same build with the demo importer and the test pack `test-isles` added (`ATLAS_BUNDLE_PACKS=e2e-remote,demo,test-isles ATLAS_BUNDLE_IMPORTERS=packages/importer-api/demo/demo-importer.js`; `e2e:pack` writes `packs/test-isles/` too, a made-up game built from the demo site's pages with the demo importer, with its page data). The demo site runs on `127.0.0.1:4432` (`ATLAS_E2E_SITE_PORT` to change it; the demo importer's list of worlds and `test-isles` name that port). Before the first launch it writes what an earlier version and the person could have left behind: a half-done version 0.2.0 download in the old app data folder, and a shared settings file remembering a copied pack folder with its images (under a path with spaces and non-ASCII letters), a folder with a second pack of an id already shown, a folder that is gone and a folder that is not a pack. It checks that the old download moves into the pack folder and finishes without fetching anything twice, that download settings are saved to the shared file, the Maps dialog's locations and their states, the hidden duplicate and its reason, forgetting a location without deleting files, and the copied pack's own images. Then it adds maps from a made-up map site on `127.0.0.1` (`e2e/demoSite.js`): an address no importer knows, a page whose data appears after a while, a second map of the same game, the first page again after the site changed, a game that comes with the app, data in the wrong shape, cancelling, and waiting too long, and it downloads the imported game's map images into its pack folder. The made-up page tries to call the app, read its packs, open a window and leave for another site, and reports what happened; the test checks that each was refused. A second launch checks that everything is remembered and deletes the imported pack. Then it pastes several addresses at once: two maps of one made-up game, one of another, a game that comes with the app, a page whose data never appears, a repeat and an address no importer knows. It checks that the unknown address is shown before anything opens, that the pages are asked for once each in the order given, one at a time and at least 3 seconds apart (from the activity log's times), that the run goes on past the pages not added, the state of each, the summary, the game shown at the end, a single offer to download map images, and the run's lines in the activity log. `node apps/desktop/e2e/demoSite.js` runs the site on its own.

- `pnpm --filter @atlas/desktop test:e2e:delete` (delete test, Linux), on the same build as the download test. Before the first launch it puts a made-up game "My Game" into the maps folder and a `.deleting-*` folder as a delete leaves behind when a file stays in use. It checks that the left-over folder is removed at start; that **Delete downloaded images…** on the bundled test pack says how many images go, removes them and only them, and the map asks for them again; that **Delete…** on "My Game" during a slow download says the download is stopped first, deletes the folder mid-download with nothing left behind and no request after it, and that the app goes on working; and, after a restart, that both stay that way. `ATLAS_E2E_SHOTS=<folder>` also copies the pictures of both confirmations there.
- `pnpm --filter @atlas/desktop test:e2e:view` ("View map page" and "Save map images as I browse" test, Linux), on a build with downloads. It needs `python3` as well, to send a window the close request its close button would (there is no window manager under Xvfb). It serves a made-up map site and its image server on `127.0.0.1` (`e2e/mapPageSite.js`; `node apps/desktop/e2e/mapPageSite.js` runs them on their own) and writes a pack made from two of the site's pages into the maps folder, with one map image already in it. It checks that the Maps dialog lists the pages, that "Open in my browser" hands the recorded address to the system browser, that addresses the pack does not record are refused, and that plain viewing writes nothing. With saving on, a page that loads its images with `fetch` and `XMLHttpRequest` while "zooming in": each image lands in the pack where the downloader puts it, byte for byte, the image already there is kept, a marker icon and a level the pack does not use are ignored, the status file, the shrunk level and the manifest are brought up to date, the pack's lock is held so a download cannot start, the page cannot call the app, read packs, open windows or leave its site, three images at the map's edge, answered the way an object store answers for an image it does not have before the page loads the rest of their level, get the downloader's "not on the server" marker, a count on the card and a line in the activity log, the map shows the saved images, and the image server saw every image asked for exactly once. A page that shows its images with `<img>` elements and a `no-cors` request gets "could not be saved" and nothing written, and closing its window stops saving and frees the pack.

CI is set up to run the smoke test on the default build, and the other four on a build with downloads, on Linux; that Linux job is switched off for now (the `desktop` matrix in `.github/workflows/ci.yml` lists Windows only), so run them locally on Linux when you change what they cover. On Windows, CI runs `pnpm --filter @atlas/desktop test:e2e:windows` instead (`e2e/windows.js`), on the default build: it checks that the binary holds no download code (the same check as `scripts/check-binary.js`; on a build with downloads, that it holds it), then starts the built app with a temporary WebView2 profile and checks from outside that the window opens with the app's title, that the embedded browser starts the app's page, and that the app is still running and responding ten seconds later. It saves a picture of the desktop to `apps/desktop/test-results/desktop-windows.png`, which CI uploads, for a person to look at. It does not look inside the page: an Edge WebDriver has to match the installed WebView2 exactly, and both it and a direct DevTools connection rely on `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which WebView2 does not apply to an app that passes browser arguments of its own, as Tauri does.

The first name in `ATLAS_BUNDLE_PACKS` is the game shown on first launch; after that the app opens the game picked last. Any pack folder in `packs/<id>/` can be bundled this way.

## Android

The same shell builds an Android app, a viewer for Android 10 (API 29) and later, with the identifier `dev.atlas.android` and the name "Atlas" (`src-tauri/tauri.android.conf.json`, which Tauri merges over `tauri.conf.json` for Android builds). The desktop app's identifier and behaviour do not change.

It needs, besides Node.js, pnpm and Rust: Java 17, the Android SDK and NDK with `ANDROID_HOME` and `NDK_HOME` set (see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/#android)), and the Rust target `aarch64-linux-android`. Then, from the repository root:

```sh
pnpm android:build --target aarch64
```

`scripts/build.js android` creates the Android project with `tauri android init` when `src-tauri/gen/android` (ignored by git) does not exist, then runs `tauri android build --apk` with the other arguments. The APK, unsigned, lands in `src-tauri/gen/android/app/build/outputs/apk/`. `bash scripts/sign-apk.sh <unsigned.apk> <signed.apk>` aligns and signs it with `zipalign` and `apksigner` and verifies the signature: with the key in `ANDROID_KEY_BASE64` (a keystore, base64), `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` when they are set, else with a key made for that run only, which cannot update an app signed with another key. The version code follows the app version (major × 1,000,000 + minor × 1,000 + patch), so a newer build installs over an older one signed with the same key. The build refuses `ATLAS_ENABLE_DOWNLOADS=1`, `ATLAS_BUNDLE_IMPORTERS` and `ATLAS_APP_NAME`/`ATLAS_APP_IDENTIFIER`.

How it differs from the desktop app:

- **Packs that come with the app** are part of its web build (`packs/<folder>/` in `dist`), served with the page from `http://tauri.localhost`, not resources served by the `atlas-pack` protocol: an Android app's resources are inside its package, not a folder. They must use folder tiles, since the Android WebView answers byte ranges from the app itself and so cannot read PMTiles archives; the build sets `ATLAS_DEMO_TILES=xyz` for the demo, and `scripts/prepare-frontend.js` refuses a pack with a `.pmtiles` file for Android.
- **The `atlas-pack` protocol** is served at `http://atlas-pack.localhost/<id>/`, as on Windows, for packs in the maps folder.
- **The maps folder and the shared settings file** are in the app's own storage (`Atlas/Maps` and `Atlas/settings.json` under the app's data folder). The page keeps the `http` scheme (`http://tauri.localhost`), so progress in IndexedDB stays where it is from one version to the next.
- **Not on Android:** folder dialogs (choosing the maps folder, adding pack folders), showing folders in a file manager, progress export and import (Android's dialogs give `content://` addresses that the shell cannot read or write yet), the import window and "Add a map", moving the map images of version 0.2.0, map image downloads, and exporting map pack files or picking one to import (the import commands that take a path are there, waiting for Android's file picker to be connected). The commands for them answer "This is not available on this device." and `desktop_info` says `folders`, `progressFiles` and `imports` are false, so the web app shows no Maps button, no export or import of progress files (it says so in the Profiles dialog) and no "Add a map".

`node scripts/check-apk.js <app.apk> [--packs demo] [--forbid <text>]...` checks a built APK and the frontend it was built from (`dist`): the native library holds no download code (as `check-binary.js` does), the app comes with exactly the packs named, `config.json` lists no importers, and no file contains a forbidden text. CI's Android job runs it, and checks the package name, the app name, the minimum Android version and the 64-bit ARM library with `aapt2`. CI also signs that APK with a throwaway key and checks it again. Running the app on a phone or an emulator is not part of CI.

The `Android release` workflow (`.github/workflows/android-release.yml`, run by hand with the version in `apps/desktop/package.json`) builds the APK with the demo pack only, signs it (with the repository secrets `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` when they exist, else with a throwaway key, which the release notes then mention), runs the checks above, and attaches `Atlas-<version>-android.apk` to the release `android-v<version>`: a draft unless its `draft` input is turned off. No signing key is ever committed to this repository.

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

The defaults are local folders, not ones that a cloud service syncs. Each entry of the maps folder is a complete pack folder: the pack files, the map images downloaded for it at its layers' own tile paths, their status files (`offline-tiles/`), page data kept by an import (`import/`), and the app's lock, unfinished-download record and, for a pack imported from a map pack file, that file's description (`.atlas/`). Nothing in it names the computer, the user or an app, so a pack folder can be copied elsewhere, or to another computer, and opened there.

The **Maps** button (folder icon in the top bar) opens a dialog that shows:

- the maps folder, with **Change…** and **Open folder**. Changing it never silently moves gigabytes: after choosing a folder the app offers **Move my maps there** when the packs can be moved by renaming (same drive; every pack is checked before any moves, and a pack that is downloading stops it), and **Use it for new maps only** otherwise or when preferred, in which case the old folder stays listed as a folder of packs and can be moved by hand;
- every pack shown, where it comes from (the app, the maps folder or an added folder), its folder, and **Show**, **Open folder**, **Update from the site…** (games added from web pages with an importer of this app; see "Updating games" below), **Rebuild** (imported packs, from the page data kept with them), **Export…** (see "Map pack files" below), **Details** (where the game's data came from and when its pages were last read, the pack version, what it holds, at what detail and when its map images were downloaded, and the map pack file it was imported from, if any), **Delete downloaded images…** for every pack with a folder, and **Delete…** for packs in the maps folder that do not come with the app (see "Deleting maps and map images" below);
- **Update all…** above the packs, when any game can be updated from its site, and **Import map pack file…**;
- packs that are not shown, and why;
- **Map packs elsewhere**: pack folders added with **Open a map pack…** (one pack folder anywhere) and folders of packs added with **Choose maps folder…**. They are remembered between runs and between apps. A location that is gone (for example an unplugged drive) stays listed as "Not found" with a plain message, and comes back when the drive does; a folder that is not a pack, or holds none, says so. **Remove from list** forgets a location and never deletes files.

Packs are read as untrusted: only folders whose `manifest.json` is a pack manifest of version 1 or 2 with a usable id are listed (at most 4 MB), the web app validates every file with the pack schema, symbolic links are not followed out of a folder, hidden folders are skipped, and the protocol's path checks apply. Nothing is written into a pack folder that was opened for viewing unless the person starts a download or an import for it.

**One pack per id.** When two folders hold packs with the same id, one is shown: a pack that comes with the app and has no remote images first, then the maps folder, then the added locations in the order they were added. The others are listed under "Not shown" with the folder that won. Packs are never merged.

**Packs that come with the app.** An app whose bundled packs have remote map images (built with such packs in `ATLAS_BUNDLE_PACKS`) installs them into the maps folder at start-up, when the maps folder has no pack with that id, or replaces only their pack files when the bundled version is newer (map images and other files are never touched). A bundled pack may come with the page data it was made from (`import/` and the manifest's `source`), so that it can be refreshed from its site like an imported pack (see "Refreshing a game that comes with the app" below); that page data is installed with it, and replaced with the pack files when the bundled version is newer. The demo world stays in the app's resources.

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

Neither follows a symbolic link or junction out of the pack folder: a linked folder on the way to a file is skipped, and a link is removed itself, never what it points to. The start-up clean-up looks only at entries directly inside the maps folder: `.deleting-*` folders, `.importing-*` folders that an import left when the app was closed during it (when no app holds their lock), and marked folders without a manifest that no app holds.

### Two apps, one maps folder

The plain build of this repository is "Atlas" (`dev.atlas.desktop`). Another build of the same shell, with its own name and identifier and with importers (see "Building another app from the shell"), installs next to it. Both list the same maps folder and the same remembered locations, so a game added or downloaded in one shows up in the other after a restart or **Refresh**. Progress stays per app.

### From version 0.2.0

Version 0.2.0 kept downloaded map images in an overlay in its app data folder, `<app data of dev.atlas.desktop>/packs/<pack id>/` (`tiles/`, `offline-tiles/`), and unfinished jobs in `<app data>/downloads/<pack id>.json`. At start-up, every app looks in that folder explicitly (whatever its own identifier) and moves each overlay into the pack folder of the same id in the maps folder, which the bundled pack has just been installed into: files are moved one by one by renaming, or copied to a `.migrating.part` file and renamed when on another drive, status files last; the job record becomes `.atlas/download-job.json`; the old folder is removed when empty. It holds the pack's lock while it works, is safe to interrupt and continues on the next start; files already in the pack folder are kept. Overlays of packs that are not in the maps folder (for example the demo world) stay where they are. While a pack's images are being moved, the Maps dialog says so.

## Map pack files

A **map pack file** (`.atlaspack`) is one game in one file: its pack files and its map images up to a chosen level of detail, to copy to another computer or to Atlas for Android and import there, for example where the game's map site cannot be reached. Every build has it, including the plain viewer and the Android app: it copies files the app already has and never fetches anything.

**Export…** on a game in the Maps dialog opens a dialog that says what the file is for and offers the three levels of detail of map image downloads (Overview, Standard, Full detail), each with its number of map images and the file's size, worked out from the files on disk without reading any image. A detail is offered only when every downloadable layer has all the levels it needs; otherwise it is shown greyed out with the layers that are not downloaded ("Not downloaded: Surface (East Field)."). Layers whose images all come with the pack (folder tiles with no remote source) are put in whole at every detail, and the dialog says so. A game whose map images are a PMTiles archive cannot be exported, and the dialog says why (one large archive file, which a map pack file does not carry and Atlas for Android cannot read). Export is refused while a download of the game is running or paused, or its files are being moved. **Export** asks where to save, with `<pack id>-<detail>.atlaspack` as the name, shows the progress with **Cancel**, and ends with the file's path and size, the number of map images, and when the data was read from the game's pages and the images downloaded. Dates are shown in local time, with the exact time in UTC as their tooltip.

**Personal data is never in a map pack file**: no found marks, ticks, profiles, presets or settings (they are in the app's web storage, not in the pack folder), no page data kept by "Add a map" (`import/`) and nothing from `.atlas/`. The Export dialog's **Also save my progress beside it** (off unless ticked) writes a second file next to the map pack file, `<name>.progress.json` for `<name>.atlaspack`, after the map pack file is complete. It is exactly what **Export all profiles** writes: the progress of every game and profile, since the progress export cannot be limited to one game (the dialog says so). Import it with **Import from file…** in the Profiles dialog. If it cannot be written, the map pack file is still there and the result says which part failed.

**Import map pack file…** opens a file dialog and reads only the file's description (`atlaspack.json`, the first entry) before anything is written. The dialog shows the game, its version and contents, the detail and number of map images, where its data came from, when its pages were read and its images downloaded, and the app that made the file and when. When a game with the same id is installed, both are shown side by side, with a sentence on which is newer: by when their data was read from the game's pages, then by pack version, then by when the file was made against the installed game's own last change (what is not recorded is never guessed; when nothing tells, the dialog says so). Importing data older than the installed game takes a deliberate second click ("Replace with the older file"). Importing a game that is in the maps folder replaces it in its own folder: found marks are kept, since progress is kept by game id, and its pack files and map images are replaced by the file's. A game that comes with the app is imported only in a version at least as new as the app's, and when the app serves it from its own files (all its map images come with it), only in a newer one; it goes into the maps folder and is shown in place of the app's, as a game refreshed from its site is. A game in an added folder is left as it is and shown from the maps folder instead. Import is refused while a download of the game runs, or its files are moved. Afterwards the game is listed and shown.

The import treats the file as untrusted. Before anything is written it checks every entry: the name must be a plain relative path (no `..`, no absolute path or drive letter, no `\`, no hidden segment such as `.atlas`), and one of the pack's JSON files (at most 64 MB each, 256 MB together, as for packs on disk), a status file (`offline-tiles/<layer>.json`, at most 1 MB) or a map image at a path one of the pack's own layer templates gives (at most 16 MB) or its empty `.404` marker; no symbolic links, at most 4,000,000 entries; the manifest's id must be the description's. There must be room on the disk for the unpacked files plus 64 MB. The pack is unpacked into a hidden `.importing-<id>` folder in the maps folder, under that folder's lock, with the manifest last, and renamed into place when complete; a pack it replaces is first renamed to `.deleting-<name>` and renamed back if the swap fails. A failure or **Cancel** leaves the maps folder as it was. The description is kept with the pack as `.atlas/pack-file.json` (`{ "importedAt", "fileName", "header" }`), for **Details**.

### The format

A map pack file is a ZIP archive (with ZIP64 records when its size, offsets or number of entries need them) that holds the pack folder's contents at its root:

1. `atlaspack.json` (deflated), always the first entry, so it can be read without the rest of the file;
2. the pack's JSON files that exist (`manifest.json`, `maps.json`, `layers.json` and the others listed under "Data packs" in the main README), deflated. `layers.json` is unchanged, so a layer keeps its remote source and an Atlas with downloads can fetch the levels left out later. In a version 2 manifest the image summary of each downloadable layer (`contents.maps[].layers[].images`) is rewritten to what the file holds (`levels`, `complete`: every level of the layer, `files`, `bytes`, `updatedAt` kept); every other field and the field order are kept, and a version 1 manifest is left as it is;
3. each downloadable layer's status file, `offline-tiles/<layer local id>.json`, rewritten to the levels in the file, with its time kept;
4. the map images of every folder layer at the layer's own `url` filled in, in any order of placeholders, with the `.404` markers of those levels, stored as they are (they are compressed already). A downloadable layer has the levels from its `minZoom` up to the detail's top level (the top level minus 2, 1 or 0, as for downloads); the map enlarges the top level it has when zoomed in further. Other folder layers are included whole.

Every entry has the time the file was made (in UTC, since ZIP times have no zone) and the permissions `0644`. Atlas reads version 1 of the format; a file of a newer version is refused with a message that names the app and version that made it, and a file whose first entry is not a description of format `atlas-pack-file` is "not an Atlas map pack file".

`atlaspack.json`, for a made-up game:

```json
{
  "format": "atlas-pack-file",
  "version": 1,
  "packId": "test-valley",
  "title": "Test Valley",
  "packVersion": "1.1.0",
  "detail": "standard",
  "exportedAt": "2026-11-11T09:30:00Z",
  "exportedBy": { "name": "Atlas", "version": "0.3.5", "platform": "windows" },
  "pack": {
    "id": "test-valley",
    "title": "Test Valley",
    "packVersion": "1.1.0",
    "gamePatch": "demo",
    "schemaVersion": 2,
    "attribution": [{ "name": "Demo map site (made-up test data)" }],
    "created": "2026-11-10T21:30:00.000Z",
    "updated": "2026-11-10T21:32:10.000Z",
    "writtenBy": { "name": "Atlas", "version": "0.3.5" }
  },
  "source": {
    "kind": "web-pages",
    "importer": { "id": "demo-maps", "title": "Demo map site" },
    "pages": [
      {
        "url": "http://127.0.0.1:4432/demo-maps/test-valley/east-field",
        "mapId": "test-valley:map:east-field",
        "importedAt": "2026-11-10T21:30:00.000Z"
      }
    ],
    "newestPageAt": "2026-11-10T21:30:00.000Z",
    "oldestPageAt": "2026-11-10T21:30:00.000Z"
  },
  "contents": {
    "maps": 1,
    "layers": 1,
    "locations": 4,
    "categories": 2,
    "regions": 0,
    "checklists": 0,
    "guides": 0
  },
  "images": {
    "detail": "standard",
    "files": 5,
    "bytes": 1600,
    "layers": [
      {
        "id": "test-valley:layer:east-field",
        "name": "Map",
        "mapName": "East Field",
        "minZoom": 0,
        "maxZoom": 2,
        "levels": [0, 1],
        "files": 5,
        "bytes": 1600,
        "complete": true,
        "full": false,
        "downloadable": true,
        "downloadedAt": "2026-11-10T21:35:00.000Z"
      }
    ]
  },
  "files": 12,
  "bytes": 9876
}
```

| Field               | Meaning                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `version` | `atlas-pack-file`, `1`.                                                                                                                                                                                                                                                                                             |
| `packId`, `title`   | The game, as its manifest names it.                                                                                                                                                                                                                                                                                 |
| `packVersion`       | The pack's own version.                                                                                                                                                                                                                                                                                             |
| `detail`            | `overview`, `standard` or `full`.                                                                                                                                                                                                                                                                                   |
| `exportedAt`        | When the file was made (ISO 8601, UTC).                                                                                                                                                                                                                                                                             |
| `exportedBy`        | The app that made it: its name, version and system (`windows`, `linux`, `macos`, `android`).                                                                                                                                                                                                                        |
| `pack`              | From the manifest: id, title, pack version, game patch, `schemaVersion`, attribution, and for version 2 `created`, `updated` and `writtenBy` when it has them.                                                                                                                                                      |
| `source`            | Where the data came from: `kind` `web-pages` (made with an importer: its id and title, each page with its map and when it was read, from the manifest and the page data index, the later time winning; and the newest and oldest of those times), `app` (comes with the app) or `unknown`.                          |
| `contents`          | Maps, layers, locations, categories, regions, checklists and guides, counted from the pack's files.                                                                                                                                                                                                                 |
| `images`            | The detail, the number and bytes of map images in the file, and per folder layer: its id, name and map, zoom range, the levels in the file, their files and bytes, `complete` (every level up to the detail's top), `full` (every level of the layer), `downloadable`, and `downloadedAt` (its status file's time). |
| `files`, `bytes`    | The entries after the description, and their size unpacked.                                                                                                                                                                                                                                                         |

Dates are written only when the pack records them; none is made up. A field this list does not name may be added in a later version 1 file and is ignored.

### The commands and tests

`packfile_options` (what can be exported of a game and how large each detail is), `packfile_export` (save dialog, then the file; with `progress`, the text of a progress export to write beside it), `packfile_pick` (open dialog, then the description and what importing would do), `packfile_inspect` (the same for a path the app already has), `packfile_import` (a path and whether to replace), `packfile_progress` and `packfile_cancel` (one export or import at a time), and `library_pack_details` (what **Details** shows). `packfile_export` and `packfile_pick` use the system's dialogs and are not available on Android yet; the others take a path and work there too, so Android's file picker can be connected to them later. Each export and import writes lines to the activity log (area `library`). The Rust side is `src-tauri/src/packfile/` (`export.rs`, `import.rs`, `shell.rs` for the maps library's rules, `space.rs` for the free space); the web side is `state/packFile.ts`, `components/PackFileDialog.tsx`, `components/PackFacts.tsx` and `components/packFileText.ts`.

The shell's unit tests (`src-tauri/src/packfile/tests.rs`, run by `cargo test`) export made-up packs at each detail and import them again, and check the description, the rewritten status files and manifest, the overlay, PMTiles refusal, the lock and cancelling, a newer or foreign format, reading the description from a cut-off file, unsafe entry names and symbolic links, wrong ids and sizes, a full disk, replacing in place and a failed swap, the start-up clean-up, a file with 70,000 entries (ZIP64) and the rules for games that come with the app. The browser test `apps/web/e2e/packFiles.spec.ts` drives both dialogs against a stand-in shell: the details offered, cancelling, the progress export beside the file and its failure, the side-by-side comparison and its newer or older sentence, the second click for older data, and the game listed and shown afterwards.

## Downloading map images

Only in a build with downloads (`ATLAS_ENABLE_DOWNLOADS=1`, see "Building another app from the shell"). A build without them, such as the plain Atlas app, says "Map image not installed" on such a map and offers nothing more; it shows the images a build with downloads put into the pack folder, and the Maps dialog can delete them.

A pack may ship without its map images when its `xyz` layers name a remote source (`tiles.remote` in `layers.json`: an `https` URL template and, per pyramid level, which remote zoom and tile offset it maps to). The desktop app with downloads then offers **Download map images** on the map's "not installed" notice, and a **Map images** button once some are there. The plain web build never shows either.

- **Detail**: Overview, Standard or Full, the top level minus 2, 1 or 0 (never below the lowest remote level). Each choice shows its image count, what is left to fetch, and a rough size and time from typical tile sizes and the polite pace below. Choosing more detail later fetches only the new levels.
- **Order**: the lowest remote level of every layer first, so each map is usable early; then upwards. Within a level, the middle of the map first and outwards from there: the tiles one remote tile up covers (2 × 2, its "children") are asked for together, and these groups go by their distance from the middle of the level, in proportion to its width and height; within a group the tile nearest the middle comes first, and ties go top to bottom, left to right. The order is the same every time, so a resumed job carries on where it stopped. The middle is the part of a map most likely to be on the server; the edges of a grid padded beyond the picture often are not. Levels below the lowest remote level are built from it by 2×2 downscaling (Lanczos3), with a neutral dark background where a child tile is missing; JPEG (quality 85), PNG and WebP (lossless) tiles are written in the layer's own format.
- **Where**: tiles go into the pack's own folder at the layer's own `url` filled in, for example `<maps folder>/<pack id>/tiles/<map>/<z>/<x>/<y>.jpg`, each written to a `.part` file first and renamed when complete. After each level, and when the job ends, a version 2 manifest's `contents.maps[].layers[].images` is updated (levels, complete, file count and bytes); every other field and the field order are kept, and version 1 manifests are left alone. A tile the server answers with 404 or 410 leaves an empty `<tile>.404` marker and is never asked for again.
- **Images that are not on the server**: besides 404 and 410, an object store that lets nobody list its contents answers a request for an image it does not have with HTTP 403 and a small XML error document whose code is `AccessDenied`. Atlas counts that answer as "not on the server" only when all of these hold: the status is 403; the type is `application/xml` or `text/xml`; the body, after an optional `<?xml …?>` declaration, is one `<Error>` element holding only simple text elements (`<Code>`, `<Message>`, `<RequestId>`, …) and exactly one `<Code>AccessDenied</Code>`; and the same host has already sent images of the same layer, in this download or in an earlier one (an image of the layer is on disk). Before that, the same answer is a refusal like any other and stops the job at once, so a server that refuses Atlas altogether still stops it at the first request. A 401, any other 403 (another code, a web page, plain text) and every other answer are handled as before. When a tile is not on the server, the tiles under it on the next level (same remote zoom plus one, its four children, for levels the layer lists) are marked missing too and never asked for. The level summaries in the activity log and the summary of a finished download say how many images were not on the server and how many were not asked for.
- **If the server starts refusing**: when 64 of these "access denied" answers come in a row with no image in between, the job stops as a refusal ("it may have started refusing downloads"). Above the lowest level, an honest store answers at most 6 in a row (3 children of one tile and 3 of the next, at most 6 per parallel download in the order answers arrive), and the lowest level is a few tiles across, so 64 leaves room while costing a refusing server at most 64 more requests. Markers from these answers are only written to disk with the next image or when the job ends; when the job stops this way, the markers since the last image are dropped, so those images are asked for again next time instead of being wrongly recorded as missing.
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
- **Polite by design**, whatever the settings: an honest `User-Agent: Atlas/<version>` (for example `Atlas/0.3.2`) with `Accept: image/*`, no cookies and no browser-imitating headers; network errors and 5xx answers retried up to 5 times with doubling waits (2 s up to 60 s); a 429 answer pauses every worker for its `Retry-After` (up to 15 minutes); the job stops with a plain reason on 401 or 403 (no way to bypass a refusal; the one exception is an object store's "no such image" from a server that has already sent images of the layer, above), on an HTML answer (a login or error page), when the disk refuses a write, or after 10 failures in a row (an answer over 16 MB or that is not an image counts as a failure). Remote sources must be `https`; plain `http` is accepted only for `127.0.0.1` and `localhost`, for tests.
- **When the server refuses**: on 401, 403 or a web page (or after 64 "access denied" answers in a row, which the panel also says), the panel says which image it was (layer, level, column and row, counted from 0, and whether it is at an edge of the map), shows its address to copy, how many images this download had saved before it and what the server answered (selected headers and the start of a text body), with **View log**. This is kept in the job record as `stopDetail`, so it is shown again after a restart. Nothing about the request changes: the job still stops at the first refusal and does not retry.

The Rust side is `src-tauri/src/tiles/` (`pyramid.rs` tile maths matching `pyramidLevel` in `@atlas/core`, `download.rs` the polite downloader, `downscale.rs`, `status.rs`, `store.rs` the overlay, `images.rs` where downloaded images are, `manager.rs` jobs and progress; only `pyramid.rs`, `status.rs`, `store.rs` and `images.rs` are in a build without downloads), and `src-tauri/src/downloads.rs`, through which the maps library stops a download before deleting and finds the images to delete in either build; the web side is `apps/web/src/desktop.ts`, `state/downloads.ts`, `state/mapImages.ts` and `components/DownloadPanel.tsx`, and `features.ts` for the build flag.

## Adding maps from web pages

In a build with importers, the **Add a map** button (map icon in the top bar) asks for the address of a map page. The importer contract is in `packages/importer-api` (`src/index.ts`, with a made-up example in `demo/demo-importer.js`): an importer has an id, a title, `matches(url)`, a `pageReader` (the source text of a function that reads what it needs from the page) and `convert(pageData, context)`, which turns the page data into a pack.

1. The address must be `https` (or `http` on `127.0.0.1`/`localhost`, for tests), with no user name or password, and an importer must recognise it; otherwise the dialog says so.
2. The shell opens the page in a separate, visible window titled "Add a map – <site>", with the platform's own browser engine and user agent, in a private session (`incognito`: no cookies or storage kept from or shared with anything else). Tauri's own start-up script is present in every webview, but the window has no capability, so every command it might send is refused ("not allowed by ACL"), and the pack protocol answers it with 403.
3. Every two seconds the shell evaluates the page reader in the page (`eval_with_callback`), wrapped so an exception counts as "not there yet". When it returns a value, the value is kept in the page as JSON text and the shell pulls it out in slices of one million characters, capped at 64 MB in all, and checks that it is JSON. The page is never given a way to send anything to the app; the app only pulls the reader's result out.
4. The dialog shows that it is waiting, for how long, and after 20 seconds explains that the page may be asking the person to sign in, to confirm they are a person or to wait, which they can do in that window, or cancel. The app does not click, retry, reload, hide the window or change anything about it to get past such a check. When the importer's wait (300 s unless it sets 30 to 900 s) runs out, or the person closes the window, the import ends with a plain explanation and nothing is written.
5. The page data goes to the importer's `convert` in the app's window. What it returns is checked (`checkOutcome`): its shape, the pack against the pack schema and its integrity rules, the pack id against the manifest. Packs that come with the app are refused, unless the importer refreshes them (see "Refreshing a game that comes with the app" below). The shell checks the pack id, the file names (only the pack's own JSON files), sizes and JSON again, takes the pack's lock, writes the page data (`import/<page key>.json`, listed in `import/index.json` with its address, time and map) and the pack files, the manifest last, into `<maps folder>/<pack id>/` or into the folder the imported pack already has. It refuses to replace a pack that was not imported, or that another importer made.
6. The new pack is listed, its game and the imported map are shown, and the result lists the game, the map and the counts, with **Download map images…**.

**Several addresses at once.** The address box takes several addresses: one per line, or separated by spaces or commas. They are trimmed and exact repeats are dropped; one address works exactly as above. More than 25 are refused with a plain message. Each address is checked against the importers as a single one is; when some are not recognised, the dialog lists them before anything opens and offers to add the rest, leaving those out. The app then works through the pages in the order given, one at a time, in the same import window and with the same limits as a single page (`src/state/importRun.ts` in the web app; the shell only gets the usual `import_open`, `import_poll` and `import_close` calls, so nothing about the window changes): open the page, wait for its data as above, add or refresh the map, close the window, and wait 3 seconds (`RUN_PAUSE_MS`) before opening the next. The dialog lists every address with its state: waiting, open (with the hint to look at the window when the page takes a while), added or refreshed with the map's name, not added with the reason, or not started. A page is never opened twice and never retried.

- The run goes on to the next page when a page's data does not appear within the wait, the importer refuses the data, the game comes with the app, or saving that map fails; that page is shown as not added, with the reason.
- It stops when the person closes the page window (as for a single page; pages done stay done) or closes the dialog; when they press **Stop**, after the page that is open now (or at once between pages); and when two pages in a row end without their data, since a site that asks a person to step in on every page, or refuses, would do the same for the rest. Pages not reached are shown as not started.
- At the end the dialog sums up the run ("3 maps added, 1 refreshed, 1 not added"), and the game of the last map added is shown, with its map. Map images are offered once for the run: **Download map images…** for the game shown; when maps of several games were added, the dialog says to choose another game in the top bar to download its images.

**A game's address.** An importer may also read a game's own page, the one that lists its maps (`games` in the contract: `matches`, a `pageReader`, `convert`, and `gameAddress`, the game page of one of its map pages). Pasting such an address alone opens it in the import window exactly as a map page (same window, limits, wait and stop rules; the activity log says it is opened "to read the list of the game's pages"), and its `convert` returns the game's name and its pages: each with its address, a kind (`map`, or a word of the importer's, such as its site's name for checklists or guides), a name and an optional group heading. The app checks that list (`checkGameListing`: at most 500 pages, each `http(s)` on the game page's site, each map page one the importer's `matches` accepts, no repeats) and shows it with tick boxes, maps first: each page marked **New** or **Already added (will be refreshed)**, and pages the importer does not read listed as **Not supported yet**, unticked and disabled. Everything the importer can add is ticked to start with; **Add N maps** (or **Add N pages**) runs the ticked pages as a run of several addresses, below. A game address pasted with other addresses is refused with a plain message, as is the address of a list of games.

**A site's list of games.** An importer may offer its site's list of games (`catalogue`: an address, a label, `matches`, a `pageReader` and `convert`). **Add a map** then shows a button with that label for each such importer (and pasting the list's address does the same): the app opens the list (one page), checks what `convert` returns (`checkCatalogue`: at most 2,000 games, each with the pack id it would get, a name, an address on the same site that is a game page or, for a game with one map, a map page the importer reads, and optional search words), and shows it with a search box and tick boxes, nothing ticked, marking games already in the maps folder. For the ticked games it reads each game page in turn (a game with one map needs none) and shows all their pages in one list to tick, as above. The list is kept on the device once it has been read (with the time, among the device's settings, per importer): the button then shows the kept list at once, without opening the site, says when it was read, and offers **Update the list**, which reads it from the site again and keeps the ticks of games still listed. Pasting the list's address always reads it from the site. A kept list is checked like a fresh one before it is shown, and is read again when it does not pass or the importer's list has another address now; it counts as no page in the 25.

**25 pages at a time** counts every page opened in one go: the game pages and the list of games too. Games that would not fit are left for later and named; ticks beyond the limit are taken off the last pages, with a plain message, and ticking more than fit is refused until some are unticked. The pause between pages holds across the reading of the lists and the run that follows.

**Updating games.** **Update from the site…** on a game in the Maps dialog, offered for games added from web pages with an importer of this app, reads the game's page again: the importer's `gameAddress` of any page the game was made from. It lists the game's pages as above, new maps marked **New**; pages the game was made from that the game page no longer lists are listed too. When the importer has no game page for it, or it cannot be read, the pages the game was made from are listed instead (unticked when the game page could not be read). **Update all…** first lists every such game, all ticked; it then reads their game pages one at a time with the pause between them, and lists all their pages in one list, so all the ticked pages are refreshed or added in one run with the same limits and stop rules, and one summary at the end. Nothing is read or updated unless the person asks for it.

**Pages that become checklists.** A page may become a checklist of a game that is in the maps folder rather than a map: `convert` then returns `checklistId` instead of `mapId` (exactly one of the two), and the summary's `checklist` gives its items and the rows it left out. The importer decides which pages do this, and a map page may as well bring a game's checklists with its map. The result says "Added “Name” to Game, a checklist of N items", with the rows left out until their maps are added.

**Refreshing a game that comes with the app.** An importer that sets `refreshesBundledGames` may refresh a game that comes with the app, from a map page, a game address or **Update from the site…**. The refreshed pack must have a newer `packVersion` than the one that comes with the app and keep every map it came with (the web app and the shell both check, and nothing is written otherwise), and the importer must keep the ids the same; it is written into the maps folder with its page data, keeping the map images already there. A game whose bundled pack has no remote images (served from the app's resources) is copied into the maps folder with its own images first. At start-up the refreshed copy is kept (and shown instead of the bundled one) while its `packVersion` is at least the bundled one's; an app whose bundled pack is newer replaces the pack files and page data as above, and keeps the images. An importer without `refreshesBundledGames` gets a plain message that the game comes with the app, as before. `IMPORTER_API_VERSION` stays 1: all of this is optional, and an importer written for 0.3.3 works unchanged.

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
2026-11-12T09:12:03.123Z [Atlas 0.3.2] download error: Stopped: the server refused access (HTTP 403) for https://tiles.example.com/5/2/3.jpg | layer Surface (Island), level 2 (remote zoom 5), column 2 of 6, row 2 of 6 (counted from 0; not at an edge) | attempt 1 | this job had saved 0 images before it, 0 of them from tiles.example.com | headers: content-type: application/xml; via: 1.1 example-cache | body: <?xml version="1.0" encoding="UTF-8"?> <Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error> | not retried
```

That is a first request refused: nothing from that server has been saved yet, so the job stops. Once the server has sent images of the layer, the same answer for an image at the edge is counted instead, and the level's summary says so:

```text
2026-11-12T09:14:10.456Z [Atlas 0.3.2] download info: Counting https://tiles.example.com/5/0/0.jpg as not on the server: the store answered "access denied" (HTTP 403 with an AccessDenied error document), as it does for images that do not exist, and it has sent images of this layer in this download. Answers like this are counted in each level's summary; 64 in a row with no image in between stop the download
2026-11-12T09:15:02.789Z [Atlas 0.3.2] download info: Level 3 (remote zoom 6) of Surface (Island) complete: 144 images, 96 saved (3.1 MB), 0 already there, 0 not on the server (404/410), 12 not on the server (the store answered "access denied", as it does for images that do not exist), 36 not asked for, because the area above them is not on the server, 0 failed | answered "access denied", for example: …
```

Line breaks and control characters in messages are replaced, so a line is always one event. When the file would pass 2 MB it is renamed to `atlas.1.log` (replacing the one before) and a new file is started. Apps append under a lock on `atlas.log.lock`, so lines from two apps never mix. If the folder cannot be written, the app carries on and writes to standard error only; every line also goes to standard error.

What is in it: the app starting (version, system, maps folder, packs and importers it comes with, and whether it has map image downloads); each download (pack, layers, detail, images planned, already there and to fetch, the host and the pace), its pauses, resumptions, cancelling, waiting in line or for another app, progress every 30 seconds or 500 images, each level completed (images saved, already there, not on the server by 404 or 410 and by a store's "access denied", not asked for because the area above them is not on the server, and failed, with a few addresses of missing images) and its totals; every answer that was not an image (the address, the attempt and what happens next), and a refusal or web page in full, as above; adding maps (the host and path of the page, not its query, the importer, waiting, timing out or closing, and the outcome with its counts or the error; for several addresses at once, how many and from which sites when the run starts, why it stopped early, and its summary; for a game page or a list of games, the site and the number of pages found by kind, or of games, and how many are added already, for example "Read the list of a game's pages from https://maps.example.com: 3 map pages (2 already added, 1 new), 1 of kind checklists, 17 of kind guides"; for updating games, how many and from which sites); viewing a map page and saving its images as you browse (the page, the totals when saving stops, why the first image at each layer's edge counts as not on the server, and the first few images that could not be saved, were not recognised or were not on the server, with their addresses and the reason); deleting a map or its downloaded images; exporting and importing map pack files (the game, the detail, the file and its size, what the file says about itself, cancelling and errors, and whether a progress export was saved beside it); the maps library (what a scan found, changes to locations and the maps folder, packs installed or updated, packs in use by another app) and moving a version 0.2.0 download. Not in it: progress, the contents of files or of the pages maps were added from, and anything from web storage.

**To send it** with a question: open **Maps**, then **View activity log** (or **View log** in the download panel), choose the area and level, and **Copy all shown**; or **Open log folder** and attach `atlas.log` (and `atlas.1.log` if the problem is older). Check it first: it holds the addresses of the map images and pages, and the path of the maps folder.

The dialog reads the last 2,000 lines (at most 512 KB) through `activity_log_read`, shows them as plain text, and is not in the plain web build. The Rust side is `src-tauri/src/activity.rs`; other modules log with `activity::info(Area::Download, "…")`, `activity::warn` or `activity::error`.

## Viewing a map page and saving its images as you browse

Only in a build with downloads, like "Download map images". Plain viewing shares its window, its commands and its state with saving, so a build without downloads has neither: the Maps dialog lists such a pack without **Map page…**.

A pack added from a web page records its pages in its manifest (`source.pages[].url`). In the Maps dialog, such a pack has **Map page…**, which lists each page with:

- **View map page**: opens the page in a window of the app, just to look at it. Nothing is added to the page and nothing is read from it.
- **View map page and save images as I browse**: the same window, and while the person pans and zooms the page's map by hand, the map images that their own browsing loads are kept in the pack, exactly where **Download map images** would put them. A card over Atlas's map counts what was saved, what the pack already had, and what could not be saved, with **Stop saving** and **Close the map page**. Closing the window also stops saving.
- **Open in my browser**: the system's default browser.

Only addresses recorded in that pack's manifest can be opened (`https`, or `http` on `127.0.0.1`/`localhost` for tests); the shell reads them from the manifest itself and refuses anything else. The window has the import window's limits: its own label (`map-page`), no capability (every command it might send is refused), no pack protocol, a private session, navigation kept on the site of the page, new windows and downloads refused. One map page window at a time; opening another closes the first. It is separate from the import window, so "Add a map" works as before, also while a map page is open.

**What saving does, and what it never does.** With saving on, a script is added to the page before its own scripts run (`src-tauri/src/pageview/script.rs`). It wraps `fetch` and `XMLHttpRequest` and, when a `GET` request the page made itself has been answered with status 200 and its address starts like one of the pack's remote image addresses, keeps a copy of the answer's body (`Response.clone()`, or the finished binary `XMLHttpRequest` response). The page's calls, their arguments and their answers pass through unchanged. Saving never makes a request, never asks again, never adds or changes a header or the user agent, and never clicks, scrolls, pans or zooms anything. The copies wait in the page, at most 16 MB per image and about 48 MB in all; more is noted as "too many at once". The shell takes them out from the Rust side with `eval_with_callback`, a few times a second, as it takes an import's page data, so the page still cannot send anything to the app.

**What cannot be saved.** Images a page shows with `<img>` elements or style sheets cannot be read without asking the server again, which Atlas does not do; neither can answers to `no-cors` requests, or binary data a page reads as text. The script only notes their addresses (from the page's resource timing list), and the card says plainly that some images on the page could not be saved this way and that **Download map images** can fetch them. Requests made inside web workers are not visible to the page at all; the card says when the page started a worker. Only the page's top frame is watched.

**How images are matched and written** (`src-tauri/src/pageview/capture.rs`). An address is a map image only when it is exactly an address the downloader would request: one of the pack's layers' `tiles.remote.urlTemplate`, filled in with whole numbers, for a remote level the layer lists, inside the layer's tile grid (both compared in the standard form browsers use for web addresses). That gives the layer and the tile, and so the file: the layer's own `url` filled in, as the downloader writes it. Everything else is ignored. The bytes must be a JPEG, PNG or WebP image whose header can be read (at most 4096 px a side). A tile already on disk that is a readable image is never replaced, so a good file is never overwritten with a smaller or broken one; a broken file at that place is replaced, and a "missing on the server" marker is removed. Files are written through a `.part` file and a rename, only inside the pack folder and never through a symbolic link. Every few seconds and when saving stops, the levels the downloader builds by shrinking are built above the saved tiles, newly complete levels are recorded in the layer's status file, and the manifest's image summary is updated, as the downloader does. A later **Download map images** then skips what was saved. Tip shown in the dialog: start zoomed out, so the whole map is saved first.

**The map's edges.** A pack's tile grid is padded around the map, so the page's own requests for images at its corners and edges often come back "not there". The script also notes those answers (the address, the status, the type, and for a 403 the first 2 KB of the body, read from a copy), and the shell records such an image as not on the server with the downloader's own marker: on a 404 or 410, or on an object store's "access denied" document (the same narrow test as above) only when the page then gets a real image of that layer from the same host (in the same look at the page or a later one), which shows the server was still serving after that answer; such answers are held in memory until then and forgotten when saving stops, so if a server starts refusing with that document, nothing after its last image is recorded, and images already on disk prove nothing here. Anything else (another 401 or 403, a server error) records nothing and counts as could not be saved; an image already on disk is never marked, an image that arrives later replaces the marker, nothing below a missing image is marked (the downloader does that), and no request is made: the card counts these as "not on the server (the map's edge)", the activity log says once per layer why they count, and levels can complete from them.

**Downloads and other apps.** Saving holds the pack folder's lock for as long as it is on, so a download, an import, a move or a delete of that pack, from this app or another Atlas app, waits until it stops (with the usual "another Atlas window or app is working on this map's files" message), and saving does not start while a download of the pack is running or paused. It only saves into a pack folder the person keeps (the maps folder or an added location).

## Security

- IPC: the web app calls only the shell's own commands, each listed in `build.rs` and granted to the main window only. In every build, in `capabilities/main.json`: `desktop_info`, `open_external`, `save_text_file`, `open_text_file`; `library_list`, `library_open_pack`, `library_add_folder`, `library_remove_location`, `library_choose_maps_folder`, `library_apply_maps_folder`, `library_reveal`, `library_delete_pack`, `library_images_info`, `library_delete_images`, `library_import_sources`, `library_save_import`, `library_pack_details`; `packfile_options`, `packfile_export`, `packfile_pick`, `packfile_inspect`, `packfile_import`, `packfile_progress`, `packfile_cancel`; `import_open`, `import_poll`, `import_close`, `import_report`; `activity_log_read`. Only in a build with downloads, in `capabilities/downloads/main-downloads.json`: `tiles_plan`, `tiles_start`, `tiles_pause`, `tiles_resume`, `tiles_cancel`, `tiles_snapshot`; `download_settings_get`, `download_settings_set`; `view_pages`, `view_open`, `view_status`, `view_stop_saving`, `view_close`, `view_open_in_browser`. A build without downloads does not have these commands at all. No plugin permissions are granted to the page; the dialog and opener plugins are used from Rust only. Folders are chosen in native dialogs, so the page never names a folder to open, and `library_reveal` opens only the maps folder, a listed pack's folder, a remembered location or the activity log's folder. `activity_log_read` returns only the end of the log file, and `import_report` only writes the outcome of adding a map (importer id, counts, a short message), the figures of a run of several, of a list read from a game page or a list of games (counts by kind), or of an update, and the sites of its pages, to it. `import_open` takes an optional `purpose` (`game` or `catalogue`), used only for the log's wording. The web app finds the shell through `window.__TAURI_INTERNALS__` and has no Tauri dependency, so the plain web build runs without it.
- Files: `save_text_file` and `open_text_file` go through the native save and open dialogs ("Export progress", "Import progress"), so the page never names a path; opened files are limited to 64 MB of UTF-8 text. `packfile_export` and `packfile_pick` go through native dialogs too ("Export map pack file", "Import map pack file"). `packfile_inspect` and `packfile_import` take a path, but open only an existing file whose name ends in `.atlaspack`, check it as described under "Map pack files" and write only into the maps folder.
- Content Security Policy (in `tauri.conf.json`): scripts, styles and fonts only from the app; images from the app, `data:`, `blob:` (PMTiles tiles) and the pack protocol; network requests only to the app and the pack protocol. Map images are downloaded by the Rust shell, not the page, and only in a build with downloads.
- The import window (see below) gets no commands, no pack protocol and no way to reach the app.
- The map page window (only in a build with downloads) gets the same: no commands, no pack protocol, no way to reach the app. The main window's commands for it are `view_pages`, `view_open`, `view_status`, `view_stop_saving`, `view_close` and `view_open_in_browser`, listed in `build.rs` and granted in `capabilities/downloads/main-downloads.json` like the download commands; `view_open` and `view_open_in_browser` open only addresses recorded in the pack's manifest.
- Links: navigation is limited to the app's own pages. `http` and `https` links to other sites, including guide links with `target="_blank"`, open in the system browser (`open_external`); any other scheme is ignored.

The bundle identifier is `dev.atlas.desktop` (Tauri warns about identifiers ending in `.app` because of the macOS bundle extension). Change it before the first public release if you prefer another; installed apps keep their data under it.

## Not there yet

- Code signing and notarisation: Windows SmartScreen and macOS Gatekeeper warn about the unsigned builds.
- Auto-update.
- Save-file reading and sync.
- Remembering window size and position, global shortcuts and a companion window.
- Tests that look inside the window on Windows. The map, pack protocol, dialogs, links, map image downloads, the maps folder and "Add a map" (including the import window's limits) are tested in the window on Linux only; on Windows the start-up test covers the app coming up, the Rust unit tests cover the shell's code, and the page itself is checked by eye from the saved picture. macOS builds in CI: the macOS bundle targets are configured but have not been built yet.
