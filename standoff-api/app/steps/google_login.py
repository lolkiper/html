"""Add Google account on Android emulator."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice
from app.models import AccountCredentials

_SIGN_IN_LABELS = ["Sign in", "Войти", "Add account", "Добавить аккаунт"]
_DISMISS_LABELS = [
    "Закрыть",
    "Close",
    "OK",
    "Ок",
    "Got it",
    "Понятно",
    "Dismiss",
    "No thanks",
    "Не сейчас",
    "Not now",
    "Пропустить",
    "Skip",
]
_GOOGLE_INFO_MARKERS = [
    "после входа в аккаунт google",
    "after signing in to your google",
    "сервисы google",
    "google services",
]


def _screen_has_sign_in(device: AdbDevice) -> bool:
    root = device.uiautomator_dump()
    if root is None:
        return False
    return any(device.find_node(root, "text", label) is not None for label in _SIGN_IN_LABELS)


def _dismiss_google_overlays(device: AdbDevice, max_rounds: int = 10) -> None:
    """Close Google Play Services info popups that block the Sign in screen."""
    for round_idx in range(max_rounds):
        if _screen_has_sign_in(device):
            return

        root = device.uiautomator_dump()
        if root is not None:
            for node in root.iter():
                text = (node.attrib.get("text") or "").lower()
                if any(marker in text for marker in _GOOGLE_INFO_MARKERS):
                    device.log("Попап Google Services — закрываем...")
                    break

        clicked = False
        for label in _DISMISS_LABELS:
            if device.click_by_ui("text", label, timeout=2):
                clicked = True
                device.rnd_delay()
                break
            if device.click_by_ui("content-desc", label, timeout=1):
                clicked = True
                device.rnd_delay()
                break

        if clicked:
            continue

        if round_idx >= 3:
            device.log("Попап не закрылся по тексту — BACK")
            device.shell("input keyevent 4")
            time.sleep(1.2)
        else:
            time.sleep(1.0)


def _click_sign_in(device: AdbDevice, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _screen_has_sign_in(device):
            for label in _SIGN_IN_LABELS:
                if device.click_by_ui("text", label, timeout=3):
                    return True
        _dismiss_google_overlays(device, max_rounds=3)
        time.sleep(0.8)
    return False


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

    device.rnd_delay()
    _dismiss_google_overlays(device)
    if not _click_sign_in(device):
        raise TimeoutError('Кнопка "Sign in" / "Войти" не найдена (попап Google Services?)')
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
