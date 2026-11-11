"""Which game a folder holds, and which version, judged from its data files.

Supported: Dark Souls Remastered (a Steam install folder, unpacked by default) and Bloodborne (a PS4 dump folder:
`eboot.bin`, `sce_sys/` and `dvdroot_ps4/`, with the game data under `dvdroot_ps4`). Prepare to Die Edition is
recognised but not supported. Anything else is "unknown", with the reason.

Only file names and a few small headers are read here; nothing is written.
"""

from __future__ import annotations

import re
import struct
import typing as tp
from dataclasses import dataclass, field
from pathlib import Path

DSR = "dark-souls-remastered"
BLOODBORNE = "bloodborne"
PTDE = "dark-souls-ptde"
UNKNOWN = "unknown"

TITLES = {
    DSR: "Dark Souls Remastered",
    BLOODBORNE: "Bloodborne",
    PTDE: "Dark Souls: Prepare to Die Edition",
    UNKNOWN: "Unknown",
}

DSR_STEAM_APP_ID = 570940


@dataclass
class Detection:
    game: str
    root: Path | None = None  # the folder that holds `map/`, `param/` and `msg/`
    version: str | None = None
    supported: bool = False
    evidence: list[str] = field(default_factory=list)
    reason: str | None = None
    picked: Path | None = None  # the folder the player chose
    details: dict[str, tp.Any] = field(default_factory=dict)

    @property
    def title(self) -> str:
        return TITLES[self.game]


def child(folder: Path, name: str) -> Path | None:
    """The entry of `folder` named `name`, ignoring case (dumps and installs differ in case)."""
    direct = folder / name
    if direct.exists():
        return direct
    lower = name.lower()
    try:
        for entry in folder.iterdir():
            if entry.name.lower() == lower:
                return entry
    except OSError:
        return None
    return None


def descend(folder: Path, *names: str) -> Path | None:
    current: Path | None = folder
    for name in names:
        if current is None:
            return None
        current = child(current, name)
    return current


def files_matching(folder: Path | None, pattern: str) -> list[Path]:
    """Files in `folder` whose names match the regular expression `pattern`, ignoring case, sorted by name."""
    if folder is None or not folder.is_dir():
        return []
    regex = re.compile(pattern, re.IGNORECASE)
    try:
        return sorted((p for p in folder.iterdir() if p.is_file() and regex.fullmatch(p.name)), key=lambda p: p.name)
    except OSError:
        return []


MSB_DSR = r"m\d\d_\d\d_\d\d_\d\d\.msb"
MSB_BB = r"m\d\d_\d\d_\d\d_\d\d\.msb\.dcx"


def map_studio(root: Path) -> Path | None:
    return descend(root, "map", "MapStudio")


def pe_file_version(exe: Path) -> str | None:
    """The file version in a Windows executable's version resource (VS_FIXEDFILEINFO), or None."""
    signature = b"\xbd\x04\xef\xfe"
    try:
        with exe.open("rb") as stream:
            tail = b""
            while True:
                chunk = stream.read(4 << 20)
                if not chunk:
                    return None
                data = tail + chunk
                index = data.find(signature)
                if index >= 0 and index + 20 <= len(data):
                    ms, ls = struct.unpack_from("<II", data, index + 8)
                    return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"
                tail = data[-32:]
    except OSError:
        return None


def steam_build_id(install: Path, app_id: int) -> str | None:
    """The Steam build id from `steamapps/appmanifest_<id>.acf`, two folders above `steamapps/common/<game>`."""
    try:
        manifest = install.parent.parent / f"appmanifest_{app_id}.acf"
        if not manifest.is_file():
            return None
        match = re.search(r'"buildid"\s+"(\d+)"', manifest.read_text(encoding="utf-8", errors="replace"))
        return match.group(1) if match else None
    except OSError:
        return None


def read_param_sfo(path: Path) -> dict[str, str | int]:
    """The entries of a PS4 `param.sfo` (TITLE_ID, APP_VER, VERSION, TITLE, ...)."""
    return read_param_sfo_bytes(path.read_bytes())


