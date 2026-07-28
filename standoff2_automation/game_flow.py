"""Standoff 2 game-specific automation flows."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from adb_client import AdbClient, AdbError
from config import GAME_ACTIVITY, GAME_PACKAGE, AppConfig
from logger_setup import setup_logger
from ocr import PriceOcr
from vision import Vision

log = setup_logger(__name__)


@dataclass
class Account:
    email: str
    password: str


class AccountBlockedError(Exception):
    pass


class GameFlow:
    def __init__(self, adb: AdbClient, vision: Vision, config: AppConfig) -> None:
        self.adb = adb
        self.vision = vision
        self.config = config
        self.ocr = PriceOcr(config)
        self.tpl = config.templates
        self.delays = config.delays
        self.taps = config.taps

    def _sleep(self, kind: str = "medium") -> None:
        delay = getattr(self.delays, kind, self.delays.medium)
        time.sleep(delay)

    def reset_session(self) -> None:
        """Force-stop and clear Standoff 2 data for a clean login."""
        self.adb.force_stop(GAME_PACKAGE)
        self._sleep("short")
        self.adb.pm_clear(GAME_PACKAGE)
        self._sleep("medium")

    def launch_game(self) -> None:
        log.info("Launching Standoff 2")
        self.adb.start_activity(GAME_PACKAGE, GAME_ACTIVITY)
        time.sleep(self.delays.launch_game)

    def _check_blocked(self) -> None:
        if self.vision.is_visible(self.tpl.account_blocked):
            raise AccountBlockedError("Account blocked / ban screen detected")

    def google_login(self, account: Account) -> None:
        log.info("Google login: %s", account.email)
        t = self.tpl

        if not self.vision.wait_and_tap(t.google_sign_in, timeout=45):
            raise RuntimeError("Google sign-in button not found")

        self._sleep("google_login")

        if not self.vision.wait_and_tap(t.google_email_field, timeout=20):
            raise RuntimeError("Google email field not found")

        self.adb.clear_field()
        self.adb.input_text(account.email)
        self._sleep("short")

        if not self.vision.wait_and_tap(t.google_next, timeout=15):
            self.adb.tap(1100, 650)
        self._sleep("medium")

        if not self.vision.wait_and_tap(t.google_password_field, timeout=20):
            raise RuntimeError("Google password field not found")

        self.adb.clear_field()
        self.adb.input_text(account.password)
        self._sleep("short")

        if not self.vision.wait_and_tap(t.google_next, timeout=15):
            self.adb.tap(1100, 650)
        self._sleep("medium")

        self.vision.wait_and_tap(t.google_login_btn, timeout=20, optional=True)
        self._sleep("long")

        self._dismiss_popups()
        self._check_blocked()
        log.info("Google login completed")

    def _dismiss_popups(self) -> None:
        for _ in range(3):
            if self.vision.wait_and_tap(
                self.tpl.popup_close,
                timeout=3,
                optional=True,
            ):
                self._sleep("short")
            else:
                break

    def bind_twitch(self) -> None:
        log.info("Binding Twitch account")
        t = self.tpl

        if not self.vision.wait_and_tap(t.main_menu_play, timeout=30, optional=True):
            log.warning("Main menu not confirmed, continuing")

        self._dismiss_popups()

        if not self.vision.wait_and_tap(t.settings_btn, timeout=25):
            raise RuntimeError("Settings button not found")

        self._sleep("medium")

        # Scroll down in settings if Twitch bind is below fold
        self.adb.swipe(
            self.taps.settings_scroll_down[0],
            self.taps.settings_scroll_down[1],
            self.taps.settings_scroll_down[0],
            200,
            400,
        )
        self._sleep("short")

        if not self.vision.wait_and_tap(t.twitch_bind, timeout=20):
            log.warning("Twitch bind button not found — skip bind step")
            self.adb.press_back()
            return

        self._sleep("medium")
        self.vision.wait_and_tap(t.twitch_authorize, timeout=30, optional=True)
        self._sleep("long")

        self.adb.press_back()
        self._sleep("short")
        log.info("Twitch bind step done")

    def sell_inventory_items(self) -> int:
        """Open inventory, list items at OCR-detected market price. Returns sold count."""
        log.info("Processing inventory")
        t = self.tpl
        sold = 0

        if not self.vision.wait_and_tap(t.inventory_btn, timeout=25):
            raise RuntimeError("Inventory button not found")

        self._sleep("medium")

        for idx in range(self.config.max_inventory_items):
            self._check_blocked()

            # Tap item slot — grid offset for row 0 col idx%5, row idx//5
            col = idx % 5
            row = idx // 5
            x = self.taps.inventory_first_item[0] + col * 180
            y = self.taps.inventory_first_item[1] + row * 160

            self.adb.tap(x, y)
            self._sleep("short")

            if not self.vision.wait_and_tap(t.market_tab, timeout=8, optional=True):
                log.debug("No market tab for item %d, next", idx)
                self.adb.press_back()
                continue

            self._sleep("medium")

            screen = self.vision.capture_bgr()
            region = self.vision.crop_region(
                screen,
                self.taps.market_price_region,
            )
            price = self.ocr.read_price(region)

            if price is None:
                log.warning("Could not parse price for item %d", idx)
                self.adb.press_back()
                continue

            if not self.vision.wait_and_tap(t.sell_btn, timeout=10, optional=True):
                log.warning("Sell button not found for item %d", idx)
                self.adb.press_back()
                continue

            self._sleep("short")

            # Confirm price field — clear and type OCR price
            self.adb.clear_field(10)
            self.adb.input_text(str(price))
            self._sleep("short")

            if self.vision.wait_and_tap(t.confirm_sell, timeout=10, optional=True):
                sold += 1
                log.info("Listed item %d at price %d", idx, price)
            else:
                log.warning("Confirm sell failed for item %d", idx)

            self._sleep("short")
            self.adb.press_back()
            self._sleep("short")

        log.info("Inventory done, listed %d items", sold)
        return sold

    def logout(self) -> None:
        log.info("Logging out / resetting session")
        t = self.tpl

        self.vision.wait_and_tap(t.settings_btn, timeout=15, optional=True)
        self._sleep("medium")

        if self.vision.wait_and_tap(t.logout_btn, timeout=10, optional=True):
            self._sleep("medium")
        else:
            log.warning("Logout button not found — clearing app data instead")

        self.reset_session()

    def process_account(self, account: Account) -> None:
        """Full pipeline for one account."""
        log.info("=" * 50)
        log.info("Processing account: %s", account.email)

        self.reset_session()
        self.launch_game()
        self.google_login(account)
        self.bind_twitch()
        self.sell_inventory_items()
        self.logout()

        log.info("Account %s finished OK", account.email)
