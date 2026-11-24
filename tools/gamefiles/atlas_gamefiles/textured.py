"""The textured map styles for game files: which floor each triangle of the game's models (models.py) is drawn on.
The 3D builder draws them (`atlas-scene draw`, as for a map made from a 3D model): each floor from above, in the
models' textures, the highest triangle of that floor at each pixel; render.draw_layer then lays the rim, walls and
outlines over it and render.compose fades the floors below, as for the other styles.

A floor shows what lies between the cut below it and its ceiling: the cut above it (none for the top floor), and,
over the floor's own walkable ground (its collision triangles, widened by `GROUND_REACH`), no higher than
`HEADROOM` above that ground, as the 3D view cuts a floor when it goes to a location. A triangle is on the floor
when it starts below the ceiling at its middle and its middle is above the cut below. So the roofs and ceilings
over a room are gone and the room shows, while a roof over ground that belongs to no walkable floor stays. Surfaces
seen from below (facing down) are on no floor, unless their material is seen from both sides. What lies under the
lowest floor's ground stays on the lowest floor, drawn under it.
"""

from __future__ import annotations

import math
import typing as tp

import numpy as np

from .models import TexturedMesh
from .render import Frame

HEADROOM = 3.0  # metres above a floor's walkable ground that its picture keeps
GROUND_REACH = 1.0  # metres the walkable ground's ceiling reaches past its edge
SAMPLE_BUDGET = 3_000_000  # pixel samples worked out at once
FACING_DOWN = -0.05  # a triangle whose normal's up part is below this faces down


