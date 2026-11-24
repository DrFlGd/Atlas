"""Whole game levels exported by the person (levels.py, unreal.py, unity.py), on made-up exports only
(tests/level_fixtures.py): an Unreal Engine level as FModel saves it and a Unity scene as AssetRipper exports it.

The tests that make a map run the scene builder (crates/atlas-scene), as test_model.py's do.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path

import numpy as np
import pytest

import level_fixtures
from atlas_gamefiles.events import Events
from atlas_gamefiles.levels import (
    AssetIndex,
    LevelError,
    assemble,
    default_assets,
    gltf_info,
    inspect_level,
    level_type,
    psk_info,
    summary_lines,
)
from atlas_gamefiles.model import ModelMapMaker
from atlas_gamefiles import unity, unreal
from test_model import builder  # noqa: F401  (the fixture)


def map_point(level_point: np.ndarray) -> tuple[float, float, float]:
    """A point of the level's frame (glTF: Y up, -Z north) on the map: east, north, height."""
    x, y, z = (float(v) for v in level_point[:3])
    return round(x, 6), round(-z, 6) + 0.0, round(y, 6)


def placed(level_file: Path) -> dict[str, dict]:
    document = json.loads(level_file.read_text(encoding="utf-8"))
    out = {}
    for instance in document["instances"]:
        matrix = np.asarray(instance["matrix"]).reshape(4, 4).T
        mesh = document["meshes"][instance["mesh"]]
        out[instance["name"]] = {"matrix": matrix, "mesh": Path(mesh["file"]).name, "base": mesh.get("base"), "materials": instance.get("materials")}
    return out


# Axes and handedness.


def test_unreal_rotations_follow_the_engine() -> None:
    x, y, z = np.eye(3)
    # Yaw turns X towards Y, pitch lifts X towards Z, roll turns Y towards -Z (FRotationMatrix).
    assert np.allclose(unreal.rotator_matrix(0, 90, 0) @ x, y)
    assert np.allclose(unreal.rotator_matrix(90, 0, 0) @ x, z)
    assert np.allclose(unreal.rotator_matrix(0, 0, 90) @ y, -z)
    # A rotator and its quaternion agree.
    s = math.sin(math.radians(45))
    assert np.allclose(unreal.rotator_matrix(0, 90, 0), unreal.quaternion_matrix(0, 0, s, s))
    # Every rotator is a turn, never a mirror.
    for angles in [(10, 20, 30), (-80, 170, 45), (0, -90, 180)]:
        assert np.isclose(np.linalg.det(unreal.rotator_matrix(*angles)), 1.0)


def test_unreal_axes_on_the_map() -> None:
    # A point 1 m along Unreal's X, 2 m along Y and 3 m up: X east, Y south (as the editor's top view), 3 m high.
    point = unreal.to_level(np.eye(4)) @ np.array([0, 0, 0, 1.0])
    assert map_point(point) == (0, 0, 0)
    point = unreal.TO_LEVEL @ np.array([100, 200, 300, 1.0])
    assert map_point(point) == (1, -2, 3)
    # Turning by yaw 90 is clockwise from above in Unreal (X to Y, east to south), and on the map too.
    turned = unreal.to_level(unreal.compose([0, 0, 0], unreal.rotator_matrix(0, 90, 0), [1, 1, 1]))
    east = turned @ np.array([1.0, 0, 0, 0])
    assert map_point(east) == (0, -1, 0)
    # The change of frame turns left- into right-handed: a transform keeps its sign of determinant.
    assert np.linalg.det(unreal.TO_LEVEL[:3, :3]) < 0
    assert np.isclose(np.linalg.det(turned[:3, :3]), 1.0)
    # An ActorX mesh (Y mirrored, Z up, centimetres): its own +X is east, its -Y (Unreal's +Y) south, +Z up.
    for psk_point, expected in [((100, 0, 0), (1, 0, 0)), ((0, -100, 0), (0, -1, 0)), ((0, 0, 100), (0, 0, 1))]:
        assert map_point(unreal.PSK_BASE @ np.array([*psk_point, 1.0])) == expected
    assert np.linalg.det(unreal.PSK_BASE[:3, :3]) > 0


