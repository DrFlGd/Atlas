"""Reading an area's geometry, one source at a time, and recording what worked.

Sources, in the order the map plan prefers them:

- collision: the walkable floors and walls (`hAA_BB_CC_DD.hkxbhd` + `.hkxbdt` in `map/mAA_BB_CC_DD/`). Dark Souls
  Remastered stores Havok 2015 `hkp` meshes, which soulstruct-havok's `MapCollisionModel` reads. Bloodborne stores
  Havok 2014 `hknp` compressed meshes, which our own decoder reads (havok2014.py); its update ships changed files in
  `hAA_BB_CC_DD.hkxbhd.patch` + `.hkxbdt.patch`, whose entries replace those of the same name;
- navmesh: walkable triangles only. Dark Souls Remastered: `.nvm` files in `mAA_BB_CC_DD.nvmbnd.dcx`, placed by the
  MSB's navmesh parts. Bloodborne: Havok navmeshes (`hkaiNavMesh`) in `mAA_BB_CC_DD.nvmhktbnd.dcx`, decoded by
  havok2014.py and placed by `mAA_BB_CC_DD.nva.dcx` (the map's offset, from its MSB, is applied by the caller);
- map pieces: the visual models (`.flver`), sampled, since there are hundreds per area and they only matter for an
  optional overview picture.

Local mesh coordinates are moved into the area's frame with the transform of each MSB part that places the model.

Phase 0 is a check, not the full map, so each reader can take an evenly spaced sample of the files (`sample`) and
stop early at a time budget (`budget` seconds): either way the result says `sampled`. Each file's reading time is
recorded, so the report shows how fast real files parse. The readers run in a separate file reader process (see
worker.py), which the check can stop if a file takes far too long.
"""

from __future__ import annotations

import math
import re
import time
import typing as tp
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .detect import files_matching
from .games import Area, GameProfile, entry_basename, model_stem


class Cancelled(Exception):
    pass


class Feedback:
    """What a reader says while it works. This one says nothing and never stops; the check's own versions report
    progress, and stop the reader (by raising `Cancelled`) when the player cancels."""

    def opening(self, name: str) -> None:
        """Before a binder (or other container) is opened: `name` is its file name."""

    def opened(self, name: str, seconds: float) -> None:
        """The binder `name` was opened, in `seconds`."""

    def planned(self, entries: int, chosen: int) -> None:
        """The binder holds `entries` files, of which `chosen` will be read."""

    def file(self, index: int, total: int, name: str) -> None:
        """Before file `index` (from 0) of the `total` chosen."""


def even_sample(items: tp.Sequence[tp.Any], count: int) -> list[tp.Any]:
    """Up to `count` items spread evenly from first to last (all of them when `count` is 0 or more than there are)."""
    if count <= 0 or len(items) <= count:
        return list(items)
    if count == 1:
        return [items[0]]
    step = (len(items) - 1) / (count - 1)
    return [items[round(index * step)] for index in range(count)]


Instances = dict[str, list[tuple[tuple[float, float, float], tuple[float, float, float]]]]
# Model -> the names of the parts that place it, in the order of its instances (for maps).
PartNames = dict[str, list[str]]


