"""Drawing an area's floors: one picture per floor, at a fixed scale, in Atlas's own colours.

- The floor's walkable surface is filled and shaded by height (dark teal low, light teal high, over the whole
  area's height range) with a little light from the north-west, so slopes and stairs read.
- The floors below show through faintly (`lowerFloorOpacity`); floors above are left out.
- Walls (wall triangles cut at chest height, see floors.py) are dark lines, and the floor's outer edge a darker
  rim.

Seen from above: right is +x and up is +z, so a world point (x, z) is at pixel ((x - xMin) * s, (zMax - z) * s)
for `s` pixels per metre, and the map's `worldTransform` is the inverse (pixel to world x, z).
"""

from __future__ import annotations

import io
import math
import typing as tp
from dataclasses import dataclass

import numpy as np

BACKGROUND = (22, 26, 32)
WALL = (6, 8, 11)
RIM = (12, 15, 20)
# Height ramp: Atlas's dark surface teal to its accent.
RAMP = (
    (0.0, (46, 72, 86)),
    (0.45, (60, 118, 124)),
    (0.8, (104, 178, 164)),
    (1.0, (172, 224, 210)),
)
LIGHT = np.array([-0.45, 0.8, 0.4])  # from the north-west (-x, +z) and above
MARKER_COLOURS = {
    "bonfire": (255, 154, 60),
    "boss": (255, 123, 114),
    "npc": (143, 184, 255),
    "drop": (199, 146, 234),
    "consumable": (138, 145, 156),
    "souls": (201, 179, 126),
}
ITEM_COLOUR = (230, 180, 80)


@dataclass(frozen=True)
class Frame:
    x_min: float
    z_max: float
    scale: float  # pixels per metre
    width: int
    height: int
    cropped: bool = False

    def to_pixels(self, xz: np.ndarray) -> np.ndarray:
        xz = np.asarray(xz, dtype=np.float64).reshape(-1, 2)
        return np.stack([(xz[:, 0] - self.x_min) * self.scale, (self.z_max - xz[:, 1]) * self.scale], axis=1)

    def world_transform(self) -> dict[str, float]:
        """Pixel to world (x, z), in the canvas matrix order Atlas uses."""
        return {"a": 1 / self.scale, "b": 0.0, "c": 0.0, "d": -1 / self.scale, "e": self.x_min, "f": self.z_max}

    def to_report(self) -> dict[str, tp.Any]:
        return {
            "width": self.width,
            "height": self.height,
            "pixelsPerMetre": round(self.scale, 4),
            "xMin": round(self.x_min, 2),
            "zMax": round(self.z_max, 2),
            "cropped": self.cropped,
            "orientation": "right is +x, up is +z; pixel = ((x - xMin) * s, (zMax - z) * s)",
        }


def make_frame(geometry_xz: np.ndarray, marker_xz: np.ndarray, settings: dict[str, tp.Any]) -> Frame:
    """The picture's frame: every walkable surface and marker plus a margin, at `pixelsPerMetre`; a larger area is
    drawn at a smaller scale (down to `minPixelsPerMetre`), and one still too large is cropped to where most of
    its floor is."""
    margin = float(settings.get("marginMetres", 12))
    wanted = float(settings.get("pixelsPerMetre", 8))
    least = float(settings.get("minPixelsPerMetre", 2))
    largest = int(settings.get("maxImageSize", 6144))
    points = np.concatenate([np.asarray(geometry_xz, dtype=np.float64).reshape(-1, 2), np.asarray(marker_xz, dtype=np.float64).reshape(-1, 2)])
    if len(points) == 0:
        points = np.zeros((1, 2))
    low, high = points.min(axis=0) - margin, points.max(axis=0) + margin
    cropped = False
    extent = float(max(high[0] - low[0], high[1] - low[1], 1.0))
    scale = min(wanted, largest / extent)
    if scale < least:
        geometry = np.asarray(geometry_xz, dtype=np.float64).reshape(-1, 2)
        if len(geometry):
            low = np.percentile(geometry, 1, axis=0) - margin
            high = np.percentile(geometry, 99, axis=0) + margin
        extent = float(max(high[0] - low[0], high[1] - low[1], 1.0))
        scale = max(least, min(wanted, largest / extent))
        if extent * scale > largest:
            centre = (low + high) / 2
            half = largest / scale / 2
            low, high = centre - half, centre + half
        cropped = True
    width = max(1, min(largest, int(math.ceil((high[0] - low[0]) * scale))))
    height = max(1, min(largest, int(math.ceil((high[1] - low[1]) * scale))))
    return Frame(float(low[0]), float(high[1]), float(scale), width, height, cropped)


