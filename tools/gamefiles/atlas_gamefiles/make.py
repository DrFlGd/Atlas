"""`make`: make an Atlas map pack from the game files, and a report of how it went.

For each real area (debug maps skipped): read the map layout and the event script (markers, see world.py), read
every collision file in the file reader process (and the navmesh: for automatic passages, or in place of collision
when there is none), find the floors (cut heights, floors.py, or automatic passages, passages.py), draw each floor and cut it into tiles (render.py, tiles.py), and put each marker on its floor. With 3D
maps on (the default), also make the area's 3D model with the Atlas scene builder (scene.py): from the game's own
models with their textures (models.py, the 3D look "Game models"), or from its collision (the 3D look "Collision",
and for any area whose models cannot be read). The textured map styles draw the floors from those models too: the
builder draws them (`atlas-scene draw`), on the floors textured.py gives each triangle. Then write the pack (pack.py) into the shared maps folder, where Atlas finds it, and the report.

Only the output folder and the maps folder are written to; the game folder is only read. The report holds counts,
ids, heights, file names and error messages, and small preview pictures: no game text.
"""

from __future__ import annotations

import gc
import json
import shutil
import sys
import tempfile
import time
import typing as tp
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np

from . import REPORT_VERSION, TOOL_NAME, __version__
from .check import CancelToken, _now, display_path, game_dict
from .config import (
    area_config,
    chosen_floor_overrides,
    floor_method,
    floor_overrides,
    is_skipped,
    load_config,
    load_floor_overrides,
)
from .content import GameContent, read_content
from .detect import BLOODBORNE, DSR, detect, map_version_refusal
from .events import Events
from .floors import FloorPlan, Prepared, apply_overrides, locate, plan_floors, prepare, support_fraction
from .floorviews import save_floor_data
from .games import PROFILES, Area, GameProfile, list_areas, newest_versions
from .geometry import Cancelled, SourceResult, rotation_matrix
from .msb import load_msb
from .passages import plan_passages, prepare_passages, support_navmesh
from .pack import (
    AreaOut,
    LayerOut,
    WRITER,
    PackRefused,
    build_pack,
    check_target,
    duplicate_ids,
    existing_pack,
    floor_names,
    install,
    merge_area,
    read_pack_json,
    swap_area,
    write_pack_json,
)
from .models import TexturedMesh, is_usable, load_mesh, summary as models_summary
from .pieces import leave_out, leave_out_of_models, removed_of
from .render import BACKGROUND, compose, draw_floor, fallback_style, make_frame, map_style, preview_png
from .safety import UnsafeOutputError, check_output_folder, is_inside, prepare_soulstruct
from .scene import (
    BuilderFailed,
    check_pack,
    corner_colours,
    find_builder,
    floor_heights,
    raw_glb,
    run_builder,
    textured_order,
    write_textured_glb,
)
from .textured import triangle_floors
from .tiles import tile_format, write_pyramid
from .worker import READER_LOG, ProcessRunner, Runner, SourceJob, clean_text
from .world import AreaContent, extract_area

ZIP_NAME = "atlas-make-report.zip"
# The map's world x is the game's x, its y the game's z, and height the game's y (for the builder).
SCENE_AXES = ["+x", "+z", "+y"]
LOG_LIMIT = 200_000
TIME_LIMIT = 300.0  # seconds one area's geometry may take in the file reader
# Share of an area's progress for each step, without and with its 3D model, and with the game's models read.
STEPS = {"layout": 0.05, "geometry": 0.45, "floors": 0.1, "render": 0.4}
STEPS_3D = {"layout": 0.05, "geometry": 0.4, "floors": 0.1, "render": 0.3, "scene": 0.15}
STEPS_MODELS = {"layout": 0.04, "geometry": 0.3, "models": 0.2, "floors": 0.06, "render": 0.25}
STEPS_MODELS_3D = {"layout": 0.04, "geometry": 0.25, "models": 0.2, "floors": 0.06, "render": 0.25, "scene": 0.2}
MODELS_TIME_LIMIT = 900.0  # seconds one area's models and textures may take in the file reader
# The games whose own models and textures are read (3D look "Game models", the textured map styles).
GAME_MODEL_GAMES = frozenset({DSR})
LOOKS_3D = ("models", "collision")  # "3D look": the game's models (the default), or the collision
SCENE_WORK = "scene-work"
REMAKE_PREVIEWS = "previews-remake"