def test_unity_axes_on_the_map() -> None:
    # Unity: X east, Z north (as its top view), Y up.
    assert map_point(unity.FLIP @ np.array([1.0, 2.0, 3.0, 1.0])) == (1, 3, 2)
    # A quarter turn about Y is clockwise from above in Unity (X to -Z, east to south), and on the map too.
    s = math.sin(math.radians(45))
    turned = unity.to_level(unity.compose([0, 0, 0], unity.quaternion_matrix(0, s, 0, s), [1, 1, 1]))
    assert map_point(turned @ np.array([1.0, 0, 0, 0])) == (0, -1, 0)
    assert np.isclose(np.linalg.det(turned[:3, :3]), 1.0)


def test_references_of_every_shape() -> None:
    parts = unreal.reference_parts
    assert parts({"ObjectName": "StaticMesh'SM_Rock'", "ObjectPath": "/Game/Env/SM_Rock.0"}) == ("StaticMesh", ["SM_Rock"], "/Game/Env/SM_Rock", 0)
    assert parts({"ObjectName": "StaticMeshComponent'Level:PersistentLevel.A.C0'", "ObjectPath": "/Game/Maps/Level.6"})[1:] == (
        ["PersistentLevel", "A", "C0"],
        "/Game/Maps/Level",
        6,
    )
    # The older one-string form, a bare path and a bare name.
    assert parts("StaticMesh'/Game/Env/SM_Rock.SM_Rock'") == ("StaticMesh", ["SM_Rock"], "/Game/Env/SM_Rock", None)
    assert unreal.segments_of("/Game/Textures/T_Rock_D") == ["Textures", "T_Rock_D"]
    assert unreal.segments_of("MI_Rock") == ["MI_Rock"]
    assert parts(None) == (None, [], None, None)
    assert parts(42) == (None, [], None, None)
    # Transforms in each form; missing values are the engine's defaults.
    t = unreal.transform_of({"TransformData": {"Translation": {"X": 1, "Y": 2, "Z": 3}}})
    assert t is not None and np.allclose(t[:3, 3], [1, 2, 3]) and np.allclose(t[:3, :3], np.eye(3))
    rows = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [5, 6, 7, 1]]
    m = unreal.transform_of({"M": rows})
    assert m is not None and np.allclose(m[:3, 3], [5, 6, 7])
    assert unreal.transform_of({"Something": 1}) is None


def test_choosing_the_diffuse_texture() -> None:
    assert unreal.diffuse_choice({"Normal": "/Game/T_A_N", "BaseColor": "/Game/T_A_D"}) == "/Game/T_A_D"
    assert unreal.diffuse_choice({"Tex1": "/Game/T_A_N", "Tex2": "/Game/T_A_BC"}) == "/Game/T_A_BC"
    assert unreal.diffuse_choice({"Mask": "/Game/T_A_ORM"}) is None
    assert unreal.diffuse_choice({}) is None


# FModel.


@pytest.fixture()
def fmodel(tmp_path: Path) -> Path:
    return level_fixtures.write_fmodel(tmp_path / "FModel Output ü")


