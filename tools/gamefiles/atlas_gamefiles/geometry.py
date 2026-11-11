"""Reading an area's geometry, one source at a time, and recording what worked.

Sources, in the order the map plan prefers them:

- collision: the walkable floors and walls (`hAA_BB_CC_DD.hkxbhd` + `.hkxbdt` in `map/mAA_BB_CC_DD/`). Dark Souls
  Remastered stores Havok 2015 `hkp` meshes, which soulstruct-havok's `MapCollisionModel` reads. Bloodborne stores
  Havok 2014 `hknp` compressed meshes: here they are only parsed, and their triangles are not decoded yet;
- navmesh: walkable triangles only. Dark Souls Remastered: `.nvm` files in `mAA_BB_CC_DD.nvmbnd.dcx`. Bloodborne:
  Havok navmeshes in `.nvmhktbnd.dcx`, only parsed here;
- map pieces: the visual models (`.flver`), sampled, since there are hundreds per area and they only matter for an
  optional overview picture.

Local mesh coordinates are moved into the area's frame with the transform of each MSB part that places the model.
"""

from __future__ import annotations

import math
import time
import typing as tp
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .detect import files_matching
from .games import Area, GameProfile, entry_basename, model_stem


class Cancelled(Exception):
    pass


Tick = tp.Callable[[int, int, str], None]
Instances = dict[str, list[tuple[tuple[float, float, float], tuple[float, float, float]]]]


@dataclass
class SourceResult:
    source: str
    status: str = ""  # ok | partial | failed | missing | not-decoded
    format: str = ""
    files: list[str] = field(default_factory=list)
    entries: int = 0
    read: int = 0
    failed: int = 0
    unplaced: int = 0
    triangles: int = 0
    vertices: int = 0
    errors: list[str] = field(default_factory=list)
    note: str | None = None
    sampled: bool = False
    classes: list[str] = field(default_factory=list)
    seconds: float = 0.0
    # World-space triangles (n, 3, 3), for previews; not part of the report.
    mesh: list[np.ndarray] = field(default_factory=list, repr=False)

    def add_error(self, error: BaseException | str) -> None:
        message = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
        message = message.strip().splitlines()[0][:300] if message.strip() else type(error).__name__
        if message not in self.errors and len(self.errors) < 5:
            self.errors.append(message)

    def finish(self) -> None:
        if self.status:
            return
        if self.entries == 0:
            self.status = "missing"
        elif self.read == 0:
            self.status = "failed"
        elif self.failed > 0:
            self.status = "partial"
        else:
            self.status = "ok"

    def triangles_array(self) -> np.ndarray:
        if not self.mesh:
            return np.zeros((0, 3, 3), dtype=np.float32)
        return np.concatenate(self.mesh, axis=0)

    def to_dict(self) -> dict[str, tp.Any]:
        data: dict[str, tp.Any] = {
            "status": self.status,
            "format": self.format,
            "files": self.files,
            "entries": self.entries,
            "read": self.read,
            "failed": self.failed,
            "triangles": self.triangles,
            "vertices": self.vertices,
            "seconds": round(self.seconds, 2),
        }
        if self.unplaced:
            data["unplaced"] = self.unplaced
        if self.sampled:
            data["sampled"] = True
        if self.classes:
            data["havokClasses"] = self.classes
        if self.errors:
            data["errors"] = self.errors
        if self.note:
            data["note"] = self.note
        return data


def rotation_matrix(degrees: tuple[float, float, float]) -> np.ndarray:
    """FromSoftware's Euler order (XZY): a point p turns as Ry @ Rz @ Rx @ p."""
    rx, ry, rz = (math.radians(a) for a in degrees)
    sx, cx = math.sin(rx), math.cos(rx)
    sy, cy = math.sin(ry), math.cos(ry)
    sz, cz = math.sin(rz), math.cos(rz)
    x = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    y = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    z = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return y @ z @ x


def place(triangles: np.ndarray, position: tuple[float, float, float], rotation: tuple[float, float, float]):
    """Local (n, 3, 3) triangles moved by a part's rotation and position."""
    matrix = rotation_matrix(rotation)
    return (triangles.reshape(-1, 3) @ matrix.T + np.asarray(position)).reshape(-1, 3, 3).astype(np.float32)


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def _place_instances(result: SourceResult, local: np.ndarray, instances: Instances, model: str) -> None:
    placed = instances.get(model, [])
    if not placed:
        result.unplaced += 1
        return
    for position, rotation in placed:
        result.mesh.append(place(local, position, rotation))


