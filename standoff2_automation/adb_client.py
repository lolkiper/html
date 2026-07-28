"""ADB wrapper for emulator interaction (background-safe, no mouse emulation)."""

from __future__ import annotations

import re
import subprocess
import time
from typing import Optional

from logger_setup import setup_logger

log = setup_logger(__name__)


class AdbError(RuntimeError):
    pass


class AdbClient:
    def __init__(self, serial: str) -> None:
        self.serial = serial

    def _run(
        self,
        *args: str,
        check: bool = True,
        timeout: int = 60,
        binary: bool = False,
    ) -> subprocess.CompletedProcess:
        cmd = ["adb", "-s", self.serial, *args]
        log.debug("ADB: %s", " ".join(cmd))
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=not binary,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise AdbError(f"ADB timeout: {' '.join(cmd)}") from exc

        if check and result.returncode != 0:
            stderr = result.stderr
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            stderr = (stderr or "").strip()
            raise AdbError(f"ADB failed ({result.returncode}): {stderr or cmd}")

        return result

    def connect(self) -> None:
        if ":" in self.serial:
            host_port = self.serial
            self._run("connect", host_port, check=False)
            time.sleep(1)
            devices = self._run("devices", check=False).stdout or ""
            if self.serial not in devices:
                raise AdbError(
                    f"Device {self.serial} not visible. "
                    "Enable ADB in emulator settings and check port."
                )
        log.info("ADB connected: %s", self.serial)

    def shell(self, command: str, check: bool = True) -> str:
        result = self._run("shell", command, check=check)
        return (result.stdout or "").strip()

    def tap(self, x: int, y: int) -> None:
        self.shell(f"input tap {x} {y}")

    def swipe(
        self,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        duration_ms: int = 300,
    ) -> None:
        self.shell(f"input swipe {x1} {y1} {x2} {y2} {duration_ms}")

    def keyevent(self, code: int) -> None:
        self.shell(f"input keyevent {code}")

    def press_back(self) -> None:
        self.keyevent(4)

    def press_home(self) -> None:
        self.keyevent(3)

    @staticmethod
    def _escape_adb_text(text: str) -> str:
        """Escape special chars for `adb shell input text`."""
        replacements = {
            " ": "%s",
            "&": "\\&",
            "<": "\\<",
            ">": "\\>",
            "|": "\\|",
            ";": "\\;",
            "(": "\\(",
            ")": "\\)",
            "'": "\\'",
            '"': '\\"',
            "\\": "\\\\",
        }
        out = []
        for ch in text:
            out.append(replacements.get(ch, ch))
        return "".join(out)

    def input_text(self, text: str) -> None:
        safe = self._escape_adb_text(text)
        self.shell(f'input text "{safe}"')

    def clear_field(self, taps: int = 30) -> None:
        for _ in range(taps):
            self.keyevent(67)  # KEYCODE_DEL
            time.sleep(0.02)

    def screenshot_png(self) -> bytes:
        result = self._run("exec-out", "screencap", "-p", timeout=30, binary=True)
        data = result.stdout
        if not data:
            raise AdbError("Empty screenshot from screencap")
        return data

    def pm_clear(self, package: str) -> None:
        log.info("Clearing app data: %s", package)
        self.shell(f"pm clear {package}")

    def force_stop(self, package: str) -> None:
        self.shell(f"am force-stop {package}")

    def start_activity(self, package: str, activity: str) -> None:
        self.shell(
            f"am start -n {package}/{activity}",
        )

    def is_package_running(self, package: str) -> bool:
        out = self.shell(f"pidof {package}", check=False)
        return bool(out and re.search(r"\d+", out))

    def get_screen_size(self) -> Optional[tuple[int, int]]:
        out = self.shell("wm size", check=False)
        match = re.search(r"(\d+)x(\d+)", out)
        if match:
            return int(match.group(1)), int(match.group(2))
        return None

    def wait_for_device(self, timeout: float = 30.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.shell("echo ok", check=True)
                return True
            except AdbError:
                time.sleep(1)
        return False
