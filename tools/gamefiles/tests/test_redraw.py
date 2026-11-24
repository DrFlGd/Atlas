"""Draw all areas again (redraw.py) and the "Colour by floor" style, on made-up data only: a pack that Make map
made from the made-up game folder, with its 3D models from the scene builder (crates/atlas-scene).

Like test_scene.py, the tests that need the builder are skipped without it, unless ATLAS_SCENE_REQUIRED is set."""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from atlas_gamefiles.check import CancelToken
from atlas_gamefiles.events import Events
from atlas_gamefiles.geometry import Cancelled
from atlas_gamefiles.make import MapMaker
from atlas_gamefiles.redraw import MapFrame, RedrawError, Redrawer, tile_folder
from atlas_gamefiles.render import FLOOR_PALETTE, draw_floor, floor_triangle_colours, map_style
from atlas_gamefiles.scene import check_pack
from atlas_gamefiles.worker import InlineRunner
from conftest import snapshot
from test_scene import builder  # noqa: F401  (the fixture)

PACK = "dark-souls-remastered"
ANOR = f"{PACK}:map:m15_01"


@pytest.fixture(scope="module")
def made_pack(dsr_map_folder: Path, builder: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:  # noqa: F811
    """A pack Make map made, with 3D models: kept as it is, each test redraws a copy."""
    base = tmp_path_factory.mktemp("redraw-made")
    MapMaker(dsr_map_folder, base / "out", Events(io.StringIO()), maps_folder=base / "Maps", runner=InlineRunner(), scene_builder=builder).run()
    return base / "Maps" / PACK


def copy_of(pack: Path, tmp_path: Path) -> Path:
    maps = tmp_path / "Maps"
    maps.mkdir()
    shutil.copytree(pack, maps / PACK)
    return maps / PACK


def redraw(pack: Path, out: Path, builder: Path, **options) -> tuple[dict, list[dict]]:  # noqa: F811
    stream = io.StringIO()
    report = Redrawer(pack, out, Events(stream), scene_builder=builder, **options).run()
    return report, [json.loads(line) for line in stream.getvalue().splitlines()]


def load(pack: Path, name: str):
    return json.loads((pack / name).read_text(encoding="utf-8"))


def tiles_of(files: dict[str, str], key: str) -> dict[str, str]:
    return {path: digest for path, digest in files.items() if path.startswith(f"tiles/{key}/")}


def test_draws_every_area_again_from_the_pack_alone(made_pack: Path, builder: Path, tmp_path: Path) -> None:  # noqa: F811
    pack = copy_of(made_pack, tmp_path)
    before = snapshot(pack)
    layers_before = load(pack, "layers.json")
    report, events = redraw(pack, tmp_path / "out", builder, style="floors")
    assert events[0]["event"] == "start" and events[-1]["event"] == "done"
    lines = {e["id"]: e for e in events if e["event"] == "map"}
    # The areas with a 3D model are drawn again, Anor Londo in its two floors from the pack; the one without is
    # left, with why.
    assert lines[ANOR]["redrawn"] is True and lines[ANOR]["floors"] == 2 and lines[ANOR]["floorsFrom"] == "pack"
    assert lines[f"{PACK}:map:m10_01"]["redrawn"] is True
    firelink = lines[f"{PACK}:map:m10_02"]
    assert firelink["redrawn"] is False and "no 3D model" in firelink["reason"]
    after = snapshot(pack)
    # Their pictures changed, at the same paths; every other file but the JSON is as it was.
    for key in ("m15_01", "m10_01"):
        assert set(tiles_of(after, key)) == set(tiles_of(before, key))
        assert tiles_of(after, key) != tiles_of(before, key)
    untouched = {p: d for p, d in before.items() if not p.startswith(("tiles/m15_01/", "tiles/m10_01/")) and not p.endswith(".json")}
    assert any(p.startswith("tiles/m10_02/") for p in untouched)
    assert {p: d for p, d in after.items() if p in untouched} == untouched
    # The pack stays valid: the same layers (heights and all), and the 3D check passes.
    assert load(pack, "layers.json") == layers_before
    assert report["check3d"]["problems"] == [] and check_pack(builder, pack)["problems"] == []
    assert load(pack, "manifest.json")["updated"] >= load(made_pack, "manifest.json")["updated"]
    assert report["summary"] == {"maps": 3, "redrawn": 2, "skipped": 1, "tiles": report["summary"]["tiles"]}
    assert report["summary"]["tiles"] > 0
    assert json.loads((tmp_path / "out" / "report.json").read_text(encoding="utf-8"))["kind"] == "redraw"
    # Nothing left beside the pack or in the output folder but the report.
    assert sorted(p.name for p in pack.parent.iterdir()) == [PACK]
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["report.json"]


def test_colour_by_floor_gives_each_floor_its_colour(made_pack: Path, builder: Path, tmp_path: Path) -> None:  # noqa: F811
    from PIL import Image

    pack = copy_of(made_pack, tmp_path)
    redraw(pack, tmp_path / "out", builder, style="floors")
    layers = {layer["heights"][0]: layer for layer in load(pack, "layers.json") if layer["mapId"] == ANOR}
    lower, upper = (layers[h] for h in sorted(layers))

    def top_picture(layer: dict) -> np.ndarray:
        folder = pack / layer["tiles"]["url"].split("{z}")[0] / str(layer["maxZoom"])
        tiles = sorted(folder.rglob("*.*"))
        return np.concatenate([np.asarray(Image.open(t).convert("RGB")).reshape(-1, 3) for t in tiles])

    def share_near(pixels: np.ndarray, colour: tuple[int, int, int]) -> float:
        rgb = np.array(colour, dtype=np.float64)
        # Its own colour, darker or lighter by height: along the line from black to it.
        scale = (pixels @ rgb) / (rgb @ rgb)
        return float((np.abs(pixels - scale[:, None] * rgb).max(axis=1) < 12).mean())

    low_pixels, high_pixels = top_picture(lower), top_picture(upper)
    assert share_near(low_pixels, FLOOR_PALETTE[0]) > 0.05
    assert share_near(high_pixels, FLOOR_PALETTE[1]) > 0.02
    assert share_near(low_pixels, FLOOR_PALETTE[1]) < 0.001


def test_new_floor_cuts_change_the_layers_of_a_pack_the_map_maker_made(made_pack: Path, builder: Path, tmp_path: Path) -> None:  # noqa: F811
    pack = copy_of(made_pack, tmp_path)
    own = tmp_path / "floor-overrides.json"
    own.write_text(json.dumps({PACK: {"m15_01": {"cuts": [], "names": ["Everything"]}}}), encoding="utf-8")
    report, _ = redraw(pack, tmp_path / "out", builder, floor_overrides_file=own)
    anor = next(m for m in report["maps"] if m["id"] == ANOR)
    assert anor["redrawn"] is True and anor["floorsFrom"] == "yours" and anor["floors"] == 1
    assert anor["layersChanged"] == {"before": 2, "after": 1}
    layers = [layer for layer in load(pack, "layers.json") if layer["mapId"] == ANOR]
    assert [(layer["id"], layer["name"]) for layer in layers] == [(f"{PACK}:layer:m15_01-f0", "Everything")]
    assert "heights" not in layers[0]
    # Every location of the area is on that floor; the second floor's pictures are gone.
    assert {loc["layerId"] for loc in load(pack, "locations.json") if loc["mapId"] == ANOR} == {layers[0]["id"]}
    assert not (pack / "tiles" / "m15_01" / "f1").exists()
    entry = next(m for m in load(pack, "manifest.json")["contents"]["maps"] if m["id"] == ANOR)
    assert [layer["id"] for layer in entry["layers"]] == [layers[0]["id"]]
    assert load(pack, "manifest.json")["contents"]["counts"]["layers"] == len(load(pack, "layers.json"))
    assert check_pack(builder, pack)["problems"] == []

    # Two floors again, cut higher: the layers come back with their heights, and locations go by theirs.
    own.write_text(json.dumps({PACK: {"m15_01": {"cuts": [3.5]}}}), encoding="utf-8")
    report, _ = redraw(pack, tmp_path / "out2", builder, floor_overrides_file=own)
    layers = {layer["id"]: layer for layer in load(pack, "layers.json") if layer["mapId"] == ANOR}
    assert sorted(layers) == [f"{PACK}:layer:m15_01-f0", f"{PACK}:layer:m15_01-f1"]
    assert layers[f"{PACK}:layer:m15_01-f0"]["heights"][1] == pytest.approx(3.5)
    locations = {loc["id"]: loc for loc in load(pack, "locations.json") if loc["mapId"] == ANOR}
    assert {loc["layerId"] for loc in locations.values()} == set(layers)
    assert locations[f"{PACK}:loc:m15_01.bonfire.1511961"]["layerId"] == f"{PACK}:layer:m15_01-f1"  # on the roof
    assert all(loc["layerId"].endswith("-f0") for loc in locations.values() if loc["height"] < 3.0)
    assert check_pack(builder, pack)["problems"] == []


def test_a_pack_from_elsewhere_keeps_its_layers(made_pack: Path, builder: Path, tmp_path: Path) -> None:  # noqa: F811
    pack = copy_of(made_pack, tmp_path)
    manifest = load(pack, "manifest.json")
    manifest["writtenBy"] = {"name": "Another app", "version": "1.0"}
    (pack / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    own = tmp_path / "floor-overrides.json"
    own.write_text(json.dumps({PACK: {"m15_01": {"cuts": []}}}), encoding="utf-8")
    before = snapshot(pack)
    report, events = redraw(pack, tmp_path / "out", builder, floor_overrides_file=own, only_maps=[ANOR])
    anor = next(m for m in report["maps"] if m["id"] == ANOR)
    assert anor["redrawn"] is False and "only a pack the Map Maker made" in anor["reason"]
    assert snapshot(pack) == before and events[-1]["event"] == "done"
    # Without cuts of its own it is drawn again in its own floors.
    report, _ = redraw(pack, tmp_path / "out2", builder)
    assert next(m for m in report["maps"] if m["id"] == ANOR)["redrawn"] is True
    assert load(pack, "manifest.json")["writtenBy"] == {"name": "Another app", "version": "1.0"}


def test_cancel_and_failures_leave_the_pack_as_it_was(
    made_pack: Path, builder: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: F811
) -> None:
    pack = copy_of(made_pack, tmp_path)
    before = snapshot(pack)
    token = CancelToken()

    class CancelWhileDrawing(Events):
        def progress(self, fraction: float, message: str, **extra) -> None:
            super().progress(fraction, message, **extra)
            if "drawing" in message:
                token.cancel()

    with pytest.raises(Cancelled):
        Redrawer(pack, tmp_path / "out", CancelWhileDrawing(io.StringIO()), token=token, scene_builder=builder).run()
    assert snapshot(pack) == before
    assert sorted(p.name for p in pack.parent.iterdir()) == [PACK]
    with pytest.raises(RedrawError, match="no map style"):
        Redrawer(pack, tmp_path / "out", Events(io.StringIO()), style="watercolour", scene_builder=builder)
    with pytest.raises(RedrawError, match="could not be read"):
        Redrawer(tmp_path / "nothing", tmp_path / "out", Events(io.StringIO()), scene_builder=builder).run()
    monkeypatch.delenv("ATLAS_SCENE_BUILDER", raising=False)
    with pytest.raises(RedrawError, match="3D builder"):
        Redrawer(pack, tmp_path / "out", Events(io.StringIO()), scene_builder=tmp_path / "no-builder").run()
    # Model files that are not ones: those maps are left, with why.
    for path in (pack / "scene").rglob("*.glb"):
        path.write_bytes(b"not a model")
    before = snapshot(pack)
    report, _ = redraw(pack, tmp_path / "out", builder)
    anor = next(m for m in report["maps"] if m["id"] == ANOR)
    assert anor["redrawn"] is False and "could not be read" in anor["reason"]
    assert snapshot(pack) == before


def test_tile_folders_and_frames() -> None:
    assert tile_folder("tiles/m10_01/f0/{z}/{x}/{y}.webp") == ("tiles/m10_01/f0/", "webp")
    assert tile_folder("tiles/a/{z}/{x}/{y}.png") == ("tiles/a/", "png")
    for url in ("../x/{z}/{x}/{y}.png", "/abs/{z}/{x}/{y}.png", "tiles/{z}_{x}_{y}.png", "{z}/{x}/{y}.png", "t/../{z}/{x}/{y}.png", "t/{z}/{x}/{y}.jpg", None):
        assert tile_folder(url) is None, url
    # Pixel to world and back, with a turn in it.
    frame = MapFrame(0.5, 0.25, -0.25, 0.5, 10.0, 20.0, width=100, height=80)
    px = frame.to_pixels(np.array([frame.to_world(12.0, 34.0)]))
    assert px[0] == pytest.approx([12.0, 34.0])
    assert frame.scale == pytest.approx(1 / np.sqrt(0.3125))


def test_colour_by_floor_is_a_style() -> None:
    from atlas_gamefiles.render import Frame

    style = map_style("floors")
    assert style.label == "Colour by floor" and style.by_floor and not style.outlines
    square = np.array([[[0, 0, 0], [10, 0, 10], [10, 0, 0]], [[0, 0, 0], [0, 0, 10], [10, 0, 10]]], dtype=np.float32)
    low = floor_triangle_colours(square, 0, 0.0, 10.0, flipped=True)
    high = floor_triangle_colours(square + np.array([0, 10, 0], dtype=np.float32), 0, 0.0, 10.0, flipped=True)
    other = floor_triangle_colours(square, 1, 0.0, 10.0, flipped=True)
    assert (high.astype(int).sum(axis=1) > low.astype(int).sum(axis=1)).all(), "lighter higher within the floor"
    assert not np.array_equal(low, other), "each floor its own colour"
    frame = Frame(-2.0, 12.0, 4.0, 56, 56)
    drawn = np.asarray(
        draw_floor(frame, style, square, np.zeros((0, 2, 2)), index=2, floor_range=(0.0, 0.0), area_range=(0.0, 1.0), flipped=True)
    )
    middle = drawn[28, 28, :3].astype(float)
    colour = np.array(FLOOR_PALETTE[2], dtype=float)
    assert np.abs(middle / middle.max() - colour / colour.max()).max() < 0.08


def test_textured_styles_draw_with_the_builder(made_pack: Path, builder: Path, tmp_path: Path) -> None:  # noqa: F811
    # The pack's own model, read back out by the builder, is drawn in its own colours by `atlas-scene draw`, as a
    # map made from a model is; the pack stays valid.
    pack = copy_of(made_pack, tmp_path)
    before = snapshot(pack)
    report, events = redraw(pack, tmp_path / "out", builder, style="textured-outlines", only_maps=[ANOR])
    line = next(e for e in events if e["event"] == "map" and e["id"] == ANOR)
    assert line["redrawn"] is True and line["floors"] == 2
    assert report["options"]["mapStyle"] == "textured-outlines"
    drawn = next(m for m in report["maps"] if m["id"] == ANOR)
    assert drawn["mapStyle"] == "textured-outlines", report["warnings"]
    assert tiles_of(snapshot(pack), "m15_01") != tiles_of(before, "m15_01")
    assert check_pack(builder, pack)["problems"] == []
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["report.json"]
    # A map turned against the world is not drawn by the builder: no box for it.
    assert MapFrame(0.5, 0.25, -0.25, 0.5, 10.0, 20.0, width=100, height=80).box() is None
    assert MapFrame(0.5, 0.0, 0.0, -0.5, 10.0, 20.0, width=100, height=80).box() == {"xMin": 10.0, "zMax": 20.0, "scale": 2.0}



def test_a_map_made_from_a_model_is_drawn_again_with_its_cuts(builder: Path, tmp_path: Path) -> None:  # noqa: F811
    # The made-up house (tests/model_fixtures.py), made into a pack from its OBJ file, then drawn again in its own
    # textures from the pack alone with the player's cut for it (under its pack id, area `model`): its three floors
    # become two, layers and all, and the pack stays valid.
    import model_fixtures
    from atlas_gamefiles.model import ModelMapMaker

    model = model_fixtures.write_obj(tmp_path / "model")
    maps = tmp_path / "Maps"
    ModelMapMaker(model, tmp_path / "made", Events(io.StringIO()), maps_folder=maps, scene_builder=builder, name="House").run()
    pack = maps / "house"
    assert len(load(pack, "layers.json")) == 3
    own = tmp_path / "floor-overrides.json"
    own.write_text(json.dumps({"house": {"model": {"cuts": [2.0]}}}), encoding="utf-8")
    report, events = redraw(pack, tmp_path / "out", builder, style="textured", floor_overrides_file=own)
    line = next(e for e in events if e["event"] == "map")
    assert line["redrawn"] is True and line["floors"] == 2 and line["floorsFrom"] == "yours"
    assert report["maps"][0]["mapStyle"] == "textured", report["warnings"]
    layers = load(pack, "layers.json")
    assert [layer["id"] for layer in layers] == ["house:layer:model-f0", "house:layer:model-f1"]
    assert [layer["heights"][1] for layer in layers][0] == pytest.approx(2.0)
    assert not (pack / "tiles" / "model" / "f2").exists()
    assert check_pack(builder, pack)["problems"] == []