def read_param_sfo_bytes(data: bytes) -> dict[str, str | int]:
    if len(data) < 20 or data[:4] != b"\x00PSF":
        raise ValueError("not a param.sfo file")
    key_table, data_table, count = struct.unpack_from("<III", data, 8)
    entries: dict[str, str | int] = {}
    for i in range(count):
        key_offset, fmt, length, _max_length, data_offset = struct.unpack_from("<HHIII", data, 20 + i * 16)
        key_start = key_table + key_offset
        key_end = data.index(b"\x00", key_start)
        key = data[key_start:key_end].decode("ascii", errors="replace")
        start = data_table + data_offset
        if fmt == 0x0404:
            entries[key] = struct.unpack_from("<I", data, start)[0]
        else:
            entries[key] = data[start:start + length].split(b"\x00")[0].decode("utf-8", errors="replace")
    return entries


def _detect_dsr(folder: Path) -> Detection | None:
    exe = child(folder, "DarkSoulsRemastered.exe")
    studio = map_studio(folder)
    msbs = files_matching(studio, MSB_DSR)
    if exe is None and not msbs:
        return None
    if exe is not None and not msbs and child(folder, "DARKSOULS.exe") is None:
        return Detection(
            DSR,
            root=folder,
            evidence=["DarkSoulsRemastered.exe"],
            reason="DarkSoulsRemastered.exe is here, but map/MapStudio has no .msb map files. "
            "The install may be incomplete: in Steam, use Properties, Installed Files, Verify integrity.",
        )
    if exe is None:
        # Map files alone: tell Remastered (DCX-compressed params) from Prepare to Die (plain params).
        if descend(folder, "param", "GameParam", "GameParam.parambnd.dcx") is None:
            return None
    detection = Detection(DSR, root=folder, supported=True)
    if exe is not None:
        detection.evidence.append("DarkSoulsRemastered.exe")
        version = pe_file_version(exe)
        if version:
            detection.version = version
            detection.evidence.append(f"executable file version {version}")
    detection.evidence.append(f"{len(msbs)} map files in map/MapStudio")
    build = steam_build_id(folder, DSR_STEAM_APP_ID)
    if build:
        detection.details["steamBuildId"] = build
        detection.evidence.append(f"Steam build {build}")
    for name, parts in (
        ("params", ("param", "GameParam", "GameParam.parambnd.dcx")),
        ("item text", ("msg", "ENGLISH", "item.msgbnd.dcx")),
    ):
        if descend(folder, *parts) is not None:
            detection.evidence.append(f"{name}: {'/'.join(parts)}")
    return detection


def _detect_ptde(folder: Path) -> Detection | None:
    exe = child(folder, "DARKSOULS.exe")
    if exe is None:
        return None
    unpacked = bool(files_matching(map_studio(folder), MSB_DSR))
    reason = (
        "This is Dark Souls: Prepare to Die Edition, which the Map Maker does not support. "
        "Choose your Dark Souls Remastered folder instead."
    )
    if not unpacked:
        reason += " (This copy is also still packed in its .bdt archives.)"
    return Detection(PTDE, root=folder, evidence=["DARKSOULS.exe"], reason=reason)


def _bloodborne_data_root(folder: Path) -> tuple[Path, Path] | None:
    """(dump root, data root) when `folder` is a Bloodborne dump root or its `dvdroot_ps4` folder."""
    dvdroot = child(folder, "dvdroot_ps4")
    if dvdroot is not None and dvdroot.is_dir():
        return folder, dvdroot
    if folder.name.lower() == "dvdroot_ps4":
        return folder.parent, folder
    # A data folder chosen directly: map/MapStudio with .msb.dcx files.
    if files_matching(map_studio(folder), MSB_BB):
        return folder.parent, folder
    return None


