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
  - **Standard** (the default): a rail of sections (Map, Lists, Progress, Games) beside one panel and the map. With a mouse and keyboard, pointing at a location shows its name, the scroll wheel and the + and − buttons zoom, right-clicking a location marks it found or not found at once (with Undo), and the keys below work with their letters shown on the buttons. Made for fingers instead, it has larger targets, no names on hover, and pressing and holding a location marks it; Atlas for Android always shows it so. Games › Settings › **Controls** (under Layout, stored with the theme) chooses: **Automatic** (the default), **For fingers** or **For a mouse**. Automatic starts made for fingers on a touch screen without a mouse (a phone or a tablet) and on a Steam Deck (Linux, a touch screen of 1280 by 800), and changes to fingers as soon as a finger presses the screen; it changes back only after the mouse alone is pressed at least five times over at least two minutes without a touch, and never on a phone, a tablet or a Steam Deck. It never changes while a finger is down, a dialog is open or a text field has the focus. The setting says what Automatic shows now and why. On a computer held in both hands (made for fingers, at most 900 px tall), the sections sit at the foot of the rail, Nearest unfound and the card's Mark found in the lower right corner, dialogs at the top, clear of the on-screen keyboard, and every target is at least 44 px (`apps/web/src/styles/handheld.css`). In a window narrower than 840 px the map fills the window, with the sections in a bar at the bottom and panels that rise over the map.
  - **Classic**: filters on the left, the map in the middle, details on the right, under a bar. Both side panes close; below 900 px wide they become bottom sheets, one at a time.

  The address can ask for a layout for the rest of the browser session (until the setting is changed): `?ui=standard`, `?ui=classic` (`?ui=desktop` is its older name) or `?ui=touch` (the standard layout made for fingers, as on a phone or a tablet, whatever Controls says). Dark theme by default; the sun/moon button (classic) or Games › Settings › Theme switches to light.

