"""Command line of the helper. The Map Maker app runs it; players never need to.

    atlas-gamefiles check <game folder> --out <output folder> [--stdin-cancel] [--map-piece-sample N] [--areas ...]
    atlas-gamefiles --version

Standard output carries JSON lines only (see events.py): `start`, `game`, `areas`, `progress`, `area`, `warning`,
then `done` (exit code 0), `cancelled` (exit code 3) or `error` (exit code 1). Standard error carries anything else.
"""

from __future__ import annotations

import argparse
import sys
import threading
import traceback
from pathlib import Path

from . import TOOL_NAME, __version__
from .check import CancelToken, Checker
from .events import claim_stdout
from .geometry import Cancelled
from .safety import UnsafeOutputError, block_network

EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_CANCELLED = 0, 1, 2, 3


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog=TOOL_NAME, description="Check a player's own game files for map data.")
    root.add_argument("--version", action="version", version=f"{TOOL_NAME} {__version__}")
    commands = root.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check", help="detect the game, read every area and write a report")
    check.add_argument("folder", type=Path, help="the game folder (Dark Souls Remastered install, Bloodborne dump)")
    check.add_argument("--out", type=Path, required=True, help="where to write report.json, previews/ and the zip")
    check.add_argument(
        "--stdin-cancel",
        action="store_true",
        help="stop cleanly when standard input reads 'cancel' or is closed (used by the Map Maker app)",
    )
    check.add_argument(
        "--map-piece-sample", type=int, default=12, help="map piece models to read per area (0 reads all)"
    )
    check.add_argument("--areas", default="", help="only these areas, comma-separated (m10_01_00_00 or m10_01)")
    return root


def watch_stdin(token: CancelToken) -> None:
    def run() -> None:
        try:
            for line in sys.stdin:
                if line.strip().lower() == "cancel":
                    break
        except (OSError, ValueError):
            pass
        token.cancel()

    threading.Thread(target=run, name="stdin-cancel", daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stderr.reconfigure(errors="replace")  # type: ignore[union-attr]
    except AttributeError:
        pass
    args = parser().parse_args(argv)
    block_network()
    events = claim_stdout()
    token = CancelToken()
    if args.stdin_cancel:
        watch_stdin(token)
    areas = [a.strip() for a in args.areas.split(",") if a.strip()]
    try:
        checker = Checker(
            args.folder, args.out, events, token=token, map_piece_sample=args.map_piece_sample, only_areas=areas
        )
        checker.run()
    except Cancelled:
        events.emit("cancelled", message="Stopped before the end; no report was written.")
        return EXIT_CANCELLED
    except UnsafeOutputError as error:
        events.emit("error", message=str(error))
        return EXIT_USAGE
    except Exception as error:
        traceback.print_exc()
        events.emit("error", message=f"{type(error).__name__}: {error}")
        return EXIT_ERROR
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