def rasterise(
    pixels: np.ndarray, chosen: np.ndarray, width: int, height: int
) -> tp.Iterator[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """The pixel centres inside the triangles `chosen` (indices into `pixels`): per batch, each sample's pixel
    (row * width + column), triangle and barycentric weights (k, 3)."""
    if not len(chosen):
        return
    p = pixels[chosen]
    low = np.ceil(p.min(axis=1) - 0.5).astype(np.int64)
    high = np.floor(p.max(axis=1) - 0.5).astype(np.int64)
    low = np.maximum(low, 0)
    high = np.minimum(high, [width - 1, height - 1])
    span = np.maximum(high - low + 1, 0)
    counts = span[:, 0] * span[:, 1]
    a = p[:, 0]
    v0, v1 = p[:, 1] - a, p[:, 2] - a
    d00 = (v0 * v0).sum(1)
    d01 = (v0 * v1).sum(1)
    d11 = (v1 * v1).sum(1)
    denominator = d00 * d11 - d01 * d01
    good = (np.abs(denominator) > 1e-12) & (counts > 0)
    start = 0
    n = len(chosen)
    cumulative = np.cumsum(np.where(good, counts, 0))
    while start < n:
        base = cumulative[start - 1] if start else 0
        end = int(np.searchsorted(cumulative, base + SAMPLE_BUDGET, side="right"))
        end = max(end, start + 1)
        index = np.arange(start, min(end, n))
        index = index[good[index]]
        start = end
        if not len(index):
            continue
        repeats = counts[index]
        local = np.repeat(index, repeats)
        offsets = np.arange(repeats.sum()) - np.repeat(np.cumsum(repeats) - repeats, repeats)
        cx = low[local, 0] + offsets // span[local, 1]
        cy = low[local, 1] + offsets % span[local, 1]
        q = np.stack([cx + 0.5, cy + 0.5], axis=1) - a[local]
        d20 = (q * v0[local]).sum(1)
        d21 = (q * v1[local]).sum(1)
        den = denominator[local]
        wv = (d11[local] * d20 - d01[local] * d21) / den
        ww = (d00[local] * d21 - d01[local] * d20) / den
        wu = 1 - wv - ww
        eps = -1e-7
        inside = (wu >= eps) & (wv >= eps) & (ww >= eps)
        if not inside.any():
            continue
        weights = np.stack([wu[inside], wv[inside], ww[inside]], axis=1)
        yield cy[inside] * width + cx[inside], chosen[local[inside]], weights


def ground_ceiling(frame: Frame, walkable: np.ndarray, cut: float, fallback: float) -> np.ndarray:
    """Per pixel, the highest point a floor's picture keeps: `HEADROOM` above its walkable ground (widened by
    `GROUND_REACH`), never above `cut`; `fallback` where it has no ground."""
    width, height = frame.width, frame.height
    ground = np.full(width * height, -np.inf)
    tris = np.asarray(walkable, dtype=np.float64).reshape(-1, 3, 3)
    if len(tris):
        pixels = np.empty((len(tris), 3, 2))
        pixels[..., 0] = (tris[..., 0] - frame.x_min) * frame.scale
        pixels[..., 1] = (frame.z_max - tris[..., 2]) * frame.scale
        for pixel, tri, weights in rasterise(pixels, np.arange(len(tris)), width, height):
            h = (tris[tri, :, 1] * weights).sum(1)
            np.maximum.at(ground, pixel, h)
        reach = max(1, int(round(GROUND_REACH * frame.scale)))
        if np.isfinite(ground).any():
            from scipy.ndimage import maximum_filter

            ground = maximum_filter(ground.reshape(height, width), size=2 * reach + 1, mode="constant", cval=-np.inf).reshape(-1)
    ceiling = np.where(np.isfinite(ground), np.minimum(ground + HEADROOM, cut), fallback)
    return ceiling


def triangle_floors(
    mesh: TexturedMesh,
    plan: tp.Any,
    frame: Frame,
    collision: np.ndarray,
    stop: tp.Callable[[], None] = lambda: None,
) -> np.ndarray:
    """Per triangle of `mesh`, the floor it is drawn on (-1: none), lowest floor first (see the top of this module).
    `collision`: the area's collision triangles, of which `plan.triangle_floor` and `plan.walkable` give each
    floor's walkable ground."""
    tris = np.asarray(mesh.triangles, dtype=np.float64).reshape(-1, 3, 3)
    out = np.full(len(tris), -1, dtype=np.int16)
    if not len(tris):
        return out
    heights = tris[:, :, 1]
    middle = heights.mean(axis=1)
    lowest = heights.min(axis=1)
    normal = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    length = np.linalg.norm(normal, axis=1)
    up = np.divide(normal[:, 1], length, out=np.zeros(len(tris)), where=length > 0)
    double_sided = np.array([bool(m.get("doubleSided")) for m in mesh.materials] + [False], dtype=bool)
    material = np.clip(np.asarray(mesh.material, dtype=np.int64), -1, len(mesh.materials))
    seen = (length > 0) & ((up >= FACING_DOWN) | double_sided[material])
    centre = tris.mean(axis=1)
    column = np.floor((centre[:, 0] - frame.x_min) * frame.scale).astype(np.int64)
    row = np.floor((frame.z_max - centre[:, 2]) * frame.scale).astype(np.int64)
    inside = (column >= 0) & (column < frame.width) & (row >= 0) & (row < frame.height)
    at = np.where(inside, row * frame.width + column, 0)
    high_of_area = float(heights.max())
    if len(collision):
        high_of_area = max(high_of_area, float(np.asarray(collision)[:, :, 1].max()))
    floors = sorted(f.index for f in plan.floors) or [0]
    for floor_index in floors:
        stop()
        cut, fallback, bottom = floor_bounds(plan, floor_index, high_of_area)
        own = (
            np.flatnonzero((plan.triangle_floor == floor_index) & plan.walkable)
            if len(collision) and len(plan.triangle_floor) == len(collision) == len(plan.walkable)
            else np.zeros(0, dtype=np.int64)
        )
        ceiling = ground_ceiling(frame, np.asarray(collision)[own] if len(own) else np.zeros((0, 3, 3)), cut, fallback)
        here = np.where(inside, ceiling[at], min(cut, fallback))
        free = (out < 0) & seen & (lowest <= here + 1e-3)
        if bottom is not None:
            free &= middle >= bottom
        out[free] = floor_index
    return out


def floor_bounds(plan: tp.Any, floor_index: int, high_of_area: float) -> tuple[float, float, float | None]:
    """A floor's cut above (inf for none), the ceiling where it has no walkable ground, and its cut below (None for
    the lowest floor). Cuts: the plan's cut heights. Automatic passages, whose floors are not apart in height: each
    floor's walkable heights (`plan.heights`), with `HEADROOM` above them."""
    floors = plan.floors
    if plan.method == "passages" and plan.heights and floor_index < len(plan.heights):
        low, high = plan.heights[floor_index]
        highest = max(h[1] for h in plan.heights)
        lowest = min(h[0] for h in plan.heights)
        cut = math.inf if high >= highest else float(high) + HEADROOM
        bottom = None if low <= lowest else float(low) - 0.5
        return cut, (high_of_area + HEADROOM if math.isinf(cut) else cut), bottom
    cuts = sorted(plan.cuts)
    cut = cuts[floor_index] if floor_index < len(cuts) else math.inf
    bottom = cuts[floor_index - 1] if 0 < floor_index <= len(cuts) else None
    floor = next((f for f in floors if f.index == floor_index), None)
    fallback = cut if not math.isinf(cut) else (float(floor.high) if floor is not None and floor.triangles else high_of_area) + HEADROOM
    return cut, fallback, bottom
