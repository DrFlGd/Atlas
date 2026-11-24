"""Unity scenes exported as a Unity project (AssetRipper's "Export all files"), for `make-model` (see levels.py).

**The scene** (`.unity`) is Unity's YAML: documents headed `--- !u!<class> &<fileID>`, read with PyYAML as plain
text (every value a string, so a long number or hex string stays as written). Read here:

- `GameObject` (1): `m_Name`, `m_IsActive`, `m_TagString` (`EditorOnly` is left out), `m_Component`;
- `Transform` (4) and `RectTransform` (224): `m_LocalPosition`, `m_LocalRotation` (a quaternion), `m_LocalScale`,
  `m_Father`; each object is placed through its parents (position · rotation · scale, parent after child);
- `MeshFilter` (33) with `m_Mesh`, drawn by the object's `MeshRenderer` (23: `m_Enabled`, `m_Materials`,
  `m_StaticBatchInfo`, `m_StaticBatchRoot`), and `SkinnedMeshRenderer` (137, in its rest pose);
- `LODGroup` (205): only the renderers of its finest level are placed;
- `MeshCollider` (64): a collision mesh, placed only when hidden surfaces are kept.

A mesh drawn with **static batching** is part of a combined mesh whose corners are already in the world (or under
its batch root): only its own submeshes are placed, where the combined mesh lies.

**Hidden** (left out unless the person keeps them): inactive objects and those under one, disabled renderers,
renderers that only cast shadows, objects with a mesh and no renderer (collision only), and names of invisible walls
and collision (levels.HIDDEN_NAMES). `Terrain`, `SpriteRenderer` and prefab instances are not read, and are counted
as not understood.

**Files**: a reference is `{fileID, guid, type}`; the `.meta` file next to each exported file gives its GUID. A mesh
is Unity's own `.asset` (YAML: `m_VertexData` with its channels and `_typelessdata`, `m_IndexBuffer`,
`m_SubMeshes`), written here as a glTF file into the work folder, or a `.glb`, `.gltf` or `.obj` file the export
program wrote; Unity's built-in cube, sphere, cylinder, capsule, plane and quad are made here. FBX meshes cannot be
read (export the meshes as glTF). A material (`.mat`) gives its main texture (`_MainTex`, `_BaseMap`,
`_BaseColorMap`, …) and colour (`_Color`, `_BaseColor`).

**Axes**: Unity is left-handed, Y up, in metres (X right, Z forward). The level's frame is glTF's: a point (x, y, z)
is (x, y, -z) there, so north on the map is Unity's +Z, as its top view shows it. Mesh files that the export
program wrote as glTF or OBJ are taken to be turned already the way glTF exporters of Unity turn them (x mirrored),
so they are turned half round about Y to match.

Another route needs none of this: export the scene as one glTF file (`.glb`), if the export program can, and choose
that file as a model (Y up, metres).
"""

from __future__ import annotations

import math
import re
import typing as tp
from pathlib import Path

import numpy as np

from .levels import (
    PICTURE_EXTENSIONS,
    Collector,
    LevelError,
    Matrix,
    Placement,
    compose,
    hidden_name,
    number,
    quaternion_matrix,
    write_mesh_glb,
)

