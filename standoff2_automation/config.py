"""Configuration for Standoff 2 emulator automation."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

# Project paths
ROOT_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = ROOT_DIR / "templates"
ACCOUNTS_FILE = ROOT_DIR / "accounts.txt"
LOG_FILE = ROOT_DIR / "log.txt"

# Standoff 2 package / activity
GAME_PACKAGE = "com.axlebolt.standoff2"
GAME_ACTIVITY = "com.axlebolt.standoff2.MainActivity"

# Emulator ADB — override via CLI or env
DEFAULT_ADB_SERIAL = "127.0.0.1:5555"

# Recommended resolution (LDPlayer / NOX preset)
SCREEN_WIDTH = 1280
SCREEN_HEIGHT = 720

# Delays (seconds) — tune per emulator speed
@dataclass
class Delays:
    short: float = 1.0
    medium: float = 2.5
    long: float = 5.0
    launch_game: float = 15.0
    google_login: float = 8.0
    between_accounts: float = 3.0


@dataclass
class TemplateConfig:
    """PNG templates in templates/ — capture from your emulator at 1280x720."""

    google_sign_in: str = "google_sign_in.png"
    google_email_field: str = "google_email.png"
    google_next: str = "google_next.png"
    google_password_field: str = "google_password.png"
    google_login_btn: str = "google_login.png"
    main_menu_play: str = "main_play.png"
    settings_btn: str = "settings.png"
    twitch_bind: str = "twitch_bind.png"
    twitch_authorize: str = "twitch_authorize.png"
    inventory_btn: str = "inventory.png"
    market_tab: str = "market_tab.png"
    sell_btn: str = "sell.png"
    confirm_sell: str = "confirm_sell.png"
    logout_btn: str = "logout.png"
    account_blocked: str = "account_blocked.png"
    popup_close: str = "popup_close.png"

    match_threshold: float = 0.78


@dataclass
class TapPoints:
    """Fallback tap coordinates when template not found (1280x720)."""

    inventory_first_item: tuple[int, int] = (200, 350)
    market_price_region: tuple[int, int, int, int] = (450, 280, 750, 340)
    settings_scroll_down: tuple[int, int] = (640, 500)
    back_button: tuple[int, int] = (60, 60)


@dataclass
class AppConfig:
    adb_serial: str = DEFAULT_ADB_SERIAL
    delays: Delays = field(default_factory=Delays)
    templates: TemplateConfig = field(default_factory=TemplateConfig)
    taps: TapPoints = field(default_factory=TapPoints)
    max_inventory_items: int = 20
    ocr_lang: str = "eng"
    template_timeout: float = 30.0
    retry_attempts: int = 3


DEFAULT_CONFIG = AppConfig()