class MakeError(Exception):
    """The map cannot be made; the message says why, for the player. `code` names the case for the app (making an
    area again: `pack-missing`, `pack-other-version`, `report-missing`, `area-missing`), which then offers Make
    map."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


class MapMaker:
    def __init__(
        self,
        folder: Path,
        out: Path,
        events: Events,
        token: CancelToken | None = None,
        maps_folder: Path | None = None,
        only_areas: tp.Sequence[str] = (),
        runner: Runner | None = None,
        config_file: Path | None = None,
        make_3d: bool = True,
        scene_builder: Path | None = None,
        floor_overrides_file: Path | None = None,
        remake: str | None = None,
        style: str | None = None,
        floor_method: str | None = None,
        look_3d: str | None = None,
    ):
        self.folder = Path(folder)
        self.out = Path(out)
        self.events = events
        self.token = token or CancelToken()
        self.maps_folder = Path(maps_folder) if maps_folder else None
        self.only_areas = {a.lower() for a in only_areas}
        self.runner: Runner = runner if runner is not None else ProcessRunner(time_limit=TIME_LIMIT)
        self.config_file = config_file
        self.warnings: list[str] = []
        self.started = time.monotonic()
        self.import_seconds: float | None = None
        self.staging: Path | None = None
        self.make_3d = make_3d
        self.scene_builder = scene_builder
        self.builder: Path | None = None
        self.drawer: Path | None = None  # the builder, for drawing the textured map styles
        self.steps = STEPS
        # How floors are found when an area does not choose (config.floor_method): None for the config's.
        self.floor_method = floor_method if floor_method in ("passages", "cuts") else None
        # The player's own floor overrides (the Map Maker's floor-overrides.json), by area key; per area they
        # replace the config's entry. The areas that used them, for the report.
        self.floor_overrides_file = Path(floor_overrides_file) if floor_overrides_file else None
        self.own_overrides: dict[str, dict[str, tp.Any]] = {}
        self.own_overrides_error: str | None = None
        self.used_own: list[str] = []
        # Making one area again (`mAA_BB`), in place of its map in the pack made before (see replace_area).
        self.remake = remake.lower()[:6] if remake else None
        self.preview_dir: Path | None = None
        # What the 3D maps show: the game's models with their textures, or the collision (LOOKS_3D).
        self.look_3d = look_3d if look_3d in LOOKS_3D else LOOKS_3D[0]
        self.want_models = False
        # How the floors are drawn (render.MAP_STYLES); an unknown or unavailable style is refused here.
        try:
            self.style = map_style(style)
        except ValueError as error:
            raise MakeError(str(error)[:1].upper() + str(error)[1:] + ".", code="map-style") from None

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        self.events.warning(message)

    def run(self) -> dict[str, tp.Any]:
        try:
            return self._run()
        except BaseException:
            if self.staging is not None and self.staging.name.startswith("."):
                shutil.rmtree(self.staging, ignore_errors=True)
            if self.preview_dir is not None:
                shutil.rmtree(self.preview_dir, ignore_errors=True)
            raise
        finally:
            self.runner.close()

    # ------------------------------------------------------------------------------------------------------

    def _run(self) -> dict[str, tp.Any]:
        events = self.events
        events.emit("start", tool=TOOL_NAME, version=__version__, folder=display_path(self.folder), mode="remake" if self.remake else "make")
        events.progress(0.0, "Looking at the folder")
        detection = detect(self.folder)
        events.emit("game", game=game_dict(detection))
        if not detection.supported or detection.root is None:
            raise MakeError(detection.reason or f"{detection.title} is not supported.")
        if detection.game not in (DSR, BLOODBORNE):
            raise MakeError(f"Making maps of {detection.title} comes in a later version. Check game files works.")
        refusal = map_version_refusal(detection)
        if refusal:
            raise MakeError(refusal, code="game-version")
        root = detection.root
        check_output_folder(self.out, root)
        if self.maps_folder is not None:
            check_output_folder(self.maps_folder, root)
            if is_inside(self.maps_folder, self.out) or is_inside(self.out, self.maps_folder):
                raise UnsafeOutputError("The maps folder and the output folder must be apart.")
        profile = PROFILES[detection.game]
        config = load_config(detection.game, self.config_file)
        pack_id = str(config.get("packId", detection.game))
        if self.maps_folder is not None:
            target = self.maps_folder / pack_id
        else:
            target = self.out / "pack" / pack_id
        previous_report = self.check_remake(target) if self.remake else None
        self.out.mkdir(parents=True, exist_ok=True)
        self.runner.use_folder(self.out)
        (self.out / "previews").mkdir(exist_ok=True)

        events.progress(0.01, "Loading the file readers")
        importing = time.monotonic()
        prepare_soulstruct()
        self.import_seconds = time.monotonic() - importing
        self.load_own_overrides(detection.game)
        render_settings = dict(config.get("render", {}))
        fmt = tile_format(str(render_settings.get("tileFormat", "webp")))
        if self.make_3d:
            self.builder = find_builder(self.scene_builder)
            if self.builder is not None:
                self.builder = self.builder.resolve()
            if self.builder is None:
                self.warn("3D maps were not made: the 3D builder (atlas-scene) that comes with the Map Maker is missing")
            else:
                self.steps = STEPS_3D
        # Only Dark Souls Remastered's own models are read for now: Bloodborne's textures are not read yet, and its
        # models at full detail made 3D maps of gigabytes. Its maps keep the collision and the untextured styles.
        wants_look = self.style.textured or (self.builder is not None and self.look_3d == "models")
        if wants_look and profile.game not in GAME_MODEL_GAMES:
            chosen = [f"the map style {self.style.label}"] if self.style.textured else []
            if self.builder is not None and self.look_3d == "models":
                chosen.append("the 3D look Game models")
            self.style = fallback_style(self.style)
            self.look_3d = "collision"
            self.warn(
                f"The game's own models and textures are read for Dark Souls Remastered only for now, so "
                f"{' and '.join(chosen)} could not be used: the maps are drawn {self.style.label.lower()}"
                + (" and the 3D maps show the collision" if self.builder is not None else "")
            )
        if self.style.textured:
            drawer = self.builder or find_builder(self.scene_builder)
            self.drawer = drawer.resolve() if drawer is not None else None
        # The game's models are read for the textured map styles, and for 3D maps with the look "Game models".
        self.want_models = self.style.textured or (self.builder is not None and self.look_3d == "models")
        if self.want_models:
            self.steps = STEPS_MODELS_3D if self.builder is not None else STEPS_MODELS

        # Where the pack goes: refuse early, before any work, when the place is taken by a pack not ours.
        if self.maps_folder is not None:
            self.maps_folder.mkdir(parents=True, exist_ok=True)
        refusal = check_target(target)
        if refusal:
            raise MakeError(refusal)
        if self.remake:
            self.staging = target.with_name(f".{pack_id}.remake-{self.remake}")
            self.preview_dir = self.out / REMAKE_PREVIEWS
            shutil.rmtree(self.preview_dir, ignore_errors=True)
            self.preview_dir.mkdir()
        else:
            self.staging = target.with_name(f".{pack_id}.making")
        previous = existing_pack(target) or {}
        if self.staging.exists():
            shutil.rmtree(self.staging)
        self.staging.mkdir(parents=True)

        all_areas = list_areas(profile, root)
        skipped = [a.id for a in all_areas if is_skipped(config, a.id)]
        areas = [a for a in all_areas if not is_skipped(config, a.id)]
        areas, older = newest_versions(areas)
        skipped += older
        # A config with `mainAreas` (Bloodborne's sixteen) makes those, in that order; the others are skipped.
        main_areas = [str(k).lower() for k in config.get("mainAreas", []) if isinstance(k, str)]
        if main_areas:
            skipped += [a.id for a in areas if a.id[:6].lower() not in main_areas]
            areas = sorted((a for a in areas if a.id[:6].lower() in main_areas), key=lambda a: main_areas.index(a.id[:6].lower()))
        # Every area's map layout is read (see below), but only these are made.
        wanted = {self.remake} if self.remake else self.only_areas
        made_areas = [a for a in areas if a.id in wanted or a.id[:6] in wanted] if wanted else list(areas)
        if not self.remake:
            areas = made_areas
        areas = [
            Area(id=a.id, name=str(area_config(config, a.id).get("name") or a.name), msb=a.msb, map_folder=a.map_folder)
            for a in areas
        ]
        made_ids = {a.id for a in made_areas}
        made_areas = [a for a in areas if a.id in made_ids]
        events.emit("areas", count=len(made_areas), areas=[{"id": a.id, "name": a.name} for a in made_areas], skipped=skipped)
        if not made_areas:
            if self.remake:
                raise MakeError(f"The area {self.remake} was not found in the game folder. Press Make map to make the whole map again.", code="area-missing")
            raise MakeError("No map areas were found in the game folder.")

        self.token.stop()
        events.progress(0.02, "Reading the item tables and the game's text")
        content = read_content(profile, root)
        for name, source in content.sources.items():
            if not source.get("ok"):
                self.warn(f"{name} could not be read ({source.get('error')}): markers get fewer names")

        report: dict[str, tp.Any] = {
            "tool": TOOL_NAME,
            "toolVersion": __version__,
            "reportVersion": REPORT_VERSION,
            "kind": "make",
            "createdAt": _now(),
            "folder": display_path(self.folder),
            "game": game_dict(detection),
            "options": {
                "areas": sorted(self.only_areas) or "all",
                "render": render_settings,
                "mapStyle": self.style.id,
                "tileFormat": fmt,
                "floors": config.get("floors", {}),
                "floorMethod": floor_method(config, None, self.floor_method),
                "config": self.config_file.name if self.config_file else f"{detection.game}.json (built in)",
                "floorOverrides": self.own_overrides_report(),
                "threeD": {
                    "asked": self.make_3d,
                    "look": self.look_3d,
                    "builder": self.builder.name if self.builder else None,
                    "settings": config.get("scene", {}),
                },
            },
            "content": content.to_report(),
            "skippedAreas": skipped,
            "areas": [],
            "pack": None,
            "summary": None,
            "warnings": self.warnings,
        }

        # Every area's map layout and event script first: bonfire objects that event scripts confirm teach the
        # fallback for areas whose script registers none. (Making one area again reads them all too, so that its
        # markers come out as in the whole map.)
        worlds: dict[str, AreaContent | str] = {}
        msbs: dict[str, tp.Any] = {}
        bonfire_models: set[str] = set()
        layout_notes: dict[str, list[str]] = {}
        for index, area in enumerate(areas):
            self.token.stop()
            events.progress(0.03 + 0.02 * index / len(areas), f"{area.name}: reading the map layout and event script")
            try:
                msbs[area.id] = load_msb(profile, area, layout_notes.setdefault(area.id, []))
                worlds[area.id] = extract_area(area, msbs[area.id], root, content, config, bonfire_models, profile)
            except Cancelled:
                raise
            except Exception as error:
                worlds[area.id] = f"the map layout could not be read: {type(error).__name__}: {str(error).strip()[:300]}"
        for area in made_areas:
            world = worlds[area.id]
            if isinstance(world, AreaContent) and world.report["bonfires"]["method"].startswith("fallback") and bonfire_models:
                worlds[area.id] = extract_area(area, msbs[area.id], root, content, config, bonfire_models, profile)
        msbs.clear()

        start, span = 0.05, 0.9
        outs: list[AreaOut] = []
        for index, area in enumerate(made_areas):
            self.token.stop()
            area_start = start + span * index / len(made_areas)
            area_span = span / len(made_areas)
            entry, area_out = self.make_area(
                profile, root, area, worlds[area.id], index, len(made_areas), area_start, area_span, content, config, fmt
            )
            if layout_notes.get(area.id):
                entry["layoutReading"] = layout_notes[area.id]
            report["areas"].append(entry)
            if area_out is not None:
                outs.append(area_out)
            worlds[area.id] = "done"
            gc.collect()

        self.token.stop()
        title = str(config.get("title", detection.title))
        if self.remake:
            assert previous_report is not None
            return self.replace_area(report, previous_report, outs, target, pack_id, title, detection, content, config)
        events.progress(0.96, "Writing the map pack")
        pack = build_pack(pack_id, title, detection.version or "", outs, content, created=previous.get("created"), labels=config)
        duplicates = duplicate_ids(pack)
        if duplicates:
            raise MakeError(
                f"The map pack would have {len(duplicates)} ids used twice, which Atlas refuses "
                f"(first: {duplicates[0]}). Please save the report and send it."
            )
        write_pack_json(self.staging, pack)
        check_3d = None
        if self.builder is not None and any(area.scene for area in outs):
            events.progress(0.97, "Checking the 3D maps")
            check_3d = check_pack(self.builder, self.staging)
            for problem in check_3d.get("problems", [])[:5]:
                self.warn(f"The 3D check found a problem: {problem}")
        installed = False
        if self.maps_folder is not None:
            try:
                install(self.staging, target)
            except PackRefused as error:
                raise MakeError(str(error)) from error
            installed = True
        else:
            if target.exists():
                shutil.rmtree(target)
            self.staging.rename(target)
        self.staging = None
        counts = {name: len(items) for name, items in pack.items() if isinstance(items, list)}
        report["pack"] = {
            "id": pack_id,
            "folder": display_path(target),
            "installed": installed,
            "mapsFolder": display_path(self.maps_folder),
            "counts": counts,
            "tileFormat": fmt,
            "tiles": sum(layer["tiles"]["files"] for area in report["areas"] for layer in area.get("floors", [])),
            "tileBytes": sum(layer["tiles"]["bytes"] for area in report["areas"] for layer in area.get("floors", [])),
            "check3d": check_3d,
        }
        events.emit("pack", folder=str(target), id=pack_id, installed=installed, counts=counts)
        report["summary"] = self.summary(report["areas"])
        return self.finish(report, target)

    # ------------------------------------------------------------------------------------------------------
    # The player's own floor overrides, and making one area again.

    def load_own_overrides(self, game: str) -> None:
        if self.floor_overrides_file is None:
            return
        try:
            self.own_overrides = load_floor_overrides(self.floor_overrides_file, game)
        except FileNotFoundError:
            self.own_overrides = {}
        except (OSError, ValueError) as error:
            self.own_overrides = {}
            self.own_overrides_error = f"{type(error).__name__}: {str(error).strip()[:200]}"
            self.warn(f"Your floor cuts ({self.floor_overrides_file.name}) could not be read ({self.own_overrides_error}): the floors are made as the Map Maker finds them")

    def own_overrides_report(self) -> dict[str, tp.Any]:
        """Which file of the player's own floor overrides was given, and (filled in as areas are made) the areas
        that used it."""
        return {
            "file": self.floor_overrides_file.name if self.floor_overrides_file else None,
            "error": self.own_overrides_error,
            "usedFor": self.used_own,
        }

    def check_remake(self, target: Path) -> dict[str, tp.Any]:
        """Before making an area again: the pack must be there, made by this version of the Map Maker, and the
        report of the make that made it in the output folder. Returns that report."""
        manifest = existing_pack(target)
        if manifest is None:
            raise MakeError(
                f"The map pack is not in {display_path(target)} any more, so its area cannot be made again. Press Make map to make the whole map.",
                code="pack-missing",
            )
        written_by = manifest.get("writtenBy") if isinstance(manifest.get("writtenBy"), dict) else {}
        if written_by.get("name") != WRITER or written_by.get("version") != __version__:
            version = written_by.get("version") or "an unknown version"
            raise MakeError(
                f"The map pack was made by Map Maker {version}, and this is {__version__}. Press Make map to make the whole map again with this version.",
                code="pack-other-version",
            )
        try:
            previous = json.loads((self.out / "report.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = None
        if not isinstance(previous, dict) or previous.get("kind") != "make" or previous.get("toolVersion") != __version__:
            raise MakeError("The report of the last make is missing or from another version. Press Make map to make the whole map again.", code="report-missing")
        if not any(isinstance(a, dict) and a.get("key") == self.remake for a in previous.get("areas", [])):
            raise MakeError(f"The last make did not make {self.remake}. Press Make map to make the whole map again.", code="report-missing")
        return previous

    def replace_area(
        self,
        report: dict[str, tp.Any],
        previous: dict[str, tp.Any],
        outs: list[AreaOut],
        target: Path,
        pack_id: str,
        title: str,
        detection: tp.Any,
        content: GameContent,
        config: dict[str, tp.Any],
    ) -> dict[str, tp.Any]:
        """Puts the area just made in place of its map in the installed pack (see pack.replace_area), and the
        report of the last make, with this area's entry replaced, in place of the report."""
        assert self.staging is not None and self.remake is not None
        key = self.remake
        entry = report["areas"][0]
        if entry.get("skipped"):
            raise MakeError(f"{entry['name']} could not be made again: {entry['skipped']}. The map pack was left as it was.")
        events = self.events
        events.progress(0.95, "Writing the new map of the area")
        manifest = existing_pack(target) or {}
        part = build_pack(pack_id, title, detection.version or "", outs, content, created=manifest.get("created"), labels=config)
        write_pack_json(self.staging, part)
        check_part = None
        if self.builder is not None and any(area.scene for area in outs):
            events.progress(0.96, "Checking the new 3D map")
            check_part = check_pack(self.builder, self.staging)
            for problem in check_part.get("problems", [])[:5]:
                self.warn(f"The 3D check found a problem: {problem}")
        try:
            old = read_pack_json(target)
        except (OSError, ValueError) as error:
            raise MakeError(f"The map pack in {display_path(target)} could not be read ({error}). Press Make map to make the whole map again.", code="pack-missing") from error
        merged = merge_area(old, part, pack_id, key)
        duplicates = duplicate_ids(merged)
        if duplicates:
            raise MakeError(
                f"The map pack would have {len(duplicates)} ids used twice, which Atlas refuses "
                f"(first: {duplicates[0]}). It was left as it was. Please save the report and send it."
            )
        self.token.stop()  # the last moment to stop: from here the pack is changed
        events.progress(0.97, "Putting the new map in the map pack")
        try:
            swap_area(self.staging, target, key, merged)
        except PackRefused as error:
            raise MakeError(str(error)) from error
        shutil.rmtree(self.staging, ignore_errors=True)
        self.staging = None
        check_3d = None
        if self.builder is not None:
            events.progress(0.98, "Checking the 3D maps of the pack")
            check_3d = check_pack(self.builder, target)
            for problem in check_3d.get("problems", [])[:5]:
                self.warn(f"The 3D check found a problem: {problem}")
        self.move_previews(key)

        # The report: the last make's, with this area's entry, warnings and pack counts made new.
        name = entry["name"]
        areas = [entry if isinstance(a, dict) and a.get("key") == key else a for a in previous.get("areas", [])]
        old_warnings = [w for w in previous.get("warnings", []) if isinstance(w, str) and not w.startswith(f"{name}:")]
        options = dict(previous.get("options", {}))
        own = dict(options.get("floorOverrides") or {})
        used = [k for k in own.get("usedFor", []) if k != key] + self.used_own
        options["floorOverrides"] = {**self.own_overrides_report(), "usedFor": sorted(used)}
        options["threeD"] = report["options"]["threeD"]
        options["mapStyle"] = self.style.id
        counts = {name_: len(items) for name_, items in merged.items() if isinstance(items, list)}
        new_report = {
            **previous,
            "toolVersion": __version__,
            "updatedAt": _now(),
            "remade": {"area": key, "name": name, "at": _now(), "check3dOfArea": check_part},
            "options": options,
            "areas": areas,
            "warnings": old_warnings + self.warnings,
        }
        new_report["pack"] = {
            **(previous.get("pack") or {}),
            "id": pack_id,
            "folder": display_path(target),
            "counts": counts,
            "tiles": sum(layer["tiles"]["files"] for area in areas for layer in area.get("floors", [])),
            "tileBytes": sum(layer["tiles"]["bytes"] for area in areas for layer in area.get("floors", [])),
            "check3d": check_3d,
        }
        self.warnings = new_report["warnings"]
        events.emit("pack", folder=str(target), id=pack_id, installed=self.maps_folder is not None, counts=counts, replaced=key, name=name)
        new_report["summary"] = self.summary(areas)
        new_report.pop("elapsedSeconds", None)
        return self.finish(new_report, target)

    def move_previews(self, key: str) -> None:
        """The area's new floor previews in place of its old ones."""
        folder = self.out / "previews"
        for old in folder.glob(f"{key}_f*.png"):
            old.unlink(missing_ok=True)
        if self.preview_dir is not None:
            for new in self.preview_dir.glob("*.png"):
                new.replace(folder / new.name)
            shutil.rmtree(self.preview_dir, ignore_errors=True)
            self.preview_dir = None

    # ------------------------------------------------------------------------------------------------------

    def make_area(
        self,
        profile: GameProfile,
        root: Path,
        area: Area,
        world: AreaContent | str,
        index: int,
        count: int,
        area_start: float,
        area_span: float,
        content: GameContent,
        config: dict[str, tp.Any],
        fmt: str,
    ) -> tuple[dict[str, tp.Any], AreaOut | None]:
        label = f"{area.name} ({index + 1} of {count})"
        key = area.id[:6]
        steps = self.steps
        offsets, total = {}, 0.0
        for step, weight in steps.items():
            offsets[step] = total
            total += weight

        def say(step: str, within: float, text: str) -> None:
            fraction = area_start + area_span * (offsets[step] + steps[step] * min(max(within, 0.0), 1.0))
            self.events.progress(fraction, f"{label}: {text}", area=area.id, step=step)

        started = time.monotonic()
        entry: dict[str, tp.Any] = {"id": area.id, "key": key, "name": area.name}
        say("layout", 0.0, "placing the markers")
        if isinstance(world, str):
            entry["skipped"] = world
            self.warn(f"{area.name}: skipped, {world}")
            self.emit_area(entry, index, count)
            return entry, None
        entry.update(world.report)
        overrides, source = chosen_floor_overrides(config, self.own_overrides, area.id)
        method = floor_method(config, overrides, self.floor_method)

        # Geometry: every collision file, else the navmesh. Automatic passages also read the navmesh beside the
        # collision (passages.py keeps it where collision ground lies under it).
        geometry: dict[str, tp.Any] = {}
        mesh = np.zeros((0, 3, 3), dtype=np.float32)
        nav: np.ndarray | None = None
        owners = np.zeros(0, dtype=np.int32)
        owner_names: list[str] = []
        used = None
        for source_kind in ("collision", "navmesh"):
            self.token.stop()
            if used is not None and method != "passages":
                break

            def told(within: float, text: str) -> None:
                say("geometry", within, text)

            told(0.0, f"reading {source_kind}")
            job = SourceJob(
                source_kind,
                profile.game,
                area,
                root,
                world.instances,
                sample=0,
                budget=0.0,
                preview_limit=0,
                part_names=world.part_names,
            )
            try:
                result, triangles = self.runner.run(job, told, self.token)
            except Cancelled:
                raise
            except Exception as error:
                result, triangles = SourceResult(source_kind, status="failed"), None
                result.add_error(error)
            geometry[source_kind] = source_summary(result)
            if result.status == "timed-out":
                self.warn(f"{area.name}: reading {source_kind} was stopped after {result.time_limit:g} s ({result.stopped_on})")
            if triangles is None or not len(triangles):
                continue
            triangles = np.asarray(triangles, dtype=np.float32)
            if source_kind == "navmesh" and profile.navmesh_kind == "hkx":
                triangles, geometry["navmeshPlacement"] = place_navmesh(
                    triangles, mesh if used else None, world, config
                )
            if used is None:
                mesh = triangles
                owners = result.owners_array()
                owner_names = list(result.owner_names)
                used = source_kind
            else:
                nav = triangles
        entry["geometry"] = {"used": used, "navmeshForPassages": nav is not None, **geometry}
        if used is None:
            self.warn(f"{area.name}: no collision or navmesh could be read; the map shows markers only")
        # The pieces the player removed in Adjust floors (pieces.py) are left out of the floors, the pictures and the
        # 3D model; the floor data keeps every triangle, so that the panel can put them back.
        every_triangle, every_owner = mesh, owners
        removed = removed_of(overrides)
        if removed:
            mesh, owners, entry["removedPieces"] = leave_out(mesh, owners, owner_names, removed)

        # The game's own models, with their textures and materials (models.py).
        textured: TexturedMesh | None = None
        models_reason: str | None = None
        if self.want_models:
            textured, entry["models"], models_reason = self.read_models(profile, root, area, world, key, say)
            if removed and textured is not None:
                textured, entry["removedPieces"]["modelTriangles"] = leave_out_of_models(textured, removed)

        # Floors.
        self.token.stop()
        say("floors", 0.0, f"finding floors in {len(mesh):,} triangles")
        if source == "yours":
            self.used_own.append(key)
        shipped = floor_overrides(config, area.id)
        plan = find_floors(mesh, nav, config, overrides, method)
        if method == "passages":
            describe_passages(plan, overrides, source, shipped)
        else:
            describe_cuts(plan, overrides, source, shipped)
        if used == "collision" and len(owners) == len(mesh):
            entry["placement"] = placement_check(mesh, owners, owner_names, world, config)

        # Markers onto floors, and their place names.
        walk_index = np.flatnonzero(plan.walkable)
        floor_count = max(len(plan.floors), 1)
        not_on_floor = []
        place_names: dict[int, str] = {}
        for marker in world.markers:
            x, y, z = marker.position
            placement = locate(plan, x, y, z)
            marker.floor = min(placement.floor, floor_count - 1)
            marker.on_floor = placement.on_floor
            if placement.triangle is not None and len(owners) == len(mesh):
                part = owner_names[int(owners[walk_index[placement.triangle]])]
                collision = world.collisions.get(part)
                if collision is not None and collision.place_id >= 0:
                    marker.place_id = collision.place_id
                    name = content.place_name(collision.place_id)
                    if name:
                        place_names[collision.place_id] = name
            if not marker.on_floor:
                not_on_floor.append({"key": marker.key, "category": marker.category, "height": round(y, 1)})

        # Frame and pictures.
        walk_xz = mesh[plan.walkable][:, :, [0, 2]].reshape(-1, 2) if len(mesh) else np.zeros((0, 2))
        marker_xz = np.array([[m.position[0], m.position[2]] for m in world.markers], dtype=np.float64).reshape(-1, 2)
        render_settings = config.get("render", {})
        frame = make_frame(walk_xz, marker_xz, render_settings)
        pixels = frame.to_pixels(marker_xz) if len(marker_xz) else np.zeros((0, 2))
        for marker, (px, py) in zip(world.markers, pixels):
            marker.pixel = (float(px), float(py))
        if plan.method == "passages":
            main = min(plan.main, max(len(plan.floors) - 1, 0))
        elif plan.floors:
            main = max(plan.floors, key=lambda f: f.area).index
        else:
            main = 0
        floors = plan.floors or [_empty_floor()]
        names = floor_names(floors, main, overrides.get("names") if isinstance(overrides.get("names"), list) else None)
        for floor, name in zip(floors, names):
            floor.name = name

        say("render", 0.0, "drawing the floors")
        heights = mesh[plan.walkable][:, :, 1] if len(mesh) else np.zeros((0, 3))
        low, high = (np.percentile(heights, [2, 98]) if len(heights) else (0.0, 1.0))
        tile_size = int(render_settings.get("tileSize", 256))
        quality = int(render_settings.get("tileQuality", 85))
        opacity = float(render_settings.get("lowerFloorOpacity", 0.4))
        if len(every_triangle):
            # For the Adjust floors panel (floorviews.py): kept in the output folder, never in the report zip.
            save_floor_data(
                self.out,
                key,
                area.name,
                every_triangle,
                plan,
                [(m.position, m.category) for m in world.markers],
                config.get("floors"),
                (float(low), float(high)),
                shipped,
                opacity,
                nav=nav,
                method=method,
                owners=every_owner,
                owner_names=owner_names,
            )
        layers_out: list[LayerOut] = []
        floor_entries = []
        assert self.staging is not None
        style = self.style
        fills: list[Path] | None = None
        if style.textured:
            why = f"the game's models could not be read ({models_reason or 'not read'})"
            if textured is not None and is_usable(textured):
                say("render", 0.0, "drawing the floors from the game's models")
                fills, why = self.draw_textured(key, textured, plan, frame, mesh, len(floors), say)
            if fills is None:
                style = fallback_style(self.style)
                entry["mapStyleNote"] = f"drawn {style.label.lower()}: {why}"
                self.warn(f"{area.name}: {entry['mapStyleNote']}")

        def layers() -> tp.Iterator[tuple[int, tp.Any]]:
            for floor in floors:
                chosen = np.flatnonzero(plan.triangle_floor == floor.index) if len(mesh) else np.zeros(0, dtype=np.int64)
                tris = mesh[chosen]
                walls = plan.wall_lines[floor.index] if floor.index < len(plan.wall_lines) else np.zeros((0, 2, 2))
                fill = None
                if fills is not None and floor.index < len(fills):
                    from PIL import Image

                    with Image.open(fills[floor.index]) as drawn:
                        fill = drawn.convert("RGBA")
                yield floor.index, draw_floor(
                    frame,
                    style,
                    tris,
                    walls,
                    index=floor.index,
                    floor_range=(floor.low, floor.high),
                    area_range=(float(low), float(high)),
                    flipped=plan.flipped,
                    fill=fill,
                )

        pictures = compose(frame, layers(), opacity)
        for done, (floor_index, picture) in enumerate(pictures):
            self.token.stop()
            floor = floors[floor_index]
            say("render", done / len(floors), f"cutting {floor.name} into tiles")
            folder = self.staging / "tiles" / key / f"f{floor_index}"
            tiles = write_pyramid(
                picture,
                folder,
                tile_size=tile_size,
                fmt=fmt,
                quality=quality,
                background=BACKGROUND,
                stop=self.token.stop,
            )
            dots = [(m.pixel[0], m.pixel[1], m.category) for m in world.markers if m.floor == floor_index and m.pixel]
            preview = f"previews/{key}_f{floor_index}.png"
            preview_folder = self.preview_dir if self.preview_dir is not None else self.out / "previews"
            (preview_folder / f"{key}_f{floor_index}.png").write_bytes(preview_png(picture, frame, dots))
            layers_out.append(LayerOut(floor, tiles, f"tiles/{key}/f{floor_index}/{{z}}/{{x}}/{{y}}.{fmt}"))
            on_this = [m for m in world.markers if m.floor == floor_index]
            floor_entries.append(
                {
                    "index": floor_index,
                    "name": floor.name,
                    "heights": [round(floor.low, 1), round(floor.high, 1)],
                    # Between the cuts below and above it (None: no cut on that side).
                    "between": [
                        round(plan.cuts[floor_index - 1], 2) if 0 < floor_index <= len(plan.cuts) else None,
                        round(plan.cuts[floor_index], 2) if floor_index < len(plan.cuts) else None,
                    ],
                    "areaSquareMetres": round(floor.area),
                    "triangles": floor.triangles,
                    "wallLines": int(len(plan.wall_lines[floor_index])) if floor_index < len(plan.wall_lines) else 0,
                    "markers": dict(sorted(Counter(m.category for m in on_this).items())),
                    "tiles": tiles,
                    "preview": preview,
                }
            )
            del picture

        # The 3D model.
        scene = None
        heights = None
        if self.builder is not None:
            scene, heights, entry["scene"] = self.make_scene(
                area, key, mesh, owners, owner_names, plan, float(low), float(high), config, not_on_floor, say,
                textured, models_reason,
            )
        elif self.make_3d:
            entry["scene"] = {"made": False, "reason": "the 3D builder is missing"}

        by_category = Counter(m.category for m in world.markers)
        entry["frame"] = frame.to_report()
        entry["floorPlan"] = plan.report
        entry["mapStyle"] = style.id
        if style.id != self.style.id:
            entry["mapStyleAsked"] = self.style.id
        entry["mainFloor"] = main
        entry["floors"] = floor_entries
        entry["markers"] = {
            "total": len(world.markers),
            "byCategory": dict(sorted(by_category.items())),
            "notOnFloor": len(not_on_floor),
            "notOnFloorList": not_on_floor[:40],
            "withFlag": sum(1 for m in world.markers if m.flag),
            "placeNames": len(place_names),
        }
        entry["seconds"] = round(time.monotonic() - started, 1)
        if textured is not None:
            shutil.rmtree(textured.folder, ignore_errors=True)
            del textured
        self.emit_area(entry, index, count)
        area_out = AreaOut(key, area.id, area.name, frame, layers_out, main, world.markers, place_names, scene, heights)
        return entry, area_out

    def draw_textured(
        self,
        key: str,
        textured: TexturedMesh,
        plan: tp.Any,
        frame: tp.Any,
        collision: np.ndarray,
        count: int,
        say: tp.Callable[[str, float, str], None],
    ) -> tuple[list[Path] | None, str]:
        """Each floor drawn from above from the game's models, by the builder (`atlas-scene draw`, see textured.py):
        the pictures, lowest floor first; or None and why not."""
        if self.drawer is None:
            return None, "the 3D builder (atlas-scene) that draws them is missing"
        work = textured.folder
        try:
            glb = self.textured_glb(textured)
            floors = triangle_floors(textured, plan, frame, collision, self.token.stop)[textured_order(textured)]
            floors.astype("<i2").tofile(work / "floors.bin")
        except OSError as error:
            return None, f"the floors of the models could not be written ({type(error).__name__}: {error})"
        except BuilderFailed as error:
            return None, str(error)
        job = {
            "input": str(glb.resolve()),
            "output": "drawn",
            "options": {"axes": SCENE_AXES, "maxTriangles": len(textured) + 1},
            "frame": {"xMin": frame.x_min, "zMax": frame.z_max, "scale": frame.scale, "width": frame.width, "height": frame.height},
            "floors": "floors.bin",
            "count": count,
        }
        try:
            done = run_builder(
                self.drawer, job, work, "draw", lambda fraction, text: say("render", 0.0, "drawing the floors from the game's models"),
                self.token.stop, command="draw",
            )
        except BuilderFailed as error:
            return None, f"the floors could not be drawn from the game's models ({error})"
        files = [work / "drawn" / str(name) for name in done.get("files", [])]
        if len(files) != count or not all(f.is_file() for f in files):
            return None, "the builder drew no picture of some floors"
        return files, ""

    def textured_glb(self, textured: TexturedMesh) -> Path:
        """The game's models as a raw glTF binary file (scene.write_textured_glb), written once into their work
        folder, for drawing the floors and for the 3D map."""
        glb = textured.folder / "models.glb"
        if not glb.is_file():
            try:
                write_textured_glb(textured, glb)
            except OSError as error:
                glb.unlink(missing_ok=True)
                raise BuilderFailed(f"the game's models could not be written ({type(error).__name__}: {error})") from error
        return glb

    def read_models(
        self,
        profile: GameProfile,
        root: Path,
        area: Area,
        world: AreaContent,
        key: str,
        say: tp.Callable[[str, float, str], None],
    ) -> tuple[TexturedMesh | None, dict[str, tp.Any], str | None]:
        """The area's visible models with their textures, read in the file reader process (models.py): the mesh
        (None when nothing could be read), the report entry, and why there is none."""
        self.token.stop()
        say("models", 0.0, "reading the game's models and textures")
        work = self.out / SCENE_WORK / f"{key.lower()}-models"
        shutil.rmtree(work, ignore_errors=True)
        work.parent.mkdir(parents=True, exist_ok=True)
        job = SourceJob(
            "models",
            profile.game,
            area,
            root,
            {},
            preview_limit=0,
            part_names=world.piece_names,
            pieces=world.pieces,
            output=str(work),
            time_limit=MODELS_TIME_LIMIT,
        )
        try:
            result, _ = self.runner.run(job, lambda within, text: say("models", within, text), self.token)
        except Cancelled:
            raise
        except Exception as error:
            result = SourceResult("models", status="failed")
            result.add_error(error)
        entry = {**source_summary(result), **result.data}
        mesh: TexturedMesh | None = None
        reason: str | None = None
        if result.status in ("ok", "partial") and (work / "models.npz").is_file():
            try:
                mesh = load_mesh(work)
            except (OSError, ValueError, KeyError) as error:
                reason = f"what was read could not be loaded ({type(error).__name__}: {error})"
        if mesh is not None and not is_usable(mesh):
            mesh = None
            reason = "no triangle of the models could be placed"
        if mesh is None:
            shutil.rmtree(work, ignore_errors=True)
            if reason is None:
                if result.status == "timed-out":
                    reason = f"reading them was stopped after {result.time_limit:g} s"
                elif result.status == "missing":
                    reason = result.note or "none were found"
                else:
                    reason = (result.errors[0] if result.errors else None) or result.note or f"reading them {result.status}"
            entry["reason"] = reason
        else:
            entry["summary"] = models_summary(result.data)
        return mesh, entry, reason

    def make_scene(
        self,
        area: Area,
        key: str,
        mesh: np.ndarray,
        owners: np.ndarray,
        owner_names: list[str],
        plan: tp.Any,
        low: float,
        high: float,
        config: dict[str, tp.Any],
        not_on_floor: list[dict[str, tp.Any]],
        say: tp.Callable[[str, float, str], None],
        textured: TexturedMesh | None = None,
        models_reason: str | None = None,
    ) -> tuple[dict[str, tp.Any] | None, list[list[float]] | None, dict[str, tp.Any]]:
        """The area's 3D model, through the scene builder: its scene, its floors' heights (None without storeys)
        and its report entry. With the 3D look "Game models", from the game's models and their textures (textures
        kept at their own size at the finest level); when those cannot be read or built, from the collision, and
        the entry says why (`lookNote`). A model that cannot be made leaves the area in 2D, with a warning."""
        assert self.builder is not None and self.staging is not None
        started = time.monotonic()
        settings = config.get("scene", {}) if isinstance(config.get("scene"), dict) else {}
        entry: dict[str, tp.Any] = {"made": False, "trianglesBefore": int(len(mesh))}
        done: dict[str, tp.Any] | None = None
        note: str | None = None
        look = "collision"
        if self.look_3d == "models":
            if textured is not None and is_usable(textured):
                model_settings = settings.get("models") if isinstance(settings.get("models"), dict) else {}
                say("scene", 0.0, f"making the 3D model of the game's models, {len(textured):,} triangles")
                try:
                    done = self.run_scene(
                        key, model_settings, None, say, {"textures": {"mode": "keep"}}, raw_file=self.textured_glb(textured)
                    )
                    look = "models"
                    entry["trianglesBefore"] = int(len(textured))
                except BuilderFailed as error:
                    note = f"the 3D model of the game's models could not be made ({error})"
            else:
                note = f"the game's models could not be read ({models_reason or 'not read'})"
        if done is None:
            if not len(mesh):
                entry["reason"] = "no geometry was read"
                return None, None, entry
            if note:
                entry["lookNote"] = note
                self.warn(f"{area.name}: the 3D map shows the collision: {note}")
            say("scene", 0.0, f"making the 3D model of {len(mesh):,} triangles")

            def write_collision(raw: Path) -> None:
                colours = corner_colours(mesh, low, high, plan.flipped)
                raw.write_bytes(raw_glb(mesh, colours, owners, owner_names, plan.flipped))

            try:
                done = self.run_scene(key, settings, write_collision, say)
            except BuilderFailed as error:
                entry["reason"] = str(error)
                self.warn(f"{area.name}: the 3D model was not made ({error}); the map stays 2D")
                return None, None, entry
        built = done.get("report", {})
        scene = done.get("scene")
        if plan.method == "passages":
            heights = [list(h) for h in plan.heights] if plan.heights and len(plan.heights) >= 2 else None
        else:
            ys = [float(mesh[:, :, 1].min()), float(mesh[:, :, 1].max())] if len(mesh) else []
            if look == "models" and textured is not None:
                ys += [float(textured.triangles[:, :, 1].min()), float(textured.triangles[:, :, 1].max())]
            heights = floor_heights(plan.cuts, len(plan.floors), min(ys), max(ys)) if ys else None
        entry.update(
            {
                "made": True,
                "look": look,
                "trianglesAfter": built.get("triangles"),
                "trianglesDropped": built.get("trianglesDropped"),
                "trianglesCleaned": built.get("trianglesCleaned"),
                "levels": built.get("levels"),
                "cells": built.get("cells"),
                "cellSize": built.get("cellSize"),
                "files": built.get("files"),
                "bytes": built.get("bytes"),
                "builderSeconds": built.get("seconds"),
                "seconds": round(time.monotonic() - started, 1),
                "floors": heights,
                "noSurfaceUnder": len(not_on_floor),
                "noSurfaceUnderList": [item["key"] for item in not_on_floor[:40]],
                "warnings": built.get("warnings", []),
            }
        )
        if look == "models":
            entry["textures"] = {
                "kept": built.get("texturesKept"),
                "leftOut": built.get("texturesLeftOut"),
                "bytes": built.get("textureBytes"),
                "largestCellBytes": max((c.get("bytes", 0) for c in built.get("cellTextures", []) if c.get("level") == 0), default=0),
            }
        return scene, heights, entry

    def run_scene(
        self,
        key: str,
        settings: dict[str, tp.Any],
        write_raw: tp.Callable[[Path], tp.Any] | None,
        say: tp.Callable[[str, float, str], None],
        extra: dict[str, tp.Any] | None = None,
        raw_file: Path | None = None,
    ) -> dict[str, tp.Any]:
        """Writes the raw model with `write_raw` (or takes `raw_file`, written already and left in place) and builds
        it into the pack's `scene/<area>/`; the builder's `done` line. BuilderFailed when it cannot."""
        assert self.builder is not None and self.staging is not None
        work = self.out / SCENE_WORK
        work.mkdir(exist_ok=True)
        raw = work / f"{key}.glb"
        try:
            if raw_file is None:
                assert write_raw is not None
                write_raw(raw)
            options: dict[str, tp.Any] = {
                "folder": f"scene/{key.lower()}",
                "axes": SCENE_AXES,
                "drop": [str(p) for p in settings.get("drop", []) if isinstance(p, str)],
                **(extra or {}),
            }
            for name in ("cellSize", "cellTriangles", "levels", "creaseAngle", "sky"):
                if name in settings:
                    options[name] = settings[name]
            if isinstance(settings.get("textures"), dict) and "textures" in options:
                options["textures"] = {**options["textures"], **settings["textures"], "mode": "keep"}
            job = {"input": str(raw_file.resolve()) if raw_file is not None else raw.name, "pack": str(self.staging.resolve()), "options": options}
            return run_builder(
                self.builder,
                job,
                work,
                key,
                lambda fraction, text: say("scene", fraction, f"3D model: {text}"),
                self.token.stop,
            )
        except OSError as error:
            raise BuilderFailed(f"the raw model could not be written ({type(error).__name__}: {error})") from error
        finally:
            for leftover in (raw, work / f"{key}.job.json"):
                leftover.unlink(missing_ok=True)

    def emit_area(self, entry: dict[str, tp.Any], index: int, count: int) -> None:
        geometry = entry.get("geometry", {})
        self.events.emit(
            "area",
            id=entry["id"],
            name=entry["name"],
            index=index,
            count=count,
            geometry={k: v.get("status") for k, v in geometry.items() if isinstance(v, dict)},
            used=geometry.get("used"),
            floors=len(entry.get("floors", [])),
            markers=entry.get("markers", {}).get("total", 0),
            skipped=entry.get("skipped"),
            scene=entry["scene"].get("made") if isinstance(entry.get("scene"), dict) else None,
        )

    def summary(self, areas: list[dict[str, tp.Any]]) -> dict[str, tp.Any]:
        made = [a for a in areas if not a.get("skipped")]
        categories: Counter[str] = Counter()
        for area in made:
            categories.update(area.get("markers", {}).get("byCategory", {}))
        return {
            "areas": len(areas),
            "areasMade": len(made),
            "areasSkipped": [a["id"] for a in areas if a.get("skipped")],
            "floors": sum(len(a.get("floors", [])) for a in made),
            "markers": sum(a.get("markers", {}).get("total", 0) for a in made),
            "markersByCategory": dict(sorted(categories.items())),
            "notOnFloor": sum(a.get("markers", {}).get("notOnFloor", 0) for a in made),
            "geometry": dict(Counter(a.get("geometry", {}).get("used") or "none" for a in made)),
            "threeD": scene_summary(made),
        }

    def diagnostics(self) -> dict[str, tp.Any]:
        system = sys.platform
        if sys.platform == "win32":
            version = sys.getwindowsversion()
            system = f"Windows {version.major}.{version.minor} build {version.build}"
        return {
            "frozen": bool(getattr(sys, "frozen", False)),
            "python": sys.version.split()[0],
            "helperVersion": __version__,
            "system": system,
            "tempDir": display_path(Path(tempfile.gettempdir())),
            "soulstructImportSeconds": round(self.import_seconds, 2) if self.import_seconds is not None else None,
            "reader": self.runner.diagnostics(),
        }

    def finish(self, report: dict[str, tp.Any], target: Path) -> dict[str, tp.Any]:
        shutil.rmtree(self.out / SCENE_WORK, ignore_errors=True)
        report["elapsedSeconds"] = round(time.monotonic() - self.started, 1)
        self.runner.close()
        report["diagnostics"] = self.diagnostics()
        self.events.progress(0.99, "Writing the report")
        report_path = self.out / "report.json"
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        zip_path = self.out / ZIP_NAME
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(report_path, "report.json")
            for area in report["areas"]:
                for floor in area.get("floors", []):
                    path = self.out / floor["preview"]
                    if path.is_file():
                        archive.write(path, floor["preview"])
            log = self.out / READER_LOG
            if log.is_file():
                data = log.read_bytes()
                if len(data) > LOG_LIMIT:
                    data = b"(earlier lines left out)\n" + data[-LOG_LIMIT:]
                archive.writestr(READER_LOG, clean_text(data.decode("utf-8", "replace")))
            archive.writestr("README.txt", README_TEXT)
        self.events.emit(
            "done",
            report=str(report_path),
            zip=str(zip_path),
            pack=str(target),
            game=report["game"],
            summary=report["summary"],
            warnings=len(self.warnings),
        )
        return report


