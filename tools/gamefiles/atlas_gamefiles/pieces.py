"""Pieces of an area the player removed in Adjust floors ("Remove pieces"): a stray panel floating over the map, say,
that has nothing to do with the ground. A removed piece is left out of finding the floors, the 2D floor pictures and
the 3D model, by Make map, Make this area again and Draw all areas again.

**A piece** is a connected piece of surface of one collision part: the part's triangles joined where they share a
corner (corners on the same millimetre are one). A stray panel is usually a piece of its own. The player can also
remove a **whole part** (every piece of it).

**How a removed piece is written down** (in the player's floor cuts file, per area, `removed`; see config.py and the
Map Maker's src-tauri/src/overrides.rs): `{"part": "h000100", "box": [x0, y0, z0, x1, y1, z1], "triangles": 2,
"area": 12.5}`, with `"whole": true` for a whole part. `part` is the collision part's name in the game's map layout;
`box` the piece's bounds in metres (the game's x, height and z, to the centimetre); `triangles` and `area` (square
metres) say how large it was. Nothing of the game itself is written: names and numbers only.

**Finding it again** works on what each place has:

1. **From the game files** (Make map, Make this area again, and the Adjust floors views, whose floor data keeps each
   triangle's part): the same game files give the same parts and triangles, so the piece is the piece of that part
   whose bounds are those written down (each side within `TOLERANCE`); a whole part is every triangle of the part.
   Indices of triangles are never written down, as they change with the order in which parts are read.
2. **Without the parts**, or when the part is gone or none of its pieces has those bounds (the game files changed):
   by its place alone (`by_place`). The triangles are joined into connected pieces over the whole model, and the
   pieces lying wholly inside the bounds (widened by `TOLERANCE`) are removed, as long as together they are not much
   larger than the piece was (`area`): never a piece that reaches outside the bounds, so nothing joined to the rest
   of the map. This is how Draw all areas again finds pieces in a pack's own 3D model (read back out of the pack,
   where the parts' names are gone), and how the game's own models (the 3D look "Game models" and the textured map
   styles) lose what lies where a removed collision piece was (`MODEL_SLACK`: a model's surface lies near, not on,
   the collision's).

A removed piece that is not found is reported, and nothing else is removed in its place.
"""

from __future__ import annotations

import json
import math
import struct
import typing as tp
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

MAX_REMOVED = 256  # removed pieces per area
MAX_PART_NAME = 64
TOLERANCE = 0.05  # metres: a piece's bounds found again within this on each side
MILLIMETRE = 1000.0
# Found by place: how much wider the bounds are taken, and how much larger (times, plus square metres) what is found
# may be than the piece was. The game's models: wider, as a model's surface lies near the collision's, not on it, and
# larger, as a model is seen from both sides and has some thickness.
PLACE_SLACK = (TOLERANCE, 1.1, 0.5)
MODEL_SLACK = (0.5, 3.0, 2.0)


# ---------------------------------------------------------------------------------------------------------------
# The record written in the floor cuts file.


def _number(value: tp.Any, limit: float = 100_000.0) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(float(value)) < limit:
        return float(value)
    return None


def clean_piece(value: tp.Any) -> dict[str, tp.Any] | None:
    """One removed piece as the player's file gives it, kept to what is read (see the top of this module); None when
    it is not usable."""
    if not isinstance(value, dict):
        return None
    part = value.get("part")
    if not isinstance(part, str):
        return None
    part = "".join(c for c in part if c.isprintable())[:MAX_PART_NAME].strip()
    box = value.get("box")
    if not isinstance(box, list) or len(box) != 6:
        return None
    numbers = [_number(v) for v in box]
    if any(v is None for v in numbers):
        return None
    low = [round(tp.cast(float, v), 2) for v in numbers[:3]]
    high = [round(tp.cast(float, v), 2) for v in numbers[3:]]
    if any(h < lo for lo, h in zip(low, high)):
        return None
    piece: dict[str, tp.Any] = {"part": part, "box": low + high}
    if value.get("whole") is True:
        piece["whole"] = True
    triangles = _number(value.get("triangles"), 1e9)
    if triangles is not None and triangles >= 0:
        piece["triangles"] = int(triangles)
    area = _number(value.get("area"), 1e9)
    if area is not None and area >= 0:
        piece["area"] = round(area, 2)
    return piece


