"""The player's own floor cuts: the height profile and cut list in the report, the player's overrides file, the
Adjust floors views (floorviews.py), and making one area again in place of its map in the pack. Made-up geometry and
a made-up game folder only (tests/fixtures.py)."""

from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest

import fixtures
from atlas_gamefiles.config import chosen_floor_overrides, clean_floor_entry, load_floor_overrides
from atlas_gamefiles.events import Events
from atlas_gamefiles.floors import height_profile, plan_floors, prepare
from atlas_gamefiles.floorviews import AreaViews, data_file, save_floor_data, serve
from atlas_gamefiles.make import MakeError, MapMaker
from atlas_gamefiles.pack import PackRefused, duplicate_ids, merge_area, read_pack_json, swap_area
from atlas_gamefiles.worker import InlineRunner
from conftest import snapshot

PACK = "dark-souls-remastered"
ANOR = f"{PACK}:map:m15_01"


def make(folder: Path, out: Path, maps: Path, **options) -> tuple[dict, list[dict]]:
    stream = io.StringIO()
    report = MapMaker(folder, out, Events(stream), maps_folder=maps, runner=InlineRunner(), make_3d=False, **options).run()
    return report, [json.loads(line) for line in stream.getvalue().splitlines()]


def own_file(path: Path, entries: dict) -> Path:
    path.write_text(json.dumps({"$comment": "made up", PACK: entries}), encoding="utf-8")
    return path


def area(report: dict, key: str) -> dict:
    return next(a for a in report["areas"] if a["key"] == key)


def load(pack: Path, name: str):
    return json.loads((pack / name).read_text(encoding="utf-8"))


def two_floors() -> np.ndarray:
    return np.array(fixtures.two_floor_triangles(), dtype=np.float32)


# ---------------------------------------------------------------------------------------------------------------


def test_height_profile_counts_walkable_floor_per_half_metre() -> None:
    profile = height_profile(np.array([0.1, 0.2, 0.3, 9.0, 9.1]), cell=1.0)
    assert profile["low"] == 0.0 and profile["step"] == 0.5
    assert profile["areas"][0] == 3 and profile["areas"][18] == 2 and sum(profile["areas"]) == 5
    assert profile["high"] == pytest.approx(profile["low"] + len(profile["areas"]) * profile["step"])
    tall = height_profile(np.array([0.0, 2000.0]), cell=1.0)
    assert len(tall["areas"]) <= 800 and tall["step"] > 0.5
    assert height_profile(np.zeros(0), cell=1.0)["areas"] == []


def test_plan_reports_its_profile_and_dropped_cuts() -> None:
    prepared = prepare(two_floors())
    plan = plan_floors(prepared)
    assert len(plan.floors) == 2 and sum(plan.report["profile"]["areas"]) > 0
    # Planned again from the same preparation, with cuts given: one through nothing (it leaves an empty floor) is
    # dropped and reported.
    again = plan_floors(prepared, overrides={"cuts": [4.5, 20.0]})
    assert again.cuts == [4.5] and again.report["cutsDropped"] == [20.0]
    assert plan_floors(prepared, overrides={"cuts": []}).floors[0].area > plan.floors[0].area


def test_own_entries_are_cleaned_and_replace_the_shipped_one(tmp_path: Path) -> None:
    assert clean_floor_entry({"cuts": [1, "x", True, 2.5], "names": ["A", 3], "other": 1}) == {"cuts": [1.0, 2.5], "names": ["A", ""]}
    assert clean_floor_entry({"other": 1}) is None and clean_floor_entry([1]) is None
    path = own_file(tmp_path / "floor-overrides.json", {"m15_01": {"cuts": [5]}, "M10_01_00_00": {"names": ["Low"]}, "bad": 3})
    own = load_floor_overrides(path, PACK)
    assert own == {"m15_01": {"cuts": [5.0]}, "m10_01": {"names": ["Low"]}}
    assert load_floor_overrides(path, "bloodborne") == {}
    config = {"floorOverrides": {"m15_01": {"names": ["Ground", "Rooftops"]}, "m14_00": {"names": ["Swamp"]}}}
    assert chosen_floor_overrides(config, own, "m15_01_00_00") == ({"cuts": [5.0]}, "yours")
    assert chosen_floor_overrides(config, own, "m14_00_00_00") == ({"names": ["Swamp"]}, "shipped")
    assert chosen_floor_overrides(config, own, "m12_00_00_00") == ({}, None)
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        load_floor_overrides(tmp_path / "broken.json", PACK)


