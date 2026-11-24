"""Command line of the helper. The Map Maker app runs it; players never need to.

    atlas-gamefiles check <game folder> --out <output folder> [--stdin-cancel] [--areas ...]
                    [--collision-sample N] [--navmesh-sample N] [--map-piece-sample N]
                    [--source-budget S] [--source-time-limit S] [--heartbeat S]
    atlas-gamefiles make <game folder> --out <output folder> [--maps-folder <folder>] [--stdin-cancel] [--areas ...]
                    [--config <file>] [--floor-overrides <file>] [--remake <area>] [--map-style <style>]
                    [--no-3d] [--scene-builder <atlas-scene program>]
    atlas-gamefiles floor-views <output folder of a make> --area <mAA_BB>
    atlas-gamefiles --version

The sample sizes and time limits have defaults for Phase 0; the options are there for testing (the app does not
set them).

Standard output carries JSON lines only (see events.py): `start`, `game`, `areas`, `progress`, `area`, `warning`,
then `done` (exit code 0), `cancelled` (exit code 3) or `error` (exit code 1). Standard error carries anything else.
`make --remake` makes one area again in place of its map in the pack made before into the same output folder; an
`error` it cannot start with has a `code` (see make.MakeError). `floor-views` answers the Adjust floors panel's
requests, one JSON line each way (see floorviews.py).
"""

from __future__ import annotations

import argparse
import re
import sys
import threading
import traceback
import typing as tp
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
    make = commands.add_parser("make", help="make an Atlas map pack from the game files, and a report")
    make.add_argument(
        "folder", type=Path, help="the game folder (Dark Souls Remastered install, or a Bloodborne 1.09 dump)"
    )
    make.add_argument("--out", type=Path, required=True, help="where to write report.json, previews/ and the zip")
    make.add_argument(
        "--maps-folder",
        type=Path,
        default=None,
        help="the Atlas maps folder to put the pack in (without it, the pack goes into <out>/pack/)",
    )
    make.add_argument("--stdin-cancel", action="store_true", help="as for check")
    make.add_argument("--areas", default="", help="only these areas, comma-separated (m10_01_00_00 or m10_01)")
    make.add_argument("--config", type=Path, default=None, help="another config file (for tuning by hand)")
    make.add_argument(
        "--floor-overrides",
        type=Path,
        default=None,
        help="the player's own floor cuts and names ({game: {mAA_BB: {cuts, names}}}); per area they replace the "
        "config's floorOverrides; an unreadable file is warned about and left out",
    )
    make.add_argument(
        "--remake",
        default=None,
        metavar="AREA",
        help="make only this area (mAA_BB) again and put its map in place of the old one in the pack made before "
        "into this output folder, leaving the rest of the pack as it is",
    )
    make.add_argument(
        "--map-style",
        default=None,
        metavar="STYLE",
        help="how the floors are drawn: shaded (by height, the default) or outlines (by height, with the walls and "
        "the edges of the walkable floor as clear lines); textured and textured-outlines are not available yet",
    )
    make.add_argument(
        "--floor-method",
        default=None,
        choices=("passages", "cuts"),
        help="how floors are found: passages (automatic passages: whole ground, split only where one walkable "
        "surface lies over another) or cuts (cut heights); an area's own choice in the floor overrides wins; "
        "the default is the game's config",
    )
    make.add_argument("--no-3d", action="store_true", help="make the flat maps only, without their 3D models")
    make.add_argument(
        "--scene-builder",
        type=Path,
        default=None,
        help="the 3D builder program (atlas-scene); by default ATLAS_SCENE_BUILDER, or the one next to this program",
    )
    make.add_argument(
        "--source-time-limit",
        type=float,
        default=None,
        help="seconds after which an area's geometry still being read is stopped (default 300)",
    )
    views = commands.add_parser("floor-views", help="redraw an area's floors from given cuts (for the Map Maker)")
    views.add_argument("out", type=Path, help="the output folder of a make (it holds floor-data/)")
    views.add_argument("--area", required=True, help="the area, mAA_BB")
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
    if getattr(args, "stdin_cancel", False):  # floor-views reads its standard input itself
        watch_stdin(token)
    areas = [a.strip() for a in getattr(args, "areas", "").split(",") if a.strip()]
    if args.command == "floor-views":
        from .floorviews import serve

        try:
            return serve(args.out, args.area, events)
        except Exception as error:
            traceback.print_exc()
            events.emit("error", message=f"{type(error).__name__}: {error}")
            return EXIT_ERROR
    if args.command == "make":
        if args.remake and not re.fullmatch(r"m\d\d_\d\d(_\d\d_\d\d)?", args.remake.lower()):
            events.emit("error", message=f"{args.remake} is not an area (mAA_BB).")
            return EXIT_USAGE
        return run_make(args, events, token, areas)
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


def run_make(args: argparse.Namespace, events: tp.Any, token: CancelToken, areas: list[str]) -> int:
    from .make import TIME_LIMIT, MakeError, MapMaker

    limit = TIME_LIMIT if args.source_time_limit is None else args.source_time_limit
    try:
        MapMaker(
            args.folder,
            args.out,
            events,
            token=token,
            maps_folder=args.maps_folder,
            only_areas=areas,
            runner=worker.ProcessRunner(time_limit=limit),
            config_file=args.config,
            make_3d=not args.no_3d,
            scene_builder=args.scene_builder,
            floor_overrides_file=args.floor_overrides,
            remake=args.remake,
            style=args.map_style,
            floor_method=args.floor_method,
        ).run()
    except Cancelled:
        events.emit("cancelled", message="Stopped before the end; the map pack was left as it was.")
        return EXIT_CANCELLED
    except MakeError as error:
        events.emit("error", message=str(error), **({"code": error.code} if error.code else {}))
        return EXIT_USAGE
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
