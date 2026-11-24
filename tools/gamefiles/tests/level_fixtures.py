"""Made-up game level exports for the tests of levels.py, unreal.py and unity.py: an Unreal Engine level as FModel
saves it (its exports as JSON, meshes as glTF and ActorX, materials as JSON and `.mat`, textures as PNG) and a Unity
scene as AssetRipper exports a project (YAML scene, `.asset` mesh, `.mat` material, PNG texture, `.meta` GUIDs).
Every name, number and picture here is made up; the shapes follow the export programs' documented file layouts.

    python tests/level_fixtures.py <folder>     writes both exports there
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from atlas_gamefiles.levels import write_mesh_glb  # noqa: E402

GAME = "MadeUpGame"


def picture(path: Path, rgb: tuple[int, int, int]) -> None:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (8, 8), rgb)
    for i in range(8):
        image.putpixel((i, i), (20, 20, 20))
    image.save(path)


def box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A closed box in a right-handed frame (any axes): corners, texture coordinates and triangles facing out."""
    corners = np.array([[x, y, z] for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)], dtype=float)
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    triangles = []
    for a, b, c, d in faces:
        triangles += [a, b, c, a, c, d]
    uvs = np.array([[(c[0] - x0) / (x1 - x0), (c[2] - z0) / (z1 - z0)] for c in corners])
    return corners, uvs, np.array(triangles)


def glb_box(path: Path, low: tuple[float, float, float], high: tuple[float, float, float], material: str) -> Path:
    """A box mesh as FModel writes glTF: Y up, metres; one material named after the game's material."""
    path.parent.mkdir(parents=True, exist_ok=True)
    corners, uvs, triangles = box(*low, *high)
    return write_mesh_glb(path, corners, uvs, [triangles], [material])


def psk_box(path: Path, size_cm: float, material: str) -> Path:
    """A cube as an ActorX file: Z up, centimetres, its base at 0."""
    half = size_cm / 2
    corners, uvs, triangles = box(-half, -half, 0, half, half, size_cm)
    out = bytearray()

    def chunk(name: str, size: int, count: int, data: bytes) -> None:
        out.extend(name.encode("ascii").ljust(20, b"\0") + struct.pack("<iii", 1999801, size, count) + data)

    chunk("ACTRHEAD", 0, 0, b"")
    chunk("PNTS0000", 12, len(corners), b"".join(struct.pack("<3f", *c) for c in corners))
    chunk("VTXW0000", 16, len(corners), b"".join(struct.pack("<HHffBBH", i, 0, uv[0], uv[1], 0, 0, 0) for i, uv in enumerate(uvs)))
    faces = triangles.reshape(-1, 3)
    chunk("FACE0000", 12, len(faces), b"".join(struct.pack("<3HBBI", *f, 0, 0, 1) for f in faces))
    chunk("MATT0000", 88, 1, material.encode("ascii").ljust(64, b"\0") + b"\0" * 24)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(out))
    return path


def ref(type_name: str, name: str, path: str) -> dict[str, str]:
    return {"ObjectName": f"{type_name}'{name}'", "ObjectPath": path}


