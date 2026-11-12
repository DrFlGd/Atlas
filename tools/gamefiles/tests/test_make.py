"""Making a map pack from a made-up Dark Souls Remastered folder (tests/fixtures.py, make_dsr_map)."""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path

import pytest

from atlas_gamefiles.check import CancelToken
from atlas_gamefiles.events import Events
from atlas_gamefiles.games import Area, newest_versions
from atlas_gamefiles.geometry import Cancelled
from atlas_gamefiles.make import MakeError, MapMaker
from atlas_gamefiles.pack import duplicate_ids
from atlas_gamefiles.safety import UnsafeOutputError
from atlas_gamefiles.worker import InlineRunner
from conftest import snapshot

PACK = "dark-souls-remastered"


def make(folder: Path, out: Path, maps: Path | None, **options) -> tuple[dict, list[dict]]:
    stream = io.StringIO()
    report = MapMaker(folder, out, Events(stream), maps_folder=maps, runner=InlineRunner(), **options).run()
    return report, [json.loads(line) for line in stream.getvalue().splitlines()]


def load(pack: Path, name: str) -> list | dict:
    return json.loads((pack / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def made(dsr_map_folder: Path, tmp_path_factory: pytest.TempPathFactory) -> tuple[dict, list[dict], Path, Path]:
    before = snapshot(dsr_map_folder)
    base = tmp_path_factory.mktemp("make")
    report, events = make(dsr_map_folder, base / "out", base / "Maps")
    assert snapshot(dsr_map_folder) == before, "the game folder must not change"
    return report, events, base / "Maps" / PACK, base / "out"


def by_id(items: list[dict]) -> dict[str, dict]:
    return {item["id"]: item for item in items}


def test_pack_is_written_into_the_maps_folder(made) -> None:
    report, events, pack, _ = made
    assert events[-1]["event"] == "done"
    assert events[-1]["pack"] == str(pack)
    assert sorted(p.name for p in pack.parent.iterdir()) == [PACK], "no leftover folders"
    manifest = load(pack, "manifest.json")
    assert manifest["schemaVersion"] == 2
    assert manifest["gameId"] == PACK
    assert manifest["gamePatch"] == "1.3.1.0"
    assert manifest["writtenBy"]["name"] == "Atlas Map Maker"
    assert any("Hunter's Atlas" in a["name"] for a in manifest["attribution"])
    assert manifest["contents"]["counts"]["maps"] == 3
    assert report["pack"]["installed"] is True


def test_one_map_per_area_and_one_layer_per_floor(made) -> None:
    _, _, pack, _ = made
    maps = by_id(load(pack, "maps.json"))
    assert sorted(maps) == [f"{PACK}:map:m10_01", f"{PACK}:map:m10_02", f"{PACK}:map:m15_01"]
    anor = maps[f"{PACK}:map:m15_01"]
    assert anor["name"] == "Anor Londo"  # from the config
    layers = [layer for layer in load(pack, "layers.json") if layer["mapId"] == anor["id"]]
    # Floor names from the config, lowest first; the main (largest) floor is the map's first layer.
    assert [layer["name"] for layer in layers] == ["Ground", "Rooftops"]
    assert layers[0]["tiles"] == {"type": "xyz", "url": "tiles/m15_01/f0/{z}/{x}/{y}.webp"}
    for layer in load(pack, "layers.json"):
        url = layer["tiles"]["url"]
        assert (pack / url.replace("{z}/{x}/{y}", "0/0/0")).is_file()
    # The world transform maps pixels back to world x, z: 8 pixels per metre, z up.
    transform = anor["worldTransform"]
    assert transform["a"] == pytest.approx(1 / 8) and transform["d"] == pytest.approx(-1 / 8)


def test_markers(made) -> None:
    _, _, pack, _ = made
    locations = by_id(load(pack, "locations.json"))
    categories = by_id(load(pack, "categories.json"))
    loc = lambda key: locations[f"{PACK}:loc:{key}"]  # noqa: E731

    # Bonfires from the event script, with their flags; one registered through an event with arguments.
    ground_bonfire, roof_bonfire = loc("m15_01.bonfire.1511960"), loc("m15_01.bonfire.1511961")
    assert (ground_bonfire["flagId"], roof_bonfire["flagId"]) == ("11510984", "11510976")
    assert ground_bonfire["layerId"].endswith("m15_01-f0") and roof_bonfire["layerId"].endswith("m15_01-f1")
    # Named after the place name of the collision they stand on.
    assert {ground_bonfire["name"], roof_bonfire["name"]} == {"Made-up Cathedral", "Made-up Cathedral (2)"}
    # An area without an event script: a bonfire found by the model other areas' scripts confirmed.
    assert loc("m10_01.bonfire.1011960")["categoryId"] == f"{PACK}:cat:bonfire"

    ring = loc("m15_01.o0500_0001.l1")
    assert (ring["name"], ring["categoryId"], ring["flagId"]) == ("Made-up Ring", f"{PACK}:cat:ring", "51510000")
    assert ring["layerId"].endswith("m15_01-f1")
    assert ring["regionId"] == f"{PACK}:region:m15_01-p1501"
    assert ring["guideId"]  # "In a chest."
    firebombs = loc("m15_01.o5010_0001.l1")
    assert firebombs["name"] == "Made-up Firebomb ×3"
    assert firebombs["layerId"].endswith("m15_01-f0")
    assert loc("m15_01.o5010_0002.l1")["name"] == "Made-up Sword +5"
    souls = loc("m15_01.o5010_0002.l2")
    assert souls["categoryId"] == f"{PACK}:cat:souls" and "flagId" not in souls
    assert loc("m10_01.o0500_0000.l2")["name"] == "Made-up Key of the Patch"  # patch text wins
    assert loc("m10_01.o0500_0000.l1")["categoryId"] == f"{PACK}:cat:upgrade"

    boss = loc("m15_01.boss.ornstein-and-smough")
    assert (boss["flagId"], boss["layerId"].split(":")[-1]) == ("12", "m15_01-f1")
    assert loc("m15_01.c0000_0001")["name"] == "Made-up Knight"
    drop = loc("m15_01.c2790_0000.d1")
    assert (drop["name"], drop["flagId"]) == ("Black Knight: Made-up Axe", "51510100")
    # No regular enemies, no bonfire stand-ins.
    assert not any(".c2800_" in key or ".c1000_" in key for key in locations)
    # A missing item lot gives no marker.
    assert not any(key.endswith("o5010_0002.l3") for key in locations)

    assert categories[f"{PACK}:cat:souls"]["defaultVisible"] is False
    assert categories[f"{PACK}:cat:consumable"]["defaultVisible"] is False
    assert categories[f"{PACK}:cat:bonfire"]["icon"] == "flame"
    assert categories[f"{PACK}:cat:npc"]["trackable"] is False

    entities = by_id(load(pack, "entities.json"))
    assert entities[f"{PACK}:entity:item-r100"]["description"] == "A ring that was made up for a test."
    for location in locations.values():
        image = by_id(load(pack, "maps.json"))[location["mapId"]]
        assert 0 <= location["x"] <= image["width"] and 0 <= location["y"] <= image["height"]


def test_checklists(made) -> None:
    _, _, pack, _ = made
    lists = {c["name"]: c for c in load(pack, "checklists.json")}
    assert list(lists) == ["All bonfires", "Bosses", "Items by area", "Rings", "Key items"]
    items = load(pack, "checklistItems.json")
    bonfires = [i for i in items if i["checklistId"] == lists["All bonfires"]["id"]]
    assert len(bonfires) == 4
    assert {i["section"] for i in bonfires} == {"Anor Londo", "Undead Burg and Undead Parish", "Firelink Shrine"}
    rings = [i for i in items if i["checklistId"] == lists["Rings"]["id"]]
    assert [i["name"] for i in rings] == ["Made-up Ring"]


def test_report(made) -> None:
    report, _, _, out = made
    anor = next(a for a in report["areas"] if a["key"] == "m15_01")
    assert anor["geometry"]["used"] == "collision"
    assert anor["floorPlan"]["cuts"] and 0 < anor["floorPlan"]["cuts"][0] < 9
    assert [f["name"] for f in anor["floors"]] == ["Ground", "Rooftops"]
    assert anor["floors"][0]["wallLines"] > 0 and anor["floors"][1]["wallLines"] > 0
    assert anor["markers"]["notOnFloor"] == 0
    assert anor["bonfires"]["method"].startswith("event script")
    assert anor["treasure"]["lotsMissing"]["count"] == 1
    assert anor["characters"]["bossesNotFound"] == ["Dark Sun Gwyndolin"]
    # The platform's mesh only meets its treasure when moved by its collision part.
    placement = anor["placement"]
    assert placement["collisionPartsMovedOrTurned"] == 1
    assert placement["markersOnFloorAsPlaced"] == 1.0
    assert placement["markersOnFloorAsStored"] < 1.0
    assert placement["verdict"].startswith("placed by part")
    firelink = next(a for a in report["areas"] if a["key"] == "m10_02")
    assert firelink["geometry"]["used"] is None
    assert firelink["markers"]["notOnFloor"] == firelink["markers"]["total"]
    assert report["summary"]["areasMade"] == 3

    text = (out / "report.json").read_text(encoding="utf-8")
    assert "Made-up" not in text, "the report holds no game text"
    with zipfile.ZipFile(out / "atlas-make-report.zip") as archive:
        names = set(archive.namelist())
    assert {"report.json", "README.txt", "previews/m15_01_f0.png", "previews/m15_01_f1.png"} <= names


def test_make_again_replaces_its_own_pack(dsr_map_folder: Path, tmp_path: Path) -> None:
    maps = tmp_path / "Maps"
    make(dsr_map_folder, tmp_path / "out1", maps, only_areas=["m15_01"])
    first = load(maps / PACK, "manifest.json")
    report, _ = make(dsr_map_folder, tmp_path / "out2", maps, only_areas=["m15_01"])
    again = load(maps / PACK, "manifest.json")
    assert again["created"] == first["created"]
    assert len(load(maps / PACK, "maps.json")) == 1
    assert sorted(p.name for p in maps.iterdir()) == [PACK]


def test_two_versions_of_an_area_make_one_map(dsr_map_folder: Path, tmp_path: Path) -> None:
    # Dark Souls Remastered ships Darkroot twice (m12_00_00_00 and m12_00_00_01); the game uses the last.
    game = tmp_path / "game"
    shutil.copytree(dsr_map_folder, game)
    studio = game / "map" / "MapStudio"
    shutil.copy(studio / "m15_01_00_00.msb", studio / "m15_01_00_01.msb")
    report, _ = make(game, tmp_path / "out", tmp_path / "Maps", only_areas=["m15_01"])
    pack = tmp_path / "Maps" / PACK
    assert [m["id"] for m in load(pack, "maps.json")] == [f"{PACK}:map:m15_01"]
    assert "m15_01_00_00" in report["skippedAreas"]
    for name in ("layers.json", "regions.json", "locations.json"):
        ids = [item["id"] for item in load(pack, name)]
        assert len(ids) == len(set(ids)), name


def test_newest_versions_keeps_the_last_of_each_area() -> None:
    areas = [Area(id=i, name=i, msb=Path(i), map_folder=None) for i in ("m12_00_00_00", "m12_00_00_01", "m12_01_00_00")]
    kept, older = newest_versions(areas)
    assert [a.id for a in kept] == ["m12_00_00_01", "m12_01_00_00"]
    assert older == ["m12_00_00_00"]


def test_duplicate_ids_are_found() -> None:
    assert duplicate_ids({"maps": [{"id": "a"}, {"id": "b"}, {"id": "a"}], "manifest": {"id": "a"}}) == ["maps: a"]


def test_refuses_a_pack_it_did_not_make(dsr_map_folder: Path, tmp_path: Path) -> None:
    other = tmp_path / "Maps" / PACK
    other.mkdir(parents=True)
    manifest = {"schemaVersion": 2, "gameId": PACK, "title": "Someone else's", "packVersion": "1.0.0"}
    (other / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(MakeError, match="did not make"):
        make(dsr_map_folder, tmp_path / "out", tmp_path / "Maps")
    assert json.loads((other / "manifest.json").read_text())["title"] == "Someone else's"
    assert sorted(p.name for p in (tmp_path / "Maps").iterdir()) == [PACK]


def test_never_writes_into_the_game_folder(dsr_map_folder: Path, tmp_path: Path) -> None:
    with pytest.raises(UnsafeOutputError):
        make(dsr_map_folder, tmp_path / "out", dsr_map_folder / "Maps")
    with pytest.raises(UnsafeOutputError):
        make(dsr_map_folder, dsr_map_folder / "out", tmp_path / "Maps")


def test_bloodborne_is_refused_for_now(bloodborne_folder: Path, tmp_path: Path) -> None:
    with pytest.raises(MakeError, match="later version"):
        make(bloodborne_folder, tmp_path / "out", tmp_path / "Maps")


def test_cancel_leaves_the_installed_pack_as_it_was(dsr_map_folder: Path, tmp_path: Path) -> None:
    maps = tmp_path / "Maps"
    make(dsr_map_folder, tmp_path / "out1", maps, only_areas=["m15_01"])
    before = snapshot(maps)
    token = CancelToken()

    class CancelWhileDrawing(Events):
        def progress(self, fraction: float, message: str, **extra) -> None:
            super().progress(fraction, message, **extra)
            if "tiles" in message:
                token.cancel()

    stream = io.StringIO()
    maker = MapMaker(dsr_map_folder, tmp_path / "out2", CancelWhileDrawing(stream), token=token, maps_folder=maps, runner=InlineRunner())
    with pytest.raises(Cancelled):
        maker.run()
    assert snapshot(maps) == before, "a cancelled make changes nothing in the maps folder"
