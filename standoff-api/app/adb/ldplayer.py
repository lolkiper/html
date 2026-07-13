"""LDPlayer dnconsole + ADB connection."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Optional

from app.adb.device import AdbDevice

STANDOFF_PACKAGE = "com.axlebolt.standoff2"
ADB_TIMEOUT_SEC = 25

LDPLAYER_SEARCH_PATHS = [
    os.environ.get("LDPLAYER_HOME", ""),
    r"C:\LDPlayer\LDPlayer9",
    r"C:\LDPlayer\LDPlayer4",
    r"C:\LDPlayer\LDPlayer",
    r"C:\Program Files\LDPlayer\LDPlayer9",
    r"C:\Program Files\LDPlayer\LDPlayer",
    r"D:\LDPlayer\LDPlayer9",
    r"D:\LDPlayer\LDPlayer",
    os.path.expandvars(r"%PROGRAMFILES%\LDPlayer\LDPlayer9"),
    os.path.expandvars(r"%PROGRAMFILES%\LDPlayer\LDPlayer"),
    os.path.expandvars(r"%PROGRAMFILES(X86)%\LDPlayer\LDPlayer9"),
    os.path.expandvars(r"%PROGRAMFILES(X86)%\LDPlayer\LDPlayer"),
]


def is_adb_ok(output: str) -> bool:
    low = (output or "").lower()
    if not output or not output.strip():
        return False
    if "adb" in low and "not found" in low:
        return False
    if "cannot connect" in low or "offline" in low:
        return False
    if "error" in low and "success" not in low and "0 error" not in low:
        if "error: closed" in low or "device offline" in low:
            return False
    if "not found" in low and "command" in low:
        return False
    return True


class LdConsole:
    def __init__(self, exe: Path, index: int, log_fn=None) -> None:
        self.exe = exe
        self.index = index
        self.log = log_fn or (lambda msg: None)

    def _run(self, *args: str, check: bool = False, timeout: int = 60) -> subprocess.CompletedProcess:
        cmd = [str(self.exe), *args]
        self.log(f"dnconsole: {' '.join(cmd[1:])}")
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=check,
            cwd=str(self.exe.parent),
            timeout=timeout,
        )

    def adb_shell(self, command: str) -> str:
        variants = [
            [str(self.exe), "adb", "--index", str(self.index), "--command", f"shell {command}"],
            [str(self.exe), "adb", "--index", str(self.index), "--command", command],
            [str(self.exe), "adb", "--name", f"LDPlayer-{self.index}", "--command", f"shell {command}"],
        ]
        errors: list[str] = []
        for args in variants:
            try:
                result = subprocess.run(
                    args,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=ADB_TIMEOUT_SEC,
                    cwd=str(self.exe.parent),
                )
                last_out = ((result.stdout or "") + (result.stderr or "")).strip()
                if is_adb_ok(last_out):
                    return last_out
                errors.append(last_out[:200] or f"exit={result.returncode}")
            except subprocess.TimeoutExpired:
                errors.append(f"timeout {ADB_TIMEOUT_SEC}s: {' '.join(args[1:4])}")
            except Exception as exc:
                errors.append(str(exc))

        hint = (
            f"ADB не отвечает для EMULATOR_INDEX={self.index}. "
            "Проверь: LDPlayer запущен, ADB включён, верный индекс. "
            f"Детали: {' | '.join(errors[:2])}"
        )
        raise RuntimeError(hint)

    def verify_adb(self) -> str:
        out = self.adb_shell("echo farm_ok")
        self.log(f"ADB ok: {out[:80]}")
        return out

    def quit(self) -> None:
        try:
            self._run("quit", "--index", str(self.index), timeout=30)
        except Exception:
            pass
        time.sleep(2)

    def launch(self) -> None:
        self._run("launch", "--index", str(self.index), timeout=90)
        time.sleep(12)

    def run_app(self, package: str) -> None:
        self._run("runapp", "--index", str(self.index), "--packagename", package, timeout=60)
        time.sleep(3)

    def randomize_device_ids(self) -> None:
        self.log("Перезапуск эмулятора + сброс IMEI/AndroidID...")
        self.quit()
        self._run(
            "modify",
            "--index",
            str(self.index),
            "--imei",
            "auto",
            "--androidid",
            "auto",
            "--mac",
            "auto",
            timeout=60,
        )
        time.sleep(2)
        self.launch()

    def connect_device(self, delay_min: float, delay_max: float) -> AdbDevice:
        self.verify_adb()
        return AdbDevice(self.adb_shell, self.log, delay_min, delay_max)


def find_dnconsole(ldplayer_home: Optional[str] = None) -> Path:
    candidates: list[Path] = []
    if ldplayer_home:
        candidates.append(Path(ldplayer_home) / "dnconsole.exe")
    for p in LDPLAYER_SEARCH_PATHS:
        if p:
            candidates.append(Path(p) / "dnconsole.exe")
    seen: set[str] = set()
    for path in candidates:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            return path
    raise FileNotFoundError(
        "dnconsole.exe не найден. Укажите LDPLAYER_HOME в config.json "
        "(например C:\\LDPlayer\\LDPlayer9 или C:\\LDPlayer\\LDPlayer)"
    )


def list_ldplayer_instances(ldplayer_home: Optional[str] = None) -> list[str]:
    """Пробует list2 / list — для диагностики."""
    exe = find_dnconsole(ldplayer_home)
    for args in (["list2"], ["list"]):
        try:
            result = subprocess.run(
                [str(exe), *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                cwd=str(exe.parent),
            )
            text = (result.stdout or result.stderr or "").strip()
            if text:
                return text.splitlines()
        except Exception:
            continue
    return []
