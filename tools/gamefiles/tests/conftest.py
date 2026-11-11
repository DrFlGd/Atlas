from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import fixtures  # noqa: E402


@pytest.fixture(scope="session")
def dsr_folder(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return fixtures.make_dsr(tmp_path_factory.mktemp("games") / "DARK SOULS REMASTERED")


@pytest.fixture(scope="session")
def bloodborne_folder(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return fixtures.make_bloodborne(tmp_path_factory.mktemp("games") / "CUSA99999")


def snapshot(folder: Path) -> dict[str, str]:
    """Every file under `folder` with a hash of its bytes, to show a check changed nothing."""
    return {
        path.relative_to(folder).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(folder.rglob("*"))
        if path.is_file()
    }
