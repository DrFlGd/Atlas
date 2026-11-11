from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from atlas_gamefiles.games import PROFILES, list_areas, model_stem
from atlas_gamefiles.geometry import Cancelled, place, read_collision, read_map_pieces, rotation_matrix


def no_tick(done: int, total: int, name: str) -> None:
    pass


def no_stop() -> None:
    pass


def test_rotation_follows_fromsoftware_order() -> None:
    # 90 degrees about y turns +x into -z (right-handed, y up).
    assert np.allclose(rotation_matrix((0, 90, 0)) @ [1, 0, 0], [0, 0, -1])
    # XZY order: x first, then z, then y.
    angles = (30.0, 45.0, 60.0)
    rx, ry, rz = (rotation_matrix((angles[0], 0, 0)), rotation_matrix((0, angles[1], 0)), rotation_matrix((0, 0, angles[2])))
    assert np.allclose(rotation_matrix(angles), ry @ rz @ rx)


def test_place_moves_triangles() -> None:
    triangle = np.array([[[1, 0, 0], [0, 0, 1], [0, 2, 0]]], dtype=np.float32)
    placed = place(triangle, (10, 0, 5), (0, 90, 0))
    assert np.allclose(placed[0, 0], [10, 0, 4])
    assert np.allclose(placed[0, 1], [11, 0, 5])
    assert np.allclose(placed[0, 2], [10, 2, 5])


def test_model_stem() -> None:
    assert model_stem("N:\\FRPG\\data\\Model\\map\\m10_01_00_00\\h0000B1A10.hkx.dcx") == "h0000B1"
    assert model_stem("n0002B0A24.nvm") == "n0002B0"
    assert model_stem("odd.hkx") == "odd"


def test_collision_is_placed_by_its_part(dsr_folder: Path) -> None:
    profile = PROFILES["dark-souls-remastered"]
    area = list_areas(profile, dsr_folder)[0]
    instances = {"h0000B1": [((5.0, 0.0, 0.0), (0.0, 90.0, 0.0))]}
    result = read_collision(profile, area, dsr_folder, instances, no_tick, no_stop)
    mesh = result.triangles_array()
    assert result.status == "ok"
    assert result.unplaced == 1  # h0001B1 has no part
    assert mesh.shape == (3, 3, 3)
    # The made-up floor spans x and z from -40 to 40, moved 5 along x.
    assert np.isclose(mesh[:, :, 0].min(), -35) and np.isclose(mesh[:, :, 0].max(), 45)


def test_collision_stops_when_cancelled(dsr_folder: Path) -> None:
    profile = PROFILES["dark-souls-remastered"]
    area = list_areas(profile, dsr_folder)[0]

    def stop() -> None:
        raise Cancelled()

    with pytest.raises(Cancelled):
        read_collision(profile, area, dsr_folder, {}, no_tick, stop)


class FakeMesh:
    vertex_count = 4

    def triangulate_flver2(self) -> np.ndarray:
        return np.zeros((2, 3))


class FakeFlver:
    version = 0x2000C
    meshes = [FakeMesh(), FakeMesh()]


def test_map_pieces_success_path_with_a_mock(dsr_folder: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Soulstruct cannot write a minimal FLVER, so the model reader is mocked: this checks counting and sampling."""
    import soulstruct.flver

    monkeypatch.setattr(soulstruct.flver.FLVER, "from_path", classmethod(lambda cls, path: FakeFlver()))
    profile = PROFILES["dark-souls-remastered"]
    area = list_areas(profile, dsr_folder)[0]
    folder = tmp_path / "map" / area.id
    folder.mkdir(parents=True)
    for index in range(30):
        (folder / f"m{index:04d}B1A10.flver.dcx").write_bytes(b"made up")
    copy = type(area)(id=area.id, name=area.name, msb=area.msb, map_folder=folder)

    result = read_map_pieces(profile, copy, tmp_path, no_tick, no_stop, sample=12)
    assert result.status == "ok"
    assert (result.entries, result.read, result.sampled) == (30, 12, True)
    assert result.vertices == 12 * 2 * 4
    assert result.triangles == 12 * 2 * 2
    everything = read_map_pieces(profile, copy, tmp_path, no_tick, no_stop, sample=0)
    assert (everything.read, everything.sampled) == (30, False)
