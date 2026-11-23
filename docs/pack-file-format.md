# The Atlas pack file format

A pack file (`.atlaspack`) holds a map, a wiki, a guide or a guidebook for a game in one file, or the issues of a magazine: the pack folder of one game, its map images up to a chosen level of detail, and the pictures its pages show. Atlas writes one with **Export** and reads one where it lies, or takes it in with **Import map pack file** (the desktop app without downloads copies it into its packs folder with **Add a pack file** instead and reads it there). Another app can show a card for a pack file and pass it on without unpacking it. This page says what is in the file and how to read it safely.

Every name in the examples is made up.

## The container

A pack file is a ZIP archive. It uses ZIP64 records when its size, its offsets or its number of entries need them. Entries are either stored as they are or deflated. No other method and no encryption is used.

The entries come in this order:

1. `atlaspack.json`, the description. It is always the first entry, so it can be read without the rest of the file.
2. From version 7, the small pictures of the maps, `preview/<name>.jpg`, right after the description and before everything else. They are stored, not deflated.
3. The pack's JSON files, such as `manifest.json`, `maps.json`, `layers.json`, `locations.json`, `guides.json`, `sections.json`, `pictures.json` and, from version 9, `routes.json`. They are deflated. A `routes.json` that holds no route is left out.
4. The status file of each layer whose images can be downloaded, `offline-tiles/<layer>.json`.
5. The map images, at the paths each layer's own `url` gives, with an empty `.404` marker for an image the map server did not have. They are stored.
6. From version 11, the model files of the pack's 3D maps, `scene/…/<name>.glb`: the levels of detail the file's `detail` picks, and each map's `neighbours` model (see "3D maps"). They are stored.
7. The pictures the pages show, in `pictures/`, that may be passed on, and those kept for the person's own use that they asked for: their downloaded photos, and from version 9 the map's icons (the pictures the pack's types name, see "The map's icons").
8. Only when the person asked for it: their own lists, locations, pages, notes, routes (from version 9, `mine/my-routes.json`) and photos, and the title the game is shown under with other games, under `mine/`.

A pack of guidebooks (version 8, see "Guidebooks") holds, after the description, `manifest.json` and `guidebooks.json` (deflated), then each guidebook's text file and its file (both stored). It holds nothing else.

A pack of magazines (version 10, see "Magazines") holds, after the description, `manifest.json` and `magazines.json` (deflated), then the cover of each issue that has one, then each issue's text file and its file (all stored). It holds nothing else.

Every entry has the time the file was made, in UTC.

## The description

`atlaspack.json` is JSON in UTF-8. Every date is ISO 8601 in UTC. A field marked optional may be missing, and a file made before the field existed never has it. Every other field is in every pack file, whatever its version, and a reader refuses a description without one as damaged. A reader must ignore fields it does not know.

| Field            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`         | Always `atlas-pack-file`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `version`        | The version of the format (see "Versions").                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packId`         | The pack's id, such as `test-valley`: 1 to 64 lower case letters, digits, `-` and `_`, starting with a letter or a digit. A pack is known by it, so a description with another id, or none, is refused.                                                                                                                                                                                                                                        |
| `title`          | The pack's own title.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `game`           | Optional. `title`: the title the game is shown under with other games when the person grouped it with others, whether or not the file carries that group (`mine/game-group.json` goes in only when they chose to include their own things); otherwise the pack's own title. So two packs of one game, read from two sites and grouped, give the same `title`. `system`: optional, the system the game is for, as the pack's manifest names it. |
| `packVersion`    | The pack's version.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `detail`         | `overview`, `standard` or `full`: how much of each map's images the file holds.                                                                                                                                                                                                                                                                                                                                                                |
| `exportedAt`     | When the file was made.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exportedBy`     | The app that made it: `name`, `version` and `platform`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `pack`           | What the pack's manifest says of itself: `id`, `title`, `packVersion`, `gamePatch`, `schemaVersion`, `attribution`, and optionally `created`, `updated` and `writtenBy`.                                                                                                                                                                                                                                                                       |
| `personalUse`    | Optional, only ever `true`: the pack's manifest says it is kept for the person's own use. A file with it is not to be passed on to others.                                                                                                                                                                                                                                                                                                     |
| `source`         | Where the data came from. `kind` is `web-pages`, `app` or `unknown`. Optional: `name`, the name of the site the pages were read from (see below); `origin`, where the pack came from in one word (see below); `importer` (`id` and `title`); `pages`, each page read with `url`, `mapId` and `importedAt`; `newestPageAt` and `oldestPageAt`.                                                                                                  |
| `contents`       | Counts: `maps`, `layers`, `locations`, `categories`, `regions`, `checklists` and `guides`, and optionally `typePictures` (from version 9), the types drawn with a picture of their own that the file carries; absent when there are none.                                                                                                                                                                                                      |
| `maps`           | Optional. One entry per map, in the order of the pack's `maps.json`: `id`, `name`, `width` and `height` of its most detailed image in pixels, `locations` (how many the pack has on it), and `preview`, the entry name of its small picture when the file holds one. From version 11, `scene`: `true` for a map whose 3D model is in the file (absent otherwise).                                                                              |
| `guides`         | Optional. The pack's pages, with `title`, `type` and `pages`. `type` is `guide` for pages read in order (the manifest's `pagesInOrder`) and `wiki` for pages read as a collection. A pack's pages are one source of pages, so there is one entry at most. A game of maps whose pages are only the notes of its locations has none.                                                                                                             |
| `cover`          | Optional. The entry name of the small picture to show for the file: that of the first map that has one.                                                                                                                                                                                                                                                                                                                                        |
| `images`         | The map images in the file: `detail`, `files`, `bytes`, and per layer what it holds (`levels`, `files`, `bytes`, `complete`, `full`, `downloadable`, `downloadedAt`).                                                                                                                                                                                                                                                                          |
| `files`, `bytes` | The entries after the description, and their size unpacked.                                                                                                                                                                                                                                                                                                                                                                                    |
| `mine`           | Optional. How many of the person's own things the file carries.                                                                                                                                                                                                                                                                                                                                                                                |
| `guidebooks`     | From version 8, and only in a pack of guidebooks. Each guidebook the file holds, in order: `file`, `title`, `pages`, `bytes` and optionally `text` (see "Guidebooks").                                                                                                                                                                                                                                                                         |

An example, for a made-up game:

```json
{
  "format": "atlas-pack-file",
  "version": 7,
  "packId": "test-valley",
  "title": "Test Valley",
  "game": { "title": "Test Valley", "system": "Saltbox 64" },
  "packVersion": "1.2.0",
  "detail": "overview",
  "exportedAt": "2026-11-19T09:30:00Z",
  "exportedBy": { "name": "Atlas", "version": "0.22.0", "platform": "windows" },
  "pack": {
    "id": "test-valley",
    "title": "Test Valley",
    "packVersion": "1.2.0",
    "gamePatch": "demo",
    "schemaVersion": 2,
    "attribution": [{ "name": "Example Wiki" }]
  },
  "source": {
    "kind": "web-pages",
    "name": "Example Wiki",
    "importer": { "id": "demo-maps", "title": "Demo map site" },
    "pages": [
      {
        "url": "https://maps.example.com/test-valley/east-field",
        "mapId": "test-valley:map:east",
        "importedAt": "2026-11-10T21:30:00.000Z"
      }
    ],
    "newestPageAt": "2026-11-10T21:30:00.000Z",
    "oldestPageAt": "2026-11-10T21:30:00.000Z"
  },
  "contents": {
    "maps": 2,
    "layers": 2,
    "locations": 3,
    "categories": 1,
    "regions": 0,
    "checklists": 0,
    "guides": 24
  },
  "maps": [
    {
      "id": "test-valley:map:east",
      "name": "East Field",
      "width": 2048,
      "height": 2048,
      "locations": 2,
      "preview": "preview/east.jpg"
    },
    {
      "id": "test-valley:map:west",
      "name": "West Ridge",
      "width": 1024,
      "height": 512,
      "locations": 1
    }
  ],
  "guides": [{ "title": "Test Valley", "type": "wiki", "pages": 24 }],
  "cover": "preview/east.jpg",
  "images": { "detail": "overview", "files": 7, "bytes": 81920, "layers": [] },
  "files": 40,
  "bytes": 245760
}
```

### The site's name

`source.name` is the first of these that the pack has:

1. The name its manifest records for the site (`source.site`), which the importer that read the pages gives: the site's name as it shows it to the person, such as the `name` of a site rules file.
2. The site its guide pages name most (each page's `source.site`), the first of those named as often.
3. For a pack read from web pages (`kind` `web-pages`), the host of the first page it records (`source.pages`), without a leading `www.`, such as `maps.example.org`.

It is absent when the pack has none of these. The importer's `title` is never taken for it: one importer can read many sites.

### Where the pack came from

`source.origin` says in one word where a pack came from, so another app can show it without working it out:

| Value           | The pack                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| `site`          | was read from web pages (`source.kind` `web-pages`).                         |
| `made-in-atlas` | was made in Atlas (its manifest says `madeInApp`).                           |
| `map-maker`     | was made with Atlas Map Maker (the pack's `writtenBy` is `Atlas Map Maker`). |
| `guidebooks`    | is a pack of guidebooks (see "Guidebooks").                                  |
| `magazines`     | is a pack of the issues of a magazine (see "Magazines", version 10).         |

Atlas writes it into every pack file it exports when it knows, and into every pack of guidebooks. It is optional: a reader must take a value it does not know as unknown, not refuse the file. A file without it is read with the same rules in the same order: a pack of guidebooks is `guidebooks`, a pack of magazines is `magazines`, one with `source.kind` `web-pages` is `site`, one whose `pack.writtenBy.name` is `Atlas Map Maker` is `map-maker`, and one whose `exportedBy.name` is `Atlas` or starts with `Atlas ` is `made-in-atlas`. Otherwise nothing is known. `Header::origin()` in the crate reads it so.

The field needs no new version. Atlas 0.23.0 and 0.24.0 were checked: their reader of the description has no rule against fields it does not know (no `deny_unknown_fields`, in `source` either), and a version 7 description with `source.origin` reads as before, so they open such a file.

## Small pictures

From version 7, the file holds a small picture of each map that has images in the file. Each is a JPEG whose longest side is at most 512 pixels, at most 512 KB. Atlas draws it from the map's own images in the file: the first layer of the map, at the lowest level of detail that is at least 512 pixels on its longest side. A map made from one picture counts too, since Atlas cuts it into the same levels.

Its entry name is `preview/<name>.jpg`. The name is made from the map's id, in lower case letters, digits, `-` and `_`, starting with a letter or a digit, at most 80 characters. So no two names differ only by case. The map's `preview` field in the description gives the name, and `cover` names the one to show for the whole file.

A map with no image in the file has no small picture. Neither has a map whose images could not be read. Making a small picture never stops an export: Atlas leaves it out instead. Atlas for Android makes no pack files, so it makes no small pictures either. The file holds at most 1,024 small pictures, 64 MB together.

When Atlas imports a file, it checks each small picture and then leaves it out. It is not written into the pack folder and is kept nowhere, since the map's own images show the map. The description, kept with the pack as `.atlas/pack-file.json`, still names it.

## The map's icons

A pack read from a map site may draw its types with the site's own icons: a type in `categories.json` then names a picture (`picture`, beside its `icon`), and that picture is kept for the person's own use (`shareable: false`). A picture cut from a sheet of icons has `cut`, the part of the downloaded file it is. A file leaves these icons out unless the person ticked "Include this map's icons" when writing it: neither their pictures nor their entries in `pictures.json` are in the file, and its types name no picture, so the file stays at the version of what else it carries. With them, the file is version 9 and `contents.typePictures` counts the types that name a picture. A reader that does not know `picture` draws each type's `icon`, which every type still has.

## Versions

A file is written at the lowest version that can hold what it carries. So an older app reads every file it can, and refuses a newer one with a message that names the app and version that made it.

| Version | What it adds                                                                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | The pack and its map images.                                                                                                                                                                                                                                                     |
| 2       | The person's own lists, locations and types (`mine/`).                                                                                                                                                                                                                           |
| 3       | Their own photos and the links between guide pages and the map.                                                                                                                                                                                                                  |
| 4       | Their own guide pages.                                                                                                                                                                                                                                                           |
| 5       | Their notes on the game's locations, and a guide page linked to one location alone.                                                                                                                                                                                              |
| 6       | The title the game is shown under with other games.                                                                                                                                                                                                                              |
| 7       | Small pictures of the maps (`preview/`).                                                                                                                                                                                                                                         |
| 8       | Guidebooks (`guidebooks/`, `guidebooks.json` and the `guidebooks` field).                                                                                                                                                                                                        |
| 9       | Routes: the pack's `routes.json` holding a route, or the person's own routes (`mine/my-routes.json`, counted as `routes` in `mine`). The map's icons: types that name a picture (`picture` in `categories.json`), with those pictures (counted as `typePictures` in `contents`). |
| 10      | Magazines: the issues of one magazine (`magazines/`, `magazines.json`, and the `magazine` and `issues` fields).                                                                                                                                                                  |
| 11      | 3D maps: a map with a model (`scene` in `maps.json`, its files under `scene/`, and `scene` in the description's `maps`); heights of locations and floors (see "3D maps").                                                                                                        |

The fields `game`, `personalUse`, `maps`, `guides`, `cover`, `source.name` and `source.origin` are optional and need no new version: a file without small pictures stays at the version of what else it carries. An older reader ignores them. Only a pack of guidebooks is version 8, only a file that carries routes or the map's icons is version 9, only a pack of magazines is version 10, and only a file that carries a 3D map's model is version 11; every other file stays at the version of what it carries, so the apps that read version 7 read it. A pack whose `routes.json` is empty is written without it, at the version of what else it carries.

## 3D maps

A map of a pack may have a 3D model. It stays an ordinary map: its images, layers, locations, areas, lists and routes are those of any map, and an app that knows nothing of 3D shows it in 2D as before. Three optional fields of the pack's JSON files make it 3D. They are written strictly (no field that is not listed, every value in its bounds) and read tolerantly: a reader leaves out what it cannot read and keeps the rest, so a scene it cannot read leaves the map in 2D.

**`height` on a location** (`locations.json`): a number, the location's height in the game's world, in the units of its map's `worldTransform`. With its `x` and `y` it gives the location's place in 3D. A location without a height is put on whatever the model has below it (in a floor, below the floor's top).

**`heights` on a layer** (`layers.json`): `[min, max]`, two numbers, min not above max: the heights of the world the layer shows. A layer with `heights` is a floor. A map whose layers have fewer than two floors has none; its floors are shown lowest first (by `min`, then `max`, then their order in `layers.json`). Choosing a floor in the 3D view shows its locations and cuts the model away above its `max`. Floors are optional: a 3D map without them is shown whole, with a free height cut. A location's height never depends on its layer.

**`scene` on a map** (`maps.json`): the model. A map with a `scene` must have a `worldTransform`.

| Field        | What it holds                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `axes`       | Optional. Three of `+x`, `-x`, `+y`, `-y`, `+z`, `-z`, naming each of the model's axes once: the axis that gives world x, world y and height, with its direction. `["+x", "-z", "+y"]` when absent. |
| `scale`      | Optional. World units per model unit, above 0; 1 when absent.                                                                                                                                       |
| `offset`     | Optional. `[x, y, height]` in world units, added after scaling; `[0, 0, 0]` when absent.                                                                                                            |
| `heights`    | Optional. `[min, max]`, the heights the model spans, for the free height cut.                                                                                                                       |
| `cells`      | 1 to 4,096 cells (below).                                                                                                                                                                           |
| `water`      | Optional. The height of open water, drawn as a level plane over the whole map.                                                                                                                      |
| `sky`        | Optional. The sky's colour, `#rrggbb`.                                                                                                                                                              |
| `camera`     | Optional. Where the 3D view starts: `target`, `[x, y, height]` in world units, the point looked at; `distance` from the camera to it, above 0; `yaw` and `pitch` in degrees (below).                |
| `neighbours` | Optional. A model file of what lies around the cells (distant hills, a coast), drawn whole and never cut into cells. Every file of a pack has it, whatever its detail.                              |

A cell is a square part of the model:

| Field     | What it holds                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | 1 to 64 of `a`–`z`, `0`–`9`, `_` and `-`, starting with a letter or digit; unique on its map.                                                                                                                               |
| `bounds`  | `[minX, minY, maxX, maxY]` in world units, min below max, a square (its sides equal within one millionth of a side).                                                                                                        |
| `heights` | Optional. `[min, max]`, the heights the cell holds, so an app can tell how far it is from the camera before loading it.                                                                                                     |
| `lods`    | 1 to 8 levels of detail, finest first: `level` (0 to 7, 0 the finest, each level higher than the one before), `file` (a model file) and optionally `triangles`, how many the file has, never more than the level before it. |

A model file's name is `scene/` and up to five folders and a name, each of `a`–`z`, `0`–`9`, `_`, `.` and `-`, starting with a letter or digit, at most 64 characters, the last ending in `.glb`. Lower case only, so no two names differ only by case on any system. A file is named once in the whole pack, by one level of one cell or as one map's `neighbours`. A model file is glTF 2.0 binary (`.glb`), at most 256 MB, with everything in it (no other file named by a `uri`). It may use `EXT_meshopt_compression` for its meshes and `KHR_texture_basisu` (KTX2) for its textures; Atlas carries the decoders of both, so it fetches nothing from elsewhere. Materials are drawn simply, with their base colour, texture and vertex colours, lit by the sky, the sun and a light at the camera, without shadows.

**Coordinates.** For a point (X, Y, Z) of a model file, after every node transform of the file,

    world x = scale × pick(axes[0]) + offset[0]
    world y = scale × pick(axes[1]) + offset[1]
    height  = scale × pick(axes[2]) + offset[2]

where `pick("+x")` is X, `pick("-z")` is −Z, and so on. The default is glTF's own: Y up, and world y pointing away from the model's +Z, as most exporters write a Z-up world into glTF. A map pixel (px, py) is at world (x, y) through its map's `worldTransform`, so a point of the model is drawn above the map pixel its world x and y lead back to, and the 3D view seen straight from above is the 2D map, north where the map image has it. The camera's `yaw` is where it looks, in degrees clockwise from the map image's up (−360 to 360); its `pitch` how far it looks down, from 0 (level) to 90 (straight down).

**Which levels a file holds.** A pack file's `detail` picks the levels of each cell that go in, and a cell keeps at least one:

| `detail`   | The levels of each cell                                    |
| ---------- | ---------------------------------------------------------- |
| `overview` | The coarsest alone.                                        |
| `standard` | Every level but 0; level 0 when it is the cell's only one. |
| `full`     | Every level.                                               |

The file's `maps.json` names only the levels it holds. A level whose file is missing from the pack folder is left out, a cell left with no level is left out, and a scene left with no cell is left out, so the map is shown in 2D. Only a file that then still has a scene is version 11, and its description marks each such map `scene: true`.

**Checks.** Besides the schema: a layer's `heights` and a cell's `heights` are ordered; a map with a `scene` has a `worldTransform`; cells have unique ids and square bounds; each cell's levels are finest first, each level once, and their `triangles` never grow; every model file is named once in the pack. The pipeline's `validate-pack` also checks that each model file is there and starts as a glTF binary file does (`glTF`, version 2, the length it says). A reader of a pack file takes a `scene/` entry only from version 11, only when `maps.json` names it, and only up to 256 MB. A model is as untrusted as any entry: a level the 3D view cannot read is left out of the view, and the cells around it are still shown.

**How Atlas shows it.** Atlas shows a map with a model in 3D in the standard layout, with "2D" one press away (the choice is kept on the device), where the device has WebGL 2; otherwise in 2D, with a note that says why. It loads the cells near the camera finely and those far coarsely, within a budget of triangles and texture memory set by the kind of device (for now about 4 million triangles and 600 MB of textures on a phone, a handheld such as a Steam Deck and a computer alike), loads coarser levels when frames come slowly or the textures pass the budget, and finer ones again once they recover.

## Guidebooks

A guidebook is a published guide the person has as one file, a PDF or a CBZ (a ZIP of pictures of pages, one per page). One game's guidebooks are in a pack file of their own, a pack of guidebooks, so a large pack of maps is never written again to add one. Atlas reads it where it lies (or, in the Android app, imports it as any pack file) and shows its guidebooks with the game whose title is the pack's game title (compared without regard to case, space and punctuation), or with the game the person put under one title with it. A pack of guidebooks of a game that is not there is an entry of its own.

Its entries:

- `manifest.json`: a manifest as a pack folder has one, with the pack's id as `gameId`, the game's title as `title`, and `writtenBy`, the app that wrote it. It has no maps, so it reads as a game of guides with no map.
- `guidebooks.json`: the list, `{ "format": "atlas-guidebooks", "version": 1, "game": { "title": … }, "guidebooks": [ … ] }`, each entry as in the description.
- For each guidebook, its file `guidebooks/<name>.pdf` or `guidebooks/<name>.cbz`, stored as it is. `<name>` is 1 to 80 lower case letters, digits, `-` and `_`, starting with a letter or a digit, made from the title.
- When the text of its pages is known, `guidebooks/<name>.text.json`, stored:

```json
{
  "format": "atlas-guidebook-text",
  "version": 1,
  "pages": [
    { "page": 1, "text": "Hollow Marsh Field Guide" },
    { "page": 3, "text": "The heron nests in the reeds by the old mill." }
  ]
}
```

Each page is listed once, in increasing order, from 1 to the guidebook's `pages`; a page with no text is left out. Atlas searches this text and never reads text out of pictures.

Each guidebook in the description and in `guidebooks.json`:

| Field   | What it holds                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------- |
| `file`  | Its entry name, `guidebooks/<name>.pdf` or `.cbz`. The extension says which it is.                    |
| `title` | Its title as it is shown, 1 to 200 characters.                                                        |
| `pages` | How many pages it has, 1 to 100,000: a PDF's page tree, or a CBZ's pictures.                          |
| `bytes` | The size of its file. Its entry must be stored and of this size.                                      |
| `text`  | Optional. The entry name of the text of its pages, `guidebooks/<name>.text.json`, with the same name. |

An example of the description's part, for a made-up game:

```json
{
  "format": "atlas-pack-file",
  "version": 8,
  "packId": "guidebooks-hollow-marsh",
  "title": "Hollow Marsh",
  "game": { "title": "Hollow Marsh" },
  "source": { "kind": "unknown", "origin": "guidebooks" },
  "guidebooks": [
    {
      "file": "guidebooks/hollow-marsh-field-guide.pdf",
      "title": "Hollow Marsh Field Guide",
      "pages": 212,
      "bytes": 148000000,
      "text": "guidebooks/hollow-marsh-field-guide.text.json"
    }
  ]
}
```

The checks a reader makes, besides those below: at most 100 guidebooks; each `file` a name as above, listed once; `pages` and `bytes` within their bounds (a file at most 16 GB, its text at most 64 MB); the file and its text stored, not deflated, the file of exactly `bytes`; a `text` that names the guidebook's own text file. A file over 4 GB is written with ZIP64 records. A PDF or CBZ is untrusted as any file is: Atlas reads it in parts, never whole, with bounds on what it reads, and a damaged one shows a sentence. Atlas runs no script a PDF holds, and opens a link to a web page only in the system browser.

A pack of guidebooks is not exported: to pass guidebooks on, copy the pack file they came in.

## Magazines

A magazine's issues come from another app that keeps them, in a pack file of their own per magazine title, a pack of magazines (version 10). Atlas only reads it: where it lies in the packs folder, or, in the Android app, imported as any pack file. It never changes one, never exports one, never reads a CBR file (an issue arrives as a CBZ) and never reads text out of pictures. A pack of magazines is of no game: it is not listed with the games, but on the shelf of magazines, and each issue is listed with the games it covers.

An app that reads version 9 at most (Atlas 0.26 and 0.27; 0.25 reads version 8) refuses a pack of magazines as a file in a newer format, with the sentence that names the app that made it, and lists it with that reason in the Library. It is not read in part.

The pack's id is `magazines-` and a name of the magazine (`magazines-marsh-monthly`), a pack id as above. The pack holds:

- `manifest.json`, with `gameId` the pack's id, `title` the magazine's title, and `writtenBy` the app that wrote it.
- `magazines.json`: the list, `{ "format": "atlas-magazines", "version": 1, "magazine": { … }, "issues": [ … ] }`, as in the description.
- For each issue, its file `magazines/<name>.pdf` or `magazines/<name>.cbz`, stored as it is. `<name>` is 1 to 80 lower case letters, digits, `-` and `_`, starting with a letter or a digit, made from the issue's date and title.
- When the text of its pages is known, `magazines/<name>.text.json`, stored, in the format of a guidebook's text (`atlas-guidebook-text`, see "Guidebooks").
- When it has one, its cover, `magazines/<name>.cover.jpg`, stored: a JPEG of at most 512 KB, best at most 512 pixels on its longest side. The covers come right after `magazines.json`, so a list of the issues can be shown from the start of the file.

The description's `magazine`: `title` (1 to 200 characters) and, optionally, `publisher` (at most 100). Each issue in `issues` and in `magazines.json`:

| Field    | What it is                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| `file`   | Its entry name, `magazines/<name>.pdf` or `.cbz`. The extension says which it is.                          |
| `title`  | How it is shown, such as `Issue 42`: 1 to 200 characters.                                                  |
| `date`   | Optional. When it came out: `YYYY-MM` or `YYYY-MM-DD`. Issues are shown newest first.                      |
| `number` | Optional. Its number, which orders issues of the same date.                                                |
| `pages`  | Its pages: a PDF's pages, a CBZ's pictures. 1 to 100,000.                                                  |
| `bytes`  | The size of its file. At most 16 GB.                                                                       |
| `text`   | Optional. The entry name of the text of its pages, `magazines/<name>.text.json`, with the same name.       |
| `cover`  | Optional. The entry name of its cover, `magazines/<name>.cover.jpg`, with the same name.                   |
| `games`  | Optional. The games it covers, at most 200, each `{ "title", "system"?, "gameId"?, "pages" }` (see below). |

A game an issue covers has a `title` (1 to 200 characters), optionally the `system` it is for (at most 100) and its Atlas game id `gameId` (a pack id), and `pages`: the runs of pages about it, 1 to 50 of them, each `[first, last]` within the issue (one page is `[12, 12]`). Atlas lists the issue with a game of this device:

1. When the entry has a `gameId` and a game here has that id: that game, and every game the person put under one title with it.
2. Otherwise: every game whose title (its own, the title its pack file shows it under, or the title the person put it under) is the entry's title, compared without regard to case, space and punctuation, as guidebooks join their game. When the entry and the game both name a system, they must be the same, compared the same way.

```json
{
  "format": "atlas-pack-file",
  "version": 10,
  "packId": "magazines-marsh-monthly",
  "title": "Marsh Monthly",
  "exportedBy": { "name": "Fen Shelf", "version": "3.1.0", "platform": "windows" },
  "source": { "kind": "unknown", "origin": "magazines" },
  "magazine": { "title": "Marsh Monthly", "publisher": "Reed Press" },
  "issues": [
    {
      "file": "magazines/2026-04-issue-41.pdf",
      "title": "Issue 41",
      "date": "2026-04",
      "number": 41,
      "pages": 84,
      "bytes": 48000000,
      "text": "magazines/2026-04-issue-41.text.json",
      "cover": "magazines/2026-04-issue-41.cover.jpg",
      "games": [
        {
          "title": "Hollow Marsh",
          "gameId": "hollow-marsh",
          "pages": [
            [12, 15],
            [40, 40]
          ]
        }
      ]
    }
  ]
}
```

The checks a reader makes, besides those below: a `magazine` with a title when there are issues; at most 1,000 issues; each `file` a name as above, listed once; a `date` as above; `pages` and `bytes` within their bounds (its text at most 64 MB, its cover at most 512 KB); the file, its text and its cover stored, the file of exactly `bytes`; a `text` and a `cover` that name the issue's own; each game as above. An issue is untrusted as a guidebook is, and read the same way.

## What is never in a pack file

- The person's progress: found marks, ticks, profiles, presets and settings. They live in the app's own storage, never in the pack folder.
- The page data and style sheets kept by "Add a map" (`import/`).
- The app's lock and download records (`.atlas/`).
- A picture kept for the person's own use (`shareable: false`), unless the person chose to include such pictures. The file is then for their own devices only. The map's icons go in only with their own choice (see "The map's icons").
- A smaller copy of a picture made for pages (`pageCopy`).
- The person's own things under `mine/`, unless the person chose to include them.

## Checks a reader must make

Treat every pack file as untrusted.

- Read the description from the first entry only, and at most 4 MB of it. Refuse the file when the first entry is not `atlaspack.json`.
- Refuse the file when `format` is not `atlas-pack-file`, when `version` is below 1, or when `version` is newer than the newest one you know.
- Refuse the file when its description lacks a field that is not optional, or when `packId` is not a pack id as described above.
- Read only the entries the description or the pack's own files name. Refuse any other entry.
- Take an entry name only when it is a plain relative path: no `..`, no `/` at the start, no drive letter, no `\`, and no segment that starts with `.`. Refuse two entries whose names differ only by case, and refuse symbolic links.
- Take a small picture only when its name is a safe `preview/<name>.jpg` name, the description lists it, it comes right after the description, it is at most 512 KB, and it starts as a JPEG does. Stop looking for small pictures at the first entry that is not one.
- Read every entry with a limit on its size, and check that its size is the one the archive says.
- Read only stored or deflated entries.
- From version 11, take a model file (`scene/`) only as "3D maps" says: named by `maps.json`, and at most 256 MB.
- Never load anything from a web address because a file names it.

## Reading a pack file where it lies

Atlas can show a pack file without importing it (see "Pack files read where they lie" in `apps/desktop/README.md`). In place, the checks above are split in two:

- **The list of contents is checked when the file is opened.** Atlas reads the description and the central directory (ZIP64 too, from the directory alone, not a local header per entry) and checks every entry's name, type, packing and size as an import does. The description listed first must start at the very start of the file, so the description read from the start is the one the list names. The JSON files the rules need (`manifest.json`, `maps.json`, `layers.json` and `pictures.json`) are read for that.
- **Each file's content is checked at its first read.** A JSON file must be JSON, and a status file one of its layer, as an import requires. An entry read whole must match its checksum, and its local header must name it. An entry that fails is never served, and the file is then listed as one that cannot be opened, with the import's sentence, until it changes.

A byte range of a stored entry (a map image) is read from the file as it is and is not checked against the entry's checksum; the whole entry is. A deflated entry is always unpacked whole, within its size limit. The small pictures and the person's own things (`mine/`) are neither served nor read, so a file whose own things an import would refuse is still shown; the person's own things of a game read in place are Atlas's, kept in the maps folder by the game's id.

When the desktop app without downloads adds a pack file to its packs folder (see "Adding a pack file in the app without downloads" in `apps/desktop/README.md`), the copy is checked whole once before it gets its name, as an import checks a file: every entry's name, type and size, every entry read to its end against its checksum, and the manifest's id against the description's. The person's own things in the file are then taken in as an import takes them. The file itself is never changed.

When the Library looks for pack files, it keeps only what tells each file from a changed one and its description. The table of where each entry is is built again when the pack is read, and only the tables of the few packs read last are kept, with one limit on the unpacked JSON files of all of them.

Another app may replace a pack file while Atlas has it open, by writing a `.part` file beside it and renaming that over it. At each read Atlas compares the file's length and modified time, its end of central directory record (with the ZIP64 locator and the ZIP64 end record when there are), and the first record of its central directory, which holds the checksum of the description. When one differs, it reads the new file's list of contents, so it never reads the new file at the old file's offsets. A file rewritten in place that keeps its length, its modified time and its description is not noticed; a pack file Atlas writes has a description of its own, which says when it was made. Atlas never writes into a pack file or beside it.

**Handing a pack file to Atlas.** An app that makes pack files can put one in the packs folder (read `packsFolder` in the shared settings file to find it; absent means the default folder, see "Changing the packs folder" in `apps/desktop/README.md`), or in a folder of games the person added, and the desktop app notices it while it runs, without being told to look (see "Pack files that arrive, change or go" in `apps/desktop/README.md`). Write it as a `.part` file and rename it to its `.atlaspack` name when it is complete: a `.part` file is never read, and Atlas waits until no change came for a moment before it looks. To replace a file, rename the new one over it; the person is then told that another version of the game arrived, newer when its `pack.updated` (then its `exportedAt`) is later, and chooses when to load it. An app can also start Atlas with the path of one pack file as its only argument, as the file manager does; if Atlas is running already, that Atlas shows it.

**Starting Atlas with a game in Steam (Linux).** On Linux, the plain viewer (the desktop app without downloads) keeps the full path of the AppImage it last started from as `linuxAppImage` in the same shared settings file (`$XDG_DATA_HOME/atlas/settings.json`, beside `packsFolder`). It is absent while Atlas does not know one (it never started from an AppImage, or the file it named is gone) and is never written on Windows or Android; an older Atlas that does not know it may leave it out when it writes the file, until the viewer starts again. Atlas writes it only when the line below can hold the path. An app that writes a game's Steam launch options builds this line from it, exactly, with the path where `<AppImage>` stands:

```sh
bash -c '"<AppImage>" --background & exec "$@"' -- %command%
```

The path stands in double quotes inside single quotes, so before using it the app checks again that it is a full path to an existing file and holds no `'`, `"`, `$`, backtick, `\` or control character (a line break among them), since the file can be edited; for such a path, or when `linuxAppImage` is absent, it writes the line with `$HOME/Applications/Atlas.AppImage` and tells the person to change the path if the file is elsewhere. Atlas's Settings show the same line under "Start Atlas with a game in Steam" (see "Atlas on Linux and the Steam Deck" in `apps/desktop/README.md`).

## Reading and writing pack files from another Rust app

The `atlas-pack` crate, in this repository at `crates/atlas-pack`, holds what another app needs: the description's types, the format's constants, the checks above for the description and the small pictures, and bounded reads from a file. It has no app code and makes no network request. It is MIT licensed, as Atlas is.

Take it as a git dependency pinned to a release tag of this repository that has the crate, so its code only changes when you change the tag. Put that tag in place of `TAG`:

```toml
[dependencies]
atlas-pack = { git = "https://github.com/DrFlGd/Atlas", tag = "TAG" }
```

Move to a later tag when you want to read a newer version of the format.

Then read a file's description and its cover:

```rust
use std::path::Path;

fn card(file: &Path) -> Result<(), String> {
    let header = atlas_pack::read_header(file)?;
    let title = header
        .game
        .as_ref()
        .map_or(header.title.as_str(), |game| game.title.as_str());
    println!("{title}: {} maps", header.maps.len());
    if let Some(cover) = &header.cover {
        let jpeg = atlas_pack::read_preview(file, cover)?;
        println!("Cover: {} bytes", jpeg.len());
    }
    Ok(())
}
```

- `read_header(path)` and `read_header_from(reader)` read the description from the first entry, at most `MAX_HEADER_BYTES`, and check it with `parse_header`.
- `read_preview(path, name)` and `read_preview_from(reader, name)` read one small picture the description lists, at most `MAX_PREVIEW_BYTES`, from the entries right after the description.
- `parse_header(text)` checks a description's text: its format and version, the fields every pack file has and its pack id (`is_pack_id`), and it leaves out the names of small pictures that are not safe.
- Each of them refuses with a `Refusal`: one or two plain sentences to show as they are (`to_string()`, or `?` into a `String`), and a `kind()`: `NotAPackFile`, `NewerFormat`, `Damaged`, `CannotOpen` or `NoSuchPicture`. The sentences name no app to install. For `NewerFormat`, `what()` says which app and version made the file, and the advice after it is only "A newer version of this app is needed to open it.": an app that wants to name itself shows `what()` and adds its own sentence, as Atlas does.
- Both reads go through the file in order from its start. They also work on a stream that cannot seek, and on a file whose end is missing.
- `Header::origin()` says where the pack came from, from `source.origin`, else by the rules in "Where the pack came from".

To write a pack of guidebooks of a game:

```rust
use std::path::{Path, PathBuf};

use atlas_pack::{write_guidebook_pack, AppInfo, GuidebookPack, NewGuidebook};

fn write(packs_folder: &Path) -> Result<(), String> {
    let pack = GuidebookPack {
        pack_id: "guidebooks-hollow-marsh".to_owned(),
        game_title: "Hollow Marsh".to_owned(),
        written_by: AppInfo {
            name: "Fen Shelf".to_owned(),
            version: "1.0.0".to_owned(),
            platform: "windows".to_owned(),
        },
        guidebooks: vec![NewGuidebook {
            file: PathBuf::from("Hollow Marsh Field Guide.pdf"),
            title: "Hollow Marsh Field Guide".to_owned(),
            pages: None,
            text: None,
        }],
    };
    let target = packs_folder.join("Hollow Marsh guidebooks.atlaspack");
    write_guidebook_pack(&pack, &target)?;
    Ok(())
}
```

- `write_guidebook_pack(pack, target)` writes a complete pack of guidebooks (version 8) at `target`, as `<target>.part` renamed to `target` when it is complete, and returns its description. It counts each guidebook's pages when `pages` is none (a PDF's page tree, read without rendering it; a CBZ's pictures), records each file's size, and writes `text` (the text of each page, the first being page 1) as its text file. It refuses with a `WriteError`, one plain sentence, and writes nothing, when something does not fit the bounds above.
- `rewrite_guidebook_pack(existing, keep, pack, target)` writes such a pack again with the guidebooks `keep` keeps and those of `pack` after them, copying the kept ones as they are; the pack's version goes up by one. Atlas uses it to add a guidebook to a game's pack and to take one out, and only on the packs it wrote (`pack.writtenBy.name` `Atlas`).
- `guidebook_pages(file)` counts a guidebook file's pages only.
- `parse_guidebook_text(bytes, pages)` checks a text file, and `GuidebookText::of_pages(pages)` makes one.
- `write_magazine_pack(pack, target)` writes a complete pack of magazines (version 10, see "Magazines") at `target`, as `<target>.part` renamed to `target` when it is complete, and returns its description. `pack` is a `MagazinePack`: its id (`magazines-` and a name), the `MagazineFacts` (title, publisher), the app that writes it, and each `NewIssue`: its file, title, date, number, pages (counted when none), text by page, cover (a JPEG file) and games (`IssueGame`). It refuses with a `WriteError`, one plain sentence, and writes nothing, when something does not fit the bounds above. Write a magazine again under the same id, at the same place, to change it: the new file replaces the old one whole.

## Building a 3D map

Every 3D map should come out the same, whichever app makes it, so Atlas has one builder for them: the `atlas-scene` crate, in this repository at `crates/atlas-scene` (MIT, like `atlas-pack`). It takes a raw model and writes the scene files of one map into a pack folder:

1. **Lines the model up with the game's world.** `axes`, `scale` and `offset` say how the raw model's coordinates become world x, world y and height, as a scene's own fields do. The files it writes use glTF's own axes around the model's rounded centre, so the scene it returns has an `offset` only, and lines up with the map through its `worldTransform`.
2. **Drops what is never seen in game:** each part whose node (or a parent node), mesh or material name matches one of `drop` (`*` any run of characters, `?` one, any case), such as invisible walls, debug shapes or clutter.
3. **Floors** are the caller's: an app that knows a map's storeys writes them as its layers' `heights` (a map without storeys has none). The builder can draw each one (step 6).
4. **Cuts it into square cells** (`cellSize` in world units, or a size that gives about `cellTriangles` each, 60,000 by default), each triangle in the cell of its centre, and makes simpler levels of each cell with meshoptimizer (`levels`: by default 30 % and 8 % of the triangles; a level that saves little is left out), one primitive per material within a cell. Vertices shared with another cell or another material never move, so cells at different levels meet without gaps, and normals are worked out on the whole model first (a hard edge where faces meet at more than `creaseAngle`, 50°), so no seam shows between cells.
5. **Compresses** each file with `EXT_meshopt_compression` (normals in 8 bits with `KHR_mesh_quantization`). Textures are left out for now, each material keeping its colour; with `textures` `{"mode": "average"}`, a material whose base colour texture is a PNG or JPEG picture in the file keeps that picture's average colour (times its own) instead, so a model whose colours are all in its textures is not drawn white. KTX2 textures come later, in the place the crate's `textures` module describes.
6. **Draws the model from straight above** when asked (`render`): one picture per floor (each floor's `heights`, what lies below it faint) or of the whole map, cut into the map image tiles every app reads (`<folder>/<floor>/{z}/{x}/{y}.png`), with the map's size and `worldTransform`, so the map works in 2D in any app and its 2D side matches its model.
7. **Checks** the scene and its files with the rules of "3D maps" above, and returns the scene to put on the map in `maps.json`, with a report: triangles in, dropped and kept per level, cells, files, bytes and seconds.

The raw model is one glTF 2.0 binary file (`.glb`) with everything in it: triangle meshes, uncompressed, in any node tree, with vertex colours (`COLOR_0`, linear as glTF reads them) and plain materials (`baseColorFactor`, `doubleSided`). Corners at one place with one colour are joined.

**In the Importer.** The desktop app that downloads uses the same builder for a map part of 3D models of a site rules file (see "Maps that are 3D models" in the guide to site rules files, and `ImportContext.sceneModel` of the importer contract): it fetches the model, or its pieces of base64 text one at a time with the site's pause, joins them, builds the map with the file's `axes`, `scale`, `offset`, `drop`, `water` and `sky`, textures as their average colour, and draws one picture per floor the importer asks for, into a hidden folder of the library, `.importing-scene-builds`. The files move into the game's folder (`scene/<map>/` and `tiles/<map>/`) only when the game is saved; builds no saved game takes are thrown away.

**From a Rust app** (a Tauri shell, say), take the crate as `atlas-pack` above, and call it:

```rust
use std::path::Path;

fn build(raw: &Path, pack: &Path) -> Result<serde_json::Value, String> {
    let mut options = atlas_scene::Options::new("scene/keep");
    options.drop = vec!["*invisible*".to_owned()];
    let built = atlas_scene::build_file(raw, &options, pack, &mut |fraction, step| {
        println!("{:.0} % {step}", fraction * 100.0);
    })?;
    // built.report: what was done; built.rendered: the pictures, when asked.
    Ok(built.scene)
}
```

**From any other app** (the Map Maker's helper is Python), run the `atlas-scene` program that comes with it. `atlas-scene build <job.json>`, where the job is `{"input": "<raw .glb>", "pack": "<pack folder>", "options": {"folder": "scene/<map>", …}}` with the same options in camelCase (`axes`, `scale`, `offset`, `drop`, `cellSize`, `cellTriangles`, `levels`, `compress`, `creaseAngle`, `textures`, `sky`, `water`, `camera`, `render`), writes one JSON object per line: `progress` lines (`fraction`, `message`), then `done` with `scene`, `report` and, when it drew the map, `rendered`; or `error` with a `message`, and exit code 1. `atlas-scene check <pack folder>` checks the 3D side of a whole pack folder (every map's scene and its files, the layers' `heights`, the locations' `height`) and writes one `checked` line with what it found; exit code 1 when there is a problem. Neither makes a network request or writes outside the pack folder it is given.
