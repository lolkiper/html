"""Console logging for the OpenCV bot."""

from __future__ import annotations

import sys
from datetime import datetime


def log(step: str, message: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{step}] {message}", flush=True)


def log_account(idx: int, total: int, email: str, message: str) -> None:
    log("account", f"{idx}/{total} {email} | {message}")


def log_error(message: str) -> None:
    print(f"[ERROR] {message}", file=sys.stderr, flush=True)
