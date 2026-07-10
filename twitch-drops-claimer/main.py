#!/usr/bin/env python3
"""
Twitch Drops claimer — Standoff 2 / SO2.

Режимы браузера:
  - Dolphin{anty}: USE_DOLPHIN=true в config.json (рекомендуется)
  - Chromium:    python main.py --chromium

Сборка:
  pip install -r requirements.txt
  playwright install chromium
  pyinstaller --onefile --console main.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Locator,
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeout,
    sync_playwright,
)

from dolphin_client import DolphinClient, DolphinConfig

DROPS_URL = "https://www.twitch.tv/drops/inventory"
DEFAULT_TIMEOUT_MS = 60_000
CLAIM_DELAY_RANGE = (1.0, 2.0)
CLAIM_TEXTS = ("получить сейчас", "claim now")


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = get_base_dir()
ACCOUNTS_FILE = BASE_DIR / "accounts.txt"
PROFILES_FILE = BASE_DIR / "profiles.txt"
CONFIG_FILE = BASE_DIR / "config.json"
ERRORS_FILE = BASE_DIR / "errors.txt"
SUCCESS_FILE = BASE_DIR / "success_log.txt"


@dataclass(frozen=True)
class Account:
    login: str
    password: str
    line_no: int
    profile_id: str | None = None


@dataclass(frozen=True)
class AppConfig:
    use_dolphin: bool
    dolphin_api_url: str
    dolphin_token: str
    dolphin_profile_id: str
    headless: bool = False

    @classmethod
    def load(cls, force_chromium: bool = False) -> AppConfig:
        data: dict = {}
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))

        use_dolphin = bool(data.get("USE_DOLPHIN", True)) and not force_chromium
        return cls(
            use_dolphin=use_dolphin,
            dolphin_api_url=str(data.get("DOLPHIN_API_URL", "http://localhost:3001")),
            dolphin_token=str(data.get("DOLPHIN_TOKEN", "")),
            dolphin_profile_id=str(data.get("DOLPHIN_PROFILE_ID", "")),
            headless=bool(data.get("HEADLESS", False)),
        )


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def log_line(path: Path, message: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"[{stamp}] {message}\n")


def parse_accounts(path: Path, profile_ids: list[str]) -> list[Account]:
    if not path.exists():
        raise FileNotFoundError(f"Файл аккаунтов не найден: {path}")

    accounts: list[Account] = []
    for idx, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            logging.warning("Строка %s пропущена: нет разделителя login:password", idx)
            continue
        login, password = line.split(":", 1)
        login, password = login.strip(), password.strip()
        if not login or not password:
            logging.warning("Строка %s пропущена: пустой логин или пароль", idx)
            continue
        profile_id = profile_ids[len(accounts)] if len(accounts) < len(profile_ids) else None
        accounts.append(Account(login=login, password=password, line_no=idx, profile_id=profile_id))
    return accounts


def load_profile_ids(default_profile_id: str, account_count: int) -> list[str]:
    if not PROFILES_FILE.exists():
        if not default_profile_id:
            raise ValueError(
                "Укажите DOLPHIN_PROFILE_ID в config.json или создайте profiles.txt"
            )
        return [default_profile_id] * account_count

    ids = [
        line.strip()
        for line in PROFILES_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if not ids:
        return [default_profile_id] * account_count
    while len(ids) < account_count:
        ids.append(ids[-1])
    return ids[:account_count]


def jitter_sleep(lo: float, hi: float) -> None:
    time.sleep(random.uniform(lo, hi))


def wait_visible(locator: Locator, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    locator.first.wait_for(state="visible", timeout=timeout_ms)


def safe_click(locator: Locator, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    target = locator.first
    wait_visible(target, timeout_ms)
    target.scroll_into_view_if_needed(timeout=timeout_ms)
    target.click(timeout=timeout_ms)


def dismiss_overlays(page: Page) -> None:
    selectors = [
        'button[data-a-target="consent-banner-accept"]',
        'button:has-text("Accept")',
        'button:has-text("Принять")',
        'button:has-text("Accept All")',
        'button[aria-label="Close"]',
        'button[aria-label="Закрыть"]',
        '[data-testid="close-button"]',
        'button:has-text("Not now")',
        'button:has-text("Не сейчас")',
    ]
    for _ in range(4):
        dismissed = False
        for sel in selectors:
            btn = page.locator(sel)
            if btn.count() and btn.first.is_visible():
                try:
                    btn.first.click(timeout=3000)
                    logging.info("Закрыт оверлей: %s", sel)
                    dismissed = True
                    jitter_sleep(0.3, 0.8)
                except PlaywrightTimeout:
                    pass
        if not dismissed:
            break


def is_logged_in(page: Page) -> bool:
    if page.locator('button[data-a-target="user-menu-toggle"]').count():
        try:
            return page.locator('button[data-a-target="user-menu-toggle"]').first.is_visible()
        except Exception:
            return False
    return page.locator('button[data-a-target="login-button"]').count() == 0


def perform_login(page: Page, account: Account) -> None:
    logging.info("Вход в аккаунт %s...", account.login)

    login_btn = page.locator('button[data-a-target="login-button"]')
    if login_btn.count() and login_btn.first.is_visible():
        safe_click(login_btn)

    username = page.locator(
        'input[name="login-username"], input#login-username, input[autocomplete="username"]'
    )
    wait_visible(username)
    username.first.fill(account.login)

    password = page.locator(
        'input[name="password"], input#password-input, input[type="password"]'
    )
    if password.count() and password.first.is_visible():
        password.first.fill(account.password)
    else:
        next_btn = page.locator(
            'button[data-a-target="passport-login-button"], '
            'button:has-text("Continue"), button:has-text("Продолжить")'
        )
        if next_btn.count():
            safe_click(next_btn)
        wait_visible(password)
        password.first.fill(account.password)

    submit = page.locator(
        'button[data-a-target="passport-login-button"], '
        'button[type="submit"]:has-text("Log In"), '
        'button[type="submit"]:has-text("Войти")'
    )
    safe_click(submit)

    wait_visible(page.locator('button[data-a-target="user-menu-toggle"]'))
    logging.info("Логин %s выполнен.", account.login)


def find_standoff_campaign(page: Page) -> Locator:
    pattern = re.compile(r"standoff|so2", re.IGNORECASE)
    candidates = page.locator(
        '[data-a-target="drops-list-item"], [class*="drops"], article, div[role="listitem"]'
    )

    for i in range(candidates.count()):
        card = candidates.nth(i)
        try:
            text = card.inner_text(timeout=5000)
        except PlaywrightTimeout:
            continue
        if pattern.search(text):
            logging.info("Кампания Standoff/SO2 найдена: %.80s...", text.replace("\n", " "))
            card.scroll_into_view_if_needed()
            return card

    fallback = page.locator("div, article, section").filter(has_text=pattern)
    if fallback.count():
        card = fallback.first
        card.scroll_into_view_if_needed()
        logging.info("Кампания найдена (fallback-селектор).")
        return card

    raise RuntimeError("Кампания Standoff 2 / SO2 не найдена на странице Drops.")


def claim_buttons_in_campaign(campaign: Locator) -> Iterable[Locator]:
    buttons = campaign.locator("button, a[role='button']")
    for i in range(buttons.count()):
        btn = buttons.nth(i)
        try:
            label = btn.inner_text(timeout=2000).strip().lower()
        except PlaywrightTimeout:
            continue
        if any(text in label for text in CLAIM_TEXTS):
            yield btn


def claim_standoff_drops(page: Page) -> int:
    claimed = 0
    campaign = find_standoff_campaign(page)
    buttons = list(claim_buttons_in_campaign(campaign))

    if not buttons:
        logging.info("Кнопок «Получить сейчас» / «Claim now» в кампании Standoff нет.")
        return 0

    logging.info("Найдено кнопок для получения: %s", len(buttons))
    for btn in buttons:
        try:
            if not btn.is_visible():
                continue
            btn.scroll_into_view_if_needed()
            btn.click(timeout=DEFAULT_TIMEOUT_MS)
            claimed += 1
            logging.info("Награда получена (%s/%s).", claimed, len(buttons))
            jitter_sleep(*CLAIM_DELAY_RANGE)
        except PlaywrightTimeout:
            logging.warning("Таймаут при клике по кнопке получения награды.")
        except Exception as exc:
            logging.warning("Ошибка клика: %s", exc)

    return claimed


def scroll_inventory(page: Page) -> None:
    logging.info("Прокрутка страницы Drops...")
    for _ in range(8):
        page.mouse.wheel(0, 900)
        page.wait_for_timeout(400)
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(300)


def logout(page: Page) -> None:
    logging.info("Выход из аккаунта...")
    safe_click(page.locator('button[data-a-target="user-menu-toggle"]'))
    safe_click(
        page.locator(
            'button[data-a-target="dropdown-logout"], '
            'button:has-text("Log Out"), button:has-text("Выйти")'
        )
    )
    page.wait_for_load_state("networkidle", timeout=DEFAULT_TIMEOUT_MS)
    logging.info("Выход выполнен.")


def process_account_on_page(page: Page, account: Account) -> int:
    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
    logging.info("=== Аккаунт %s (строка %s) ===", account.login, account.line_no)

    page.goto(DROPS_URL, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle", timeout=DEFAULT_TIMEOUT_MS)
    dismiss_overlays(page)

    if not is_logged_in(page):
        perform_login(page, account)
        page.goto(DROPS_URL, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle", timeout=DEFAULT_TIMEOUT_MS)
        dismiss_overlays(page)
    else:
        logging.info("Уже авторизован (проверьте, что это нужный аккаунт).")

    scroll_inventory(page)
    claimed = claim_standoff_drops(page)
    logging.info("Получено наград Standoff: %s", claimed)

    logout(page)
    log_line(SUCCESS_FILE, f"{account.login}: OK, claimed={claimed}")
    logging.info("Аккаунт %s обработан успешно.", account.login)
    return claimed


def get_page(context: BrowserContext) -> Page:
    if context.pages:
        return context.pages[0]
    return context.new_page()


def run_chromium(pw: Playwright, accounts: list[Account], headless: bool) -> int:
    failures = 0
    browser = pw.chromium.launch(headless=headless)
    try:
        for account in accounts:
            context = browser.new_context(viewport={"width": 1280, "height": 720}, locale="ru-RU")
            page = context.new_page()
            try:
                process_account_on_page(page, account)
                jitter_sleep(2.0, 4.0)
            except Exception as exc:
                failures += 1
                msg = f"{account.login}: {exc}"
                logging.error("Ошибка: %s", msg)
                log_line(ERRORS_FILE, msg)
            finally:
                context.close()
    finally:
        browser.close()
    return failures


def run_dolphin(pw: Playwright, accounts: list[Account], config: AppConfig) -> int:
    if not config.dolphin_token:
        raise ValueError("DOLPHIN_TOKEN не задан в config.json")

    dolphin = DolphinClient(
        DolphinConfig(api_url=config.dolphin_api_url, token=config.dolphin_token)
    )
    failures = 0

    # Группируем аккаунты по profile_id — один запуск профиля на группу
    groups: dict[str, list[Account]] = {}
    for acc in accounts:
        pid = acc.profile_id or config.dolphin_profile_id
        if not pid:
            raise ValueError(f"Нет profile_id для аккаунта {acc.login}")
        groups.setdefault(pid, []).append(acc)

    for profile_id, group in groups.items():
        browser: Browser | None = None
        try:
            logging.info("Запуск профиля Dolphin: %s (%s аккаунт(ов))", profile_id, len(group))
            browser, context = dolphin.connect(pw, profile_id)
            page = get_page(context)

            for account in group:
                try:
                    process_account_on_page(page, account)
                    jitter_sleep(2.0, 4.0)
                except Exception as exc:
                    failures += 1
                    msg = f"{account.login}: {exc}"
                    logging.error("Ошибка: %s", msg)
                    log_line(ERRORS_FILE, msg)
        finally:
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
            dolphin.stop_profile(profile_id)

    return failures


def run(force_chromium: bool, headless: bool | None, limit: int | None) -> int:
    app_config = AppConfig.load(force_chromium=force_chromium)
    if headless is None:
        headless = app_config.headless

    profile_ids = load_profile_ids(
        app_config.dolphin_profile_id,
        len([ln for ln in ACCOUNTS_FILE.read_text(encoding="utf-8").splitlines()
             if ln.strip() and not ln.strip().startswith("#") and ":" in ln]),
    )
    accounts = parse_accounts(ACCOUNTS_FILE, profile_ids)

    if not accounts:
        logging.error("В %s нет валидных аккаунтов.", ACCOUNTS_FILE)
        return 1

    if limit is not None:
        accounts = accounts[:limit]

    mode = "Dolphin Anty" if app_config.use_dolphin else "Chromium"
    logging.info("Режим: %s. К обработке: %s аккаунт(ов).", mode, len(accounts))

    with sync_playwright() as pw:
        if app_config.use_dolphin:
            failures = run_dolphin(pw, accounts, app_config)
        else:
            failures = run_chromium(pw, accounts, headless)

    logging.info("Готово. Успешно: %s, ошибок: %s.", len(accounts) - failures, failures)
    return 0 if failures == 0 else 2


def main() -> None:
    setup_logging()
    parser = argparse.ArgumentParser(description="Twitch Drops — Standoff 2 (Dolphin / Chromium)")
    parser.add_argument(
        "--chromium",
        action="store_true",
        help="Использовать обычный Chromium вместо Dolphin",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=None,
        help="Только для Chromium: без окна браузера",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Обработать только первые N аккаунтов",
    )
    args = parser.parse_args()
    sys.exit(run(force_chromium=args.chromium, headless=args.headless, limit=args.limit))


if __name__ == "__main__":
    main()
