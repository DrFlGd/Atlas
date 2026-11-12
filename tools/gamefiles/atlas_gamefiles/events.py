"""Progress lines on standard output: one JSON object per line, flushed at once; and the standard streams kept apart
from the libraries.

Standard output carries only these lines. Anything else that writes to it (a library's `print`, a logger) is sent
to standard error instead, by `claim_stdout()`, so the app reading the lines never sees anything but JSON.

Standard input (where the app writes `cancel`) is kept the same way, by `claim_stdin()`: this process reads it
through a private copy, and the standard input that libraries and any program they start would see is the null
device. On Windows, `stdin_lines` also never leaves a read waiting on the pipe: it asks the pipe how many bytes are
there (`PeekNamedPipe`) and reads only those. A read left waiting on a pipe there blocks every other use of that
pipe, even a program asking what kind of file its standard input is (`GetFileType`) as it starts, and that
program then never starts. (That is the likely reason Map Maker 0.1.1's file reader process, a multiprocessing
child that Windows gave a copy of the helper's standard input, never started on a player's PC.)
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import typing as tp


class Events:
    """Writes events to a text stream. `emit` is safe to call from several threads."""

    def __init__(self, stream: tp.TextIO):
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, event: str, **fields: tp.Any) -> None:
        line = json.dumps({"event": event, **fields}, ensure_ascii=False, separators=(",", ":"), default=str)
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()

    def progress(self, fraction: float, message: str, **fields: tp.Any) -> None:
        self.emit("progress", fraction=round(min(max(fraction, 0.0), 1.0), 4), message=message, **fields)

    def warning(self, message: str, **fields: tp.Any) -> None:
        self.emit("warning", message=message, **fields)


class NullEvents(Events):
    def __init__(self):
        super().__init__(open(os.devnull, "w"))

    def emit(self, event: str, **fields: tp.Any) -> None:
        pass


def claim_stdout_stream() -> tp.TextIO:
    """Keep the real standard output for this module's lines; point file descriptor 1 and `sys.stdout` at standard
    error. Returns the real standard output, as a text stream."""
    try:
        sys.stdout.flush()
        events_fd = os.dup(sys.stdout.fileno())
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        stream: tp.TextIO = os.fdopen(events_fd, "w", encoding="utf-8", newline="\n", buffering=1)
    except (AttributeError, OSError, ValueError):
        # No real file descriptors (an embedded interpreter, a test harness): keep the stream as it is.
        stream = sys.stdout
    sys.stdout = sys.stderr
    return stream


def claim_stdout() -> Events:
    """Keep the real standard output for events; point file descriptor 1 and `sys.stdout` at standard error."""
    return Events(claim_stdout_stream())


def claim_stdin() -> int | None:
    """Keep the real standard input for this process alone: returns a private (not inherited) copy of file
    descriptor 0, and points descriptor 0 (and with it the Windows standard input handle) at the null device. None
    when there is no standard input to claim."""
    try:
        private = os.dup(0)
    except OSError:
        return None
    try:
        null = os.open(os.devnull, os.O_RDONLY)
        try:
            os.dup2(null, 0)
        finally:
            os.close(null)
    except OSError:
        pass
    return private


_BROKEN_PIPE = (109, 232)  # ERROR_BROKEN_PIPE, ERROR_NO_DATA: the writer closed the pipe


def stdin_lines(fd: int, poll: float = 0.1) -> tp.Iterator[str]:
    """The lines (without line ends) read from `fd` until it ends. On Windows, when `fd` is a pipe, only bytes
    already in the pipe are read, so no read is ever left waiting on it (see the top of this module)."""
    pending = b""
    if sys.platform == "win32":
        import _winapi
        import msvcrt

        handle = msvcrt.get_osfhandle(fd)
        while True:
            try:
                available = _winapi.PeekNamedPipe(handle, 0)[0]
            except OSError as error:
                if getattr(error, "winerror", None) in _BROKEN_PIPE:
                    available = -1  # the end
                else:
                    break  # not a pipe (a console, a file): read it the usual way below
            if available < 0:
                if pending:
                    yield pending.decode("utf-8", "replace").rstrip("\r")
                return
            if available == 0:
                time.sleep(poll)
                continue
            data = os.read(fd, available)
            if not data:
                break
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                yield line.decode("utf-8", "replace").rstrip("\r")
    while True:
        data = os.read(fd, 65536)
        if not data:
            break
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            yield line.decode("utf-8", "replace").rstrip("\r")
    if pending:
        yield pending.decode("utf-8", "replace").rstrip("\r")