@pytest.fixture(scope="module")
def made(dsr_map_folder: Path, tmp_path_factory: pytest.TempPathFactory):
    base = tmp_path_factory.mktemp("own-floors")
    report, _ = make(dsr_map_folder, base / "out", base / "Maps")
    return report, base


def test_the_report_says_where_each_cut_comes_from(made) -> None:
    report, base = made
    plan = area(report, "m15_01")["floorPlan"]
    cut = plan["cuts"][0]
    assert plan["cutList"] == [{"height": cut, "by": "automatic"}]
    assert plan["overrides"] == {"from": "shipped", "names": ["Ground", "Rooftops"]}
    assert plan["shipped"] == {"cuts": [cut], "names": ["Ground", "Rooftops"]}
    profile = plan["profile"]
    assert profile["low"] <= 0 and profile["high"] >= 9 and max(profile["areas"]) > 0
    floors = area(report, "m15_01")["floors"]
    assert floors[0]["between"] == [None, cut] and floors[1]["between"] == [cut, None]
    assert report["options"]["floorOverrides"] == {"file": None, "error": None, "usedFor": []}
    # The views' data is kept in the output folder, never in the zip.
    assert data_file(base / "out", "m15_01").is_file()
    with zipfile.ZipFile(base / "out" / "atlas-make-report.zip") as archive:
        assert not any("floor-data" in name for name in archive.namelist())


def test_own_cuts_and_names_are_used_and_reported(dsr_map_folder: Path, tmp_path: Path) -> None:
    path = own_file(tmp_path / "floor-overrides.json", {"m15_01": {"cuts": [3.0], "names": ["Courtyard", ""]}})
    report, _ = make(dsr_map_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], floor_overrides_file=path)
    plan = area(report, "m15_01")["floorPlan"]
    assert plan["cutList"] == [{"height": 3.0, "by": "yours"}]
    assert plan["overrides"]["from"] == "yours"
    # His entry replaced the shipped one whole: the upper floor has no name of its own.
    assert [f["name"] for f in area(report, "m15_01")["floors"]] == ["Courtyard", "Upper level"]
    assert report["options"]["floorOverrides"] == {"file": "floor-overrides.json", "error": None, "usedFor": ["m15_01"]}


def test_an_unreadable_own_file_is_warned_about(dsr_map_folder: Path, tmp_path: Path) -> None:
    path = tmp_path / "floor-overrides.json"
    path.write_text("{broken", encoding="utf-8")
    report, events = make(dsr_map_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], floor_overrides_file=path)
    assert events[-1]["event"] == "done"
    assert any("could not be read" in w for w in report["warnings"])
    assert [f["name"] for f in area(report, "m15_01")["floors"]] == ["Ground", "Rooftops"]
    assert report["options"]["floorOverrides"]["error"]
    # A file that is not there is no warning: the player has not set any cuts yet.
    report, _ = make(dsr_map_folder, tmp_path / "out2", tmp_path / "Maps", only_areas=["m15_01"], floor_overrides_file=tmp_path / "none.json")
    assert not any("could not be read" in w for w in report["warnings"])


# ---------------------------------------------------------------------------------------------------------------
# The Adjust floors views.


def test_views_redraw_the_floors_from_given_cuts(made) -> None:
    report, base = made
    stream = io.StringIO()
    requests = [
        json.dumps({"id": 1, "cuts": [4.5], "names": ["Low", ""]}),
        json.dumps({"id": 2, "cuts": []}),
        "not json",
        json.dumps({"id": 3, "cuts": [4.5, 30.0]}),
    ]
    assert serve(base / "out", "m15_01", Events(stream), lines=requests) == 0
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    ready = lines[0]
    assert ready["event"] == "ready" and ready["profile"] == area(report, "m15_01")["floorPlan"]["profile"]
    assert ready["shippedCuts"] == area(report, "m15_01")["floorPlan"]["shipped"]["cuts"]
    first = lines[1]
    assert first["event"] == "views" and first["id"] == 1 and first["cuts"] == [4.5]
    assert [f["name"] for f in first["floors"]] == ["Low", "Upper level"]
    for floor in first["floors"]:
        assert floor["top"].startswith("data:image/png;base64,") and floor["colour"].startswith("#")
    assert sum(f["markers"] for f in first["floors"]) == area(report, "m15_01")["markers"]["total"]
    assert len(first["markers"]) == len(ready["markers"]) == area(report, "m15_01")["markers"]["total"]
    model = ready["model"]
    steps = np.frombuffer(base64.b64decode(model["positions"]), dtype="<u2")
    assert model["triangles"] > 0 and len(steps) == model["triangles"] * 9
    for axis in ("x", "z"):
        section = ready["section"][axis]
        pixels = np.frombuffer(base64.b64decode(section["pixels"]), dtype=np.uint8)
        assert len(pixels) == section["rows"] * section["columns"] and section["from"] < section["to"]
        assert (pixels >= 128).any(), "walkable floor is drawn"
    assert ready["heights"]["low"] <= ready["profile"]["low"] and ready["heights"]["high"] >= ready["profile"]["high"]
    assert len(lines[2]["floors"]) == 1
    assert lines[3]["event"] == "error" and lines[3]["id"] is None
    assert lines[4]["cuts"] == [4.5] and lines[4]["dropped"] == [30.0]


