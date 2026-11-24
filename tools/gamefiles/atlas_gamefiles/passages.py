"""Automatic passages: a way of finding an area's floors that keeps its ground whole where nothing overlaps, and
splits it only where one walkable surface lies over another. It sits beside the cut heights of floors.py
("Floors: Automatic passages | Cuts" in the Map Maker), and works for every game.

1. **Ground.** The collision's walkable triangles (facing up, as floors.py finds them) are sampled on the same
   1 m grid as the cuts use. In each cell, the ground is grouped into fixed height **bands** (`band`, 3 m): two
   surfaces of a cell are apart only when they are in different bands and more than `overlap` (2.4 m) apart.
2. **Navmesh support.** Where the area has a navmesh, its triangles are kept only where collision ground lies
   under them: under the centre and under at least two corners, within `navSupport` (1.2 m). The others (AI
   short cuts, proxy surfaces) are dropped. Collision ground counts as walkable for finding overlaps only where a
   kept navmesh triangle lies on it (so the top of a roof or a wall does not make an overlap); without a navmesh,
   all of it counts.
3. **Overlapping places.** A cell is overlapping where two walkable surfaces lie one over the other (step 1); the
   overlapping cells that touch make one **place** (smaller than `minPassageArea` square metres: left alone). In a
   place, its surfaces are ranked from the bottom: rank 0 the lowest storey, 1 the next, and so on. A walkable
   triangle with most of its samples in a place takes the place and rank of most of them; the others are free.
4. **Sheets.** The walkable ground is joined into sheets by connectivity in 3D: triangles sharing a full edge (their
   corners welded to 2 cm), triangles meeting in one surface of a grid cell, and surfaces of neighbouring cells within
   1.2 m of height (steps and seams between meshes). So slopes, stairs and ramps stay one surface. Joins are made in
   three rounds, never joining two pieces of one place at different ranks: first free ground with free ground and
   each piece of a place with itself; then each place's shown piece (the upper by default, the lower when the
   player chose "Lower" there) with the ground round it; then the rest, where they do not clash. What cannot join
   stays a sheet of its own: the passage under a bridge, or the bridge when its lower passage is shown.
5. **Levels.** The largest sheet is the main level. A sheet over another in some place is a level above it, under
   one a level below; sheets that overlap nothing are on the main level. Each level is one floor (one map layer),
   lowest first, so the existing floors, layers and their `heights` carry it: Atlas needs no change.

Markers go on the floor of the surface under them, as with cuts (floors.locate).
"""

from __future__ import annotations

import math
import typing as tp
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from .floors import (
    Floor,
    FloorPlan,
    Prepared,
    _flat_area,
    height_profile,
    prepare,
    sample,
    wall_lines,
)

DEFAULTS: dict[str, float] = {
    "band": 3.0,
    "overlap": 2.4,
    "navSupport": 1.2,
    "minPassageArea": 6.0,
}
WELD = 0.02  # metres: corners this close are one corner
JOIN = 1.2  # metres: surfaces of neighbouring cells this close in height are one ground
MAX_LEVELS = 6
UPPER, LOWER = "upper", "lower"


def passage_settings(config: dict[str, tp.Any] | None) -> dict[str, float]:
    settings = dict(DEFAULTS)
    for key, value in (config or {}).items():
        if key in DEFAULTS and isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            settings[key] = float(value)
    return settings


# --- What does not change with the player's choices ----------------------------------------------------------


@dataclass
class Place:
    id: int
    cells: np.ndarray  # cell keys (ix * nz + iz)
    centre: tuple[float, float]  # x, z of a cell in it (the one nearest its middle)
    area: float  # square metres
    levels: int  # how many storeys stack in it
    heights: tuple[float, float]  # its lowest and highest walkable height


