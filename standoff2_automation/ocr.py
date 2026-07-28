"""Tesseract OCR for market price digits."""

from __future__ import annotations

import re
from typing import Optional

import cv2
import numpy as np
import pytesseract

from config import AppConfig
from logger_setup import setup_logger

log = setup_logger(__name__)


class PriceOcr:
    def __init__(self, config: AppConfig) -> None:
        self.config = config

    def preprocess(self, bgr: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        scaled = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
        _, binary = cv2.threshold(scaled, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        kernel = np.ones((2, 2), np.uint8)
        cleaned = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        return cleaned

    def read_price(self, region_bgr: np.ndarray) -> Optional[int]:
        processed = self.preprocess(region_bgr)
        config = (
            f"--psm 7 -c tessedit_char_whitelist=0123456789., "
            f"-l {self.config.ocr_lang}"
        )
        raw = pytesseract.image_to_string(processed, config=config)
        log.debug("OCR raw: %r", raw)

        digits = re.sub(r"[^\d]", "", raw)
        if not digits:
            return None

        try:
            price = int(digits)
        except ValueError:
            return None

        if price <= 0:
            return None

        log.info("Parsed market price: %d", price)
        return price