def clean_pieces(value: tp.Any) -> list[dict[str, tp.Any]]:
    """The removed pieces of an area's entry, cleaned, each once."""
    if not isinstance(value, list):
        return []
    out: list[dict[str, tp.Any]] = []
    seen: set[str] = set()
    for item in value[:MAX_REMOVED]:
        piece = clean_piece(item)
        if piece is None:
            continue
        key = json.dumps([piece["part"], piece["box"], piece.get("whole", False)])
        if key not in seen:
            seen.add(key)
            out.append(piece)
    return out


def removed_of(overrides: dict[str, tp.Any] | None) -> list[dict[str, tp.Any]]:
    """The removed pieces of an area's floor overrides (none in the shipped config: only the player removes)."""
    return clean_pieces((overrides or {}).get("removed"))


# ---------------------------------------------------------------------------------------------------------------
# Connected pieces.


def components(triangles: np.ndarray, group: np.ndarray | None = None) -> np.ndarray:
    """Each triangle's connected piece (0, 1, ... in order of first triangle): triangles sharing a corner (on the same
    millimetre) are joined, and with `group` (one number a triangle), only within the same group."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    triangles = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    n = len(triangles)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    corners = np.round(triangles.reshape(-1, 3) * MILLIMETRE).astype(np.int64)
    if group is not None:
        corners = np.concatenate([np.repeat(np.asarray(group, dtype=np.int64), 3)[:, None], corners], axis=1)
    corners = np.ascontiguousarray(corners)
    keys = corners.view(np.dtype((np.void, corners.dtype.itemsize * corners.shape[1]))).ravel()
    _, vertex = np.unique(keys, return_inverse=True)
    vertex = vertex.reshape(n, 3)
    count = int(vertex.max()) + 1
    rows = np.concatenate([vertex[:, 0], vertex[:, 1]])
    cols = np.concatenate([vertex[:, 1], vertex[:, 2]])
    graph = coo_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(count, count))
    _, label = connected_components(graph, directed=False)
    piece = label[vertex[:, 0]]
    # Numbered by first triangle, so that the same triangles give the same numbers.
    _, first, inverse = np.unique(piece, return_index=True, return_inverse=True)
    order = np.argsort(np.argsort(first))
    return order[inverse].astype(np.int64)


def triangle_areas(triangles: np.ndarray) -> np.ndarray:
    t = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    return 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)


def _per_piece(triangles: np.ndarray, piece: np.ndarray, count: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Each piece's bounds (count, 6), triangles and area."""
    t = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    boxes = np.zeros((count, 6))
    sizes = np.bincount(piece, minlength=count)
    areas = np.bincount(piece, weights=triangle_areas(t), minlength=count)
    if len(t):
        order = np.argsort(piece, kind="stable")
        starts = np.concatenate([[0], np.cumsum(sizes)[:-1]])
        filled = sizes > 0
        boxes[filled, :3] = np.minimum.reduceat(t.min(axis=1)[order], starts[filled])
        boxes[filled, 3:] = np.maximum.reduceat(t.max(axis=1)[order], starts[filled])
    return boxes, sizes, areas


@dataclass
class PieceTable:
    """An area's pieces: each triangle's piece, and per piece its part (an index in `part_names`), bounds,
    triangles and area."""

    triangle_piece: np.ndarray
    piece_part: np.ndarray
    piece_box: np.ndarray
    piece_triangles: np.ndarray
    piece_area: np.ndarray
    part_names: list[str]

    def record(self, piece: int) -> dict[str, tp.Any]:
        """What is written down for removing piece `piece`."""
        part = int(self.piece_part[piece])
        return {
            "part": self.part_names[part] if 0 <= part < len(self.part_names) else "",
            "box": [round(float(v), 2) for v in self.piece_box[piece]],
            "triangles": int(self.piece_triangles[piece]),
            "area": round(float(self.piece_area[piece]), 2),
        }


