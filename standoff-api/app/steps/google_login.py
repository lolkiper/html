"""Add Google account on Android emulator."""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET

from app.adb.device import AdbDevice
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


def _is_popup_blocking(root: ET.Element) -> bool:
    texts = _node_texts(root)
    has_close = _texts_contain(texts, "закрыть", "close")
    has_info = _texts_contain(texts, *_GOOGLE_INFO_MARKERS)
    return has_close and has_info


def _is_login_form(root: ET.Element) -> bool:
    if _is_popup_blocking(root):
        return False
    texts = _node_texts(root)
    return _texts_contain(
        texts,
        "телефон или адрес",
        "phone or email",
        "email or phone",
        "электронная почта",
    )


def _dismiss_blocking_popup(device: AdbDevice, max_attempts: int = 6) -> None:
    for _ in range(max_attempts):
        root = device.uiautomator_dump()
        if root is None or not _is_popup_blocking(root):
            return
        device.log('Попап Google — клик по тексту "Закрыть"')
        if device.click_text(_BLOCKING_POPUP_CLOSE, timeout=5):
            device.rnd_delay()
        else:
            time.sleep(1.0)


def _reach_login_form(device: AdbDevice, timeout: float = 35.0) -> bool:
    """Close popup and open email form."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        _dismiss_blocking_popup(device)

        root = device.uiautomator_dump()
        if root is None:
            time.sleep(1.0)
            continue

        if _is_login_form(root):
            device.log('Форма готова — виден текст "Телефон или адрес эл. почты"')
            return True

        if device.click_text(_SIGN_IN_LABELS, timeout=3):
            device.rnd_delay()
            continue

        time.sleep(1.0)

    root = device.uiautomator_dump()
    return root is not None and _is_login_form(root)


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
    _dismiss_blocking_popup(device)
    if not _reach_login_form(device):
        raise TimeoutError("Не удалось открыть форму входа Google")

    device.log('Клик по тексту "Телефон или адрес эл. почты"...')
    if not device.click_text(
        ["Телефон или адрес эл. почты", "Телефон или email", "Phone or email"],
        timeout=20,
        tap_label=True,
    ):
        _dismiss_blocking_popup(device)
        if not device.click_text(
            ["Телефон или адрес эл. почты", "Телефон или email", "Phone or email"],
            timeout=15,
            tap_label=True,
        ):
            raise TimeoutError('Не удалось нажать на текст "Телефон или адрес эл. почты"')
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
    if not device.fill_field_by_text(
        _PASSWORD_FIELD_HINTS,
        account.google_password,
        tap_label=True,
    ):
        raise TimeoutError('Текст "Введите пароль" не найден на экране')
    if not device.click_text(_NEXT_LABELS, timeout=15):
        raise TimeoutError('Текст "Далее" не найден после пароля')
    device.rnd_delay()

    device.log('Листаем и ищем текст "Понятно"...')
    if not device.find_and_click_text_with_scroll(["Понятно", "Got it"], timeout=30):
        device.log('Текст "Понятно" не найден — возможно экран пропущен')
    device.rnd_delay()

    device.log('Клик по тексту "Принимаю"...')
    if not device.click_text(["Принимаю", "I agree", "Accept"], timeout=20):
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
    device.log(f"Google аккаунт {account.google_login} добавлен")
