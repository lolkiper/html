from __future__ import annotations

import logging
from typing import Any

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

logger = logging.getLogger("twitch_dolphin")


class DolphinError(Exception):
    pass


def _api_base(api_url: str) -> str:
    return api_url.rstrip("/")


def start_profile(profile_id: str, api_url: str, timeout: int = 120) -> dict[str, Any]:
    url = f"{_api_base(api_url)}/v1.0/browser_profiles/{profile_id}/start"
    try:
        response = requests.get(url, params={"automation": 1}, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        raise DolphinError(f"Failed to start Dolphin profile {profile_id}: {exc}") from exc

    if not payload.get("success"):
        raise DolphinError(
            f"Dolphin API refused to start profile {profile_id}: {payload.get('message', payload)}"
        )
    automation = payload.get("automation") or {}
    port = automation.get("port")
    if not port:
        raise DolphinError(f"No automation port returned for profile {profile_id}")
    return {"port": port, "raw": payload}


def stop_profile(profile_id: str, api_url: str, timeout: int = 60) -> None:
    url = f"{_api_base(api_url)}/v1.0/browser_profiles/{profile_id}/stop"
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Profile %s | Failed to stop Dolphin profile: %s", profile_id, exc)


def connect_webdriver(port: int, page_load_timeout: int) -> webdriver.Chrome:
    options = Options()
    options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
    try:
        driver = webdriver.Chrome(options=options)
    except Exception as exc:
        raise DolphinError(f"WebDriver connection failed on port {port}: {exc}") from exc
    driver.set_page_load_timeout(page_load_timeout)
    return driver


def close_webdriver(driver: webdriver.Chrome | None) -> None:
    if driver is None:
        return
    try:
        driver.quit()
    except Exception as exc:
        logger.warning("WebDriver quit error: %s", exc)