def test_views_of_a_made_up_keep(tmp_path: Path) -> None:
    """A made-up area with storeys, stairs, a ramp and an overhang: its section shows walls and floors, its model
    comes back whole, and its markers are put on floors; one on the stairs lies near the cut between storeys."""
    triangles, markers = fixtures.made_up_keep()
    mesh = np.array(triangles, dtype=np.float32)
    plan = plan_floors(mesh)
    save_floor_data(tmp_path, "m99_01", "Made-up Keep", mesh, plan, markers, None, (-3.0, 22.0), {}, 0.4)
    views = AreaViews(data_file(tmp_path, "m99_01"))
    ready = views.ready()
    model = ready["model"]
    corners = np.frombuffer(base64.b64decode(model["positions"]), dtype="<u2").reshape(-1, 3).astype(np.float64)
    low, high = np.array(model["min"]), np.array(model["max"])
    decoded = low + corners / 65535 * (high - low)
    assert model["triangles"] == len(mesh) and np.abs(decoded - mesh.reshape(-1, 3)).max() < 0.01
    section = ready["section"]["x"]
    pixels = np.frombuffer(base64.b64decode(section["pixels"]), dtype=np.uint8).reshape(section["rows"], section["columns"])
    walls, floors = (pixels > 0) & (pixels < 128), pixels >= 128
    assert walls.sum() > floors.sum() > 0
    # The keep's floors at 0, 5, 10 and 15 m show as lines in the section.
    rows = [int((ready["heights"]["high"] - h) / (ready["heights"]["high"] - ready["heights"]["low"]) * section["rows"]) for h in (0, 5, 10, 15)]
    assert all(floors[max(r - 2, 0) : r + 3].any() for r in rows)
    assert [m["type"] for m in ready["markers"]] == [category for _, category in markers]
    answer = views.views([1.75, 6.75, 13.25], None)
    placed = answer["markers"]
    assert len(placed) == len(markers)
    on_stairs = [i for i, ((x, y, z), _) in enumerate(markers) if -28 < x < -18 and -20 < z < -14][0]
    assert abs(markers[on_stairs][0][1] - 1.75) < 1.0 and placed[on_stairs]["surface"] is not None
    plain = views.views([1.75, 6.75, 13.25], None)["floors"][1]["top"]
    outlined = views.views([1.75, 6.75, 13.25], None, outlines=True)["floors"][1]["top"]
    assert plain != outlined


def test_views_need_the_floor_data_of_a_make(tmp_path: Path) -> None:
    stream = io.StringIO()
    assert serve(tmp_path, "m15_01", Events(stream), lines=[]) == 1
    line = json.loads(stream.getvalue())
    assert line["event"] == "error" and line["code"] == "no-floor-data"


# ---------------------------------------------------------------------------------------------------------------
# Making one area again.


def tiles_of(pack: Path, key: str) -> dict[str, str]:
    return {path: digest for path, digest in snapshot(pack).items() if path.startswith(f"tiles/{key}/")}


