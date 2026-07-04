"""
YouTube login + language-change automation using Selenium.

The Selenium driver connects to the Chromium instance that Dolphin Anty
already launched, via the remote debugger port returned by the start_profile
API call.
"""

import time
import logging

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import (
    TimeoutException,
    NoSuchElementException,
    ElementNotInteractableException,
)

from totp_helper import get_totp_code, get_totp_code_with_validity
from config import PAGE_LOAD_TIMEOUT, ELEMENT_WAIT_TIMEOUT, ACTION_DELAY, LOGIN_WAIT

logger = logging.getLogger(__name__)


def connect_to_dolphin_profile(port: int) -> webdriver.Remote:
    """
    Connect Selenium to a Dolphin profile that is already running.

    Dolphin start_profile() returns:
        { "automation": { "port": 9222, "wsEndpoint": "..." }, ... }
    Pass the port number here.
    """
    options = Options()
    options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
    return driver


# --------------------------------------------------------------------------- #
# Internal helpers
# --------------------------------------------------------------------------- #

def _wait(driver: webdriver.Remote, timeout: int = ELEMENT_WAIT_TIMEOUT) -> WebDriverWait:
    return WebDriverWait(driver, timeout)


def _click(driver: webdriver.Remote, by: By, selector: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
    el = _wait(driver, timeout).until(EC.element_to_be_clickable((by, selector)))
    el.click()
    return el


def _type(driver: webdriver.Remote, by: By, selector: str, text: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
    el = _wait(driver, timeout).until(EC.visibility_of_element_located((by, selector)))
    el.clear()
    el.send_keys(text)
    return el


def _find_any(driver: webdriver.Remote, selectors: list[tuple[By, str]], timeout: int = ELEMENT_WAIT_TIMEOUT):
    """Wait until ANY of the given (By, selector) pairs is clickable and return the first found."""
    wait = WebDriverWait(driver, timeout)
    locators = [EC.presence_of_element_located(s) for s in selectors]
    # wait for any
    for _ in range(timeout * 2):
        for loc in selectors:
            try:
                el = driver.find_element(*loc)
                if el.is_displayed():
                    return el
            except NoSuchElementException:
                pass
        time.sleep(0.5)
    raise TimeoutException(f"None of the selectors found within {timeout}s: {selectors}")


# --------------------------------------------------------------------------- #
# Login flow
# --------------------------------------------------------------------------- #

def login_to_youtube(
    driver: webdriver.Remote,
    email: str,
    password: str,
    totp_secret: str = "",
) -> bool:
    """
    Log in to a Google/YouTube account.

    Returns True on success, False on failure.
    The driver should already be pointed at a running Dolphin profile.
    """
    try:
        logger.info(f"Opening YouTube sign-in page for {email}")
        driver.get("https://accounts.google.com/ServiceLogin?service=youtube")
        time.sleep(ACTION_DELAY)

        # ── Step 1: Email ────────────────────────────────────────────────── #
        email_field = _wait(driver).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, "input[type='email']"))
        )
        email_field.clear()
        email_field.send_keys(email)
        time.sleep(0.5)

        # Click "Next" — works regardless of interface language
        _click_next_button(driver)
        time.sleep(ACTION_DELAY)

        # ── Step 2: Password ─────────────────────────────────────────────── #
        password_field = _wait(driver).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, "input[type='password']"))
        )
        password_field.clear()
        password_field.send_keys(password)
        time.sleep(0.5)

        _click_next_button(driver)
        time.sleep(LOGIN_WAIT)

        # ── Step 3: 2FA (if required) ────────────────────────────────────── #
        if _is_2fa_required(driver):
            if not totp_secret:
                logger.error("2FA required but no TOTP secret provided")
                return False

            code, remaining = get_totp_code_with_validity(totp_secret)
            # If the code expires in less than 5 seconds, wait for the next one
            if remaining < 5:
                logger.info(f"TOTP code expires in {remaining}s — waiting for next code")
                time.sleep(remaining + 1)
                code, _ = get_totp_code_with_validity(totp_secret)

            logger.info(f"Entering 2FA code (valid for {remaining}s)")
            _enter_2fa_code(driver, code)
            time.sleep(LOGIN_WAIT)

        # ── Step 4: Verify we are logged in ─────────────────────────────── #
        driver.get("https://www.youtube.com")
        time.sleep(ACTION_DELAY)

        if _is_logged_in(driver):
            logger.info(f"✓ Logged in successfully: {email}")
            return True
        else:
            logger.warning(f"✗ Login verification failed for {email}")
            return False

    except Exception as exc:
        logger.error(f"Login error for {email}: {exc}")
        return False


def _click_next_button(driver: webdriver.Remote):
    """
    Click the "Next" button on Google sign-in, regardless of language.
    Google renders it as a button with id 'identifierNext' or 'passwordNext',
    or with jsname='LgbsSe'.  We try multiple selectors.
    """
    selectors = [
        (By.ID, "identifierNext"),
        (By.ID, "passwordNext"),
        (By.CSS_SELECTOR, "button[jsname='LgbsSe']"),
        (By.CSS_SELECTOR, "div[jsname='LgbsSe']"),
        (By.XPATH, "//button[contains(@class,'VfPpkd-LgbsSe')]"),
        (By.XPATH, "//div[@role='button'][contains(@class,'VfPpkd')]"),
    ]
    for by, sel in selectors:
        try:
            btn = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((by, sel)))
            btn.click()
            return
        except (TimeoutException, ElementNotInteractableException):
            continue
    # Last resort: press Enter in whatever input is focused
    driver.switch_to.active_element.send_keys(Keys.RETURN)


