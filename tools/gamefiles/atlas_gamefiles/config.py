"""The per-game config files in `tools/gamefiles/config/` (bundled into the single-file helper): area names, floor
tuning and names, the boss table, bonfire names and the item category rules. Names and numbers only."""

from __future__ import annotations

import json
import sys
import typing as tp
from pathlib import Path


def config_folder() -> Path:
    bundle = getattr(sys, "_MEIPASS", None)
    if getattr(sys, "frozen", False) and bundle:
        return Path(bundle) / "config"
    return Path(__file__).resolve().parent.parent / "config"


def load_config(game: str, override: Path | None = None) -> dict[str, tp.Any]:
    """The config of `game`, or the file `override` (for tuning by hand)."""
    path = override if override is not None else config_folder() / f"{game}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} is not a JSON object")
    return data


def area_key(area_id: str) -> str:
    """`m10_01_00_00` -> `m10_01`, the key the config uses."""
    return area_id[:6]


def area_config(config: dict[str, tp.Any], area_id: str) -> dict[str, tp.Any]:
    value = config.get("areas", {}).get(area_key(area_id), {})
    return value if isinstance(value, dict) else {}


def floor_overrides(config: dict[str, tp.Any], area_id: str) -> dict[str, tp.Any]:
    value = config.get("floorOverrides", {}).get(area_key(area_id), {})
    return value if isinstance(value, dict) else {}


def is_skipped(config: dict[str, tp.Any], area_id: str) -> bool:
    return any(area_id.startswith(prefix) for prefix in config.get("skipAreas", []))
