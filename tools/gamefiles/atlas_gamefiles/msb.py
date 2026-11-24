"""What an area's MSB (map layout) file holds: parts by type, treasure events and the item lots they give,
bonfire or lamp candidates, and the range of part positions."""

from __future__ import annotations

import typing as tp
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field

import numpy as np

from .detect import DSR
from .games import Area, GameProfile


# Parts that carry geometry: their position is often the origin, with the model's own coordinates.
GEOMETRY_KINDS = frozenset({"MapPiece", "Collision", "Navmesh", "ConnectCollision"})


@dataclass
class Placement:
    kind: str  # part type, e.g. "Character", or "Treasure" for a treasure event's part
    name: str
    model: str | None
    position: tuple[float, float, float]
    rotation: tuple[float, float, float]


@dataclass
class MsbSummary:
    parts: dict[str, int]
    parts_total: int
    treasures: int
    item_lots: set[int]
    bonfires: dict[str, tp.Any]
    bounds: dict[str, list[float]] | None
    # The same, without the parts that carry geometry (see GEOMETRY_KINDS).
    point_bounds: dict[str, list[float]] | None
    placements: list[Placement]
    # Model name -> transforms (position, rotation in degrees) of the parts that place it, for geometry.
    instances: dict[str, list[tuple[tuple[float, float, float], tuple[float, float, float]]]] = field(
        default_factory=dict
    )
    notes: list[str] = field(default_factory=list)


def _vector(value: tp.Any) -> tuple[float, float, float]:
    try:
        return float(value.x), float(value.y), float(value.z)
    except AttributeError:
        x, y, z = value
        return float(x), float(y), float(z)


def _part_kind(part: tp.Any) -> str:
    name = type(part).__name__
    return name[3:] if name.startswith("MSB") else name


def _model_name(part: tp.Any) -> str | None:
    model = getattr(part, "model", None)
    return getattr(model, "name", None) if model is not None else None


def load_msb(profile: GameProfile, area: Area, notes: list[str] | None = None) -> tp.Any:
    """The area's map layout. Read with Soulstruct's checks first; a file they turn down is read again with them
    relaxed (lenient_layout_reading), and `notes` says so. Real Bloodborne files need that: they hold small values
    in bytes Soulstruct expects blank, Soulstruct's check of absent data blocks measures from the start of the file
    rather than the entry (so it turns down every such entry after the first), and its Bloodborne parts read an
    `instance_index` they have no field for. Nothing Atlas uses is in those values."""
    msb_class = profile.msb_class()
    try:
        return msb_class.from_path(area.msb)
    except Exception as strict_error:
        relaxed: Counter[str] = Counter()
        try:
            with lenient_layout_reading(relaxed):
                msb = msb_class.from_path(area.msb)
        except Exception:
            raise strict_error
        if notes is not None:
            notes.append(lenient_note(relaxed))
        return msb


def lenient_note(relaxed: Counter[str]) -> str:
    counts = [
        (relaxed["padding"], "in bytes expected blank"),
        (relaxed["unused"], "data blocks expected absent"),
        (relaxed["dropped"], "with no field to hold them"),
    ]
    found = "; ".join(f"{count} {what}" for count, what in counts if count) or "none"
    return f"read with relaxed checks, past values Atlas does not use: {found}"


_INIT_FIELDS: dict[type, frozenset[str] | None] = {}


def _init_fields(cls: type) -> frozenset[str] | None:
    """The names an entry type's constructor takes, or None when it is not a dataclass (then nothing is dropped)."""
    if cls not in _INIT_FIELDS:
        import dataclasses

        _INIT_FIELDS[cls] = (
            frozenset(f.name for f in dataclasses.fields(cls) if f.init) if dataclasses.is_dataclass(cls) else None
        )
    return _INIT_FIELDS[cls]


@contextmanager
def lenient_layout_reading(relaxed: Counter[str]) -> tp.Iterator[None]:
    """For the duration: blank-byte (`_pad`) fields accept any value; an entry's data block that Soulstruct expects
    to be absent is checked by its offset within the entry, and skipped (counted) when present rather than refused;
    and a value Soulstruct reads but its entry type has no field for (Bloodborne parts' `instance_index`) is dropped.
    Every other check stays. Soulstruct 2.6 and constrata internals; if they differ, nothing is relaxed."""
    from constrata.metadata import BinaryMetadata
    from soulstruct.base.maps.msb.msb_entry import MSBEntry

    original_validate = BinaryMetadata.__dict__.get("validate")
    original_kwargs = MSBEntry.__dict__.get("reader_to_entry_kwargs")
    if original_validate is None or not isinstance(original_kwargs, classmethod):
        yield
        return

    def validate(self: tp.Any, value: tp.Any) -> None:
        if str(getattr(self, "field_name", "")).startswith("_pad"):
            if getattr(self, "asserted", None) and value not in self.asserted:
                relaxed["padding"] += 1
            return
        original_validate(self, value)

    def reader_to_entry_kwargs(cls: tp.Any, reader: tp.Any, entry_offset: int) -> dict[str, tp.Any]:
        kwargs = cls.HEADER_STRUCT.reader_to_entry_kwargs(reader, cls, entry_offset)
        for struct_name, struct_type in cls.STRUCTS.items():
            try:
                relative = kwargs.pop(f"{struct_name}_offset")
            except KeyError:
                raise ValueError(f"Struct offset not found for `{struct_name}` in `{cls.__name__}`.")
            if struct_type is None:
                if relative != 0:
                    relaxed["unused"] += 1
                continue
            if relative == 0:
                raise ValueError(f"Offset for used struct `{struct_name}` in `{cls.__name__}` is 0.")
            reader.seek(entry_offset + relative)
            kwargs |= struct_type.reader_to_entry_kwargs(reader, cls, entry_offset)
        accepted = _init_fields(cls)
        if accepted is not None:
            for name in [name for name in kwargs if name not in accepted]:
                kwargs.pop(name)
                relaxed["dropped"] += 1
        return kwargs

    BinaryMetadata.validate = validate
    MSBEntry.reader_to_entry_kwargs = classmethod(reader_to_entry_kwargs)
    try:
        yield
    finally:
        BinaryMetadata.validate = original_validate
        MSBEntry.reader_to_entry_kwargs = original_kwargs


