#!/usr/bin/env python3
"""CLI: API farm — продажа кейсов по готовым handshake (без эмулятора)."""

from __future__ import annotations

import argparse

from app.accounts_store import load_accounts_ready_for_farm
from app.config import ACCOUNTS_FILE, AppConfig
from app.cycle_runner import run_cycle
from app.models import JobOptions


def main() -> int:
    parser = argparse.ArgumentParser(description="Farm: API слив по handshake")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--cycle", type=int, default=1)
    parser.add_argument("--repeat", action="store_true")
    parser.add_argument("--no-twitch", action="store_true")
    parser.add_argument("--no-sell", action="store_true")
    args = parser.parse_args()

    config = AppConfig.load()
    if config.pipeline_mode != "api":
        print('В config.json установи "PIPELINE_MODE": "api"')
        return 1

    accounts = load_accounts_ready_for_farm(ACCOUNTS_FILE)
    if not accounts:
        print(f"Нет аккаунтов с handshake в {ACCOUNTS_FILE}")
        print("Сначала: python run_prepare.py --limit 1")
        return 1

    if args.limit:
        accounts = accounts[: args.limit]

    print(f"Farm API: {len(accounts)} акк. с handshake\n")

    options = JobOptions(
        link_twitch=not args.no_twitch,
        sell_cases=not args.no_sell,
    )
    stats = run_cycle(
        accounts,
        config,
        cycle_no=args.cycle,
        options=options,
        repeat=args.repeat,
    )
    return 0 if stats.errors == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
