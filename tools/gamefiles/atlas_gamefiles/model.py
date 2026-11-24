"""`make-model`: make an Atlas map pack from a 3D model file (glTF, OBJ, STL or PLY), made from scratch or exported
from a modelling program, the way `make` makes one from game files.

The 3D builder (`atlas-scene`, see scene.py) reads the model file: it lines it up with the map (the up axis and the
scale the person chose) and gives its triangles (`atlas-scene triangles`). From them:

1. **Floors** (floors.py): by **ground area** (the default: heights where flat ground piles up are floor levels, each
   cut 1.5 m below; `automatic: "ground"`), by **automatic passages** (passages.py, on the model's walkable surfaces
   alone, as it has no navmesh), or **no floors** (the whole model, one map; `automatic: "none"`). The person's own
   cuts from Adjust floors (`--floor-overrides`, under the pack's id and the area `model`) win, as for game files.
2. **Pictures**: each floor drawn from above with everything above it cut away (render.py, tiles.py), in the chosen
   map style. The textured styles draw each floor in the model's own textures and colours (`atlas-scene draw`); a
   model with neither is height shaded.
3. **The 3D map**: the builder makes the model file itself into the pack's `scene/model/` (cells, levels of detail,
   meshopt), with its textures at full size at the finest level (`keep`) or each material's plain colour, its
   materials seen from one side unless they say both (or the person chose).
4. **Pack** (pack.py): one map, one layer per floor with its `heights`, no locations (the person adds those in Atlas
   with Edit locations), `writtenBy` "Atlas Map Maker", installed in the maps folder like a game's pack. A pack the
   Map Maker made from game files is never replaced by one made from a model.
5. **Report**, as `make`'s (kind `make`, one area keyed `model`), so the Map Maker shows it the same way, with the
   model's details in `model`. The floor data is kept for Adjust floors, and `--remake` makes the map again from
   the same model file (Make this area again).

Nothing is written but the output folder and the pack; the model file is only read.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import time
import typing as tp
import unicodedata
import zipfile
from pathlib import Path

import numpy as np

from . import REPORT_VERSION, TOOL_NAME, __version__
from .check import CancelToken, _now, display_path
from .config import chosen_floor_overrides, floor_method, load_floor_overrides
from .content import GameContent
from .events import Events
from .floorviews import save_floor_data
from .make import MakeError, _empty_floor, describe_cuts, describe_passages, find_floors, scene_summary
from .pack import (
    GAME_FILES_ATTRIBUTION,
    MODEL_ATTRIBUTION,
    WRITER,
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
from .render import BACKGROUND, MAP_STYLES, compose, draw_layer, make_frame, map_style, preview_png, triangle_colours
from .safety import UnsafeOutputError, is_inside
from .scene import BuilderFailed, check_pack, find_builder, floor_heights, run_builder
from .tiles import tile_format, write_pyramid

KEY = "model"  # the map's area key: its tiles, 3D model, floor data and floor cuts are under it
ZIP_NAME = "atlas-make-report.zip"
WORK = "model-work"
UP_AXES = {
    # Which axis of the model gives world east, north and up (a scene's `axes`), for each up axis; each is a turn,
    # never a mirror.
    "+y": ["+x", "-z", "+y"],
    "+z": ["+x", "+y", "+z"],
    "-y": ["+x", "+z", "-y"],
    "-z": ["+x", "-y", "-z"],
    "+x": ["+y", "+z", "+x"],
    "-x": ["+y", "-z", "-x"],
}
FLOOR_CHOICES = ("ground", "passages", "none")
TEXTURE_CHOICES = ("keep", "plain")
DEFAULT_MAX_TRIANGLES = 5_000_000
LARGEST_MAX_TRIANGLES = 50_000_000
MODEL_RENDER = {"pixelsPerMetre": 8, "minPixelsPerMetre": 1, "maxImageSize": 6144, "marginMetres": 6}
# Progress: reading the model, floors, pictures, 3D map.
STEPS = {"read": (0.02, 0.12), "floors": (0.12, 0.2), "render": (0.2, 0.55), "scene": (0.55, 0.93)}


def pack_id_for(name: str) -> str:
    """A pack id from the model's name: lower case letters, digits and dashes (accents dropped), at most 64."""
    letters = (c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))
    plain = "".join(c if c.isascii() and c.isalnum() else "-" for c in letters).lower()
    slug = re.sub(r"-+", "-", plain).strip("-")[:64].strip("-")
    return slug or "model-map"


