"""Whole game levels that a person exported from their own installed game with an export program, made into one
model for `make-model` (model.py):

- **Unreal Engine** levels exported with FModel (unreal.py): the level (`.umap`) saved as JSON, with its meshes
  exported as glTF (`.glb`) or ActorX (`.psk`, `.pskx`), its materials as JSON and its textures as PNG;
- **Unity** scenes exported as a Unity project by AssetRipper (unity.py): the scene (`.unity`, YAML), its meshes
  (`.asset`, or `.glb`/`.obj`), materials (`.mat`) and textures (`.png`), found by the GUIDs of their `.meta` files.

Each reader turns the level into **placements**: a mesh file, where it is (a 4 × 4 matrix in the level's frame:
glTF's axes, Y up, metres, right-handed; north is -Z), its name, and the pictures of its materials. The readers
leave out what is never seen in the game when asked (hidden and collision-only surfaces, blocking volumes,
editor-only objects, lower levels of detail) and small clutter (a mesh whose box in the level is smaller than a
size), and report what they placed, skipped, did not find or did not understand.

The placements are written as an Atlas level file (`.atlaslevel`, JSON, read by the 3D builder's `level.rs`), which
names each mesh file once and places it as often as the level does; the builder reads it like any model file, so
the floors, the textured floor pictures and the 3D map are made as for a model.

Nothing is downloaded and nothing is written into the export folder: the level file (and the meshes a reader has to
write as glTF, such as Unity's own `.asset` meshes) go into the make's work folder.
"""

from __future__ import annotations

import json
import os
import struct
import typing as tp
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .check import display_path

LEVEL_SUFFIXES = {".json": "unreal", ".unity": "unity"}
MESH_EXTENSIONS = (".glb", ".gltf", ".pskx", ".psk", ".obj")
PICTURE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".tga", ".bmp")
# Names of things that are never seen in a game (invisible walls, collision shapes), left out with hidden surfaces.
HIDDEN_NAMES = ("invisible", "blockingvolume", "blocking_volume", "playerblocker", "camerablocker", "collision", "collider")
LIST_MOST = 40  # names listed in the report per list
INDEX_MOST = 400_000  # files looked at in an export folder

Matrix = np.ndarray  # 4 × 4, column vectors


class LevelError(ValueError):
    """The level export cannot be read at all; the message says why, for the person."""


def level_type(path: Path) -> str | None:
    """`unreal` or `unity` for a file that is a level export by its name, else None (a model file)."""
    return LEVEL_SUFFIXES.get(Path(path).suffix.lower())


def identity() -> Matrix:
    return np.eye(4)


def compose(translation: tp.Sequence[float], rotation: np.ndarray, scale: tp.Sequence[float]) -> Matrix:
    """T · R · S."""
    m = np.eye(4)
    m[:3, :3] = np.asarray(rotation, dtype=np.float64) @ np.diag(np.asarray(scale, dtype=np.float64))
    m[:3, 3] = np.asarray(translation, dtype=np.float64)
    return m


