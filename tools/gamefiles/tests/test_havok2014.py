"""Our Havok 2014 decoder (havok2014.py) on made-up files written byte by byte (havok_fixtures.py)."""

from __future__ import annotations

import math

import numpy as np
import pytest

import fixtures
from atlas_gamefiles.havok2014 import HavokError, Packfile, collision_triangles, navmesh_triangles, nva_placements
from havok_fixtures import compressed_mesh_file, navmesh_file, nva_file


def same_triangles(a: np.ndarray, b: np.ndarray, tolerance: float) -> bool:
    """Whether two lists of triangles match (in any order of triangles, corners in order)."""
    key = lambda t: np.round(t.reshape(-1, 9), 1).tolist()  # noqa: E731
    return len(a) == len(b) and np.abs(np.array(sorted(key(a))) - np.array(sorted(key(b)))).max() <= tolerance


def test_compressed_mesh_round_trip() -> None:
    triangles = np.array(fixtures.made_up_keep()[0][:300], dtype=np.float64)
    decoded = collision_triangles(compressed_mesh_file(triangles))
    assert decoded.shape == triangles.shape
    assert same_triangles(decoded, triangles, 0.15)


def test_body_moves_and_turns_the_mesh() -> None:
    triangles = np.array(fixtures.quad(0, 10, 0, 4, 1.0), dtype=np.float64)
    half = math.sqrt(0.5)
    raw = compressed_mesh_file(triangles, position=(100.0, 2.0, -50.0), quaternion=(0.0, half, 0.0, half))
    decoded = collision_triangles(raw)
    # A quarter turn about the vertical: x goes to -z.
    assert np.allclose(decoded[..., 1], 3.0, atol=0.02)
    assert decoded[..., 0].min() >= 100.0 - 0.02 and decoded[..., 0].max() <= 104.0 + 0.02
    assert decoded[..., 2].min() >= -60.0 - 0.02 and decoded[..., 2].max() <= -50.0 + 0.02


def test_shape_data_at_either_offset() -> None:
    triangles = np.array(fixtures.quad(0, 2, 0, 2, 0.0), dtype=np.float64)
    assert len(collision_triangles(compressed_mesh_file(triangles, shape_data_at=96))) == 2


def test_navmesh_faces_become_fans() -> None:
    square = [(0.0, 0.0, 0.0), (4.0, 0.0, 0.0), (4.0, 0.0, 4.0), (0.0, 0.0, 4.0)]
    triangle = [(10.0, 1.0, 0.0), (12.0, 1.0, 0.0), (10.0, 1.0, 2.0)]
    decoded = navmesh_triangles(navmesh_file([square, triangle]))
    assert decoded.shape == (3, 3, 3)
    assert np.allclose(decoded[0], [square[0], square[1], square[2]])
    assert np.allclose(decoded[1], [square[0], square[2], square[3]])


def test_navmesh_placement_table() -> None:
    placements = nva_placements(nva_file([(7, 123, (1.0, 2.0, 3.0), (0.0, 1.5, 0.0))]))
    (placement,) = placements
    assert placement.model == 123 and placement.position == pytest.approx((1.0, 2.0, 3.0))
    assert placement.rotation == pytest.approx((0.0, 1.5, 0.0))
    with pytest.raises(HavokError):
        nva_placements(b"NOPE" + bytes(60))


def test_not_a_packfile() -> None:
    with pytest.raises(HavokError):
        Packfile.from_bytes(b"not a havok file" * 8)
    with pytest.raises(HavokError):
        collision_triangles(navmesh_file([[(0, 0, 0), (1, 0, 0), (0, 0, 1)]]))
