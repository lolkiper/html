# -*- coding: utf-8 -*-
"""JSON storage for Telegram bot channel lists."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from channel_parser import ChannelStats, load_results

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
CHANNELS_FILE = DATA_DIR / "telegram-channels.json"
RESULTS_FILE = DATA_DIR / "telegram-results.json"


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_channels_db() -> dict[str, Any]:
    _ensure_data_dir()
    if not CHANNELS_FILE.exists():
        return {"chats": {}}
    try:
        return json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"chats": {}}


def _save_channels_db(data: dict[str, Any]) -> None:
    _ensure_data_dir()
    CHANNELS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_channel_links(chat_id: int) -> list[str]:
    data = _load_channels_db()
    chat = data["chats"].get(str(chat_id), {})
    return list(chat.get("links", []))


def add_channel_link(chat_id: int, link: str) -> tuple[bool, str]:
    value = link.strip()
    if not value:
        return False, "\u041f\u0443\u0441\u0442\u0430\u044f \u0441\u0441\u044b\u043b\u043a\u0430"

    data = _load_channels_db()
    key = str(chat_id)
    chat = data["chats"].setdefault(key, {"links": [], "updated_at": None})
    links: list[str] = chat.setdefault("links", [])

    if value in links:
        return False, "\u041a\u0430\u043d\u0430\u043b \u0443\u0436\u0435 \u0432 \u0441\u043f\u0438\u0441\u043a\u0435"

    links.append(value)
    chat["updated_at"] = datetime.now(timezone.utc).isoformat()
    data["chats"][key] = chat
    _save_channels_db(data)
    return True, f"\u0414\u043e\u0431\u0430\u0432\u043b\u0435\u043d (#{len(links)})"


def remove_channel_link(chat_id: int, index: int) -> tuple[bool, str]:
    data = _load_channels_db()
    key = str(chat_id)
    chat = data["chats"].get(key)
    if not chat:
        return False, "\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442"

    links: list[str] = chat.get("links", [])
    if index < 1 or index > len(links):
        return False, f"\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 \u043d\u043e\u043c\u0435\u0440. \u0418\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439 1..{len(links)}"

    removed = links.pop(index - 1)
    chat["updated_at"] = datetime.now(timezone.utc).isoformat()
    data["chats"][key] = chat
    _save_channels_db(data)

    # Drop cached stats for this chat; user can run /check again
    results = load_results(RESULTS_FILE)
    results["channels"] = [
        item for item in (results.get("channels") or [])
        if item.get("chat_id") != chat_id
    ]
    RESULTS_FILE.write_text(
        json.dumps(results, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return True, f"\u0423\u0434\u0430\u043b\u0451\u043d: {removed[:80]}"


def get_results_for_chat(chat_id: int) -> list[ChannelStats]:
    data = load_results(RESULTS_FILE)
    channels = []
    for item in data.get("channels") or []:
        if item.get("chat_id") != chat_id:
            continue
        try:
            channels.append(ChannelStats(**item))
        except TypeError:
            continue
    channels.sort(key=lambda c: c.channel_number)
    return channels


def save_chat_results(chat_id: int, stats_list: list[ChannelStats]) -> None:
    data = load_results(RESULTS_FILE)
    others = [
        item for item in (data.get("channels") or [])
        if item.get("chat_id") != chat_id
    ]
    merged = others + [dict(**s.to_dict(), chat_id=chat_id) for s in stats_list]
    payload_path = RESULTS_FILE
    payload = {
        "channels": merged,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    payload_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
