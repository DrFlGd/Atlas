"""Making a map from a 3D model file (model.py), and the ground-area floor method (floors.py), on made-up models only
(tests/model_fixtures.py: a two-storey house written as OBJ and STL).

The tests that read model files run the scene builder (crates/atlas-scene): `cargo build --release` there first, or
name it in ATLAS_SCENE_BUILDER. Without it they are skipped, unless ATLAS_SCENE_REQUIRED is set (CI sets it).
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path

import numpy as np
import pytest

import model_fixtures
from atlas_gamefiles.events import Events
from atlas_gamefiles.floors import ground_cuts, plan_floors, prepare, settings_from
from atlas_gamefiles.floorviews import AreaViews, data_file
from atlas_gamefiles.make import MakeError
from atlas_gamefiles.model import UP_AXES, ModelMapMaker, orient_up, pack_id_for
from atlas_gamefiles.pack import GAME_FILES_ATTRIBUTION, MODEL_ATTRIBUTION, WRITER
from atlas_gamefiles.scene import builder_name

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


def house_triangles() -> np.ndarray:
    """The made-up house as the helper holds triangles: x east, height, z north."""
    out = []
    for corners, _ in model_fixtures.house():
        a, b, c, d = ((x, z, y) for x, y, z in corners)
        out += [(a, b, c), (a, c, d)]
    return np.asarray(out, dtype=np.float32)


def events() -> tuple[Events, io.StringIO]:
    stream = io.StringIO()
    return Events(stream), stream


def lines(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def test_pack_ids_and_up_axes() -> None:
    assert pack_id_for("Made-up House") == "made-up-house"
    assert pack_id_for("Château d’Été 2") == "chateau-d-ete-2"
    assert pack_id_for("   ") == "model-map"
    assert pack_id_for("a" * 100) == "a" * 64
    # Each up axis is a turn, never a mirror: east × north = up.
    vectors = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0), "-y": (0, -1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}
    for up, (east, north, height) in UP_AXES.items():
        assert height == up
        assert tuple(np.cross(vectors[east], vectors[north])) == vectors[height], up


def test_ground_area_finds_the_storeys_and_their_cuts() -> None:
    triangles = house_triangles()
    settings = settings_from({"automatic": "ground", "bothSides": 1})
    cuts, notes = ground_cuts(orient_up(triangles), False, settings)
    # Levels at the upper floor's top (3.5) and the roof's top (7.3), each cut 1.5 m below.
    assert [note["level"] for note in notes] == [3.5, 7.3]
    assert cuts == [2.0, 5.8]
    # A larger separation keeps the stronger of two close levels; a peak under the share is left out.
    cuts, _ = ground_cuts(orient_up(triangles), False, settings_from({"bothSides": 1, "floorSeparation": 4.0}))
    assert len(cuts) == 1
    cuts, _ = ground_cuts(orient_up(triangles), False, settings_from({"bothSides": 1, "groundShare": 0.9}))
    assert cuts == []
    # Joined when closer than the merge gap.
    cuts, _ = ground_cuts(orient_up(triangles), False, settings_from({"bothSides": 1, "mergeGap": 3.9}))
    assert len(cuts) == 1
    # The plan: three floors, the yard and ground floor on the lowest.
    plan = plan_floors(prepare(orient_up(triangles), {"automatic": "ground", "bothSides": 1}))
    assert plan.cuts == [2.0, 5.8]
    assert len(plan.floors) == 3
    assert plan.floors[0].area > plan.floors[1].area
    # No floors: one.
    assert plan_floors(prepare(triangles, {"automatic": "none"})).cuts == []


def test_orient_up_turns_downward_faces() -> None:
    triangles = house_triangles()
    turned = orient_up(triangles)
    a, b, c = (turned[:, i].astype(np.float64) for i in range(3))
    assert (np.cross(b - a, c - a)[:, 1] >= 0).all()
    assert turned.shape == triangles.shape


def make(builder: Path, model: Path, out: Path, maps: Path, **options) -> tuple[dict, list[dict]]:
    sink, stream = events()
    report = ModelMapMaker(model, out, sink, maps_folder=maps, scene_builder=builder, **options).run()
    return report, lines(stream)


def test_makes_a_pack_from_an_obj_with_its_texture(builder: Path, tmp_path: Path) -> None:
    model = model_fixtures.write_obj(tmp_path / "my models ü")
    maps = tmp_path / "Maps"
    out = tmp_path / "out"
    report, said = make(builder, model, out, maps, name="Made-up House", style="textured")
    assert [line["event"] for line in said if line["event"] != "progress"][:2] == ["start", "model"]
    assert said[-1]["event"] == "done"
    pack = maps / "made-up-house"
    manifest = json.loads((pack / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["writtenBy"]["name"] == WRITER
    assert manifest["title"] == "Made-up House"
    assert manifest["attribution"] == [{"name": MODEL_ATTRIBUTION}]
    assert json.loads((pack / "locations.json").read_text(encoding="utf-8")) == []
    layers = json.loads((pack / "layers.json").read_text(encoding="utf-8"))
    assert [layer["heights"] for layer in layers if layer["id"].endswith("-f1")] == [[2.0, 5.8]]
    assert len(layers) == 3
    maps_json = json.loads((pack / "maps.json").read_text(encoding="utf-8"))
    assert maps_json[0]["scene"]["cells"], "a 3D map"
    assert (pack / "tiles" / "model" / "f2").is_dir()
    area = report["areas"][0]
    assert area["mapStyle"] == "textured"
    assert [cut["height"] for cut in area["floorPlan"]["cutList"]] == [2.0, 5.8]
    assert report["model"]["format"] == "OBJ"
    assert report["model"]["texturesFound"] == 1
    assert report["model"]["sizeMetres"] == [30.0, 22.0, 7.5]
    assert area["scene"]["texturesKept"] == 1
    assert (out / "previews" / "model_f2.png").is_file()
    assert (out / "atlas-make-report.zip").is_file()
    # The roof's texture is on the top floor's picture: red tiles, not the height ramp's teal.
    from PIL import Image

    with Image.open(out / "previews" / "model_f2.png") as picture:
        r, g, b = picture.convert("RGB").getpixel((picture.width // 2, picture.height // 2))
    assert r > g + 40 and r > b + 40, (r, g, b)

    # Adjust floors reads its floor data, with the ground-area cuts as the automatic ones.
    views = AreaViews(data_file(out, "model"))
    ready = views.ready()
    assert ready["automatic"] == [2.0, 5.8]
    assert ready["markers"] == []
    assert len(views.views([3.0], ["", "Top"])["floors"]) == 2

    # Make this area again with the person's cuts (under the pack id and the area "model").
    overrides = tmp_path / "floor-overrides.json"
    overrides.write_text(json.dumps({"made-up-house": {"model": {"cuts": [2.5], "names": ["Downstairs", "Upstairs"]}}}), encoding="utf-8")
    again, _ = make(builder, model, out, maps, name="Made-up House", floor_overrides_file=overrides, remake=True)
    assert again["remade"]["area"] == "model"
    assert again["createdAt"] == report["createdAt"]
    assert [floor["name"] for floor in again["areas"][0]["floors"]] == ["Downstairs", "Upstairs"]
    assert again["options"]["floorOverrides"]["usedFor"] == ["model"]
    assert not (out / "previews" / "model_f2.png").exists(), "the old third floor's preview is gone"

    # The model file moved: said plainly, with a code the app knows.
    moved = model.with_name("moved.obj")
    model.rename(moved)
    with pytest.raises(MakeError) as raised:
        make(builder, model, out, maps, name="Made-up House", remake=True)
    assert raised.value.code == "model-missing"


def test_an_stl_in_millimetres_with_z_up(builder: Path, tmp_path: Path) -> None:
    model = model_fixtures.write_stl(tmp_path / "house.stl")
    report, _ = make(builder, model, tmp_path / "out", tmp_path / "Maps", up="+z", scale=0.001, floors="none", style="textured")
    assert report["model"]["sizeMetres"] == [30.0, 22.0, 7.5]
    assert len(report["areas"][0]["floors"]) == 1
    assert report["areas"][0]["mapStyle"] == "shaded", "no colours of its own: height shaded"
    assert any("no colours or textures" in warning for warning in report["warnings"])
    passages, _ = make(builder, model, tmp_path / "out2", tmp_path / "Maps", up="+z", scale=0.001, floors="passages")
    assert passages["areas"][0]["floorPlan"]["method"] == "passages"
    assert len(passages["areas"][0]["floors"]) >= 2


def test_bad_files_and_packs_made_from_game_files_are_refused(builder: Path, tmp_path: Path) -> None:
    bad = tmp_path / "broken.stl"
    bad.write_bytes(b"\0" * 90)
    with pytest.raises(MakeError, match="could not be read"):
        make(builder, bad, tmp_path / "out", tmp_path / "Maps")
    fbx = tmp_path / "model.fbx"
    fbx.write_bytes(b"Kaydara FBX Binary  \0")
    with pytest.raises(MakeError, match="Export the model as glTF"):
        make(builder, fbx, tmp_path / "out", tmp_path / "Maps")
    model = model_fixtures.write_stl(tmp_path / "house.stl")
    with pytest.raises(MakeError, match="Allow very large models"):
        make(builder, model, tmp_path / "out", tmp_path / "Maps", max_triangles=10)
    game = tmp_path / "Maps" / "made-up-game"
    game.mkdir(parents=True)
    (game / "manifest.json").write_text(
        json.dumps({"writtenBy": {"name": WRITER}, "attribution": [{"name": GAME_FILES_ATTRIBUTION}]}), encoding="utf-8"
    )
    with pytest.raises(MakeError, match="made from game files"):
        make(builder, model, tmp_path / "out", tmp_path / "Maps", name="Made-up Game", up="+z", scale=0.001)
    assert (game / "manifest.json").is_file()
