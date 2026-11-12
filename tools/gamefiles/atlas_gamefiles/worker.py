"""Reading an area's geometry in a separate file reader process, with a time limit, so that no file can hang the
whole check.

Real game files may parse slowly in pure Python, and a parser may never finish on data it does not expect. So the
check reads each geometry source (collision, navmesh, map pieces) of each area in a file reader process: one at a
time, reused from source to source until one has to be stopped. The parent keeps watching it:

- start-up: the reader says each start-up step it has done (`booted`, `numpy`, `soulstruct core`,
  `soulstruct.havok`, `ready`; see reader.py). A reader not ready after `start_limit` seconds is stopped, and the
  report says the last step it reached, with the end of its log;
- progress: the reader says before it opens a binder, how long that took, and before each file. While it says
  nothing for `heartbeat` seconds, the parent reports that it is still on that file, with the seconds so far, so
  the window never sits on one message;
- a time limit: a source still running after `time_limit` seconds is stopped. The reader is killed, the source is
  recorded as `timed-out` with the file it was on and how many files it got through, and the check goes on with
  the next source (in a new reader);
- cancel: kills the reader at once.

The reader is this same program started again as a plain child process (`atlas-gamefiles reader`, or
`python -m atlas_gamefiles reader`), with pipes of its own for standard input and output, its standard error in a
log file in the output folder (`reader-log.txt`, also put in the report zip), and on Windows no console window: the
way the Map Maker app starts the helper itself. (Map Maker 0.1.1 used multiprocessing's `spawn`, and on a player's
PC that child never started; see events.py for why.) It ends when its standard input ends, so it never outlives
the helper.

Only the result comes back, with the area's triangles for the preview capped at `preview_limit` (an evenly spaced
selection), in a temporary `.npy` file in the output folder that is deleted once read.
"""

from __future__ import annotations

import dataclasses
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import typing as tp
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .games import PROFILES, Area
from .geometry import Cancelled, Feedback, Instances, SourceResult, read_collision, read_map_pieces, read_navmesh
from .reader import STAGES

# Defaults, overridable on the command line (see cli.py).
TIME_LIMIT = 90.0  # seconds one source of one area may take before its reader is stopped
HEARTBEAT = 5.0  # seconds of silence before saying "still reading ..."
START_LIMIT = 60.0  # seconds the reader may take to start (importing NumPy and Soulstruct)
PREVIEW_LIMIT = 200_000  # triangles per source sent back for the preview

READER_LOG = "reader-log.txt"
MESH_PREFIX = "reader-mesh-"
LOG_TAIL_LINES = 25

# How each source names what it reads, for the progress lines.
FILE_WORDS = {"collision": "collision file", "navmesh": "navmesh file", "mapPieces": "model"}
OPEN_WORDS = {"collision": "collision files", "navmesh": "navmesh files", "mapPieces": "map piece models"}

Say = tp.Callable[[float, str], None]
"""Progress for the check: how far through the source (0 to 1), and what is happening."""


@dataclass(frozen=True)
class SourceJob:
    """One geometry source of one area, as the reader reads it."""

    source: str  # collision | navmesh | mapPieces
    game: str
    area: Area
    root: Path
    instances: Instances
    sample: int = 0  # files to read, evenly spaced (0: all)
    budget: float = 0.0  # seconds after which no new file is started (0: no budget)
    preview_limit: int = PREVIEW_LIMIT


def cap_triangles(mesh: np.ndarray, limit: int) -> np.ndarray:
    """At most `limit` triangles, evenly spaced through `mesh`."""
    if limit <= 0 or len(mesh) <= limit:
        return mesh
    return mesh[np.linspace(0, len(mesh) - 1, limit).astype(np.int64)]


def execute(job: SourceJob, feedback: Feedback) -> tuple[SourceResult, np.ndarray]:
    """Read one source; return its result (without the mesh) and its triangles for the preview."""
    profile = PROFILES[job.game]
    if job.source == "collision":
        result = read_collision(profile, job.area, job.root, job.instances, feedback, job.sample, job.budget)
    elif job.source == "navmesh":
        result = read_navmesh(profile, job.area, job.root, job.instances, feedback, job.sample, job.budget)
    elif job.source == "mapPieces":
        result = read_map_pieces(profile, job.area, job.root, feedback, job.sample, job.budget)
    else:
        raise ValueError(f"unknown geometry source {job.source!r}")
    mesh = cap_triangles(result.triangles_array(), job.preview_limit)
    result.mesh = []
    return result, mesh


