"""Command line of the helper. The Map Maker app runs it; players never need to.

    atlas-gamefiles check <game folder> --out <output folder> [--stdin-cancel] [--areas ...]
                    [--collision-sample N] [--navmesh-sample N] [--map-piece-sample N]
                    [--source-budget S] [--source-time-limit S] [--heartbeat S]
    atlas-gamefiles --version

The sample sizes and time limits have defaults for Phase 0; the options are there for testing (the app does not
set them).

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
from . import worker
from .check import COLLISION_SAMPLE, MAP_PIECE_SAMPLE, NAVMESH_SAMPLE, SOURCE_BUDGET, CancelToken, Checker
from .events import claim_stdin, claim_stdout, stdin_lines
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
    check.add_argument("--areas", default="", help="only these areas, comma-separated (m10_01_00_00 or m10_01)")
    limits = check.add_argument_group("sampling and time limits (for testing; the defaults suit a first check)")
    limits.add_argument(
        "--collision-sample",
        type=int,
        default=COLLISION_SAMPLE,
        help=f"collision files to read per area, evenly spaced (0 reads all; default {COLLISION_SAMPLE})",
    )
    limits.add_argument(
        "--navmesh-sample",
        type=int,
        default=NAVMESH_SAMPLE,
        help=f"navmesh files to read per area (0 reads all; default {NAVMESH_SAMPLE})",
    )
    limits.add_argument(
        "--map-piece-sample",
        type=int,
        default=MAP_PIECE_SAMPLE,
        help=f"map piece models to read per area (0 reads all; default {MAP_PIECE_SAMPLE})",
    )
    limits.add_argument(
        "--source-budget",
        type=float,
        default=SOURCE_BUDGET,
        help=f"seconds after which a source starts no new file (0: no budget; default {SOURCE_BUDGET:g})",
    )
    limits.add_argument(
        "--source-time-limit",
        type=float,
        default=worker.TIME_LIMIT,
        help="seconds after which a source still being read is stopped and recorded as timed out "
        f"(0: no limit; default {worker.TIME_LIMIT:g})",
    )
    limits.add_argument(
        "--heartbeat",
        type=float,
        default=worker.HEARTBEAT,
        help=f"seconds of silence before a 'still reading' progress line (default {worker.HEARTBEAT:g})",
    )
    return root


def watch_stdin(token: CancelToken) -> None:
    """Cancel on a `cancel` line, or when standard input ends. Standard input is claimed first (see events.py): no
    library, and no program started from here, ever sees the app's pipe, and on Windows no read waits on it."""
    fd = claim_stdin()

    def run() -> None:
        if fd is None:
            return
        try:
            for line in stdin_lines(fd):
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
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["reader"]:  # the file reader process, which the helper starts itself (reader.py)
        from .reader import main as reader_main

        return reader_main(argv[1:])
    args = parser().parse_args(argv)
    block_network()
    events = claim_stdout()
    token = CancelToken()
    if args.stdin_cancel:
        watch_stdin(token)
    areas = [a.strip() for a in args.areas.split(",") if a.strip()]
    try:
        checker = Checker(
            args.folder,
            args.out,
            events,
            token=token,
            only_areas=areas,
            collision_sample=args.collision_sample,
            navmesh_sample=args.navmesh_sample,
            map_piece_sample=args.map_piece_sample,
            source_budget=args.source_budget,
            runner=worker.ProcessRunner(time_limit=args.source_time_limit, heartbeat=args.heartbeat),
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