def _detect_bloodborne(folder: Path) -> Detection | None:
    roots = _bloodborne_data_root(folder)
    if roots is None:
        return None
    dump_root, data_root = roots
    msbs = files_matching(map_studio(data_root), MSB_BB)
    eboot = child(dump_root, "eboot.bin")
    detection = Detection(BLOODBORNE, root=data_root)
    if eboot is not None:
        detection.evidence.append("eboot.bin")
    sfo = descend(dump_root, "sce_sys", "param.sfo")
    if sfo is not None:
        try:
            sfo_entries = read_param_sfo(sfo)
        except (OSError, ValueError) as error:
            detection.evidence.append(f"sce_sys/param.sfo could not be read: {error}")
        else:
            title_id = sfo_entries.get("TITLE_ID")
            app_version = sfo_entries.get("APP_VER")
            detection.details["titleId"] = title_id
            detection.details["appVersion"] = app_version
            detection.details["title"] = sfo_entries.get("TITLE")
            if app_version:
                detection.version = str(app_version).lstrip("0") or str(app_version)
            detection.evidence.append(f"param.sfo: {title_id}, app version {app_version}")
    if not msbs:
        detection.reason = (
            "This looks like a Bloodborne dump, but dvdroot_ps4/map/MapStudio has no .msb.dcx map files. "
            "The dump may be incomplete or still packed."
        )
        return detection
    detection.supported = True
    detection.evidence.append(f"{len(msbs)} map files in map/MapStudio")
    stems = {path.name.lower().split(".")[0] for path in msbs}
    dlc = sorted(stem for stem in stems if stem[:3] in {"m34", "m35", "m36"})
    detection.details["dlcMaps"] = dlc
    detection.evidence.append(
        f"The Old Hunters maps: {', '.join(dlc)}" if dlc else "no The Old Hunters maps (m34, m35, m36)"
    )
    if detection.version is None:
        detection.version = "1.09 or later (The Old Hunters maps present)" if dlc else None
    for name, parts in (
        ("params", ("param", "gameparam", "gameparam.parambnd.dcx")),
        ("item text", ("msg", "engus", "item.msgbnd.dcx")),
    ):
        if descend(data_root, *parts) is not None:
            detection.evidence.append(f"{name}: {'/'.join(parts)}")
    return detection


DETECTORS: tuple[tp.Callable[[Path], Detection | None], ...] = (_detect_dsr, _detect_bloodborne, _detect_ptde)


def _detect_here(folder: Path) -> Detection | None:
    for detector in DETECTORS:
        detection = detector(folder)
        if detection is not None:
            return detection
    return None


def detect(folder: Path) -> Detection:
    """Detect the game in `folder`, or in one of its sub-folders (two levels) when the player chose a parent."""
    folder = Path(folder)
    if not folder.exists():
        return Detection(UNKNOWN, picked=folder, reason=f"The folder {folder} does not exist.")
    if not folder.is_dir():
        return Detection(UNKNOWN, picked=folder, reason=f"{folder} is a file, not a folder.")
    found = _detect_here(folder)
    if found is None:
        candidates: list[Detection] = []
        try:
            level1 = sorted(p for p in folder.iterdir() if p.is_dir())
        except OSError:
            level1 = []
        for sub in level1:
            here = _detect_here(sub)
            if here is None:
                try:
                    level2 = sorted(p for p in sub.iterdir() if p.is_dir())
                except OSError:
                    level2 = []
                for subsub in level2:
                    here = _detect_here(subsub)
                    if here is not None:
                        break
            if here is not None:
                candidates.append(here)
        supported = [c for c in candidates if c.supported]
        found = (supported or candidates or [None])[0]
        if found is not None:
            found.evidence.insert(0, f"found in the sub-folder {found.root}")
    if found is None:
        return Detection(
            UNKNOWN,
            picked=folder,
            reason=(
                "No supported game was found here. For Dark Souls Remastered, choose the folder that holds "
                "DarkSoulsRemastered.exe (usually C:\\Program Files (x86)\\Steam\\steamapps\\common\\"
                "DARK SOULS REMASTERED). For Bloodborne, choose the dump folder that holds eboot.bin and dvdroot_ps4."
            ),
        )
    found.picked = folder
    return found
