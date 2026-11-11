from __future__ import annotations

import struct
import zlib

import numpy as np

from atlas_gamefiles.msb import Placement
from atlas_gamefiles.preview import BACKGROUND, png_bytes, render


def decode_png(data: bytes) -> np.ndarray:
    """Just enough of a PNG reader for the files `png_bytes` writes (8-bit RGB, filter 0)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    position, chunks = 8, {}
    while position < len(data):
        (length,) = struct.unpack(">I", data[position:position + 4])
        kind = data[position + 4:position + 8]
        body = data[position + 8:position + 8 + length]
        (crc,) = struct.unpack(">I", data[position + 8 + length:position + 12 + length])
        assert crc == zlib.crc32(kind + body) & 0xFFFFFFFF
        chunks[kind] = chunks.get(kind, b"") + body
        position += 12 + length
    width, height, depth, colour, *_ = struct.unpack(">IIBBBBB", chunks[b"IHDR"])
    assert (depth, colour) == (8, 2)
    raw = zlib.decompress(chunks[b"IDAT"])
    rows = [raw[r * (width * 3 + 1):(r + 1) * (width * 3 + 1)] for r in range(height)]
    assert all(row[0] == 0 for row in rows)
    return np.frombuffer(b"".join(row[1:] for row in rows), dtype=np.uint8).reshape(height, width, 3)


def test_png_round_trip() -> None:
    image = np.zeros((3, 4, 3), dtype=np.uint8)
    image[1, 2] = (255, 10, 20)
    assert np.array_equal(decode_png(png_bytes(image)), image)


def test_nothing_to_draw() -> None:
    assert render(np.zeros((0, 3, 3), dtype=np.float32), []) is None
    # Parts that only carry geometry get no dot.
    assert render(np.zeros((0, 3, 3), dtype=np.float32), [Placement("MapPiece", "m", "m", (0, 0, 0), (0, 0, 0))]) is None


def test_orientation_and_shading() -> None:
    # A high triangle in the north-east (+x, +z) and a low one in the south-west.
    high = [[50, 10, 50], [100, 10, 50], [100, 10, 100]]
    low = [[0, 0, 0], [50, 0, 0], [0, 0, 50]]
    triangles = np.array([high, low], dtype=np.float32)
    treasure = Placement("Treasure", "t", None, (100.0, 0.0, 0.0), (0.0, 0.0, 0.0))
    png, meta = render(triangles, [treasure], size=108, padding=4)
    image = decode_png(png)
    assert (meta["width"], meta["height"]) == (108, 108)
    assert meta["pixelsPerMetre"] == 1.0
    north_east = image[10, 98]  # top right
    south_west = image[98, 10]  # bottom left
    assert tuple(north_east) != BACKGROUND and tuple(south_west) != BACKGROUND
    assert north_east.sum() > south_west.sum(), "higher ground is lighter"
    assert tuple(image[104, 104]) == (230, 180, 80), "the treasure dot sits at +x, -z: bottom right"
    assert tuple(image[50, 30]) == BACKGROUND
    assert meta["dots"] == {"treasure": 1}


def test_many_small_triangles_render_quickly() -> None:
    rng = np.random.default_rng(1)
    centres = rng.uniform(0, 1000, size=(50000, 1, 3)).astype(np.float32)
    triangles = centres + rng.uniform(-0.5, 0.5, size=(50000, 3, 3)).astype(np.float32)
    png, meta = render(triangles, [])
    assert meta["geometryTriangles"] == 50000
    assert len(png) > 1000
