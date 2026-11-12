"""`make`: make an Atlas map pack from the game files, and a report of how it went.

For each real area (debug maps skipped): read the map layout and the event script (markers, see world.py), read
every collision file in the file reader process (the navmesh when there is no collision), find the floors
(floors.py), draw each floor and cut it into tiles (render.py, tiles.py), and put each marker on its floor. Then
write the pack (pack.py) into the shared maps folder, where Atlas finds it, and the report.

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
from .config import area_config, floor_overrides, is_skipped, load_config
from .content import GameContent, read_content
from .detect import DSR, detect
from .events import Events
from .floors import locate, plan_floors, support_fraction
from .games import PROFILES, Area, GameProfile, list_areas, newest_versions
from .geometry import Cancelled, SourceResult, rotation_matrix
from .msb import load_msb
from .pack import (
    AreaOut,
    LayerOut,
    PackRefused,
    build_pack,
    check_target,
    duplicate_ids,
    existing_pack,
    floor_names,
    install,
    write_pack_json,
)
from .render import BACKGROUND, compose, draw_layer, make_frame, preview_png, triangle_colours
from .safety import UnsafeOutputError, check_output_folder, is_inside, prepare_soulstruct
from .tiles import tile_format, write_pyramid
from .worker import READER_LOG, ProcessRunner, Runner, SourceJob, clean_text
from .world import AreaContent, extract_area

ZIP_NAME = "atlas-make-report.zip"
LOG_LIMIT = 200_000
TIME_LIMIT = 300.0  # seconds one area's geometry may take in the file reader
# Share of an area's progress for each step.
STEPS = {"layout": 0.05, "geometry": 0.45, "floors": 0.1, "render": 0.4}


class MakeError(Exception):
    """The map cannot be made; the message says why, for the player."""


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

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        self.events.warning(message)

    def run(self) -> dict[str, tp.Any]:
        try:
            return self._run()
        except BaseException:
            if self.staging is not None and self.staging.name.startswith("."):
                shutil.rmtree(self.staging, ignore_errors=True)
            raise
        finally:
            self.runner.close()

    # ------------------------------------------------------------------------------------------------------

    def _run(self) -> dict[str, tp.Any]:
        events = self.events
        events.emit("start", tool=TOOL_NAME, version=__version__, folder=display_path(self.folder), mode="make")
        events.progress(0.0, "Looking at the folder")
        detection = detect(self.folder)
        events.emit("game", game=game_dict(detection))
        if not detection.supported or detection.root is None:
            raise MakeError(detection.reason or f"{detection.title} is not supported.")
        if detection.game != DSR:
            raise MakeError(f"Making maps of {detection.title} comes in a later version. Check game files works.")
        root = detection.root
        check_output_folder(self.out, root)
        if self.maps_folder is not None:
            check_output_folder(self.maps_folder, root)
            if is_inside(self.maps_folder, self.out) or is_inside(self.out, self.maps_folder):
                raise UnsafeOutputError("The maps folder and the output folder must be apart.")
        self.out.mkdir(parents=True, exist_ok=True)
        self.runner.use_folder(self.out)
        (self.out / "previews").mkdir(exist_ok=True)

        events.progress(0.01, "Loading the file readers")
        importing = time.monotonic()
        prepare_soulstruct()
        self.import_seconds = time.monotonic() - importing
        profile = PROFILES[detection.game]
        config = load_config(detection.game, self.config_file)
        pack_id = str(config.get("packId", detection.game))
        render_settings = dict(config.get("render", {}))
        fmt = tile_format(str(render_settings.get("tileFormat", "webp")))

        # Where the pack goes: refuse early, before any work, when the place is taken by a pack not ours.
        if self.maps_folder is not None:
            self.maps_folder.mkdir(parents=True, exist_ok=True)
            target = self.maps_folder / pack_id
            self.staging = self.maps_folder / f".{pack_id}.making"
        else:
            target = self.out / "pack" / pack_id
            self.staging = self.out / "pack" / f".{pack_id}.making"
        refusal = check_target(target)
        if refusal:
            raise MakeError(refusal)
        previous = existing_pack(target) or {}
        if self.staging.exists():
            shutil.rmtree(self.staging)
        self.staging.mkdir(parents=True)

        all_areas = list_areas(profile, root)
        skipped = [a.id for a in all_areas if is_skipped(config, a.id)]
        areas = [a for a in all_areas if not is_skipped(config, a.id)]
        areas, older = newest_versions(areas)
        skipped += older
        if self.only_areas:
            areas = [a for a in areas if a.id in self.only_areas or a.id[:6] in self.only_areas]
        areas = [
            Area(id=a.id, name=str(area_config(config, a.id).get("name") or a.name), msb=a.msb, map_folder=a.map_folder)
            for a in areas
        ]
        events.emit("areas", count=len(areas), areas=[{"id": a.id, "name": a.name} for a in areas], skipped=skipped)
        if not areas:
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
                "tileFormat": fmt,
                "floors": config.get("floors", {}),
                "config": self.config_file.name if self.config_file else f"{detection.game}.json (built in)",
            },
            "content": content.to_report(),
            "skippedAreas": skipped,
            "areas": [],
            "pack": None,
            "summary": None,
            "warnings": self.warnings,
        }

        # Every area's map layout and event script first: bonfire objects that event scripts confirm teach the
        # fallback for areas whose script registers none.
        worlds: dict[str, AreaContent | str] = {}
        msbs: dict[str, tp.Any] = {}
        bonfire_models: set[str] = set()
        for index, area in enumerate(areas):
            self.token.stop()
            events.progress(0.03 + 0.02 * index / len(areas), f"{area.name}: reading the map layout and event script")
            try:
                msbs[area.id] = load_msb(profile, area)
                worlds[area.id] = extract_area(area, msbs[area.id], root, content, config, bonfire_models)
            except Cancelled:
                raise
            except Exception as error:
                worlds[area.id] = f"the map layout could not be read: {type(error).__name__}: {str(error).strip()[:300]}"
        for area in areas:
            world = worlds[area.id]
            if isinstance(world, AreaContent) and world.report["bonfires"]["method"].startswith("fallback") and bonfire_models:
                worlds[area.id] = extract_area(area, msbs[area.id], root, content, config, bonfire_models)
        msbs.clear()

        start, span = 0.05, 0.9
        outs: list[AreaOut] = []
        for index, area in enumerate(areas):
            self.token.stop()
            area_start = start + span * index / len(areas)
            area_span = span / len(areas)
            entry, area_out = self.make_area(
                profile, root, area, worlds[area.id], index, len(areas), area_start, area_span, content, config, fmt
            )
            report["areas"].append(entry)
            if area_out is not None:
                outs.append(area_out)
            worlds[area.id] = "done"
            gc.collect()

        self.token.stop()
        events.progress(0.96, "Writing the map pack")
        title = str(config.get("title", detection.title))
        pack = build_pack(pack_id, title, detection.version or "", outs, content, created=previous.get("created"))
        duplicates = duplicate_ids(pack)
        if duplicates:
            raise MakeError(
                f"The map pack would have {len(duplicates)} ids used twice, which Atlas refuses "
                f"(first: {duplicates[0]}). Please save the report and send it."
            )
        write_pack_json(self.staging, pack)
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
        }
        events.emit("pack", folder=str(target), id=pack_id, installed=installed, counts=counts)
        report["summary"] = self.summary(report["areas"])
        return self.finish(report, target)

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
        offsets, total = {}, 0.0
        for step, weight in STEPS.items():
            offsets[step] = total
            total += weight

        def say(step: str, within: float, text: str) -> None:
            fraction = area_start + area_span * (offsets[step] + STEPS[step] * min(max(within, 0.0), 1.0))
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

        # Geometry: every collision file, else the navmesh.
        geometry: dict[str, tp.Any] = {}
        mesh = np.zeros((0, 3, 3), dtype=np.float32)
        owners = np.zeros(0, dtype=np.int32)
        owner_names: list[str] = []
        used = None
        for source in ("collision", "navmesh"):
            self.token.stop()

            def told(within: float, text: str, source: str = source) -> None:
                say("geometry", within, text)

            told(0.0, f"reading {source}")
            job = SourceJob(
                source,
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
                result, triangles = SourceResult(source, status="failed"), None
                result.add_error(error)
            geometry[source] = source_summary(result)
            if result.status == "timed-out":
                self.warn(f"{area.name}: reading {source} was stopped after {result.time_limit:g} s ({result.stopped_on})")
            if triangles is not None and len(triangles):
                mesh = np.asarray(triangles, dtype=np.float32)
                owners = result.owners_array()
                owner_names = list(result.owner_names)
                used = source
                break
        entry["geometry"] = {"used": used, **geometry}
        if used is None:
            self.warn(f"{area.name}: no collision or navmesh could be read; the map shows markers only")

        # Floors.
        self.token.stop()
        say("floors", 0.0, f"finding floors in {len(mesh):,} triangles")
        overrides = floor_overrides(config, area.id)
        plan = plan_floors(mesh, config.get("floors"), overrides)
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
        if plan.floors:
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
        layers_out: list[LayerOut] = []
        floor_entries = []
        assert self.staging is not None

        def layers() -> tp.Iterator[tuple[int, tp.Any]]:
            for floor in floors:
                chosen = np.flatnonzero(plan.triangle_floor == floor.index) if len(mesh) else np.zeros(0, dtype=np.int64)
                tris = mesh[chosen]
                colours = triangle_colours(tris, float(low), float(high), plan.flipped)
                walls = plan.wall_lines[floor.index] if floor.index < len(plan.wall_lines) else np.zeros((0, 2, 2))
                yield floor.index, draw_layer(frame, tris, colours, walls)

        for done, (floor_index, picture) in enumerate(compose(frame, layers(), opacity)):
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
            (self.out / preview).write_bytes(preview_png(picture, frame, dots))
            layers_out.append(LayerOut(floor, tiles, f"tiles/{key}/f{floor_index}/{{z}}/{{x}}/{{y}}.{fmt}"))
            on_this = [m for m in world.markers if m.floor == floor_index]
            floor_entries.append(
                {
                    "index": floor_index,
                    "name": floor.name,
                    "heights": [round(floor.low, 1), round(floor.high, 1)],
                    "areaSquareMetres": round(floor.area),
                    "triangles": floor.triangles,
                    "wallLines": int(len(plan.wall_lines[floor_index])) if floor_index < len(plan.wall_lines) else 0,
                    "markers": dict(sorted(Counter(m.category for m in on_this).items())),
                    "tiles": tiles,
                    "preview": preview,
                }
            )
            del picture

        by_category = Counter(m.category for m in world.markers)
        entry["frame"] = frame.to_report()
        entry["floorPlan"] = plan.report
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
        self.emit_area(entry, index, count)
        area_out = AreaOut(key, area.id, area.name, frame, layers_out, main, world.markers, place_names)
        return entry, area_out

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
(height ranges, area, wall lines), the markers by category and those not standing on a floor, the bonfire,
treasure and character counts, and how the collision meshes were placed (placement). previews/ holds a small
picture of each floor with a dot per marker. {READER_LOG} is the log of the file reader process.

It holds no game files and no game text: only counts, ids, heights, file names and error messages. The map pack
itself stays on this PC.
"""
