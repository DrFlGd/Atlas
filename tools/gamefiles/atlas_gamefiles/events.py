"""Progress lines on standard output: one JSON object per line, flushed at once.

Standard output carries only these lines. Anything else that writes to it (a library's `print`, a logger) is sent
to standard error instead, by `claim_stdout()`, so the app reading the lines never sees anything but JSON.
"""

from __future__ import annotations

import json
import os
import sys
import threading
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


def claim_stdout() -> Events:
    """Keep the real standard output for events; point file descriptor 1 and `sys.stdout` at standard error."""
    try:
        sys.stdout.flush()
        events_fd = os.dup(sys.stdout.fileno())
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        stream = os.fdopen(events_fd, "w", encoding="utf-8", newline="\n", buffering=1)
    except (AttributeError, OSError, ValueError):
        # No real file descriptors (an embedded interpreter, a test harness): keep the stream as it is.
        stream = sys.stdout
    sys.stdout = sys.stderr
    return Events(stream)
