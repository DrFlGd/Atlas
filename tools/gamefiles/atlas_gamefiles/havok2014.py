"""Bloodborne's Havok 2014 files, decoded by our own code: the collision meshes (`hknpCompressedMeshShape`, which
soulstruct-havok parses but does not turn into triangles) and the navmeshes (`hkaiNavMesh`, which it has no types
for).

Both are Havok "packfiles" (binary, 64-bit pointers, little-endian). A packfile holds a header, three sections
(class names, types, data) and, for the data section, three fixup tables: local fixups (a pointer at one offset of
the data section points to another offset of it), global fixups (a pointer to another section) and virtual fixups
(the object starting at an offset is of the class whose name is at an offset of the class names section). Nothing
else of the format is needed: objects are found by class name, and their fields are read at fixed offsets.

**Compressed meshes** (`hknpCompressedMeshShapeData`, its mesh tree at +16):

- the tree's `domain` (an axis-aligned box) at +16 of the tree, and its arrays (a 16-byte array header each: a
  pointer, then the count): `sections` +64, `primitives` +80, `sharedVerticesIndex` +96, `packedVertices` +112,
  `sharedVertices` +128;
- each section (96 bytes) has six floats at +48 (an offset and a scale, three each), the first of its packed
  vertices (+72), where its shared vertex indices start (+76, shifted right by 8), where its primitives start and
  how many (+80: start shifted right by 8, count in the low 8 bits), and how many packed vertices (+88) and shared
  vertex indices (+89) it has;
- a packed vertex is 32 bits (11 for x, 11 for y, 10 for z): offset + steps * scale; a shared vertex is 64 bits (21
  for x, 21 for y, 22 for z) spread over the tree's domain;
- a primitive is four bytes, indices into the section's vertices (its packed ones, then its shared ones): a triangle
  when the last two are equal, else a quad (two triangles). Unused slots hold DE AD DE AD and are skipped.

Each body of an `hknpPhysicsSystemData` (+64: its bodies, 96 bytes each: the shape pointer at +0, a position at +48,
a rotation quaternion x, y, z, w at +64) places a shape; the shape's mesh data pointer is at +88 (Bloodborne's
layout) or +96. A mesh no body places is taken as it is.

**Navmeshes** (`hkaiNavMesh`): faces at +16 (16 bytes each: first edge, ..., edge count at +8), edges at +32 (20
bytes each, the edge's first vertex at +0) and vertices at +48 (four floats each). Each face is a polygon of its
edges' first vertices, cut into a fan of triangles.

**Navmesh placement** (`mAA_BB_CC_DD.nva.dcx`, "NVMA"): a table at offset 16 (index, version, size, count), then the
entries from offset 32, 144 bytes each: position (3 floats) at +0, rotation in radians (3 floats) at +16, scale (3
floats) at +32, then the entry's name number and the navmesh model number (2 ints) at +48.

The layout facts above were checked against the types soulstruct-havok defines for Havok 2014; the method of
reading Bloodborne's files follows Hunter's Atlas (see the README's credits). No code was taken from either.
"""

from __future__ import annotations

import math
import struct
import typing as tp
from dataclasses import dataclass, field

import numpy as np

MAGIC = b"\x57\xe0\xe0\x57\x10\xc0\xc0\x10"
NONE = 0xFFFFFFFF
MAX_ITEMS = 20_000_000
POISON = (0xDE, 0xAD, 0xDE, 0xAD)


class HavokError(ValueError):
    """The bytes are not a Havok 2014 packfile we can read."""


def undcx(data: bytes) -> bytes:
    """`data` without its DCX wrapping, when it has one."""
    if data[:4] == b"DCX\0":
        from soulstruct.dcx import decompress

        return bytes(decompress(data)[0])
    return bytes(data)


@dataclass
class Section:
    tag: str
    start: int
    local: int
    global_: int
    virtual: int
    exports: int
    imports: int
    end: int


