"""Запуск Standoff 2 с рабочего стола LDPlayer — тап по иконке."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.config import AppConfig


def step_launch_standoff_from_home(device: AdbDevice, config: AppConfig | None = None) -> None:
    """Домой → найти «Standoff 2» → клик (или запасные координаты)."""
    cfg = config or AppConfig.load()
    coord = (cfg.standoff_icon_x, cfg.standoff_icon_y)

    device.log("Возврат на рабочий стол LDPlayer...")
    device.shell("input keyevent 3")  # HOME
    time.sleep(1.5)

    device.log("Ищу иконку Standoff 2...")
    labels = [
        "Standoff 2",
        "Standoff2",
        "STANDOFF 2",
        "Standoff",
    ]
    for label in labels:
        if device.click_by_ui("text", label, timeout=8):
            device.log(f"Нажата иконка Standoff 2 (текст «{label}»)")
            time.sleep(6)
            return
        if device.click_by_ui("content-desc", label, timeout=4):
            device.log(f"Нажата иконка Standoff 2 (desc «{label}»)")
            time.sleep(6)
            return

    device.log(f"Текст не найден — тап по координатам {coord} (1280x720)")
    device.tap_coord(coord)
    time.sleep(6)
    device.log("Ожидание загрузки Standoff 2...")
