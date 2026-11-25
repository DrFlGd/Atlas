"""Remove pieces (pieces.py): finding pieces of an area, writing them down in the floor cuts file, finding them again
from the game files and from a pack's own 3D model, and leaving them out of the floors, the floor pictures and the
3D model; putting them back. Made-up geometry and a made-up game folder only (tests/fixtures.py): in the made-up Anor
Londo, the collision part h0001B0 is a small platform 12 m up, apart from everything, like a stray panel."""

from __future__ import annotations

import base64
import io
import json
import struct
from pathlib import Path

import numpy as np
import pytest

import fixtures
from atlas_gamefiles.config import chosen_floor_overrides, clean_floor_entry, load_floor_overrides
from atlas_gamefiles.events import Events
from atlas_gamefiles.floors import plan_floors
from atlas_gamefiles.floorviews import AreaViews, data_file, save_floor_data, serve
from atlas_gamefiles.make import MapMaker
from atlas_gamefiles.pieces import (
    MODEL_SLACK,
    Places,
    clean_piece,
    clean_pieces,
    components,
    find_removed,
    leave_out,
    leave_out_of_glb,
    piece_table,
)
from atlas_gamefiles.redraw import Redrawer, map_frame, unpack_model
from atlas_gamefiles.worker import InlineRunner
from test_redraw import made_pack  # noqa: F401  (the fixture)
from test_scene import builder  # noqa: F401  (the fixture)

PACK = "dark-souls-remastered"
ANOR = f"{PACK}:map:m15_01"
PLATFORM = (45.0, 12.0, 45.0)  # the middle of the made-up platform (part h0001B0)


def triangles(items: list) -> np.ndarray:
    return np.array(items, dtype=np.float32).reshape(-1, 3, 3)


def ground_and_panels() -> tuple[np.ndarray, np.ndarray, list[str]]:
    """A ground of 20 m tiles (part "ground"), with a stray panel 15 m up in the same part, and another stray panel
    20 m up that is a part of its own ("panel")."""
    ground = []
    for x in range(-40, 40, 20):
        for z in range(-40, 40, 20):
            ground += fixtures.quad(x, x + 20, z, z + 20, 0.0)
    stray = fixtures.quad(10, 14, 10, 12, 15.0)
    panel = fixtures.quad(-30, -20, -30, -26, 20.0)
    mesh = triangles(ground + stray + panel)
    owners = np.array([0] * (len(ground) + len(stray)) + [1] * len(panel), dtype=np.int32)
    return mesh, owners, ["ground", "panel"]


# ---------------------------------------------------------------------------------------------------------------
# Pieces and finding them again.


def test_pieces_are_connected_surfaces_within_a_part() -> None:
    mesh, owners, names = ground_and_panels()
    table = piece_table(mesh, owners, names)
    assert len(table.piece_part) == 3
    ground, stray, panel = (int(table.triangle_piece[i]) for i in (0, len(mesh) - 3, len(mesh) - 1))
    assert len({ground, stray, panel}) == 3
    assert table.record(stray) == {"part": "ground", "box": [10.0, 15.0, 10.0, 14.0, 15.0, 12.0], "triangles": 2, "area": 8.0}
    assert table.record(panel)["part"] == "panel" and table.record(ground)["triangles"] == 32
    # The same triangles in another order give the same pieces (their numbers follow the first triangle).
    again = piece_table(mesh[::-1], owners[::-1], names)
    assert sorted(again.record(p)["box"] for p in range(3)) == sorted(table.record(p)["box"] for p in range(3))
    # Two parts touching at a corner stay apart; one part's triangles that only touch join.
    touching = triangles(fixtures.quad(0, 1, 0, 1, 0.0) + fixtures.quad(1, 2, 1, 2, 0.0))
    assert len(set(components(touching).tolist())) == 1
    assert len(set(components(touching, np.array([0, 0, 1, 1])).tolist())) == 2