def test_fmodel_level_is_placed(fmodel: Path, tmp_path: Path) -> None:
    assert level_type(fmodel) == "unreal"
    assert default_assets(fmodel, "unreal").name == "Exports"
    assembled = assemble(fmodel, tmp_path / "work", clutter=0.5)
    report = assembled.report
    assert report["placed"] == 3
    assert report["skipped"] == {"clutter": 3, "editorOnly": 1, "hidden": 1}
    assert report["notFound"] == [{"name": "Env/SM_Missing", "count": 1}]
    assert report["unknownTypes"] == [{"name": "LandscapeComponent", "count": 1}]
    placements = placed(assembled.file)
    assert set(placements) == {"Floor_1", "Floor_2", "BP_Crates_C_1"}
    # The upper floor is 4 m up; the crate hangs 1 m along its turned root's X: Unreal (10, 6, 0) m.
    assert map_point(placements["Floor_2"]["matrix"] @ np.array([0, 0, 0, 1.0])) == (0, 0, 4)
    crate = placements["BP_Crates_C_1"]
    assert crate["mesh"] == "SM_Crate.pskx" and crate["base"] is not None
    base = np.asarray(crate["base"]).reshape(4, 4).T
    assert map_point(crate["matrix"] @ base @ np.array([0, 0, 0, 1.0])) == (10, -6, 0)
    # The crate's top (1 m up in its own Z-up centimetres) is 1 m up on the map.
    assert map_point(crate["matrix"] @ base @ np.array([0, 0, 100, 1.0]))[2] == 1
    # Textures: the floor's own material (BaseColor), the override's parent (a name ending _BC), the crate's .mat.
    textures = {name: Path(p["materials"][0]["texture"]).name for name, p in placements.items()}
    assert textures == {"Floor_1": "T_Floor_D.png", "Floor_2": "T_Alt_BC.png", "BP_Crates_C_1": "T_Crate_D.png"}
    assert "Env/SM_Missing" in " ".join(summary_lines(report))


def test_fmodel_hidden_kept_and_clutter_kept(fmodel: Path, tmp_path: Path) -> None:
    report = assemble(fmodel, tmp_path / "work", clutter=0.0, leave_out_hidden=False).report
    # The pebbles and the hidden wall are placed; editor-only meshes never are.
    assert report["placed"] == 3 + 3 + 1
    assert report["skipped"] == {"editorOnly": 1}


def test_fmodel_tolerates_what_it_does_not_know(tmp_path: Path) -> None:
    content = tmp_path / "Exports" / "Game" / "Content"
    level_fixtures.glb_box(content / "Env" / "SM_Floor.glb", (-5, -0.2, -5), (5, 0, 5), "MI_Unknown")
    level = content / "Maps" / "Odd.json"
    level.parent.mkdir(parents=True)
    exports = [
        {"Type": "World", "Name": "Odd"},
        "not an export",
        # No transform at all, an older string reference, and fields never seen before.
        {"Type": "StaticMeshComponent", "Name": "Mesh0", "Outer": "A", "Properties": {"StaticMesh": "StaticMesh'/Game/Env/SM_Floor.SM_Floor'", "NewThing": [1, 2]}},
        {"Type": "StaticMeshComponent", "Name": "Mesh1", "Outer": "B", "Properties": {"StaticMesh": {"ObjectName": "StaticMesh'SM_Floor'"}, "RelativeLocation": "bad"}},
        {"Type": "WaterBodyComponent", "Name": "Water", "Outer": "C"},
        {"Type": "StaticMeshComponent", "Name": "Empty", "Outer": "D", "Properties": {}},
    ]
    level.write_text(json.dumps(exports), encoding="utf-8")
    assembled = assemble(level, tmp_path / "work")
    report = assembled.report
    assert report["placed"] == 2
    assert report["unknownTypes"] == [{"name": "WaterBodyComponent", "count": 1}]
    assert report["skipped"] == {"noMesh": 1}
    assert report["texturesMissing"] == [{"name": "MI_Unknown", "count": 2}]
    for placement in placed(assembled.file).values():
        assert np.allclose(placement["matrix"], np.eye(4))
    # Not FModel's JSON, and nothing that can be placed.
    level.write_text('{"Hello": 1}', encoding="utf-8")
    with pytest.raises(LevelError, match="not a level saved by FModel"):
        assemble(level, tmp_path / "work")
    level.write_text(json.dumps([{"Type": "World", "Name": "Odd"}]), encoding="utf-8")
    with pytest.raises(LevelError, match="No mesh"):
        assemble(level, tmp_path / "work")
    with pytest.raises(LevelError, match="not a level export"):
        assemble(tmp_path / "model.glb", tmp_path / "work")


