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


def _is_login_form(root: ET.Element) -> bool:
    texts = _node_texts(root)
    return _texts_contain(
        texts,
        "телефон или адрес",
        "phone or email",
        "email or phone",
        "электронная почта",
    )



def _is_blocking_info_popup(root: ET.Element) -> bool:
    texts = _node_texts(root)
    if _texts_contain(texts, "закрыть", "close") and _texts_contain(
        texts, *_GOOGLE_INFO_MARKERS
    ):
        return True
    return _texts_contain(texts, *_GOOGLE_INFO_MARKERS) and not _is_login_form(root)


def _reach_login_form(device: AdbDevice, timeout: float = 35.0) -> bool:
    """Dismiss info popup or click Sign in until the email form is visible."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        root = device.uiautomator_dump()
        if root is None:
            time.sleep(1.0)
            continue

        if _is_login_form(root):
            device.log("Экран входа Google (email)")
            return True

        if _is_blocking_info_popup(root):
            device.log("Инфо-попап Google — клик по тексту Закрыть")
            device.click_text(_BLOCKING_POPUP_CLOSE, timeout=3)
            device.rnd_delay()
            continue

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

    if not device.click_text(["Google", "Гугл"], timeout=15):
        raise TimeoutError("Кнопка Google не найдена")

    device.rnd_delay()
    if not _reach_login_form(device):
        raise TimeoutError("Не удалось открыть форму входа Google")

    device.log('Клик по тексту "Телефон или адрес эл. почты" и ввод email...')
    if not device.fill_field_by_text(_EMAIL_FIELD_HINTS, account.google_login):
        raise TimeoutError('Текст "Телефон или адрес эл. почты" не найден на экране')
    if not device.click_text(_NEXT_LABELS, timeout=15):
        raise TimeoutError('Текст "Далее" не найден после email')
    device.rnd_delay()

    device.log('Клик по тексту "Введите пароль" и ввод...')
    if not device.wait_for("text", "Введите пароль", timeout=20) and not device.wait_for(
        "text", "Enter your password", timeout=5
    ):
        raise TimeoutError("Экран ввода пароля не появился")
    if not device.fill_field_by_text(_PASSWORD_FIELD_HINTS, account.google_password):
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