def describe_cuts(plan: tp.Any, overrides: dict[str, tp.Any], source: str | None, shipped: dict[str, tp.Any]) -> None:
    """Adds to the floor plan's report what the Adjust floors panel shows: each cut and who set it (`automatic`, or
    `yours` or `shipped` for an override), the override used, and what the area has without the player's own
    (the shipped config over the automatic cuts), which "Back to automatic" returns to."""
    report = plan.report
    auto = [float(note["height"]) for note in report.get("automaticCuts", [])]
    replaced = isinstance(overrides.get("cuts"), list)
    cut_list = []
    for cut in plan.cuts:
        automatic = source is None or (not replaced and any(abs(cut - a) <= 0.011 for a in auto))
        cut_list.append({"height": round(cut, 2), "by": "automatic" if automatic else source})
    report["cutList"] = cut_list
    report["overrides"] = {"from": source, **overrides} if source else None
    shipped_names = shipped.get("names") if isinstance(shipped.get("names"), list) else None
    report["shipped"] = {
        "cuts": [round(c, 2) for c in apply_overrides(list(auto), shipped)],
        "names": [str(n) for n in shipped_names] if shipped_names else None,
    }


def find_floors(
    mesh: np.ndarray,
    nav: np.ndarray | None,
    config: dict[str, tp.Any],
    overrides: dict[str, tp.Any],
    method: str,
    prepared: Prepared | None = None,
) -> FloorPlan:
    """An area's floors by cut heights (floors.py) or automatic passages (passages.py)."""
    prepared = prepared if prepared is not None else prepare(mesh, config.get("floors"))
    if method == "passages":
        return plan_passages(prepare_passages(prepared, nav, config.get("floors")), overrides=overrides)
    return plan_floors(prepared, overrides=overrides)


