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

   Phase 0 is a check, not the full map, so collision is read from an evenly spaced sample of 12 files per area (`--collision-sample`, 0 for all), and every source stops starting new files after 45 seconds (`--source-budget`); either way it is marked `sampled`. The report records each source's time to open its binder (`openSeconds`), the reading time per file (`fileSeconds`: min, median, max) and the slowest file, so real parse speeds show up in a player's report.
   **Nothing can hang the check.** The geometry is read in a separate file reader process (`worker.py`, `reader.py`): one at a time, reused from source to source. It is this same program started again with a hidden command (`atlas-gamefiles reader`, or `python -m atlas_gamefiles reader`) as a plain child process with pipes of its own (jobs in on standard input, progress and results out on standard output, one JSON line each; the preview triangles in a temporary `.npy` file in the output folder, deleted once read), its standard error in `reader-log.txt` in the output folder, and on Windows no console window: the way the app starts the helper itself. (0.1.1 used multiprocessing's `spawn`; on a player's PC that child never started. See "Standard input" below.) The reader applies the same promises as the helper (no network, Soulstruct imported with `prepare_soulstruct`) before it reads anything, and ends when its standard input ends, so it never outlives the helper. It reports each start-up step (`booted`, `numpy`, `soulstruct core`, `soulstruct.havok`, `ready`); one not ready after 60 seconds is stopped, and every source then fails with the last step it reached (if only the Havok reader would not load, the reader starts again without it and only the sources that need it fail). It reports before it opens a binder, how long that took, and before each file; when it is silent for 5 seconds (`--heartbeat`), the helper writes a progress line that it is still on that file ("still reading h1000B0A10.hkx.dcx (collision file 3 of 12), 20 s"). A source still running after 90 seconds (`--source-time-limit`, 0 for none) is stopped: the reader is killed, the source is recorded as `timed-out` with the file it was on (`stoppedOn`) and the files done before it (`filesDone`), a warning is added, and the check goes on in a new reader. Shortly before either time limit, the reader writes every thread's stack to its log, so a report of a hang says where it hung. Cancel kills the reader at once. Only the result comes back, with at most 200,000 triangles per source for the preview.

4. **Draws one top-down preview PNG per area**: geometry shaded by height where it was read, dots for treasure, bonfire or lamp candidates, characters, objects and player starts. Right is +x and up is +z.
5. **Writes** `report.json`, `previews/<area>.png` and `atlas-check-report.zip` (both, the reader's log and a short README) into the output folder. The report's `diagnostics` section says how the helper ran: frozen or not, Python and helper versions, the Windows version, the temporary folder, how long importing Soulstruct took, and for the file reader how it was started, each start's steps with their times, the last step reached, and, when anything went wrong, the end of its log. Paths under the home folder start with `~`, in the report and in the zipped log.

Standard output carries one JSON object per line: `start`, `game`, `areas`, `progress` (with `fraction` and `message`), `area`, `warning`, then `done` (exit code 0), `cancelled` (3) or `error` (1, or 2 for a bad output folder). Everything else goes to standard error. With `--stdin-cancel`, writing `cancel` to standard input, or closing it, stops the check at once (the file reader process is killed).

**Standard input.** The helper (and the reader) keeps its standard input to itself: it reads it through a private copy, and the standard input that libraries and any program they start see is the null device (`events.claim_stdin`). On Windows it also never leaves a read waiting on the pipe: it asks how many bytes are there (`PeekNamedPipe`) and reads only those (`events.stdin_lines`). A read left waiting on a pipe there blocks every other use of that pipe, even a program asking what kind of file its standard input is as it starts. In 0.1.1, the helper waited on the app's pipe for `cancel` while its multiprocessing child, which Windows gives a copy of the helper's standard input, started. That is most likely why, on a player's PC, the child never got going and every geometry source failed with "it did not start within 180 s" (not confirmed on that PC; the CI step "Try the helper the way the app starts it" starts the helper the same way).

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