def _havok_classes(hkx: tp.Any) -> list[str]:
    try:
        variants = hkx.root.namedVariants
        return sorted({type(v.variant).__name__ for v in variants if getattr(v, "variant", None) is not None})
    except Exception:
        return []


def read_collision(
    profile: GameProfile, area: Area, root: Path, instances: Instances, tick: Tick, stop: tp.Callable[[], None]
) -> SourceResult:
    started = time.monotonic()
    result = SourceResult("collision")
    folder = area.map_folder
    binders = files_matching(folder, r"h\d\d_\d\d_\d\d_\d\d\.hkxbhd") or files_matching(folder, r"h.*\.hkxbhd")
    if folder is None or not binders:
        result.status = "missing"
        result.note = f"no hAA_BB_CC_DD.hkxbhd collision file in map/{area.id}"
        return result
    from soulstruct.containers import Binder
    from soulstruct.havok.core import HKX
    from soulstruct.havok.fromsoft.shared.map_collision import MapCollisionModel

    result.format = "Havok 2015 hkp mesh (HKX in HKXBHD/HKXBDT)" if profile.collision_kind == "dsr" else (
        "Havok 2014 hknp compressed mesh (HKX in HKXBHD/HKXBDT)"
    )
    binder_path = binders[0]
    result.files.append(_relative(binder_path, root))
    try:
        binder = Binder.from_path(binder_path)
    except Exception as error:
        result.add_error(error)
        result.status = "failed"
        result.seconds = time.monotonic() - started
        return result
    entries = [e for e in binder.entries if entry_basename(e.path or "").lower().split(".", 1)[-1] in ("hkx", "hkx.dcx")]
    result.entries = len(entries)
    parsed_only = 0
    for index, entry in enumerate(entries):
        stop()
        name = entry_basename(entry.path or f"entry {index}")
        tick(index, len(entries), name)
        try:
            model = MapCollisionModel.from_bytes(entry.data)
        except Exception as error:
            # Not a mesh Soulstruct reads (Bloodborne): does it parse as a Havok file at all?
            try:
                hkx = HKX.from_bytes(entry.data)
            except Exception as parse_error:
                result.failed += 1
                result.add_error(parse_error)
                continue
            parsed_only += 1
            for class_name in _havok_classes(hkx):
                if class_name not in result.classes:
                    result.classes.append(class_name)
            if profile.collision_kind == "dsr":
                result.failed += 1
                result.add_error(error)
            continue
        result.read += 1
        pieces = []
        for mesh in model.meshes:
            vertices = np.asarray(mesh.vertices, dtype=np.float32)[:, :3]
            faces = np.asarray(mesh.faces)[:, :3].astype(np.int64)
            result.vertices += len(vertices)
            result.triangles += len(faces)
            if len(faces):
                pieces.append(vertices[faces])
        if pieces:
            _place_instances(result, np.concatenate(pieces), instances, model_stem(name))
    result.finish()
    if profile.collision_kind == "bloodborne" and result.read == 0 and parsed_only:
        result.status = "not-decoded"
        result.read = parsed_only
        result.note = (
            f"{parsed_only} of {len(entries)} collision files parse as Havok files, but their triangles "
            "(hknp compressed meshes) need a decoder that is planned for a later phase."
        )
    result.seconds = time.monotonic() - started
    return result


