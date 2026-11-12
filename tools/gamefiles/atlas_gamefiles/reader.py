"""The file reader process: `atlas-gamefiles reader`, started by the helper itself (worker.py), never by a person.

It is the same program as the helper (the single-file executable, or `python -m atlas_gamefiles`), started as a
plain child process with its own pipes: jobs come in on standard input, one JSON object per line; progress and
results go out on standard output, one JSON array per line; standard error goes to a log file in the output folder.
The triangles of a result come back in a temporary `.npy` file that the helper names in the job, reads and deletes.

What it says, in order:

- `["stage", name]` for each start-up step done: `booted` (this module runs), `numpy`, `soulstruct core`
  (Soulstruct imported with `prepare_soulstruct`), `soulstruct.havok` (the Havok reader imported; skipped with
  `--skip-havok`), then `["ready"]`, or `["broken", message]` when a step failed;
- per job: `["opening", binder]`, `["opened", binder, seconds]`, `["planned", entries, chosen]`,
  `["file", index, total, name]`, then `["result", result, mesh file or null]` or `["error", message]`.

It reads nothing from the network (`block_network`), and ends as soon as its standard input ends, which happens when
the helper closes it or goes away, even in the middle of a file. While starting, and while a job runs longer than
the helper asked (`dumpAfter`), it writes where it is (every thread's stack) to the log, so a report of a hang says
where it hung.

Only the standard library is imported before `booted`, so that step shows that the program itself started.
"""

from __future__ import annotations

import argparse
import faulthandler
import json
import logging
import os
import queue
import sys
import threading
import time
import traceback
import typing as tp

from . import __version__

STAGES = ("booted", "numpy", "soulstruct core", "soulstruct.havok", "ready")


class Out:
    """The reader's standard output: one JSON array per line, flushed at once."""

    def __init__(self, stream: tp.TextIO):
        self.stream = stream
        self.lock = threading.Lock()

    def send(self, *message: tp.Any) -> None:
        line = json.dumps(list(message), separators=(",", ":"), default=str)
        with self.lock:
            self.stream.write(line + "\n")
            self.stream.flush()


def log(text: str) -> None:
    """A short line in the log (standard error)."""
    try:
        sys.stderr.write(f"[reader {time.strftime('%H:%M:%S')}] {text}\n")
        sys.stderr.flush()
    except (AttributeError, OSError, ValueError):
        pass


def _read_jobs(fd: int | None, jobs: queue.Queue[str]) -> None:
    """Puts each line of standard input into `jobs`; ends this process when standard input ends."""
    from .events import stdin_lines

    try:
        if fd is not None:
            for line in stdin_lines(fd):
                if line.strip():
                    jobs.put(line)
    except (OSError, ValueError):
        pass
    log("standard input ended: stopping")
    os._exit(0)


def _stall(stage: str, at: str) -> None:
    """For tests only: never finish the step `at`."""
    if stage == at:
        log(f"stalling at {stage} (test)")
        time.sleep(3600)


def _load(target: str) -> tp.Callable[..., tp.Any]:
    module_name, _, name = target.partition(":")
    import importlib

    return getattr(importlib.import_module(module_name), name)


