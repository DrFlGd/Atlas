"""Made-up game folders for the tests, written with Soulstruct. They hold no game data: every part, model name,
item lot, text and coordinate here is invented, and the meshes are a few triangles.

    python tests/fixtures.py dsr <folder>         # a made-up Dark Souls Remastered install
    python tests/fixtures.py dsr-map <folder>     # the same, with what a map needs (see make_dsr_map)
    python tests/fixtures.py dsr-textured <folder>  # dsr-map with made-up models and textures (make_dsr_textured)
    python tests/fixtures.py bloodborne <folder>  # a made-up Bloodborne dump layout (see make_bloodborne)
    python tests/fixtures.py bloodborne-textured <folder>  # with made-up models and PS4 textures

What Soulstruct 2.6.0 cannot write is noted where it matters:
- map piece models (FLVER): Soulstruct writes a small one (make_dsr_textured); make_dsr's area holds a file that
  is not a FLVER (the reader's failure path);
- materials (MTD): Soulstruct 2.6.0's MTD writer fails, so the made-up models have no MTD files and their
  materials are told apart by their texture types and MTD names, as the reader does without an MTD;
- Bloodborne MSB files: Soulstruct's Bloodborne MSB writer leaves each part's instance index unfilled and some
  byte defaults out of range, so make_bloodborne_msb fills those in while writing. It then puts small values in
  bytes Soulstruct expects blank, as real Bloodborne files have (the reader reads past them, see msb.load_msb);
- Bloodborne collision and navmesh (Havok 2014 hknp meshes, hkaiNavMesh) and the navmesh placement table (.nva):
  Soulstruct does not write them, so havok_fixtures.py writes them byte by byte, holding made-up triangles.
"""

from __future__ import annotations

import math
import typing as tp
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from atlas_gamefiles.safety import prepare_soulstruct  # noqa: E402

prepare_soulstruct()

import numpy as np  # noqa: E402
from soulstruct.base.maps.navmesh.nvm import NVM, NVMTriangle  # noqa: E402
from soulstruct.base.params.param import TypedParam  # noqa: E402
from soulstruct.base.text.fmg import FMG  # noqa: E402
from soulstruct.containers import Binder, BinderEntry, BinderVersion  # noqa: E402
from soulstruct.darksouls1r.maps import MSB  # noqa: E402
from soulstruct.darksouls1r.maps.navmesh import NVMBND  # noqa: E402
from soulstruct.darksouls1r.events import EMEVD  # noqa: E402
from soulstruct.darksouls1r.params.paramdef import EQUIP_PARAM_GOODS_ST, ITEMLOT_PARAM_ST, NPC_PARAM_ST  # noqa: E402
from soulstruct.dcx import DCXType  # noqa: E402
from soulstruct.havok.enums import HavokModule  # noqa: E402
from soulstruct.havok.fromsoft.shared.hkx_binder import HKXBHD  # noqa: E402
from soulstruct.havok.fromsoft.shared.map_collision import MapCollisionModel, MapCollisionModelMesh  # noqa: E402
from soulstruct.utilities.maths import Vector3  # noqa: E402

UNDEAD_BURG = "m10_01_00_00"
FIRELINK = "m10_02_00_00"
CATHEDRAL_WARD = "m24_00_00_00"
ITEM_LOTS = (1010000, 1010010, 1010020)


def fake_exe(path: Path, version: tuple[int, int, int, int] = (1, 3, 1, 0)) -> None:
    """A file that is not a program: a header, padding and a version block (VS_FIXEDFILEINFO) to find."""
    a, b, c, d = version
    block = b"\xbd\x04\xef\xfe" + struct.pack("<IIIII", 0x10000, (a << 16) | b, (c << 16) | d, 0, 0)
    path.write_bytes(b"MZ made-up test file\0" + b"\0" * 4000 + block + b"\0" * 64)


def make_msb(stem: str, *, with_geometry_parts: bool, collision: str = "h0000B1", navmesh: str = "n0000B1") -> MSB:
    msb = MSB()
    area, block = int(stem[1:3]), int(stem[4:6])
    base = area * 100000 + block * 10000
    chest = msb.objects.new(
        name="o0500_0000", model=msb.auto_object_model("o0500"), translate=Vector3((12.0, 1.0, -8.0))
    )
    bonfire = msb.objects.new(
        name="o0510_0000",
        model=msb.auto_object_model("o0510"),
        translate=Vector3((-20.0, 0.5, 15.0)),
        entity_id=base + 1960,
    )
    msb.characters.new(
        name="c2800_0000", model=msb.auto_character_model("c2800"), translate=Vector3((30.0, 2.0, 25.0))
    )
    msb.characters.new(
        name="c2800_0001", model=msb.auto_character_model("c2800"), translate=Vector3((-35.0, 4.0, -30.0))
    )
    msb.player_starts.new(
        name="c0000_0000", model=msb.auto_player_model("c0000"), translate=Vector3((0.0, 0.0, 40.0))
    )
    msb.treasures.new(name="Treasure chest", treasure_part=chest, item_lot_1=ITEM_LOTS[0], item_lot_2=ITEM_LOTS[1])
    msb.treasures.new(name="Treasure corpse", treasure_part=bonfire, item_lot_1=ITEM_LOTS[2], item_lot_2=9999999)
    if with_geometry_parts:
        msb.map_pieces.new(name="m0000B1", model=msb.auto_map_piece_model("m0000B1", stem))
        msb.collisions.new(
            name=collision,
            model=msb.auto_collision_model(collision, stem),
            translate=Vector3((5.0, 0.0, 0.0)),
            rotate=Vector3((0.0, 90.0, 0.0)),
            attached_bonfire=base + 950,
        )
        msb.navmeshes.new(name=navmesh, model=msb.auto_navmesh_model(navmesh, stem))
    return msb


# Markers the Bloodborne MSB builder writes into fields next to bytes Soulstruct expects blank, to find those bytes.
_GPARAM_MARK = 0x7A7A7A01
_SCENE_GPARAM_MARK = 0x6B6B6B01


Placement = tuple[str, str, tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]


