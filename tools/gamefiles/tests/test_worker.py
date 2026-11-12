"""Reading geometry in the file reader process: its start-up steps, the start and source time limits, the heartbeat,
cancel, a reader that crashes, and a reader whose parent goes away. The readers here are made up (fake_readers.py);
test_check.py runs the real ones through the same reader process."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest

from atlas_gamefiles.check import CancelToken, Checker
from atlas_gamefiles.events import Events
from atlas_gamefiles.games import PROFILES, Area, list_areas
from atlas_gamefiles.geometry import Cancelled
from atlas_gamefiles.events import stdin_lines
from atlas_gamefiles.geometry import SourceResult
from atlas_gamefiles.reader import STAGES
from atlas_gamefiles.worker import (
    ProcessRunner,
    SourceJob,
    cap_triangles,
    job_from_dict,
    job_to_dict,
    result_from_dict,
    result_to_dict,
)

DSR = "dark-souls-remastered"
FAKE = "fake_readers:scripted"
HERE = Path(__file__).resolve().parent


def alive(process) -> bool:
    return process is not None and process.poll() is None


def job(behaviour: str, tmp_path: Path, source: str = "collision", **options) -> SourceJob:
    area = Area(id=behaviour, name=behaviour, msb=tmp_path / "made-up.msb", map_folder=tmp_path)
    return SourceJob(source, DSR, area, tmp_path, {}, **options)


class Said:
    def __init__(self) -> None:
        self.lines: list[tuple[float, str]] = []

    def __call__(self, within: float, text: str) -> None:
        self.lines.append((within, text))

    def texts(self) -> list[str]:
        return [text for _, text in self.lines]


@pytest.fixture
def runner():
    made = ProcessRunner(time_limit=2.0, heartbeat=0.3, run=FAKE)
    yield made
    made.close()


def test_a_stuck_file_times_out_and_the_next_source_goes_on(runner: ProcessRunner, tmp_path: Path) -> None:
    said = Said()
    started = time.monotonic()
    result, mesh = runner.run(job("stuck", tmp_path), said, CancelToken())
    elapsed = time.monotonic() - started
    assert runner.process is None, "the stuck child was killed"
    assert result.status == "timed-out"
    assert elapsed < 30
    report = result.to_dict()
    assert report["stoppedOn"] == "stuck.hkx.dcx"
    assert report["filesDone"] == 1
    assert report["entries"] == 5
    assert report["timeLimitSeconds"] == 2.0
    assert report["fileSeconds"]["files"] == 1
    assert report["slowestFile"] == "quick.hkx.dcx"
    assert "stuck.hkx.dcx (collision file 2 of 3)" in report["note"]
    assert len(mesh) == 0
    tail = runner.diagnostics()["logTail"]
    assert any("fake_readers.py" in line and "scripted" in line for line in tail), "the log says where it hung"

    texts = said.texts()
    assert "opening the collision files (h99_00_00_00.hkxbhd)" in texts
    assert "collision file 2 of 3 (stuck.hkx.dcx)" in texts
    beats = [text for text in texts if text.startswith("still reading stuck.hkx.dcx (collision file 2 of 3), ")]
    assert len(beats) >= 3, texts
    assert beats[-1].endswith(" s")

    # The next source gets a new child and is read.
    result, mesh = runner.run(job("fine", tmp_path), Said(), CancelToken())
    assert result.status == "ok"
    assert mesh.shape == (10, 3, 3)
    assert alive(runner.process)


def test_opening_that_never_ends_times_out(runner: ProcessRunner, tmp_path: Path) -> None:
    said = Said()
    result, _ = runner.run(job("stuck-opening", tmp_path), said, CancelToken())
    assert result.status == "timed-out"
    assert result.to_dict()["stoppedOn"] == "opening h99_00_00_00.hkxbhd"
    assert any(text.startswith("still opening the collision files (h99_00_00_00.hkxbhd), ") for text in said.texts())


def test_cancel_kills_the_child_at_once(runner: ProcessRunner, tmp_path: Path) -> None:
    token = CancelToken()
    children = []

    def say(within: float, text: str) -> None:
        if "stuck.hkx.dcx" in text:
            children.append(runner.process)
            token.cancel()

    started = time.monotonic()
    with pytest.raises(Cancelled):
        runner.run(job("stuck", tmp_path), say, token)
    assert time.monotonic() - started < 15
    (child,) = children
    assert not alive(child) and child.returncode is not None
    assert runner.process is None


def test_a_crashing_child_fails_one_source_only(runner: ProcessRunner, tmp_path: Path) -> None:
    result, _ = runner.run(job("crash", tmp_path), Said(), CancelToken())
    assert result.status == "failed"
    assert result.errors == ["The file reader process ended unexpectedly while reading made-up.hkx (exit code 5)"]
    result, _ = runner.run(job("error", tmp_path), Said(), CancelToken())
    assert result.status == "failed"
    assert result.errors == ["ValueError: made-up bad data"]
    child = runner.process
    result, _ = runner.run(job("fine", tmp_path), Said(), CancelToken())
    assert result.status == "ok"
    assert runner.process is child, "a reader error does not cost a new child"


def test_the_real_reader_in_the_child(dsr_folder: Path) -> None:
    profile = PROFILES[DSR]
    area = list_areas(profile, dsr_folder)[0]
    instances = {"h0000B1": [((5.0, 0.0, 0.0), (0.0, 90.0, 0.0))]}
    runner = ProcessRunner(time_limit=120, heartbeat=1)
    try:
        said = Said()
        result, mesh = runner.run(SourceJob("collision", DSR, area, dsr_folder, instances), said, CancelToken())
        assert result.status == "ok", result.errors
        assert mesh.shape == (3, 3, 3)
        assert np.isclose(mesh[:, :, 0].max(), 45)
        assert said.texts()[-1] == "collision file 2 of 2 (h0001B1A10.hkx.dcx)"
        capped, mesh = runner.run(
            SourceJob("collision", DSR, area, dsr_folder, instances, preview_limit=2), Said(), CancelToken()
        )
        assert capped.triangles == 6 and mesh.shape == (2, 3, 3)
    finally:
        runner.close()


def test_cap_triangles() -> None:
    mesh = np.arange(100 * 9, dtype=np.float32).reshape(100, 3, 3)
    assert cap_triangles(mesh, 0) is mesh
    capped = cap_triangles(mesh, 10)
    assert capped.shape == (10, 3, 3)
    assert (capped[0] == mesh[0]).all() and (capped[-1] == mesh[-1]).all()


def test_a_stuck_source_does_not_hang_the_check(dsr_folder: Path, tmp_path: Path) -> None:
    """The whole check, with the collision reader stuck in every area: the check still ends with a report."""
    stream = io.StringIO()
    runner = ProcessRunner(time_limit=1.5, heartbeat=0.3, run=FAKE)
    original_run = runner.run

    def run(job: SourceJob, say, token):
        # Every area behaves as "stuck-collision": collision never ends, the other sources read.
        area = Area(id="stuck-collision", name=job.area.name, msb=job.area.msb, map_folder=job.area.map_folder)
        fake = SourceJob(job.source, job.game, area, job.root, job.instances, job.sample, job.budget)
        return original_run(fake, say, token)

    runner.run = run  # type: ignore[method-assign]
    report = Checker(dsr_folder, tmp_path / "out", Events(stream), runner=runner).run()
    events = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert events[-1]["event"] == "done"
    for area in report["areas"]:
        assert area["geometry"]["collision"]["status"] == "timed-out"
        assert area["geometry"]["navmesh"]["status"] == "ok"
    assert report["summary"]["geometry"]["collision"]["timed-out"] == 2
    assert report["summary"]["recommendedGeometry"] == "navmesh"
    assert any("was stopped after 1.5 s (stuck.hkx.dcx)" in warning for warning in report["warnings"])
    assert report["options"]["sourceTimeLimitSeconds"] == 1.5
    messages = [e["message"] for e in events if e["event"] == "progress"]
    assert any("still reading stuck.hkx.dcx" in message for message in messages)
    fractions = [e["fraction"] for e in events if e["event"] == "progress"]
    assert fractions == sorted(fractions), "progress only moves forward"


def test_cancelling_the_check_while_a_file_is_stuck(dsr_folder: Path, tmp_path: Path) -> None:
    token = CancelToken()
    stream = io.StringIO()
    events = Events(stream)
    runner = ProcessRunner(time_limit=600, heartbeat=0.2, run=FAKE)
    original_run = runner.run
    children = []

    def run(job: SourceJob, say, token_):
        area = Area(id="stuck", name=job.area.name, msb=job.area.msb, map_folder=job.area.map_folder)
        return original_run(SourceJob(job.source, job.game, area, job.root, job.instances), say, token_)

    runner.run = run  # type: ignore[method-assign]
    original_emit = events.emit

    def emit(event: str, **fields) -> None:
        original_emit(event, **fields)
        if event == "progress" and "still reading" in fields["message"] and not token.cancelled:
            children.append(runner.process)
            token.cancel()

    events.emit = emit  # type: ignore[method-assign]
    started = time.monotonic()
    with pytest.raises(Cancelled):
        Checker(dsr_folder, tmp_path / "out", events, token=token, runner=runner).run()
    assert time.monotonic() - started < 60
    (child,) = children
    assert not alive(child)
    assert runner.process is None
    assert not (tmp_path / "out" / "report.json").exists()


def test_start_up_steps_are_reported(tmp_path: Path) -> None:
    runner = ProcessRunner(run=FAKE, folder=tmp_path / "out")
    try:
        said = Said()
        result, mesh = runner.run(job("fine", tmp_path), said, CancelToken())
        assert result.status == "ok" and mesh.shape == (10, 3, 3)
        assert said.texts()[0] == "starting the file reader"
        (start,) = runner.starts
        assert list(start.stages) == list(STAGES)
        diagnostics = runner.diagnostics()
        assert diagnostics["lastStage"] == "ready"
        assert 0 < diagnostics["startSeconds"] < 60
        assert diagnostics["starts"][0]["ok"] is True
        assert "logTail" not in diagnostics
        assert not list((tmp_path / "out").glob("reader-mesh-*")), "the mesh file was deleted once read"
        log = (tmp_path / "out" / "reader-log.txt").read_text(encoding="utf-8")
        for stage in STAGES:
            assert f"] {stage}: " in log
        assert "collision fine: ok in " in log
    finally:
        runner.close()


def test_a_reader_that_does_not_start_says_where_it_stopped(tmp_path: Path) -> None:
    runner = ProcessRunner(
        start_limit=4, heartbeat=0.3, run=FAKE, folder=tmp_path, reader_options=["--test-stall-at", "numpy"]
    )
    try:
        said = Said()
        started = time.monotonic()
        result, _ = runner.run(job("fine", tmp_path), said, CancelToken())
        assert time.monotonic() - started < 30
        assert result.status == "failed"
        assert result.errors == [
            "The file reader process could not start: it did not start within 4 s; "
            "last step done: booted (loading numpy when it stopped)"
        ]
        assert any(text.startswith("still starting the file reader (loading numpy), ") for text in said.texts())
        assert runner.process is None, "the reader that did not start was killed"
        diagnostics = runner.diagnostics()
        assert diagnostics["lastStage"] == "booted"
        assert diagnostics["startSeconds"] is None
        assert diagnostics["broken"].startswith("it did not start within 4 s")
        tail = diagnostics["logTail"]
        assert any("stalling at numpy" in line for line in tail)
        assert any("in _stall" in line for line in tail), "the stack of the stuck start-up is in the log"

        # The next source does not wait again.
        started = time.monotonic()
        result, _ = runner.run(job("fine", tmp_path, source="navmesh"), Said(), CancelToken())
        assert result.status == "failed" and time.monotonic() - started < 1
        assert len(runner.starts) == 1
    finally:
        runner.close()


def test_a_reader_that_cannot_load_havok_still_reads_navmesh(tmp_path: Path) -> None:
    runner = ProcessRunner(
        start_limit=4, heartbeat=0, run=FAKE, folder=tmp_path, reader_options=["--test-stall-at", "soulstruct.havok"]
    )
    try:
        result, _ = runner.run(job("fine", tmp_path), Said(), CancelToken())
        assert result.status == "failed"
        assert "could not load the Havok reader" in result.errors[0]
        assert "last step done: soulstruct core (loading soulstruct.havok when it stopped)" in result.errors[0]
        result, mesh = runner.run(job("fine", tmp_path, source="navmesh"), Said(), CancelToken())
        assert result.status == "ok" and len(mesh) == 10
        first, second = runner.starts
        assert first.error and not first.skip_havok
        assert second.error is None and second.skip_havok
        assert list(second.stages) == ["booted", "numpy", "soulstruct core", "ready"]
        diagnostics = runner.diagnostics()
        assert diagnostics["havokBroken"] == first.error
        assert "broken" not in diagnostics
    finally:
        runner.close()


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import _winapi

        try:
            handle = _winapi.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        except OSError:
            return False
        try:
            return _winapi.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: still running
        finally:
            _winapi.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = Path(f"/proc/{pid}/stat")
    try:
        return stat.read_text().rsplit(")", 1)[1].split()[0] != "Z"  # a zombie has ended
    except OSError:
        return True  # no /proc (not Linux): os.kill found it


PARENT = """
import os, sys
sys.path[:0] = [{package!r}, {tests!r}]
from pathlib import Path
from atlas_gamefiles.check import CancelToken
from atlas_gamefiles.games import Area
from atlas_gamefiles.worker import ProcessRunner, SourceJob