def test_removed_pieces_are_found_by_their_part_and_by_their_place() -> None:
    mesh, owners, names = ground_and_panels()
    table = piece_table(mesh, owners, names)
    stray = table.record(int(table.triangle_piece[len(mesh) - 3]))
    found = find_removed(mesh, owners, names, [stray])
    assert found.removed.sum() == 2 and found.removed[-4:-2].all() and found.how == ["part"]
    # Without the parts (a pack's own model), by its place: the same triangles.
    by_place = find_removed(mesh, None, None, [stray])
    assert (by_place.removed == found.removed).all() and by_place.how == ["place"]
    # A whole part; a part of another name is found by place; bounds that hold no piece find nothing.
    whole = find_removed(mesh, owners, names, [{"part": "panel", "whole": True, "box": [0, 0, 0, 0, 0, 0]}])
    assert whole.removed[-2:].all() and whole.removed.sum() == 2
    renamed = find_removed(mesh, owners, ["ground", "other"], [{**table.record(int(table.triangle_piece[-1]))}])
    assert renamed.how == ["place"] and renamed.removed[-2:].all() and renamed.removed.sum() == 2
    nothing = find_removed(mesh, owners, names, [{"part": "ground", "box": [100, 0, 100, 101, 0, 101], "area": 1.0}])
    assert not nothing.removed.any() and nothing.how == [None] and nothing.report([{"part": "ground", "box": [100, 0, 100, 101, 0, 101]}])["found"] == 0
    # By place, never a piece that reaches outside the bounds: bounds over a corner of the ground find nothing.
    corner = {"part": "x", "box": [-41.0, -1.0, -41.0, -30.0, 1.0, -30.0], "area": 100.0}
    assert not find_removed(mesh, None, None, [corner]).removed.any()
    # Nor more than the piece was: bounds round both panels, for one panel's area, find only a piece with its bounds.
    both = {"part": "x", "box": [-31.0, 14.0, -31.0, 15.0, 21.0, 13.0], "area": 8.0}
    assert not find_removed(mesh, None, None, [both]).removed.any()


def test_leaving_out_the_stray_panel_changes_the_floors() -> None:
    mesh, owners, names = ground_and_panels()
    plan = plan_floors(mesh)
    table = piece_table(mesh, owners, names)
    records = [table.record(int(table.triangle_piece[i])) for i in (len(mesh) - 3, len(mesh) - 1)]
    kept, kept_owners, report = leave_out(mesh, owners, names, records)
    assert len(kept) == len(mesh) - 4 and len(kept_owners) == len(kept)
    assert report is not None and report["asked"] == 2 and report["found"] == 2 and report["triangles"] == 4
    assert [p["by"] for p in report["pieces"]] == ["part", "part"]
    without = plan_floors(kept)
    assert without.report["profile"]["high"] < plan.report["profile"]["high"]
    assert max(f.high for f in without.floors) == pytest.approx(0.0)
    assert leave_out(mesh, owners, names, []) == (mesh, owners, None)


def test_the_game_models_lose_what_lies_where_a_removed_piece_was() -> None:
    from atlas_gamefiles.models import TexturedMesh
    from atlas_gamefiles.pieces import leave_out_of_models

    # A model of the stray panel, a little thick (a box round it), and the ground's model.
    panel = fixtures.quad(10, 14, 10, 12, 15.1) + fixtures.quad(10, 14, 10, 12, 14.9)
    ground = fixtures.quad(-40, 40, -40, 40, 0.0)
    tris = triangles(panel + ground)
    n = len(tris)
    models = TexturedMesh(tris, np.zeros((n, 3, 2), np.float32), np.zeros(n, np.int32), np.zeros(n, np.int32), ["m"], [], [], Path("."))
    record = {"part": "ground", "box": [10.0, 15.0, 10.0, 14.0, 15.0, 12.0], "triangles": 2, "area": 8.0}
    kept, count = leave_out_of_models(models, [record])
    assert count == 4 and len(kept) == 2 and len(kept.uvs) == 2 and len(kept.owners) == 2
    assert Places(tris).find(record, MODEL_SLACK).sum() == 4
    assert leave_out_of_models(models, []) == (models, 0)


