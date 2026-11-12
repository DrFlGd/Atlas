# Atlas Map Maker

Atlas Map Maker checks the game files on your own PC and reports what map data can be read from them. It is the first step towards making Atlas maps from game files: Dark Souls Remastered first, then Bloodborne. This first version only checks and reports: it makes no maps yet.

It only reads the game folder. It never changes, copies or uploads anything from it, and it makes no network requests. The report it saves holds counts, file names, coordinate ranges, error messages and small preview pictures, and no game files.

## For Jerred: how to test it

No command line needed, ever.

1. **Install.** Open the repository's Releases page, find **Atlas Map Maker 0.1.2** (tag `mapmaker-v0.1.2`) and download **Atlas-Map-Maker-0.1.2-setup.exe**. Run it. The installer is not signed, so Windows shows a blue "Windows protected your PC" box: click **More info**, then **Run anyway**. The installer shows the GNU GPL licence (see below): click **I Agree**, then install. It installs next to Atlas and changes nothing in it.
2. **Start** Atlas Map Maker from the Start menu.
3. **Choose your Dark Souls Remastered folder.** Click **Choose folder…** and pick the game's folder, the one that holds `DarkSoulsRemastered.exe`. With Steam it is usually:

   `C:\Program Files (x86)\Steam\steamapps\common\DARK SOULS REMASTERED`

   If it is somewhere else: in Steam, right-click Dark Souls Remastered, then **Manage**, **Browse local files**, and choose the folder that opens. Choosing a folder above it also works. The app remembers the folder for next time.

4. **Click Check game files.** A progress bar shows each area as it is read, with the file it is on; while a file takes long, the line says so every few seconds ("still reading …, 20 s"). It may take a few minutes: each area's collision is read from a sample of 12 files, for at most about 45 seconds, and a file reader that takes longer than 90 seconds is stopped (the table then says "Took too long") and the check goes on. **Cancel** stops it at once.
5. **Read the result.** The top says which game and version it found and which geometry source works best (collision, navmesh or map pieces). The table lists every area with its parts, treasure, item lots, bonfire candidates and what each geometry source gave. Below are the preview pictures, seen from above.
6. **Click Save report…** and save the `.zip` file (Documents is suggested). **Show in folder** opens the folder it is in.
7. **Upload that .zip file to the thread.**

For Bloodborne (later), choose the dump folder, the one that holds `eboot.bin` and `dvdroot_ps4`. The check reports what it can read, but Bloodborne's collision meshes are only opened, not drawn, until a later version.

What it should show for Dark Souls Remastered: about 17 areas, most with treasure, and Collision read in most areas. If something fails, the report holds the error messages we need.

## Licence

The Atlas repository is MIT, but **the Map Maker installer is GPL-3.0**: it carries `atlas-gamefiles`, the file reader built from [tools/gamefiles](../../tools/gamefiles/README.md), which uses the GPL-3.0 libraries Soulstruct and soulstruct-havok. The app's own code in this folder is MIT. The source of every release is in this repository at the release's tag (`mapmaker-v<version>`).

## How it works

- `src/`: the window (React, with the Atlas viewer's theme from `apps/web/src/styles/theme.css`). It calls the shell's commands through Tauri's injected `invoke`, like the viewer, with no Tauri package.
- `src-tauri/`: the Tauri 2 shell (`dev.atlas.mapmaker`). `checks.rs` starts the helper with the chosen folder and a new output folder in the app's data (`%LOCALAPPDATA%\dev.atlas.mapmaker\checks\run-…`, the last three kept), reads its JSON progress lines, keeps the last lines of its error output for a failed check, and reads `report.json` when it is done. **Cancel** writes `cancel` to the helper's standard input (the helper then stops its file reader process at once); if it has not stopped five seconds later, the app ends it and its child processes. Closing the app ends a running check. The last folder is kept in `%APPDATA%\dev.atlas.mapmaker\settings.json`.
- The helper ships as a Tauri sidecar: `scripts/build.js` copies the PyInstaller-built `atlas-gamefiles` to `src-tauri/binaries/atlas-gamefiles-<target triple>[.exe]` and runs `tauri build` with `src-tauri/tauri.build.conf.json`, which lists it under `bundle.externalBin`, so the installer puts it next to `atlas-mapmaker.exe`. Plain `cargo` builds and tests need no helper.

## Building

Needs what the viewer's desktop app needs ([apps/desktop/README.md](../desktop/README.md)), plus Python 3.13 for the helper.

```
cd tools/gamefiles && pip install -r requirements-dev.txt && pyinstaller --clean --noconfirm atlas-gamefiles.spec && cd ../..
pnpm install
pnpm --filter @atlas/mapmaker desktop:build          # helper from tools/gamefiles/dist/, or set ATLAS_GAMEFILES_HELPER
```

The NSIS installer lands in `apps/mapmaker/src-tauri/target/release/bundle/nsis/`. For development, `pnpm --filter @atlas/mapmaker dev` opens the window on the Vite dev server; a debug build uses the helper named by `ATLAS_GAMEFILES_HELPER` when it is set.

Tests: `pnpm --filter @atlas/mapmaker test` (wording of the report, build script), `cargo test` in `src-tauri` (progress lines, cancel and failure states, a stand-in helper on Linux), `node e2e/linux.js <made-up folder>` under `xvfb-run` (the built app, its helper and a made-up Dark Souls Remastered folder from `tools/gamefiles/tests/fixtures.py`, end to end), and `node e2e/windows.js` (the Windows start-up test).

## Releases

The **Release Map Maker** workflow (`.github/workflows/release-mapmaker.yml`) is run by hand from the Actions tab with a version that must match `apps/mapmaker/package.json`. It builds and tests the helper, builds the installer on Windows, and publishes `Atlas-Map-Maker-<version>-setup.exe` as a GitHub Release tagged `mapmaker-v<version>`. The viewer's own releases (`v*` tags) are separate.