HEADER = re.compile(r"^--- !u!(\d+) &(-?\d+)([^\n]*)$", re.M)
GUID = re.compile(r"^guid:\s*([0-9a-fA-F]{32})\s*$", re.M)
BUILTIN_GUIDS = ("0000000000000000e000000000000000", "0000000000000000f000000000000000")
BUILTIN_MESHES = {"10202": "Cube", "10206": "Cylinder", "10207": "Sphere", "10208": "Capsule", "10209": "Plane", "10210": "Quad"}
FLIP = np.diag([1.0, 1.0, -1.0, 1.0])  # Unity to the level's frame (and back)
# Meshes an export program wrote as glTF or OBJ: x mirrored from Unity's; turned half round about Y to the level's.
EXTERNAL_BASE = np.diag([-1.0, 1.0, -1.0, 1.0])
MAIN_TEXTURES = ("_MainTex", "_BaseMap", "_BaseColorMap", "_BaseColorTexture", "_Albedo", "_AlbedoMap", "_Diffuse", "_DiffuseMap", "_MainTexture")
MAIN_COLOURS = ("_Color", "_BaseColor", "_MainColor", "_BaseColorFactor")
CLASS = {
    "GameObject": "1",
    "Transform": "4",
    "MeshRenderer": "23",
    "MeshFilter": "33",
    "Mesh": "43",
    "MeshCollider": "64",
    "SkinnedMeshRenderer": "137",
    "LODGroup": "205",
    "SpriteRenderer": "212",
    "Terrain": "218",
    "RectTransform": "224",
    "PrefabInstance": "1001",
    "Prefab": "1001480554",
}
NOT_READ = {"212": "SpriteRenderer", "218": "Terrain", "1001": "PrefabInstance", "1001480554": "Prefab"}
# Vertex formats: (numpy type, bytes, normalised divisor) for Unity 2019 and later, and for earlier versions.
FORMATS_2019 = {
    "0": ("<f4", 4, None), "1": ("<f2", 2, None), "2": ("u1", 1, 255.0), "3": ("i1", 1, 127.0), "4": ("<u2", 2, 65535.0),
    "5": ("<i2", 2, 32767.0), "6": ("u1", 1, None), "7": ("i1", 1, None), "8": ("<u2", 2, None), "9": ("<i2", 2, None),
    "10": ("<u4", 4, None), "11": ("<i4", 4, None),
}
FORMATS_OLD = {"0": ("<f4", 4, None), "1": ("<f2", 2, None), "2": ("u1", 1, 255.0), "3": ("u1", 1, None), "4": ("<u4", 4, None)}


def yaml_loader() -> tp.Any:
    try:
        import yaml
    except ImportError as error:  # pragma: no cover - PyYAML is a dependency of the helper
        raise LevelError("The helper cannot read Unity scenes: PyYAML is missing. Please reinstall the app.") from error
    return yaml, getattr(yaml, "CBaseLoader", yaml.BaseLoader)


def load_documents(path: Path) -> list[tuple[str, str, bool, dict[str, tp.Any]]]:
    """A Unity YAML file's documents: class id, file id, whether stripped, and its one mapping's content."""
    try:
        text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    except OSError as error:
        raise LevelError(f"{Path(path).name} cannot be read: {error}") from error
    return load_documents_text(text, Path(path).name)


def load_documents_text(text: str, name: str = "the file") -> list[tuple[str, str, bool, dict[str, tp.Any]]]:
    """As load_documents, from the file's text."""
    headers = list(HEADER.finditer(text))
    if not headers:
        raise LevelError(f"{name} is not a Unity scene saved as text (YAML): export the project with its scenes as text.")
    yaml, loader = yaml_loader()
    plain = HEADER.sub("---", text[headers[0].start() :])
    try:
        bodies = list(yaml.load_all(plain, Loader=loader))
    except yaml.YAMLError as error:
        raise LevelError(f"{name} could not be read as YAML: {str(error).splitlines()[0][:200]}") from error
    out = []
    for header, body in zip(headers, bodies):
        content: dict[str, tp.Any] = {}
        if isinstance(body, dict) and len(body) == 1:
            value = next(iter(body.values()))
            content = value if isinstance(value, dict) else {}
        elif isinstance(body, dict):
            content = body
        out.append((header.group(1), header.group(2), "stripped" in header.group(3), content))
    return out


def ref_id(value: tp.Any) -> str | None:
    """The file id of a reference (`{fileID: …}`), None for none (0)."""
    if isinstance(value, dict):
        file_id = str(value.get("fileID", "0")).strip()
        return None if file_id in ("0", "") else file_id
    return None