@dataclass
class PassagePrep:
    """Steps 1 to 4 up to the first round of joins: everything the player's Upper / Lower choices do not change,
    kept so that the Adjust floors panel can redraw in a moment."""

    prepared: Prepared
    settings: dict[str, float]
    places: list[Place]
    cell_place: dict[int, int]
    # Per walkable triangle (index into prepared.walk_index): its first-round piece.
    piece: np.ndarray
    # Per piece: its place (-1: free ground) and rank there.
    piece_place: np.ndarray
    piece_rank: np.ndarray
    piece_area: np.ndarray
    # Pairs of touching pieces (each pair once).
    links: np.ndarray
    # The storeys of overlapping cells: (cell key, storey there, piece) once each, sorted by cell and storey.
    stack_cell: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    stack_rank: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    stack_piece: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    nav: dict[str, tp.Any] = field(default_factory=dict)

    @property
    def walk_count(self) -> int:
        return len(self.prepared.walk_index)


def _cell_lookup(keys: np.ndarray, heights: np.ndarray, query_keys: np.ndarray, query_heights: np.ndarray, reach: float) -> np.ndarray:
    """For each query (cell key, height): whether a (key, height) of the sorted table lies in the same cell within
    `reach` of its height."""
    start = np.searchsorted(keys, query_keys, side="left")
    end = np.searchsorted(keys, query_keys, side="right")
    found = np.zeros(len(query_keys), dtype=bool)
    most = int((end - start).max()) if len(start) else 0
    for step in range(most):
        at = start + step
        valid = at < end
        if not valid.any():
            break
        index = np.where(valid, at, 0)
        found |= valid & (np.abs(heights[index] - query_heights) <= reach)
    return found


def _keys_of(surfaces: tp.Any, x: np.ndarray, z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    nx, nz = surfaces.shape
    ix = np.floor((x - surfaces.origin[0]) / surfaces.cell).astype(np.int64)
    iz = np.floor((z - surfaces.origin[1]) / surfaces.cell).astype(np.int64)
    inside = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    return np.where(inside, ix * nz + iz, -1), inside


def support_navmesh(prepared: Prepared, nav: np.ndarray, reach: float) -> np.ndarray:
    """Which navmesh triangles collision ground supports: under the centre and at least two corners, within
    `reach` metres of height (step 2)."""
    surfaces = prepared.surfaces
    if surfaces is None or not len(nav):
        return np.zeros(len(nav), dtype=bool)
    points = np.concatenate([nav.mean(axis=1, keepdims=True), nav], axis=1).reshape(-1, 3).astype(np.float64)
    keys, inside = _keys_of(surfaces, points[:, 0], points[:, 2])
    near = np.zeros(len(points), dtype=bool)
    nx, nz = surfaces.shape
    # The cell and its neighbours: a corner on a cell's edge may have its ground sampled next door.
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1):
            shifted = np.where(inside, keys + dx * nz + dz, -1)
            near |= _cell_lookup(surfaces.key, surfaces.height, shifted, points[:, 1], reach)
    near = near.reshape(-1, 4)
    return near[:, 0] & (near[:, 1:].sum(axis=1) >= 2)


def _confirmed(prepared: Prepared, nav: np.ndarray, reach: float) -> np.ndarray:
    """Per surface of the grid: whether a kept navmesh triangle lies on it (in its cell or next to it, within
    `reach`)."""
    surfaces = prepared.surfaces
    assert surfaces is not None
    cx, cz, height, _ = sample(nav, surfaces.cell, surfaces.origin)
    nx, nz = surfaces.shape
    keep = (cx >= 0) & (cx < nx) & (cz >= 0) & (cz < nz)
    nav_keys = cx[keep] * nz + cz[keep]
    nav_heights = height[keep]
    order = np.lexsort((nav_heights, nav_keys))
    nav_keys, nav_heights = nav_keys[order], nav_heights[order]
    ix, iz = surfaces.key // nz, surfaces.key % nz
    confirmed = np.zeros(len(surfaces.key), dtype=bool)
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1):
            tx, tz = ix + dx, iz + dz
            valid = (tx >= 0) & (tx < nx) & (tz >= 0) & (tz < nz)
            query = np.where(valid, tx * nz + tz, -1)
            confirmed |= valid & _cell_lookup(nav_keys, nav_heights, query, surfaces.height, reach)
    return confirmed


