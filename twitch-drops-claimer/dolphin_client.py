"""Клиент Dolphin{anty} Local API + подключение Playwright по CDP."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import requests
from playwright.sync_api import Browser, BrowserContext, Playwright

logger = logging.getLogger(__name__)

START_RETRIES = 5
START_RETRY_BASE_SEC = 2.0


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
        last_error: Exception | None = None

        for attempt in range(1, START_RETRIES + 1):
            try:
                response = requests.get(
                    url,
                    params={"automation": 1},
                    headers=self.config.headers,
                    timeout=120,
                )
                if response.status_code >= 500:
                    raise requests.HTTPError(
                        f"{response.status_code} Server Error: {response.reason} for url: {response.url}",
                        response=response,
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
            except (requests.RequestException, RuntimeError) as exc:
                last_error = exc
                if attempt >= START_RETRIES:
                    break
                wait_sec = START_RETRY_BASE_SEC * attempt
                logger.warning(
                    "Dolphin start %s не удался (%s), повтор %s/%s через %.0f сек...",
                    profile_id,
                    exc,
                    attempt,
                    START_RETRIES,
                    wait_sec,
                )
                self.stop_profile(profile_id)
                time.sleep(wait_sec)

        assert last_error is not None
        raise last_error

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
