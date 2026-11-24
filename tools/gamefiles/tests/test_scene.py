"""3D maps: the raw model the helper writes, and Make map with the scene builder (crates/atlas-scene), on made-up
geometry only.

The tests that run the builder need it built: `cargo build --release` in crates/atlas-scene, or a path in
ATLAS_SCENE_BUILDER. Without it they are skipped, unless ATLAS_SCENE_REQUIRED is set (CI sets it), when they fail.
"""

from __future__ import annotations

import io
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

from atlas_gamefiles.check import CancelToken
from atlas_gamefiles.events import Events
from atlas_gamefiles.geometry import Cancelled
from atlas_gamefiles.make import MapMaker
from atlas_gamefiles.scene import (
    builder_name,
    check_pack,
    corner_colours,
    find_builder,
    floor_heights,
    raw_glb,
)
from atlas_gamefiles.worker import InlineRunner
from conftest import snapshot

PACK = "dark-souls-remastered"
REPO = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def builder() -> Path:
    for candidate in (
        os.environ.get("ATLAS_SCENE_BUILDER"),
        REPO / "crates" / "atlas-scene" / "target" / "release" / builder_name(),
        REPO / "crates" / "atlas-scene" / "target" / "debug" / builder_name(),
    ):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    if os.environ.get("ATLAS_SCENE_REQUIRED"):
        pytest.fail("the scene builder is not built (cargo build --release in crates/atlas-scene)")
    pytest.skip("the scene builder is not built")


def split(data: bytes) -> tuple[dict, bytes]:
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    assert (magic, version, total) == (b"glTF", 2, len(data))
    json_length, _ = struct.unpack_from("<I4s", data, 12)
    document = json.loads(data[20 : 20 + json_length])
    bin_length, kind = struct.unpack_from("<I4s", data, 20 + json_length)
    assert kind == b"BIN\0"
    start = 28 + json_length
    return document, data[start : start + bin_length]


def square(y: float, x0: float = 0.0, z0: float = 0.0, size: float = 4.0, down: bool = False) -> np.ndarray:
    """Two triangles of a level square at height y; counter-clockwise from above (+y) unless `down`."""
    a, b, c, d = (x0, y, z0), (x0 + size, y, z0), (x0 + size, y, z0 + size), (x0, y, z0 + size)
    tris = [[a, c, b], [a, d, c]]
    if down:
        tris = [[t[0], t[2], t[1]] for t in tris]
    return np.array(tris, dtype=np.float32)