def make_bloodborne_msb(stem: str, *, collision: str, navmesh: str, pieces: tp.Sequence[Placement] = ()) -> bytes:
    """make_msb's layout as a Bloodborne MSB (Soulstruct's Bloodborne class), with what real files hold in bytes
    Soulstruct expects blank: small values after the GParam and SceneGParam fields. Its entries after the first
    with an absent data block (the "other" event here) are turned down by Soulstruct's check of absent blocks, which
    measures their offset from the start of the file rather than from the entry. `pieces` are more map piece parts:
    name, model, position, rotation (degrees) and scale."""
    import soulstruct.bloodborne.maps.events as bb_events
    import soulstruct.bloodborne.maps.models as bb_models
    import soulstruct.bloodborne.maps.parts as bb_parts
    from soulstruct.bloodborne.maps import MSB as BloodborneMSB

    msb = BloodborneMSB()
    area, block = int(stem[1:3]), int(stem[4:6])
    base = area * 100000 + block * 10000
    def model(kind: str, name: str, stem: str = "") -> tp.Any:
        made = getattr(bb_models, f"MSB{kind}Model")(name=name)
        if stem:
            made.set_auto_sib_path(stem)
        getattr(msb, f"{kind[0].lower()}{''.join('_' + c.lower() if c.isupper() else c for c in kind[1:])}_models").append(made)
        return made

    part = {"part_unk_x0e_x0f": 0}  # Soulstruct's default (-1) does not fit the byte it is written to
    chest = msb.objects.new(name="o0500_0000", model=model("Object", "o0500"), translate=Vector3((12.0, 1.0, -8.0)), **part)
    lamp = msb.objects.new(
        name="o0510_0000", model=model("Object", "o0510"), translate=Vector3((-20.0, 0.5, 15.0)), entity_id=base + 1960, **part
    )
    character = model("Character", "c2800")
    first = msb.characters.new(name="c2800_0000", model=character, translate=Vector3((30.0, 2.0, 25.0)), **part)
    second = msb.characters.new(name="c2800_0001", model=character, translate=Vector3((-35.0, 4.0, -30.0)), **part)
    msb.player_starts.new(name="c0000_0000", model=model("Player", "c0000"), translate=Vector3((0.0, 0.0, 40.0)), **part)
    msb.treasures.new(name="Treasure chest", treasure_part=chest, item_lot_1=ITEM_LOTS[0], item_lot_2=ITEM_LOTS[1])
    msb.treasures.new(name="Treasure corpse", treasure_part=lamp, item_lot_1=ITEM_LOTS[2], item_lot_2=9999999)
    msb.map_pieces.new(
        name="m0000B1",
        model=model("MapPiece", "m0000B1", stem),
        environment_map_id=_GPARAM_MARK,
        **part,
    )
    piece_models: dict[str, tp.Any] = {}
    for name, piece_model, position, rotation, scale in pieces:
        if piece_model not in piece_models:
            piece_models[piece_model] = model("MapPiece", piece_model, stem)
        msb.map_pieces.new(
            name=name,
            model=piece_models[piece_model],
            translate=Vector3(position),
            rotate=Vector3(rotation),
            scale=Vector3(scale),
            **part,
        )
    msb.collisions.new(
        name=collision,
        model=model("Collision", collision, stem),
        translate=Vector3((5.0, 0.0, 0.0)),
        rotate=Vector3((0.0, 90.0, 0.0)),
        attached_lantern=base + 950,
        sg_unk_x14_x18=_SCENE_GPARAM_MARK,
        unk_x0b_x0c=0,  # Soulstruct's default here is not a number
        event_ids=[0, 0, 0, 0],
        **part,
    )
    msb.navmeshes.new(name=navmesh, model=model("Navmesh", navmesh, stem), **part)
    msb.other_events.new(name="Other event")
    # A platoon, as real files have: Soulstruct 2.6 names its indices one way in the file's struct and another in
    # the event (`_platoon_character_indices` and `_platoon_characters_indices`), so it reads them into no field.
    msb.platoons.new(name="Platoon", platoon_characters=[first, second] + [None] * 28)

    msb.dcx_type = DCXType.Null  # plain bytes here; write_dcx compresses them
    header = bb_parts.PartHeaderStruct
    original = header.__dict__["preprocess_write_kwargs"]

    def preprocess_write_kwargs(cls, entry, entry_lists, kwargs) -> None:
        original.__func__(cls, entry, entry_lists, kwargs)
        kwargs["instance_index"] = 0  # left unfilled by Soulstruct's writer

    header.preprocess_write_kwargs = classmethod(preprocess_write_kwargs)
    platoon = bb_events.PlatoonEventDataStruct
    platoon_original = platoon.__dict__.get("preprocess_write_kwargs")

    def write_platoon(cls, entry, entry_lists, kwargs) -> None:
        # Soulstruct's own writer looks for the event's fields by the struct's names, which the event lacks.
        kwargs["_platoon_character_indices"] = entry.try_index(entry_lists["characters"], "platoon_characters")
        kwargs["_platoon_parent_indices"] = entry.try_index(entry_lists["PARTS_PARAM_ST"], "platoon_parents")

    platoon.preprocess_write_kwargs = classmethod(write_platoon)
    try:
        data = bytearray(msb.to_bytes())
    finally:
        header.preprocess_write_kwargs = original
        if platoon_original is None:
            del platoon.preprocess_write_kwargs
        else:
            platoon.preprocess_write_kwargs = platoon_original

    def after(mark: bytes) -> int:
        assert data.count(mark) == 1, (mark, data.count(mark))
        return data.index(mark) + len(mark)

    # GParam: four ints, then 16 blank bytes; real files hold two ints in the last eight.
    at = after(struct.pack("<i", _GPARAM_MARK))
    data[at + 8 : at + 16] = struct.pack("<ii", 4988, 4942)
    # SceneGParam: six ints, then 36 blank bytes; real files start them with 01 01 01.
    at = after(struct.pack("<i", _SCENE_GPARAM_MARK))
    data[at : at + 3] = b"\x01\x01\x01"
    return bytes(data)


def write_dcx(path: Path, data: bytes) -> None:
    from soulstruct.dcx import compress

    path.write_bytes(compress(data, DCXType.DCX_DFLT_10000_44_9))


def collision_model(name: str) -> MapCollisionModel:
    vertices = np.array(
        [[-40, 0, -40, 0], [40, 0, -40, 0], [40, 0, 40, 0], [-40, 0, 40, 0], [-10, 6, -10, 0], [10, 6, 10, 0]],
        dtype=np.float32,
    )
    faces = np.array([[0, 1, 2, 0], [0, 2, 3, 0], [4, 1, 5, 0]], dtype=np.uint16)
    model = MapCollisionModel(name=name, meshes=[MapCollisionModelMesh(vertices, faces, 1)])
    model.havok_module = HavokModule.hk2015
    model.dcx_type = DCXType.DCX_DFLT_10000_24_9
    return model


def navmesh() -> NVM:
    vertices = np.array([[-30, 0, -30], [30, 0, -30], [30, 0, 30], [-30, 0, 30]], dtype=np.float32)
    triangles = [NVMTriangle((0, 1, 2), (-1, 1, -1), 0, 1), NVMTriangle((0, 2, 3), (0, -1, -1), 0, 1)]
    return NVM(vertices=vertices, triangles=triangles)


def item_lot_binder() -> Binder:
    param_class = TypedParam(ITEMLOT_PARAM_ST)
    param = param_class(param_type="ITEMLOT_PARAM_ST", rows={lot: ITEMLOT_PARAM_ST() for lot in ITEM_LOTS})
    return Binder(
        version=BinderVersion.V3,
        v4_info=None,
        dcx_type=DCXType.DCX_DFLT_10000_24_9,
        entries=[
            BinderEntry(
                data=param.to_bytes(), entry_id=0, path="N:\\FRPG\\data\\INTERROOT_x64\\param\\GameParam\\ItemLotParam.param"
            )
        ],
    )


def item_text_binder() -> Binder:
    goods = FMG(entries={100: "Made-up Ember", 101: "Made-up Key", 102: ""})
    rings = FMG(entries={200: "Made-up Ring"})
    return Binder(
        version=BinderVersion.V3,
        v4_info=None,
        dcx_type=DCXType.DCX_DFLT_10000_24_9,
        entries=[
            BinderEntry(data=goods.to_bytes(), entry_id=10, path="N:\\FRPG\\data\\Msg\\Data_ENGLISH\\Goods_names.fmg"),
            BinderEntry(data=rings.to_bytes(), entry_id=11, path="N:\\FRPG\\data\\Msg\\Data_ENGLISH\\Ring_names.fmg"),
        ],
    )


def write_collision(folder: Path, stem: str, area_suffix: str) -> None:
    binder = HKXBHD(map_stem=stem)
    binder.set_hkx(f"h0000B1{area_suffix}", collision_model("h0000B1"))
    binder.set_hkx(f"h0001B1{area_suffix}", collision_model("h0001B1"))  # placed by no part
    binder.write(folder / f"h{stem[1:]}.hkxbhd")


