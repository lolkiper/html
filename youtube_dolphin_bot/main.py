#!/usr/bin/env python3
"""
YouTube Dolphin Bot — main entry point.

Usage:
    python main.py --accounts accounts.txt [--proxies proxies.txt] [options]

Run  python main.py --help  for full usage.
"""

import argparse
import csv
import logging
import sys
import time
from pathlib import Path

from colorama import Fore, Style, init as colorama_init

from config import DOLPHIN_API_BASE, DEFAULT_TAGS, PROFILE_OS, RESULTS_FILE, LOG_FILE
from dolphin_api import DolphinAPI, parse_proxy
from account_parser import Account, load_accounts, load_proxies, assign_proxies
from youtube_automation import (
    connect_to_dolphin_profile,
    login_to_youtube,
    set_youtube_language_english,
)

colorama_init(autoreset=True)


# ─────────────────────────────────────────────────────────────────────────────
# Logging setup
# ─────────────────────────────────────────────────────────────────────────────

def setup_logging(log_file: str, verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(log_file, encoding="utf-8"),
    ]
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )


logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Result reporting
# ─────────────────────────────────────────────────────────────────────────────

def _status_color(status: str) -> str:
    return {
        "success": Fore.GREEN,
        "failed":  Fore.RED,
        "pending": Fore.YELLOW,
    }.get(status, Fore.WHITE)


def print_summary(accounts: list[Account]) -> None:
    ok  = sum(1 for a in accounts if a.status == "success")
    bad = sum(1 for a in accounts if a.status == "failed")
    print()
    print("─" * 50)
    print(f"  Total   : {len(accounts)}")
    print(f"  {Fore.GREEN}Success : {ok}{Style.RESET_ALL}")
    print(f"  {Fore.RED}Failed  : {bad}{Style.RESET_ALL}")
    print("─" * 50)


def save_results(accounts: list[Account], filepath: str) -> None:
    with open(filepath, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["email", "status", "profile_id", "note"])
        for acc in accounts:
            writer.writerow([acc.email, acc.status, acc.profile_id, acc.note])
    logger.info(f"Results saved to {filepath}")


# ─────────────────────────────────────────────────────────────────────────────
# Core processing
# ─────────────────────────────────────────────────────────────────────────────

