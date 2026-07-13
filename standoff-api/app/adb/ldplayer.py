"""LDPlayer dnconsole + ADB connection."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Optional

from app.adb.device import AdbDevice

STANDOFF_PACKAGE = "com.axlebolt.standoff2"

LDPLAYER_SEARCH_PATHS = [
    os.environ.get("LDPLAYER_HOME", ""),
    r"C:\LDPlayer\LDPlayer9",
    r"C:\LDPlayer\LDPlayer4",
    r"C:\Program Files\LDPlayer\LDPlayer9",
    r"D:\LDPlayer\LDPlayer9",
    os.path.expandvars(r"%PROGRAMFILES%\LDPlayer\LDPlayer9"),
    os.path.expandvars(r"%PROGRAMFILES(X86)%\LDPlayer\LDPlayer9"),
]


def is_adb_ok(output: str) -> bool:
    low = (output or "").lower()
    if "error" in low and "success" not in low:
        return False
    if "not found" in low or "cannot" in low:
        return False
    return True


class LdConsole:
    def __init__(self, exe: Path, index: int, log_fn=None) -> None:
        self.exe = exe
        self.index = index
        self.log = log_fn or (lambda msg: None)

    def _run(self, *args: str, check: bool = False) -> subprocess.CompletedProcess:
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
        )

    def adb_shell(self, command: str) -> str:
        variants = [
            [str(self.exe), "adb", "--index", str(self.index), "--command", f"shell {command}"],
            [str(self.exe), "adb", "--index", str(self.index), "--command", command],
            [str(self.exe), "adb", "--name", f"LDPlayer-{self.index}", "--command", f"shell {command}"],
        ]
        last_out = ""
        for args in variants:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                cwd=str(self.exe.parent),
            )
            last_out = ((result.stdout or "") + (result.stderr or "")).strip()
            if is_adb_ok(last_out):
                return last_out
        return last_out

    def quit(self) -> None:
        try:
            self._run("quit", "--index", str(self.index))
        except Exception:
            pass
        time.sleep(3)

    def launch(self) -> None:
        self._run("launch", "--index", str(self.index))
        time.sleep(18)

    def run_app(self, package: str) -> None:
        self._run("runapp", "--index", str(self.index), "--packagename", package)
        time.sleep(3)

    def randomize_device_ids(self) -> None:
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
        )
        time.sleep(2)
        self.launch()

    def connect_device(self, delay_min: float, delay_max: float) -> AdbDevice:
        return AdbDevice(self.adb_shell, self.log, delay_min, delay_max)


def find_dnconsole(ldplayer_home: Optional[str] = None) -> Path:
    candidates: list[Path] = []
    if ldplayer_home:
        candidates.append(Path(ldplayer_home) / "dnconsole.exe")
    for p in LDPLAYER_SEARCH_PATHS:
        if p:
            candidates.append(Path(p) / "dnconsole.exe")
    for path in candidates:
        if path.is_file():
            return path
    raise FileNotFoundError(
        "dnconsole.exe не найден. Укажите LDPLAYER_HOME в config.json "
        "(например C:\\LDPlayer\\LDPlayer9)"
    )