def ref_guid(value: tp.Any) -> str | None:
    if isinstance(value, dict):
        guid = str(value.get("guid", "")).strip().lower()
        return guid if re.fullmatch(r"[0-9a-f]{32}", guid) and guid != "0" * 32 else None
    return None


def xyz(value: tp.Any, default: float) -> list[float]:
    if not isinstance(value, dict):
        return [default] * 3
    return [number(value.get(k, default), default) for k in ("x", "y", "z")]


def local_matrix(transform: dict[str, tp.Any]) -> Matrix:
    position = xyz(transform.get("m_LocalPosition"), 0.0)
    rotation = transform.get("m_LocalRotation")
    quat = [number(rotation.get(k), 1.0 if k == "w" else 0.0) for k in ("x", "y", "z", "w")] if isinstance(rotation, dict) else [0, 0, 0, 1]
    scale = xyz(transform.get("m_LocalScale"), 1.0)
    return compose(position, quaternion_matrix(*quat), scale)


def to_level(matrix: Matrix) -> Matrix:
    """A Unity transform in the level's frame."""
    return FLIP @ matrix @ FLIP


def srgb_to_linear(value: float) -> float:
    v = min(max(value, 0.0), 1.0)
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


class UnityScene:
    def __init__(self, path: Path, root: Path, collector: Collector, leave_out_hidden: bool, work: Path, stop: tp.Callable[[], None]):
        self.path = path
        self.root = root
        self.collector = collector
        self.report = collector.report
        self.leave_out_hidden = leave_out_hidden
        self.work = work / "unity-meshes"
        self.work.mkdir(parents=True, exist_ok=True)
        self.stop = stop
        self.documents = load_documents(path)
        self.by_id: dict[str, tuple[str, dict[str, tp.Any]]] = {}
        for class_id, file_id, _, content in self.documents:
            self.by_id[file_id] = (class_id, content)
        self.guids = self.index_guids(root)
        self.worlds: dict[str, Matrix] = {}
        self.active: dict[str, bool] = {}
        self.asset_documents: dict[Path, list[tuple[str, str, bool, dict[str, tp.Any]]] | None] = {}
        self.meshes: dict[tuple[str, str, int, int], Path | None] = {}
        self.materials: dict[str, dict[str, tp.Any] | None] = {}

    @staticmethod
    def index_guids(root: Path) -> dict[str, Path]:
        guids: dict[str, Path] = {}
        for meta in root.rglob("*.meta"):
            try:
                with open(meta, "r", encoding="utf-8", errors="replace") as handle:
                    head = handle.read(2048)
            except OSError:
                continue
            match = GUID.search(head)
            if match:
                guids.setdefault(match.group(1).lower(), meta.with_suffix(""))
        return guids

    # Objects.

    def components(self, game_object: dict[str, tp.Any]) -> list[tuple[str, dict[str, tp.Any]]]:
        out = []
        for item in game_object.get("m_Component", []) if isinstance(game_object.get("m_Component"), list) else []:
            if not isinstance(item, dict):
                continue
            for value in item.values():
                file_id = ref_id(value)
                if file_id and file_id in self.by_id:
                    out.append(self.by_id[file_id])
        return out

    def transform_of(self, game_object_id: str) -> tuple[str, dict[str, tp.Any]] | None:
        _, game_object = self.by_id.get(game_object_id, ("", {}))
        for item in game_object.get("m_Component", []) if isinstance(game_object.get("m_Component"), list) else []:
            if isinstance(item, dict):
                for value in item.values():
                    file_id = ref_id(value)
                    if file_id and self.by_id.get(file_id, ("",))[0] in (CLASS["Transform"], CLASS["RectTransform"]):
                        return file_id, self.by_id[file_id][1]
        return None

    def world(self, transform_id: str, depth: int = 0) -> Matrix:
        if transform_id in self.worlds:
            return self.worlds[transform_id]
        _, transform = self.by_id.get(transform_id, ("", {}))
        local = local_matrix(transform)
        father = ref_id(transform.get("m_Father"))
        world = self.world(father, depth + 1) @ local if father and father in self.by_id and depth < 256 else local
        self.worlds[transform_id] = world
        return world

    def active_in_hierarchy(self, transform_id: str, depth: int = 0) -> bool:
        if transform_id in self.active:
            return self.active[transform_id]
        _, transform = self.by_id.get(transform_id, ("", {}))
        game_object_id = ref_id(transform.get("m_GameObject"))
        _, game_object = self.by_id.get(game_object_id or "", ("", {}))
        active = str(game_object.get("m_IsActive", "1")).strip() != "0"
        father = ref_id(transform.get("m_Father"))
        if active and father and father in self.by_id and depth < 256:
            active = self.active_in_hierarchy(father, depth + 1)
        self.active[transform_id] = active
        return active

    # Files.

    def asset(self, guid: str) -> Path | None:
        return self.guids.get(guid)

    def asset_docs(self, path: Path) -> list[tuple[str, str, bool, dict[str, tp.Any]]] | None:
        if path not in self.asset_documents:
            try:
                self.asset_documents[path] = load_documents(path)
            except LevelError:
                self.asset_documents[path] = None
        return self.asset_documents[path]

    def mesh_file(self, ref: tp.Any, subset: tuple[int, int] | None) -> tuple[Path | None, Matrix | None, str]:
        """The mesh file a reference names (written as glTF here when it is Unity's own), the base turning its
        coordinates into the level's, and its name for the report."""
        file_id = ref_id(ref) or "0"
        guid = ref_guid(ref)
        if guid in BUILTIN_GUIDS or (guid is None and file_id in BUILTIN_MESHES and file_id not in self.by_id):
            shape = BUILTIN_MESHES.get(file_id)
            if shape is None:
                return None, None, f"built-in mesh {file_id}"
            return self.builtin(shape), None, shape
        if guid is None:
            # A mesh saved in the scene itself.
            class_id, content = self.by_id.get(file_id, ("", {}))
            if class_id != CLASS["Mesh"]:
                return None, None, f"mesh {file_id} of the scene"
            return self.native(("scene", file_id), content, subset), None, str(content.get("m_Name") or file_id)
        path = self.asset(guid)
        if path is None:
            return None, None, f"the file of GUID {guid}"
        suffix = path.suffix.lower()
        if suffix in (".glb", ".gltf", ".obj"):
            if subset is not None:
                self.report.note("Statically batched parts of glTF or OBJ meshes are placed whole.")
            return path, EXTERNAL_BASE, path.name
        if suffix in (".fbx", ".dae", ".blend", ".3ds", ".max"):
            self.report.note("FBX and other model files cannot be read: set the export program to write meshes as glTF, or as Unity's own .asset files.")
            return None, None, path.name
        docs = self.asset_docs(path)
        if not docs:
            return None, None, path.name
        meshes = [(fid, content) for class_id, fid, _, content in docs if class_id == CLASS["Mesh"]]
        chosen = next((m for m in meshes if m[0] == file_id), meshes[0] if meshes else None)
        if chosen is None:
            return None, None, path.name
        return self.native((str(path), chosen[0]), chosen[1], subset), None, path.name

    def native(self, key: tuple[str, str], mesh: dict[str, tp.Any], subset: tuple[int, int] | None) -> Path | None:
        first, count = subset if subset is not None else (0, -1)
        cache = (key[0], key[1], first, count)
        if cache not in self.meshes:
            name = f"mesh-{len(self.meshes)}"
            try:
                positions, uvs, groups = read_unity_mesh(mesh, subset)
            except (ValueError, KeyError, TypeError, IndexError) as error:
                self.report.note(f"The mesh {mesh.get('m_Name') or key[1]} could not be read: {error}")
                self.meshes[cache] = None
            else:
                if not groups or not len(positions):
                    self.meshes[cache] = None
                else:
                    self.meshes[cache] = write_mesh_glb(self.work / f"{name}.glb", positions, uvs, groups, [f"submesh {i}" for i in range(len(groups))])
        return self.meshes[cache]

    def builtin(self, shape: str) -> Path:
        cache = ("builtin", shape, 0, -1)
        if cache not in self.meshes:
            positions, uvs, triangles = builtin_mesh(shape)
            self.meshes[cache] = write_mesh_glb(self.work / f"builtin-{shape.lower()}.glb", positions, uvs, [triangles], [shape])
        path = self.meshes[cache]
        assert path is not None
        return path

    def material(self, ref: tp.Any) -> dict[str, tp.Any] | None:
        """A material's main texture and colour, as a change for the level file."""
        guid = ref_guid(ref)
        file_id = ref_id(ref)
        key = f"{guid}:{file_id}"
        if key in self.materials:
            return self.materials[key]
        content: dict[str, tp.Any] | None = None
        if guid is None and file_id:
            class_id, found = self.by_id.get(file_id, ("", {}))
            content = found if class_id == "21" else None
        elif guid is not None and guid not in BUILTIN_GUIDS:
            path = self.asset(guid)
            docs = self.asset_docs(path) if path is not None and path.suffix.lower() == ".mat" else None
            if docs:
                content = next((c for class_id, _, _, c in docs if class_id == "21"), None)
        change = None
        if content is not None:
            change = {}
            texture_ref, colour = material_values(content)
            if texture_ref is not None:
                texture_guid = ref_guid(texture_ref)
                path = self.asset(texture_guid) if texture_guid else None
                if path is not None and path.suffix.lower() in PICTURE_EXTENSIONS and path.is_file():
                    change["texture"] = path
                    self.report.textures_found += 1
                else:
                    shown = str(content.get("m_Name") or "material")
                    self.report.textures_missing[shown] = self.report.textures_missing.get(shown, 0) + 1
            if colour is not None:
                change["color"] = colour
        self.materials[key] = change or None
        return self.materials[key]

    # The scene.

    def read(self) -> None:
        report = self.report
        lower_detail: set[str] = set()
        for class_id, _, _, content in self.documents:
            if class_id == CLASS["LODGroup"]:
                for level, lod in enumerate(content.get("m_LODs", []) if isinstance(content.get("m_LODs"), list) else []):
                    if level == 0 or not isinstance(lod, dict):
                        continue
                    for item in lod.get("renderers", []) if isinstance(lod.get("renderers"), list) else []:
                        renderer = ref_id(item.get("renderer")) if isinstance(item, dict) else None
                        if renderer:
                            lower_detail.add(renderer)
            elif class_id in NOT_READ:
                report.unknown_type(NOT_READ[class_id])
        renderer_ids = {id(content): file_id for class_id, file_id, _, content in self.documents if class_id in (CLASS["MeshRenderer"], CLASS["SkinnedMeshRenderer"])}
        for n, (class_id, file_id, stripped, game_object) in enumerate(self.documents):
            if n % 256 == 0:
                self.stop()
            if class_id != CLASS["GameObject"] or stripped:
                continue
            parts = self.components(game_object)
            filters = [c for k, c in parts if k == CLASS["MeshFilter"]]
            renderers = [c for k, c in parts if k in (CLASS["MeshRenderer"], CLASS["SkinnedMeshRenderer"])]
            colliders = [c for k, c in parts if k == CLASS["MeshCollider"]]
            if not filters and not renderers and not colliders:
                continue
            transform = self.transform_of(file_id)
            if transform is None:
                report.unknown_type("object without a transform")
                continue
            name = str(game_object.get("m_Name") or "object")
            renderer = renderers[0] if renderers else None
            mesh_ref = None
            if renderer is not None and renderer in [c for k, c in parts if k == CLASS["SkinnedMeshRenderer"]]:
                mesh_ref = renderer.get("m_Mesh")
                report.note("Skinned meshes are placed in their rest pose.")
            elif filters:
                mesh_ref = filters[0].get("m_Mesh")
            if mesh_ref is None or ref_id(mesh_ref) is None:
                if colliders and not self.leave_out_hidden:
                    self.place(name, transform[0], colliders[0].get("m_Mesh"), None, [])
                elif colliders:
                    report.skip("hidden")
                elif renderers:
                    report.skip("noMesh")
                continue
            why = self.hidden(game_object, transform[0], renderer, name)
            if renderer is not None and renderer_ids.get(id(renderer)) in lower_detail:
                why = why or "lowerDetail"
            if why is not None:
                report.skip(why)
                continue
            if renderer is None and not self.leave_out_hidden and colliders:
                self.place(name, transform[0], colliders[0].get("m_Mesh"), None, [])
                continue
            materials = renderer.get("m_Materials", []) if renderer is not None and isinstance(renderer.get("m_Materials"), list) else []
            subset, root = static_batch(renderer)
            self.place(name, transform[0], mesh_ref, subset, materials, root)

    def hidden(self, game_object: dict[str, tp.Any], transform_id: str, renderer: dict[str, tp.Any] | None, name: str) -> str | None:
        if str(game_object.get("m_TagString", "")).strip() == "EditorOnly":
            return "editorOnly"
        if not self.leave_out_hidden:
            return None
        if renderer is None:
            return "hidden"
        if not self.active_in_hierarchy(transform_id):
            return "hidden"
        if str(renderer.get("m_Enabled", "1")).strip() == "0" or str(renderer.get("m_CastShadows", "1")).strip() == "3":
            return "hidden"
        if hidden_name(name):
            return "hidden"
        return None

    def place(self, name: str, transform_id: str, mesh_ref: tp.Any, subset: tuple[int, int] | None, materials: list[tp.Any], root: str | None = None) -> None:
        mesh, base, shown = self.mesh_file(mesh_ref, subset)
        if mesh is None:
            self.report.missing(shown)
            return
        if subset is not None:
            # Its corners are in the world already, or under its batch root.
            world = self.world(root) if root and root in self.by_id else np.eye(4)
        else:
            world = self.world(transform_id)
        changes = [self.material(m) for m in materials]
        if base is not None:
            # A glTF or OBJ mesh keeps its own materials (their order is not the renderer's).
            changes = []
        self.collector.add(Placement(mesh, to_level(world), name, changes, base))