def write_fmodel(folder: Path) -> Path:
    """An FModel export: `Exports/MadeUpGame/Content/...`. Returns the level's JSON.

    The level holds: a floor slab at the ground and another 4 m up (turned, with another material), a Blueprint-like
    actor whose crate (ActorX) hangs under a turned root, three pebbles of foliage (an instanced component, small
    clutter), a hidden invisible wall, a blocking volume, an editor-only mesh, a mesh that was not exported and a
    landscape (not understood)."""
    content = folder / "Exports" / GAME / "Content"
    glb_box(content / "Env" / "SM_Floor.glb", (-5, -0.2, -5), (5, 0, 5), "MI_Floor")
    glb_box(content / "Env" / "SM_Pebble.glb", (-0.1, 0, -0.1), (0.1, 0.1, 0.1), "MI_Floor")
    glb_box(content / "Env" / "SM_Wall.glb", (-2, 0, -0.1), (2, 3, 0.1), "MI_Floor")
    psk_box(content / "Props" / "SM_Crate.pskx", 100, "MI_Crate")
    picture(content / "Textures" / "T_Floor_D.png", (150, 120, 90))
    picture(content / "Textures" / "T_Floor_N.png", (128, 128, 255))
    picture(content / "Textures" / "T_Alt_BC.png", (60, 140, 60))
    picture(content / "Textures" / "T_Alt_N.png", (128, 128, 255))
    picture(content / "Textures" / "T_Crate_D.png", (180, 140, 60))
    materials = content / "Materials"
    materials.mkdir(parents=True, exist_ok=True)
    (materials / "MI_Floor.json").write_text(
        json.dumps(
            [
                {
                    "Type": "MaterialInstanceConstant",
                    "Name": "MI_Floor",
                    "Properties": {
                        "Parent": ref("Material", "M_Base", "/Game/Materials/M_Base.0"),
                        "TextureParameterValues": [
                            {"ParameterInfo": {"Name": "Normal", "Index": -1}, "ParameterValue": ref("Texture2D", "T_Floor_N", "/Game/Textures/T_Floor_N.0")},
                            {"ParameterInfo": {"Name": "BaseColor", "Index": -1}, "ParameterValue": ref("Texture2D", "T_Floor_D", "/Game/Textures/T_Floor_D.0")},
                        ],
                    },
                }
            ]
        ),
        encoding="utf-8",
    )
    (materials / "MI_Floor_Alt.json").write_text(
        json.dumps([{"Type": "MaterialInstanceConstant", "Name": "MI_Floor_Alt", "Properties": {"Parent": ref("Material", "M_Alt", "/Game/Materials/M_Alt.0")}}]),
        encoding="utf-8",
    )
    (materials / "M_Alt.json").write_text(
        json.dumps(
            [
                {
                    "Type": "Material",
                    "Name": "M_Alt",
                    "Properties": {"CachedReferencedTextures": [ref("Texture2D", "T_Alt_N", "/Game/Textures/T_Alt_N.0"), ref("Texture2D", "T_Alt_BC", "/Game/Textures/T_Alt_BC.0")]},
                }
            ]
        ),
        encoding="utf-8",
    )
    (content / "Props" / "MI_Crate.mat").write_text("Diffuse=T_Crate_D\nNormal=T_Crate_N\n", encoding="utf-8")

    level = "/Game/Maps/Test_Level"
    exports: list[dict] = []

    def add(export: dict) -> dict:
        exports.append(export)
        return export

    def local(name: str, outer: str, type_name: str) -> dict[str, str]:
        index = next(i for i, e in enumerate(exports) if e["Name"] == name and e.get("Outer") == outer)
        return ref(type_name, f"Test_Level:PersistentLevel.{outer}.{name}", f"{level}.{index}")

    def mesh(name: str) -> dict[str, str]:
        folder_name = "Props" if name == "SM_Crate" else "Env"
        return ref("StaticMesh", name, f"/Game/{folder_name}/{name}.0")

    add({"Type": "World", "Name": "Test_Level", "Properties": {}})
    add({"Type": "Level", "Name": "PersistentLevel", "Outer": "Test_Level"})
    # Floors: one at the ground, one 4 m up, turned, with another material.
    add({"Type": "StaticMeshComponent", "Name": "StaticMeshComponent0", "Outer": "Floor_1", "Properties": {"StaticMesh": mesh("SM_Floor")}})
    add({"Type": "StaticMeshActor", "Name": "Floor_1", "Outer": "PersistentLevel", "Properties": {"RootComponent": local("StaticMeshComponent0", "Floor_1", "StaticMeshComponent")}})
    add(
        {
            "Type": "StaticMeshComponent",
            "Name": "StaticMeshComponent0",
            "Outer": "Floor_2",
            "Properties": {
                "StaticMesh": mesh("SM_Floor"),
                "RelativeLocation": {"X": 0, "Y": 0, "Z": 400},
                "RelativeRotation": {"Pitch": 0, "Yaw": 90, "Roll": 0},
                "OverrideMaterials": [ref("MaterialInstanceConstant", "MI_Floor_Alt", "/Game/Materials/MI_Floor_Alt.0")],
            },
        }
    )
    add({"Type": "StaticMeshActor", "Name": "Floor_2", "Outer": "PersistentLevel", "Properties": {"RootComponent": local("StaticMeshComponent0", "Floor_2", "StaticMeshComponent")}})
    # A Blueprint-like actor: a turned root at (10 m, 5 m), and a crate 1 m along the root's X.
    add(
        {
            "Type": "SceneComponent",
            "Name": "DefaultSceneRoot",
            "Outer": "BP_Crates_C_1",
            "Properties": {"RelativeLocation": {"X": 1000, "Y": 500, "Z": 0}, "RelativeRotation": {"Pitch": 0, "Yaw": 90, "Roll": 0}},
        }
    )
    add(
        {
            "Type": "StaticMeshComponent",
            "Name": "Crate",
            "Outer": "BP_Crates_C_1",
            "Properties": {"StaticMesh": mesh("SM_Crate"), "RelativeLocation": {"X": 100, "Y": 0, "Z": 0}},
        }
    )
    exports[-1]["Properties"]["AttachParent"] = local("DefaultSceneRoot", "BP_Crates_C_1", "SceneComponent")
    add({"Type": "BP_Crates_C", "Name": "BP_Crates_C_1", "Outer": "PersistentLevel", "Properties": {"RootComponent": local("DefaultSceneRoot", "BP_Crates_C_1", "SceneComponent")}})
    # Foliage: three pebbles (20 cm), each instance's transform relative to the component.
    add(
        {
            "Type": "HierarchicalInstancedStaticMeshComponent",
            "Name": "Foliage_Pebbles",
            "Outer": "InstancedFoliageActor_0",
            "Properties": {"StaticMesh": mesh("SM_Pebble")},
            "PerInstanceSMData": [
                {"TransformData": {"Rotation": {"X": 0, "Y": 0, "Z": 0, "W": 1}, "Translation": {"X": 200 * i, "Y": -300, "Z": 0}, "Scale3D": {"X": 1, "Y": 1, "Z": 1}}}
                for i in range(3)
            ],
        }
    )
    add({"Type": "InstancedFoliageActor", "Name": "InstancedFoliageActor_0", "Outer": "PersistentLevel", "Properties": {}})
    # Never seen in game: a hidden invisible wall, a blocking volume, an editor-only mesh.
    add(
        {
            "Type": "StaticMeshComponent",
            "Name": "StaticMeshComponent0",
            "Outer": "Wall_Hidden",
            "Properties": {"StaticMesh": mesh("SM_Wall"), "bHiddenInGame": True, "RelativeLocation": {"X": 0, "Y": 800, "Z": 0}},
        }
    )
    add({"Type": "StaticMeshActor", "Name": "Wall_Hidden", "Outer": "PersistentLevel", "Properties": {}})
    add({"Type": "BrushComponent", "Name": "BrushComponent0", "Outer": "BlockingVolume_1", "Properties": {}})
    add({"Type": "BlockingVolume", "Name": "BlockingVolume_1", "Outer": "PersistentLevel", "Properties": {}})
    add({"Type": "StaticMeshComponent", "Name": "StaticMeshComponent0", "Outer": "Editor_Marker", "Properties": {"StaticMesh": mesh("SM_Wall"), "bIsEditorOnly": True}})
    add({"Type": "StaticMeshActor", "Name": "Editor_Marker", "Outer": "PersistentLevel", "Properties": {}})
    # A mesh that was not exported, and a landscape.
    add({"Type": "StaticMeshComponent", "Name": "StaticMeshComponent0", "Outer": "Lost_1", "Properties": {"StaticMesh": mesh("SM_Missing"), "SomethingNew": {"Unknown": 1}}})
    add({"Type": "StaticMeshActor", "Name": "Lost_1", "Outer": "PersistentLevel", "Properties": {}})
    add({"Type": "LandscapeComponent", "Name": "LandscapeComponent_0", "Outer": "Landscape_1", "Properties": {}})
    path = content / "Maps" / "Test_Level.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(exports, indent=2), encoding="utf-8")
    return path


