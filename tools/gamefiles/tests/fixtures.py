"""Made-up game folders for the tests, written with Soulstruct. They hold no game data: every part, model name,
item lot, text and coordinate here is invented, and the meshes are a few triangles.

    python tests/fixtures.py dsr <folder>         # a made-up Dark Souls Remastered install
    python tests/fixtures.py bloodborne <folder>  # a made-up Bloodborne dump layout (see make_bloodborne)

What Soulstruct 2.6.0 cannot write is noted where it matters:
- map piece models (FLVER): no writer for a minimal model, so the fixture holds a file that is not a FLVER (the
  reader's failure path); the success path is tested with a mock in test_geometry.py;
- Bloodborne MSB files: Soulstruct's Bloodborne MSB writer leaves part offsets unfilled, so the fixture's
  `.msb.dcx` files are Dark Souls Remastered MSBs, and the tests read them with the Dark Souls class (a mock);
- Bloodborne collision (Havok 2014 hknp meshes): not written; the fixture reuses a Havok 2015 mesh, and the test
  makes the mesh reader refuse it, as it refuses real Bloodborne files.
"""

from __future__ import annotations

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
from soulstruct.darksouls1r.params.paramdef import ITEMLOT_PARAM_ST  # noqa: E402
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


def make_msb(stem: str, *, with_geometry_parts: bool) -> MSB:
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
            name="h0000B1",
            model=msb.auto_collision_model("h0000B1", stem),
            translate=Vector3((5.0, 0.0, 0.0)),
            rotate=Vector3((0.0, 90.0, 0.0)),
            attached_bonfire=base + 950,
        )
        msb.navmeshes.new(name="n0000B1", model=msb.auto_navmesh_model("n0000B1", stem))
    return msb


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


def make_bloodborne(root: Path) -> Path:
    """A dump-shaped folder: eboot.bin, sce_sys/param.sfo and dvdroot_ps4 with one area. See the module notes."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "eboot.bin").write_bytes(b"not a program: made-up test file")
    (root / "sce_sys").mkdir()
    (root / "sce_sys" / "param.sfo").write_bytes(
        param_sfo({"APP_VER": "01.09", "TITLE": "Made-up Title", "TITLE_ID": "CUSA99999"})
    )
    data = root / "dvdroot_ps4"
    studio = data / "map" / "MapStudio"
    studio.mkdir(parents=True)
    msb = make_msb(CATHEDRAL_WARD, with_geometry_parts=True)
    msb.dcx_type = DCXType.DCX_DFLT_10000_44_9
    msb.write(studio / f"{CATHEDRAL_WARD}.msb.dcx")
    ward = data / "map" / CATHEDRAL_WARD
    ward.mkdir(parents=True)
    write_collision(ward, CATHEDRAL_WARD, "A24")
    navmeshes = Binder(
        version=BinderVersion.V3,
        v4_info=None,
        dcx_type=DCXType.DCX_DFLT_10000_44_9,
        entries=[
            BinderEntry(
                data=collision_model("n0000B0").to_bytes(), entry_id=0, path="N:\\SPRJ\\data\\n0000B0A24.hkx.dcx"
            )
        ],
    )
    navmeshes.write(ward / f"{CATHEDRAL_WARD}.nvmhktbnd.dcx")
    (data / "param" / "gameparam").mkdir(parents=True)
    item_lot_binder().write(data / "param" / "gameparam" / "gameparam.parambnd.dcx")
    return root


if __name__ == "__main__":
    kind, target = sys.argv[1], Path(sys.argv[2])
    {"dsr": make_dsr, "bloodborne": make_bloodborne}[kind](target)
    print(f"Wrote a made-up {kind} folder to {target}")