def static_batch(renderer: dict[str, tp.Any] | None) -> tuple[tuple[int, int] | None, str | None]:
    """The submeshes of a combined mesh a statically batched renderer draws, and its batch root."""
    if renderer is None:
        return None, None
    info = renderer.get("m_StaticBatchInfo")
    first, count = 0, 0
    if isinstance(info, dict):
        first, count = int(number(info.get("firstSubMesh"))), int(number(info.get("subMeshCount")))
    elif isinstance(renderer.get("m_SubsetIndices"), list) and renderer["m_SubsetIndices"]:
        subsets = [int(number(v)) for v in renderer["m_SubsetIndices"]]
        first, count = min(subsets), len(subsets)
    if count <= 0:
        return None, None
    return (first, count), ref_id(renderer.get("m_StaticBatchRoot"))


def material_values(content: dict[str, tp.Any]) -> tuple[dict[str, tp.Any] | None, list[float] | None]:
    """A material's main texture reference and its colour (linear RGBA)."""
    saved = content.get("m_SavedProperties") if isinstance(content.get("m_SavedProperties"), dict) else {}

    def entries(key: str) -> dict[str, tp.Any]:
        out: dict[str, tp.Any] = {}
        for item in saved.get(key, []) if isinstance(saved.get(key), list) else []:
            if not isinstance(item, dict):
                continue
            if "first" in item and "second" in item:  # older versions
                first = item.get("first")
                name = first.get("name") if isinstance(first, dict) else None
                if name:
                    out[str(name)] = item.get("second")
            else:
                out.update(item)
        return out

    textures = entries("m_TexEnvs")
    texture = None
    for name in MAIN_TEXTURES:
        value = textures.get(name)
        if isinstance(value, dict) and ref_guid(value.get("m_Texture")):
            texture = value.get("m_Texture")
            break
    colours = entries("m_Colors")
    colour = None
    for name in MAIN_COLOURS:
        value = colours.get(name)
        if isinstance(value, dict):
            rgba = [number(value.get(k), 1.0) for k in ("r", "g", "b", "a")]
            colour = [srgb_to_linear(rgba[0]), srgb_to_linear(rgba[1]), srgb_to_linear(rgba[2]), min(max(rgba[3], 0.0), 1.0)]
            break
    return texture, colour


