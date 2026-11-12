"""What goes on an area's map, from its MSB map layout, its event script and the game-wide data (content.py):
bonfires, world pickups (treasure), bosses, NPCs and enemies with a one-time guaranteed drop. No regular enemies.

Every marker gets a stable id from the area and the part it stands on (`m10_01.o5010_0007.l1`), so a later
"make again" keeps found marks. Positions are the parts' own positions, in the area's coordinates.
"""

from __future__ import annotations

import re
import typing as tp
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .config import area_key
from .content import GameContent, Lot, LotItem
from .detect import descend, files_matching
from .games import Area

Vector = tuple[float, float, float]

# The order of importance of item categories: a pickup with several items is filed under its most important one.
CATEGORY_PRIORITY = ("ring", "weapon", "armour", "spell", "key", "upgrade", "other", "consumable", "souls")
CATEGORIES = frozenset(CATEGORY_PRIORITY)


@dataclass
class Marker:
    key: str  # stable local id (area, part, and which lot)
    kind: str  # bonfire | boss | npc | drop | item
    category: str  # bonfire | boss | npc | drop | weapon | armour | ring | spell | key | upgrade | consumable | souls | other
    name: str
    position: Vector
    part: str
    flag: int | None = None
    items: tuple[LotItem, ...] = ()
    note: str | None = None
    # Filled in later: the place name under the marker, its floor, and whether a floor was found under it.
    place_id: int | None = None
    floor: int | None = None
    on_floor: bool = False
    pixel: tuple[float, float] | None = None


@dataclass
class CollisionPart:
    name: str
    model: str | None
    position: Vector
    rotation: Vector
    place_id: int  # PlaceNames id, -1 for the area's own name
    attached_bonfire: int


@dataclass
class AreaContent:
    markers: list[Marker] = field(default_factory=list)
    collisions: dict[str, CollisionPart] = field(default_factory=dict)
    # Geometry placement: model -> [(position, rotation)], and the parts' names in the same order.
    instances: dict[str, list[tuple[Vector, Vector]]] = field(default_factory=dict)
    part_names: dict[str, list[str]] = field(default_factory=dict)
    report: dict[str, tp.Any] = field(default_factory=dict)


def _vector(value: tp.Any) -> Vector:
    try:
        return float(value.x), float(value.y), float(value.z)
    except AttributeError:
        x, y, z = value
        return float(x), float(y), float(z)


def _kind(part: tp.Any) -> str:
    name = type(part).__name__
    return name[3:] if name.startswith("MSB") else name


def _model(part: tp.Any) -> str | None:
    model = getattr(part, "model", None)
    return getattr(model, "name", None) if model is not None else None


def _model_number(model: str | None) -> int | None:
    if not model:
        return None
    match = re.fullmatch(r"[a-z](\d+)", model.lower())
    return int(match.group(1)) if match else None


def safe_key(text: str) -> str:
    """A part name as an id piece: ASCII letters, digits, `_`, `.` and `-`, starting with a letter or digit."""
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", text.encode("ascii", "ignore").decode()).strip("-.")
    if not cleaned or not cleaned[0].isalnum():
        cleaned = "p" + cleaned
    return cleaned


def item_category(item: LotItem, content: GameContent, config: dict[str, tp.Any]) -> str:
    rules = config.get("items", {})

    def ranged(key: str) -> str | None:
        for first, last, category in rules.get(key, []):
            if first <= item.id <= last and category in CATEGORIES:
                return category
        return None

    if item.kind == "weapon":
        return ranged("weaponRanges") or "weapon"
    if item.kind == "armour":
        return "armour"
    if item.kind == "ring":
        return "ring"
    found = ranged("goodsRanges")
    if found:
        return found
    goods_type = content.goods_types.get(item.id)
    if goods_type is not None:
        category = rules.get("goodsTypes", {}).get(str(goods_type))
        return category if category in CATEGORIES else "other"
    return ranged("fallbackGoodsRanges") or "other"


def item_name(item: LotItem, content: GameContent) -> str:
    name = content.item_name(item.kind, item.id)
    if not name:
        name = f"Unknown {item.kind} {item.id}"
    return f"{name} ×{item.count}" if item.count > 1 else name


