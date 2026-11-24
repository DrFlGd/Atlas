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


MAX_CUTS = 32
MAX_NAMES = 33
MAX_NAME = 80
MAX_PASSAGES = 256
FLOOR_METHODS = ("passages", "cuts")
# The floor cuts file (floor-overrides.json): version 2 adds `version`, and per area `method` and `passages`.
# Version 1 files (no `version`) still load.
FLOOR_OVERRIDES_VERSION = 2


def floor_method(config: dict[str, tp.Any], overrides: dict[str, tp.Any] | None = None, asked: str | None = None) -> str:
    """How an area's floors are found: the area's own choice (its floor overrides' `method`), else the one asked
    for this make, else the config's (`floors.method`), else cuts."""
    for value in ((overrides or {}).get("method"), asked, (config.get("floors") or {}).get("method")):
        if value in FLOOR_METHODS:
            return str(value)
    return "cuts"


def _number(value: tp.Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and abs(float(value)) < 100_000:
        return float(value)
    return None


def clean_floor_entry(value: tp.Any) -> dict[str, tp.Any] | None:
    """One area's floor overrides as the player's own file gives them, kept to what floors.py and passages.py read:
    `cuts`, `splitAt` and `mergeAt` (heights in metres), `names` (lowest first), `method` (passages or cuts) and
    `passages` (`[{x, z, show}]`: which storey to show on the main floor, upper or lower, in the overlapping place
    at x, z). None when nothing usable is left."""
    if not isinstance(value, dict):
        return None
    entry: dict[str, tp.Any] = {}
    if value.get("method") in FLOOR_METHODS:
        entry["method"] = value["method"]
    passages = value.get("passages")
    if isinstance(passages, list):
        kept_passages = []
        for item in passages[:MAX_PASSAGES]:
            if not isinstance(item, dict) or item.get("show") not in ("upper", "lower"):
                continue
            x, z = _number(item.get("x")), _number(item.get("z"))
            if x is not None and z is not None:
                kept_passages.append({"x": round(x, 2), "z": round(z, 2), "show": item["show"]})
        entry["passages"] = kept_passages
    for key in ("cuts", "splitAt", "mergeAt"):
        heights = value.get(key)
        if isinstance(heights, list):
            kept = [
                float(h)
                for h in heights[:MAX_CUTS]
                if isinstance(h, (int, float)) and not isinstance(h, bool) and abs(float(h)) < 100_000
            ]
            if kept or key == "cuts":
                entry[key] = kept
    names = value.get("names")
    if isinstance(names, list):
        entry["names"] = [str(n)[:MAX_NAME] if isinstance(n, str) else "" for n in names[:MAX_NAMES]]
    return entry or None


def load_floor_overrides(path: Path, game: str) -> dict[str, dict[str, tp.Any]]:
    """The player's own floor overrides of `game` from `path` (the Map Maker keeps them in floor-overrides.json in
    its settings folder): `{game: {mAA_BB: entry}}`, as `floorOverrides` in the config but keyed by game first.
    Raises OSError or ValueError when the file cannot be read; entries that are not usable are left out."""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("not a JSON object")
    game_entries = data.get(game, {})
    if not isinstance(game_entries, dict):
        raise ValueError(f"{game} is not a JSON object")
    out: dict[str, dict[str, tp.Any]] = {}
    for key, value in game_entries.items():
        if not isinstance(key, str) or key.startswith("$"):
            continue
        entry = clean_floor_entry(value)
        if entry is not None:
            out[area_key(key.lower())] = entry
    return out


def chosen_floor_overrides(
    config: dict[str, tp.Any], own: dict[str, dict[str, tp.Any]], area_id: str
) -> tuple[dict[str, tp.Any], str | None]:
    """The floor overrides of an area and where they come from: the player's own entry replaces the shipped one
    whole (`"yours"`), else the config's (`"shipped"`), else none (None)."""
    key = area_key(area_id)
    if key in own:
        return own[key], "yours"
    shipped = floor_overrides(config, area_id)
    return shipped, ("shipped" if shipped else None)


def is_skipped(config: dict[str, tp.Any], area_id: str) -> bool:
    return any(area_id.startswith(prefix) for prefix in config.get("skipAreas", []))