def main(argv: list[str]) -> int:
    started = time.monotonic()
    options = argparse.ArgumentParser(prog="atlas-gamefiles reader", add_help=False)
    options.add_argument("--skip-havok", action="store_true")
    options.add_argument("--dump-after", type=float, default=0.0)
    # For tests (ignored in the single-file executable): another `module:function` to run each job, and a step at
    # which to stall.
    options.add_argument("--run", default="")
    options.add_argument("--test-stall-at", default="")
    args = options.parse_args(argv)
    frozen = bool(getattr(sys, "frozen", False))
    stall_at = "" if frozen else args.test_stall_at

    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, "w"))
    try:
        sys.stderr.reconfigure(errors="replace")  # type: ignore[union-attr]
    except AttributeError:
        pass
    from .events import claim_stdin, claim_stdout_stream

    out = Out(claim_stdout_stream())
    jobs: queue.Queue[str] = queue.Queue()
    threading.Thread(target=_read_jobs, args=(claim_stdin(), jobs), name="jobs", daemon=True).start()
    log(f"atlas-gamefiles {__version__} reader started (process {os.getpid()}, Python {sys.version.split()[0]})")
    try:
        faulthandler.enable(sys.stderr)
        if args.dump_after > 0:
            faulthandler.dump_traceback_later(args.dump_after, repeat=True)
    except (AttributeError, OSError, ValueError, RuntimeError):
        pass

    def stage(name: str) -> None:
        log(f"{name}: {time.monotonic() - started:.2f} s")
        out.send("stage", name)

    try:
        stage("booted")
        _stall("numpy", stall_at)
        import numpy as np

        stage("numpy")
        _stall("soulstruct core", stall_at)
        from .safety import block_network, prepare_soulstruct

        block_network()
        prepare_soulstruct()
        # Soulstruct logs each file it cannot read, with a traceback; the report has the errors already, so only
        # what is worse goes to the log.
        logging.getLogger("soulstruct").setLevel(logging.CRITICAL)
        from soulstruct.containers import Binder  # noqa: F401

        from .worker import cap_triangles, execute, job_from_dict, result_to_dict

        stage("soulstruct core")
        if not args.skip_havok:
            _stall("soulstruct.havok", stall_at)
            from soulstruct.havok.core import HKX  # noqa: F401
            from soulstruct.havok.fromsoft.shared.map_collision import MapCollisionModel  # noqa: F401

            stage("soulstruct.havok")
        run = _load(args.run) if args.run and not frozen else execute
    except BaseException as error:
        log("start-up failed:\n" + traceback.format_exc())
        out.send("broken", f"{type(error).__name__}: {error}")
        return 1
    try:
        faulthandler.cancel_dump_traceback_later()
    except (AttributeError, RuntimeError):
        pass
    log(f"ready: {time.monotonic() - started:.2f} s")
    out.send("ready")

    from .geometry import Feedback

    class PipeFeedback(Feedback):
        def opening(self, name: str) -> None:
            out.send("opening", name)

        def opened(self, name: str, seconds: float) -> None:
            out.send("opened", name, round(seconds, 3))

        def planned(self, entries: int, chosen: int) -> None:
            out.send("planned", entries, chosen)

        def file(self, index: int, total: int, name: str) -> None:
            out.send("file", index, total, name)

    feedback = PipeFeedback()
    while True:
        data = json.loads(jobs.get())
        job = job_from_dict(data)
        what = f"{job.source} {job.area.id}"
        log(f"{what}: start")
        dump_after = float(data.get("dumpAfter") or 0)
        if dump_after > 0:
            faulthandler.dump_traceback_later(dump_after, repeat=True)
        job_started = time.monotonic()
        try:
            result, mesh = run(job, feedback)
        except Exception as error:  # a reader bug must not end the reader; the helper records it
            log(f"{what}: failed\n" + traceback.format_exc(limit=8))
            out.send("error", f"{type(error).__name__}: {error}")
            continue
        finally:
            if dump_after > 0:
                faulthandler.cancel_dump_traceback_later()
        mesh = np.asarray(mesh, dtype=np.float32).reshape(-1, 3, 3)
        owners = result.owners_array()
        if len(owners) != len(mesh):
            mesh = cap_triangles(mesh, job.preview_limit)
            owners = owners[:0]
        mesh_file = data.get("meshFile") if len(mesh) else None
        if mesh_file:
            np.save(mesh_file, mesh, allow_pickle=False)
        owners_file = data.get("ownersFile") if len(owners) else None
        if owners_file:
            np.save(owners_file, owners.astype(np.int32), allow_pickle=False)
        log(f"{what}: {result.status} in {time.monotonic() - job_started:.2f} s")
        out.send("result", result_to_dict(result), mesh_file, owners_file)