def describe_passages(plan: tp.Any, overrides: dict[str, tp.Any], source: str | None, shipped: dict[str, tp.Any]) -> None:
    """As describe_cuts, for automatic passages: the override used, and what the area has without the player's own
    (the shipped config's choices)."""
    report = plan.report
    report["cutList"] = []
    report["overrides"] = {"from": source, **overrides} if source else None
    shipped_names = shipped.get("names") if isinstance(shipped.get("names"), list) else None
    report["shipped"] = {
        "cuts": [],
        "names": [str(n) for n in shipped_names] if shipped_names else None,
        "passages": [p for p in shipped.get("passages", []) if isinstance(p, dict)] if isinstance(shipped.get("passages"), list) else [],
    }


def map_offset_transform(offset: dict[str, tp.Any], inverse: bool = False) -> tp.Callable[[np.ndarray], np.ndarray]:
    """The map's offset (its MSB MapOffset event: a move and a turn about the vertical) as a function on (n, 3, 3)
    triangles, or its inverse."""
    move = np.asarray(offset.get("translate", (0.0, 0.0, 0.0)), dtype=np.float64)
    turn = rotation_matrix((0.0, float(offset.get("rotateY", 0.0)), 0.0))

    def apply(triangles: np.ndarray) -> np.ndarray:
        points = triangles.reshape(-1, 3).astype(np.float64)
        moved = (points - move) @ turn if inverse else points @ turn.T + move
        return moved.reshape(-1, 3, 3).astype(np.float32)

    return apply


