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

JumbleResult = Literal["found", "not_found", "error"]


def open_twitch_home(driver: WebDriver, home_url: str, timeout: int) -> None:
    try:
        driver.get(home_url)
        WebDriverWait(driver, timeout).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )
    except TimeoutException:
        logger.warning("Twitch home load timed out")
    except WebDriverException as exc:
        raise RuntimeError(f"Failed to open Twitch: {exc}") from exc


def search_and_open_jumble(
    driver: WebDriver,
    query: str,
    timeout: int,
) -> JumbleResult:
    try:
        search_selectors = [
            "input[data-a-target='tw-input-textfield-input']",
            "input[aria-label='Search Input']",
            "input[type='search']",
        ]
        search_input = None
        for selector in search_selectors:
            try:
                search_input = WebDriverWait(driver, timeout).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
                )
                break
            except TimeoutException:
                continue

        if search_input is None:
            driver.get(f"https://www.twitch.tv/search?term={query}")
        else:
            search_input.click()
            search_input.clear()
            search_input.send_keys(query)
            search_input.send_keys(Keys.RETURN)

        WebDriverWait(driver, timeout).until(
            lambda d: "search" in (d.current_url or "").lower() or query.lower() in _body_text(d)
        )

        result_selectors = [
            f"a[href*='/{query.lower()}']",
            "a[data-a-target='preview-card-image-link']",
            "a[data-a-target='search-result-card']",
        ]
        for selector in result_selectors:
            links = driver.find_elements(By.CSS_SELECTOR, selector)
            for link in links:
                if not link.is_displayed():
                    continue
                href = (link.get_attribute("href") or "").lower()
                text = (link.text or "").lower()
                if query.lower() in href or query.lower() in text:
                    link.click()
                    time.sleep(2)
                    return "found"

        # Fallback: open first visible search result card
        cards = driver.find_elements(By.CSS_SELECTOR, "a[data-a-target='preview-card-image-link']")
        for card in cards:
            if card.is_displayed():
                card.click()
                time.sleep(2)
                return "found"

        return "not_found"
    except TimeoutException:
        logger.error("Timed out while searching for %s", query)
        return "error"
    except WebDriverException as exc:
        logger.error("Search flow failed: %s", exc)
        return "error"


def _body_text(driver: WebDriver) -> str:
    try:
        return driver.find_element(By.TAG_NAME, "body").text or ""
    except WebDriverException:
        return ""


def watch_for_duration(seconds: int) -> None:
    if seconds <= 0:
        return
    logger.info("Watching stream for %s seconds", seconds)
    time.sleep(seconds)
