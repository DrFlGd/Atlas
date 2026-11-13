# Atlas

A local-first map, checklist and guide companion for video games. One TypeScript web app that also ships as a Tauri desktop app and, later, a Docker image.

This repository holds the engine only. It contains no game assets and no data taken from other map sites. Game content is loaded from data packs that live outside this repository.

Status: early development. The web app covers the core loop: filter the map, find a location, mark it found and watch the counters, and work through a pack's checklists and guides. It works offline from a static build and keeps progress in the browser.

## Requirements

- Node.js 22.12 or newer
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)

## Getting started

```sh
pnpm install
pnpm dev        # http://localhost:5173
```

The first `pnpm dev` or `pnpm build` generates the demo pack, which takes about 25 seconds. Later runs reuse it until the generator changes.

## Scripts

| Command                              | What it does                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm dev`                           | Generates the demo pack if needed, then starts the Vite dev server.               |
| `pnpm build`                         | Generates the demo pack if needed, then builds the static app to `apps/web/dist`. |
| `pnpm preview`                       | Serves the built app at http://localhost:4173.                                    |
| `pnpm test`                          | Runs the unit tests (Vitest) in every package.                                    |
| `pnpm test:e2e`                      | Runs the Playwright tests against the built app (run `pnpm build` first).         |
| `pnpm --filter @atlas/web test:perf` | Measures frame rate and marker redraw time while panning (needs a build).         |
| `pnpm lint`                          | ESLint and Prettier checks. `pnpm format` rewrites files with Prettier.           |
| `pnpm typecheck`                     | Strict `tsc` in every package.                                                    |
| `pnpm demo:build`                    | Rebuilds the demo pack from scratch.                                              |
| `pnpm desktop:dev`                   | Runs the desktop app on a Vite dev server at port 1420 (see below).               |
| `pnpm desktop:build`                 | Builds the desktop app and its installers (see below).                            |
| `pnpm android:build`                 | Builds the Android app as an unsigned APK (see below).                            |

Playwright downloads its own Chromium with `pnpm --filter @atlas/web exec playwright install chromium`. To use a browser that is already installed instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its path. The tests start their own preview server on port 4380; set `ATLAS_E2E_PORT` to use another port. They never reuse a server that is already running.

## Using the app

- **Layout.** Two layouts, chosen under Games › Settings › Layout (stored on the device with the theme), or with the layout button in the classic top bar:
  - **Standard** (the default): a rail of sections (Map, Lists, Progress, Games) beside one panel and the map. With a mouse and keyboard, pointing at a location shows its name, the scroll wheel and the + and − buttons zoom, right-clicking a location marks it found or not found at once (with Undo), and the keys below work with their letters shown on the buttons. On a touch screen it is made for fingers instead, as in Atlas for Android, which always shows it. In a window narrower than 840 px the map fills the window, with the sections in a bar at the bottom and panels that rise over the map.
  - **Classic**: filters on the left, the map in the middle, details on the right, under a bar. Both side panes close; below 900 px wide they become bottom sheets, one at a time.

  The address can ask for a layout for the rest of the browser session (until the setting is changed): `?ui=standard`, `?ui=classic` (`?ui=desktop` is its older name) or `?ui=touch` (the standard layout made for fingers). Dark theme by default; the sun/moon button (classic) or Games › Settings › Theme switches to light.

- **Filters.** Types are grouped; each row and group has a checkbox and a found/total count. Pack presets and your own saved presets switch the visible types in one click. "Hide found" removes found markers from the map.
- **Found tracking.** Select a marker (click it, or pick a search result) and press the found switch in the details pane, or `F`. Found markers fade but stay on the map. Only types the pack marks as trackable can be marked. `Z` (or Ctrl/Cmd+Z) undoes the last change.
- **Counters.** Found/total per type, group, region, map and pack, always derived from the stored progress. The top bar shows the pack total; the map switcher shows each map's total.
- **Regions.** Under Filters, Progress lists the regions of the active map with their counts. Clicking a region (or pressing Enter on it) moves the map there: to the region's centre when the pack gives one, otherwise to the middle of its outline, zoomed to show the whole outline. A region with neither stays a plain row. On narrow windows the filter sheet closes so the map can be seen.
- **Search.** `/` focuses the search box. It matches location names, entities, guide titles, checklist names and checklist items across every map. Choosing a location switches map and layer if needed, flies there and selects it; choosing a checklist, a checklist item or a guide opens it on the checklists screen, with the item scrolled into view.
- **Checklists and guides.** The list button next to Filters in the top bar (or `C`) shows the pack's checklists and guides as a second tab of the left pane, so the map and the details pane stay usable beside it; below 900 px it is a bottom sheet like the filters. It lists the checklists, then the guides (lists of locations marked as guides, and guide texts that belong to no single location), each list with its found/total and a total over all lists. A list shows its items in order, under their section headings, each with a tick, its name, the type and region of its location (and the map, when the list spans several), the location's own note, and "Show on map", which switches map if needed and selects the location. Long lists render only the rows in view, so lists of thousands of items open at once. A list can be filtered by region and by type (each with found/total, Select all and Deselect all), searched, and set to hide found items. A guide text opens as Markdown with its locations as "show on map" buttons. The details pane names the checklists and guides a location is on. A pack with no checklists and no guide texts of its own has no button, tab or shortcut for them, as a pack with one map has no map switcher.
- **Ticking items.** An item with locations is found exactly when all its locations that can be marked are found, so ticking it on the list or marking its locations on the map show in both at once. Ticking it marks its locations that are not found yet; unticking it marks all of its locations not found, also those marked on the map before. Either is one change that `Z` takes back, and a notice says how many locations changed. An item without a location (a step, or a location in a type that is not tracked) has a tick of its own, kept per profile like found marks. Item ticks never change the top bar's found counter, which still counts locations found.
- **Maps and layers.** The map switcher sits in the top bar; maps with more than one layer get a layer switcher on the map. Filters and counters follow the active map.
- **Details.** Name, type, region, coordinates, the found switch and the guide entry. Hovering a marker shows its name only.
- **Profiles.** Each pack has its own profiles (for example one per playthrough): create, rename, duplicate, delete and switch them from the profile button.
- **Game save.** For a pack of a game whose saves Atlas reads (The Witcher 3 for now, saves of patches 4.0x and 5.0x), the save button in the top bar links a save to the profile: in the desktop app the game's saves folder (found under Documents, also when Documents is moved, for example by OneDrive), another folder or one save file; in a browser, a file opened with "Open a save file…". Atlas reads a copy of the save, never changes it, and shows its version, the world you saved in, what its own map lists (locations discovered, cleared and known of), how many locations it shows done per type, what did not match and why. A Witcher 3 save names the locations on its map by the game's own tags, without positions, so a location is marked when the pack names that tag (a location's `flagId`), when a fact the pack names is set, or, once the game's map locations are read (below), when a pin the save shows done lies on a location of its type; when a save marks nothing, the dialog says why (nothing discovered yet, or no table yet of where each tag is) rather than reporting a failure. It marks those locations found, but never where you set or cleared a mark by hand; each read is one change that `Z` takes back, and "Remove marks made from saves" takes them all back. Where you stood is an arrow on the map (a dot when the save has no facing), with "Show me"; when no map of the pack shows the save's world, the dialog says so, and you can choose which map shows which world. A map is lined up with the game world by the pack's `worldTransform`, else by placing yourself on the map from two saves made at least 50 m apart. In the desktop app, "Map locations from the game" reads where the game's own map pins are from your copy of the game (read-only, from the game folder you choose): the save's tags then become locations with a position, and a map is lined up automatically from every signpost of its world when the fit passes a clear bar; that table stays on the device, is never exported or put in a pack, and is read again after a game patch ([apps/desktop/README.md](apps/desktop/README.md#the-games-own-map-locations)). In the desktop app, "Follow new saves" reads each new save a few seconds after the game has finished writing it. A save of a game version Atlas does not know is refused with a message, and marking by hand works as before. The parser and matcher are in `packages/saves`; what a save holds beyond the player's position, the facts and the map pins (quests, Gwent cards, gear) is not used yet.
- **Export and import.** The profile dialog exports the current profile or all profiles of every pack as one JSON file, and imports such a file by merging (newer change wins) or replacing.
- **Map pack files.** In the desktop app, **Export…** on a game in the Maps dialog saves the game with its map images, at a chosen level of detail, as one `.atlaspack` file, and **Import map pack file…** adds such a file on another computer; Atlas for Android reads the same format. A map pack file never holds personal data such as found marks; the Export dialog can save the progress export beside it. See [apps/desktop/README.md](apps/desktop/README.md#map-pack-files).
- **Keyboard.** `/` search, `F` mark found, `Z` undo, `N` select the nearest marker not yet found, `C` show or hide the checklists and guides, `Esc` clear the selection (in the standard layout: close what is on top, such as a menu, the search, the location or a list), `?` the list of keys and what the mouse does (standard layout; also the keyboard button in the rail). Shortcuts are ignored while typing in a field or while a dialog is open.

### Where progress is kept

Progress lives in the browser's IndexedDB (database `atlas`, through Dexie), behind the `ProgressStore` interface in `packages/core/src/progress` (`@atlas/core/dexie` holds the Dexie implementation). If IndexedDB is unavailable, for example in some private windows, the app keeps progress in memory and says so. Stored records:

| Record   | Fields                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------- |
| Profile  | `id`, `gameId`, `name`, `createdAt`, `updatedAt`, `deleted`                                               |
| Progress | `profileId`, `targetId`, `state` (`found`), `updatedAt`, `deleted`, `source` (`manual`, `save`, `memory`) |

`targetId` is a location id, or the id of a checklist item that has a tick of its own (an item without a place that can be marked found); for such an item `found` means done. An item with places has no record of its own: its state is read from its places. Item ticks are ordinary progress records, so they needed no new table, no IndexedDB upgrade (the database is still at version 1) and no new export version: profiles, duplication, deletion, undo, export and import carry them, the found counters ignore them because they count locations only, exports from Atlas 0.3.3 import unchanged, and Atlas 0.3.3 imports an export with item ticks and keeps them without showing them.
| User preset | `id`, `gameId`, `name`, `categoryIds`, `updatedAt`, `deleted` |
| Setting | `key`, `value` (device-local: theme, panes, active pack, last map and view per pack, the game save linked to each profile, which map shows which game world, how maps are lined up with game worlds, and the table of the game's own map pins read in the desktop app) |

Marks made from a game save are progress records with `source: 'save'`. Reading a save only adds such records, never for a target whose newest record (a mark or a tombstone) has `source: 'manual'`, so marks set or cleared by hand always win; "Remove marks made from saves" writes tombstones for the targets whose newest record came from a save. The save itself, its link to a profile, the map chosen for each world, the lining up of maps and the table of the game's map pins are never part of an export.

Deletions are kept as tombstones (`deleted: true`) with their time, so merging two copies always keeps the newer change. Progress rows store the target id as it was when marked; a pack's `idMigrations` map old ids to new ones when progress is read, so a renamed location keeps its found state.

In the desktop app, progress is kept the same way, in that app's own web storage. Two desktop apps built from this repository with different identifiers (see [apps/desktop/README.md](apps/desktop/README.md#two-apps-one-maps-folder)) share their maps folder but not their progress; use export and import to carry progress from one to the other.

The export file is `{ "format": "atlas-progress", "version": 1, "exportedAt", "scope": "profile" | "all", "profiles", "progress", "presets" }`, with the same record shapes, and is validated with Zod on import. Replacing with an "all" export also removes local profiles and presets of the same packs that the file does not have.

### Guides

Guide entries are Markdown, rendered with markdown-it with raw HTML disabled, so any HTML in a pack shows as text. Images are not rendered, and web links open in a new tab with `rel="noopener noreferrer"` (in the desktop app, in the system browser).

A link whose target is a content id of the same pack is an in-app link: `[the old well](demo:loc:0412)`, or `<demo:loc:0412>`. It is drawn as a button and acts in the app instead of opening a browser:

| Target                               | What the link does                                                    |
| ------------------------------------ | --------------------------------------------------------------------- |
| a location (`<gameId>:loc:…`)        | shows it on the map and selects it, switching map and layer if needed |
| a region (`<gameId>:region:…`)       | moves the map to the region, as a region row in Progress does         |
| a map (`<gameId>:map:…`)             | shows that map                                                        |
| a checklist (`<gameId>:checklist:…`) | opens it on the checklists screen                                     |
| an item (`<gameId>:checkitem:…`)     | opens its checklist with the item in view                             |
| a guide (`<gameId>:guide:…`)         | opens it on the checklists screen                                     |

Ids from an earlier pack version are followed through `idMigrations`. A link to an id the pack does not have, to another pack, or to another kind of content is shown as plain text. In-app links work in every Markdown text: location notes in the details pane and in checklist rows, guide pages and item notes.

Text between double bars, `||like this||`, is hidden until the reader presses "Show hidden text" where it begins (a solution, a spoiler). A hidden part may sit inside a sentence or run over several paragraphs, lists and code, and may hold in-app links. Bars pair up left to right; a last bar without a partner, bars in code and escaped bars (`\|`) are plain text. Where a note is shown as one line (list rows, Next up), each hidden part reads "(Hidden)".

## The demo pack

`packs/demo` is a fictional island generated entirely by code in `packages/pipeline`: an 8192 × 8192 px relief map drawn from seeded noise, cut into a 256 px WebP tile pyramid (zoom 0–5, 1,365 tiles), with ten regions, twelve categories in three groups and 5,000 locations. A second, smaller map, an underground cave system of 2048 × 2048 px with two layers and 240 locations on each, exercises the map and layer switchers. The pack also has entities, guides with Markdown, three presets, a note of its own for each lore tablet and chest on the surface, five lists (a checklist of every waystone, a story of steps without places, a long mixed list of 326 items with sections, a route of 2,015 places across both maps, and secrets: eight riddles of one name whose notes hide their answers) and three walkthrough guides that use in-app links. The same seed always produces the same pack.

The generated files are not committed; only the folder's README and `.gitignore` are. This keeps the repository small, and the build is quick enough to run on first use. `pnpm dev` and `pnpm build` call `pnpm demo:ensure`, which rebuilds only when the generator source or options changed (recorded in `packs/demo/.build-stamp.json`).

```sh
pnpm demo:build                 # PMTiles archive (default)
pnpm demo:build --tiles xyz     # plain {z}/{x}/{y}.webp folder instead
pnpm demo:build --seed 42 --locations 10000
```

## Repository layout

```
apps/web            React + Vite web app (static output)
apps/desktop        Tauri 2 desktop shell around the web build
apps/mapmaker       Atlas Map Maker: a separate Tauri 2 app that checks a player's own game files (installer GPL-3.0)
packages/schema     Pack schema (manifest versions 1 and 2) in Zod, id helpers, integrity checks
packages/core       Pack loader, coordinate maths, marker clustering, MapView
packages/importer-api  The contract for importers that turn a web page into a pack, and a demo importer
packages/saves      Game save readers (The Witcher 3), the game's map pin files (CR2W), and matching a save against a pack; pure TypeScript
packages/pipeline   Demo pack generator, tile cutter and PMTiles writer (Node)
packs/demo          Generated demo pack (not committed)
tools/gamefiles     The Map Maker's game file reader, in Python with Soulstruct (GPL-3.0)
```

Workspace packages export their TypeScript sources directly; the web app bundles them and the pipeline runs them with `tsx`, so there is no separate library build step.

## Desktop app

`apps/desktop` wraps the same web build in a Tauri 2 window for Windows, macOS and Linux. It needs Rust and, per platform, a C++ toolchain or WebKitGTK; [apps/desktop/README.md](apps/desktop/README.md) lists the prerequisites. `pnpm desktop:dev` opens the window on the dev server; `pnpm desktop:build` writes installers to `apps/desktop/src-tauri/target/release/bundle/`. CI builds an unsigned Windows installer on every run and keeps it as a workflow artifact; the Linux build and its tests are switched off for now (see `.github/workflows/ci.yml`).

In the desktop app, packs are served by a small protocol in the Rust shell that answers range requests, because the protocol Tauri uses for the bundled frontend does not. The desktop app also shows packs from a maps folder and from folders the person chooses, exports and imports progress through native file dialogs, exports a game with its map images to one map pack file (`.atlaspack`) and imports such files ([apps/desktop/README.md](apps/desktop/README.md#map-pack-files)), opens web links in the system browser, and shows the map images that are in a pack's folder. The public Atlas app is a viewer: it never fetches map images from other servers. Only a build made with `ATLAS_ENABLE_DOWNLOADS=1` can download a pack's map images from the tile server its layers name (`tiles.remote`), politely and resumably, into the pack's folder, one pack at a time across every Atlas app on the computer ([apps/desktop/README.md](apps/desktop/README.md#building-another-app-from-the-shell)). Every Atlas desktop app writes what it does to a shared activity log, which the app shows and can copy to send with a question ([apps/desktop/README.md](apps/desktop/README.md#activity-log)). A desktop build can include importers that add maps from web pages ("Add a map"); the plain build has none. The desktop app finds the game's saves folder, lists and reads saves (read-only) and follows new ones, and reads the map files of the game folder the person chooses (read-only); the reading itself is the web app's ([apps/desktop/README.md](apps/desktop/README.md#game-saves)). Not there yet: code signing and auto-update.

The `Release` workflow (`.github/workflows/release.yml`, run by hand or by pushing a `v*` tag) builds the plain viewer's Windows installer and publishes it as a GitHub Release.

The same shell builds an Android app (Android 10 and later), a viewer with the demo pack: `pnpm android:build --target aarch64` writes an unsigned APK, CI builds and checks one on every run, and the `Android release` workflow (run by hand) attaches a signed one to a draft release `android-v<version>`. See [apps/desktop/README.md](apps/desktop/README.md#android).

## Map Maker

`apps/mapmaker` is Atlas Map Maker, a separate Windows app for making Atlas maps from a player's own game files: Dark Souls Remastered first, then Bloodborne. Its first version only checks the game folder and reports what map data can be read (areas, treasure, item lots, collision, navmesh and map pieces), with a top-down preview of each area and a report to save. It runs `tools/gamefiles`, a Python program built with PyInstaller, as a sidecar. They only read the chosen game folder: they never write into it, copy game files from it or make network requests, and no game files or data from them are in this repository. See [apps/mapmaker/README.md](apps/mapmaker/README.md) and [tools/gamefiles/README.md](tools/gamefiles/README.md). The `Release Map Maker` workflow publishes its installer under `mapmaker-v*` tags, separately from the viewer's releases.

## Data packs

A pack is a read-only, versioned folder loaded by URL:

```
manifest.json         who the pack is and what is in it (see "The manifest" below)
maps.json             maps: pixel size and optional world-coordinate transform
layers.json           tile layers of each map
regions.json          regions: name, optional outline and centre, optionally nested
categoryGroups.json
categories.json
locations.json
entities.json         optional collections, loaded as empty when absent:
checklists.json       entities, checklists, checklist items, guides, links, presets
checklistItems.json
guides.json
links.json
presets.json
tiles/                tile pyramids, one PMTiles file or {z}/{x}/{y} folder per layer
offline-tiles/        status files of downloaded map images (desktop app, see apps/desktop)
import/               page data kept by "Add a map", never served to the map (desktop app)
.atlas/               the desktop app's lock, unfinished-download record and map pack file record
```

A pack folder is self-contained: every path in it is relative, nothing names a computer, user or app, paths use `/`, and no two names differ only in case, so a pack folder with its downloaded images can be copied to another computer (or operating system) and opened there.

- Coordinates are pixels of the full-resolution map image, origin top-left. A layer's `maxZoom` is the pyramid level at which one tile pixel equals one image pixel.
- Content ids are stable, prefixed strings: `<gameId>:<kind>:<localId>`, for example `demo:loc:0412`.
- The schema lives in `packages/schema` and is shared by the app and the pipeline. `loadPack` in `packages/core` validates every file and checks references between files before the app uses a pack.
- Packs are written strictly and read tolerantly. The tools that make or check packs (the demo pack builder, `validate-pack`, an importer's result before the app saves it) refuse an unknown field anywhere, so a typo is caught where the pack is made. The app, when it reads a pack, skips fields it does not know and treats a value it does not know in an optional choice (such as a checklist `type` added later) as if the field were absent, so a pack made by a newer tool still opens. Atlas 0.4.4 and earlier refuse unknown fields anywhere.
- A region (`regions.json`) has an id, its map, an optional parent region and a name, and two optional geometry fields: `polygon`, its outline (at least three points, implicitly closed), and `center`, the `[x, y]` point the map goes to when the region is picked. A region may have both, either or neither; one with neither still counts the progress of the locations that name it, but the app cannot show where it is. Outline points and the centre must lie inside the map. Both fields are optional, so adding them did not change the manifest's `schemaVersion`; Atlas 0.3.3 and earlier refuse a pack with a region that has a `center` or no `polygon`.
- An `xyz` layer may name a remote source (`tiles.remote`: an `https` URL template and the remote zoom and tile offset of each pyramid level). A desktop app built with downloads can download such tiles into the pack's folder, and every desktop app shows the ones that are there; see [apps/desktop/README.md](apps/desktop/README.md#downloading-map-images). The web app shows its usual "not installed" notice for them.
- A checklist (`checklists.json`) has an id, a name, an optional description, an `order`, an optional `kind`: `"checklist"` (the default) for things to do or collect, or `"guide"` for a guide that is a list of places, and an optional `type`, which says how the app shows it:

  | `type`       | What it is                                                                                   | Views                              |
  | ------------ | -------------------------------------------------------------------------------------------- | ---------------------------------- |
  | `collection` | Find everything of a set.                                                                    | By area, By type                   |
  | `secrets`    | A collection whose notes are solutions, with hidden text and locations named in the text.    | By area, By type                   |
  | `photos`     | A collection with a photo per entry (photos are not shown yet; it is shown as a collection). | By area, By type                   |
  | `route`      | Steps followed in order, with locations, and a next step.                                    | In order (first), By area, By type |
  | `build`      | Ordered steps of items, locations and bosses, each with a reason, and a next step.           | In order                           |
  | `plain`      | Things to do, shown as written: no choice of view, no next step.                             | In order                           |

  Without a `type`, a list of kind `"guide"` is a route, a list with no places is plain, and any other is a collection. A list with no places is shown in order whatever its type (a route or a build still with a next step). Apps that do not know `type` go by `kind`, which lists guides under a heading of their own, so packs keep writing it. Its items (`checklistItems.json`) have an id, the checklist, a name, an `order`, the locations they stand for (`locationIds`, often one, may be on several maps, may be none) and related entities, and two optional fields: `section`, the heading the item is listed under (items in order that share a section are shown together), and `note`, a short Markdown note shown under the item. An item with no location that can be marked found has a tick of its own (see "Ticking items" above).

- A guide (`guides.json`) has an id, a title, a Markdown `body`, the locations it is about and an optional `order`, its place among the listed guides (guides without one follow, by title). A guide tied to exactly one location, by its own `locationIds` or by that location's `guideId`, is that location's note and shows in the details pane and in checklist rows. Any other guide (a walkthrough, a chapter, or a guide shared by many places) is listed on the checklists screen.
- `kind`, `section`, `note` and `order` (on guides) are optional, so adding them did not change the manifest's `schemaVersion`; Atlas 0.3.3 and earlier refuse a pack that uses any of them, as they do for unknown fields anywhere. `type` is optional too; Atlas 0.4.4 and earlier refuse a pack whose checklists have it.
- Pack ids (`gameId`) are lowercase letters, digits, `-` and `_`. In the desktop app only one pack with an id is shown at a time; see [apps/desktop/README.md](apps/desktop/README.md#maps-folder-and-other-locations).
- PMTiles archives are read with HTTP range requests, so whatever serves a pack must support them (the Vite dev and preview servers and common static servers do).

### The manifest

`manifest.json` has two versions. Version 1 holds only the pack's identity; version 2 adds a description of the pack, written by the tools and apps that write packs. The app reads both; a version 1 pack never needs to be rewritten.

```json
{
  "schemaVersion": 2,
  "gameId": "test-valley",
  "title": "Test Valley",
  "packVersion": "1.1.0",
  "gamePatch": "demo",
  "attribution": [{ "name": "Demo map site (made-up test data)" }],
  "idMigrations": {},
  "created": "2026-11-10T21:30:00.000Z",
  "updated": "2026-11-10T21:32:10.000Z",
  "writtenBy": { "name": "Atlas", "version": "0.3.0" },
  "source": {
    "importer": { "id": "demo-maps", "title": "Demo map site" },
    "pages": [
      {
        "url": "http://127.0.0.1:4432/demo-maps/test-valley/east-field",
        "mapId": "test-valley:map:east-field",
        "importedAt": "2026-11-10T21:30:00.000Z"
      },
      {
        "url": "http://127.0.0.1:4432/demo-maps/test-valley/west-ridge",
        "mapId": "test-valley:map:west-ridge",
        "importedAt": "2026-11-10T21:32:10.000Z"
      }
    ]
  },
  "contents": {
    "counts": {
      "maps": 2,
      "layers": 2,
      "locations": 6,
      "categories": 4,
      "regions": 0,
      "guides": 0
    },
    "maps": [
      {
        "id": "test-valley:map:east-field",
        "name": "East Field",
        "width": 1024,
        "height": 768,
        "locations": 4,
        "layers": [
          {
            "id": "test-valley:layer:east-field",
            "name": "Map",
            "minZoom": 0,
            "maxZoom": 2,
            "tiles": "xyz",
            "downloadable": true,
            "images": {
              "levels": [0, 1, 2],
              "complete": true,
              "files": 16,
              "bytes": 5120,
              "updatedAt": "2026-11-10T21:35:00Z"
            }
          }
        ]
      }
    ]
  }
}
```

| Field                             | Version     | Meaning                                                                                                                                                                                                                                                                 |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                   | 1, 2        | The manifest format: `1` or `2`. Anything else is refused with a plain message.                                                                                                                                                                                         |
| `gameId`                          | 1, 2        | The pack id, also the prefix of every content id.                                                                                                                                                                                                                       |
| `title`                           | 1, 2        | The game's name as shown in the game switcher.                                                                                                                                                                                                                          |
| `packVersion`                     | 1, 2        | The pack's own version, `major.minor.patch`; a location's `since` names one.                                                                                                                                                                                            |
| `gamePatch`                       | 1, 2        | The game version the content matches.                                                                                                                                                                                                                                   |
| `attribution`                     | 1, 2        | Who made the content, with optional URL and licence.                                                                                                                                                                                                                    |
| `idMigrations`                    | 1, 2        | Old content id to new id, so stored progress follows renamed locations.                                                                                                                                                                                                 |
| `created`                         | 2           | When the pack was first written (ISO 8601). Kept when the pack is written again.                                                                                                                                                                                        |
| `updated`                         | 2           | When the pack's content last changed.                                                                                                                                                                                                                                   |
| `writtenBy`                       | 2           | The tool or app, and its version, that wrote the pack's files.                                                                                                                                                                                                          |
| `source`                          | 2, optional | For packs made by an importer: the importer's id and title, and each page the pack was made from, with the map it became and when. Absent for packs built by hand or by a pipeline.                                                                                     |
| `contents.counts`                 | 2           | Maps, layers, locations, categories, regions and guides in the pack.                                                                                                                                                                                                    |
| `contents.maps[]`                 | 2           | Each map's id, name, size in pixels and number of locations, and its layers: id, name, zoom range, tile kind (`pmtiles` or `xyz`) and whether its images can be downloaded.                                                                                             |
| `contents.maps[].layers[].images` | 2, optional | For downloadable layers, what the desktop app has downloaded into the pack folder: the complete `levels`, whether every level is there (`complete`), the number of image `files` and their `bytes`, and when this was recorded. Updated after each level of a download. |

The descriptive fields (`created` and after) describe the pack; they are not used to load it. The counts are worked out from the pack's files whenever a tool or app writes them, and the image summary when the desktop app downloads images. Anything that edits the pack files by hand can leave them stale: the app then still loads the pack from its files, and a broken or missing descriptive field is ignored rather than refused. `describePack` in `packages/schema` writes a version 2 manifest from a pack's data.

## Runtime configuration

The app reads `config.json` next to `index.html` at startup, so one build can be configured per deployment without rebuilding:

```json
{ "theme": "dark", "clustering": true }
```

- `theme`: `dark` or `light`, used until the user picks one.
- `clustering`: group nearby markers at low zoom.
- `packs`: an explicit list of packs, `[{ "id": "<gameId>", "url": "packs/demo/", "title": "…" }]`. When given, the pack index is not read. The desktop build uses this to point at its pack protocol.
- `packIndex`: where to find the pack index when `packs` is not given; default `packs/index.json`.
- `packUrl`: older shorthand for a single pack; the app reads the pack's manifest for its id and title.
- `importers`: importer modules of a desktop build, `[{ "id", "title", "description", "version", "module" }]`, written by the desktop build from `ATLAS_BUNDLE_IMPORTERS`. Absent in the web build.

URLs in `config.json` and in the index are absolute or relative to the app root (the folder with `index.html`).

### Pack discovery

Without a `packs` list, the app reads `packs/index.json`:

```json
{ "packs": [{ "id": "demo", "url": "packs/demo/", "title": "Atlas demo world" }] }
```

The dev server builds this index from every folder in `packs/` that has a `manifest.json`. `pnpm build` copies the packs named in `ATLAS_BUNDLE_PACKS` (comma-separated folder names, default `demo`) into `dist/packs/` and writes the index for them, in that order. With more than one pack, a game switcher appears in the top bar. The first pack in the index is shown on first launch; after that the app opens the game picked last.

Before showing a tile layer, the app requests the first bytes of its PMTiles archive (or the top tile of a folder pyramid). If that fails, the map shows a plain background and a short notice instead of tiles, and the markers still work.

All asset paths are relative, so the built app runs from any sub-path. For testing, `?clustering=off` draws every marker individually, and the URL fragment `#@x,y,zoom` records the current view.

## Map view

All map rendering sits behind the `MapView` interface in `packages/core/src/mapview` (set layer, set markers, fly to, select, view changes), in image-pixel coordinates. It is implemented with Leaflet 1.9 under `CRS.Simple`, the `pmtiles` Leaflet raster layer (or a plain tile layer for `{z}/{x}/{y}` folders), and a single canvas for markers with Supercluster clustering. ESLint rejects imports of `leaflet` or `pmtiles` anywhere else, so the library can be replaced later.

## Licence

Atlas is released under the [MIT licence](LICENSE). The licence covers this repository: the app, its packages and the made-up demo pack. Data packs made by other people or tools are not part of this repository and keep their own terms.

Two exceptions are under the [GNU General Public License version 3](tools/gamefiles/LICENSE) (or later): `tools/gamefiles`, because it uses the GPL-3.0 libraries Soulstruct and soulstruct-havok, and the Atlas Map Maker installer, which carries the program built from it. The Map Maker app's own code in `apps/mapmaker` is MIT. Nothing from `tools/gamefiles` goes into the Atlas viewer, the desktop app or the importers.
