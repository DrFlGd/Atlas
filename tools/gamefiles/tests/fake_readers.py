"""Made-up readers for the child process tests (test_worker.py). The child imports this module by name, so it lives
in its own file. Each behaves by the made-up area's id."""

from __future__ import annotations

import os
import time

import numpy as np

from atlas_gamefiles.geometry import Feedback, SourceResult
from atlas_gamefiles.worker import SourceJob


def scripted(job: SourceJob, feedback: Feedback) -> tuple[SourceResult, np.ndarray]:
    behaviour = job.area.id
    if behaviour == "stuck" or (behaviour == "stuck-collision" and job.source == "collision"):
        # Opens, reads one file quickly, then never finishes the second.
        feedback.opening("h99_00_00_00.hkxbhd")
        feedback.planned(5, 3)
        feedback.file(0, 3, "quick.hkx.dcx")
        time.sleep(0.05)
        feedback.file(1, 3, "stuck.hkx.dcx")
        time.sleep(600)
    if behaviour == "stuck-opening":
        feedback.opening("h99_00_00_00.hkxbhd")
        time.sleep(600)
    if behaviour == "crash":
        os._exit(5)
    if behaviour == "error":
        raise ValueError("made-up bad data")
    feedback.opening("made-up.bnd")
    feedback.planned(1, 1)
    feedback.file(0, 1, "made-up.hkx")
    result = SourceResult(job.source, status="ok", entries=1, read=1, triangles=10)
    mesh = np.arange(10 * 9, dtype=np.float32).reshape(10, 3, 3)
    return result, mesh[: job.preview_limit] if job.preview_limit else mesh
