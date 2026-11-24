# Atlas Map Maker

Atlas Map Maker makes an Atlas map pack from the game files on your own PC, and installs it where the Atlas viewer finds its maps. Dark Souls Remastered, and Bloodborne 1.09. It can also just check the files and report what map data can be read (version 0.1), and make a map from a 3D model you made or exported (glTF, OBJ, STL or PLY; see [Making a map from a 3D model](#making-a-map-from-a-3d-model)).

It only reads the game folder. It never changes, copies or uploads anything from it, and it makes no network requests. The map pack it makes is drawn from your game files, so **it stays on your PC**: it is never put in a repository or a release, and you should not share it. The report it saves holds counts, ids, file names, coordinate ranges, error messages and small preview pictures, and no game files or game text.

## For Jerred: how to make the Dark Souls Remastered map

No command line needed, ever.

1. **Install.** Open the repository's Releases page, find **Atlas Map Maker 0.2.0** (tag `mapmaker-v0.2.0`, once it is released) and download **Atlas-Map-Maker-0.2.0-setup.exe**. Run it. The installer is not signed, so Windows shows a blue "Windows protected your PC" box: click **More info**, then **Run anyway**. The installer shows the GNU GPL licence (see below): click **I Agree**, then install. It installs next to Atlas and changes nothing in it.
2. **Start** Atlas Map Maker from the Start menu.
3. **Choose your Dark Souls Remastered folder.** Press **Choose folder…** and pick the game's folder, the one that holds `DarkSoulsRemastered.exe`. With Steam it is usually:

   `C:\Program Files (x86)\Steam\steamapps\common\DARK SOULS REMASTERED`

   If it is somewhere else: in Steam, right-click Dark Souls Remastered, then **Manage**, **Browse local files**, and choose the folder that opens. Choosing a folder above it also works. The app remembers the folder for next time.

4. **Press Make map.** Leave **Also make 3D maps** ticked (it is on unless you untick it; the app remembers the choice). It reads every area in full (collision, or the navmesh where collision cannot be read, and with the 3D look **Game models** or a **Textured** map style, the game's own models and textures), works out the floors, draws them and cuts them into map tiles, and makes a 3D model of each area. A progress bar shows each area as it goes; it may take several minutes. Reading an area's collision is stopped after 5 minutes; that area is then drawn from its navmesh, or with markers only, and the rest goes on. **Cancel** stops it at once and leaves your maps folder as it was.
5. **Open Atlas.** The map pack is installed in Atlas's maps folder (`%LOCALAPPDATA%\Atlas\Maps\dark-souls-remastered`, or the folder you chose in Atlas's Settings), and the window says where; **Show in folder** opens it. Open the Library in Atlas: the game is listed there. Making the map again replaces the pack it made before; it never replaces a pack it did not make.
6. **Read the result.** The table lists every area with its floors, its markers by type, its 3D model (triangles read and in the model, its levels of detail, cells, size and time), and anything to look at (markers not over any floor, bosses not found, item lots missing from the item table, an area too large for one picture). Below are small pictures of every floor.
7. **Press Save report…**, save the `.zip` file and **upload it to the thread**. It holds the report and the small floor pictures, not the map pack.

**Check game files** still works as in 0.1: it only reports what can be read, and makes nothing.

### Adjusting an area's floors

Where the Map Maker cut an area into floors in the wrong places, fix it by hand. The report's table shows, for each area, its floors with their heights, and the cut heights between them with who set each: **automatic**, **set in the Map Maker** (its own settings for a few areas) or **set by you**.

1. **Press Adjust floors** beside the area (in the table, or under its first floor picture). The panel shows:
   - on the left, **how much walkable floor there is at each height** (bars, height going up), and beside it a **section**: the whole area seen from the side, walls and all. Walkable floor is drawn as bright lines (brighter the nearer), walls see-through (lighter where more stand one behind another, so the rooms show through the outer walls), each part in the colour of the floor its height is on; the colours follow the cuts as you move them. **Seen from the south** and **Seen from the east** switch which side. A cut is a dashed line across both, labelled with its height in metres;
   - in the section, the area's **items and other locations** as dots in the colour of their type (**Show items** hides them). Things lie at walking height, so a cut through them is likely wrong: a dot within 1 m of a cut has a yellow ring (and the panel counts them), and one that is put on another floor than its height gives, or has no floor under it, a white ring. Point at a dot, or move to it with Tab, to see its type, height and floor;
   - below, the **3D view**: the area's model, the chosen floor bright and the others dim, each cut a see-through level in the colour of the floor above it, and the items as dots. Drag to turn it, scroll or pinch to zoom, right-drag or drag with two fingers to move it; with the view selected, the arrow keys turn it, + and − zoom, Home goes back to the start. **Press an item's dot** to go to it: its floor is chosen, what is more than 3 m above it is left out (never more than its floor's top) and the view looks down at it from close by; Escape, another floor, or a press beside the dots goes back. **Hide what is above this floor** leaves out everything above the chosen floor, so you look down into it; **Outlines** draws the edges of the walls and floors; **Full 3D** lets the view fill the window (Escape or **Back to the floors** returns);
   - or, with **From above**, the chosen floor seen from above as its map draws it (what is above it left out, the floors below faint, its markers as dots), with **Turn left** and **Turn right** (or the arrow keys) to turn it a quarter at a time and **Outlines**;
   - on the right, **the floors, highest first**: each one's name, its heights, its walkable area and its markers, with the cut between each two.
2. **Move a cut** by dragging its line (with a mouse or a finger), by typing its height, or by pressing it and using the arrow keys (0.1 m a press; Page Up and Page Down, 1 m). **Add a floor** cuts the floor at the height you type (it suggests the middle of the largest floor); **Delete floor** joins a floor to the one below it (the lowest joins the one above); **Remove cut** joins the two floors on each side of a cut. Type a **name** for any floor; an empty name keeps the Map Maker's own. The views follow your cuts as you go (the floors from above in a moment), without reading the game files again. **Map style of this area** chooses how Make this area again draws it.
3. **Press Make this area again.** Your cuts are saved, and only that area is made again: its floors, tiles, previews, markers (each on its floor) and, with **Also make 3D maps**, its 3D model. Its map is then put in place of the old one in your map pack; every other map and its files stay as they were. Progress and **Cancel** work as for Make map; a cancelled or failed run leaves the pack as it was. If the pack is gone or was made by another version of the Map Maker, it says so and offers **Make map**.
4. **Save** keeps your cuts without making the area again: the next **Make map** uses them. **Back to automatic** clears your cuts for that area.

Your cuts are kept in `floor-overrides.json` beside the Map Maker's settings (`%APPDATA%\dev.atlas.mapmaker\`), and every Make map uses them; the report says which areas used them. **Save my floor cuts to a file…** saves them (every area of the game, cuts and names only, nothing of the game itself) so you can **upload that file to the thread**: the Map Maker's own settings can then take them in for everyone. **Load floor cuts from a file…** takes such a file in. The file format is in [tools/gamefiles/README.md](../../tools/gamefiles/README.md#floor-cuts-file).

### Bloodborne

Choose your Bloodborne 1.09 game folder (dvdroot_ps4): the folder that holds `dvdroot_ps4`, or `dvdroot_ps4` itself. The Map Maker reads version 1.09 only, from `sce_sys/param.sfo` beside it, and says so if the folder is another version. Then make the map as above. The sixteen main areas are made (the Chalice Dungeons are not), with lamps, bosses, NPCs and the items lying in the world; enemy drops and rewards an event gives are left out. "Main Bloodborne areas: 16 of 16" in the result says all were found. The report lists bosses it did not find and lamps it could not place: the first make from a real game folder is what checks these.

### Floors: Automatic passages | Cuts

**Floors** (beside Also make 3D maps, remembered) chooses how floors are found: **As suits the game** (automatic passages for Bloodborne, cuts for Dark Souls Remastered), **Automatic passages** or **Cuts**. Cuts split an area into floors at set heights. Automatic passages keep the ground whole and split it only where one walkable surface lies more than 2.4 m over another, a bridge over a street or a ramp winding over itself, following how the ground joins up; the navmesh helps find where you can walk. Each area can be switched in Adjust floors with **Floors: Automatic passages | Cuts**, and its choice is saved with your floor cuts.

With automatic passages, Adjust floors shows each **overlapping spot** as a numbered bracket in the section and a large dot in the 3D view, and lists them under **Overlapping spots** (**Spot 1**, **Spot 2**, …). For each, **Main floor shows** **Upper** or **Lower** chooses which storey is drawn on the main floor where the two meet (the other goes on a floor of its own). Press a walkable surface in the section to go to its floor. The section and the 3D view are coloured by floor, and the views follow your choices as you go.

### Comparing with a picture

**Compare with a picture…** (beside each area in the result, and in Adjust floors) puts a picture you choose (PNG or JPEG, say another map of the same area) **Side by side** with the map Atlas made, or **Over the map** with its **Opacity**. Drag the picture to move it, and use **Size** and **Turn** (or the arrow keys, + and −, and [ and ]) to line it up; **Reset** starts again. The picture and how it is lined up are remembered per area in the Map Maker's settings, and **Forget this picture** clears them. The picture is only shown here: it is never copied into the map pack or the report.

### Making a map from a 3D model

**Make a map from a 3D model…** makes a map pack from a model you made from scratch or exported from another program: a building, a level, a scene. It reads:

- **glTF** (`.glb`, or `.gltf` with its `.bin` and texture files beside it), with its materials, textures and vertex colours;
- **OBJ** (`.obj` with its `.mtl` materials file and textures), materials seen from both sides;
- **STL** (binary or text) and **PLY** (text or binary, with vertex colours), which have no materials: drawn height shaded.

**FBX** and **COLLADA** (`.dae`) files cannot be read yet: the Map Maker says so and asks you to export the model as glTF (`.glb` or `.gltf`) or OBJ from the program you made it in. (No reader for them in Rust is reliable enough yet: FBX needs its node transforms worked out, which none does.)

1. **Press Make a map from a 3D model…** and choose the file (the app's own file dialog; the folder is remembered). The 3D builder reads it at once and says what it holds: its format, triangles, materials, textures found and any file it names that is missing (a texture or materials file not next to the model: the map is made without it, and the result says so).
2. **Set it up**, with a live 3D preview beside it (turned and scaled as the map will be, in a box of its size; north away from you):
   - **Name** (from the file's name; the pack id is made from it, so making a map of the same name again replaces that pack, and never one made from game files) and **Title in Atlas**.
   - **Up axis**: guessed from the file type (Y up for glTF and OBJ, Z up for STL and PLY). Check the preview: the ground should be at the bottom.
   - **Units**: metres, centimetres, millimetres, inches, feet, or **Custom** (metres per unit). The size in metres is shown, with a word when it looks unlikely for a map.
   - **Textures**: keep the model's textures, or plain colours (each material in one colour; a smaller pack).
   - **Faces**: seen from both sides, or the front only. As the file says by default: glTF says per material; OBJ, STL and PLY faces are taken as seen from both sides.
   - **Floors**: **By ground area** (the default, below), **Automatic passages** (as for game files) or **No floors** (one floor).
   - **Map style**: as for game files, and **Textured** too, which draws each floor from above in the model's own textures and colours (height shaded when the model has none).
   - **Allow very large models**: a model of more than 5 million triangles is refused unless this is on (up to 50 million; it needs much memory).
3. **Press Make map.** Progress and Cancel work as for game files. The pack is installed in the Atlas maps folder, one layer per floor, each drawn from above with everything above it cut away, with the model as its 3D map.

**By ground area** finds a model's storeys from its flat ground: it adds up the area of surfaces facing up (within 30° of level) in 1 m steps of height, takes the heights with the most ground, strongest first, and stops below a tenth of the largest. Storeys closer than **Floors at least … m apart** (3 m unless you set it) keep only the stronger; levels closer than **Join levels closer than … m** (2 m) are joined. Each floor is cut 1.5 m below its level. Adjust floors says where the storeys were found, and the cuts can be moved there as for any area.

**No locations** are made from a model: the result says so. Add them in Atlas with **Edit locations**.

**Make this area again** and **Adjust floors** work for these maps too. The model file's path and its setup are remembered with the make, so the model is read again from it; if the file was moved or renamed, the Map Maker says so, and you choose it again with Make a map from a 3D model…. Your floor cuts for it are kept under its pack id, area `model`.

### What is on the map

- **One map per area, one layer per floor.** Floors are found from the height of the walkable ground: where one walkable surface lies at least 3 metres over another across enough ground, they are split into floors (at most 5 per area). Each floor is drawn from above with everything above it left out, shaded by height (dark teal low, light teal high) with light from the north-west, walls outlined in dark lines, and the floors below faded underneath. North (+z) is up.
- **Map style** (remembered, beside Also make 3D maps): **Height shaded** as above, or **Height shaded with outlines**, which draws the collision boundaries (the walls, and the edges of the walkable floor) as clear light lines. **Textured** draws each floor from above from the game's own models in their own textures (Dark Souls Remastered), with everything above the floor cut away as for the other styles: the roofs and ceilings over a room are left out, so the room shows. **Textured with outlines** adds the light lines of the walls and the floor's edges. An area whose models cannot be read is drawn height shaded (with outlines for Textured with outlines), and its report says why.
- **Markers:** bonfires (from the event scripts), every treasure pickup (one marker per item, with its name, count and description; consumables and souls are in types hidden by default), bosses, NPCs you can talk to, and enemies with a guaranteed one-time drop. No regular enemies. Each marker sits on the floor its height falls in, and has the game's event flag where there is one.
- **Checklists:** All bonfires, Bosses, Items by area, Rings, Key items (for Bloodborne: All lamps and Accessories).
- **3D maps** (with **Also make 3D maps**): each area as a 3D model. **3D look** (remembered, beside Also make 3D maps) chooses what from: **Game models** (the default) makes it from the game's own models, placed as the map layout places them, with every texture at its own size up close and smaller copies further away (Dark Souls Remastered); **Collision** makes it from the ground and walls, in the same colours as its map (lighter where higher, darker on steep slopes and walls). An area whose models cannot be read is made from its collision, and its report says why (Bloodborne areas are made from their collision for now). In Atlas (0.31 or later) the map opens in 3D, with **2D | 3D** beside it; markers stand at their height, and where an area has floors, choosing one cuts away what is above it. Areas with one floor have no floor choice. The model is made by the 3D builder that comes with the Map Maker (`atlas-scene`, from [crates/atlas-scene](../../crates/atlas-scene)).
- Names and numbers that need choosing (area names, floor names for a few areas, bosses and their flags, item category ranges) are in [tools/gamefiles/config/dark-souls-remastered.json](../../tools/gamefiles/config/dark-souls-remastered.json) and [bloodborne.json](../../tools/gamefiles/config/bloodborne.json); the defaults need no tuning.

The method follows [Hunter's Atlas](https://github.com/MikeTat1988/HuntersAtlas) (GPL-2.0), credited in every pack's attribution.

## Licence

The Atlas repository is MIT, but **the Map Maker installer is GPL-3.0**: it carries `atlas-gamefiles`, the file reader built from [tools/gamefiles](../../tools/gamefiles/README.md), which uses the GPL-3.0 libraries Soulstruct and soulstruct-havok. The app's own code in this folder is MIT. The source of every release is in this repository at the release's tag (`mapmaker-v<version>`).

## How it works

- `src/`: the window (React, with the Atlas viewer's theme from `apps/web/src/styles/theme.css`). It calls the shell's commands through Tauri's injected `invoke`, like the viewer, with no Tauri package.
- `src-tauri/`: the Tauri 2 shell (`dev.atlas.mapmaker`). `checks.rs` starts the helper (`check`, or `make` with `--maps-folder`) with the chosen folder and a new output folder in the app's data (`%LOCALAPPDATA%\dev.atlas.mapmaker\checks\run-…` or `makes\run-…`, the last three kept), reads its JSON progress lines, keeps the last lines of its error output for a failed check, and reads `report.json` when it is done. **Cancel** writes `cancel` to the helper's standard input (the helper then stops its file reader process at once); if it has not stopped five seconds later, the app ends it and its child processes. Closing the app ends a running check or make. `maps.rs` finds the viewer's maps folder the way the viewer does: `mapsFolder` in `%LOCALAPPDATA%\Atlas\settings.json`, else `%LOCALAPPDATA%\Atlas\Maps` (`~/.local/share/atlas/maps` on Linux). The last folder is kept in `%APPDATA%\dev.atlas.mapmaker\settings.json`, with the last make's game and output folders (`lastMake`), so its report, and Adjust floors, are there when the app opens again. **Make this area again** runs `make --remake <area>` in that make's output folder (`checks.rs`, `Job::Remake`): its report stays shown while it runs and when it fails. `overrides.rs` keeps the player's floor cuts (`floor-overrides.json` beside the settings; passed to the helper with `--floor-overrides`), and `floorviews.rs` keeps the helper's `floor-views` command running while the Adjust floors panel is open, one JSON line each way per redraw. The settings also keep the chosen floor method (`floorMethod`, passed to `make` and `make --remake` as `--floor-method`) and, for Compare with a picture, per area (`compare`, keyed `<game>:<mAA_BB>`) the picture's path and its alignment (position as fractions of the map picture, size, turn, opacity, view); `compare_open_picture` opens only a picture the player chose there (PNG or JPEG by its first bytes, at most 40 MB), and nothing of it is copied anywhere. **Make a map from a 3D model…** (`choose_model`, the Tauri file dialog) keeps the chosen file in the shell; only that file is read: `model_inspect` runs the 3D builder's `atlas-scene inspect <file>` for what it holds and a small preview of its shape (`src/model.ts` turns and scales it for the 3D view of `floors3d.ts`), and `model_make_start` runs the helper's `make-model <file>` with the setup (`Job::Model`, `settings::ModelSetup`, each option as `--option=value`). The make's settings (`lastMake`) then also keep the model file's path and setup (`model`), so the report, Adjust floors and Make this area again (`make-model … --remake`) work after the app is opened again; the folder the model was chosen in is kept as `lastModelFolder`.
- The helper and the 3D builder ship as Tauri sidecars: `scripts/build.js` copies the PyInstaller-built `atlas-gamefiles` and the `atlas-scene` program (built from `crates/atlas-scene` with `cargo build --release`, or named by `ATLAS_SCENE_BUILDER`) to `src-tauri/binaries/<name>-<target triple>[.exe]` and runs `tauri build` with `src-tauri/tauri.build.conf.json`, which lists both under `bundle.externalBin`, so the installer puts them next to `atlas-mapmaker.exe`. Make map passes the builder to the helper (`--scene-builder`) with the 3D look (`--look-3d models|collision`, kept as `look3d`), or `--no-3d` when **Also make 3D maps** is unticked (kept as `make3d` in the settings file). The builder also draws the floors of the textured map styles (`atlas-scene draw`). Plain `cargo` builds and tests need neither.

## Building

Needs what the viewer's desktop app needs ([apps/desktop/README.md](../desktop/README.md)), plus Python 3.13 for the helper.

```
cd tools/gamefiles && pip install -r requirements-dev.txt && pyinstaller --clean --noconfirm atlas-gamefiles.spec && cd ../..
pnpm install
pnpm --filter @atlas/mapmaker desktop:build          # helper from tools/gamefiles/dist/, or set ATLAS_GAMEFILES_HELPER
```

The NSIS installer lands in `apps/mapmaker/src-tauri/target/release/bundle/nsis/`. For development, `pnpm --filter @atlas/mapmaker dev` opens the window on the Vite dev server; a debug build uses the helper named by `ATLAS_GAMEFILES_HELPER` and the 3D builder named by `ATLAS_SCENE_BUILDER` when they are set.

Tests: `pnpm --filter @atlas/mapmaker test` (wording of the report, build script), `cargo test` in `src-tauri` (progress lines, cancel and failure states, a stand-in helper for check and make on Linux, the maps folder), `node e2e/linux.js <made-up folder>` under `xvfb-run` (the built app, its helper and a made-up Dark Souls Remastered folder from `tools/gamefiles/tests/fixtures.py`, end to end), `node e2e/helper.js <helper> <made-up folder> <out> [--cancel | --make <maps folder>]` (the built helper started the way the app starts it), and `node e2e/windows.js` (the Windows start-up test). CI also makes a pack from the made-up `dsr-map` folder with the built helper and validates it with `pnpm --filter @atlas/pipeline validate-pack <pack folder>`.

## Releases

The **Release Map Maker** workflow (`.github/workflows/release-mapmaker.yml`) is run by hand from the Actions tab with a version that must match `apps/mapmaker/package.json`. It builds and tests the helper, builds the installer on Windows, and publishes `Atlas-Map-Maker-<version>-setup.exe` as a GitHub Release tagged `mapmaker-v<version>`. The viewer's own releases (`v*` tags) are separate.
