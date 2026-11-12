"""Floors from an area's collision (or navmesh) triangles.

1. **Walkable** triangles face up (their normal is within `walkableSlope` degrees of straight up); **walls** are
   steeper than `wallSlope`. Which way a triangle faces depends on the order of its corners; the side most of the
   flat surface faces is taken as up, so a mesh with the other winding still works.
2. The walkable triangles are sampled on a grid of `cell`-metre cells, seen from above. Each cell keeps its
   **surfaces**: the heights at which something walkable crosses it (heights within a metre of each other are one
   surface).
3. Where two surfaces of one cell are at least `clearance` apart, one floor is **stacked** above another there.
   The area is cut into floors at the heights that separate the most stacked surface while slicing through the
   least walkable surface (a cut in the gap between storeys, not through a slope), one cut at a time, until no
   cut separates at least `minStackedArea` square metres of stacked floor, or there are `maxFloors` floors.
   An area with nothing stacked is one floor. Per area, the config can name floors and add, drop or replace cuts.
4. **Connected pieces stay whole**: a piece of floor that a cut only clips (a ramp or a slope that rises a little
   past the cut, joined to the floor it belongs to, with nothing stacked over it) is moved back onto that floor.
5. Each walkable triangle goes to the floor most of its samples are on, and each **wall** triangle is cut at
   `wallCutHeight` above the floor next to it, giving the wall lines of that floor.

Markers are put on the floor of the surface just below them (`locate`).
"""

from __future__ import annotations

import math
import typing as tp
from dataclasses import dataclass, field

import numpy as np

DEFAULTS: dict[str, float] = {
    "cell": 1.0,
    "clearance": 3.0,
    "minStackedArea": 150.0,
    "maxFloors": 5,
    "minFloorHeight": 4.0,
    "walkableSlope": 50.0,
    "wallSlope": 70.0,
    "wallCutHeight": 1.3,
}
STEP = 1.0  # metres: heights closer than this in one cell are one surface
JOIN = 1.5  # metres: neighbouring cells' surfaces closer than this in height are joined (for connected pieces)
SAMPLE_BUDGET = 6_000_000  # cell tests per chunk while sampling


@dataclass
class Floor:
    index: int  # 0 is the lowest
    low: float  # height range of its walkable surface (5th to 95th percentile)
    high: float
    area: float  # square metres seen from above
    triangles: int
    name: str = ""


@dataclass
class Surfaces:
    """Walkable surfaces per grid cell, sorted by cell and then height."""

    cell: float
    origin: tuple[float, float]  # world x, z of the grid's corner
    shape: tuple[int, int]  # cells along x, z
    key: np.ndarray  # cell number (ix * nz + iz)
    height: np.ndarray
    triangle: np.ndarray  # one walkable triangle that makes the surface (index into the walkable triangles)
    floor: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int32))

    def cells(self, x: float, z: float) -> tuple[int, int]:
        return int(math.floor((x - self.origin[0]) / self.cell)), int(math.floor((z - self.origin[1]) / self.cell))

    def around(self, x: float, z: float, reach: int = 1) -> np.ndarray:
        """Indices of the surfaces in the cell at (x, z) and its neighbours."""
        ix, iz = self.cells(x, z)
        nx, nz = self.shape
        found = []
        for dx in range(-reach, reach + 1):
            for dz in range(-reach, reach + 1):
                cx, cz = ix + dx, iz + dz
                if 0 <= cx < nx and 0 <= cz < nz:
                    key = cx * nz + cz
                    start = np.searchsorted(self.key, key, side="left")
                    end = np.searchsorted(self.key, key, side="right")
                    if end > start:
                        found.append(np.arange(start, end))
        return np.concatenate(found) if found else np.zeros(0, dtype=np.int64)


@dataclass
class FloorPlan:
    floors: list[Floor]
    cuts: list[float]
    walkable: np.ndarray  # bool per input triangle
    walls: np.ndarray  # bool per input triangle
    triangle_floor: np.ndarray  # floor per input triangle (-1 for non-walkable)
    wall_lines: list[np.ndarray]  # per floor: (m, 2, 2) segments in world x, z
    surfaces: Surfaces | None
    flipped: bool
    report: dict[str, tp.Any] = field(default_factory=dict)


def settings_from(config: dict[str, tp.Any] | None) -> dict[str, float]:
    settings = dict(DEFAULTS)
    for key, value in (config or {}).items():
        if key in DEFAULTS and isinstance(value, (int, float)):
            settings[key] = float(value)
    return settings


