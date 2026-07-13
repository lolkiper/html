"""Google sign-in overlay: email, password, post-login screens."""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET

from app.adb.device import AdbDevice, normalize_ui_text
from app.models import AccountCredentials

_EMAIL_FIELD_HINTS = [
    "Телефон или адрес эл. почты",
    "Телефон или email",
    "Email or phone",
    "Phone or email",
    "Электронная почта",
]
_PASSWORD_FIELD_HINTS = [
    "Введите пароль",
    "Enter your password",
    "Пароль",
    "Password",
]
_NEXT_LABELS = ["Далее", "ДАЛЕЕ", "Next", "NEXT"]
_SIGN_IN_LABELS = ["Sign in", "Войти", "Add account", "Добавить аккаунт"]
_BLOCKING_POPUP_CLOSE = ["Закрыть", "Close"]
_GOOGLE_INFO_MARKERS = [
    "после входа в аккаунт google",
    "after signing in to your google",
]


def _node_texts(root: ET.Element) -> list[str]:
    return [(node.attrib.get("text") or "").lower() for node in root.iter()]


def _texts_contain(texts: list[str], *needles: str) -> bool:
    return any(any(n in t for n in needles) for t in texts)


def is_popup_blocking(root: ET.Element) -> bool:
    texts = _node_texts(root)
    has_close = _texts_contain(texts, "закрыть", "close")
    has_info = _texts_contain(texts, *_GOOGLE_INFO_MARKERS)
    return has_close and has_info


def _screen_text_blob(root: ET.Element) -> str:
    parts: list[str] = []
    for node in root.iter():
        for attr in ("text", "content-desc"):
            raw = normalize_ui_text(node.attrib.get(attr) or "")
            if raw:
                parts.append(raw)
    return " ".join(parts)


def is_login_form(root: ET.Element) -> bool:
    if is_popup_blocking(root):
        return False
    blob = _screen_text_blob(root)
    if _texts_contain([blob], "телефон или адрес", "phone or email", "email or phone", "электронная почта"):
        return True
    if "используйте аккаунт google" in blob and "далее" in blob:
        return True
    if "google" in blob and "вход" in blob and "далее" in blob:
        return True
    return False


def _focus_email_field(device: AdbDevice) -> bool:
    if device.click_text(_EMAIL_FIELD_HINTS, timeout=10, tap_label=True):
        return True
    if device.click_edittext(0):
        return True
    device.log("Запасной тап в поле email (640, 300)")
    device.tap(640, 300)
    device.rnd_delay()
    return True


def dismiss_blocking_popup(device: AdbDevice, max_attempts: int = 6) -> None:
    for _ in range(max_attempts):
        root = device.uiautomator_dump()
        if root is None or not is_popup_blocking(root):
            return
        device.log('Попап Google — клик по тексту "Закрыть"')
        if device.click_text(_BLOCKING_POPUP_CLOSE, timeout=5):
            device.rnd_delay()
        else:
            time.sleep(1.0)


def reach_login_form(device: AdbDevice, timeout: float = 35.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        dismiss_blocking_popup(device)
        root = device.uiautomator_dump()
        if root is None:
            time.sleep(1.0)
            continue
        if is_login_form(root):
            device.log("Экран Google email открыт")
            return True
        if device.click_text(_SIGN_IN_LABELS, timeout=3):
            device.rnd_delay()
            continue
        time.sleep(1.0)
    root = device.uiautomator_dump()
    return root is not None and is_login_form(root)


def step_google_signin_form(device: AdbDevice, account: AccountCredentials) -> None:
    """Email → Далее → пароль → Далее → Понятно → Принимаю → Ещё → Принять."""
    dismiss_blocking_popup(device)
    if not reach_login_form(device):
        raise TimeoutError("Не удалось открыть форму входа Google")

    device.log("Клик в поле email...")
    _focus_email_field(device)
    time.sleep(0.5)
    device.log(f"Ввод email: {account.google_login}")
    device.input_text(account.google_login)
    device.rnd_delay()
    if not device.click_text(_NEXT_LABELS, timeout=15):
        raise TimeoutError('Текст "Далее" не найден после email')
    device.rnd_delay()

    device.log('Клик по тексту "Введите пароль" и ввод...')
    if not device.wait_for("text", "Введите пароль", timeout=20) and not device.wait_for(
        "text", "Enter your password", timeout=5
    ):
        raise TimeoutError("Экран ввода пароля не появился")
    if not device.click_text(_PASSWORD_FIELD_HINTS, timeout=15, tap_label=True):
        raise TimeoutError('Не удалось нажать на текст "Введите пароль"')
    time.sleep(0.5)
    device.log("Ввод пароля...")
    device.input_text(account.google_password)
    device.rnd_delay()
    if not device.click_text(_NEXT_LABELS, timeout=15):
        raise TimeoutError('Текст "Далее" не найден после пароля')
    device.rnd_delay()

    device.log('Листаем и ищем текст "Понятно"...')
    if not device.find_and_click_text_with_scroll(["Понятно", "Got it"], timeout=30):
        device.log('Текст "Понятно" не найден — возможно экран пропущен')
    device.rnd_delay()

    device.log('Клик по тексту "Принимаю"...')
    if not device.click_text(["Принимаю", "ПРИНИМАЮ", "I agree", "Accept"], timeout=20):
        device.log('Текст "Принимаю" не найден — возможно экран пропущен')
    device.rnd_delay()

    device.log('Клик по тексту "Ещё"...')
    if device.click_text(["Ещё", "ЕЩЁ", "More", "MORE"], timeout=20):
        device.rnd_delay()
        device.log('Клик по тексту "Принять"...')
        device.click_text(["Принять", "ПРИНЯТЬ", "Accept", "I agree"], timeout=20)
    else:
        device.log('Текст "Ещё" не найден — возможно уже принято')
    device.rnd_delay()
