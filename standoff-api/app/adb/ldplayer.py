"""LDPlayer dnconsole + прямой ADB (adb.exe connect)."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Callable, Optional

from app.adb.device import AdbDevice

STANDOFF_PACKAGE = "com.axlebolt.standoff2"
ADB_TIMEOUT_SEC = 60

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
    bad = (
        "unknown command",
        "not found",
        "cannot connect",
        "device offline",
        "error: closed",
        "no devices",
        "unauthorized",
        "failed",
    )
    if any(token in low for token in bad):
        return False
    return True


def is_shell_ok(output: str) -> bool:
    return is_adb_ok(output) and "adb.exe:" not in (output or "").lower()


def find_adb_exe(dnconsole: Path) -> Optional[Path]:
    folder = dnconsole.parent
    for name in ("adb.exe", "adb"):
        candidate = folder / name
        if candidate.is_file():
            return candidate
    return None


def guess_adb_ports(index: int) -> list[int]:
    ports = [
        5555 + index * 2,
        5554 + index * 2,
        5555 + index,
        5557 + index * 2,
        5555,
    ]
    seen: set[int] = set()
    result: list[int] = []
    for port in ports:
        if port not in seen and port > 0:
            seen.add(port)
            result.append(port)
    return result


def adb_run(adb_exe: Path, *args: str, log_fn: Callable[[str], None] | None = None) -> str:
    result = subprocess.run(
        [str(adb_exe), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=ADB_TIMEOUT_SEC,
        cwd=str(adb_exe.parent),
    )
    out = ((result.stdout or "") + (result.stderr or "")).strip()
    if log_fn and out:
        log_fn(f"adb {' '.join(args[:4])} → {out[:120]}")
    return out


class LdConsole:
    def __init__(self, exe: Path, index: int, log_fn=None) -> None:
        self.exe = exe
        self.index = index
        self.log = log_fn or (lambda msg: None)

    def _run(self, *args: str, timeout: int = 60) -> subprocess.CompletedProcess:
        cmd = [str(self.exe), *args]
        self.log(f"dnconsole: {' '.join(cmd[1:])}")
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(self.exe.parent),
            timeout=timeout,
        )

    def adb_shell_dnconsole(self, command: str) -> str:
        inner = command.removeprefix("shell ").strip()
        variants = [
            [str(self.exe), "adb", "--index", str(self.index), "--command", f"shell {inner}"],
            [str(self.exe), "adb", "--index", str(self.index), "--command", inner],
            [str(self.exe), "adb", "--name", f"LDPlayer-{self.index}", "--command", f"shell {inner}"],
        ]
        last_out = ""
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
                if is_shell_ok(last_out):
                    return last_out
            except Exception:
                continue
        return last_out

    def quit(self) -> None:
        try:
            self._run("quit", "--index", str(self.index), timeout=30)
        except Exception:
            pass
        time.sleep(2)

    def launch(self) -> None:
        self._run("launch", "--index", str(self.index), timeout=90)
        time.sleep(12)

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


def connect_device(
    ld: LdConsole,
    *,
    adb_host: str = "127.0.0.1",
    adb_port: Optional[int] = None,
    delay_min: float = 1.2,
    delay_max: float = 2.5,
    retries: int = 12,
) -> AdbDevice:
    """Прямой adb.exe → fallback dnconsole. Как в рабочем LDPlayer-боте."""
    log = ld.log
    adb_exe = find_adb_exe(ld.exe)
    ports = guess_adb_ports(ld.index)
    if adb_port is not None:
        ports.insert(0, adb_port)

    log(f"Подключение ADB index={ld.index}, порты: {ports}")

    if adb_exe and adb_exe.is_file():
        adb_run(adb_exe, "start-server", log_fn=log)
        for attempt in range(1, retries + 1):
            for port in ports:
                serial = f"{adb_host}:{port}"
                adb_run(adb_exe, "connect", serial, log_fn=log)
                time.sleep(0.8)
                devices = adb_run(adb_exe, "devices", log_fn=log)
                if serial not in devices or "device" not in devices:
                    continue

                def shell_fn(command: str, _adb=adb_exe, _serial=serial) -> str:
                    inner = command.removeprefix("shell ").strip()
                    return adb_run(_adb, "-s", _serial, "shell", inner, log_fn=None)

                out = shell_fn("getprop ro.build.version.release")
                if is_shell_ok(out) and any(ch.isdigit() for ch in out):
                    log(f"ADB подключён: {serial}, Android {out.strip()}")

                    def logging_shell(command: str) -> str:
                        result = shell_fn(command)
                        if not is_shell_ok(result):
                            log(f"ADB warn: {command[:50]} → {result[:100]}")
                        return result

                    return AdbDevice(logging_shell, log, delay_min, delay_max)

            log(f"Прямой ADB: попытка {attempt}/{retries} — устройство не найдено")
            time.sleep(3)

    log("Прямой ADB не сработал — пробую dnconsole adb...")

    def dn_shell(command: str) -> str:
        return ld.adb_shell_dnconsole(command)

    for attempt in range(1, retries + 1):
        out = dn_shell("getprop ro.build.version.release")
        if is_shell_ok(out) and any(ch.isdigit() for ch in out):
            log(f"ADB через dnconsole: Android {out.strip()}")
            return AdbDevice(dn_shell, log, delay_min, delay_max)
        log(f"dnconsole ADB: попытка {attempt}/{retries} → {out[:100]}")
        time.sleep(3)

    raise RuntimeError(
        f"ADB не подключился (EMULATOR_INDEX={ld.index}). "
        "Открой эмулятор, включи ADB в LDPlayer, проверь индекс в dnconsole list2. "
        f"Для «standoff bust» в списке это index 6."
    )


def find_dnconsole(ldplayer_home: Optional[str] = None) -> Path:
    candidates: list[Path] = []
    if ldplayer_home:
        candidates.append(Path(ldplayer_home) / "dnconsole.exe")
    for path_str in LDPLAYER_SEARCH_PATHS:
        if path_str:
            candidates.append(Path(path_str) / "dnconsole.exe")
    seen: set[str] = set()
    for path in candidates:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            return path
    raise FileNotFoundError(
        "dnconsole.exe не найден. Укажите LDPLAYER_HOME в config.json"
    )


def list_ldplayer_instances(ldplayer_home: Optional[str] = None) -> list[str]:
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