def quaternion_matrix(x: float, y: float, z: float, w: float) -> np.ndarray:
    """The rotation of a quaternion (normalised first; identity when it is all zeros)."""
    n = float(np.sqrt(x * x + y * y + z * z + w * w))
    if not np.isfinite(n) or n < 1e-12:
        return np.eye(3)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def number(value: tp.Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if np.isfinite(out) else default


def hidden_name(*names: str | None) -> bool:
    """A name of something never seen in game (an invisible wall, a collision shape)."""
    for name in names:
        if name:
            lowered = name.lower()
            if any(word in lowered for word in HIDDEN_NAMES) or lowered.startswith("ucx_"):
                return True
    return False


@dataclass
class Placement:
    """One mesh placed in the level."""

    mesh: Path
    matrix: Matrix
    name: str
    # Per material of the mesh file, by its index: a picture and/or a colour (linear RGBA), or None to keep it.
    materials: list[dict[str, tp.Any] | None] = field(default_factory=list)
    # The mesh's own coordinates into the level's (for an ActorX mesh: Z-up centimetres into Y-up metres).
    base: Matrix | None = None


@dataclass
class MeshInfo:
    """What the level reader needs of a mesh file without reading its triangles: its material names, which of them
    have a picture of their own, and its box in its own coordinates."""

    materials: list[str]
    textured: list[bool]
    low: np.ndarray | None
    high: np.ndarray | None


class Report:
    """What a level reader did, for the person: counts, and short lists of names."""

    def __init__(self, kind: str, file: Path, assets: Path):
        self.kind = kind
        self.file = file
        self.assets = assets
        self.placed = 0
        self.skipped: dict[str, int] = {}
        self.not_found: dict[str, int] = {}
        self.unknown: dict[str, int] = {}
        self.notes: list[str] = []
        self.textures_found = 0
        self.textures_missing: dict[str, int] = {}
        self.meshes: set[str] = set()

    def skip(self, why: str, count: int = 1) -> None:
        self.skipped[why] = self.skipped.get(why, 0) + count

    def missing(self, name: str, count: int = 1) -> None:
        self.not_found[name] = self.not_found.get(name, 0) + count

    def unknown_type(self, name: str) -> None:
        self.unknown[name] = self.unknown.get(name, 0) + 1

    def note(self, text: str) -> None:
        if text not in self.notes:
            self.notes.append(text)

    def to_dict(self) -> dict[str, tp.Any]:
        def top(counts: dict[str, int]) -> list[dict[str, tp.Any]]:
            ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
            return [{"name": name, "count": n} for name, n in ranked[:LIST_MOST]]

        return {
            "type": self.kind,
            "file": self.file.name,
            "assets": display_path(self.assets),
            "placed": self.placed,
            "meshes": len(self.meshes),
            "skipped": dict(sorted(self.skipped.items())),
            "skippedTotal": sum(self.skipped.values()),
            "notFound": top(self.not_found),
            "notFoundCount": sum(self.not_found.values()),
            "unknownTypes": top(self.unknown),
            "texturesFound": self.textures_found,
            "texturesMissing": top(self.textures_missing),
            "notes": self.notes[:LIST_MOST],
        }


SKIP_WORDS = {
    "hidden": "hidden or collision-only",
    "editorOnly": "only in the editor",
    "clutter": "smaller than the clutter size",
    "lowerDetail": "lower levels of detail",
    "noMesh": "no mesh set",
    "notRead": "mesh file could not be read",
}


def summary_lines(report: dict[str, tp.Any]) -> list[str]:
    """The report in a few plain lines, for warnings and the command line."""
    lines = [f"{report.get('placed', 0):,} meshes placed ({report.get('meshes', 0):,} different)"]
    skipped = report.get("skipped") or {}
    if skipped:
        parts = [f"{n:,} {SKIP_WORDS.get(why, why)}" for why, n in skipped.items()]
        lines.append("Left out: " + ", ".join(parts))
    if report.get("notFoundCount"):
        names = ", ".join(item["name"] for item in report.get("notFound", [])[:5])
        count = report["notFoundCount"]
        meshes = "mesh was" if count == 1 else "meshes were"
        lines.append(f"{count:,} placed {meshes} not found in the export folder: {names}")
    if report.get("unknownTypes"):
        names = ", ".join(f"{item['name']} ({item['count']})" for item in report["unknownTypes"][:6])
        lines.append(f"Not understood, so left out: {names}")
    return lines


class AssetIndex:
    """The files of an export folder, found by name: by their path inside the folder (without extension, any case)
    and by their file name alone."""

    def __init__(self, root: Path, extensions: tp.Iterable[str]):
        self.root = Path(root)
        wanted = {e.lower() for e in extensions}
        self.by_stem: dict[str, list[Path]] = {}
        self.files = 0
        for folder, dirs, files in os.walk(self.root):
            dirs.sort()
            for name in sorted(files):
                suffix = os.path.splitext(name)[1].lower()
                if suffix not in wanted:
                    continue
                path = Path(folder) / name
                self.by_stem.setdefault(os.path.splitext(name)[0].lower(), []).append(path)
                self.files += 1
                if self.files >= INDEX_MOST:
                    return

    def find(self, segments: tp.Sequence[str], extensions: tp.Sequence[str]) -> Path | None:
        """The file named by `segments` (its folders and name, outermost first, without extension) with one of
        `extensions` (the first preferred): the one whose path ends with the most of those segments."""
        if not segments:
            return None
        stem = segments[-1].lower()
        candidates = [p for p in self.by_stem.get(stem, []) if p.suffix.lower() in extensions]
        if not candidates:
            return None
        wanted = [s.lower() for s in reversed(segments[:-1])]

        def score(path: Path) -> tuple[int, int]:
            try:
                parts = [p.lower() for p in path.relative_to(self.root).parts[:-1]]
            except ValueError:
                parts = []
            parts = [p for p in reversed(parts) if p != "content"]
            matched = 0
            for want, have in zip([w for w in wanted if w != "content"], parts):
                if want != have:
                    break
                matched += 1
            return matched, -extensions.index(path.suffix.lower())

        return max(candidates, key=score)


def glb_json(path: Path) -> dict[str, tp.Any] | None:
    """The JSON of a glTF file (`.glb` chunk, or the `.gltf` file), without its buffers."""
    try:
        with open(path, "rb") as handle:
            head = handle.read(20)
            if head[:4] == b"glTF":
                length, kind = struct.unpack("<I4s", head[12:20])
                if kind != b"JSON" or length > 256 << 20:
                    return None
                return json.loads(handle.read(length).decode("utf-8"))
            handle.seek(0)
            data = handle.read(256 << 20)
        return json.loads(data.decode("utf-8-sig"))
    except (OSError, ValueError, struct.error, UnicodeDecodeError):
        return None


def gltf_info(path: Path) -> MeshInfo | None:
    document = glb_json(path)
    if not isinstance(document, dict):
        return None
    materials = document.get("materials") if isinstance(document.get("materials"), list) else []
    names = [str(m.get("name", "")) if isinstance(m, dict) else "" for m in materials]
    textured = [
        bool(isinstance(m, dict) and isinstance(m.get("pbrMetallicRoughness"), dict) and "baseColorTexture" in m["pbrMetallicRoughness"])
        for m in materials
    ]
    # The box: each mesh's position bounds through its nodes' transforms.
    accessors = document.get("accessors") if isinstance(document.get("accessors"), list) else []
    meshes = document.get("meshes") if isinstance(document.get("meshes"), list) else []
    nodes = document.get("nodes") if isinstance(document.get("nodes"), list) else []
    corners: list[np.ndarray] = []

    def mesh_corners(index: int) -> list[np.ndarray]:
        out = []
        mesh = meshes[index] if 0 <= index < len(meshes) and isinstance(meshes[index], dict) else {}
        for primitive in mesh.get("primitives", []) if isinstance(mesh.get("primitives"), list) else []:
            position = (primitive.get("attributes") or {}).get("POSITION") if isinstance(primitive, dict) else None
            if isinstance(position, int) and 0 <= position < len(accessors):
                accessor = accessors[position]
                if isinstance(accessor, dict) and len(accessor.get("min", [])) == 3 and len(accessor.get("max", [])) == 3:
                    low, high = np.asarray(accessor["min"], float), np.asarray(accessor["max"], float)
                    out += [np.array([(low, high)[i][0], (low, high)[j][1], (low, high)[k][2], 1.0]) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
        return out

    def node_matrix(node: dict[str, tp.Any]) -> Matrix:
        if isinstance(node.get("matrix"), list) and len(node["matrix"]) == 16:
            return np.asarray(node["matrix"], float).reshape(4, 4).T
        t = node.get("translation", [0, 0, 0])
        r = node.get("rotation", [0, 0, 0, 1])
        s = node.get("scale", [1, 1, 1])
        return compose(t, quaternion_matrix(*r), s)

    scene_roots: list[int] = []
    scenes = document.get("scenes") if isinstance(document.get("scenes"), list) else []
    chosen = document.get("scene", 0)
    if isinstance(chosen, int) and 0 <= chosen < len(scenes) and isinstance(scenes[chosen], dict):
        scene_roots = [n for n in scenes[chosen].get("nodes", []) if isinstance(n, int)]
    elif nodes:
        children = {c for n in nodes if isinstance(n, dict) for c in n.get("children", []) if isinstance(c, int)}
        scene_roots = [i for i in range(len(nodes)) if i not in children]
    stack = [(i, np.eye(4)) for i in scene_roots]
    seen: set[int] = set()
    while stack:
        index, parent = stack.pop()
        if index in seen or not (0 <= index < len(nodes)) or not isinstance(nodes[index], dict):
            continue
        seen.add(index)
        node = nodes[index]
        try:
            matrix = parent @ node_matrix(node)
        except (TypeError, ValueError):
            matrix = parent
        if isinstance(node.get("mesh"), int):
            corners += [matrix @ c for c in mesh_corners(node["mesh"])]
        stack += [(c, matrix) for c in node.get("children", []) if isinstance(c, int)]
    if not nodes:
        for i in range(len(meshes)):
            corners += mesh_corners(i)
    if corners:
        points = np.asarray(corners)[:, :3]
        return MeshInfo(names, textured, points.min(axis=0), points.max(axis=0))
    return MeshInfo(names, textured, None, None)


def psk_info(path: Path) -> MeshInfo | None:
    """An ActorX file's material names and its box, from its chunks."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    if not data.startswith(b"ACTRHEAD"):
        return None
    names: list[str] = []
    low = high = None
    at = 0
    while at + 32 <= len(data):
        chunk = data[at : at + 20].split(b"\0", 1)[0].decode("ascii", "replace").strip()
        size, count = struct.unpack("<ii", data[at + 24 : at + 32])
        start = at + 32
        end = start + max(size, 0) * max(count, 0)
        if end > len(data):
            break
        if chunk == "PNTS0000" and size >= 12 and count > 0:
            points = np.frombuffer(data, dtype="<f4", count=count * (size // 4), offset=start).reshape(count, size // 4)[:, :3]
            points = points[np.isfinite(points).all(axis=1)]
            if len(points):
                low, high = points.min(axis=0).astype(float), points.max(axis=0).astype(float)
        elif chunk == "MATT0000":
            for i in range(count):
                raw = data[start + i * size : start + i * size + min(size, 64)]
                names.append(raw.split(b"\0", 1)[0].decode("utf-8", "replace").strip())
        at = end
    return MeshInfo(names, [False] * len(names), low, high)


def obj_info(path: Path) -> MeshInfo | None:
    """An OBJ file's box (its `v` lines); its materials are its own (read by the builder with its `.mtl`)."""
    low = np.full(3, np.inf)
    high = np.full(3, -np.inf)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if line.startswith("v "):
                    parts = line.split()
                    try:
                        point = np.array([float(parts[1]), float(parts[2]), float(parts[3])])
                    except (IndexError, ValueError):
                        continue
                    low = np.minimum(low, point)
                    high = np.maximum(high, point)
    except OSError:
        return None
    if not np.isfinite(low).all():
        return MeshInfo([], [], None, None)
    return MeshInfo([], [], low, high)


def mesh_info(path: Path) -> MeshInfo | None:
    suffix = Path(path).suffix.lower()
    if suffix in (".glb", ".gltf"):
        return gltf_info(path)
    if suffix in (".psk", ".pskx"):
        return psk_info(path)
    if suffix == ".obj":
        return obj_info(path)
    return None


def world_size(info: MeshInfo, matrix: Matrix) -> float | None:
    """The largest side of the mesh's box once placed (metres), or None when its box is not known."""
    if info.low is None or info.high is None:
        return None
    lo, hi = info.low, info.high
    corners = np.array([[(lo, hi)[i][0], (lo, hi)[j][1], (lo, hi)[k][2], 1.0] for i in (0, 1) for j in (0, 1) for k in (0, 1)])
    placed = (matrix @ corners.T).T[:, :3]
    return float((placed.max(axis=0) - placed.min(axis=0)).max())


class Collector:
    """Gathers placements, leaving out clutter, and writes them as an Atlas level file."""

    def __init__(self, report: Report, clutter: float):
        self.report = report
        self.clutter = max(float(clutter or 0.0), 0.0)
        self.placements: list[Placement] = []
        self.infos: dict[Path, MeshInfo | None] = {}

    def info(self, mesh: Path) -> MeshInfo | None:
        if mesh not in self.infos:
            self.infos[mesh] = mesh_info(mesh)
        return self.infos[mesh]

    def add(self, placement: Placement) -> bool:
        info = self.info(placement.mesh)
        if info is None:
            self.report.skip("notRead")
            self.report.note(f"{placement.mesh.name} could not be read as a mesh file")
            return False
        if not np.isfinite(placement.matrix).all():
            self.report.skip("notRead")
            return False
        if self.clutter > 0:
            matrix = placement.matrix @ placement.base if placement.base is not None else placement.matrix
            size = world_size(info, matrix)
            if size is not None and size < self.clutter:
                self.report.skip("clutter")
                return False
        self.placements.append(placement)
        self.report.placed += 1
        self.report.meshes.add(str(placement.mesh))
        return True

    def write(self, path: Path) -> Path:
        """The Atlas level file of the placements (see the 3D builder's level.rs)."""
        meshes: dict[tuple[str, str], int] = {}
        mesh_list: list[dict[str, tp.Any]] = []
        instances: list[dict[str, tp.Any]] = []
        for placement in self.placements:
            base = None if placement.base is None else matrix_list(placement.base)
            key = (str(placement.mesh), json.dumps(base))
            if key not in meshes:
                meshes[key] = len(mesh_list)
                entry: dict[str, tp.Any] = {"file": str(placement.mesh)}
                if base is not None:
                    entry["base"] = base
                mesh_list.append(entry)
            instance: dict[str, tp.Any] = {"mesh": meshes[key], "matrix": matrix_list(placement.matrix), "name": placement.name}
            changes = [clean_change(c) for c in placement.materials]
            if any(c is not None for c in changes):
                instance["materials"] = changes
            instances.append(instance)
        document = {"atlasLevel": 1, "meshes": mesh_list, "instances": instances}
        path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        return path


def clean_change(change: dict[str, tp.Any] | None) -> dict[str, tp.Any] | None:
    if not change:
        return None
    out: dict[str, tp.Any] = {}
    if change.get("texture"):
        out["texture"] = str(change["texture"])
    if change.get("color") is not None:
        out["color"] = [round(float(v), 5) for v in change["color"]]
    return out or None


def matrix_list(matrix: Matrix) -> list[float]:
    """Column-major, as glTF and the builder take it."""
    return [round(float(v), 9) for v in np.asarray(matrix, dtype=np.float64).T.reshape(-1)]


def write_mesh_glb(path: Path, positions: np.ndarray, uvs: np.ndarray | None, groups: list[np.ndarray], names: list[str]) -> Path:
    """A glTF binary file of one mesh: shared positions (and texture coordinates), a primitive and a material per
    index group (in order, so material `i` of the file is group `i`)."""
    positions = np.ascontiguousarray(positions, dtype="<f4").reshape(-1, 3)
    binary = bytearray()
    views: list[dict[str, tp.Any]] = []
    accessors: list[dict[str, tp.Any]] = []

    def add(data: np.ndarray, kind: str, component: int, extra: dict[str, tp.Any] | None = None) -> int:
        raw = np.ascontiguousarray(data).tobytes()
        binary.extend(b"\0" * (-len(binary) % 4))
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(raw)})
        binary.extend(raw)
        accessor = {"bufferView": len(views) - 1, "componentType": component, "count": int(len(data)), "type": kind}
        accessor.update(extra or {})
        accessors.append(accessor)
        return len(accessors) - 1

    bounds = {"min": positions.min(axis=0).tolist(), "max": positions.max(axis=0).tolist()} if len(positions) else {}
    position = add(positions, "VEC3", 5126, bounds)
    attributes = {"POSITION": position}
    if uvs is not None and len(uvs) == len(positions):
        attributes["TEXCOORD_0"] = add(np.ascontiguousarray(uvs, dtype="<f4").reshape(-1, 2), "VEC2", 5126)
    primitives = []
    for i, group in enumerate(groups):
        if len(group) < 3:
            continue
        indices = add(np.ascontiguousarray(group, dtype="<u4").reshape(-1), "SCALAR", 5125)
        primitives.append({"attributes": attributes, "indices": indices, "material": i})
    document = {
        "asset": {"version": "2.0", "generator": "Atlas Map Maker"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": path.stem}],
        "meshes": [{"name": path.stem, "primitives": primitives}],
        "materials": [{"name": name, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}} for name in names],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    text = json.dumps(document, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    total = 12 + 8 + len(text) + 8 + len(binary)
    path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(text), b"JSON") + text + struct.pack("<I4s", len(binary), b"BIN\0") + bytes(binary)
    )
    return path


