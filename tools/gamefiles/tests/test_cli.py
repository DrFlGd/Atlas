"""The command line, as the Map Maker app runs it: a separate process, JSON lines on standard output."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from atlas_gamefiles.safety import NetworkDisabledError, block_network, check_output_folder, UnsafeOutputError
from conftest import snapshot

PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def helper(*args: str, stdin: int | None = subprocess.DEVNULL) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONPATH": str(PACKAGE_ROOT), "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(
        [sys.executable, "-m", "atlas_gamefiles", *args],
        stdin=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=300,
    )


def lines(stdout: str) -> list[dict]:
    return [json.loads(line) for line in stdout.splitlines()]


def test_version() -> None:
    result = helper("--version")
    assert result.returncode == 0
    assert result.stdout.strip() == "atlas-gamefiles 0.1.0"


def test_check_prints_only_json_lines(dsr_folder: Path, tmp_path: Path) -> None:
    before = snapshot(dsr_folder)
    result = helper("check", str(dsr_folder), "--out", str(tmp_path / "out"))
    assert result.returncode == 0, result.stderr
    events = lines(result.stdout)  # every line is JSON
    assert events[0]["event"] == "start"
    assert events[-1]["event"] == "done"
    assert events[-1]["summary"]["areas"] == 2
    assert Path(events[-1]["zip"]).is_file()
    assert snapshot(dsr_folder) == before


def test_output_inside_the_game_folder_is_refused(dsr_folder: Path) -> None:
    result = helper("check", str(dsr_folder), "--out", str(dsr_folder / "out"))
    assert result.returncode == 2
    assert lines(result.stdout)[-1]["event"] == "error"
    assert not (dsr_folder / "out").exists()


def test_closing_stdin_cancels(dsr_folder: Path, tmp_path: Path) -> None:
    # Standard input is closed at once, so the check stops at its first chance.
    result = helper("check", str(dsr_folder), "--out", str(tmp_path / "out"), "--stdin-cancel")
    assert result.returncode == 3, result.stderr
    assert lines(result.stdout)[-1]["event"] == "cancelled"
    assert not (tmp_path / "out" / "report.json").exists()


def test_bad_arguments() -> None:
    assert helper("check").returncode == 2


def test_network_is_blocked() -> None:
    script = (
        "import socket\n"
        "from atlas_gamefiles.safety import block_network, NetworkDisabledError\n"
        "block_network()\n"
        "try:\n"
        "    socket.create_connection(('127.0.0.1', 9))\n"
        "except NetworkDisabledError:\n"
        "    print('blocked')\n"
    )
    env = {**os.environ, "PYTHONPATH": str(PACKAGE_ROOT)}
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, env=env, timeout=60)
    assert result.stdout.strip() == "blocked", result.stderr


def test_network_block_covers_sockets_and_lookups() -> None:
    saved = (socket.socket.connect, socket.create_connection, socket.getaddrinfo)
    try:
        block_network()
        with pytest.raises(NetworkDisabledError):
            socket.getaddrinfo("example.invalid", 443)
        with socket.socket() as sock, pytest.raises(NetworkDisabledError):
            sock.connect(("127.0.0.1", 9))
    finally:
        import atlas_gamefiles.safety as safety

        socket.socket.connect, socket.create_connection, socket.getaddrinfo = saved
        safety._network_blocked = False


def test_output_folder_rules(tmp_path: Path) -> None:
    game = tmp_path / "game"
    game.mkdir()
    check_output_folder(tmp_path / "elsewhere", game)
    for bad in (game, game / "sub", tmp_path):
        with pytest.raises(UnsafeOutputError):
            check_output_folder(bad, game)