folder = Path({folder!r})
runner = ProcessRunner(time_limit=0, heartbeat=0, run="fake_readers:scripted", folder=folder)

def say(within, text):
    if "stuck.hkx.dcx" in text:
        print(runner.process.pid, flush=True)
        os._exit(0)  # the helper goes away while the reader is stuck in a file

area = Area(id="stuck", name="stuck", msb=folder / "made-up.msb", map_folder=folder)
runner.run(SourceJob("collision", "dark-souls-remastered", area, folder, {{}}), say, CancelToken())
"""


def test_the_reader_ends_with_its_parent(tmp_path: Path) -> None:
    script = PARENT.format(package=str(HERE.parent), tests=str(HERE), folder=str(tmp_path))
    parent = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL
    )
    assert parent.returncode == 0, parent.stderr
    pid = int(parent.stdout.strip())
    deadline = time.monotonic() + 15
    while pid_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.2)
    assert not pid_alive(pid), "the reader ended when its parent went away"
    assert "standard input ended: stopping" in (tmp_path / "reader-log.txt").read_text(encoding="utf-8")


def test_stdin_lines_reads_a_pipe_to_its_end() -> None:
    read_fd, write_fd = os.pipe()

    def write() -> None:
        for chunk in (b"cancel\nab", b"c\r\n", b"last"):
            os.write(write_fd, chunk)
            time.sleep(0.3)
        os.close(write_fd)

    import threading

    writer = threading.Thread(target=write)
    writer.start()
    try:
        assert list(stdin_lines(read_fd, poll=0.05)) == ["cancel", "abc", "last"]
    finally:
        writer.join()
        os.close(read_fd)


CLAIM = """
import os, sys
sys.path.insert(0, {package!r})
from atlas_gamefiles.events import claim_stdin, stdin_lines
private = claim_stdin()
print(repr(os.read(0, 100)))  # standard input is now the null device: nothing to read
print(list(stdin_lines(private)))
"""


def test_claim_stdin_keeps_the_pipe_for_this_process() -> None:
    result = subprocess.run(
        [sys.executable, "-c", CLAIM.format(package=str(HERE.parent))],
        input="cancel\nmore\n",
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["b''", "['cancel', 'more']"]


def test_jobs_and_results_go_through_json(tmp_path: Path) -> None:
    original = SourceJob(
        "navmesh",
        DSR,
        Area(id="m10_01_00_00", name="Undead Burg", msb=tmp_path / "a.msb", map_folder=None),
        tmp_path,
        {"n0000B1": [((1.0, 2.0, 3.0), (0.0, 90.0, 0.0))]},
        sample=3,
        budget=4.5,
        preview_limit=7,
    )
    assert job_from_dict(json.loads(json.dumps(job_to_dict(original)))) == original
    result = SourceResult("collision", status="timed-out", entries=4, file_seconds=[("a.hkx", 0.5)], stopped_on="b")
    result.mesh = [np.zeros((1, 3, 3), dtype=np.float32)]
    back = result_from_dict(json.loads(json.dumps(result_to_dict(result))))
    assert back.to_dict() == result.to_dict()
    assert back.file_seconds == [("a.hkx", 0.5)] and back.mesh == []