@dataclass
class Assembled:
    """A level made into an Atlas level file."""

    file: Path
    report: dict[str, tp.Any]


def default_assets(path: Path, kind: str) -> Path:
    """Where a level's exported files are, when the person did not say: for FModel, the `Exports` folder above the
    level (its output folder), else the folder above a `Content` folder; for Unity, the project folder (the one
    with `Assets` in it). Else the level's own folder."""
    path = Path(path).resolve()
    if kind == "unreal":
        for parent in path.parents:
            if parent.name.lower() == "exports":
                return parent
        for parent in path.parents:
            if parent.name.lower() == "content":
                return parent.parent
    else:
        for parent in path.parents:
            if parent.name.lower() == "assets":
                return parent.parent
    return path.parent


def assemble(
    path: Path,
    work: Path,
    assets: Path | None = None,
    clutter: float = 0.0,
    leave_out_hidden: bool = True,
    stop: tp.Callable[[], None] = lambda: None,
) -> Assembled:
    """Reads a level export and writes its Atlas level file into `work`. Raises LevelError when it cannot."""
    path = Path(path)
    kind = level_type(path)
    if kind is None:
        raise LevelError(f"{path.name} is not a level export: choose the .json of an Unreal Engine level or a Unity .unity scene.")
    root = Path(assets) if assets else default_assets(path, kind)
    if not root.is_dir():
        raise LevelError(f"The export folder {root} is not there. Choose the folder that holds the level's exported files.")
    work.mkdir(parents=True, exist_ok=True)
    report = Report(kind, path, root)
    collector = Collector(report, clutter)
    if kind == "unreal":
        from .unreal import read_level

        read_level(path, root, collector, leave_out_hidden, stop)
    else:
        from .unity import read_scene

        read_scene(path, root, collector, leave_out_hidden, work, stop)
    if not collector.placements:
        lines = summary_lines(report.to_dict())
        raise LevelError(f"No mesh of {path.name} could be placed. " + " ".join(line.rstrip(".") + "." for line in lines))
    level_file = collector.write(work / f"{safe_stem(path.stem)}.atlaslevel")
    return Assembled(level_file, report.to_dict())


