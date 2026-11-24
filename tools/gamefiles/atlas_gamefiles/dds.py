"""Reading a texture's picture: a DDS file (as Dark Souls Remastered keeps its textures in TPF files) to an RGBA
picture, its largest level only.

Pillow (already a dependency, HPND licence) decodes the block-compressed formats: BC1 to BC7 (DXT1, DXT3, DXT5,
ATI1/BC4, ATI2/BC5, BC6H, BC7), with the old four-character codes or a DX10 header, and plain RGB(A) pixels with
masks. This module only smooths what Pillow does not take as it is:

- DX10 formats that hold the same bytes as one Pillow reads (the `_SRGB` and `_TYPELESS` variants of BC1 to BC3,
  BC4's signed form read as unsigned is not: it is refused) are read as that one;
- 8-bit BGRA and BGRX pixels (DX10 87, 88, 90 to 93) are read here.

A cube map or an array gives its first picture. Colour values are returned as stored (sRGB for colour textures):
the picture is meant to be written again as PNG, not lit.

Console textures (Bloodborne's PS4 TPF files hold no DDS header, and their blocks are swizzled) are put in order
and given a header first (see `console_dds`). PS4 ones are put in order here (`ps4_deswizzle`), with numpy: the
PS4 keeps a texture's elements (4 x 4 pixel blocks, or pixels for plain formats) in tiles of 8 x 8 elements, each
tile in Morton order (the bits of an element's column and row taken in turn), the tiles row by row. Soulstruct 2.6's
own way does the same one element at a time in Python (seconds for a large texture), and moves 8 bytes at a time
for every block format, which mixes up the halves of the 16-byte blocks of BC2, BC3, BC5, BC6H and BC7. Other
consoles' textures are left to Soulstruct.
"""

from __future__ import annotations

import io
import struct
import typing as tp

import numpy as np

DDS_MAGIC = b"DDS "
HEADER_SIZE = 124
DX10 = b"DX10"

# DX10 formats Pillow reads, by the formats that hold the same bytes.
SAME_BYTES = {
    70: 71,  # BC1_TYPELESS -> BC1_UNORM
    72: 71,  # BC1_UNORM_SRGB
    73: 74,  # BC2_TYPELESS -> BC2_UNORM
    75: 74,  # BC2_UNORM_SRGB
    76: 77,  # BC3_TYPELESS -> BC3_UNORM
    78: 77,  # BC3_UNORM_SRGB
    79: 80,  # BC4_TYPELESS -> BC4_UNORM
    82: 83,  # BC5_TYPELESS -> BC5_UNORM
    94: 95,  # BC6H_TYPELESS -> BC6H_UF16
}
# Plain 8-bit pixels in blue, green, red order: DX10 format -> has alpha.
BGRA_FORMATS = {87: True, 88: False, 90: True, 91: True, 92: False, 93: False}
DXGI_NAMES = {
    2: "R32G32B32A32_FLOAT",
    10: "R16G16B16A16_FLOAT",
    11: "R16G16B16A16_UNORM",
    27: "R8G8B8A8_TYPELESS",
    28: "R8G8B8A8_UNORM",
    29: "R8G8B8A8_UNORM_SRGB",
    61: "R8_UNORM",
    65: "A8_UNORM",
    70: "BC1_TYPELESS",
    71: "BC1_UNORM",
    72: "BC1_UNORM_SRGB",
    73: "BC2_TYPELESS",
    74: "BC2_UNORM",
    75: "BC2_UNORM_SRGB",
    76: "BC3_TYPELESS",
    77: "BC3_UNORM",
    78: "BC3_UNORM_SRGB",
    79: "BC4_TYPELESS",
    80: "BC4_UNORM",
    81: "BC4_SNORM",
    82: "BC5_TYPELESS",
    83: "BC5_UNORM",
    84: "BC5_SNORM",
    87: "B8G8R8A8_UNORM",
    88: "B8G8R8X8_UNORM",
    90: "B8G8R8A8_TYPELESS",
    91: "B8G8R8A8_UNORM_SRGB",
    92: "B8G8R8X8_TYPELESS",
    93: "B8G8R8X8_UNORM_SRGB",
    94: "BC6H_TYPELESS",
    95: "BC6H_UF16",
    96: "BC6H_SF16",
    97: "BC7_TYPELESS",
    98: "BC7_UNORM",
    99: "BC7_UNORM_SRGB",
}


