"""Making a map pack from a made-up Bloodborne dump (tests/fixtures.py, make_bloodborne): Havok 2014 collision and
navmesh read by our own decoder, lamps from the event script, treasure chains, and floors by automatic passages."""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import pytest

import fixtures
from atlas_gamefiles.events import Events
from atlas_gamefiles.games import PROFILES
from atlas_gamefiles.make import MakeError, MapMaker, map_offset_transform
from atlas_gamefiles.worker import InlineRunner
from conftest import snapshot

PACK = "bloodborne"


def make(folder: Path, out: Path, maps: Path, **options) -> tuple[dict, list[dict]]:
    from soulstruct.darksouls1r.maps import MSB as DarkSoulsMSB

    stream = io.StringIO()
    # Soulstruct cannot write Bloodborne MSBs, so the made-up one is a Dark Souls MSB, read with that class.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(type(PROFILES["bloodborne"]), "msb_class", lambda self: DarkSoulsMSB)
        report = MapMaker(folder, out, Events(stream), maps_folder=maps, runner=InlineRunner(), **options).run()
    return report, [json.loads(line) for line in stream.getvalue().splitlines()]


def load(pack: Path, name: str) -> list | dict:
    return json.loads((pack / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def made(bloodborne_folder: Path, tmp_path_factory: pytest.TempPathFactory) -> tuple[dict, Path, Path]:
    before = snapshot(bloodborne_folder)
    base = tmp_path_factory.mktemp("make-bloodborne")
    report, events = make(bloodborne_folder, base / "out", base / "Maps")
    assert snapshot(bloodborne_folder) == before, "the game folder must not change"
    assert events[-1]["event"] == "done"
    return report, base / "Maps" / PACK, base / "out"


def test_report(made) -> None:
    report, _, _ = made
    assert report["game"]["id"] == "bloodborne"
    (ward,) = report["areas"]
    assert ward["name"] == "Cathedral Ward"
    geometry = ward["geometry"]
    assert geometry["used"] == "collision" and geometry["navmeshForPassages"] is True
    assert geometry["collision"]["status"] == "ok" and geometry["navmesh"]["status"] == "ok"
    assert geometry["navmeshPlacement"]["chosen"] == "as placed"
    plan = ward["floorPlan"]
    assert plan["method"] == "passages"
    assert plan["navmesh"]["used"] is True
    assert len(plan["passages"]["places"]) == 1
    assert [f["areaSquareMetres"] < 250 for f in ward["floors"]] == [True, False]
    assert ward["mainFloor"] == 1
    assert report["options"]["floorMethod"] == "passages"


def test_lamps_items_and_names(made) -> None:
    _, pack, _ = made
    locations = {loc["id"].split(":loc:")[1]: loc for loc in load(pack, "locations.json")}
    lamp = locations["m24_00.bonfire.2401960"]
    assert lamp["flagId"] == "12401010"
    categories = {c["id"].split(":cat:")[1]: c for c in load(pack, "categories.json")}
    assert categories["bonfire"]["name"] == "Lamp"
    lists = [c["name"] for c in load(pack, "checklists.json")]
    assert "All lamps" in lists
    names = sorted(loc["name"] for loc in locations.values() if ".o0500_0000." in loc["id"])
    # The chest's first lot gives the lot after it too (a chain): the gem ranks before the vial.
    assert names == ["Blood gem or rune 3000 and 1 more", "Made-up Hat"]
    # The lot without a picked-up flag is left out.
    assert not any("Made-up Bell" in loc["name"] for loc in locations.values())


def test_layers_carry_the_passage_floors(made) -> None:
    _, pack, _ = made
    layers = [layer for layer in load(pack, "layers.json") if layer["mapId"].endswith("m24_00")]
    assert len(layers) == 2
    if all("heights" in layer for layer in layers):
        heights = sorted(layer["heights"] for layer in layers)
        assert heights[0][1] <= heights[1][1]


def test_cuts_can_be_asked_for(bloodborne_folder: Path, tmp_path: Path) -> None:
    report, _ = make(bloodborne_folder, tmp_path / "out", tmp_path / "Maps", floor_method="cuts", make_3d=False)
    (ward,) = report["areas"]
    assert ward["floorPlan"]["method"] == "cuts"
    assert "navmeshForPassages" in ward["geometry"] and ward["geometry"]["navmeshForPassages"] is False


def test_other_versions_are_refused(bloodborne_folder: Path, tmp_path: Path) -> None:
    folder = tmp_path / "dump"
    shutil.copytree(bloodborne_folder, folder)
    (folder / "sce_sys" / "param.sfo").write_bytes(fixtures.param_sfo({"APP_VER": "01.08", "TITLE_ID": "CUSA99999"}))
    with pytest.raises(MakeError, match="version 1.08") as error:
        make(folder, tmp_path / "out", tmp_path / "Maps")
    assert error.value.code == "game-version"
    assert "dvdroot_ps4" in str(error.value)


def test_map_offset_moves_and_turns() -> None:
    import numpy as np

    triangles = np.array([[[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 2.0, 0.0]]], dtype=np.float32)
    offset = {"translate": [10.0, 1.0, -5.0], "rotateY": 90.0}
    moved = map_offset_transform(offset)(triangles)
    back = map_offset_transform(offset, inverse=True)(moved)
    assert np.allclose(back, triangles, atol=1e-5)
    assert np.allclose(moved[0, 2], [10.0, 3.0, -5.0], atol=1e-5)