def orient_up(triangles: np.ndarray) -> np.ndarray:
    """The triangles with each one turned to face up (its corners in the other order where it faces down), for a
    model whose surfaces face either way."""
    a, b, c = (triangles[:, i].astype(np.float64) for i in range(3))
    up = np.cross(b - a, c - a)[:, 1]
    out = triangles.copy()
    down = up < 0
    out[down] = out[down][:, [0, 2, 1]]
    return out


class ModelMapMaker:
    def __init__(
        self,
        model_file: Path,
        out: Path,
        events: Events,
        token: CancelToken | None = None,
        maps_folder: Path | None = None,
        scene_builder: Path | None = None,
        name: str | None = None,
        title: str | None = None,
        up: str = "+y",
        scale: float = 1.0,
        units: str | None = None,
        textures: str = "keep",
        double_sided: bool | None = None,
        floors: str = "ground",
        floor_separation: float | None = None,
        merge_gap: float | None = None,
        max_triangles: int = DEFAULT_MAX_TRIANGLES,
        style: str | None = None,
        floor_overrides_file: Path | None = None,
        remake: bool = False,
    ):
        self.model_file = Path(model_file)
        self.out = Path(out)
        self.events = events
        self.token = token or CancelToken()
        self.maps_folder = Path(maps_folder) if maps_folder else None
        self.scene_builder = scene_builder
        self.name = (name or self.model_file.stem).strip()[:80] or "Model"
        self.title = (title or self.name).strip()[:120] or self.name
        if up not in UP_AXES:
            raise MakeError(f"{up} is not an up axis; the axes are {', '.join(UP_AXES)}.")
        self.up = up
        if not (isinstance(scale, (int, float)) and math.isfinite(scale) and 1e-6 <= scale <= 1e6):
            raise MakeError("The scale must be a number above 0.")
        self.scale = float(scale)
        self.units = units
        if textures not in TEXTURE_CHOICES:
            raise MakeError(f"{textures} is not a way of keeping textures; the ways are {', '.join(TEXTURE_CHOICES)}.")
        self.textures = textures
        self.double_sided = double_sided
        if floors not in FLOOR_CHOICES:
            raise MakeError(f"{floors} is not a way of finding floors; the ways are {', '.join(FLOOR_CHOICES)}.")
        self.floors = floors
        self.floor_separation = floor_separation
        self.merge_gap = merge_gap
        self.max_triangles = int(min(max(max_triangles, 1), LARGEST_MAX_TRIANGLES))
        try:
            self.style = map_style(style, model=True)
        except ValueError as error:
            raise MakeError(str(error)[:1].upper() + str(error)[1:] + ".", code="map-style") from None
        self.floor_overrides_file = Path(floor_overrides_file) if floor_overrides_file else None
        self.remake = remake
        self.pack_id = pack_id_for(self.name)
        self.warnings: list[str] = []
        self.started = time.monotonic()
        self.staging: Path | None = None
        self.builder: Path | None = None
        self.used_own: list[str] = []
        self.own_error: str | None = None

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        self.events.warning(message)

    def say(self, step: str, within: float, text: str) -> None:
        start, end = STEPS[step]
        self.events.progress(start + (end - start) * min(max(within, 0.0), 1.0), text, area="model", step=step)

    def run(self) -> dict[str, tp.Any]:
        try:
            return self._run()
        except BaseException:
            if self.staging is not None and self.staging.name.startswith("."):
                shutil.rmtree(self.staging, ignore_errors=True)
            raise
        finally:
            shutil.rmtree(self.out / WORK, ignore_errors=True)

    def settings(self) -> dict[str, tp.Any]:
        """What the model was made with, for the report (and Make this area again)."""
        return {
            "file": self.model_file.name,
            "path": display_path(self.model_file),
            "name": self.name,
            "title": self.title,
            "up": self.up,
            "scale": self.scale,
            "units": self.units,
            "textures": self.textures,
            "doubleSided": self.double_sided,
            "floors": self.floors,
            "floorSeparation": self.floor_separation,
            "mergeGap": self.merge_gap,
            "maxTriangles": self.max_triangles,
        }

    def floor_config(self, both_sides: bool) -> dict[str, tp.Any]:
        floors: dict[str, tp.Any] = {
            "method": "passages" if self.floors == "passages" else "cuts",
            "automatic": "none" if self.floors == "none" else "ground",
            "bothSides": 1.0 if both_sides else 0.0,
            "maxFloors": 12,
        }
        if self.floor_separation is not None:
            floors["floorSeparation"] = float(self.floor_separation)
        if self.merge_gap is not None:
            floors["mergeGap"] = float(self.merge_gap)
        return floors

    def _run(self) -> dict[str, tp.Any]:
        events = self.events
        events.emit("start", tool=TOOL_NAME, version=__version__, folder=display_path(self.model_file), mode="model")
        events.progress(0.0, "Looking at the model file")
        if not self.model_file.is_file():
            raise MakeError(
                f"The model file {self.model_file} is not there any more. Choose it again with Make a map from a 3D model.",
                code="model-missing",
            )
        if self.maps_folder is not None and (is_inside(self.maps_folder, self.out) or is_inside(self.out, self.maps_folder)):
            raise UnsafeOutputError("The maps folder and the output folder must be apart.")
        self.builder = find_builder(self.scene_builder)
        if self.builder is None:
            raise MakeError("The 3D builder that comes with the Map Maker (atlas-scene) is missing: it reads model files. Please reinstall the app.")
        self.builder = self.builder.resolve()
        target = (self.maps_folder / self.pack_id) if self.maps_folder is not None else self.out / "pack" / self.pack_id
        previous_report = self.check_remake(target) if self.remake else None
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "previews").mkdir(exist_ok=True)
        work = self.out / WORK
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir()
        if self.maps_folder is not None:
            self.maps_folder.mkdir(parents=True, exist_ok=True)
        refusal = check_target(target) or self.not_a_game_pack(target)
        if refusal:
            raise MakeError(refusal)

        # 1. The model's triangles, lined up with the map.
        self.token.stop()
        axes = UP_AXES[self.up]
        self.say("read", 0.0, f"Reading {self.model_file.name}")
        placing = {"axes": axes, "scale": self.scale, "maxTriangles": self.max_triangles}
        try:
            done = run_builder(
                self.builder,
                {"input": str(self.model_file.resolve()), "output": "triangles.bin", "options": placing},
                work,
                "triangles",
                lambda fraction, text: self.say("read", fraction, text),
                self.token.stop,
                command="triangles",
            )
        except BuilderFailed as error:
            raise MakeError(f"{self.model_file.name} could not be read: {error}") from error
        info = done.get("info") or {}
        mesh = np.fromfile(work / "triangles.bin", dtype="<f4").reshape(-1, 3, 3)
        (work / "triangles.bin").unlink(missing_ok=True)
        size = [round(float(done["max"][k]) - float(done["min"][k]), 2) for k in range(3)] if len(mesh) else [0.0, 0.0, 0.0]
        events.emit(
            "model",
            file=self.model_file.name,
            format=info.get("formatName"),
            triangles=int(len(mesh)),
            size=size,
            missing=info.get("missingFiles", []),
        )
        for missing in info.get("missingFiles", [])[:10]:
            self.warn(f"{missing} is missing: it belongs with {self.model_file.name} and must be next to it; the model is made without it")
        for warning in info.get("warnings", [])[:5]:
            self.warn(str(warning))
        both_sides = self.double_sided if self.double_sided is not None else not info.get("sidesGiven", False)
        if both_sides:
            mesh = orient_up(mesh)
        config = {"floors": self.floor_config(bool(both_sides)), "render": dict(MODEL_RENDER), "scene": {}}

        # 2. Floors.
        self.token.stop()
        self.say("floors", 0.0, f"Finding floors in {len(mesh):,} triangles")
        own = self.load_own_overrides()
        overrides, source = chosen_floor_overrides(config, own, KEY)
        method = floor_method(config, overrides, None)
        if source == "yours":
            self.used_own.append(KEY)
        plan = find_floors(mesh, None, config, overrides, method)
        if method == "passages":
            describe_passages(plan, overrides, source, {})
        else:
            describe_cuts(plan, overrides, source, {})
        plan.report["automatic"] = config["floors"]["automatic"]

        # 3. Pictures.
        style = self.style
        textured = style.textured and bool(info.get("hasColours"))
        if style.textured and not textured:
            plain = "outlines" if style.outlines else "shaded"
            self.warn(f"{self.model_file.name} has no colours or textures of its own, so its floors are drawn {MAP_STYLES[plain].label.lower()}")
            style = map_style(plain)
        # The whole model is on the map, not only its walkable ground.
        frame = make_frame(mesh[:, :, [0, 2]].reshape(-1, 2), np.zeros((0, 2)), config["render"])
        if plan.method == "passages":
            main = min(plan.main, max(len(plan.floors) - 1, 0))
        elif plan.floors:
            main = max(plan.floors, key=lambda f: f.area).index
        else:
            main = 0
        floors = plan.floors or [_empty_floor()]
        names = floor_names(floors, main, overrides.get("names") if isinstance(overrides.get("names"), list) else None)
        for floor, floor_name in zip(floors, names):
            floor.name = floor_name
        heights = mesh[plan.walkable][:, :, 1] if plan.walkable.any() else mesh[:, :, 1]
        low, high = (np.percentile(heights, [2, 98]) if len(heights) else (0.0, 1.0))
        opacity = 0.4
        save_floor_data(self.out, KEY, self.name, mesh, plan, [], config["floors"], (float(low), float(high)), {}, opacity, method=method)
        fills = self.draw_textured(work, frame, plan, len(floors), placing) if textured else None

        staging_name = f".{self.pack_id}.making"
        self.staging = target.with_name(staging_name)
        if self.staging.exists():
            shutil.rmtree(self.staging)
        self.staging.mkdir(parents=True)
        fmt = tile_format("webp")
        layers_out: list[LayerOut] = []
        floor_entries = []

        def layers() -> tp.Iterator[tuple[int, tp.Any]]:
            for floor in floors:
                chosen = np.flatnonzero(plan.triangle_floor == floor.index)
                tris = mesh[chosen]
                colours = triangle_colours(tris, float(low), float(high), plan.flipped)
                walls = plan.wall_lines[floor.index] if floor.index < len(plan.wall_lines) else np.zeros((0, 2, 2))
                fill = None
                if fills is not None and floor.index < len(fills):
                    from PIL import Image

                    with Image.open(fills[floor.index]) as picture:
                        fill = picture.convert("RGBA")
                yield floor.index, draw_layer(frame, tris, colours, walls, style, fill=fill)

        for done_count, (floor_index, picture) in enumerate(compose(frame, layers(), opacity)):
            self.token.stop()
            floor = floors[floor_index]
            self.say("render", done_count / len(floors), f"Cutting {floor.name} into map tiles")
            tiles = write_pyramid(picture, self.staging / "tiles" / KEY / f"f{floor_index}", tile_size=256, fmt=fmt, quality=85, background=BACKGROUND, stop=self.token.stop)
            preview = f"previews/{KEY}_f{floor_index}.png"
            (self.out / preview).write_bytes(preview_png(picture, frame, []))
            layers_out.append(LayerOut(floor, tiles, f"tiles/{KEY}/f{floor_index}/{{z}}/{{x}}/{{y}}.{fmt}"))
            floor_entries.append(
                {
                    "index": floor_index,
                    "name": floor.name,
                    "heights": [round(floor.low, 1), round(floor.high, 1)],
                    "between": [
                        round(plan.cuts[floor_index - 1], 2) if 0 < floor_index <= len(plan.cuts) else None,
                        round(plan.cuts[floor_index], 2) if floor_index < len(plan.cuts) else None,
                    ],
                    "areaSquareMetres": round(floor.area),
                    "triangles": floor.triangles,
                    "wallLines": int(len(plan.wall_lines[floor_index])) if floor_index < len(plan.wall_lines) else 0,
                    "markers": {},
                    "tiles": tiles,
                    "preview": preview,
                }
            )
            del picture
        for old in (self.out / "previews").glob(f"{KEY}_f*.png"):
            if not any(entry["preview"] == f"previews/{old.name}" for entry in floor_entries):
                old.unlink(missing_ok=True)

        # 4. The 3D map, from the model file itself.
        scene, floor_layer_heights, scene_entry = self.make_scene(work, mesh, plan, axes)

        entry: dict[str, tp.Any] = {
            "id": KEY,
            "key": KEY,
            "name": self.name,
            "geometry": {"used": "model"},
            "frame": frame.to_report(),
            "floorPlan": plan.report,
            "mapStyle": style.id,
            "mapStyleAsked": self.style.id,
            "mainFloor": main,
            "floors": floor_entries,
            "markers": {"total": 0, "byCategory": {}, "notOnFloor": 0, "notOnFloorList": [], "withFlag": 0, "placeNames": 0},
            "scene": scene_entry,
            "seconds": round(time.monotonic() - self.started, 1),
        }
        events.emit(
            "area",
            id=KEY,
            name=self.name,
            index=0,
            count=1,
            geometry={},
            used="model",
            floors=len(floor_entries),
            markers=0,
            skipped=None,
            scene=bool(scene_entry.get("made")),
        )
        area_out = AreaOut(KEY, KEY, self.name, frame, layers_out, main, [], {}, scene, floor_layer_heights)

        # 5. The pack.
        self.token.stop()
        events.progress(0.95, "Writing the map pack")
        previous = existing_pack(target) or {}
        pack = build_pack(
            self.pack_id,
            self.title,
            "",
            [area_out],
            GameContent(),
            created=previous.get("created"),
            attribution=[{"name": MODEL_ATTRIBUTION}],
        )
        duplicates = duplicate_ids(pack)
        if duplicates:
            raise MakeError(f"The map pack would have ids used twice ({duplicates[0]}). Please save the report and send it.")
        write_pack_json(self.staging, pack)
        check_3d = None
        if scene is not None:
            events.progress(0.97, "Checking the 3D map")
            check_3d = check_pack(self.builder, self.staging)
            for problem in check_3d.get("problems", [])[:5]:
                self.warn(f"The 3D check found a problem: {problem}")
        self.token.stop()  # the last moment to stop: from here the maps folder is changed
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
        events.emit("pack", folder=str(target), id=self.pack_id, installed=installed, counts=counts)

        report: dict[str, tp.Any] = {
            "tool": TOOL_NAME,
            "toolVersion": __version__,
            "reportVersion": REPORT_VERSION,
            "kind": "make",
            "source": "model",
            "createdAt": (previous_report or {}).get("createdAt") or _now(),
            "folder": display_path(self.model_file.parent),
            "game": {
                "id": self.pack_id,
                "title": self.title,
                "supported": True,
                "version": None,
                "dataFolder": None,
                "evidence": [f"A map made from the 3D model {self.model_file.name}"],
            },
            "model": {
                **self.settings(),
                "format": info.get("formatName"),
                "triangles": int(len(mesh)),
                "parts": info.get("parts"),
                "materials": info.get("materials"),
                "texturedMaterials": info.get("texturedMaterials"),
                "texturesFound": info.get("texturesFound"),
                "hasColours": bool(info.get("hasColours")),
                "sidesGiven": bool(info.get("sidesGiven")),
                "bothSides": bool(both_sides),
                "sizeMetres": size,
                "missingFiles": info.get("missingFiles", []),
            },
            "options": {
                "mapStyle": style.id,
                "floorMethod": method,
                "floors": config["floors"],
                "render": config["render"],
                "tileFormat": fmt,
                "floorOverrides": {
                    "file": self.floor_overrides_file.name if self.floor_overrides_file else None,
                    "error": self.own_error,
                    "usedFor": self.used_own,
                },
                "threeD": {"asked": True, "builder": self.builder.name, "settings": {}},
            },
            "areas": [entry],
            "pack": {
                "id": self.pack_id,
                "folder": display_path(target),
                "installed": installed,
                "mapsFolder": display_path(self.maps_folder),
                "counts": counts,
                "tileFormat": fmt,
                "tiles": sum(layer["tiles"]["files"] for layer in floor_entries),
                "tileBytes": sum(layer["tiles"]["bytes"] for layer in floor_entries),
                "check3d": check_3d,
            },
            "summary": {
                "areas": 1,
                "areasMade": 1,
                "areasSkipped": [],
                "floors": len(floor_entries),
                "markers": 0,
                "markersByCategory": {},
                "notOnFloor": 0,
                "geometry": {"model": 1},
                "threeD": scene_summary([entry]),
            },
            "warnings": self.warnings,
        }
        if self.remake:
            report["updatedAt"] = _now()
            report["remade"] = {"area": KEY, "name": self.name, "at": _now()}
        return self.finish(report, target)

    def not_a_game_pack(self, target: Path) -> str | None:
        """A pack the Map Maker made from game files is never replaced by a map of a model."""
        manifest = existing_pack(target)
        if not manifest:
            return None
        attribution = manifest.get("attribution") if isinstance(manifest.get("attribution"), list) else []
        if any(isinstance(a, dict) and a.get("name") == GAME_FILES_ATTRIBUTION for a in attribution):
            return (
                f"A map pack called {self.pack_id} is already in the maps folder, made from game files. "
                "Give the model another name, so it gets a pack of its own."
            )
        return None

    def check_remake(self, target: Path) -> dict[str, tp.Any]:
        manifest = existing_pack(target)
        if manifest is None:
            raise MakeError(
                f"The map pack is not in {display_path(target)} any more. Make it again with Make a map from a 3D model.",
                code="pack-missing",
            )
        written_by = manifest.get("writtenBy") if isinstance(manifest.get("writtenBy"), dict) else {}
        if written_by.get("name") != WRITER:
            raise MakeError(
                "That map pack was not made by the Map Maker. Make the map again with Make a map from a 3D model.", code="pack-other-version"
            )
        try:
            previous = json.loads((self.out / "report.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = None
        if not isinstance(previous, dict) or previous.get("source") != "model":
            raise MakeError(
                "The report of the last make is missing. Make the map again with Make a map from a 3D model.", code="report-missing"
            )
        return previous

    def load_own_overrides(self) -> dict[str, dict[str, tp.Any]]:
        if self.floor_overrides_file is None:
            return {}
        try:
            return load_floor_overrides(self.floor_overrides_file, self.pack_id)
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            self.own_error = f"{type(error).__name__}: {str(error).strip()[:200]}"
            self.warn(f"Your floor cuts ({self.floor_overrides_file.name}) could not be read ({self.own_error}): the floors are made as the Map Maker finds them")
            return {}

    def draw_textured(self, work: Path, frame: tp.Any, plan: tp.Any, count: int, placing: dict[str, tp.Any]) -> list[Path] | None:
        """Each floor drawn from above in the model's own textures and colours by the builder; None (height shaded
        then) when it cannot."""
        assert self.builder is not None
        floors_file = work / "floors.bin"
        plan.triangle_floor.astype("<i2").tofile(floors_file)
        job = {
            "input": str(self.model_file.resolve()),
            "output": "drawn",
            "options": {**placing, "colouring": "textures" if self.textures == "keep" else "plain"},
            "frame": {"xMin": frame.x_min, "zMax": frame.z_max, "scale": frame.scale, "width": frame.width, "height": frame.height},
            "floors": floors_file.name,
            "count": count,
        }
        try:
            done = run_builder(
                self.builder, job, work, "draw", lambda fraction, text: self.say("render", 0.0, "Drawing the floors"), self.token.stop, command="draw"
            )
        except BuilderFailed as error:
            self.warn(f"The floors could not be drawn with the model's textures ({error}), so they are height shaded")
            return None
        return [work / "drawn" / str(name) for name in done.get("files", [])]

    def make_scene(
        self, work: Path, mesh: np.ndarray, plan: tp.Any, axes: list[str]
    ) -> tuple[dict[str, tp.Any] | None, list[list[float]] | None, dict[str, tp.Any]]:
        assert self.builder is not None and self.staging is not None
        started = time.monotonic()
        entry: dict[str, tp.Any] = {"made": False, "trianglesBefore": int(len(mesh))}
        self.say("scene", 0.0, f"Making the 3D map of {len(mesh):,} triangles")
        options: dict[str, tp.Any] = {
            "folder": f"scene/{KEY}",
            "axes": axes,
            "scale": self.scale,
            "textures": {"mode": "keep" if self.textures == "keep" else "average"},
            "maxTriangles": self.max_triangles,
        }
        if self.double_sided is not None:
            options["doubleSided"] = self.double_sided
        job = {"input": str(self.model_file.resolve()), "pack": str(self.staging.resolve()), "options": options}
        try:
            done = run_builder(
                self.builder,
                job,
                work,
                "scene",
                lambda fraction, text: self.say("scene", fraction, f"3D map: {text}"),
                self.token.stop,
            )
        except BuilderFailed as error:
            entry["reason"] = str(error)
            self.warn(f"{self.name}: the 3D map was not made ({error}); the map stays 2D")
            return None, None, entry
        built = done.get("report", {})
        if plan.method == "passages":
            heights = [list(h) for h in plan.heights] if plan.heights and len(plan.heights) >= 2 else None
        else:
            heights = floor_heights(plan.cuts, len(plan.floors), float(mesh[:, :, 1].min()), float(mesh[:, :, 1].max()))
        entry.update(
            {
                "made": True,
                "trianglesAfter": built.get("triangles"),
                "trianglesDropped": built.get("trianglesDropped"),
                "trianglesCleaned": built.get("trianglesCleaned"),
                "levels": built.get("levels"),
                "cells": built.get("cells"),
                "cellSize": built.get("cellSize"),
                "files": built.get("files"),
                "bytes": built.get("bytes"),
                "texturesKept": built.get("texturesKept"),
                "textureBytes": built.get("textureBytes"),
                "builderSeconds": built.get("seconds"),
                "seconds": round(time.monotonic() - started, 1),
                "floors": heights,
                "noSurfaceUnder": 0,
                "noSurfaceUnderList": [],
                "warnings": built.get("warnings", []),
            }
        )
        return done.get("scene"), heights, entry

    def finish(self, report: dict[str, tp.Any], target: Path) -> dict[str, tp.Any]:
        report["elapsedSeconds"] = round(time.monotonic() - self.started, 1)
        self.events.progress(0.99, "Writing the report")
        report_path = self.out / "report.json"
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        zip_path = self.out / ZIP_NAME
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(report_path, "report.json")
            for floor in report["areas"][0].get("floors", []):
                path = self.out / floor["preview"]
                if path.is_file():
                    archive.write(path, floor["preview"])
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


README_TEXT = """Atlas Map Maker: report of a map made from a 3D model

report.json says how the map pack was made from the model file: the model's format, size, up axis and scale (model),
the floors found (their heights, area and the cut heights between them, and who set each: automatic, by ground area,
or your own floor cuts), how the floors were drawn and the 3D map (triangles before and after, cells, levels of
detail, file sizes, time taken). previews/ holds a small picture of each floor.

It holds no part of the model itself: only counts, heights, names and messages.
"""