def normals(triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unit normals' up component and the triangles' areas."""
    a, b, c = triangles[:, 0].astype(np.float64), triangles[:, 1].astype(np.float64), triangles[:, 2].astype(np.float64)
    cross = np.cross(b - a, c - a)
    length = np.linalg.norm(cross, axis=1)
    up = np.divide(cross[:, 1], length, out=np.zeros_like(length), where=length > 1e-12)
    return up, length / 2


def classify(triangles: np.ndarray, settings: dict[str, float]) -> tuple[np.ndarray, np.ndarray, bool]:
    up, area = normals(triangles)
    walk = math.cos(math.radians(settings["walkableSlope"]))
    facing_up = area[up >= walk].sum()
    facing_down = area[up <= -walk].sum()
    flipped = bool(facing_down > facing_up)
    if flipped:
        up = -up
    wall = math.cos(math.radians(settings["wallSlope"]))
    return up >= walk, (np.abs(up) <= wall) & (area > 1e-9), flipped


def sample(triangles: np.ndarray, cell: float, origin: tuple[float, float]) -> tuple[np.ndarray, ...]:
    """Grid samples of (walkable) triangles: cell x, cell z, height and triangle index of every cell centre inside
    a triangle, plus each triangle's centre (so that no triangle is missed)."""
    n = len(triangles)
    xz = (triangles[:, :, [0, 2]].astype(np.float64) - np.asarray(origin)) / cell
    ys = triangles[:, :, 1].astype(np.float64)
    low = np.floor(xz.min(axis=1)).astype(np.int64)
    high = np.floor(xz.max(axis=1)).astype(np.int64)
    span = high - low + 1
    counts = span[:, 0] * span[:, 1]
    a, b, c = xz[:, 0], xz[:, 1], xz[:, 2]
    v0, v1 = b - a, c - a
    d00 = (v0 * v0).sum(1)
    d01 = (v0 * v1).sum(1)
    d11 = (v1 * v1).sum(1)
    denominator = d00 * d11 - d01 * d01
    good = np.abs(denominator) > 1e-12
    out_x, out_z, out_h, out_t = [], [], [], []
    start = 0
    while start < n:
        total = 0
        end = start
        while end < n and (total == 0 or total + counts[end] <= SAMPLE_BUDGET):
            total += counts[end]
            end += 1
        index = np.arange(start, end)
        index = index[good[index]]
        if len(index):
            repeats = counts[index]
            tri = np.repeat(index, repeats)
            offsets = np.arange(repeats.sum()) - np.repeat(np.cumsum(repeats) - repeats, repeats)
            cx = low[tri, 0] + offsets // span[tri, 1]
            cz = low[tri, 1] + offsets % span[tri, 1]
            p = np.stack([cx + 0.5, cz + 0.5], axis=1) - a[tri]
            d20 = (p * v0[tri]).sum(1)
            d21 = (p * v1[tri]).sum(1)
            den = denominator[tri]
            v = (d11[tri] * d20 - d01[tri] * d21) / den
            w = (d00[tri] * d21 - d01[tri] * d20) / den
            u = 1 - v - w
            eps = -1e-6
            inside = (u >= eps) & (v >= eps) & (w >= eps)
            tri, u, v, w, cx, cz = tri[inside], u[inside], v[inside], w[inside], cx[inside], cz[inside]
            out_x.append(cx)
            out_z.append(cz)
            out_h.append(u * ys[tri, 0] + v * ys[tri, 1] + w * ys[tri, 2])
            out_t.append(tri)
        start = end
    centre = xz.mean(axis=1)
    out_x.append(np.floor(centre[:, 0]).astype(np.int64))
    out_z.append(np.floor(centre[:, 1]).astype(np.int64))
    out_h.append(ys.mean(axis=1))
    out_t.append(np.arange(n))
    return np.concatenate(out_x), np.concatenate(out_z), np.concatenate(out_h), np.concatenate(out_t)


def build_surfaces(walk_tris: np.ndarray, cell: float) -> tuple[Surfaces, np.ndarray, np.ndarray]:
    """The surfaces of the walkable triangles, and for each sample its surface and triangle."""
    xz = walk_tris[:, :, [0, 2]].reshape(-1, 2)
    origin = (float(math.floor(xz[:, 0].min() / cell) * cell - cell), float(math.floor(xz[:, 1].min() / cell) * cell - cell))
    nx = int(math.ceil((xz[:, 0].max() - origin[0]) / cell)) + 2
    nz = int(math.ceil((xz[:, 1].max() - origin[1]) / cell)) + 2
    cx, cz, h, tri = sample(walk_tris, cell, origin)
    cx = np.clip(cx, 0, nx - 1)
    cz = np.clip(cz, 0, nz - 1)
    key = cx * nz + cz
    order = np.lexsort((h, key))
    key, h, tri = key[order], h[order], tri[order]
    new = np.ones(len(key), dtype=bool)
    new[1:] = (key[1:] != key[:-1]) | (h[1:] - h[:-1] > STEP)
    surface_of_sample = np.cumsum(new) - 1
    count = np.bincount(surface_of_sample)
    heights = np.bincount(surface_of_sample, weights=h) / count
    first = np.flatnonzero(new)
    surfaces = Surfaces(
        cell=cell,
        origin=origin,
        shape=(nx, nz),
        key=key[first],
        height=heights.astype(np.float64),
        triangle=tri[first],
    )
    return surfaces, surface_of_sample, tri


def stacked_pairs(surfaces: Surfaces, clearance: float) -> tuple[np.ndarray, np.ndarray]:
    """(lower, upper) heights of surfaces stacked in one cell, at least `clearance` apart."""
    same = surfaces.key[1:] == surfaces.key[:-1]
    gap = surfaces.height[1:] - surfaces.height[:-1]
    chosen = same & (gap >= clearance)
    return surfaces.height[:-1][chosen], surfaces.height[1:][chosen]


def auto_cuts(surfaces: Surfaces, settings: dict[str, float]) -> tuple[list[float], list[dict[str, tp.Any]]]:
    """Cut heights, lowest first, and a note on each (for the report)."""
    lower, upper = stacked_pairs(surfaces, settings["clearance"])
    heights = np.sort(surfaces.height)
    if len(lower) == 0 or len(heights) == 0:
        return [], []
    cell_area = settings["cell"] ** 2
    need = settings["minStackedArea"] / cell_area
    min_height = settings["minFloorHeight"]
    candidates = np.arange(math.floor(heights[0]) + 0.25, heights[-1], 0.5)
    if len(candidates) == 0:
        return [], []
    # Walkable surface sliced by a cut at each candidate height: surfaces within a metre of it.
    sliced = np.searchsorted(heights, candidates + 1.0) - np.searchsorted(heights, candidates - 1.0)
    cuts: list[float] = []
    notes: list[dict[str, tp.Any]] = []
    while len(cuts) + 1 < int(settings["maxFloors"]):
        bounds = [-math.inf, *sorted(cuts), math.inf]
        best: tuple[float, float, int, int] | None = None
        for low_bound, high_bound in zip(bounds[:-1], bounds[1:]):
            inside = (lower > low_bound) & (upper < high_bound)
            lo, hi = np.sort(lower[inside]), np.sort(upper[inside])
            if len(lo) < need:
                continue
            in_range = heights[(heights > low_bound) & (heights < high_bound)]
            if len(in_range) == 0:
                continue
            bottom, top = in_range[0], in_range[-1]
            usable = (candidates > max(low_bound, bottom) + min_height) & (candidates < min(high_bound, top) - min_height)
            usable &= (candidates > low_bound) & (candidates < high_bound)
            if not usable.any():
                continue
            where = candidates[usable]
            separated = np.searchsorted(lo, where - 0.5) - np.searchsorted(hi, where + 0.5)
            cost = sliced[usable]
            score = separated - cost
            ok = (separated >= need) & (separated > cost)
            if not ok.any():
                continue
            score = np.where(ok, score, -np.inf)
            top_score = score.max()
            ties = np.flatnonzero(score == top_score)
            pick = int(ties[len(ties) // 2])
            if best is None or top_score > best[0]:
                best = (float(top_score), float(where[pick]), int(separated[pick]), int(cost[pick]))
        if best is None:
            break
        cuts.append(best[1])
        notes.append({"height": round(best[1], 2), "stackedArea": round(best[2] * cell_area), "slicedArea": round(best[3] * cell_area)})
    order = np.argsort(cuts)
    return [cuts[i] for i in order], [notes[i] for i in order]


def apply_overrides(cuts: list[float], overrides: dict[str, tp.Any]) -> list[float]:
    if isinstance(overrides.get("cuts"), list):
        cuts = [float(v) for v in overrides["cuts"] if isinstance(v, (int, float))]
    for height in overrides.get("splitAt", []) or []:
        if isinstance(height, (int, float)):
            cuts.append(float(height))
    for height in overrides.get("mergeAt", []) or []:
        if isinstance(height, (int, float)):
            cuts = [c for c in cuts if abs(c - float(height)) > 2.0]
    return sorted(set(round(c, 3) for c in cuts))


def keep_pieces_whole(surfaces: Surfaces, floors: np.ndarray, cuts: list[float], settings: dict[str, float]) -> tuple[np.ndarray, int]:
    """Moves pieces of floor that a cut only clips back to the floor they are joined to (see the module notes).
    Returns the new floor of each surface and how many pieces moved."""
    if not cuts or len(surfaces.key) == 0:
        return floors, 0
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    nx, nz = surfaces.shape
    ix, iz = surfaces.key // nz, surfaces.key % nz
    count = len(surfaces.key)
    # Join each surface to the surfaces of the next cells (+x, +z, and the two diagonals) on the same floor whose
    # height is within JOIN; and record joins across floors, which pieces may move along.
    rows_list, cols_list = [], []
    for dx, dz in ((1, 0), (0, 1), (1, 1), (1, -1)):
        tx, tz = ix + dx, iz + dz
        valid = np.flatnonzero((tx >= 0) & (tx < nx) & (tz >= 0) & (tz < nz))
        target = tx[valid] * nz + tz[valid]
        start = np.searchsorted(surfaces.key, target, side="left")
        end = np.searchsorted(surfaces.key, target, side="right")
        repeats = end - start
        source = np.repeat(valid, repeats)
        other = np.repeat(start, repeats) + (np.arange(repeats.sum()) - np.repeat(np.cumsum(repeats) - repeats, repeats))
        close = np.abs(surfaces.height[other] - surfaces.height[source]) <= JOIN
        rows_list.append(source[close])
        cols_list.append(other[close])
    pairs_a = np.concatenate(rows_list) if rows_list else np.zeros(0, dtype=np.int64)
    pairs_b = np.concatenate(cols_list) if cols_list else np.zeros(0, dtype=np.int64)
    same = floors[pairs_a] == floors[pairs_b]
    rows, cols = pairs_a[same], pairs_b[same]
    cross_a, cross_b = pairs_a[~same], pairs_b[~same]
    graph = coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(count, count))
    pieces, label = connected_components(graph, directed=False)
    piece_size = np.bincount(label, minlength=pieces)
    moved = 0
    floors = floors.copy()
    clearance = settings["clearance"]
    cut_array = np.asarray(cuts)
    # Smaller pieces first; a piece moves to a floor it is joined to when it lies within `minFloorHeight` of the
    # cut between them, and nothing on that floor is stacked with it.
    candidates: dict[int, set[int]] = {}
    links = np.unique(
        np.concatenate([np.stack([label[cross_a], floors[cross_b]], 1), np.stack([label[cross_b], floors[cross_a]], 1)]),
        axis=0,
    ) if len(cross_a) else np.zeros((0, 2), dtype=np.int64)
    for piece, target in links:
        candidates.setdefault(int(piece), set()).add(int(target))
    members_of = _members(label, pieces)
    floor_size = np.bincount(floors, minlength=len(cuts) + 1)
    for piece in sorted(candidates, key=lambda p: piece_size[p]):
        members = members_of[piece]
        if len(members) == 0:
            continue
        current = int(floors[members[0]])
        heights = surfaces.height[members]
        for target in sorted(candidates[piece], key=lambda f: abs(f - current)):
            if abs(target - current) != 1:
                continue
            cut = cut_array[min(target, current)]
            if np.abs(heights - cut).max() > settings["minFloorHeight"]:
                continue
            # The piece must be smaller than what it joins on the target floor.
            if piece_size[piece] * 2 > floor_size[target]:
                continue
            if _stacked_with(surfaces, members, floors, target, clearance):
                continue
            floors[members] = target
            floor_size[target] += len(members)
            floor_size[current] -= len(members)
            moved += 1
            break
    return floors, moved


def _members(label: np.ndarray, pieces: int) -> list[np.ndarray]:
    order = np.argsort(label, kind="stable")
    bounds = np.searchsorted(label[order], np.arange(pieces + 1))
    return [order[bounds[i]:bounds[i + 1]] for i in range(pieces)]


def _stacked_with(surfaces: Surfaces, members: np.ndarray, floors: np.ndarray, target: int, clearance: float) -> bool:
    """Whether any member surface shares its cell with a surface of floor `target` at least `clearance` away."""
    keys = surfaces.key[members]
    start = np.searchsorted(surfaces.key, keys, side="left")
    end = np.searchsorted(surfaces.key, keys, side="right")
    shared = (end - start) >= 2
    if not shared.any():
        return False
    members, start, end = members[shared], start[shared], end[shared]
    repeats = end - start
    member = np.repeat(members, repeats)
    other = np.repeat(start, repeats) + (np.arange(repeats.sum()) - np.repeat(np.cumsum(repeats) - repeats, repeats))
    chosen = floors[other] == target
    return bool((np.abs(surfaces.height[other[chosen]] - surfaces.height[member[chosen]]) >= clearance).any())


def plan_floors(
    triangles: np.ndarray, config: dict[str, tp.Any] | None = None, overrides: dict[str, tp.Any] | None = None
) -> FloorPlan:
    settings = settings_from(config)
    overrides = overrides or {}
    triangles = np.asarray(triangles, dtype=np.float32).reshape(-1, 3, 3)
    walkable, walls, flipped = classify(triangles, settings) if len(triangles) else (
        np.zeros(0, bool), np.zeros(0, bool), False
    )
    walk_index = np.flatnonzero(walkable)
    triangle_floor = np.full(len(triangles), -1, dtype=np.int32)
    report: dict[str, tp.Any] = {
        "triangles": int(len(triangles)),
        "walkable": int(len(walk_index)),
        "walls": int(walls.sum()),
        "windingFlipped": flipped,
        "settings": settings,
    }
    if len(walk_index) == 0:
        return FloorPlan([], [], walkable, walls, triangle_floor, [], None, flipped, report)
    walk_tris = triangles[walk_index]
    cell = settings["cell"]
    surfaces, surface_of_sample, sample_tri = build_surfaces(walk_tris, cell)
    auto, notes = auto_cuts(surfaces, settings)
    cuts = apply_overrides(list(auto), overrides)
    report["automaticCuts"] = notes
    if cuts != [round(c, 3) for c in auto]:
        report["cutsFromConfig"] = True

    moved_total = 0
    while True:
        floors = np.searchsorted(np.asarray(cuts), surfaces.height).astype(np.int32)
        floors, moved = keep_pieces_whole(surfaces, floors, cuts, settings)
        # Each walkable triangle: the floor most of its samples are on.
        k = len(cuts) + 1
        votes = np.bincount(sample_tri * k + floors[surface_of_sample], minlength=len(walk_tris) * k)
        tri_floor = votes.reshape(len(walk_tris), k).argmax(axis=1).astype(np.int32)
        present = np.bincount(tri_floor, minlength=k)
        empty = [i for i in range(k) if present[i] == 0]
        if not empty or not cuts:
            moved_total = moved
            break
        drop = empty[0]
        cuts = [c for i, c in enumerate(cuts) if i != (drop - 1 if drop > 0 else 0)]
    surfaces.floor = floors
    report["piecesKeptWhole"] = moved_total
    triangle_floor[walk_index] = tri_floor

    _, area = normals(triangles)
    flat_area = _flat_area(triangles)
    result_floors = []
    for index in range(len(cuts) + 1):
        mine = surfaces.height[floors == index]
        tris = walk_index[tri_floor == index]
        low, high = (np.percentile(mine, [5, 95]) if len(mine) else (0.0, 0.0))
        result_floors.append(
            Floor(index, float(low), float(high), float(flat_area[tris].sum()), int(len(tris)))
        )
    plan = FloorPlan(result_floors, [float(c) for c in cuts], walkable, walls, triangle_floor, [], surfaces, flipped, report)
    plan.wall_lines = wall_lines(triangles, walls, surfaces, len(result_floors), settings)
    report["cuts"] = [round(c, 2) for c in cuts]
    return plan


def _flat_area(triangles: np.ndarray) -> np.ndarray:
    xz = triangles[:, :, [0, 2]].astype(np.float64)
    a, b, c = xz[:, 0], xz[:, 1], xz[:, 2]
    return np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) / 2


def wall_lines(
    triangles: np.ndarray, walls: np.ndarray, surfaces: Surfaces, floor_count: int, settings: dict[str, float]
) -> list[np.ndarray]:
    """Per floor, the wall triangles cut at `wallCutHeight` above that floor's surface next to them."""
    from scipy.ndimage import maximum_filter

    nx, nz = surfaces.shape
    wall_tris = triangles[walls].astype(np.float64)
    out: list[np.ndarray] = []
    if len(wall_tris) == 0:
        return [np.zeros((0, 2, 2)) for _ in range(floor_count)]
    centre = wall_tris.mean(axis=1)
    cx = np.clip(np.floor((centre[:, 0] - surfaces.origin[0]) / surfaces.cell).astype(np.int64), 0, nx - 1)
    cz = np.clip(np.floor((centre[:, 2] - surfaces.origin[1]) / surfaces.cell).astype(np.int64), 0, nz - 1)
    ys = wall_tris[:, :, 1]
    ix, iz = surfaces.key // nz, surfaces.key % nz
    for floor in range(floor_count):
        mine = surfaces.floor == floor
        grid = np.full((nx, nz), -np.inf)
        np.maximum.at(grid, (ix[mine], iz[mine]), surfaces.height[mine])
        reach = maximum_filter(grid, size=5, mode="constant", cval=-np.inf)
        level = np.where(np.isfinite(grid), grid, reach)[cx, cz]
        plane = level + settings["wallCutHeight"] + 1e-4
        chosen = np.isfinite(level) & (ys.min(axis=1) < plane) & (ys.max(axis=1) > plane)
        out.append(cut_triangles(wall_tris[chosen], plane[chosen]))
    return out


def cut_triangles(tris: np.ndarray, plane: np.ndarray) -> np.ndarray:
    """Where each triangle crosses its horizontal plane: (m, 2, 2) segments in x, z."""
    if len(tris) == 0:
        return np.zeros((0, 2, 2))
    d = tris[:, :, 1] - plane[:, None]
    points = []
    masks = []
    for i, j in ((0, 1), (1, 2), (2, 0)):
        crosses = (d[:, i] * d[:, j]) < 0
        t = np.divide(d[:, i], d[:, i] - d[:, j], out=np.zeros(len(d)), where=crosses)
        p = tris[:, i] + (tris[:, j] - tris[:, i]) * t[:, None]
        points.append(p[:, [0, 2]])
        masks.append(crosses)
    masks_arr = np.stack(masks, axis=1)
    points_arr = np.stack(points, axis=1)
    two = masks_arr.sum(axis=1) == 2
    order = np.argsort(~masks_arr[two], axis=1, kind="stable")[:, :2]
    chosen = np.take_along_axis(points_arr[two], order[:, :, None], axis=1)
    return chosen


@dataclass
class Placement:
    floor: int
    on_floor: bool
    surface_height: float | None
    triangle: int | None  # walkable triangle index (into the walkable triangles) under it


def locate(plan: FloorPlan, x: float, y: float, z: float) -> Placement:
    """The floor of the walkable surface just below (x, y, z): within 1.5 m above it or 6 m below it. Without one,
    the floor whose height range holds y, and `on_floor` false."""
    cuts = np.asarray(plan.cuts)
    surfaces = plan.surfaces
    if surfaces is not None:
        near = surfaces.around(x, z, reach=1)
        if len(near):
            heights = surfaces.height[near]
            below = (heights <= y + 1.5) & (heights >= y - 6.0)
            if below.any():
                pick = near[below][np.argmax(heights[below])]
                return Placement(int(surfaces.floor[pick]), True, float(surfaces.height[pick]), int(surfaces.triangle[pick]))
    floor = int(np.searchsorted(cuts, y)) if len(cuts) else 0
    return Placement(min(floor, max(len(plan.floors) - 1, 0)), False, None, None)


def support_fraction(triangles: np.ndarray, points: np.ndarray, config: dict[str, tp.Any] | None = None) -> float | None:
    """The share of `points` that have walkable surface just below them in `triangles` (for checking how the
    geometry is placed)."""
    if len(points) == 0 or len(triangles) == 0:
        return None
    settings = settings_from(config)
    walkable, _, _ = classify(triangles, settings)
    if not walkable.any():
        return 0.0
    surfaces, _, _ = build_surfaces(triangles[walkable], settings["cell"])
    hits = 0
    for x, y, z in points:
        near = surfaces.around(float(x), float(z), reach=1)
        if len(near):
            heights = surfaces.height[near]
            if ((heights <= y + 1.5) & (heights >= y - 6.0)).any():
                hits += 1
    return hits / len(points)
