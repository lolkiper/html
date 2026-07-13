"""Load config.json from project root."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.text_io import read_text_auto


def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


BASE_DIR = base_dir()
CONFIG_FILE = BASE_DIR / "config.json"
CONFIG_EXAMPLE = BASE_DIR / "config.example.json"
ACCOUNTS_FILE = BASE_DIR / "accounts.txt"
SUCCESS_LOG = BASE_DIR / "success_log.txt"
ERRORS_LOG = BASE_DIR / "errors_log.txt"
CYCLE_LOG = BASE_DIR / "cycle_log.txt"


@dataclass
class AppConfig:
    api_host: str = "0.0.0.0"
    api_port: int = 8080
    api_key: str = ""
    ldplayer_home: Optional[str] = None
    emulator_index: int = 0
    adb_port: Optional[int] = None
    standoff_icon_x: int = 660
    standoff_icon_y: int = 340
    sell_min_price: bool = True
    sell_max_items: int = 50
    skip_twitch_if_linked: bool = True
    delay_min_sec: float = 1.2
    delay_max_sec: float = 2.5
    market_fee_rate: float = 0.75
    reset_device_on_start: bool = False
    auto_find_emulator: bool = True
    google_via_settings: bool = False

    @classmethod
    def load(cls) -> AppConfig:
        path = CONFIG_FILE if CONFIG_FILE.exists() else CONFIG_EXAMPLE
        data: dict = {}
        if path.exists():
            data = json.loads(read_text_auto(path))
        return cls(
            api_host=str(data.get("API_HOST", "0.0.0.0")),
            api_port=int(data.get("API_PORT", 8080)),
            api_key=str(data.get("API_KEY", "")),
            ldplayer_home=data.get("LDPLAYER_HOME") or None,
            emulator_index=int(data.get("EMULATOR_INDEX", 0)),
            adb_port=data.get("ADB_PORT"),
            standoff_icon_x=int(data.get("STANDOFF_ICON_X", 660)),
            standoff_icon_y=int(data.get("STANDOFF_ICON_Y", 340)),
            sell_min_price=bool(data.get("SELL_MIN_PRICE", True)),
            sell_max_items=int(data.get("SELL_MAX_ITEMS", 50)),
            skip_twitch_if_linked=bool(data.get("SKIP_TWITCH_IF_LINKED", True)),
            delay_min_sec=float(data.get("DELAY_MIN_SEC", 1.2)),
            delay_max_sec=float(data.get("DELAY_MAX_SEC", 2.5)),
            market_fee_rate=float(data.get("MARKET_FEE_RATE", 0.75)),
            reset_device_on_start=bool(data.get("RESET_DEVICE_ON_START", False)),
            auto_find_emulator=bool(data.get("AUTO_FIND_EMULATOR", True)),
            google_via_settings=bool(data.get("GOOGLE_VIA_SETTINGS", False)),
        )
