"""Game-wide data a map needs, read in full for `make`: what each item lot gives (and its "picked up" flag), what
kind of item each goods row is, the characters' names and drops, and the game's own text (item names and
descriptions, place names, character names).

Dark Souls Remastered only for now. Nothing here is written anywhere but into the player's own pack and report:
the report holds counts, ids and error messages, never text.
"""

from __future__ import annotations

import time
import typing as tp
from dataclasses import dataclass, field
from pathlib import Path

from .detect import descend
from .games import GameProfile, entry_basename

# ItemLotParam's item categories (lotItemCategoryNN).
WEAPON, ARMOUR, RING, GOODS = 0, 0x10000000, 0x20000000, 0x40000000
KIND_OF_CATEGORY = {WEAPON: "weapon", ARMOUR: "armour", RING: "ring", GOODS: "goods"}

# The game's text tables in item.msgbnd.dcx, by binder entry id (base, patch). The patch tables of Dark Souls
# Remastered hold the text added or changed after release, and win over the base tables.
TEXT_TABLES = {
    "goodsNames": (10, 111),
    "weaponNames": (11, 115),
    "armourNames": (12, 117),
    "ringNames": (13, 113),
    "spellNames": (14, 118),
    "npcNames": (18, 119),
    "placeNames": (19, 120),
    "goodsSummaries": (20, 110),
    "weaponSummaries": (21, 114),
    "armourSummaries": (22, 116),
    "ringSummaries": (23, 112),
    "goodsDescriptions": (24, 100),
    "weaponDescriptions": (25, 106),
    "armourDescriptions": (26, 108),
    "ringDescriptions": (27, 109),
}
NAME_TABLES = {"weapon": "weaponNames", "armour": "armourNames", "ring": "ringNames", "goods": "goodsNames"}
DESCRIPTION_TABLES = {
    "weapon": ("weaponDescriptions", "weaponSummaries"),
    "armour": ("armourDescriptions", "armourSummaries"),
    "ring": ("ringDescriptions", "ringSummaries"),
    "goods": ("goodsDescriptions", "goodsSummaries"),
}


@dataclass(frozen=True)
class LotItem:
    kind: str  # weapon | armour | ring | goods
    id: int
    count: int
    chance: int  # chance points (relative)


@dataclass(frozen=True)
class Lot:
    id: int
    items: tuple[LotItem, ...]
    flag: int  # set when the lot is picked up (0: none)
    # Chance points that give nothing: a lot with none always gives its items.
    nothing_chance: int

    @property
    def guaranteed(self) -> bool:
        return bool(self.items) and self.nothing_chance == 0


@dataclass
class Npc:
    name_id: int
    item_lots: tuple[int, ...]


@dataclass
class GameContent:
    lots: dict[int, Lot] = field(default_factory=dict)
    goods_types: dict[int, int] = field(default_factory=dict)
    npcs: dict[int, Npc] = field(default_factory=dict)
    text: dict[str, dict[int, str]] = field(default_factory=dict)
    # What was read, for the report: per table, ok / rows / error.
    sources: dict[str, dict[str, tp.Any]] = field(default_factory=dict)
    seconds: float = 0.0

    def item_name(self, kind: str, item_id: int) -> str | None:
        table = self.text.get(NAME_TABLES[kind], {})
        name = table.get(item_id)
        if name:
            return name
        if kind == "goods":
            return self.text.get("spellNames", {}).get(item_id) or None
        if kind == "weapon":
            # Upgraded and infused weapons: the base name, with the level.
            level = item_id % 100
            base = table.get(item_id - level)
            if base:
                return f"{base} +{level}" if level else base
            base = table.get(item_id - item_id % 1000)
            if base:
                return base
        if kind == "armour":
            base = table.get(item_id - item_id % 100)
            if base:
                return base
        return None

    def item_description(self, kind: str, item_id: int) -> str | None:
        for table in DESCRIPTION_TABLES[kind]:
            text = self.text.get(table, {}).get(item_id)
            if text:
                return text
        if kind == "weapon":
            for table in DESCRIPTION_TABLES[kind]:
                text = self.text.get(table, {}).get(item_id - item_id % 100)
                if text:
                    return text
        return None

    def npc_name(self, character_id: int) -> str | None:
        npc = self.npcs.get(character_id)
        if npc is None or npc.name_id <= 0:
            return None
        return self.text.get("npcNames", {}).get(npc.name_id) or None

    def place_name(self, place_id: int) -> str | None:
        if place_id < 0:
            return None
        return self.text.get("placeNames", {}).get(place_id) or None

    def to_report(self) -> dict[str, tp.Any]:
        return {
            "seconds": round(self.seconds, 2),
            "sources": self.sources,
            "textTables": {name: len(table) for name, table in sorted(self.text.items())},
        }


def _error(error: BaseException) -> str:
    text = str(error).strip().splitlines()
    return f"{type(error).__name__}: {text[0][:300]}" if text else type(error).__name__


