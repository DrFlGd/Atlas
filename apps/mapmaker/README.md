# Atlas Map Maker

Atlas Map Maker makes an Atlas map pack from the game files on your own PC, and installs it where the Atlas viewer finds its maps. Dark Souls Remastered first; Bloodborne later. It can also just check the files and report what map data can be read (version 0.1).

It only reads the game folder. It never changes, copies or uploads anything from it, and it makes no network requests. The map pack it makes is drawn from your game files, so **it stays on your PC**: it is never put in a repository or a release, and you should not share it. The report it saves holds counts, ids, file names, coordinate ranges, error messages and small preview pictures, and no game files or game text.

## For Jerred: how to make the Dark Souls Remastered map

No command line needed, ever.

1. **Install.** Open the repository's Releases page, find **Atlas Map Maker 0.2.0** (tag `mapmaker-v0.2.0`, once it is released) and download **Atlas-Map-Maker-0.2.0-setup.exe**. Run it. The installer is not signed, so Windows shows a blue "Windows protected your PC" box: click **More info**, then **Run anyway**. The installer shows the GNU GPL licence (see below): click **I Agree**, then install. It installs next to Atlas and changes nothing in it.
2. **Start** Atlas Map Maker from the Start menu.
3. **Choose your Dark Souls Remastered folder.** Click **Choose folder…** and pick the game's folder, the one that holds `DarkSoulsRemastered.exe`. With Steam it is usually:

   `C:\Program Files (x86)\Steam\steamapps\common\DARK SOULS REMASTERED`

   If it is somewhere else: in Steam, right-click Dark Souls Remastered, then **Manage**, **Browse local files**, and choose the folder that opens. Choosing a folder above it also works. The app remembers the folder for next time.

4. **Click Make map.** It reads every area in full (collision, or the navmesh where collision cannot be read), works out the floors, draws them and cuts them into map tiles. A progress bar shows each area as it goes; it may take several minutes. Reading an area's collision is stopped after 5 minutes; that area is then drawn from its navmesh, or with markers only, and the rest goes on. **Cancel** stops it at once and leaves your maps folder as it was.
5. **Open Atlas.** The map pack is installed in Atlas's maps folder (`%LOCALAPPDATA%\Atlas\Maps\dark-souls-remastered`, or the folder you chose in Atlas's Maps dialog), and the window says where; **Show in folder** opens it. In Atlas, the pack appears in the list of maps (click **Refresh** in the Maps dialog if Atlas was already open). Making the map again replaces the pack it made before; it never replaces a pack it did not make.
6. **Read the result.** The table lists every area with its floors, its markers by type, and anything to look at (markers not over any floor, bosses not found, item lots missing from the item table, an area too large for one picture). Below are small pictures of every floor.
7. **Click Save report…**, save the `.zip` file and **upload it to the thread**. It holds the report and the small floor pictures, not the map pack.

**Check game files** still works as in 0.1: it only reports what can be read, and makes nothing.

### What is on the map

- **One map per area, one layer per floor.** Floors are found from the height of the walkable ground: where one walkable surface lies at least 3 metres over another across enough ground, they are split into floors (at most 5 per area). Each floor is drawn from above, shaded by height (dark teal low, light teal high) with light from the north-west, walls outlined in dark lines, and the floors below faded underneath. North (+z) is up.
- **Markers:** bonfires (from the event scripts), every treasure pickup (one marker per item, with its name, count and description; consumables and souls are in types hidden by default), bosses, NPCs you can talk to, and enemies with a guaranteed one-time drop. No regular enemies. Each marker sits on the floor its height falls in, and has the game's event flag where there is one.
- **Checklists:** All bonfires, Bosses, Items by area, Rings, Key items.
- Names and numbers that need choosing (area names, floor names for a few areas, bosses and their flags, item category ranges) are in [tools/gamefiles/config/dark-souls-remastered.json](../../tools/gamefiles/config/dark-souls-remastered.json); the defaults need no tuning.

