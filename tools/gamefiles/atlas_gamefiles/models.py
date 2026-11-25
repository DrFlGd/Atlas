"""The game's own look: an area's visible map models (FLVER), their textures (TPF/DDS) and materials (MTD), placed
by the map layout's map pieces, for the 3D look "Game models" and the textured map styles.

Where things are (Dark Souls Remastered, and Bloodborne the same way where noted):

- models: `map/mAA_BB_CC_DD/mXXXXBXAAA.flver.dcx` (or `.flver`), one file per model; Bloodborne keeps each in a
  `mAA_BB_CC_DD_XXXXXX.mapbnd.dcx` binder. The MSB's map piece parts name the model and place it (position,
  rotation in degrees, scale). A map piece's vertices may stand on its bones (some old map pieces place walls or
  trees with them), so each vertex is first moved by its bone, as the game does;
- textures: TPF files, by the name the model's material gives (its path's stem): first in split binders
  (`map/mAA/*.tpfbhd` + `.tpfbdt`, one TPF per entry), then loose TPF files, then the other areas' binders. Only
  the binders' headers are read to find a name; an entry's bytes are read only when it is needed. Each TPF holds DDS
  pictures (dds.py); Bloodborne's are PS4 console textures, which Soulstruct gives a header and deswizzles;
- materials: the MTD named by each material (`mtd/*.mtdbnd.dcx`): its samplers say which texture is the diffuse
  (albedo) one and which texture coordinates it reads, and `g_BlendMode` whether it is cut out (`TexEdge`) or
  blended. Without the MTD, the texture types the model gives and the MTD's name (`_Edge`, `_Alp`) say the same.

The file reader process reads it (worker.py, source `models`) and writes, into the folder it is given:
`models.npz` (every placed triangle in the game's own coordinates, oriented so that its front faces the way the
model's normals do; its texture coordinates; its material; the part that placed it), `models.json` (the materials,
the textures and the report) and one PNG per texture (`t<n>.png`), each at its own size; textures of the same
pixels under other names share the first one's PNG. Nothing is read twice and nothing in the game folder is changed.

Every model and texture is read on its own: one that fails is counted and named in the report, and the rest go on.
The report counts the textures read, those found that could not be read (`failedCount`, each texture once however
many copies of it were tried) and those found nowhere (`missingCount`).
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import time
import typing as tp
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .detect import descend, files_matching
from .games import Area, GameProfile, entry_basename, model_stem
from .geometry import Cancelled, Feedback, SourceResult, _files, rotation_matrix

MODELS_FILE = "models.npz"
INDEX_FILE = "models.json"
FORMAT = "FLVER map pieces, TPF/DDS textures, MTD materials"
# Face set flags of coarser levels of detail and of motion blur copies: never the one read.
FACE_SET_SKIP = 0x01 | 0x02 | 0x80
# MTD `g_BlendMode` values (the `LS` variants are 32 more).
BLEND_EDGE = 1
BLEND_ALPHA = 2
BLEND_WATER = (3, 9)
BLEND_EFFECTS = (4, 5, 6, 7, 8)  # added, taken away or multiplied light: effects, left out
DIFFUSE_NAMES = ("g_diffuse", "g_diffusetexture", "g_albedo", "g_albedomap", "g_basecolor")
NOT_DIFFUSE_SUFFIXES = ("_n", "_s", "_h", "_r", "_em", "_lit", "_l", "_m", "_nm", "_sp", "_hm")
UNTEXTURED = (0.55, 0.55, 0.55, 1.0)
WATER = (0.16, 0.3, 0.38, 0.7)
CUTOFF = 0.5
LIST_LIMIT = 20


# --- What the reader writes, and what the maker reads back ------------------------------------------------------


@dataclass
class TexturedMesh:
    """An area's placed models: triangles (n, 3, 3) in the game's x, y (height), z; texture coordinates (n, 3, 2);
    each triangle's material and owner (the map piece part that placed it). `materials`: per material its `name`,
    `texture` (index in `textures`, or -1), `alpha` (`opaque`, `mask` or `blend`), `cutoff`, `doubleSided` and
    `colour` (linear RGBA). `textures`: per texture its `name`, `file` (a PNG in `folder`), `width`, `height`,
    `format` and `alpha` (whether the PNG keeps an alpha channel)."""

    triangles: np.ndarray
    uvs: np.ndarray
    material: np.ndarray
    owners: np.ndarray
    owner_names: list[str]
    materials: list[dict[str, tp.Any]]
    textures: list[dict[str, tp.Any]]
    folder: Path
    report: dict[str, tp.Any] = field(default_factory=dict)

    def __len__(self) -> int:
        return int(len(self.triangles))

    def texture_path(self, index: int) -> Path | None:
        if 0 <= index < len(self.textures) and self.textures[index].get("file"):
            return self.folder / str(self.textures[index]["file"])
        return None


def save_mesh(mesh: TexturedMesh) -> None:
    mesh.folder.mkdir(parents=True, exist_ok=True)
    with open(mesh.folder / MODELS_FILE, "wb") as handle:
        np.savez(
            handle,
            triangles=np.ascontiguousarray(mesh.triangles, dtype=np.float32),
            uvs=np.ascontiguousarray(mesh.uvs, dtype=np.float32),
            material=np.ascontiguousarray(mesh.material, dtype=np.int32),
            owners=np.ascontiguousarray(mesh.owners, dtype=np.int32),
        )
    index = {"ownerNames": mesh.owner_names, "materials": mesh.materials, "textures": mesh.textures, "report": mesh.report}
    (mesh.folder / INDEX_FILE).write_text(json.dumps(index), encoding="utf-8")


def load_mesh(folder: Path) -> TexturedMesh:
    folder = Path(folder)
    index = json.loads((folder / INDEX_FILE).read_text(encoding="utf-8"))
    with np.load(folder / MODELS_FILE, allow_pickle=False) as data:
        return TexturedMesh(
            triangles=data["triangles"],
            uvs=data["uvs"],
            material=data["material"],
            owners=data["owners"],
            owner_names=[str(n) for n in index.get("ownerNames", [])],
            materials=list(index.get("materials", [])),
            textures=list(index.get("textures", [])),
            folder=folder,
            report=dict(index.get("report", {})),
        )


# --- Finding the model of each map piece --------------------------------------------------------------------------


def piece_model(stem: str, area_id: str, models: tp.Iterable[str]) -> str | None:
    """The MSB model a map piece file holds: `m0000B1A10` (Dark Souls: the model and the area) is `m0000B1`;
    `m29_00_00_00_200000` (Bloodborne: the map, then the model's number) is `m200000`; a file named as a model is
    that model; else the model whose name and `_` start it."""
    by_lower = {model.lower(): model for model in models}
    short = model_stem(stem).lower()
    stem = stem.lower()
    if stem in by_lower:
        return by_lower[stem]
    if short in by_lower:
        return by_lower[short]
    prefix = "m" + area_id[1:].lower() + "_"
    if stem.startswith(prefix):
        candidate = "m" + stem[len(prefix):]
        if candidate in by_lower:
            return by_lower[candidate]
    for lower, model in by_lower.items():
        if stem.startswith(lower + "_"):
            return model
    return None


def model_sources(area: Area, models: tp.Iterable[str]) -> tuple[dict[str, tuple[str, tp.Callable[[], tp.Any]]], list[str]]:
    """Per model of `models`, its file's name and a loader that reads its FLVER; and the model files no map piece
    places (by name)."""
    from soulstruct.containers import Binder
    from soulstruct.flver import FLVER

    wanted = list(models)
    folder = area.map_folder
    out: dict[str, tuple[str, tp.Callable[[], tp.Any]]] = {}
    unused: list[str] = []
    for path in files_matching(folder, r".*\.flver(\.dcx)?"):
        model = piece_model(path.name.split(".")[0], area.id, wanted)
        if model is None:
            unused.append(path.name)
        elif model not in out:
            out[model] = (path.name, lambda path=path: FLVER.from_path(path))
    for path in files_matching(folder, r".*\.mapbnd(\.dcx)?"):
        model = piece_model(path.name.split(".")[0], area.id, wanted)
        if model is None:
            unused.append(path.name)
            continue
        if model in out:
            continue

        def load(path: Path = path) -> tp.Any:
            binder = Binder.from_path(path)
            entries = [e for e in binder.entries if ".flver" in entry_basename(e.path or "").lower()]
            if not entries:
                raise ValueError("the binder holds no FLVER model")
            return entries[0].to_binary_file(FLVER)

        out[model] = (path.name, load)
    return out, unused


# --- One model's meshes ------------------------------------------------------------------------------------------


@dataclass
class LocalMesh:
    """One FLVER mesh, its vertices moved by their bones: triangles (m, 3, 3), normals (m, 3, 3) or None, texture
    coordinates (m, 3, 2), and its material's key."""

    triangles: np.ndarray
    normals: np.ndarray | None
    uvs: np.ndarray
    material: tuple[tp.Any, ...]


def _bone_matrices(bones: list[tp.Any]) -> list[np.ndarray]:
    """Each bone's 4 x 4 matrix to the model's space: scale, then turn (XZY, radians), then move, then its parent's."""
    local = []
    for bone in bones:
        try:
            t = np.asarray(tuple(bone.translate), dtype=np.float64)
            r = np.asarray(tuple(bone.rotate), dtype=np.float64)
            s = np.asarray(tuple(bone.scale), dtype=np.float64)
        except Exception:
            t, r, s = np.zeros(3), np.zeros(3), np.ones(3)
        m = np.eye(4)
        m[:3, :3] = rotation_matrix(tuple(math.degrees(v) for v in r)) * s  # type: ignore[arg-type]
        m[:3, 3] = t
        local.append(m)
    world: list[np.ndarray | None] = [None] * len(bones)

    def resolve(index: int, depth: int = 0) -> np.ndarray:
        if world[index] is not None:
            return world[index]  # type: ignore[return-value]
        parent = int(getattr(bones[index], "parent_bone_index", -1))
        if 0 <= parent < len(bones) and parent != index and depth < 64:
            matrix = resolve(parent, depth + 1) @ local[index]
        else:
            matrix = local[index]
        world[index] = matrix
        return matrix

    return [resolve(i) for i in range(len(bones))]


def _face_set(mesh: tp.Any) -> tp.Any:
    for face_set in mesh.face_sets:
        if not int(getattr(face_set, "flags", 0)) & FACE_SET_SKIP:
            return face_set
    return mesh.face_sets[0]


def _vertex_bones(mesh: tp.Any, array: tp.Any, vertex_array: tp.Any) -> np.ndarray | int:
    names = array.dtype.names or ()
    local: np.ndarray | int
    if "bone_indices" in names:
        local = np.asarray(array["bone_indices"]).reshape(len(array), -1)[:, 0].astype(np.int64)
    elif "normal_w" in names and getattr(vertex_array, "guess_has_normal_w_bone_indices", False):
        local = np.asarray(array["normal_w"]).reshape(len(array), -1)[:, 0].astype(np.int64)
    else:
        return int(getattr(mesh, "default_bone_index", 0) or 0)
    indices = getattr(mesh, "bone_indices", None)
    if indices is not None and len(indices):
        table = np.asarray(indices, dtype=np.int64)
        return np.where((local >= 0) & (local < len(table)), table[np.clip(local, 0, len(table) - 1)], local)
    return local


def flver_meshes(flver: tp.Any, material_key: tp.Callable[[tp.Any], tuple[tp.Any, ...]]) -> list[LocalMesh]:
    """A FLVER's meshes at their finest level of detail, each vertex moved by its bone (static meshes)."""
    bones = _bone_matrices(list(getattr(flver, "bones", []) or []))
    identity = [bool(np.allclose(m, np.eye(4), atol=1e-6)) for m in bones]
    old = int(getattr(flver, "version", 0x20000)) < 0x20000
    out: list[LocalMesh] = []
    for mesh in flver.meshes:
        if not mesh.face_sets or not mesh.vertex_arrays:
            continue
        vertex_array = mesh.vertex_arrays[0]
        array = vertex_array.array
        names = array.dtype.names or ()
        if "position" not in names or len(array) == 0:
            continue
        positions = np.asarray(array["position"], dtype=np.float64).reshape(len(array), -1)[:, :3]
        normals = np.asarray(array["normal"], dtype=np.float64).reshape(len(array), -1)[:, :3] if "normal" in names else None
        key = material_key(mesh)
        uv_index = int(key[-1]) if key else 0
        uv_name = f"uv_{uv_index}" if f"uv_{uv_index}" in names else ("uv_0" if "uv_0" in names else None)
        uvs = (
            np.asarray(array[uv_name], dtype=np.float64).reshape(len(array), -1)[:, :2]
            if uv_name
            else np.zeros((len(array), 2))
        )
        if bones and not getattr(mesh, "is_dynamic", False):
            bone_of = _vertex_bones(mesh, array, vertex_array)
            if isinstance(bone_of, int):
                groups = [(bone_of, slice(None))]
            else:
                groups = [(int(b), bone_of == b) for b in np.unique(bone_of)]
            positions = positions.copy()
            normals = normals.copy() if normals is not None else None
            for bone, chosen in groups:
                if not 0 <= bone < len(bones) or identity[bone]:
                    continue
                matrix = bones[bone]
                positions[chosen] = positions[chosen] @ matrix[:3, :3].T + matrix[:3, 3]
                if normals is not None:
                    normals[chosen] = normals[chosen] @ np.linalg.inv(matrix[:3, :3])
        if old:
            faces = mesh.triangulate_flver0()
        else:
            face_set = _face_set(mesh)
            faces = face_set.triangulate(mesh.can_use_0xffff_separators)
        faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
        faces = faces[(faces < len(array)).all(axis=1) & (faces >= 0).all(axis=1)]
        if not len(faces):
            continue
        out.append(
            LocalMesh(
                triangles=positions[faces],
                normals=normals[faces] if normals is not None else None,
                uvs=uvs[faces],
                material=key,
            )
        )
    return out


# --- Materials --------------------------------------------------------------------------------------------------


def path_stem(path: str) -> str:
    """`N:\\FRPG\\data\\Model\\map\\m10\\tex\\m10_wall.tga` -> `m10_wall`."""
    return entry_basename(path or "").split(".")[0]


class MaterialBook:
    """The MTD files of the game folder (`mtd/*.mtdbnd*`), read once each when first asked."""

    def __init__(self, root: Path):
        self.binders: list[tp.Any] = []
        self.files: list[str] = []
        self.errors: list[str] = []
        self.cache: dict[str, tp.Any] = {}
        self.read = 0
        folder = descend(root, "mtd")
        for path in files_matching(folder, r".*\.mtdbnd(\.dcx)?"):
            try:
                from soulstruct.base.models.mtd import MTDBND

                self.binders.append(MTDBND.from_path(path))
                self.files.append(path.name)
            except Exception as error:
                if len(self.errors) < 5:
                    self.errors.append(f"{path.name}: {type(error).__name__}: {error}"[:300])

    def get(self, name: str) -> tp.Any | None:
        key = name.lower()
        if key in self.cache:
            return self.cache[key]
        found = None
        for binder in self.binders:
            try:
                found = binder.get_mtd(key)
                break
            except Exception:
                continue
        if found is not None:
            self.read += 1
        self.cache[key] = found
        return found


def blend_mode(mtd: tp.Any | None, mtd_stem: str) -> str:
    """`opaque`, `mask`, `blend`, `water` or `effect`, by the MTD's `g_BlendMode`, else by its name."""
    mode = None
    if mtd is not None:
        try:
            mode = int(mtd.get_param("g_BlendMode", -1))
        except Exception:
            mode = None
        if mode is not None and mode >= 32:
            mode -= 32
    if mode is None or mode < 0:
        lower = mtd_stem.lower()
        if "water" in lower:
            return "water"
        if "_alp" in lower:
            return "blend"
        if "_edge" in lower:
            return "mask"
        return "opaque"
    if mode == BLEND_EDGE:
        return "mask"
    if mode == BLEND_ALPHA:
        return "blend"
    if mode in BLEND_WATER:
        return "water"
    if mode in BLEND_EFFECTS:
        return "effect"
    return "opaque"


def _diffuse_rank(name: str) -> int | None:
    """How surely a sampler or texture type is the diffuse one: 0 surest; None when it is not one."""
    lower = name.lower()
    if lower in DIFFUSE_NAMES:
        return 0
    if ("diffuse" in lower or "albedo" in lower or "basecolor" in lower) and not lower.rstrip("_").endswith("2"):
        return 1
    return None


def diffuse_texture(material: tp.Any, mtd: tp.Any | None) -> tuple[str | None, int, str]:
    """The stem of the material's diffuse texture (None: none), the texture coordinates it reads, and how it was
    chosen (`mtd`, `type` or `name`)."""
    textures = [t for t in getattr(material, "textures", []) if path_stem(getattr(t, "path", ""))]
    if not textures:
        return None, 0, "none"
    if mtd is not None:
        ranked = sorted(
            ((rank, index, sampler) for index, sampler in enumerate(getattr(mtd, "samplers", []))
             if (rank := _diffuse_rank(str(sampler.sampler_type))) is not None),
            key=lambda item: (item[0], item[1]),
        )
        for _, index, sampler in ranked:
            uv = max(int(getattr(sampler, "uv_index", 1)) - 1, 0)
            by_type = [t for t in textures if (t.texture_type or "").lower() == sampler.sampler_type.lower()]
            if by_type:
                return path_stem(by_type[0].path), uv, "mtd"
            all_textures = list(getattr(material, "textures", []))
            if index < len(all_textures) and not (all_textures[index].texture_type or "") and path_stem(all_textures[index].path):
                return path_stem(all_textures[index].path), uv, "mtd"
    ranked_types = sorted(
        ((rank, index, t) for index, t in enumerate(textures) if (rank := _diffuse_rank(t.texture_type or "")) is not None),
        key=lambda item: (item[0], item[1]),
    )
    if ranked_types:
        return path_stem(ranked_types[0][2].path), 0, "type"
    for texture in textures:
        stem = path_stem(texture.path).lower()
        if not stem.endswith(NOT_DIFFUSE_SUFFIXES):
            return path_stem(texture.path), 0, "name"
    return None, 0, "none"


# --- Textures -----------------------------------------------------------------------------------------------------


@dataclass
class TextureSource:
    """Where a texture's TPF is: an entry of a split binder (read by its header), or a loose file."""

    label: str
    bhd: Path | None = None
    bdt: Path | None = None
    header: tp.Any = None
    file: Path | None = None


def _split_headers(bhd: Path) -> list[tp.Any]:
    """The entry headers of a split binder's header file, without reading its data file."""
    from soulstruct.containers import Binder
    from soulstruct.dcx import decompress
    from soulstruct.utilities.binary import BinaryReader

    data = bhd.read_bytes()
    if data[:4] == b"DCX\0":
        data, _ = decompress(data)
    reader = BinaryReader(data)
    try:
        version = reader.peek(4)
        if version == b"BHF3":
            _, headers = Binder._read_header_v3(reader)
        elif version == b"BHF4":
            _, headers = Binder._read_header_v4(reader)
        else:
            raise ValueError(f"not a binder header file ({version!r})")
    finally:
        reader.close()
    return list(headers)


class TextureFinder:
    """Finds TPF textures by name in the game folder: the area's own folders first (see the top of this module)."""

    def __init__(self, root: Path, area: Area, feedback: Feedback):
        self.root = Path(root)
        self.area = area
        self.feedback = feedback
        self.binders: list[str] = []
        self.errors: list[str] = []
        self.searched_all = False
        self.index: dict[str, list[TextureSource]] = {}
        self.loose: list[Path] = []
        map_dir = descend(self.root, "map")
        self.near: list[Path] = [p for p in (area.map_folder, descend(map_dir, area.id[:3]) if map_dir else None) if p]
        self.map_dir = map_dir
        for folder in self.near:
            self._add_folder(folder)

    def _add_folder(self, folder: Path) -> None:
        for bhd in files_matching(folder, r".*\.tpfbhd(\.dcx)?"):
            bdt_name = bhd.name.replace("tpfbhd", "tpfbdt").replace("TPFBHD", "TPFBDT")
            bdt = next((p for p in folder.iterdir() if p.name.lower() == bdt_name.lower()), None)
            if bdt is None:
                self._error(f"{bhd.name}: its .tpfbdt is missing")
                continue
            try:
                headers = _split_headers(bhd)
            except Exception as error:
                self._error(f"{bhd.name}: {type(error).__name__}: {error}")
                continue
            self.binders.append(f"{folder.name}/{bhd.name}")
            for header in headers:
                stem = entry_basename(header.path or "").split(".")[0].lower()
                if stem:
                    self.index.setdefault(stem, []).append(TextureSource(f"{folder.name}/{bhd.name}", bhd, bdt, header))
        for path in files_matching(folder, r".*\.tpf(\.dcx)?"):
            self.loose.append(path)
            self.index.setdefault(path.name.split(".")[0].lower(), []).append(TextureSource(f"{folder.name}/{path.name}", file=path))

    def _error(self, message: str) -> None:
        if message not in self.errors and len(self.errors) < LIST_LIMIT:
            self.errors.append(message[:300])

    def search_everywhere(self) -> None:
        """Adds the other areas' texture folders (`map/m*/`), for names not found near the area."""
        if self.searched_all or self.map_dir is None:
            return
        self.searched_all = True
        try:
            folders = sorted(p for p in self.map_dir.iterdir() if p.is_dir() and p not in self.near)
        except OSError:
            return
        for folder in folders:
            self._add_folder(folder)

    def read(self, source: TextureSource) -> tp.Any:
        """The TPF of a source (Soulstruct's TPF)."""
        from soulstruct.containers.entry import BinderEntry
        from soulstruct.containers.tpf import TPF
        from soulstruct.utilities.binary import BinaryReader

        if source.file is not None:
            return TPF.from_path(source.file)
        reader = BinaryReader(source.bdt)
        try:
            entry = BinderEntry.from_header(reader, source.header)
        finally:
            reader.close()
        return TPF.from_bytes(entry.get_uncompressed_data())


def texture_picture(texture: tp.Any, platform: tp.Any) -> tuple[tp.Any, str]:
    """A TPF texture's picture (RGBA Pillow image) and its format, for the report."""
    from soulstruct.containers.tpf import TPFPlatform

    from .dds import TextureError, console_dds, decode, describe

    data = bytes(texture.data)
    if platform is not None and platform != TPFPlatform.PC and data[:4] != b"DDS ":
        if data[:4] == b"GNF ":
            raise TextureError("a GNF texture, which is not read")
        data = console_dds(texture, platform)
        return decode(data), f"{getattr(platform, 'name', platform)} {describe(data)}"
    return decode(data), describe(data)


# --- Reading an area ---------------------------------------------------------------------------------------------

Pieces = dict[str, list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]]


