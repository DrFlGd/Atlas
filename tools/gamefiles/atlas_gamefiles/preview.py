"""Small top-down preview pictures: geometry shaded by height, with a dot per part. Written as PNG by hand (zlib),
so the helper needs no imaging library.

Seen from above: right is +x and up is +z (the games are y-up); a pixel is `(x - xmin) * scale` across and
`(zmax - z) * scale` down. Phase 0 checks this orientation against a known layout.
"""

from __future__ import annotations

import struct
import typing as tp
import zlib

import numpy as np

from .msb import GEOMETRY_KINDS, Placement

BACKGROUND = (22, 26, 32)
LOW = np.array([52, 74, 92], dtype=np.float32)
HIGH = np.array([196, 214, 226], dtype=np.float32)

# Drawn in this order, so the rarer, more interesting dots end up on top.
DOTS: tuple[tuple[str, tuple[int, int, int], int], ...] = (
    ("other", (138, 145, 156), 1),
    ("Object", (108, 182, 255), 2),
    ("Character", (255, 123, 114), 2),
    ("PlayerStart", (154, 216, 122), 3),
    ("Treasure", (230, 180, 80), 3),
    ("Bonfire", (255, 140, 40), 4),
)
LEGEND = {
    "other": "other parts (dummies and the like)",
    "Object": "objects",
    "Character": "characters",
    "PlayerStart": "player starts",
    "Treasure": "treasure",
    "Bonfire": "bonfire or lamp candidates",
}


def png_bytes(image: np.ndarray) -> bytes:
    """Encode an (h, w, 3) uint8 array as a PNG."""
    height, width, _ = image.shape
    raw = b"".join(b"\x00" + image[row].tobytes() for row in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def _frame(points: list[np.ndarray]) -> tuple[float, float, float, float] | None:
    present = [p for p in points if p.size]
    if not present:
        return None
    every = np.concatenate(present, axis=0)
    xmin, zmin = every.min(axis=0)
    xmax, zmax = every.max(axis=0)
    return float(xmin), float(zmin), float(xmax), float(zmax)


def _rasterize(triangles: np.ndarray, to_pixels: tp.Callable[[np.ndarray], np.ndarray], height_map: np.ndarray):
    """Keep, per pixel, the highest triangle surface (the one seen from above)."""
    h, w = height_map.shape
    corners = to_pixels(triangles[:, :, [0, 2]].reshape(-1, 2)).reshape(-1, 3, 2)
    heights = triangles[:, :, 1].mean(axis=1)
    low = np.floor(corners.min(axis=1)).astype(np.int64)
    high = np.ceil(corners.max(axis=1)).astype(np.int64)
    visible = (high[:, 0] >= 0) & (high[:, 1] >= 0) & (low[:, 0] < w) & (low[:, 1] < h)
    small = visible & ((high - low).max(axis=1) <= 1)
    if small.any():
        centre = corners[small].mean(axis=1).astype(np.int64)
        cx = np.clip(centre[:, 0], 0, w - 1)
        cy = np.clip(centre[:, 1], 0, h - 1)
        np.maximum.at(height_map, (cy, cx), heights[small])
    for index in np.flatnonzero(visible & ~small):
        (x0, y0), (x1, y1), (x2, y2) = corners[index]
        left, top = max(low[index, 0], 0), max(low[index, 1], 0)
        right, bottom = min(high[index, 0], w - 1), min(high[index, 1], h - 1)
        xs, ys = np.meshgrid(np.arange(left, right + 1) + 0.5, np.arange(top, bottom + 1) + 0.5)
        e0 = (x1 - x0) * (ys - y0) - (y1 - y0) * (xs - x0)
        e1 = (x2 - x1) * (ys - y1) - (y2 - y1) * (xs - x1)
        e2 = (x0 - x2) * (ys - y2) - (y0 - y2) * (xs - x2)
        inside = ((e0 >= 0) & (e1 >= 0) & (e2 >= 0)) | ((e0 <= 0) & (e1 <= 0) & (e2 <= 0))
        if not inside.any():
            # Thinner than a pixel: mark the pixel at its centre.
            inside = np.zeros_like(inside)
            cy_, cx_ = int((y0 + y1 + y2) / 3) - top, int((x0 + x1 + x2) / 3) - left
            if 0 <= cy_ < inside.shape[0] and 0 <= cx_ < inside.shape[1]:
                inside[cy_, cx_] = True
        region = height_map[top:bottom + 1, left:right + 1]
        np.maximum(region, np.where(inside, heights[index], -np.inf), out=region)


def render(
    triangles: np.ndarray, placements: list[Placement], size: int = 512, padding: int = 8
) -> tuple[bytes, dict[str, tp.Any]] | None:
    """A PNG of the area from above and a description of its frame, or None when there is nothing to draw.

    Parts that only carry geometry (map pieces, collisions, navmeshes) get no dot: their position is usually the
    origin, and their shape is what the triangles show.
    """
    placements = [p for p in placements if p.kind not in GEOMETRY_KINDS]
    part_points = np.array([[p.position[0], p.position[2]] for p in placements], dtype=np.float64).reshape(-1, 2)
    mesh_points = triangles[:, :, [0, 2]].reshape(-1, 2).astype(np.float64) if len(triangles) else np.zeros((0, 2))
    frame = _frame([part_points, mesh_points])
    if frame is None:
        return None
    xmin, zmin, xmax, zmax = frame
    extent = max(xmax - xmin, zmax - zmin, 1.0)
    scale = (size - 2 * padding) / extent
    width = int(np.ceil((xmax - xmin) * scale)) + 2 * padding
    height = int(np.ceil((zmax - zmin) * scale)) + 2 * padding

    def to_pixels(xz: np.ndarray) -> np.ndarray:
        return np.stack([(xz[:, 0] - xmin) * scale + padding, (zmax - xz[:, 1]) * scale + padding], axis=1)

    image = np.empty((height, width, 3), dtype=np.uint8)
    image[:] = BACKGROUND
    if len(triangles):
        height_map = np.full((height, width), -np.inf, dtype=np.float32)
        _rasterize(triangles, to_pixels, height_map)
        filled = np.isfinite(height_map)
        if filled.any():
            values = height_map[filled]
            low, high = float(values.min()), float(values.max())
            t = (values - low) / (high - low) if high > low else np.full_like(values, 0.5)
            image[filled] = (LOW + (HIGH - LOW) * t[:, None]).astype(np.uint8)

    counts: dict[str, int] = {}
    for kind, colour, radius in DOTS:
        chosen = [p for p in placements if (p.kind == kind) or (kind == "other" and p.kind not in LEGEND)]
        if not chosen:
            continue
        counts[kind] = len(chosen)
        pixels = to_pixels(np.array([[p.position[0], p.position[2]] for p in chosen])).astype(np.int64)
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                if dx * dx + dy * dy > radius * radius + radius:
                    continue
                px = np.clip(pixels[:, 0] + dx, 0, width - 1)
                py = np.clip(pixels[:, 1] + dy, 0, height - 1)
                image[py, px] = colour
    meta = {
        "width": width,
        "height": height,
        "pixelsPerMetre": round(scale, 4),
        "xMin": round(xmin, 2),
        "zMax": round(zmax, 2),
        "orientation": "right is +x, up is +z; pixel = ((x - xMin) * scale + 8, (zMax - z) * scale + 8)",
        "dots": {LEGEND[k]: v for k, v in counts.items()},
        "geometryTriangles": int(len(triangles)),
    }
    return png_bytes(image), meta