@dataclass
class SourceResult:
    source: str
    status: str = ""  # ok | partial | failed | missing | not-decoded | timed-out
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
    # Seconds to open the binder, and to read each file (name, seconds).
    open_seconds: float | None = None
    file_seconds: list[tuple[str, float]] = field(default_factory=list)
    # For a source stopped at the time limit: the file it was on, and how many files it had got through.
    stopped_on: str | None = None
    files_done: int | None = None
    time_limit: float | None = None
    # World-space triangles (n, 3, 3), for previews and maps; not part of the report.
    mesh: list[np.ndarray] = field(default_factory=list, repr=False)
    # When part names are given (for maps): for each triangle, the index in `owner_names` of the part that
    # placed it.
    owners: list[np.ndarray] = field(default_factory=list, repr=False)
    owner_names: list[str] = field(default_factory=list)

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

    def owners_array(self) -> np.ndarray:
        if not self.owners:
            return np.zeros(0, dtype=np.int32)
        return np.concatenate(self.owners, axis=0)

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
        if self.open_seconds is not None:
            data["openSeconds"] = round(self.open_seconds, 2)
        if self.file_seconds:
            times = sorted(seconds for _, seconds in self.file_seconds)
            data["fileSeconds"] = {
                "files": len(times),
                "min": round(times[0], 3),
                "median": round(float(np.median(times)), 3),
                "max": round(times[-1], 3),
            }
            data["slowestFile"] = max(self.file_seconds, key=lambda item: item[1])[0]
        if self.stopped_on is not None:
            data["stoppedOn"] = self.stopped_on
            data["filesDone"] = self.files_done or 0
        if self.time_limit is not None:
            data["timeLimitSeconds"] = self.time_limit
        if self.errors:
            data["errors"] = self.errors
        if self.note:
            data["note"] = self.note
        return data


def _files(
    result: SourceResult,
    chosen: tp.Sequence[tuple[str, tp.Any]],
    feedback: Feedback,
    budget: float,
    started: float,
    words: str,
) -> tp.Iterator[tuple[str, tp.Any]]:
    """The chosen (name, item) pairs, one at a time: says each one to `feedback`, records how long the caller spent
    on it, and stops early once `budget` seconds (0: no budget) have passed since `started`."""
    for index, (name, item) in enumerate(chosen):
        if budget > 0 and index > 0 and time.monotonic() - started > budget:
            result.sampled = True
            stopped = f"stopped at the {budget:g} s time budget after {index} of {len(chosen)} {words}"
            result.note = f"{result.note}; {stopped}" if result.note else stopped[0].upper() + stopped[1:]
            return
        feedback.file(index, len(chosen), name)
        file_started = time.monotonic()
        yield name, item
        result.file_seconds.append((name, time.monotonic() - file_started))


def _open_binder(result: SourceResult, path: Path, feedback: Feedback) -> tp.Any:
    feedback.opening(path.name)
    from soulstruct.containers import Binder

    opened = time.monotonic()
    binder = Binder.from_path(path)
    result.open_seconds = time.monotonic() - opened
    feedback.opened(path.name, result.open_seconds)
    return binder


def _sample_note(result: SourceResult, chosen: int, words: str) -> None:
    if chosen < result.entries:
        result.sampled = True
        result.note = f"Read an evenly spaced sample of {chosen} of {result.entries} {words}"


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


def _place_instances(
    result: SourceResult, local: np.ndarray, instances: Instances, model: str, names: PartNames | None = None
) -> None:
    placed = instances.get(model, [])
    if not placed:
        result.unplaced += 1
        return
    labels = (names or {}).get(model)
    for index, (position, rotation) in enumerate(placed):
        result.mesh.append(place(local, position, rotation))
        if names is not None:
            label = labels[index] if labels and index < len(labels) else model
            result.owners.append(np.full(len(local), len(result.owner_names), dtype=np.int32))
            result.owner_names.append(label)


def _havok_classes(hkx: tp.Any) -> list[str]:
    try:
        variants = hkx.root.namedVariants
        return sorted({type(v.variant).__name__ for v in variants if getattr(v, "variant", None) is not None})
    except Exception:
        return []


