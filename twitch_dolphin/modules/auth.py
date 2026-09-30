from __future__ import annotations

import logging
import time
from typing import Literal

from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

logger = logging.getLogger("twitch_dolphin")

LoginResult = Literal["already_logged_in", "success", "manual_verification_required", "failed"]


def _wait(driver: WebDriver, timeout: int) -> WebDriverWait:
    return WebDriverWait(driver, timeout)


def _page_text(driver: WebDriver) -> str:
    try:
        return (driver.find_element(By.TAG_NAME, "body").text or "").lower()
    except WebDriverException:
        return ""


def requires_manual_verification(driver: WebDriver) -> bool:
    """
    Detect CAPTCHA, 2FA, email/phone codes, security challenges, or blocks.
    Does not attempt to bypass any of these flows.
    """
    text = _page_text(driver)
    url = (driver.current_url or "").lower()

    keywords = [
        "captcha",
        "two-factor",
        "2fa",
        "verification code",
        "verify your",
        "confirm your login",
        "suspicious activity",
        "unusual activity",
        "security check",
        "authenticate",
        "enter the code",
        "check your email",
        "text message",
        "phone number",
        "account has been suspended",
        "account is banned",
        "blocked",
        "robot",
        "prove you're human",
    ]
    if any(k in text for k in keywords):
        return True

    if "challenge" in url or "mfa" in url or "two-factor" in url:
        return True

    for selector in ("iframe[src*='captcha']", "iframe[src*='recaptcha']"):
        try:
            if driver.find_elements(By.CSS_SELECTOR, selector):
                return True
        except WebDriverException:
            continue

    # Twitch 2FA / verification inputs
    verification_selectors = [
        "input[name='authy_token']",
        "input[data-a-target='authy-input']",
        "input[autocomplete='one-time-code']",
    ]
    for selector in verification_selectors:
        try:
            elements = driver.find_elements(By.CSS_SELECTOR, selector)
            if elements and any(el.is_displayed() for el in elements):
                return True
        except WebDriverException:
            continue

    return False


def check_logged_in(driver: WebDriver, timeout: int = 15) -> bool:
    """
    Return True if an active Twitch session is detected.
    """
    try:
        _wait(driver, timeout).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )
    except TimeoutException:
        pass

    if requires_manual_verification(driver):
        return False

    logged_in_selectors = [
        "button[data-a-target='user-menu-toggle']",
        "[data-a-target='top-nav-avatar']",
        "img[data-a-target='user-avatar']",
    ]
    for selector in logged_in_selectors:
        try:
            elements = driver.find_elements(By.CSS_SELECTOR, selector)
            if elements and any(el.is_displayed() for el in elements):
                return True
        except WebDriverException:
            continue

    try:
        login_buttons = driver.find_elements(
            By.CSS_SELECTOR, "a[data-a-target='login-button'], button[data-a-target='login-button']"
        )
        if login_buttons and any(el.is_displayed() for el in login_buttons):
            return False
    except WebDriverException:
        pass

    # On /login with visible username field → not logged in
    try:
        username_fields = driver.find_elements(By.ID, "login-username")
        if username_fields and any(el.is_displayed() for el in username_fields):
            return False
    except WebDriverException:
        pass

    # Fallback: user menu in top nav
    if "twitch.tv" in (driver.current_url or ""):
        try:
            if driver.find_elements(By.CSS_SELECTOR, "[data-a-target='top-nav-live-indicator']"):
                return True
        except WebDriverException:
            pass

    return False


def verify_login(driver: WebDriver, timeout: int = 30) -> LoginResult:
    """
    Confirm authentication after submitting credentials.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if requires_manual_verification(driver):
            return "manual_verification_required"
        if check_logged_in(driver, timeout=3):
            return "success"
        time.sleep(0.5)

    if requires_manual_verification(driver):
        return "manual_verification_required"
    return "failed"


def _fill_login_form(driver: WebDriver, username: str, password: str, timeout: int) -> None:
    wait = _wait(driver, timeout)
    username_input = wait.until(EC.element_to_be_clickable((By.ID, "login-username")))
    password_input = wait.until(EC.element_to_be_clickable((By.ID, "password-input")))

    username_input.clear()
    username_input.send_keys(username)
    password_input.clear()
    password_input.send_keys(password)


def _submit_login(driver: WebDriver, timeout: int) -> None:
    wait = _wait(driver, timeout)
    selectors = [
        "button[data-a-target='passport-login-button']",
        "button[type='submit']",
    ]
    for selector in selectors:
        try:
            button = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, selector)))
            button.click()
            return
        except TimeoutException:
            continue
    password_input = driver.find_element(By.ID, "password-input")
    password_input.send_keys(Keys.RETURN)


def login_twitch(
    driver: WebDriver,
    username: str,
    password: str,
    login_url: str,
    element_timeout: int = 20,
    verify_timeout: int = 30,
) -> LoginResult:
    """
    Ensure Twitch session: reuse existing session or perform login.
    Password must never be logged by callers.
    """
    try:
        driver.get(login_url)
    except TimeoutException:
        logger.warning("Twitch login page load timed out; continuing checks")
    except WebDriverException as exc:
        logger.error("Failed to open Twitch login: %s", exc)
        return "failed"

    try:
        _wait(driver, element_timeout).until(
            lambda d: d.execute_script("return document.readyState") in ("interactive", "complete")
        )
    except TimeoutException:
        pass

    if requires_manual_verification(driver):
        return "manual_verification_required"

    if check_logged_in(driver, timeout=element_timeout):
        logger.info("Login already active")
        return "already_logged_in"

    if not username:
        return "failed"

    try:
        _fill_login_form(driver, username, password, element_timeout)
        _submit_login(driver, element_timeout)
    except TimeoutException:
        logger.error("Login form elements not found in time")
        return "failed"
    except WebDriverException as exc:
        logger.error("Login form interaction failed: %s", exc)
        return "failed"

    try:
        _wait(driver, element_timeout).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )
    except TimeoutException:
        pass

    return verify_login(driver, timeout=verify_timeout)