Execute = tp.Callable[[SourceJob, Feedback], tuple[SourceResult, np.ndarray]]


# --- Jobs and results through the pipes (see reader.py) ------------------------------------------------------


def needs_havok(job: SourceJob) -> bool:
    """Whether reading this source takes the Havok reader."""
    return job.source == "collision" or (job.source == "navmesh" and PROFILES[job.game].navmesh_kind != "nvm")


def job_to_dict(job: SourceJob) -> dict[str, tp.Any]:
    return {
        "source": job.source,
        "game": job.game,
        "area": {
            "id": job.area.id,
            "name": job.area.name,
            "msb": str(job.area.msb),
            "mapFolder": str(job.area.map_folder) if job.area.map_folder is not None else None,
        },
        "root": str(job.root),
        "instances": {model: [list(map(list, placed)) for placed in places] for model, places in job.instances.items()},
        "sample": job.sample,
        "budget": job.budget,
        "previewLimit": job.preview_limit,
    }


def job_from_dict(data: dict[str, tp.Any]) -> SourceJob:
    area = data["area"]
    return SourceJob(
        source=data["source"],
        game=data["game"],
        area=Area(
            id=area["id"],
            name=area["name"],
            msb=Path(area["msb"]),
            map_folder=Path(area["mapFolder"]) if area["mapFolder"] is not None else None,
        ),
        root=Path(data["root"]),
        instances={
            model: [(tuple(position), tuple(rotation)) for position, rotation in places]  # type: ignore[misc]
            for model, places in data["instances"].items()
        },
        sample=int(data["sample"]),
        budget=float(data["budget"]),
        preview_limit=int(data["previewLimit"]),
    )


def result_to_dict(result: SourceResult) -> dict[str, tp.Any]:
    data = dataclasses.asdict(dataclasses.replace(result, mesh=[]))
    del data["mesh"]
    return data


def result_from_dict(data: dict[str, tp.Any]) -> SourceResult:
    fields = {field.name for field in dataclasses.fields(SourceResult)} - {"mesh"}
    result = SourceResult(**{key: value for key, value in data.items() if key in fields})
    result.file_seconds = [(str(name), float(seconds)) for name, seconds in result.file_seconds]
    return result


