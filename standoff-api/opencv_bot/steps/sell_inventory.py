"""Шаг 5: продажа кейсов по цене запроса (OCR + OpenCV)."""

from __future__ import annotations

import time

from opencv_bot.adb import AdbClient
from opencv_bot.bot_config import BotConfig
from opencv_bot import logger
from opencv_bot.ocr import read_order_price
from opencv_bot.vision import Vision


def open_inventory(adb: AdbClient, vision: Vision, cfg: BotConfig) -> None:
  logger.log("sell", "переход в инвентарь...")
  vision.tap_template(
    "inventory",
    timeout=cfg.wait_timeout_sec,
    fallback_coord=cfg.coord("inventory"),
  )
  vision.tap_any(
    ["market_tab"],
    fallback_coord=cfg.coord("market_tab"),
    timeout=8,
  )
  adb.tap(*cfg.coord("my_items"))
  time.sleep(cfg.delay_after_screen_sec)


def _enter_price(adb: AdbClient, vision: Vision, cfg: BotConfig, price: str) -> None:
  vision.tap_template("price_input", timeout=3, fallback_coord=cfg.coord("price_input"))
  time.sleep(0.15)
  # Очистка поля
  adb.shell("input keyevent 67")
  adb.shell("input keyevent 67")
  adb.shell("input keyevent 67")
  adb.input_text(price)
  time.sleep(0.2)


def sell_all_cases(adb: AdbClient, vision: Vision, cfg: BotConfig) -> tuple[int, float]:
  """Продаёт кейсы; возвращает (кол-во, суммарная gold)."""
  open_inventory(adb, vision, cfg)
  sold = 0
  total_gold = 0.0
  roi = cfg.order_price_roi()

  for attempt in range(cfg.max_cases_per_account):
    logger.log("sell", f"поиск кейса ({attempt + 1}/{cfg.max_cases_per_account})...")

    if not vision.tap_any(["case_item"], timeout=4):
      logger.log("sell", "кейсы не найдены — выход из цикла")
      break

    vision.tap_any(["sell_button"], fallback_coord=cfg.coord("sell_button"), timeout=6)
    time.sleep(cfg.delay_after_screen_sec)

    screen = vision.capture("market_price")
    price = read_order_price(screen, roi, cfg)

    if not price:
      logger.log("sell", "OCR не распознал цену — тап по минимальной цене (координаты)")
      adb.tap(*cfg.coord("price_input"))
      price = "1"

    logger.log("sell", f"продажа по цене запроса: {price} G")
    _enter_price(adb, vision, cfg, price)

    vision.tap_any(
      ["create_order", "confirm_sell"],
      fallback_coord=cfg.coord("confirm_sell"),
      timeout=8,
    )

    try:
      total_gold += float(price.replace(",", "."))
    except ValueError:
      total_gold += 1.0
    sold += 1
    logger.log("sell", f"кейс #{sold} выставлен на продажу")
    time.sleep(0.8)

    if attempt % 4 == 3:
      adb.back()
      time.sleep(0.4)
      adb.tap(*cfg.coord("my_items"))
      time.sleep(0.5)

  logger.log("sell", f"итого продано: {sold}, ~{total_gold:.2f} G")
  return sold, total_gold