def lot_label(lot: Lot, content: GameContent, config: dict[str, tp.Any]) -> tuple[str, str]:
    """A pickup's name (its most important item first) and its category."""
    ranked = sorted(
        lot.items, key=lambda item: CATEGORY_PRIORITY.index(item_category(item, content, config))
    )
    first = ranked[0]
    name = item_name(first, content)
    if len(ranked) > 1:
        name += f" and {len(ranked) - 1} more"
    return name, item_category(first, content, config)


def read_bonfire_registrations(root: Path, area: Area) -> tuple[list[tuple[int, int]], dict[str, tp.Any]]:
    """The bonfires an area's event script registers (`RegisterBonfire(flag, obj)`, instruction 2009:3), as
    (flag, object entity id) pairs, also when the call is in an event run with arguments."""
    folder = descend(root, "event")
    files = files_matching(folder, re.escape(area.id) + r"\.emevd(\.dcx)?")
    info: dict[str, tp.Any] = {"file": None}
    if not files:
        info["error"] = f"no event/{area.id}.emevd.dcx"
        return [], info
    info["file"] = f"event/{files[0].name}"
    try:
        from soulstruct.darksouls1r.events import EMEVD

        emevd = EMEVD.from_path(files[0])
    except Exception as error:
        info["error"] = f"{type(error).__name__}: {str(error).strip()[:200]}"
        return [], info
    found: list[tuple[int, int]] = []
    # Events whose RegisterBonfire takes its flag or object from the event's arguments: event id -> byte offsets
    # of (flag, object) in the event's arguments, or None where the instruction holds the value itself.
    parametrized: dict[int, list[tuple[tp.Any, tp.Any, int | None, int | None]]] = defaultdict(list)
    calls: list[tuple[int, list[tp.Any]]] = []
    for event_id, event in emevd.events.items():
        for instruction in event.instructions:
            category, index = int(instruction.category), int(instruction.index)
            args = list(instruction.args_list)
            if (category, index) == (2000, 0) and len(args) >= 2:  # RunEvent(slot, event_id, *args)
                calls.append((int(args[1]), args[2:]))
            if (category, index) != (2009, 3) or len(args) < 2:
                continue
            replaced = {int(r.write_offset): int(r.read_offset) for r in instruction.event_arg_replacements}
            if replaced:
                parametrized[int(event_id)].append((args[0], args[1], replaced.get(0), replaced.get(4)))
            else:
                found.append((int(args[0]), int(args[1])))
    for event_id, call_args in calls:
        for flag, obj, flag_offset, obj_offset in parametrized.get(event_id, []):
            try:
                if flag_offset is not None:
                    flag = call_args[flag_offset // 4]
                if obj_offset is not None:
                    obj = call_args[obj_offset // 4]
                found.append((int(flag), int(obj)))
            except (IndexError, TypeError, ValueError):
                continue
    info["registered"] = len(found)
    return sorted(set(found)), info


def extract_area(
    area: Area,
    msb: tp.Any,
    root: Path,
    content: GameContent,
    config: dict[str, tp.Any],
    bonfire_models: set[str] | None = None,
) -> AreaContent:
    """The markers of one area, and how its geometry is placed. `bonfire_models` collects the models of bonfire
    objects confirmed by event scripts (for the fallback in areas without a usable script)."""
    result = AreaContent()
    report = result.report
    key = area_key(area.id)
    parts = list(msb.get_parts())
    used_keys: Counter[str] = Counter()

    def unique(base: str) -> str:
        used_keys[base] += 1
        return base if used_keys[base] == 1 else f"{base}.{used_keys[base]}"

    objects_by_entity: dict[int, tp.Any] = {}
    characters = []
    moved = 0
    instances: dict[str, list[tuple[Vector, Vector]]] = defaultdict(list)
    part_names: dict[str, list[str]] = defaultdict(list)
    for part in parts:
        kind = _kind(part)
        model = _model(part)
        position = _vector(part.translate)
        rotation = _vector(getattr(part, "rotate", (0.0, 0.0, 0.0)))
        if model and kind in ("Collision", "Navmesh"):
            if (position, rotation) not in instances[model]:
                instances[model].append((position, rotation))
                part_names[model].append(part.name)
        if kind == "Collision":
            result.collisions[part.name] = CollisionPart(
                part.name,
                model,
                position,
                rotation,
                int(getattr(part, "place_name_banner_id", -1)),
                int(getattr(part, "attached_bonfire", 0) or 0),
            )
            if any(abs(v) > 1e-4 for v in position + rotation):
                moved += 1
        elif kind == "Object":
            entity = int(getattr(part, "entity_id", -1) or -1)
            if entity > 0:
                objects_by_entity[entity] = part
        elif kind == "Character":
            characters.append(part)
    result.instances = dict(instances)
    result.part_names = dict(part_names)
    report["collisionParts"] = {"total": len(result.collisions), "movedOrTurned": moved}

    # --- Bonfires
    registrations, bonfire_info = read_bonfire_registrations(root, area)
    names = config.get("bonfireNames", {})
    bonfires: list[tuple[tp.Any, int | None]] = []
    missing_objects = []
    for flag, entity in registrations:
        part = objects_by_entity.get(entity)
        if part is None:
            missing_objects.append(entity)
            continue
        bonfires.append((part, flag))
        if bonfire_models is not None and _model(part):
            bonfire_models.add(_model(part))
    method = "event script (RegisterBonfire)"
    if not registrations:
        # No script, or none registered: objects that collisions name as their bonfire, then objects of a model
        # that event scripts elsewhere confirmed as a bonfire.
        attached = {c.attached_bonfire for c in result.collisions.values() if c.attached_bonfire > 0}
        chosen = {objects_by_entity[e].name: objects_by_entity[e] for e in attached if e in objects_by_entity}
        if bonfire_models:
            for part in objects_by_entity.values():
                if _model(part) in bonfire_models:
                    chosen.setdefault(part.name, part)
        bonfires = [(part, None) for part in chosen.values()]
        method = "fallback: objects named by collisions or of a confirmed bonfire model"
    for part, flag in bonfires:
        entity = int(getattr(part, "entity_id", -1) or -1)
        name = names.get(str(entity)) or (names.get(str(flag)) if flag else None) or ""
        result.markers.append(
            Marker(
                key=unique(f"{key}.bonfire.{entity if entity > 0 else safe_key(part.name)}"),
                kind="bonfire",
                category="bonfire",
                name=name,  # filled from the place name later when empty
                position=_vector(part.translate),
                part=part.name,
                flag=flag if flag and flag > 0 else None,
            )
        )
    report["bonfires"] = {
        "method": method,
        **bonfire_info,
        "placed": len(bonfires),
        "objectsNotFound": missing_objects[:20],
    }

    # --- Treasure
    lots_referenced: set[int] = set()
    lots_missing: set[int] = set()
    lots_empty: set[int] = set()
    by_part_kind: Counter[str] = Counter()
    treasures = list(getattr(msb, "treasures", []))
    for treasure in treasures:
        part = getattr(treasure, "treasure_part", None)
        if part is None:
            by_part_kind["none"] += 1
            continue
        by_part_kind[_kind(part)] += 1
        notes = []
        if getattr(treasure, "is_in_chest", False):
            notes.append("In a chest.")
        if getattr(treasure, "is_hidden", False):
            notes.append("Appears later in the game.")
        for slot in range(1, 6):
            lot_id = getattr(treasure, f"item_lot_{slot}", -1)
            if not isinstance(lot_id, int) or lot_id <= 0:
                continue
            lots_referenced.add(lot_id)
            lot = content.lots.get(lot_id)
            marker_key = unique(f"{key}.{safe_key(part.name)}.l{slot}")
            if lot is None:
                lots_missing.add(lot_id)
                continue
            if not lot.items:
                lots_empty.add(lot_id)
                continue
            name, category = lot_label(lot, content, config)
            result.markers.append(
                Marker(
                    key=marker_key,
                    kind="item",
                    category=category,
                    name=name,
                    position=_vector(part.translate),
                    part=part.name,
                    flag=lot.flag if lot.flag > 0 else None,
                    items=lot.items,
                    note=" ".join(notes) or None,
                )
            )
    report["treasure"] = {
        "events": len(treasures),
        "partKinds": dict(sorted(by_part_kind.items())),
        "lotsReferenced": len(lots_referenced),
        "lotsFound": len(lots_referenced - lots_missing),
        "lotsEmpty": len(lots_empty),
        "lotsMissing": missing_lot_diagnosis(sorted(lots_missing), content),
    }

    # --- Characters: bosses, NPCs and enemies with a one-time guaranteed drop
    ignore = set(config.get("characters", {}).get("ignoreModels", []))
    bosses_here = [b for b in config.get("bosses", []) if key in b.get("areas", [key])]
    boss_parts: dict[int, list[tp.Any]] = defaultdict(list)
    counts: Counter[str] = Counter()
    for part in characters:
        number = _model_number(_model(part))
        if number in ignore:
            counts["ignored"] += 1
            continue
        boss_index = next((i for i, b in enumerate(bosses_here) if number in b.get("models", [])), None)
        if boss_index is not None:
            boss_parts[boss_index].append(part)
            continue
        character_id = int(getattr(part, "character_id", -1) or -1)
        talk_id = int(getattr(part, "talk_id", 0) or 0)
        if talk_id > 0:
            counts["npc"] += 1
            result.markers.append(
                Marker(
                    key=unique(f"{key}.{safe_key(part.name)}"),
                    kind="npc",
                    category="npc",
                    name=content.npc_name(character_id) or model_name(_model(part)) or "Character",
                    position=_vector(part.translate),
                    part=part.name,
                )
            )
            continue
        npc = content.npcs.get(character_id)
        if npc is None:
            counts["enemy"] += 1
            continue
        dropped = False
        for slot, lot_id in enumerate(npc.item_lots, start=1):
            lot = content.lots.get(lot_id) if lot_id > 0 else None
            if lot is None or lot.flag <= 0 or not lot.guaranteed:
                continue
            item, _ = lot_label(lot, content, config)
            who = content.npc_name(character_id) or model_name(_model(part)) or "Enemy"
            result.markers.append(
                Marker(
                    key=unique(f"{key}.{safe_key(part.name)}.d{slot}"),
                    kind="drop",
                    category="drop",
                    name=f"{who}: {item}",
                    position=_vector(part.translate),
                    part=part.name,
                    flag=lot.flag,
                    items=lot.items,
                    note="Dropped once, always, when defeated.",
                )
            )
            dropped = True
        counts["guaranteedDrop" if dropped else "enemy"] += 1
    for index, found in sorted(boss_parts.items()):
        boss = bosses_here[index]
        part = next((p for p in found if int(getattr(p, "entity_id", -1) or -1) > 0), found[0])
        flag = boss.get("flag")
        result.markers.append(
            Marker(
                key=unique(f"{key}.boss.{safe_key(boss['name']).lower()}"),
                kind="boss",
                category="boss",
                name=str(boss["name"]),
                position=_vector(part.translate),
                part=part.name,
                flag=int(flag) if isinstance(flag, int) and flag > 0 else None,
            )
        )
    report["characters"] = {
        "total": len(characters),
        "bosses": len(boss_parts),
        "bossesExpected": len(bosses_here),
        "bossesNotFound": [b["name"] for i, b in enumerate(bosses_here) if i not in boss_parts],
        **dict(sorted(counts.items())),
    }
    offsets = list(getattr(msb, "map_offsets", []) or [])
    if offsets:
        offset = offsets[0]
        report["mapOffset"] = {
            "translate": [round(v, 2) for v in _vector(getattr(offset, "translate", (0.0, 0.0, 0.0)))],
            "rotateY": round(float(getattr(offset, "rotate_y", 0.0) or 0.0), 2),
        }
    return result


def model_name(model: str | None) -> str | None:
    """A character model's name from Soulstruct's table (names only), e.g. `c2510` -> Undead Merchant."""
    number = _model_number(model)
    if number is None:
        return None
    try:
        from soulstruct.darksouls1ptde.constants import CHARACTER_MODELS
    except Exception:  # pragma: no cover
        return None
    name = CHARACTER_MODELS.get(number)
    if not isinstance(name, str):
        return None
    return re.sub(r"\s*\([^)]*\)$", "", name) or None


def missing_lot_diagnosis(missing: list[int], content: GameContent) -> dict[str, tp.Any]:
    """Why referenced item lots are not in the table: how many have a row a little before or after them (a lot
    chain), and a few of their ids. Numbers only."""
    if not missing:
        return {"count": 0}
    rows = content.lots
    near_after = sum(1 for lot in missing if any((lot + n) in rows for n in range(1, 10)))
    near_before = sum(1 for lot in missing if any((lot - n) in rows for n in range(1, 10)))
    return {
        "count": len(missing),
        "rowWithin9After": near_after,
        "rowWithin9Before": near_before,
        "tableEmpty": not rows,
        "examples": missing[:12],
    }