def _stack_ranks(
    keys: np.ndarray, heights: np.ndarray, counted: np.ndarray, band: float, overlap: float, base: float
) -> tuple[np.ndarray, np.ndarray]:
    """Per surface (sorted by cell, then height): its rank in its cell's stack (0 the lowest) and whether its cell
    is overlapping (step 3). Only `counted` surfaces make storeys; the others take the rank of the storey nearest
    in height."""
    rank = np.zeros(len(keys), dtype=np.int32)
    overlapping = np.zeros(len(keys), dtype=bool)
    if not len(keys):
        return rank, overlapping
    bands = np.floor((heights - base) / band).astype(np.int64)
    starts = np.flatnonzero(np.r_[True, keys[1:] != keys[:-1]])
    ends = np.r_[starts[1:], len(keys)]
    multi = np.flatnonzero((ends - starts) >= 2)
    for s, e in zip(starts[multi].tolist(), ends[multi].tolist()):
        mine = np.arange(s, e)
        chosen = mine[counted[s:e]]
        if len(chosen) < 2:
            continue
        level = [0]
        for previous, current in zip(chosen[:-1], chosen[1:]):
            apart = heights[current] - heights[previous] > overlap and bands[current] != bands[previous]
            level.append(level[-1] + (1 if apart else 0))
        if level[-1] == 0:
            continue
        overlapping[s:e] = True
        storey = np.asarray(level)
        chosen_heights = heights[chosen]
        nearest = np.abs(heights[s:e, None] - chosen_heights[None, :]).argmin(axis=1)
        rank[s:e] = storey[nearest]
    return rank, overlapping


def _components_of_cells(cells: np.ndarray, nz: int) -> np.ndarray:
    """Labels of the 8-connected groups of `cells` (sorted unique cell keys)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    if not len(cells):
        return np.zeros(0, dtype=np.int64)
    ix, iz = cells // nz, cells % nz
    rows, cols = [], []
    for dx, dz in ((1, 0), (0, 1), (1, 1), (1, -1)):
        target = (ix + dx) * nz + (iz + dz)
        at = np.searchsorted(cells, target)
        ok = (at < len(cells)) & (iz + dz >= 0) & (iz + dz < nz)
        ok &= cells[np.minimum(at, len(cells) - 1)] == target
        rows.append(np.flatnonzero(ok))
        cols.append(at[ok])
    r, c = np.concatenate(rows), np.concatenate(cols)
    graph = coo_matrix((np.ones(len(r)), (r, c)), shape=(len(cells), len(cells)))
    return connected_components(graph, directed=False)[1]


def _weld_links(walk_tris: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pairs of walkable triangles that share a full edge in 3D (corners welded to WELD)."""
    count = len(walk_tris)
    if count < 2:
        return np.zeros(0, np.int64), np.zeros(0, np.int64)
    corners = np.round(walk_tris.reshape(-1, 3).astype(np.float64) / WELD).astype(np.int64)
    _, vertex = np.unique(corners, axis=0, return_inverse=True)
    vertex = vertex.reshape(-1, 3)
    edges = np.concatenate([vertex[:, [0, 1]], vertex[:, [1, 2]], vertex[:, [2, 0]]])
    edges.sort(axis=1)
    owner = np.tile(np.arange(count), 3)
    distinct = edges[:, 0] != edges[:, 1]
    edges, owner = edges[distinct], owner[distinct]
    code = edges[:, 0] * (int(vertex.max()) + 1) + edges[:, 1]
    order = np.argsort(code, kind="stable")
    code, owner = code[order], owner[order]
    same = code[1:] == code[:-1]
    return owner[:-1][same], owner[1:][same]


def _grid_links(prepared: Prepared) -> tuple[np.ndarray, np.ndarray]:
    """Pairs of walkable triangles joined through the grid: sampled into one surface of a cell, or making surfaces
    of neighbouring cells within JOIN of height."""
    surfaces = prepared.surfaces
    assert surfaces is not None
    first = surfaces.triangle
    rows = [prepared.sample_tri]
    cols = [first[prepared.surface_of_sample]]
    nx, nz = surfaces.shape
    ix, iz = surfaces.key // nz, surfaces.key % nz
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
        rows.append(first[source[close]])
        cols.append(first[other[close]])
    return np.concatenate(rows), np.concatenate(cols)


