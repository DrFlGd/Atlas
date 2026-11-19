# The Atlas pack file format

A pack file (`.atlaspack`) holds a map, wiki or guide for a game in one file: the pack folder of one game, its map images up to a chosen level of detail, and the pictures its pages show. Atlas writes one with **Export** and reads one where it lies, or takes it in with **Import map pack file** (the desktop app without downloads copies it into its packs folder with **Add a pack file** instead and reads it there). Another app can show a card for a pack file and pass it on without unpacking it. This page says what is in the file and how to read it safely.

Every name in the examples is made up.

## The container

A pack file is a ZIP archive. It uses ZIP64 records when its size, its offsets or its number of entries need them. Entries are either stored as they are or deflated. No other method and no encryption is used.

The entries come in this order:

1. `atlaspack.json`, the description. It is always the first entry, so it can be read without the rest of the file.
2. From version 7, the small pictures of the maps, `preview/<name>.jpg`, right after the description and before everything else. They are stored, not deflated.
3. The pack's JSON files, such as `manifest.json`, `maps.json`, `layers.json`, `locations.json`, `guides.json`, `sections.json` and `pictures.json`. They are deflated.
4. The status file of each layer whose images can be downloaded, `offline-tiles/<layer>.json`.
5. The map images, at the paths each layer's own `url` gives, with an empty `.404` marker for an image the map server did not have. They are stored.
6. The pictures the pages show, in `pictures/`, that may be passed on.
7. Only when the person asked for it: their own lists, locations, pages, notes and photos, and the title the game is shown under with other games, under `mine/`.

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
| `source`         | Where the data came from. `kind` is `web-pages`, `app` or `unknown`. Optional: `name`, the name of the site the pages were read from (see below); `importer` (`id` and `title`); `pages`, each page read with `url`, `mapId` and `importedAt`; `newestPageAt` and `oldestPageAt`.                                                                                                                                                              |
| `contents`       | Counts: `maps`, `layers`, `locations`, `categories`, `regions`, `checklists` and `guides`.                                                                                                                                                                                                                                                                                                                                                     |
| `maps`           | Optional. One entry per map, in the order of the pack's `maps.json`: `id`, `name`, `width` and `height` of its most detailed image in pixels, `locations` (how many the pack has on it), and `preview`, the entry name of its small picture when the file holds one.                                                                                                                                                                           |
| `guides`         | Optional. The pack's pages, with `title`, `type` and `pages`. `type` is `guide` for pages read in order (the manifest's `pagesInOrder`) and `wiki` for pages read as a collection. A pack's pages are one source of pages, so there is one entry at most. A game of maps whose pages are only the notes of its locations has none.                                                                                                             |
| `cover`          | Optional. The entry name of the small picture to show for the file: that of the first map that has one.                                                                                                                                                                                                                                                                                                                                        |
| `images`         | The map images in the file: `detail`, `files`, `bytes`, and per layer what it holds (`levels`, `files`, `bytes`, `complete`, `full`, `downloadable`, `downloadedAt`).                                                                                                                                                                                                                                                                          |
| `files`, `bytes` | The entries after the description, and their size unpacked.                                                                                                                                                                                                                                                                                                                                                                                    |
| `mine`           | Optional. How many of the person's own things the file carries.                                                                                                                                                                                                                                                                                                                                                                                |

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

## Small pictures

From version 7, the file holds a small picture of each map that has images in the file. Each is a JPEG whose longest side is at most 512 pixels, at most 512 KB. Atlas draws it from the map's own images in the file: the first layer of the map, at the lowest level of detail that is at least 512 pixels on its longest side. A map made from one picture counts too, since Atlas cuts it into the same levels.

Its entry name is `preview/<name>.jpg`. The name is made from the map's id, in lower case letters, digits, `-` and `_`, starting with a letter or a digit, at most 80 characters. So no two names differ only by case. The map's `preview` field in the description gives the name, and `cover` names the one to show for the whole file.

A map with no image in the file has no small picture. Neither has a map whose images could not be read. Making a small picture never stops an export: Atlas leaves it out instead. Atlas for Android makes no pack files, so it makes no small pictures either. The file holds at most 1,024 small pictures, 64 MB together.

When Atlas imports a file, it checks each small picture and then leaves it out. It is not written into the pack folder and is kept nowhere, since the map's own images show the map. The description, kept with the pack as `.atlas/pack-file.json`, still names it.

