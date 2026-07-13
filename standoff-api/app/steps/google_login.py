"""Add Google account on Android emulator."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.models import AccountCredentials


def step_google_account(device: AdbDevice, account: AccountCredentials) -> None:
    device.shell("am start -n com.android.settings/.Settings")
    time.sleep(2)

    intents = [
        "am start -a android.settings.ADD_ACCOUNT_SETTINGS",
        "am start -n com.android.settings/.accounts.AddAccountSettings",
    ]
    opened = False
    for intent in intents:
        device.shell(intent)
        time.sleep(2)
        if device.wait_for("text", "Google", timeout=6):
            opened = True
            break
        if device.wait_for("text", "Аккаунт", timeout=4):
            opened = True
            break

    if not opened:
        raise TimeoutError("Не открылось окно добавления Google-аккаунта")

    if not device.click_any(["Google", "Гугл"]):
        raise TimeoutError("Кнопка Google не найдена")

    device.click_any(["Sign in", "Войти"], timeout=15)
    device.rnd_delay()

    if not device.fill_field(
        ["Email or phone", "Phone or email", "Электронная почта", "Телефон или email"],
        account.google_login,
    ):
        raise TimeoutError("Поле email Google не найдено")
    device.click_any(["Next", "Далее"], timeout=12)
    device.rnd_delay()

    if not device.fill_field(["Enter your password", "Пароль", "Password"], account.google_password):
        raise TimeoutError("Поле пароля Google не найдено")
    device.click_any(["Next", "Далее"], timeout=12)
    device.rnd_delay()

    for _ in range(5):
        if device.click_any(["I agree", "Принимаю", "Accept", "Принять"], timeout=4):
            device.rnd_delay()
            continue
        if device.click_any(["Skip", "Пропустить", "Not now", "Не сейчас"], timeout=3):
            device.rnd_delay()
            continue
        break

    device.log(f"Google аккаунт {account.google_login} добавлен")
