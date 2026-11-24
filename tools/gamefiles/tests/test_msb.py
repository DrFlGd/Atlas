"""Reading a Bloodborne map layout file the way real ones are: Soulstruct's checks turn them down, the relaxed
reading reads past the values Atlas does not use, and Soulstruct's own checks are back afterwards."""

from __future__ import annotations

from collections import Counter

import pytest

import fixtures
from atlas_gamefiles.detect import DSR
from atlas_gamefiles.games import PROFILES, Area
from atlas_gamefiles.msb import lenient_layout_reading, load_msb, summarize


@pytest.fixture(scope="module")
def layout() -> bytes:
    return fixtures.make_bloodborne_msb(fixtures.CATHEDRAL_WARD, collision="h000100", navmesh="n000100")


def bloodborne_msb_class() -> type:
    return PROFILES["bloodborne"].msb_class()


def test_soulstruct_alone_turns_the_file_down(layout: bytes) -> None:
    with pytest.raises(Exception):
        bloodborne_msb_class().from_bytes(layout)


def test_relaxed_reading_reads_every_part(layout: bytes) -> None:
    relaxed: Counter[str] = Counter()
    with lenient_layout_reading(relaxed):
        msb = bloodborne_msb_class().from_bytes(layout)
    assert relaxed["padding"] == 2 and relaxed["unused"] == 0 and relaxed["dropped"] == 8
    parts = {part.name: part for part in msb.get_parts()}
    assert sorted(parts) == [
        "c0000_0000", "c2800_0000", "c2800_0001", "h000100", "m0000B1", "n000100", "o0500_0000", "o0510_0000"
    ]
    collision = parts["h000100"]
    assert tuple(float(v) for v in collision.translate) == (5.0, 0.0, 0.0)
    assert tuple(float(v) for v in collision.rotate) == (0.0, 90.0, 0.0)
    assert collision.attached_lantern == 2400950
    assert [(t.treasure_part.name, t.item_lot_1) for t in msb.treasures] == [
        ("o0500_0000", fixtures.ITEM_LOTS[0]),
        ("o0510_0000", fixtures.ITEM_LOTS[2]),
    ]
    # Soulstruct's own checks are back.
    with pytest.raises(Exception):
        bloodborne_msb_class().from_bytes(layout)


def test_load_msb_says_it_relaxed(layout: bytes, tmp_path) -> None:
    path = tmp_path / f"{fixtures.CATHEDRAL_WARD}.msb.dcx"
    fixtures.write_dcx(path, layout)
    area = Area(id=fixtures.CATHEDRAL_WARD, name="Cathedral Ward", msb=path, map_folder=None)
    notes: list[str] = []
    msb = load_msb(PROFILES["bloodborne"], area, notes)
    assert len(notes) == 1 and notes[0].startswith("read with relaxed checks")
    summary = summarize(PROFILES["bloodborne"], area, msb)
    assert summary.parts_total == 8 and summary.treasures == 2


def test_a_file_soulstruct_reads_is_read_as_before(dsr_folder) -> None:
    profile = PROFILES[DSR]
    path = next((dsr_folder / "map" / "MapStudio").glob("*.msb"))
    notes: list[str] = []
    load_msb(profile, Area(id=path.stem, name="Made-up", msb=path, map_folder=None), notes)
    assert notes == []