# Unity.

GUIDS = {
    "slab": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    "ground_mat": "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    "ground_png": "1234567890abcdef1234567890abcdef",
}


def meta(path: Path, guid: str) -> None:
    path.with_name(path.name + ".meta").write_text(f"fileFormatVersion: 2\nguid: {guid}\nNativeFormatImporter:\n  mainObjectFileID: 0\n", encoding="utf-8")


def unity_slab_mesh(size: float = 10.0) -> str:
    """Unity's own mesh (`.asset`, YAML) of a flat square `size` metres wide at height 0, facing up in Unity (its
    triangles clockwise seen from above), with texture coordinates; the 2019 vertex layout of 14 channels, position
    and texture coordinates in one stream."""
    half = size / 2
    corners = [(-half, 0, -half), (half, 0, -half), (half, 0, half), (-half, 0, half)]
    uvs = [(0, 0), (1, 0), (1, 1), (0, 1)]
    data = b"".join(struct.pack("<3f2f", *c, *uv) for c, uv in zip(corners, uvs))
    # Clockwise seen from above in Unity's left-handed frame: 0, 2, 1 and 0, 3, 2.
    indices = struct.pack("<6H", 0, 3, 2, 0, 2, 1)
    channels = []
    for i in range(14):
        if i == 0:
            channels.append((0, 0, 0, 3))
        elif i == 4:
            channels.append((0, 12, 0, 2))
        else:
            channels.append((0, 0, 0, 0))
    channel_text = "".join(f"    - stream: {s}\n      offset: {o}\n      format: {f}\n      dimension: {d}\n" for s, o, f, d in channels)
    return (
        "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!43 &4300000\nMesh:\n  m_ObjectHideFlags: 0\n  m_Name: Slab\n"
        "  serializedVersion: 10\n  m_SubMeshes:\n  - serializedVersion: 2\n    firstByte: 0\n    indexCount: 6\n"
        "    topology: 0\n    baseVertex: 0\n    firstVertex: 0\n    vertexCount: 4\n  m_IndexFormat: 0\n"
        f"  m_IndexBuffer: {indices.hex()}\n  m_VertexData:\n    serializedVersion: 3\n    m_VertexCount: 4\n"
        f"    m_Channels:\n{channel_text}    m_DataSize: {len(data)}\n    _typelessdata: {data.hex()}\n"
        "  m_LocalAABB:\n    m_Center: {x: 0, y: 0, z: 0}\n    m_Extent: {x: 5, y: 0, z: 5}\n"
    )