def safe_stem(stem: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "-_ " else "_" for c in stem).strip() or "level"
    return cleaned[:60]


def inspect_level(
    path: Path,
    assets: Path | None,
    clutter: float,
    leave_out_hidden: bool,
    max_triangles: int | None,
    builder: Path | None,
    stop: tp.Callable[[], None] = lambda: None,
) -> dict[str, tp.Any]:
    """`inspect-level`: the level put together in a folder of its own that is deleted afterwards, and read by the 3D
    builder (`atlas-scene inspect`): its `info` and `preview`, with the level's report (`level`). Raises ValueError
    (LevelError) with a message for the person."""
    import shutil
    import subprocess
    import sys
    import tempfile

    from .scene import CREATE_NO_WINDOW, find_builder

    program = find_builder(builder)
    if program is None:
        raise LevelError("The 3D builder that comes with the Map Maker (atlas-scene) is missing. Please reinstall the app.")
    work = Path(tempfile.mkdtemp(prefix="atlas-level-"))
    try:
        assembled = assemble(path, work, assets=assets, clutter=clutter, leave_out_hidden=leave_out_hidden, stop=stop)
        most = str(int(max_triangles)) if max_triangles else "5000000"
        result = subprocess.run(
            [str(program), "inspect", str(assembled.file), "--max-triangles", most],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=900,
            creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        answer: dict[str, tp.Any] | None = None
        for raw in reversed(result.stdout.decode("utf-8", "replace").splitlines()):
            try:
                answer = json.loads(raw)
                break
            except ValueError:
                continue
        if not isinstance(answer, dict):
            raise LevelError(f"The 3D builder stopped without an answer (code {result.returncode}).")
        if answer.get("event") == "error":
            raise LevelError(str(answer.get("message") or "The level could not be read."))
        answer.pop("event", None)
        answer["level"] = assembled.report
        return answer
    finally:
        shutil.rmtree(work, ignore_errors=True)
