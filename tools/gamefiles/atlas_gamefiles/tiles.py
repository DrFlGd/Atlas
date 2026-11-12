"""Cutting a floor's picture into the tile pyramid Atlas reads: a `{z}/{x}/{y}` folder of square tiles, with the
same maths as `@atlas/core` (packages/core/src/geometry/coords.ts):

- the top level `maxZoom` is the smallest whose tiles cover the picture at one tile pixel per picture pixel:
  `max(0, ceil(log2(longest side / tile size)))`;
- each level below halves the picture (its size rounded up), down to level 0;
- tiles on the right and bottom edges that the picture does not fill are padded (with the background colour).
"""

from __future__ import annotations

import io
import math
import os
import typing as tp
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def pyramid_max_zoom(width: int, height: int, tile_size: int) -> int:
    longest = max(width, height)
    return max(0, math.ceil(math.log2(longest / tile_size) - 1e-9))


def tile_format(requested: str) -> str:
    """`webp` when this Pillow can write it, else `png`."""
    if requested == "webp":
        from PIL import features

        if features.check("webp"):
            return "webp"
    return "png"


def encode(tile: tp.Any, fmt: str, quality: int) -> bytes:
    buffer = io.BytesIO()
    if fmt == "webp":
        tile.save(buffer, "WEBP", quality=quality, method=4)
    else:
        tile.save(buffer, "PNG", optimize=False, compress_level=6)
    return buffer.getvalue()


def write_pyramid(
    picture: tp.Any,
    folder: Path,
    *,
    tile_size: int = 256,
    fmt: str = "webp",
    quality: int = 85,
    background: tuple[int, int, int] = (0, 0, 0),
    workers: int | None = None,
    stop: tp.Callable[[], None] | None = None,
) -> dict[str, tp.Any]:
    """Writes the pyramid of an RGB picture under `folder` (`<z>/<x>/<y>.<fmt>`). Returns its levels, file count
    and bytes. `stop` is called between levels and may raise to cancel."""
    from PIL import Image

    width, height = picture.size
    max_zoom = pyramid_max_zoom(width, height, tile_size)
    blank = encode(Image.new("RGB", (tile_size, tile_size), background), fmt, quality)
    files = 0
    total = 0
    level = picture
    workers = workers or max(2, min(8, (os.cpu_count() or 2)))

    def save(path: Path, tile: tp.Any | None) -> int:
        data = blank if tile is None else encode(tile, fmt, quality)
        path.write_bytes(data)
        return len(data)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for zoom in range(max_zoom, -1, -1):
            if stop is not None:
                stop()
            if zoom < max_zoom:
                level = level.reduce(2)
            columns = math.ceil(level.width / tile_size)
            rows = math.ceil(level.height / tile_size)
            jobs = []
            for x in range(columns):
                column = folder / str(zoom) / str(x)
                column.mkdir(parents=True, exist_ok=True)
                for y in range(rows):
                    box = (x * tile_size, y * tile_size, min((x + 1) * tile_size, level.width), min((y + 1) * tile_size, level.height))
                    tile = level.crop(box)
                    extrema = tile.getextrema()
                    if all(low == high == background[i] for i, (low, high) in enumerate(extrema)):
                        tile = None
                    elif tile.size != (tile_size, tile_size):
                        padded = Image.new("RGB", (tile_size, tile_size), background)
                        padded.paste(tile, (0, 0))
                        tile = padded
                    jobs.append(pool.submit(save, column / f"{y}.{fmt}", tile))
            for job in jobs:
                total += job.result()
                files += 1
    return {"minZoom": 0, "maxZoom": max_zoom, "tileSize": tile_size, "files": files, "bytes": total, "format": fmt}
