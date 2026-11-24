"""`redraw`: draw every 2D floor of a map pack again from the pack itself, with no game files (the Map Maker's
"Draw all areas again").

For each map of the pack that has a 3D model (a `scene` in `maps.json`):

1. the 3D builder reads the model back out of the pack (`atlas-scene unpack`, see crates/atlas-scene): each cell's
   finest level in the pack, with its textures when it has them, as one raw model in the world (x, height, y),
   which is what Make map's floor finder and drawing read (x, the game's y, the game's z);
2. its floors are found as Make map finds them (floors.py, passages.py) with the floor cuts in force now: the
   player's own (`--floor-overrides`, the Map Maker's floor cuts file) when it has an entry for the map's area;
   else the pack's own floors (its layers' `heights`), cut where one ends and the next begins, or, where they
   overlap (made with automatic passages), with automatic passages again;
3. each floor is drawn in the map style asked for through `render.draw_floor` (the one place a style becomes a
   picture, as in Make map), the floors below faded, at the map's own size and `worldTransform`, and cut into the
   tiles of its layer, at the layer's own path and format.

A pack the Map Maker made (`writtenBy`) takes the floors as they now are: its layers' heights and names, and the
locations on each floor (by their height, as Make map puts markers on floors), even when the floor cuts give
another number of floors. Any other pack keeps its layers and locations: a map whose floors would change in number
is left as it was. A map that cannot be drawn again is left as it was, with the reason in the report.

Nothing is changed until every map is drawn: the new tiles are written beside the pack (a hidden
`.<pack>.redraw` folder in the maps folder), then swapped in by renames with the changed JSON files, the old ones
kept aside (`.<pack>.redraw-old`) until all is in place and put back if anything fails, so Atlas never sees half a
pack. Cancelling before the swap leaves the pack as it was. The report (`report.json` in the output folder) says
per map what was drawn again or why not.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import struct
import subprocess
import sys
import time
import typing as tp
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import REPORT_VERSION, TOOL_NAME, __version__
from .check import CancelToken, _now, display_path
from .config import chosen_floor_overrides, floor_method, load_config, load_floor_overrides
from .events import Events
from .floors import FloorPlan, locate, plan_floors, prepare
from .pack import FILES, WRITER, collection_text, content_counts, floor_names, layer_order, now, read_pack_json
from .passages import plan_passages, prepare_passages
from .render import BACKGROUND, MapStyle, SurfaceTextures, compose, draw_floor, map_style
from .scene import CREATE_NO_WINDOW, check_pack, find_builder, floor_heights
from .tiles import tile_format, write_pyramid

STAGING = ".{}.redraw"
BACKUP = ".{}.redraw-old"
WORK = "redraw-work"
UNPACK_TIME_LIMIT = 600.0
AREA_KEY = re.compile(r"m\d\d_\d\d")
# A layer's tiles: a plain folder path, then `{z}/{x}/{y}.<png|webp>`.
TILE_URL = re.compile(r"^((?:[A-Za-z0-9_][A-Za-z0-9_.\-]*/)+)\{z\}/\{x\}/\{y\}\.(png|webp)$")
ALPHA_MODES = ("OPAQUE", "MASK", "BLEND")


class RedrawError(Exception):
    """The pack cannot be drawn again at all; the message says why, for the player."""


class Skip(Exception):
    """One map cannot be drawn again; the message says why."""


# ---------------------------------------------------------------------------------------------------------------
# The model, as `atlas-scene unpack` writes it.


@dataclass
class PackModel:
    """A map's model: triangles (n, 3, 3) in (world x, height, world y), and their look (None when the model says
    nothing but colours)."""

    triangles: np.ndarray
    surface: SurfaceTextures
    report: dict[str, tp.Any]


def read_unpacked(data: bytes) -> tuple[np.ndarray, SurfaceTextures]:
    """The triangles and their look from the raw model `atlas-scene unpack` writes: plain glTF binary, one mesh per
    material, 32-bit float positions (x, height, y), colours (RGBA) and texture coordinates, 32-bit indices."""
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total != len(data):
        raise ValueError("the unpacked model is not a glTF binary file")
    json_length, kind = struct.unpack_from("<I4s", data, 12)
    if kind != b"JSON":
        raise ValueError("the unpacked model has no JSON chunk")
    document = json.loads(data[20 : 20 + json_length])
    start = 20 + json_length
    binary = b""
    if start + 8 <= len(data):
        bin_length, kind = struct.unpack_from("<I4s", data, start)
        if kind == b"BIN\0":
            binary = data[start + 8 : start + 8 + bin_length]
    views = document.get("bufferViews", [])
    accessors = document.get("accessors", [])
    sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

    def values(index: int) -> np.ndarray:
        accessor = accessors[index]
        width = sizes[accessor["type"]]
        dtype = {5126: "<f4", 5125: "<u4"}[accessor["componentType"]]
        view = views[accessor["bufferView"]]
        offset = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
        count = int(accessor["count"])
        out = np.frombuffer(binary, dtype=dtype, count=count * width, offset=offset)
        return out.reshape(count, width) if width > 1 else out

    images = tuple(
        bytes(binary[int(views[image["bufferView"]].get("byteOffset", 0)) :][: int(views[image["bufferView"]]["byteLength"])])
        for image in document.get("images", [])
    )
    textures = document.get("textures", [])
    samplers = document.get("samplers", [])
    materials = []
    for material in document.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        texture = pbr.get("baseColorTexture")
        image = wrap = None
        if isinstance(texture, dict) and 0 <= int(texture.get("index", -1)) < len(textures):
            entry = textures[int(texture["index"])]
            image = entry.get("source")
            sampler = samplers[entry["sampler"]] if "sampler" in entry and entry["sampler"] < len(samplers) else {}
            wrap = (int(sampler.get("wrapS", 10497)), int(sampler.get("wrapT", 10497)))
        alpha = material.get("alphaMode", "OPAQUE")
        materials.append(
            {
                "name": material.get("name", ""),
                "colour": tuple(float(v) for v in pbr.get("baseColorFactor", (1.0, 1.0, 1.0, 1.0))),
                "image": image,
                "wrap": wrap,
                "alpha": alpha if alpha in ALPHA_MODES else "OPAQUE",
                "alphaCutoff": float(material.get("alphaCutoff", 0.5)),
                "doubleSided": bool(material.get("doubleSided", False)),
            }
        )
    triangles, uvs, colours, owners = [], [], [], []
    any_colours = False
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4:
                continue
            attributes = primitive["attributes"]
            positions = values(attributes["POSITION"]).astype(np.float32)
            indices = values(primitive["indices"]).astype(np.int64) if "indices" in primitive else np.arange(len(positions))
            indices = indices[: len(indices) // 3 * 3].reshape(-1, 3)
            if len(indices) and int(indices.max()) >= len(positions):
                raise ValueError("the unpacked model names a vertex it does not have")
            triangles.append(positions[indices])
            uv = values(attributes["TEXCOORD_0"]) if "TEXCOORD_0" in attributes else np.zeros((len(positions), 2), np.float32)
            uvs.append(uv.astype(np.float32)[indices])
            if "COLOR_0" in attributes:
                any_colours = True
                colour = values(attributes["COLOR_0"]).astype(np.float32)
                if colour.shape[1] == 3:
                    colour = np.concatenate([colour, np.ones((len(colour), 1), np.float32)], axis=1)
            else:
                colour = np.ones((len(positions), 4), np.float32)
            colours.append(colour[indices])
            owners.append(np.full(len(indices), int(primitive.get("material", 0)), dtype=np.int32))
    if not triangles:
        empty = np.zeros((0, 3, 3), np.float32)
        return empty, SurfaceTextures(np.zeros((0, 3, 2), np.float32), np.zeros(0, np.int32), None, tuple(materials), images)
    surface = SurfaceTextures(
        np.concatenate(uvs),
        np.concatenate(owners),
        np.concatenate(colours) if any_colours else None,
        tuple(materials),
        images,
    )
    return np.concatenate(triangles), surface


def unpack_model(builder: Path, pack: Path, map_id: str, work: Path, stop: tp.Callable[[], None]) -> PackModel:
    """The model of `map_id` in `pack`, read out by the builder (`atlas-scene unpack`) into `work`."""
    work.mkdir(parents=True, exist_ok=True)
    output = work / "model.glb"
    output.unlink(missing_ok=True)
    stop()
    try:
        result = subprocess.run(
            [str(builder), "unpack", str(pack), map_id, str(output)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=UNPACK_TIME_LIMIT,
            creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Skip(f"its 3D model could not be read ({type(error).__name__})") from None
    done: dict[str, tp.Any] | None = None
    failure = None
    for raw in result.stdout.decode("utf-8", "replace").splitlines():
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if message.get("event") == "done":
            done = message
        elif message.get("event") == "error":
            failure = str(message.get("message", ""))
    if done is None or result.returncode != 0 or not output.is_file():
        raise Skip(f"its 3D model could not be read ({failure or f'the builder ended with code {result.returncode}'})")
    try:
        triangles, surface = read_unpacked(output.read_bytes())
    except (OSError, ValueError, KeyError, IndexError, TypeError, struct.error) as error:
        raise Skip(f"its 3D model could not be read ({type(error).__name__}: {error})") from None
    finally:
        output.unlink(missing_ok=True)
    return PackModel(triangles, surface, done.get("report") or {})


# ---------------------------------------------------------------------------------------------------------------
# A map's frame: its picture's size and its worldTransform.


@dataclass(frozen=True)
class MapFrame:
    """A map picture of `width` by `height` pixels whose pixel (px, py) is at world (a px + c py + e, b px + d py +
    f), its `worldTransform`: what render.draw_layer and compose need of a frame."""

    a: float
    b: float
    c: float
    d: float
    e: float
    f: float
    width: int
    height: int

    @property
    def scale(self) -> float:
        """Pixels per world unit."""
        return 1.0 / math.sqrt(abs(self.a * self.d - self.b * self.c))

    def to_pixels(self, xz: np.ndarray) -> np.ndarray:
        """World (x, y) points to map pixels."""
        xz = np.asarray(xz, dtype=np.float64).reshape(-1, 2)
        det = self.a * self.d - self.b * self.c
        dx, dy = xz[:, 0] - self.e, xz[:, 1] - self.f
        return np.stack([(self.d * dx - self.c * dy) / det, (-self.b * dx + self.a * dy) / det], axis=1)

    def to_world(self, px: float, py: float) -> tuple[float, float]:
        return self.a * px + self.c * py + self.e, self.b * px + self.d * py + self.f


def map_frame(entry: dict[str, tp.Any]) -> MapFrame:
    transform = entry.get("worldTransform")
    width, height = entry.get("width"), entry.get("height")
    if not isinstance(transform, dict) or not isinstance(width, int) or not isinstance(height, int):
        raise Skip("it has no worldTransform or size")
    try:
        values = [float(transform[k]) for k in "abcdef"]
    except (KeyError, TypeError, ValueError):
        raise Skip("its worldTransform cannot be read") from None
    frame = MapFrame(*values, width=width, height=height)
    if not all(math.isfinite(v) for v in values) or abs(values[0] * values[3] - values[1] * values[2]) < 1e-12:
        raise Skip("its worldTransform cannot be read")
    if not (1 <= width <= 16384 and 1 <= height <= 16384):
        raise Skip(f"its picture is {width} by {height} pixels, larger than the redraw draws")
    return frame


# ---------------------------------------------------------------------------------------------------------------
# Floors.


def floors_of(layers: list[dict[str, tp.Any]]) -> list[tuple[dict[str, tp.Any], float, float]]:
    """The layers with `heights` (the map's floors), lowest first (by min, then max, then their order), with them."""
    out = []
    for order, layer in enumerate(layers):
        heights = layer.get("heights")
        if (
            isinstance(heights, list)
            and len(heights) == 2
            and all(isinstance(v, (int, float)) and math.isfinite(v) for v in heights)
        ):
            out.append((order, float(heights[0]), float(heights[1]), layer))
    out.sort(key=lambda item: (item[1], item[2], item[0]))
    return [(layer, low, high) for _, low, high, layer in out]


def overlapping(floors: list[tuple[dict[str, tp.Any], float, float]]) -> bool:
    return any(floors[i][2] > floors[i + 1][1] + 0.05 for i in range(len(floors) - 1))


@dataclass
class FloorChoice:
    plan: FloorPlan
    source: str  # "yours" (the player's floor cuts), "pack" (the pack's floors) or "passages" (found again)
    overrides: dict[str, tp.Any]
    main: int


def choose_floors(
    mesh: np.ndarray,
    pack_floors: list[tuple[dict[str, tp.Any], float, float]],
    key: str | None,
    own: dict[str, dict[str, tp.Any]],
    config: dict[str, tp.Any],
    asked_method: str | None,
) -> FloorChoice:
    """The floors to draw (see the top of this module)."""
    settings = config.get("floors") if isinstance(config.get("floors"), dict) else None
    prepared = prepare(mesh, settings)
    if key is not None and key in own:
        overrides, _ = chosen_floor_overrides(config, own, key)
        method = floor_method(config, overrides, asked_method)
        source = "yours"
    elif len(pack_floors) >= 2 and overlapping(pack_floors):
        overrides = chosen_floor_overrides(config, {}, key)[0] if key is not None else {}
        method, source = "passages", "passages"
    else:
        cuts = [high for _, _, high in pack_floors[:-1]] if len(pack_floors) >= 2 else []
        overrides, method, source = {"cuts": cuts}, "cuts", "pack"
    if method == "passages":
        plan = plan_passages(prepare_passages(prepared, None, settings), overrides=overrides)
        main = min(plan.main, max(len(plan.floors) - 1, 0))
    else:
        plan = plan_floors(prepared, overrides=overrides)
        main = max(plan.floors, key=lambda f: f.area).index if plan.floors else 0
    return FloorChoice(plan, source, overrides, main)


def new_heights(plan: FloorPlan, mesh: np.ndarray) -> list[list[float]] | None:
    """Each floor's `[min, max]` for its layer, as Make map writes them (None without storeys)."""
    if plan.method == "passages":
        return [list(h) for h in plan.heights] if plan.heights and len(plan.heights) >= 2 else None
    if not len(mesh):
        return None
    return floor_heights(plan.cuts, len(plan.floors), float(mesh[:, :, 1].min()), float(mesh[:, :, 1].max()))


# ---------------------------------------------------------------------------------------------------------------


@dataclass
class MapWork:
    """One map drawn again: its new layers and locations, and the tile folders to put in place and to take out."""

    map_id: str
    layers: list[dict[str, tp.Any]]
    moved: dict[str, str]  # location id -> its new layer
    folders_in: list[str]
    folders_out: list[str]
    tiles: dict[str, dict[str, tp.Any]]  # layer id -> write_pyramid's result


def tile_folder(url: tp.Any) -> tuple[str, str] | None:
    """A layer's tile folder (`tiles/m10_01/f0/`) and its images' format, when its url is a plain folder path then
    `{z}/{x}/{y}.<png|webp>`."""
    if not isinstance(url, str):
        return None
    match = TILE_URL.match(url)
    if not match or any(part in ("..", ".") for part in match.group(1).split("/")):
        return None
    return match.group(1), match.group(2)


class Redrawer:
    def __init__(
        self,
        pack: Path,
        out: Path,
        events: Events,
        token: CancelToken | None = None,
        style: str | None = None,
        floor_overrides_file: Path | None = None,
        floor_method: str | None = None,
        scene_builder: Path | None = None,
        only_maps: tp.Sequence[str] = (),
    ):
        self.pack = Path(pack)
        self.out = Path(out)
        self.events = events
        self.token = token or CancelToken()
        self.floor_overrides_file = Path(floor_overrides_file) if floor_overrides_file else None
        self.floor_method = floor_method if floor_method in ("passages", "cuts") else None
        self.scene_builder = scene_builder
        self.only_maps = set(only_maps)
        self.warnings: list[str] = []
        self.started = time.monotonic()
        try:
            self.style: MapStyle = map_style(style)
        except ValueError as error:
            raise RedrawError(str(error)[:1].upper() + str(error)[1:] + ".") from None
        self.staging = self.pack.with_name(STAGING.format(self.pack.name))
        self.backup = self.pack.with_name(BACKUP.format(self.pack.name))

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        self.events.warning(message)

    def run(self) -> dict[str, tp.Any]:
        try:
            return self._run()
        finally:
            shutil.rmtree(self.staging, ignore_errors=True)
            shutil.rmtree(self.out / WORK, ignore_errors=True)

    def _run(self) -> dict[str, tp.Any]:
        events = self.events
        events.emit("start", tool=TOOL_NAME, version=__version__, folder=display_path(self.pack), mode="redraw")
        events.progress(0.0, "Reading the map pack")
        try:
            data = read_pack_json(self.pack)
        except (OSError, ValueError) as error:
            raise RedrawError(f"The map pack in {display_path(self.pack)} could not be read ({error}).") from None
        manifest = data["manifest"]
        builder = find_builder(self.scene_builder)
        if builder is None:
            raise RedrawError("The 3D builder that comes with the Map Maker (atlas-scene) is missing, so the 3D models cannot be read. Please reinstall the app.")
        game = str(manifest.get("gameId") or "")
        written_by = manifest.get("writtenBy") if isinstance(manifest.get("writtenBy"), dict) else {}
        ours = written_by.get("name") == WRITER
        try:
            config = load_config(game) if re.fullmatch(r"[a-z0-9-]{1,64}", game) else {}
        except (OSError, ValueError):
            config = {}
        own: dict[str, dict[str, tp.Any]] = {}
        own_error = None
        if self.floor_overrides_file is not None and game:
            try:
                own = load_floor_overrides(self.floor_overrides_file, game)
            except FileNotFoundError:
                own = {}
            except (OSError, ValueError) as error:
                own_error = f"{type(error).__name__}: {str(error).strip()[:200]}"
                self.warn(f"Your floor cuts ({self.floor_overrides_file.name}) could not be read ({own_error}): the pack's own floors are used")
        render = config.get("render", {}) if isinstance(config.get("render"), dict) else {}
        self.opacity = float(render.get("lowerFloorOpacity", 0.4))
        self.quality = int(render.get("tileQuality", 85))
        self.webp = tile_format("webp") == "webp"

        self.out.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.staging, ignore_errors=True)
        self.staging.mkdir(parents=True)
        maps = [m for m in data["maps"] if isinstance(m, dict) and isinstance(m.get("id"), str)]
        if self.only_maps:
            maps = [m for m in maps if m["id"] in self.only_maps]
        with_scene = [m for m in maps if isinstance(m.get("scene"), dict)]
        events.emit("maps", count=len(with_scene), maps=[{"id": m["id"], "name": m.get("name", m["id"])} for m in with_scene])
        report: dict[str, tp.Any] = {
            "tool": TOOL_NAME,
            "toolVersion": __version__,
            "reportVersion": REPORT_VERSION,
            "kind": "redraw",
            "createdAt": _now(),
            "pack": {
                "id": self.pack.name,
                "folder": display_path(self.pack),
                "title": manifest.get("title"),
                "gameId": game or None,
                "madeByMapMaker": ours,
            },
            "options": {
                "mapStyle": self.style.id,
                "floorOverrides": {
                    "file": self.floor_overrides_file.name if self.floor_overrides_file else None,
                    "error": own_error,
                },
                "floorMethod": self.floor_method,
            },
            "maps": [],
            "summary": None,
            "check3d": None,
            "warnings": self.warnings,
        }
        # Every layer's tile folder, so that no map's new tiles take a folder another layer reads.
        all_folders = {
            layer["id"]: tile_folder((layer.get("tiles") or {}).get("url"))
            for layer in data["layers"]
            if isinstance(layer, dict) and isinstance(layer.get("tiles"), dict)
        }
        done: list[MapWork] = []
        for index, entry in enumerate(maps):
            self.token.stop()
            name = str(entry.get("name") or entry["id"])
            started = time.monotonic()
            line: dict[str, tp.Any] = {"id": entry["id"], "name": name}
            if not isinstance(entry.get("scene"), dict):
                line.update(redrawn=False, reason="it has no 3D model")
            else:
                share = 0.05 + 0.85 * index / max(len(maps), 1)
                span = 0.85 / max(len(maps), 1)
                try:
                    work = self.redraw_map(entry, data, all_folders, own, config, ours, builder, line, share, span)
                    done.append(work)
                    line["redrawn"] = True
                except Skip as skip:
                    line.update(redrawn=False, reason=str(skip))
            line["seconds"] = round(time.monotonic() - started, 1)
            report["maps"].append(line)
            events.emit("map", **{k: line.get(k) for k in ("id", "name", "redrawn", "reason", "floors", "floorsFrom")})

        self.token.stop()  # the last moment to stop: from here the pack is changed
        if done:
            events.progress(0.92, "Putting the new pictures in the map pack")
            self.swap(data, done, ours)
            events.progress(0.96, "Checking the 3D maps of the pack")
            report["check3d"] = check_pack(builder, self.pack)
            for problem in report["check3d"].get("problems", [])[:5]:
                self.warn(f"The 3D check found a problem: {problem}")
        redrawn = [m for m in report["maps"] if m.get("redrawn")]
        report["summary"] = {
            "maps": len(report["maps"]),
            "redrawn": len(redrawn),
            "skipped": len(report["maps"]) - len(redrawn),
            "tiles": sum(m.get("tiles", 0) for m in redrawn),
        }
        report["elapsedSeconds"] = round(time.monotonic() - self.started, 1)
        events.progress(0.99, "Writing the report")
        report_path = self.out / "report.json"
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        events.emit("done", report=str(report_path), pack=str(self.pack), summary=report["summary"], warnings=len(self.warnings))
        return report

    # -----------------------------------------------------------------------------------------------------------

    def redraw_map(
        self,
        entry: dict[str, tp.Any],
        data: dict[str, tp.Any],
        all_folders: dict[str, tuple[str, str] | None],
        own: dict[str, dict[str, tp.Any]],
        config: dict[str, tp.Any],
        ours: bool,
        builder: Path,
        line: dict[str, tp.Any],
        share: float,
        span: float,
    ) -> MapWork:
        map_id = entry["id"]
        name = line["name"]

        def say(within: float, text: str) -> None:
            self.events.progress(share + span * min(max(within, 0.0), 1.0), f"{name}: {text}", map=map_id)

        frame = map_frame(entry)
        layers = [layer for layer in data["layers"] if isinstance(layer, dict) and layer.get("mapId") == map_id]
        if not layers:
            raise Skip("it has no layer to draw into")
        pack_floors = floors_of(layers)
        if len(pack_floors) < 2 and len(layers) > 1:
            raise Skip(f"it has {len(layers)} layers but not as floors (no heights), so which one to draw is not known")
        tail = map_id.rsplit(":", 1)[-1].lower()
        key = tail if AREA_KEY.fullmatch(tail) else None
        for layer in layers:
            found = all_folders.get(layer["id"])
            if found is None:
                raise Skip("its images are not in {z}/{x}/{y} folders of PNG or WebP pictures, which the redraw writes")
            if found[1] == "webp" and not self.webp:
                raise Skip("its images are WebP, which this computer's picture library cannot write")
            for other, folder in all_folders.items():
                if other != layer["id"] and folder is not None and (
                    folder[0].startswith(found[0]) or found[0].startswith(folder[0])
                ):
                    raise Skip("its images share a folder with another layer's")

        say(0.0, "reading its 3D model")
        work_folder = self.out / WORK
        model = unpack_model(builder, self.pack, map_id, work_folder, self.token.stop)
        mesh = model.triangles
        line.update(
            triangles=int(len(mesh)),
            cellsRead=model.report.get("cells"),
            levels=model.report.get("levels"),
            textures=model.report.get("textures"),
        )
        for warning in model.report.get("warnings", []) or []:
            self.warn(f"{name}: {warning}")
        if not len(mesh):
            raise Skip("its 3D model has no triangles")

        self.token.stop()
        say(0.2, f"finding floors in {len(mesh):,} triangles")
        choice = choose_floors(mesh, pack_floors, key, own, config, self.floor_method)
        plan = choice.plan
        floors = plan.floors
        if not floors:
            raise Skip("its 3D model has no walkable ground")
        line["floors"] = len(floors)
        line["floorsFrom"] = choice.source
        if plan.report.get("cutsDropped"):
            line["cutsDropped"] = plan.report["cutsDropped"]
        old_count = max(len(pack_floors), 1)
        relayer = ours and key is not None
        if len(floors) != old_count and not relayer:
            raise Skip(f"its floors now come to {len(floors)}, and its layers are {old_count}; only a pack the Map Maker made can change its layers")

        # The layers: the old ones (lowest first) for the same number of floors, else new ones as Make map writes them.
        names_asked = choice.overrides.get("names") if isinstance(choice.overrides.get("names"), list) else None
        heights = new_heights(plan, mesh) if relayer else None
        old_order = [layer for layer, _, _ in pack_floors] if pack_floors else layers[:1]
        if len(floors) == old_count:
            targets = list(old_order)
            if relayer:
                labels = floor_names(floors, choice.main, names_asked) if names_asked else [str(t.get("name", "")) for t in targets]
                targets = [
                    {
                        **target,
                        "name": label or target.get("name"),
                        **({"heights": heights[i]} if heights and i < len(heights) else {}),
                    }
                    for i, (target, label) in enumerate(zip(targets, labels))
                ]
                if not heights:
                    targets = [{k: v for k, v in t.items() if k != "heights"} for t in targets]
        else:
            assert key is not None
            pack_id = map_id.split(":", 1)[0]
            first = all_folders[layers[0]["id"]]
            fmt = first[1] if first else "png"
            size = int(layers[0].get("tileSize", 256))
            labels = floor_names(floors, choice.main, names_asked)
            by_index = []
            for floor, label in zip(floors, labels):
                layer = {
                    "id": f"{pack_id}:layer:{key}-f{floor.index}",
                    "mapId": map_id,
                    "name": label,
                    "tiles": {"type": "xyz", "url": f"tiles/{key}/f{floor.index}/{{z}}/{{x}}/{{y}}.{fmt}"},
                    "minZoom": 0,
                    "maxZoom": 0,
                    "tileSize": size,
                }
                if heights and floor.index < len(heights):
                    layer["heights"] = heights[floor.index]
                by_index.append(layer)
            targets = by_index
            line["layersChanged"] = {"before": old_count, "after": len(floors)}
        # Layers in layers.json's order: as Make map orders them for a new set, else as they were.
        if len(floors) == old_count:
            ordered = [next((t for t in targets if t["id"] == layer["id"]), layer) for layer in layers]
        else:
            ordered = [targets[i] for i in layer_order(floors, choice.main)]

        # The pictures, each floor over the faded ones below it, cut into its layer's tiles.
        surface = model.surface
        low, high = (np.percentile(mesh[plan.walkable][:, :, 1], [2, 98]) if plan.walkable.any() else (0.0, 1.0))

        def pictures() -> tp.Iterator[tuple[int, tp.Any]]:
            for floor in floors:
                chosen = np.flatnonzero(plan.triangle_floor == floor.index)
                walls = plan.wall_lines[floor.index] if floor.index < len(plan.wall_lines) else np.zeros((0, 2, 2))
                yield floor.index, draw_floor(
                    frame,
                    self.style,
                    mesh[chosen],
                    walls,
                    index=floor.index,
                    floor_range=(floor.low, floor.high),
                    area_range=(float(low), float(high)),
                    flipped=plan.flipped,
                    surface=surface.subset(chosen),
                )

        tiles: dict[str, dict[str, tp.Any]] = {}
        folders_in = []
        for done, (floor_index, picture) in enumerate(compose(frame, pictures(), self.opacity)):
            self.token.stop()
            target = targets[floor_index]
            say(0.4 + 0.6 * done / len(floors), f"drawing {target.get('name') or 'a floor'}")
            found = tile_folder(target["tiles"]["url"])
            if found is None:
                raise Skip("its images are not in {z}/{x}/{y} folders")
            folder, fmt = found
            size = int(target.get("tileSize", 256))
            if not (64 <= size <= 1024):
                raise Skip(f"its tiles are {size} pixels, which the redraw does not write")
            written = write_pyramid(
                picture,
                self.staging / folder,
                tile_size=size,
                fmt=fmt,
                quality=self.quality,
                background=BACKGROUND,
                stop=self.token.stop,
            )
            tiles[target["id"]] = written
            folders_in.append(folder)
            del picture
        for layer in ordered:
            if layer["id"] in tiles:
                layer["minZoom"] = tiles[layer["id"]]["minZoom"]
                layer["maxZoom"] = tiles[layer["id"]]["maxZoom"]
        line["tiles"] = sum(t["files"] for t in tiles.values())

        # The locations on each floor, by their height, as Make map puts markers on floors (the Map Maker's packs).
        moved: dict[str, str] = {}
        if relayer:
            layer_of = {floor.index: targets[floor.index]["id"] for floor in floors}
            kept = {layer["id"] for layer in ordered}
            for location in data["locations"]:
                if not isinstance(location, dict) or location.get("mapId") != map_id:
                    continue
                height = location.get("height")
                x, y = location.get("x"), location.get("y")
                if isinstance(height, (int, float)) and isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    wx, wy = frame.to_world(float(x), float(y))
                    placed = locate(plan, wx, float(height), wy)
                    new = layer_of.get(min(placed.floor, len(floors) - 1))
                elif location.get("layerId") in kept:
                    new = location.get("layerId")
                else:
                    new = layer_of.get(choice.main)
                if new is not None and new != location.get("layerId"):
                    moved[location["id"]] = new
            line["locationsMoved"] = len(moved)
        folders_out = [folder for layer in layers if (folder := all_folders[layer["id"]]) is not None and folder[0] not in folders_in]
        return MapWork(map_id, ordered, moved, folders_in, [f for f, _ in folders_out], tiles)

    # -----------------------------------------------------------------------------------------------------------

    def swap(self, data: dict[str, tp.Any], done: list[MapWork], ours: bool) -> None:
        """Puts the new tiles and JSON files in place (see the top of this module)."""
        changed = {work.map_id: work for work in done}
        layers: list[tp.Any] = []
        placed: set[str] = set()
        for layer in data["layers"]:
            map_id = layer.get("mapId") if isinstance(layer, dict) else None
            if map_id in changed:
                if map_id not in placed:
                    layers.extend(changed[map_id].layers)
                    placed.add(map_id)
                continue
            layers.append(layer)
        moved = {k: v for work in done for k, v in work.moved.items()}
        locations = [
            {**loc, "layerId": moved[loc["id"]]} if isinstance(loc, dict) and loc.get("id") in moved else loc
            for loc in data["locations"]
        ]
        manifest = dict(data["manifest"])
        stamp = now()
        manifest["updated"] = stamp
        contents = manifest.get("contents")
        if isinstance(contents, dict):
            contents = dict(contents)
            entries = []
            for entry in contents.get("maps") or []:
                work = changed.get(entry.get("id")) if isinstance(entry, dict) else None
                if work is None:
                    entries.append(entry)
                    continue
                old = {item.get("id"): item for item in entry.get("layers") or [] if isinstance(item, dict)}
                new_layers = []
                for layer in work.layers:
                    item = dict(old.get(layer["id"]) or {"id": layer["id"], "tiles": "xyz", "downloadable": False})
                    item.update(name=layer.get("name"), minZoom=layer["minZoom"], maxZoom=layer["maxZoom"])
                    written = work.tiles.get(layer["id"])
                    if written is not None and (isinstance(item.get("images"), dict) or layer["id"] not in old):
                        item["images"] = {
                            **(item.get("images") if isinstance(item.get("images"), dict) else {}),
                            "levels": list(range(written["minZoom"], written["maxZoom"] + 1)),
                            "complete": True,
                            "files": written["files"],
                            "bytes": written["bytes"],
                            "updatedAt": stamp,
                        }
                    new_layers.append(item)
                entries.append({**entry, "layers": new_layers})
            contents["maps"] = entries
            if ours and isinstance(contents.get("counts"), dict):
                contents["counts"] = content_counts(
                    data["maps"], layers, locations, data["categories"], data["regions"], data["guides"]
                )
            manifest["contents"] = contents
        texts = {
            FILES["layers"]: collection_text(layers),
            FILES["locations"]: collection_text(locations),
            "manifest.json": json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        }
        swap_in(self.pack, self.staging, self.backup, texts, [f for w in done for f in w.folders_in], [f for w in done for f in w.folders_out])


