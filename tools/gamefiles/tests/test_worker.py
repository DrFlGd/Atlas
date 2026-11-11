"""Reading geometry in a child process: the time limit, the heartbeat, cancel, and a child that crashes. The readers
here are made up (fake_readers.py); test_check.py runs the real ones through the same child process."""

from __future__ import annotations

import io
import json
import time
from pathlib import Path

import numpy as np
import pytest

import fake_readers
from atlas_gamefiles.check import CancelToken, Checker
from atlas_gamefiles.events import Events
from atlas_gamefiles.games import PROFILES, Area, list_areas
from atlas_gamefiles.geometry import Cancelled
from atlas_gamefiles.worker import ProcessRunner, SourceJob, cap_triangles

DSR = "dark-souls-remastered"


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
    made = ProcessRunner(time_limit=2.0, heartbeat=0.3, run=fake_readers.scripted)
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
    assert runner.process is not None and runner.process.is_alive()


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
    assert not child.is_alive() and child.exitcode is not None
    assert runner.process is None


def test_a_crashing_child_fails_one_source_only(runner: ProcessRunner, tmp_path: Path) -> None:
    result, _ = runner.run(job("crash", tmp_path), Said(), CancelToken())
    assert result.status == "failed"
    assert "ended unexpectedly" in result.errors[0]
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
    runner = ProcessRunner(time_limit=1.5, heartbeat=0.3, run=fake_readers.scripted)
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
    runner = ProcessRunner(time_limit=600, heartbeat=0.2, run=fake_readers.scripted)
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
    assert not child.is_alive()
    assert runner.process is None
    assert not (tmp_path / "out" / "report.json").exists()