def _is_2fa_required(driver: webdriver.Remote) -> bool:
    """Return True if the page is asking for a 2FA / verification code."""
    indicators = [
        "//input[@id='totpPin']",
        "//input[contains(@aria-label,'code') or contains(@aria-label,'код')]",
        "//input[@name='totpPin']",
        "//*[contains(@class,'totp')]",
        "//input[@id='idvPin']",
    ]
    for xpath in indicators:
        try:
            el = driver.find_element(By.XPATH, xpath)
            if el.is_displayed():
                return True
        except NoSuchElementException:
            pass
    # Also check URL
    return "challenge/totp" in driver.current_url or "signin/challenge" in driver.current_url


def _enter_2fa_code(driver: webdriver.Remote, code: str):
    """Type the 6-digit TOTP code and submit."""
    selectors = [
        (By.ID, "totpPin"),
        (By.ID, "idvPin"),
        (By.CSS_SELECTOR, "input[name='totpPin']"),
        (By.CSS_SELECTOR, "input[aria-label*='code']"),
        (By.CSS_SELECTOR, "input[aria-label*='код']"),
        (By.CSS_SELECTOR, "input[type='tel']"),
    ]
    for by, sel in selectors:
        try:
            field = WebDriverWait(driver, 5).until(
                EC.visibility_of_element_located((by, sel))
            )
            field.clear()
            field.send_keys(code)
            time.sleep(0.5)
            _click_next_button(driver)
            return
        except (TimeoutException, NoSuchElementException):
            continue
    raise RuntimeError("Could not find 2FA input field")


def _is_logged_in(driver: webdriver.Remote) -> bool:
    """
    Return True if the current page shows a signed-in YouTube session.
    Looks for the avatar button (present only when logged in).
    """
    try:
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "button#avatar-btn"))
        )
        return True
    except TimeoutException:
        pass
    # Fallback: check if account menu is anywhere on the page
    try:
        driver.find_element(By.CSS_SELECTOR, "ytd-masthead #avatar-btn")
        return True
    except NoSuchElementException:
        return False


# --------------------------------------------------------------------------- #
# Language change
# --------------------------------------------------------------------------- #

def set_youtube_language_english(driver: webdriver.Remote) -> bool:
    """
    Change YouTube interface language to English (US) regardless of the
    current language.  Works by navigating the settings menu via accessible
    selectors that don't depend on visible label text.

    Returns True on success.
    """
    try:
        logger.info("Setting YouTube language to English")
        driver.get("https://www.youtube.com")
        time.sleep(ACTION_DELAY)

        # Open the account/settings menu
        _click(driver, By.CSS_SELECTOR, "button#avatar-btn")
        time.sleep(ACTION_DELAY)

        # Click the "Language" row — it contains the globe/language icon
        # We look by the icon name attribute, which is language-independent
        lang_selectors = [
            (By.XPATH, "//yt-icon[@icon='language']"),
            (By.CSS_SELECTOR, "ytd-compact-link-renderer yt-icon[icon='language']"),
            (By.XPATH, "//ytd-compact-link-renderer[.//yt-icon[@icon='language']]"),
            (By.CSS_SELECTOR, "tp-yt-paper-item[role='option'] yt-icon[icon='language']"),
        ]
        lang_row = None
        for by, sel in lang_selectors:
            try:
                lang_row = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((by, sel)))
                break
            except TimeoutException:
                continue

        if lang_row is None:
            # Try clicking the settings cog first (some layouts)
            try:
                _click(driver, By.XPATH, "//yt-icon[@icon='settings']", timeout=5)
                time.sleep(ACTION_DELAY)
                for by, sel in lang_selectors:
                    try:
                        lang_row = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((by, sel)))
                        break
                    except TimeoutException:
                        continue
            except TimeoutException:
                pass

        if lang_row is None:
            logger.error("Could not find Language option in YouTube menu")
            return False

        lang_row.click()
        time.sleep(ACTION_DELAY)

        # Select "English (US)" from the language list
        # The option text is always "English (US)" in every language version
        english_selectors = [
            (By.XPATH, "//yt-formatted-string[normalize-space(text())='English (US)']"),
            (By.XPATH, "//*[contains(text(),'English (US)')]"),
            (By.XPATH, "//ytd-compact-link-renderer[.//yt-formatted-string[contains(.,'English (US)')]]"),
        ]
        for by, sel in english_selectors:
            try:
                el = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((by, sel)))
                el.click()
                time.sleep(ACTION_DELAY)
                logger.info("✓ Language set to English (US)")
                return True
            except TimeoutException:
                continue

        logger.error("Could not find 'English (US)' option in language list")
        return False

    except Exception as exc:
        logger.error(f"Language change error: {exc}")
        return False
