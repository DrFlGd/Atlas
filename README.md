# Atlas

A local-first map, checklist and guide companion for video games. One TypeScript web app that also ships as a Tauri desktop app and, later, a Docker image.

This repository holds the engine only. It contains no game assets and no data taken from other map sites. Game content is loaded from data packs that live outside this repository.

Status: early development. The web app covers the core loop: filter the map, find a place, mark it found and watch the counters. It works offline from a static build and keeps progress in the browser.

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

Playwright downloads its own Chromium with `pnpm --filter @atlas/web exec playwright install chromium`. To use a browser that is already installed instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its path. The tests start their own preview server on port 4380; set `ATLAS_E2E_PORT` to use another port. They never reuse a server that is already running.

## Using the app

- **Layout.** Filters on the left, the map in the middle, details on the right. Both side panes close; below 900 px wide they become bottom sheets, one at a time. Dark theme by default; the sun/moon button switches to light.
- **Filters.** Categories are grouped; each row and group has a checkbox and a found/total count. Pack presets and your own saved presets switch the visible categories in one click. "Hide found" removes found markers from the map.
- **Found tracking.** Select a marker (click it, or pick a search result) and press the found switch in the details pane, or `F`. Found markers fade but stay on the map. Only categories the pack marks as trackable can be marked. `Z` (or Ctrl/Cmd+Z) undoes the last change.
- **Counters.** Found/total per category, group, region, map and pack, always derived from the stored progress. The top bar shows the pack total; the map switcher shows each map's total.
- **Search.** `/` focuses the search box. It matches location names, entities and guide titles across every map, and choosing a result switches map and layer if needed, flies there and selects it.
- **Maps and layers.** The map switcher sits in the top bar; maps with more than one layer get a layer switcher on the map. Filters and counters follow the active map.
- **Details.** Name, category, region, coordinates, the found switch and the guide entry. Hovering a marker shows its name only.
- **Profiles.** Each pack has its own profiles (for example one per playthrough): create, rename, duplicate, delete and switch them from the profile button.
- **Export and import.** The profile dialog exports the current profile or all profiles of every pack as one JSON file, and imports such a file by merging (newer change wins) or replacing.
- **Keyboard.** `/` search, `F` mark found, `Z` undo, `N` select the nearest marker not yet found, `Esc` clear the selection. Shortcuts are ignored while typing in a field or while a dialog is open.

### Where progress is kept

Progress lives in the browser's IndexedDB (database `atlas`, through Dexie), behind the `ProgressStore` interface in `packages/core/src/progress` (`@atlas/core/dexie` holds the Dexie implementation). If IndexedDB is unavailable, for example in some private windows, the app keeps progress in memory and says so. Stored records:

| Record      | Fields                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Profile     | `id`, `gameId`, `name`, `createdAt`, `updatedAt`, `deleted`                                               |
| Progress    | `profileId`, `targetId`, `state` (`found`), `updatedAt`, `deleted`, `source` (`manual`, `save`, `memory`) |
| User preset | `id`, `gameId`, `name`, `categoryIds`, `updatedAt`, `deleted`                                             |
| Setting     | `key`, `value` (device-local: theme, panes, active pack, last map and view per pack)                      |

Deletions are kept as tombstones (`deleted: true`) with their time, so merging two copies always keeps the newer change. Progress rows store the target id as it was when marked; a pack's `idMigrations` map old ids to new ones when progress is read, so a renamed location keeps its found state.

The export file is `{ "format": "atlas-progress", "version": 1, "exportedAt", "scope": "profile" | "all", "profiles", "progress", "presets" }`, with the same record shapes, and is validated with Zod on import. Replacing with an "all" export also removes local profiles and presets of the same packs that the file does not have.

### Guides

Guide entries are Markdown, rendered with markdown-it with raw HTML disabled, so any HTML in a pack shows as text. Images are not rendered, and links open in a new tab with `rel="noopener noreferrer"`.

## The demo pack

`packs/demo` is a fictional island generated entirely by code in `packages/pipeline`: an 8192 × 8192 px relief map drawn from seeded noise, cut into a 256 px WebP tile pyramid (zoom 0–5, 1,365 tiles), with ten regions, twelve categories in three groups and 5,000 locations. A second, smaller map, an underground cave system of 2048 × 2048 px with two layers and 240 locations on each, exercises the map and layer switchers. The pack also has entities, guides with Markdown and three presets. The same seed always produces the same pack.

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
packages/schema     Pack schema v1 in Zod, id helpers, cross-file integrity checks
packages/core       Pack loader, coordinate maths, marker clustering, MapView
packages/pipeline   Demo pack generator, tile cutter and PMTiles writer (Node)
packs/demo          Generated demo pack (not committed)
```

Workspace packages export their TypeScript sources directly; the web app bundles them and the pipeline runs them with `tsx`, so there is no separate library build step.

## Desktop app

`apps/desktop` wraps the same web build in a Tauri 2 window for Windows, macOS and Linux. It needs Rust and, per platform, a C++ toolchain or WebKitGTK; [apps/desktop/README.md](apps/desktop/README.md) lists the prerequisites. `pnpm desktop:dev` opens the window on the dev server; `pnpm desktop:build` writes installers to `apps/desktop/src-tauri/target/release/bundle/`. CI builds unsigned Linux and Windows bundles on every run and keeps them as workflow artifacts.

In the desktop app, packs are served by a small protocol in the Rust shell that answers range requests, because the protocol Tauri uses for the bundled frontend does not. The desktop app also exports and imports progress through native file dialogs, opens web links in the system browser, and can download a pack's map images from the tile server its layers name (`tiles.remote`), politely and resumably, for offline use. Not there yet: code signing, auto-update and save-file sync.

## Data packs

A pack is a read-only, versioned folder loaded by URL:

```
manifest.json         gameId, title, packVersion, gamePatch, schemaVersion, attribution, idMigrations
maps.json             maps: pixel size and optional world-coordinate transform
layers.json           tile layers of each map
regions.json          region polygons, optionally nested
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
```

- Coordinates are pixels of the full-resolution map image, origin top-left. A layer's `maxZoom` is the pyramid level at which one tile pixel equals one image pixel.
- Content ids are stable, prefixed strings: `<gameId>:<kind>:<localId>`, for example `demo:loc:0412`.
- The schema lives in `packages/schema` and is shared by the app and the pipeline. `loadPack` in `packages/core` validates every file and checks references between files before the app uses a pack.
- An `xyz` layer may name a remote source (`tiles.remote`: an `https` URL template and the remote zoom and tile offset of each pyramid level). The desktop app can download such tiles into its own data folder; see [apps/desktop/README.md](apps/desktop/README.md#downloading-map-images). The web app shows its usual "not installed" notice for them.
- PMTiles archives are read with HTTP range requests, so whatever serves a pack must support them (the Vite dev and preview servers and common static servers do).

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