- **Filters.** Types are grouped; each row and group has a checkbox and a found/total count. Pack presets and your own saved presets switch the visible types in one click. "Hide found" removes found markers from the map.
- **Found tracking.** Select a marker (click it, or pick a search result) and press the found switch in the details pane, or `F`. Found markers fade but stay on the map. Only types the pack marks as trackable can be marked. `Z` (or Ctrl/Cmd+Z) undoes the last change.
- **Counters.** Found/total per type, group, region, map and pack, always derived from the stored progress. The top bar shows the pack total; the map switcher shows each map's total.
- **Regions.** Under Filters, Progress lists the regions of the active map with their counts. Clicking a region (or pressing Enter on it) moves the map there: to the region's centre when the pack gives one, otherwise to the middle of its outline, zoomed to show the whole outline. A region with neither stays a plain row. On narrow windows the filter sheet closes so the map can be seen.
- **Search.** `/` focuses the search box. It matches location names, entities, guide titles, checklist names and checklist items across every map. Choosing a location switches map and layer if needed, flies there and selects it; choosing a checklist, a checklist item or a guide opens it on the checklists screen, with the item scrolled into view.
- **Checklists and guides.** The list button next to Filters in the top bar (or `C`) shows the pack's checklists and guides as a second tab of the left pane, so the map and the details pane stay usable beside it; below 900 px it is a bottom sheet like the filters. It lists the checklists, then the guides (lists of locations marked as guides, and guide texts that belong to no single location), each list with its found/total and a total over all lists. A list shows its items in order, under their section headings, each with a tick, its name, the type and region of its location (and the map, when the list spans several), the location's own note, and "Show on map", which switches map if needed and selects the location. Long lists render only the rows in view, so lists of thousands of items open at once. A list can be filtered by region and by type (each with found/total, Select all and Deselect all), searched, and set to hide found items. A guide text opens as Markdown with its locations as "show on map" buttons. The details pane names the checklists and guides a location is on. A pack with no checklists and no guide texts of its own has no button, tab or shortcut for them, as a pack with one map has no map switcher.
- **Guides.** When a pack has a contents (`sections.json`), the standard layout has a **Guides** section that reads its guides as pages, as a wiki is read: the contents, with sections inside sections and pages in the source's order; each page with its tables, pictures, hidden text and the credit of the site it was read from; links between pages that stay in the app, links to the web that open in the browser (in the desktop app, the system browser); Back and Forward, each returning to where the page or list was scrolled to; a page with three headings or more lists them at its top, **On this page** (sub-headings in under their heading, each a link to its section; open beside the contents on a wide window, folded on a phone, and kept as the person leaves it while the app is open); a link to a section of a page opens the page at that heading (one of the page shown moves to it, and Back returns to where the reader was); and a search over the pages' titles and text (hidden text is not searched). With the contents beside the page on a wide window, and the contents and the page one at a time on a phone; wide tables scroll sideways on their own. A table with a heading row and two rows or more sorts by a column: its headings are buttons, the first press sorts smallest first, the second largest first, the third puts the page's order back. A column whose cells start with numbers (`147-279`, `+408%`, `-13%`, `1,200`) sorts by those numbers, any other by its words; cells with nothing in them (`N/A`, `-`) come last either way, a picture counts as its words, and hidden text that is not shown counts as nothing, so sorting never gives it away. Sorting changes only the page shown, never the guide, and a page opened again shows its own order. Guides that a contents lists are read there and not offered under Lists; other guides (walkthroughs of the lists) stay under Lists. A game with no map opens on its guides, with no Map section; the classic layout shows "This game has no map" where the map would be, with a button to the guides.
- **The landing page of Guides.** Guides opens on a landing page named after the game (the title of its group, when games are shown under one title). When the pack keeps its site's own home page (`homePage`, see "Data packs"), that page is the landing page: read and edited as any page, its links and linked pictures leading to the main areas. Otherwise the landing page is made from the menu when it is shown: each section a group of tiles (its first pages, a picture where a page has one, and a link to the rest), and a line saying the site's own home page has not been read when the pages came from a site. A source with neither a home page nor a menu lands on **All pages**. A made landing page is no stored page and has nothing to edit. **Home**, beside Back and Forward in the head of the page area and always in view (or the `H` key), leads back to the landing page of the source shown; so do the game's name at the start of the way above every page, the name at the top of the bar, and the list a phone opens with its **Contents** button, which is headed with the game's name and names the home page first. The page editor's arrange tool shows the home page above the tree. The classic layout has no landing page and lists the guides as before.
- **The bar, and All pages.** The bar beside the page shows only the source's own menu, and what the person arranged by hand: the pack's sections (not those marked `placeByLinks`), in its order and nesting, and the person's own sections and pages, the pages they moved into a section, and the pages they put under a page. The app never files a page under another by reading the pages: not by their links, their lists, their `filedUnder` or their headings. A page the menu does not name is outside the menu, and **All pages**, one line at the foot of the bar with the number of pages, is the way to it: it opens in the page area every page of the source from A to Z, under the first letter of its title (accents left out; titles that start with a digit or a sign under `#`, first), in the order people read titles (numbers by their value, upper and lower case alike), each a link to its page, with the letters at the top leading to their groups. It is quick with thousands of pages (a part out of view is drawn when it comes into view), the way above it reads the source's name › All pages, and Back and Forward return to it where it was scrolled to. Above a page outside the menu, the way names the pages its source files it under (`filedUnder`), outermost first, at most six, never one twice; with none, only the source's name. At the foot of a page, **Pages under this page** lists the pages the person put there by hand, and **Linked from** the pages of the source that link to it (twelve named, then "and n more"), worked out when the page is shown; the home page has neither. A guide read in order reads its menu: a page outside it has no Previous or Next. A source with nothing for the bar has none: the page takes the width, and the head of the page area holds the search, the choice of source (with two or more) and an **All pages** button; on a phone, its **Contents** button opens All pages and is named so.
- **Page width.** On a computer or a tablet, the button with two arrows in the head of Guides (**Page width**) shows a game's pages as a column of text (**Reading**, at most 760 pixels, as before), **Wide** (at most 1,000 pixels, for a site that lays its pages out wider, so blocks it sets side by side stay side by side) or **Full** (as wide as the room for the page, with the reader's margins). The menu marks the width the site's rules file gave the pack (`pageWidth`, see "Data packs"), the default when the person has not chosen. The person's choice is kept with their own pages (see "Editing pages"), so building the game again or updating its pack keeps it, and it wins over the pack's. A phone always shows a page as wide as the phone, and has no button. The page editor keeps its own width. Every build has it, the viewer too.
- **Links to a location of a map.** A page of a game read from a site may link to a location on a map by the id the map's site gives it, such as a guide's link to a marker of a map site. When the pack says which links those are (`mapLinks`, see "Data packs") and a map with that location is at hand, in the game itself or in another game shown under one title with it, the link is shown as the app's own link and opens the map at the location, switching to that game when the map is another's, as a map of the maps menu does. A link whose location is not at hand stays a link to the web and opens outside the app, as before. The page's text is not changed: a game whose wiki gets such links later shows them once it is built again from its saved pages. Every build has it, the viewer too.
- **Ticking items.** An item with locations is found exactly when all its locations that can be marked are found, so ticking it on the list or marking its locations on the map show in both at once. Ticking it marks its locations that are not found yet; unticking it marks all of its locations not found, also those marked on the map before. Either is one change that `Z` takes back, and a notice says how many locations changed. An item without a location (a step, or a location in a type that is not tracked) has a tick of its own, kept per profile like found marks. Item ticks never change the top bar's found counter, which still counts locations found.
- **Photos.** A location's photos are at the top of its card (the details pane in the classic layout), before "From the wiki"; a list entry shows its own photos under it. A Photo guide shows each entry as a card, its photo first, grouped by area. A spoiler photo stays blurred until it is tapped or clicked; a tap on a photo opens it large (Escape, Close or a click beside it closes it). In the list editor, **Add a photo** beside the note's buttons adds a screenshot of one's own (PNG, JPEG or WebP) to a step, and **Edit locations** has the same for a location of one's own; each photo has a spoiler switch and **Remove**. Own photos are shrunk to about 1280 pixels wide and kept with the person's own lists and locations, never in a pack (see [apps/desktop/README.md](apps/desktop/README.md#maps-folder-and-other-locations)). A list file (`.atlaslist`) carries its list's photos (`pictureFiles`: each `file` with its bytes in base64 as `data`); a file without them still reads, and a list file may be up to 64 MB.
- **Maps and layers.** The map switcher sits in the top bar; maps with more than one layer get a layer switcher on the map. Filters and counters follow the active map.
- **Details.** Name, type, region, coordinates, the found switch and the guide entry. Hovering a marker shows its name only.
- **Profiles.** Each pack has its own profiles (for example one per playthrough): create, rename, duplicate, delete and switch them from the profile button.
- **Game save.** For a pack of a game whose saves Atlas reads (The Witcher 3 for now, saves of patches 4.0x and 5.0x), the save button in the top bar links a save to the profile: in the desktop app the game's saves folder (found under Documents, also when Documents is moved, for example by OneDrive), another folder or one save file; in a browser, a file opened with "Open a save file…". Atlas reads a copy of the save, never changes it, and shows its version, the world you saved in, what its own map lists (locations discovered, cleared and known of), how many locations it shows done per type, what did not match and why. A Witcher 3 save names the locations on its map by the game's own tags, without positions, so a location is marked when the pack names that tag (a location's `flagId`), when a fact the pack names is set, or, once the game's map locations are read (below), when a pin the save shows done lies on a location of its type; when a save marks nothing, the dialog says why (nothing discovered yet, or no table yet of where each tag is) rather than reporting a failure. It marks those locations found, but never where you set or cleared a mark by hand; each read is one change that `Z` takes back, and "Remove marks made from saves" takes them all back. Where you stood is an arrow on the map (a dot when the save has no facing), with "Show me"; when no map of the pack shows the save's world, the dialog says so, and you can choose which map shows which world. A map is lined up with the game world by the pack's `worldTransform`, else by placing yourself on the map from two saves made at least 50 m apart. In the desktop app, "Map locations from the game" reads where the game's own map pins are from your copy of the game (read-only, from the game folder you choose): the save's tags then become locations with a position, and a map is lined up automatically from every signpost of its world when the fit passes a clear bar; that table stays on the device, is never exported or put in a pack, and is read again after a game patch ([apps/desktop/README.md](apps/desktop/README.md#the-games-own-map-locations)). In the desktop app, "Follow new saves" reads each new save a few seconds after the game has finished writing it. A save of a game version Atlas does not know is refused with a message, and marking by hand works as before. The parser and matcher are in `packages/saves`; what a save holds beyond the player's position, the facts and the map pins (quests, Gwent cards, gear) is not used yet.
- **Export and import.** The profile dialog exports the current profile or all profiles of every pack as one JSON file, and imports such a file by merging (newer change wins) or replacing.
- **Map pack files.** In the desktop app, **Export…** on a game in the Maps dialog saves the game with its map images, at a chosen level of detail, as one `.atlaspack` file, and **Import map pack file…** adds such a file on another computer (the desktop app without downloads keeps it a file: **Add a pack file…** copies it into the packs folder, where it is read, and its settings offer the folders of maps and wikis it no longer uses for removal), while a pack file opened from the file manager, or put in the packs folder, is shown where it lies without importing it; Atlas for Android reads the same format. A map pack file never holds personal data such as found marks; the Export dialog can save the progress export beside it. See [apps/desktop/README.md](apps/desktop/README.md#map-pack-files), and [docs/pack-file-format.md](docs/pack-file-format.md) for the format and the `atlas-pack` crate (`crates/atlas-pack`) with which another app reads a file's description and the small pictures of its maps without unpacking it.
- **Keyboard.** `/` search, `F` mark found, `Z` undo, `N` select the nearest marker not yet found, `C` show or hide the checklists and guides, `Esc` clear the selection (in the standard layout: close what is on top, such as a menu, the search, the location or a list), `?` the guide of keys and controller, with what the mouse does (standard layout; also the keyboard button in the rail). On the map, with nothing else focused, `W` `A` `S` `D` move the map, `+` and `-` zoom, `Enter` opens the location under the crosshair, `0` shows the whole map and `L` the next level; `Q` and `E` switch to the section before or after. Shortcuts are ignored while typing in a field or while a dialog is open.
- **Controller.** Where the web view offers controllers (see "Atlas on Linux and the Steam Deck" in `apps/desktop/README.md`), the map moves with the left stick, zooms with the triggers and has a crosshair that holds the nearest location: A opens it, X marks it found. The bumpers switch sections, B goes back, Menu opens Settings and View the guide of keys and controller, which lists every key and button by context (`apps/web/src/input/bindings.ts` is the one table of them). A bar at the bottom of the screen shows the buttons that matter where you are. Settings › **Controller**: button hints (Automatic, Always, Never), button names (Automatic, Letters, Shapes), map speed, invert up and down, and whether a controller is detected now.

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

Guide entries are Markdown, rendered with markdown-it with raw HTML disabled, so any HTML in a pack shows as text. Images are rendered only from the pack's own pictures, by id: `![a waystone](demo:picture:wiki-waystone)` shows the file that `pictures.json` gives for that id, with its caption and credit; an image of any other address, or of an id the pack does not have, shows its alternative text, so a guide never makes the app load anything from the web. A title of the form `"=28x13"` (or `"=28"`, the width alone) is the size the picture is shown at where it stands, in CSS pixels: `![a badge](demo:picture:badge "=28x13")`. One at most 48 pixels tall stands in the line of text, as a badge or an icon does, with no caption under it; a larger one is shown that wide, with its caption. A picture whose file is not in the pack's folder (one listed with a `remote` address and not downloaded yet) shows its alternative text with "(picture not downloaded)", and is tried again when images are saved. In every app, a picture whose file is larger than the page shows it (an icon in a line of text too) opens in a larger view when pressed, or with Enter or Space once it has the focus: over everything on a dimmed backdrop, fitted to the window (a small one enlarged at most four times, with sharp pixels), with its caption and its size in pixels. A picture larger than the window can be seen at its real size, one pixel of its file to one pixel of the page, with a press on it or the zoom button, and is then moved by dragging, by scrolling, with a finger or with the arrow keys; pinching is not handled, so a touch screen uses the zoom button. Escape, the close button, a press beside the picture or Android's Back button closes it, and the focus goes back to the picture. It is a dialog for screen readers, named by what the picture shows. A picture that opens large has a small mark in its bottom right corner, always shown (a touch screen has no hover), with a tooltip that says what a press does: two arrows out to the corners, and a triangle before them for a picture that moves; a press on the mark is a press on the picture. A small picture in a line of text, and one shown narrower than 96 or shorter than 64 CSS pixels, has no mark, as it would be covered, and opens large all the same. A GIF that moves (more than one picture) opens large whatever its size, unless it is a link, and the larger view plays it from its start each time it is opened, so one that plays once and has stopped can be seen again; its file is read once, from the pack's folder, to learn whether it moves. When the system asks for less motion, such a picture is shown still on the page with a "Play" button and no corner mark until it plays; the larger view plays it when it is opened. A picture that is a link (an item's icon that leads to its page) follows its link and does not open large, one whose file is no larger than shown opens nothing, and a picture in hidden text is shown by the first press and opened by a later one. The photos of locations and list entries open in the same view, with the same corner mark. Web links open in a new tab with `rel="noopener noreferrer"` (in the desktop app, in the system browser).

A link whose target is a content id of the same pack is an in-app link: `[the old well](demo:loc:0412)`, or `<demo:loc:0412>`. It is drawn as a button and acts in the app instead of opening a browser:

| Target                               | What the link does                                                    |
| ------------------------------------ | --------------------------------------------------------------------- |
| a location (`<gameId>:loc:…`)        | shows it on the map and selects it, switching map and layer if needed |
| a region (`<gameId>:region:…`)       | moves the map to the region, as a region row in Progress does         |
| a map (`<gameId>:map:…`)             | shows that map                                                        |
| a checklist (`<gameId>:checklist:…`) | opens it on the checklists screen                                     |
| an item (`<gameId>:checkitem:…`)     | opens its checklist with the item in view                             |
| a guide (`<gameId>:guide:…`)         | opens it on the checklists screen                                     |

Ids from an earlier pack version are followed through `idMigrations`. A link to an id the pack does not have, to another pack, or to another kind of content is shown as plain text; on a guide page of a game read from a site, a link to one of its pages that was not read yet is underlined with dots and says "This page has not been read yet" when pointed at, and works once that page is read. In-app links work in every Markdown text: location notes in the details pane and in checklist rows, guide pages and item notes.

Every heading of a guide has a name, worked out from its words whenever the page is shown, so nothing is stored for it: the words in lower case, accents and apostrophes left out, and every other run of characters that are not letters or digits one dash (`## Where to find` is `where-to-find`); a heading whose words an earlier heading of the page has gets `-2`, the next `-3`, as a wiki numbers them. A link to a page names a section of it with its title, `#` and the section's name: `[by boat](demo:guide:wiki-travel "#by-boat")`. Only a title that starts with `#` names a section; any other title is what the link says when pointed at, as before. Finding the heading is forgiving, since a section often comes from a site's address: case, underscores for spaces, percent-encoded characters, punctuation, accents and the number after a repeated heading do not count. When no heading fits, the page opens at its top. A link to a section of the page it stands on is written the same way, with the page's own id. An app before this opens the page at its top, and shows the title (`#by-boat`) when the link is pointed at. The functions are `sectionName`, `headingNames` and `findSection` in `packages/core/src/guides/sections.ts`.

Text between double bars, `||like this||`, is hidden until the reader presses "Show hidden text" where it begins (a solution, a spoiler). A hidden part may sit inside a sentence or run over several paragraphs, lists and code, and may hold in-app links. Bars pair up left to right; a last bar without a partner, bars in code and escaped bars (`\|`) are plain text. Where a note is shown as one line (list rows, Next up), each hidden part reads "(Hidden)".

Bars in paragraphs of their own around other blocks hide those blocks whole: `||`, a blank line, a table, a blank line, `||` hides the table (a part of a table is never hidden as a whole, since hiding a cell would move the others; the text of cells is; in a cell every bar is escaped, as a table needs any bar there: `| \|\|Hidden Hall\|\| | 7 |`). A paragraph that holds only the bar that closes such a part is left out.

Raised and lowered text is `^raised^` and `~lowered~` (a note's mark, `Text^\[a\]^`, a small tag after a name, a formula, `H~2~O`). Neither may hold a space or a line end that is not escaped (`^two\ words^`), as in other Markdown that has them, so `x^2 + y^2` stays as it is; a link, a picture or code inside may hold spaces as always. `~~` is strikethrough, and `\^` and `\~` are the characters themselves. An app before these marks shows the characters as written (`Vale^DLC^`).

A table cell is one line in Markdown; the exact text `<br>` in a cell is a line break there (`| 82 DPS<br>16.4 a hit |`). It is the only HTML a guide holds, and only in a table cell: `<br>` anywhere else, escaped (`\<br>`) or in code, and any other tag stay text. An app before this shows `<br>` as text.

Coloured words are `[like this]{color=#b8714a}`: the words in brackets and, right after them, a colour of `#` and three or six hexadecimal digits, nothing else (no names, no other property, no space before the brace); anything else stays text. The words may hold other marks and links, and may stand in a link's words or raised text (`Vale^[DLC]{color=#82c936}^`). A colour chosen for one background can be unreadable on another, so each theme shows it with its hue kept and its lightness moved toward the theme's text until it has a contrast of at least 4.5 to 1 with every background guide text stands on there; a colour that already reads is shown as written. Only the checked colour reaches the page, as a data attribute the app turns into the colour; a guide's text never becomes a `style` attribute. An app before this shows the words with their brackets and braces, as written.

A box of facts (a wiki's "infobox": a thing's name, its picture, and rows of a label and its value) is a table of two columns whose first row is the box's title and, in its second cell, exactly `{box}`:

```
| Stonebreaker maul | {box} |
| --- | --- |
| ![A stone maul](demo:picture:wiki-maul "=160x160") |  |
| *Cut from the arm of a fallen warden.* |  |
| Type | Heavy weapon |
| **Damage** |  |
| Slam | 80^\[a\]^ |
| Found in | [Stone wardens](demo:guide:wiki-wardens) |
```

Every other row is a label and its value. A row whose second cell is empty runs across the box (a picture, a caption, a line of text), and is a heading of the box when its words are all bold (`| **Damage** |  |`); a row with both cells empty is left out, and so is the first row of a box with an empty title. A value holds what any table cell holds: links, pictures, raised text, coloured words, hidden text and line breaks (`<br>`). Anything else in the first row's second cell (`box`, `` `{box}` ``, a third column) makes an ordinary table. The page shows the box at the right of its text where the page is at least 620 pixels wide, the text flowing beside it, and across the page where it is narrower (a phone), where it stands in the text. Its labels and heading rows are no headings of the page: they are not in "On this page" and no link names them as a section. A box is never sorted and its rows have no "Add to build" buttons; "Find on the map" reads its rows as any table's (a row whose label says where, such as `Found in`, gives the rest of the row). The page editor edits a box as the table it is, with a line saying what makes it a box. An app before this shows an ordinary table whose second heading is `{box}`.

A list of tiles is not a form of its own but a way of showing a list: a bulleted list of two items or more, each only a picture shown on its own (one larger than a picture in a line of text, or of no given size), alone or as a link's only content, followed by at most 60 characters of words (a name, which may be a link), with nothing nested, no other picture and no hidden text, is shown as a grid of tiles, each name under its picture, as a wiki's gallery or the grid of linked pictures on its home page:

```
- [![Gear](demo:picture:gear "=100x100")](demo:guide:gear) [Gear](demo:guide:gear)
- [![Bosses](demo:picture:bosses "=100x100")](demo:guide:bosses) [Bosses](demo:guide:bosses)
```

Any other list is shown as before, and an app before this shows the list. A picture shown at twice its own size or more (a small icon a wiki draws larger) is drawn with sharp pixels rather than blurred.

#### Layout forms

A page can lay its blocks out as a site does: blocks side by side, a card with a title, a row of short items, a list in columns and a centred block. Each form is whole marker lines around ordinary Markdown blocks, so an app before this shows every block in reading order, with the marker lines as written. The rules (read by `layoutForms.ts` in `@atlas/schema`, the one reader every part of the app uses):

- A marker line is `:::`, a space and the form's name, and for some forms a space and its values, in lower case. It starts at the start of its line, may end with spaces, and stands alone: a blank line (or the start or end of the page) before it and after it.
- `::: side` opens blocks side by side; `::: next` stands between two of them (two to four blocks). Their shares of the width may follow the name, two to four whole numbers joined by `:`: `::: side 1:3` makes the second block three times as wide as the first, as a narrow menu beside a text. Without shares the blocks are equally wide; a block without a share has 1, a share left over is ignored, and each counts as 1 to 9. A `::: next` after the fourth block is text.
- `::: card` opens a framed block. Its first block, when an ordinary heading (`### Menu`), is its title bar, and is a heading of the page: listed under "On this page" and a section a link can name.
- `::: row` opens a row: a list in it is set on one line, a dot between its items (when every item starts with a picture shown in the line of text, the pictures stand beside the items instead), and wraps onto further lines where the page is narrow. An item of several lines (Markdown line breaks in it, as `rowMarkdown` writes an item with `\n`) is a block of those lines one under another, beside the small pictures it starts with: a platform's icon beside its name, a number and a line under it.
- `::: columns 3` opens a list flowed in that many columns, a whole number counted as 2 to 6. When every item is one line that starts with a small picture shown in the line of text (an icon before a name), the items show without bullets, each picture beside its words. A list whose every item is one line fills the columns by count, as a site's balanced columns of such lines do (21 items in four columns are 6, 6, 6 and 3), so an item that wraps in a narrower column moves no other item to the next column; as many lists as columns, and nothing else, are one list a column. Where the columns are fewer than asked (a narrow pane), the browser balances them.
- `::: centred` opens a block set in the middle.
- `::: end` closes the form opened last that is still open. Forms nest as brackets do, at most four deep, and a page holds at most 200 forms; any deeper or later form is read as text, its blocks kept.
- A marker with no partner (an opening never closed, an `::: end` with nothing open, a `::: next` whose innermost open form is not `side`), an unknown name, other values, a marker line that is indented, in a list, a quote or code, joined to a line of text, or escaped (`\::: card`) is ordinary text, shown as written.

```
::: side 1:3

::: card

### Find your way

- [Waystones](demo:guide:wiki-waystones)
- [Blades](demo:guide:wiki-blades)

::: end

::: next

::: centred

**Welcome to the isle.**

::: end

::: columns 3

- The landing
- Old mill
- Cliff path

::: end

::: end
```

Every mark works inside a form: boxes of facts, tiles, hidden text (inside a form, or around one), coloured words, tables (and their sorting), pictures with sizes, in-app links and links to sections. Where a form is narrow (a phone, a narrow pane, a block beside another), blocks side by side stand one under another in reading order (blocks of short lines only, such as two short lists with their headings in a card, stay side by side while each has room for a short line, and stand one under another on a phone), columns become fewer, down to one, and a row wraps. A card has the app's own frame and title bar in both themes; no colours or frames come from a site. Search, "From the wiki", the first lines of a page, the build planner, the filing of pages and every other reader of a page's text read the blocks of the forms in order and never their marker lines.

An importer writes the forms with the helpers of `@atlas/importer-api`: `sideBySideMarkdown(blocks, shares)`, `cardMarkdown(title, body, level)`, `rowMarkdown(items)`, `columnsMarkdown(count, body)` and `centredMarkdown(body)`, with `sharesOf(widths)` for shares from widths in any unit and `escapeLayoutMarkers(text)` for a site's text that would read as a marker line. The page editor shows each form as a frame around its blocks, with **Layout** in its text tools to make one, and edits its marker lines as text in **Markdown**.

An importer that reads a page in the app's window can also keep the layout the browser shows, style sheets included, with the measuring step of `@atlas/importer-api` (`layoutNotes.ts`). `LAYOUT_NOTES_SCRIPT` is the text of a function the importer puts in its own page reader and calls on the page's article: it returns the copy (a caller may hand it a fresh copy of its own and lower limits). It copies the article into a document of its own, which loads nothing and runs nothing, measures each element of the article as the browser laid it out, and writes what it found as notes on the copy, never on the page; it makes no requests, presses, scrolls or changes nothing, and works on any document handed to it (a frame's too, from outside it). The notes are `data-atlas-*` attributes:

- `data-atlas-layout="1 16"` on the copy itself: the version of the notes and the size of the text most of the article's words have, in pixels, with ` cut` when the step stopped at its limit.
- `data-atlas-hidden`: the element is not shown, by `display` (`display: none`), `visibility` (hidden) or `box` (no size, or kept out of view, as text for screen readers is). Nothing under it is noted.
- `data-atlas-box="left top width height"`: its box in whole pixels from the article's top left.
- `data-atlas-flow`: how its children flow, `row` or `column` (a flex box, with ` wrap` when it wraps), `grid` with the widths of its columns, `columns N`, `inline` (items set in one line) or `float` (children floated beside each other).
- `data-atlas-look`: `centred` (its text set in the middle, or a flex row that sets its children in the middle with `justify-content: center`), `framed` (a border all round, or a background unlike what is behind it), `bold`, `italic` (all of its own words are), and `xN`, the size of its own words to the article's (`x1.5`, the smallest of them), when it differs by a tenth or more.

The step notes at most `MAX_LAYOUT_NOTES` (5000) elements and stops after `LAYOUT_NOTES_MS` (400 ms). On any error, while the page is still loading or while one of its style sheets has not come, it returns the copy without notes; a note the page itself wrote is removed. `readLayoutNotesMark(value)` and `readLayoutNote(attributes)` read the notes back, ignoring a value not in their form, and `layoutNoteAttributes(note)` writes them (for tests). What a converter makes of the notes is the importer's: the forms it writes are the ones above.

A page the app fetched has no notes, as nothing measured it. A build with downloads lays such a page out itself, when the importer asks (`ImportContext.layOut(page)`, with the page's HTML, its address and, optionally, selectors of its article): in a frame of its own, out of sight, out of the accessibility tree and removed when done, 1280 pixels wide, with the style sheets the app keeps for the game (see `styles.ts`), it lays the page out and measures it with the same step, from the first article selector that finds something, else from the body, and hands the page back as HTML with the notes on it, or null. The frame is closed: it is sandboxed without scripts, its document is given as text with a policy of its own that allows nothing from the network (`default-src 'none'`, inline styles only), every element that runs, loads or shows another page is left out (scripts, frames, objects, embeds, links, `base`, a refresh, a form's sending), as are event attributes and every address of something loaded (`src`, `srcset`, a poster, a background), the sheets go in as text with `@import` left out and every `url()` made empty, and a picture keeps the size it states (a small fixed box when it states none). Notes the page came with are taken off first, so every note handed back is the app's; the app keeps none of them, and the page data it saves is the page as it came. One page is laid out at a time, each within `LAYOUT_PAGE_MS` (2 s); a game with no kept sheets has no frame opened, and the page comes back null. "Build again from saved pages" lays out each page the importer asks for and says how far it is ("Laying out page 120 of 3,400") and, at the end, how many were laid out; a page read by itself is laid out once fetched, before it is converted. The sheets a wiki's pages link to are fetched after the session that read them, so the pages of a wiki's first session are written without being laid out; once its sheets are kept, the app builds the game again from its saved pages by itself, with nothing downloaded, and says so. An importer that does not ask, and an app that cannot lay pages out (a build without downloads, an older app), leave pages as before.

A site rules file can say what an importer's general rules get wrong on one site, in the `layout` section of a wiki or guide part or of a reader's defaults (see "The layout of the pages" in `packages/importer-api/site-rules/atlas-site-rules.md`): how the layout is read (`seen`, `stated` or `off`), which blocks are cards and their titles, which are side by side, in one column or in a row, what is left out, which hidden blocks are kept, lines made headings, lines of more than four blocks, the pictures of a home page, and the width of the pages. The checker (`checkSiteRules`) and the JSON schema check it; what an importer makes of it is the importer's. An importer that lays pages out (`ImportContext.layOut`) asks for no page of a site whose file says `read: "stated"` or `"off"`, and reads no reader's notes on its pages; the other entries hold the same for a page laid out in the frame as for one read in the window. A site's information (`siteInfo`) may name `layoutRead` and `pageWidth`. "Try on a saved page" shows the layout an importer found (`SiteTrial.layout`): how it is read, sets of blocks side by side, cards and their titles, rows, lists in columns, centred blocks, lines made headings and blocks left out, with each entry of the section that matched nothing among the selectors that matched nothing. An importer may try any file it reads, not only parts read by `rules` (`ImporterSites.cannotTry` says why it cannot try one, in a sentence). A page saved as one file with its style sheets inside it is laid out first in the app's closed frame (`SiteTrialRequest.layOut`), which runs no script and fetches nothing, so the trial reads it by position; a page that links to style sheets it does not hold, or holds none, is read by the layout its HTML states, and the Sites screen and the rules editor say which was done, and why, in plain words. The editor draws the page as Guides draws it, at the width the file gives the game's pages.

#### Pages linked to the map

Pages read from a site (guides with a `source`) can be linked to the map. **Link pages to the map**, at the top of the contents, compares each page's title with the game's types, location names and regions (without case, accents, punctuation, a leading article or simple plurals; a location name is also tried without its number) and lists the pages in three groups: **Sure** (one clear match), **Unsure** (several matches, or only a near one) and **No match**. Each page can be confirmed, changed to another type, location name or region found by name, or skipped; **Confirm all sure** confirms the first group at once. Nothing is linked until the person confirms it. Linking is done on a larger screen (a tablet on its side or a computer); a phone uses the links and says so.

A linked page shows **From the wiki** on the cards of its locations (the page most about the location first: the location alone, its own name, then its type, then its region; with its first lines, its credit and **Read the full page**), and the page shows **On the map: N locations** with **Show on the map**, which shows only those locations until the chip "Only …" is closed. In the list editor, **Link a guide** in a step's note tools finds a page by name and puts an in-app link to it in the note.

A location's card can also find its page itself, in the standard layout. **Add to a wiki page…**, on the card of a location no page is linked to, lists the saved pages that may be about it, the best first, each with **Read** and **This is the page**; on a card with a linked page, **Search for another page** does the same, and **Not this page** takes the link off (with Undo). Only pages already saved are searched; nothing is fetched. A page is found by its title or another name (an id the page was read under before, from the pack's `idMigrations`), whatever their case, accents, punctuation, leading article, simple plurals, a note in brackets or a number at the end, with the words in any order, a word misspelt by a letter (by two in a word of eight letters or more; none in a word of three letters or fewer, or a number; two letters swapped count as one) and words written together or apart taken as the same; a rarer word counts for more than a word many titles share. Pages whose text only mentions the name come after. The pages of other games read with this one are searched too. **This is the page** links the page to every location of the location's name, or only to this one: it asks which when the map has more than one location of that name, and links to the name at once when it has only this one. A page can be linked to at most 20 things on the map. The search itself is `PageNameIndex` in `packages/core/src/guides/nameMatch.ts`, which indexes titles by word so a wiki of thousands of pages is searched as a name is typed.

Below the pages found, **Or put a link to … on a page of your own** chooses one of the person's own pages; **Add the link** opens it in the page editor with a link to the location added at its end, to save or undo.

A page's entries on the map have a small map mark after them, in the standard layout and the finger one (`apps/web/src/markdownEntries.ts` and `apps/web/src/state/mapEntries.ts`). An entry is a link to a page that is linked to a location (by the pack, or by the person's link to the location or its name; a page linked to a whole type or region counts for none), a link to a location (an in-app link, or a web link to a location of a map the app found), or a plain name that exactly matches the name of one location of the game and no other, whatever its case, but only as the whole first cell of a table's row or the first words of a list's item (bold or not), never in running text. Pressed, the mark shows the location, or for several a short list of them (at most 8) with **Show all on the map**. On a page of the wiki, where Edit locations has room, **Put entries on the map** gives each entry that is not on the map a mark too (a link to a page with no location, a table's first cell, a list's bold first words or its first words before a colon or a dash between spaces): pressed, it opens Edit locations, the person presses the map where the entry is and chooses its type (the last one used first), and the new location of their own is named after the entry and linked to its page, so the page shows on its card under **From the wiki**. Nothing about the marks is stored.

A game with a map can also read the pages of another game on the device that has pages and no map (a wiki read as a game of its own): **Add guides from another game**, at the top of its contents. Those pages are read under their own heading, with their own ids, and can be linked to this map like the game's own. The other game's pack is never changed; **Stop reading here** takes them away again.

The choices are the person's own and are kept beside the map, not in the pack: in the desktop app as the file `<gameId>.guide-links.json` in the maps folder, in the browser and on Android in IndexedDB (the setting `guideLinks:<gameId>`). Both hold the same JSON:

```json
{
  "format": "atlas-guide-links",
  "version": 2,
  "gameId": "demo",
  "updatedAt": "2026-11-13T10:00:00.000Z",
  "guidesFrom": [{ "gameId": "isle-wiki" }],
  "choices": {
    "demo:guide:wiki-waystones": {
      "state": "linked",
      "targets": [{ "to": "type", "id": "demo:cat:waystone" }]
    },
    "demo:guide:wiki-wolves": {
      "state": "linked",
      "targets": [{ "to": "name", "name": "Wolf den" }]
    },
    "demo:guide:wiki-wardens": {
      "state": "linked",
      "targets": [{ "to": "location", "id": "demo:loc:0412" }]
    },
    "demo:guide:wiki-regions": { "state": "skipped" }
  }
}
```

`choices` is keyed by guide id (of this game, or of a game in `guidesFrom`); a target is a type (`{ "to": "type", "id": "<gameId>:cat:…" }`), a location name (`{ "to": "name", "name" }`, every location of that name or of that name with a number), a region (`{ "to": "region", "id": "<gameId>:region:…" }`, with its sub-regions) or one location alone (`{ "to": "location", "id": "<gameId>:loc:…" }`, from **Only this one** on its card), at most 20 per page. A location's pages are looked up in that order: the location alone, its name, its type, its region. The file is version 2 only while some page is linked to one location alone, and version 1 otherwise, as Atlas 0.6.3 writes it; an older Atlas reads a version 2 file and uses it without changing it, and says so. The file is written strictly and read tolerantly: unknown fields are ignored, a choice that cannot be read is left out (and a copy of the file is kept before it is next written), and choices for pages the game does not have now are kept, so reading the pages again keeps them. It holds no personal data. A map pack file carries it with the person's own things (`mine/guide-links.json`).

#### Editing pages

**Edit the page**, on a page of Guides (or **Edit the pages**, at the top of its contents), opens the page editor. Beside the page are the contents as the person arranges them: a page or a section is moved by dragging its handle, by Alt+Up and Alt+Down on the handle, or from its menu (**Move up**, **Move down**, **Move to section…**); **New page** and **New section** add one's own; a wiki page can be hidden from the contents and shown again; one's own pages and sections can be deleted (what a section held stays where it was). Pages are tagged **Changed by you** or **Yours**.

The contents beside the page also make levels of pages and fill them. Each page row has a tick box (in view on hover or focus, always on a touch screen, and on every row while one is ticked; Shift ticks every row from the last one ticked); while pages are ticked, a bar says how many and offers **Move to…**, **New level from these** and **Clear**, and dragging one ticked row drags them all. They move together in contents order; a page that would go under itself or under a page beneath it stays where it is, and the app says how many stayed. Alt+Up and Alt+Down move one row at a time. Each move is one change, with one **Undo**. Putting pages under a page records only those pages, in the order the person gives them. The pages the site's menu does not name are in one flat group at the end, **Not in the menu**, a row with no handle: a page is moved into the menu from it (dragged, or with **Move to…**), and goes back to it when the person moves it there; a page the site's own menu names stays in the menu, and the app says so. **New level from these** asks for a name and makes a page of one's own where the first ticked page is (before it in a section; under the page it was under, after the pages put there by hand), with the ticked pages under it in their order; with **List the pages in its text** (on at first), its text is a list of links to them. **New page under this page**, in a page's menu and over the contents for the page edited, adds a page of one's own under it, opened to be written. **File the pages this page lists under it**, in a page's menu, puts the pages its text lists that are in **Not in the menu** under it, in its order, once, as if the person had moved them (with one **Undo**); a page it lists that is in the menu or under a page already stays where it is, and the app says how many. In the page editor, **List the pages under this page** (under the text tools' **More**) puts a list of links to the pages under the page edited after the part being edited, nested as the contents shows them; it is text from then on and does not change when the pages under the page do. On a phone, the contents open from the page's **Contents** button, with the same tools.

The page is edited with text tools (headings, bold, italic, strikethrough, bulleted, numbered and nested lists, tables with their rows, columns and alignment, pictures of the game or one's own, links to a page, a location or the web, quotes, code, a line across the page, and hidden text) or, with **Markdown**, as its Markdown text; both edit the same page, with Undo and Redo. A picture's size is kept as its title (`"=28x13"` or `"=28"`, in CSS pixels; a height of at most 48 px is shown in the line of text). Raised and lowered text shows raised and lowered in the text tools, and coloured words in their colour; both keep their marks as the text around them is edited (there is no tool to colour words); in a table cell, Shift+Enter is a line break, written `<br>`. A box of facts is edited as the table it is (its title in the first cell, `{box}` beside it). A layout form is a frame around the blocks it holds, named by its form, with its tools: **Widths** for blocks side by side (1:1, 1:2, 2:1, 1:3, 3:1 for two blocks, and so on), **Add a block** and **Remove block 2** (its text goes to the block before it), **Columns**, **Move up**, **Move down** and **Take apart** (the form goes, its text stays); a card's title is edited in its title bar. **Layout** in the text tools makes each of the five forms around the part being edited, or new and empty; a block moved past a marker goes into or out of a form. What has no tool of its own (reference links, raw HTML shown as text, hidden text that runs across a list or around a table) is kept and edited as Markdown. The page is edited part by part (each paragraph, heading, list, table, quote or code block): a part that is not changed keeps its text byte for byte, and in a list or a table only the item or row changed is written anew, so a page opened and saved without a change is the pack's page still. Changes are saved with **Save**; until then they are kept in the browser, and leaving asks first.

**About this page** has its section, the locations it is linked to on the map (as in "Pages linked to the map"), and for a wiki page **See the wiki's version**, **Go back to the wiki's version** (after asking) and what to do **When the wiki changes this page**: keep the person's version and say so, or take the wiki's. When the pack's text of a page changed since the person changed it, the page says so, with the wiki's new version to see and **Keep my version** or **Take the wiki's version**; the person's text is never replaced without them choosing it.

The changes are the person's own and kept apart from the pack, so reading the wiki again never overwrites them: in the desktop app as the file `<gameId>.my-pages.json` in the maps folder (moved with the maps folder, deleted with the game's lists when asked), in the browser and on Android in IndexedDB (the setting `ownPages:<gameId>`). A map pack file carries them, with the person's other own things, as `mine/my-pages.json`. Both hold the same JSON:

```json
{
  "format": "atlas-own-pages",
  "version": 1,
  "gameId": "demo",
  "updatedAt": "2026-11-13T10:00:00.000Z",
  "pages": [
    {
      "id": "demo:guide:wiki-wolves",
      "body": "Wolves hunt in packs…",
      "basedOn": "The wiki's text the change was made to",
      "updatedAt": "2026-11-13T10:00:00.000Z"
    },
    { "id": "demo:guide:wiki-regions", "hidden": true, "updatedAt": "2026-11-13T10:00:00.000Z" },
    {
      "id": "demo:guide:own.k3x9q2",
      "title": "My notes",
      "body": "…",
      "updatedAt": "2026-11-13T10:00:00.000Z"
    }
  ],
  "sections": [{ "id": "demo:section:own.a7m2p0", "title": "Mine" }],
  "contents": {
    "top": ["demo:section:wiki-basics", "demo:section:wiki-isle", "demo:section:own.a7m2p0"],
    "sections": { "demo:section:own.a7m2p0": ["demo:guide:own.k3x9q2"] }
  },
  "pictures": [
    {
      "id": "demo:picture:own.f4c8",
      "file": "pictures/own.f4c8.webp",
      "shareable": true,
      "width": 1280,
      "height": 720
    }
  ],
  "listPages": { "demo:guide:wiki-travel": true, "demo:guide:wiki-regions": false },
  "pageWidth": "wide"
}
```

A wiki page's record keeps only what the person changed (`title`, `body`, with `basedOn`, the wiki's text it was changed from), `hidden`, and `whenWikiChanges` (`"take"`; absent is "keep"); a page or section of one's own has an id starting `own.`. `contents` is the person's arrangement, when they made one. Under a page's id it holds the pages the person put under that page, in their order. A list written by an earlier version, which held every page shown under the page, is kept and shown as it is, so nothing the person arranged moves. Pages and sections of the pack it does not name (read from a newer pack) are put after the entry before them in the pack's contents, and one's own it does not name at the end. `pictures` are the person's own photos the pages show, kept with their own photos. `listPages` (optional, absent when there is none) is a say earlier versions kept, by a wiki page's id, on whether the page files the pages it lists; Atlas files no page under another by itself any more, so it reads the field, keeps it when it writes the file again, and is guided by it in nothing (a say that cannot be read is left out). Atlas 0.11.0 and earlier read a file with it as before and ignore the field. `pageWidth` (optional) is the width the person shows the game's pages at, `reading`, `wide` or `full` (see "Page width" above), and wins over the pack's; one that cannot be read is left out. Atlas 0.15.0 and earlier read a file with it as before, ignore the field and leave it out when they write the file again. The file is written strictly and read tolerantly, as the other own files are.

#### My notes

Every location's card has **My note** at its top, in the standard layout (a phone, a tablet or a computer): **Add a note** writes one there, in Markdown (hidden text included), with photos; **Edit** and **Delete** (with Undo) change it. A location with a note carries a small mark on the map, **With my notes** in the filters (and a chip over the map on a phone) shows only those locations, whatever types are shown, and search finds the words of notes after the names, each row saying the line of the note. The note of a location of one's own is the one kept with that location (in the own locations file, `<gameId>.my-locations.json`), shown and changed there the same way.

A note is kept under the location's id as it was when it was written. When the pack renames a location (its `idMigrations`) the note follows it; when the game no longer has the location, the note is kept and listed under **Notes without a location**, in the filters, with the name the location had, to read, copy or delete. When two notes lead to one location, the newer is shown and the other is listed there too; writing the note again keeps one.

The notes are the person's own and kept apart from the pack: in the desktop app as the file `<gameId>.my-notes.json` in the maps folder (moved with the maps folder, deleted with the game only when **Also delete my locations, types and notes for this game** is ticked), in the browser and on Android in IndexedDB (the setting `ownNotes:<gameId>`). A map pack file carries them, with the person's other own things, as `mine/my-notes.json`. Both hold the same JSON:

```json
{
  "format": "atlas-own-notes",
  "version": 1,
  "gameId": "demo",
  "updatedAt": "2026-11-14T10:00:00.000Z",
  "notes": {
    "demo:loc:0412": {
      "text": "The ladder is **behind** the well.\n\n||Use the rusted key.||",
      "name": "Old well",
      "photos": [{ "picture": "demo:picture:own.ab12", "spoiler": true }],
      "updatedAt": "2026-11-14T10:00:00.000Z"
    }
  },
  "pictures": [
    {
      "id": "demo:picture:own.ab12",
      "file": "pictures/own.ab12.png",
      "shareable": true,
      "width": 1280,
      "height": 720
    }
  ]
}
```

`notes` is keyed by location id, of this game's locations only (a location of one's own keeps its note itself); `name` is the location's name when the note was written, at most 200 characters, and `text` at most 20,000 characters of Markdown; a note has words or a photo. Notes are written in the order of their ids, so the file changes only where a note does. `pictures` are the person's own photos the notes show, kept with their own photos and never deleted as unused while a note shows them. The file is written strictly and read tolerantly, as the other own files are: a note that cannot be read is left out and counted (and a copy of the file is kept before it is next written), and a file a newer Atlas wrote is shown and not changed.

#### Your names for maps and levels

**Rename…** beside each map and each level, in the maps menu (the map's chip) and in the game's details in the Library (**Maps and levels**), gives it a name of your own. Your name is shown wherever the map or level is named: the maps menu and the chip, the map switcher of the classic layout, lists, search, a location's card and Progress. The dialog says the original name, and **Use the original name** gives it back; a notice after a rename offers it too. For the game shown, Undo in Edit locations takes a rename back like any other change of your own.

The names are kept with your own data of the game, never in its pack, so reading the game again, updating it or importing its pack file over it keeps them. They are in the own locations file (`<gameId>.my-locations.json` in the maps folder, or where progress is kept in a browser and on Android), as `names`: each with the `id` of the map or level (its layer), your `name` (at most 200 characters) and the `original` name the source gave it when you first renamed it, kept beside yours and never shown in its place. A name of a map or level the game does not have now is kept for when it comes back; deleting a map made in the app forgets the names of it and its levels. A file with names is version 2, so an older Atlas shows its locations and does not write over them; one without names stays version 1. A pack file that carries your locations carries your names with them. The names of the sources of a title are not changed here (see "One title for several sources").

### One title for several sources

The same game can come from more than one source: a map read from one site, another read from a second site, a wiki read as a game of pages. **Show with another game under one title** puts them under one title. It is in Games (a browser, the Android app) on each game's row, and in the Library (the desktop app) under **More**. The person chooses the other game and the title: the first game's title is offered, and another can be typed. More games can join a title later (**Add another game…**), and a game already under a title brings that title's games along.

A title is one row, with **Sources: A, B**. Opening it opens the source shown last under it on this device, or the first one with a map. **Sources…** lists the sources, to show one, take one out, rename the title or **Show separately again**. The maps menu is headed **Maps of** the title and lists the maps of each source under its name; choosing one shows that source at that map. A source with one map has the same menu, so the source can always be changed where the maps are. Guides of every source also show the pages of the title's games of pages (a wiki read as a game with no map) and of the games each source reads guides from, under **With this title**; this is worked out when Guides are shown and never written into a source's own choices. A game of pages under a title shows the title's maps at the top of its Guides.

Each source stays a whole game: found marks, lists, own locations, notes and progress stay with the source they were made on, and Progress shows the source shown. Nothing is merged, so nothing is lost when a source is taken out or the title is undone (each change can be undone from its message). A source's name is its importer's title (the manifest's `source.importer.title`), else its pack's title, or **Your own** for a game made in the app. Sources whose names are the same are told apart by the site each was made from (the host of the first web page its manifest's `source.pages` records, without a leading `www.`): **Example (wiki.fenmoor.example)** and **Example (fenmoor.pages.example)**. Those whose site is not known, or is the site of another of them, get a number instead (**Example 1**, **Example 2**), never both; one left alone keeps the plain name. The list of a title's sources shows each source's title and its site under its name, and the Library says where a game added from web pages came from (**Added with Example from wiki.fenmoor.example**). The classic layout lists each game under its own title in its game menu and opens it as before; its Library shows the title rows.

In the desktop app with downloads (the Importer), adding a game whose title is the same as one already here, without case, accents or punctuation, offers once to show them under one title; the person can change the title or keep them apart, and the game is never put under a title without asking.

The titles are kept beside the games, not in them: in the desktop app as the file `game-groups.json` in the maps folder (carried over when the maps folder changes), in the browser and on Android in IndexedDB (the setting `gameGroups`; the source shown last under each title is the setting `gameGroupsLast`, and the games the Importer asked about `gameGroupsAsked`). Both hold the same JSON:

```json
{
  "format": "atlas-game-groups",
  "version": 1,
  "updatedAt": "2026-11-14T10:00:00.000Z",
  "groups": [
    {
      "id": "title-5c1e09a2b7d4",
      "title": "Atlas demo world",
      "members": [{ "gameId": "demo" }, { "gameId": "isle-wiki" }]
    }
  ]
}
```

A title has 2 to 20 games and a name of at most 200 characters, and a game is under one title at most; there are at most 1,000 titles. A game that is not on this device is kept in its title and not shown (the title says how many are away), and a title with one game here shows as that game. Deleting a game takes it out of its title. A pack's id never changes (its folder, its profiles and the person's own files are kept under it), so a title names games by id and needs no `idMigrations`. The file is written strictly and read tolerantly: unknown fields are ignored, a title or game that cannot be read is left out (and a copy of the file is kept before it is next written), and a file a newer Atlas wrote is shown and not changed.

A map pack file exported with **Include my lists, locations, types and photos** carries the game's title as `mine/game-group.json` (`{ "format": "atlas-game-group", "version": 1, "gameId", "updatedAt", "title", "members" }`), as version 6 of the format; importing it adds the title, or puts the game under the title already here that holds one of its games. Every map pack file of a game under a title names the game by that title in its description (`game.title`), ticked or not; only the group itself, with the other games' ids, waits for the tick.

## The demo pack

`packs/demo` is a fictional island generated entirely by code in `packages/pipeline`: an 8192 × 8192 px relief map drawn from seeded noise, cut into a 256 px WebP tile pyramid (zoom 0–5, 1,365 tiles), with ten regions, twelve categories in three groups and 5,000 locations. A second, smaller map, an underground cave system of 2048 × 2048 px with two layers and 240 locations on each, exercises the map and layer switchers. The pack also has entities, guides with Markdown, three presets, a note of its own for each lore tablet and chest on the surface, five lists (a checklist of every waystone, a story of steps without places, a long mixed list of 326 items with sections, a route of 2,015 places across both maps, and secrets: eight riddles of one name whose notes hide their answers) and three walkthrough guides that use in-app links. It has drawn photos too: three waystones with a photo each (the second a spoiler) and a Photo guide, "Views of the isle", of six views, each a card with a photo (the fourth a spoiler) and a note. It also has a small made-up wiki, "Example Wiki" under CC BY-SA 4.0: six pages in a contents of two sections (one inside the other), with a table, a drawn picture of a waystone (`pictures/wiki-waystone.png`), hidden text and links between the pages, each with its credit, read in the Guides section, and its home page ("Main Page", the pack's `homePage`): a welcome, the picture of the waystone leading to its page, and the main areas under three headings. Its page "Isle portal" is laid out with every layout form. The same seed always produces the same pack.

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

In the desktop app, packs are served by a small protocol in the Rust shell that answers range requests, because the protocol Tauri uses for the bundled frontend does not. The desktop app also shows packs from a maps folder and from folders the person chooses, exports and imports progress through native file dialogs, exports a game with its map images to one map pack file (`.atlaspack`) and imports such files ([apps/desktop/README.md](apps/desktop/README.md#map-pack-files)), opens web links in the system browser, and shows the map images that are in a pack's folder. The public Atlas app is a viewer: it never fetches map images from other servers. Only a build made with `ATLAS_ENABLE_DOWNLOADS=1` can download a pack's map images from the tile server its layers name (`tiles.remote`), politely and resumably, into the pack's folder, one pack at a time across every Atlas app on the computer ([apps/desktop/README.md](apps/desktop/README.md#building-another-app-from-the-shell)). Every Atlas desktop app writes what it does to a shared activity log, which the app shows and can copy to send with a question ([apps/desktop/README.md](apps/desktop/README.md#activity-log)). A desktop build can include importers that add maps from web pages ("Add a map"); the plain build has none. An importer may also read sites no importer knows by name (a wiki on any host), only after every importer that knows an address; the person chooses how each such site is read (by the app, in a window of the app, or only as they browse it in that window, each article page they open kept once) and confirms its licence when its pages state none ([apps/desktop/README.md](apps/desktop/README.md#adding-maps-from-web-pages)). The desktop app finds the game's saves folder, lists and reads saves (read-only) and follows new ones, and reads the map files of the game folder the person chooses (read-only); the reading itself is the web app's ([apps/desktop/README.md](apps/desktop/README.md#game-saves)). The viewer updates itself on Windows and from an AppImage on Linux (see [Updates](#updates)). Not there yet: code signing for Windows and macOS.

The `Release` workflow (`.github/workflows/release.yml`, run by hand or by pushing a `v*` tag) builds the plain viewer's Windows installer and publishes it as a GitHub Release, the repository's latest, then adds the Linux AppImage (`Atlas.AppImage`) and `latest.json` for updates. It needs the repository secret `TAURI_SIGNING_PRIVATE_KEY` and stops at once without it.

The `Linux release` workflow (`.github/workflows/linux-release.yml`, run by hand with a trial number) builds the plain viewer for Linux as an AppImage on Ubuntu 22.04, checks it, starts it once (`.github/workflows/linux-appimage.yml`, which the `Release` workflow uses too), and attaches it to a draft prerelease `linux-trial-<number>` whose notes say how to install and try it on a Steam Deck. A trial never has `latest.json`, so no Atlas takes it as an update. See [apps/desktop/README.md](apps/desktop/README.md#atlas-on-linux-and-the-steam-deck).

### Updates

The plain viewer on Windows, and on Linux when it runs from `Atlas.AppImage`, updates itself from this repository's releases:

- **When Atlas starts**, a few seconds in, it looks quietly for a new version. It says nothing when there is none or when the computer is offline. **Settings**, then **Updates**, has the switch **Check for updates when Atlas starts** (on until the person turns it off), the version, and **Check for updates**, which says what it found.
- **A new version** shows a notice in a corner of the window that covers nothing: the version and what is new in it, with **Install now**, **Later** (until the next start) and **Skip this version**. **Install now** downloads it with its progress, saves what the person changed (as **Exit Atlas** does), and installs it. On Windows the installer closes Atlas, updates it and starts it again. On Linux the new version takes the AppImage's own file, under the same name, so a Steam launch line that names `Atlas.AppImage` keeps working, and Atlas starts again.
- **Where it comes from.** Atlas reads `latest.json` of the repository's latest release (`https://github.com/DrFlGd/Atlas/releases/latest/download/latest.json`), with `Atlas/<version>` as its User-Agent. Every file is signed with the project's update key, and Atlas installs only a file whose signature matches the public key built into it (`plugins.updater` in `apps/desktop/src-tauri/tauri.conf.json`). The updater runs in the Rust shell; the page never names an address.
- **Not at a start by Steam.** On Linux, Atlas does not look at a start with a game in Steam (the launch line's `--background`, or Steam's and Game Mode's own variables), so nothing new appears beside a game; **Check for updates** in Settings still works. The start option `--no-update-check` does the same on any desktop.
- **Copies that do not update themselves** say where their updates come from in Settings instead: Linux installed as a package (no AppImage), the app built with downloads (`ATLAS_ENABLE_DOWNLOADS=1`, which has releases of its own), and other systems. The Android app and the web build have no updater at all.

Releasing an update: the `Release` workflow signs the installer and the AppImage with the repository secret `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty for a key without one), attaches each with its `.sig` file, and writes `latest.json` with the version, the notes' "New in <version>" part, the date, and the address and signature of each file attached (`windows-x86_64`, `linux-x86_64`). When the AppImage fails, the Windows release still goes out and `latest.json` lists Windows only. See [apps/desktop/README.md](apps/desktop/README.md#updates).

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
sections.json         optional: the contents of the guides (sections of guides and sections)
pictures.json         optional: the pictures guides, locations and list entries show, in pictures/
pictures/             the picture files pictures.json names
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
- An `xyz` layer may name a remote source (`tiles.remote`: an `https` URL template and the remote zoom and tile offset of each pyramid level). The template has `{z}`, `{x}` and `{y}` in the order the source uses; a source that counts its rows from the bottom of the zoom's whole grid (often called TMS) has `{-y}` in place of `{y}`. Everything in the pack itself counts rows from the top. A desktop app built with downloads can download such tiles into the pack's folder, and every desktop app shows the ones that are there; see [apps/desktop/README.md](apps/desktop/README.md#downloading-map-images). The web app shows its usual "not installed" notice for them.
- A checklist (`checklists.json`) has an id, a name, an optional description, an `order`, an optional `kind`: `"checklist"` (the default) for things to do or collect, or `"guide"` for a guide that is a list of places, and an optional `type`, which says how the app shows it:

  | `type`       | What it is                                                                                | Views                              |
  | ------------ | ----------------------------------------------------------------------------------------- | ---------------------------------- |
  | `collection` | Find everything of a set.                                                                 | By area, By type                   |
  | `secrets`    | A collection whose notes are solutions, with hidden text and locations named in the text. | By area, By type                   |
  | `photos`     | A Photo guide: a collection with a photo per entry, shown as cards.                       | Cards (first), By area, By type    |
  | `route`      | Steps followed in order, with locations, and a next step.                                 | In order (first), By area, By type |
  | `build`      | Ordered steps of items, locations and bosses, each with a reason, and a next step.        | In order                           |
  | `plain`      | Things to do, shown as written: no choice of view, no next step.                          | In order                           |

  Without a `type`, a list of kind `"guide"` is a route, a list with no places is plain, and any other is a collection. A list with no places is shown in order whatever its type (a route or a build still with a next step). Apps that do not know `type` go by `kind`, which lists guides under a heading of their own, so packs keep writing it. Its items (`checklistItems.json`) have an id, the checklist, a name, an `order`, the locations they stand for (`locationIds`, often one, may be on several maps, may be none) and related entities, and two optional fields: `section`, the heading the item is listed under (items in order that share a section are shown together), and `note`, a short Markdown note shown under the item. An item with no location that can be marked found has a tick of its own (see "Ticking items" above).

- A guide (`guides.json`) has an id, a title, a Markdown `body`, the locations it is about and an optional `order`, its place among the listed guides (guides without one follow, by title). A guide tied to exactly one location, by its own `locationIds` or by that location's `guideId`, is that location's note and shows in the details pane and in checklist rows. Any other guide (a walkthrough, a chapter, or a guide shared by many places) is listed on the checklists screen.
- A guide may name where its text was read (`source`): the page's `url`, the `site`'s name, its `license` (`name` and the `url` of its text), the `credit` line the site asks for, when it was read (`readAt`) and whether the text was changed from the original (`adapted`, for example converted to Markdown), and whether the person confirmed the licence because the page states none (`licenseConfirmed`). The app shows it as the credit under the page. Atlas 0.4.4 and earlier refuse a pack whose guides have it. When the page states no licence, `licenseBasis` may say where the licence came from instead: `permission` for words the person filled in, such as permission from the site's owner (the words are `license.name`, the address of its terms `license.url`, and `licenseGivenBy`, `licenseGivenOn` and `licenseNote` are optional), or `none` when nothing was recorded (`license.name` is then "No licence recorded. Kept for personal use."); `stated` and `confirmed` are the other values. A game with such a page says `personalUse: true` in its manifest, which the app works out from its guides whenever it describes the pack; the Library shows it as "For personal use", and its export says the file is for the person's own devices. Apps before these fields drop them when reading and show `license.name` as the licence.
- The contents (`sections.json`) is a list of sections, each with an id (`<gameId>:section:…`), a title and its `items`: ids of guides and of other sections, in the order the source lists them. A section that no other section lists is at the top of the contents; a section is listed by one section at most and never inside itself, and a guide may be listed by several. With a contents, the guides it lists are read in the Guides section (see "Guides" above).
- A section may say `"placeByLinks": true` (optional): the pages it lists are pages the source's menu does not name, outside the menu. Atlas never shows the section in the bar beside the page, and files none of its pages under another page by itself, by links, lists, `filedUnder` or headings: each is in **All pages** (every page of the source from A to Z), and the way above it names the pages its source files it under, when it says (see `filedUnder` below). The person may move any of them into the menu, or put one under a page, by hand (own pages, `contents`); the arrange tool shows the rest as one group, "Not in the menu". A page of the section the pack also places in its menu is shown there. Atlas 0.6.2 and earlier ignore the field and list the section's pages as they are; versions after it and before this one showed each page under a page that lists it, worked out from the pages' links, and the headings of such a page as levels. A person's say on which pages file the pages they list (own pages, `listPages`), which those versions kept, is read and kept, and changes nothing.
- A guide id in `idMigrations` is another name of a page: the address a site forwarded to the page, say. A link to that name opens the page, and counts as a link to it in the tree.
- `idSections` in the manifest (optional) names, for another name of a page in `idMigrations`, the section of the page it leads to, as a site forwards a name to a part of a page: `"idSections": { "demo:guide:wiki-ferry": "by-boat" }`. A link to that name opens the page at that heading, unless the link names a section of its own. A name `idMigrations` does not have is never reached, and a value that cannot be read is left out. Atlas 0.9.0 and earlier open such a pack and ignore the field (the page opens at its top); an importer writes it only when the app says it keeps it (`keepsIdSections` of the import context), since those apps refuse it in what an importer gives them.
- `homePage` in the manifest (optional) names the guide that is the home page of the site the pages were read from: `"homePage": "demo:guide:wiki-main-page"`. Atlas opens Guides on it, shows it in no section (a section that lists it does not show it there), and never names it under "Linked from" or among the pages to link to the map; the pages it lists stay where the menu has them. A guide id the pack does not have, or one renamed through `idMigrations`, is followed to its current id or left out. Atlas 0.9.0 and earlier open such a pack and ignore the field (the home page is a page like the others); an importer writes it only when the app says it keeps it (`keepsHomePage` of the import context), and may list a site's home page in its contents as `"kind": "home-page"`, which the app ticks at first.
- `pageWidth` in the manifest (optional) is the width the pack's guide pages are shown at on a computer or a tablet when the person has not chosen one: `reading` (a column of at most 760 pixels, the default), `wide` (about 1,000 pixels) or `full` (the width of the window): `"pageWidth": "wide"`. It names a width, never pixels. An importer writes the one the site's rules file gives (`layout.pageWidth`), and only when the app says it keeps it (`keepsPageWidth` of the import context), since Atlas 0.15.0 and earlier refuse it in what an importer gives them; they open a pack that has it and ignore the field. A value that cannot be read is left out. A map pack file carries it with the pack, so another computer shows the pages at the importer's width; with **Include my lists, locations, types and photos**, the person's own choice goes with their own pages too.
- `mapLinks` in the manifest (optional) says which web links of the pack's pages name a location of a map by the id its site gives it: `"mapLinks": [{ "hosts": ["maps.example.org"], "address": "/isle/*", "query": "spot" }]`, 1 to 20 entries. Each names the hosts of such links (lower case, without `www.`, which counts too), the path of such a link as an address pattern (`*` any run of characters without `/`, `**` any run with them), and where the id is: `{id}` for one part of that path, between two `/` (`"/isle/spot/{id}"`), or `query`, the parameter after `?` whose value it is. The pages keep such links as web links. When a page is shown, a link that fits an entry is looked up among the locations of the game, then of the other games shown under one title with it (see "Games shown under one title"): a location's site id is the last part of its id, after its last `:`, as an importer that reads a map writes it when the site gives one (`demo:loc:0412` has the site id `0412`), and a location a person made is never found. A link that finds its location is shown and followed as the app's own links to a location are; on a map of another game of the title, that game opens on the map, at the location. A link that finds none stays a web link and opens outside the app. A site rules file gives the entries (`mapLinks` of a wiki or guide part, see "Links to a location of a map" in `packages/importer-api/site-rules/atlas-site-rules.md`), and an importer writes them only when the app says it keeps them (`keepsMapLinks` of the import context), since Atlas 0.17.0 and earlier refuse them in what an importer gives them; they open a pack that has them and show the links as web links. An entry that cannot be read is left out.
- A guide may name the guides its source itself files it under (`filedUnder`, optional): guide ids, the most fitting first, at most 20, such as a wiki's categories that are pages of the wiki and the title of a navigation box at the foot of the page: `"filedUnder": ["demo:guide:wiki-weapons"]`. A guide the pack does not have (a page not read yet) is no error and is left out. It is read for the way above a page outside the menu only: the first of them that is a page of the source (through other names of pages, `idMigrations`), then that page's, and so on up, outermost first, at most six, never a page twice, stopping at the home page. The bar never shows a page under another by it. Atlas 0.5.0 to 0.10.3 open such a pack and ignore the field (they show the tree by links alone); Atlas 0.4.4 and earlier refuse it; an importer writes it only when the app says it keeps it (`keepsFiledUnder` of the import context).
- The pictures (`pictures.json`) each have an id (`<gameId>:picture:…`), a `file` directly in the pack's `pictures/` folder (`png`, `jpg`, `jpeg`, `webp` or `gif`; no two files differ only in case), an optional `caption`, `credit`, `license`, `source` (the page it was taken from), `width` and `height`, and `shareable`: `false` for a picture kept for the person's own use, which a map pack file leaves out (see [apps/desktop/README.md](apps/desktop/README.md#the-format)). A picture may also have `remote`, the `https` address its file can be downloaded from later; its file need not be in the pack then. A picture kept at full size may also have `shownAt`, the `https` address the page showed a smaller copy of it at, when that differs from `remote` (so a picture is known by either address), and `pageCopy`, a smaller copy of its file for pages: `{ "file": "pictures/….<ext>", "width", "height" }`, `file` in `pictures/` as a picture's is and no other picture's file, `width` (and `height`, optional) the size the page shows it at. Pages then show the copy and the larger view the file; where the copy is not there, pages show the file. The desktop app makes the copy when it downloads the file. A photo of a location or a list entry with a `remote` address and neither `shownAt` nor `pageCopy` may have a copy for cards beside its file, `pictures/<name>.page.<type>`, which the desktop app makes when it keeps the photo wider than 1,280 pixels; cards show that copy where it is there, else the file, and the larger view the file. Atlas 0.11.0 and earlier read such a list and leave both fields out, and an importer writes them only when the app says it keeps them (`pictureSize` of the import context, see [apps/desktop/README.md](apps/desktop/README.md#adding-maps-from-web-pages)). Only a desktop app built with downloads fetches it, and only when the person asks ("Download location photos", see [apps/desktop/README.md](apps/desktop/README.md#downloading-location-photos)); every other app shows "Photo not downloaded" in its place. Nothing but a guide's `![…](<gameId>:picture:…)`, the photos of locations and list entries and the pictures of types ever loads a picture, and always from the pack's own folder (or the person's own pictures), never from a web address.
- A type (`categories.json`) may name a picture beside its `icon` (`picture`, optional): the id of a picture in `pictures.json`, the type's own icon as the map the pack was read from draws it. Such a picture is kept for the person's own use (`shareable: false`), with the `remote` address it is downloaded from. Where its file is one of several icons on one picture (a sheet of icons), the picture has `cut`, the part of the downloaded file it is: `{ "x", "y", "width", "height" }`, whole pixels from the top left, at most 16,384 each; the desktop app cuts that part when it downloads the file, and asks for a sheet once for all the icons on it. Where the person uses the map's icons (a choice of each game, in the Library and when the game is added, on unless they turn it off), the map, the filters, the lists and the cards draw the type with its picture, and with its `icon` wherever the picture's file is not there; with the choice off, every type is drawn with its `icon`. Older apps skip both fields and draw the `icon`. A type that names a picture the pack does not list is read without it. An importer writes them only when the app says it keeps them (`keepsTypePictures` of the import context), and only where the site's rules file says where the icons are (`types.picture`). A map pack file leaves them out (the types then name no picture) unless the person ticks "Include this map's icons" when writing it; such a file is version 9.
- Photos: a location (`locations.json`) and a list entry (`checklistItems.json`) may have `photos`, at most 20, first shown first. Each photo is `{ "picture": "<gameId>:picture:…", "spoiler": true }`: the picture's id, and optionally `spoiler`, which keeps it blurred until the reader taps or clicks it. A tap on a photo shown opens it large. The location card shows the location's photos first; a list entry shows its own photos under it and its location's photos in its "more"; a Photo guide (`type: "photos"`) shows each entry as a card, its photo first, grouped by area and by map when the list spans more than one. `photos` is optional, so it did not change the `schemaVersion`; Atlas 0.4.4 and earlier refuse a pack that has it. When reading, a photo that cannot be read is left out, not the pack.
- A game with no map holds guides and lists only: it may leave out `maps.json`, `layers.json`, `categoryGroups.json`, `categories.json` and `locations.json`, but only all of them together, and they then load as empty. Atlas 0.4.4 and earlier refuse such a pack, so the tools keep writing those files, empty. `sections.json` and `pictures.json` are optional, and an empty one reads as none.
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

| Field                             | Version        | Meaning                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                   | 1, 2           | The manifest format: `1` or `2`. Anything else is refused with a plain message.                                                                                                                                                                                         |
| `gameId`                          | 1, 2           | The pack id, also the prefix of every content id.                                                                                                                                                                                                                       |
| `title`                           | 1, 2           | The game's name as shown in the game switcher.                                                                                                                                                                                                                          |
| `packVersion`                     | 1, 2           | The pack's own version, `major.minor.patch`; a location's `since` names one.                                                                                                                                                                                            |
| `gamePatch`                       | 1, 2           | The game version the content matches.                                                                                                                                                                                                                                   |
| `attribution`                     | 1, 2           | Who made the content, with optional URL and licence.                                                                                                                                                                                                                    |
| `idMigrations`                    | 1, 2           | Old content id to new id, so stored progress follows renamed locations.                                                                                                                                                                                                 |
| `idSections`                      | 1, 2, optional | For another name of a page in `idMigrations`, the section of the page it leads to (see "Data packs" above).                                                                                                                                                             |
| `homePage`                        | 1, 2, optional | The guide that is the site's home page, the landing page of Guides (see "Data packs" above).                                                                                                                                                                            |
| `pageWidth`                       | 1, 2, optional | The width the guide pages are shown at by default: `reading`, `wide` or `full` (see "Data packs" above).                                                                                                                                                                |
| `mapLinks`                        | 1, 2, optional | Which web links of the guide pages name a location of a map by its site's id, and where the id is in them (see "Data packs" above).                                                                                                                                     |
| `created`                         | 2              | When the pack was first written (ISO 8601). Kept when the pack is written again.                                                                                                                                                                                        |
| `updated`                         | 2              | When the pack's content last changed.                                                                                                                                                                                                                                   |
| `writtenBy`                       | 2              | The tool or app, and its version, that wrote the pack's files.                                                                                                                                                                                                          |
| `source`                          | 2, optional    | For packs made by an importer: the importer's id and title, and each page the pack was made from, with the map it became and when. Absent for packs built by hand or by a pipeline.                                                                                     |
| `source.site`                     | 2, optional    | The name of the site the pages were read from, as the importer shows it (for a site a rules file describes, the file's `name`), when the importer gives it (`site` of its import result); kept when a later page gives none. Apps before it drop it when reading.       |
| `contents.counts`                 | 2              | Maps, layers, locations, categories, regions and guides in the pack.                                                                                                                                                                                                    |
| `contents.maps[]`                 | 2              | Each map's id, name, size in pixels and number of locations, and its layers: id, name, zoom range, tile kind (`pmtiles` or `xyz`) and whether its images can be downloaded.                                                                                             |
| `contents.maps[].layers[].images` | 2, optional    | For downloadable layers, what the desktop app has downloaded into the pack folder: the complete `levels`, whether every level is there (`complete`), the number of image `files` and their `bytes`, and when this was recorded. Updated after each level of a download. |

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