def piece_table(triangles: np.ndarray, owners: np.ndarray | None, owner_names: list[str] | None) -> PieceTable:
    """The pieces of `triangles`, each within the part that placed it (`owners`, an index in `owner_names` per
    triangle; without them, all is one part named "")."""
    t = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    if owners is None or owner_names is None or len(owners) != len(t):
        owners, owner_names = np.zeros(len(t), dtype=np.int64), [""]
    owners = np.asarray(owners, dtype=np.int64)
    piece = components(t, owners)
    count = int(piece.max()) + 1 if len(piece) else 0
    part = np.full(count, -1, dtype=np.int64)
    part[piece] = owners
    boxes, sizes, areas = _per_piece(t, piece, count)
    return PieceTable(piece, part, boxes, sizes, areas, [str(n) for n in owner_names])


# ---------------------------------------------------------------------------------------------------------------
# Finding removed pieces again.


@dataclass
class Found:
    """Which triangles the removed pieces are (`removed`, a mask), and per piece how many triangles were found and
    how (`part`: by its part, `place`: by its place alone, None: not found)."""

    removed: np.ndarray
    triangles: list[int]
    how: list[str | None]

    def report(self, pieces: list[dict[str, tp.Any]]) -> dict[str, tp.Any]:
        return {
            "asked": len(pieces),
            "found": sum(1 for n in self.triangles if n > 0),
            "triangles": int(self.removed.sum()),
            "pieces": [
                {
                    "part": p["part"],
                    **({"whole": True} if p.get("whole") else {}),
                    "box": p["box"],
                    "found": n > 0,
                    "by": how,
                    "triangles": n,
                }
                for p, n, how in zip(pieces, self.triangles, self.how)
            ],
        }


def _box_of(piece: dict[str, tp.Any]) -> np.ndarray:
    return np.asarray(piece["box"], dtype=np.float64)


def by_part(table: PieceTable, piece: dict[str, tp.Any]) -> np.ndarray:
    """The pieces (indices in the table) that are this removed piece, by its part: none when the part is not there
    or no piece of it has its bounds."""
    parts = [i for i, name in enumerate(table.part_names) if name == piece["part"]]
    if not parts or not len(table.piece_part):
        return np.zeros(0, dtype=np.int64)
    mine = np.isin(table.piece_part, parts)
    if piece.get("whole"):
        return np.flatnonzero(mine)
    close = np.all(np.abs(table.piece_box - _box_of(piece)) <= TOLERANCE + 1e-6, axis=1)
    return np.flatnonzero(mine & close)


