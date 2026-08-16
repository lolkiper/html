"""Text-only event log for the LDPlayer visual automation engine.

Two hard rules are enforced here:

* image data never reaches the log (frames, buffers and PIL images are replaced
  by a placeholder instead of being dumped or written to disk);
* values the user marked as sensitive are redacted before formatting.
"""

from __future__ import annotations

import re
import threading
import time
from collections import deque
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

REDACTED = "***"
IMAGE_PLACEHOLDER = "<image omitted>"


class LogLevel(IntEnum):
    DEBUG = 10
    INFO = 20
    SUCCESS = 25
    WARNING = 30
    ERROR = 40

    @property
    def label(self) -> str:
        return self.name

    @classmethod
    def parse(cls, value: "LogLevel | str | int") -> "LogLevel":
        if isinstance(value, LogLevel):
            return value
        if isinstance(value, int):
            return cls(value)
        return cls[str(value).strip().upper()]


class Secret(str):
    """A string whose content must never appear in the log or on screen."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"Secret({REDACTED})"

    def __str__(self) -> str:
        return REDACTED

    def reveal(self) -> str:
        """Return the raw value. Only input backends may call this."""
        return str.__str__(self)


@dataclass(frozen=True)
class LogRecord:
    timestamp: float
    level: LogLevel
    message: str
    category: str = "engine"

    @property
    def clock(self) -> str:
        return time.strftime("%H:%M:%S", time.localtime(self.timestamp))

    def format(self, with_level: bool = False) -> str:
        if with_level:
            return f"[{self.clock}] {self.level.label:<7} {self.message}"
        return f"[{self.clock}] {self.message}"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.format()


def _looks_like_image(value: Any) -> bool:
    """Detect numpy frames, raw buffers and PIL images without importing them."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return True
    if hasattr(value, "dtype") and hasattr(value, "shape"):
        return True
    if hasattr(value, "mode") and hasattr(value, "size") and hasattr(value, "tobytes"):
        return True
    return False


