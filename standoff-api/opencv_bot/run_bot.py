#!/usr/bin/env python3
"""
Standoff 2 LDPlayer bot — OpenCV + ADB + OCR.

Запуск (из папки standoff-api):
  pip install -r requirements-opencv.txt
  copy opencv_bot\\config.example.json opencv_bot\\config.json
  copy opencv_bot\\accounts.example.txt opencv_bot\\accounts.txt
  python -m opencv_bot.run_bot

Формат accounts.txt:
  email@gmail.com:password
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback
from pathlib import Path

# Чтобы работало и как модуль, и при прямом запуске
if __name__ == "__main__" and __package__ is None:
  sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from opencv_bot.accounts import Account, load_pending_accounts, mark_done, mark_error
from opencv_bot.adb import connect_ldplayer
from opencv_bot.bot_config import BOT_DIR, BotConfig
from opencv_bot import logger
from opencv_bot.steps.cleanup import clear_for_new_account
from opencv_bot.steps.game_flow import launch_standoff, wait_lobby
from opencv_bot.steps.google_auth import google_sign_in
from opencv_bot.steps.logout import logout_and_reset
from opencv_bot.steps.sell_inventory import sell_all_cases
from opencv_bot.vision import Vision


def process_account(
  idx: int,
  total: int,
  account: Account,
  cfg: BotConfig,
) -> None:
  """Полный цикл для одного Google-аккаунта."""
  adb = connect_ldplayer(cfg)
  vision = Vision(adb, cfg)
  t0 = time.time()

  logger.log_account(idx, total, account.email, "старт")

  # 1–2. Очистка
  clear_for_new_account(adb, cfg)

  # 3. Запуск игры + кнопка Google
  launch_standoff(adb, vision, cfg)
  google_sign_in(adb, vision, cfg, account)

  # 4. Лобби
  wait_lobby(vision, cfg)

  # 5. Продажа кейсов
  sold, gold = sell_all_cases(adb, vision, cfg)
  logger.log_account(idx, total, account.email, f"продано кейсов={sold} gold≈{gold:.1f}")

  # 6. Логаут
  logout_and_reset(adb, cfg)

  elapsed = time.time() - t0
  mark_done(cfg, account, f"sold={sold} gold={gold:.1f} time={elapsed:.0f}s")
  logger.log_account(idx, total, account.email, f"OK за {elapsed:.0f}s → done.txt")


def main() -> int:
  parser = argparse.ArgumentParser(description="Standoff 2 LDPlayer OpenCV bot")
  parser.add_argument("--limit", type=int, default=0, help="Обработать только N аккаунтов (0 = все)")
  parser.add_argument("--config", type=str, default="", help="Путь к config.json")
  args = parser.parse_args()

  cfg_path = Path(args.config) if args.config else None
  cfg = BotConfig.load(cfg_path)

  accounts = load_pending_accounts(cfg)
  if not accounts:
    logger.log_error(
      f"Нет аккаунтов в {BOT_DIR / cfg.accounts_file}. "
      f"Формат: email:password"
    )
    return 1

  if args.limit > 0:
    accounts = accounts[: args.limit]

  logger.log("bot", f"аккаунтов к обработке: {len(accounts)}")
  logger.log("bot", f"шаблоны: {BOT_DIR / 'templates'} (положи PNG при необходимости)")
  logger.log("bot", f"скриншоты ошибок: {BOT_DIR / cfg.screenshots_dir}")

  total = len(accounts)
  ok = 0
  err = 0

  for idx, account in enumerate(accounts, start=1):
    try:
      process_account(idx, total, account, cfg)
      ok += 1
    except Exception as exc:
      err += 1
      logger.log_account(idx, total, account.email, f"ОШИБКА: {exc}")
      logger.log_error(traceback.format_exc())
      try:
        adb = connect_ldplayer(cfg)
        vision = Vision(adb, cfg)
        vision.save_error_shot(account.email, "fail")
        logout_and_reset(adb, cfg)
      except Exception:
        pass
      mark_error(cfg, account, str(exc)[:120])

  logger.log("bot", f"готово: ok={ok} err={err}")
  return 0 if err == 0 else 1


if __name__ == "__main__":
  raise SystemExit(main())
