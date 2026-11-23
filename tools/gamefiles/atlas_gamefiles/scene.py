"""3D maps: each area's collision as a 3D model, made with the Atlas scene builder.

The builder (`atlas-scene`, built from `crates/atlas-scene` in this repository, MIT) is a separate program that comes
with the Map Maker, next to this helper. For each area this module:

1. writes the collision triangles as a raw glTF binary file (`raw_glb`) in the report folder: one node per collision
   part (named after it, so the config's `scene.drop` patterns can leave parts out), positions in the game's own
   coordinates (x, height y, z), each corner coloured as the flat map colours its floor: by height on the same ramp,
   darker on steep slopes and walls, with one material seen from both sides. The triangles are turned so that floors
   face up;
2. runs `atlas-scene build` on it: the model is lined up with the map (world x is the game's x, world y its z, height
   its y, as the map's `worldTransform` reads them), cut into square cells with simpler levels of detail and
   compressed, into the pack's `scene/<area>/` folder, and checked;
3. returns the scene for the map's entry in `maps.json`, with the builder's report.

Nothing here reads game files; the triangles come from the file reader like those of the flat map. The raw file is
deleted once the builder is done.
"""

from __future__ import annotations

import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time
import typing as tp
from pathlib import Path

import numpy as np

from .geometry import Cancelled
from .render import RAMP

BUILDER = "atlas-scene"
BUILDER_ENV = "ATLAS_SCENE_BUILDER"
CREATE_NO_WINDOW = 0x08000000
TIME_LIMIT = 600.0  # seconds one area's model may take in the builder
# Shade per slope, as on the flat map: walkable ground as it is, steeper slopes darker, walls darkest.
SLOPE_SHADE = ((50.0, 1.0), (70.0, 0.78), (90.0, 0.55))


def builder_name() -> str:
    return BUILDER + (".exe" if sys.platform == "win32" else "")


def find_builder(explicit: Path | None = None) -> Path | None:
    """The builder: the one named on the command line (the app names it), else `ATLAS_SCENE_BUILDER`, else the one
    next to this helper's program (where the installer puts both)."""
    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(Path(explicit))
    if os.environ.get(BUILDER_ENV):
        candidates.append(Path(os.environ[BUILDER_ENV]))
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / builder_name())
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def srgb_to_linear(value: np.ndarray) -> np.ndarray:
    v = np.clip(value, 0.0, 1.0)
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def corner_colours(triangles: np.ndarray, low: float, high: float, flipped: bool) -> np.ndarray:
    """Linear RGB per corner, (n, 3, 3): the flat map's height ramp at each corner's height, times the shade of the
    triangle's slope. Corners at one place on one kind of slope get one colour, so the builder can join them."""
    t = (triangles[:, :, 1].astype(np.float64) - low) / (high - low) if high > low else np.full(triangles.shape[:2], 0.5)
    t = np.clip(t, 0.0, 1.0)
    stops = np.array([s for s, _ in RAMP])
    colours = np.array([c for _, c in RAMP], dtype=np.float64) / 255.0
    ramp = np.stack([np.interp(t, stops, colours[:, k]) for k in range(3)], axis=-1)
    a, b, c = (triangles[:, i].astype(np.float64) for i in range(3))
    normal = np.cross(b - a, c - a)
    length = np.linalg.norm(normal, axis=1)
    up = np.divide(normal[:, 1], length, out=np.zeros_like(length), where=length > 1e-12)
    if flipped:
        up = -up
    slope = np.degrees(np.arccos(np.clip(np.abs(up), 0.0, 1.0)))
    shade = np.full(len(triangles), SLOPE_SHADE[-1][1])
    for limit, value in reversed(SLOPE_SHADE):
        shade[slope <= limit] = value
    return srgb_to_linear(ramp * shade[:, None, None]).astype(np.float32)


