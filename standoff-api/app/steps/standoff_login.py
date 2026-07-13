"""Launch Standoff 2 and login via Google."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.adb.ldplayer import STANDOFF_PACKAGE

# Координаты для 1280x720 — подстрой в config при другом разрешении
COORD_LOGIN_GOOGLE = (640, 420)
COORD_GAME_LOAD = (640, 360)


def step_standoff_login(device: AdbDevice) -> None:
    device.shell(
        f"am start -n {STANDOFF_PACKAGE}/com.unity3d.player.UnityPlayerActivity"
    )
    time.sleep(12)

    for _ in range(3):
        device.tap_coord(COORD_GAME_LOAD)
        time.sleep(2)

    if device.click_any(["Google", "Гугл", "Sign in with Google"], timeout=25):
        device.rnd_delay()
    else:
        device.tap_coord(COORD_LOGIN_GOOGLE)

    device.rnd_delay()
    if device.click_any(["Continue", "Продолжить", "Select", "Выбрать"], timeout=20):
        device.rnd_delay()

    if not device.wait_for("text", "PLAY", timeout=15) and not device.wait_for(
        "text", "ИГРАТЬ", timeout=10
    ):
        device.log("Лобби может быть уже открыто — продолжаем")
    device.log("Вход в Standoff 2 выполнен")
