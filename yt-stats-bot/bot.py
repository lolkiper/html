# -*- coding: utf-8 -*-
# YT Stats Telegram Bot - one file for ApexNodes / Pterodactyl
# 1) Insert BOT_TOKEN below
# 2) Upload this file to /home/container/
# 3) Startup command: python bot.py
# 4) Start server

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ===================== SETTINGS =====================
BOT_TOKEN = ""  # token from @BotFather
ALLOWED_USER_IDS: list[int] = []  # empty = everyone, or [123456789]
# ====================================================

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
CHANNELS_FILE = DATA_DIR / "telegram-channels.json"
RESULTS_FILE = DATA_DIR / "telegram-results.json"
DASH = "\u2014"


def _ensure_deps() -> None:
    marker = APP_DIR / ".deps_ok"
    if marker.exists():
        return
    pkgs = ["python-telegram-bot>=21.0", "requests>=2.31.0", "yt-dlp>=2024.1.0"]
    print("Installing dependencies...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *pkgs])
    marker.write_text("ok", encoding="utf-8")


_ensure_deps()

import requests
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

logging.basicConfig(format="%(asctime)s %(levelname)s: %(message)s", level=logging.INFO)
log = logging.getLogger("yt-stats-bot")

BAN_PATTERNS = [
    re.compile(r"channel (?:has been )?terminated", re.I),
    re.compile(r"account has been terminated", re.I),
    re.compile(r"this channel does not exist", re.I),
    re.compile(r"channel is unavailable", re.I),
    re.compile(r"channel isn't available", re.I),
    re.compile(r"this account has been suspended", re.I),
    re.compile(r"\u043d\u0430\u0440\u0443\u0448\u0435\u043d\u0438\u0435 \u043f\u0440\u0430\u0432\u0438\u043b", re.I),
    re.compile(r"\u043a\u0430\u043d\u0430\u043b (?:\u0431\u044b\u043b )?\u0443\u0434\u0430\u043b", re.I),
    re.compile(r"\u043a\u0430\u043d\u0430\u043b \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d", re.I),
    re.compile(r"\u044d\u0442\u043e\u0442 \u043a\u0430\u043d\u0430\u043b \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d", re.I),
    re.compile(r"\u0430\u043a\u043a\u0430\u0443\u043d\u0442 (?:\u0431\u044b\u043b )?\u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d", re.I),
    re.compile(r"account (?:has been )?disabled", re.I),
    re.compile(r"community guidelines", re.I),
]

BAN_URL_HINTS = ("disabled", "banned", "suspended", "terminated", "notavailable", "oops")

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
}


@dataclass
class ChannelStats:
    channel_number: int
    raw: str
    channel_id: str | None = None
    channel_name: str = DASH
    channel_url: str | None = None
    subscribers: str = DASH
    total_views: str = DASH
    last_video_title: str = DASH
    last_video_views: str = DASH
    last_video_date: str = DASH
    last_video_url: str | None = None
    status: str = "PENDING"
    is_blocked: bool = False
    block_reason: str | None = None
    error: str | None = None
    updated_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def detect_ban_from_text(text: str) -> bool:
    return any(pattern.search(text or "") for pattern in BAN_PATTERNS)


def detect_ban_from_url(url: str) -> bool:
    value = (url or "").lower()
    return any(hint in value for hint in BAN_URL_HINTS)


def format_count(value: Any) -> str:
    if value is None:
        return DASH
    if isinstance(value, (int, float)):
        return f"{int(value):,}".replace(",", " ")
    text = str(value).strip()
    return text or DASH


def extract_channel_id(raw: str) -> str | None:
    value = (raw or "").strip()
    if not value or value.startswith("#"):
        return None

    pipe_match = re.match(r"^\d+\|(.+)$", value)
    if pipe_match:
        value = pipe_match.group(1).strip()

    id_match = re.match(r"^(UC[\w-]{20,})$", value, re.I)
    if id_match:
        return id_match.group(1)

    url_match = re.search(r"youtube\.com/channel/(UC[\w-]{20,})", value, re.I)
    if url_match:
        return url_match.group(1)

    return None


