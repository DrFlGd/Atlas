from __future__ import annotations

import shutil
from pathlib import Path

import fixtures
from atlas_gamefiles import detect as d


def test_dark_souls_remastered(dsr_folder: Path) -> None:
    found = d.detect(dsr_folder)
    assert found.game == d.DSR
    assert found.supported
    assert found.root == dsr_folder
    assert found.version == "1.3.1.0"
    assert "DarkSoulsRemastered.exe" in found.evidence
    assert any("2 map files" in line for line in found.evidence)


def test_parent_folder_finds_the_game(dsr_folder: Path) -> None:
    found = d.detect(dsr_folder.parent)
    assert found.game == d.DSR
    assert found.root == dsr_folder
    assert found.picked == dsr_folder.parent
    assert found.evidence[0].startswith("found in the sub-folder")


def test_steam_build_id(tmp_path: Path) -> None:
    install = tmp_path / "steamapps" / "common" / "DARK SOULS REMASTERED"
    fixtures.make_dsr(install)
    (tmp_path / "steamapps" / "appmanifest_570940.acf").write_text('"AppState"\n{\n\t"buildid"\t\t"1234567"\n}\n')
    found = d.detect(install)
    assert found.details["steamBuildId"] == "1234567"


def test_bloodborne_dump_root_and_dvdroot(bloodborne_folder: Path) -> None:
    for folder in (bloodborne_folder, bloodborne_folder / "dvdroot_ps4"):
        found = d.detect(folder)
        assert found.game == d.BLOODBORNE, folder
        assert found.supported
        assert found.root == bloodborne_folder / "dvdroot_ps4"
        assert found.version == "1.09"
        assert found.details["titleId"] == "CUSA99999"
        assert found.details["dlcMaps"] == []


def test_bloodborne_without_maps_is_not_supported(tmp_path: Path) -> None:
    (tmp_path / "dvdroot_ps4").mkdir()
    (tmp_path / "eboot.bin").write_bytes(b"made up")
    found = d.detect(tmp_path)
    assert found.game == d.BLOODBORNE
    assert not found.supported
    assert "no .msb.dcx" in (found.reason or "")


def test_prepare_to_die_is_recognised_but_not_supported(tmp_path: Path) -> None:
    (tmp_path / "DARKSOULS.exe").write_bytes(b"made up")
    found = d.detect(tmp_path)
    assert found.game == d.PTDE
    assert not found.supported
    assert "Remastered" in (found.reason or "")


def test_unknown_folder(tmp_path: Path) -> None:
    (tmp_path / "readme.txt").write_text("nothing here")
    found = d.detect(tmp_path)
    assert found.game == d.UNKNOWN
    assert not found.supported
    assert "DarkSoulsRemastered.exe" in (found.reason or "")
    assert d.detect(tmp_path / "missing").reason.startswith("The folder")


def test_exe_without_maps_explains(tmp_path: Path, dsr_folder: Path) -> None:
    shutil.copy(dsr_folder / "DarkSoulsRemastered.exe", tmp_path / "DarkSoulsRemastered.exe")
    found = d.detect(tmp_path)
    assert found.game == d.DSR
    assert not found.supported
    assert "Verify integrity" in (found.reason or "")


def test_case_insensitive_names(tmp_path: Path) -> None:
    (tmp_path / "MAP").mkdir()
    assert d.child(tmp_path, "map") == tmp_path / "MAP"
    assert d.descend(tmp_path, "Map", "MapStudio") is None


def test_param_sfo() -> None:
    entries = d.read_param_sfo_bytes(fixtures.param_sfo({"TITLE_ID": "CUSA99999", "APP_VER": "01.09"}))
    assert entries == {"TITLE_ID": "CUSA99999", "APP_VER": "01.09"}