def summarize(profile: GameProfile, area: Area, msb: tp.Any) -> MsbSummary:
    parts = list(msb.get_parts())
    counts: Counter[str] = Counter()
    placements: list[Placement] = []
    instances: dict[str, list[tuple[tuple[float, float, float], tuple[float, float, float]]]] = defaultdict(list)
    for part in parts:
        kind = _part_kind(part)
        counts[kind] += 1
        position = _vector(part.translate)
        rotation = _vector(getattr(part, "rotate", (0.0, 0.0, 0.0)))
        model = _model_name(part)
        placements.append(Placement(kind, part.name, model, position, rotation))
        if model:
            instances[model].append((position, rotation))

    item_lots: set[int] = set()
    treasures = list(getattr(msb, "treasures", []))
    for treasure in treasures:
        for index in range(1, 6):
            lot = getattr(treasure, f"item_lot_{index}", None)
            if isinstance(lot, int) and lot > 0:
                item_lots.add(lot)
        part = getattr(treasure, "treasure_part", None)
        if part is not None:
            placements.append(
                Placement("Treasure", treasure.name, _model_name(part), _vector(part.translate), (0.0, 0.0, 0.0))
            )

    bonfires = bonfire_candidates(profile, area, parts)
    for name in bonfires.get("parts", []):
        for placement in placements:
            if placement.name == name and placement.kind != "Treasure":
                placements.append(Placement("Bonfire", name, placement.model, placement.position, (0.0, 0.0, 0.0)))
                break

    part_placements = [p for p in placements if p.kind not in ("Treasure", "Bonfire")]

    return MsbSummary(
        parts=dict(sorted(counts.items())),
        parts_total=len(parts),
        treasures=len(treasures),
        item_lots=item_lots,
        bonfires=bonfires,
        bounds=_bounds(part_placements),
        point_bounds=_bounds([p for p in part_placements if p.kind not in GEOMETRY_KINDS]),
        placements=placements,
        instances=dict(instances),
    )


def _bounds(placements: list[Placement]) -> dict[str, list[float]] | None:
    if not placements:
        return None
    positions = np.array([p.position for p in placements])
    low, high = positions.min(axis=0), positions.max(axis=0)
    return {axis: [round(float(low[i]), 2), round(float(high[i]), 2)] for i, axis in enumerate("xyz")}


def bonfire_candidates(profile: GameProfile, area: Area, parts: list[tp.Any]) -> dict[str, tp.Any]:
    """Parts that may be bonfires (Dark Souls) or lamps (Bloodborne). Unconfirmed: Phase 0 reports what it finds.

    Dark Souls: entity ids in the ranges Soulstruct documents as reserved for bonfires (objects base+1900..1989,
    characters base+900..989, where base is AA*100000 + BB*10000 for map mAA_BB, so 1010000 for m10_01), and the
    distinct bonfire ids that collisions name in `attached_bonfire`.
    Bloodborne: the distinct lamp ids that collisions name in `attached_lantern`.
    """
    if profile.game == DSR:
        base = area.area_number * 100000 + area.block_number * 10000
        objects = [
            p.name
            for p in parts
            if _part_kind(p) == "Object" and base + 1900 <= getattr(p, "entity_id", -1) <= base + 1989
        ]
        characters = [
            p.name
            for p in parts
            if _part_kind(p) == "Character" and base + 900 <= getattr(p, "entity_id", -1) <= base + 989
        ]
        attached = sorted(
            {
                getattr(p, "attached_bonfire", 0)
                for p in parts
                if _part_kind(p) == "Collision" and getattr(p, "attached_bonfire", 0) > 0
            }
        )
        return {
            "count": len(objects),
            "method": "objects with entity ids in the bonfire range (base+1900 to base+1989)",
            "objects": len(objects),
            "characters": len(characters),
            "collisionBonfireIds": len(attached),
            "parts": objects + characters,
        }
    attached = sorted(
        {
            getattr(p, "attached_lantern", 0)
            for p in parts
            if _part_kind(p) == "Collision" and getattr(p, "attached_lantern", 0) > 0
        }
    )
    return {
        "count": len(attached),
        "method": "distinct lamp ids named by collisions (attached_lantern)",
        "collisionLampIds": len(attached),
        "parts": [],
    }