def normalize_channel_input(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return value

    pipe_match = re.match(r"^\d+\|(.+)$", value)
    if pipe_match:
        value = pipe_match.group(1).strip()

    channel_id = extract_channel_id(value)
    if channel_id:
        return f"https://www.youtube.com/channel/{channel_id}"

    if value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith("@"):
        return f"https://www.youtube.com/{value}"
    if re.match(r"^UC[\w-]{20,}$", value, re.I):
        return f"https://www.youtube.com/channel/{value}"

    return f"https://www.youtube.com/{value.lstrip('/')}"


def parse_channels_file(path: Path) -> list[tuple[int, str]]:
    if not path.exists():
        return []

    channels: list[tuple[int, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        channels.append((len(channels) + 1, value))
    return channels


def save_channels_file(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def load_results(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"channels": [], "updated_at": None}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"channels": [], "updated_at": None}


def save_results(path: Path, channels: list[ChannelStats]) -> None:
    payload = {
        "channels": [item.to_dict() for item in channels],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _http_get(url: str) -> requests.Response:
    return requests.get(url, timeout=25, headers=HTTP_HEADERS)


def _extract_json_blob(html: str, marker: str) -> dict[str, Any] | None:
    idx = html.find(marker)
    if idx == -1:
        return None
    start = html.find("{", idx)
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for pos in range(start, len(html)):
        ch = html[pos]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start : pos + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _walk_strings(node: Any, out: list[str]) -> None:
    if isinstance(node, dict):
        for value in node.values():
            _walk_strings(value, out)
    elif isinstance(node, list):
        for value in node:
            _walk_strings(value, out)
    elif isinstance(node, str):
        out.append(node)


def _find_first_text(node: Any, predicate) -> str | None:
    if isinstance(node, dict):
        for value in node.values():
            found = _find_first_text(value, predicate)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_first_text(value, predicate)
            if found:
                return found
    elif isinstance(node, str) and predicate(node):
        return node
    return None


def _find_video_id(node: Any) -> str | None:
    if isinstance(node, dict):
        if node.get("videoId"):
            return str(node["videoId"])
        for value in node.values():
            found = _find_video_id(value)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_video_id(value)
            if found:
                return found
    return None


def _parse_channel_from_html(html: str, page_url: str) -> dict[str, Any]:
    data = _extract_json_blob(html, "var ytInitialData = ") or _extract_json_blob(html, "ytInitialData = ")
    result: dict[str, Any] = {
        "channel_id": extract_channel_id(page_url),
        "channel_name": DASH,
        "subscribers": DASH,
        "total_views": DASH,
        "last_video_title": DASH,
        "last_video_views": DASH,
        "last_video_date": DASH,
        "last_video_url": None,
    }

    if not data:
        return result

    og_title = re.search(r'<meta property="og:title" content="([^"]+)"', html)
    if og_title:
        result["channel_name"] = og_title.group(1).replace(" - YouTube", "").strip()

    texts: list[str] = []
    _walk_strings(data, texts)

    for text in texts:
        if result["channel_name"] == DASH and 2 <= len(text) <= 80 and "http" not in text:
            if text.endswith(" - YouTube"):
                result["channel_name"] = text.replace(" - YouTube", "").strip()
                break

    sub = _find_first_text(
        data,
        lambda s: bool(
            re.search(r"(sub|subscriber|\u043f\u043e\u0434\u043f\u0438\u0441|\u0430\u0431\u043e\u043d\u0435\u043d\u0442)", s, re.I)
        )
        and bool(re.search(r"\d", s)),
    )
    if sub:
        result["subscribers"] = sub.strip()

    views = _find_first_text(
        data,
        lambda s: bool(re.search(r"(view|\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440)", s, re.I)) and bool(re.search(r"\d", s)),
    )
    if views and "sub" not in views.lower() and "\u043f\u043e\u0434\u043f\u0438\u0441" not in views.lower():
        result["last_video_views"] = views.strip()

    date_text = _find_first_text(
        data,
        lambda s: bool(
            re.search(
                r"(ago|\u043d\u0430\u0437\u0430\u0434|minute|hour|day|week|month|year|\u043c\u0438\u043d|\u0447\u0430\u0441|\u0434\u043d|\u043d\u0435\u0434|\u043c\u0435\u0441|\u043b\u0435\u0442|\u0433\u043e\u0434)",
                s,
                re.I,
            )
        ),
    )
    if date_text:
        result["last_video_date"] = date_text.strip()

    title = _find_first_text(
        data,
        lambda s: 5 <= len(s) <= 120 and "http" not in s and not re.search(r"(sub|view|\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440|\u043f\u043e\u0434\u043f\u0438\u0441)", s, re.I),
    )
    if title and title != result["channel_name"]:
        result["last_video_title"] = title.strip()

    video_id = _find_video_id(data)
    if video_id:
        result["last_video_url"] = f"https://www.youtube.com/watch?v={video_id}"

    meta_url = _find_first_text(data, lambda s: "/channel/UC" in s)
    if meta_url:
        cid = extract_channel_id(meta_url)
        if cid:
            result["channel_id"] = cid

    return result


def _fetch_from_html(channel_url: str) -> dict[str, Any]:
    videos_url = channel_url.rstrip("/")
    if not videos_url.endswith("/videos"):
        videos_url = f"{videos_url}/videos"

    response = _http_get(videos_url)
    final_url = str(response.url)
    if detect_ban_from_url(final_url):
        raise RuntimeError("URL blocked")

    html = response.text or ""
    if detect_ban_from_text(html):
        raise RuntimeError("Channel page blocked")

    parsed = _parse_channel_from_html(html, final_url)
    channel_id = parsed.get("channel_id") or extract_channel_id(channel_url)

    if channel_id:
        about_response = _http_get(f"https://www.youtube.com/channel/{channel_id}/about")
        about_html = about_response.text or ""
        match = re.search(
            r"([\d.,\s]+[KkMmBb\u041c\u043c]?)\s*(?:total\s+)?views|([\d.,\s]+[KkMmBb\u041c\u043c]?)\s*\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440",
            about_html,
            re.I,
        )
        if match:
            parsed["total_views"] = (match.group(1) or match.group(2) or "").strip()
        elif detect_ban_from_text(about_html):
            raise RuntimeError("About page blocked")

    return parsed


def _fetch_with_ytdlp(channel_url: str) -> dict[str, Any]:
    if yt_dlp is None:
        raise RuntimeError("yt-dlp not installed")

    videos_url = channel_url.rstrip("/")
    if not videos_url.endswith("/videos"):
        videos_url = f"{videos_url}/videos"

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
        "playlistend": 1,
    }
    cookies_browser = __import__("os").environ.get("YTDLP_COOKIES_BROWSER", "").strip()
    if cookies_browser:
        ydl_opts["cookiesfrombrowser"] = (cookies_browser,)

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(videos_url, download=False)

    if not info:
        raise RuntimeError("Empty response from YouTube")
    return info


def _pick_latest_video(info: dict[str, Any]) -> dict[str, Any] | None:
    entries = info.get("entries") or []
    if entries and entries[0]:
        return entries[0]
    if info.get("id") and info.get("title"):
        return info
    return None


def _apply_ytdlp_info(stats: ChannelStats, info: dict[str, Any], channel_url: str) -> None:
    stats.channel_id = info.get("channel_id") or info.get("uploader_id") or extract_channel_id(channel_url)
    stats.channel_name = info.get("channel") or info.get("uploader") or DASH
    stats.subscribers = format_count(info.get("channel_follower_count"))

    if info.get("view_count") is not None:
        stats.total_views = format_count(info.get("view_count"))

    latest = _pick_latest_video(info)
    if latest:
        stats.last_video_title = latest.get("title") or DASH
        stats.last_video_views = format_count(latest.get("view_count"))
        stats.last_video_date = latest.get("upload_date") or latest.get("release_date") or DASH
        if stats.last_video_date and re.fullmatch(r"\d{8}", str(stats.last_video_date)):
            raw_date = str(stats.last_video_date)
            stats.last_video_date = f"{raw_date[6:8]}.{raw_date[4:6]}.{raw_date[0:4]}"

        video_id = latest.get("id")
        video_url = latest.get("webpage_url")
        if video_url:
            stats.last_video_url = video_url
        elif video_id:
            stats.last_video_url = f"https://www.youtube.com/watch?v={video_id}"


def _apply_html_info(stats: ChannelStats, parsed: dict[str, Any]) -> None:
    stats.channel_id = parsed.get("channel_id") or stats.channel_id
    stats.channel_name = parsed.get("channel_name") or DASH
    stats.subscribers = parsed.get("subscribers") or DASH
    stats.total_views = parsed.get("total_views") or DASH
    stats.last_video_title = parsed.get("last_video_title") or DASH
    stats.last_video_views = parsed.get("last_video_views") or DASH
    stats.last_video_date = parsed.get("last_video_date") or DASH
    stats.last_video_url = parsed.get("last_video_url")


def fetch_channel_stats(channel_number: int, raw: str) -> ChannelStats:
    stats = ChannelStats(channel_number=channel_number, raw=raw)
    channel_url = normalize_channel_input(raw)
    stats.channel_url = channel_url

    try:
        try:
            info = _fetch_with_ytdlp(channel_url)
            _apply_ytdlp_info(stats, info, channel_url)
        except Exception:
            parsed = _fetch_from_html(channel_url)
            _apply_html_info(stats, parsed)
    except Exception as err:  # noqa: BLE001
        message = str(err)
        if detect_ban_from_text(message) or "blocked" in message.lower():
            stats.is_blocked = True
            stats.block_reason = message[:240]
            stats.status = "BLOCKED"
        else:
            stats.status = "ERROR"
            stats.error = message[:240]
        stats.updated_at = datetime.now(timezone.utc).isoformat()
        return stats

    if stats.total_views == DASH and stats.channel_id:
        try:
            about = _fetch_from_html(f"https://www.youtube.com/channel/{stats.channel_id}")
            if about.get("total_views") and about["total_views"] != DASH:
                stats.total_views = about["total_views"]
        except Exception:
            pass

    if stats.subscribers == DASH and stats.total_views == DASH and stats.last_video_title == DASH:
        stats.is_blocked = True
        stats.block_reason = "Could not load channel data"
        stats.status = "BLOCKED"
    else:
        stats.status = "OK"

    if stats.channel_id:
        stats.channel_url = f"https://www.youtube.com/channel/{stats.channel_id}"

    stats.updated_at = datetime.now(timezone.utc).isoformat()
    return stats


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


HELP_TEXT = (
    "<b>YT Stats Bot</b>\n\n"
    "\u0411\u043e\u0442 \u0434\u043b\u044f \u043c\u043e\u043d\u0438\u0442\u043e\u0440\u0438\u043d\u0433\u0430 YouTube-\u043a\u0430\u043d\u0430\u043b\u043e\u0432 \u043d\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435.\n\n"
    "<b>\u041a\u043e\u043c\u0430\u043d\u0434\u044b:</b>\n"
    "/add &lt;\u0441\u0441\u044b\u043b\u043a\u0430&gt; \u2014 \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043a\u0430\u043d\u0430\u043b\n"
    "/list \u2014 \u0441\u043f\u0438\u0441\u043e\u043a (\u043a\u043d\u043e\u043f\u043a\u0438 \u25c0\ufe0f \u25b6\ufe0f)\n"
    "/check \u2014 \u043e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0432\u0441\u0435\n"
    "/check 3 \u2014 \u043e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u043a\u0430\u043d\u0430\u043b #3\n"
    "/remove 3 \u2014 \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u043a\u0430\u043d\u0430\u043b #3\n"
    "/help \u2014 \u0441\u043f\u0440\u0430\u0432\u043a\u0430\n\n"
    "\u041c\u043e\u0436\u043d\u043e \u043f\u0440\u043e\u0441\u0442\u043e \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443 \u0432 \u0447\u0430\u0442."
)


def _is_allowed(user_id: int | None) -> bool:
    if user_id is None:
        return False
    env_raw = os.environ.get("ALLOWED_USER_IDS", "").strip()
    allowed: set[int] = set(ALLOWED_USER_IDS)
    if env_raw:
        for part in env_raw.split(","):
            part = part.strip()
            if part.isdigit():
                allowed.add(int(part))
    if not allowed:
        return True
    return user_id in allowed


async def _deny(update: Update) -> None:
    if update.message:
        await update.message.reply_text("Access denied.")
    elif update.callback_query:
        await update.callback_query.answer("Access denied", show_alert=True)


def _status_emoji(stats: ChannelStats) -> str:
    if stats.is_blocked:
        return "\U0001f6ab"
    if stats.status == "OK":
        return "\u2705"
    if stats.status == "ERROR":
        return "\u274c"
    return "\u23f3"


def _format_channel_card(stats: ChannelStats, total: int) -> str:
    status = "\u0417\u0410\u0411\u0410\u041d\u0415\u041d" if stats.is_blocked else stats.status
    lines = [
        f"<b>\U0001f4fa \u041a\u0430\u043d\u0430\u043b #{stats.channel_number}/{total}</b>",
        f"<b>{stats.channel_name}</b>",
        "",
        f"\U0001f465 \u041f\u043e\u0434\u043f\u0438\u0441\u0447\u0438\u043a\u0438: <b>{stats.subscribers}</b>",
        f"\U0001f441 \u041f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u044b \u043a\u0430\u043d\u0430\u043b\u0430: <b>{stats.total_views}</b>",
        f"{_status_emoji(stats)} \u0421\u0442\u0430\u0442\u0443\u0441: <b>{status}</b>",
    ]
    if stats.block_reason:
        lines.append(f"\u26a0\ufe0f {stats.block_reason}")
    if stats.error:
        lines.append(f"\u26a0\ufe0f {stats.error}")

    lines.extend(
        [
            "",
            f"\U0001f3ac <b>\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u0432\u0438\u0434\u0435\u043e:</b> {stats.last_video_title}",
            f"\U0001f441 \u041f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u044b: {stats.last_video_views}",
            f"\U0001f4c5 \u0414\u0430\u0442\u0430: {stats.last_video_date}",
        ]
    )
    if stats.last_video_url:
        lines.append(f'\U0001f517 <a href="{stats.last_video_url}">\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0432\u0438\u0434\u0435\u043e</a>')
    if stats.channel_url:
        lines.append(f'\U0001f517 <a href="{stats.channel_url}">\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043a\u0430\u043d\u0430\u043b</a>')
    return "\n".join(lines)


def _list_keyboard(chat_id: int, page: int, total: int) -> InlineKeyboardMarkup:
    buttons = []
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("\u25c0\ufe0f \u041d\u0430\u0437\u0430\u0434", callback_data=f"page:{chat_id}:{page - 1}"))
    nav.append(InlineKeyboardButton(f"{page + 1}/{total}", callback_data="noop"))
    if page < total - 1:
        nav.append(InlineKeyboardButton("\u0412\u043f\u0435\u0440\u0451\u0434 \u25b6\ufe0f", callback_data=f"page:{chat_id}:{page + 1}"))
    if nav:
        buttons.append(nav)
    buttons.append([
        InlineKeyboardButton("\U0001f504 \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c", callback_data=f"refresh:{chat_id}:{page + 1}"),
        InlineKeyboardButton("\U0001f504 \u0412\u0441\u0435", callback_data=f"refresh_all:{chat_id}"),
    ])
    return InlineKeyboardMarkup(buttons)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    await update.message.reply_text(HELP_TEXT, parse_mode=ParseMode.HTML)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await cmd_start(update, context)


async def cmd_add(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    if not context.args:
        await update.message.reply_text("\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u0435: /add <\u0441\u0441\u044b\u043b\u043a\u0430 \u043d\u0430 \u043a\u0430\u043d\u0430\u043b>")
        return

    link = " ".join(context.args).strip()
    if "youtube.com" not in link and not link.startswith("UC") and not link.startswith("@"):
        await update.message.reply_text("\u041d\u0443\u0436\u043d\u0430 \u0441\u0441\u044b\u043b\u043a\u0430 YouTube \u0438\u043b\u0438 UC... / @handle")
        return

    chat_id = update.effective_chat.id
    ok, message = add_channel_link(chat_id, link)
    await update.message.reply_text(message)


async def _fetch_all(chat_id: int, links: list[str]) -> list[ChannelStats]:
    results: list[ChannelStats] = []
    for index, raw in enumerate(links, start=1):
        stats = await asyncio.to_thread(fetch_channel_stats, index, raw)
        results.append(stats)
    save_chat_results(chat_id, results)
    return results


async def _fetch_one(chat_id: int, index: int) -> ChannelStats | None:
    links = get_channel_links(chat_id)
    if index < 1 or index > len(links):
        return None

    existing = {s.channel_number: s for s in get_results_for_chat(chat_id)}
    stats = await asyncio.to_thread(fetch_channel_stats, index, links[index - 1])
    existing[index] = stats
    ordered = [existing[i] for i in sorted(existing)]
    save_chat_results(chat_id, ordered)
    return stats


async def cmd_check(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return

    chat_id = update.effective_chat.id
    links = get_channel_links(chat_id)
    if not links:
        await update.message.reply_text("\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442. /add <\u0441\u0441\u044b\u043b\u043a\u0430>")
        return

    if context.args and context.args[0].isdigit():
        index = int(context.args[0])
        msg = await update.message.reply_text(f"\u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e \u043a\u0430\u043d\u0430\u043b #{index}...")
        stats = await _fetch_one(chat_id, index)
        if not stats:
            await msg.edit_text(f"\u041d\u0435\u0442 \u043a\u0430\u043d\u0430\u043b\u0430 #{index}. \u0412\u0441\u0435\u0433\u043e: {len(links)}")
            return
        await msg.edit_text(
            _format_channel_card(stats, len(links)),
            parse_mode=ParseMode.HTML,
            disable_web_page_preview=True,
        )
        return

    msg = await update.message.reply_text(f"\u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e {len(links)} \u043a\u0430\u043d\u0430\u043b\u043e\u0432...")
    await _fetch_all(chat_id, links)
    await msg.edit_text("\u0413\u043e\u0442\u043e\u0432\u043e. /list")


async def cmd_remove(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text("\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u0435: /remove 3")
        return

    chat_id = update.effective_chat.id
    ok, message = remove_channel_link(chat_id, int(context.args[0]))
    await update.message.reply_text(message)


async def cmd_list(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    await _send_list_page(update.effective_chat.id, update, page=0)


async def _send_list_page(chat_id: int, update: Update, page: int, edit: bool = False) -> None:
    links = get_channel_links(chat_id)
    if not links:
        text = "\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442.\n\n/add <\u0441\u0441\u044b\u043b\u043a\u0430>"
        if edit and update.callback_query:
            await update.callback_query.edit_message_text(text)
        elif update.message:
            await update.message.reply_text(text)
        elif update.callback_query:
            await update.callback_query.message.reply_text(text)
        return

    results = get_results_for_chat(chat_id)
    by_num = {s.channel_number: s for s in results}
    total = len(links)
    page = max(0, min(page, total - 1))
    channel_num = page + 1

    if channel_num in by_num:
        text = _format_channel_card(by_num[channel_num], total)
    else:
        text = (
            f"<b>\u041a\u0430\u043d\u0430\u043b #{channel_num}/{total}</b>\n"
            f"<code>{links[page][:120]}</code>\n\n"
            "\u041d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445. \u041d\u0430\u0436\u043c\u0438 \u00ab\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c\u00bb."
        )

    keyboard = _list_keyboard(chat_id, page, total)
    if edit and update.callback_query:
        await update.callback_query.edit_message_text(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
            disable_web_page_preview=True,
        )
    elif update.message:
        await update.message.reply_text(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
            disable_web_page_preview=True,
        )
    elif update.callback_query:
        await update.callback_query.message.reply_text(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
            disable_web_page_preview=True,
        )


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not query.data:
        return
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return

    await query.answer()
    data = query.data

    if data == "noop":
        return

    if data.startswith("page:"):
        _, chat_id_raw, page_raw = data.split(":", 2)
        await _send_list_page(int(chat_id_raw), update, int(page_raw), edit=True)
        return

    if data.startswith("refresh_all:"):
        chat_id = int(data.split(":", 1)[1])
        links = get_channel_links(chat_id)
        await query.edit_message_text(f"\u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e {len(links)} \u043a\u0430\u043d\u0430\u043b\u043e\u0432...")
        await _fetch_all(chat_id, links)
        await _send_list_page(chat_id, update, page=0, edit=True)
        return

    if data.startswith("refresh:"):
        _, chat_id_raw, index_raw = data.split(":", 2)
        chat_id = int(chat_id_raw)
        index = int(index_raw)
        await query.edit_message_text(f"\u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e \u043a\u0430\u043d\u0430\u043b #{index}...")
        await _fetch_one(chat_id, index)
        await _send_list_page(chat_id, update, page=index - 1, edit=True)


YOUTUBE_RE = re.compile(
    r"(https?://(?:www\.)?youtube\.com/\S+|@[\w.-]+|UC[\w-]{20,})",
    re.I,
)


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.text:
        return
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return

    match = YOUTUBE_RE.search(update.message.text)
    if not match:
        return

    link = match.group(1).strip()
    chat_id = update.effective_chat.id
    ok, message = add_channel_link(chat_id, link)
    await update.message.reply_text(f"{message}\n\n/check \u2014 \u043e\u0431\u043d\u043e\u0432\u0438\u0442\u044c\n/list \u2014 \u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c")


def main() -> None:
    token = (BOT_TOKEN or os.environ.get("TELEGRAM_BOT_TOKEN", "")).strip()
    if not token:
        raise SystemExit("Set BOT_TOKEN at top of bot.py or TELEGRAM_BOT_TOKEN env")

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("add", cmd_add))
    app.add_handler(CommandHandler("list", cmd_list))
    app.add_handler(CommandHandler("check", cmd_check))
    app.add_handler(CommandHandler("remove", cmd_remove))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))

    log.info("Bot started")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
