#!/usr/bin/env python3
"""CLI: LDPlayer login → handshake → accounts.txt (фабрика токенов)."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.accounts_store import load_accounts_needing_prepare
from app.config import ACCOUNTS_FILE, ACCOUNTS_LOGIN_FILE, AppConfig
from app.prepare_runner import run_prepare


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare: эмулятор → handshake")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Входной файл без handshake (default: accounts_login.txt или accounts.txt)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ACCOUNTS_FILE,
        help="Куда писать аккаунты с handshake (default: accounts.txt)",
    )
    args = parser.parse_args()

    config = AppConfig.load()
    in_path = args.input
    if in_path is None:
        in_path = ACCOUNTS_LOGIN_FILE if ACCOUNTS_LOGIN_FILE.exists() else ACCOUNTS_FILE

    accounts = load_accounts_needing_prepare(in_path)
    if not accounts:
        print(f"Нет аккаунтов без handshake в {in_path}")
        print("Формат: google_login:google_pass")
        return 1

    if args.limit:
        accounts = accounts[: args.limit]

    print(f"Prepare: {len(accounts)} акк. | вход={in_path.name} | выход={args.output.name}")
    print("PIPELINE: эмулятор → вход → handshake → accounts.txt\n")

    stats = run_prepare(accounts, config, accounts_out=args.output)
    return 0 if stats.errors == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
