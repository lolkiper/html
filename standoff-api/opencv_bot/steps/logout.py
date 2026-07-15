"""Шаг 6: выход из аккаунта и подготовка к следующему."""

from __future__ import annotations

from opencv_bot.adb import AdbClient
from opencv_bot.bot_config import BotConfig
from opencv_bot import logger
from opencv_bot.steps.cleanup import clear_for_new_account


def logout_and_reset(adb: AdbClient, cfg: BotConfig) -> None:
  logger.log("logout", "выход из игры и сброс данных...")
  adb.force_stop(cfg.standoff_package)
  clear_for_new_account(adb, cfg)
  adb.home()
  logger.log("logout", "готово к следующему аккаунту")
