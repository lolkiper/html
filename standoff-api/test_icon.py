#!/usr/bin/env python3
"""Тест: только ADB + тап по иконке Standoff 2."""

from __future__ import annotations

from app.adb.ldplayer import LdConsole, find_dnconsole
from app.config import AppConfig
from app.steps.launch_standoff import step_launch_standoff_from_home


def main() -> int:
    config = AppConfig.load()
    print("=== Тест: тап по Standoff 2 ===\n")

    exe = find_dnconsole(config.ldplayer_home)
    print(f"dnconsole: {exe}")
    print(f"EMULATOR_INDEX: {config.emulator_index}\n")

    ld = LdConsole(exe, config.emulator_index, print)
    device = ld.connect_device(config.delay_min_sec, config.delay_max_sec)
    step_launch_standoff_from_home(device, config)
    print("\n[OK] Тап выполнен. Должна начать грузиться Standoff 2.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
