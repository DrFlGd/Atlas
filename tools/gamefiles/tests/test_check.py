"""The whole check on made-up folders, in this process (see test_cli.py for the command line)."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest

from atlas_gamefiles.check import CancelToken, Checker
from atlas_gamefiles.events import Events
from atlas_gamefiles.games import PROFILES
from atlas_gamefiles.geometry import Cancelled
from atlas_gamefiles.safety import UnsafeOutputError
from conftest import snapshot


def run(folder: Path, out: Path, **options) -> tuple[dict, list[dict]]:
    stream = io.StringIO()
    report = Checker(folder, out, Events(stream), **options).run()
    events = [json.loads(line) for line in stream.getvalue().splitlines()]
    return report, events


def test_dark_souls_remastered_report(dsr_folder: Path, tmp_path: Path) -> None:
    before = snapshot(dsr_folder)
    report, events = run(dsr_folder, tmp_path / "out")
    assert snapshot(dsr_folder) == before, "the game folder must not change"

    assert report["game"]["id"] == "dark-souls-remastered"
    assert report["game"]["version"] == "1.3.1.0"
    assert [a["id"] for a in report["areas"]] == ["m10_01_00_00", "m10_02_00_00"]
    burg, firelink = report["areas"]
    assert burg["name"] == "Undead Burg / Parish"
    assert firelink["name"] == "Firelink Shrine"

    assert burg["parts"] == {
        "Character": 2,
        "Collision": 1,
        "MapPiece": 1,
        "Navmesh": 1,
        "Object": 2,
        "PlayerStart": 1,
    }
    assert burg["treasures"] == 2
    assert burg["itemLotsReferenced"] == 4  # 1010000, 1010010, 1010020 and 9999999
    assert burg["itemLotsFound"] == 3  # 9999999 is not in the made-up ItemLotParam
    assert burg["bonfireCandidates"]["count"] == 1
    assert burg["bonfireCandidates"]["examples"] == ["o0510_0000"]
    assert burg["bonfireCandidates"]["collisionBonfireIds"] == 1
    assert burg["bounds"] == {"x": [-35.0, 30.0], "y": [0.0, 4.0], "z": [-30.0, 40.0]}

    collision = burg["geometry"]["collision"]
    assert collision["status"] == "ok"
    assert (collision["entries"], collision["read"], collision["triangles"], collision["unplaced"]) == (2, 2, 6, 1)
    navmesh = burg["geometry"]["navmesh"]
    assert (navmesh["status"], navmesh["read"], navmesh["triangles"]) == ("ok", 1, 2)
    pieces = burg["geometry"]["mapPieces"]
    assert pieces["status"] == "failed"  # the fixture's .flver is not a model
    assert pieces["errors"]
    assert firelink["geometry"]["collision"]["status"] == "missing"

    assert burg["preview"]["geometry"] == "collision"
    assert burg["preview"]["dots"]["treasure"] == 2
    assert firelink["preview"]["geometry"] == "none (parts only)"

    summary = report["summary"]
    assert summary["areas"] == 2
    assert summary["treasures"] == 4
    assert summary["itemLotsReferenced"] == 4
    assert summary["itemLotsFound"] == 3
    assert summary["recommendedGeometry"] == "collision"
    assert report["gameData"]["itemLots"] == {
        "ok": True,
        "file": "param/GameParam/GameParam.parambnd.dcx",
        "rows": 3,
        "seconds": report["gameData"]["itemLots"]["seconds"],
    }
    assert report["gameData"]["itemText"]["tables"] == 2
    assert report["gameData"]["itemText"]["entries"] == 3
    assert "Expected about 17 Dark Souls Remastered areas, found 2" in report["warnings"]

    kinds = [e["event"] for e in events]
    assert kinds[0] == "start" and kinds[-1] == "done"
    assert {"game", "areas", "progress", "area", "warning"} <= set(kinds)
    fractions = [e["fraction"] for e in events if e["event"] == "progress"]
    assert fractions == sorted(fractions), "progress only moves forward"

    out = tmp_path / "out"
    assert json.loads((out / "report.json").read_text(encoding="utf-8")) == report
    with zipfile.ZipFile(out / "atlas-check-report.zip") as archive:
        assert sorted(archive.namelist()) == [
            "README.txt",
            "previews/m10_01_00_00.png",
            "previews/m10_02_00_00.png",
            "report.json",
        ]


def test_only_some_areas(dsr_folder: Path, tmp_path: Path) -> None:
    report, _ = run(dsr_folder, tmp_path / "out", only_areas=["m10_02"])
    assert [a["id"] for a in report["areas"]] == ["m10_02_00_00"]
    assert report["warnings"] == []


def test_bloodborne_report(bloodborne_folder: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Mocks, because Soulstruct cannot write Bloodborne MSBs or Havok 2014 meshes (see fixtures.py): the made-up
    `.msb.dcx` is read with the Dark Souls class, and the mesh reader refuses the collision files as it refuses real
    Bloodborne ones, so the check falls back to parsing them as Havok files."""
    from soulstruct.darksouls1r.maps import MSB as DarkSoulsMSB
    from soulstruct.havok.fromsoft.shared import map_collision

    monkeypatch.setattr(type(PROFILES["bloodborne"]), "msb_class", lambda self: DarkSoulsMSB)

    def refuse(cls, data):
        raise ValueError("Cannot import `MapCollisionModel` from HKX with Havok version: 'hk_2014.1.0-r1'")

    monkeypatch.setattr(map_collision.MapCollisionModel, "from_bytes", classmethod(refuse))

    before = snapshot(bloodborne_folder)
    report, _ = run(bloodborne_folder, tmp_path / "out")
    assert snapshot(bloodborne_folder) == before

    assert report["game"]["id"] == "bloodborne"
    assert report["game"]["version"] == "1.09"
    (ward,) = report["areas"]
    assert ward["name"] == "Cathedral Ward"
    assert ward["treasures"] == 2
    assert ward["bonfireCandidates"]["method"].startswith("distinct lamp ids")
    collision = ward["geometry"]["collision"]
    assert collision["status"] == "not-decoded"
    assert collision["read"] == 2
    assert "decoder" in collision["note"]
    assert collision["havokClasses"]
    assert ward["geometry"]["navmesh"]["status"] == "not-decoded"
    assert ward["preview"]["geometry"] == "none (parts only)"
    assert report["summary"]["mainAreas"]["found"] == 1
    assert report["summary"]["recommendedGeometry"] is None
    # The made-up param file holds Dark Souls rows; whether or not they read, the check goes on.
    assert "itemLots" in report["gameData"]


