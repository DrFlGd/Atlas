"""`check`: detect the game in a folder, read every area, and write the report, previews and a zip of both.

Only the output folder is written to. The game folder is read, never written, and no game file is copied: the
report holds counts, names of files, coordinate ranges and error messages; the previews are dots and shaded
triangles drawn from coordinates.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile
import threading
import time
import typing as tp
import zipfile
from pathlib import Path

import numpy as np

from . import REPORT_VERSION, TOOL_NAME, __version__
from .detect import BLOODBORNE, DSR, Detection, detect
from .events import Events
from .gamedata import ItemLots, read_item_lots, read_item_text
from .games import BLOODBORNE_MAIN_AREAS, PROFILES, Area, GameProfile, list_areas
from .geometry import Cancelled, SourceResult
from .msb import load_msb, summarize
from .preview import LEGEND, render
from .safety import check_output_folder, prepare_soulstruct
from .worker import PREVIEW_LIMIT, READER_LOG, ProcessRunner, Runner, SourceJob, clean_text

ZIP_NAME = "atlas-check-report.zip"
LOG_LIMIT = 200_000  # bytes of the reader's log put in the zip (the end of it)
GEOMETRY_SOURCES = ("collision", "navmesh", "mapPieces")
SOURCE_NAMES = {"collision": "collision", "navmesh": "navmesh", "mapPieces": "map piece models"}

# Phase 0 reads a sample of each area's geometry, and gives each source a time budget (see geometry.py); the
# command line can change these (cli.py).
COLLISION_SAMPLE = 12
NAVMESH_SAMPLE = 0
MAP_PIECE_SAMPLE = 12
SOURCE_BUDGET = 45.0

# Share of an area's progress for each step.
STEP_WEIGHTS = {"msb": 0.1, "collision": 0.5, "navmesh": 0.2, "mapPieces": 0.15, "preview": 0.05}


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def stop(self) -> None:
        """Raise `Cancelled` when cancel was asked for: called between files."""
        if self._event.is_set():
            raise Cancelled()


def display_path(path: Path | None) -> str | None:
    """A path for the report, with the home folder shortened to `~` so it holds no user name."""
    if path is None:
        return None
    text = str(path)
    home = os.path.expanduser("~")
    if home and home not in ("~", "/") and text.lower().startswith(home.lower()):
        return "~" + text[len(home):]
    return text


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def game_dict(detection: Detection) -> dict[str, tp.Any]:
    data: dict[str, tp.Any] = {
        "id": detection.game,
        "title": detection.title,
        "supported": detection.supported,
        "version": detection.version,
        "dataFolder": display_path(detection.root),
        "evidence": detection.evidence,
    }
    if detection.details:
        data["details"] = detection.details
    if detection.reason:
        data["reason"] = detection.reason
    return data


class Checker:
    def __init__(
        self,
        folder: Path,
        out: Path,
        events: Events,
        token: CancelToken | None = None,
        map_piece_sample: int = MAP_PIECE_SAMPLE,
        only_areas: tp.Sequence[str] = (),
        collision_sample: int = COLLISION_SAMPLE,
        navmesh_sample: int = NAVMESH_SAMPLE,
        source_budget: float = SOURCE_BUDGET,
        runner: Runner | None = None,
    ):
        self.folder = Path(folder)
        self.out = Path(out)
        self.events = events
        self.token = token or CancelToken()
        self.samples = {"collision": collision_sample, "navmesh": navmesh_sample, "mapPieces": map_piece_sample}
        self.source_budget = source_budget
        # Geometry is read in a file reader process with a time limit, unless a test passes another runner.
        self.runner: Runner = runner if runner is not None else ProcessRunner()
        self.only_areas = {a.lower() for a in only_areas}
        self.warnings: list[str] = []
        self.started = time.monotonic()
        self.import_seconds: float | None = None
        self.reader_warned: set[str] = set()

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        self.events.warning(message)

    def run(self) -> dict[str, tp.Any]:
        try:
            return self._run()
        finally:
            self.runner.close()

    def options(self) -> dict[str, tp.Any]:
        runner = self.runner
        return {
            "mapPieceSample": self.samples["mapPieces"],
            "collisionSample": self.samples["collision"],
            "navmeshSample": self.samples["navmesh"],
            "sourceBudgetSeconds": self.source_budget,
            "sourceTimeLimitSeconds": runner.time_limit if isinstance(runner, ProcessRunner) else None,
            "previewTriangleLimit": PREVIEW_LIMIT,
            "areas": sorted(self.only_areas) or "all",
        }

    def _run(self) -> dict[str, tp.Any]:
        events = self.events
        events.emit("start", tool=TOOL_NAME, version=__version__, folder=display_path(self.folder))
        events.progress(0.0, "Looking at the folder")
        detection = detect(self.folder)
        events.emit("game", game=game_dict(detection))
        if detection.supported and detection.root is not None:
            check_output_folder(self.out, detection.root)
        self.out.mkdir(parents=True, exist_ok=True)
        self.runner.use_folder(self.out)

        report: dict[str, tp.Any] = {
            "tool": TOOL_NAME,
            "toolVersion": __version__,
            "reportVersion": REPORT_VERSION,
            "createdAt": _now(),
            "folder": display_path(self.folder),
            "game": game_dict(detection),
            "options": self.options(),
            "gameData": None,
            "areas": [],
            "summary": None,
            "warnings": self.warnings,
        }
        if not detection.supported or detection.root is None:
            self.warn(detection.reason or f"{detection.title} is not supported.")
            return self.finish(report)

        events.progress(0.01, "Loading the file readers")
        importing = time.monotonic()
        prepare_soulstruct()
        self.import_seconds = time.monotonic() - importing
        profile = PROFILES[detection.game]
        root = detection.root
        areas = list_areas(profile, root)
        if self.only_areas:
            areas = [a for a in areas if a.id in self.only_areas or a.id[:6] in self.only_areas]
        events.emit("areas", count=len(areas), areas=[{"id": a.id, "name": a.name} for a in areas])

        self.token.stop()
        events.progress(0.02, "Reading the item lot table")
        item_lots = read_item_lots(profile, root)
        self.token.stop()
        events.progress(0.04, "Reading the item names")
        item_text = read_item_text(profile, root)
        report["gameData"] = {"itemLots": item_lots.to_dict(), "itemText": item_text.to_dict()}
        if not item_lots.ok:
            self.warn(f"The item lot table could not be read: {item_lots.error}")
        if not item_text.ok:
            self.warn(f"The item names could not be read: {item_text.error}")

        (self.out / "previews").mkdir(exist_ok=True)
        start, span = 0.05, 0.93
        all_lots: set[int] = set()
        for index, area in enumerate(areas):
            self.token.stop()
            area_start = start + span * index / max(len(areas), 1)
            area_span = span / max(len(areas), 1)
            entry, lots = self.check_area(profile, root, area, index, len(areas), area_start, area_span, item_lots)
            all_lots |= lots
            report["areas"].append(entry)
        report["summary"] = self.summary(detection, report["areas"], all_lots, item_lots)
        return self.finish(report)

    def check_area(
        self,
        profile: GameProfile,
        root: Path,
        area: Area,
        index: int,
        count: int,
        area_start: float,
        area_span: float,
        item_lots: ItemLots,
    ) -> tuple[dict[str, tp.Any], set[int]]:
        label = f"{area.name} ({index + 1} of {count})"
        offsets: dict[str, float] = {}
        total = 0.0
        for step, weight in STEP_WEIGHTS.items():
            offsets[step] = total
            total += weight
        area_started = time.monotonic()

        entry: dict[str, tp.Any] = {
            "id": area.id,
            "name": area.name,
            "msbFile": area.msb.relative_to(root).as_posix(),
            "mapFolder": area.map_folder.relative_to(root).as_posix() if area.map_folder else None,
        }
        self.events.progress(area_start, f"{label}: reading the map layout", area=area.id, step="msb")
        instances: dict[str, tp.Any] = {}
        placements = []
        lots: set[int] = set()
        try:
            msb = load_msb(profile, area)
            summary = summarize(profile, area, msb)
        except Cancelled:
            raise
        except Exception as error:
            entry["msb"] = {"ok": False, "error": f"{type(error).__name__}: {str(error).strip()[:300]}"}
            self.warn(f"{area.name}: the map layout ({area.msb.name}) could not be read")
        else:
            instances = summary.instances
            placements = summary.placements
            lots = summary.item_lots
            entry["msb"] = {"ok": True}
            entry["parts"] = summary.parts
            entry["partsTotal"] = summary.parts_total
            entry["treasures"] = summary.treasures
            entry["itemLotsReferenced"] = len(lots)
            entry["itemLotsFound"] = len(lots & item_lots.rows) if item_lots.ok else None
            bonfires = dict(summary.bonfires)
            names = bonfires.pop("parts", [])
            bonfires["examples"] = names[:8]
            entry["bonfireCandidates"] = bonfires
            entry["bounds"] = summary.bounds
            entry["pointBounds"] = summary.point_bounds

        geometry: dict[str, SourceResult] = {}
        for source in GEOMETRY_SOURCES:
            self.token.stop()
            base = area_start + area_span * offsets[source]
            weight = area_span * STEP_WEIGHTS[source]

            def say(within: float, text: str, base: float = base, weight: float = weight, source: str = source) -> None:
                self.events.progress(base + weight * within, f"{label}: {text}", area=area.id, step=source)

            say(0.0, f"reading {SOURCE_NAMES[source]}")
            job = SourceJob(
                source,
                profile.game,
                area,
                root,
                instances,
                sample=self.samples[source],
                budget=self.source_budget,
            )
            try:
                result, mesh = self.runner.run(job, say, self.token)
            except Cancelled:
                raise
            except Exception as error:  # a reader bug must not end the whole check
                result, mesh = SourceResult(source, status="failed"), None
                result.add_error(error)
            if mesh is not None and len(mesh):
                result.mesh = [mesh]
            self.warn_reader()
            if result.status == "timed-out":
                self.warn(
                    f"{area.name}: reading {SOURCE_NAMES[source]} was stopped after {result.time_limit:g} s "
                    f"({result.stopped_on}); the check went on without it"
                )
            geometry[source] = result
        entry["geometry"] = {source: result.to_dict() for source, result in geometry.items()}

        self.token.stop()
        self.events.progress(
            area_start + area_span * offsets["preview"], f"{label}: drawing the preview", area=area.id, step="preview"
        )
        drawn_from = None
        triangles = np.zeros((0, 3, 3), dtype=np.float32)
        for source in ("collision", "navmesh"):
            mesh = geometry[source].triangles_array()
            if len(mesh):
                triangles, drawn_from = mesh, source
                if geometry[source].sampled:
                    drawn_from += f" (a sample of {geometry[source].read} of {geometry[source].entries} files)"
                break
        picture = None
        try:
            picture = render(triangles, placements)
        except Exception as error:
            self.warn(f"{area.name}: the preview could not be drawn ({type(error).__name__}: {error})")
        if picture is not None:
            png, meta = picture
            name = f"previews/{area.id}.png"
            (self.out / name).write_bytes(png)
            entry["preview"] = {"file": name, "geometry": drawn_from or "none (parts only)", **meta}
        else:
            entry["preview"] = None
        for result in geometry.values():
            result.mesh.clear()
        entry["seconds"] = round(time.monotonic() - area_started, 1)
        self.events.emit(
            "area",
            id=area.id,
            name=area.name,
            index=index,
            count=count,
            parts=entry.get("partsTotal"),
            treasures=entry.get("treasures"),
            geometry={source: result.status for source, result in geometry.items()},
            preview=entry["preview"]["file"] if entry["preview"] else None,
        )
        return entry, lots

    def warn_reader(self) -> None:
        """One warning when the file reader process cannot start, or cannot load the Havok reader."""
        runner = self.runner
        if not isinstance(runner, ProcessRunner):
            return
        for key, problem, what in (
            ("broken", runner.broken, "The file reader process could not start"),
            ("havok", runner.havok_broken, "The file reader process could not load the Havok reader"),
        ):
            if problem and key not in self.reader_warned:
                self.reader_warned.add(key)
                self.warn(f"{what}: {problem}. The report's diagnostics section and {READER_LOG} say more.")

    def summary(
        self, detection: Detection, areas: list[dict[str, tp.Any]], lots: set[int], item_lots: ItemLots
    ) -> dict[str, tp.Any]:
        geometry: dict[str, dict[str, int]] = {}
        for source in GEOMETRY_SOURCES:
            counts = {
                "ok": 0,
                "partial": 0,
                "failed": 0,
                "missing": 0,
                "not-decoded": 0,
                "timed-out": 0,
                "triangles": 0,
            }
            for area in areas:
                result = area["geometry"][source]
                counts[result["status"]] = counts.get(result["status"], 0) + 1
                counts["triangles"] += result["triangles"]
            geometry[source] = counts
        read_areas = [a for a in areas if a["msb"]["ok"]]
        summary: dict[str, tp.Any] = {
            "areas": len(areas),
            "areasRead": len(read_areas),
            "parts": sum(a.get("partsTotal", 0) for a in read_areas),
            "treasures": sum(a.get("treasures", 0) for a in read_areas),
            "itemLotsReferenced": len(lots),
            "itemLotsFound": len(lots & item_lots.rows) if item_lots.ok else None,
            "bonfireCandidates": sum(a["bonfireCandidates"]["count"] for a in read_areas),
            "geometry": geometry,
            "previews": sum(1 for a in areas if a.get("preview")),
        }
        summary["recommendedGeometry"], summary["recommendation"] = self.recommend(geometry, len(areas))

        if detection.game == BLOODBORNE:
            present = {a["id"][:6] for a in areas}
            missing = [stem for stem in BLOODBORNE_MAIN_AREAS if stem not in present]
            summary["mainAreas"] = {
                "expected": len(BLOODBORNE_MAIN_AREAS),
                "found": len(BLOODBORNE_MAIN_AREAS) - len(missing),
                "missing": missing,
            }
            if missing and not self.only_areas:
                self.warn(f"Expected 16 main Bloodborne areas; missing: {', '.join(missing)}")
        if detection.game == DSR and not self.only_areas and len(areas) < 17:
            self.warn(f"Expected about 17 Dark Souls Remastered areas, found {len(areas)}")
        for area in areas:
            if not area["msb"]["ok"]:
                continue
            if area.get("partsTotal", 0) and area.get("treasures", 0) == 0:
                self.warn(f"{area['name']}: no treasure events")
        return summary

    @staticmethod
    def recommend(geometry: dict[str, dict[str, int]], area_count: int) -> tuple[str | None, str]:
        """The first source (collision, then navmesh, then map pieces) read in at least 80% of the areas that have
        its files."""
        for source in GEOMETRY_SOURCES:
            counts = geometry[source]
            good = counts["ok"] + counts["partial"]
            present = area_count - counts["missing"]
            if good and good >= round(present * 0.8):
                missing = ""
                if counts["missing"]:
                    areas = "1 area has" if counts["missing"] == 1 else f"{counts['missing']} areas have"
                    missing = f" ({areas} no {SOURCE_NAMES[source]} files)"
                where = "the 1 area" if present == 1 else f"the {present} areas"
                return source, (
                    f"{SOURCE_NAMES[source].capitalize()} was read in {good} of {where} that have it{missing}: "
                    "use it for the floor plans."
                )
        return None, "No geometry source was read in most areas; see each area's errors."

    def diagnostics(self) -> dict[str, tp.Any]:
        """How the helper ran, for a report from a PC where something stalled. No user name: paths under the home
        folder start with `~`."""
        system = sys.platform
        if sys.platform == "win32":
            version = sys.getwindowsversion()
            system = f"Windows {version.major}.{version.minor} build {version.build}"
        return {
            "frozen": bool(getattr(sys, "frozen", False)),
            "python": sys.version.split()[0],
            "helperVersion": __version__,
            "system": system,
            "tempDir": display_path(Path(tempfile.gettempdir())),
            "soulstructImportSeconds": round(self.import_seconds, 2) if self.import_seconds is not None else None,
            "reader": self.runner.diagnostics(),
        }

    def finish(self, report: dict[str, tp.Any]) -> dict[str, tp.Any]:
        report["elapsedSeconds"] = round(time.monotonic() - self.started, 1)
        self.runner.close()  # the reader's log is complete once it has ended
        report["diagnostics"] = self.diagnostics()
        self.events.progress(0.99, "Writing the report")
        report_path = self.out / "report.json"
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        zip_path = self.out / ZIP_NAME
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(report_path, "report.json")
            for area in report["areas"]:
                if area.get("preview"):
                    archive.write(self.out / area["preview"]["file"], area["preview"]["file"])
            log = self.out / READER_LOG
            if log.is_file():
                data = log.read_bytes()
                if len(data) > LOG_LIMIT:
                    data = b"(earlier lines left out)\n" + data[-LOG_LIMIT:]
                archive.writestr(READER_LOG, clean_text(data.decode("utf-8", "replace")))
            archive.writestr("README.txt", README_TEXT)
        self.events.emit(
            "done",
            report=str(report_path),
            zip=str(zip_path),
            game=report["game"],
            summary=report["summary"],
            warnings=len(self.warnings),
        )
        return report


README_TEXT = f"""Atlas Map Maker: game files check report

report.json lists what {TOOL_NAME} could read from the game folder: the game and version, each area's
parts, treasure and item lot counts, and which geometry source (collision, navmesh, map piece models) worked.
previews/ holds one top-down picture per area: shaded triangles where geometry was read, and dots for
parts ({", ".join(LEGEND.values())}).
{READER_LOG} is the log of the file reader process: when it started, each step of its start-up, each
source it read and how long it took, and where it was if it was stopped.

It holds no game files: only counts, file names, coordinate ranges and error messages.
"""