def test_mesh_files_are_found_and_measured(fmodel: Path) -> None:
    root = default_assets(fmodel, "unreal")
    index = AssetIndex(root, (".glb", ".pskx"))
    assert index.find(["Env", "SM_Floor"], (".glb",)) is not None
    assert index.find(["Elsewhere", "SM_Floor"], (".glb",)) is not None, "by name when its folder differs"
    assert index.find(["Env", "SM_Nothing"], (".glb",)) is None
    floor = gltf_info(index.find(["Env", "SM_Floor"], (".glb",)))
    assert floor is not None and floor.materials == ["MI_Floor"] and floor.textured == [False]
    assert np.allclose(floor.low, [-5, -0.2, -5]) and np.allclose(floor.high, [5, 0, 5])
    crate = psk_info(index.find(["Props", "SM_Crate"], (".pskx",)))
    assert crate is not None and crate.materials == ["MI_Crate"]
    assert np.allclose(crate.high, [50, 50, 100])


# Unity.


@pytest.fixture()
def unity_scene(tmp_path: Path) -> Path:
    return level_fixtures.write_unity(tmp_path / "AssetRipper Export ü")


def test_unity_scene_is_placed(unity_scene: Path, tmp_path: Path) -> None:
    assert level_type(unity_scene) == "unity"
    assert default_assets(unity_scene, "unity").name == "ExportedProject"
    assembled = assemble(unity_scene, tmp_path / "work")
    report = assembled.report
    assert report["placed"] == 5
    assert report["skipped"] == {"editorOnly": 1, "hidden": 3, "lowerDetail": 1}
    assert report["notFoundCount"] == 1
    assert report["unknownTypes"] == [{"name": "Terrain", "count": 1}]
    placements = placed(assembled.file)
    assert set(placements) == {"Ground", "Upper Floor", "Turned Crate", "Crate", "Rock_LOD0"}
    # Unity (5, 0.5, 3): 5 m east, 3 m north, 0.5 m up.
    assert map_point(placements["Crate"]["matrix"] @ np.array([0, 0, 0, 1.0])) == (5, 3, 0.5)
    # Under a parent turned a quarter round about Y (clockwise from above): 1 m along its x is 1 m south.
    assert map_point(placements["Turned Crate"]["matrix"] @ np.array([0, 0, 0, 1.0])) == (0, -1, 8.5)
    assert Path(placements["Ground"]["materials"][0]["texture"]).name == "Ground.png"
    assert placements["Crate"]["mesh"] == "builtin-cube.glb"
    # Unity's own mesh, written as glTF: its top still faces up once mirrored into the level's frame.
    slab = Path(json.loads(assembled.file.read_text(encoding="utf-8"))["meshes"][0]["file"])
    document = glb_mesh(slab)
    positions, triangles = document
    a, b, c = positions[triangles[:3]]
    assert np.cross(b - a, c - a)[1] > 0


