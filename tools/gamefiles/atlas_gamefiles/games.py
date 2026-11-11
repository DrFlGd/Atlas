"""Per-game knowledge: where files are, which Soulstruct classes read them, and the area names Soulstruct knows."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .detect import BLOODBORNE, DSR, descend, files_matching


@dataclass(frozen=True)
class Area:
    id: str  # MSB file stem, e.g. m10_01_00_00
    name: str
    msb: Path
    map_folder: Path | None

    @property
    def area_number(self) -> int:
        return int(self.id[1:3])

    @property
    def block_number(self) -> int:
        return int(self.id[4:6])


@dataclass(frozen=True)
class GameProfile:
    game: str
    msb_pattern: str
    param_path: tuple[str, ...]
    text_path: tuple[str, ...]
    # How collision HKX entries are stored: "dsr" (Havok 2015, hkp meshes Soulstruct reads) or "bloodborne"
    # (Havok 2014, hknp compressed meshes that need a decoder of our own, planned for a later phase).
    collision_kind: str
    navmesh_kind: str  # "nvm" (DSR) or "hkx" (Bloodborne .nvmhktbnd)

    def msb_class(self) -> type:
        if self.game == DSR:
            from soulstruct.darksouls1r.maps import MSB
        else:
            from soulstruct.bloodborne.maps import MSB
        return MSB

    def item_lot_row_type(self) -> type:
        if self.game == DSR:
            from soulstruct.darksouls1r.params.paramdef import ITEMLOT_PARAM_ST
        else:
            from soulstruct.bloodborne.params.paramdef import ITEMLOT_PARAM_ST
        return ITEMLOT_PARAM_ST

    def known_maps(self) -> dict[str, str]:
        """Soulstruct's names for the game's maps, by MSB stem and by `mAA_BB` prefix."""
        if self.game == DSR:
            from soulstruct.darksouls1r.maps.constants import ALL_MAPS
        else:
            from soulstruct.bloodborne.maps.constants import ALL_MAPS
        names: dict[str, str] = {}
        for game_map in ALL_MAPS:
            if game_map.area_id is None:
                continue
            name = game_map.verbose_name or game_map.name
            stem = game_map.msb_file_stem
            if stem:
                names[stem] = name
            names.setdefault(f"m{game_map.area_id:02d}_{game_map.block_id:02d}", name)
        return names


PROFILES = {
    DSR: GameProfile(
        game=DSR,
        msb_pattern=r"m\d\d_\d\d_\d\d_\d\d\.msb",
        param_path=("param", "GameParam", "GameParam.parambnd.dcx"),
        text_path=("msg", "ENGLISH", "item.msgbnd.dcx"),
        collision_kind="dsr",
        navmesh_kind="nvm",
    ),
    BLOODBORNE: GameProfile(
        game=BLOODBORNE,
        msb_pattern=r"m\d\d_\d\d_\d\d_\d\d\.msb\.dcx",
        param_path=("param", "gameparam", "gameparam.parambnd.dcx"),
        text_path=("msg", "engus", "item.msgbnd.dcx"),
        collision_kind="bloodborne",
        navmesh_kind="hkx",
    ),
}

# The sixteen Bloodborne areas that Hunter's Atlas maps (its check expects 16), by `mAA_BB` prefix.
BLOODBORNE_MAIN_AREAS = (
    "m21_00", "m21_01", "m22_00", "m23_00", "m24_00", "m24_01", "m24_02", "m25_00",
    "m26_00", "m27_00", "m28_00", "m32_00", "m33_00", "m34_00", "m35_00", "m36_00",
)  # fmt: skip


def stem_of(path: Path) -> str:
    return path.name.split(".")[0].lower()


def map_folder_for(root: Path, stem: str) -> Path | None:
    """The `map/mAA_BB_CC_DD` folder of an area: the MSB's own stem, else the same area and block."""
    map_dir = descend(root, "map")
    if map_dir is None:
        return None
    exact = descend(map_dir, stem)
    if exact is not None and exact.is_dir():
        return exact
    prefix = stem[:6].lower()
    try:
        matches = sorted(
            p for p in map_dir.iterdir() if p.is_dir() and p.name.lower().startswith(prefix) and p.name != "MapStudio"
        )
    except OSError:
        return None
    return matches[0] if matches else None


def list_areas(profile: GameProfile, root: Path) -> list[Area]:
    studio = descend(root, "map", "MapStudio")
    names = profile.known_maps()
    areas = []
    for msb in files_matching(studio, profile.msb_pattern):
        stem = stem_of(msb)
        name = names.get(stem) or names.get(stem[:6]) or stem
        areas.append(Area(id=stem, name=name, msb=msb, map_folder=map_folder_for(root, stem)))
    return areas


def entry_basename(path: str) -> str:
    """The file name of a binder entry path, which uses backslashes."""
    return re.split(r"[\\/]", path)[-1]


def model_stem(entry_name: str) -> str:
    """`h0000B1A10.hkx.dcx` -> `h0000B1`: the model name an MSB part refers to (the `Axx` area suffix dropped)."""
    stem = entry_basename(entry_name).split(".")[0]
    match = re.fullmatch(r"(.+?)A\d\d", stem)
    return match.group(1) if match else stem