class EventLog:
    """Thread-safe, bounded, listener based log used by the engine and the GUI."""

    def __init__(
        self,
        capacity: int = 4000,
        level: LogLevel | str = LogLevel.INFO,
        file_path: str | Path | None = None,
    ) -> None:
        self._records: deque[LogRecord] = deque(maxlen=capacity)
        self._listeners: list[Callable[[LogRecord], None]] = []
        self._secrets: set[str] = set()
        self._patterns: list[re.Pattern[str]] = []
        self._lock = threading.RLock()
        self.level = LogLevel.parse(level)
        self._file_path: Path | None = None
        if file_path is not None:
            self.attach_file(file_path)

    # ------------------------------------------------------------------ setup
    def attach_file(self, file_path: str | Path) -> None:
        """Attach a plain-text sink. Only formatted text lines are written."""
        path = Path(file_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._file_path = path

    def detach_file(self) -> None:
        self._file_path = None

    def add_listener(self, callback: Callable[[LogRecord], None]) -> Callable[[LogRecord], None]:
        with self._lock:
            self._listeners.append(callback)
        return callback

    def remove_listener(self, callback: Callable[[LogRecord], None]) -> None:
        with self._lock:
            if callback in self._listeners:
                self._listeners.remove(callback)

    # ------------------------------------------------------------- redaction
    def register_secret(self, value: str | None) -> None:
        """Register a literal value that must be redacted from every message."""
        if not value:
            return
        raw = value.reveal() if isinstance(value, Secret) else str(value)
        if len(raw) < 2:
            return
        with self._lock:
            self._secrets.add(raw)

    def register_secret_pattern(self, pattern: str) -> None:
        with self._lock:
            self._patterns.append(re.compile(pattern))

    def forget_secrets(self) -> None:
        with self._lock:
            self._secrets.clear()
            self._patterns.clear()

    def sanitize_value(self, value: Any) -> Any:
        """Sanitize a formatting argument, keeping numbers usable for ``%.2f``."""
        if isinstance(value, bool) or isinstance(value, (int, float)):
            return value
        return self.sanitize(value)

    def sanitize(self, value: Any) -> str:
        if _looks_like_image(value):
            return IMAGE_PLACEHOLDER
        if isinstance(value, Secret):
            return REDACTED
        text = value if isinstance(value, str) else repr(value)
        with self._lock:
            secrets = sorted(self._secrets, key=len, reverse=True)
            patterns = list(self._patterns)
        for secret in secrets:
            if secret and secret in text:
                text = text.replace(secret, REDACTED)
        for pattern in patterns:
            text = pattern.sub(REDACTED, text)
        return text

    # ------------------------------------------------------------------- log
    def log(
        self,
        level: LogLevel | str,
        message: Any,
        *args: Any,
        category: str = "engine",
    ) -> LogRecord | None:
        level = LogLevel.parse(level)
        text = self.sanitize(message)
        if args:
            safe_args = tuple(self.sanitize_value(arg) for arg in args)
            try:
                text = text % safe_args
            except (TypeError, ValueError):
                text = " ".join([text, *(str(arg) for arg in safe_args)])
        record = LogRecord(time.time(), level, text, category)
        if level < self.level:
            return None
        with self._lock:
            self._records.append(record)
            listeners = list(self._listeners)
            path = self._file_path
        if path is not None:
            try:
                with path.open("a", encoding="utf-8") as handle:
                    handle.write(record.format(with_level=True) + "\n")
            except OSError:
                pass
        for listener in listeners:
            try:
                listener(record)
            except Exception:  # a broken listener must never stop the engine
                pass
        return record

    def debug(self, message: Any, *args: Any, **kw: Any) -> LogRecord | None:
        return self.log(LogLevel.DEBUG, message, *args, **kw)

    def info(self, message: Any, *args: Any, **kw: Any) -> LogRecord | None:
        return self.log(LogLevel.INFO, message, *args, **kw)

    def success(self, message: Any, *args: Any, **kw: Any) -> LogRecord | None:
        return self.log(LogLevel.SUCCESS, message, *args, **kw)

    def warning(self, message: Any, *args: Any, **kw: Any) -> LogRecord | None:
        return self.log(LogLevel.WARNING, message, *args, **kw)

    def error(self, message: Any, *args: Any, **kw: Any) -> LogRecord | None:
        return self.log(LogLevel.ERROR, message, *args, **kw)

    # ---------------------------------------------------------------- access
    def records(self, level: LogLevel | None = None) -> list[LogRecord]:
        with self._lock:
            records = list(self._records)
        if level is None:
            return records
        return [record for record in records if record.level >= level]

    def lines(self, level: LogLevel | None = None) -> list[str]:
        return [record.format() for record in self.records(level)]

    def clear(self) -> None:
        with self._lock:
            self._records.clear()

    def __len__(self) -> int:  # pragma: no cover - trivial
        return len(self._records)

    def __bool__(self) -> bool:
        # An empty log must never be falsy: ``log or get_logger()`` is used all
        # over the code base to accept an injected log instance.
        return True


_default_log = EventLog()


def get_logger() -> EventLog:
    """Return the process wide log instance."""
    return _default_log


def set_logger(log: EventLog) -> EventLog:
    global _default_log
    _default_log = log
    return _default_log


def mask_text(text: str, keep: int = 0) -> str:
    """Return a masked preview of user supplied text (used for TYPE TEXT)."""
    if not text:
        return ""
    if keep <= 0:
        return f"{REDACTED} ({len(text)} chars)"
    head = text[:keep]
    return f"{head}{REDACTED} ({len(text)} chars)"


def summarize_secret_fields(values: Iterable[tuple[str, Any]], sensitive: Sequence[str]) -> str:
    """Format ``key=value`` pairs, redacting the keys listed in ``sensitive``."""
    parts = []
    for key, value in values:
        parts.append(f"{key}={REDACTED}" if key in sensitive else f"{key}={value}")
    return ", ".join(parts)