def glb_mesh(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Positions and the first primitive's indices of a glTF binary file this helper wrote."""
    import struct

    data = path.read_bytes()
    length = struct.unpack("<I", data[12:16])[0]
    document = json.loads(data[20 : 20 + length])
    binary = data[28 + length :]

    def accessor(index: int, dtype: str, width: int) -> np.ndarray:
        view = document["bufferViews"][document["accessors"][index]["bufferView"]]
        return np.frombuffer(binary[view["byteOffset"] : view["byteOffset"] + view["byteLength"]], dtype=dtype).reshape(-1, width)

    primitive = document["meshes"][0]["primitives"][0]
    return accessor(primitive["attributes"]["POSITION"], "<f4", 3), accessor(primitive["indices"], "<u4", 1).reshape(-1)


def test_unity_hidden_kept(unity_scene: Path, tmp_path: Path) -> None:
    report = assemble(unity_scene, tmp_path / "work", leave_out_hidden=False).report
    # The inactive and disabled crates and the collision-only wall are placed; editor-only and coarser levels not.
    assert report["placed"] == 5 + 3
    assert report["skipped"] == {"editorOnly": 1, "lowerDetail": 1}


def test_unity_meshes_and_shapes() -> None:
    mesh = unity.load_documents_text(level_fixtures.unity_slab_mesh(2.0))[0][3]
    positions, uvs, groups = unity.read_unity_mesh(mesh, None)
    assert positions.shape == (4, 3) and np.allclose(positions[:, 1], 0)
    assert uvs is not None and np.allclose(uvs[0], [0, 1]), "v counted from the top, as glTF does"
    assert len(groups) == 1 and len(groups[0]) == 6
    with pytest.raises(ValueError):
        unity.read_unity_mesh({"m_VertexData": {"m_VertexCount": "0"}}, None)
    for shape in ("Cube", "Sphere", "Cylinder", "Capsule", "Plane", "Quad"):
        positions, uvs, triangles = unity.builtin_mesh(shape)
        assert len(triangles) % 3 == 0 and triangles.max() < len(positions) and len(uvs) == len(positions)
    _, _, cube = unity.builtin_mesh("Cube")
    assert len(cube) == 36
    # Static batching: the submeshes of a combined mesh a renderer draws.
    assert unity.static_batch({"m_StaticBatchInfo": {"firstSubMesh": "2", "subMeshCount": "3"}, "m_StaticBatchRoot": {"fileID": "77"}}) == ((2, 3), "77")
    assert unity.static_batch({"m_StaticBatchInfo": {"firstSubMesh": "0", "subMeshCount": "0"}}) == (None, None)
    texture, colour = unity.material_values(
        {"m_SavedProperties": {"m_TexEnvs": [{"first": {"name": "_MainTex"}, "second": {"m_Texture": {"fileID": "2800000", "guid": "ab" * 16}}}],
                               "m_Colors": [{"first": {"name": "_Color"}, "second": {"r": "1", "g": "0.5", "b": "0", "a": "1"}}]}}
    )
    assert texture == {"fileID": "2800000", "guid": "ab" * 16}
    assert colour is not None and colour[0] == 1 and 0.2 < colour[1] < 0.22


def test_unity_scene_that_is_not_text(tmp_path: Path) -> None:
    scene = tmp_path / "Assets" / "Binary.unity"
    scene.parent.mkdir(parents=True)
    scene.write_bytes(b"\x00\x01binary scene")
    with pytest.raises(LevelError, match="saved as text"):
        assemble(scene, tmp_path / "work")


# Making the map.


def test_level_maps_are_made(fmodel: Path, unity_scene: Path, tmp_path: Path, builder: Path) -> None:  # noqa: F811
    for level, name in ((fmodel, "Made-up Level"), (unity_scene, "Made-up Scene")):
        stream = io.StringIO()
        out = tmp_path / f"out {name}"
        report = ModelMapMaker(
            level,
            out,
            Events(stream),
            maps_folder=tmp_path / "maps",
            scene_builder=builder,
            name=name,
            up="+z",  # ignored for a level: it stands up already
            scale=0.01,
            style="textured",
            cut_below=1.0,
        ).run()
        model = report["model"]
        assert model["up"] == "+y" and model["scale"] == 1.0
        assert model["levelReport"]["placed"] >= 3
        assert model["cutBelow"] == 1.0
        assert report["options"]["floors"]["cutBelow"] == 1.0
        area = report["areas"][0]
        assert len(area["floors"]) == 2, area["floorPlan"]
        assert area["mapStyle"] == "textured"
        assert area["scene"]["made"]
        cut = area["floorPlan"]["cuts"][0]
        assert 2.5 < cut < 3.5, "the upper floor (4 m) cut 1 m below"
        events = [json.loads(line) for line in stream.getvalue().splitlines()]
        assert any(e["event"] == "level" and e["placed"] == model["levelReport"]["placed"] for e in events)
        assert not (out / "model-work").exists()
        assert (tmp_path / "maps" / report["pack"]["id"] / "manifest.json").is_file()


def test_inspect_level(unity_scene: Path, builder: Path) -> None:  # noqa: F811
    answer = inspect_level(unity_scene, None, 0.0, True, None, builder)
    assert answer["info"]["format"] == "level" and answer["info"]["up"] == "+y"
    assert answer["level"]["placed"] == 5
    assert answer["preview"]["triangles"] > 0
    with pytest.raises(LevelError):
        inspect_level(unity_scene.with_suffix(".json"), None, 0.0, True, None, builder)
