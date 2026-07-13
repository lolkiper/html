"""Add Google account via Android Settings (optional)."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.models import AccountCredentials
from app.steps.google_signin_form import (
    dismiss_blocking_popup,
    reach_login_form,
    step_google_signin_form,
)


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

    if not device.click_text(["Google", "Гугл"], timeout=15, exact=True):
        if not device.click_text(["Google", "Гугл"], timeout=10):
            raise TimeoutError("Кнопка Google не найдена")

    device.rnd_delay()
    dismiss_blocking_popup(device)
    if not reach_login_form(device):
        raise TimeoutError("Не удалось открыть форму входа Google")

    step_google_signin_form(device, account)
    device.log(f"Google аккаунт {account.google_login} добавлен")