The method follows [Hunter's Atlas](https://github.com/MikeTat1988/HuntersAtlas) (GPL-2.0), credited in every pack's attribution.

## Licence

The Atlas repository is MIT, but **the Map Maker installer is GPL-3.0**: it carries `atlas-gamefiles`, the file reader built from [tools/gamefiles](../../tools/gamefiles/README.md), which uses the GPL-3.0 libraries Soulstruct and soulstruct-havok. The app's own code in this folder is MIT. The source of every release is in this repository at the release's tag (`mapmaker-v<version>`).

## How it works

- `src/`: the window (React, with the Atlas viewer's theme from `apps/web/src/styles/theme.css`). It calls the shell's commands through Tauri's injected `invoke`, like the viewer, with no Tauri package.
- `src-tauri/`: the Tauri 2 shell (`dev.atlas.mapmaker`). `checks.rs` starts the helper (`check`, or `make` with `--maps-folder`) with the chosen folder and a new output folder in the app's data (`%LOCALAPPDATA%\dev.atlas.mapmaker\checks\run-…` or `makes\run-…`, the last three kept), reads its JSON progress lines, keeps the last lines of its error output for a failed check, and reads `report.json` when it is done. **Cancel** writes `cancel` to the helper's standard input (the helper then stops its file reader process at once); if it has not stopped five seconds later, the app ends it and its child processes. Closing the app ends a running check or make. `maps.rs` finds the viewer's maps folder the way the viewer does: `mapsFolder` in `%LOCALAPPDATA%\Atlas\settings.json`, else `%LOCALAPPDATA%\Atlas\Maps` (`~/.local/share/atlas/maps` on Linux). The last folder is kept in `%APPDATA%\dev.atlas.mapmaker\settings.json`.
- The helper ships as a Tauri sidecar: `scripts/build.js` copies the PyInstaller-built `atlas-gamefiles` to `src-tauri/binaries/atlas-gamefiles-<target triple>[.exe]` and runs `tauri build` with `src-tauri/tauri.build.conf.json`, which lists it under `bundle.externalBin`, so the installer puts it next to `atlas-mapmaker.exe`. Plain `cargo` builds and tests need no helper.

## Building

Needs what the viewer's desktop app needs ([apps/desktop/README.md](../desktop/README.md)), plus Python 3.13 for the helper.

```
cd tools/gamefiles && pip install -r requirements-dev.txt && pyinstaller --clean --noconfirm atlas-gamefiles.spec && cd ../..
pnpm install
pnpm --filter @atlas/mapmaker desktop:build          # helper from tools/gamefiles/dist/, or set ATLAS_GAMEFILES_HELPER
```

The NSIS installer lands in `apps/mapmaker/src-tauri/target/release/bundle/nsis/`. For development, `pnpm --filter @atlas/mapmaker dev` opens the window on the Vite dev server; a debug build uses the helper named by `ATLAS_GAMEFILES_HELPER` when it is set.

Tests: `pnpm --filter @atlas/mapmaker test` (wording of the report, build script), `cargo test` in `src-tauri` (progress lines, cancel and failure states, a stand-in helper for check and make on Linux, the maps folder), `node e2e/linux.js <made-up folder>` under `xvfb-run` (the built app, its helper and a made-up Dark Souls Remastered folder from `tools/gamefiles/tests/fixtures.py`, end to end), `node e2e/helper.js <helper> <made-up folder> <out> [--cancel | --make <maps folder>]` (the built helper started the way the app starts it), and `node e2e/windows.js` (the Windows start-up test). CI also makes a pack from the made-up `dsr-map` folder with the built helper and validates it with `pnpm --filter @atlas/pipeline validate-pack <pack folder>`.

## Releases

The **Release Map Maker** workflow (`.github/workflows/release-mapmaker.yml`) is run by hand from the Actions tab with a version that must match `apps/mapmaker/package.json`. It builds and tests the helper, builds the installer on Windows, and publishes `Atlas-Map-Maker-<version>-setup.exe` as a GitHub Release tagged `mapmaker-v<version>`. The viewer's own releases (`v*` tags) are separate.