def make_dsr(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    fake_exe(root / "DarkSoulsRemastered.exe")
    studio = root / "map" / "MapStudio"
    studio.mkdir(parents=True)
    make_msb(UNDEAD_BURG, with_geometry_parts=True).write(studio / f"{UNDEAD_BURG}.msb")
    make_msb(FIRELINK, with_geometry_parts=False).write(studio / f"{FIRELINK}.msb")

    burg = root / "map" / UNDEAD_BURG
    burg.mkdir()
    write_collision(burg, UNDEAD_BURG, "A10")
    navmeshes = NVMBND(map_stem=UNDEAD_BURG)
    model = navmesh()
    model.dcx_type = DCXType.Null
    navmeshes.set_nvm("n0000B1A10", model)
    navmeshes.write(burg / f"{UNDEAD_BURG}.nvmbnd.dcx")
    (burg / "m0000B1A10.flver.dcx").write_bytes(b"not a model: made-up test file")
    (root / "map" / FIRELINK).mkdir()

    (root / "param" / "GameParam").mkdir(parents=True)
    item_lot_binder().write(root / "param" / "GameParam" / "GameParam.parambnd.dcx")
    (root / "msg" / "ENGLISH").mkdir(parents=True)
    item_text_binder().write(root / "msg" / "ENGLISH" / "item.msgbnd.dcx")
    return root


def param_sfo(entries: dict[str, str]) -> bytes:
    """A minimal PS4 param.sfo with UTF-8 entries (made-up values)."""
    keys = b""
    values = b""
    index = b""
    for key, value in entries.items():
        data = value.encode() + b"\0"
        size = (len(data) + 3) // 4 * 4
        index += struct.pack("<HHIII", len(keys), 0x0204, len(data), size, len(values))
        keys += key.encode() + b"\0"
        values += data.ljust(size, b"\0")
    keys = keys.ljust((len(keys) + 3) // 4 * 4, b"\0")
    key_table = 20 + len(index)
    data_table = key_table + len(keys)
    header = b"\x00PSF" + struct.pack("<IIII", 0x101, key_table, data_table, len(entries))
    return header + index + keys + values


BB_LOTS = {
    # lot: (item category, item id, count, flag); Bloodborne numbers its categories (4 goods, 1 armour, 8 gems).
    ITEM_LOTS[0]: (4, 1000, 2, 52400000),
    ITEM_LOTS[0] + 1: (8, 3000, 1, 0),  # given with the lot before it (a chain)
    ITEM_LOTS[1]: (1, 10000, 1, 52400010),
    ITEM_LOTS[2]: (4, 2000, 1, 0),  # no flag: left out
}
BB_TEXT = {10: {1000: "Made-up Vial", 2000: "Made-up Bell"}, 12: {10000: "Made-up Hat"}}
BB_EVENT_SCRIPT = """
from soulstruct.bloodborne.events import *
from soulstruct.bloodborne.events.instructions import *


@ContinueOnRest(0)
def Constructor():
    RunEvent(7000, slot=0, args=(2400950, 2401960, 0, 12401000), arg_types="iiii")
"""


def bloodborne_binders() -> tuple[Binder, Binder]:
    """Made-up Bloodborne item lots, goods and characters (Bloodborne's row layouts), and item names."""
    from soulstruct.bloodborne.params import paramdef

    lots = {
        lot_id: paramdef.ITEMLOT_PARAM_ST(Item1=item, Item1Category=category, Item1Count=count, Item1ChancePoints=100, ItemFlag=flag)
        for lot_id, (category, item, count, flag) in BB_LOTS.items()
    }
    goods = {1000: paramdef.EQUIP_PARAM_GOODS_ST(GoodType=0), 2000: paramdef.EQUIP_PARAM_GOODS_ST(GoodType=1)}
    entries = []
    for index, (file, row_type, rows) in enumerate(
        (
            ("ItemLotParam", paramdef.ITEMLOT_PARAM_ST, lots),
            ("EquipParamGoods", paramdef.EQUIP_PARAM_GOODS_ST, goods),
            ("NpcParam", paramdef.NPC_PARAM_ST, {}),
        )
    ):
        param = TypedParam(row_type)(param_type=row_type.__name__, rows=rows)
        entries.append(BinderEntry(data=param.to_bytes(), entry_id=index, path=f"N:\\SPRJ\\data\\Param\\param\\GameParam\\{file}.param"))
    params = Binder(version=BinderVersion.V3, v4_info=None, dcx_type=DCXType.DCX_DFLT_10000_44_9, entries=entries)
    texts = [
        BinderEntry(data=FMG(entries=names).to_bytes(), entry_id=entry_id, path=f"N:\\SPRJ\\data\\Msg\\engUS\\made_up_{entry_id}.fmg")
        for entry_id, names in BB_TEXT.items()
    ]
    text = Binder(version=BinderVersion.V3, v4_info=None, dcx_type=DCXType.DCX_DFLT_10000_44_9, entries=texts)
    return params, text


def write_split_binder(folder: Path, name: str, entries: dict[str, bytes], suffix: str = "") -> None:
    """A split collision binder (`name`.hkxbhd and .hkxbdt) of raw entries; `suffix` (".patch") names it as an
    update's binder."""
    binder = HKXBHD(map_stem="m" + name[1:])
    for index, (stem, data) in enumerate(entries.items()):
        binder.entries.append(BinderEntry(data=data, entry_id=index, path=f"N:\\SPRJ\\data\\INTERROOT_ps4\\map\\{stem}.hkx"))
    work = folder / ".writing"
    work.mkdir()
    binder.write(work / f"{name}.hkxbhd")
    for written in sorted(work.iterdir()):
        written.replace(folder / (written.name + suffix))
    work.rmdir()


def make_bloodborne(root: Path) -> Path:
    """A dump-shaped folder: eboot.bin, sce_sys/param.sfo and dvdroot_ps4 with one area (Cathedral Ward's name and
    numbers, everything in it made up): its collision (an hknp mesh, with an update's .patch binder replacing one
    entry by the bridge over a street of bridge_over_street), its navmesh and placement table, item tables, item
    names and an event script registering a lamp. See the module notes."""
    from havok_fixtures import compressed_mesh_file, navmesh_file, nva_file
    from soulstruct.bloodborne.events import EMEVD as BloodborneEMEVD

    root.mkdir(parents=True, exist_ok=True)
    (root / "eboot.bin").write_bytes(b"not a program: made-up test file")
    (root / "sce_sys").mkdir()
    (root / "sce_sys" / "param.sfo").write_bytes(
        param_sfo({"APP_VER": "01.09", "TITLE": "Made-up Title", "TITLE_ID": "CUSA99999"})
    )
    data = root / "dvdroot_ps4"
    studio = data / "map" / "MapStudio"
    studio.mkdir(parents=True)
    write_dcx(studio / f"{CATHEDRAL_WARD}.msb.dcx", make_bloodborne_msb(CATHEDRAL_WARD, collision="h000100", navmesh="n000100"))
    ward = data / "map" / CATHEDRAL_WARD
    ward.mkdir(parents=True)
    name = "h" + CATHEDRAL_WARD[1:]
    write_split_binder(
        ward,
        name,
        {f"{name}_000100": compressed_mesh_file(quad(-40, 40, -40, 40, 0.0)), f"{name}_000101": compressed_mesh_file(quad(-5, 5, -5, 5, 0.0))},
    )
    write_split_binder(ward, name, {f"{name}_000100": compressed_mesh_file(bridge_over_street())}, suffix=".patch")
    # The navmesh: the same ground a little above it, plus a made-up short cut floating in the air (dropped), placed
    # by the table where the MSB places the collision (5, 0, 0, turned a quarter about the vertical).
    ground = [[(x, y + 0.1, z) for x, y, z in triangle] for triangle in bridge_over_street()]
    ground.append([(-30.0, 20.0, -30.0), (-30.0, 20.0, -20.0), (-20.0, 20.0, -30.0)])
    navmeshes = Binder(
        version=BinderVersion.V3,
        v4_info=None,
        dcx_type=DCXType.DCX_DFLT_10000_44_9,
        entries=[
            BinderEntry(data=navmesh_file(ground), entry_id=0, path=f"N:\\SPRJ\\data\\INTERROOT_ps4\\map\\{CATHEDRAL_WARD}\\n{CATHEDRAL_WARD[1:]}_000100.hkx")
        ],
    )
    navmeshes.write(ward / f"{CATHEDRAL_WARD}.nvmhktbnd.dcx")
    (ward / f"{CATHEDRAL_WARD}.nva").write_bytes(nva_file([(100, 100, (5.0, 0.0, 0.0), (0.0, math.pi / 2, 0.0))]))
    params, text = bloodborne_binders()
    (data / "param" / "gameparam").mkdir(parents=True)
    params.write(data / "param" / "gameparam" / "gameparam.parambnd.dcx")
    (data / "msg" / "engus").mkdir(parents=True)
    text.write(data / "msg" / "engus" / "item.msgbnd.dcx")
    (data / "event").mkdir()
    script = BloodborneEMEVD.from_evs_string(BB_EVENT_SCRIPT, map_name=CATHEDRAL_WARD)
    script.dcx_type = DCXType.DCX_DFLT_10000_44_9
    (data / "event" / f"{CATHEDRAL_WARD}.emevd.dcx").write_bytes(script.to_bytes())
    return root


# --- A made-up Dark Souls Remastered folder with what a map needs ------------------------------------------------
#
# On top of make_dsr: a third area, "Anor Londo" (m15_01), with two stacked floors (a ground plane and a raised
# floor over a walled room), a small platform placed by a moved collision part, two bonfires registered by its
# event script (one directly, one through an event run with arguments), treasure with item lots, a boss, an NPC,
# an enemy with a one-time guaranteed drop and a regular enemy; full item lot, goods and character tables; and the
# item, NPC and place name text. All of it invented.

ANOR_LONDO = "m15_01_00_00"
MAP_LOTS = {
    # lot: (item category, item id, count, flag)
    1010000: (0x40000000, 1000, 2, 51010000),  # goods: an upgrade material
    1010010: (0x40000000, 2000, 1, 51010010),  # goods: a key item
    1010020: (0x10000000, 10000, 1, 51010020),  # armour
    1510000: (0x20000000, 100, 1, 51510000),  # ring
    1510010: (0x40000000, 200, 3, 51510010),  # goods: a consumable, three of them
    1510020: (0x00000000, 100005, 1, 51510020),  # weapon, +5
    1510030: (0x40000000, 400, 1, 0),  # goods: souls (no flag)
    1510100: (0x00000000, 200000, 1, 51510100),  # weapon: an enemy's one-time drop
}
GOODS_TYPES = {200: 0, 400: 0, 1000: 2, 2000: 1, 3000: 5}
ITEM_TEXT = {
    10: {200: "Made-up Firebomb", 400: "Made-up Soul", 1000: "Made-up Shard", 2000: "Made-up Key", 3000: "Made-up Spell"},
    111: {2000: "Made-up Key of the Patch"},
    11: {100000: "Made-up Sword", 200000: "Made-up Axe"},
    12: {10000: "Made-up Helm"},
    13: {100: "Made-up Ring"},
    18: {6000: "Made-up Knight"},
    19: {1501: "Made-up Cathedral"},
    24: {200: "A made-up description of a made-up firebomb."},
    27: {100: "A ring that was made up for a test."},
}


def quad(x0: float, x1: float, z0: float, z1: float, y: float) -> list[list[tuple[float, float, float]]]:
    """A flat rectangle at height y, as two triangles facing up."""
    return [[(x0, y, z0), (x0, y, z1), (x1, y, z0)], [(x1, y, z0), (x0, y, z1), (x1, y, z1)]]


def wall(x0: float, z0: float, x1: float, z1: float, y0: float, y1: float) -> list[list[tuple[float, float, float]]]:
    """An upright rectangle from (x0, z0) to (x1, z1), from height y0 to y1, as two triangles."""
    return [[(x0, y0, z0), (x1, y0, z1), (x0, y1, z0)], [(x1, y0, z1), (x1, y1, z1), (x0, y1, z0)]]


def mesh_model(name: str, triangles: list[list[tuple[float, float, float]]]) -> MapCollisionModel:
    vertices = np.array([[*corner, 0.0] for triangle in triangles for corner in triangle], dtype=np.float32)
    faces = np.array([[3 * i, 3 * i + 1, 3 * i + 2, 0] for i in range(len(triangles))], dtype=np.uint16)
    model = MapCollisionModel(name=name, meshes=[MapCollisionModelMesh(vertices, faces, 1)])
    model.havok_module = HavokModule.hk2015
    model.dcx_type = DCXType.DCX_DFLT_10000_24_9
    return model


def two_floor_triangles() -> list[list[tuple[float, float, float]]]:
    """A 120 m ground plane in 20 m tiles; a walled room (25 m square) with a raised floor on top at 9 m, with a
    low wall round its edge."""
    triangles = []
    for x in range(-60, 60, 20):
        for z in range(-60, 60, 20):
            triangles += quad(x, x + 20, z, z + 20, 0.0)
    triangles += quad(-25, 25, -25, 25, 9.0)
    for (x0, z0), (x1, z1) in (((-25, -25), (25, -25)), ((25, -25), (25, 25)), ((25, 25), (-25, 25)), ((-25, 25), (-25, -25))):
        triangles += wall(x0, z0, x1, z1, 0.0, 9.0)
        triangles += wall(x0, z0, x1, z1, 9.0, 10.5)
    return triangles


Triangles = list[list[tuple[float, float, float]]]


def slab(x0: float, x1: float, z0: float, z1: float, y: float, holes: tuple[tuple[float, ...], ...] = (), step: float = 2.0) -> Triangles:
    """A flat floor at height y in `step`-metre squares, leaving out the squares inside `holes` ((x0, x1, z0, z1))."""
    out: Triangles = []
    for i in range(round((x1 - x0) / step)):
        for k in range(round((z1 - z0) / step)):
            a, b = x0 + i * step, z0 + k * step
            cx, cz = a + step / 2, b + step / 2
            if any(h[0] < cx < h[1] and h[2] < cz < h[3] for h in holes):
                continue
            out += quad(a, a + step, b, b + step, y)
    return out


def walls_round(x0: float, x1: float, z0: float, z1: float, y0: float, y1: float, doors: tuple[int, ...] = ()) -> Triangles:
    """Four upright walls round a rectangle; `doors` names the sides (0 south, 1 east, 2 north, 3 west) that have a
    3 m wide, 3 m high opening in their middle."""
    out: Triangles = []
    corners = ((x0, z0), (x1, z0), (x1, z1), (x0, z1))
    for side in range(4):
        (ax, az), (bx, bz) = corners[side], corners[(side + 1) % 4]
        if side not in doors:
            out += wall(ax, az, bx, bz, y0, y1)
            continue
        mx, mz = (ax + bx) / 2, (az + bz) / 2
        length = math.hypot(bx - ax, bz - az)
        ux, uz = (bx - ax) / length, (bz - az) / length
        out += wall(ax, az, mx - 1.5 * ux, mz - 1.5 * uz, y0, y1)
        out += wall(mx + 1.5 * ux, mz + 1.5 * uz, bx, bz, y0, y1)
        out += wall(mx - 1.5 * ux, mz - 1.5 * uz, mx + 1.5 * ux, mz + 1.5 * uz, y0 + 3.0, y1)
    return out


def stairs(x0: float, x1: float, z0: float, z1: float, y0: float, y1: float, steps: int) -> Triangles:
    """A flight of steps rising from y0 at x0 to y1 at x1 (treads and risers), across z0 to z1."""
    out: Triangles = []
    run, rise = (x1 - x0) / steps, (y1 - y0) / steps
    for i in range(steps):
        a, y = x0 + i * run, y0 + (i + 1) * rise
        out += wall(a, z0, a, z1, y - rise, y)
        out += quad(min(a, a + run), max(a, a + run), z0, z1, y)
    return out


def ramp(x0: float, x1: float, z0: float, z1: float, y0: float, y1: float, pieces: int = 8) -> Triangles:
    """A ramp rising from y0 at z0 to y1 at z1, across x0 to x1."""
    out: Triangles = []
    for i in range(pieces):
        za, zb = z0 + (z1 - z0) * i / pieces, z0 + (z1 - z0) * (i + 1) / pieces
        ya, yb = y0 + (y1 - y0) * i / pieces, y0 + (y1 - y0) * (i + 1) / pieces
        out += [[(x0, ya, za), (x0, yb, zb), (x1, ya, za)], [(x1, ya, za), (x0, yb, zb), (x1, yb, zb)]]
    return out


def made_up_keep() -> tuple[Triangles, list[tuple[tuple[float, float, float], str]]]:
    """A made-up area that looks like a real one, for the floor views: a courtyard (0 m) with a sunken garden to the
    west (-3 m, steps down); a keep with a ground floor of rooms, a first floor at 5 m and a second at 10 m (stairs
    inside between them), a walkable roof at 15 m with a parapet, and a balcony over the courtyard (an overhang); a
    curtain wall with a wall walk at 5 m and a ramp up to it; a tower with its top at 22 m. Every coordinate is
    invented. Returns the triangles and the markers ((x, height, z), category), at walking height."""
    t: Triangles = []
    # Ground: the courtyard, the sunken garden, the wall between them and the steps down.
    t += slab(-40, 60, -50, 50, 0.0, step=5.0)
    t += slab(-70, -46, -50, 50, -3.0, step=5.0)
    t += wall(-40, -50, -40, -6, -3.0, 0.0) + wall(-40, 6, -40, 50, -3.0, 0.0)
    t += stairs(-40, -46, -6, 6, 0.0, -3.0, 8)
    t += walls_round(-70, 60, -50, 50, -3.0, 4.0)  # the outer wall of the area
    # The keep: outer walls to the roof, rooms on the ground floor, two floors with stairwells, the roof.
    t += walls_round(-30, 10, -20, 20, 0.0, 15.0, doors=(1,))
    t += wall(-10, -20, -10, -2, 0.0, 5.0) + wall(-10, 2, -10, 20, 0.0, 5.0) + wall(-10, -2, -10, 2, 3.0, 5.0)
    t += wall(-30, 0, -10, 0, 0.0, 5.0)
    first_hole = (-28, -18, -20, -14)
    second_hole = (-28, -18, 14, 20)
    t += slab(-30, 10, -20, 20, 5.0, holes=(first_hole,))
    t += stairs(-28, -18, -20, -14, 0.0, 5.0, 16)
    t += wall(-30, 6, -2, 6, 5.0, 10.0)
    t += slab(-30, 10, -20, 20, 10.0, holes=(second_hole,))
    t += stairs(-28, -18, 14, 20, 5.0, 10.0, 16)
    t += slab(-30, 10, -20, 20, 15.0)
    t += walls_round(-30, 10, -20, 20, 15.0, 16.2)
    # The balcony on the north side at 5 m, over the courtyard, with its rail.
    t += slab(-22, -2, 20, 28, 5.0)
    t += wall(-22, 28, -2, 28, 5.0, 6.1) + wall(-22, 20, -22, 28, 5.0, 6.1) + wall(-2, 28, -2, 20, 5.0, 6.1)
    # The curtain wall to the east with its wall walk at 5 m, and the ramp up to it from the south.
    t += walls_round(10, 50, -20, -14, 0.0, 5.0)
    t += slab(10, 50, -20, -14, 5.0)
    t += wall(10, -20, 50, -20, 5.0, 6.2)
    t += ramp(44, 50, -44, -20, 0.0, 5.0)
    # The tower, with a landing at 11 m and its top at 22 m.
    t += walls_round(30, 40, 10, 20, 0.0, 22.0, doors=(3,))
    t += slab(30, 40, 10, 20, 11.0, holes=((30, 34, 10, 14),))
    t += slab(30, 40, 10, 20, 22.0)
    t += walls_round(30, 40, 10, 20, 22.0, 23.2)
    markers = [
        ((0.0, 0.0, -35.0), "bonfire"),
        ((25.0, 0.0, 30.0), "consumable"),
        ((-55.0, -3.0, 20.0), "ring"),
        ((-60.0, -3.0, -30.0), "souls"),
        ((-20.0, 0.0, -8.0), "weapon"),
        ((0.0, 0.0, 10.0), "npc"),
        ((-23.0, 2.5, -17.0), "consumable"),  # on the stairs
        ((-20.0, 5.0, 0.0), "upgrade"),
        ((0.0, 5.0, -10.0), "armour"),
        ((-12.0, 5.0, 24.0), "key"),  # on the balcony
        ((30.0, 5.0, -17.0), "souls"),  # on the wall walk
        ((47.0, 2.6, -32.0), "consumable"),  # on the ramp
        ((-15.0, 10.0, -10.0), "spell"),
        ((-25.0, 10.0, 8.0), "ring"),
        ((-10.0, 15.0, 0.0), "boss"),
        ((35.0, 11.0, 17.0), "upgrade"),
        ((36.0, 22.0, 15.0), "drop"),
    ]
    return t, markers


def make_anor_londo_msb() -> MSB:
    msb = MSB()
    base = 1510000
    msb.collisions.new(
        name="h0000B0", model=msb.auto_collision_model("h0000B0", ANOR_LONDO), place_name_banner_id=1501
    )
    msb.collisions.new(
        name="h0001B0",
        model=msb.auto_collision_model("h0001B0", ANOR_LONDO),
        translate=Vector3((45.0, 12.0, 45.0)),
        rotate=Vector3((0.0, 30.0, 0.0)),
    )
    bonfire_ground = msb.objects.new(
        name="o0510_0001", model=msb.auto_object_model("o0510"), translate=Vector3((5.0, 0.0, 40.0)), entity_id=base + 1960
    )
    msb.objects.new(
        name="o0510_0002", model=msb.auto_object_model("o0510"), translate=Vector3((0.0, 9.0, 0.0)), entity_id=base + 1961
    )
    chest = msb.objects.new(name="o0500_0001", model=msb.auto_object_model("o0500"), translate=Vector3((10.0, 9.0, 10.0)))
    corpse = msb.objects.new(name="o5010_0001", model=msb.auto_object_model("o5010"), translate=Vector3((-40.0, 0.0, -40.0)))
    perch = msb.objects.new(name="o5010_0002", model=msb.auto_object_model("o5010"), translate=Vector3((45.0, 12.2, 45.0)))
    msb.treasures.new(name="Ring chest", treasure_part=chest, item_lot_1=1510000, is_in_chest=True)
    msb.treasures.new(name="Firebombs", treasure_part=corpse, item_lot_1=1510010)
    msb.treasures.new(name="Perch", treasure_part=perch, item_lot_1=1510020, item_lot_2=1510030, item_lot_3=7777777)
    msb.characters.new(
        name="c5270_0000", model=msb.auto_character_model("c5270"), translate=Vector3((0.0, 9.0, -10.0)), entity_id=base + 800
    )
    msb.characters.new(
        name="c0000_0001",
        model=msb.auto_character_model("c0000"),
        translate=Vector3((-30.0, 0.0, 30.0)),
        character_id=6000,
        talk_id=150100,
    )
    msb.characters.new(
        name="c2790_0000", model=msb.auto_character_model("c2790"), translate=Vector3((30.0, 0.0, -30.0)), character_id=279000
    )
    msb.characters.new(
        name="c2800_0005", model=msb.auto_character_model("c2800"), translate=Vector3((-10.0, 0.0, -50.0)), character_id=280000
    )
    msb.characters.new(
        name="c1000_0000", model=msb.auto_character_model("c1000"), translate=Vector3((5.0, 0.0, 40.0)), talk_id=151000
    )
    msb.player_starts.new(name="c0000_0000", model=msb.auto_player_model("c0000"), translate=Vector3((0.0, 0.0, 50.0)))
    _ = bonfire_ground
    return msb


EVENT_SCRIPT = """
from soulstruct.darksouls1r.events import *
from soulstruct.darksouls1r.events.instructions import *


@ContinueOnRest(0)
def Constructor():
    RegisterBonfire(11510984, obj=1511960)
    RunEvent(11510100, slot=0, args=(11510976, 1511961))


@ContinueOnRest(11510100)
def Bonfire(_, flag: int, obj: int):
    RegisterBonfire(flag, obj=obj)
"""


def map_param_binder() -> Binder:
    lots = {}
    for lot_id, (category, item_id, count, flag) in MAP_LOTS.items():
        lots[lot_id] = ITEMLOT_PARAM_ST(
            Item1ID=item_id, Item1Category=category, Item1Count=count, Item1ChancePoints=100, ItemFlag=flag
        )
    goods = {goods_id: EQUIP_PARAM_GOODS_ST(GoodType=kind) for goods_id, kind in GOODS_TYPES.items()}
    npcs = {
        6000: NPC_PARAM_ST(NameID=6000),
        279000: NPC_PARAM_ST(ItemLotID1=1510100),
        280000: NPC_PARAM_ST(),
    }
    entries = []
    for index, (file, row_type, rows) in enumerate(
        (
            ("ItemLotParam", ITEMLOT_PARAM_ST, lots),
            ("EquipParamGoods", EQUIP_PARAM_GOODS_ST, goods),
            ("NpcParam", NPC_PARAM_ST, npcs),
        )
    ):
        param = TypedParam(row_type)(param_type=row_type.__name__, rows=rows)
        entries.append(
            BinderEntry(data=param.to_bytes(), entry_id=index, path=f"N:\\FRPG\\data\\INTERROOT_x64\\param\\GameParam\\{file}.param")
        )
    return Binder(version=BinderVersion.V3, v4_info=None, dcx_type=DCXType.DCX_DFLT_10000_24_9, entries=entries)


def map_text_binder() -> Binder:
    entries = [
        BinderEntry(data=FMG(entries=texts).to_bytes(), entry_id=entry_id, path=f"N:\\FRPG\\data\\Msg\\Data_ENGLISH\\made_up_{entry_id}.fmg")
        for entry_id, texts in ITEM_TEXT.items()
    ]
    return Binder(version=BinderVersion.V3, v4_info=None, dcx_type=DCXType.DCX_DFLT_10000_24_9, entries=entries)


def make_dsr_map(root: Path) -> Path:
    make_dsr(root)
    make_anor_londo_msb().write(root / "map" / "MapStudio" / f"{ANOR_LONDO}.msb")
    folder = root / "map" / ANOR_LONDO
    folder.mkdir()
    binder = HKXBHD(map_stem=ANOR_LONDO)
    binder.set_hkx("h0000B0A15", mesh_model("h0000B0", two_floor_triangles()))
    binder.set_hkx("h0001B0A15", mesh_model("h0001B0", quad(-5, 5, -5, 5, 0.0)))
    binder.write(folder / f"h{ANOR_LONDO[1:]}.hkxbhd")
    (root / "event").mkdir()
    script = EMEVD.from_evs_string(EVENT_SCRIPT, map_name=ANOR_LONDO)
    script.dcx_type = DCXType.DCX_DFLT_10000_24_9
    (root / "event" / f"{ANOR_LONDO}.emevd.dcx").write_bytes(script.to_bytes())
    for path, binder in (
        (root / "param" / "GameParam" / "GameParam.parambnd.dcx", map_param_binder()),
        (root / "msg" / "ENGLISH" / "item.msgbnd.dcx", map_text_binder()),
    ):
        path.unlink()  # replaced, without the backup copy Soulstruct would leave
        binder.write(path)
    return root


def bridge_over_street() -> Triangles:
    """A made-up street (0 m, running north) between two raised plazas (8 m), each with a ramp down to the street at
    its south end, a ramp from the east plaza down to the street's north end, and a bridge at 8 m joining the
    plazas across the street (x 20 to 40, z 26 to 34). Every coordinate is invented."""
    t: Triangles = []
    t += slab(20, 40, -50, 100, 0.0)
    for x0, x1 in ((0, 20), (40, 60)):
        t += slab(x0, x1, -50, -40, 0.0)
        t += ramp(x0, x1, -40, 0, 0.0, 8.0)
        t += slab(x0, x1, 0, 60, 8.0)
    t += ramp(40, 60, 60, 100, 8.0, 0.0)
    t += slab(20, 40, 26, 34, 8.0)
    return t



# On top of make_dsr_map: Anor Londo's own models (map pieces) and textures, all made up. A ground plane (its
# texture a DXT1 picture in the area's texture binder, `map/m15/m15_0000.tpfbhd`), a roof over the walled room whose
# vertices stand on a bone 9 m up (a BC7 picture with a DX10 header, 128 x 64), a crate moved, turned and scaled by
# its part (a BC1 sRGB picture in a loose TPF in the area folder) with a cut-out leaf (a DXT5 picture with holes,
# found in another area's binder) and a mesh whose texture is nowhere, and a model file that is not a FLVER.

GROUND_COLOUR = (230, 120, 40)  # orange
ROOF_COLOUR = (40, 90, 220)  # blue
CRATE_COLOUR = (30, 200, 60)  # green
LEAF_COLOUR = (250, 240, 30)  # yellow


def dds_dx10(width: int, height: int, dxgi: int, blocks: bytes) -> bytes:
    """A DDS file with a DX10 header around block-compressed data."""
    header = struct.pack(
        "<4sIIIIIII44sII4sIIIIIIIIII",
        b"DDS ",
        124,
        0x1 | 0x2 | 0x4 | 0x1000 | 0x80000,
        height,
        width,
        len(blocks),
        0,
        1,
        b"\0" * 44,
        32,
        0x4,
        b"DX10",
        0, 0, 0, 0, 0,
        0x1000, 0, 0, 0, 0,
    )
    return header + struct.pack("<IIIII", dxgi, 3, 0, 1, 0) + blocks


def bc7_solid(width: int, height: int, colour: tuple[int, int, int]) -> bytes:
    """BC7 blocks of one colour (mode 6: two 7-bit endpoints with a shared low bit, every index 0)."""
    return bc7_block(colour) * ((width + 3) // 4) * ((height + 3) // 4)


def bc7_block(colour: tuple[int, int, int]) -> bytes:
    """One BC7 block (4 x 4 pixels, 16 bytes) of one colour."""
    bits, at = 0, 0

    def put(value: int, count: int) -> None:
        nonlocal bits, at
        bits |= value << at
        at += count

    put(0x40, 7)  # mode 6
    for channel in (*colour, 255):
        put(channel >> 1, 7)
        put(channel >> 1, 7)
    put(1, 1)
    put(1, 1)
    return bits.to_bytes(16, "little")


def pillow_dds(picture: tp.Any, pixel_format: str) -> bytes:
    import io

    out = io.BytesIO()
    picture.save(out, "DDS", pixel_format=pixel_format)
    return out.getvalue()


def made_up_textures() -> dict[str, bytes]:
    from PIL import Image

    ground = Image.new("RGBA", (64, 32), GROUND_COLOUR + (255,))
    crate = Image.new("RGBA", (16, 16), CRATE_COLOUR + (255,))
    leaf = Image.new("RGBA", (16, 16), LEAF_COLOUR + (255,))
    for x in range(8):  # its left half cut out
        for y in range(16):
            leaf.putpixel((x, y), (0, 0, 0, 0))
    crate_dds = pillow_dds(crate, "DXT1")
    return {
        "m15_made_ground": pillow_dds(ground, "DXT1"),
        "m15_made_roof": dds_dx10(128, 64, 98, bc7_solid(128, 64, ROOF_COLOUR)),  # BC7_UNORM
        "m15_made_crate": dds_dx10(16, 16, 72, crate_dds[128:]),  # BC1_UNORM_SRGB
        "m15_made_leaf": pillow_dds(leaf, "DXT5"),
    }


def tpf_of(stem: str, dds: bytes) -> bytes:
    from soulstruct.containers.tpf import TPF, TPFPlatform, TPFTexture

    return TPF(textures=[TPFTexture(stem=stem, format=0, data=dds)], platform=TPFPlatform.PC, encoding_type=1).to_bytes()


def write_texture_binder(path: Path, textures: dict[str, bytes]) -> None:
    """A split texture binder (`.tpfbhd` + `.tpfbdt`), one TPF per entry, the first compressed."""
    from soulstruct.dcx import compress

    entries = []
    for index, (stem, dds) in enumerate(textures.items()):
        data = tpf_of(stem, dds)
        name = f"{stem}.tpf"
        if index == 0:
            data, name = compress(data, DCXType.DCX_DFLT_10000_24_9), f"{stem}.tpf.dcx"
        entries.append(BinderEntry(data=data, entry_id=index, path=name))
    path.parent.mkdir(parents=True, exist_ok=True)
    Binder(version=BinderVersion.V3, v4_info=None, is_split_bxf=True, dcx_type=DCXType.Null, entries=entries).write(path)


def flver_mesh(triangles: Triangles, uv_scale: float, texture: str | None, mtd: str, bone: int = 0, texture_type: str = "g_Diffuse", culled: bool = True) -> tp.Any:
    """A FLVER mesh of `triangles` (faces kept as given; normals from their winding), texture coordinates from x and
    z times `uv_scale`, its material naming `texture` (and a normal map) and the MTD `mtd`, its vertices on `bone`."""
    from soulstruct.flver.face_set import FaceSet
    from soulstruct.flver.material import Material
    from soulstruct.flver.mesh import FLVERMesh
    from soulstruct.flver.texture import Texture
    from soulstruct.flver.vertex_array import VertexArray
    from soulstruct.flver.vertex_array_layout import (
        VertexArrayLayout,
        VertexDataFormatEnum,
        VertexNormal,
        VertexPosition,
        VertexUV,
    )

    layout = VertexArrayLayout(
        [
            VertexPosition(VertexDataFormatEnum.Float3, 0),
            VertexNormal(VertexDataFormatEnum.FourBytesB, 12),
            VertexUV(VertexDataFormatEnum.UV, 16),
        ]
    )
    _, dtype = layout.get_dtypes()
    corners = np.array(triangles, dtype=np.float64).reshape(-1, 3)
    array = np.zeros(len(corners), dtype=dtype)
    array["position"] = corners
    tris = corners.reshape(-1, 3, 3)
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    array["normal"] = np.repeat(normals, 3, axis=0)
    array["uv_0"] = corners[:, [0, 2]] * uv_scale
    textures = [Texture(path=f"N:\\FRPG\\data\\Model\\map\\m15\\tex\\{texture}_n.tga", texture_type="g_Bumpmap")]
    if texture:
        textures.insert(0, Texture(path=f"N:\\FRPG\\data\\Model\\map\\m15\\tex\\{texture}.tga", texture_type=texture_type))
    material = Material(name=f"made-up {texture}", mat_def_path=f"N:\\FRPG\\data\\Material\\mtd\\{mtd}.mtd", textures=textures)
    faces = np.arange(len(corners), dtype=np.uint32).reshape(-1, 3)
    face_set = FaceSet(flags=0, is_triangle_strip=False, use_backface_culling=culled, unk_x06=0, vertex_indices=faces)
    return FLVERMesh(
        is_dynamic=False,
        material=material,
        default_bone_index=bone,
        bone_indices=np.array([bone], dtype=np.int32),
        vertex_arrays=[VertexArray(array, layout)],
        face_sets=[face_set],
    )


def write_flver(path: Path, name: str, meshes: list[tp.Any], bones: tp.Sequence[tp.Any] = ()) -> None:
    from soulstruct.flver import FLVER
    from soulstruct.flver.bone import FLVERBone
    from soulstruct.flver.version import FLVERVersion

    flver = FLVER(version=FLVERVersion.DarkSouls_A, bones=[FLVERBone(name=name), *bones], meshes=meshes)
    write_dcx(path, flver.to_bytes())


def make_dsr_textured(root: Path) -> Path:
    from soulstruct.flver.bone import FLVERBone

    make_dsr_map(root)
    msb = make_anor_londo_msb()
    pieces = (
        ("m0000B0_0000", "m0000B0", (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
        ("m0001B0_0000", "m0001B0", (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
        ("m0002B0_0000", "m0002B0", (30.0, 0.5, 30.0), (0.0, 90.0, 0.0), (2.0, 1.0, 2.0)),
        ("m0003B0_0000", "m0003B0", (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
    )
    for name, model, position, rotation, scale in pieces:
        msb.map_pieces.new(
            name=name,
            model=msb.auto_map_piece_model(model, ANOR_LONDO),
            translate=Vector3(position),
            rotate=Vector3(rotation),
            scale=Vector3(scale),
        )
    path = root / "map" / "MapStudio" / f"{ANOR_LONDO}.msb"
    path.unlink()
    msb.write(path)

    folder = root / "map" / ANOR_LONDO
    textures = made_up_textures()
    # The ground, and a room's walls of the ground's texture, seen from inside and out.
    ground: Triangles = []
    for x in range(-60, 60, 20):
        for z in range(-60, 60, 20):
            ground += quad(x, x + 20, z, z + 20, 0.0)
    write_flver(folder / "m0000B0A15.flver.dcx", "m0000B0", [flver_mesh(ground, 0.25, "m15_made_ground", "M[D]")])
    # The roof: its vertices at 0, on a bone 9 m up (as some map pieces stand on their bones). Its underside faces down.
    roof = quad(-25, 25, -25, 25, 0.0)
    underside = [[t[0], t[2], t[1]] for t in roof]
    lift = FLVERBone(name="Roof", translate=Vector3((0.0, 9.0, 0.0)), parent_bone_index=0)
    write_flver(
        folder / "m0001B0A15.flver.dcx",
        "m0001B0",
        [flver_mesh(roof, 0.1, "m15_made_roof", "M[D]", bone=1), flver_mesh(underside, 0.1, "m15_made_roof", "M[D]", bone=1)],
        [lift],
    )
    # The crate: a lid 2 m square, 1 m up; a leaf beside it (cut out, seen from both sides); a mesh without texture.
    lid = quad(-1, 1, -1, 1, 1.0)
    leaf = quad(1.5, 3.5, -1, 1, 1.0)
    lost = quad(-1, 1, 2, 3, 1.0)
    write_flver(
        folder / "m0002B0A15.flver.dcx",
        "m0002B0",
        [
            flver_mesh(lid, 0.5, "m15_made_crate", "M[D]"),
            flver_mesh(leaf, 0.5, "m15_made_leaf", "M_made[D]_Edge", culled=False),
            flver_mesh(lost, 0.5, "m15_made_missing", "M[D]"),
        ],
    )
    (folder / "m0003B0A15.flver.dcx").write_bytes(b"not a model: made-up test file")
    write_texture_binder(root / "map" / "m15" / "m15_0000.tpfbhd", {k: textures[k] for k in ("m15_made_ground", "m15_made_roof")})
    write_dcx(folder / "m15_made_crate.tpf.dcx", tpf_of("m15_made_crate", textures["m15_made_crate"]))
    write_texture_binder(root / "map" / "m10" / "m10_0000.tpfbhd", {"m15_made_leaf": textures["m15_made_leaf"]})
    return root


# --- A made-up Bloodborne dump with the game's own models and PS4 textures -----------------------------------------
#
# On top of make_bloodborne: Cathedral Ward's map pieces, each model's FLVER in its own `.mapbnd.dcx` binder in the
# area folder, as Bloodborne keeps them. A ground (`m001000`, a BC1 texture of three colours) and `HOUSES` huts
# (`m002000`, placed 20 m apart over the ground and turned), each with a roof (a BC7 texture of four colours), a
# cut-out leaf (a BC3 texture whose left half is clear: BC3's blocks are 16 bytes, which Soulstruct 2.6's own PS4
# deswizzle cuts in two) and a sign whose texture is a GNF file (not read). The textures are PS4 ones, as
# Bloodborne's: no DDS header, their blocks swizzled (ps4_swizzle), in TPF files of the PS4 platform, in a split
# BND4 binder `map/m24/m24_0000.tpfbhd` + `.tpfbdt`. All of it invented.

STONE_COLOURS = ((230, 120, 40), (30, 200, 60), (40, 90, 220))  # top left, bottom left, right half
ROOF_COLOURS = ((200, 40, 40), (240, 220, 40), (40, 200, 200), (150, 60, 200))  # quadrants, row by row
LEAF_COLOURS = ((250, 240, 30), (220, 30, 120))  # the right half's top and bottom
HOUSES = 16
BB_MODELS = {"ground": "m001000", "house": "m002000"}


def ps4_swizzle(linear: bytes, width: int, height: int, side: int, size: int) -> bytes:
    """Elements (blocks of `side` pixels a side, `size` bytes each) in row order as the PS4 keeps them: in tiles of
    8 x 8 elements, each in Morton order (Soulstruct's `morton`), the tiles row by row, padded to whole tiles."""
    from soulstruct.base.textures.dds.utilities import morton

    cols, rows = max(1, -(-width // side)), max(1, -(-height // side))
    out = bytearray()
    for i in range(-(-rows // 8)):
        for j in range(-(-cols // 8)):
            for k in range(64):
                r, c = divmod(morton(k, 8, 8), 8)
                row, col = i * 8 + r, j * 8 + c
                if row < rows and col < cols:
                    start = (row * cols + col) * size
                    out += linear[start : start + size]
                else:
                    out += bytes(size)
    return bytes(out)


def made_up_ps4_textures() -> dict[str, tuple[int, int, int, int, bytes]]:
    """Per texture: its TPF format number, its DXGI format, width, height and swizzled data."""
    from PIL import Image

    stone = Image.new("RGBA", (64, 32), STONE_COLOURS[2] + (255,))
    stone.paste(Image.new("RGBA", (32, 16), STONE_COLOURS[0] + (255,)), (0, 0))
    stone.paste(Image.new("RGBA", (32, 16), STONE_COLOURS[1] + (255,)), (0, 16))
    leaf = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    leaf.paste(Image.new("RGBA", (16, 16), LEAF_COLOURS[0] + (255,)), (16, 0))
    leaf.paste(Image.new("RGBA", (16, 16), LEAF_COLOURS[1] + (255,)), (16, 16))
    roof = b"".join(
        bc7_block(ROOF_COLOURS[(1 if row >= 8 else 0) * 2 + (1 if col >= 16 else 0)]) for row in range(16) for col in range(32)
    )
    return {
        "m24_made_stone": (0, 71, 64, 32, ps4_swizzle(pillow_dds(stone, "DXT1")[128:], 64, 32, 4, 8)),
        "m24_made_roof": (102, 98, 128, 64, ps4_swizzle(roof, 128, 64, 4, 16)),
        "m24_made_leaf": (5, 77, 32, 32, ps4_swizzle(pillow_dds(leaf, "DXT5")[128:], 32, 32, 4, 16)),
        "m24_made_sign": (0, 71, 16, 16, b"GNF " + bytes(124)),
    }


def ps4_tpf(stem: str, fmt: int, dxgi: int, width: int, height: int, data: bytes) -> bytes:
    from soulstruct.containers.tpf import DXGI_FORMAT, TPF, TPFPlatform, TPFTexture

    info = TPFTexture.ConsoleInfo(width=width, height=height, texture_count=1, unk2=0xD, dxgi_format=DXGI_FORMAT(dxgi))
    texture = TPFTexture(stem=stem, format=fmt, data=data, mipmap_count=1, console_info=info)
    return TPF(textures=[texture], platform=TPFPlatform.PS4, encoding_type=1).to_bytes()


def write_ps4_texture_binder(path: Path, textures: dict[str, tuple[int, int, int, int, bytes]]) -> None:
    """A split BND4 texture binder of PS4 TPF files, one a texture, compressed as Bloodborne's are."""
    from soulstruct.containers.core import BinderVersion4Info
    from soulstruct.dcx import compress

    entries = [
        BinderEntry(
            data=compress(ps4_tpf(stem, *texture), DCXType.DCX_DFLT_10000_44_9),
            entry_id=index,
            path=f"N:\\SPRJ\\data\\INTERROOT_ps4\\map\\m24\\tex\\{stem}.tpf.dcx",
        )
        for index, (stem, texture) in enumerate(textures.items())
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    Binder(
        version=BinderVersion.V4,
        v4_info=BinderVersion4Info.bloodborne_default(),
        is_split_bxf=True,
        dcx_type=DCXType.Null,
        entries=entries,
    ).write(path)


def write_mapbnd(folder: Path, model: str, meshes: list[tp.Any]) -> None:
    """A Bloodborne map piece binder (`m24_00_00_00_<number>.mapbnd.dcx`) holding the model's FLVER."""
    from soulstruct.containers.core import BinderVersion4Info
    from soulstruct.flver import FLVER
    from soulstruct.flver.bone import FLVERBone
    from soulstruct.flver.version import FLVERVersion

    name = f"{CATHEDRAL_WARD}_{model[1:]}"
    flver = FLVER(version=FLVERVersion.Bloodborne_DS3_A, bones=[FLVERBone(name=model)], meshes=meshes)
    binder = Binder(
        version=BinderVersion.V4,
        v4_info=BinderVersion4Info.bloodborne_default(),
        dcx_type=DCXType.DCX_DFLT_10000_44_9,
        entries=[
            BinderEntry(
                data=flver.to_bytes(),
                entry_id=200,
                path=f"N:\\SPRJ\\data\\INTERROOT_ps4\\map\\{CATHEDRAL_WARD}\\{name}\\Model\\{name}.flver",
            )
        ],
    )
    binder.write(folder / f"{name}.mapbnd.dcx")


def bloodborne_pieces(houses: int = HOUSES) -> list[Placement]:
    pieces: list[Placement] = [("m001000_0000", BB_MODELS["ground"], (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))]
    across = max(1, math.isqrt(houses))
    for index in range(houses):
        x, z = -30.0 + 20.0 * (index % across), -30.0 + 20.0 * (index // across)
        pieces.append((f"m002000_{index:04d}", BB_MODELS["house"], (x, 0.0, z), (0.0, 90.0 * (index % 4), 0.0), (1.0, 1.0, 1.0)))
    return pieces


def make_bloodborne_textured(root: Path, houses: int = HOUSES) -> Path:
    make_bloodborne(root)
    data = root / "dvdroot_ps4"
    write_dcx(
        data / "map" / "MapStudio" / f"{CATHEDRAL_WARD}.msb.dcx",
        make_bloodborne_msb(CATHEDRAL_WARD, collision="h000100", navmesh="n000100", pieces=bloodborne_pieces(houses)),
    )
    folder = data / "map" / CATHEDRAL_WARD
    ground: Triangles = []
    for x in range(-40, 40, 10):
        for z in range(-40, 40, 10):
            ground += quad(x, x + 10, z, z + 10, 0.0)
    write_mapbnd(folder, BB_MODELS["ground"], [flver_mesh(ground, 0.05, "m24_made_stone", "M[D]")])
    roof = quad(-3, 3, -3, 3, 4.0)
    leaf = quad(3.5, 5.5, -1, 1, 1.0)
    sign = quad(-1, 1, 3.5, 4.5, 1.5)
    write_mapbnd(
        folder,
        BB_MODELS["house"],
        [
            flver_mesh(roof, 0.1, "m24_made_roof", "M[D]"),
            flver_mesh(leaf, 0.5, "m24_made_leaf", "M_made[D]_Edge", culled=False),
            flver_mesh(sign, 0.5, "m24_made_sign", "M[D]"),
        ],
    )
    write_ps4_texture_binder(data / "map" / "m24" / "m24_0000.tpfbhd", made_up_ps4_textures())
    return root


if __name__ == "__main__":
    kind, target = sys.argv[1], Path(sys.argv[2])
    {
        "dsr": make_dsr,
        "dsr-map": make_dsr_map,
        "dsr-textured": make_dsr_textured,
        "bloodborne": make_bloodborne,
        "bloodborne-textured": make_bloodborne_textured,
    }[kind](target)
    print(f"Wrote a made-up {kind} folder to {target}")

