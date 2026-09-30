from __future__ import annotations

import logging
import sys
from pathlib import Path

from modules import auth, dolphin, twitch
from modules.logger import setup_logger
from modules.utils import (
    ensure_progress_entry,
    load_accounts,
    load_config,
    load_profiles,
    load_json,
    save_json,
)

ROOT = Path(__file__).resolve().parent


def _resolve(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else ROOT / p


def process_profile(
    profile_id: str,
    account: dict[str, str],
    config: dict,
    progress: dict,
    log: logging.Logger,
) -> None:
    entry = ensure_progress_entry(progress, profile_id)
    driver = None

    api_url = config["dolphin_api_url"]
    page_timeout = int(config.get("page_load_timeout_seconds", 60))
    element_timeout = int(config.get("element_wait_timeout_seconds", 20))
    verify_timeout = int(config.get("login_verify_timeout_seconds", 30))
    watch_seconds = int(config.get("watch_duration_seconds", 300))
    search_query = config.get("search_query", "Jumble")

    try:
        session = dolphin.start_profile(profile_id, api_url)
        driver = dolphin.connect_webdriver(session["port"], page_timeout)

        login_result = auth.login_twitch(
            driver,
            username=account["login"],
            password=account["password"],
            login_url=config.get("twitch_login_url", "https://www.twitch.tv/login"),
            element_timeout=element_timeout,
            verify_timeout=verify_timeout,
        )

        if login_result == "manual_verification_required":
            log.warning("Profile %s | Manual verification required", profile_id)
            entry["login"] = "manual_verification_required"
            entry["jumble"] = "not_started"
            entry["completed"] = False
            return

        if login_result in ("success", "already_logged_in"):
            log.info("Profile %s | Twitch login successful", profile_id)
            entry["login"] = "success"
        else:
            log.error("Profile %s | Twitch login failed", profile_id)
            entry["login"] = "failed"
            entry["jumble"] = "not_started"
            entry["completed"] = False
            return

        twitch.open_twitch_home(
            driver,
            config.get("twitch_home_url", "https://www.twitch.tv"),
            page_timeout,
        )

        jumble_result = twitch.search_and_open_jumble(driver, search_query, element_timeout)
        entry["jumble"] = jumble_result
        if jumble_result == "found":
            log.info("Profile %s | Jumble stream opened", profile_id)
            twitch.watch_for_duration(watch_seconds)
            entry["completed"] = True
        else:
            log.warning("Profile %s | Jumble not found (%s)", profile_id, jumble_result)
            entry["completed"] = False

    except dolphin.DolphinError as exc:
        log.error("Profile %s | Dolphin error: %s", profile_id, exc)
        entry["login"] = entry.get("login", "not_started")
        entry["completed"] = False
    except Exception as exc:
        log.error("Profile %s | Unexpected error: %s", profile_id, exc)
        entry["completed"] = False
    finally:
        dolphin.close_webdriver(driver)
        dolphin.stop_profile(profile_id, api_url)
        save_json(_resolve(config["progress_file"]), progress)


def main() -> int:
    config = load_config(_resolve("config.json"))
    log = setup_logger(config.get("log_dir", "logs"))

    profiles_path = _resolve(config.get("profiles_file", "profiles.txt"))
    accounts_path = _resolve(config.get("accounts_file", "accounts.txt"))
    progress_path = _resolve(config.get("progress_file", "progress.json"))

    try:
        accounts = load_accounts(accounts_path)
    except ValueError as exc:
        log.error("%s", exc)
        return 1

    profiles = load_profiles(profiles_path)
    if not profiles:
        log.error("No profile IDs found in %s", profiles_path)
        return 1

    progress = load_json(progress_path)

    for profile_id in profiles:
        log.info("Profile %s | Starting", profile_id)
        account = accounts.get(profile_id)
        if account is None:
            log.error("Profile %s | Account credentials not found", profile_id)
            entry = ensure_progress_entry(progress, profile_id)
            entry["login"] = "credentials_missing"
            entry["completed"] = False
            save_json(progress_path, progress)
            continue

        if not account.get("password"):
            log.error("Profile %s | Empty password", profile_id)
            entry = ensure_progress_entry(progress, profile_id)
            entry["login"] = "empty_password"
            entry["completed"] = False
            save_json(progress_path, progress)
            continue

        login_name = account.get("login", "")
        if login_name:
            log.info("Profile %s | Login: %s", profile_id, login_name)

        process_profile(profile_id, account, config, progress, log)

    log.info("All profiles processed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