def process_account(
    account: Account,
    dolphin: DolphinAPI,
    keep_profile: bool = False,
    headless: bool = False,
) -> None:
    """
    Full pipeline for one account:
      1. Create Dolphin profile (with proxy)
      2. Start profile → get debugger port
      3. Connect Selenium
      4. Log in to YouTube
      5. Change language to English
      6. Stop profile  (optionally delete it)
    """
    profile_id = None
    driver = None

    try:
        # ── 1. Create profile ────────────────────────────────────────────── #
        proxy = parse_proxy(account.proxy_str) if account.proxy_str else None
        profile_name = f"yt_{account.email.split('@')[0]}_{int(time.time())}"

        logger.info(f"[{account.email}] Creating Dolphin profile '{profile_name}'")
        result = dolphin.create_profile(
            name=profile_name,
            proxy=proxy,
            tags=DEFAULT_TAGS,
            os=PROFILE_OS,
        )
        profile_id = result.get("browserProfileId") or result.get("id")
        account.profile_id = str(profile_id)
        logger.info(f"[{account.email}] Profile created: id={profile_id}")

        # ── 2. Start profile ─────────────────────────────────────────────── #
        logger.info(f"[{account.email}] Starting Dolphin profile {profile_id}")
        start_data = dolphin.start_profile(profile_id, headless=headless)

        port = (
            start_data.get("automation", {}).get("port")
            or start_data.get("port")
        )
        if not port:
            raise RuntimeError(f"No automation port returned: {start_data}")

        time.sleep(2)  # give the browser a moment to come up

        # ── 3. Connect Selenium ──────────────────────────────────────────── #
        logger.info(f"[{account.email}] Connecting to Chrome debugger on port {port}")
        driver = connect_to_dolphin_profile(port)

        # ── 4. Login ─────────────────────────────────────────────────────── #
        ok = login_to_youtube(
            driver,
            email=account.email,
            password=account.password,
            totp_secret=account.totp_secret,
        )
        if not ok:
            account.status = "failed"
            account.note = "Login failed"
            return

        # ── 5. Change language ───────────────────────────────────────────── #
        lang_ok = set_youtube_language_english(driver)
        if not lang_ok:
            account.status = "failed"
            account.note = "Login OK but language change failed"
            return

        account.status = "success"
        logger.info(f"{Fore.GREEN}[{account.email}] ✓ Done{Style.RESET_ALL}")

    except Exception as exc:
        account.status = "failed"
        account.note = str(exc)
        logger.error(f"[{account.email}] Error: {exc}")

    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass

        if profile_id is not None:
            try:
                dolphin.stop_profile(profile_id)
            except Exception:
                pass

            if not keep_profile:
                try:
                    dolphin.delete_profile(profile_id)
                    logger.debug(f"[{account.email}] Profile {profile_id} deleted")
                except Exception:
                    pass


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="youtube_dolphin_bot",
        description="Automate YouTube login & language setup via Dolphin Anty profiles.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py --accounts accounts.txt
  python main.py --accounts accounts.txt --proxies proxies.txt --keep-profiles
  python main.py --accounts accounts.txt --delay 10 --verbose
  python main.py --accounts accounts.txt --start 5 --end 10   # process only rows 5-10
        """,
    )
    p.add_argument("--accounts", required=True, help="Path to accounts file")
    p.add_argument("--proxies",  default="",   help="Path to proxies file (optional)")
    p.add_argument(
        "--dolphin-api",
        default=DOLPHIN_API_BASE,
        help=f"Dolphin Anty local API URL (default: {DOLPHIN_API_BASE})",
    )
    p.add_argument(
        "--dolphin-token",
        default="",
        help="Dolphin Anty API token (if required)",
    )
    p.add_argument(
        "--delay",
        type=float,
        default=5.0,
        help="Seconds to wait between accounts (default: 5)",
    )
    p.add_argument(
        "--keep-profiles",
        action="store_true",
        help="Do NOT delete Dolphin profiles after processing",
    )
    p.add_argument(
        "--headless",
        action="store_true",
        help="Run browser in headless mode",
    )
    p.add_argument(
        "--start",
        type=int,
        default=1,
        help="1-based index of first account to process (default: 1)",
    )
    p.add_argument(
        "--end",
        type=int,
        default=0,
        help="1-based index of last account to process (0 = all, default: 0)",
    )
    p.add_argument(
        "--results",
        default=RESULTS_FILE,
        help=f"CSV file to write results to (default: {RESULTS_FILE})",
    )
    p.add_argument(
        "--log",
        default=LOG_FILE,
        help=f"Log file path (default: {LOG_FILE})",
    )
    p.add_argument("--verbose", "-v", action="store_true", help="Enable debug logging")
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    setup_logging(args.log, args.verbose)

    # ── Verify Dolphin is running ────────────────────────────────────────── #
    dolphin = DolphinAPI(base_url=args.dolphin_api, api_token=args.dolphin_token)
    if not dolphin.check_connection():
        logger.error(
            f"Cannot reach Dolphin Anty API at {args.dolphin_api}\n"
            "Make sure Dolphin Anty is open and the local API is enabled:\n"
            "  Settings → Automation → Enable API"
        )
        return 1

    logger.info(f"Connected to Dolphin Anty API at {args.dolphin_api}")

    # ── Load accounts ────────────────────────────────────────────────────── #
    accounts = load_accounts(args.accounts)

    if args.proxies:
        proxies = load_proxies(args.proxies)
        assign_proxies(accounts, proxies)

    # Apply start/end slice (convert to 0-based)
    start_idx = max(0, args.start - 1)
    end_idx   = args.end if args.end > 0 else len(accounts)
    accounts  = accounts[start_idx:end_idx]

    if not accounts:
        logger.warning("No accounts to process after applying start/end filter")
        return 0

    logger.info(f"Processing {len(accounts)} account(s)")

    # ── Process accounts one by one ──────────────────────────────────────── #
    for i, account in enumerate(accounts, start=1):
        color = _status_color("pending")
        print(f"\n{color}[{i}/{len(accounts)}] {account.email}{Style.RESET_ALL}")

        process_account(
            account,
            dolphin,
            keep_profile=args.keep_profiles,
            headless=args.headless,
        )

        color = _status_color(account.status)
        print(f"  → {color}{account.status.upper()}{Style.RESET_ALL}  {account.note}")

        if i < len(accounts):
            time.sleep(args.delay)

    # ── Summary & results ────────────────────────────────────────────────── #
    print_summary(accounts)
    save_results(accounts, args.results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
