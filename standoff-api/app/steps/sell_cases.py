"""Sell cases/crates on Standoff 2 marketplace."""

from __future__ import annotations

import time

from app.adb.device import AdbDevice

# Лобби → инвентарь → рынок (1280x720)
COORD_INVENTORY = (1180, 650)
COORD_MARKET_TAB = (640, 680)
COORD_MY_ITEMS = (200, 120)
COORD_SELL_BTN = (1050, 650)
COORD_MIN_PRICE = (640, 480)
COORD_CONFIRM_SELL = (640, 580)

CASE_KEYWORDS = ("case", "кейс", "crate", "ящик", "box", "jumble", "major")


def step_sell_cases(
    device: AdbDevice,
    *,
    min_price: bool = True,
    max_items: int = 50,
) -> tuple[int, float]:
    """Возвращает (продано штук, условное gold)."""
    sold = 0
    gold = 0.0

    device.tap_coord(COORD_INVENTORY)
    time.sleep(2)

    if not device.click_any(["Inventory", "Инвентарь", "Склад"], timeout=15):
        device.tap_coord(COORD_INVENTORY)
        time.sleep(2)

    device.tap_coord(COORD_MARKET_TAB)
    time.sleep(1.5)
    device.click_any(["Market", "Рынок", "Marketplace", "Маркет"], timeout=12)
    device.tap_coord(COORD_MY_ITEMS)
    time.sleep(2)
    device.click_any(["My items", "Мои предметы", "Продать", "Sell"], timeout=12)

    for attempt in range(max_items):
        case_nodes = device.find_nodes_with_text(*CASE_KEYWORDS)
        if not case_nodes:
            device.log("Кейсы для продажи не найдены в инвентаре")
            break

        node = case_nodes[0]
        center = device.node_center(node)
        if not center:
            break

        device.tap(center[0], center[1])
        device.rnd_delay()

        if not device.click_any(["Sell", "Продать", "Выставить"], timeout=12):
            device.tap_coord(COORD_SELL_BTN)

        time.sleep(1.5)

        if min_price:
            device.click_any(
                ["Minimum", "Минимальная", "Min price", "Мин. цена"],
                timeout=8,
            )
            device.tap_coord(COORD_MIN_PRICE)

        if not device.click_any(
            ["Confirm", "Подтвердить", "Sell", "Продать", "OK", "ОК"],
            timeout=12,
        ):
            device.tap_coord(COORD_CONFIRM_SELL)

        sold += 1
        gold += 1.0
        device.log(f"Кейс продан ({sold})")
        device.rnd_delay()
        time.sleep(1.0)

        if attempt % 5 == 4:
            device.shell("input keyevent 4")
            time.sleep(0.8)
            device.tap_coord(COORD_MY_ITEMS)
            time.sleep(1.2)

    device.log(f"Продано кейсов: {sold}")
    return sold, gold