def read_navmesh(
    profile: GameProfile, area: Area, root: Path, instances: Instances, tick: Tick, stop: tp.Callable[[], None]
) -> SourceResult:
    started = time.monotonic()
    result = SourceResult("navmesh")
    folder = area.map_folder
    from soulstruct.containers import Binder

    if profile.navmesh_kind == "nvm":
        binders = files_matching(folder, r"m\d\d_\d\d_\d\d_\d\d\.nvmbnd(\.dcx)?")
        result.format = "NVM in NVMBND"
    else:
        binders = files_matching(folder, r".*\.nvmhktbnd(\.dcx)?")
        result.format = "Havok navmesh (HKX in NVMHKTBND)"
    if folder is None or not binders:
        result.status = "missing"
        result.note = f"no navmesh binder in map/{area.id}"
        return result
    result.files.append(_relative(binders[0], root))
    try:
        binder = Binder.from_path(binders[0])
    except Exception as error:
        result.add_error(error)
        result.status = "failed"
        result.seconds = time.monotonic() - started
        return result

    if profile.navmesh_kind == "nvm":
        from soulstruct.base.maps.navmesh.nvm import NVM

        entries = [e for e in binder.entries if ".nvm" in entry_basename(e.path or "").lower()]
        result.entries = len(entries)
        for index, entry in enumerate(entries):
            stop()
            name = entry_basename(entry.path or f"entry {index}")
            tick(index, len(entries), name)
            try:
                nvm = NVM.from_bytes(entry.data)
            except Exception as error:
                result.failed += 1
                result.add_error(error)
                continue
            result.read += 1
            vertices = np.asarray(nvm.vertices, dtype=np.float32)
            faces = np.array([t.vertex_indices for t in nvm.triangles], dtype=np.int64).reshape(-1, 3)
            result.vertices += len(vertices)
            result.triangles += len(faces)
            if len(faces):
                _place_instances(result, vertices[faces], instances, model_stem(name))
        result.finish()
    else:
        from soulstruct.havok.core import HKX

        entries = [e for e in binder.entries if ".hkx" in entry_basename(e.path or "").lower()]
        result.entries = len(entries)
        for index, entry in enumerate(entries):
            stop()
            tick(index, len(entries), entry_basename(entry.path or f"entry {index}"))
            try:
                hkx = HKX.from_bytes(entry.data)
            except Exception as error:
                result.failed += 1
                result.add_error(error)
                continue
            result.read += 1
            for class_name in _havok_classes(hkx):
                if class_name not in result.classes:
                    result.classes.append(class_name)
        result.finish()
        if result.read:
            result.status = "not-decoded"
            result.note = (
                f"{result.read} of {result.entries} navmesh files parse as Havok files; reading their triangles "
                "is planned for a later phase."
            )
    result.seconds = time.monotonic() - started
    return result


def read_map_pieces(
    profile: GameProfile, area: Area, root: Path, tick: Tick, stop: tp.Callable[[], None], sample: int
) -> SourceResult:
    """Read up to `sample` map piece models (all of them when `sample` is 0) and count meshes and vertices."""
    started = time.monotonic()
    result = SourceResult("mapPieces", format="FLVER")
    folder = area.map_folder
    flvers = files_matching(folder, r"m.*\.flver(\.dcx)?")
    binders = files_matching(folder, r".*\.mapbnd(\.dcx)?")
    if folder is None or not (flvers or binders):
        result.status = "missing"
        result.note = f"no map piece models (.flver or .mapbnd) in map/{area.id}"
        return result
    from soulstruct.containers import Binder
    from soulstruct.flver import FLVER

    sources: list[tuple[str, tp.Callable[[], list[tp.Any]]]] = []
    for path in flvers:
        sources.append((path.name, lambda path=path: [FLVER.from_path(path)]))
    for path in binders:

        def load(path: Path = path) -> list[tp.Any]:
            binder = Binder.from_path(path)
            return [e.to_binary_file(FLVER) for e in binder.entries if ".flver" in entry_basename(e.path or "")]

        sources.append((path.name, load))
    result.entries = len(sources)
    result.files = [f"map/{folder.name}/ ({len(flvers)} .flver, {len(binders)} .mapbnd)"]
    chosen = sources if sample <= 0 or len(sources) <= sample else sources[:: max(1, len(sources) // sample)][:sample]
    result.sampled = len(chosen) < len(sources)
    for index, (name, load) in enumerate(chosen):
        stop()
        tick(index, len(chosen), name)
        try:
            models = load()
        except Exception as error:
            result.failed += 1
            result.add_error(error)
            continue
        result.read += 1
        for model in models:
            for mesh in model.meshes:
                result.vertices += int(mesh.vertex_count)
                try:
                    faces = mesh.triangulate_flver2() if hasattr(model, "version") and model.version >= 0x20000 else (
                        mesh.triangulate_flver0()
                    )
                    result.triangles += len(faces)
                except Exception:
                    pass
    result.finish()
    if result.sampled:
        result.note = f"read a sample of {len(chosen)} of {len(sources)} models"
    result.seconds = time.monotonic() - started
    return result
