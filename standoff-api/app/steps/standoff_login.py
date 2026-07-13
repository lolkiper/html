"""Вход в Standoff 2 после запуска игры."""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET

from app.adb.device import AdbDevice
from app.config import AppConfig
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
_UNITY_MARKERS = ["game view", "unity view", "standoff"]


def _visible_labels(root: ET.Element) -> list[str]:
    seen: list[str] = []
    for node in root.iter():
        for attr in ("text", "content-desc"):
            raw = (node.attrib.get(attr) or "").strip()
            if raw and raw not in seen:
                seen.append(raw)
    return seen


def _sample_visible_labels(device: AdbDevice) -> str:
    root = device.uiautomator_dump()
    if root is None:
        return "UI dump пуст"
    seen = _visible_labels(root)
    if not seen:
        return "тексты на экране не найдены"
    return "На экране: " + " | ".join(seen[:10])


def _is_unity_game_screen(root: ET.Element) -> bool:
    labels = [label.lower() for label in _visible_labels(root)]
    if not labels:
        return False
    if any(marker in label for label in labels for marker in _UNITY_MARKERS):
        return True
    return len(labels) <= 2


def _tap_google_button(device: AdbDevice, coord: tuple[int, int], reason: str) -> bool:
    device.log(f"{reason} — тап кнопки Google {coord} (1280x720)")
    device.tap_coord(coord)
    device.rnd_delay()
    return True


def _reach_google_login_button(
    device: AdbDevice,
    google_coord: tuple[int, int],
    timeout: float = 120.0,
) -> bool:
    deadline = time.time() + timeout
    last_debug = 0.0
    unity_hits = 0

    while time.time() < deadline:
        root = device.uiautomator_dump()

        if device.has_text(_GOOGLE_LOGIN_LABELS):
            device.log('Клик по тексту "Вход с помощью Google"')
            if device.click_text(_GOOGLE_LOGIN_LABELS, timeout=8):
                return True

        if device.has_text(_ALLOW_LABELS):
            device.log('Разрешение — клик по тексту "РАЗРЕШИТЬ"')
            device.click_text(_ALLOW_LABELS, timeout=4, quiet=True)
            device.rnd_delay()
            unity_hits = 0
            continue

        if device.has_text(_LEGAL_ACCEPT_LABELS):
            device.log('Юридическая информация — клик по тексту "ПРИНИМАЮ"')
            device.click_text(_LEGAL_ACCEPT_LABELS, timeout=4, quiet=True)
            device.rnd_delay()
            unity_hits = 0
            continue

        if root is not None and _is_unity_game_screen(root):
            unity_hits += 1
            if unity_hits >= 2:
                return _tap_google_button(
                    device,
                    google_coord,
                    "Unity-экран (Game view) — текст кнопок недоступен",
                )
        else:
            unity_hits = 0

        now = time.time()
        if now - last_debug > 12:
            device.log(_sample_visible_labels(device))
            last_debug = now

        time.sleep(2.0)

    return _tap_google_button(device, google_coord, "Таймаут — запасной тап")


def step_standoff_login(
    device: AdbDevice,
    account: AccountCredentials,
    config: AppConfig | None = None,
) -> None:
    cfg = config or AppConfig.load()
    google_coord = (cfg.standoff_google_x, cfg.standoff_google_y)

    device.log("Ожидание экрана входа Standoff 2...")
    _reach_google_login_button(device, google_coord)

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
