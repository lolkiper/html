"""OpenCV template matching for UI element detection."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from adb_client import AdbClient
from config import TEMPLATES_DIR, AppConfig
from logger_setup import setup_logger

log = setup_logger(__name__)


@dataclass
class MatchResult:
    x: int
    y: int
    confidence: float
    width: int
    height: int

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.width // 2, self.y + self.height // 2


class Vision:
    def __init__(self, adb: AdbClient, config: AppConfig) -> None:
        self.adb = adb
        self.config = config

    def capture_bgr(self) -> np.ndarray:
        png_bytes = self.adb.screenshot_png()
        arr = np.frombuffer(png_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise RuntimeError("Failed to decode screenshot")
        return img

    def _load_template(self, name: str) -> Optional[np.ndarray]:
        path = TEMPLATES_DIR / name
        if not path.exists():
            log.warning("Template missing: %s", path)
            return None
        tpl = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if tpl is None:
            log.warning("Failed to read template: %s", path)
        return tpl

    def find_template(
        self,
        screen: np.ndarray,
        template_name: str,
        threshold: Optional[float] = None,
    ) -> Optional[MatchResult]:
        tpl = self._load_template(template_name)
        if tpl is None:
            return None

        th = threshold if threshold is not None else self.config.templates.match_threshold
        result = cv2.matchTemplate(screen, tpl, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)

        if max_val < th:
            return None

        h, w = tpl.shape[:2]
        return MatchResult(
            x=max_loc[0],
            y=max_loc[1],
            confidence=float(max_val),
            width=w,
            height=h,
        )

    def wait_and_tap(
        self,
        template_name: str,
        timeout: Optional[float] = None,
        optional: bool = False,
    ) -> bool:
        deadline = time.time() + (timeout or self.config.template_timeout)
        while time.time() < deadline:
            screen = self.capture_bgr()
            match = self.find_template(screen, template_name)
            if match:
                cx, cy = match.center
                log.info(
                    "Tap %s at (%d,%d) conf=%.2f",
                    template_name,
                    cx,
                    cy,
                    match.confidence,
                )
                self.adb.tap(cx, cy)
                return True
            time.sleep(0.8)

        msg = f"Template not found: {template_name}"
        if optional:
            log.warning("%s (optional, skipped)", msg)
            return False
        log.error(msg)
        return False

    def is_visible(self, template_name: str) -> bool:
        screen = self.capture_bgr()
        return self.find_template(screen, template_name) is not None

    def crop_region(
        self,
        screen: np.ndarray,
        region: tuple[int, int, int, int],
    ) -> np.ndarray:
        x1, y1, x2, y2 = region
        return screen[y1:y2, x1:x2].copy()