def prepare_passages(
    triangles: np.ndarray | Prepared,
    nav: np.ndarray | None = None,
    config: dict[str, tp.Any] | None = None,
) -> PassagePrep:
    """Steps 1 to 4 (the first round of joins) for `triangles` (or triangles prepared before) and the navmesh
    `nav` (None or empty: none)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    prepared = triangles if isinstance(triangles, Prepared) else prepare(triangles, config)
    settings = {**prepared.settings, **passage_settings(config)}
    nav_info: dict[str, tp.Any] = {"triangles": 0, "kept": 0, "used": False}
    empty = np.zeros(0, dtype=np.int64)
    surfaces = prepared.surfaces
    if surfaces is None:
        return PassagePrep(prepared, settings, [], {}, empty, empty, empty, np.zeros(0), np.zeros((0, 2), np.int64), nav=nav_info)
    walk_tris = prepared.triangles[prepared.walk_index]

    # Step 2: the navmesh, kept where collision ground supports it; collision surfaces it confirms.
    counted = np.ones(len(surfaces.key), dtype=bool)
    if nav is not None and len(nav):
        nav = np.asarray(nav, dtype=np.float32).reshape(-1, 3, 3)
        kept = support_navmesh(prepared, nav, settings["navSupport"])
        nav_info = {"triangles": int(len(nav)), "kept": int(kept.sum()), "used": bool(kept.any())}
        if kept.any():
            counted = _confirmed(prepared, nav[kept], settings["navSupport"])
            nav_info["surfacesConfirmed"] = round(float(counted.mean()), 3)

    # Steps 1 and 3: bands, stacks and places.
    base = float(math.floor(surfaces.height.min())) if len(surfaces.height) else 0.0
    rank, overlapping = _stack_ranks(surfaces.key, surfaces.height, counted, settings["band"], settings["overlap"], base)
    cells = np.unique(surfaces.key[overlapping])
    nz = surfaces.shape[1]
    group = _components_of_cells(cells, nz)
    cell_area = settings["cell"] ** 2
    places: list[Place] = []
    cell_place: dict[int, int] = {}
    if len(cells):
        sizes = np.bincount(group)
        for label in np.argsort(-sizes, kind="stable"):
            mine = cells[group == label]
            area = len(mine) * cell_area
            if area < settings["minPassageArea"]:
                continue
            place_id = len(places)
            in_place = np.isin(surfaces.key, mine)
            heights = surfaces.height[in_place]
            x = surfaces.origin[0] + (mine // nz + 0.5) * surfaces.cell
            z = surfaces.origin[1] + (mine % nz + 0.5) * surfaces.cell
            middle = np.argmin((x - x.mean()) ** 2 + (z - z.mean()) ** 2)
            places.append(
                Place(
                    place_id,
                    mine,
                    (round(float(x[middle]), 2), round(float(z[middle]), 2)),
                    float(area),
                    int(rank[in_place].max()) + 1,
                    (round(float(heights.min()), 2), round(float(heights.max()), 2)),
                )
            )
            for key in mine.tolist():
                cell_place[key] = place_id
    surface_place = np.array([cell_place.get(int(k), -1) for k in surfaces.key.tolist()], dtype=np.int64) if cell_place else np.full(len(surfaces.key), -1, dtype=np.int64)

    # Each walkable triangle: free, or the place and rank of most of its samples.
    count = len(walk_tris)
    sample_place = surface_place[prepared.surface_of_sample]
    sample_rank = rank[prepared.surface_of_sample]
    total = np.bincount(prepared.sample_tri, minlength=count)
    in_place = sample_place >= 0
    placed = np.bincount(prepared.sample_tri[in_place], minlength=count)
    tri_place = np.full(count, -1, dtype=np.int64)
    tri_rank = np.zeros(count, dtype=np.int64)
    ranked = np.flatnonzero(placed * 2 > total)
    if len(ranked):
        span = MAX_LEVELS * 2
        code = sample_place[in_place] * span + np.minimum(sample_rank[in_place], span - 1)
        tri = prepared.sample_tri[in_place]
        pairs = np.unique(np.stack([tri, code], axis=1), axis=0, return_counts=True)
        rows, votes = pairs
        order = np.lexsort((-votes, rows[:, 0]))
        rows = rows[order]
        firsts = np.r_[True, rows[1:, 0] != rows[:-1, 0]]
        best = rows[firsts]
        chosen = np.zeros(count, dtype=bool)
        chosen[ranked] = True
        best = best[chosen[best[:, 0]]]
        tri_place[best[:, 0]] = best[:, 1] // span
        tri_rank[best[:, 0]] = best[:, 1] % span

    # Step 4, first round: free with free, and each piece of a place with itself.
    weld_a, weld_b = _weld_links(walk_tris)
    grid_a, grid_b = _grid_links(prepared)
    link_a = np.concatenate([weld_a, grid_a])
    link_b = np.concatenate([weld_b, grid_b])
    keep = link_a != link_b
    link_a, link_b = link_a[keep], link_b[keep]
    label = tri_place * (MAX_LEVELS * 2) + tri_rank
    label[tri_place < 0] = -1
    same = label[link_a] == label[link_b]
    graph = coo_matrix((np.ones(int(same.sum())), (link_a[same], link_b[same])), shape=(count, count))
    pieces, piece = connected_components(graph, directed=False)
    piece_place = np.full(pieces, -1, dtype=np.int64)
    piece_rank = np.zeros(pieces, dtype=np.int64)
    piece_place[piece] = tri_place
    piece_rank[piece] = tri_rank
    flat = _flat_area(walk_tris)
    piece_area = np.bincount(piece, weights=flat, minlength=pieces)
    other = ~same
    pairs = np.stack([piece[link_a[other]], piece[link_b[other]]], axis=1)
    pairs.sort(axis=1)
    pairs = np.unique(pairs[pairs[:, 0] != pairs[:, 1]], axis=0) if len(pairs) else np.zeros((0, 2), np.int64)
    # Which piece is at which storey of each overlapping cell (a piece that overlaps itself keeps its lowest).
    stacked = surface_place[prepared.surface_of_sample] >= 0
    triples = np.stack(
        [
            surfaces.key[prepared.surface_of_sample[stacked]],
            rank[prepared.surface_of_sample[stacked]].astype(np.int64),
            piece[prepared.sample_tri[stacked]],
        ],
        axis=1,
    )
    triples = np.unique(triples, axis=0) if len(triples) else np.zeros((0, 3), np.int64)
    return PassagePrep(
        prepared, settings, places, cell_place, piece, piece_place, piece_rank, piece_area, pairs,
        triples[:, 0], triples[:, 1], triples[:, 2], nav_info,
    )  # fmt: skip


# --- The player's choices, and the floors they give ----------------------------------------------------------


class _Sheets:
    """Union-find over pieces that never makes a sheet overlap itself: two sheets do not join where, in some cell
    of a place, one is at another storey than the other."""

    def __init__(self, prep: PassagePrep):
        count = len(prep.piece_place)
        self.parent = list(range(count))
        self.cells: list[dict[int, int]] = [{} for _ in range(count)]
        for cell, rank, piece in zip(prep.stack_cell.tolist(), prep.stack_rank.tolist(), prep.stack_piece.tolist()):
            self.cells[piece].setdefault(cell, rank)
        self.refused = 0

    def find(self, item: int) -> int:
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != root:
            self.parent[item], item = root, self.parent[item]
        return root

    def join(self, a: int, b: int) -> bool:
        a, b = self.find(a), self.find(b)
        if a == b:
            return True
        small, large = (a, b) if len(self.cells[a]) <= len(self.cells[b]) else (b, a)
        theirs = self.cells[large]
        for cell, rank in self.cells[small].items():
            if theirs.get(cell, rank) != rank:
                self.refused += 1
                return False
        theirs.update(self.cells[small])
        self.cells[small] = {}
        self.parent[small] = large
        return True


def match_choices(prep: PassagePrep, choices: tp.Iterable[dict[str, tp.Any]] | None) -> dict[int, str]:
    """The player's choices (`{x, z, show}`, see config.clean_floor_entry) by place: the place whose cells hold
    (x, z), else the place whose centre is nearest within 6 m."""
    out: dict[int, str] = {}
    surfaces = prep.prepared.surfaces
    if surfaces is None or not prep.places:
        return out
    nx, nz = surfaces.shape
    for choice in choices or []:
        if not isinstance(choice, dict) or choice.get("show") not in (UPPER, LOWER):
            continue
        try:
            x, z = float(choice["x"]), float(choice["z"])
        except (KeyError, TypeError, ValueError):
            continue
        ix = int(math.floor((x - surfaces.origin[0]) / surfaces.cell))
        iz = int(math.floor((z - surfaces.origin[1]) / surfaces.cell))
        place = prep.cell_place.get(ix * nz + iz) if 0 <= ix < nx and 0 <= iz < nz else None
        if place is None:
            best = min(prep.places, key=lambda p: (p.centre[0] - x) ** 2 + (p.centre[1] - z) ** 2)
            if (best.centre[0] - x) ** 2 + (best.centre[1] - z) ** 2 <= 36:
                place = best.id
        if place is not None:
            out[place] = str(choice["show"])
    return out


@dataclass
class PassagePlan:
    sheet: np.ndarray  # per walkable triangle: its sheet
    level: np.ndarray  # per walkable triangle: its floor index (0 the lowest)
    levels: int
    main: int  # the main level's floor index
    places: list[dict[str, tp.Any]]
    report: dict[str, tp.Any]


def _layers(
    count: int, above: dict[int, set[int]], below: dict[int, set[int]], area: np.ndarray
) -> tuple[np.ndarray, int]:
    """Levels of sheets from which lie over which: each sheet one level above the highest sheet under it (longest
    path), then each group of sheets that lie over one another moved so that its largest sheet is level 0. A loop
    (A over B over A, which odd geometry can make) is broken where the fewest relations are lost; those are
    counted."""
    waiting = [len(below.get(n, ())) for n in range(count)]
    level = np.zeros(count, dtype=np.int64)
    done = np.zeros(count, dtype=bool)
    ready = deque(n for n in range(count) if waiting[n] == 0)
    clashes = 0
    finished = 0
    while finished < count:
        if not ready:
            stuck = min((n for n in range(count) if not done[n]), key=lambda n: (waiting[n], -area[n]))
            clashes += waiting[stuck]
            waiting[stuck] = 0
            ready.append(stuck)
        node = ready.popleft()
        if done[node]:
            continue
        done[node] = True
        finished += 1
        for other in above.get(node, ()):
            if done[other]:
                continue
            level[other] = max(level[other], level[node] + 1)
            waiting[other] -= 1
            if waiting[other] == 0:
                ready.append(other)
    # Groups of sheets joined by over / under, each set so that its largest sheet is level 0.
    group = np.full(count, -1, dtype=np.int64)
    for start in np.argsort(-area, kind="stable").tolist():
        if group[start] >= 0:
            continue
        group[start] = start
        queue = deque([start])
        while queue:
            current = queue.popleft()
            for other in (*above.get(current, ()), *below.get(current, ())):
                if group[other] < 0:
                    group[other] = start
                    queue.append(other)
    return level - level[group], clashes


def shown_pieces(prep: PassagePrep, choices: dict[int, str]) -> dict[int, int]:
    """Per place, the piece shown on the main level: of the pieces there that touch ground outside the place, the
    highest storey (the lowest when the player chose "Lower"), the largest of those on a tie."""
    outside: dict[int, set[int]] = {}
    for a, b in prep.links.tolist():
        pa, pb = int(prep.piece_place[a]), int(prep.piece_place[b])
        if pa != pb:
            if pa >= 0:
                outside.setdefault(pa, set()).add(a)
            if pb >= 0:
                outside.setdefault(pb, set()).add(b)
    shown: dict[int, int] = {}
    for place, pieces in outside.items():
        lower = choices.get(place) == LOWER
        shown[place] = max(
            pieces,
            key=lambda p: ((-1 if lower else 1) * int(prep.piece_rank[p]), float(prep.piece_area[p])),
        )
    return shown


def assign(prep: PassagePrep, choices: dict[int, str] | None = None) -> PassagePlan:
    """Steps 4 (the other rounds) and 5: the sheets and their levels for the player's choices (place -> upper or
    lower; the others upper)."""
    choices = choices or {}
    pieces = len(prep.piece_place)
    if not pieces:
        return PassagePlan(np.zeros(0, np.int64), np.zeros(0, np.int64), 1, 0, [], {"sheets": 0})
    sheets = _Sheets(prep)
    shown = np.zeros(pieces, dtype=bool)
    for piece in shown_pieces(prep, choices).values():
        shown[piece] = True

    a, b = prep.links[:, 0], prep.links[:, 1]
    free_a, free_b = prep.piece_place[a] < 0, prep.piece_place[b] < 0
    second = (free_a & shown[b]) | (free_b & shown[a]) | (shown[a] & shown[b])
    for chosen in (np.flatnonzero(second), np.flatnonzero(~second)):
        # Bigger pieces first, so a clash leaves the smaller piece apart.
        order = chosen[np.argsort(-np.minimum(prep.piece_area[a[chosen]], prep.piece_area[b[chosen]]), kind="stable")]
        for index in order.tolist():
            sheets.join(int(a[index]), int(b[index]))
    roots = np.array([sheets.find(p) for p in range(pieces)], dtype=np.int64)
    _, sheet_of_piece = np.unique(roots, return_inverse=True)
    sheet_count = int(sheet_of_piece.max()) + 1
    sheet_area = np.bincount(sheet_of_piece, weights=prep.piece_area, minlength=sheet_count)

    # Step 5: levels. In each overlapping cell, the sheet at one storey is under the sheet at the next.
    above: dict[int, set[int]] = {}
    below: dict[int, set[int]] = {}
    stack_sheet = sheet_of_piece[prep.stack_piece] if len(prep.stack_piece) else np.zeros(0, np.int64)
    nexts = np.flatnonzero(
        (prep.stack_cell[1:] == prep.stack_cell[:-1])
        & (prep.stack_rank[1:] > prep.stack_rank[:-1])
        & (stack_sheet[1:] != stack_sheet[:-1])
    ) if len(stack_sheet) > 1 else np.zeros(0, np.int64)  # fmt: skip
    if len(nexts):
        pairs = np.unique(np.stack([stack_sheet[nexts], stack_sheet[nexts + 1]], axis=1), axis=0)
        for low, high in pairs.tolist():
            above.setdefault(low, set()).add(high)
            below.setdefault(high, set()).add(low)
    level, clashes = _layers(sheet_count, above, below, sheet_area)
    level = np.clip(level, -(MAX_LEVELS - 1), MAX_LEVELS - 1)
    distinct = np.unique(level)
    floor_of_sheet = np.searchsorted(distinct, level)
    main = int(np.searchsorted(distinct, 0))
    tri_sheet = sheet_of_piece[prep.piece]
    tri_level = floor_of_sheet[tri_sheet]

    place_of_stack = np.array([prep.cell_place.get(int(c), -1) for c in prep.stack_cell.tolist()], dtype=np.int64)
    place_rows = []
    for place in prep.places:
        here = place_of_stack == place.id
        floors_here = floor_of_sheet[stack_sheet[here]] if here.any() else np.zeros(0, np.int64)
        choice = choices.get(place.id)
        place_rows.append(
            {
                "id": place.id,
                "x": place.centre[0],
                "z": place.centre[1],
                "area": round(place.area),
                "levels": place.levels,
                "heights": list(place.heights),
                "show": choice or UPPER,
                "set": choice is not None,
                "sheets": int(len(np.unique(stack_sheet[here]))) if here.any() else 0,
                "floors": sorted(int(f) for f in np.unique(floors_here)),
            }
        )
    report = {
        "sheets": sheet_count,
        "levels": int(len(distinct)),
        "mainLevel": main,
        "joinsRefused": sheets.refused,
        "levelClashes": clashes,
        "choicesUsed": len(choices),
    }
    return PassagePlan(tri_sheet, tri_level, int(len(distinct)), main, place_rows, report)


def plan_passages(
    triangles: np.ndarray | Prepared | PassagePrep,
    nav: np.ndarray | None = None,
    config: dict[str, tp.Any] | None = None,
    overrides: dict[str, tp.Any] | None = None,
) -> FloorPlan:
    """The floors of an area by automatic passages, as a FloorPlan (no cuts; `report["method"]` is "passages",
    `report["passages"]` the places and sheets, and `heights` on each floor its walkable heights)."""
    prep = triangles if isinstance(triangles, PassagePrep) else prepare_passages(triangles, nav, config)
    prepared = prep.prepared
    overrides = overrides or {}
    choices = match_choices(prep, overrides.get("passages"))
    triangles_all = prepared.triangles
    settings = prepared.settings
    walk_index = prepared.walk_index
    triangle_floor = np.full(len(triangles_all), -1, dtype=np.int32)
    report: dict[str, tp.Any] = {
        "method": "passages",
        "triangles": int(len(triangles_all)),
        "walkable": int(len(walk_index)),
        "walls": int(prepared.walls.sum()),
        "windingFlipped": prepared.flipped,
        "settings": {**settings, **{k: prep.settings[k] for k in DEFAULTS}},
        "navmesh": prep.nav,
        "cuts": [],
    }
    surfaces = prepared.surfaces
    if surfaces is None:
        report["profile"] = height_profile(np.zeros(0), settings["cell"])
        report["passages"] = {"places": [], "sheets": 0, "levels": 1}
        return FloorPlan([], [], prepared.walkable, prepared.walls, triangle_floor, [], None, prepared.flipped, report, "passages")
    plan = assign(prep, choices)
    report["profile"] = height_profile(surfaces.height, settings["cell"])
    report["passages"] = {**plan.report, "places": plan.places}
    tri_floor = plan.level.astype(np.int32)
    triangle_floor[walk_index] = tri_floor
    # Each surface of the grid: the floor most of its samples' triangles are on.
    k = plan.levels
    votes = np.bincount(prepared.surface_of_sample * k + tri_floor[prepared.sample_tri], minlength=len(surfaces.key) * k)
    surfaces.floor = votes.reshape(len(surfaces.key), k).argmax(axis=1).astype(np.int32)
    flat = _flat_area(triangles_all)
    floors = []
    heights = []
    for index in range(plan.levels):
        mine = surfaces.height[surfaces.floor == index]
        tris = walk_index[tri_floor == index]
        low, high = (np.percentile(mine, [5, 95]) if len(mine) else (0.0, 0.0))
        floors.append(Floor(index, float(low), float(high), float(flat[tris].sum()), int(len(tris))))
        ys = triangles_all[tris][:, :, 1] if len(tris) else np.zeros((0, 3))
        heights.append([round(float(ys.min()), 2), round(float(ys.max()), 2)] if len(ys) else [0.0, 0.0])
    # Floors go lowest first by their heights in Atlas (a layer's `heights`): keep both ends rising with the index.
    for index in range(1, len(heights)):
        heights[index][0] = max(heights[index][0], heights[index - 1][0])
        heights[index][1] = max(heights[index][1], heights[index - 1][1], heights[index][0])
    result = FloorPlan(floors, [], prepared.walkable, prepared.walls, triangle_floor, [], surfaces, prepared.flipped, report)
    result.wall_lines = wall_lines(triangles_all, prepared.walls, surfaces, len(floors), settings)
    result.method = "passages"
    result.main = plan.main
    result.heights = heights
    report["mainFloor"] = plan.main
    report["floorHeights"] = heights
    return result
