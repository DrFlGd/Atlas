# PyInstaller spec: one executable, `atlas-gamefiles` (`.exe` on Windows), with Python, Soulstruct and NumPy inside.
#
#   pyinstaller --clean --noconfirm atlas-gamefiles.spec
#
# Python code, the libraries' own compiled modules, and only those Soulstruct data files that its modules read when
# imported: its instruction and field definitions (JSON), type stubs (.pyi) and Havok type lists (XML). Everything else Soulstruct
# carries stays out, and must: the Oodle DLL, the .exe and .dll tools, soulstruct-havok's Havok templates, and the
# paramdef and material binders. `check_bundle` below fails the build if any of them got in.
# Plotting and GUI libraries that some Soulstruct modules import only when present are left out.

import re

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = collect_data_files(
    "soulstruct", includes=["**/*.emedf.json", "**/paramdef_info.json", "**/*.pyi", "havok/types/*.xml"]
)

hidden = [
    *collect_submodules("soulstruct.darksouls1r.maps"),
    *collect_submodules("soulstruct.darksouls1ptde.maps"),
    *collect_submodules("soulstruct.bloodborne.maps"),
    *collect_submodules("soulstruct.darksouls1r.params.paramdef"),
    *collect_submodules("soulstruct.bloodborne.params.paramdef"),
    *collect_submodules("soulstruct.havok.types.hk2014"),
    *collect_submodules("soulstruct.havok.types.hk2015"),
    "soulstruct.havok.fromsoft.shared.map_collision",
    "soulstruct.flver",
]

excluded = [
    "tkinter",
    "matplotlib",
    "PIL",
    "vispy",
    "pydub",
    "psutil",
    "IPython",
    "pytest",
]

a = Analysis(
    ["atlas_gamefiles/__main__.py"],
    pathex=["."],
    datas=datas,
    hiddenimports=hidden,
    excludes=excluded,
    noarchive=False,
    optimize=0,
)

FORBIDDEN = re.compile(r"(oo2core|\.exe$|\.hkx$|paramdefbnd|mtdbnd|Paramdex)", re.IGNORECASE)


def check_bundle(entries):
    found = [name for name, *_ in entries if FORBIDDEN.search(name.replace("\\", "/"))]
    if found:
        raise SystemExit(f"These files must not be in the helper: {found}")


check_bundle(a.datas)
check_bundle(a.binaries)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="atlas-gamefiles",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
)
