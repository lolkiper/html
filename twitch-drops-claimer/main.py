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
CLAIM_DELAY_RANGE = (0.3, 0.5)

# Паузы (секунды) — уменьшены в 5× от предыдущей версии
DELAY_AFTER_NAV = (0.5, 0.9)
DELAY_AFTER_CLICK = (0.2, 0.4)
DELAY_AFTER_TYPE = (0.16, 0.3)
DELAY_AFTER_LOGIN = (0.8, 1.2)
DELAY_AFTER_LOGOUT = (0.5, 0.8)
DELAY_BETWEEN_ACCOUNTS = (1.0, 1.6)
TYPE_DELAY_MS = (14, 28)
CLAIM_TEXTS = (
    "получить сейчас",
    "claim now",
    "claim reward",
    "revendică",
    "revendica",
    "redeem",
)


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
ACCOUNTS_EXAMPLE = BASE_DIR / "accounts.txt.example"
CONFIG_EXAMPLE = BASE_DIR / "config.json.example"


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


def ensure_setup(app_config: AppConfig) -> bool:
    """Проверяет наличие обязательных файлов; создаёт из .example при первом запуске."""
    ok = True

    if not CONFIG_FILE.exists():
        if CONFIG_EXAMPLE.exists():
            CONFIG_FILE.write_text(CONFIG_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
            logging.error(
                "Создан config.json из примера. Откройте файл и вставьте DOLPHIN_TOKEN и DOLPHIN_PROFILE_ID."
            )
        else:
            logging.error("Не найден config.json — скопируйте config.json.example → config.json")
        ok = False

    if app_config.use_dolphin and CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        token = str(cfg.get("DOLPHIN_TOKEN", ""))
        profile = str(cfg.get("DOLPHIN_PROFILE_ID", ""))
        if not token or token.startswith("ВСТАВЬ"):
            logging.error("В config.json укажите реальный DOLPHIN_TOKEN.")
            ok = False
        if not profile or profile.startswith("ВСТАВЬ"):
            logging.error("В config.json укажите DOLPHIN_PROFILE_ID (ID профиля Dolphin).")
            ok = False

    if not ACCOUNTS_FILE.exists():
        if ACCOUNTS_EXAMPLE.exists():
            ACCOUNTS_FILE.write_text(ACCOUNTS_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
            logging.error(
                "Создан accounts.txt из примера.\n"
                "Откройте файл и добавьте строки: логин:пароль\n"
                "Затем снова запустите: python main.py"
            )
        else:
            logging.error(
                "Файл accounts.txt не найден в папке:\n  %s\n"
                "Создайте accounts.txt (формат: login:password, одна строка — один аккаунт).",
                ACCOUNTS_FILE,
            )
        ok = False

    return ok


def count_account_lines() -> int:
    if not ACCOUNTS_FILE.exists():
        return 0
    return len([
        ln for ln in ACCOUNTS_FILE.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.strip().startswith("#") and ":" in ln
    ])


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


def human_fill(locator: Locator, text: str, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    """Ввод текста посимвольно — Twitch иногда не принимает мгновенный fill()."""
    field = locator.first
    wait_visible(field, timeout_ms)
    field.click()
    jitter_sleep(0.08, 0.18)
    field.fill("")
    jitter_sleep(0.06, 0.12)
    field.press_sequentially(text, delay=random.randint(*TYPE_DELAY_MS))
    jitter_sleep(*DELAY_AFTER_TYPE)


def wait_until_logged_in(page: Page, timeout_sec: float = 60.0) -> None:
    """Ждём, пока форма входа исчезнет и появится меню пользователя."""
    logging.info("Ожидание завершения авторизации (до %.0f сек)...", timeout_sec)
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        dismiss_email_verification(page)
        if is_logged_in(page) and not login_form_visible(page):
            jitter_sleep(*DELAY_AFTER_LOGIN)
            dismiss_email_verification(page)
            if is_logged_in(page) and not login_form_visible(page):
                try:
                    page.wait_for_load_state("networkidle", timeout=15_000)
                except PlaywrightTimeout:
                    pass
                logging.info("Сессия Twitch подтверждена.")
                return
        jitter_sleep(0.16, 0.3)
    raise RuntimeError("Таймаут: авторизация не завершилась")


def navigate(page: Page, url: str) -> None:
    page.goto(url, wait_until="domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=DEFAULT_TIMEOUT_MS)
    except PlaywrightTimeout:
        logging.warning("networkidle таймаут на %s — продолжаем после паузы.", url)
    jitter_sleep(*DELAY_AFTER_NAV)


def wait_visible(locator: Locator, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    locator.first.wait_for(state="visible", timeout=timeout_ms)


def safe_click(locator: Locator, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    target = locator.first
    wait_visible(target, timeout_ms)
    target.scroll_into_view_if_needed(timeout=timeout_ms)
    jitter_sleep(0.06, 0.14)
    target.click(timeout=timeout_ms)
    jitter_sleep(*DELAY_AFTER_CLICK)


def dismiss_email_verification(page: Page) -> bool:
    """Закрывает модалку «Verify Your Email Address» — Remind me later или X."""
    markers = (
        "verify your email",
        "verification code",
        "подтвердите email",
        "код подтверждения",
        "verifică",
    )
    body = ""
    try:
        body = page.locator("body").inner_text(timeout=2000).lower()
    except Exception:
        pass

    if not any(m in body for m in markers):
        return False

    logging.info("Обнаружено окно верификации email — закрываю...")
    selectors = [
        'button:has-text("Remind me later")',
        'button:has-text("Напомнить позже")',
        'button:has-text("Amintește-mi mai târziu")',
        'button:has-text("Later")',
        '[data-a-target="modal-close-button"]',
        'div[role="dialog"] button[aria-label="Close"]',
        'div[role="dialog"] button[aria-label="Закрыть"]',
    ]
    for sel in selectors:
        btn = page.locator(sel)
        if btn.count():
            try:
                if btn.first.is_visible():
                    btn.first.click(timeout=5000)
                    logging.info("Окно верификации закрыто: %s", sel)
                    jitter_sleep(0.2, 0.4)
                    return True
            except PlaywrightTimeout:
                pass

    dialog = page.locator('div[role="dialog"]').filter(
        has_text=re.compile(r"verify|verification|verific", re.IGNORECASE)
    )
    if dialog.count():
        try:
            dialog.first.locator("button").first.click(timeout=3000)
            logging.info("Окно верификации закрыто через dialog.")
            jitter_sleep(0.2, 0.4)
            return True
        except PlaywrightTimeout:
            pass
    return False


def dismiss_overlays(page: Page) -> None:
    dismiss_email_verification(page)
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
                    jitter_sleep(0.06, 0.16)
                except PlaywrightTimeout:
                    pass
        if not dismissed:
            break


def login_form_visible(page: Page) -> bool:
    selectors = [
        '[data-a-target="passport-login-modal"]',
        'input[name="login-username"]',
        'input#login-username',
        'input[autocomplete="username"]',
        'form input[type="password"]',
    ]
    for sel in selectors:
        loc = page.locator(sel)
        if loc.count():
            try:
                if loc.first.is_visible():
                    return True
            except Exception:
                pass
    return False


def is_logged_in(page: Page) -> bool:
    if login_form_visible(page):
        return False
    login_btn = page.locator('button[data-a-target="login-button"]')
    if login_btn.count():
        try:
            if login_btn.first.is_visible():
                return False
        except Exception:
            pass
    user_menu = page.locator('button[data-a-target="user-menu-toggle"]')
    if user_menu.count():
        try:
            return user_menu.first.is_visible()
        except Exception:
            return False
    return False


def open_login_form(page: Page) -> None:
    if login_form_visible(page):
        jitter_sleep(0.2, 0.4)
        return
    login_btn = page.locator('button[data-a-target="login-button"]')
    if login_btn.count() and login_btn.first.is_visible():
        safe_click(login_btn)
        jitter_sleep(0.3, 0.5)
        return
    logging.info("Открываю страницу входа Twitch...")
    navigate(page, "https://www.twitch.tv/login")


def perform_login(page: Page, account: Account) -> None:
    logging.info("Вход в аккаунт %s...", account.login)
    dismiss_overlays(page)
    open_login_form(page)
    jitter_sleep(0.2, 0.4)

    username = page.locator(
        'input[name="login-username"], input#login-username, input[autocomplete="username"]'
    )
    human_fill(username, account.login, timeout_ms=30_000)

    password = page.locator(
        'input[name="password"], input#password-input, input[type="password"]'
    )
    if password.count() and password.first.is_visible():
        human_fill(password, account.password, timeout_ms=30_000)
    else:
        next_btn = page.locator(
            'button[data-a-target="passport-login-button"], '
            'button:has-text("Continue"), button:has-text("Продолжить"), '
            'button:has-text("Continuă")'
        )
        if next_btn.count():
            safe_click(next_btn)
            jitter_sleep(0.3, 0.5)
        human_fill(password, account.password, timeout_ms=30_000)

    jitter_sleep(0.2, 0.4)
    submit = page.locator(
        'button[data-a-target="passport-login-button"]:not([disabled]), '
        'button[type="submit"]:has-text("Log In"):not([disabled]), '
        'button[type="submit"]:has-text("Войти"):not([disabled]), '
        'button[type="submit"]:has-text("Conectează-te"):not([disabled]), '
        'button[type="submit"]:has-text("Sign In"):not([disabled])'
    )
    if not submit.count():
        submit = page.locator(
            'button[data-a-target="passport-login-button"], '
            'button[type="submit"]:has-text("Log In"), '
            'button[type="submit"]:has-text("Войти"), '
            'button[type="submit"]:has-text("Conectează-te"), '
            'button[type="submit"]:has-text("Sign In")'
        )
    safe_click(submit, timeout_ms=30_000)

    wait_until_logged_in(page)
    logging.info("Логин %s выполнен.", account.login)


def ensure_account_session(page: Page, account: Account) -> None:
    """Сброс чужой сессии и вход под нужным аккаунтом."""
    dismiss_overlays(page)

    if is_logged_in(page):
        logging.info("Активна другая сессия — выход перед входом в %s", account.login)
        try:
            logout(page)
            dismiss_overlays(page)
            jitter_sleep(0.2, 0.4)
        except Exception as exc:
            logging.warning("Выход не удался (%s), продолжаем вход.", exc)

    if not is_logged_in(page):
        perform_login(page, account)
    else:
        raise RuntimeError(f"Не удалось переключиться на аккаунт {account.login}")

    jitter_sleep(0.4, 0.7)


def find_standoff_campaign(page: Page) -> Locator:
    """Ищет блок кампании Standoff/SO2 с прокруткой страницы."""
    pattern = re.compile(r"standoff|so2", re.IGNORECASE)
    selectors = (
        '[data-a-target="drops-list-item"]',
        '[class*="drops"]',
        '[class*="Drop"]',
        'article',
        'div[role="listitem"]',
        'li',
    )

    for scroll_pass in range(15):
        for sel in selectors:
            cards = page.locator(sel).filter(has_text=pattern)
            count = cards.count()
            for i in range(count):
                card = cards.nth(i)
                try:
                    text = card.inner_text(timeout=3000)
                except PlaywrightTimeout:
                    continue
                if pattern.search(text):
                    logging.info(
                        "Кампания Standoff/SO2 найдена (проход %s): %.80s...",
                        scroll_pass + 1,
                        text.replace("\n", " "),
                    )
                    card.scroll_into_view_if_needed()
                    return card

        text_hit = page.get_by_text(pattern)
        if text_hit.count():
            card = text_hit.first.locator("xpath=ancestor::article[1]")
            if not card.count():
                card = text_hit.first.locator("xpath=ancestor::div[contains(@class,'drop') or contains(@class,'Drop')][1]")
            if card.count():
                card.scroll_into_view_if_needed()
                logging.info("Кампания найдена через get_by_text (проход %s).", scroll_pass + 1)
                return card

        page.mouse.wheel(0, 800)
        page.wait_for_timeout(100)

    # Диагностика: сохранить скрин при отладке
    screenshot = BASE_DIR / "debug_drops_not_found.png"
    try:
        page.screenshot(path=str(screenshot), full_page=True)
        logging.error("Скрин сохранён: %s", screenshot)
    except Exception:
        pass

    raise RuntimeError(
        "Кампания Standoff 2 / SO2 не найдена. "
        "Проверьте, что аккаунт залогинен и на странице есть активная кампания."
    )


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
    jitter_sleep(0.3, 0.5)
    for _ in range(8):
        page.mouse.wheel(0, 900)
        page.wait_for_timeout(random.randint(100, 160))
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(random.randint(120, 200))
    jitter_sleep(0.2, 0.4)


def logout(page: Page) -> None:
    if not is_logged_in(page):
        logging.info("Выход не требуется — сессия не активна.")
        return
    logging.info("Выход из аккаунта...")
    safe_click(page.locator('button[data-a-target="user-menu-toggle"]'))
    safe_click(
        page.locator(
            'button[data-a-target="dropdown-logout"], '
            'button:has-text("Log Out"), button:has-text("Выйти"), '
            'button:has-text("Deconectare"), button[data-a-target="logout-button"]'
        )
    )
    page.wait_for_load_state("networkidle", timeout=DEFAULT_TIMEOUT_MS)
    jitter_sleep(*DELAY_AFTER_LOGOUT)
    logging.info("Выход выполнен.")


def process_account_on_page(page: Page, account: Account) -> int:
    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
    logging.info("=== Аккаунт %s (строка %s) ===", account.login, account.line_no)

    navigate(page, DROPS_URL)
    dismiss_overlays(page)

    ensure_account_session(page, account)

    navigate(page, DROPS_URL)
    dismiss_overlays(page)
    dismiss_email_verification(page)
    wait_until_logged_in(page, timeout_sec=20.0)

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
                jitter_sleep(*DELAY_BETWEEN_ACCOUNTS)
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
                    jitter_sleep(*DELAY_BETWEEN_ACCOUNTS)
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

    if not ensure_setup(app_config):
        return 1

    profile_ids = load_profile_ids(app_config.dolphin_profile_id, count_account_lines())
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