def ramp_colours(t: np.ndarray) -> np.ndarray:
    stops = np.array([s for s, _ in RAMP])
    colours = np.array([c for _, c in RAMP], dtype=np.float64)
    t = np.clip(t, 0.0, 1.0)
    return np.stack([np.interp(t, stops, colours[:, channel]) for channel in range(3)], axis=1)


def triangle_colours(triangles: np.ndarray, low: float, high: float, flipped: bool) -> np.ndarray:
    a, b, c = (triangles[:, i].astype(np.float64) for i in range(3))
    normal = np.cross(b - a, c - a)
    length = np.linalg.norm(normal, axis=1, keepdims=True)
    normal = np.divide(normal, length, out=np.zeros_like(normal), where=length > 1e-12)
    if flipped:
        normal = -normal
    light = LIGHT / np.linalg.norm(LIGHT)
    shade = 0.78 + 0.32 * np.clip(normal @ light, 0.0, 1.0)
    heights = triangles[:, :, 1].mean(axis=1)
    t = (heights - low) / (high - low) if high > low else np.full(len(heights), 0.5)
    return np.clip(ramp_colours(t) * shade[:, None], 0, 255).astype(np.uint8)


def draw_layer(
    frame: Frame,
    triangles: np.ndarray,
    colours: np.ndarray,
    walls: np.ndarray,
) -> tp.Any:
    """One floor alone, on a transparent picture: its triangles (lowest first, so higher ones are drawn over
    them), its rim and its walls."""
    from PIL import Image, ImageChops, ImageDraw, ImageFilter

    layer = Image.new("RGBA", (frame.width, frame.height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    if len(triangles):
        order = np.argsort(triangles[:, :, 1].mean(axis=1), kind="stable")
        pixels = frame.to_pixels(triangles[order][:, :, [0, 2]].reshape(-1, 2)).reshape(-1, 3, 2)
        fills = colours[order]
        for corners, fill in zip(pixels.round(2).tolist(), fills.tolist()):
            draw.polygon([tuple(p) for p in corners], fill=(fill[0], fill[1], fill[2], 255))
        alpha = layer.getchannel("A")
        rim = ImageChops.subtract(alpha, alpha.filter(ImageFilter.MinFilter(3)))
        layer.paste(Image.new("RGBA", layer.size, RIM + (255,)), (0, 0), rim)
    if len(walls):
        width = max(1, int(round(0.22 * frame.scale)))
        ends = frame.to_pixels(walls.reshape(-1, 2)).reshape(-1, 2, 2).round(2).tolist()
        for (x0, y0), (x1, y1) in ends:
            draw.line([(x0, y0), (x1, y1)], fill=WALL + (255,), width=width)
    return layer


def compose(frame: Frame, layers: tp.Iterable[tuple[int, tp.Any]], opacity: float) -> tp.Iterator[tuple[int, tp.Any]]:
    """Each floor (lowest first) over the background and the floors below it, faded. Yields (floor, RGB picture);
    each layer is let go once it is folded into what lies below the next floor."""
    from PIL import Image

    under = Image.new("RGB", (frame.width, frame.height), BACKGROUND)
    for index, layer in layers:
        picture = under.copy()
        picture.paste(layer, (0, 0), layer)
        yield index, picture
        faded = layer.getchannel("A").point(lambda a: int(a * opacity))
        under.paste(layer.convert("RGB"), (0, 0), faded)
        del layer, picture


def preview_png(picture: tp.Any, frame: Frame, markers: list[tuple[float, float, str]], size: int = 640) -> bytes:
    """A small PNG of a floor's picture with a dot per marker on that floor ((pixel x, pixel y, category))."""
    from PIL import ImageDraw

    small = picture.copy()
    small.thumbnail((size, size))
    factor = small.width / max(picture.width, 1)
    draw = ImageDraw.Draw(small)
    for x, y, category in markers:
        colour = MARKER_COLOURS.get(category, ITEM_COLOUR)
        r = 4 if category in ("bonfire", "boss") else 2
        cx, cy = x * factor, y * factor
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=colour, outline=(0, 0, 0))
    buffer = io.BytesIO()
    small.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()