class Places:
    """The connected pieces of a whole model, joined across parts, for finding removed pieces by place alone; worked
    out on first use."""

    def __init__(self, triangles: np.ndarray):
        self.triangles = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
        self._table: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None

    def table(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Each triangle's piece, and each piece's bounds and area."""
        if self._table is None:
            piece = components(self.triangles)
            count = int(piece.max()) + 1 if len(piece) else 0
            boxes, _, areas = _per_piece(self.triangles, piece, count)
            self._table = (piece, boxes, areas)
        return self._table

    def find(self, piece: dict[str, tp.Any], slack: tuple[float, float, float] = PLACE_SLACK) -> np.ndarray:
        """The triangles of the model's pieces lying wholly inside the removed piece's bounds (widened by `slack[0]`),
        when together they are no larger than `slack[1]` times its area plus `slack[2]` square metres (a mask)."""
        if not len(self.triangles):
            return np.zeros(0, dtype=bool)
        pad, times, plus = slack
        box = _box_of(piece)
        low, high = box[:3] - pad, box[3:] + pad
        # Only pieces that touch the bounds need be looked at: those of triangles with a corner inside.
        inside = np.all((self.triangles >= low) & (self.triangles <= high), axis=(1, 2))
        if not inside.any():
            return inside
        labels, boxes, areas = self.table()
        candidates = np.unique(labels[inside])
        whole = np.all(boxes[candidates, :3] >= low, axis=1) & np.all(boxes[candidates, 3:] <= high, axis=1)
        chosen = candidates[whole]
        if not len(chosen):
            return np.zeros(len(self.triangles), dtype=bool)
        wanted = piece.get("area")
        if wanted is not None and float(areas[chosen].sum()) > float(wanted) * times + plus:
            # Too much lies there: only a piece with the very bounds, if there is one.
            close = np.all(np.abs(boxes[chosen] - box) <= TOLERANCE + 1e-6, axis=1)
            chosen = chosen[close]
            if not len(chosen) or float(areas[chosen].sum()) > float(wanted) * times + plus:
                return np.zeros(len(self.triangles), dtype=bool)
        return np.isin(labels, chosen)


def find_removed(
    triangles: np.ndarray,
    owners: np.ndarray | None,
    owner_names: list[str] | None,
    pieces: list[dict[str, tp.Any]],
    table: PieceTable | None = None,
    slack: tuple[float, float, float] = PLACE_SLACK,
) -> Found:
    """Which of `triangles` the removed `pieces` are: by their part where the triangles' parts are known, else by
    their place (see the top of this module)."""
    t = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    removed = np.zeros(len(t), dtype=bool)
    counts: list[int] = []
    how: list[str | None] = []
    if not pieces or not len(t):
        return Found(removed, [0] * len(pieces), [None] * len(pieces))
    known = owners is not None and owner_names is not None and len(owners) == len(t)
    if known and table is None:
        table = piece_table(t, owners, owner_names)
    places = Places(t)
    for piece in pieces:
        mask = None
        if known and table is not None:
            found = by_part(table, piece)
            if len(found):
                mask = np.isin(table.triangle_piece, found)
                how.append("part")
        if mask is None:
            mask = places.find(piece, slack)
            how.append("place" if mask.any() else None)
        counts.append(int(mask.sum()))
        removed |= mask
    return Found(removed, counts, how)


def leave_out(
    triangles: np.ndarray, owners: np.ndarray, owner_names: list[str], pieces: list[dict[str, tp.Any]]
) -> tuple[np.ndarray, np.ndarray, dict[str, tp.Any] | None]:
    """The triangles (and their owners) without the removed pieces, and what the report says of them (None when no
    piece is removed)."""
    if not pieces:
        return triangles, owners, None
    found = find_removed(triangles, owners if len(owners) == len(triangles) else None, owner_names, pieces)
    keep = ~found.removed
    kept_owners = owners[keep] if len(owners) == len(triangles) else owners
    return triangles[keep], kept_owners, found.report(pieces)


def leave_out_of_models(models: tp.Any, pieces: list[dict[str, tp.Any]]) -> tuple[tp.Any, int]:
    """The game's own models (models.TexturedMesh) without what lies where the removed pieces are (found by place,
    with `MODEL_SLACK`), and how many of their triangles were left out."""
    if models is None or not pieces or not len(models.triangles):
        return models, 0
    removed = np.zeros(len(models.triangles), dtype=bool)
    places = Places(models.triangles)
    for piece in pieces:
        removed |= places.find(piece, MODEL_SLACK)
    if not removed.any():
        return models, 0
    keep = ~removed
    return (
        replace(
            models,
            triangles=models.triangles[keep],
            uvs=models.uvs[keep],
            material=models.material[keep],
            owners=models.owners[keep],
        ),
        int(removed.sum()),
    )


# ---------------------------------------------------------------------------------------------------------------
# A raw model file (glTF binary), as `atlas-scene unpack` writes it: plain triangle meshes.


def _read_glb(data: bytes) -> tuple[dict[str, tp.Any], bytes]:
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("not a glTF binary file")
    length = struct.unpack_from("<I", data, 8)[0]
    offset = 12
    document: dict[str, tp.Any] | None = None
    binary = b""
    while offset + 8 <= min(length, len(data)):
        size, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + size]
        if kind == 0x4E4F534A:
            document = json.loads(chunk.decode("utf-8"))
        elif kind == 0x004E4942:
            binary = chunk
        offset += 8 + size
    if document is None:
        raise ValueError("no JSON in the glTF file")
    return document, binary


def _write_glb(document: dict[str, tp.Any], binary: bytes) -> bytes:
    text = json.dumps(document, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    return b"".join(
        [
            struct.pack("<4sII", b"glTF", 2, total),
            struct.pack("<II", len(text), 0x4E4F534A),
            text,
            struct.pack("<II", len(binary), 0x004E4942),
            binary,
        ]
    )


_COMPONENTS = {5121: ("<u1", 1), 5123: ("<u2", 2), 5125: ("<u4", 4), 5126: ("<f4", 4)}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _accessor(document: dict[str, tp.Any], binary: bytes, index: int) -> np.ndarray:
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    dtype, size = _COMPONENTS[int(accessor["componentType"])]
    width = _WIDTH[accessor["type"]]
    count = int(accessor["count"])
    start = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    stride = int(view.get("byteStride", size * width))
    if stride == size * width:
        values = np.frombuffer(binary, dtype=dtype, count=count * width, offset=start)
        return values.reshape(count, width) if width > 1 else values
    rows = [np.frombuffer(binary, dtype=dtype, count=width, offset=start + i * stride) for i in range(count)]
    return np.array(rows).reshape(count, width) if width > 1 else np.array(rows).ravel()


def leave_out_of_glb(path: Path, pieces: list[dict[str, tp.Any]]) -> Found | None:
    """Removes the removed pieces (found by place) from the raw model file at `path`, as `atlas-scene unpack` writes
    one (a triangle mesh per material, with indices, no node transforms), in place; what was found, or None when no
    triangle was removed (the file is then left as it was). ValueError when the file is not one it can change."""
    if not pieces:
        return None
    document, binary = _read_glb(Path(path).read_bytes())
    primitives: list[tuple[dict[str, tp.Any], np.ndarray]] = []
    corners = []
    for node in document.get("nodes", []):
        if any(key in node for key in ("matrix", "rotation", "scale", "translation")):
            raise ValueError("the model's nodes are moved")
    shown = {node["mesh"] for node in document.get("nodes", []) if isinstance(node.get("mesh"), int)}
    for index, mesh in enumerate(document.get("meshes", [])):
        if index not in shown:
            continue
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4 or "indices" not in primitive:
                raise ValueError("the model has a mesh that is not indexed triangles")
            positions = _accessor(document, binary, primitive["attributes"]["POSITION"]).astype(np.float64)
            indices = _accessor(document, binary, primitive["indices"]).astype(np.int64).reshape(-1, 3)
            primitives.append((primitive, indices))
            corners.append(positions[indices])
    if not corners:
        return None
    triangles = np.concatenate(corners, axis=0)
    found = find_removed(triangles, None, None, pieces)
    if not found.removed.any():
        return None
    out = bytearray(binary)
    out += b"\0" * (-len(out) % 4)
    start = 0
    emptied: list[int] = []  # ids of primitives left with no triangle
    for primitive, indices in primitives:
        keep = ~found.removed[start : start + len(indices)]
        start += len(indices)
        if keep.all():
            continue
        if not keep.any():
            emptied.append(id(primitive))
            continue
        data = indices[keep].astype("<u4").tobytes()
        document["bufferViews"].append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data), "target": 34963})
        out += data
        out += b"\0" * (-len(out) % 4)
        document["accessors"].append(
            {"bufferView": len(document["bufferViews"]) - 1, "componentType": 5125, "count": int(keep.sum()) * 3, "type": "SCALAR"}
        )
        primitive["indices"] = len(document["accessors"]) - 1
    # A primitive left with no triangle is taken out of its mesh; a mesh left with none stays as it was (a mesh needs
    # one) but no node shows it any more.
    unused = set()
    for index, mesh in enumerate(document.get("meshes", [])):
        left = [p for p in mesh.get("primitives", []) if id(p) not in emptied]
        if left:
            mesh["primitives"] = left
        else:
            unused.add(index)
    for node in document.get("nodes", []):
        if node.get("mesh") in unused:
            node.pop("mesh")
    document["buffers"] = [{"byteLength": len(out)}]
    Path(path).write_bytes(_write_glb(document, bytes(out)))
    return found
