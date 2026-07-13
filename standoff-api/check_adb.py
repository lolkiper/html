#!/usr/bin/env python3
"""Проверка LDPlayer + ADB перед запуском фармы."""

from __future__ import annotations

from app.adb.ldplayer import LdConsole, connect_device, find_dnconsole, list_ldplayer_instances
from app.config import AppConfig


def main() -> int:
    config = AppConfig.load()
    print("=== Standoff API: проверка LDPlayer / ADB ===\n")
    print(f"LDPLAYER_HOME: {config.ldplayer_home}")
    print(f"EMULATOR_INDEX: {config.emulator_index}")
    print(f"RESET_DEVICE_ON_START: {config.reset_device_on_start}\n")

    try:
        exe = find_dnconsole(config.ldplayer_home)
        print(f"[OK] dnconsole: {exe}\n")
    except FileNotFoundError as exc:
        print(f"[FAIL] {exc}")
        return 1

    instances = list_ldplayer_instances(config.ldplayer_home)
    if instances:
        print("Эмуляторы (dnconsole list2) — EMULATOR_INDEX = номер слева:")
        for line in instances:
            print(f"  {line}")
        print()

    ld = LdConsole(exe, config.emulator_index, print)
    try:
        device = connect_device(ld, adb_port=config.adb_port)
        version = device.shell("getprop ro.build.version.release").strip()
        print(f"\n[OK] ADB работает. Android {version}")
        print("\nМожно запускать:")
        print("  python test_icon.py")
        print("  python run_cycle.py --limit 5")
        return 0
    except Exception as exc:
        print(f"\n[FAIL] {exc}\n")
        print("Подсказки:")
        print("- Для эмулятора «standoff bust» поставь EMULATOR_INDEX: 6")
        print("- Для «LDPlayer-10-13» поставь EMULATOR_INDEX: 13")
        print("- LDPlayer → Настройки → Другие → ADB → Открыть локальное подключение")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
