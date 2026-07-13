"""Bind Twitch account inside Standoff 2 settings."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.models import AccountCredentials

COORD_LOBBY_SETTINGS = (1200, 40)
COORD_SETTINGS_GAME_TAB = (400, 180)
COORD_BIND_TWITCH = (640, 520)


def is_twitch_already_linked(device: AdbDevice) -> bool:
    device.tap_coord(COORD_LOBBY_SETTINGS)
    time.sleep(1.5)
    device.tap_coord(COORD_SETTINGS_GAME_TAB)
    time.sleep(1.5)
    linked = device.wait_for("text", "Unlink", timeout=4) or device.wait_for(
        "text", "Отвязать", timeout=3
    )
    device.shell("input keyevent 4")
    time.sleep(0.5)
    device.shell("input keyevent 4")
    return linked


def step_twitch_bind(device: AdbDevice, account: AccountCredentials, skip_if_linked: bool) -> bool:
    if skip_if_linked and is_twitch_already_linked(device):
        device.log("Twitch уже привязан — пропуск")
        return True

    device.tap_coord(COORD_LOBBY_SETTINGS)
    time.sleep(2)
    device.tap_coord(COORD_SETTINGS_GAME_TAB)
    time.sleep(1.5)

    if not device.click_any(
        ["Bind Twitch", "Привязать Twitch", "Link Twitch", "Twitch"],
        timeout=20,
    ):
        device.tap_coord(COORD_BIND_TWITCH)

    time.sleep(3)

    if not device.fill_field(["Username", "Логин", "Email"], account.twitch_login):
        raise TimeoutError("Поле логина Twitch не найдено")
    device.click_any(["Next", "Далее", "Continue"], timeout=10)
    device.rnd_delay()

    if not device.fill_field(["Password", "Пароль"], account.twitch_password):
        raise TimeoutError("Поле пароля Twitch не найдено")

    device.click_any(["Log in", "Войти", "Authorize", "Авторизовать"], timeout=20)
    time.sleep(5)
    device.click_any(["Authorize", "Авторизовать", "Allow", "Разрешить"], timeout=20)
    time.sleep(4)

    device.log(f"Twitch {account.twitch_login} привязан к Standoff")
    return True