# ---------------------------------------------------------------------------------------------------------------
# The floor cuts file.


def test_removed_pieces_in_the_floor_cuts_file_and_old_files_still_load(tmp_path: Path) -> None:
    piece = {"part": "h000100", "box": [1.234, 2, 3, 4, 5, 6.789], "triangles": 2, "area": 3.456}
    assert clean_piece(piece) == {"part": "h000100", "box": [1.23, 2.0, 3.0, 4.0, 5.0, 6.79], "triangles": 2, "area": 3.46}
    assert clean_piece({**piece, "whole": True})["whole"] is True
    for bad in ({**piece, "box": [1, 2, 3]}, {**piece, "box": [5, 0, 0, 1, 1, 1]}, {**piece, "part": 3}, {**piece, "box": [1, 2, 3, 4, 5, "x"]}, [1]):
        assert clean_piece(bad) is None
    assert len(clean_pieces([piece, piece, {"part": "x"}])) == 1
    assert clean_floor_entry({"cuts": [4], "removed": [piece, "x"]}) == {"cuts": [4.0], "removed": [clean_piece(piece)]}
    assert clean_floor_entry({"removed": [{"part": "x"}]}) is None

    path = tmp_path / "floor-overrides.json"
    # Version 1 (no version) and 2 files load as before; version 3 adds removed pieces.
    for version in (None, 2):
        data = {PACK: {"m15_01": {"cuts": [5]}}}
        if version:
            data["version"] = version
        path.write_text(json.dumps(data), encoding="utf-8")
        assert load_floor_overrides(path, PACK) == {"m15_01": {"cuts": [5.0]}}
    path.write_text(json.dumps({"version": 3, PACK: {"m15_01": {"cuts": [5], "removed": [piece]}}}), encoding="utf-8")
    assert load_floor_overrides(path, PACK)["m15_01"]["removed"] == [clean_piece(piece)]

    # An entry that only removes pieces (after Back to automatic) keeps the shipped floors.
    config = {"floorOverrides": {"m15_01": {"names": ["Ground", "Rooftops"]}}}
    own = {"m15_01": {"removed": [clean_piece(piece)]}}
    assert chosen_floor_overrides(config, own, "m15_01_00_00") == ({"names": ["Ground", "Rooftops"], "removed": [clean_piece(piece)]}, "yours")
    own = {"m15_01": {"cuts": [], "removed": [clean_piece(piece)]}}
    assert chosen_floor_overrides(config, own, "m15_01_00_00")[0] == {"cuts": [], "removed": [clean_piece(piece)]}


# ---------------------------------------------------------------------------------------------------------------
# The Adjust floors views.


