#!/usr/bin/env python3
"""
Standoff 2 emulator automation — multi-account loop via ADB.

Usage:
    python main.py
    python main.py --serial 127.0.0.1:62001 --accounts accounts.txt
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from adb_client import AdbClient, AdbError
from config import ACCOUNTS_FILE, DEFAULT_CONFIG, AppConfig
from game_flow import Account, AccountBlockedError, GameFlow
from logger_setup import setup_logger
from vision import Vision

log = setup_logger("main")


def parse_accounts(path: Path) -> list[Account]:
    if not path.exists():
        raise FileNotFoundError(f"Accounts file not found: {path}")

    accounts: list[Account] = []
    for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            log.warning("Line %d: invalid format (expected email:password), skip", line_no)
            continue
        email, password = line.split(":", 1)
        email, password = email.strip(), password.strip()
        if not email or not password:
            log.warning("Line %d: empty email or password, skip", line_no)
            continue
        accounts.append(Account(email=email, password=password))

    return accounts


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Standoff 2 ADB automation bot")
    p.add_argument(
        "--serial",
        default=DEFAULT_CONFIG.adb_serial,
        help="ADB device serial (e.g. 127.0.0.1:5555 for LDPlayer)",
    )
    p.add_argument(
        "--accounts",
        type=Path,
        default=ACCOUNTS_FILE,
        help="Path to accounts.txt (email:password per line)",
    )
    p.add_argument(
        "--max-items",
        type=int,
        default=DEFAULT_CONFIG.max_inventory_items,
        help="Max inventory slots to process per account",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Only parse accounts and test ADB connection",
    )
    return p


def main() -> int:
    args = build_parser().parse_args()

    config = AppConfig(
        adb_serial=args.serial,
        max_inventory_items=args.max_items,
    )

    try:
        accounts = parse_accounts(args.accounts)
    except FileNotFoundError as exc:
        log.error("%s", exc)
        return 1

    if not accounts:
        log.error("No valid accounts in %s", args.accounts)
        return 1

    log.info("Loaded %d account(s) from %s", len(accounts), args.accounts)

    adb = AdbClient(config.adb_serial)
    try:
        adb.connect()
    except AdbError as exc:
        log.error("ADB connection failed: %s", exc)
        return 1

    size = adb.get_screen_size()
    if size:
        log.info("Emulator resolution: %dx%d", size[0], size[1])
        if size != (1280, 720):
            log.warning(
                "Recommended resolution is 1280x720 for template coords. "
                "Recapture templates or update config.py taps."
            )

    if args.dry_run:
        log.info("Dry run OK — ADB reachable, %d accounts ready", len(accounts))
        return 0

    vision = Vision(adb, config)
    flow = GameFlow(adb, vision, config)

    success = 0
    failed = 0

    for i, account in enumerate(accounts, 1):
        log.info("[%d/%d] Starting %s", i, len(accounts), account.email)
        try:
            flow.process_account(account)
            success += 1
        except AccountBlockedError as exc:
            failed += 1
            log.error("SKIP (blocked): %s — %s", account.email, exc)
        except (AdbError, RuntimeError, Exception) as exc:
            failed += 1
            log.exception("SKIP (error): %s — %s", account.email, exc)
            try:
                flow.reset_session()
            except Exception:
                pass

        if i < len(accounts):
            time.sleep(config.delays.between_accounts)

    log.info("=" * 50)
    log.info("Done. Success: %d | Failed/skipped: %d | Total: %d", success, failed, len(accounts))
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
