"""The game's own models and textures (models.py, dds.py, textured.py): the 3D look "Game models" and the textured
map styles, on the made-up models and textures of fixtures.make_dsr_textured only (no game data).

The tests that make maps need the scene builder (crates/atlas-scene), as test_scene.py: skipped without it, unless
ATLAS_SCENE_REQUIRED is set.
"""

from __future__ import annotations

import io
import json
import os
import struct
import typing as tp
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import fixtures
from atlas_gamefiles.dds import TextureError, decode, describe, size_of
from atlas_gamefiles.events import Events
from atlas_gamefiles.games import PROFILES, list_areas
from atlas_gamefiles.geometry import Feedback
from atlas_gamefiles.make import MapMaker
from atlas_gamefiles.models import load_mesh, piece_model, read_map_models
from atlas_gamefiles.scene import builder_name, check_pack
from atlas_gamefiles.worker import InlineRunner
from conftest import snapshot

PACK = "dark-souls-remastered"
REPO = Path(__file__).resolve().parents[3]
PIECES = {
    "m0000B0": [((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))],
    "m0001B0": [((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))],
    "m0002B0": [((30.0, 0.5, 30.0), (0.0, 90.0, 0.0), (2.0, 1.0, 2.0))],
    "m0003B0": [((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))],
}
SIZES = {"m15_made_ground": (64, 32), "m15_made_roof": (128, 64), "m15_made_crate": (16, 16), "m15_made_leaf": (16, 16)}


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


def make(folder: Path, out: Path, maps: Path, **options) -> tuple[dict, list[dict]]:
    stream = io.StringIO()
    report = MapMaker(folder, out, Events(stream), maps_folder=maps, runner=InlineRunner(), **options).run()
    return report, [json.loads(line) for line in stream.getvalue().splitlines()]


def area_of(report: dict, key: str) -> dict:
    return next(a for a in report["areas"] if a["key"] == key)


