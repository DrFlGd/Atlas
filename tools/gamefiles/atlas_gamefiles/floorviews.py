"""The views of the Map Maker's Adjust floors panel, redrawn from the player's cuts in a second or two, without
reading the game files again.

Make map keeps what finding floors needs of each area in its output folder (`floor-data/<mAA_BB>.npz`, on the
player's PC only, never in the report zip): the area's walkable and wall triangles, its markers' positions and
categories, and its floor settings. `atlas-gamefiles floor-views <output folder> --area <mAA_BB>` loads that once,
then answers one request per line on standard input (`{"id": 1, "cuts": [4.5, 12], "names": ["", "Roof"]}`) with
one `views` line on standard output, until standard input ends:

- `floors`: each floor between the cuts, lowest first: its name, the heights of its walkable surface, its walkable
  area, its markers, and a small picture of it from above (north up, the floors below faded, as the map draws it);
- `side`: the area's walkable floor seen from the south (`x`, east-west across) and from the east (`z`,
  north-south across), height up, each floor in its own colour, so the player sees which platforms a cut slices;
- `profile`: the walkable area at each height, as the report has it, and `cuts`: the cuts used (a cut that leaves
  a floor with nothing on it is dropped, as Make map drops it).

Pictures come as `data:` URLs. Nothing is written.
"""

from __future__ import annotations

import base64
import io
import json
import math
import time
import typing as tp
from pathlib import Path

import numpy as np

from . import __version__
from .config import area_key, clean_floor_entry
from .events import Events, claim_stdin, stdin_lines
from .floors import FloorPlan, Prepared, apply_overrides, height_profile, locate, plan_floors, prepare
from .pack import floor_names
from .render import BACKGROUND, ITEM_COLOUR, MARKER_COLOURS, WALL, ramp_colours

FLOOR_DATA = "floor-data"
DATA_VERSION = 1
TOP_SIZE = 480  # pixels, the longer side of a floor seen from above
SIDE_WIDTH = 640
SIDE_ROWS = 360
# One colour per floor in the side views, lowest first (the panel draws its floor list in the same colours).
FLOOR_COLOURS = ((79, 193, 178), (240, 170, 80), (160, 140, 245), (240, 110, 130), (110, 180, 245), (170, 210, 90))


def floor_colour(index: int) -> tuple[int, int, int]:
    return FLOOR_COLOURS[index % len(FLOOR_COLOURS)]


def data_file(out: Path, key: str) -> Path:
    return Path(out) / FLOOR_DATA / f"{area_key(key.lower())}.npz"


