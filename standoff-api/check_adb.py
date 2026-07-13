#!/usr/bin/env python3
"""Проверка LDPlayer + ADB. Сканирует все эмуляторы."""

from __future__ import annotations

import argparse

from app.adb.ldplayer import (
    LdConsole,
    connect_device,
    find_dnconsole,
    parse_list2,
    scan_working_emulator,
)
from app.config import AppConfig


def main() -> int:
    parser = argparse.ArgumentParser(description="Проверка ADB LDPlayer")
    parser.add_argument(
        "--scan",
        action="store_true",
        help="Сканировать все эмуляторы и найти рабочий",
    )
    args = parser.parse_args()

    config = AppConfig.load()
    print("=== Standoff API: проверка LDPlayer / ADB ===\n")
    print(f"LDPLAYER_HOME: {config.ldplayer_home}")
    print(f"EMULATOR_INDEX: {config.emulator_index}")
    print(f"AUTO_FIND_EMULATOR: {config.auto_find_emulator}\n")

    try:
        exe = find_dnconsole(config.ldplayer_home)
        print(f"[OK] dnconsole: {exe}\n")
    except FileNotFoundError as exc:
        print(f"[FAIL] {exc}")
        return 1

    instances = parse_list2(config.ldplayer_home)
    if instances:
        print("Эмуляторы (list2) — колонка «running=1» значит запущен:")
        for inst in instances:
            run = "RUN" if inst.running else "off"
            res = f" {inst.resolution}" if inst.resolution else ""
            print(f"  [{run}] index={inst.index}  {inst.name}{res}")
        print()

    if args.scan:
        print("Сканирование ADB...\n")
        device, found = scan_working_emulator(
            config.ldplayer_home,
            prefer_index=config.emulator_index,
            log_fn=print,
        )
        if device and found is not None:
            version = device.shell("getprop ro.build.version.release").strip()
            print(f"\n[OK] Рабочий эмулятор: EMULATOR_INDEX={found}, Android {version}")
            print(f"\nЗапиши в config.json:  \"EMULATOR_INDEX\": {found}")
            print("\nДальше:")
            print("  python test_icon.py")
            print("  python run_cycle.py --limit 5")
            return 0

    print("Проверка одного индекса...\n")
    ld = LdConsole(exe, config.emulator_index, print)
    try:
        device = connect_device(ld, adb_port=config.adb_port, retries=3)
        version = device.shell("getprop ro.build.version.release").strip()
        print(f"\n[OK] ADB работает. Android {version}")
        return 0
    except Exception as exc:
        print(f"\n[FAIL] {exc}\n")
        print("Что сделать:")
        print("1. В LDPlayer ЗАПУСТИ эмулятор «standoff bust» (index 6)")
        print("2. Внутри эмулятора: Настройки → Другие → ADB → Открыть локальное подключение")
        print("3. В config.json: \"EMULATOR_INDEX\": 6")
        print("4. python check_adb.py --scan")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