class Watch:
    """Turns the reader's messages into progress lines, and remembers where it is, for a heartbeat or a time-out."""

    def __init__(self, job: SourceJob, say: Say, heartbeat: float, clock: tp.Callable[[], float] = time.monotonic):
        self.job = job
        self.say_to = say
        self.heartbeat = heartbeat
        self.clock = clock
        now = clock()
        self.started = now
        self.last_said = now
        self.doing = "starting"
        self.name: str | None = None
        self.index = -1
        self.total = 0
        self.entries = 0
        self.since = now  # when the current step began
        self.started_reader = now
        self.file_seconds: list[tuple[str, float]] = []
        self.stage: str | None = None  # the last start-up step the reader has done

    @property
    def within(self) -> float:
        return max(self.index, 0) / self.total if self.total else 0.0

    def say(self, text: str) -> None:
        self.last_said = self.clock()
        self.say_to(self.within, text)

    def starting_reader(self) -> None:
        self.doing, self.since = "starting", self.clock()
        self.started_reader = self.since
        self.stage = None
        self.say("starting the file reader")

    def handle(self, message: tuple[tp.Any, ...]) -> None:
        kind = message[0]
        now = self.clock()
        if kind == "stage":
            self.stage, self.since = str(message[1]), now
        elif kind == "opening":
            self.doing, self.name, self.since = "opening", message[1], now
            self.say(f"opening the {OPEN_WORDS[self.job.source]} ({message[1]})")
        elif kind == "opened":
            self.say(f"opened {message[1]} in {float(message[2]):.1f} s")
        elif kind == "planned":
            self.entries, self.total = int(message[1]), int(message[2])
        elif kind == "file":
            if self.doing == "file" and self.name is not None:
                self.file_seconds.append((self.name, now - self.since))
            _, index, total, name = message
            self.doing, self.index, self.total, self.name, self.since = "file", int(index), int(total), name, now
            self.say(f"{FILE_WORDS[self.job.source]} {self.index + 1} of {self.total} ({name})")

    def beat(self) -> None:
        """Say that the reader is still at work, when it has said nothing for `heartbeat` seconds."""
        now = self.clock()
        if self.heartbeat <= 0 or now - self.last_said < self.heartbeat:
            return
        seconds = round(now - self.since)
        if self.doing == "file":
            what = f"still reading {self.name} ({FILE_WORDS[self.job.source]} {self.index + 1} of {self.total})"
        elif self.doing == "opening":
            what = f"still opening the {OPEN_WORDS[self.job.source]} ({self.name})"
        else:
            seconds = round(now - self.started_reader)
            what = "still starting the file reader"
            if self.stage:
                what += f" ({doing_after(self.stage)})"
        self.say(f"{what}, {seconds} s")

    def timed_out(self, limit: float) -> SourceResult:
        """The record of a source stopped at the time limit."""
        result = SourceResult(self.job.source, status="timed-out", time_limit=limit)
        result.seconds = self.clock() - self.started
        result.entries = self.entries
        result.file_seconds = list(self.file_seconds)
        if self.doing == "file":
            result.stopped_on = self.name
            result.files_done = self.index
            result.note = (
                f"Stopped after {limit:g} s while reading {self.name} ({FILE_WORDS[self.job.source]} "
                f"{self.index + 1} of {self.total}), which had taken {round(self.clock() - self.since)} s; "
                f"{self.index} {'file was' if self.index == 1 else 'files were'} done before it."
            )
        else:
            result.stopped_on = f"opening {self.name}" if self.name else "starting"
            result.files_done = 0
            result.note = f"Stopped after {limit:g} s while opening {self.name or 'the files'}; no file was read."
        return result


def doing_after(stage: str | None) -> str:
    """What the reader is doing after the start-up step `stage`: the next step's name."""
    if stage is None:
        return "the program had not begun"
    if stage not in STAGES or stage == STAGES[-1]:
        return f"after {stage}"
    return f"loading {STAGES[STAGES.index(stage) + 1]}"


class WorkerUnavailable(RuntimeError):
    pass


CREATE_NO_WINDOW = 0x08000000