## Versions

A file is written at the lowest version that can hold what it carries. So an older app reads every file it can, and refuses a newer one with a message that names the app and version that made it.

| Version | What it adds                                                                        |
| ------- | ----------------------------------------------------------------------------------- |
| 1       | The pack and its map images.                                                        |
| 2       | The person's own lists, locations and types (`mine/`).                              |
| 3       | Their own photos and the links between guide pages and the map.                     |
| 4       | Their own guide pages.                                                              |
| 5       | Their notes on the game's locations, and a guide page linked to one location alone. |
| 6       | The title the game is shown under with other games.                                 |
| 7       | Small pictures of the maps (`preview/`).                                            |

The fields `game`, `personalUse`, `maps`, `guides`, `cover` and `source.name` are optional and need no new version: a file without small pictures stays at the version of what else it carries. An older reader ignores them.

## What is never in a pack file

- The person's progress: found marks, ticks, profiles, presets and settings. They live in the app's own storage, never in the pack folder.
- The page data and style sheets kept by "Add a map" (`import/`).
- The app's lock and download records (`.atlas/`).
- A picture kept for the person's own use (`shareable: false`), unless the person chose to include such pictures. The file is then for their own devices only.
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
- Never load anything from a web address because a file names it.

## Reading a pack file where it lies

Atlas can show a pack file without importing it (see "Pack files read where they lie" in `apps/desktop/README.md`). In place, the checks above are split in two:

- **The list of contents is checked when the file is opened.** Atlas reads the description and the central directory (ZIP64 too, from the directory alone, not a local header per entry) and checks every entry's name, type, packing and size as an import does. The description listed first must start at the very start of the file, so the description read from the start is the one the list names. The JSON files the rules need (`manifest.json`, `maps.json`, `layers.json` and `pictures.json`) are read for that.
- **Each file's content is checked at its first read.** A JSON file must be JSON, and a status file one of its layer, as an import requires. An entry read whole must match its checksum, and its local header must name it. An entry that fails is never served, and the file is then listed as one that cannot be opened, with the import's sentence, until it changes.

A byte range of a stored entry (a map image) is read from the file as it is and is not checked against the entry's checksum; the whole entry is. A deflated entry is always unpacked whole, within its size limit. The small pictures and the person's own things (`mine/`) are neither served nor read, so a file whose own things an import would refuse is still shown; the person's own things of a game read in place are Atlas's, kept in the maps folder by the game's id.

When the desktop app without downloads adds a pack file to its packs folder (see "Adding a pack file in the app without downloads" in `apps/desktop/README.md`), the copy is checked whole once before it gets its name, as an import checks a file: every entry's name, type and size, every entry read to its end against its checksum, and the manifest's id against the description's. The person's own things in the file are then taken in as an import takes them. The file itself is never changed.

When the Library looks for pack files, it keeps only what tells each file from a changed one and its description. The table of where each entry is is built again when the pack is read, and only the tables of the few packs read last are kept, with one limit on the unpacked JSON files of all of them.

Another app may replace a pack file while Atlas has it open, by writing a `.part` file beside it and renaming that over it. At each read Atlas compares the file's length and modified time, its end of central directory record (with the ZIP64 locator and the ZIP64 end record when there are), and the first record of its central directory, which holds the checksum of the description. When one differs, it reads the new file's list of contents, so it never reads the new file at the old file's offsets. A file rewritten in place that keeps its length, its modified time and its description is not noticed; a pack file Atlas writes has a description of its own, which says when it was made. Atlas never writes into a pack file or beside it.

**Handing a pack file to Atlas.** An app that makes pack files can put one in the packs folder, or in a folder of games the person added, and the desktop app notices it while it runs, without being told to look (see "Pack files that arrive, change or go" in `apps/desktop/README.md`). Write it as a `.part` file and rename it to its `.atlaspack` name when it is complete: a `.part` file is never read, and Atlas waits until no change came for a moment before it looks. To replace a file, rename the new one over it; the person is then told that another version of the game arrived, newer when its `pack.updated` (then its `exportedAt`) is later, and chooses when to load it. An app can also start Atlas with the path of one pack file as its only argument, as the file manager does; if Atlas is running already, that Atlas shows it.

## Reading pack files from another Rust app

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
