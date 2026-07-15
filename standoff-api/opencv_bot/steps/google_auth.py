"""Шаг 3: Google Auth через OpenCV + ADB input (с uiautomator fallback)."""

from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET

from opencv_bot.accounts import Account
from opencv_bot.adb import AdbClient
from opencv_bot.bot_config import BotConfig
from opencv_bot import logger
from opencv_bot.vision import Vision

# --- uiautomator fallback (когда шаблонов нет) ---

def _ui_dump(adb: AdbClient) -> ET.Element | None:
  path = "/sdcard/window_dump.xml"
  adb.shell(f"uiautomator dump {path}")
  time.sleep(0.35)
  raw = adb.shell(f"cat {path}")
  if "<?xml" not in raw:
    return None
  start = raw.find("<?xml")
  try:
    return ET.fromstring(raw[start:])
  except ET.ParseError:
    return None


def _blob(root: ET.Element) -> str:
  parts: list[str] = []
  for node in root.iter():
    for attr in ("text", "content-desc"):
      t = (node.attrib.get(attr) or "").replace("\u00a0", " ").lower().strip()
      if t:
        parts.append(t)
  return " ".join(parts)


def _click_text(adb: AdbClient, labels: list[str], timeout: float = 8.0) -> bool:
  deadline = time.time() + timeout
  while time.time() < deadline:
    root = _ui_dump(adb)
    if root is None:
      time.sleep(0.35)
      continue
    for node in root.iter():
      for attr in ("text", "content-desc"):
        raw = (node.attrib.get(attr) or "").strip()
        if not raw:
          continue
        low = raw.lower()
        for label in labels:
          if label.lower() in low:
            bounds = node.attrib.get("bounds", "")
            m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
            if m:
              x1, y1, x2, y2 = map(int, m.groups())
              adb.tap((x1 + x2) // 2, (y1 + y2) // 2)
              logger.log("google", f'клик UI: "{raw}"')
              return True
    time.sleep(0.35)
  return False


def _is_email_screen(blob: str) -> bool:
  return (
    "используйте аккаунт google" in blob
    or "phone or email" in blob
    or ("google" in blob and "далее" in blob and "создать аккаунт" in blob)
  )


def _is_password_screen(blob: str) -> bool:
  if _is_email_screen(blob):
    return False
  return (
    "забыли пароль" in blob
    or "enter your password" in blob
    or "введите пароль" in blob
    or ("@" in blob and "далее" in blob and "используйте аккаунт google" not in blob)
  )


def _wait_email_screen(adb: AdbClient, cfg: BotConfig, vision: Vision) -> None:
  deadline = time.time() + cfg.wait_timeout_sec
  while time.time() < deadline:
    root = _ui_dump(adb)
    if root and _is_email_screen(_blob(root)):
      return
    if vision.tap_template("google_next", timeout=1, fallback_coord=None):
      pass
    time.sleep(cfg.delay_ui_poll_sec)
  raise TimeoutError("Экран ввода email Google не появился")


def _wait_password_screen(adb: AdbClient, cfg: BotConfig) -> None:
  deadline = time.time() + cfg.wait_timeout_sec
  while time.time() < deadline:
    root = _ui_dump(adb)
    if root and _is_password_screen(_blob(root)):
      return
    time.sleep(cfg.delay_ui_poll_sec)
  raise TimeoutError("Экран ввода пароля Google не появился")


def _tap_next(vision: Vision, cfg: BotConfig, adb: AdbClient) -> None:
  if not vision.tap_any(
    ["google_next"],
    fallback_coord=cfg.coord("google_next"),
    timeout=5,
  ):
    _click_text(adb, ["Далее", "Next", "ДАЛЕЕ"])


def _accept_google_screens(vision: Vision, cfg: BotConfig, adb: AdbClient) -> None:
  labels = [
    "Понятно", "Got it", "Принимаю", "I agree", "Accept",
    "Ещё", "More", "Принять", "Agree",
  ]
  for _ in range(8):
    if vision.tap_any(["google_agree", "google_accept"], timeout=2):
      continue
    if _click_text(adb, labels, timeout=2):
      continue
    time.sleep(0.5)


def google_sign_in(
  adb: AdbClient,
  vision: Vision,
  cfg: BotConfig,
  account: Account,
) -> None:
  """Email → Далее → пароль → Далее → согласия Google."""
  logger.log("google", f"вход: {account.email}")

  _wait_email_screen(adb, cfg, vision)

  if not vision.tap_template("google_next", timeout=2, fallback_coord=cfg.coord("google_email_field")):
    adb.tap(*cfg.coord("google_email_field"))
  time.sleep(0.15)
  adb.input_text(account.email)
  time.sleep(0.2)
  _tap_next(vision, cfg, adb)

  _wait_password_screen(adb, cfg)
  if not vision.tap_template("google_password", timeout=2, fallback_coord=cfg.coord("google_password_field")):
    adb.tap(*cfg.coord("google_password_field"))
  time.sleep(0.15)
  adb.input_text(account.password)
  time.sleep(0.2)
  _tap_next(vision, cfg, adb)

  _accept_google_screens(vision, cfg, adb)
  logger.log("google", "авторизация Google завершена")