def test_raw_model_has_a_node_per_part_and_floors_face_up() -> None:
    tris = np.concatenate([square(0.0, down=True), square(5.0, 10.0, down=True)])
    owners = np.array([0, 0, 1, 1], dtype=np.int32)
    colours = corner_colours(tris, 0.0, 5.0, flipped=True)
    document, binary = split(raw_glb(tris, colours, owners, ["h0001", "h0002"], flipped=True))
    assert [n["name"] for n in document["nodes"]] == ["h0001", "h0002"]
    positions = document["accessors"][document["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    view = document["bufferViews"][positions["bufferView"]]
    points = np.frombuffer(binary, dtype=np.float32, count=positions["count"] * 3, offset=view["byteOffset"]).reshape(-1, 3, 3)
    normal = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    assert (normal[:, 1] > 0).all(), "turned to face up"
    assert positions["min"] == [0.0, 0.0, 0.0] and positions["max"] == [4.0, 0.0, 4.0]
    # Collision is drawn from both sides in the 3D view.
    assert document["materials"][0]["doubleSided"] is True
    assert document["meshes"][1]["primitives"][0]["material"] == 0


def test_colours_follow_height_and_slope() -> None:
    low, high = square(0.0), square(10.0)
    wall = np.array([[[0, 0, 0], [0, 4, 0], [4, 0, 0]]], dtype=np.float32)  # standing up
    colours = corner_colours(np.concatenate([low, high, wall]), 0.0, 10.0, flipped=False)
    assert colours.shape == (5, 3, 3)
    assert colours[2].mean() > colours[0].mean(), "higher ground is lighter"
    # The wall's foot is at the ground's height but darker.
    assert colours[4, 0].mean() < colours[0, 0].mean()
    # One place on one kind of slope has one colour, so the builder can join the corners.
    assert np.array_equal(colours[0, 0], colours[1, 0])
    assert (colours >= 0).all() and (colours <= 1).all()


def test_floor_heights() -> None:
    assert floor_heights([], 1, -3.2, 20.0) is None
    assert floor_heights([4.5], 2, -3.2, 20.0) == [[-4.0, 4.5], [4.5, 20.0]]
    assert floor_heights([4.5, 9.0], 2, -3.2, 20.0) is None  # does not add up: no heights


def test_finds_the_builder_named_or_in_the_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    program = tmp_path / builder_name()
    program.write_bytes(b"")
    monkeypatch.delenv("ATLAS_SCENE_BUILDER", raising=False)
    assert find_builder(program) == program
    assert find_builder(tmp_path / "missing") is None
    monkeypatch.setenv("ATLAS_SCENE_BUILDER", str(program))
    assert find_builder() == program


def make(folder: Path, out: Path, maps: Path, **options) -> tuple[dict, list[dict]]:
    stream = io.StringIO()
    report = MapMaker(folder, out, Events(stream), maps_folder=maps, runner=InlineRunner(), **options).run()
    return report, [json.loads(line) for line in stream.getvalue().splitlines()]


def load(pack: Path, name: str) -> list | dict:
    return json.loads((pack / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def made_3d(dsr_map_folder: Path, builder: Path, tmp_path_factory: pytest.TempPathFactory):
    base = tmp_path_factory.mktemp("make3d")
    report, events = make(dsr_map_folder, base / "out", base / "Maps", scene_builder=builder)
    return report, events, base / "Maps" / PACK, base / "out"


def test_make_writes_a_3d_model_per_area(made_3d, builder: Path) -> None:
    report, events, pack, out = made_3d
    assert events[-1]["event"] == "done"
    maps = {m["id"]: m for m in load(pack, "maps.json")}
    anor = maps[f"{PACK}:map:m15_01"]
    scene = anor["scene"]
    assert scene["cells"] and "axes" not in scene and len(scene["offset"]) == 3
    for cell in scene["cells"]:
        for lod in cell["lods"]:
            assert lod["file"].startswith("scene/m15_01/")
            assert (pack / lod["file"]).read_bytes()[:4] == b"glTF"
    # The model lines up with the map: its cells lie over the map's picture, in world x and the game's z.
    t = anor["worldTransform"]
    x0, z1 = t["e"], t["f"]
    x1, z0 = x0 + anor["width"] * t["a"], z1 + anor["height"] * t["d"]
    for cell in scene["cells"]:
        bx0, by0, bx1, by1 = cell["bounds"]
        assert bx1 > x0 and bx0 < x1 and by1 > z0 and by0 < z1
    # An area with no geometry has no model.
    assert "scene" not in maps[f"{PACK}:map:m10_02"]
    # Two floors: each layer has its heights, split at the cut the floor finder chose.
    layers = [layer for layer in load(pack, "layers.json") if layer["mapId"] == anor["id"]]
    heights = {layer["name"]: layer["heights"] for layer in layers}
    cut = next(a for a in report["areas"] if a["key"] == "m15_01")["floorPlan"]["cuts"][0]
    assert heights["Ground"][1] == pytest.approx(cut, abs=0.01) == heights["Rooftops"][0]
    # Markers of an area with a model have their height.
    locations = {loc["id"]: loc for loc in load(pack, "locations.json")}
    roof_bonfire = locations[f"{PACK}:loc:m15_01.bonfire.1511961"]
    assert roof_bonfire["height"] > cut
    assert all("height" not in loc for loc in locations.values() if loc["mapId"] == f"{PACK}:map:m10_02")
    # The check of the builder passes, and the work files are gone.
    assert report["pack"]["check3d"]["problems"] == []
    assert check_pack(builder, pack)["problems"] == []
    assert not (out / "scene-work").exists()


def test_make_reports_the_3d_side(made_3d) -> None:
    report, events, _, out = made_3d
    lines = {e["id"][:6]: e.get("scene") for e in events if e["event"] == "area"}
    assert lines["m15_01"] is True and lines["m10_02"] is False
    anor = next(a for a in report["areas"] if a["key"] == "m15_01")["scene"]
    assert anor["made"] is True
    assert anor["trianglesBefore"] > 0 and 0 < anor["trianglesAfter"] <= anor["trianglesBefore"]
    assert anor["cells"] >= 1 and anor["files"] >= anor["cells"] and anor["bytes"] > 0
    assert anor["seconds"] >= 0 and anor["noSurfaceUnder"] == 0
    assert [len(f) for f in anor["floors"]] == [2, 2]
    firelink = next(a for a in report["areas"] if a["key"] == "m10_02")["scene"]
    assert firelink == {"made": False, "trianglesBefore": 0, "reason": "no geometry was read"}
    summary = report["summary"]["threeD"]
    assert summary["areasMade"] >= 1 and summary["bytes"] > 0
    assert report["options"]["threeD"]["asked"] is True
    text = (out / "report.json").read_text(encoding="utf-8")
    assert "Made-up" not in text


def test_without_3d_the_pack_is_as_before(dsr_map_folder: Path, builder: Path, tmp_path: Path) -> None:
    report, _ = make(dsr_map_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], make_3d=False, scene_builder=builder)
    pack = tmp_path / "Maps" / PACK
    assert "scene" not in load(pack, "maps.json")[0]
    assert all("heights" not in layer for layer in load(pack, "layers.json"))
    assert all("height" not in loc for loc in load(pack, "locations.json"))
    assert not (pack / "scene").exists()
    assert report["summary"]["threeD"] is None and report["pack"]["check3d"] is None


def test_a_missing_builder_leaves_the_maps_2d(dsr_map_folder: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATLAS_SCENE_BUILDER", raising=False)
    report, _ = make(dsr_map_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], scene_builder=tmp_path / "nothing")
    assert any("3D builder" in w for w in report["warnings"])
    assert "scene" not in load(tmp_path / "Maps" / PACK, "maps.json")[0]
    assert report["areas"][0]["scene"] == {"made": False, "reason": "the 3D builder is missing"}


def test_a_failing_builder_leaves_that_map_2d(dsr_map_folder: Path, tmp_path: Path) -> None:
    # Python is no builder: it ends with an error, as a broken builder would.
    report, events = make(dsr_map_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], scene_builder=Path(sys.executable))
    assert events[-1]["event"] == "done"
    assert any("3D model was not made" in w for w in report["warnings"])
    assert report["areas"][0]["scene"]["made"] is False
    assert "scene" not in load(tmp_path / "Maps" / PACK, "maps.json")[0]


def test_cancel_while_making_the_model_changes_nothing(dsr_map_folder: Path, builder: Path, tmp_path: Path) -> None:
    maps = tmp_path / "Maps"
    make(dsr_map_folder, tmp_path / "out1", maps, only_areas=["m15_01"], scene_builder=builder)
    before = snapshot(maps)
    token = CancelToken()

    class CancelWhileModelling(Events):
        def progress(self, fraction: float, message: str, **extra) -> None:
            super().progress(fraction, message, **extra)
            if "3D model" in message:
                token.cancel()

    maker = MapMaker(
        dsr_map_folder,
        tmp_path / "out2",
        CancelWhileModelling(io.StringIO()),
        token=token,
        maps_folder=maps,
        runner=InlineRunner(),
        scene_builder=builder,
    )
    with pytest.raises(Cancelled):
        maker.run()
    assert snapshot(maps) == before


def test_make_this_area_again_replaces_its_3d_model(dsr_map_folder: Path, builder: Path, tmp_path: Path) -> None:
    maps, out = tmp_path / "Maps", tmp_path / "out"
    make(dsr_map_folder, out, maps, scene_builder=builder)
    pack = maps / PACK
    others = {p: d for p, d in snapshot(pack).items() if not p.startswith(("tiles/m15_01/", "scene/m15_01/")) and not p.endswith(".json")}
    own = tmp_path / "floor-overrides.json"
    own.write_text(json.dumps({PACK: {"m15_01": {"cuts": [3.5]}}}), encoding="utf-8")
    report, events = make(dsr_map_folder, out, maps, scene_builder=builder, remake="m15_01", floor_overrides_file=own)
    assert events[-1]["event"] == "done"
    # The other maps' files are untouched; the area's new model passes the check, and so does the whole pack.
    assert {p: d for p, d in snapshot(pack).items() if p in others} == others
    assert report["remade"]["check3dOfArea"]["problems"] == []
    assert report["pack"]["check3d"]["problems"] == []
    assert check_pack(builder, pack)["problems"] == []
    anor = next(m for m in load(pack, "maps.json") if m["id"] == f"{PACK}:map:m15_01")
    for cell in anor["scene"]["cells"]:
        for lod in cell["lods"]:
            assert (pack / lod["file"]).is_file()
    heights = [layer["heights"] for layer in load(pack, "layers.json") if layer["mapId"] == anor["id"]]
    assert sorted(h[1] for h in heights)[0] == pytest.approx(3.5)
    assert sorted(p.name for p in maps.iterdir()) == [PACK]
    assert not (out / "scene-work").exists()
