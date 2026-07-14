"""Open Twitch OAuth in Chrome — LDPlayer built-in browser is blocked by Twitch."""

from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET

from app.adb.device import AdbDevice, normalize_ui_text

_TWITCH_URL_RE = re.compile(r"https?://(?:www\.)?twitch\.tv[^\s\"'<>]+", re.IGNORECASE)
_UNSUPPORTED_MARKERS = (
    "браузер пока не поддерживается",
    "browser is not supported",
    "browser not supported",
    "ваш браузер",
    "your browser",
)
_TWITCH_LOGIN_MARKERS = (
    "войти в twitch",
    "log in to twitch",
    "имя пользователя",
    "username",
    "password",
    "пароль",
)
_CHROME_PACKAGES = (
    "com.android.chrome",
    "com.google.android.apps.chrome",
    "com.chrome.beta",
    "com.chrome.dev",
)
_BUILTIN_BROWSERS = (
    "com.android.browser",
    "com.ldmnq.browser",
    "com.ldmnq.browser2",
    "com.android.webview",
)


def _screen_blob(root: ET.Element) -> str:
    parts: list[str] = []
    for node in root.iter():
        for attr in ("text", "content-desc"):
            raw = normalize_ui_text(node.attrib.get(attr) or "")
            if raw:
                parts.append(raw)
    return " ".join(parts)


def find_chrome_package(device: AdbDevice) -> str | None:
    raw = device.shell("pm list packages")
    for pkg in _CHROME_PACKAGES:
        if pkg in raw:
            return pkg
    return None


def try_set_chrome_default(device: AdbDevice, chrome_pkg: str) -> None:
    for cmd in (
        f"cmd role add-role-holder android.app.role.BROWSER {chrome_pkg}",
        f"settings put secure default_browser {chrome_pkg}",
    ):
        device.shell(cmd)


def find_twitch_oauth_url(device: AdbDevice, root: ET.Element | None = None) -> str | None:
    if root is not None:
        for node in root.iter():
            for attr in ("text", "content-desc"):
                raw = node.attrib.get(attr) or ""
                match = _TWITCH_URL_RE.search(raw)
                if match:
                    return match.group(0).rstrip(".,;)")
    for cmd in (
        "dumpsys activity activities",
        "dumpsys window windows",
        "dumpsys activity top",
    ):
        raw = device.shell(cmd)
        match = _TWITCH_URL_RE.search(raw or "")
        if match:
            return match.group(0).rstrip(".,;)")
    return None


def is_unsupported_browser_screen(blob: str) -> bool:
    return any(marker in blob for marker in _UNSUPPORTED_MARKERS)


def is_twitch_login_screen(blob: str) -> bool:
    if is_unsupported_browser_screen(blob):
        return False
    return any(marker in blob for marker in _TWITCH_LOGIN_MARKERS)


def open_url_in_chrome(device: AdbDevice, url: str, chrome_pkg: str) -> bool:
    safe = url.replace("\\", "\\\\").replace('"', '\\"')
    for browser in _BUILTIN_BROWSERS:
        device.shell(f"am force-stop {browser}")
    out = device.shell(
        f'am start -a android.intent.action.VIEW -d "{safe}" '
        f"-n {chrome_pkg}/com.google.android.apps.chrome.Main"
    )
    if "Error" in (out or "") and "does not exist" in (out or "").lower():
        out = device.shell(f'am start -a android.intent.action.VIEW -d "{safe}" {chrome_pkg}')
    device.log(f"Twitch OAuth открыт в Chrome ({chrome_pkg})")
    return "Error" not in (out or "")


def prepare_chrome_for_twitch(device: AdbDevice) -> str:
    chrome = find_chrome_package(device)
    if not chrome:
        raise RuntimeError(
            "Google Chrome не установлен в LDPlayer. "
            "Открой Play Store → установи Chrome → перезапусти prepare."
        )
    try_set_chrome_default(device, chrome)
    return chrome


def ensure_twitch_login_in_chrome(device: AdbDevice, chrome_pkg: str, timeout: float = 25.0) -> None:
    """Wait for Twitch login; if built-in browser is blocked, reopen OAuth in Chrome."""
    deadline = time.time() + timeout
    recovered = False
    while time.time() < deadline:
        root = device.uiautomator_dump()
        if root is None:
            time.sleep(0.35)
            continue
        blob = _screen_blob(root)
        if is_unsupported_browser_screen(blob):
            url = find_twitch_oauth_url(device, root)
            if not url:
                raise RuntimeError(
                    "Twitch: браузер не поддерживается и OAuth URL не найден. "
                    "Установи Chrome в LDPlayer."
                )
            device.log("Twitch: встроенный браузер заблокирован — переключаю на Chrome")
            open_url_in_chrome(device, url, chrome_pkg)
            recovered = True
            time.sleep(2.0)
            continue
        if is_twitch_login_screen(blob):
            if recovered:
                device.log("Twitch: форма входа открыта в Chrome")
            return
        time.sleep(0.35)
    raise TimeoutError("Экран входа Twitch не появился (нужен Chrome в LDPlayer)")