def test_views_leave_out_removed_pieces_and_put_them_back(tmp_path: Path) -> None:
    mesh, owners, names = ground_and_panels()
    plan = plan_floors(mesh)
    save_floor_data(tmp_path, "m99_04", "Made-up Field", mesh, plan, [], None, (0.0, 20.0), {}, 0.4, owners=owners, owner_names=names)
    views = AreaViews(data_file(tmp_path, "m99_04"))
    ready = views.ready()
    pieces = ready["pieces"]
    piece_of = np.frombuffer(base64.b64decode(pieces["triangle"]), dtype="<u4")
    boxes = np.frombuffer(base64.b64decode(pieces["box"]), dtype="<f4").reshape(-1, 6)
    part = np.frombuffer(base64.b64decode(pieces["part"]), dtype="<u4")
    assert len(piece_of) == len(mesh) and pieces["parts"] == names and len(boxes) == len(part) == 3
    assert pieces["parts"][part[piece_of[-1]]] == "panel"
    stray = views.table.record(int(piece_of[-1]))  # the highest panel
    request = [
        {"id": 1, "cuts": []},
        {"id": 2, "cuts": [], "removed": [stray, {"part": "nowhere", "box": [900, 0, 900, 901, 0, 901]}]},
        {"id": 3, "cuts": [], "method": "passages", "removed": [stray]},
        {"id": 4, "cuts": []},
    ]
    stream = io.StringIO()
    assert serve(tmp_path, "m99_04", Events(stream), lines=[json.dumps(r) for r in request]) == 0
    _, plain, removed, passages, back = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert plain["removed"] == [] and "section" not in plain
    assert removed["removed"] == [2, 0]
    # Without the highest panel the walkable heights end lower, and the section and heights come with the views.
    assert removed["profile"]["high"] < plain["profile"]["high"]
    assert removed["heights"]["high"] < ready["heights"]["high"] and set(removed["section"]) == {"x", "z"}
    # The 3D view keeps every triangle: the removed ones have no floor.
    floors = np.frombuffer(base64.b64decode(passages["triangleFloors"]), dtype=np.uint8)
    assert len(floors) == len(mesh) and (floors[-2:] == 255).all()
    # Put back: as at first.
    assert back["profile"] == plain["profile"] and "section" not in back


def test_a_map_made_from_a_3d_model_has_no_pieces(tmp_path: Path) -> None:
    mesh, _, _ = ground_and_panels()
    save_floor_data(tmp_path, "model", "Made-up Model", mesh, plan_floors(mesh), [], None, (0.0, 20.0), {}, 0.4)
    assert "pieces" not in AreaViews(data_file(tmp_path, "model")).ready()


# ---------------------------------------------------------------------------------------------------------------
# Make map, Make this area again, and Draw all areas again.


def make(folder: Path, out: Path, maps: Path, **options) -> dict:
    options.setdefault("make_3d", False)
    return MapMaker(folder, out, Events(io.StringIO()), maps_folder=maps, runner=InlineRunner(), **options).run()


def area(report: dict, key: str) -> dict:
    return next(a for a in report["areas"] if a["key"] == key)


def platform_record(out: Path) -> dict:
    """The made-up platform, as the Adjust floors panel writes it down when it is pressed."""
    views = AreaViews(data_file(out, "m15_01"))
    table = views.table
    piece = int(table.triangle_piece[np.flatnonzero(table.piece_part[table.triangle_piece] == table.part_names.index("h0001B0"))[0]])
    return table.record(piece)


def own_file(path: Path, entry: dict) -> Path:
    path.write_text(json.dumps({"version": 3, PACK: {"m15_01": entry}}), encoding="utf-8")
    return path


