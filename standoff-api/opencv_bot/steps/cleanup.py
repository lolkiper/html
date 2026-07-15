"""Шаг 2: очистка данных перед новым аккаунтом."""

from __future__ import annotations

from opencv_bot.adb import AdbClient
from opencv_bot.bot_config import BotConfig
from opencv_bot import logger


def clear_for_new_account(adb: AdbClient, cfg: BotConfig) -> None:
  logger.log("cleanup", "остановка Standoff 2 и очистка данных...")
  adb.force_stop(cfg.standoff_package)
  adb.clear_app(cfg.standoff_package)
  adb.clear_app(cfg.google_play_package)
  logger.log("cleanup", "готово — можно входить в новый Google-аккаунт")
