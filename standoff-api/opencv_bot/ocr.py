"""OCR for order price digits (pytesseract)."""

from __future__ import annotations

import re
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from opencv_bot.bot_config import BotConfig
from opencv_bot import logger

_DIGITS_RE = re.compile(r"[\d.]+")


def _prepare_for_ocr(img: Image.Image) -> np.ndarray:
  gray = np.array(img.convert("L"))
  scaled = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
  _, binary = cv2.threshold(scaled, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
  return binary


def read_price_from_image(img: Image.Image, cfg: BotConfig) -> str | None:
  try:
    import pytesseract
  except ImportError:
    logger.log_error("pytesseract не установлен: pip install pytesseract")
    return None

  cmd = str(cfg.ocr.get("tesseract_cmd", "") or "").strip()
  if cmd:
    pytesseract.pytesseract.tesseract_cmd = cmd

  whitelist = str(cfg.ocr.get("whitelist", "0123456789."))
  processed = _prepare_for_ocr(img)
  text = pytesseract.image_to_string(
    processed,
    config=f"--psm 7 -c tessedit_char_whitelist={whitelist}",
  )
  matches = _DIGITS_RE.findall(text.replace(",", "."))
  if not matches:
    return None
  # Берём самое длинное число (обычно цена)
  best = max(matches, key=len)
  logger.log("ocr", f"распознана цена: {best} (raw={text.strip()!r})")
  return best


def read_order_price(screen_path: Path, roi: tuple[int, int, int, int], cfg: BotConfig) -> str | None:
  x1, y1, x2, y2 = roi
  img = Image.open(screen_path).crop((x1, y1, x2, y2))
  return read_price_from_image(img, cfg)