def floor_pixel(pack: Path, floor: int, world: tuple[float, float]) -> tuple[int, ...]:
    """The colour of floor `floor` of Anor Londo's map at world (x, z), from its finest tiles."""
    from PIL import Image

    maps = json.loads((pack / "maps.json").read_text(encoding="utf-8"))
    frame = map_frame(next(m for m in maps if m["id"] == ANOR))
    layer = next(
        layer for layer in json.loads((pack / "layers.json").read_text(encoding="utf-8")) if layer["id"] == f"{PACK}:layer:m15_01-f{floor}"
    )
    (px, py), = frame.to_pixels(np.array([world]))
    size = layer["tileSize"]
    folder = pack / layer["tiles"]["url"].split("{z}")[0] / str(layer["maxZoom"])
    tile = next((folder / str(int(px // size))).glob(f"{int(py // size)}.*"))
    with Image.open(tile) as picture:
        return tuple(picture.convert("RGB").getpixel((int(px % size), int(py % size))))


def test_make_leaves_a_removed_piece_out_and_puts_it_back(dsr_map_folder: Path, tmp_path: Path) -> None:
    maps, out = tmp_path / "Maps", tmp_path / "out"
    first = make(dsr_map_folder, out, maps, only_areas=["m15_01"])
    pack = maps / PACK
    record = platform_record(out)
    assert record["part"] == "h0001B0" and record["triangles"] == 2 and record["box"][1] == record["box"][4] == 12.0
    # On the upper floor, the platform is drawn; beside it, only the faded ground below.
    beside = (45.0, 20.0)
    drawn = floor_pixel(pack, 1, PLATFORM[::2])
    assert drawn != floor_pixel(pack, 1, beside)
    assert "removedPieces" not in area(first, "m15_01")

    # Removed (and saved with the cuts): Make this area again leaves it out of the picture.
    path = own_file(tmp_path / "floor-overrides.json", {"removed": [record]})
    report = make(dsr_map_folder, out, maps, remake="m15_01", floor_overrides_file=path)
    entry = area(report, "m15_01")
    assert entry["removedPieces"]["found"] == 1 and entry["removedPieces"]["triangles"] == 2
    assert entry["removedPieces"]["pieces"][0]["by"] == "part"
    assert floor_pixel(pack, 1, PLATFORM[::2]) == floor_pixel(pack, 1, beside)
    # The shipped floors and names stay (an entry that only removes pieces).
    assert [f["name"] for f in entry["floors"]] == ["Ground", "Rooftops"]
    assert entry["floorPlan"]["overrides"]["removed"] == [record]
    # What lies on the platform has nothing under it now.
    assert entry["markers"]["notOnFloor"] > area(first, "m15_01")["markers"]["notOnFloor"]
    # The panel's floor data still has every triangle, so that it can be put back.
    assert AreaViews(data_file(out, "m15_01")).table.part_names.count("h0001B0") == 1
    assert len(AreaViews(data_file(out, "m15_01")).all) == entry["floorPlan"]["triangles"] + 2

    # Make map (every area) uses it too.
    whole = make(dsr_map_folder, tmp_path / "out2", tmp_path / "Maps2", floor_overrides_file=path)
    assert area(whole, "m15_01")["removedPieces"]["found"] == 1

    # Put back: drawn again.
    own_file(path, {})
    report = make(dsr_map_folder, out, maps, remake="m15_01", floor_overrides_file=path)
    assert "removedPieces" not in area(report, "m15_01")
    assert floor_pixel(pack, 1, PLATFORM[::2]) == drawn


def model_has_platform(builder: Path, pack: Path, work: Path) -> bool:  # noqa: F811
    model = unpack_model(builder, pack, ANOR, work, lambda: None)
    centres = model.triangles.mean(axis=1)
    return bool((np.abs(centres - np.array(PLATFORM)).max(axis=1) < 6.0).any())


def test_the_3d_model_leaves_a_removed_piece_out(dsr_map_folder: Path, builder: Path, tmp_path: Path) -> None:  # noqa: F811
    maps, out = tmp_path / "Maps", tmp_path / "out"
    make(dsr_map_folder, out, maps, only_areas=["m15_01"], make_3d=True, scene_builder=builder)
    pack = maps / PACK
    assert model_has_platform(builder, pack, tmp_path / "work")
    path = own_file(tmp_path / "floor-overrides.json", {"cuts": [6.25], "removed": [platform_record(out)]})
    report = make(dsr_map_folder, out, maps, remake="m15_01", floor_overrides_file=path, make_3d=True, scene_builder=builder)
    assert area(report, "m15_01")["scene"]["made"] is True
    assert not model_has_platform(builder, pack, tmp_path / "work")


def test_draw_all_areas_again_leaves_a_removed_piece_out(made_pack: Path, builder: Path, tmp_path: Path) -> None:  # noqa: F811
    import shutil

    from atlas_gamefiles.scene import check_pack

    maps = tmp_path / "Maps"
    maps.mkdir()
    pack = maps / PACK
    shutil.copytree(made_pack, pack)
    assert model_has_platform(builder, pack, tmp_path / "work")
    drawn = floor_pixel(pack, 1, PLATFORM[::2])
    beside = floor_pixel(pack, 1, (45.0, 20.0))
    assert drawn != beside
    # Written down from the game files' pieces; found again in the pack's own model by its place.
    record = {"part": "h0001B0", "box": [38.17, 12.0, 38.17, 51.83, 12.0, 51.83], "triangles": 2, "area": 100.0}
    path = own_file(tmp_path / "floor-overrides.json", {"removed": [record]})
    report = Redrawer(pack, tmp_path / "out", Events(io.StringIO()), scene_builder=builder, floor_overrides_file=path, only_maps=[ANOR]).run()
    line = next(m for m in report["maps"] if m["id"] == ANOR)
    assert line["redrawn"] is True and line["removedPieces"]["found"] == 1 and line["removedPieces"]["pieces"][0]["by"] == "place"
    assert floor_pixel(pack, 1, PLATFORM[::2]) == floor_pixel(pack, 1, (45.0, 20.0))
    # Its 3D model was made again without it, and the pack is still valid.
    assert not model_has_platform(builder, pack, tmp_path / "work")
    assert report["check3d"]["problems"] == [] and check_pack(builder, pack)["problems"] == []
    assert sorted(p.name for p in maps.iterdir()) == [PACK]
    # Drawn again once more: the model no longer has it, so it is left as it is.
    report = Redrawer(pack, tmp_path / "out2", Events(io.StringIO()), scene_builder=builder, floor_overrides_file=path, only_maps=[ANOR]).run()
    line = next(m for m in report["maps"] if m["id"] == ANOR)
    assert line["redrawn"] is True and line["removedPieces"]["found"] == 0


def test_a_raw_model_loses_the_removed_piece(tmp_path: Path) -> None:
    """A raw model as `atlas-scene unpack` writes one: two materials, indexed; the panel goes, the rest stays."""
    mesh, _, _ = ground_and_panels()
    ground, panel = mesh[:-2], mesh[-2:]
    document = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 1]}], "nodes": [], "meshes": [], "accessors": [], "bufferViews": []}
    binary = bytearray()
    for index, part in enumerate((ground, panel)):
        positions = part.reshape(-1, 3).astype("<f4")
        indices = np.arange(len(positions), dtype="<u4")
        for data, extra in ((positions, {"type": "VEC3", "componentType": 5126}), (indices, {"type": "SCALAR", "componentType": 5125})):
            document["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": data.nbytes})
            binary += data.tobytes()
            document["accessors"].append({"bufferView": len(document["bufferViews"]) - 1, "count": len(data), **extra})
        document["meshes"].append({"primitives": [{"attributes": {"POSITION": 2 * index}, "indices": 2 * index + 1, "mode": 4}]})
        document["nodes"].append({"mesh": index})
    text = json.dumps(document).encode()
    text += b" " * (-len(text) % 4)
    path = tmp_path / "model.glb"
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 28 + len(text) + len(binary)) + struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(binary), 0x004E4942) + bytes(binary))
    record = {"part": "panel", "box": [-30.0, 20.0, -30.0, -20.0, 20.0, -26.0], "area": 40.0}
    found = leave_out_of_glb(path, [record])
    assert found is not None and found.triangles == [2]
    from atlas_gamefiles.pieces import _accessor, _read_glb

    document, binary = _read_glb(path.read_bytes())
    assert "mesh" not in document["nodes"][1] and document["nodes"][0]["mesh"] == 0
    left = _accessor(document, binary, document["meshes"][0]["primitives"][0]["indices"])
    assert len(left) == len(ground) * 3
    # Nothing there any more: the file is left as it is.
    before = path.read_bytes()
    assert leave_out_of_glb(path, [record]) is None and path.read_bytes() == before
