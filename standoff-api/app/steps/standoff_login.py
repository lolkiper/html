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
    "Вход с помощью",
    "Sign in with Google",
    "Login with Google",
    "Войти с Google",
]
_CONTINUE_LABELS = ["Continue", "Продолжить", "Select", "Выбрать"]
# Запасные координаты кнопки Google (1280x720), если игра не отдаёт текст в UI dump
_FALLBACK_GOOGLE_LOGIN = (380, 600)


def _sample_visible_labels(device: AdbDevice) -> str:
    root = device.uiautomator_dump()
    if root is None:
        return "UI dump пуст"
    seen: list[str] = []
    for node in root.iter():
        for attr in ("text", "content-desc"):
            raw = (node.attrib.get(attr) or "").strip()
            if raw and raw not in seen and len(raw) < 80:
                seen.append(raw)
    if not seen:
        return "тексты на экране не найдены (игра может не отдавать UI)"
    return "На экране: " + " | ".join(seen[:10])


def _reach_google_login_button(device: AdbDevice, timeout: float = 120.0) -> bool:
    """Ждёт экран входа без фиксированной паузы и жмёт Google."""
    deadline = time.time() + timeout
    last_debug = 0.0

    while time.time() < deadline:
        if device.has_text(_GOOGLE_LOGIN_LABELS):
            device.log('Экран входа — клик по тексту "Вход с помощью Google"')
            if device.click_text(_GOOGLE_LOGIN_LABELS, timeout=8):
                return True

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

        now = time.time()
        if now - last_debug > 12:
            device.log(_sample_visible_labels(device))
            last_debug = now

        time.sleep(2.0)

    device.log(
        f'Текст кнопки не найден — запасной тап {_FALLBACK_GOOGLE_LOGIN} (1280x720)'
    )
    device.tap_coord(_FALLBACK_GOOGLE_LOGIN)
    device.rnd_delay()
    return True


def step_standoff_login(device: AdbDevice, account: AccountCredentials) -> None:
    device.log("Ожидание экрана входа Standoff 2...")
    _reach_google_login_button(device)

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