def read_collision(
    profile: GameProfile,
    area: Area,
    root: Path,
    instances: Instances,
    feedback: Feedback,
    sample: int = 0,
    budget: float = 0.0,
    names: PartNames | None = None,
) -> SourceResult:
    if profile.collision_kind == "bloodborne":
        return read_bloodborne_collision(area, root, instances, feedback, sample, budget, names)
    started = time.monotonic()
    result = SourceResult("collision")
    folder = area.map_folder
    binders = files_matching(folder, r"h\d\d_\d\d_\d\d_\d\d\.hkxbhd") or files_matching(folder, r"h.*\.hkxbhd")
    if folder is None or not binders:
        result.status = "missing"
        result.note = f"no hAA_BB_CC_DD.hkxbhd collision file in map/{area.id}"
        return result
    result.format = "Havok 2015 hkp mesh (HKX in HKXBHD/HKXBDT)" if profile.collision_kind == "dsr" else (
        "Havok 2014 hknp compressed mesh (HKX in HKXBHD/HKXBDT)"
    )
    binder_path = binders[0]
    result.files.append(_relative(binder_path, root))
    try:
        binder = _open_binder(result, binder_path, feedback)
    except Cancelled:
        raise
    except Exception as error:
        result.add_error(error)
        result.status = "failed"
        result.seconds = time.monotonic() - started
        return result
    from soulstruct.havok.core import HKX
    from soulstruct.havok.fromsoft.shared.map_collision import MapCollisionModel

    entries = [e for e in binder.entries if entry_basename(e.path or "").lower().split(".", 1)[-1] in ("hkx", "hkx.dcx")]
    result.entries = len(entries)
    named = [(entry_basename(entry.path or f"entry {index}"), entry) for index, entry in enumerate(entries)]
    chosen = even_sample(named, sample)
    feedback.planned(len(entries), len(chosen))
    _sample_note(result, len(chosen), "collision files")
    parsed_only = 0
    for name, entry in _files(result, chosen, feedback, budget, started, "collision files"):
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
            _place_instances(result, np.concatenate(pieces), instances, model_stem(name), names)
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
    profile: GameProfile,
    area: Area,
    root: Path,
    instances: Instances,
    feedback: Feedback,
    sample: int = 0,
    budget: float = 0.0,
    names: PartNames | None = None,
) -> SourceResult:
    if profile.navmesh_kind == "hkx":
        return read_bloodborne_navmesh(area, root, instances, feedback, sample, budget)
    started = time.monotonic()
    result = SourceResult("navmesh")
    folder = area.map_folder
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
        binder = _open_binder(result, binders[0], feedback)
    except Cancelled:
        raise
    except Exception as error:
        result.add_error(error)
        result.status = "failed"
        result.seconds = time.monotonic() - started
        return result

    suffix = ".nvm" if profile.navmesh_kind == "nvm" else ".hkx"
    entries = [e for e in binder.entries if suffix in entry_basename(e.path or "").lower()]
    result.entries = len(entries)
    named = [(entry_basename(entry.path or f"entry {index}"), entry) for index, entry in enumerate(entries)]
    chosen = even_sample(named, sample)
    feedback.planned(len(entries), len(chosen))
    _sample_note(result, len(chosen), "navmesh files")
    if profile.navmesh_kind == "nvm":
        from soulstruct.base.maps.navmesh.nvm import NVM

        for name, entry in _files(result, chosen, feedback, budget, started, "navmesh files"):
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
                _place_instances(result, vertices[faces], instances, model_stem(name), names)
        result.finish()
    else:
        from soulstruct.havok.core import HKX

        for name, entry in _files(result, chosen, feedback, budget, started, "navmesh files"):
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


# --- Bloodborne -------------------------------------------------------------------------------------------------


def _binder_entries(path: Path, bdt: Path | None = None) -> dict[str, tp.Any]:
    """A split binder's entries by their file name's stem (lower case)."""
    from soulstruct.containers import Binder

    binder = Binder.from_path(path, bdt_path=bdt) if bdt is not None else Binder.from_path(path)
    return {entry_basename(entry.path or "").split(".")[0].lower(): entry for entry in binder.entries}


