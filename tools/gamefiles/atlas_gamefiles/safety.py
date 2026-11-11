"""The helper's promises, enforced in code:

- no network: every socket connection and name lookup raises;
- the game folder is only read: the output folder may not be inside it, and nothing is copied from it;
- importing Soulstruct writes nothing anywhere: its config file, its log file and its console logging are
  kept away, and it loads no DLL (it would look for an Oodle DLL in other games' folders).
"""

from __future__ import annotations

import ctypes
import logging
import os
import socket
import sys
import tempfile
from pathlib import Path


class NetworkDisabledError(RuntimeError):
    pass


def _refuse(*_args, **_kwargs):
    raise NetworkDisabledError("atlas-gamefiles makes no network requests")


_network_blocked = False


def block_network() -> None:
    """Make every outgoing connection and DNS lookup in this process fail."""
    global _network_blocked
    if _network_blocked:
        return
    socket.socket.connect = _refuse  # type: ignore[method-assign]
    socket.socket.connect_ex = _refuse  # type: ignore[method-assign]
    socket.socket.sendto = _refuse  # type: ignore[method-assign]
    socket.create_connection = _refuse  # type: ignore[assignment]
    socket.getaddrinfo = _refuse  # type: ignore[assignment]
    socket.gethostbyname = _refuse  # type: ignore[assignment]
    _network_blocked = True


def is_inside(path: Path, folder: Path) -> bool:
    """Whether `path` is `folder` or anywhere below it (after resolving links)."""
    try:
        path.resolve().relative_to(folder.resolve())
    except ValueError:
        return False
    return True


class UnsafeOutputError(ValueError):
    pass


def check_output_folder(out: Path, game_folder: Path) -> None:
    """Refuse an output folder inside the game folder: the helper never writes there."""
    if is_inside(out, game_folder):
        raise UnsafeOutputError(
            f"The output folder {out} is inside the game folder {game_folder}; "
            "the helper never writes into the game folder. Choose another output folder."
        )
    if is_inside(game_folder, out):
        raise UnsafeOutputError(
            f"The game folder {game_folder} is inside the output folder {out}; choose another output folder."
        )


_soulstruct_ready = False


def prepare_soulstruct() -> None:
    """Import Soulstruct so that it touches nothing outside this process.

    Soulstruct's config module reads and may write `soulstruct_config.json` (in the user's AppData, or next to the
    executable when frozen) and sets up a log file and console logging; its DCX module tries to load an Oodle DLL,
    searching other games' install folders. Here, during that first import:

    - the home folder points at an empty temporary folder, so no config or log file is found or written;
    - `sys.frozen` is hidden, so the frozen helper does not look for (or create) a config file next to itself;
    - its logging setup is replaced by a no-op, and its loggers only report errors, to standard error;
    - `ctypes.WinDLL` is hidden, so no DLL is loaded (Dark Souls Remastered and Bloodborne use zlib DCX, not Oodle).
    """
    global _soulstruct_ready
    if _soulstruct_ready:
        return
    # Libraries that may load their own DLLs are imported first, with `ctypes.WinDLL` in place.
    import numpy  # noqa: F401
    import zstandard  # noqa: F401
    import constrata  # noqa: F401
    soulstruct_logger = logging.getLogger("soulstruct")
    soulstruct_logger.handlers.clear()
    soulstruct_logger.addHandler(logging.StreamHandler(sys.stderr))
    soulstruct_logger.setLevel(logging.ERROR)
    soulstruct_logger.propagate = False
    import soulstruct.logging_utils as logging_utils

    logging_utils.setup = lambda *args, **kwargs: (None, None)  # type: ignore[assignment]

    saved_env = {key: os.environ.get(key) for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA")}
    frozen = getattr(sys, "frozen", None)
    win_dll = getattr(ctypes, "WinDLL", None)
    with tempfile.TemporaryDirectory(prefix="atlas-gamefiles-home-") as home:
        try:
            for key in saved_env:
                os.environ[key] = home
            if frozen is not None:
                del sys.frozen  # type: ignore[attr-defined]
            if win_dll is not None:
                del ctypes.WinDLL
            import soulstruct.config  # noqa: F401  (reads its defaults: there is no config file in `home`)
            import soulstruct.dcx  # noqa: F401  (tries, and fails, to load the Oodle DLL)
        finally:
            for key, value in saved_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            if frozen is not None:
                sys.frozen = frozen  # type: ignore[attr-defined]
            if win_dll is not None:
                ctypes.WinDLL = win_dll  # type: ignore[attr-defined]

    _soulstruct_ready = True
