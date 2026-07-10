"""Клиент Dolphin{anty} Local API + подключение Playwright по CDP."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import requests
from playwright.sync_api import Browser, BrowserContext, Playwright

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DolphinConfig:
    api_url: str
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


class DolphinClient:
    def __init__(self, config: DolphinConfig) -> None:
        self.config = config
        self._active_profile_id: str | None = None

    def start_profile(self, profile_id: str) -> tuple[int, str]:
        url = f"{self.config.api_url.rstrip('/')}/v1.0/browser_profiles/{profile_id}/start"
        response = requests.get(
            url,
            params={"automation": 1},
            headers=self.config.headers,
            timeout=120,
        )
        response.raise_for_status()
        data = response.json()

        automation = data.get("automation") or {}
        port = automation.get("port")
        ws_endpoint = automation.get("wsEndpoint")

        if not port or not ws_endpoint:
            raise RuntimeError(f"Dolphin не вернул automation port/wsEndpoint: {data}")

        if str(ws_endpoint).startswith("ws://"):
            cdp_url = ws_endpoint
        else:
            cdp_url = f"ws://127.0.0.1:{port}{ws_endpoint}"

        self._active_profile_id = profile_id
        logger.info("Профиль Dolphin %s запущен (port=%s).", profile_id, port)
        return port, cdp_url

    def stop_profile(self, profile_id: str | None = None) -> None:
        pid = profile_id or self._active_profile_id
        if not pid:
            return
        url = f"{self.config.api_url.rstrip('/')}/v1.0/browser_profiles/{pid}/stop"
        try:
            requests.get(url, headers=self.config.headers, timeout=60)
            logger.info("Профиль Dolphin %s остановлен.", pid)
        except requests.RequestException as exc:
            logger.warning("Не удалось остановить профиль %s: %s", pid, exc)
        if self._active_profile_id == pid:
            self._active_profile_id = None

    def connect(
        self,
        playwright: Playwright,
        profile_id: str,
    ) -> tuple[Browser, BrowserContext]:
        _, cdp_url = self.start_profile(profile_id)
        browser = playwright.chromium.connect_over_cdp(cdp_url)
        if not browser.contexts:
            raise RuntimeError("Dolphin не предоставил browser context.")
        context = browser.contexts[0]
        logger.info("Playwright подключён к Dolphin по CDP.")
        return browser, context