def place_mesh(local: LocalMesh, position: tp.Sequence[float], rotation: tp.Sequence[float], scale: tp.Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    """A mesh placed by a map piece part: triangles and texture coordinates, each triangle turned so that it faces
    the way its normals do (glTF's front, counter-clockwise)."""
    matrix = rotation_matrix(tuple(float(v) for v in rotation))  # type: ignore[arg-type]
    s = np.asarray(scale, dtype=np.float64)
    s = np.where(np.abs(s) < 1e-6, 1.0, s)
    points = local.triangles.reshape(-1, 3) * s
    world = (points @ matrix.T + np.asarray(position, dtype=np.float64)).reshape(-1, 3, 3)
    uvs = local.uvs.copy()
    a, b, c = world[:, 0], world[:, 1], world[:, 2]
    facing = np.cross(b - a, c - a)
    if local.normals is not None:
        normals = (local.normals.reshape(-1, 3) / s) @ matrix.T
        wrong = (facing * normals.reshape(-1, 3, 3).sum(axis=1)).sum(axis=1) < 0
    else:
        # No normals: keep the model's own order, mirrored back when the scale mirrors it.
        wrong = np.full(len(world), bool(np.prod(np.sign(s)) < 0))
    if wrong.any():
        world[wrong] = world[wrong][:, [0, 2, 1]]
        uvs[wrong] = uvs[wrong][:, [0, 2, 1]]
    return world.astype(np.float32), uvs.astype(np.float32)


def read_map_models(
    profile: GameProfile,
    area: Area,
    root: Path,
    pieces: Pieces,
    feedback: Feedback,
    output: Path,
    names: dict[str, list[str]] | None = None,
    budget: float = 0.0,
) -> SourceResult:
    """Reads the area's map pieces with their textures and materials into `output` (see the top of this module).
    The result's `data` holds the report."""
    started = time.monotonic()
    result = SourceResult("models", format=FORMAT)
    folder = area.map_folder
    placed_models = [m for m, places in pieces.items() if places]
    if folder is None or not placed_models:
        result.status = "missing"
        result.note = "no map piece parts in the map layout" if folder is not None else f"no map/{area.id} folder"
        result.seconds = time.monotonic() - started
        return result
    feedback.opening(f"map/{folder.name}")
    opened = time.monotonic()
    sources, unused = model_sources(area, placed_models)
    book = MaterialBook(root)
    result.open_seconds = time.monotonic() - opened
    feedback.opened(f"map/{folder.name}", result.open_seconds)
    missing_models = sorted(m for m in placed_models if m not in sources)
    result.entries = len(sources)
    result.files = [f"map/{folder.name}/ ({len(sources)} models of {len(placed_models)} placed)"]
    feedback.planned(len(sources), len(sources))

    materials: list[dict[str, tp.Any]] = []
    material_of: dict[tuple[tp.Any, ...], int] = {}
    texture_names: list[str] = []
    texture_of: dict[str, int] = {}
    chosen_by: Counter[str] = Counter()
    blend_counts: Counter[str] = Counter()
    mtd_names: Counter[str] = Counter()
    left_out = 0
    tris_out: list[np.ndarray] = []
    uvs_out: list[np.ndarray] = []
    mats_out: list[np.ndarray] = []
    owners_out: list[np.ndarray] = []
    owner_names: list[str] = []
    instances = 0

    def material_key(mesh: tp.Any) -> tuple[tp.Any, ...]:
        material = mesh.material
        mtd_path = str(getattr(material, "mat_def_path", "") or "")
        mtd_stem = path_stem(mtd_path)
        mtd = book.get(entry_basename(mtd_path)) if mtd_path else None
        stem, uv, how = diffuse_texture(material, mtd)
        mode = blend_mode(mtd, mtd_stem)
        try:
            culled = bool(_face_set(mesh).use_backface_culling)
        except Exception:
            culled = True
        return (stem.lower() if stem else None, stem, mode, not culled, mtd_stem, how, uv)

    def material_index(key: tuple[tp.Any, ...]) -> int | None:
        stem_lower, stem, mode, double_sided, mtd_stem, how, _ = key
        if mode == "effect":
            return None
        short = (stem_lower, mode, double_sided)
        if short in material_of:
            return material_of[short]
        texture = -1
        if stem_lower:
            if stem_lower not in texture_of:
                texture_of[stem_lower] = len(texture_names)
                texture_names.append(stem)
            texture = texture_of[stem_lower]
        colour = WATER if mode == "water" else (1.0, 1.0, 1.0, 1.0) if texture >= 0 else UNTEXTURED
        alpha = {"water": "blend", "blend": "blend", "mask": "mask"}.get(mode, "opaque")
        materials.append(
            {
                "name": f"{mtd_stem or 'material'} {stem or 'untextured'}".strip(),
                "texture": texture,
                "alpha": alpha,
                "cutoff": CUTOFF,
                "doubleSided": bool(double_sided),
                "colour": list(colour),
                "mtd": mtd_stem,
                "chosenBy": how,
            }
        )
        material_of[short] = len(materials) - 1
        return material_of[short]

    for model, (file_name, load) in _files(result, sorted(sources.items()), feedback, budget, started, "models"):
        try:
            flver = load()
            meshes = flver_meshes(flver, material_key)
        except Cancelled:
            raise
        except Exception as error:
            result.failed += 1
            result.add_error(f"{file_name}: {type(error).__name__}: {error}")
            continue
        result.read += 1
        labels = (names or {}).get(model, [])
        kept: list[tuple[LocalMesh, int]] = []
        for local in meshes:
            key = local.material
            mtd_names[key[4] or "(none)"] += 1
            chosen = material_index(key)
            if chosen is None:
                left_out += len(local.triangles)
                continue
            chosen_by[key[5]] += 1
            blend_counts[materials[chosen]["alpha"]] += 1
            kept.append((local, chosen))
        for index, (position, rotation, scale) in enumerate(pieces.get(model, [])):
            owner = len(owner_names)
            owner_names.append(labels[index] if index < len(labels) else model)
            instances += 1
            for local, chosen in kept:
                world, uvs = place_mesh(local, position, rotation, scale)
                tris_out.append(world)
                uvs_out.append(uvs)
                mats_out.append(np.full(len(world), chosen, dtype=np.int32))
                owners_out.append(np.full(len(world), owner, dtype=np.int32))
        result.vertices += sum(len(m.triangles) * 3 for m in meshes)
        result.triangles += sum(len(m.triangles) for m in meshes)
        del flver, meshes

    # Textures: each once, at its own size.
    feedback.opening("textures")
    finder = TextureFinder(root, area, feedback)
    output.mkdir(parents=True, exist_ok=True)
    textures: list[dict[str, tp.Any]] = [{"name": name, "file": None} for name in texture_names]
    alpha_wanted = [False] * len(texture_names)
    for material in materials:
        if material["texture"] >= 0 and material["alpha"] != "opaque":
            alpha_wanted[material["texture"]] = True
    formats: Counter[str] = Counter()
    failed: list[str] = []
    failed_stems: set[str] = set()
    missing: list[str] = []
    written: dict[str, str] = {}  # a PNG's digest -> its file, so the same pixels are written once
    shared = 0
    png_bytes = 0
    found_in: Counter[str] = Counter()
    pending = {name.lower(): i for i, name in enumerate(texture_names)}
    largest = (0, 0)
    pixels = 0
    for attempt in (0, 1):
        if attempt == 1:
            if not pending:
                break
            finder.search_everywhere()
        for stem in sorted(pending):
            feedback.file(len(texture_names) - len(pending), len(texture_names), f"texture {stem}")
            index = pending[stem]
            for source in finder.index.get(stem, []):
                try:
                    tpf = finder.read(source)
                    match = next((t for t in tpf.textures if t.stem.lower() == stem), None)
                    if match is None and len(tpf.textures) == 1:
                        match = tpf.textures[0]
                    if match is None:
                        continue
                    picture, fmt = texture_picture(match, tpf.platform)
                except Cancelled:
                    raise
                except Exception as error:
                    failed_stems.add(stem)
                    if len(failed) < LIST_LIMIT:
                        failed.append(f"{stem}: {type(error).__name__}: {error}"[:300])
                    continue
                keep_alpha = alpha_wanted[index] and picture.getchannel("A").getextrema()[0] < 255
                encoded = io.BytesIO()
                (picture if keep_alpha else picture.convert("RGB")).save(encoded, "PNG", compress_level=6)
                digest = hashlib.sha256(encoded.getbuffer()).hexdigest()
                if digest in written:
                    file_name = written[digest]
                    shared += 1
                else:
                    file_name = written[digest] = f"t{index}.png"
                    (output / file_name).write_bytes(encoded.getbuffer())
                    png_bytes += encoded.getbuffer().nbytes
                del encoded
                width, height = picture.size
                textures[index].update(
                    {"file": file_name, "width": width, "height": height, "format": fmt, "alpha": keep_alpha, "from": source.label}
                )
                formats[fmt] += 1
                found_in[source.label] += 1
                largest = max(largest, (width, height), key=lambda s: s[0] * s[1])
                pixels += width * height
                del picture
                break
        pending = {stem: i for stem, i in pending.items() if not textures[i].get("file")}
    missing = sorted(texture_names[i] for stem, i in pending.items() if stem not in failed_stems)
    unreadable = sorted(texture_names[i] for stem, i in pending.items() if stem in failed_stems)

    mesh = TexturedMesh(
        triangles=np.concatenate(tris_out) if tris_out else np.zeros((0, 3, 3), dtype=np.float32),
        uvs=np.concatenate(uvs_out) if uvs_out else np.zeros((0, 3, 2), dtype=np.float32),
        material=np.concatenate(mats_out) if mats_out else np.zeros(0, dtype=np.int32),
        owners=np.concatenate(owners_out) if owners_out else np.zeros(0, dtype=np.int32),
        owner_names=owner_names,
        materials=materials,
        textures=textures,
        folder=output,
    )
    report = {
        "models": {
            "placed": len(placed_models),
            "files": len(sources),
            "read": result.read,
            "failed": result.failed,
            "parts": instances,
            "notFound": missing_models[:LIST_LIMIT],
            "notFoundCount": len(missing_models),
            "filesNotPlaced": len(unused),
        },
        "triangles": len(mesh),
        "materials": {
            "count": len(materials),
            "meshesByAlpha": dict(sorted(blend_counts.items())),
            "diffuseChosenBy": dict(sorted(chosen_by.items())),
            "untextured": sum(1 for m in materials if m["texture"] < 0),
            "effectTrianglesLeftOut": left_out,
            "mtdFiles": book.files,
            "mtdRead": book.read,
            "mtdErrors": book.errors,
            "mostUsedMtd": dict(mtd_names.most_common(LIST_LIMIT)),
        },
        "textures": {
            "wanted": len(texture_names),
            "read": sum(1 for t in textures if t.get("file")),
            "formats": dict(sorted(formats.items())),
            "largest": list(largest),
            "pixels": pixels,
            "missing": missing[:LIST_LIMIT],
            "missingCount": len(missing),
            "failedCount": len(unreadable),
            "failedNames": unreadable[:LIST_LIMIT],
            "failed": failed,
            "sameAsAnother": shared,
            "pngBytes": png_bytes,
            "binders": finder.binders[:LIST_LIMIT],
            "bindersSearched": len(finder.binders),
            "searchedEveryArea": finder.searched_all,
            "foundIn": dict(found_in.most_common(LIST_LIMIT)),
            "errors": finder.errors,
        },
    }
    mesh.report = report
    save_mesh(mesh)
    result.data = report
    result.finish()
    if result.status == "ok" and (missing_models or missing or unreadable):
        result.note = (
            f"{len(missing_models)} placed models and {len(missing)} textures were not found, "
            f"{len(unreadable)} textures could not be read"
        )
    result.seconds = time.monotonic() - started
    return result


def summary(report: dict[str, tp.Any]) -> str:
    """One line of what was read, for the progress and the report."""
    models = report.get("models", {})
    textures = report.get("textures", {})
    unreadable = int(textures.get("failedCount", 0) or 0)
    return (
        f"{models.get('read', 0)} of {models.get('files', 0)} models, {report.get('triangles', 0):,} triangles, "
        f"{textures.get('read', 0)} of {textures.get('wanted', 0)} textures"
        + (f" ({unreadable} could not be read)" if unreadable else "")
    )


def is_usable(mesh: TexturedMesh | None) -> bool:
    return mesh is not None and len(mesh) > 0