def save_floor_data(
    out: Path,
    key: str,
    name: str,
    mesh: np.ndarray,
    plan: FloorPlan,
    markers: list[tuple[tuple[float, float, float], str]],
    floor_settings: dict[str, tp.Any] | None,
    colour_range: tuple[float, float],
    shipped: dict[str, tp.Any],
    lower_opacity: float,
) -> Path:
    """Keeps what the views need of an area (see the top of this module)."""
    keep = plan.walkable | plan.walls if len(mesh) else np.zeros(0, dtype=bool)
    triangles = np.asarray(mesh, dtype=np.float32)[keep] if len(mesh) else np.zeros((0, 3, 3), dtype=np.float32)
    positions = np.array([position for position, _ in markers], dtype=np.float64).reshape(-1, 3)
    categories = np.array([category for _, category in markers], dtype="U16")
    meta = {
        "version": DATA_VERSION,
        "toolVersion": __version__,
        "key": key,
        "name": name,
        "floors": floor_settings or {},
        "colourRange": [float(colour_range[0]), float(colour_range[1])],
        "shipped": shipped,
        "lowerFloorOpacity": lower_opacity,
    }
    path = data_file(out, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    with open(partial, "wb") as handle:
        np.savez_compressed(handle, triangles=triangles, markers=positions, categories=categories, meta=np.array(json.dumps(meta)))
    partial.replace(path)
    return path


class AreaViews:
    """One area's floor data, prepared once, and its views for any cuts."""

    def __init__(self, path: Path):
        with np.load(path, allow_pickle=False) as data:
            self.meta: dict[str, tp.Any] = json.loads(str(data["meta"]))
            triangles = data["triangles"]
            self.markers = data["markers"]
            self.categories = [str(c) for c in data["categories"]]
        if self.meta.get("version") != DATA_VERSION:
            raise ValueError("the floor data was written by another version of the Map Maker")
        self.prepared: Prepared = prepare(triangles, self.meta.get("floors"))
        heights = self.prepared.surfaces.height if self.prepared.surfaces is not None else np.zeros(0)
        self.profile = height_profile(heights, self.prepared.settings["cell"])

    def ready(self) -> dict[str, tp.Any]:
        return {
            "area": self.meta.get("key"),
            "profile": self.profile,
            "automatic": [round(c, 2) for c in self.prepared.auto],
            "shipped": self.meta.get("shipped") or {},
            # What the area has without the player's own cuts: the config's over the automatic ones.
            "shippedCuts": [round(c, 2) for c in apply_overrides(list(self.prepared.auto), self.meta.get("shipped") or {})],
        }

    def views(self, cuts: list[float], names: list[str] | None) -> dict[str, tp.Any]:
        started = time.monotonic()
        plan = plan_floors(self.prepared, overrides={"cuts": cuts})
        floors = plan.floors
        main = max(floors, key=lambda f: f.area).index if floors else 0
        floor_count = max(len(floors), 1)
        marker_floor = []
        for x, y, z in self.markers:
            marker_floor.append(min(locate(plan, float(x), float(y), float(z)).floor, floor_count - 1))
        tops = self.top_views(plan, marker_floor)
        labels = floor_names(floors, main, names)
        floor_list = []
        for floor, label in zip(floors, labels):
            on_floor = [c for c, f in zip(self.categories, marker_floor) if f == floor.index]
            floor_list.append(
                {
                    "index": floor.index,
                    "name": label,
                    "heights": [round(floor.low, 1), round(floor.high, 1)],
                    "areaSquareMetres": round(floor.area),
                    "markers": len(on_floor),
                    "colour": "#%02x%02x%02x" % floor_colour(floor.index),
                    "top": tops[floor.index] if floor.index < len(tops) else None,
                }
            )
        return {
            "cuts": [round(c, 2) for c in plan.cuts],
            "dropped": plan.report.get("cutsDropped", []),
            "mainFloor": main,
            "profile": self.profile,
            "floors": floor_list,
            "side": {axis: self.side_view(plan, axis) for axis in ("x", "z")},
            "seconds": round(time.monotonic() - started, 2),
        }

    # ------------------------------------------------------------------------------------------------------

    def top_views(self, plan: FloorPlan, marker_floor: list[int]) -> list[str]:
        """Each floor from above, on the grid of the floor finder (a metre a cell), the floors below faded."""
        from PIL import Image, ImageDraw

        surfaces = plan.surfaces
        if surfaces is None:
            return []
        nx, nz = surfaces.shape
        ix, iz = surfaces.key // nz, surfaces.key % nz
        low, high = self.meta.get("colourRange", [0.0, 1.0])
        opacity = float(self.meta.get("lowerFloorOpacity", 0.4))
        scale = TOP_SIZE / max(nx, nz)
        size = (max(1, round(nx * scale)), max(1, round(nz * scale)))
        under = np.empty((nz, nx, 3), dtype=np.float64)
        under[:] = BACKGROUND
        out = []
        for floor in plan.floors:
            mine = surfaces.floor == floor.index
            grid = np.full((nx, nz), -np.inf)
            np.maximum.at(grid, (ix[mine], iz[mine]), surfaces.height[mine])
            filled = np.isfinite(grid).T[::-1]  # rows from the north down, columns from the west
            t = (grid.T[::-1][filled] - low) / (high - low) if high > low else np.full(int(filled.sum()), 0.5)
            colours = ramp_colours(t)
            picture = under.copy()
            picture[filled] = colours
            image = Image.fromarray(picture.astype(np.uint8), "RGB").resize(size, Image.Resampling.NEAREST if scale >= 1 else Image.Resampling.BOX)
            draw = ImageDraw.Draw(image)
            walls = plan.wall_lines[floor.index] if floor.index < len(plan.wall_lines) else np.zeros((0, 2, 2))
            if len(walls):
                pixels = self._pixels(surfaces, walls.reshape(-1, 2), scale, nz).reshape(-1, 2, 2).round(1).tolist()
                for (x0, y0), (x1, y1) in pixels:
                    draw.line([(x0, y0), (x1, y1)], fill=WALL, width=1)
            dots = [i for i, f in enumerate(marker_floor) if f == floor.index]
            if dots:
                points = self._pixels(surfaces, self.markers[dots][:, [0, 2]], scale, nz)
                for (x, y), i in zip(points.tolist(), dots):
                    category = self.categories[i]
                    r = 3 if category in ("bonfire", "boss") else 2
                    draw.ellipse([x - r, y - r, x + r, y + r], fill=MARKER_COLOURS.get(category, ITEM_COLOUR), outline=(0, 0, 0))
            out.append(png_url(image))
            under[filled] = under[filled] * (1 - opacity) + colours * opacity
        return out

    @staticmethod
    def _pixels(surfaces: tp.Any, xz: np.ndarray, scale: float, nz: int) -> np.ndarray:
        x = (xz[:, 0] - surfaces.origin[0]) / surfaces.cell * scale
        y = (nz - (xz[:, 1] - surfaces.origin[1]) / surfaces.cell) * scale
        return np.stack([x, y], axis=1)

    def side_view(self, plan: FloorPlan, axis: str) -> dict[str, tp.Any]:
        """The walkable floor seen from the side: `x` from the south (west on the left), `z` from the east (south
        on the left); height up over the profile's range, each floor in its colour, brighter where more floor is
        stacked in one place."""
        from PIL import Image

        surfaces = plan.surfaces
        low, high = float(self.profile["low"]), float(self.profile["high"])
        if surfaces is None or high <= low:
            return {"image": None, "low": low, "high": high, "from": 0.0, "to": 0.0}
        nx, nz = surfaces.shape
        across = (surfaces.key // nz) if axis == "x" else (surfaces.key % nz)
        columns = nx if axis == "x" else nz
        origin = surfaces.origin[0] if axis == "x" else surfaces.origin[1]
        rows = SIDE_ROWS
        row = np.clip(((high - surfaces.height) / (high - low) * rows).astype(np.int64), 0, rows - 1)
        floors = max(len(plan.floors), 1)
        counts = np.zeros((floors, rows, columns), dtype=np.float64)
        np.add.at(counts, (np.clip(surfaces.floor, 0, floors - 1), row, across), 1.0)
        total = counts.sum(axis=0)
        which = counts.argmax(axis=0)
        strength = np.log1p(total) / math.log1p(max(float(total.max()), 1.0))
        palette = np.array([floor_colour(i) for i in range(floors)], dtype=np.float64)
        picture = np.empty((rows, columns, 3), dtype=np.float64)
        picture[:] = BACKGROUND
        shown = total > 0
        picture[shown] = palette[which[shown]] * (0.45 + 0.55 * strength[shown, None])
        # Floors seen edge on are thin: each is drawn a row thicker above and below, where nothing else is.
        for shift in (1, -1):
            spread = np.roll(shown, shift, axis=0)
            spread[0 if shift == 1 else -1] = False
            fill = spread & ~shown
            picture[fill] = np.roll(picture, shift, axis=0)[fill]
        image = Image.fromarray(np.clip(picture, 0, 255).astype(np.uint8), "RGB")
        width = SIDE_WIDTH
        image = image.resize((width, rows), Image.Resampling.NEAREST if columns <= width else Image.Resampling.BOX)
        return {
            "image": png_url(image),
            "low": low,
            "high": high,
            "from": round(origin, 1),
            "to": round(origin + columns * surfaces.cell, 1),
        }


def png_url(image: tp.Any) -> str:
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=False, compress_level=3)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def serve(out: Path, area: str, events: Events, lines: tp.Iterable[str] | None = None) -> int:
    """The `floor-views` command: answers requests until standard input (or `lines`) ends. Exit code 0, or 1 when
    the area's floor data is missing or cannot be read."""
    path = data_file(out, area)
    if not path.is_file():
        events.emit(
            "error",
            code="no-floor-data",
            message="The floors of this area were made by an older Map Maker. Press Make map once, then Adjust floors.",
        )
        return 1
    try:
        views = AreaViews(path)
    except (OSError, ValueError, KeyError) as error:
        events.emit("error", code="no-floor-data", message=f"The floor data of this area could not be read ({error}). Press Make map again.")
        return 1
    events.emit("ready", **views.ready())
    if lines is None:
        fd = claim_stdin()
        lines = stdin_lines(fd) if fd is not None else iter(())
    for line in lines:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("a request is a JSON object")
            request_id = request.get("id")
            entry = clean_floor_entry({"cuts": request.get("cuts", []), "names": request.get("names", [])}) or {}
            names = entry.get("names")
            events.emit("views", id=request_id, **views.views(entry.get("cuts", []), names if names else None))
        except Exception as error:  # one bad request does not end the views
            events.emit("error", id=request_id, message=f"{type(error).__name__}: {error}")
    return 0
