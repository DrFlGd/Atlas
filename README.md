# Atlas

A local-first map, checklist and guide companion for video games. One TypeScript web app that also ships as a Tauri desktop app and, later, a Docker image.

This repository holds the engine only. It contains no game assets and no data taken from other map sites. Game content is loaded from data packs that live outside this repository.

Status: early development. The web app currently shows a pannable, zoomable tiled map of a fictional demo world with 5,000 markers.

## Requirements

- Node.js 22.12 or newer
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)

## Getting started

```sh
pnpm install
pnpm dev        # http://localhost:5173
```

The first `pnpm dev` or `pnpm build` generates the demo pack, which takes about 20 seconds. Later runs reuse it until the generator changes.

## Scripts

| Command                              | What it does                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm dev`                           | Generates the demo pack if needed, then starts the Vite dev server.               |
| `pnpm build`                         | Generates the demo pack if needed, then builds the static app to `apps/web/dist`. |
| `pnpm preview`                       | Serves the built app at http://localhost:4173.                                    |
| `pnpm test`                          | Runs the unit tests (Vitest) in every package.                                    |
| `pnpm test:e2e`                      | Runs the Playwright smoke tests against the built app (run `pnpm build` first).   |
| `pnpm --filter @atlas/web test:perf` | Measures frame rate and marker redraw time while panning (needs a build).         |
| `pnpm lint`                          | ESLint and Prettier checks. `pnpm format` rewrites files with Prettier.           |
| `pnpm typecheck`                     | Strict `tsc` in every package.                                                    |
| `pnpm demo:build`                    | Rebuilds the demo pack from scratch.                                              |

Playwright downloads its own Chromium with `pnpm --filter @atlas/web exec playwright install chromium`. To use a browser that is already installed instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its path.

## The demo pack

`packs/demo` is a fictional island generated entirely by code in `packages/pipeline`: an 8192 × 8192 px relief map drawn from seeded noise, cut into a 256 px WebP tile pyramid (zoom 0–5, 1,365 tiles), with ten regions, nine categories and 5,000 locations. The same seed always produces the same pack.

The generated files are not committed; only the folder's README and `.gitignore` are. This keeps the repository small, and the build is quick enough to run on first use. `pnpm dev` and `pnpm build` call `pnpm demo:ensure`, which rebuilds only when the generator source or options changed (recorded in `packs/demo/.build-stamp.json`).

```sh
pnpm demo:build                 # PMTiles archive (default)
pnpm demo:build --tiles xyz     # plain {z}/{x}/{y}.webp folder instead
pnpm demo:build --seed 42 --locations 10000
```

## Repository layout

```
apps/web            React + Vite web app (static output)
packages/schema     Pack schema v1 in Zod, id helpers, cross-file integrity checks
packages/core       Pack loader, coordinate maths, marker clustering, MapView
packages/pipeline   Demo pack generator, tile cutter and PMTiles writer (Node)
packs/demo          Generated demo pack (not committed)
```

Workspace packages export their TypeScript sources directly; the web app bundles them and the pipeline runs them with `tsx`, so there is no separate library build step. A Tauri shell is planned as `apps/desktop`.

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
- PMTiles archives are read with HTTP range requests, so whatever serves a pack must support them (the Vite dev and preview servers and common static servers do).

## Runtime configuration

The app reads `config.json` next to `index.html` at startup, so one build can be configured per deployment without rebuilding:

```json
{ "packUrl": "packs/demo/", "theme": "dark", "clustering": true }
```

`packUrl` may be absolute or relative to `config.json`. All asset paths are relative, so the built app runs from any sub-path. For testing, `?clustering=off` draws every marker individually, and the URL fragment `#@x,y,zoom` records the current view.

## Map view

All map rendering sits behind the `MapView` interface in `packages/core/src/mapview` (set layer, set markers, fly to, select, view changes), in image-pixel coordinates. It is implemented with Leaflet 1.9 under `CRS.Simple`, the `pmtiles` Leaflet raster layer (or a plain tile layer for `{z}/{x}/{y}` folders), and a single canvas for markers with Supercluster clustering. ESLint rejects imports of `leaflet` or `pmtiles` anywhere else, so the library can be replaced later.
