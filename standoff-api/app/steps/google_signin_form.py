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


def is_password_form(root: ET.Element) -> bool:
    if is_popup_blocking(root):
        return False
    if is_login_form(root):
        return False
    blob = _screen_text_blob(root)
    if _texts_contain(
        [blob],
        "введите пароль",
        "enter your password",
        "enter password",
        "wrong password",
        "неверный пароль",
    ):
        return True
    if _texts_contain([blob], "забыли пароль", "forgot your password", "forgot password"):
        return True
    if _texts_contain([blob], "показать пароль", "show password"):
        return True
    if _texts_contain([blob], "добро пожаловать", "welcome"):
        if "парол" in blob or "password" in blob:
            return True
    if "@" in blob and _texts_contain([blob], "далее", "next", "войти", "sign in"):
        if not _texts_contain([blob], "создать аккаунт", "create account", "используйте аккаунт google"):
            if any("EditText" in (node.attrib.get("class") or "") for node in root.iter()):
                return True
    return False


def _pause(seconds: float = 0.2) -> None:
    time.sleep(seconds)


def _focus_email_field(device: AdbDevice) -> bool:
    if device.click_text(_EMAIL_FIELD_HINTS, timeout=2, tap_label=True, quiet=True, fast=True):
        return True
    if device.click_edittext(0, fast=True):
        return True
    device.log("Запасной тап в поле email (640, 300)")
    device.tap(640, 300)
    _pause()
    return True


def _focus_password_field(device: AdbDevice) -> bool:
    if device.click_text(_PASSWORD_FIELD_HINTS, timeout=2, tap_label=True, quiet=True, fast=True):
        return True
    if device.click_edittext(0, fast=True):
        return True
    device.log("Запасной тап в поле пароля (640, 430)")
    device.tap(640, 430)
    _pause()
    return True


def _maybe_pick_account(device: AdbDevice, email: str) -> bool:
    lowered = email.lower()
    parts = [lowered]
    if "@" in lowered:
        parts.append(lowered.split("@", 1)[0])
    for part in parts:
        if device.click_text([part], timeout=1.5, quiet=True, fast=True):
            device.log(f"Выбран аккаунт в списке Google: {part}")
            return True
    return False


def dismiss_blocking_popup(device: AdbDevice, max_attempts: int = 3) -> None:
    for _ in range(max_attempts):
        root = device.uiautomator_dump()
        if root is None or not is_popup_blocking(root):
            return
        device.log('Попап Google — клик по тексту "Закрыть"')
        if device.click_text(_BLOCKING_POPUP_CLOSE, timeout=2, fast=True):
            _pause()
        else:
            _pause(0.3)


def reach_login_form(device: AdbDevice, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        dismiss_blocking_popup(device)
        root = device.uiautomator_dump()
        if root is None:
            _pause(0.3)
            continue
        if is_login_form(root):
            device.log("Экран Google email открыт")
            return True
        if device.click_text(_SIGN_IN_LABELS, timeout=1.5, quiet=True, fast=True):
            _pause()
            continue
        _pause(0.3)
    root = device.uiautomator_dump()
    return root is not None and is_login_form(root)


def reach_password_form(device: AdbDevice, account: AccountCredentials, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        dismiss_blocking_popup(device)
        root = device.uiautomator_dump()
        if root is None:
            _pause(0.3)
            continue
        if is_password_form(root):
            device.log("Экран пароля Google открыт")
            return True
        _maybe_pick_account(device, account.google_login)
        _pause(0.35)
    root = device.uiautomator_dump()
    return root is not None and is_password_form(root)


def step_google_signin_form(device: AdbDevice, account: AccountCredentials) -> None:
    """Email → Далее → пароль → Далее → Понятно → Принимаю → Ещё → Принять."""
    dismiss_blocking_popup(device)
    root = device.uiautomator_dump()
    if root is not None and is_password_form(root):
        device.log("Уже на экране пароля — пропускаем email")
    elif not reach_login_form(device):
        raise TimeoutError("Не удалось открыть форму входа Google")
    else:
        device.log("Клик в поле email...")
        _focus_email_field(device)
        _pause(0.15)
        device.log(f"Ввод email: {account.google_login}")
        device.input_text(account.google_login)
        _pause(0.2)
        if not device.click_text(_NEXT_LABELS, timeout=10, fast=True):
            raise TimeoutError('Текст "Далее" не найден после email')
        _pause(0.35)

    device.log("Ожидание экрана пароля...")
    if not reach_password_form(device, account):
        raise TimeoutError("Экран ввода пароля не появился")

    device.log("Клик в поле пароля и ввод...")
    _focus_password_field(device)
    _pause(0.15)
    device.log("Ввод пароля...")
    device.input_text(account.google_password)
    _pause(0.2)
    if not device.click_text(_NEXT_LABELS, timeout=10, fast=True):
        device.press_enter()
        _pause(0.3)
    _pause(0.35)

    device.log('Листаем и ищем текст "Понятно"...')
    if not device.find_and_click_text_with_scroll(["Понятно", "Got it"], timeout=15):
        device.log('Текст "Понятно" не найден — возможно экран пропущен')
    _pause()

    device.log('Клик по тексту "Принимаю"...')
    if not device.click_text(["Принимаю", "ПРИНИМАЮ", "I agree", "Accept"], timeout=10, fast=True):
        device.log('Текст "Принимаю" не найден — возможно экран пропущен')
    _pause()

    device.log('Клик по тексту "Ещё"...')
    if device.click_text(["Ещё", "ЕЩЁ", "More", "MORE"], timeout=8, fast=True):
        _pause()
        device.log('Клик по тексту "Принять"...')
        device.click_text(["Принять", "ПРИНЯТЬ", "Accept", "I agree"], timeout=8, fast=True)
    else:
        device.log('Текст "Ещё" не найден — возможно уже принято')
    _pause()
