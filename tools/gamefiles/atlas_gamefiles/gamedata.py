"""Game-wide data the maps will need: the item lot table (what each treasure gives, and its "picked up" flag) and
the item names. Phase 0 only checks that they can be read and counts them."""

from __future__ import annotations

import time
import typing as tp
from dataclasses import dataclass, field
from pathlib import Path

from .detect import descend
from .games import GameProfile, entry_basename


@dataclass
class ItemLots:
    ok: bool = False
    file: str | None = None
    rows: set[int] = field(default_factory=set)
    error: str | None = None
    seconds: float = 0.0

    def to_dict(self) -> dict[str, tp.Any]:
        data: dict[str, tp.Any] = {"ok": self.ok, "file": self.file, "rows": len(self.rows), "seconds": round(self.seconds, 2)}
        if self.error:
            data["error"] = self.error
        return data


@dataclass
class ItemText:
    ok: bool = False
    file: str | None = None
    tables: int = 0
    entries: int = 0
    error: str | None = None

    def to_dict(self) -> dict[str, tp.Any]:
        data: dict[str, tp.Any] = {"ok": self.ok, "file": self.file, "tables": self.tables, "entries": self.entries}
        if self.error:
            data["error"] = self.error
        return data


def _error(error: BaseException) -> str:
    text = str(error).strip().splitlines()
    return f"{type(error).__name__}: {text[0][:300]}" if text else type(error).__name__


def read_item_lots(profile: GameProfile, root: Path) -> ItemLots:
    started = time.monotonic()
    result = ItemLots()
    path = descend(root, *profile.param_path)
    if path is None:
        result.error = f"{'/'.join(profile.param_path)} not found"
        return result
    result.file = "/".join(profile.param_path)
    try:
        from soulstruct.base.params.param import TypedParam
        from soulstruct.containers import Binder

        binder = Binder.from_path(path)
        entry = next(
            (e for e in binder.entries if entry_basename(e.path or "").lower() in ("itemlotparam.param", "itemlotparam")),
            None,
        )
        if entry is None:
            result.error = "no ItemLotParam in the param file"
            return result
        param = TypedParam(profile.item_lot_row_type()).from_bytes(entry.data)
        result.rows = set(param.rows)
        result.ok = True
    except Exception as error:
        result.error = _error(error)
    finally:
        result.seconds = time.monotonic() - started
    return result


def read_item_text(profile: GameProfile, root: Path) -> ItemText:
    result = ItemText()
    path = descend(root, *profile.text_path)
    if path is None:
        result.error = f"{'/'.join(profile.text_path)} not found"
        return result
    result.file = "/".join(profile.text_path)
    try:
        from soulstruct.base.text.fmg import FMG
        from soulstruct.containers import Binder

        binder = Binder.from_path(path)
        for entry in binder.entries:
            if not entry_basename(entry.path or "").lower().endswith(".fmg"):
                continue
            fmg = FMG.from_bytes(entry.data)
            result.tables += 1
            result.entries += sum(1 for text in fmg.entries.values() if text)
        result.ok = result.tables > 0
        if not result.ok:
            result.error = "no text tables (.fmg) in the file"
    except Exception as error:
        result.error = _error(error)
    return result