def raw_glb(triangles: np.ndarray, colours: np.ndarray, owners: np.ndarray, owner_names: list[str], flipped: bool) -> bytes:
    """A glTF binary file of the triangles ((n, 3, 3) in the game's x, y, z) with a colour per corner, one node and
    mesh per owner (collision part). Triangles are turned so that floors face +y (counter-clockwise from above)."""
    tris = np.ascontiguousarray(triangles, dtype=np.float32)
    cols = np.ascontiguousarray(colours, dtype=np.float32)
    if flipped:
        tris = tris[:, [0, 2, 1]]
        cols = cols[:, [0, 2, 1]]
    if len(owners) != len(tris):
        owners = np.zeros(len(tris), dtype=np.int32)
        owner_names = ["area"]
    order = np.argsort(owners, kind="stable")
    tris, cols, owners = tris[order], cols[order], np.asarray(owners)[order]
    bounds = np.flatnonzero(np.diff(owners)) + 1
    starts = [0, *bounds.tolist()]
    ends = [*bounds.tolist(), len(owners)]
    binary = bytearray()
    views, accessors, meshes, nodes = [], [], [], []
    for start, end in zip(starts, ends):
        if end <= start:
            continue
        count = (end - start) * 3
        positions = tris[start:end].reshape(-1, 3)
        for data, kind in ((positions, "POSITION"), (cols[start:end].reshape(-1, 3), "COLOR_0")):
            views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": data.nbytes})
            binary += data.tobytes()
            accessor = {"bufferView": len(views) - 1, "componentType": 5126, "count": count, "type": "VEC3"}
            if kind == "POSITION":
                accessor["min"] = positions.min(axis=0).tolist()
                accessor["max"] = positions.max(axis=0).tolist()
            accessors.append(accessor)
        index = int(owners[start])
        name = owner_names[index] if 0 <= index < len(owner_names) else f"part {index}"
        meshes.append(
            {
                "name": name,
                "primitives": [{"attributes": {"POSITION": len(accessors) - 2, "COLOR_0": len(accessors) - 1}, "material": 0}],
            }
        )
        nodes.append({"name": name, "mesh": len(meshes) - 1})
    document = {
        "asset": {"version": "2.0", "generator": "Atlas Map Maker"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        # Collision is seen from both sides: its walls face either way, and the 3D view draws each
        # surface on the sides its material says.
        "materials": [{"name": "collision", "doubleSided": True, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    text = json.dumps(document, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<I4s", len(text), b"JSON")
        + text
        + struct.pack("<I4s", len(binary), b"BIN\0")
        + bytes(binary)
    )


def floor_heights(cuts: list[float], floors: int, low: float, high: float) -> list[list[float]] | None:
    """Each floor's `[min, max]` for its layer: from the cut below it (or the lowest ground) to the cut above it (or
    the highest point). None when the area has fewer than two floors: a map without storeys has none."""
    if floors < 2 or len(cuts) != floors - 1:
        return None
    edges = [float(np.floor(low)), *[round(float(c), 2) for c in sorted(cuts)], float(np.ceil(high))]
    out = []
    for i in range(floors):
        bottom, top = edges[i], edges[i + 1]
        out.append([min(bottom, top), max(bottom, top)])
    return out


class BuilderFailed(Exception):
    """The builder could not make the model; the message says why."""


def run_builder(
    builder: Path,
    job: dict[str, tp.Any],
    work: Path,
    name: str,
    progress: tp.Callable[[float, str], None],
    stop: tp.Callable[[], None],
    time_limit: float = TIME_LIMIT,
) -> dict[str, tp.Any]:
    """Runs `atlas-scene build` on a job written into `work`; returns its `done` line. Calls `progress` with its
    progress lines and `stop` often (it may raise `Cancelled`, which ends the builder at once)."""
    job_file = work / f"{name}.job.json"
    job_file.write_text(json.dumps(job), encoding="utf-8")
    process = subprocess.Popen(
        [str(builder), "build", str(job_file)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=work,
        creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    lines: queue.Queue[bytes | None] = queue.Queue()

    def listen() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    errors: list[bytes] = []

    def drain() -> None:
        assert process.stderr is not None
        errors.append(process.stderr.read()[-4000:])

    threading.Thread(target=listen, name="scene-builder", daemon=True).start()
    threading.Thread(target=drain, name="scene-builder-errors", daemon=True).start()
    started = time.monotonic()
    done: dict[str, tp.Any] | None = None
    failure: str | None = None
    try:
        while True:
            stop()
            if time_limit > 0 and time.monotonic() - started > time_limit:
                raise BuilderFailed(f"it was stopped after {time_limit:g} s")
            try:
                raw = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if raw is None:
                break
            try:
                message = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            event = message.get("event")
            if event == "progress":
                progress(float(message.get("fraction", 0.0)), str(message.get("message", "")))
            elif event == "done":
                done = message
            elif event == "error":
                failure = str(message.get("message", "it failed"))
    except (Cancelled, BuilderFailed):
        if process.poll() is None:
            process.kill()
        process.wait()
        raise
    code = process.wait()
    if done is not None and code == 0:
        return done
    if failure:
        raise BuilderFailed(failure)
    tail = b"".join(errors).decode("utf-8", "replace").strip().splitlines()[-3:]
    raise BuilderFailed(f"it ended with code {code}" + (f": {' / '.join(tail)}" if tail else ""))


def check_pack(builder: Path, folder: Path, time_limit: float = 300.0) -> dict[str, tp.Any]:
    """`atlas-scene check` on a pack folder: the 3D side of it, as the pack file format sets it."""
    try:
        result = subprocess.run(
            [str(builder), "check", str(folder)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=time_limit,
            creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"problems": [f"the check could not run ({type(error).__name__})"]}
    for raw in result.stdout.decode("utf-8", "replace").splitlines():
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if message.get("event") == "checked":
            message.pop("event", None)
            return message
    return {"problems": [f"the check ended with code {result.returncode} and said nothing"]}
