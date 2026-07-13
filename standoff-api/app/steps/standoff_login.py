"""Вход в Standoff 2 после запуска игры — все экраны по тексту."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.models import AccountCredentials
from app.steps.google_signin_form import step_google_signin_form

_ALLOW_LABELS = ["РАЗРЕШИТЬ", "Разрешить", "ALLOW", "Allow"]
_LEGAL_ACCEPT_LABELS = ["ПРИНИМАЮ", "Принимаю", "I ACCEPT", "I accept"]
_GOOGLE_LOGIN_LABELS = [
    "Вход с помощью Google",
    "Sign in with Google",
    "Login with Google",
    "Войти с Google",
]
_CONTINUE_LABELS = ["Continue", "Продолжить", "Select", "Выбрать"]


def _reach_google_login_button(device: AdbDevice, timeout: float = 90.0) -> bool:
    """Ждёт нужный экран и сразу жмёт «Вход с помощью Google», если он уже виден."""
    deadline = time.time() + timeout

    while time.time() < deadline:
        if device.has_text(_GOOGLE_LOGIN_LABELS):
            device.log('Экран входа — клик по тексту "Вход с помощью Google"')
            return device.click_text(_GOOGLE_LOGIN_LABELS, timeout=8)

        if device.has_text(_ALLOW_LABELS):
            device.log('Разрешение — клик по тексту "РАЗРЕШИТЬ"')
            device.click_text(_ALLOW_LABELS, timeout=4, quiet=True)
            device.rnd_delay()
            continue

        if device.has_text(_LEGAL_ACCEPT_LABELS):
            device.log('Юридическая информация — клик по тексту "ПРИНИМАЮ"')
            device.click_text(_LEGAL_ACCEPT_LABELS, timeout=4, quiet=True)
            device.rnd_delay()
            continue

        time.sleep(1.5)

    return False


def step_standoff_login(device: AdbDevice, account: AccountCredentials) -> None:
    device.log("Ожидание загрузки Standoff 2...")
    time.sleep(8)

    if not _reach_google_login_button(device):
        raise TimeoutError('Кнопка "Вход с помощью Google" не найдена')

    device.log("Google вход (email → Далее → пароль → Далее)...")
    step_google_signin_form(device, account)

    if device.has_text(_CONTINUE_LABELS):
        device.log("Выбор аккаунта Google...")
        device.click_text(_CONTINUE_LABELS, timeout=8, quiet=True)

    if device.wait_for("text", "PLAY", timeout=15) or device.wait_for("text", "ИГРАТЬ", timeout=10):
        device.log("Лобби Standoff 2 открыто")
    else:
        device.log("Лобби может быть уже открыто — продолжаем")

    device.log("Вход в Standoff 2 выполнен")
