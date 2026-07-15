"""ADB connection to LDPlayer via subprocess."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Callable

from opencv_bot.bot_config import BotConfig
from opencv_bot import logger


class AdbClient:
  """Thin wrapper around adb.exe / adb shell."""

  def __init__(self, cfg: BotConfig, adb_exe: Path, serial: str) -> None:
    self.cfg = cfg
    self.adb_exe = adb_exe
    self.serial = serial

  def run(self, *args: str, timeout: int = 60) -> str:
    cmd = [str(self.adb_exe), "-s", self.serial, *args]
    try:
      proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
      out = (proc.stdout or "") + (proc.stderr or "")
      return out.strip()
    except subprocess.TimeoutExpired:
      return "ERROR: timeout"
    except FileNotFoundError:
      return "ERROR: adb not found"

  def shell(self, command: str) -> str:
    return self.run("shell", command)

  def tap(self, x: int, y: int) -> None:
    self.shell(f"input tap {x} {y}")
    time.sleep(self.cfg.delay_after_tap_sec)

  def input_text(self, text: str) -> None:
    safe = (
      text.replace("\\", "\\\\")
      .replace('"', '\\"')
      .replace(" ", "%s")
      .replace("&", "\\&")
      .replace("|", "\\|")
      .replace(";", "\\;")
      .replace("'", "\\'")
    )
    self.shell(f'input text "{safe}"')

  def keyevent(self, code: int) -> None:
    self.shell(f"input keyevent {code}")

  def home(self) -> None:
    self.keyevent(3)

  def back(self) -> None:
    self.keyevent(4)

  def screenshot_png(self, local_path: Path) -> bool:
    remote = "/sdcard/opencv_bot_screen.png"
    self.shell(f"screencap -p {remote}")
    out = self.run("pull", remote, str(local_path))
    return local_path.exists() and "error" not in out.lower()

  def clear_app(self, package: str) -> None:
    logger.log("adb", f"pm clear {package}")
    self.shell(f"pm clear {package}")

  def force_stop(self, package: str) -> None:
    self.shell(f"am force-stop {package}")

  def launch_app(self, package: str) -> None:
    self.shell(
      f"monkey -p {package} -c android.intent.category.LAUNCHER 1"
    )


def find_adb_exe(cfg: BotConfig) -> Path | None:
  candidates: list[Path] = []
  home = Path(cfg.ldplayer_home)
  if home.is_dir():
    candidates.append(home / "adb.exe")
    candidates.append(home / "adb")
  for env_key in ("ADB", "ANDROID_HOME", "ANDROID_SDK_ROOT"):
    base = os.environ.get(env_key, "")
    if base:
      candidates.append(Path(base) / "platform-tools" / "adb.exe")
      candidates.append(Path(base) / "adb.exe")
  candidates.append(Path("adb.exe"))
  candidates.append(Path("adb"))
  for path in candidates:
    if path.is_file():
      return path
  return None


def connect_ldplayer(cfg: BotConfig) -> AdbClient:
  adb_exe = find_adb_exe(cfg)
  if adb_exe is None:
    raise RuntimeError(
      "adb.exe не найден. Укажи LDPLAYER_HOME в opencv_bot/config.json"
    )

  base_port = 5555 + cfg.emulator_index * 2
  ports = list(cfg.adb_ports)
  if base_port not in ports:
    ports.insert(0, base_port)

  serial = ""
  for port in ports:
    target = f"{cfg.adb_host}:{port}"
    logger.log("adb", f"connect {target}")
    subprocess.run([str(adb_exe), "connect", target], capture_output=True, text=True)
    time.sleep(0.5)
    devices = subprocess.run(
      [str(adb_exe), "devices"],
      capture_output=True,
      text=True,
    ).stdout or ""
    if target in devices and "device" in devices:
      serial = target
      break

  if not serial:
    raise RuntimeError(
      f"Эмулятор не найден. Запусти LDPlayer index={cfg.emulator_index}, "
      f"проверь ADB_PORTS в config.json"
    )

  logger.log("adb", f"подключён: {serial}")
  return AdbClient(cfg, adb_exe, serial)
