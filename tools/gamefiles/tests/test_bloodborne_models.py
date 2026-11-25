"""Bloodborne's own models and PS4 textures (models.py, dds.py), and their 3D maps and textured map styles (make.py),
on the made-up dump of fixtures.make_bloodborne_textured only (no game data).

The tests that make maps need the scene builder (crates/atlas-scene), as test_scene.py: skipped without it, unless
ATLAS_SCENE_REQUIRED is set.
"""

from __future__ import annotations

import io
import json
import os
import struct
from collections import Counter
from pathlib import Path

import pytest
from PIL import Image

import fixtures
from atlas_gamefiles.dds import ps4_deswizzle
from atlas_gamefiles.events import Events
from atlas_gamefiles.games import PROFILES, list_areas
from atlas_gamefiles.geometry import Feedback
from atlas_gamefiles.make import MapMaker, too_few_textures
from atlas_gamefiles.models import load_mesh, read_map_models
from atlas_gamefiles.scene import builder_name
from atlas_gamefiles.worker import InlineRunner
from conftest import snapshot

PACK = "bloodborne"
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


@pytest.fixture(scope="module")
def textured_folder(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return fixtures.make_bloodborne_textured(tmp_path_factory.mktemp("games") / "CUSA99999")


def make(folder: Path, out: Path, maps: Path, **options) -> tuple[dict, list[dict]]:
    stream = io.StringIO()
    report = MapMaker(folder, out, Events(stream), maps_folder=maps, runner=InlineRunner(), **options).run()
    return report, [json.loads(line) for line in stream.getvalue().splitlines()]


def near(colour, expected, tolerance: int = 10) -> bool:
    return all(abs(int(a) - int(b)) <= tolerance for a, b in zip(colour, expected))


def pieces() -> dict[str, list]:
    out: dict[str, list] = {}
    for _, model, position, rotation, scale in fixtures.bloodborne_pieces():
        out.setdefault(model, []).append((position, rotation, scale))
    return out


def glb_pictures(data: bytes) -> list[bytes]:
    """The pictures inside a glTF binary file, as stored."""
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + json_length])
    binary = data[28 + json_length :]
    out = []
    for image in document.get("images", []):
        view = document["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        out.append(binary[start : start + view["byteLength"]])
    return out


# --- PS4 textures -------------------------------------------------------------------------------------------------


def test_ps4_textures_are_put_in_order_for_every_block_size() -> None:
    # Pictures of several colours, swizzled as the PS4 keeps them, come back in their places: BC1 (8-byte blocks),
    # BC3 (16-byte blocks, which Soulstruct 2.6's own way cuts in two), and plain RGBA pixels, at sizes that are not
    # whole tiles.
    picture = Image.new("RGBA", (48, 40), (200, 30, 30, 255))
    picture.paste(Image.new("RGBA", (24, 20), (30, 200, 30, 255)), (24, 0))
    picture.paste(Image.new("RGBA", (24, 20), (30, 30, 200, 255)), (0, 20))
    picture.paste(Image.new("RGBA", (12, 8), (250, 250, 250, 255)), (36, 32))
    for fmt, dxgi, size in (("DXT1", 71, 8), ("DXT5", 77, 16)):
        linear = fixtures.pillow_dds(picture, fmt)[128:]
        swizzled = fixtures.ps4_swizzle(linear, 48, 40, 4, size)
        assert len(swizzled) > len(linear)  # padded to whole tiles
        assert ps4_deswizzle(swizzled, 48, 40, dxgi) == linear[: 12 * 10 * size], fmt
    pixels = picture.tobytes()
    swizzled = fixtures.ps4_swizzle(pixels, 48, 40, 1, 4)
    assert ps4_deswizzle(swizzled, 48, 40, 28) == pixels


def test_a_ps4_tpf_reads_each_texture_in_its_colours() -> None:
    from soulstruct.containers.tpf import TPF

    from atlas_gamefiles.models import texture_picture

    textures = fixtures.made_up_ps4_textures()
    seen = {}
    for stem in ("m24_made_stone", "m24_made_roof", "m24_made_leaf"):
        tpf = TPF.from_bytes(fixtures.ps4_tpf(stem, *textures[stem]))
        picture, fmt = texture_picture(tpf.textures[0], tpf.platform)
        seen[stem] = (picture, fmt)
    stone, fmt = seen["m24_made_stone"]
    assert fmt == "PS4 DXT1" and stone.size == (64, 32)
    assert near(stone.getpixel((4, 4))[:3], fixtures.STONE_COLOURS[0])
    assert near(stone.getpixel((4, 28))[:3], fixtures.STONE_COLOURS[1])
    assert near(stone.getpixel((60, 4))[:3], fixtures.STONE_COLOURS[2])
    roof, fmt = seen["m24_made_roof"]
    assert fmt == "PS4 DX10 BC7_UNORM" and roof.size == (128, 64)
    for (x, y), colour in zip(((8, 8), (120, 8), (8, 56), (120, 56)), fixtures.ROOF_COLOURS):
        assert near(roof.getpixel((x, y))[:3], colour, 4), (x, y)
    leaf, fmt = seen["m24_made_leaf"]
    assert fmt == "PS4 DXT5" and leaf.size == (32, 32)
    assert leaf.getpixel((4, 16))[3] == 0
    assert near(leaf.getpixel((24, 4)), fixtures.LEAF_COLOURS[0] + (255,))
    assert near(leaf.getpixel((24, 28)), fixtures.LEAF_COLOURS[1] + (255,))


def test_reads_bloodborne_models_with_their_ps4_textures(textured_folder: Path, tmp_path: Path) -> None:
    profile = PROFILES[PACK]
    (area,) = [a for a in list_areas(profile, textured_folder / "dvdroot_ps4") if a.id == fixtures.CATHEDRAL_WARD]
    before = snapshot(textured_folder)
    result = read_map_models(profile, area, textured_folder / "dvdroot_ps4", pieces(), Feedback(), tmp_path / "models")
    assert snapshot(textured_folder) == before
    report = result.data
    assert report["models"]["read"] == 2 and report["models"]["parts"] == 1 + fixtures.HOUSES
    textures = report["textures"]
    # Three read; the sign's (a GNF file) found but not readable, counted once, by name, with the reason.
    assert textures["wanted"] == 4 and textures["read"] == 3
    assert textures["failedCount"] == 1 and textures["failedNames"] == ["m24_made_sign"]
    assert "GNF" in textures["failed"][0]
    assert textures["missingCount"] == 0 and textures["missing"] == []
    assert set(textures["formats"]) == {"PS4 DXT1", "PS4 DX10 BC7_UNORM", "PS4 DXT5"}
    assert textures["foundIn"] == {"m24/m24_0000.tpfbhd": 3}
    assert "1 textures could not be read" in result.note
    assert too_few_textures(textures) is None  # three of four is enough

    mesh = load_mesh(tmp_path / "models")
    by_name = {t["name"]: t for t in mesh.textures}
    with Image.open(mesh.folder / by_name["m24_made_roof"]["file"]) as roof:
        assert roof.size == (128, 64)
        assert near(roof.convert("RGB").getpixel((120, 56)), fixtures.ROOF_COLOURS[3], 4)
    with Image.open(mesh.folder / by_name["m24_made_leaf"]["file"]) as leaf:
        assert leaf.mode == "RGBA" and leaf.getpixel((4, 4))[3] == 0  # cut out: its alpha kept
    # Every house's triangles placed: a roof (2), a leaf (2) and a sign (2) each, and the ground's 128.
    assert len(mesh) == 128 + fixtures.HOUSES * 6


def test_textures_the_same_pixels_are_written_once(textured_folder: Path, tmp_path: Path, monkeypatch) -> None:
    # Two names, the same pixels: one PNG, both textures pointing at it.
    import atlas_gamefiles.models as models

    original = models.texture_picture

    def same_picture(texture, platform):
        picture, fmt = original(texture, platform)
        if texture.stem == "m24_made_roof":
            return Image.new("RGBA", picture.size, (1, 2, 3, 255)), fmt
        if texture.stem == "m24_made_stone":
            return Image.new("RGBA", (128, 64), (1, 2, 3, 255)), fmt
        return picture, fmt

    monkeypatch.setattr(models, "texture_picture", same_picture)
    profile = PROFILES[PACK]
    (area,) = [a for a in list_areas(profile, textured_folder / "dvdroot_ps4") if a.id == fixtures.CATHEDRAL_WARD]
    result = read_map_models(profile, area, textured_folder / "dvdroot_ps4", pieces(), Feedback(), tmp_path / "models")
    assert result.data["textures"]["sameAsAnother"] == 1
    mesh = load_mesh(tmp_path / "models")
    by_name = {t["name"]: t for t in mesh.textures}
    assert by_name["m24_made_roof"]["file"] == by_name["m24_made_stone"]["file"]
    assert len(list((tmp_path / "models").glob("t*.png"))) == 2


# --- Making maps --------------------------------------------------------------------------------------------------


def cut_config(tmp_path: Path, **models: object) -> Path:
    """Bloodborne's config with `scene.models` settings of the test's own."""
    from atlas_gamefiles.config import load_config

    config = load_config(PACK)
    config["scene"] = {**config.get("scene", {}), "models": models}
    path = tmp_path / "bloodborne.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


@pytest.fixture(scope="module")
def made_textured(textured_folder: Path, builder: Path, tmp_path_factory: pytest.TempPathFactory):
    base = tmp_path_factory.mktemp("bb-textured")
    before = snapshot(textured_folder)
    # Cut into many cells (a few triangles each, never kept whole), to show each picture is kept once all the same.
    config = cut_config(base, cellTriangles=24, oneCell=False)
    report, events = make(
        textured_folder, base / "out", base / "Maps", scene_builder=builder, style="textured", config_file=config
    )
    assert snapshot(textured_folder) == before
    return report, events, base / "Maps" / PACK


def test_bloodborne_3d_maps_and_textured_styles_use_the_game_models(made_textured) -> None:
    report, events, pack = made_textured
    assert events[-1]["event"] == "done"
    assert not any("only" in w and "models" in w for w in report["warnings"]), report["warnings"]
    (ward,) = report["areas"]
    assert ward["mapStyle"] == "textured" and "mapStyleNote" not in ward
    scene = ward["scene"]
    assert scene["made"] and scene["look"] == "models" and "lookNote" not in scene
    # The report gives the model's size and its textures: read, not readable, not found.
    textures = scene["textures"]
    assert (textures["wanted"], textures["read"], textures["failed"], textures["missing"]) == (4, 3, 1, 0)
    assert textures["eachOnce"] is True and textures["oneCell"] is False
    assert scene["bytes"] > 0 and scene["cells"] > 1
    assert "1 could not be read" in ward["models"]["summary"]


def test_each_texture_is_in_one_file_of_each_level(made_textured) -> None:
    report, _, pack = made_textured
    (ward,) = report["areas"]
    maps = json.loads((pack / "maps.json").read_text(encoding="utf-8"))
    (scene,) = [m["scene"] for m in maps if m.get("scene")]
    copies: Counter[bytes] = Counter()
    finest = 0
    for cell in scene["cells"]:
        for lod in cell["lods"]:
            pictures = glb_pictures((pack / lod["file"]).read_bytes())
            if lod["level"] == 0:
                copies.update(pictures)
                finest += sum(len(p) for p in pictures)
    # Three textures read, each once at the finest level, with its own bytes: the size follows the textures, not
    # the cells that show them.
    assert len(copies) == 3 and set(copies.values()) == {1}
    assert len(scene["cells"]) > 3
    assert ward["scene"]["textures"]["kept"] >= 3
    for picture in copies:
        with Image.open(io.BytesIO(picture)) as image:
            assert image.size in {(64, 32), (128, 64), (32, 32)}  # each at its own size
    assert finest == ward["scene"]["levels"][0]["textureBytes"]


def test_unreadable_textures_fall_back_to_collision_with_the_reason(textured_folder: Path, builder: Path, tmp_path: Path, monkeypatch) -> None:
    import atlas_gamefiles.models as models
    from atlas_gamefiles.dds import TextureError

    def unreadable(texture, platform):
        raise TextureError("made-up failure")

    monkeypatch.setattr(models, "texture_picture", unreadable)
    report, events = make(textured_folder, tmp_path / "out", tmp_path / "Maps", scene_builder=builder, style="textured-outlines")
    assert events[-1]["event"] == "done"
    (ward,) = report["areas"]
    reason = "only 0 of the 4 textures they show could be read (4 could not be read, the first: "
    assert reason in ward["models"]["reason"] and "made-up failure" in ward["models"]["reason"]
    assert ward["scene"]["made"] and ward["scene"]["look"] == "collision"
    assert reason in ward["scene"]["lookNote"]
    assert ward["mapStyle"] == "outlines" and reason in ward["mapStyleNote"]
    assert any("the 3D map shows the collision" in w and reason in w for w in report["warnings"])


def test_an_area_over_the_size_budget_falls_back_to_collision(textured_folder: Path, builder: Path, tmp_path: Path) -> None:
    config = cut_config(tmp_path, maxMegabytes=0.001)
    report, _ = make(textured_folder, tmp_path / "out", tmp_path / "Maps", scene_builder=builder, config_file=config)
    (ward,) = report["areas"]
    scene = ward["scene"]
    assert scene["made"] and scene["look"] == "collision"
    assert "more than the 0 MB an area may take" in scene["lookNote"]
    assert scene["modelTextures"]["read"] == 3
