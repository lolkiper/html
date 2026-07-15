"""Шаг 4: запуск игры и ожидание лобби."""

from __future__ import annotations

import time

from opencv_bot.adb import AdbClient
from opencv_bot.bot_config import BotConfig
from opencv_bot import logger
from opencv_bot.vision import Vision


def launch_standoff(adb: AdbClient, vision: Vision, cfg: BotConfig) -> None:
  logger.log("game", "запуск Standoff 2...")
  adb.home()
  time.sleep(0.8)

  if not vision.tap_template(
    "standoff_icon",
    timeout=cfg.wait_timeout_sec,
    fallback_coord=cfg.coord("standoff_icon"),
  ):
    adb.launch_app(cfg.standoff_package)

  time.sleep(4.0)
  logger.log("game", "ожидание кнопки Google / лобби...")

  # Разрешения и юридические экраны
  from opencv_bot.steps.google_auth import _click_text, _accept_google_screens

  for label in ("РАЗРЕШИТЬ", "Allow", "ПРИНИМАЮ", "I ACCEPT"):
    _click_text(adb, [label], timeout=2)

  vision.tap_template(
    "google_sign_in",
    timeout=cfg.wait_timeout_sec,
    fallback_coord=cfg.coord("google_sign_in"),
  )


def wait_lobby(vision: Vision, cfg: BotConfig) -> None:
  logger.log("game", "ожидание лобби (PLAY / ИНГРАТЬ)...")
  if vision.tap_any(["lobby_play"], timeout=cfg.wait_timeout_sec):
    logger.log("game", "лобби загружено")
    return
  # Если шаблона нет — просто ждём
  time.sleep(5.0)
  logger.log("game", "лобби (таймаут шаблона — продолжаем)")
