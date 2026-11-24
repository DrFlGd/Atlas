"""Unreal Engine levels exported with FModel, for `make-model` (see levels.py).

**The level**: FModel saves a level (`.umap`) as JSON: a list of its exports, each with `Type`, `Name`, `Outer` and
`Properties`. A reference to another export is `{"ObjectName": "Type'Outer.Name'", "ObjectPath":
"/Game/Path/Package.<index>"}` (older versions write it as one string, `"Type'/Game/Path/Package.Name'"`). Read here:

- **actors** (any export whose components point back to it through their `Outer`): `RootComponent`, `bHidden`,
  `bIsEditorOnlyActor`; volumes (`BlockingVolume` and every other `*Volume`) have no mesh;
- **scene components**: `RelativeLocation` (`X`, `Y`, `Z`), `RelativeRotation` (`Pitch`, `Yaw`, `Roll` in degrees),
  `RelativeScale3D`, `AttachParent`, `bAbsoluteLocation`/`Rotation`/`Scale`; each is placed through its parents'
  transforms, as the engine does (location · rotation · scale, parent after child). Missing values are the
  engine's defaults (no move, no turn, scale 1). A component whose values are in its template (`Template` or
  `Archetype`, as a placed Blueprint's are) takes those it lacks from the template, when the template's package is
  in the export folder too;
- **mesh components**: `StaticMeshComponent` (and every type ending so, such as `SplineMeshComponent`, placed
  without its bend) with `StaticMesh`, `SkeletalMeshComponent` with `SkeletalMesh` (or `SkinnedAsset`, in its rest
  pose), `InstancedStaticMeshComponent` and `HierarchicalInstancedStaticMeshComponent` (foliage) with each instance
  of `PerInstanceSMData` (`TransformData`: `Translation`, `Rotation` as a quaternion, `Scale3D`; or a 4 × 4
  matrix); `OverrideMaterials` per material slot;
- **hidden surfaces** (left out unless the person keeps them): `bHiddenInGame`, `bVisible: false`,
  `bRenderInMainPass: false`, hidden actors, editor-only components and actors, and names of invisible walls and
  collision (see levels.HIDDEN_NAMES).

Every other type of component that looks like it draws something (`LandscapeComponent`, `ModelComponent`,
`ProceduralMeshComponent`, `WaterBodyComponent`, …) is counted as not understood and left out.

**Axes**: Unreal is left-handed, Z up, in centimetres (X forward, Y right). The level's frame is glTF's (right-
handed, Y up, metres): a point (x, y, z) is (x, z, y) / 100 there, which turns left- into right-handed and keeps
the map from above as the editor's top view shows it (X east, Y south). Each transform is turned the same way
(P · M · P⁻¹).

**Meshes**: each mesh is found in the export folder by its package path (FModel writes `/Game/X/SM_A` as
`<Game>/Content/X/SM_A.glb`): glTF first (FModel writes it in the same frame as above: Y up, metres), then ActorX
(`.pskx`, `.psk`: Y turned over, Z up, centimetres, as ActorX files are written). **Textures**: a material of a mesh
with no picture of its own is looked up by its name (a JSON file FModel saved, or a `.mat` file) for its diffuse
texture (`Diffuse`, `BaseColor`, `Albedo`, … or a name ending `_D`, `_BC`, …), through its parents, found as a
PNG in the export folder.

Nothing here is the engine's code: it follows what FModel's JSON shows.
"""

from __future__ import annotations

import json
import math
import re
import typing as tp
from pathlib import Path

import numpy as np

from .levels import (
    MESH_EXTENSIONS,
    PICTURE_EXTENSIONS,
    AssetIndex,
    Collector,
    LevelError,
    Matrix,
    Placement,
    compose,
    hidden_name,
    number,
    quaternion_matrix,
)