def bloodborne_collision_model(stem: str, area_id: str, models: tp.Iterable[str]) -> str | None:
    """The MSB model a Bloodborne collision entry holds: `h21_00_00_00_000100` (the map's prefix, then the model's
    number) is `h000100`; an entry named as a model is that model; else the model whose name and `_` start it."""
    stem = stem.lower()
    prefix = "h" + area_id[1:].lower() + "_"
    by_lower = {model.lower(): model for model in models}
    if stem in by_lower:
        return by_lower[stem]
    if stem.startswith(prefix):
        candidate = "h" + stem[len(prefix):]
        if candidate in by_lower:
            return by_lower[candidate]
    for lower, model in by_lower.items():
        if stem.startswith(lower + "_"):
            return model
    return None


def read_bloodborne_collision(
    area: Area,
    root: Path,
    instances: Instances,
    feedback: Feedback,
    sample: int = 0,
    budget: float = 0.0,
    names: PartNames | None = None,
) -> SourceResult:
    """Bloodborne's collision: every entry of `hAA_BB_CC_DD.hkxbhd`, those of its `.patch` binder replacing entries
    of the same name, decoded with havok2014.py and placed by the MSB collision parts of its model."""
    from .havok2014 import collision_triangles

    started = time.monotonic()
    result = SourceResult("collision", format="Havok 2014 hknp compressed mesh (HKX in HKXBHD/HKXBDT), our decoder")
    folder = area.map_folder
    stem = "h" + area.id[1:]
    base = files_matching(folder, re.escape(stem) + r"\.hkxbhd") or files_matching(folder, r"h\d\d_\d\d_\d\d_\d\d\.hkxbhd")
    if folder is None or not base:
        result.status = "missing"
        result.note = f"no hAA_BB_CC_DD.hkxbhd collision file in map/{area.id}"
        return result
    patch = files_matching(folder, re.escape(base[0].name) + r"\.patch")
    patch_data = files_matching(folder, re.escape(base[0].name[:-3]) + r"bdt\.patch")
    try:
        feedback.opening(base[0].name)
        opened = time.monotonic()
        entries = _binder_entries(base[0])
        result.files.append(_relative(base[0], root))
        replaced = 0
        if patch and patch_data:
            patched = _binder_entries(patch[0], patch_data[0])
            replaced = sum(1 for key in patched if key in entries)
            entries.update(patched)
            result.files.append(_relative(patch[0], root))
        result.open_seconds = time.monotonic() - opened
        feedback.opened(base[0].name, result.open_seconds)
    except Cancelled:
        raise
    except Exception as error:
        result.add_error(error)
        result.status = "failed"
        result.seconds = time.monotonic() - started
        return result
    named = sorted(
        (key, entry) for key, entry in entries.items() if entry_basename(entry.path or "").lower().split(".", 1)[-1] in ("hkx", "hkx.dcx")
    )
    result.entries = len(named)
    chosen = even_sample(named, sample)
    feedback.planned(len(named), len(chosen))
    _sample_note(result, len(chosen), "collision files")
    if replaced:
        note = f"{replaced} collision files replaced by the update's .patch binder"
        result.note = f"{result.note}; {note}" if result.note else note[0].upper() + note[1:]
    for key, entry in _files(result, chosen, feedback, budget, started, "collision files"):
        try:
            local = collision_triangles(entry.data)
        except Exception as error:
            result.failed += 1
            result.add_error(f"{key}: {type(error).__name__}: {error}")
            continue
        result.read += 1
        result.triangles += len(local)
        result.vertices += len(local) * 3
        model = bloodborne_collision_model(key, area.id, instances)
        if model is None or not len(local):
            result.unplaced += 1 if model is None else 0
            continue
        _place_instances(result, local, instances, model, names)
    result.finish()
    result.seconds = time.monotonic() - started
    return result


def navmesh_model_number(stem: str) -> int | None:
    """The model number of a Bloodborne navmesh entry (`..._000123` -> 123)."""
    match = re.search(r"_(\d+)$", stem)
    return int(match.group(1)) if match else None


