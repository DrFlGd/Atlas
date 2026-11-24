"""Made-up 3D models for the tests of `make-model`: a small two-storey house with a yard, written as OBJ (with its
materials file and a made-up texture picture) and as binary STL, Z up. Nothing here comes from a real model.

    python tests/model_fixtures.py <folder>     writes house.obj, house.mtl, roof tiles.png and house.stl there
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

# Each quad: four corners (x east, y north, z up, metres), counter-clockwise seen from its front, and its material.
Quad = tuple[tuple[tuple[float, float, float], ...], str]


def box_quads(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float, material: str) -> list[Quad]:
    """A closed box: top facing up, bottom facing down, sides facing out."""
    return [
        (((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)), material),
        (((x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)), material),
        (((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)), material),
        (((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)), material),
        (((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)), material),
        (((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)), material),
    ]


def house() -> list[Quad]:
    """A house 16 by 10 metres on a yard 30 by 22: a ground floor at 0, an upper floor at 3.5 (a slab 0.3 thick), a
    flat roof at 7 (also a slab), walls 0.3 thick with a gap for a door, and an inside stair up to the upper floor."""
    quads: list[Quad] = []
    # The yard and the ground floor (one ground at 0, a thin slab).
    quads += box_quads(-7, -6, -0.2, 23, 16, 0.0, "Grass")
    # Walls (stone), the south wall with a door gap from x 6 to 8.
    quads += box_quads(0, 0, 0, 6, 0.3, 7.3, "Stone")
    quads += box_quads(8, 0, 0, 16, 0.3, 7.3, "Stone")
    quads += box_quads(6, 0, 2.2, 8, 0.3, 7.3, "Stone")
    quads += box_quads(0, 9.7, 0, 16, 10, 7.3, "Stone")
    quads += box_quads(0, 0.3, 0, 0.3, 9.7, 7.3, "Stone")
    quads += box_quads(15.7, 0.3, 0, 16, 9.7, 7.3, "Stone")
    # The upper floor (wood), with a stairwell gap from x 12 to 15.
    quads += box_quads(0.3, 0.3, 3.2, 12, 9.7, 3.5, "Wood")
    quads += box_quads(15, 0.3, 3.2, 15.7, 9.7, 3.5, "Wood")
    quads += box_quads(12, 4, 3.2, 15, 9.7, 3.5, "Wood")
    # The stair: seven steps up to 3.5 between x 12 and 15, y 0.3 to 4.
    for step in range(7):
        y0 = 0.3 + step * 0.53
        quads += box_quads(12, y0, 0, 15, y0 + 0.53, (step + 1) * 0.5, "Wood")
    # The roof (tiles, textured).
    quads += box_quads(-0.5, -0.5, 7.0, 16.5, 10.5, 7.3, "Roof")
    return quads


MATERIALS = {
    "Grass": (0.35, 0.55, 0.25),
    "Stone": (0.6, 0.6, 0.62),
    "Wood": (0.55, 0.38, 0.22),
    "Roof": (1.0, 1.0, 1.0),
}
TEXTURE = "roof tiles.png"


def write_texture(path: Path) -> None:
    """A made-up 32-pixel texture: red tiles with dark lines."""
    from PIL import Image

    picture = Image.new("RGB", (32, 32), (170, 70, 50))
    for i in range(32):
        for j in (0, 16):
            picture.putpixel((i, j), (90, 40, 30))
            picture.putpixel((j, i), (90, 40, 30))
    picture.save(path)


def write_obj(folder: Path, name: str = "house") -> Path:
    """The house as OBJ, Y up (x, z up, -y north), with its materials file and texture."""
    folder.mkdir(parents=True, exist_ok=True)
    lines = [f"# a made-up house\nmtllib {name}.mtl\no House\n", "vt 0 0\nvt 4 0\nvt 4 4\nvt 0 4\n"]
    faces: dict[str, list[str]] = {}
    count = 0
    for corners, material in house():
        for x, y, z in corners:
            lines.append(f"v {x:g} {z:g} {-y:g}\n")
        faces.setdefault(material, []).append(f"f {count + 1}/1 {count + 2}/2 {count + 3}/3 {count + 4}/4\n")
        count += 4
    for material, face_lines in faces.items():
        lines.append(f"usemtl {material}\n")
        lines += face_lines
    path = folder / f"{name}.obj"
    path.write_text("".join(lines), encoding="utf-8")
    mtl = []
    for material, (r, g, b) in MATERIALS.items():
        mtl.append(f"newmtl {material}\nKd {r} {g} {b}\n")
        if material == "Roof":
            mtl.append(f"map_Kd {TEXTURE}\n")
    (folder / f"{name}.mtl").write_text("".join(mtl), encoding="utf-8")
    write_texture(folder / TEXTURE)
    return path


def write_stl(path: Path) -> Path:
    """The house as binary STL, Z up, in millimetres."""
    triangles = []
    for corners, _ in house():
        a, b, c, d = corners
        triangles += [(a, b, c), (a, c, d)]
    data = bytearray(b"made-up house".ljust(80, b" "))
    data += struct.pack("<I", len(triangles))
    for triangle in triangles:
        data += struct.pack("<3f", 0, 0, 0)
        for x, y, z in triangle:
            data += struct.pack("<3f", x * 1000, y * 1000, z * 1000)
        data += b"\0\0"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(data))
    return path


if __name__ == "__main__":
    out = Path(sys.argv[1])
    write_obj(out)
    write_stl(out / "house.stl")
    print(out)