def test_make_this_area_again_replaces_only_its_map(dsr_map_folder: Path, tmp_path: Path) -> None:
    maps, out = tmp_path / "Maps", tmp_path / "out"
    first, _ = make(dsr_map_folder, out, maps)
    pack = maps / PACK
    before = read_pack_json(pack)
    others = {key: tiles_of(pack, key) for key in ("m10_01", "m10_02")}
    assert all(others.values()) and tiles_of(pack, "m15_01")
    assert (out / "previews" / "m15_01_f1.png").is_file()

    path = own_file(tmp_path / "floor-overrides.json", {"m15_01": {"cuts": [], "names": ["All of it"]}})
    report, events = make(dsr_map_folder, out, maps, remake="m15_01", floor_overrides_file=path)
    assert events[-1]["event"] == "done"
    assert next(e for e in events if e["event"] == "areas")["count"] == 1
    assert next(e for e in events if e["event"] == "pack")["replaced"] == "m15_01"
    after = read_pack_json(pack)

    # Every other map, its things and its files are as they were.
    for key in ("m10_01", "m10_02"):
        assert tiles_of(pack, key) == others[key]
        map_id = f"{PACK}:map:{key}"
        for name in ("maps", "layers", "regions", "locations"):
            mine = lambda items: [i for i in items if i.get("mapId", i.get("id")) == map_id]  # noqa: E731
            assert mine(after[name]) == mine(before[name]), name
    # The area has one floor now: one layer, the old floor's tiles gone, its markers on that floor.
    layers = [layer for layer in after["layers"] if layer["mapId"] == ANOR]
    assert [layer["name"] for layer in layers] == ["All of it"]
    assert not (pack / "tiles" / "m15_01" / "f1").exists() and (pack / "tiles" / "m15_01" / "f0").is_dir()
    assert all(loc["layerId"].endswith("m15_01-f0") for loc in after["locations"] if loc["mapId"] == ANOR)
    # The markers are the same, so the checklist entries keep their ids (and the player's ticks).
    assert [i["id"] for i in after["checklistItems"]] == [i["id"] for i in before["checklistItems"]]
    assert duplicate_ids(after) == []
    assert after["manifest"]["created"] == before["manifest"]["created"]
    assert after["manifest"]["contents"]["counts"]["layers"] == before["manifest"]["contents"]["counts"]["layers"] - 1
    assert sorted(p.name for p in maps.iterdir()) == [PACK], "no leftover folders"
    assert not any(p.name.startswith(".") for p in pack.iterdir())

    # The report is the last make's, with this area's entry made new.
    assert [a["key"] for a in report["areas"]] == [a["key"] for a in first["areas"]]
    assert area(report, "m10_01") == area(first, "m10_01")
    assert [f["name"] for f in area(report, "m15_01")["floors"]] == ["All of it"]
    assert report["remade"]["area"] == "m15_01" and report["createdAt"] == first["createdAt"]
    assert report["options"]["floorOverrides"]["usedFor"] == ["m15_01"]
    assert report["summary"]["floors"] == first["summary"]["floors"] - 1
    assert json.loads((out / "report.json").read_text(encoding="utf-8"))["remade"]["area"] == "m15_01"
    assert not (out / "previews" / "m15_01_f1.png").exists() and (out / "previews" / "m15_01_f0.png").is_file()
    assert not (out / "previews-remake").exists()

    # Back to the shipped floors: the area has two again.
    report, _ = make(dsr_map_folder, out, maps, remake="m15_01")
    assert [f["name"] for f in area(report, "m15_01")["floors"]] == ["Ground", "Rooftops"]
    assert report["options"]["floorOverrides"]["usedFor"] == []
    assert [layer["name"] for layer in load(pack, "layers.json") if layer["mapId"] == ANOR] == ["Ground", "Rooftops"]
    assert [i["id"] for i in load(pack, "checklistItems.json")] == [i["id"] for i in before["checklistItems"]]


