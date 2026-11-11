"""Reading an area's geometry in a child process, with a time limit, so that no file can hang the whole check.

Real game files may parse slowly in pure Python, and a parser may never finish on data it does not expect. So the
check reads each geometry source (collision, navmesh, map pieces) of each area in a child process: one child at a
time, reused from source to source until one has to be stopped. The parent keeps watching it:

- progress: the child says before it opens a binder and before each file. While it says nothing for `heartbeat`
  seconds, the parent reports that it is still on that file, with the seconds so far, so the window never sits on
  one message;
- a time limit: a source still running after `time_limit` seconds is stopped. The child is killed, the source is
  recorded as `timed-out` with the file it was on and how many files it got through, and the check goes on with
  the next source (in a new child);
- cancel: kills the child at once.

The child applies the helper's promises before it reads anything: no network (`block_network`), and Soulstruct
imported with `prepare_soulstruct`. It is started with multiprocessing's `spawn` method on every system, which
also works in the single-file executable, as its entry point calls `multiprocessing.freeze_support()`. It ends
itself when its parent goes away.

Only the result comes back, with the area's triangles for the preview capped at `preview_limit` (an evenly spaced
selection), so the pipe never carries a whole area's mesh.
"""

from __future__ import annotations

import multiprocessing
import os
import sys
import threading
import time
import typing as tp
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .games import PROFILES, Area
from .geometry import Cancelled, Feedback, Instances, SourceResult, read_collision, read_map_pieces, read_navmesh
from .safety import block_network, prepare_soulstruct

# Defaults, overridable on the command line (see cli.py).
TIME_LIMIT = 90.0  # seconds one source of one area may take before its child is stopped
HEARTBEAT = 5.0  # seconds of silence before saying "still reading ..."
START_LIMIT = 180.0  # seconds the child may take to start (unpacking and importing Soulstruct)
PREVIEW_LIMIT = 200_000  # triangles per source sent back for the preview

# How each source names what it reads, for the progress lines.
FILE_WORDS = {"collision": "collision file", "navmesh": "navmesh file", "mapPieces": "model"}
OPEN_WORDS = {"collision": "collision files", "navmesh": "navmesh files", "mapPieces": "map piece models"}

Say = tp.Callable[[float, str], None]
"""Progress for the check: how far through the source (0 to 1), and what is happening."""


@dataclass(frozen=True)
class SourceJob:
    """One geometry source of one area, as the child reads it. Everything here can be pickled."""

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


# --- The child ---------------------------------------------------------------------------------------------------


class PipeFeedback(Feedback):
    """In the child: every step goes to the parent at once."""

    def __init__(self, conn: tp.Any):
        self.conn = conn

    def opening(self, name: str) -> None:
        self.conn.send(("opening", name))

    def planned(self, entries: int, chosen: int) -> None:
        self.conn.send(("planned", entries, chosen))

    def file(self, index: int, total: int, name: str) -> None:
        self.conn.send(("file", index, total, name))


def _end_with_parent() -> None:
    """Exit as soon as the parent has gone, even in the middle of a file (a killed helper leaves no reader behind)."""
    parent = multiprocessing.parent_process()
    if parent is None:
        return

    def watch() -> None:
        parent.join()
        os._exit(1)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def worker_main(conn: tp.Any, run: Execute = execute) -> None:
    """The child's loop: read jobs from `conn`, answer each with a result or an error, until told to stop."""
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:  # no console (a window app started the helper)
            setattr(sys, name, open(os.devnull, "w"))
    block_network()
    _end_with_parent()
    try:
        prepare_soulstruct()
    except BaseException as error:
        conn.send(("broken", f"{type(error).__name__}: {error}"))
        return
    conn.send(("ready",))
    feedback = PipeFeedback(conn)
    while True:
        try:
            job = conn.recv()
        except (EOFError, OSError):
            return
        if job is None:
            return
        try:
            result, mesh = run(job, feedback)
        except Exception as error:  # a reader bug must not end the child; the parent records it
            conn.send(("error", f"{type(error).__name__}: {error}"))
        else:
            conn.send(("result", result, mesh))


# --- The parent --------------------------------------------------------------------------------------------------


class Watch:
    """Turns the child's messages into progress lines, and remembers where it is, for a heartbeat or a time-out."""

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
        self.file_seconds: list[tuple[str, float]] = []

    @property
    def within(self) -> float:
        return max(self.index, 0) / self.total if self.total else 0.0

    def say(self, text: str) -> None:
        self.last_said = self.clock()
        self.say_to(self.within, text)

    def starting_reader(self) -> None:
        self.doing, self.since = "starting", self.clock()
        self.say("starting the file reader")

    def handle(self, message: tuple[tp.Any, ...]) -> None:
        kind = message[0]
        now = self.clock()
        if kind == "opening":
            self.doing, self.name, self.since = "opening", message[1], now
            self.say(f"opening the {OPEN_WORDS[self.job.source]} ({message[1]})")
        elif kind == "planned":
            self.entries, self.total = int(message[1]), int(message[2])
        elif kind == "file":
            if self.doing == "file" and self.name is not None:
                self.file_seconds.append((self.name, now - self.since))
            _, index, total, name = message
            self.doing, self.index, self.total, self.name, self.since = "file", int(index), int(total), name, now
            self.say(f"{FILE_WORDS[self.job.source]} {self.index + 1} of {self.total} ({name})")

    def beat(self) -> None:
        """Say that the child is still at work, when it has said nothing for `heartbeat` seconds."""
        now = self.clock()
        if self.heartbeat <= 0 or now - self.last_said < self.heartbeat:
            return
        seconds = round(now - self.since)
        if self.doing == "file":
            what = f"still reading {self.name} ({FILE_WORDS[self.job.source]} {self.index + 1} of {self.total})"
        elif self.doing == "opening":
            what = f"still opening the {OPEN_WORDS[self.job.source]} ({self.name})"
        else:
            what = "still starting the file reader"
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


