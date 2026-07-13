"""Read text files on Windows (UTF-8 / Блокнот cp1251)."""

from __future__ import annotations

from pathlib import Path

ENCODINGS = ("utf-8-sig", "utf-8", "cp1251", "latin-1")


def read_text_auto(path: Path) -> str:
    raw = path.read_bytes()
    if not raw:
        return ""

    last_error: UnicodeDecodeError | None = None
    for encoding in ENCODINGS:
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError as exc:
            last_error = exc

    if last_error is not None:
        raise last_error
    return raw.decode("utf-8", errors="replace")