def reader_command() -> tuple[list[str], str]:
    """How to start the reader: this same program with the hidden `reader` command; and a description for the
    report."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "reader"], f"{Path(sys.executable).name} reader (the single-file helper, again)"
    return [sys.executable, "-m", "atlas_gamefiles", "reader"], "python -m atlas_gamefiles reader"


def clean_text(text: str) -> str:
    """`text` with the home folder shortened to `~`, so that a log holds no user name."""
    home = os.path.expanduser("~")
    if home and home not in ("~", "/", "\\"):
        for variant in {home, home.replace("\\", "/"), home.replace("/", "\\")}:
            text = text.replace(variant, "~")
    return text


@dataclass
class ReaderStart:
    """One start of the reader, for the report."""

    stages: dict[str, float] = dataclasses.field(default_factory=dict)  # step: seconds after the start
    seconds: float | None = None  # until ready
    error: str | None = None
    skip_havok: bool = False

    @property
    def last_stage(self) -> str | None:
        return next(reversed(self.stages), None) if self.stages else None

    def to_dict(self) -> dict[str, tp.Any]:
        data: dict[str, tp.Any] = {
            "ok": self.error is None,
            "seconds": round(self.seconds, 2) if self.seconds is not None else None,
            "stages": {name: round(seconds, 2) for name, seconds in self.stages.items()},
            "lastStage": self.last_stage,
        }
        if self.skip_havok:
            data["withoutHavok"] = True
        if self.error:
            data["error"] = self.error
        return data


class ProcessRunner:
    """Reads sources in a file reader process, with a time limit per source; the reader is reused until one is
    stopped."""

    def __init__(
        self,
        time_limit: float = TIME_LIMIT,
        heartbeat: float = HEARTBEAT,
        start_limit: float = START_LIMIT,
        run: str = "",
        poll: float = 0.2,
        folder: Path | None = None,
        reader_options: tp.Sequence[str] = (),
    ):
        """`run` (for tests): another `module:function` for the reader to run each job with. `folder`: where the
        log and the temporary mesh files go (the check passes its output folder; by default a temporary folder,
        removed at the end). `reader_options`: more options for the reader (for tests)."""
        self.time_limit = time_limit
        self.heartbeat = heartbeat
        self.start_limit = start_limit
        self.run_job = run
        self.poll = poll
        self.folder = folder
        self.own_folder: Path | None = None
        self.reader_options = list(reader_options)
        self.process: subprocess.Popen[bytes] | None = None
        self.messages: queue.Queue[tuple[tp.Any, ...]] = queue.Queue()
        self.broken: str | None = None  # the reader cannot start: every source fails with this
        self.havok_broken: str | None = None  # the reader cannot load the Havok reader: only sources needing it fail
        self.starts: list[ReaderStart] = []
        self.troubles = 0  # starts that failed, sources stopped or lost: the report then shows the log's end
        self.jobs = 0
        self.command, self.description = reader_command()

    # --- Where the files go

    def use_folder(self, folder: Path) -> None:
        """Put the log and the temporary mesh files in `folder` (the check's output folder)."""
        if self.process is None and self.own_folder is None:
            self.folder = Path(folder)

    def work_folder(self) -> Path:
        if self.folder is None:
            self.own_folder = self.folder = Path(tempfile.mkdtemp(prefix="atlas-gamefiles-reader-"))
        self.folder.mkdir(parents=True, exist_ok=True)
        return self.folder

    @property
    def log_path(self) -> Path | None:
        return self.folder / READER_LOG if self.folder is not None else None

    def log_tail(self, lines: int = LOG_TAIL_LINES) -> list[str]:
        """The last lines of the reader's log, each cut to 200 characters, with no user name."""
        path = self.log_path
        if path is None or not path.is_file():
            return []
        try:
            with path.open("rb") as file:
                file.seek(max(path.stat().st_size - 16_000, 0))
                text = file.read().decode("utf-8", "replace")
        except OSError:
            return []
        return [clean_text(line)[:200] for line in text.splitlines()[-lines:]]

    def diagnostics(self) -> dict[str, tp.Any]:
        last = self.starts[-1] if self.starts else None
        data: dict[str, tp.Any] = {
            "startedWith": f"{self.description}: a child process with its own pipes"
            + (", no console window" if sys.platform == "win32" else ""),
            "startLimitSeconds": self.start_limit,
            "starts": [start.to_dict() for start in self.starts],
            "startSeconds": round(last.seconds, 2) if last and last.seconds is not None else None,
            "lastStage": last.last_stage if last else None,
            "sources": self.jobs,
            "log": READER_LOG,
        }
        if self.broken:
            data["broken"] = self.broken
        if self.havok_broken:
            data["havokBroken"] = self.havok_broken
        if self.troubles:
            data["logTail"] = self.log_tail()
        return data

    # --- The reader process

    def _environment(self) -> dict[str, str]:
        env = dict(os.environ)
        if not getattr(sys, "frozen", False):
            # The reader imports what this process imports (as multiprocessing's `spawn` would arrange).
            paths = [path for path in sys.path if path and os.path.isdir(path)]
            env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(paths))
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    def _listen(self, process: subprocess.Popen[bytes], messages: queue.Queue[tuple[tp.Any, ...]]) -> None:
        """Puts each line the reader writes into `messages`, then ("eof",)."""
        assert process.stdout is not None
        try:
            for raw in process.stdout:
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue  # not a protocol line (nothing else should write there)
                if isinstance(message, list) and message:
                    messages.put(tuple(message))
        except (OSError, ValueError):
            pass
        messages.put(("eof",))

    def _wait(self, token: tp.Any, watch: Watch, deadline: float | None) -> tuple[tp.Any, ...] | None:
        """The reader's next message; None at the deadline. Raises `Cancelled` (after killing the reader) on
        cancel, and EOFError when the reader has gone."""
        while True:
            if token.cancelled:
                self.kill()
                raise Cancelled()
            now = time.monotonic()
            if deadline is not None and now >= deadline:
                return None
            wait = self.poll if deadline is None else min(self.poll, max(deadline - now, 0.0))
            try:
                message = self.messages.get(timeout=max(wait, 0.001))
            except queue.Empty:
                watch.beat()
                continue
            if message[0] == "eof":
                raise EOFError()
            return message

    def _exit_code(self) -> int | None:
        if self.process is None:
            return None
        try:
            return self.process.wait(5)
        except subprocess.TimeoutExpired:
            return None

    def _start(self, token: tp.Any, watch: Watch) -> None:
        watch.starting_reader()
        folder = self.work_folder()
        record = ReaderStart(skip_havok=self.havok_broken is not None)
        self.starts.append(record)
        command = [*self.command]
        if self.havok_broken is not None:
            command.append("--skip-havok")
        if self.start_limit > 0:
            command += ["--dump-after", f"{max(self.start_limit / 2, 1.0):g}"]
        if self.run_job:
            command += ["--run", self.run_job]
        command += self.reader_options
        started = time.monotonic()
        try:
            with (folder / READER_LOG).open("ab") as log:
                log.write(f"--- reader start {len(self.starts)} ---\n".encode())
                log.flush()
                self.process = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=log,
                    cwd=folder,
                    env=self._environment(),
                    creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                )
        except OSError as error:
            self.process = None
            record.error = self.broken = f"it could not be started ({type(error).__name__}: {error})"
            self.troubles += 1
            raise WorkerUnavailable(self.broken) from error
        self.messages = queue.Queue()
        threading.Thread(
            target=self._listen, args=(self.process, self.messages), name="reader-output", daemon=True
        ).start()
        deadline = started + self.start_limit if self.start_limit > 0 else None
        while True:
            try:
                message = self._wait(token, watch, deadline)
            except EOFError:
                message = ("broken", f"it ended as it started (exit code {self._exit_code()})")
            if message is None:
                message = ("broken", f"it did not start within {self.start_limit:g} s")
            if message[0] == "stage":
                record.stages[str(message[1])] = time.monotonic() - started
                watch.handle(message)
                continue
            break
        if message[0] == "ready":
            record.stages["ready"] = record.seconds = time.monotonic() - started
            return
        self.kill()
        self.troubles += 1
        stage = record.last_stage
        error = str(message[1]) if len(message) > 1 else "it did not start"
        if stage is None:
            error += "; it never reported that it had begun"
        else:
            error += f"; last step done: {stage} ({doing_after(stage)} when it stopped)"
        record.error = error
        if stage == "soulstruct core" and not record.skip_havok:
            # Everything but the Havok reader loaded: the sources that need it fail, the others go on without it.
            self.havok_broken = error
            self._start(token, watch)
            return
        self.broken = error
        raise WorkerUnavailable(error)

    def run(self, job: SourceJob, say: Say, token: tp.Any) -> tuple[SourceResult, np.ndarray]:
        watch = Watch(job, say, self.heartbeat)
        empty = np.zeros((0, 3, 3), dtype=np.float32)
        self.jobs += 1
        if needs_havok(job) and self.havok_broken is not None:
            result = SourceResult(job.source, status="failed")
            result.add_error(f"The file reader process could not load the Havok reader: {self.havok_broken}")
            return result, empty
        mesh_file = self.work_folder() / f"{MESH_PREFIX}{os.getpid()}-{self.jobs}.npy"
        try:
            if self.broken:
                raise WorkerUnavailable(self.broken)
            if self.process is None or self.process.poll() is not None:
                self.kill()
                self._start(token, watch)
            if needs_havok(job) and self.havok_broken is not None:
                raise WorkerUnavailable(f"it could not load the Havok reader: {self.havok_broken}")
            data = job_to_dict(job)
            data["meshFile"] = str(mesh_file)
            if self.time_limit >= 2:  # the log gets the reader's stack shortly before the time limit
                data["dumpAfter"] = max(self.time_limit - 10, self.time_limit * 0.75)
            assert self.process is not None and self.process.stdin is not None
            self.process.stdin.write((json.dumps(data) + "\n").encode())
            self.process.stdin.flush()
        except WorkerUnavailable as error:
            result = SourceResult(job.source, status="failed")
            result.add_error(f"The file reader process could not start: {error}")
            return result, empty
        except (OSError, ValueError, AssertionError) as error:
            self.kill()
            self.troubles += 1
            result = SourceResult(job.source, status="failed")
            result.add_error(f"The file reader process could not be reached: {error}")
            return result, empty
        watch.started = watch.since = time.monotonic()
        deadline = watch.started + self.time_limit if self.time_limit > 0 else None
        try:
            while True:
                try:
                    message = self._wait(token, watch, deadline)
                except EOFError:
                    code = self._exit_code()
                    self.kill()
                    self.troubles += 1
                    result = SourceResult(job.source, status="failed")
                    where = f" while reading {watch.name}" if watch.name else ""
                    result.add_error(f"The file reader process ended unexpectedly{where} (exit code {code})")
                    result.seconds = time.monotonic() - watch.started
                    return result, empty
                if message is None:
                    self.kill()
                    self.troubles += 1
                    return watch.timed_out(self.time_limit), empty
                if message[0] == "result":
                    result = result_from_dict(message[1])
                    mesh = empty
                    if message[2]:
                        mesh = np.load(message[2], allow_pickle=False)
                    return result, mesh
                if message[0] == "error":
                    result = SourceResult(job.source, status="failed")
                    result.add_error(str(message[1]))
                    result.seconds = time.monotonic() - watch.started
                    return result, empty
                watch.handle(message)
        finally:
            mesh_file.unlink(missing_ok=True)

    def kill(self) -> None:
        """End the reader at once."""
        process = self.process
        self.process = None
        if process is None:
            return
        if process.stdin is not None:
            try:
                process.stdin.close()  # the reader ends on its own when its standard input ends
            except OSError:
                pass
        if process.poll() is None:
            process.kill()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            pass
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass

    def close(self) -> None:
        """Let the reader go (it is between sources: closing its standard input ends it); kill it if it does not."""
        process = self.process
        if process is not None and process.poll() is None and process.stdin is not None:
            try:
                process.stdin.close()
                process.wait(5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        self.kill()
        if self.folder is not None:
            for leftover in self.folder.glob(f"{MESH_PREFIX}{os.getpid()}-*.npy"):
                leftover.unlink(missing_ok=True)
        if self.own_folder is not None:
            shutil.rmtree(self.own_folder, ignore_errors=True)
            self.own_folder = None


class InlineFeedback(Feedback):
    """In this process: progress to the watch, and cancel between files."""

    def __init__(self, watch: Watch, token: tp.Any):
        self.watch, self.token = watch, token

    def opening(self, name: str) -> None:
        self.token.stop()
        self.watch.handle(("opening", name))

    def opened(self, name: str, seconds: float) -> None:
        self.watch.handle(("opened", name, seconds))

    def planned(self, entries: int, chosen: int) -> None:
        self.watch.handle(("planned", entries, chosen))

    def file(self, index: int, total: int, name: str) -> None:
        self.token.stop()
        self.watch.handle(("file", index, total, name))


class InlineRunner:
    """Reads sources in this process, without a time limit: for tests that replace a reader with a mock (a mock
    does not reach another process)."""

    def __init__(self, run: Execute = execute):
        self.run_job = run

    def use_folder(self, folder: Path) -> None:
        pass

    def diagnostics(self) -> dict[str, tp.Any]:
        return {"startedWith": "in the helper's own process (tests)"}

    def run(self, job: SourceJob, say: Say, token: tp.Any) -> tuple[SourceResult, np.ndarray]:
        watch = Watch(job, say, heartbeat=0)
        return self.run_job(job, InlineFeedback(watch, token))

    def close(self) -> None:
        pass


Runner = tp.Union[ProcessRunner, InlineRunner]