def swap_in(target: Path, staging: Path, backup: Path, texts: dict[str, str], folders_in: list[str], folders_out: list[str]) -> None:
    """The new tile folders (`folders_in`, from `staging`) and JSON files (`texts`) in place in the pack `target`,
    `folders_out` taken out, all by renames, the old ones moved into `backup` until the end and put back if anything
    fails (then RedrawError). The manifest is swapped last."""
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)
    partials: list[Path] = []
    aside: list[str] = []
    moved_in: list[str] = []
    swapped: list[str] = []
    order = [name for name in texts if name != "manifest.json"] + ["manifest.json"]
    try:
        backup.mkdir(parents=True)
        for name in order:
            partial = target / f".{name}.partial"
            partial.write_text(texts[name], encoding="utf-8")
            partials.append(partial)
        for folder in dict.fromkeys([*folders_out, *folders_in]):
            old = target / folder
            if old.exists():
                (backup / folder).parent.mkdir(parents=True, exist_ok=True)
                old.rename(backup / folder)
                aside.append(folder)
        for folder in folders_in:
            (target / folder).parent.mkdir(parents=True, exist_ok=True)
            (staging / folder).rename(target / folder)
            moved_in.append(folder)
        for name in order:
            current = target / name
            if current.exists():
                shutil.copy2(current, backup / name)
            (target / f".{name}.partial").replace(current)
            swapped.append(name)
    except OSError as error:
        restored = True

        def quietly(action: tp.Callable[[], tp.Any]) -> bool:
            try:
                action()
            except OSError:
                return False
            return True

        for name in reversed(swapped):
            restored &= quietly(lambda name=name: (backup / name).replace(target / name))
        for folder in reversed(moved_in):
            restored &= quietly(lambda folder=folder: (target / folder).rename(staging / folder))
        for folder in reversed(aside):
            restored &= quietly(lambda folder=folder: (backup / folder).rename(target / folder))
        if restored:
            shutil.rmtree(backup, ignore_errors=True)
            raise RedrawError(
                f"The new pictures could not be put in the map pack ({error}), so it was left as it was. If Atlas is "
                "open, close it and press Draw all areas again."
            ) from error
        raise RedrawError(
            f"The new pictures could not be put in the map pack ({error}), and the old ones could not all be put "
            f"back: they are in {backup}."
        ) from error
    finally:
        for partial in partials:
            partial.unlink(missing_ok=True)
    shutil.rmtree(backup, ignore_errors=True)
    # Folders left empty by layers taken out.
    for folder in folders_out:
        parent = (target / folder).parent
        while parent != target and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent


def redraw(pack: Path, out: Path, events: Events, **options: tp.Any) -> dict[str, tp.Any]:
    return Redrawer(pack, out, events, **options).run()
