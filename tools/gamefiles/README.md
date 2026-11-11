# atlas-gamefiles: the Map Maker's file reader

**Licence: GPL-3.0-or-later** ([LICENSE](LICENSE)). This folder, and the Atlas Map Maker installer that carries the program built from it, are under the GNU General Public License version 3, because they use [Soulstruct](https://github.com/Grimrukh/soulstruct) and [soulstruct-havok](https://github.com/Grimrukh/soulstruct-havok) (both GPL-3.0-or-later). The rest of this repository stays under the MIT licence. Nothing from this folder goes into the Atlas viewer or the Importer.

`atlas-gamefiles` reads a player's own game files and reports what map data can be read from them. It is the first step towards making Atlas map packs from game files: Dark Souls Remastered first, then Bloodborne. Players never run it by hand: the [Atlas Map Maker](../../apps/mapmaker/README.md) app runs it and shows the result.

## What it does (Phase 0: check only)

`atlas-gamefiles check <game folder> --out <output folder>`:

1. **Detects the game and version** from data files, not from one executable fingerprint:
   - Dark Souls Remastered: `DarkSoulsRemastered.exe` (its file version), `map/MapStudio/*.msb`, the Steam build id when `appmanifest_570940.acf` is two folders up;
   - Bloodborne: a dump folder with `eboot.bin`, `sce_sys/param.sfo` (title id and app version) and `dvdroot_ps4/map/MapStudio/*.msb.dcx`, and whether The Old Hunters maps (m34, m35, m36) are there;
   - Prepare to Die Edition is recognised and refused; anything else is "unknown" with the reason. A parent folder works too: it looks two levels down.
2. **Lists the areas** (one MSB map layout each) with parts by type, treasure events, the item lots they give (and how many of those are in the game's `ItemLotParam`), and bonfire or lamp candidates (Dark Souls: entity ids in the bonfire ranges and collisions' `attached_bonfire`; Bloodborne: collisions' `attached_lantern`; both unconfirmed). Also the range of part positions.
3. **Tries each geometry source** per area and records what worked, with counts and the first errors:
   - collision (`hAA_BB_CC_DD.hkxbhd` + `.hkxbdt`): Dark Souls Remastered's Havok 2015 meshes are read with soulstruct-havok's `MapCollisionModel`; Bloodborne's Havok 2014 compressed meshes are only parsed (their triangles need a decoder of our own, a later phase);
   - navmesh: Dark Souls Remastered `.nvm` files in `mAA_BB_CC_DD.nvmbnd.dcx`; Bloodborne `.nvmhktbnd.dcx` (parsed only);
   - map piece models (`.flver`, `.mapbnd`): a sample of 12 per area (`--map-piece-sample`, 0 for all).
4. **Draws one top-down preview PNG per area**: geometry shaded by height where it was read, dots for treasure, bonfire or lamp candidates, characters, objects and player starts. Right is +x and up is +z.
5. **Writes** `report.json`, `previews/<area>.png` and `atlas-check-report.zip` (both, plus a short README) into the output folder.

Standard output carries one JSON object per line: `start`, `game`, `areas`, `progress` (with `fraction` and `message`), `area`, `warning`, then `done` (exit code 0), `cancelled` (3) or `error` (1, or 2 for a bad output folder). Everything else goes to standard error. With `--stdin-cancel`, writing `cancel` to standard input, or closing it, stops the check between two files.

## Promises, enforced in code

- **No network.** Every socket connection and name lookup in the process raises (`safety.block_network`).
- **The game folder is only read.** The output folder may not be inside it (or contain it), and nothing is copied from it: the report holds counts, file names, coordinate ranges and error messages, and the previews are drawn from coordinates.
- **Nothing else is written.** Soulstruct normally reads and writes a config file and a log file in the user's AppData (or next to a frozen executable) and loads an Oodle DLL from other games' folders. `safety.prepare_soulstruct` imports it with those paths pointed at an empty temporary folder, its logging set-up replaced and DLL loading hidden.
- **What the executable must not carry is checked at build time.** The PyInstaller spec takes only Soulstruct's code, its instruction and field definitions (JSON), type stubs and Havok type lists, and fails if the Oodle DLL, any bundled `.exe`/`.dll`, Havok templates or paramdef/material binders got in.

## Development

Python 3.13 (Soulstruct 2.6 needs it).

```
cd tools/gamefiles
python -m venv .venv && . .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
python -m pytest
python -m atlas_gamefiles check "<game folder>" --out ../../build/check
pyinstaller --clean --noconfirm atlas-gamefiles.spec   # dist/atlas-gamefiles(.exe)
```

`requirements.txt` pins every runtime package exactly (Soulstruct 2.6.0, soulstruct-havok 1.5.0, NumPy, SciPy and their dependencies); soulstruct-havok imports colorama without declaring it, so it is listed too.

### Tests use made-up files only

`tests/fixtures.py` writes made-up game folders with Soulstruct itself: MSB map layouts, an ItemLotParam, item name tables, collision meshes in an HKXBHD/HKXBDT pair and a navmesh binder, all with invented names, ids and a few triangles. `python tests/fixtures.py dsr <folder>` writes one by hand (CI uses it to try the built executable). What Soulstruct 2.6.0 cannot write is tested with a mock, and says so in the test:

- map piece models (FLVER): no minimal writer, so the success path mocks the model reader; the fixture holds a file that is not a model, for the failure path;
- Bloodborne MSBs: Soulstruct's writer leaves part offsets unfilled, so the Bloodborne fixture's map layout is a Dark Souls one, read with a mocked class;
- Bloodborne collision (Havok 2014 hknp): not written; the test makes the mesh reader refuse the made-up mesh, as it refuses real Bloodborne files.

No real game data is used in tests, committed, or shipped.

## Credits

The approach follows [Hunter's Atlas](https://github.com/MikeTat1988/HuntersAtlas) (GPL-2.0), which maps Bloodborne from a player's own dump with Soulstruct. It was read for method only; no code was copied.