def read_bloodborne_navmesh(
    area: Area,
    root: Path,
    instances: Instances,
    feedback: Feedback,
    sample: int = 0,
    budget: float = 0.0,
) -> SourceResult:
    """Bloodborne's navmesh: each `hkaiNavMesh` of `mAA_BB_CC_DD.nvmhktbnd.dcx`, decoded with havok2014.py and placed
    by the map's navmesh placement table (`.nva.dcx`), or else by the MSB's navmesh parts. In the map's own frame:
    the caller applies the map's offset."""
    from .havok2014 import navmesh_triangles, nva_placements

    started = time.monotonic()
    result = SourceResult("navmesh", format="Havok navmesh (hkaiNavMesh in NVMHKTBND), our decoder")
    folder = area.map_folder
    binders = files_matching(folder, r".*\.nvmhktbnd(\.dcx)?")
    if folder is None or not binders:
        result.status = "missing"
        result.note = f"no navmesh binder in map/{area.id}"
        return result
    result.files.append(_relative(binders[0], root))
    try:
        binder = _open_binder(result, binders[0], feedback)
    except Cancelled:
        raise
    except Exception as error:
        result.add_error(error)
        result.status = "failed"
        result.seconds = time.monotonic() - started
        return result
    placements: list[tp.Any] = []
    tables = files_matching(folder, r".*\.nva(\.dcx)?")
    if tables:
        try:
            placements = nva_placements(tables[0].read_bytes())
            result.files.append(_relative(tables[0], root))
        except Exception as error:
            result.add_error(f"{tables[0].name}: {type(error).__name__}: {error}")
    entries = [e for e in binder.entries if ".hkx" in entry_basename(e.path or "").lower()]
    result.entries = len(entries)
    named = [(entry_basename(entry.path or f"entry {index}"), entry) for index, entry in enumerate(entries)]
    chosen = even_sample(named, sample)
    feedback.planned(len(entries), len(chosen))
    _sample_note(result, len(chosen), "navmesh files")
    by_model: dict[int, list[tp.Any]] = {}
    for placement in placements:
        by_model.setdefault(int(placement.model), []).append(placement)
    for name, entry in _files(result, chosen, feedback, budget, started, "navmesh files"):
        try:
            local = navmesh_triangles(entry.data)
        except Exception as error:
            result.failed += 1
            result.add_error(f"{name}: {type(error).__name__}: {error}")
            continue
        result.read += 1
        result.triangles += len(local)
        result.vertices += len(local) * 3
        if not len(local):
            continue
        stem = name.split(".")[0]
        number = navmesh_model_number(stem)
        placed = by_model.get(number, []) if number is not None else []
        if placed:
            for placement in placed:
                rotation = tuple(math.degrees(r) for r in placement.rotation)
                scaled = local * np.asarray(placement.scale, dtype=np.float32)
                result.mesh.append(place(scaled, placement.position, rotation))  # type: ignore[arg-type]
            continue
        model = next((m for m in instances if number is not None and navmesh_model_number(m) == number), None)
        model = model or next((m for m in instances if stem.lower().startswith(m.lower())), None)
        if model is None:
            result.unplaced += 1
            continue
        _place_instances(result, local, instances, model)
    result.finish()
    if placements:
        note = f"placed by {len(placements)} entries of the navmesh placement table"
        result.note = f"{result.note}; {note}" if result.note else note[0].upper() + note[1:]
    result.seconds = time.monotonic() - started
    return result


def read_map_pieces(
    profile: GameProfile, area: Area, root: Path, feedback: Feedback, sample: int, budget: float = 0.0
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
    feedback.opening(f"map/{folder.name}")
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
    chosen = even_sample(sources, sample)
    feedback.planned(len(sources), len(chosen))
    _sample_note(result, len(chosen), "models")
    for name, load in _files(result, chosen, feedback, budget, started, "models"):
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
    result.seconds = time.monotonic() - started
    return result
