"""Writing the Atlas pack: one map per area, one layer per floor, regions from areas and place names, categories
with Atlas's own icons, item entities with the game's descriptions, and checklists.

Only fields that the pack schema (`packages/schema`, manifest version 2) knows are written: older Atlas viewers
refuse unknown fields. CI checks every file this writes with the schema itself (`pnpm --filter @atlas/pipeline
validate-pack`).

The pack is a self-contained folder: its JSON files, `tiles/<area>/<floor>/{z}/{x}/{y}.<webp|png>` and, with 3D maps,
`scene/<area>/<cell>/lod<n>.glb` (see scene.py). An area with a 3D model has its `scene` on its map, its markers'
heights (`height`, the game's y) and, where it has two floors or more, each floor's heights on its layer (`heights`). It is
written next to its final place (a hidden `.<id>.making` folder in the maps folder) and then swapped in, so Atlas
never sees half a pack; a pack folder of the same id that the Map Maker did not write is never replaced.

Making one area again (the Map Maker's "Make this area again") writes that area's new files in a hidden
`.<id>.remake-<area>` folder beside the pack, merges its map into the installed pack's JSON (`merge_area`) and swaps
the area's folders and the JSON files in (`swap_area`); every other map and its files stay as they were.
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

GROUPS = (("places", "Locations", 0), ("characters", "Characters", 1), ("items", "Items", 2))
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
KIND_LETTER = {"weapon": "w", "armour": "a", "ring": "r", "goods": "g", "gem": "j"}


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
    # The 3D model (the scene for maps.json), and each floor's [min, max] heights by floor index (None without
    # storeys).
    scene: dict[str, tp.Any] | None = None
    floor_heights: list[list[float]] | None = None


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


def duplicate_ids(pack: dict[str, tp.Any]) -> list[str]:
    """Ids used twice in one list of the pack (Atlas refuses such a pack), as `list: id`."""
    found = []
    for name, items in pack.items():
        if not isinstance(items, list):
            continue
        seen: set[str] = set()
        for item in items:
            item_id = item.get("id") if isinstance(item, dict) else None
            if item_id is None:
                continue
            if item_id in seen:
                found.append(f"{name}: {item_id}")
            seen.add(item_id)
    return found


CHECKLISTS = (
    ("bonfires", "All bonfires", "Every bonfire, area by area."),
    ("bosses", "Bosses", "Every boss on these maps."),
    ("items", "Items by area", "Every item pickup in the world, area by area (consumables and souls too)."),
    ("rings", "Rings", "Every ring lying in the world."),
    ("keys", "Key items", "Keys and other key items lying in the world."),
)


def checklist(pack_id: str, order: int, names: dict[str, tp.Any] | None = None) -> dict[str, tp.Any]:
    """Checklist `order` of CHECKLISTS; `names` (the config's `checklistNames`) can give it another name and
    description in a game: `{list key: [name, description]}`."""
    list_key, name, description = CHECKLISTS[order]
    other = (names or {}).get(list_key)
    if isinstance(other, list) and len(other) == 2 and all(isinstance(v, str) and v for v in other):
        name, description = other
    return {"id": f"{pack_id}:checklist:{list_key}", "name": name, "description": description, "order": order, "kind": "checklist"}


def category_lists(
    pack_id: str, used: set[str], names: dict[str, tp.Any] | None = None
) -> tuple[list[dict[str, tp.Any]], list[dict[str, tp.Any]]]:
    """The category groups and categories of the categories `used` (by their short ids), in Atlas's order. `names`
    (the config's `categoryNames`) can give a category another name in a game (Bloodborne's lamps)."""
    names = {k: v for k, v in (names or {}).items() if isinstance(v, str) and v and not k.startswith("$")}
    groups_used = {c[1] for c in CATEGORIES if c[0] in used}
    groups = [
        {"id": f"{pack_id}:catgroup:{gid}", "name": name, "order": order} for gid, name, order in GROUPS if gid in groups_used
    ]
    categories = [
        {
            "id": f"{pack_id}:cat:{cid}",
            "groupId": f"{pack_id}:catgroup:{group}",
            "name": names.get(cid, name),
            "icon": icon,
            "color": colour,
            "trackable": trackable,
            "defaultVisible": visible,
        }
        for cid, group, name, icon, colour, trackable, visible in CATEGORIES
        if cid in used
    ]
    return groups, categories


def content_counts(maps: list, layers: list, locations: list, categories: list, regions: list, guides: list) -> dict[str, int]:
    return {
        "maps": len(maps),
        "layers": len(layers),
        "locations": len(locations),
        "categories": len(categories),
        "regions": len(regions),
        "guides": len(guides),
    }


def build_pack(
    pack_id: str,
    title: str,
    game_patch: str,
    areas: list[AreaOut],
    content: GameContent,
    created: str | None = None,
    labels: dict[str, tp.Any] | None = None,
) -> dict[str, tp.Any]:
    """The pack's JSON. `labels` is the game's config, for its `categoryNames` and `checklistNames`."""
    labels = labels or {}

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
                **({"scene": area.scene} if area.scene else {}),
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
                    **(
                        {"heights": area.floor_heights[index]}
                        if area.scene and area.floor_heights and index < len(area.floor_heights)
                        else {}
                    ),
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
            if area.scene:
                location["height"] = round(float(marker.position[1]), 2)
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

    category_groups, categories = category_lists(pack_id, set(used_categories), labels.get("categoryNames"))

    checklists, checklist_items = [], []
    for order, (list_key, name, description) in enumerate(CHECKLISTS):
        entries = lists.get(list_key, [])
        if not entries:
            continue
        list_id = ident("checklist", list_key)
        checklists.append(checklist(pack_id, order, labels.get("checklistNames")))
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
            {"name": "Made with Atlas Map Maker from your own game files (private, not for sharing)"},
            {"name": "Method after Hunter's Atlas", "url": HUNTERS_ATLAS, "license": "GPL-2.0"},
        ],
        "idMigrations": {},
        "created": created or stamp,
        "updated": stamp,
        "writtenBy": {"name": WRITER, "version": __version__},
        "contents": {
            "counts": content_counts(maps, layers, locations, categories, regions, guides),
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


# ---------------------------------------------------------------------------------------------------------------
# Making one area again: its map put in place of the old one in the installed pack, the rest left as it was.


def read_pack_json(folder: Path) -> dict[str, tp.Any]:
    """The manifest and every collection of the pack in `folder`. Raises OSError or ValueError."""
    pack: dict[str, tp.Any] = {"manifest": json.loads((folder / "manifest.json").read_text(encoding="utf-8-sig"))}
    for name, file in FILES.items():
        path = folder / file
        items = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else []
        if not isinstance(items, list):
            raise ValueError(f"{file} is not a list")
        pack[name] = items
    if not isinstance(pack["manifest"], dict):
        raise ValueError("manifest.json is not a JSON object")
    return pack


def _splice(items: list[tp.Any], new: list[tp.Any], belongs: tp.Callable[[tp.Any], bool]) -> list[tp.Any]:
    """`items` with those that `belongs` picks replaced by `new`, at the place of the first of them (else at the
    end)."""
    out: list[tp.Any] = []
    placed = False
    for item in items:
        if isinstance(item, dict) and belongs(item):
            if not placed:
                out.extend(new)
                placed = True
            continue
        out.append(item)
    if not placed:
        out.extend(new)
    return out


def merge_area(old: dict[str, tp.Any], part: dict[str, tp.Any], pack_id: str, key: str) -> dict[str, tp.Any]:
    """The pack `old` with the map of area `key` (its map, layers, regions, locations and guides, and its entries
    in the checklists) replaced by those of `part`, a pack of that area alone (`build_pack` of it). Every other
    map and its things stay as they were, in their order and with their ids: a checklist entry of the area keeps
    its id when it is for the same location, so the player's ticks stay. Entities, categories and checklists are
    those the merged pack uses; the manifest's contents are counted again."""
    map_id = f"{pack_id}:map:{key}"
    gone = {loc.get("id") for loc in old["locations"] if isinstance(loc, dict) and loc.get("mapId") == map_id}
    merged: dict[str, tp.Any] = {}
    merged["maps"] = _splice(old["maps"], part["maps"], lambda item: item.get("id") == map_id)
    for name in ("layers", "regions", "locations"):
        merged[name] = _splice(old[name], part[name], lambda item: item.get("mapId") == map_id)
    merged["guides"] = _splice(
        old["guides"], part["guides"], lambda item: any(i in gone for i in item.get("locationIds", []))
    )

    # Checklists: per list, the area's entries replaced where they were.
    checklists, items = [], []
    old_lists = {c.get("id"): c for c in old["checklists"] if isinstance(c, dict)}
    new_lists = {c.get("id"): c for c in part["checklists"] if isinstance(c, dict)}
    for order, (list_key, _, _) in enumerate(CHECKLISTS):
        list_id = f"{pack_id}:checklist:{list_key}"
        old_items = [i for i in old["checklistItems"] if isinstance(i, dict) and i.get("checklistId") == list_id]
        new_items = [i for i in part["checklistItems"] if i.get("checklistId") == list_id]

        def belongs(item: dict[str, tp.Any]) -> bool:
            return any(i in gone for i in item.get("locationIds", []))

        ids_by_place = {tuple(i.get("locationIds", [])): i["id"] for i in old_items if belongs(i)}
        numbers = [_item_number(i.get("id", "")) for i in old_items]
        next_number = max([n for n in numbers if n is not None], default=0) + 1
        renamed = []
        for item in new_items:
            item_id = ids_by_place.pop(tuple(item.get("locationIds", [])), None)
            if item_id is None:
                item_id = f"{pack_id}:checkitem:{list_key}-{next_number}"
                next_number += 1
            renamed.append({**item, "id": item_id})
        spliced = [{**item, "order": n} for n, item in enumerate(_splice(old_items, renamed, belongs))]
        if spliced:
            checklists.append(old_lists.get(list_id) or new_lists.get(list_id) or checklist(pack_id, order))
            items.extend(spliced)
    merged["checklists"] = checklists
    merged["checklistItems"] = items

    referenced = {e for loc in merged["locations"] for e in loc.get("entityIds", [])}
    referenced |= {e for item in items for e in item.get("entityIds", [])}
    entities, seen = [], set()
    for entity in [*old["entities"], *part["entities"]]:
        entity_id = entity.get("id") if isinstance(entity, dict) else None
        if entity_id in referenced and entity_id not in seen:
            entities.append(entity)
            seen.add(entity_id)
    merged["entities"] = entities
    used = {str(loc.get("categoryId", "")).rsplit(":", 1)[-1] for loc in merged["locations"]}
    merged["categoryGroups"], merged["categories"] = category_lists(pack_id, used)
    merged["links"] = old.get("links", [])
    merged["presets"] = old.get("presets", [])

    manifest = dict(old["manifest"])
    contents = dict(manifest.get("contents") or {})
    contents["maps"] = _splice(
        list(contents.get("maps") or []), part["manifest"]["contents"]["maps"], lambda item: item.get("id") == map_id
    )
    contents["counts"] = content_counts(
        merged["maps"], merged["layers"], merged["locations"], merged["categories"], merged["regions"], merged["guides"]
    )
    manifest["contents"] = contents
    manifest["updated"] = part["manifest"]["updated"]
    manifest["writtenBy"] = part["manifest"]["writtenBy"]
    merged["manifest"] = manifest
    return merged


def _item_number(item_id: str) -> int | None:
    tail = item_id.rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else None


def swap_area(staging: Path, target: Path, key: str, pack: dict[str, tp.Any]) -> None:
    """Puts the area's new files (`tiles/<key>/` and `scene/<key>/` in `staging`) and the merged pack's JSON in
    place in the installed pack `target`, all by renames in the same folder:

    1. every JSON file is written next to its place first (`.<name>.partial`);
    2. the area's old folders are moved aside, into a hidden `.<id>.remake-old` folder beside the pack, and its
       new ones moved in;
    3. each JSON file is swapped in (a copy of the old one kept aside), the manifest last.

    Any failure puts back what was moved and swapped, so the pack is as it was, and raises PackRefused. Then the
    old files are deleted. Other maps' files are never touched."""
    texts = {file: collection_text(pack[name]) for name, file in FILES.items()}
    texts["manifest.json"] = json.dumps(pack["manifest"], indent=2, ensure_ascii=False) + "\n"
    folders = [("tiles", key), ("scene", key.lower())]
    backup = target.with_name(f".{target.name}.remake-old")
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)
    partials: list[Path] = []
    aside: list[tuple[str, str]] = []
    moved_in: list[tuple[str, str]] = []
    swapped: list[str] = []
    try:
        backup.mkdir(parents=True)
        for file, text in texts.items():
            partial = target / f".{file}.partial"
            partial.write_text(text, encoding="utf-8")
            partials.append(partial)
        for sub, name in folders:
            old = target / sub / name
            if old.exists():
                (backup / sub).mkdir(parents=True, exist_ok=True)
                old.rename(backup / sub / name)
                aside.append((sub, name))
        for sub, name in folders:
            new = staging / sub / name
            if new.exists():
                (target / sub).mkdir(exist_ok=True)
                new.rename(target / sub / name)
                moved_in.append((sub, name))
        for file in texts:  # the manifest last
            current = target / file
            if current.exists():
                shutil.copy2(current, backup / file)
            (target / f".{file}.partial").replace(current)
            swapped.append(file)
    except OSError as error:
        restored = True
        for file in reversed(swapped):
            restored &= _quietly(lambda file=file: (backup / file).replace(target / file))
        for sub, name in reversed(moved_in):
            restored &= _quietly(lambda sub=sub, name=name: (target / sub / name).rename(staging / sub / name))
        for sub, name in reversed(aside):
            restored &= _quietly(lambda sub=sub, name=name: (backup / sub / name).rename(target / sub / name))
        if restored:
            shutil.rmtree(backup, ignore_errors=True)
        else:
            raise PackRefused(
                f"The new map of this area could not be put in the map pack ({error}), and the old one could not all "
                f"be put back: its files are in {backup}. Press Make map to make the whole map again."
            ) from error
        raise PackRefused(
            f"The new map of this area could not be put in the map pack ({error}), so the pack was left as it was. "
            "If Atlas is open, close it and make the area again."
        ) from error
    finally:
        for partial in partials:
            partial.unlink(missing_ok=True)
    shutil.rmtree(backup, ignore_errors=True)
    for sub, _ in folders:
        folder = target / sub
        if folder.is_dir() and not any(folder.iterdir()):
            _quietly(folder.rmdir)


def _quietly(action: tp.Callable[[], tp.Any]) -> bool:
    try:
        action()
    except OSError:
        return False
    return True
