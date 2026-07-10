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
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

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
)
# Только эта кампания — не трогаем другие игры на странице
CAMPAIGN_TITLE_REGEX = re.compile(
    r"SO2\s*JumbleRumble|JumbleRumble\s*:\s*Major",
    re.IGNORECASE,
)
CAMPAIGN_CLAIM_BTN_REGEX = re.compile(r"claim now|получить сейчас", re.IGNORECASE)


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
    parallel_workers: int = 5

    @classmethod
    def load(cls, force_chromium: bool = False) -> AppConfig:
        data: dict = {}
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))

        use_dolphin = bool(data.get("USE_DOLPHIN", True)) and not force_chromium
        workers = int(data.get("PARALLEL_WORKERS", 5))
        return cls(
            use_dolphin=use_dolphin,
            dolphin_api_url=str(data.get("DOLPHIN_API_URL", "http://localhost:3001")),
            dolphin_token=str(data.get("DOLPHIN_TOKEN", "")),
            dolphin_profile_id=str(data.get("DOLPHIN_PROFILE_ID", "")),
            headless=bool(data.get("HEADLESS", False)),
            parallel_workers=max(1, workers),
        )


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


_LOG_LOCK = threading.Lock()


def log_line(path: Path, message: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _LOG_LOCK:
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


def wait_until_logged_in(page: Page, timeout_sec: float = 3.0) -> None:
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


def is_page_alive(page: Page | None) -> bool:
    if page is None:
        return False
    try:
        if page.is_closed():
            return False
        page.evaluate("() => 1")
        return True
    except Exception:
        return False


def is_session_lost_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return (
        "has been closed" in msg
        or "target page" in msg
        or "target closed" in msg
        or "browser has been closed" in msg
    )


def navigate(page: Page, url: str, retries: int = 3) -> None:
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            page.goto(url, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=DEFAULT_TIMEOUT_MS)
            except PlaywrightTimeout:
                logging.warning("networkidle таймаут на %s — продолжаем после паузы.", url)
            jitter_sleep(*DELAY_AFTER_NAV)
            return
        except Exception as exc:
            last_exc = exc
            err = str(exc)
            retryable = any(
                token in err
                for token in (
                    "ERR_TUNNEL_CONNECTION_FAILED",
                    "ERR_ABORTED",
                    "ERR_CONNECTION",
                    "ERR_PROXY",
                    "ERR_NETWORK",
                    "net::",
                )
            )
            if retryable and attempt < retries:
                logging.warning(
                    "Сетевая ошибка на %s (%s), повтор %s/%s...",
                    url,
                    exc,
                    attempt,
                    retries,
                )
                jitter_sleep(1.5, 3.0)
                continue
            raise
    if last_exc is not None:
        raise last_exc


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


def force_logout_state(page: Page) -> None:
    """Жёсткий сброс сессии Twitch перед входом в другой аккаунт."""
    try:
        page.context.clear_cookies()
    except Exception as exc:
        logging.warning("Не удалось очистить cookies: %s", exc)
    navigate(page, "https://www.twitch.tv/login")
    jitter_sleep(0.4, 0.8)
    dismiss_overlays(page)


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
            logging.warning("Выход не удался (%s), принудительный сброс сессии.", exc)

    if is_logged_in(page):
        logging.warning("Сессия всё ещё активна — очистка cookies и /login")
        force_logout_state(page)

    if not is_logged_in(page):
        perform_login(page, account)
    else:
        force_logout_state(page)
        if not is_logged_in(page):
            perform_login(page, account)
        else:
            raise RuntimeError(f"Не удалось переключиться на аккаунт {account.login}")

    jitter_sleep(0.4, 0.7)


def _find_campaign_root(page: Page) -> tuple[Locator, int]:
    """JS: контейнер JumbleRumble, внутри которого есть кнопки Claim Now."""
    info = page.evaluate(
        """() => {
            document.querySelectorAll('[data-farm-jumblerumble]').forEach(
                el => el.removeAttribute('data-farm-jumblerumble')
            );
            const titleRe = /SO2\\s*JumbleRumble|JumbleRumble\\s*:\\s*Major/i;
            const isClaimLabel = (t) => /claim\\s*now/i.test(t) || /получить\\s*сейчас/i.test(t);

            const titleEls = [...document.querySelectorAll('*')].filter(el => {
                const t = (el.textContent || '').trim();
                return t.length >= 8 && t.length < 100 && titleRe.test(t);
            });

            let best = null;
            let bestArea = Infinity;
            let bestClaims = 0;

            for (const titleEl of titleEls) {
                let node = titleEl;
                for (let d = 0; d < 22 && node; d++) {
                    const full = (node.innerText || '');
                    const lower = full.toLowerCase();
                    if (!titleRe.test(full) || !lower.includes('jumble')) {
                        node = node.parentElement;
                        continue;
                    }
                    const claimEls = [...node.querySelectorAll('button, [role=button], a, div')]
                        .filter(el => isClaimLabel((el.textContent || '').trim()));
                    if (claimEls.length === 0) {
                        node = node.parentElement;
                        continue;
                    }
                    const rect = node.getBoundingClientRect();
                    const area = rect.width * rect.height;
                    if (area > 500 && area < bestArea) {
                        best = node;
                        bestArea = area;
                        bestClaims = claimEls.length;
                    }
                    node = node.parentElement;
                }
            }

            if (best) {
                best.setAttribute('data-farm-jumblerumble', '1');
                return { found: true, claims: bestClaims };
            }
            return { found: false, claims: 0 };
        }"""
    )
    loc = page.locator('[data-farm-jumblerumble="1"]')
    if info.get("found") and loc.count():
        return loc, int(info.get("claims", 0))
    return page.locator('[data-farm-jumblerumble="1"]').filter(has_text="__none__"), 0


def _collect_claim_targets(campaign: Locator) -> list[dict]:
    """Собирает координаты Claim Now внутри контейнера кампании (JS — надёжнее для Twitch)."""
    return campaign.evaluate(
        """(root) => {
            const isClaim = (t) => /claim\\s*now/i.test(t) || /получить\\s*сейчас/i.test(t);
            const out = [];
            const nodes = root.querySelectorAll('button, [role=button], a, div, span, p');
            for (const el of nodes) {
                const label = (el.textContent || '').trim();
                if (!isClaim(label)) continue;
                if (label.length > 60) continue;
                const st = window.getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
                const r = el.getBoundingClientRect();
                if (r.width < 20 || r.height < 10) continue;
                const kids = [...el.querySelectorAll('button, [role=button], a')]
                    .filter(c => isClaim((c.textContent || '').trim()));
                if (kids.length > 0 && el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') continue;
                out.push({
                    key: Math.round(r.x) + ':' + Math.round(r.y),
                    x: r.x + r.width / 2,
                    y: r.y + r.height / 2,
                    label: label.slice(0, 30),
                });
            }
            const seen = new Set();
            return out.filter(p => { if (seen.has(p.key)) return false; seen.add(p.key); return true; });
        }"""
    )


def find_standoff_campaign(page: Page) -> Locator:
    """Ищет секцию JumbleRumble — без прокрутки всей страницы."""
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(150)
    jitter_sleep(0.2, 0.4)

    for scroll_pass in range(6):
        campaign, claim_count = _find_campaign_root(page)
        if campaign.count():
            try:
                snippet = campaign.first.inner_text(timeout=3000)[:100].replace("\n", " ")
                logging.info(
                    "JumbleRumble найден (проход %s, Claim в DOM: %s): %s...",
                    scroll_pass + 1,
                    claim_count,
                    snippet,
                )
                campaign.first.scroll_into_view_if_needed()
                page.wait_for_timeout(300)
                return campaign.first
            except PlaywrightTimeout:
                pass

        if scroll_pass < 5:
            page.mouse.wheel(0, 320)
            page.wait_for_timeout(120)

    shot = BASE_DIR / "debug_drops_not_found.png"
    try:
        page.screenshot(path=str(shot), full_page=True)
        logging.error("Скрин: %s", shot)
    except Exception:
        pass
    raise RuntimeError("Секция SO2 JumbleRumble не найдена на странице Drops.")


def reset_campaign_horizontal_scroll(campaign: Locator) -> None:
    try:
        campaign.evaluate(
            """(el) => {
                for (const node of [el, ...el.querySelectorAll('*')]) {
                    if (node.scrollWidth > node.clientWidth + 10) node.scrollLeft = 0;
                }
            }"""
        )
    except Exception:
        pass


def scroll_campaign_rewards(campaign: Locator, step: int = 260) -> None:
    """Только горизонтальная прокрутка ряда кейсов внутри кампании."""
    try:
        campaign.evaluate(
            """(el, step) => {
                for (const node of [el, ...el.querySelectorAll('*')]) {
                    if (node.scrollWidth > node.clientWidth + 10) {
                        node.scrollLeft = Math.min(
                            node.scrollLeft + step,
                            node.scrollWidth - node.clientWidth
                        );
                    }
                }
            }""",
            step,
        )
    except Exception:
        pass
    jitter_sleep(0.12, 0.25)




def claim_standoff_drops(page: Page) -> int:
    campaign = find_standoff_campaign(page)
    jitter_sleep(0.3, 0.5)
    dismiss_email_verification(page)

    lower = campaign.inner_text(timeout=5000).lower()
    if "jumble" not in lower:
        raise RuntimeError("Контейнер кампании не содержит JumbleRumble — отмена.")

    reset_campaign_horizontal_scroll(campaign)
    claimed = 0
    seen: set[str] = set()
    no_new_streak = 0

    for pass_num in range(16):
        targets = _collect_claim_targets(campaign)
        if pass_num == 0:
            logging.info("Кнопок Claim в JumbleRumble: %s", len(targets))

        new_clicks = 0
        for t in targets:
            key = t["key"]
            if key in seen:
                continue
            try:
                page.mouse.click(t["x"], t["y"])
                seen.add(key)
                claimed += 1
                new_clicks += 1
                logging.info("JumbleRumble Claim (%s) @ %s", claimed, key)
                jitter_sleep(*CLAIM_DELAY_RANGE)
                dismiss_email_verification(page)
            except Exception as exc:
                logging.warning("Ошибка клика @ %s: %s", key, exc)

        if new_clicks == 0:
            no_new_streak += 1
        else:
            no_new_streak = 0

        scroll_campaign_rewards(campaign)
        if no_new_streak >= 4:
            break

    if claimed == 0:
        try:
            page.screenshot(path=str(BASE_DIR / "debug_no_claim_buttons.png"))
        except Exception:
            pass
        logging.info("В JumbleRumble нет доступных Claim Now.")
    else:
        logging.info("Всего получено в JumbleRumble: %s.", claimed)
    return claimed


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
    wait_until_logged_in(page, timeout_sec=2.0)

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


def _profile_key(account: Account, default_profile_id: str) -> str:
    return account.profile_id or default_profile_id or account.login


def split_accounts_for_workers(
    accounts: list[Account],
    workers: int,
    use_dolphin: bool,
    default_profile_id: str,
) -> list[list[Account]]:
    """Делит аккаунты между браузерами: у каждого своя очередь, без пересечений."""
    if not accounts:
        return []

    worker_count = min(max(1, workers), len(accounts))
    buckets: list[list[Account]] = [[] for _ in range(worker_count)]

    if use_dolphin:
        # Один profile_id — только один браузер; аккаунты с тем же профилем идут в его очередь
        profile_to_worker: dict[str, int] = {}
        next_worker = 0
        for account in accounts:
            key = _profile_key(account, default_profile_id)
            if key not in profile_to_worker:
                profile_to_worker[key] = next_worker % worker_count
                next_worker += 1
            buckets[profile_to_worker[key]].append(account)
    else:
        for idx, account in enumerate(accounts):
            buckets[idx % worker_count].append(account)

    return [bucket for bucket in buckets if bucket]


def log_worker_split(buckets: list[list[Account]]) -> None:
    logging.info("Разделение аккаунтов по браузерам:")
    for worker_no, bucket in enumerate(buckets, start=1):
        logins = ", ".join(account.login for account in bucket)
        logging.info("  Браузер %s (%s шт.): %s", worker_no, len(bucket), logins)


def _open_dolphin_session(
    worker_no: int,
    dolphin: DolphinClient,
    pw: Playwright,
    profile_id: str,
) -> tuple[Browser, Page]:
    logging.info("[Браузер %s] Запуск профиля Dolphin %s", worker_no, profile_id)
    browser, context = dolphin.connect(pw, profile_id)
    return browser, get_page(context)


def _browser_worker(
    worker_no: int,
    accounts: list[Account],
    config: AppConfig,
    headless: bool,
) -> int:
    """Один браузер на воркер: между аккаунтами только logout, закрытие в конце очереди."""
    failures = 0
    logging.info(
        "Браузер %s стартовал — %s аккаунт(ов): %s",
        worker_no,
        len(accounts),
        ", ".join(account.login for account in accounts),
    )

    with sync_playwright() as pw:
        if config.use_dolphin:
            if not config.dolphin_token:
                raise ValueError("DOLPHIN_TOKEN не задан в config.json")

            dolphin = DolphinClient(
                DolphinConfig(api_url=config.dolphin_api_url, token=config.dolphin_token)
            )
            browser: Browser | None = None
            page: Page | None = None
            active_profile_id: str | None = None

            def close_dolphin_session() -> None:
                nonlocal browser, page, active_profile_id
                if browser:
                    try:
                        browser.close()
                    except Exception:
                        pass
                    browser = None
                    page = None
                if active_profile_id:
                    dolphin.stop_profile(active_profile_id)
                    jitter_sleep(0.8, 1.4)
                    active_profile_id = None

            def ensure_dolphin_page(profile_id: str) -> Page:
                nonlocal browser, page, active_profile_id
                if (
                    profile_id == active_profile_id
                    and is_page_alive(page)
                    and browser is not None
                ):
                    assert page is not None
                    return page

                close_dolphin_session()
                browser, page = _open_dolphin_session(worker_no, dolphin, pw, profile_id)
                active_profile_id = profile_id
                return page

            def run_account(account: Account, profile_id: str) -> None:
                nonlocal page
                page = ensure_dolphin_page(profile_id)
                process_account_on_page(page, account)

            try:
                for account in accounts:
                    profile_id = account.profile_id or config.dolphin_profile_id
                    if not profile_id:
                        failures += 1
                        msg = f"{account.login}: нет profile_id"
                        logging.error("[Браузер %s] %s", worker_no, msg)
                        log_line(ERRORS_FILE, msg)
                        continue

                    try:
                        run_account(account, profile_id)
                        jitter_sleep(*DELAY_BETWEEN_ACCOUNTS)
                    except Exception as exc:
                        if is_session_lost_error(exc) or not is_page_alive(page):
                            logging.warning(
                                "[Браузер %s] Сессия потеряна у %s — перезапуск браузера...",
                                worker_no,
                                account.login,
                            )
                            close_dolphin_session()
                            try:
                                run_account(account, profile_id)
                                jitter_sleep(*DELAY_BETWEEN_ACCOUNTS)
                                continue
                            except Exception as retry_exc:
                                exc = retry_exc

                        failures += 1
                        msg = f"{account.login}: {exc}"
                        logging.error("[Браузер %s] Ошибка: %s", worker_no, msg)
                        log_line(ERRORS_FILE, msg)
                        if is_session_lost_error(exc):
                            close_dolphin_session()
            finally:
                close_dolphin_session()
        else:
            browser = pw.chromium.launch(headless=headless)
            try:
                context = browser.new_context(
                    viewport={"width": 1280, "height": 720},
                    locale="ru-RU",
                )
                page = context.new_page()
                for account in accounts:
                    try:
                        if not is_page_alive(page):
                            page = context.new_page()
                        process_account_on_page(page, account)
                        jitter_sleep(*DELAY_BETWEEN_ACCOUNTS)
                    except Exception as exc:
                        if is_session_lost_error(exc):
                            logging.warning(
                                "[Браузер %s] Вкладка закрыта — новая для %s",
                                worker_no,
                                account.login,
                            )
                            try:
                                page = context.new_page()
                                process_account_on_page(page, account)
                                jitter_sleep(*DELAY_BETWEEN_ACCOUNTS)
                                continue
                            except Exception as retry_exc:
                                exc = retry_exc
                        failures += 1
                        msg = f"{account.login}: {exc}"
                        logging.error("[Браузер %s] Ошибка: %s", worker_no, msg)
                        log_line(ERRORS_FILE, msg)
            finally:
                browser.close()

    logging.info("Браузер %s завершил работу.", worker_no)
    return failures


def run_parallel(accounts: list[Account], config: AppConfig, headless: bool, workers: int) -> int:
    buckets = split_accounts_for_workers(
        accounts,
        workers,
        config.use_dolphin,
        config.dolphin_profile_id,
    )

    if config.use_dolphin and workers > 1:
        unique_profiles = len({
            _profile_key(acc, config.dolphin_profile_id) for acc in accounts
        })
        if unique_profiles < workers:
            logging.warning(
                "Dolphin: уникальных профилей %s — одновременно активно %s браузер(ов). "
                "Добавьте разные ID в profiles.txt (по одному на аккаунт).",
                unique_profiles,
                len(buckets),
            )

    log_worker_split(buckets)
    logging.info(
        "Параллельный режим: до %s браузер(ов), каждый со своей очередью аккаунтов.",
        len(buckets),
    )

    failures = 0
    with ThreadPoolExecutor(max_workers=len(buckets)) as executor:
        futures = {
            executor.submit(_browser_worker, worker_no, bucket, config, headless): worker_no
            for worker_no, bucket in enumerate(buckets, start=1)
        }
        for future in as_completed(futures):
            worker_no = futures[future]
            try:
                failures += future.result()
            except Exception as exc:
                failures += 1
                logging.error("[Браузер %s] Критическая ошибка: %s", worker_no, exc)

    return failures


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


def run(
    force_chromium: bool,
    headless: bool | None,
    limit: int | None,
    workers: int | None,
) -> int:
    app_config = AppConfig.load(force_chromium=force_chromium)
    if headless is None:
        headless = app_config.headless
    parallel_workers = workers if workers is not None else app_config.parallel_workers
    parallel_workers = max(1, parallel_workers)

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
    if parallel_workers > 1:
        logging.info(
            "Режим: %s, параллельно %s браузер(ов). К обработке: %s аккаунт(ов).",
            mode,
            parallel_workers,
            len(accounts),
        )
        failures = run_parallel(accounts, app_config, headless, parallel_workers)
    else:
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
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        metavar="N",
        help="Сколько браузеров запускать параллельно (или PARALLEL_WORKERS в config.json)",
    )
    args = parser.parse_args()
    sys.exit(
        run(
            force_chromium=args.chromium,
            headless=args.headless,
            limit=args.limit,
            workers=args.workers,
        )
    )


if __name__ == "__main__":
    main()
