#!/usr/bin/env python3
"""CLI: run one cycle from accounts.txt with farm-style logs."""

from __future__ import annotations

import argparse

from app.accounts import load_accounts_file
from app.accounts_store import load_accounts_ready_for_farm
from app.config import ACCOUNTS_FILE, AppConfig
from app.cycle_runner import run_cycle
from app.models import JobOptions


def main() -> int:
    parser = argparse.ArgumentParser(description="Standoff farm cycle runner")
    parser.add_argument("--limit", type=int, default=None, help="Макс. аккаунтов")
    parser.add_argument("--cycle", type=int, default=1, help="Номер цикла в логе")
    parser.add_argument("--repeat", action="store_true", help="Пометка repeat в итоге")
    parser.add_argument("--twitch", action="store_true", help="Привязать Twitch (по умолчанию выкл.)")
    parser.add_argument("--no-sell", action="store_true")
    parser.add_argument(
        "--farm-only",
        action="store_true",
        help="Только аккаунты с handshake (как run_farm.py)",
    )
    args = parser.parse_args()

    config = AppConfig.load()
    if args.farm_only or config.pipeline_mode == "api":
        accounts = load_accounts_ready_for_farm(ACCOUNTS_FILE)
        if not accounts:
            print(f"Нет аккаунтов с handshake в {ACCOUNTS_FILE}")
            print("Сначала: python run_prepare.py --limit 1")
            return 1
    else:
        accounts = load_accounts_file(ACCOUNTS_FILE)
    if not accounts:
        print(f"Нет аккаунтов в {ACCOUNTS_FILE}")
        return 1
    if args.limit:
        accounts = accounts[: args.limit]

    options = JobOptions(
        link_twitch=args.twitch,
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
