#!/usr/bin/env python3
"""Проверка LDPlayer + ADB перед запуском фармы."""

from __future__ import annotations

from app.adb.ldplayer import find_dnconsole, list_ldplayer_instances, LdConsole
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
        print("\nУкажи в config.json путь к папке где лежит dnconsole.exe")
        print("Пример LDPlayer 9:  C:\\LDPlayer\\LDPlayer9")
        print("Пример LDPlayer:    C:\\LDPlayer\\LDPlayer")
        return 1

    instances = list_ldplayer_instances(config.ldplayer_home)
    if instances:
        print("Эмуляторы (dnconsole list):")
        for line in instances[:15]:
            print(f"  {line}")
        print()

    ld = LdConsole(exe, config.emulator_index, print)
    try:
        out = ld.verify_adb()
        print(f"\n[OK] ADB отвечает: {out!r}")
        print("\nМожно запускать: python run_cycle.py --limit 5")
        return 0
    except Exception as exc:
        print(f"\n[FAIL] {exc}\n")
        print("Что сделать:")
        print("1. Запусти LDPlayer вручную (окно эмулятора открыто)")
        print("2. LDPlayer → Настройки → Другие → ADB отладка → Открыть локальное подключение")
        print("3. Если несколько эмуляторов — смени EMULATOR_INDEX в config.json (0, 1, 2...)")
        print("4. Запусти снова: python check_adb.py")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
