"""Writing the Atlas pack: one map per area, one layer per floor, regions from areas and place names, categories
with Atlas's own icons, item entities with the game's descriptions, and checklists.

Only fields that the pack schema (`packages/schema`, manifest version 2) knows are written: older Atlas viewers
refuse unknown fields. CI checks every file this writes with the schema itself (`pnpm --filter @atlas/pipeline
validate-pack`).

The pack is a self-contained folder: its JSON files and `tiles/<area>/<floor>/{z}/{x}/{y}.<webp|png>`. It is
written next to its final place (a hidden `.<id>.making` folder in the maps folder) and then swapped in, so Atlas
never sees half a pack; a pack folder of the same id that the Map Maker did not write is never replaced.
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
import typing as tp
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from . import __version__
from .content import GameContent
from .floors import Floor
from .render import Frame
from .world import Marker

WRITER = "Atlas Map Maker"
PACK_VERSION = "1.0.0"
SINCE = "1.0.0"
HUNTERS_ATLAS = "https://github.com/MikeTat1988/HuntersAtlas"

GROUPS = (("places", "Places", 0), ("characters", "Characters", 1), ("items", "Items", 2))
# id, group, name, icon (Atlas's icon set), colour, trackable, shown at first
CATEGORIES = (
    ("bonfire", "places", "Bonfire", "flame", "#ff9a3c", True, True),
    ("boss", "characters", "Boss", "skull", "#ff7b72", True, True),
    ("npc", "characters", "NPC", "person", "#8fb8ff", False, True),
    ("drop", "characters", "Guaranteed drop", "paw", "#c792ea", True, True),
    ("weapon", "items", "Weapon or shield", "sword", "#e6b450", True, True),
    ("armour", "items", "Armour", "shield", "#d1a36b", True, True),
    ("ring", "items", "Ring", "gem", "#63cdb9", True, True),
    ("spell", "items", "Spell", "book", "#b393f0", True, True),
    ("key", "items", "Key item", "key", "#ffd479", True, True),
    ("upgrade", "items", "Upgrade material", "hammer", "#9ad87a", True, True),
    ("other", "items", "Other item", "chest", "#a0a8b4", True, True),
    ("consumable", "items", "Consumable", "flask", "#8a919c", True, False),
    ("souls", "items", "Souls", "coin", "#c9b37e", True, False),
)
ITEM_CATEGORIES = {c[0] for c in CATEGORIES if c[1] == "items"}
KIND_LETTER = {"weapon": "w", "armour": "a", "ring": "r", "goods": "g"}


@dataclass
class LayerOut:
    floor: Floor
    tiles: dict[str, tp.Any]  # from tiles.write_pyramid
    url: str


@dataclass
class AreaOut:
    key: str  # m10_01
    area_id: str
    name: str
    frame: Frame
    layers: list[LayerOut]  # by floor index, lowest first
    main_floor: int
    markers: list[Marker]
    place_names: dict[int, str] = field(default_factory=dict)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def floor_names(floors: list[Floor], main: int, names: list[str] | None) -> list[str]:
    """Names, by floor index: from the config (lowest first), else relative to the main floor."""
    out = []
    above = [f.index for f in floors if f.index > main]
    below = [f.index for f in floors if f.index < main]
    for floor in floors:
        if names and floor.index < len(names) and str(names[floor.index]).strip():
            out.append(str(names[floor.index]).strip())
        elif len(floors) == 1:
            out.append("Ground")
        elif floor.index == main:
            out.append("Main level")
        elif floor.index > main:
            n = above.index(floor.index) + 1
            out.append("Upper level" if len(above) == 1 else f"Upper level {n}")
        else:
            n = len(below) - below.index(floor.index)
            out.append("Lower level" if len(below) == 1 else f"Lower level {n}")
    return out


def layer_order(floors: list[Floor], main: int) -> list[int]:
    """The main floor first (Atlas opens a map on its first layer), then the others from the highest down."""
    rest = sorted((f.index for f in floors if f.index != main), reverse=True)
    return [main, *rest]


def build_pack(
    pack_id: str,
    title: str,
    game_patch: str,
    areas: list[AreaOut],
    content: GameContent,
    created: str | None = None,
) -> dict[str, tp.Any]:
    def ident(kind: str, local: str) -> str:
        return f"{pack_id}:{kind}:{local}"

    maps, layers, regions, locations, entities, guides = [], [], [], [], [], []
    used_categories: Counter[str] = Counter()
    entity_ids: dict[tuple[str, int], str] = {}
    lists: dict[str, list[tuple[str, str, str]]] = defaultdict(list)  # checklist -> (section, name, location id)

    for area in areas:
        map_id = ident("map", area.key)
        maps.append(
            {
                "id": map_id,
                "name": area.name,
                "width": area.frame.width,
                "height": area.frame.height,
                "worldTransform": {k: round(v, 6) for k, v in area.frame.world_transform().items()},
            }
        )
        floors = [layer.floor for layer in area.layers]
        for index in layer_order(floors, area.main_floor):
            layer = area.layers[index]
            layers.append(
                {
                    "id": ident("layer", f"{area.key}-f{index}"),
                    "mapId": map_id,
                    "name": layer.floor.name,
                    "tiles": {"type": "xyz", "url": layer.url},
                    "minZoom": layer.tiles["minZoom"],
                    "maxZoom": layer.tiles["maxZoom"],
                    "tileSize": layer.tiles["tileSize"],
                }
            )
        area_region = ident("region", area.key)
        regions.append(
            {
                "id": area_region,
                "mapId": map_id,
                "parentId": None,
                "name": area.name,
                "center": [round(area.frame.width / 2, 1), round(area.frame.height / 2, 1)],
            }
        )
        # Sub-regions: the game's place names, where markers stand on a collision that names one.
        places: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for marker in area.markers:
            if marker.place_id is not None and marker.place_id in area.place_names and marker.pixel:
                places[marker.place_id].append(marker.pixel)
        place_region: dict[int, str] = {}
        for place_id, points in sorted(places.items()):
            if area.place_names[place_id] == area.name:
                continue
            region_id = ident("region", f"{area.key}-p{place_id}")
            place_region[place_id] = region_id
            regions.append(
                {
                    "id": region_id,
                    "mapId": map_id,
                    "parentId": area_region,
                    "name": area.place_names[place_id],
                    "center": [round(sum(p[0] for p in points) / len(points), 1), round(sum(p[1] for p in points) / len(points), 1)],
                }
            )
        bonfire_names: Counter[str] = Counter()
        for marker in area.markers:
            if marker.pixel is None or marker.floor is None:
                continue
            name = marker.name
            if marker.kind == "bonfire":
                if not name:
                    name = area.place_names.get(marker.place_id if marker.place_id is not None else -1) or area.name
                bonfire_names[name] += 1
                if bonfire_names[name] > 1:
                    name = f"{name} ({bonfire_names[name]})"
            location_id = ident("loc", marker.key)
            item_entities = []
            for item in marker.items:
                key = (item.kind, item.id)
                if key not in entity_ids:
                    entity_ids[key] = ident("entity", f"item-{KIND_LETTER[item.kind]}{item.id}")
                    entity = {
                        "id": entity_ids[key],
                        "name": content.item_name(item.kind, item.id) or f"Unknown {item.kind} {item.id}",
                        "kind": "item",
                    }
                    description = content.item_description(item.kind, item.id)
                    if description:
                        entity["description"] = description
                    entities.append(entity)
                if entity_ids[key] not in item_entities:
                    item_entities.append(entity_ids[key])
            guide_id = None
            if marker.note:
                guide_id = ident("guide", marker.key)
                guides.append({"id": guide_id, "title": name, "body": marker.note, "locationIds": [location_id]})
            location = {
                "id": location_id,
                "mapId": map_id,
                "layerId": ident("layer", f"{area.key}-f{marker.floor}"),
                "x": round(min(max(marker.pixel[0], 0.0), area.frame.width), 2),
                "y": round(min(max(marker.pixel[1], 0.0), area.frame.height), 2),
                "categoryId": ident("cat", marker.category),
                "regionId": place_region.get(marker.place_id if marker.place_id is not None else -1, area_region),
                "name": name,
                "entityIds": item_entities,
                "guideId": guide_id,
                "since": SINCE,
            }
            if marker.flag:
                location["flagId"] = str(marker.flag)
            locations.append(location)
            used_categories[marker.category] += 1
            if marker.kind == "bonfire":
                lists["bonfires"].append((area.name, name, location_id))
            elif marker.kind == "boss":
                lists["bosses"].append((area.name, name, location_id))
            if marker.category in ITEM_CATEGORIES:
                lists["items"].append((area.name, name, location_id))
            if marker.category == "ring":
                lists["rings"].append((area.name, name, location_id))
            if marker.category == "key":
                lists["keys"].append((area.name, name, location_id))

    groups_used = {c[1] for c in CATEGORIES if c[0] in used_categories}
    category_groups = [
        {"id": ident("catgroup", gid), "name": name, "order": order} for gid, name, order in GROUPS if gid in groups_used
    ]
    categories = [
        {
            "id": ident("cat", cid),
            "groupId": ident("catgroup", group),
            "name": name,
            "icon": icon,
            "color": colour,
            "trackable": trackable,
            "defaultVisible": visible,
        }
        for cid, group, name, icon, colour, trackable, visible in CATEGORIES
        if cid in used_categories
    ]

    checklists, checklist_items = [], []
    definitions = (
        ("bonfires", "All bonfires", "Every bonfire, area by area."),
        ("bosses", "Bosses", "Every boss on these maps."),
        ("items", "Items by area", "Every item pickup in the world, area by area (consumables and souls too)."),
        ("rings", "Rings", "Every ring lying in the world."),
        ("keys", "Key items", "Keys and other key items lying in the world."),
    )
    for order, (list_key, name, description) in enumerate(definitions):
        entries = lists.get(list_key, [])
        if not entries:
            continue
        list_id = ident("checklist", list_key)
        checklists.append({"id": list_id, "name": name, "description": description, "order": order, "kind": "checklist"})
        for number, (section, item_name, location_id) in enumerate(entries):
            checklist_items.append(
                {
                    "id": ident("checkitem", f"{list_key}-{number + 1}"),
                    "checklistId": list_id,
                    "name": item_name,
                    "order": number,
                    "locationIds": [location_id],
                    "entityIds": [],
                    "section": section[:200],
                }
            )

    stamp = now()
    manifest = {
        "schemaVersion": 2,
        "gameId": pack_id,
        "title": title,
        "packVersion": PACK_VERSION,
        "gamePatch": game_patch or "unknown",
        "attribution": [
            {"name": "Made by Atlas Map Maker from this player's own game files. Private: not for sharing."},
            {"name": "Method after Hunter's Atlas (maps from a player's own game files)", "url": HUNTERS_ATLAS, "license": "GPL-2.0"},
        ],
        "idMigrations": {},
        "created": created or stamp,
        "updated": stamp,
        "writtenBy": {"name": WRITER, "version": __version__},
        "contents": {
            "counts": {
                "maps": len(maps),
                "layers": len(layers),
                "locations": len(locations),
                "categories": len(categories),
                "regions": len(regions),
                "guides": len(guides),
            },
            "maps": [
                {
                    "id": ident("map", area.key),
                    "name": area.name,
                    "width": area.frame.width,
                    "height": area.frame.height,
                    "locations": sum(1 for loc in locations if loc["mapId"] == ident("map", area.key)),
                    "layers": [
                        {
                            "id": ident("layer", f"{area.key}-f{index}"),
                            "name": area.layers[index].floor.name,
                            "minZoom": area.layers[index].tiles["minZoom"],
                            "maxZoom": area.layers[index].tiles["maxZoom"],
                            "tiles": "xyz",
                            "downloadable": False,
                            "images": {
                                "levels": list(range(area.layers[index].tiles["minZoom"], area.layers[index].tiles["maxZoom"] + 1)),
                                "complete": True,
                                "files": area.layers[index].tiles["files"],
                                "bytes": area.layers[index].tiles["bytes"],
                                "updatedAt": stamp,
                            },
                        }
                        for index in layer_order([layer.floor for layer in area.layers], area.main_floor)
                    ],
                }
                for area in areas
            ],
        },
    }
    return {
        "manifest": manifest,
        "maps": maps,
        "layers": layers,
        "regions": regions,
        "categoryGroups": category_groups,
        "categories": categories,
        "locations": locations,
        "entities": entities,
        "checklists": checklists,
        "checklistItems": checklist_items,
        "guides": guides,
        "links": [],
        "presets": [],
    }


FILES = {
    "maps": "maps.json",
    "layers": "layers.json",
    "regions": "regions.json",
    "categoryGroups": "categoryGroups.json",
    "categories": "categories.json",
    "locations": "locations.json",
    "entities": "entities.json",
    "checklists": "checklists.json",
    "checklistItems": "checklistItems.json",
    "guides": "guides.json",
    "links": "links.json",
    "presets": "presets.json",
}


def collection_text(items: list[tp.Any]) -> str:
    """One element per line, as the Atlas pipeline writes packs."""
    if not items:
        return "[]\n"
    return "[\n" + ",\n".join("  " + json.dumps(item, ensure_ascii=False, separators=(",", ":")) for item in items) + "\n]\n"


def write_pack_json(folder: Path, pack: dict[str, tp.Any]) -> list[str]:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "manifest.json").write_text(json.dumps(pack["manifest"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    written = ["manifest.json"]
    for name, file in FILES.items():
        (folder / file).write_text(collection_text(pack[name]), encoding="utf-8")
        written.append(file)
    return written


class PackRefused(Exception):
    """The maps folder holds a pack of this id that the Map Maker did not write."""


def existing_pack(target: Path) -> dict[str, tp.Any] | None:
    try:
        data = json.loads((target / "manifest.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def check_target(target: Path) -> str | None:
    """None when `target` can be (re)written; else why not. The `created` time of a pack being replaced is kept."""
    if not target.exists():
        return None
    manifest = existing_pack(target)
    if manifest is None:
        if target.is_dir() and not any(target.iterdir()):
            return None
        return f"{target} already exists and is not a map pack, so the Map Maker leaves it alone."
    written_by = manifest.get("writtenBy") if isinstance(manifest.get("writtenBy"), dict) else {}
    if written_by.get("name") != WRITER:
        return f"{target} holds a map pack that the Map Maker did not make, so it is not replaced."
    return None


def install(staging: Path, target: Path) -> None:
    """Swaps the finished pack in place of `target` (same folder, so these are renames)."""
    old = target.with_name(f".{target.name}.old")
    if old.exists():
        shutil.rmtree(old, ignore_errors=True)
    if target.exists():
        try:
            target.rename(old)
        except OSError as error:
            raise PackRefused(
                f"The old map pack in {target} could not be moved aside ({error}). If Atlas is open, close it and "
                "make the map again."
            ) from error
    try:
        staging.rename(target)
    except OSError:
        if old.exists() and not target.exists():
            old.rename(target)
        raise
    shutil.rmtree(old, ignore_errors=True)
