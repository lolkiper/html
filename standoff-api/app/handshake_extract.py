"""Extract Standoff 2 handshake (session ticket) from emulator via ADB."""

from __future__ import annotations

import re
from typing import Callable

from app.adb.ldplayer import STANDOFF_PACKAGE

# JWT / session tickets from Bolt usually start with eyJ
_JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
# Long base64-ish ticket without dots
_B64_TICKET_RE = re.compile(r"(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{80,})(?![A-Za-z0-9_-])")
# dump.cs 0.39.2: AuthenticatedPlayerApiState._token / PlayerAuthInfo.Token after HandshakeAsync
_LOGCAT_COMMANDS = (
    "logcat -d",
    'logcat -d | grep -iE "eyJ|handshake|ticket|bolt|axlebolt" 2>/dev/null || logcat -d',
)


def _unique_candidates(text: str) -> list[str]:
    found: list[str] = []
    for pattern in (_JWT_RE, _B64_TICKET_RE):
        for match in pattern.finditer(text or ""):
            token = match.group(1) if match.lastindex else match.group(0)
            token = token.strip('"\'<> ')
            if len(token) < 60:
                continue
            if token not in found:
                found.append(token)
    return found


def _try_logcat(shell_fn: Callable[[str], str], log_fn=print) -> str | None:
    log_fn("Токен: читаю logcat...")
    for cmd in _LOGCAT_COMMANDS:
        raw = shell_fn(cmd)
        for token in _unique_candidates(raw):
            if token.count(".") >= 2:  # prefer JWT shape
                log_fn(f"Токен найден в logcat (JWT, {len(token)} симв.)")
                return token
        for token in _unique_candidates(raw):
            log_fn(f"Токен найден в logcat ({len(token)} симв.)")
            return token
    return None


def _try_shared_prefs(shell_fn: Callable[[str], str], log_fn=print) -> str | None:
    pkg = STANDOFF_PACKAGE
    commands = [
        f"su -c 'grep -ohE \"eyJ[A-Za-z0-9._-]{{40,}}\" /data/data/{pkg}/shared_prefs/*.xml 2>/dev/null'",
        f"su -c 'grep -rohE \"eyJ[A-Za-z0-9._-]{{40,}}\" /data/data/{pkg}/ 2>/dev/null | head -5'",
        f"su -c 'grep -ri ticket /data/data/{pkg}/shared_prefs/ 2>/dev/null'",
        f"su -c 'cat /data/data/{pkg}/shared_prefs/*.xml 2>/dev/null'",
    ]
    for cmd in commands:
        log_fn(f"Токен: {cmd[:70]}...")
        raw = shell_fn(cmd)
        for token in _unique_candidates(raw):
            log_fn(f"Токен найден в shared_prefs ({len(token)} симв.)")
            return token
        if "eyJ" in (raw or ""):
            for token in _unique_candidates(raw):
                return token
    return None


def _try_sdcard_token(shell_fn: Callable[[str], str], log_fn=print) -> str | None:
    paths = [
        "/sdcard/DCIM/SharedFolder/token",
        "/sdcard/token",
        "/sdcard/Download/token",
    ]
    for path in paths:
        raw = shell_fn(f"cat {path} 2>/dev/null")
        if raw and len(raw.strip()) > 40:
            token = raw.strip().splitlines()[0].strip()
            log_fn(f"Токен найден в {path}")
            return token
    return None


def extract_handshake(shell_fn: Callable[[str], str], log_fn=print) -> str:
    """Return handshake string or raise TimeoutError."""
    import time

    time.sleep(2)
    methods = (
        _try_sdcard_token,
        _try_shared_prefs,
        _try_logcat,
    )
    for attempt in range(3):
        for method in methods:
            try:
                token = method(shell_fn, log_fn)
                if token:
                    return token
            except Exception as exc:
                log_fn(f"Токен: {method.__name__} ошибка: {exc}")
        log_fn(f"Токен: попытка {attempt + 1}/3 — не найден, ждём...")
        time.sleep(3)

    raise TimeoutError(
        "Handshake не найден. Нужен root на LDPlayer или положи токен в "
        "/sdcard/token (см. standoff2-external-token). "
        "Telegram: https://t.me/astandy_api"
    )
