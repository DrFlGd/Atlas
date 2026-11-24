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

Console textures (Bloodborne's PS4 TPF files hold no DDS header and swizzled blocks) are given a header and put in
order by Soulstruct first (see `console_dds`).
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


def console_dds(texture: tp.Any, platform: tp.Any) -> bytes:
    """A console texture of a TPF file (Soulstruct's `TPFTexture`, no DDS header, swizzled) as a DDS file, by
    Soulstruct's own header maker and deswizzler (PS4: Bloodborne)."""
    dds = texture.get_headerized_dds(platform)
    return bytes(dds.to_bytes())