def place_navmesh(
    nav: np.ndarray, collision: np.ndarray | None, world: AreaContent, config: dict[str, tp.Any]
) -> tuple[np.ndarray, dict[str, tp.Any]]:
    """Bloodborne's navmesh, placed by its table, then by the map's offset or not (config `navmesh.applyMapOffset`:
    true, false or auto). Auto tries the navmesh as placed, with the offset and with its inverse, and keeps the way
    that puts the most navmesh on collision ground (or, without collision, the most bonfires and pickups on the
    navmesh)."""
    offset = world.report.get("mapOffset")
    setting = (config.get("navmesh") or {}).get("applyMapOffset", "auto")
    info: dict[str, tp.Any] = {"mapOffset": offset, "setting": setting}
    still = not offset or not any(abs(v) > 1e-4 for v in [*offset.get("translate", ()), offset.get("rotateY", 0.0)])
    if still or setting is False:
        info["chosen"] = "as placed"
        return nav, info
    ways = {"as placed": nav, "with the map offset": map_offset_transform(offset)(nav)}
    if setting is True:
        info["chosen"] = "with the map offset"
        return ways["with the map offset"], info
    ways["with the inverse map offset"] = map_offset_transform(offset, inverse=True)(nav)
    scores: dict[str, float | None] = {}
    if collision is not None and len(collision):
        prepared = prepare(collision, config.get("floors"))
        step = max(1, len(nav) // 4000)
        reach = float((config.get("floors") or {}).get("navSupport", 1.2))
        for name, triangles in ways.items():
            scores[name] = round(float(support_navmesh(prepared, triangles[::step], reach).mean()), 3)
    else:
        points = np.array([m.position for m in world.markers if m.kind in ("bonfire", "item")], dtype=np.float64)
        for name, triangles in ways.items():
            value = support_fraction(triangles, points.reshape(-1, 3), config.get("floors"))
            scores[name] = None if value is None else round(value, 3)
    info["scores"] = scores
    chosen = max(ways, key=lambda name: (scores.get(name) or 0.0, name == "as placed"))
    info["chosen"] = chosen
    return ways[chosen], info


def scene_summary(areas: list[dict[str, tp.Any]]) -> dict[str, tp.Any] | None:
    """The 3D side of a make, over all areas: None when 3D maps were off."""
    scenes = [a["scene"] for a in areas if isinstance(a.get("scene"), dict)]
    if not scenes:
        return None
    made = [s for s in scenes if s.get("made")]
    return {
        "areasMade": len(made),
        "areasNotMade": len(scenes) - len(made),
        "trianglesBefore": sum(s.get("trianglesBefore", 0) for s in made),
        "trianglesAfter": sum(s.get("trianglesAfter") or 0 for s in made),
        "cells": sum(s.get("cells") or 0 for s in made),
        "files": sum(s.get("files") or 0 for s in made),
        "bytes": sum(s.get("bytes") or 0 for s in made),
        "seconds": round(sum(s.get("seconds") or 0 for s in made), 1),
        "noSurfaceUnder": sum(s.get("noSurfaceUnder") or 0 for s in made),
        "looks": dict(Counter(s.get("look", "collision") for s in made)),
    }


def _empty_floor():
    from .floors import Floor

    return Floor(0, 0.0, 0.0, 0.0, 0)


def source_summary(result: SourceResult) -> dict[str, tp.Any]:
    data = result.to_dict()
    data.pop("files", None)
    return data


def placement_check(
    mesh: np.ndarray, owners: np.ndarray, owner_names: list[str], world: AreaContent, config: dict[str, tp.Any]
) -> dict[str, tp.Any]:
    """Are collision meshes stored in the area's coordinates, or must each be moved by its MSB collision part?
    The map places them by their parts. When some parts are moved or turned, this also tries the meshes as stored
    and counts, both ways, how many bonfires and pickups have walkable floor just below them: the right way is the
    one where nearly all do."""
    moved = world.report.get("collisionParts", {}).get("movedOrTurned", 0)
    points = np.array([m.position for m in world.markers if m.kind in ("bonfire", "item")], dtype=np.float64).reshape(-1, 3)
    data: dict[str, tp.Any] = {
        "method": "each collision mesh is moved and turned by the MSB collision part that places it",
        "collisionPartsMovedOrTurned": moved,
        "markersChecked": int(len(points)),
    }
    placed = support_fraction(mesh, points, config.get("floors"))
    data["markersOnFloorAsPlaced"] = None if placed is None else round(placed, 3)
    if moved:
        raw = mesh.copy()
        for index, name in enumerate(owner_names):
            part = world.collisions.get(name)
            if part is None:
                continue
            chosen = owners == index
            if not chosen.any() or not any(abs(v) > 1e-4 for v in part.position + part.rotation):
                continue
            matrix = rotation_matrix(part.rotation)
            local = (mesh[chosen].reshape(-1, 3).astype(np.float64) - np.asarray(part.position)) @ matrix
            raw[chosen] = local.reshape(-1, 3, 3).astype(np.float32)
        stored = support_fraction(raw, points, config.get("floors"))
        data["markersOnFloorAsStored"] = None if stored is None else round(stored, 3)
        if placed is not None and stored is not None:
            data["verdict"] = (
                "placed by part (as the map does)" if placed >= stored else "as stored in the files (the map is wrong)"
            )
    else:
        data["verdict"] = "no collision part is moved or turned, so both ways are the same"
    return data


README_TEXT = f"""Atlas Map Maker: make map report

report.json says how the map pack was made from the game folder: per area, the geometry read, the floors found
(height ranges, area, wall lines, the cut heights between them and who set each: automatic, the Map Maker's
settings, or your own floor cuts, and how much walkable floor there is at each height), the markers by category and those not standing on a floor, the bonfire,
treasure and character counts, how the collision meshes were placed (placement), and its 3D model (scene:
triangles before and after, cells, levels of detail, file sizes, time taken, markers with no surface under them). previews/ holds a small
picture of each floor with a dot per marker. {READER_LOG} is the log of the file reader process.

It holds no game files and no game text: only counts, ids, heights, file names and error messages. The map pack
itself stays on this PC.
"""
