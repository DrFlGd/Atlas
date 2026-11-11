"""What an area's MSB (map layout) file holds: parts by type, treasure events and the item lots they give,
bonfire or lamp candidates, and the range of part positions."""

from __future__ import annotations

import typing as tp
from collections import Counter, defaultdict
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


def load_msb(profile: GameProfile, area: Area) -> tp.Any:
    return profile.msb_class().from_path(area.msb)


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
