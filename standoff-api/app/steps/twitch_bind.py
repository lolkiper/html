"""Bind Twitch account inside Standoff 2 settings."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.models import AccountCredentials
from app.steps.twitch_browser import ensure_twitch_login_in_chrome, prepare_chrome_for_twitch

COORD_LOBBY_SETTINGS = (1200, 40)
COORD_SETTINGS_GAME_TAB = (400, 180)
COORD_BIND_TWITCH = (640, 520)

_TWITCH_LOGIN_HINTS = ["Username", "Логин", "Email", "Имя пользователя"]
_TWITCH_PASSWORD_HINTS = ["Password", "Пароль"]
_LOGIN_BTN = ["Log in", "Войти", "Sign in"]
_AUTH_BTN = ["Authorize", "Авторизовать", "Allow", "Разрешить", "Accept", "Принять"]


def is_twitch_already_linked(device: AdbDevice) -> bool:
    device.tap_coord(COORD_LOBBY_SETTINGS)
    time.sleep(0.8)
    device.tap_coord(COORD_SETTINGS_GAME_TAB)
    time.sleep(0.8)
    linked = device.wait_for("text", "Unlink", timeout=3) or device.wait_for(
        "text", "Отвязать", timeout=2
    )
    device.shell("input keyevent 4")
    time.sleep(0.3)
    device.shell("input keyevent 4")
    return linked


def step_twitch_bind(device: AdbDevice, account: AccountCredentials, skip_if_linked: bool) -> bool:
    if skip_if_linked and is_twitch_already_linked(device):
        device.log("Twitch уже привязан — пропуск")
        return True

    chrome_pkg = prepare_chrome_for_twitch(device)

    device.tap_coord(COORD_LOBBY_SETTINGS)
    time.sleep(1.0)
    device.tap_coord(COORD_SETTINGS_GAME_TAB)
    time.sleep(0.8)

    if not device.click_any(
        ["Bind Twitch", "Привязать Twitch", "Link Twitch", "Twitch", "Привязать"],
        timeout=12,
        fast=True,
    ):
        device.tap_coord(COORD_BIND_TWITCH)

    time.sleep(1.5)
    ensure_twitch_login_in_chrome(device, chrome_pkg)

    if not device.fill_field(_TWITCH_LOGIN_HINTS, account.twitch_login, text_only=False):
        if not device.click_edittext(0, fast=True):
            raise TimeoutError("Поле логина Twitch не найдено")
        time.sleep(0.15)
        device.input_text(account.twitch_login)
    device.click_any(["Next", "Далее", "Continue"], timeout=5, fast=True)

    if not device.fill_field(_TWITCH_PASSWORD_HINTS, account.twitch_password):
        if not device.click_edittext(0, fast=True):
            raise TimeoutError("Поле пароля Twitch не найдено")
        time.sleep(0.15)
        device.input_text(account.twitch_password)

    device.click_any(_LOGIN_BTN, timeout=10, fast=True)
    time.sleep(2.0)
    device.click_any(_AUTH_BTN, timeout=12, fast=True)
    time.sleep(2.0)

    device.log(f"Twitch {account.twitch_login} привязан к Standoff")
    return True