# Bytes of one 4 x 4 block of the block-compressed DXGI formats.
BLOCK_BYTES = {**{f: 8 for f in (70, 71, 72, 79, 80, 81)}, **{f: 16 for f in (73, 74, 75, 76, 77, 78, 82, 83, 84, 94, 95, 96, 97, 98, 99)}}
# DXGI formats written with the old four-character codes (as Soulstruct wrote them), so the report reads the same.
FOURCC = {71: b"DXT1", 74: b"DXT3", 77: b"DXT5"}
PS4_TILE = 8  # elements a side of a PS4 tile


class TextureError(Exception):
    """The texture cannot be read; the message says why."""


def describe(data: bytes) -> str:
    """The texture's format, for the report: the four-character code, or `DX10 <format>`, or `RGB 32-bit`."""
    if len(data) < 4 + HEADER_SIZE or data[:4] != DDS_MAGIC:
        return "not a DDS file"
    flags, fourcc, bits = struct.unpack_from("<I4sI", data, 80)
    if fourcc == DX10 and len(data) >= 4 + HEADER_SIZE + 20:
        (dxgi,) = struct.unpack_from("<I", data, 128)
        return f"DX10 {DXGI_NAMES.get(dxgi, str(dxgi))}"
    if flags & 0x4:
        return fourcc.decode("ascii", "replace").strip("\0") or f"code {fourcc.hex()}"
    return f"RGB {bits}-bit"


def size_of(data: bytes) -> tuple[int, int]:
    """The width and height in a DDS header."""
    if len(data) < 4 + HEADER_SIZE or data[:4] != DDS_MAGIC:
        raise TextureError("not a DDS file")
    height, width = struct.unpack_from("<II", data, 12)
    return int(width), int(height)


def decode(data: bytes) -> tp.Any:
    """The DDS file's largest picture as an RGBA Pillow image. TextureError when it cannot be read."""
    from PIL import Image

    width, height = size_of(data)
    if width <= 0 or height <= 0 or width > 16384 or height > 16384:
        raise TextureError(f"it says it is {width} x {height} pixels")
    flags, fourcc = struct.unpack_from("<I4s", data, 80)
    if flags & 0x4 and fourcc == DX10:
        if len(data) < 4 + HEADER_SIZE + 20:
            raise TextureError("its DX10 header is cut short")
        (dxgi,) = struct.unpack_from("<I", data, 128)
        if dxgi in BGRA_FORMATS:
            return _bgra(data, width, height, BGRA_FORMATS[dxgi])
        if dxgi in SAME_BYTES:
            data = data[:128] + struct.pack("<I", SAME_BYTES[dxgi]) + data[132:]
    try:
        with Image.open(io.BytesIO(data), formats=["DDS"]) as image:
            image.load()
            picture = image.convert("RGBA")
    except (OSError, NotImplementedError, ValueError, SyntaxError) as error:
        raise TextureError(f"{describe(data)}: {error}") from None
    if picture.size != (width, height):
        raise TextureError(f"it read as {picture.size[0]} x {picture.size[1]} pixels, not {width} x {height}")
    return picture


def _bgra(data: bytes, width: int, height: int, alpha: bool) -> tp.Any:
    from PIL import Image

    start = 4 + HEADER_SIZE + 20
    count = width * height * 4
    if len(data) < start + count:
        raise TextureError("its pixels are cut short")
    pixels = np.frombuffer(data, dtype=np.uint8, count=count, offset=start).reshape(height, width, 4)
    rgba = pixels[..., [2, 1, 0, 3]].copy()
    if not alpha:
        rgba[..., 3] = 255
    return Image.fromarray(rgba, "RGBA")


def _morton_tile() -> tuple[np.ndarray, np.ndarray]:
    """The row and column in a PS4 tile of its elements 0 to 63, as stored: the bits of the column and the row in
    turn, the column's first."""
    rows = np.zeros(PS4_TILE * PS4_TILE, dtype=np.int64)
    cols = np.zeros(PS4_TILE * PS4_TILE, dtype=np.int64)
    for k in range(PS4_TILE * PS4_TILE):
        for bit in range(3):
            cols[k] |= ((k >> (2 * bit)) & 1) << bit
            rows[k] |= ((k >> (2 * bit + 1)) & 1) << bit
    return rows, cols