# Unreal (x, y, z) in centimetres to the level's frame: (x, z, y) / 100.
TO_LEVEL = np.array([[0.01, 0, 0, 0], [0, 0, 0.01, 0], [0, 0.01, 0, 0], [0, 0, 0, 1.0]])
FROM_LEVEL = np.linalg.inv(TO_LEVEL)
# An ActorX mesh (x, -y, z in Unreal's centimetres) into the level's frame: (x, z, -y) / 100.
PSK_BASE = np.array([[0.01, 0, 0, 0], [0, 0, 0.01, 0], [0, -0.01, 0, 0], [0, 0, 0, 1.0]])
INSTANCED = ("InstancedStaticMeshComponent", "HierarchicalInstancedStaticMeshComponent", "FoliageInstancedStaticMeshComponent")
MESH_PROPERTIES = ("StaticMesh", "SkeletalMesh", "SkinnedAsset", "SkeletalMeshAsset")
# Components that look like they draw something but are not read here.
DRAWING_WORDS = ("Mesh", "Landscape", "Foliage", "Geometry", "Model", "Water", "Procedural", "Text", "Decal")
# Types of components that draw a mesh, read here (and any component that names a mesh).
MESH_TYPES = ("StaticMeshComponent", "SkeletalMeshComponent", "SplineMeshComponent", *INSTANCED)
DIFFUSE_NAMES = ("diffuse", "basecolor", "base color", "base_color", "albedo", "basecolormap", "diffusemap", "maintex", "color", "colour")
DIFFUSE_ENDINGS = ("_d", "_bc", "_basecolor", "_diffuse", "_albedo", "_col", "_color", "_c", "_alb", "_dif")
NOT_DIFFUSE = ("normal", "_n", "mask", "_orm", "_mra", "_arm", "rough", "metal", "_ao", "emissive", "_e", "height", "_h", "spec", "opacity")
TEMPLATE_DEPTH = 3
PARENT_DEPTH = 6


def to_level(matrix: Matrix) -> Matrix:
    """An Unreal transform in the level's frame."""
    return TO_LEVEL @ matrix @ FROM_LEVEL


