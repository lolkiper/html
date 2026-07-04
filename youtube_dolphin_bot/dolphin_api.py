"""
Dolphin Anty local API client.

Dolphin must be running and the local API enabled (Settings → Automation → API).
Default endpoint: http://localhost:3001/v1.0
"""

import time
import requests
from config import DOLPHIN_API_BASE


class DolphinAPI:
    def __init__(self, base_url: str = DOLPHIN_API_BASE, api_token: str = ""):
        self.base = base_url.rstrip("/")
        self.session = requests.Session()
        if api_token:
            self.session.headers.update({"Authorization": f"Bearer {api_token}"})

    # ------------------------------------------------------------------ #
    # Profile management
    # ------------------------------------------------------------------ #

    def create_profile(
        self,
        name: str,
        proxy: dict | None = None,
        tags: list[str] | None = None,
        os: str = "windows",
    ) -> dict:
        """
        Create a new browser profile.

        proxy dict format:
            {
                "type": "http",     # http / socks5 / socks4
                "host": "1.2.3.4",
                "port": 8080,
                "login": "user",    # optional
                "password": "pass"  # optional
            }
        """
        payload: dict = {
            "name": name,
            "platform": os,
            "browserType": "anty",
            "mainWebsite": "youtube",
            "useragent": {"mode": "auto"},
            "webRTC": {"mode": "altered", "enabled": True},
            "canvas": {"mode": "real"},
            "webGL": {"mode": "real"},
            "timezone": {"mode": "auto"},
            "locale": {"mode": "auto"},
            "geolocation": {"mode": "auto"},
        }

        if tags:
            payload["tags"] = tags

        if proxy:
            payload["proxy"] = {
                "type": proxy["type"],
                "host": proxy["host"],
                "port": int(proxy["port"]),
                "login": proxy.get("login", ""),
                "password": proxy.get("password", ""),
            }

        resp = self.session.post(f"{self.base}/browser_profiles", json=payload)
        resp.raise_for_status()
        return resp.json()

    def delete_profile(self, profile_id: int | str) -> dict:
        resp = self.session.delete(f"{self.base}/browser_profiles/{profile_id}")
        resp.raise_for_status()
        return resp.json()

    def get_profile(self, profile_id: int | str) -> dict:
        resp = self.session.get(f"{self.base}/browser_profiles/{profile_id}")
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # Profile launch / stop
    # ------------------------------------------------------------------ #

    def start_profile(self, profile_id: int | str, headless: bool = False) -> dict:
        """
        Launch the profile.  Returns automation data incl. port & wsEndpoint.
        """
        params = {"automation": 1}
        if headless:
            params["headless"] = 1

        resp = self.session.get(
            f"{self.base}/browser_profiles/{profile_id}/start",
            params=params,
        )
        resp.raise_for_status()
        return resp.json()

    def stop_profile(self, profile_id: int | str) -> dict:
        resp = self.session.get(f"{self.base}/browser_profiles/{profile_id}/stop")
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    def check_connection(self) -> bool:
        """Return True if Dolphin local API is reachable."""
        try:
            resp = self.session.get(f"{self.base}/browser_profiles", timeout=5)
            return resp.status_code < 500
        except requests.ConnectionError:
            return False


def parse_proxy(proxy_str: str) -> dict | None:
    """
    Parse a proxy string into a dict understood by DolphinAPI.

    Supported formats:
        socks5://user:pass@host:port
        http://host:port
        host:port:user:pass          (assumed http)
        host:port                    (assumed http, no auth)
    """
    if not proxy_str or proxy_str.strip().lower() in ("", "no", "none", "-"):
        return None

    proxy_str = proxy_str.strip()

    # URL-style  proto://[user:pass@]host:port
    if "://" in proxy_str:
        from urllib.parse import urlparse
        p = urlparse(proxy_str)
        return {
            "type": p.scheme,
            "host": p.hostname,
            "port": p.port,
            "login": p.username or "",
            "password": p.password or "",
        }

    # host:port:user:pass
    parts = proxy_str.split(":")
    if len(parts) == 4:
        return {
            "type": "http",
            "host": parts[0],
            "port": int(parts[1]),
            "login": parts[2],
            "password": parts[3],
        }

    # host:port
    if len(parts) == 2:
        return {
            "type": "http",
            "host": parts[0],
            "port": int(parts[1]),
            "login": "",
            "password": "",
        }

    raise ValueError(f"Cannot parse proxy string: {proxy_str!r}")