TILE_ROWS, TILE_COLS = _morton_tile()


def element_of(dxgi: int) -> tuple[int, int]:
    """The pixels a side of one element of a DXGI format (4 for blocks, 1 for plain pixels) and its bytes."""
    if dxgi in BLOCK_BYTES:
        return 4, BLOCK_BYTES[dxgi]
    try:
        from soulstruct.base.textures.dds.enums import DXGI_FORMAT_BPP, DXGI_FORMAT

        bits = int(DXGI_FORMAT_BPP.get(DXGI_FORMAT(dxgi), 0))
    except (ImportError, ValueError):
        bits = 0
    if bits <= 0 or bits % 8:
        raise TextureError(f"its format ({DXGI_NAMES.get(dxgi, dxgi)}) is not read")
    return 1, bits // 8


def ps4_deswizzle(data: bytes, width: int, height: int, dxgi: int) -> bytes:
    """The largest picture of a PS4 texture's data, its elements put in row order (see the top of this module)."""
    side, size = element_of(dxgi)
    cols = max(1, -(-width // side))
    rows = max(1, -(-height // side))
    tiles_x = -(-cols // PS4_TILE)
    tiles_y = -(-rows // PS4_TILE)
    need = tiles_x * tiles_y * PS4_TILE * PS4_TILE * size
    if len(data) < size:
        raise TextureError("it holds no pixels")
    raw = np.frombuffer(data, dtype=np.uint8, count=min(len(data), need))
    if len(raw) < need:  # a texture smaller than a tile may be stored without the tile's padding
        raw = np.concatenate([raw, np.zeros(need - len(raw), dtype=np.uint8)])
    tiles = raw.reshape(tiles_y, tiles_x, PS4_TILE * PS4_TILE, size)
    out = np.zeros((tiles_y, PS4_TILE, tiles_x, PS4_TILE, size), dtype=np.uint8)
    out[:, TILE_ROWS, :, TILE_COLS, :] = tiles.transpose(2, 0, 1, 3)
    return out.reshape(tiles_y * PS4_TILE, tiles_x * PS4_TILE, size)[:rows, :cols].tobytes()


def dds_file(width: int, height: int, dxgi: int, data: bytes) -> bytes:
    """A DDS file of one picture: the old four-character code for BC1 to BC3, else a DX10 header."""
    side, size = element_of(dxgi)
    pitch = max(1, -(-width // side)) * size
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | (0x80000 if side == 4 else 0x8)
    fourcc = FOURCC.get(dxgi, DX10)
    header = struct.pack(
        "<4sIIIIIII44sII4sIIIIIIIIII",
        DDS_MAGIC, HEADER_SIZE, flags, height, width, pitch, 0, 1, b"\0" * 44,
        32, 0x4, fourcc, 0, 0, 0, 0, 0,
        0x1000, 0, 0, 0, 0,
    )
    if fourcc == DX10:
        header += struct.pack("<IIIII", dxgi, 3, 0, 1, 0)
    return header + data


def console_dds(texture: tp.Any, platform: tp.Any) -> bytes:
    """A console texture of a TPF file (Soulstruct's `TPFTexture`, no DDS header, swizzled) as a DDS file of its
    largest picture: PS4 ones (Bloodborne) put in order here, by the DXGI format the file gives (or the one its TPF
    format number stands for); others by Soulstruct's own header maker and deswizzler."""
    from soulstruct.containers.tpf import TPF_TEXTURE_FORMAT_TO_DXGI_FORMAT, TPFPlatform

    if platform != TPFPlatform.PS4:
        return bytes(texture.get_headerized_dds(platform).to_bytes())
    info = texture.console_info
    if info is None:
        raise TextureError("it gives no size")
    dxgi = int(info.dxgi_format or 0) or int(TPF_TEXTURE_FORMAT_TO_DXGI_FORMAT.get(int(texture.format), 0))
    if not dxgi:
        raise TextureError(f"its format ({texture.format}) is not known")
    width, height = int(info.width), int(info.height)
    if width <= 0 or height <= 0 or width > 16384 or height > 16384:
        raise TextureError(f"it says it is {width} x {height} pixels")
    return dds_file(width, height, dxgi, ps4_deswizzle(bytes(texture.data), width, height, dxgi))