def rotator_matrix(pitch: float, yaw: float, roll: float) -> np.ndarray:
    """The rotation of an Unreal rotator (degrees), for column vectors: yaw turns X towards Y about Z, pitch lifts X
    towards Z, roll turns Y towards -Z about X (the engine's FRotationMatrix, its rows here as columns)."""
    p, y, r = (math.radians(a) for a in (pitch, yaw, roll))
    sp, cp, sy, cy, sr, cr = math.sin(p), math.cos(p), math.sin(y), math.cos(y), math.sin(r), math.cos(r)
    rows = np.array(
        [
            [cp * cy, cp * sy, sp],
            [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
            [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp],
        ]
    )
    return rows.T


def vector(value: tp.Any, default: float = 0.0) -> list[float] | None:
    if isinstance(value, dict):
        return [number(value.get(k, default), default) for k in ("X", "Y", "Z")]
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return [number(v, default) for v in value]
    return None


def rotation_of(value: tp.Any) -> np.ndarray | None:
    """A rotator (`Pitch`, `Yaw`, `Roll`) or a quaternion (`X`, `Y`, `Z`, `W`)."""
    if not isinstance(value, dict):
        return None
    if any(k in value for k in ("Pitch", "Yaw", "Roll")):
        return rotator_matrix(number(value.get("Pitch")), number(value.get("Yaw")), number(value.get("Roll")))
    if "W" in value:
        return quaternion_matrix(number(value.get("X")), number(value.get("Y")), number(value.get("Z")), number(value.get("W"), 1.0))
    return None


def transform_of(data: tp.Any) -> Matrix | None:
    """An FTransform (`Translation`, `Rotation`, `Scale3D`) or an FMatrix (`M`, rows, or 16 numbers, the engine's
    row-vector order) as a matrix for column vectors."""
    if not isinstance(data, dict):
        if isinstance(data, list) and len(data) == 16:
            return np.asarray([number(v) for v in data]).reshape(4, 4).T
        return None
    for key in ("TransformData", "Transform", "InstanceTransform"):
        if key in data:
            return transform_of(data[key])
    if "M" in data:
        rows = data["M"]
        flat = [v for row in rows for v in row] if isinstance(rows, list) and rows and isinstance(rows[0], list) else rows
        if isinstance(flat, list) and len(flat) == 16:
            return np.asarray([number(v) for v in flat]).reshape(4, 4).T
        return None
    if any(k in data for k in ("Translation", "Rotation", "Scale3D")):
        t = vector(data.get("Translation")) or [0.0, 0.0, 0.0]
        r = rotation_of(data.get("Rotation"))
        s = vector(data.get("Scale3D"), 1.0) or [1.0, 1.0, 1.0]
        return compose(t, r if r is not None else np.eye(3), s)
    return None


def parse_reference_text(text: str) -> tuple[str | None, list[str], str | None]:
    """`Type'/Game/Path/Package.Name'`, `Type'/Game/Path/Package:Outer.Name'`, `/Game/Path/Package.Name`,
    `/Game/Path/Package`, `Type'Outer.Name'` or a bare name: its type, names and package path."""
    match = re.match(r"^\s*([\w/]+)'(.*)'\s*$", text)
    type_name, inner = (match.group(1), match.group(2).strip()) if match else (None, text.strip())
    if ":" in inner:
        package, _, rest = inner.partition(":")
        return type_name, [n for n in rest.split(".") if n], package or None
    if "/" in inner:
        folder, _, last = inner.rpartition("/")
        if "." in last:
            stem, _, name = last.partition(".")
            return type_name, [name or stem], f"{folder}/{stem}"
        return type_name, [last], inner
    return type_name, [n for n in inner.split(".") if n], None


def reference_parts(ref: tp.Any) -> tuple[str | None, list[str], str | None, int | None]:
    """A reference's type, its names (outermost first), its package path and the export index in it (FModel's
    `ObjectPath` ends with it). `(None, [], None, None)` for no reference."""
    if isinstance(ref, str):
        if ref.startswith("{"):
            try:
                return reference_parts(json.loads(ref))
            except ValueError:
                pass
        type_name, names, package = parse_reference_text(ref)
        return type_name, names, package, None
    if not isinstance(ref, dict):
        return None, [], None, None
    type_name, names, package = parse_reference_text(str(ref.get("ObjectName") or ""))
    path = str(ref.get("ObjectPath") or "").strip()
    index = None
    tail = re.match(r"^(.*)\.(\d+)$", path)
    if tail:
        package, index = tail.group(1), int(tail.group(2))
    elif path:
        _, path_names, path_package = parse_reference_text(path)
        package = path_package or package
        names = names or path_names
    return type_name, names, package, index


def package_segments(package: str | None, names: list[str]) -> list[str]:
    """A package path as folders and a name: `/Game/Env/SM_Rock` gives Env, SM_Rock (the mount point dropped)."""
    if package:
        parts = [p for p in package.replace("\\", "/").split("/") if p]
        if len(parts) > 1:
            parts = parts[1:]
        return parts
    return names[-1:] if names else []


def segments_of(ref: tp.Any) -> list[str]:
    _, names, package, _ = reference_parts(ref)
    return package_segments(package, names)


class FModelLevel:
    def __init__(self, path: Path, root: Path, collector: Collector, leave_out_hidden: bool, stop: tp.Callable[[], None]):
        self.path = path
        self.root = root
        self.collector = collector
        self.report = collector.report
        self.leave_out_hidden = leave_out_hidden
        self.stop = stop
        self.index = AssetIndex(root, (*MESH_EXTENSIONS, *PICTURE_EXTENSIONS, ".json", ".mat"))
        self.exports = self.load_exports(path)
        if self.exports is None:
            raise LevelError(f"{path.name} is not a level saved by FModel: it is not a list of exports (JSON).")
        self.by_name: dict[str, list[int]] = {}
        self.by_outer_name: dict[tuple[str, str], int] = {}
        for i, export in enumerate(self.exports):
            name = str(export.get("Name", ""))
            self.by_name.setdefault(name, []).append(i)
            self.by_outer_name.setdefault((str(export.get("Outer", "")), name), i)
        self.worlds: dict[int, Matrix] = {}
        self.packages: dict[str, list[dict[str, tp.Any]] | None] = {}
        self.textures: dict[str, Path | None] = {}

    @staticmethod
    def load_exports(path: Path) -> list[dict[str, tp.Any]] | None:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        if isinstance(data, dict):
            for key in ("Exports", "exports"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
        if not isinstance(data, list):
            return None
        return [e for e in data if isinstance(e, dict)]

    # References.

    def resolve(self, ref: tp.Any, exports: list[dict[str, tp.Any]] | None = None) -> dict[str, tp.Any] | None:
        """The export a reference names in the level (or in `exports`, another package's)."""
        exports = self.exports if exports is None else exports
        _, names, _, index = reference_parts(ref)
        if not names:
            return None
        name = names[-1]
        outer = names[-2] if len(names) > 1 else None
        if index is not None and 0 <= index < len(exports) and exports[index].get("Name") == name:
            return exports[index]
        if exports is self.exports:
            if outer is not None and (outer, name) in self.by_outer_name:
                return self.exports[self.by_outer_name[(outer, name)]]
            found = self.by_name.get(name, [])
            return self.exports[found[0]] if len(found) == 1 else None
        matching = [e for e in exports if e.get("Name") == name and (outer is None or e.get("Outer") in (outer, None))]
        return matching[0] if matching else None

    def package(self, package: str | None, names: list[str]) -> list[dict[str, tp.Any]] | None:
        """Another package's exports, when FModel saved it as JSON in the export folder."""
        segments = package_segments(package, names)
        key = "/".join(segments).lower()
        if key not in self.packages:
            found = self.index.find(segments, (".json",)) if segments else None
            self.packages[key] = self.load_exports(found) if found and found.resolve() != self.path.resolve() else None
        return self.packages[key]

    def properties(self, export: dict[str, tp.Any], depth: int = 0) -> dict[str, tp.Any]:
        """The export's properties, with those it lacks from its template (a Blueprint's component)."""
        own = export.get("Properties") if isinstance(export.get("Properties"), dict) else {}
        merged = dict(own)
        for key in ("PerInstanceSMData",):
            if key in export and key not in merged:
                merged[key] = export[key]
        if depth >= TEMPLATE_DEPTH:
            return merged
        for key in ("Template", "Archetype"):
            ref = export.get(key) or own.get(key)
            if not ref:
                continue
            _, names, package, _ = reference_parts(ref)
            template = None
            if package is not None and not self.is_level_package(package):
                exports = self.package(package, names)
                template = self.resolve(ref, exports) if exports else None
            elif package is not None:
                template = self.resolve(ref)
            if template is not None and template is not export:
                for name, value in self.properties(template, depth + 1).items():
                    merged.setdefault(name, value)
                break
        return merged

    def is_level_package(self, package: str) -> bool:
        return package.rsplit("/", 1)[-1].lower() == self.path.stem.lower()

    # Transforms.

    def relative(self, props: dict[str, tp.Any]) -> Matrix:
        t = vector(props.get("RelativeLocation")) or [0.0, 0.0, 0.0]
        r = rotation_of(props.get("RelativeRotation"))
        s = vector(props.get("RelativeScale3D"), 1.0) or [1.0, 1.0, 1.0]
        return compose(t, r if r is not None else np.eye(3), s)

    def world(self, index: int, depth: int = 0) -> Matrix:
        """A component's place in Unreal's world frame, through its attach parents."""
        if index in self.worlds:
            return self.worlds[index]
        export = self.exports[index]
        props = self.properties(export)
        local = self.relative(props)
        parent = self.parent_of(export, props)
        if parent is None or depth > 64:
            world = local
        else:
            above = self.world(parent, depth + 1)
            world = above @ local
            absolute = [bool(props.get(f"bAbsolute{k}")) for k in ("Location", "Rotation", "Scale")]
            if any(absolute):
                world = absolute_world(above, local, absolute)
        self.worlds[index] = world
        return world

    def parent_of(self, export: dict[str, tp.Any], props: dict[str, tp.Any]) -> int | None:
        ref = props.get("AttachParent")
        found = self.resolve(ref) if ref else None
        if found is None and ref:
            # A template's parent: the component of the same name in this actor.
            _, names, _, _ = reference_parts(ref)
            if names:
                wanted = names[-1].replace("_GEN_VARIABLE", "")
                key = (str(export.get("Outer", "")), wanted)
                if key in self.by_outer_name:
                    found = self.exports[self.by_outer_name[key]]
        if found is None:
            # A component that is not its actor's root hangs under the root.
            actor = self.actor_of(export)
            if actor is not None:
                root = self.resolve((actor.get("Properties") or {}).get("RootComponent"))
                if root is not None and root is not export:
                    found = root
        if found is None or found is export:
            return None
        return self.index_of(found)

    def index_of(self, export: dict[str, tp.Any]) -> int | None:
        for i in self.by_name.get(str(export.get("Name", "")), []):
            if self.exports[i] is export:
                return i
        return None

    def actor_of(self, export: dict[str, tp.Any]) -> dict[str, tp.Any] | None:
        outer = export.get("Outer")
        if not outer:
            return None
        found = self.by_name.get(str(outer), [])
        candidates = [self.exports[i] for i in found if self.exports[i] is not export]
        return candidates[0] if candidates else None

    # Meshes and materials.

    def mesh_file(self, ref: tp.Any) -> tuple[Path | None, str]:
        _, names, package, _ = reference_parts(ref)
        segments = package_segments(package, names)
        shown = "/".join(segments) or (names[-1] if names else "?")
        if not segments:
            return None, shown
        found = self.index.find(segments, MESH_EXTENSIONS)
        if found is None:
            found = self.index.find([*segments[:-1], segments[-1] + "_LOD0"], MESH_EXTENSIONS)
        return found, shown

    def material_texture(self, ref: tp.Any, depth: int = 0) -> Path | None:
        """The diffuse picture of a material (a reference, or a material's name)."""
        segments = segments_of(ref)
        if not segments:
            return None
        key = "/".join(segments).lower()
        if key in self.textures:
            return self.textures[key]
        self.textures[key] = None
        found = None
        file = self.index.find(segments, (".json", ".mat"))
        if file is not None and file.resolve() != self.path.resolve() and depth < PARENT_DEPTH:
            params, parents = read_material(file)
            choice = diffuse_choice(params)
            if choice is not None:
                texture = segments_of(choice)
                found = self.index.find(texture, PICTURE_EXTENSIONS) if texture else None
            if found is None:
                for parent in parents:
                    found = self.material_texture(parent, depth + 1)
                    if found is not None:
                        break
        self.textures[key] = found
        return found

    def changes_for(self, mesh: Path, overrides: list[tp.Any]) -> list[dict[str, tp.Any] | None]:
        """The pictures of the mesh's materials: its own (by name) where the file has none, and the level's
        `OverrideMaterials` by slot."""
        info = self.collector.info(mesh)
        changes: list[dict[str, tp.Any] | None] = []
        count = max(len(info.materials) if info else 0, len(overrides))
        for slot in range(count):
            override = overrides[slot] if slot < len(overrides) else None
            texture = None
            if override:
                texture = self.material_texture(override)
                if texture is None:
                    _, names, _, _ = reference_parts(override)
                    if names:
                        self.missing_texture(names[-1])
            elif info and slot < len(info.materials) and not info.textured[slot] and info.materials[slot]:
                texture = self.material_texture(info.materials[slot])
                if texture is None:
                    self.missing_texture(info.materials[slot])
            if texture is not None:
                self.report.textures_found += 1
            changes.append({"texture": texture} if texture is not None else None)
        return changes

    def missing_texture(self, name: str) -> None:
        self.report.textures_missing[name] = self.report.textures_missing.get(name, 0) + 1

    # The level.

    def hidden(self, export: dict[str, tp.Any], props: dict[str, tp.Any]) -> str | None:
        """Why a component is never seen, or None."""
        actor = self.actor_of(export)
        actor_props = self.properties(actor) if actor is not None else {}
        if props.get("bIsEditorOnly") is True or actor_props.get("bIsEditorOnlyActor") is True:
            return "editorOnly"
        if not self.leave_out_hidden:
            return None
        if props.get("bHiddenInGame") is True or props.get("bVisible") is False or props.get("bRenderInMainPass") is False:
            return "hidden"
        if actor_props.get("bHidden") is True or actor_props.get("bActorHiddenInGame") is True:
            return "hidden"
        actor_type = str(actor.get("Type", "")) if actor is not None else ""
        if actor_type.endswith("Volume"):
            return "hidden"
        names = [export.get("Name"), actor.get("Name") if actor is not None else None, actor_props.get("ActorLabel")]
        if hidden_name(*[str(n) for n in names if n]):
            return "hidden"
        return None

    def read(self) -> None:
        report = self.report
        for i, export in enumerate(self.exports):
            if i % 256 == 0:
                self.stop()
            kind = str(export.get("Type", ""))
            if "Component" not in kind and not kind.endswith("_C"):
                continue
            props = self.properties(export)
            mesh_ref = next((props[k] for k in MESH_PROPERTIES if props.get(k)), None)
            if mesh_ref is None:
                if kind.endswith(MESH_TYPES):
                    report.skip("noMesh")
                elif "Component" in kind and any(word in kind for word in DRAWING_WORDS):
                    report.unknown_type(kind)
                continue
            name = str(export.get("Name", ""))
            actor = self.actor_of(export)
            label = str((actor or {}).get("Name") or name)
            why = self.hidden(export, props)
            mesh, shown = self.mesh_file(mesh_ref)
            if mesh is not None and why is None and self.leave_out_hidden and hidden_name(mesh.stem):
                why = "hidden"
            instances = self.instances(kind, props)
            if why is not None:
                report.skip(why, max(len(instances), 1))
                continue
            if mesh is None:
                report.missing(shown, len(instances))
                continue
            if kind.endswith("SplineMeshComponent"):
                report.note("Spline meshes are placed without their bend.")
            if "SkeletalMesh" in kind or "SkeletalMesh" in str(mesh_ref):
                report.note("Skeletal meshes are placed in their rest pose.")
            overrides = props.get("OverrideMaterials") if isinstance(props.get("OverrideMaterials"), list) else []
            changes = self.changes_for(mesh, overrides) if self.collector.info(mesh) is not None else []
            base = PSK_BASE if mesh.suffix.lower() in (".psk", ".pskx") else None
            world = self.world(i)
            for n, local in enumerate(instances):
                matrix = to_level(world @ local)
                self.collector.add(Placement(mesh, matrix, f"{label} {n}" if len(instances) > 1 else label, changes, base))

    def instances(self, kind: str, props: dict[str, tp.Any]) -> list[Matrix]:
        """The component's own place (one), or each instance of an instanced component, relative to it."""
        data = props.get("PerInstanceSMData")
        if kind in INSTANCED or isinstance(data, list):
            if not isinstance(data, list):
                return []
            out = []
            for item in data:
                matrix = transform_of(item)
                if matrix is not None:
                    out.append(matrix)
                else:
                    self.report.unknown_type("instance without a transform")
            return out
        return [np.eye(4)]


def absolute_world(parent: Matrix, local: Matrix, absolute: list[bool]) -> Matrix:
    """A component placed with some of its transform in the world (`bAbsoluteLocation`, `Rotation`, `Scale`)."""
    p_t, p_r, p_s = decompose(parent)
    l_t, l_r, l_s = decompose(local)
    rotation = l_r if absolute[1] else p_r @ l_r
    scale = l_s if absolute[2] else p_s * l_s
    translation = l_t if absolute[0] else (parent @ np.append(l_t, 1.0))[:3]
    return compose(translation, rotation, scale)


def decompose(matrix: Matrix) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    linear = matrix[:3, :3]
    scale = np.linalg.norm(linear, axis=0)
    scale[scale < 1e-12] = 1.0
    rotation = linear / scale
    if np.linalg.det(rotation) < 0:
        scale[0] = -scale[0]
        rotation[:, 0] = -rotation[:, 0]
    return matrix[:3, 3].copy(), rotation, scale


def read_material(path: Path) -> tuple[dict[str, str], list[tp.Any]]:
    """A material file's texture parameters (name → texture reference or name) and its parents.

    Read: FModel's saved properties (a list of exports: `TextureParameterValues` with `ParameterInfo.Name` and
    `ParameterValue`, `Parent`, a base material's `CachedReferencedTextures`/`ReferencedTextures`), a material
    summary (`{"Textures": {name: path}}`, also under `Parameters`) and a `.mat` text file (`Diffuse=T_A_D`)."""
    params: dict[str, str] = {}
    parents: list[tp.Any] = []
    if path.suffix.lower() == ".mat":
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return params, parents
        for line in text.splitlines():
            key, sep, value = line.partition("=")
            if sep and value.strip():
                params[key.strip()] = value.strip()
        return params, parents
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeDecodeError):
        return params, parents
    if isinstance(data, dict):
        for holder in (data, data.get("Parameters") if isinstance(data.get("Parameters"), dict) else {}):
            textures = holder.get("Textures")
            if isinstance(textures, dict):
                for key, value in textures.items():
                    if isinstance(value, str) and value:
                        params[str(key)] = value
        data = data.get("Exports") if isinstance(data.get("Exports"), list) else [data]
    if not isinstance(data, list):
        return params, parents
    for export in data:
        if not isinstance(export, dict):
            continue
        props = export.get("Properties") if isinstance(export.get("Properties"), dict) else {}
        for item in props.get("TextureParameterValues", []) if isinstance(props.get("TextureParameterValues"), list) else []:
            if not isinstance(item, dict):
                continue
            info = item.get("ParameterInfo") if isinstance(item.get("ParameterInfo"), dict) else {}
            name = str(info.get("Name") or item.get("ParameterName") or "")
            value = item.get("ParameterValue")
            if name and value:
                params[name] = value if isinstance(value, str) else json.dumps(value)
        for key in ("CachedReferencedTextures", "ReferencedTextures"):
            for n, value in enumerate(props.get(key, []) if isinstance(props.get(key), list) else []):
                if value:
                    params.setdefault(f"{key}[{n}]", value if isinstance(value, str) else json.dumps(value))
        if props.get("Parent"):
            parents.append(props["Parent"])
    return params, parents


def texture_name(value: str) -> str:
    """The texture's own name, from a reference or path."""
    segments = segments_of(value)
    return (segments[-1] if segments else value).lower()


def diffuse_choice(params: dict[str, str]) -> str | None:
    """The parameter value that is most likely the diffuse (base colour) texture; a reference as text."""

    if not params:
        return None
    lowered = {k.lower(): v for k, v in params.items()}
    for wanted in DIFFUSE_NAMES:
        for key, value in lowered.items():
            if key == wanted and not any(word in texture_name(value) for word in ("normal",)):
                return decode(value)
    for key, value in lowered.items():
        if any(word in key for word in DIFFUSE_NAMES[:5]) and not any(word in key for word in ("normal", "mask", "rough")):
            return decode(value)
    for value in params.values():
        name = texture_name(value)
        if name.endswith(DIFFUSE_ENDINGS):
            return decode(value)
    for value in params.values():
        name = texture_name(value)
        if not any(word in name for word in NOT_DIFFUSE):
            return decode(value)
    return None


def decode(value: str) -> tp.Any:
    if value.startswith("{"):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def read_level(path: Path, root: Path, collector: Collector, leave_out_hidden: bool, stop: tp.Callable[[], None]) -> None:
    level = FModelLevel(path, root, collector, leave_out_hidden, stop)
    level.read()
    if not any(str(e.get("Type", "")).endswith("Component") for e in level.exports):
        collector.report.note(f"{path.name} holds no components: save the level (.umap) itself as JSON with FModel.")
