"""OpenCV template matching on emulator screenshots."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from opencv_bot.adb import AdbClient
from opencv_bot.bot_config import BotConfig
from opencv_bot import logger


@dataclass
class Match:
  name: str
  x: int
  y: int
  score: float


class Vision:
  def __init__(self, adb: AdbClient, cfg: BotConfig) -> None:
    self.adb = adb
    self.cfg = cfg
    self.shots_dir = cfg.path(cfg.screenshots_dir)
    self.shots_dir.mkdir(parents=True, exist_ok=True)
    self._screen_cache: Path | None = None

  def capture(self, tag: str = "screen") -> Path:
    path = self.shots_dir / f"{tag}_{int(time.time() * 1000)}.png"
    if not self.adb.screenshot_png(path):
      raise RuntimeError("Не удалось сделать скриншот через ADB")
    self._screen_cache = path
    return path

  def save_error_shot(self, email: str, step: str) -> Path:
    safe = email.split("@")[0].replace(".", "_")[:24]
    path = self.shots_dir / f"error_{safe}_{step}_{int(time.time())}.png"
    try:
      self.capture("error")
      if self._screen_cache and self._screen_cache.exists():
        self._screen_cache.replace(path)
    except Exception:
      pass
    logger.log("vision", f"скрин ошибки: {path.name}")
    return path

  @staticmethod
  def _load_bgr(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
      raise RuntimeError(f"Не удалось прочитать изображение: {path}")
    return img

  def match_template(
    self,
    screen_path: Path,
    template_path: Path,
    threshold: float | None = None,
  ) -> Match | None:
    if not template_path.is_file():
      return None
    thr = threshold if threshold is not None else self.cfg.template_threshold
    screen = self._load_bgr(screen_path)
    template = self._load_bgr(template_path)
    if template.shape[0] > screen.shape[0] or template.shape[1] > screen.shape[1]:
      return None
    result = cv2.matchTemplate(screen, template, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)
    if max_val < thr:
      return None
    h, w = template.shape[:2]
    return Match(
      name=template_path.stem,
      x=max_loc[0] + w // 2,
      y=max_loc[1] + h // 2,
      score=float(max_val),
    )

  def find(
    self,
    template_key: str,
    screen: Path | None = None,
  ) -> Match | None:
    screen_path = screen or self.capture(template_key)
    tpl = self.cfg.template_path(template_key)
    match = self.match_template(screen_path, tpl)
    if match:
      logger.log("vision", f'шаблон "{template_key}" → ({match.x},{match.y}) score={match.score:.2f}')
    return match

  def wait_for(
    self,
    template_key: str,
    timeout: float | None = None,
  ) -> Match | None:
    deadline = time.time() + (timeout or self.cfg.wait_timeout_sec)
    while time.time() < deadline:
      screen = self.capture(f"wait_{template_key}")
      match = self.match_template(screen, self.cfg.template_path(template_key))
      if match:
        match.name = template_key
        logger.log("vision", f'найден "{template_key}" ({match.x},{match.y})')
        return match
      time.sleep(self.cfg.delay_ui_poll_sec)
    return None

  def tap_template(
    self,
    template_key: str,
    *,
    timeout: float | None = None,
    fallback_coord: tuple[int, int] | None = None,
  ) -> bool:
    match = self.wait_for(template_key, timeout=timeout) if timeout else self.find(template_key)
    if match:
      self.adb.tap(match.x, match.y)
      time.sleep(self.cfg.delay_after_screen_sec)
      return True
    if fallback_coord:
      logger.log("vision", f'шаблон "{template_key}" не найден → тап {fallback_coord}')
      self.adb.tap(fallback_coord[0], fallback_coord[1])
      time.sleep(self.cfg.delay_after_screen_sec)
      return True
    return False

  def tap_any(
    self,
    template_keys: list[str],
    fallback_coord: tuple[int, int] | None = None,
    timeout: float | None = None,
  ) -> bool:
    deadline = time.time() + (timeout or self.cfg.wait_timeout_sec)
    while time.time() < deadline:
      screen = self.capture("tap_any")
      for key in template_keys:
        match = self.match_template(screen, self.cfg.template_path(key))
        if match:
          logger.log("vision", f'тап по "{key}" ({match.x},{match.y})')
          self.adb.tap(match.x, match.y)
          time.sleep(self.cfg.delay_after_screen_sec)
          return True
      time.sleep(self.cfg.delay_ui_poll_sec)
    if fallback_coord:
      self.adb.tap(fallback_coord[0], fallback_coord[1])
      return True
    return False

  def crop_roi(self, screen_path: Path, roi: tuple[int, int, int, int]) -> Image.Image:
    x1, y1, x2, y2 = roi
    img = Image.open(screen_path)
    return img.crop((x1, y1, x2, y2))
