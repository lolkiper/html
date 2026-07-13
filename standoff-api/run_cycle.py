#!/usr/bin/env python3
"""CLI: run one cycle from accounts.txt with farm-style logs."""

from __future__ import annotations

import argparse

from app.accounts import load_accounts_file
from app.config import ACCOUNTS_FILE, AppConfig
from app.cycle_runner import run_cycle
from app.models import JobOptions


def main() -> int:
    parser = argparse.ArgumentParser(description="Standoff farm cycle runner")
    parser.add_argument("--limit", type=int, default=None, help="Макс. аккаунтов")
    parser.add_argument("--cycle", type=int, default=1, help="Номер цикла в логе")
    parser.add_argument("--repeat", action="store_true", help="Пометка repeat в итоге")
    parser.add_argument("--no-twitch", action="store_true")
    parser.add_argument("--no-sell", action="store_true")
    args = parser.parse_args()

    config = AppConfig.load()
    accounts = load_accounts_file(ACCOUNTS_FILE)
    if not accounts:
        print(f"Нет аккаунтов в {ACCOUNTS_FILE}")
        return 1
    if args.limit:
        accounts = accounts[: args.limit]

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
