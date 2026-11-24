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


def test_an_entry_that_cannot_be_read_is_left_out_and_the_rest_still_read(layout: bytes, tmp_path, monkeypatch) -> None:
    from soulstruct.bloodborne.maps.parts import MSBCharacter

    original = MSBCharacter.from_msb_reader.__func__
    calls = {"n": 0}

    def failing_once(cls, reader):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("made-up bad value")
        return original(cls, reader)

    monkeypatch.setattr(MSBCharacter, "from_msb_reader", classmethod(failing_once))
    path = tmp_path / f"{fixtures.CATHEDRAL_WARD}.msb.dcx"
    fixtures.write_dcx(path, layout)
    area = Area(id=fixtures.CATHEDRAL_WARD, name="Cathedral Ward", msb=path, map_folder=None)
    notes: list[str] = []
    msb = load_msb(PROFILES["bloodborne"], area, notes)
    assert len(notes) == 1
    assert "entries that could not be read were left out: 1 parts" in notes[0]
    assert "ValueError: made-up bad value (a part at byte " in notes[0]
    summary = summarize(PROFILES["bloodborne"], area, msb)
    # One character fewer; the treasures still point at their own parts.
    assert summary.parts_total == 7 and summary.treasures == 2
    assert [t.treasure_part.name for t in msb.treasures] == ["o0500_0000", "o0510_0000"]


def test_a_layout_the_relaxed_reading_turns_down_says_why(layout: bytes, tmp_path, monkeypatch) -> None:
    from atlas_gamefiles.msb import LayoutUnreadable

    msb_class = bloodborne_msb_class()

    def broken(cls, entry_lists):
        raise RuntimeError("made-up failure after reading")

    monkeypatch.setattr(msb_class, "_dereference_msb_entries", classmethod(broken))
    path = tmp_path / f"{fixtures.CATHEDRAL_WARD}.msb.dcx"
    fixtures.write_dcx(path, layout)
    area = Area(id=fixtures.CATHEDRAL_WARD, name="Cathedral Ward", msb=path, map_folder=None)
    with pytest.raises(LayoutUnreadable) as caught:
        load_msb(PROFILES["bloodborne"], area, [])
    message = str(caught.value)
    assert message.startswith("read with relaxed checks: RuntimeError: made-up failure after reading; with Soulstruct's checks: ")
    assert len(message) < 400