def test_make_this_area_again_needs_its_pack_and_report(dsr_map_folder: Path, tmp_path: Path) -> None:
    maps, out = tmp_path / "Maps", tmp_path / "out"
    with pytest.raises(MakeError) as missing:
        make(dsr_map_folder, out, maps, remake="m15_01")
    assert missing.value.code == "pack-missing"
    make(dsr_map_folder, out, maps, only_areas=["m15_01"])
    with pytest.raises(MakeError) as not_made:
        make(dsr_map_folder, out, maps, remake="m10_01")
    assert not_made.value.code == "report-missing"
    manifest = json.loads((maps / PACK / "manifest.json").read_text(encoding="utf-8"))
    manifest["writtenBy"]["version"] = "0.0.1"
    (maps / PACK / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    before = snapshot(maps)
    with pytest.raises(MakeError) as other:
        make(dsr_map_folder, out, maps, remake="m15_01")
    assert other.value.code == "pack-other-version" and "0.0.1" in str(other.value)
    assert snapshot(maps) == before


def test_cancel_while_making_the_area_again_changes_nothing(dsr_map_folder: Path, tmp_path: Path) -> None:
    from atlas_gamefiles.check import CancelToken
    from atlas_gamefiles.geometry import Cancelled

    maps, out = tmp_path / "Maps", tmp_path / "out"
    make(dsr_map_folder, out, maps)
    before, report_before = snapshot(maps), snapshot(out)
    token = CancelToken()

    class CancelWhileDrawing(Events):
        def progress(self, fraction: float, message: str, **extra) -> None:
            super().progress(fraction, message, **extra)
            if "tiles" in message:
                token.cancel()

    maker = MapMaker(dsr_map_folder, out, CancelWhileDrawing(io.StringIO()), token=token, maps_folder=maps, runner=InlineRunner(), make_3d=False, remake="m15_01")
    with pytest.raises(Cancelled):
        maker.run()
    assert snapshot(maps) == before
    after = snapshot(out)
    for name in ("report.json", "atlas-make-report.zip", "previews/m15_01_f0.png", "previews/m15_01_f1.png"):
        assert after[name] == report_before[name], name


# ---------------------------------------------------------------------------------------------------------------
# merge_area and swap_area alone, on made-up packs.


def made_up_pack(maps: dict[str, list[str]], ticks: str = "") -> dict:
    """A pack with a map per key and a location per name, each in the bonfires checklist."""
    pack = {name: [] for name in ("maps", "layers", "regions", "locations", "entities", "checklists", "checklistItems", "guides", "categoryGroups", "categories", "links", "presets")}
    for key, names in maps.items():
        map_id = f"p:map:{key}"
        pack["maps"].append({"id": map_id, "name": key})
        pack["layers"].append({"id": f"p:layer:{key}-f0", "mapId": map_id})
        pack["regions"].append({"id": f"p:region:{key}", "mapId": map_id})
        for name in names:
            loc_id = f"p:loc:{key}.{name}"
            pack["locations"].append({"id": loc_id, "mapId": map_id, "categoryId": "p:cat:bonfire", "entityIds": [f"p:entity:{name}"]})
            pack["entities"].append({"id": f"p:entity:{name}"})
            pack["checklistItems"].append({"id": f"p:checkitem:bonfires-{len(pack['checklistItems']) + 1}{ticks}", "checklistId": "p:checklist:bonfires", "locationIds": [loc_id], "order": 0})
    pack["checklists"] = [{"id": "p:checklist:bonfires", "name": "All bonfires", "order": 0}]
    pack["manifest"] = {
        "created": "then",
        "updated": "then",
        "writtenBy": {"name": "Atlas Map Maker", "version": "x"},
        "contents": {"maps": [{"id": f"p:map:{key}"} for key in maps], "counts": {}},
    }
    return pack


def test_merge_area_keeps_the_other_maps_and_the_ids() -> None:
    old = made_up_pack({"a": ["one", "two"], "b": ["three"], "c": ["four"]})
    part = made_up_pack({"b": ["three", "new"]})
    part["manifest"]["updated"] = "now"
    merged = merge_area(old, part, "p", "b")
    assert [m["id"] for m in merged["maps"]] == ["p:map:a", "p:map:b", "p:map:c"]
    assert [loc["id"] for loc in merged["locations"]] == ["p:loc:a.one", "p:loc:a.two", "p:loc:b.three", "p:loc:b.new", "p:loc:c.four"]
    items = merged["checklistItems"]
    # The same location keeps its entry's id; a new one gets a number not used before; orders are counted again.
    assert [i["id"] for i in items] == ["p:checkitem:bonfires-1", "p:checkitem:bonfires-2", "p:checkitem:bonfires-3", "p:checkitem:bonfires-5", "p:checkitem:bonfires-4"]
    assert [i["order"] for i in items] == [0, 1, 2, 3, 4]
    assert {e["id"] for e in merged["entities"]} == {"p:entity:one", "p:entity:two", "p:entity:three", "p:entity:new", "p:entity:four"}
    assert [c["id"] for c in merged["categories"]] == ["p:cat:bonfire"]
    assert merged["manifest"]["updated"] == "now" and merged["manifest"]["created"] == "then"
    assert merged["manifest"]["contents"]["counts"]["locations"] == 5
    assert duplicate_ids(merged) == []
    # An area that is not in the pack yet is added at the end.
    added = merge_area(old, made_up_pack({"d": ["five"]}), "p", "d")
    assert [m["id"] for m in added["maps"]][-1] == "p:map:d"


def write_made_up(folder: Path, pack: dict, keys: list[str]) -> None:
    from atlas_gamefiles.pack import write_pack_json

    write_pack_json(folder, pack)
    for key in keys:
        tile = folder / "tiles" / key / "f0" / "0" / "0"
        tile.mkdir(parents=True)
        (tile / "0.webp").write_bytes(key.encode())


def test_swap_area_puts_the_new_files_in_and_the_old_ones_out(tmp_path: Path) -> None:
    target, staging = tmp_path / "p", tmp_path / ".p.remake-b"
    old = made_up_pack({"a": ["one"], "b": ["two"]})
    write_made_up(target, old, ["a", "b"])
    (target / "scene" / "b" / "c0").mkdir(parents=True)
    (target / "scene" / "b" / "c0" / "lod0.glb").write_bytes(b"old model")
    other = snapshot(target / "tiles" / "a")
    staging_tile = staging / "tiles" / "b" / "f1" / "0" / "0"
    staging_tile.mkdir(parents=True)
    (staging_tile / "0.webp").write_bytes(b"new")
    merged = merge_area(old, made_up_pack({"b": ["two"]}), "p", "b")
    swap_area(staging, target, "b", merged)
    assert (target / "tiles" / "b" / "f1" / "0" / "0" / "0.webp").read_bytes() == b"new"
    assert not (target / "tiles" / "b" / "f0").exists()
    assert not (target / "scene").exists(), "the old model is gone, and its empty folder"
    assert snapshot(target / "tiles" / "a") == other
    assert sorted(p.name for p in tmp_path.iterdir()) == [".p.remake-b", "p"]
    assert not any(p.name.startswith(".") for p in target.iterdir())


def test_swap_area_puts_everything_back_when_it_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target, staging = tmp_path / "p", tmp_path / ".p.remake-b"
    old = made_up_pack({"a": ["one"], "b": ["two"]})
    write_made_up(target, old, ["a", "b"])
    (staging / "tiles" / "b" / "f0").mkdir(parents=True)
    (staging / "tiles" / "b" / "f0" / "new.webp").write_bytes(b"new")
    before = snapshot(target)
    real_replace = Path.replace

    def failing_replace(self: Path, other):
        if Path(other).name == "manifest.json":
            raise PermissionError("in use")
        return real_replace(self, other)

    monkeypatch.setattr(Path, "replace", failing_replace)
    merged = merge_area(old, made_up_pack({"b": ["changed"]}), "p", "b")
    with pytest.raises(PackRefused, match="left as it was"):
        swap_area(staging, target, "b", merged)
    monkeypatch.undo()
    assert snapshot(target) == before
    assert (staging / "tiles" / "b" / "f0" / "new.webp").is_file()
    assert sorted(p.name for p in tmp_path.iterdir()) == [".p.remake-b", "p"]


# ---------------------------------------------------------------------------------------------------------------
# Map styles.


def test_map_styles_draw_outlines_and_refuse_textures(dsr_map_folder: Path, tmp_path: Path) -> None:
    from atlas_gamefiles.render import MAP_STYLES, OUTLINE, Frame, draw_layer, map_style

    triangles = np.array(fixtures.quad(0, 10, 0, 10, 0.0), dtype=np.float32)
    colours = np.full((len(triangles), 3), 90, dtype=np.uint8)
    walls = np.array([[[2.0, 2.0], [8.0, 2.0]]])
    frame = Frame(-2.0, 12.0, 8.0, 112, 112)
    shaded = np.asarray(draw_layer(frame, triangles, colours, walls, map_style("shaded")))
    outlined = np.asarray(draw_layer(frame, triangles, colours, walls, map_style("outlines")))
    is_outline = lambda picture: (picture[:, :, :3] == OUTLINE).all(axis=2)  # noqa: E731
    assert not is_outline(shaded).any() and is_outline(outlined).sum() > 100
    assert map_style(None).id == "shaded"
    for name in ("textured", "textured-outlines", "watercolour"):
        with pytest.raises(ValueError):
            map_style(name)
    assert not MAP_STYLES["textured"].available and MAP_STYLES["textured"].note

    with pytest.raises(MakeError) as refused:
        MapMaker(dsr_map_folder, tmp_path / "out", Events(io.StringIO()), style="textured")
    assert refused.value.code == "map-style" and "textures" in str(refused.value)
    report, _ = make(dsr_map_folder, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"], style="outlines")
    assert report["options"]["mapStyle"] == "outlines" and area(report, "m15_01")["mapStyle"] == "outlines"