def write_unity(folder: Path) -> Path:
    """An AssetRipper project: `ExportedProject/Assets/...`. Returns the scene.

    The scene holds: the ground (a slab of Unity's own mesh with a textured material), an upper floor 4 m up under
    a parent turned a quarter round, a built-in cube crate at (5, 0, 3), an inactive object, a disabled renderer,
    a collision-only object, an editor-only object, a finer and a coarser level of detail, a terrain (not
    understood) and a mesh whose file is not there."""
    project = folder / "ExportedProject"
    assets = project / "Assets"
    (assets / "Mesh").mkdir(parents=True, exist_ok=True)
    (assets / "Material").mkdir(parents=True, exist_ok=True)
    (assets / "Scenes").mkdir(parents=True, exist_ok=True)
    slab = assets / "Mesh" / "Slab.asset"
    slab.write_text(unity_slab_mesh(), encoding="utf-8")
    meta(slab, GUIDS["slab"])
    texture = assets / "Texture2D" / "Ground.png"
    picture(texture, (90, 150, 70))
    meta(texture, GUIDS["ground_png"])
    material = assets / "Material" / "Ground.mat"
    material.write_text(
        "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!21 &2100000\nMaterial:\n  m_Name: Ground\n"
        "  m_Shader: {fileID: 46, guid: 0000000000000000f000000000000000, type: 0}\n  m_SavedProperties:\n"
        "    serializedVersion: 3\n    m_TexEnvs:\n    - _BumpMap:\n        m_Texture: {fileID: 0}\n"
        f"    - _MainTex:\n        m_Texture: {{fileID: 2800000, guid: {GUIDS['ground_png']}, type: 3}}\n"
        "        m_Scale: {x: 1, y: 1}\n        m_Offset: {x: 0, y: 0}\n    m_Floats:\n    - _Glossiness: 0.5\n"
        "    m_Colors:\n    - _Color: {r: 1, g: 1, b: 1, a: 1}\n",
        encoding="utf-8",
    )
    meta(material, GUIDS["ground_mat"])

    docs: list[str] = []
    next_id = [100]

    def new_id() -> int:
        next_id[0] += 1
        return next_id[0]

    def game_object(name: str, position=(0, 0, 0), rotation=(0, 0, 0, 1), father: int = 0, mesh: str | None = None, renderer: bool = True,
                    collider: bool = False, active: bool = True, enabled: bool = True, tag: str = "Untagged", material: bool = True) -> tuple[int, int, int]:
        go, tr = new_id(), new_id()
        components = [tr]
        mf = mr = 0
        if mesh is not None and not collider:
            mf = new_id()
            components.append(mf)
        if renderer and mesh is not None and not collider:
            mr = new_id()
            components.append(mr)
        mc = new_id() if collider else 0
        if mc:
            components.append(mc)
        listed = "".join(f"  - component: {{fileID: {c}}}\n" for c in components)
        docs.append(f"--- !u!1 &{go}\nGameObject:\n  m_Name: {name}\n  m_TagString: {tag}\n  m_IsActive: {1 if active else 0}\n  m_Component:\n{listed}")
        docs.append(
            f"--- !u!4 &{tr}\nTransform:\n  m_GameObject: {{fileID: {go}}}\n"
            f"  m_LocalRotation: {{x: {rotation[0]}, y: {rotation[1]}, z: {rotation[2]}, w: {rotation[3]}}}\n"
            f"  m_LocalPosition: {{x: {position[0]}, y: {position[1]}, z: {position[2]}}}\n  m_LocalScale: {{x: 1, y: 1, z: 1}}\n"
            f"  m_Children: []\n  m_Father: {{fileID: {father}}}\n"
        )
        if mf:
            docs.append(f"--- !u!33 &{mf}\nMeshFilter:\n  m_GameObject: {{fileID: {go}}}\n  m_Mesh: {mesh}\n")
        if mr:
            materials = f"  - {{fileID: 2100000, guid: {GUIDS['ground_mat']}, type: 2}}\n" if material else "  - {fileID: 0}\n"
            docs.append(
                f"--- !u!23 &{mr}\nMeshRenderer:\n  m_GameObject: {{fileID: {go}}}\n  m_Enabled: {1 if enabled else 0}\n  m_CastShadows: 1\n"
                f"  m_Materials:\n{materials}  m_StaticBatchInfo:\n    firstSubMesh: 0\n    subMeshCount: 0\n  m_StaticBatchRoot: {{fileID: 0}}\n"
            )
        if mc:
            docs.append(f"--- !u!64 &{mc}\nMeshCollider:\n  m_GameObject: {{fileID: {go}}}\n  m_Mesh: {mesh}\n")
        return go, tr, mr

    slab_ref = f"{{fileID: 4300000, guid: {GUIDS['slab']}, type: 2}}"
    cube_ref = "{fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}"
    game_object("Ground", mesh=slab_ref)
    s = 0.7071067811865476
    _, turned, _ = game_object("Upper Storey", position=(0, 4, 0), rotation=(0, s, 0, s))
    game_object("Upper Floor", father=turned, mesh=slab_ref)
    # A crate 1 m along the turned parent's x: a quarter turn about Y takes x to -z.
    game_object("Turned Crate", position=(1, 4.5, 0), father=turned, mesh=cube_ref, material=False)
    game_object("Crate", position=(5, 0.5, 3), mesh=cube_ref, material=False)
    game_object("Inactive Crate", position=(-5, 0.5, -3), mesh=cube_ref, active=False)
    game_object("Disabled Crate", position=(-5, 0.5, 3), mesh=cube_ref, enabled=False)
    game_object("Invisible Wall", position=(0, 0, 9), mesh=cube_ref, collider=True)
    game_object("Editor Gizmo", position=(2, 0, 2), mesh=cube_ref, tag="EditorOnly")
    _, _, lod0 = game_object("Rock_LOD0", position=(3, 0, -3), mesh=cube_ref)
    _, _, lod1 = game_object("Rock_LOD1", position=(3, 0, -3), mesh=cube_ref)
    group = new_id()
    docs.append(
        f"--- !u!205 &{group}\nLODGroup:\n  m_LODs:\n  - screenRelativeHeight: 0.5\n    renderers:\n    - renderer: {{fileID: {lod0}}}\n"
        f"  - screenRelativeHeight: 0.1\n    renderers:\n    - renderer: {{fileID: {lod1}}}\n"
    )
    game_object("Lost Thing", mesh="{fileID: 4300000, guid: ffffffffffffffffffffffffffffffff, type: 2}")
    docs.append(f"--- !u!218 &{new_id()}\nTerrain:\n  m_Enabled: 1\n")
    scene = assets / "Scenes" / "Test Scène.unity"
    scene.write_text("%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n" + "".join(docs), encoding="utf-8")
    meta(scene, "fedcba0987654321fedcba0987654321")
    return scene


if __name__ == "__main__":
    out = Path(sys.argv[1])
    print(write_fmodel(out / "fmodel"))
    print(write_unity(out / "unity"))
