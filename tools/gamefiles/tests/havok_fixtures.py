"""Made-up Bloodborne-style Havok 2014 files for the tests, written here byte by byte (Soulstruct does not write
them): a collision file with a compressed mesh (`hknpCompressedMeshShapeData`) placed by a body, a navmesh
(`hkaiNavMesh`) and a navmesh placement table (`.nva`). Only what atlas_gamefiles.havok2014 reads is filled in; the
rest is zeros. The geometry is whatever the test passes in: invented triangles, never game data.
"""

from __future__ import annotations

import struct
import typing as tp

import numpy as np

MAGIC = b"\x57\xe0\xe0\x57\x10\xc0\xc0\x10"


class DataWriter:
    """The data section of a packfile being written: objects, pointers between them and their classes."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.pointers: list[tuple[int, int]] = []
        self.objects: list[tuple[int, str]] = []

    def align(self, size: int = 16) -> None:
        while len(self.data) % size:
            self.data.append(0)

    def reserve(self, size: int, class_name: str | None = None) -> int:
        self.align()
        at = len(self.data)
        self.data.extend(b"\0" * size)
        if class_name:
            self.objects.append((at, class_name))
        return at

    def put(self, offset: int, fmt: str, *values: tp.Any) -> None:
        struct.pack_into(fmt, self.data, offset, *values)

    def blob(self, payload: bytes) -> int:
        self.align()
        at = len(self.data)
        self.data.extend(payload)
        return at

    def array(self, header: int, payload: bytes, count: int) -> None:
        """Fills the 16-byte `hkArray` header at `header` with `count` items stored in `payload`."""
        self.put(header + 8, "<iI", count, count | (1 << 31))
        if count:
            self.pointers.append((header, self.blob(payload)))

    def point(self, source: int, target: int) -> None:
        self.pointers.append((source, target))

    def packfile(self) -> bytes:
        self.align()
        names = sorted({name for _, name in self.objects})
        class_names = bytearray()
        name_at: dict[str, int] = {}
        for name in names:
            class_names += struct.pack("<I", 0x12345678) + b"\x09"
            name_at[name] = len(class_names)
            class_names += name.encode() + b"\0"
        while len(class_names) % 16:
            class_names.append(0xFF)

        def fixups(rows: list[tuple[int, ...]], width: int) -> bytes:
            out = b"".join(struct.pack(f"<{width}I", *row) for row in rows)
            while len(out) % 16:
                out += b"\xff" * 4
            return out

        local = fixups(sorted(self.pointers), 2)
        global_ = fixups([], 3)
        virtual = fixups([(at, 0, name_at[name]) for at, name in sorted(self.objects)], 3)
        header = bytearray(0x40)
        header[0:8] = MAGIC
        struct.pack_into("<ii", header, 0x08, 0, 11)
        header[0x10:0x14] = bytes([8, 1, 1, 1])
        struct.pack_into("<iiiii", header, 0x14, 3, 2, 0, 0, 0)
        header[0x28:0x38] = b"hk_2014.1.0-r1".ljust(16, b"\0")
        struct.pack_into("<ihh", header, 0x38, 0, -1, 0)
        start = 0x40 + 3 * 0x40
        classes_start = start
        types_start = classes_start + len(class_names)
        data_start = types_start
        body = bytes(self.data)
        local_at = len(body)
        global_at = local_at + len(local)
        virtual_at = global_at + len(global_)
        end = virtual_at + len(virtual)

        def section(tag: str, begin: int, values: tuple[int, ...]) -> bytes:
            return tag.encode().ljust(19, b"\0") + b"\xff" + struct.pack("<7I", begin, *values) + b"\xff" * 16

        n = len(class_names)
        sections = (
            section("__classnames__", classes_start, (n, n, n, n, n, n))
            + section("__types__", types_start, (0, 0, 0, 0, 0, 0))
            + section("__data__", data_start, (local_at, global_at, virtual_at, end, end, end))
        )
        return bytes(header) + sections + bytes(class_names) + body + local + global_ + virtual


def compressed_mesh_file(
    triangles: tp.Sequence[tp.Sequence[tp.Sequence[float]]],
    position: tuple[float, float, float] = (0.0, 0.0, 0.0),
    quaternion: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0),
    per_section: int = 40,
    shape_data_at: int = 88,
) -> bytes:
    """A collision file holding `triangles` (in the body's own frame) in a compressed mesh, placed by one body at
    `position` turned by `quaternion`. The first corner of each section's first triangle is stored as a shared
    vertex, the rest as packed ones; consecutive triangles sharing an edge are stored as quads."""
    tris = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    writer = DataWriter()
    scene = writer.reserve(40, "hknpPhysicsSceneData")
    system = writer.reserve(120, "hknpPhysicsSystemData")
    writer.put(scene + 16 + 8, "<ii", 1, 1)
    writer.point(scene + 16, writer.blob(b"\0" * 8))
    writer.point(writer.pointers[-1][1], system)
    shape = writer.reserve(184, "fsnpCustomParamCompressedMeshShape")
    mesh = writer.reserve(208, "hknpCompressedMeshShapeData")
    writer.point(shape + shape_data_at, mesh)
    body = bytearray(96)
    struct.pack_into("<4f", body, 48, *position, 0.0)
    struct.pack_into("<4f", body, 64, *quaternion)
    writer.array(system + 64, bytes(body), 1)
    writer.point(writer.pointers[-1][1], shape)

    tree = mesh + 16
    low = tris.reshape(-1, 3).min(axis=0) - 1.0
    high = tris.reshape(-1, 3).max(axis=0) + 1.0
    writer.put(tree + 16, "<4f4f", *low, 0.0, *high, 0.0)
    shared_steps = np.array([(1 << 21) - 1, (1 << 21) - 1, (1 << 22) - 1], dtype=np.float64)
    sections = bytearray()
    primitives = bytearray()
    packed = bytearray()
    shared = bytearray()
    shared_index = bytearray()
    packed_total = shared_total = primitive_total = 0
    for first in range(0, len(tris), per_section):
        chunk = tris[first:first + per_section]
        corners = chunk.reshape(-1, 3)
        lo = corners.min(axis=0)
        span = np.maximum(corners.max(axis=0) - lo, 1e-3)
        scale = span / np.array([2047.0, 2047.0, 1023.0])
        # One shared vertex (the first corner), the others packed, de-duplicated.
        shared_q = np.round((corners[0] - low) / (high - low) * shared_steps).astype(np.uint64)
        shared += struct.pack("<Q", int(shared_q[0]) | (int(shared_q[1]) << 21) | (int(shared_q[2]) << 42))
        keys: dict[tuple[int, int, int], int] = {}
        packed_here: list[int] = []
        indices = []
        for corner_index, corner in enumerate(corners):
            if corner_index == 0:
                indices.append(-1)
                continue
            q = tuple(int(v) for v in np.round((corner - lo) / scale))
            if q not in keys:
                keys[q] = len(packed_here)
                packed_here.append(q[0] | (q[1] << 11) | (q[2] << 22))
            indices.append(keys[q])
        shared_slot = len(packed_here)
        indices = [shared_slot if i < 0 else i for i in indices]
        rows = []
        index = 0
        tri_list = [indices[i * 3:i * 3 + 3] for i in range(len(chunk))]
        while index < len(tri_list):
            a, b, c = tri_list[index]
            if index + 1 < len(tri_list):
                d, e, f = tri_list[index + 1]
                if (d, e) == (a, c):  # (a, c, f) continues (a, b, c) into the quad a, b, c, f
                    rows.append((a, b, c, f))
                    index += 2
                    continue
            rows.append((a, b, c, c))
            index += 1
        rows.append((0xDE, 0xAD, 0xDE, 0xAD))
        record = bytearray(96)
        struct.pack_into("<6f", record, 48, *lo, *scale)
        struct.pack_into(
            "<3I", record, 72, packed_total, (shared_total << 8) | 1, (primitive_total << 8) | len(rows)
        )
        record[88] = len(packed_here)
        record[89] = 1
        sections += record
        for row in rows:
            primitives += bytes(row)
        for value in packed_here:
            packed += struct.pack("<I", value)
        shared_index += struct.pack("<H", shared_total)
        packed_total += len(packed_here)
        shared_total += 1
        primitive_total += len(rows)
    writer.array(tree + 64, bytes(sections), len(sections) // 96)
    writer.array(tree + 80, bytes(primitives), primitive_total)
    writer.array(tree + 96, bytes(shared_index), shared_total)
    writer.array(tree + 112, bytes(packed), packed_total)
    writer.array(tree + 128, bytes(shared), shared_total)
    return writer.packfile()


def navmesh_file(polygons: tp.Sequence[tp.Sequence[tp.Sequence[float]]]) -> bytes:
    """A navmesh (`hkaiNavMesh`) of the given faces, each a list of corners (x, y, z) in order."""
    writer = DataWriter()
    navmesh = writer.reserve(176, "hkaiNavMesh")
    vertices: list[tuple[float, float, float]] = []
    faces = bytearray()
    edges = bytearray()
    edge_count = 0
    for polygon in polygons:
        ids = []
        for corner in polygon:
            ids.append(len(vertices))
            vertices.append(tuple(float(v) for v in corner))  # type: ignore[arg-type]
        faces += struct.pack("<iihhhh", edge_count, -1, len(ids), 0, 0, 0)
        for k, start in enumerate(ids):
            edges += struct.pack("<iiIIBBh", start, ids[(k + 1) % len(ids)], 0xFFFFFFFF, 0xFFFFFFFF, 0, 0, 0)
        edge_count += len(ids)
    writer.array(navmesh + 16, bytes(faces), len(polygons))
    writer.array(navmesh + 32, bytes(edges), edge_count)
    writer.array(navmesh + 48, b"".join(struct.pack("<4f", *v, 1.0) for v in vertices), len(vertices))
    return writer.packfile()


def nva_file(placements: tp.Sequence[tuple[int, int, tuple[float, float, float], tuple[float, float, float]]]) -> bytes:
    """A navmesh placement table: (name number, model number, position, rotation in radians) per navmesh."""
    out = bytearray(b"NVMA" + struct.pack("<3I", 4, 0, 0))
    out += struct.pack("<4I", 0, 3, 32 + 144 * len(placements), len(placements))
    for name, model, position, rotation in placements:
        entry = bytearray(144)
        struct.pack_into("<3f", entry, 0, *position)
        struct.pack_into("<3f", entry, 16, *rotation)
        struct.pack_into("<3f", entry, 32, 1.0, 1.0, 1.0)
        struct.pack_into("<2i", entry, 48, name, model)
        out += entry
    return bytes(out)