class WorkerUnavailable(RuntimeError):
    pass


class ProcessRunner:
    """Reads sources in a child process, with a time limit per source; the child is reused until one is stopped."""

    def __init__(
        self,
        time_limit: float = TIME_LIMIT,
        heartbeat: float = HEARTBEAT,
        start_limit: float = START_LIMIT,
        run: Execute = execute,
        poll: float = 0.2,
    ):
        self.time_limit = time_limit
        self.heartbeat = heartbeat
        self.start_limit = start_limit
        self.run_job = run
        self.poll = poll
        self.context = multiprocessing.get_context("spawn")
        self.process: tp.Any = None
        self.conn: tp.Any = None
        self.broken: str | None = None

    def _wait(self, token: tp.Any, watch: Watch, deadline: float | None) -> tuple[tp.Any, ...] | None:
        """The child's next message; None at the deadline. Raises `Cancelled` (after killing the child) on cancel,
        and EOFError when the child has gone."""
        while True:
            if token.cancelled:
                self.kill()
                raise Cancelled()
            now = time.monotonic()
            if deadline is not None and now >= deadline:
                return None
            wait = self.poll if deadline is None else min(self.poll, max(deadline - now, 0.0))
            if self.conn.poll(wait):
                return self.conn.recv()
            if not self.process.is_alive() and not self.conn.poll(0):
                raise EOFError()
            watch.beat()

    def _start(self, token: tp.Any, watch: Watch) -> None:
        watch.starting_reader()
        parent_end, child_end = self.context.Pipe()
        process = self.context.Process(
            target=worker_main, args=(child_end, self.run_job), name="atlas-gamefiles-reader", daemon=True
        )
        process.start()
        child_end.close()
        self.process, self.conn = process, parent_end
        deadline = time.monotonic() + self.start_limit if self.start_limit > 0 else None
        try:
            message = self._wait(token, watch, deadline)
        except EOFError:
            message = ("broken", f"it ended at once (exit code {self.process.exitcode})")
        if message is None:
            self.kill()
            message = ("broken", f"it did not start within {self.start_limit:g} s")
        if message[0] != "ready":
            self.kill()
            self.broken = str(message[1]) if len(message) > 1 else "it did not start"
            raise WorkerUnavailable(self.broken)

    def run(self, job: SourceJob, say: Say, token: tp.Any) -> tuple[SourceResult, np.ndarray]:
        watch = Watch(job, say, self.heartbeat)
        empty = np.zeros((0, 3, 3), dtype=np.float32)
        try:
            if self.broken:
                raise WorkerUnavailable(self.broken)
            if self.process is None or not self.process.is_alive():
                self.kill()
                self._start(token, watch)
            self.conn.send(job)
        except WorkerUnavailable as error:
            result = SourceResult(job.source, status="failed")
            result.add_error(f"The file reader process could not start: {error}")
            return result, empty
        except (BrokenPipeError, EOFError, OSError) as error:
            self.kill()
            result = SourceResult(job.source, status="failed")
            result.add_error(f"The file reader process could not be reached: {error}")
            return result, empty
        watch.started = watch.since = time.monotonic()
        deadline = watch.started + self.time_limit if self.time_limit > 0 else None
        while True:
            try:
                message = self._wait(token, watch, deadline)
            except (EOFError, OSError):
                code = self.process.exitcode if self.process is not None else None
                self.kill()
                result = SourceResult(job.source, status="failed")
                where = f" while reading {watch.name}" if watch.name else ""
                result.add_error(f"The file reader process ended unexpectedly{where} (exit code {code})")
                result.seconds = time.monotonic() - watch.started
                return result, empty
            if message is None:
                self.kill()
                return watch.timed_out(self.time_limit), empty
            if message[0] == "result":
                return message[1], message[2]
            if message[0] == "error":
                result = SourceResult(job.source, status="failed")
                result.add_error(str(message[1]))
                result.seconds = time.monotonic() - watch.started
                return result, empty
            watch.handle(message)

    def kill(self) -> None:
        """End the child at once."""
        process, conn = self.process, self.conn
        self.process = self.conn = None
        if process is not None:
            if process.is_alive():
                process.kill()
            process.join(10)
        if conn is not None:
            conn.close()

    def close(self) -> None:
        """Let the child finish (it is between jobs) and go; kill it if it does not."""
        if self.process is not None and self.process.is_alive() and self.conn is not None:
            try:
                self.conn.send(None)
                self.process.join(5)
            except (BrokenPipeError, OSError):
                pass
        self.kill()


class InlineFeedback(Feedback):
    """In this process: progress to the watch, and cancel between files."""

    def __init__(self, watch: Watch, token: tp.Any):
        self.watch, self.token = watch, token

    def opening(self, name: str) -> None:
        self.token.stop()
        self.watch.handle(("opening", name))

    def planned(self, entries: int, chosen: int) -> None:
        self.watch.handle(("planned", entries, chosen))

    def file(self, index: int, total: int, name: str) -> None:
        self.token.stop()
        self.watch.handle(("file", index, total, name))


class InlineRunner:
    """Reads sources in this process, without a time limit: for tests that replace a reader with a mock (a mock
    does not reach a child process)."""

    def __init__(self, run: Execute = execute):
        self.run_job = run

    def run(self, job: SourceJob, say: Say, token: tp.Any) -> tuple[SourceResult, np.ndarray]:
        watch = Watch(job, say, heartbeat=0)
        return self.run_job(job, InlineFeedback(watch, token))

    def close(self) -> None:
        pass


Runner = tp.Union[ProcessRunner, InlineRunner]