def read_unity_mesh(mesh: dict[str, tp.Any], subset: tuple[int, int] | None) -> tuple[np.ndarray, np.ndarray | None, list[np.ndarray]]:
    """A Unity mesh (its YAML) as positions and texture coordinates in the level's frame (z and v turned over), and
    its triangles per submesh (those of `subset` only: first submesh and count), their corners in the other order so
    that their fronts stay fronts."""
    data = mesh.get("m_VertexData")
    if not isinstance(data, dict):
        raise ValueError("it has no vertex data")
    count = int(number(data.get("m_VertexCount")))
    raw = bytes.fromhex(str(data.get("_typelessdata") or "").strip())
    channels = data.get("m_Channels") if isinstance(data.get("m_Channels"), list) else []
    if count <= 0 or not raw or not channels:
        if str(mesh.get("m_MeshCompression", "0")).strip() not in ("0", ""):
            raise ValueError("it is compressed, which is not read")
        raise ValueError("it has no vertices")
    modern = len(channels) > 8
    formats = FORMATS_2019 if modern else FORMATS_OLD
    uv_channel = 4 if modern else 3

    def layout(channel: dict[str, tp.Any]) -> tuple[int, int, int, str]:
        dimension = int(number(channel.get("dimension"))) & 0xF
        kind = str(channel.get("format", "0")).strip()
        return int(number(channel.get("stream"))), int(number(channel.get("offset"))), dimension, kind

    streams: dict[int, int] = {}
    for channel in channels:
        if isinstance(channel, dict):
            stream, _, dimension, kind = layout(channel)
            if dimension:
                streams[stream] = streams.get(stream, 0) + dimension * formats.get(kind, ("", 4, None))[1]
    starts: dict[int, int] = {}
    at = 0
    for stream in sorted(streams):
        starts[stream] = at
        at += streams[stream] * count
        at = (at + 15) // 16 * 16

    def read(index: int) -> np.ndarray | None:
        if index >= len(channels) or not isinstance(channels[index], dict):
            return None
        stream, offset, dimension, kind = layout(channels[index])
        if not dimension or kind not in formats:
            return None
        dtype, size, divisor = formats[kind]
        stride = streams[stream]
        start = starts[stream]
        if start + stride * (count - 1) + offset + dimension * size > len(raw):
            raise ValueError("its vertex data is shorter than its channels say")
        view = np.ndarray(shape=(count, dimension), dtype=np.dtype(dtype), buffer=raw, offset=start + offset, strides=(stride, size))
        values = view.astype(np.float64)
        return values / divisor if divisor else values

    positions = read(0)
    if positions is None or positions.shape[1] < 3:
        raise ValueError("it has no positions")
    positions = positions[:, :3] * np.array([1.0, 1.0, -1.0])
    uvs = read(uv_channel)
    if uvs is not None:
        uvs = np.stack([uvs[:, 0], 1.0 - uvs[:, 1]], axis=1) if uvs.shape[1] >= 2 else None
    index_bytes = bytes.fromhex(str(mesh.get("m_IndexBuffer") or "").strip())
    wide = str(mesh.get("m_IndexFormat", "0")).strip() == "1"
    indices = np.frombuffer(index_bytes, dtype="<u4" if wide else "<u2").astype(np.int64)
    submeshes = mesh.get("m_SubMeshes") if isinstance(mesh.get("m_SubMeshes"), list) else []
    if subset is not None:
        submeshes = submeshes[subset[0] : subset[0] + subset[1]]
    groups = []
    for sub in submeshes:
        if not isinstance(sub, dict) or str(sub.get("topology", "0")).strip() != "0":
            groups.append(np.zeros(0, dtype=np.int64))
            continue
        first = int(number(sub.get("firstByte"))) // (4 if wide else 2)
        many = int(number(sub.get("indexCount")))
        group = indices[first : first + many] + int(number(sub.get("baseVertex")))
        group = group[: len(group) // 3 * 3]
        if len(group) and (group.max() >= count or group.min() < 0):
            raise ValueError("a submesh names a vertex the mesh does not have")
        # Mirrored into a right-handed frame, each triangle's corners go the other way round to keep its front.
        groups.append(group.reshape(-1, 3)[:, [0, 2, 1]].reshape(-1))
    return positions, uvs, groups


def builtin_mesh(shape: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Unity's built-in meshes, as their sizes are (the cube 1 m, the plane 10 m, the sphere 1 m across, the
    cylinder and capsule 2 m high), in the level's frame. They are the same mirrored, so only their sides differ."""
    if shape == "Plane":
        positions = np.array([[-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]], float)
        uvs = np.array([[0, 1], [1, 1], [1, 0], [0, 0]], float)
        return positions, uvs, np.array([0, 2, 1, 0, 3, 2])
    if shape == "Quad":
        positions = np.array([[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]], float)
        uvs = np.array([[0, 1], [1, 1], [1, 0], [0, 0]], float)
        return positions, uvs, np.array([0, 1, 2, 0, 2, 3])
    if shape == "Cube":
        positions, uvs, triangles = [], [], []
        for axis in range(3):
            for sign in (-1.0, 1.0):
                u_axis, v_axis = [k for k in range(3) if k != axis]
                start = len(positions)
                for du, dv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    point = [0.0, 0.0, 0.0]
                    point[axis] = 0.5 * sign
                    point[u_axis] = 0.5 * du
                    point[v_axis] = 0.5 * dv
                    positions.append(point)
                    uvs.append([(du + 1) / 2, (1 - dv) / 2])
                quad = [0, 1, 2, 0, 2, 3] if sign > 0 else [0, 2, 1, 0, 3, 2]
                if axis == 1:
                    quad = [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]]
                triangles += [start + i for i in quad]
        return np.asarray(positions, float), np.asarray(uvs, float), np.asarray(triangles)
    # Round shapes: rings from the top down, each of 16 corners.
    segments = 16
    rings: list[tuple[float, float]] = []  # (height, radius)
    if shape == "Sphere":
        rings = [(0.5 * math.cos(math.pi * i / 8), 0.5 * math.sin(math.pi * i / 8)) for i in range(9)]
    elif shape == "Capsule":
        top = [(0.5 + 0.5 * math.cos(math.pi * i / 8), 0.5 * math.sin(math.pi * i / 8)) for i in range(5)]
        rings = top + [(-h, r) for h, r in reversed(top)]
    else:  # Cylinder
        rings = [(1.0, 0.0), (1.0, 0.5), (-1.0, 0.5), (-1.0, 0.0)]
    positions, uvs = [], []
    for k, (height, radius) in enumerate(rings):
        for s in range(segments + 1):
            angle = 2 * math.pi * s / segments
            positions.append([radius * math.cos(angle), height, radius * math.sin(angle)])
            uvs.append([s / segments, k / (len(rings) - 1)])
    triangles = []
    row = segments + 1
    for k in range(len(rings) - 1):
        for s in range(segments):
            a, b = k * row + s, k * row + s + 1
            c, d = a + row, b + row
            triangles += [a, b, d, a, d, c]
    return np.asarray(positions, float), np.asarray(uvs, float), np.asarray(triangles)


def read_scene(path: Path, root: Path, collector: Collector, leave_out_hidden: bool, work: Path, stop: tp.Callable[[], None]) -> None:
    UnityScene(path, root, collector, leave_out_hidden, work, stop).read()