def test_unknown_folder_still_writes_a_report(tmp_path: Path) -> None:
    folder = tmp_path / "games"
    folder.mkdir()
    report, events = run(folder, tmp_path / "out")
    assert report["game"]["id"] == "unknown"
    assert report["areas"] == []
    assert report["warnings"] and "DarkSoulsRemastered.exe" in report["warnings"][0]
    assert events[-1]["event"] == "done"
    assert (tmp_path / "out" / "atlas-check-report.zip").is_file()


def test_refuses_output_inside_the_game_folder(dsr_folder: Path) -> None:
    before = snapshot(dsr_folder)
    with pytest.raises(UnsafeOutputError):
        run(dsr_folder, dsr_folder / "report")
    assert snapshot(dsr_folder) == before
    assert not (dsr_folder / "report").exists()


def test_cancel_stops_between_files(dsr_folder: Path, tmp_path: Path) -> None:
    token = CancelToken()
    stream = io.StringIO()
    events = Events(stream)
    original = events.emit

    def emit(event: str, **fields) -> None:
        original(event, **fields)
        if event == "areas":
            token.cancel()

    events.emit = emit  # type: ignore[method-assign]
    with pytest.raises(Cancelled):
        Checker(dsr_folder, tmp_path / "out", events, token=token).run()
    assert not (tmp_path / "out" / "report.json").exists()
