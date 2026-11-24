"""Command line of the helper. The Map Maker app runs it; players never need to.

    atlas-gamefiles check <game folder> --out <output folder> [--stdin-cancel] [--areas ...]
                    [--collision-sample N] [--navmesh-sample N] [--map-piece-sample N]
                    [--source-budget S] [--source-time-limit S] [--heartbeat S]
    atlas-gamefiles make <game folder> --out <output folder> [--maps-folder <folder>] [--stdin-cancel] [--areas ...]
                    [--config <file>] [--floor-overrides <file>] [--remake <area>] [--map-style <style>]
                    [--no-3d] [--look-3d models|collision] [--scene-builder <atlas-scene program>]
    atlas-gamefiles make-model <model file> --out <output folder> [--maps-folder <folder>] [--stdin-cancel]
                    [--name <name>] [--title <title>] [--up +y|+z|-y|-z|+x|-x] [--scale <metres per unit>]
                    [--textures keep|plain] [--double-sided auto|yes|no] [--floors ground|passages|none]
                    [--floor-separation <m>] [--merge-gap <m>] [--max-triangles <n>] [--map-style <style>]
                    [--floor-overrides <file>] [--remake] [--scene-builder <atlas-scene program>]
    atlas-gamefiles redraw <pack folder> --out <output folder> [--map-style <style>] [--floor-overrides <file>]
                    [--floor-method passages|cuts] [--scene-builder <atlas-scene program>] [--stdin-cancel]
    atlas-gamefiles floor-views <output folder of a make> --area <mAA_BB, or model>
    atlas-gamefiles --version

The sample sizes and time limits have defaults for Phase 0; the options are there for testing (the app does not
set them).

Standard output carries JSON lines only (see events.py): `start`, `game`, `areas`, `progress`, `area`, `warning`,
then `done` (exit code 0), `cancelled` (exit code 3) or `error` (exit code 1). Standard error carries anything else.
`make --remake` makes one area again in place of its map in the pack made before into the same output folder; an
`error` it cannot start with has a `code` (see make.MakeError). `floor-views` answers the Adjust floors panel's
requests, one JSON line each way (see floorviews.py). `redraw` draws every 2D floor of a map pack again from the
pack's own 3D models, with no game files (see redraw.py): `start`, `maps`, `progress`, a `map` line per map (drawn
again, or why not), `warning`, then `done`, `cancelled` or `error`.
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
        help="how the floors are drawn: shaded (by height, the default), outlines (by height, with the walls and "
        "the edges of the walkable floor as clear lines), floors (each floor in its own colour, shaded by height "
        "within it), textured (from the game's own models and textures) or textured-outlines (the same, with the "
        "outlines); an area whose models cannot be read is drawn by height",
    )
    make.add_argument(
        "--look-3d",
        default=None,
        choices=("models", "collision"),
        help="what the 3D maps show: models (the game's own models with their textures, the default; an area whose "
        "models cannot be read gets its collision) or collision (the ground and walls, coloured by height)",
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
    again = commands.add_parser(
        "redraw", help="draw every 2D floor of a map pack again from its own 3D models (no game files needed)"
    )
    again.add_argument("pack", type=Path, help="the map pack's folder (in the Atlas maps folder)")
    again.add_argument("--out", type=Path, required=True, help="where to write report.json")
    again.add_argument(
        "--map-style", default=None, metavar="STYLE", help="how the floors are drawn, as for make-model (the textured styles too)"
    )
    again.add_argument("--floor-overrides", type=Path, default=None, help="the player's own floor cuts, as for make")
    again.add_argument("--floor-method", default=None, choices=("passages", "cuts"), help="as for make")
    again.add_argument("--scene-builder", type=Path, default=None, help="the 3D builder program, as for make")
    again.add_argument("--stdin-cancel", action="store_true", help="as for check")
    model = commands.add_parser("make-model", help="make an Atlas map pack from a 3D model file (glTF, OBJ, STL, PLY)")
    model.add_argument("model", type=Path, help="the model file (.glb, .gltf, .obj, .stl or .ply)")
    model.add_argument("--out", type=Path, required=True, help="where to write report.json, previews/ and the zip")
    model.add_argument("--maps-folder", type=Path, default=None, help="as for make")
    model.add_argument("--stdin-cancel", action="store_true", help="as for check")
    model.add_argument("--name", default=None, help="the map's name (the pack id is made from it); the file's name by default")
    model.add_argument("--title", default=None, help="the pack's title; the name by default")
    model.add_argument("--up", default="+y", choices=("+y", "+z", "-y", "-z", "+x", "-x"), help="the model's up axis")
    model.add_argument("--scale", type=float, default=1.0, help="metres per model unit (0.01 for centimetres)")
    model.add_argument("--units", default=None, help="what the scale is, for the report (metres, centimetres, …)")
    model.add_argument("--textures", default="keep", choices=("keep", "plain"), help="keep the textures, or plain colours")
    model.add_argument(
        "--double-sided",
        default="auto",
        choices=("auto", "yes", "no"),
        help="surfaces seen from both sides: as the model says (glTF materials; OBJ, STL and PLY both), or all, or none",
    )
    model.add_argument(
        "--floors",
        default="ground",
        choices=("ground", "passages", "none"),
        help="floors by ground area, automatic passages, or none (one map of the whole model)",
    )
    model.add_argument("--floor-separation", type=float, default=None, help="ground area: floor levels at least this far apart (m)")
    model.add_argument("--merge-gap", type=float, default=None, help="ground area: levels closer than this are joined (m)")
    model.add_argument("--max-triangles", type=int, default=None, help="refuse a model of more triangles (default 5,000,000)")
    model.add_argument("--map-style", default=None, metavar="STYLE", help="shaded, outlines, floors, textured or textured-outlines")
    model.add_argument("--floor-overrides", type=Path, default=None, help="as for make (under the pack id, area model)")
    model.add_argument("--remake", action="store_true", help="make the map again in place of the one made into this output folder")
    model.add_argument("--scene-builder", type=Path, default=None, help="as for make")
    views = commands.add_parser("floor-views", help="redraw an area's floors from given cuts (for the Map Maker)")
    views.add_argument("out", type=Path, help="the output folder of a make (it holds floor-data/)")
    views.add_argument("--area", required=True, help="the area: mAA_BB, or model for a map made from a 3D model")
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
    if args.command == "redraw":
        return run_redraw(args, events, token)
    if args.command == "make-model":
        return run_make_model(args, events, token)
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
            look_3d=args.look_3d,
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


def run_redraw(args: argparse.Namespace, events: tp.Any, token: CancelToken) -> int:
    from .redraw import RedrawError, Redrawer

    try:
        Redrawer(
            args.pack,
            args.out,
            events,
            token=token,
            style=args.map_style,
            floor_overrides_file=args.floor_overrides,
            floor_method=args.floor_method,
            scene_builder=args.scene_builder,
        ).run()
    except Cancelled:
        events.emit("cancelled", message="Stopped before the end; the map pack was left as it was.")
        return EXIT_CANCELLED
    except RedrawError as error:
        events.emit("error", message=str(error))
        return EXIT_USAGE
    except Exception as error:
        traceback.print_exc()
        events.emit("error", message=f"{type(error).__name__}: {error}")
        return EXIT_ERROR
    return EXIT_OK



def run_make_model(args: argparse.Namespace, events: tp.Any, token: CancelToken) -> int:
    from .make import MakeError
    from .model import DEFAULT_MAX_TRIANGLES, ModelMapMaker

    try:
        ModelMapMaker(
            args.model,
            args.out,
            events,
            token=token,
            maps_folder=args.maps_folder,
            scene_builder=args.scene_builder,
            name=args.name,
            title=args.title,
            up=args.up,
            scale=args.scale,
            units=args.units,
            textures=args.textures,
            double_sided={"yes": True, "no": False}.get(args.double_sided),
            floors=args.floors,
            floor_separation=args.floor_separation,
            merge_gap=args.merge_gap,
            max_triangles=args.max_triangles or DEFAULT_MAX_TRIANGLES,
            style=args.map_style,
            floor_overrides_file=args.floor_overrides,
            remake=args.remake,
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