def clean_text(text: str | None) -> str | None:
    """Game text tidied for a pack: no carriage returns, no blank padding; None when empty."""
    if not text:
        return None
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text or text in ("%null%", "[]"):
        return None
    return text


def _lot_from_row(lot_id: int, row: tp.Any) -> Lot:
    items: list[LotItem] = []
    nothing = 0
    for slot in range(1, 9):
        item_id = int(getattr(row, f"Item{slot}ID", 0) or 0)
        category = int(getattr(row, f"Item{slot}Category", 0) or 0)
        chance = int(getattr(row, f"Item{slot}ChancePoints", 0) or 0)
        count = int(getattr(row, f"Item{slot}Count", 0) or 0)
        kind = KIND_OF_CATEGORY.get(category & 0xF0000000) if category >= 0 else None
        if item_id <= 0 or kind is None:
            nothing += chance
            continue
        items.append(LotItem(kind, item_id, max(count, 1), chance))
    if any(item.chance > 0 for item in items):
        items = [item for item in items if item.chance > 0]
    return Lot(lot_id, tuple(items), int(getattr(row, "ItemFlag", 0) or 0), nothing)


def read_content(profile: GameProfile, root: Path) -> GameContent:
    """Everything `make` needs from the param and text files. A table that cannot be read is recorded and left
    empty: the map is still made, with fewer names."""
    started = time.monotonic()
    content = GameContent()
    _read_params(profile, root, content)
    _read_text(profile, root, content)
    content.seconds = time.monotonic() - started
    return content


def _read_params(profile: GameProfile, root: Path, content: GameContent) -> None:
    path = descend(root, *profile.param_path)
    wanted = {
        "itemlotparam": "ItemLotParam",
        "equipparamgoods": "EquipParamGoods",
        "npcparam": "NpcParam",
    }
    if path is None:
        for name in wanted.values():
            content.sources[name] = {"ok": False, "error": f"{'/'.join(profile.param_path)} not found"}
        return
    try:
        from soulstruct.base.params.param import TypedParam
        from soulstruct.containers import Binder

        if profile.game == "dark-souls-remastered":
            from soulstruct.darksouls1r.params.paramdef import EQUIP_PARAM_GOODS_ST, ITEMLOT_PARAM_ST, NPC_PARAM_ST
        else:  # pragma: no cover - Bloodborne maps come later
            from soulstruct.bloodborne.params.paramdef import EQUIP_PARAM_GOODS_ST, ITEMLOT_PARAM_ST, NPC_PARAM_ST

        binder = Binder.from_path(path)
    except Exception as error:
        for name in wanted.values():
            content.sources[name] = {"ok": False, "error": _error(error)}
        return
    entries = {entry_basename(e.path or "").lower().split(".")[0]: e for e in binder.entries}
    row_types = {"ItemLotParam": ITEMLOT_PARAM_ST, "EquipParamGoods": EQUIP_PARAM_GOODS_ST, "NpcParam": NPC_PARAM_ST}
    for key, name in wanted.items():
        entry = entries.get(key)
        if entry is None:
            content.sources[name] = {"ok": False, "error": f"no {name} in the param file"}
            continue
        try:
            param = TypedParam(row_types[name]).from_bytes(entry.data)
            rows = param.rows
            if name == "ItemLotParam":
                content.lots = {int(lot_id): _lot_from_row(int(lot_id), row) for lot_id, row in rows.items()}
            elif name == "EquipParamGoods":
                content.goods_types = {int(i): int(getattr(row, "GoodType", 0) or 0) for i, row in rows.items()}
            else:
                content.npcs = {
                    int(i): Npc(
                        int(getattr(row, "NameID", 0) or 0),
                        tuple(int(getattr(row, f"ItemLotID{n}", -1) or -1) for n in range(1, 7)),
                    )
                    for i, row in rows.items()
                }
            content.sources[name] = {"ok": True, "rows": len(rows)}
        except Exception as error:
            content.sources[name] = {"ok": False, "error": _error(error)}


def _read_text(profile: GameProfile, root: Path, content: GameContent) -> None:
    path = descend(root, *profile.text_path)
    if path is None:
        content.sources["itemText"] = {"ok": False, "error": f"{'/'.join(profile.text_path)} not found"}
        return
    try:
        from soulstruct.base.text.fmg import FMG
        from soulstruct.containers import Binder

        binder = Binder.from_path(path)
        by_id: dict[int, dict[int, str]] = {}
        for entry in binder.entries:
            if not entry_basename(entry.path or "").lower().endswith(".fmg"):
                continue
            fmg = FMG.from_bytes(entry.data)
            table = by_id.setdefault(int(entry.entry_id), {})
            for text_id, text in fmg.entries.items():
                cleaned = clean_text(text)
                if cleaned:
                    table[int(text_id)] = cleaned
        for name, (base, patch) in TEXT_TABLES.items():
            merged = dict(by_id.get(base, {}))
            merged.update(by_id.get(patch, {}))
            content.text[name] = merged
        content.sources["itemText"] = {"ok": True, "tables": len(by_id)}
    except Exception as error:
        content.sources["itemText"] = {"ok": False, "error": _error(error)}