@dataclass
class Packfile:
    """The parts of a packfile this module reads: the data section, its pointers and its objects' classes."""

    data: bytes
    start: int  # where the data section starts in `data`
    size: int  # its size
    pointers: dict[int, int] = field(default_factory=dict)  # data-section offset -> data-section offset
    classes: dict[int, str] = field(default_factory=dict)  # object offset -> class name
    version: str = ""

    @classmethod
    def from_bytes(cls, raw: bytes) -> Packfile:
        raw = undcx(raw)
        if len(raw) < 0x40 or raw[:8] != MAGIC:
            raise HavokError("not a Havok packfile")
        pointer_size, little = raw[0x10], raw[0x11]
        if pointer_size != 8 or little != 1:
            raise HavokError(f"a Havok packfile with {pointer_size}-byte pointers, not a 64-bit one")
        sections_count = struct.unpack_from("<i", raw, 0x14)[0]
        contents_section = struct.unpack_from("<i", raw, 0x18)[0]
        version = raw[0x28:0x38].split(b"\0", 1)[0].decode("ascii", "replace")
        file_version = struct.unpack_from("<i", raw, 0x0C)[0]
        header_end = 0x40
        if file_version >= 11:
            header_end += struct.unpack_from("<h", raw, 0x3E)[0]
        header_size = 0x40 if file_version >= 11 else 0x30
        if not 1 <= sections_count <= 8:
            raise HavokError(f"a Havok packfile with {sections_count} sections")
        sections = []
        for index in range(sections_count):
            at = header_end + index * header_size
            if at + 48 > len(raw):
                raise HavokError("the Havok packfile is cut short")
            tag = raw[at:at + 19].split(b"\0", 1)[0].decode("ascii", "replace")
            values = struct.unpack_from("<7I", raw, at + 20)
            sections.append(Section(tag, *values))
        names_section = next((s for s in sections if s.tag == "__classnames__"), sections[0])
        if 0 <= contents_section < len(sections) and sections[contents_section].tag == "__data__":
            data_index = contents_section
        else:
            data_index = next((i for i, s in enumerate(sections) if s.tag == "__data__"), -1)
        if data_index < 0:
            raise HavokError("the Havok packfile has no data section")
        data = sections[data_index]
        if data.start + data.end > len(raw):
            raise HavokError("the Havok packfile's data section is cut short")
        packfile = cls(raw, data.start, data.local, version=version)

        def table(begin: int, end: int, width: int) -> np.ndarray:
            count = max(0, (end - begin) // (4 * width))
            values = np.frombuffer(raw, dtype="<u4", count=count * width, offset=data.start + begin)
            values = values.reshape(-1, width)
            return values[values[:, 0] != NONE]

        for src, dst in table(data.local, data.global_, 2).tolist():
            packfile.pointers[src] = dst
        for src, section, dst in table(data.global_, data.virtual, 3).tolist():
            if section == data_index:
                packfile.pointers[src] = dst
        for src, section, name_at in table(data.virtual, data.exports, 3).tolist():
            if 0 <= section < len(sections):
                names = sections[section]
                at = names.start + name_at
                packfile.classes[src] = raw[at:raw.index(b"\0", at)].decode("ascii", "replace")
        return packfile

    # --- reading fields -----------------------------------------------------------------------------------------

    def objects(self, class_name: str) -> list[int]:
        return sorted(offset for offset, name in self.classes.items() if name == class_name)

    def unpack(self, fmt: str, offset: int) -> tuple[tp.Any, ...]:
        if offset < 0 or offset + struct.calcsize(fmt) > self.size:
            raise HavokError(f"a field at {offset:#x} is outside the data section")
        return struct.unpack_from(fmt, self.data, self.start + offset)

    def pointer(self, offset: int) -> int | None:
        return self.pointers.get(offset)

    def array(self, offset: int, dtype: str, width: int = 1) -> np.ndarray:
        """An `hkArray` whose 16-byte header is at `offset`: its items as an (n,) or (n, width) array."""
        count = self.unpack("<i", offset + 8)[0]
        item = np.dtype(dtype)
        if count <= 0:
            return np.zeros((0, width) if width > 1 else 0, dtype=item)
        if count > MAX_ITEMS:
            raise HavokError(f"an array of {count} items")
        target = self.pointer(offset)
        if target is None:
            raise HavokError(f"an array at {offset:#x} points nowhere")
        if target + count * width * item.itemsize > self.size:
            raise HavokError(f"an array at {offset:#x} runs past the data section")
        values = np.frombuffer(self.data, dtype=item, count=count * width, offset=self.start + target)
        return values.reshape(-1, width) if width > 1 else values


# --- Collision -------------------------------------------------------------------------------------------------

MESH_DATA = "hknpCompressedMeshShapeData"
SYSTEM = "hknpPhysicsSystemData"
SHAPE_DATA_POINTERS = (88, 96)


def quaternion_matrix(x: float, y: float, z: float, w: float) -> np.ndarray:
    length = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / length, y / length, z / length, w / length
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def mesh_tree_triangles(packfile: Packfile, tree: int) -> np.ndarray:
    """The (n, 3, 3) triangles of the compressed mesh tree at `tree`."""
    low = np.array(packfile.unpack("<3f", tree + 16), dtype=np.float64)
    high = np.array(packfile.unpack("<3f", tree + 32), dtype=np.float64)
    sections = packfile.array(tree + 64, "u1", 96)
    primitives = packfile.array(tree + 80, "u1", 4)
    shared_index = packfile.array(tree + 96, "<u2")
    packed = packfile.array(tree + 112, "<u4").astype(np.int64)
    shared = packfile.array(tree + 128, "<u8")
    steps = np.array([(1 << 21) - 1, (1 << 21) - 1, (1 << 22) - 1], dtype=np.float64)
    shared_xyz = np.stack(
        [shared & 0x1FFFFF, (shared >> np.uint64(21)) & 0x1FFFFF, shared >> np.uint64(42)], axis=1
    ).astype(np.float64)
    shared_xyz = low + shared_xyz * (high - low) / steps
    out = []
    for raw in sections:
        record = raw.tobytes()
        codec = np.array(struct.unpack_from("<6f", record, 48), dtype=np.float64)
        first_packed, shared_at, primitive_at = struct.unpack_from("<3I", record, 72)
        packed_count, shared_count = record[88], record[89]
        corners = packed[first_packed:first_packed + packed_count]
        if len(corners) != packed_count:
            raise HavokError("a mesh section's packed vertices run past the end")
        local = np.stack([corners & 0x7FF, (corners >> 11) & 0x7FF, (corners >> 22) & 0x3FF], axis=1)
        vertices = codec[:3] + local.astype(np.float64) * codec[3:]
        if shared_count:
            start = shared_at >> 8
            indices = shared_index[start:start + shared_count].astype(np.int64)
            if len(indices) != shared_count or (len(indices) and indices.max() >= len(shared_xyz)):
                raise HavokError("a mesh section's shared vertices run past the end")
            vertices = np.concatenate([vertices, shared_xyz[indices]])
        start, count = primitive_at >> 8, primitive_at & 0xFF
        prims = primitives[start:start + count]
        prims = prims[~np.all(prims == np.array(POISON, dtype=np.uint8), axis=1)].astype(np.int64)
        if not len(prims):
            continue
        if prims.max() >= len(vertices):
            raise HavokError("a mesh primitive names a vertex its section does not have")
        out.append(vertices[prims[:, :3]])
        quads = prims[prims[:, 2] != prims[:, 3]]
        if len(quads):
            out.append(vertices[quads[:, [0, 2, 3]]])
    if not out:
        return np.zeros((0, 3, 3), dtype=np.float32)
    return np.concatenate(out).astype(np.float32)


def collision_triangles(raw: bytes) -> np.ndarray:
    """Every triangle of a Bloodborne collision file (an `.hkx`, DCX-wrapped or not), in the file's own frame, each
    mesh moved by the bodies that place it."""
    packfile = Packfile.from_bytes(raw)
    meshes = packfile.objects(MESH_DATA)
    if not meshes:
        names = sorted(set(packfile.classes.values()))
        raise HavokError(f"no compressed mesh in this Havok file (it holds {', '.join(names[:6]) or 'nothing'})")
    placements: dict[int, list[tuple[np.ndarray, np.ndarray]]] = {}
    for system in packfile.objects(SYSTEM):
        bodies = packfile.unpack("<i", system + 64 + 8)[0]
        first = packfile.pointer(system + 64)
        if first is None or bodies <= 0 or bodies > 100_000:
            continue
        for index in range(bodies):
            body = first + index * 96
            shape = packfile.pointer(body)
            if shape is None:
                continue
            target = None
            for offset in SHAPE_DATA_POINTERS:
                candidate = packfile.pointer(shape + offset)
                if candidate in meshes:
                    target = candidate
                    break
            if target is None:
                continue
            position = np.array(packfile.unpack("<3f", body + 48), dtype=np.float64)
            rotation = quaternion_matrix(*packfile.unpack("<4f", body + 64))
            placements.setdefault(target, []).append((position, rotation))
    out = []
    for mesh in meshes:
        triangles = mesh_tree_triangles(packfile, mesh + 16).astype(np.float64)
        if not len(triangles):
            continue
        for position, rotation in placements.get(mesh, [(np.zeros(3), np.eye(3))]):
            out.append((triangles.reshape(-1, 3) @ rotation.T + position).reshape(-1, 3, 3))
    if not out:
        return np.zeros((0, 3, 3), dtype=np.float32)
    return np.concatenate(out).astype(np.float32)


# --- Navmesh ---------------------------------------------------------------------------------------------------

NAVMESH = "hkaiNavMesh"


def navmesh_triangles(raw: bytes) -> np.ndarray:
    """The walkable triangles of a Bloodborne navmesh file (`hkaiNavMesh`), in the navmesh's own frame."""
    packfile = Packfile.from_bytes(raw)
    found = packfile.objects(NAVMESH)
    if not found:
        raise HavokError("no navmesh in this Havok file")
    out = []
    for navmesh in found:
        faces = packfile.array(navmesh + 16, "u1", 16)
        edges = packfile.array(navmesh + 32, "u1", 20)
        vertices = packfile.array(navmesh + 48, "<f4", 4)[:, :3].astype(np.float64)
        if not len(faces):
            continue
        face_first = faces[:, 0:4].copy().view("<i4").reshape(-1).astype(np.int64)
        face_count = faces[:, 8:10].copy().view("<i2").reshape(-1).astype(np.int64)
        edge_start = edges[:, 0:4].copy().view("<i4").reshape(-1).astype(np.int64) if len(edges) else np.zeros(0, np.int64)
        for first, count in zip(face_first.tolist(), face_count.tolist()):
            if count < 3 or first < 0 or first + count > len(edge_start):
                continue
            corners = edge_start[first:first + count]
            if corners.min() < 0 or corners.max() >= len(vertices):
                continue
            polygon = vertices[corners]
            fan = np.stack([np.repeat(polygon[:1], count - 2, axis=0), polygon[1:-1], polygon[2:]], axis=1)
            out.append(fan)
    if not out:
        return np.zeros((0, 3, 3), dtype=np.float32)
    return np.concatenate(out).astype(np.float32)


@dataclass(frozen=True)
class NavmeshPlacement:
    name: int
    model: int
    position: tuple[float, float, float]
    rotation: tuple[float, float, float]  # radians
    scale: tuple[float, float, float]


def nva_placements(raw: bytes) -> list[NavmeshPlacement]:
    """The navmesh placements of an `.nva` file."""
    data = undcx(raw)
    if data[:4] != b"NVMA":
        raise HavokError("not a navmesh placement (NVA) file")
    _index, _version, _size, count = struct.unpack_from("<4I", data, 16)
    if count > 100_000 or 32 + count * 144 > len(data):
        raise HavokError("the navmesh placement table runs past the end of the file")
    out = []
    for index in range(count):
        at = 32 + index * 144
        position = struct.unpack_from("<3f", data, at)
        rotation = struct.unpack_from("<3f", data, at + 16)
        scale = struct.unpack_from("<3f", data, at + 32)
        name, model = struct.unpack_from("<2i", data, at + 48)
        out.append(NavmeshPlacement(name, model, position, rotation, scale))
    return out
