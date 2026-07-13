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
_LOBBY_LABELS = ["PLAY", "ИГРАТЬ", "Play", "Играть"]
_CONTINUE_LABELS = ["Continue", "Продолжить", "Select", "Выбрать"]


def _wait_click_text(
    device: AdbDevice,
    labels: list[str],
    *,
    timeout: float = 45.0,
    log_msg: str = "",
    optional: bool = False,
) -> bool:
    if log_msg:
        device.log(log_msg)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if device.click_text(labels, timeout=3):
            device.rnd_delay()
            return True
        time.sleep(1.5)
    if optional:
        device.log(f"Не найдено (пропуск): {labels[0]}")
        return False
    return False


def step_standoff_login(device: AdbDevice, account: AccountCredentials) -> None:
    device.log("Ожидание загрузки Standoff 2...")
    time.sleep(8)

    _wait_click_text(
        device,
        _ALLOW_LABELS,
        timeout=50,
        log_msg='Шаг 1: разрешение — клик по тексту "РАЗРЕШИТЬ"',
        optional=True,
    )

    _wait_click_text(
        device,
        _LEGAL_ACCEPT_LABELS,
        timeout=50,
        log_msg='Шаг 2: юридическая информация — клик по тексту "ПРИНИМАЮ"',
        optional=True,
    )

    if not _wait_click_text(
        device,
        _GOOGLE_LOGIN_LABELS,
        timeout=60,
        log_msg='Шаг 3: клик по тексту "Вход с помощью Google"',
    ):
        raise TimeoutError('Кнопка "Вход с помощью Google" не найдена')

    device.log("Шаг 4: Google вход (email → Далее → пароль → Далее)...")
    step_google_signin_form(device, account)

    _wait_click_text(
        device,
        _CONTINUE_LABELS,
        timeout=20,
        log_msg="Выбор аккаунта Google (если есть)...",
        optional=True,
    )

    if device.wait_for("text", "PLAY", timeout=15) or device.wait_for("text", "ИГРАТЬ", timeout=10):
        device.log("Лобби Standoff 2 открыто")
    else:
        device.log("Лобби может быть уже открыто — продолжаем")

    device.log("Вход в Standoff 2 выполнен")