def glb_pictures(data: bytes) -> list[tuple[int, int]]:
    """The sizes of the pictures inside a glTF binary file."""
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + json_length])
    binary = data[28 + json_length :]
    sizes = []
    for image in document.get("images", []):
        view = document["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        with Image.open(io.BytesIO(binary[start : start + view["byteLength"]])) as picture:
            sizes.append(picture.size)
    return sizes


def preview_colour(out: Path, key: str, floor: int, frame: dict, x: float, z: float) -> tuple[int, int, int]:
    """The colour of the floor's preview at world (x, z)."""
    with Image.open(out / "previews" / f"{key}_f{floor}.png") as picture:
        factor = picture.width / frame["width"]
        px = (x - frame["xMin"]) * frame["pixelsPerMetre"] * factor
        py = (frame["zMax"] - z) * frame["pixelsPerMetre"] * factor
        return picture.convert("RGB").getpixel((int(px), int(py)))


def near(colour: tp.Sequence[int], expected: tp.Sequence[int], tolerance: int = 40) -> bool:
    return all(abs(int(a) - int(b)) <= tolerance for a, b in zip(colour, expected))



# --- Textures -----------------------------------------------------------------------------------------------------


def test_dds_reads_each_block_format_at_its_own_size() -> None:
    textures = fixtures.made_up_textures()
    expected = {
        "m15_made_ground": ("DXT1", fixtures.GROUND_COLOUR),
        "m15_made_roof": ("DX10 BC7_UNORM", fixtures.ROOF_COLOUR),
        "m15_made_crate": ("DX10 BC1_UNORM_SRGB", fixtures.CRATE_COLOUR),
        "m15_made_leaf": ("DXT5", fixtures.LEAF_COLOUR),
    }
    for name, (fmt, colour) in expected.items():
        data = textures[name]
        assert describe(data) == fmt
        picture = decode(data)
        assert picture.size == SIZES[name] == size_of(data)
        r, g, b, a = picture.getpixel((picture.width - 1, picture.height - 1))
        assert near((r, g, b), colour, 8) and a == 255, name
    leaf = decode(textures["m15_made_leaf"])
    assert leaf.getpixel((0, 0))[3] == 0 and leaf.getpixel((15, 0))[3] == 255
    # Plain blue, green, red, alpha pixels (DX10 B8G8R8A8_UNORM), read here.
    pixels = bytes([10, 20, 30, 40]) * 4
    picture = decode(fixtures.dds_dx10(2, 2, 87, pixels))
    assert picture.getpixel((1, 1)) == (30, 20, 10, 40)
    # What cannot be read is refused with a reason.
    with pytest.raises(TextureError):
        decode(b"not a texture at all, made up" * 10)
    with pytest.raises(TextureError):
        decode(fixtures.dds_dx10(4, 4, 81, b"\0" * 8))  # BC4_SNORM


def test_a_console_texture_is_given_a_header_first() -> None:
    # Bloodborne's PS4 textures hold no DDS header and swizzled blocks: Soulstruct makes the header and puts the
    # blocks in order. A picture of one colour reads the same in any order, so this tries the way, not the order.
    from soulstruct.containers.tpf import DXGI_FORMAT, TPFPlatform, TPFTexture

    from atlas_gamefiles.models import texture_picture

    blocks = fixtures.pillow_dds(Image.new("RGBA", (16, 16), fixtures.CRATE_COLOUR + (255,)), "DXT1")[128:]
    info = TPFTexture.ConsoleInfo(width=16, height=16, dxgi_format=DXGI_FORMAT.BC1_UNORM)
    texture = TPFTexture(stem="made_up", format=0, data=blocks, mipmap_count=1, console_info=info)
    picture, fmt = texture_picture(texture, TPFPlatform.PS4)
    assert picture.size == (16, 16) and fmt == "PS4 DXT1"
    assert near(picture.getpixel((7, 9))[:3], fixtures.CRATE_COLOUR, 8)
    with pytest.raises(TextureError):
        texture_picture(TPFTexture(stem="made_up", format=0, data=b"GNF " + bytes(60)), TPFPlatform.PS4)


# --- Reading an area's models ------------------------------------------------------------------------------------


def test_piece_model_names() -> None:
    models = ["m0000B0", "m0002B1", "m200000"]
    assert piece_model("m0000B0A15", "m15_01_00_00", models) == "m0000B0"
    assert piece_model("M0002B1A15", "m15_01_00_00", models) == "m0002B1"
    assert piece_model("m29_00_00_00_200000", "m29_00_00_00", models) == "m200000"
    assert piece_model("m9999B9A15", "m15_01_00_00", models) is None


def test_reads_the_models_placed_with_their_textures(dsr_textured_folder: Path, tmp_path: Path) -> None:
    profile = PROFILES[PACK]
    area = next(a for a in list_areas(profile, dsr_textured_folder) if a.id == fixtures.ANOR_LONDO)
    before = snapshot(dsr_textured_folder)
    result = read_map_models(profile, area, dsr_textured_folder, PIECES, Feedback(), tmp_path / "models")
    assert snapshot(dsr_textured_folder) == before
    # One model file is not a FLVER: counted and named, and the others read.
    assert result.status == "partial" and result.read == 3 and result.failed == 1
    assert "m0003B0A15" in result.errors[0]
    report = result.data
    assert report["models"]["parts"] == 3
    assert report["textures"]["read"] == 4 and report["textures"]["missing"] == ["m15_made_missing"]
    assert report["textures"]["searchedEveryArea"] is True  # the leaf's texture is in another area's binder
    assert set(report["textures"]["formats"]) == {"DXT1", "DX10 BC7_UNORM", "DX10 BC1_UNORM_SRGB", "DXT5"}

    mesh = load_mesh(tmp_path / "models")
    assert len(mesh) == 82
    by_texture = {t["name"]: t for t in mesh.textures}
    for name, size in SIZES.items():
        texture = by_texture[name]
        assert (texture["width"], texture["height"]) == size
        with Image.open(mesh.folder / texture["file"]) as picture:
            assert picture.size == size  # each at its own size
    material_of = {m["name"].split()[-1]: m for m in mesh.materials}
    assert material_of["m15_made_leaf"]["alpha"] == "mask" and material_of["m15_made_leaf"]["doubleSided"]
    assert by_texture["m15_made_leaf"]["alpha"] is True and by_texture["m15_made_ground"]["alpha"] is False
    assert material_of["m15_made_ground"]["chosenBy"] == "type"  # the diffuse, not the normal map
    missing = material_of["m15_made_missing"]
    assert not by_texture["m15_made_missing"].get("file") and missing["texture"] >= 0

    def triangles_of(name: str) -> np.ndarray:
        index = next(i for i, m in enumerate(mesh.materials) if m["name"].endswith(name))
        return mesh.triangles[mesh.material == index]

    # The roof stands on its bone, 9 m up; its top faces up and its underside down.
    roof = triangles_of("m15_made_roof")
    assert np.allclose(roof[:, :, 1], 9.0)
    ups = np.cross(roof[:, 1] - roof[:, 0], roof[:, 2] - roof[:, 0])[:, 1]
    assert (ups > 0).sum() == 2 and (ups < 0).sum() == 2
    # The crate's lid: moved, turned and scaled by its part (2 m square, scaled twice, at 30, 1.5, 30).
    lid = triangles_of("m15_made_crate")
    assert np.allclose(lid[:, :, 1], 1.5)
    assert np.allclose([lid[:, :, 0].min(), lid[:, :, 0].max(), lid[:, :, 2].min(), lid[:, :, 2].max()], [28, 32, 28, 32])
    assert (np.cross(lid[:, 1] - lid[:, 0], lid[:, 2] - lid[:, 0])[:, 1] > 0).all()
    # The ground faces up everywhere, its texture repeating every 4 m.
    ground = triangles_of("m15_made_ground")
    assert len(ground) == 72 and (np.cross(ground[:, 1] - ground[:, 0], ground[:, 2] - ground[:, 0])[:, 1] > 0).all()
    index = next(i for i, m in enumerate(mesh.materials) if m["name"].endswith("m15_made_ground"))
    uvs = mesh.uvs[mesh.material == index]
    assert np.allclose(uvs[..., 0], ground[..., 0] * 0.25, atol=1e-3)


def test_a_model_in_a_binder_is_found_by_its_map_piece(tmp_path: Path) -> None:
    # Bloodborne keeps each map piece model in a binder named after the map and the model's number.
    from soulstruct.containers import Binder, BinderEntry, BinderVersion
    from soulstruct.dcx import DCXType
    from soulstruct.flver import FLVER
    from soulstruct.flver.bone import FLVERBone
    from soulstruct.flver.version import FLVERVersion

    from atlas_gamefiles.games import Area
    from atlas_gamefiles.models import model_sources

    folder = tmp_path / "map" / "m29_00_00_00"
    folder.mkdir(parents=True)
    mesh = fixtures.flver_mesh(fixtures.quad(-1, 1, -1, 1, 0.0), 1.0, "m29_made_up", "P[ARSN]")
    data = FLVER(version=FLVERVersion.DarkSouls_A, bones=[FLVERBone(name="m000100")], meshes=[mesh]).to_bytes()
    binder = Binder(
        version=BinderVersion.V4,
        dcx_type=DCXType.DCX_DFLT_10000_44_9,
        entries=[BinderEntry(data=data, entry_id=200, path="N:\\SPRJ\\data\\Model\\map\\m29_00_00_00\\m000100.flver")],
    )
    binder.write(folder / "m29_00_00_00_000100.mapbnd.dcx")
    area = Area(id="m29_00_00_00", name="made up", msb=tmp_path / "none.msb", map_folder=folder)
    sources, unused = model_sources(area, ["m000100", "m000200"])
    assert list(sources) == ["m000100"] and unused == []
    name, load = sources["m000100"]
    assert name == "m29_00_00_00_000100.mapbnd.dcx" and len(load().meshes) == 1


# --- Making maps ----------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def made_textured(dsr_textured_folder: Path, builder: Path, tmp_path_factory: pytest.TempPathFactory):
    base = tmp_path_factory.mktemp("textured")
    before = snapshot(dsr_textured_folder)
    report, events = make(dsr_textured_folder, base / "out", base / "Maps", scene_builder=builder, style="textured")
    assert snapshot(dsr_textured_folder) == before  # nothing in the game folder changed
    return report, events, base / "Maps" / PACK, base / "out"


def test_a_textured_area_builds_its_3d_map_from_the_game_models(made_textured, builder: Path) -> None:
    report, events, pack, out = made_textured
    assert events[-1]["event"] == "done"
    anor = area_of(report, "m15_01")
    scene = anor["scene"]
    assert scene["made"] is True and scene["look"] == "models" and "lookNote" not in scene
    assert scene["trianglesBefore"] == 82
    assert scene["textures"]["kept"] == 4 and scene["textures"]["leftOut"] == 0
    assert anor["models"]["summary"] == "3 of 4 models, 82 triangles, 4 of 5 textures"
    assert report["options"]["threeD"]["look"] == "models"
    assert report["summary"]["threeD"]["looks"] == {"collision": 1, "models": 1}
    # Each texture is kept at its own size in the finest level.
    maps = {m["id"]: m for m in json.loads((pack / "maps.json").read_text(encoding="utf-8"))}
    cells = maps[f"{PACK}:map:m15_01"]["scene"]["cells"]
    finest = sorted(size for cell in cells for size in glb_pictures((pack / cell["lods"][0]["file"]).read_bytes()))
    assert finest == sorted(SIZES.values())
    assert report["pack"]["check3d"]["problems"] == []
    assert check_pack(builder, pack)["problems"] == []
    assert not (out / "scene-work").exists()


def test_an_area_whose_models_cannot_be_read_falls_back_to_collision(made_textured) -> None:
    report, _, _, _ = made_textured
    burg = area_of(report, "m10_01")
    assert burg["scene"]["made"] is True and burg["scene"]["look"] == "collision"
    assert "could not be read" in burg["scene"]["lookNote"] and "m0000B1A10" in burg["scene"]["lookNote"]
    assert burg["models"]["status"] == "failed"
    # And its floors are drawn height shaded, saying why.
    assert burg["mapStyle"] == "shaded" and burg["mapStyleAsked"] == "textured"
    assert "could not be read" in burg["mapStyleNote"]
    assert any("Undead Burg" in w and "collision" in w for w in report["warnings"])


def test_the_textured_style_draws_each_floor_from_the_game_models(made_textured) -> None:
    report, _, _, out = made_textured
    anor = area_of(report, "m15_01")
    assert anor["mapStyle"] == "textured" and "mapStyleNote" not in anor
    frame = anor["frame"]
    # The ground floor: the roof over the room is cut away, so the room's ground shows (orange); the crate's lid
    # (green) and the untextured mesh (grey) beside it.
    assert near(preview_colour(out, "m15_01", 0, frame, -15, 15), fixtures.GROUND_COLOUR)
    assert near(preview_colour(out, "m15_01", 0, frame, 45, -45), fixtures.GROUND_COLOUR)
    assert near(preview_colour(out, "m15_01", 0, frame, 30, 30), fixtures.CRATE_COLOUR)
    # The floor on top: the roof (blue), with the ground below faded.
    assert near(preview_colour(out, "m15_01", 1, frame, -15, 15), fixtures.ROOF_COLOUR)
    faded = preview_colour(out, "m15_01", 1, frame, 45, -45)
    assert not near(faded, fixtures.GROUND_COLOUR, 20) and faded[0] > faded[2]


def test_textured_with_outlines_and_without_3d(dsr_textured_folder: Path, builder: Path, tmp_path: Path) -> None:
    report, _ = make(
        dsr_textured_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], make_3d=False,
        scene_builder=builder, style="textured-outlines",
    )
    anor = report["areas"][0]
    assert anor["mapStyle"] == "textured-outlines" and "scene" not in anor
    frame = anor["frame"]
    assert near(preview_colour(tmp_path / "out", "m15_01", 0, frame, -15, 15), fixtures.GROUND_COLOUR)
    # The room's west wall (x -25) is a light line across the orange ground, as the outline styles draw walls.
    across = [preview_colour(tmp_path / "out", "m15_01", 0, frame, x, 0.0) for x in np.arange(-27.0, -23.0, 0.1)]
    assert any(c[2] > 100 and c[1] > 150 for c in across), across


def test_textured_styles_without_the_builder_are_height_shaded(
    dsr_textured_folder: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ATLAS_SCENE_BUILDER", raising=False)
    report, _ = make(
        dsr_textured_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], make_3d=False,
        scene_builder=tmp_path / "nothing", style="textured-outlines",
    )
    anor = report["areas"][0]
    assert anor["mapStyle"] == "outlines" and anor["mapStyleAsked"] == "textured-outlines"
    assert "builder" in anor["mapStyleNote"]


def test_the_collision_look_reads_no_models(dsr_textured_folder: Path, builder: Path, tmp_path: Path) -> None:
    report, _ = make(dsr_textured_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], scene_builder=builder, look_3d="collision")
    anor = report["areas"][0]
    assert anor["scene"]["look"] == "collision" and "lookNote" not in anor["scene"]
    assert "models" not in anor and anor["mapStyle"] == "shaded"
