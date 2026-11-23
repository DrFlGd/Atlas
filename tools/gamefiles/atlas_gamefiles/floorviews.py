"""The views of the Map Maker's Adjust floors panel, redrawn from the player's cuts in a moment, without reading the
game files again.

Make map keeps what finding floors needs of each area in its output folder (`floor-data/<mAA_BB>.npz`, on the
player's PC only, never in the report zip): the area's collision triangles, its markers' positions and types, and
its floor settings. `atlas-gamefiles floor-views <output folder> --area <mAA_BB>` loads that once and says `ready`
with what does not change with the cuts:

- `model`: the area's triangles for the panel's 3D view, each corner's x, height and z as 16-bit steps between
  `min` and `max` (little-endian, base64), three corners a triangle;
- `section`: the whole area seen from the south (`x`, west on the left) and from the east (`z`, south on the left),
  height up, one byte a pixel, rows from the top (`heights.high`) down: 0 nothing, 1 to 127 a wall or slope, 128 to
  255 walkable floor (drawn three pixels thick), brighter the nearer it is. The panel colours each row by the floor
  its height is on, so the cuts can move without asking again;
- `markers`: each marker's position and type, with its colour on the map;
- `heights`: the heights the panel shows (the walkable floor's, and a little of the walls above and below);
- `profile`: the walkable area at each height, as the report has it, and the cuts without the player's own.

Then it answers one request per line on standard input (`{"id": 1, "cuts": [4.5, 12], "names": ["", "Roof"]}`,
with `"outlines": true` for the pictures from above with outlines) with one `views` line on standard output, until
standard input ends:

- `floors`: each floor between the cuts, lowest first: its name, the heights of its walkable surface, its walkable
  area, its markers, and a small picture of it from above (north up, the floors below faded, as the map draws it);
- `markers`: the floor each marker is put on, and the height of the walkable surface under it (none: no surface
  under it, so it goes by its height);
- `cuts`: the cuts used (a cut that leaves a floor with nothing on it is dropped, as Make map drops it).

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
from .floors import FloorPlan, Prepared, apply_overrides, height_profile, locate, plan_floors, prepare, sample
from .pack import floor_names
from .render import BACKGROUND, ITEM_COLOUR, MARKER_COLOURS, OUTLINE, WALL, ramp_colours

FLOOR_DATA = "floor-data"
DATA_VERSION = 1
TOP_SIZE = 480  # pixels, the longer side of a floor seen from above
SECTION_COLUMNS = 720  # pixels across a section
SECTION_ROWS = 400  # pixels from its top height to its bottom one
SECTION_SAMPLES = 4_000_000  # pixel samples worked out at once while drawing a section
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
    triangles = np.asarray(mesh, dtype=np.float32).reshape(-1, 3, 3)
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
        self.low, self.high = shown_heights(self.profile, self.prepared.triangles)

    def ready(self) -> dict[str, tp.Any]:
        return {
            "area": self.meta.get("key"),
            "profile": self.profile,
            "heights": {"low": self.low, "high": self.high},
            "model": self.model(),
            "section": {axis: self.section(axis) for axis in ("x", "z")},
            "markers": [
                {
                    "x": round(float(x), 2),
                    "y": round(float(y), 2),
                    "z": round(float(z), 2),
                    "type": category,
                    "colour": "#%02x%02x%02x" % MARKER_COLOURS.get(category, ITEM_COLOUR),
                }
                for (x, y, z), category in zip(self.markers.tolist(), self.categories)
            ],
            "automatic": [round(c, 2) for c in self.prepared.auto],
            "shipped": self.meta.get("shipped") or {},
            # What the area has without the player's own cuts: the config's over the automatic ones.
            "shippedCuts": [round(c, 2) for c in apply_overrides(list(self.prepared.auto), self.meta.get("shipped") or {})],
        }

    def views(self, cuts: list[float], names: list[str] | None, outlines: bool = False) -> dict[str, tp.Any]:
        started = time.monotonic()
        plan = plan_floors(self.prepared, overrides={"cuts": cuts})
        floors = plan.floors
        main = max(floors, key=lambda f: f.area).index if floors else 0
        floor_count = max(len(floors), 1)
        marker_floor = []
        marker_list = []
        for x, y, z in self.markers:
            placed = locate(plan, float(x), float(y), float(z))
            marker_floor.append(min(placed.floor, floor_count - 1))
            surface = round(placed.surface_height, 2) if placed.on_floor and placed.surface_height is not None else None
            marker_list.append({"floor": marker_floor[-1], "surface": surface})
        tops = self.top_views(plan, marker_floor, outlines)
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
            "markers": marker_list,
            "seconds": round(time.monotonic() - started, 2),
        }

    # ------------------------------------------------------------------------------------------------------

    def top_views(self, plan: FloorPlan, marker_floor: list[int], outlines: bool = False) -> list[str]:
        """Each floor from above, on the grid of the floor finder (a metre a cell), the floors below faded; with
        `outlines`, the walls and the edge of the floor as light lines (as the map style with outlines draws them)."""
        from PIL import Image, ImageChops, ImageDraw, ImageFilter

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
            resample = Image.Resampling.NEAREST if scale >= 1 else Image.Resampling.BOX
            image = Image.fromarray(picture.astype(np.uint8), "RGB").resize(size, resample)
            if outlines:
                mask = Image.fromarray((filled * 255).astype(np.uint8), "L").resize(size, Image.Resampling.NEAREST)
                image.paste(WALL, (0, 0), ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5))))
                image.paste(OUTLINE, (0, 0), ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(3))))
            draw = ImageDraw.Draw(image)
            walls = plan.wall_lines[floor.index] if floor.index < len(plan.wall_lines) else np.zeros((0, 2, 2))
            if len(walls):
                pixels = self._pixels(surfaces, walls.reshape(-1, 2), scale, nz).reshape(-1, 2, 2).round(1).tolist()
                for (x0, y0), (x1, y1) in pixels:
                    draw.line([(x0, y0), (x1, y1)], fill=WALL, width=4 if outlines else 1)
                if outlines:
                    for (x0, y0), (x1, y1) in pixels:
                        draw.line([(x0, y0), (x1, y1)], fill=OUTLINE, width=2)
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

    def model(self) -> dict[str, tp.Any]:
        """The triangles for the 3D view (see the top of this module)."""
        corners = self.prepared.triangles.reshape(-1, 3).astype(np.float64)
        if len(corners) == 0:
            return {"triangles": 0, "min": [0, 0, 0], "max": [0, 0, 0], "positions": ""}
        low, high = corners.min(axis=0), corners.max(axis=0)
        span = np.where(high > low, high - low, 1.0)
        steps = np.round((corners - low) / span * 65535).astype("<u2")
        return {
            "triangles": int(len(corners) // 3),
            "min": [round(float(v), 3) for v in low],
            "max": [round(float(v), 3) for v in low + span],
            "positions": base64.b64encode(steps.tobytes()).decode("ascii"),
        }

    def section(self, axis: str) -> dict[str, tp.Any]:
        """The whole area seen from the side, walls and all (see the top of this module): `x` from the south, `z`
        from the east. Walls and slopes are drawn see-through, brighter where more of them stand one behind another,
        so the rooms inside show through the outer walls; walkable floor is drawn over them, brighter the nearer."""
        triangles = self.prepared.triangles
        columns, rows = SECTION_COLUMNS, SECTION_ROWS
        low, high = self.low, self.high
        empty = {"columns": columns, "rows": rows, "from": 0.0, "to": 0.0, "pixels": ""}
        if len(triangles) == 0 or high <= low:
            return empty
        # Across the picture and away from the viewer: from the south, x and z; from the east, z and minus x.
        across_of = (lambda p: p[..., 0]) if axis == "x" else (lambda p: p[..., 2])
        depth_of = (lambda p: p[..., 2]) if axis == "x" else (lambda p: -p[..., 0])
        across_all = across_of(triangles).astype(np.float64)
        start, end = float(across_all.min()), float(across_all.max())
        if end <= start:
            return empty
        depth_all = depth_of(triangles).astype(np.float64)
        near, far = float(depth_all.min()), float(depth_all.max())
        to_column = columns / (end - start)
        to_row = rows / (high - low)
        layers = np.zeros(rows * columns, dtype=np.int64)
        floors = np.full(rows * columns, np.inf)

        def inside(column: np.ndarray, row: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
            keep = (column >= 0) & (column < columns) & (row >= 0) & (row < rows)
            return keep, row[keep] * columns + column[keep]

        flat = np.empty(triangles.shape, dtype=np.float64)
        flat[..., 0] = (across_all - start) * to_column
        flat[..., 1] = depth_all
        flat[..., 2] = (high - triangles[..., 1].astype(np.float64)) * to_row
        walkable = self.prepared.walkable
        boxes = (np.ptp(flat[..., 0], axis=1) + 1) * (np.ptp(flat[..., 2], axis=1) + 1)
        first = 0
        while first < len(flat):
            last = first + 1
            total = boxes[first]
            while last < len(flat) and total + boxes[last] <= SECTION_SAMPLES:
                total += boxes[last]
                last += 1
            column, row, depth, tri = sample(flat[first:last], 1.0, (0.0, 0.0))
            keep, pixel = inside(column, row)
            on_floor = walkable[first:last][tri[keep]]
            np.add.at(layers, pixel[~on_floor], 1)
            np.minimum.at(floors, pixel[on_floor], depth[keep][on_floor])
            first = last
        # Walkable surfaces seen edge on are lines: draw each cell of the surface grid as a short line.
        surfaces = self.prepared.surfaces
        if surfaces is not None and len(surfaces.key):
            nz = surfaces.shape[1]
            centre = np.stack(
                [
                    surfaces.origin[0] + (surfaces.key // nz + 0.5) * surfaces.cell,
                    surfaces.height,
                    surfaces.origin[1] + (surfaces.key % nz + 0.5) * surfaces.cell,
                ],
                axis=-1,
            )
            left = (across_of(centre) - surfaces.cell / 2 - start) * to_column
            width = max(1, int(math.ceil(surfaces.cell * to_column)))
            row = np.floor((high - surfaces.height) * to_row).astype(np.int64)
            depth = depth_of(centre)
            for step in range(width + 1):
                keep, pixel = inside(np.floor(left + step).astype(np.int64), row)
                np.minimum.at(floors, pixel, depth[keep])
        floors = floors.reshape(rows, columns)
        thick = floors.copy()
        thick[1:] = np.minimum(thick[1:], floors[:-1])
        thick[:-1] = np.minimum(thick[:-1], floors[1:])
        is_floor = np.isfinite(thick)
        nearness = np.where(is_floor, (far - np.where(is_floor, thick, far)) / (far - near) if far > near else 1.0, 0.0)
        layers = layers.reshape(rows, columns)
        walled = layers > 0
        most = float(np.percentile(layers[walled], 98)) if walled.any() else 1.0
        density = np.log1p(np.minimum(layers, most)) / math.log1p(max(most, 1.0))
        pixels = np.where(is_floor, 128 + np.round(np.clip(nearness, 0, 1) * 127), np.where(walled, 1 + np.round(density * 126), 0))
        return {
            "columns": columns,
            "rows": rows,
            "from": round(start, 2),
            "to": round(end, 2),
            "pixels": base64.b64encode(pixels.astype(np.uint8).tobytes()).decode("ascii"),
        }


def shown_heights(profile: dict[str, tp.Any], triangles: np.ndarray) -> tuple[float, float]:
    """The heights the panel shows: the walkable floor's, and the triangles' a little above and below it (at most a
    few metres, so a far-off piece does not shrink the rest)."""
    low, high = float(profile["low"]), float(profile["high"])
    if len(triangles) == 0:
        return low, max(high, low + 1.0)
    ys = triangles[..., 1]
    if high <= low:
        low, high = float(ys.min()), float(ys.max())
    pad = max(4.0, 0.15 * (high - low))
    shown_low = min(low, max(float(ys.min()), low - pad))
    shown_high = max(high, min(float(ys.max()), high + pad))
    return math.floor(shown_low * 2) / 2, max(math.ceil(shown_high * 2) / 2, math.floor(shown_low * 2) / 2 + 1.0)


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
            outlines = request.get("outlines") is True
            events.emit("views", id=request_id, **views.views(entry.get("cuts", []), names if names else None, outlines))
        except Exception as error:  # one bad request does not end the views
            events.emit("error", id=request_id, message=f"{type(error).__name__}: {error}")
    return 0
