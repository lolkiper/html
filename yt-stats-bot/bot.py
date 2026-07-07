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
YOUTUBE_API_KEY = ""  # https://console.cloud.google.com/apis/credentials
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
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup, Update
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

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
_RUNTIME_API_KEY = ""


def set_youtube_api_key(key: str) -> None:
    global _RUNTIME_API_KEY
    _RUNTIME_API_KEY = (key or "").strip()


def get_youtube_api_key() -> str:
    return _RUNTIME_API_KEY or os.environ.get("YOUTUBE_API_KEY", "").strip()


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


def _youtube_api_get(endpoint: str, params: dict[str, Any], api_key: str) -> dict[str, Any]:
    query = {**params, "key": api_key}
    response = requests.get(f"{YOUTUBE_API_BASE}/{endpoint}", params=query, timeout=25)
    try:
        data = response.json()
    except json.JSONDecodeError:
        raise RuntimeError(f"YouTube API HTTP {response.status_code}")

    if response.status_code != 200:
        err = data.get("error", {}) if isinstance(data, dict) else {}
        message = err.get("message", response.text)[:240]
        raise RuntimeError(f"YouTube API: {message}")
    return data


def _format_api_date(iso_value: str | None) -> str:
    if not iso_value:
        return DASH
    try:
        dt = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
        return dt.strftime("%d.%m.%Y")
    except ValueError:
        return iso_value[:10]


def _extract_handle(raw: str) -> str | None:
    value = (raw or "").strip()
    pipe_match = re.match(r"^\d+\|(.+)$", value)
    if pipe_match:
        value = pipe_match.group(1).strip()
    if value.startswith("@"):
        return value[1:]
    handle_match = re.search(r"youtube\.com/@([\w.-]+)", value, re.I)
    if handle_match:
        return handle_match.group(1)
    return None


def resolve_channel_id_via_api(raw: str, api_key: str) -> str | None:
    channel_id = extract_channel_id(raw)
    if channel_id:
        return channel_id

    handle = _extract_handle(raw)
    if handle:
        data = _youtube_api_get("channels", {"part": "id", "forHandle": handle}, api_key)
        items = data.get("items") or []
        if items:
            return items[0].get("id")

    value = (raw or "").strip()
    legacy_match = re.search(r"youtube\.com/(?:c|user)/([\w.-]+)", value, re.I)
    if legacy_match:
        query = legacy_match.group(1)
        data = _youtube_api_get(
            "search",
            {"part": "snippet", "type": "channel", "q": query, "maxResults": 1},
            api_key,
        )
        items = data.get("items") or []
        if items:
            return items[0].get("snippet", {}).get("channelId")

    return None


def _fetch_latest_video_via_api(channel_item: dict[str, Any], api_key: str) -> dict[str, str | None]:
    result = {
        "title": DASH,
        "views": DASH,
        "date": DASH,
        "url": None,
    }
    uploads_id = (
        channel_item.get("contentDetails", {})
        .get("relatedPlaylists", {})
        .get("uploads")
    )
    if not uploads_id:
        return result

    playlist = _youtube_api_get(
        "playlistItems",
        {"part": "snippet,contentDetails", "playlistId": uploads_id, "maxResults": 1},
        api_key,
    )
    items = playlist.get("items") or []
    if not items:
        return result

    item = items[0]
    snippet = item.get("snippet", {})
    video_id = item.get("contentDetails", {}).get("videoId") or snippet.get("resourceId", {}).get("videoId")
    result["title"] = snippet.get("title") or DASH
    result["date"] = _format_api_date(snippet.get("publishedAt"))
    if video_id:
        result["url"] = f"https://www.youtube.com/watch?v={video_id}"
        video_data = _youtube_api_get(
            "videos",
            {"part": "statistics", "id": video_id},
            api_key,
        )
        video_items = video_data.get("items") or []
        if video_items:
            result["views"] = format_count(video_items[0].get("statistics", {}).get("viewCount"))
    return result


def _fetch_via_youtube_api(channel_number: int, raw: str, api_key: str) -> ChannelStats:
    stats = ChannelStats(channel_number=channel_number, raw=raw)
    channel_id = resolve_channel_id_via_api(raw, api_key)

    if not channel_id:
        stats.status = "ERROR"
        stats.error = "Could not resolve channel ID"
        stats.updated_at = datetime.now(timezone.utc).isoformat()
        return stats

    data = _youtube_api_get(
        "channels",
        {"part": "snippet,statistics,status,contentDetails", "id": channel_id},
        api_key,
    )
    items = data.get("items") or []
    if not items:
        stats.channel_id = channel_id
        stats.channel_url = f"https://www.youtube.com/channel/{channel_id}"
        stats.is_blocked = True
        stats.block_reason = "Channel not found or terminated"
        stats.status = "BLOCKED"
        stats.updated_at = datetime.now(timezone.utc).isoformat()
        return stats

    item = items[0]
    snippet = item.get("snippet", {})
    statistics = item.get("statistics", {})
    status_info = item.get("status", {})

    stats.channel_id = channel_id
    stats.channel_url = f"https://www.youtube.com/channel/{channel_id}"
    stats.channel_name = snippet.get("title") or DASH

    if statistics.get("hiddenSubscriberCount"):
        stats.subscribers = "\u0441\u043a\u0440\u044b\u0442\u043e"
    else:
        stats.subscribers = format_count(statistics.get("subscriberCount"))

    stats.total_views = format_count(statistics.get("viewCount"))

    if status_info.get("privacyStatus") == "closed":
        stats.is_blocked = True
        stats.block_reason = "Channel closed"
        stats.status = "BLOCKED"
        stats.updated_at = datetime.now(timezone.utc).isoformat()
        return stats

    if not statistics and not snippet.get("title"):
        stats.is_blocked = True
        stats.block_reason = "Channel unavailable"
        stats.status = "BLOCKED"
        stats.updated_at = datetime.now(timezone.utc).isoformat()
        return stats

    latest = _fetch_latest_video_via_api(item, api_key)
    stats.last_video_title = latest["title"] or DASH
    stats.last_video_views = latest["views"] or DASH
    stats.last_video_date = latest["date"] or DASH
    stats.last_video_url = latest["url"]
    stats.status = "OK"
    stats.updated_at = datetime.now(timezone.utc).isoformat()
    return stats


def _fetch_via_fallback(channel_number: int, raw: str) -> ChannelStats:
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


def fetch_channel_stats(channel_number: int, raw: str) -> ChannelStats:
    api_key = get_youtube_api_key()
    if not api_key:
        stats = ChannelStats(channel_number=channel_number, raw=raw)
        stats.status = "ERROR"
        stats.error = "\u041d\u0443\u0436\u0435\u043d YOUTUBE_API_KEY \u0432 bot.py"
        stats.updated_at = datetime.now(timezone.utc).isoformat()
        return stats

    try:
        return _fetch_via_youtube_api(channel_number, raw, api_key)
    except Exception as err:  # noqa: BLE001
        stats = ChannelStats(channel_number=channel_number, raw=raw)
        message = str(err)
        if detect_ban_from_text(message):
            stats.is_blocked = True
            stats.block_reason = message[:240]
            stats.status = "BLOCKED"
        else:
            stats.status = "ERROR"
            stats.error = message[:240]
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
    "<b>\U0001f3ac YT Stats Bot</b>\n"
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n"
    "\u041c\u043e\u043d\u0438\u0442\u043e\u0440\u0438\u043d\u0433 YouTube-\u043a\u0430\u043d\u0430\u043b\u043e\u0432:\n"
    "\u2022 \u043f\u043e\u0434\u043f\u0438\u0441\u0447\u0438\u043a\u0438\n"
    "\u2022 \u0431\u0430\u043d / \u0441\u0442\u0430\u0442\u0443\u0441\n"
    "\u2022 \u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u044b\n"
    "\u2022 \u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u0432\u0438\u0434\u0435\u043e\n\n"
    "\U0001f449 \u0418\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439 \u043a\u043d\u043e\u043f\u043a\u0438 \u043d\u0438\u0436\u0435\n"
    "\u0438\u043b\u0438 \u043f\u0440\u043e\u0441\u0442\u043e \u043e\u0442\u043f\u0440\u0430\u0432\u044c \u0441\u0441\u044b\u043b\u043a\u0443 \u043d\u0430 \u043a\u0430\u043d\u0430\u043b."
)

BTN_LIST = "\U0001f4cb \u041c\u043e\u0438 \u043a\u0430\u043d\u0430\u043b\u044b"
BTN_ADD = "\u2795 \u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c"
BTN_REFRESH = "\U0001f504 \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c"
BTN_SUMMARY = "\U0001f4ca \u0421\u0432\u043e\u0434\u043a\u0430"
BTN_HELP = "\u2139\ufe0f \u041f\u043e\u043c\u043e\u0449\u044c"
BTN_MENU = "\U0001f3e0 \u041c\u0435\u043d\u044e"

REMOVE_PAGE_SIZE = 6


def _main_reply_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [
            [KeyboardButton(BTN_LIST), KeyboardButton(BTN_ADD)],
            [KeyboardButton(BTN_REFRESH), KeyboardButton(BTN_SUMMARY)],
            [KeyboardButton(BTN_HELP)],
        ],
        resize_keyboard=True,
        input_field_placeholder="\u0421\u0441\u044b\u043b\u043a\u0430 YouTube \u0438\u043b\u0438 \u043a\u043d\u043e\u043f\u043a\u0430 \u043c\u0435\u043d\u044e...",
    )


def _welcome_text(chat_id: int) -> str:
    count = len(get_channel_links(chat_id))
    results = get_results_for_chat(chat_id)
    ok = sum(1 for s in results if s.status == "OK" and not s.is_blocked)
    banned = sum(1 for s in results if s.is_blocked)
    return (
        f"<b>\U0001f3ac YT Stats Bot</b>\n"
        f"\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n"
        f"\U0001f4fa \u041a\u0430\u043d\u0430\u043b\u043e\u0432 \u0432 \u0441\u043f\u0438\u0441\u043a\u0435: <b>{count}</b>\n"
        f"\u2705 \u0410\u043a\u0442\u0438\u0432\u043d\u044b\u0445: <b>{ok}</b>  \U0001f6ab \u0417\u0430\u0431\u0430\u043d\u0435\u043d\u043e: <b>{banned}</b>\n\n"
        f"\U0001f449 \u0412\u044b\u0431\u0435\u0440\u0438 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u043a\u043d\u043e\u043f\u043a\u0430\u043c\u0438 \u043d\u0438\u0436\u0435"
    )


def _home_inline_keyboard(chat_id: int) -> InlineKeyboardMarkup:
    count = len(get_channel_links(chat_id))
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton(f"\U0001f4cb \u041a\u0430\u043d\u0430\u043b\u044b ({count})", callback_data=f"menu:list:{chat_id}:0")],
            [
                InlineKeyboardButton("\u2795 \u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c", callback_data=f"menu:add:{chat_id}"),
                InlineKeyboardButton("\U0001f504 \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c", callback_data=f"menu:check:{chat_id}"),
            ],
            [
                InlineKeyboardButton("\U0001f4ca \u0421\u0432\u043e\u0434\u043a\u0430", callback_data=f"menu:summary:{chat_id}"),
                InlineKeyboardButton("\U0001f5d1 \u0423\u0434\u0430\u043b\u0438\u0442\u044c", callback_data=f"menu:remove:{chat_id}:0"),
            ],
        ]
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
    bar = "\u2501" * 18
    lines = [
        f"<b>\U0001f4fa \u041a\u0430\u043d\u0430\u043b {stats.channel_number} / {total}</b>",
        bar,
        f"<b>{stats.channel_name}</b>",
        "",
        f"\U0001f465 \u041f\u043e\u0434\u043f\u0438\u0441\u0447\u0438\u043a\u0438   <b>{stats.subscribers}</b>",
        f"\U0001f441 \u041f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u044b       <b>{stats.total_views}</b>",
        f"{_status_emoji(stats)} \u0421\u0442\u0430\u0442\u0443\u0441          <b>{status}</b>",
    ]
    if stats.block_reason:
        lines.append(f"\u26a0\ufe0f {stats.block_reason}")
    if stats.error:
        lines.append(f"\u26a0\ufe0f {stats.error}")

    lines.extend(["", bar, "\U0001f3ac <b>\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u0432\u0438\u0434\u0435\u043e</b>"])
    lines.append(stats.last_video_title)
    lines.append(f"\U0001f441 {stats.last_video_views}  \U0001f4c5 {stats.last_video_date}")
    return "\n".join(lines)


def _format_summary(chat_id: int) -> str:
    links = get_channel_links(chat_id)
    results = {s.channel_number: s for s in get_results_for_chat(chat_id)}
    if not links:
        return "\U0001f4ca <b>\u0421\u0432\u043e\u0434\u043a\u0430</b>\n\n\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442."

    lines = [
        f"<b>\U0001f4ca \u0421\u0432\u043e\u0434\u043a\u0430</b>",
        "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
        f"\u0412\u0441\u0435\u0433\u043e \u043a\u0430\u043d\u0430\u043b\u043e\u0432: <b>{len(links)}</b>\n",
    ]
    for i in range(1, len(links) + 1):
        stats = results.get(i)
        if stats:
            emoji = _status_emoji(stats)
            name = stats.channel_name if stats.channel_name != DASH else links[i - 1][:40]
            lines.append(f"{emoji} <b>#{i}</b> {name}")
            lines.append(f"    \U0001f465 {stats.subscribers}  \U0001f441 {stats.total_views}")
        else:
            lines.append(f"\u23f3 <b>#{i}</b> <code>{links[i - 1][:50]}</code>")
            lines.append("    \u041d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445")
    return "\n".join(lines)


def _list_keyboard(
    chat_id: int,
    page: int,
    total: int,
    stats: ChannelStats | None = None,
) -> InlineKeyboardMarkup:
    buttons: list[list[InlineKeyboardButton]] = []
    nav: list[InlineKeyboardButton] = []
    if page > 0:
        nav.append(InlineKeyboardButton("\u25c0\ufe0f", callback_data=f"page:{chat_id}:{page - 1}"))
    nav.append(InlineKeyboardButton(f" {page + 1} / {total} ", callback_data="noop"))
    if page < total - 1:
        nav.append(InlineKeyboardButton("\u25b6\ufe0f", callback_data=f"page:{chat_id}:{page + 1}"))
    buttons.append(nav)

    link_row: list[InlineKeyboardButton] = []
    if stats and stats.channel_url:
        link_row.append(InlineKeyboardButton("\U0001f4fa \u041a\u0430\u043d\u0430\u043b", url=stats.channel_url))
    if stats and stats.last_video_url:
        link_row.append(InlineKeyboardButton("\U0001f3ac \u0412\u0438\u0434\u0435\u043e", url=stats.last_video_url))
    if link_row:
        buttons.append(link_row)

    buttons.append(
        [
            InlineKeyboardButton("\U0001f504 \u042d\u0442\u043e\u0442", callback_data=f"refresh:{chat_id}:{page + 1}"),
            InlineKeyboardButton("\U0001f504 \u0412\u0441\u0435", callback_data=f"refresh_all:{chat_id}"),
        ]
    )
    buttons.append(
        [
            InlineKeyboardButton("\U0001f5d1 \u0423\u0434\u0430\u043b\u0438\u0442\u044c", callback_data=f"pickrm:{chat_id}:{page}"),
            InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}"),
        ]
    )
    return InlineKeyboardMarkup(buttons)


def _remove_picker_keyboard(chat_id: int, page: int) -> InlineKeyboardMarkup:
    links = get_channel_links(chat_id)
    results = {s.channel_number: s for s in get_results_for_chat(chat_id)}
    total = len(links)
    pages = max(1, (total + REMOVE_PAGE_SIZE - 1) // REMOVE_PAGE_SIZE)
    page = max(0, min(page, pages - 1))
    start = page * REMOVE_PAGE_SIZE

    buttons: list[list[InlineKeyboardButton]] = []
    for i in range(start + 1, min(start + REMOVE_PAGE_SIZE + 1, total + 1)):
        stats = results.get(i)
        label_name = (stats.channel_name if stats and stats.channel_name != DASH else links[i - 1])[:28]
        buttons.append(
            [InlineKeyboardButton(f"\U0001f5d1 #{i} {label_name}", callback_data=f"remove:{chat_id}:{i}")]
        )

    nav: list[InlineKeyboardButton] = []
    if page > 0:
        nav.append(InlineKeyboardButton("\u25c0\ufe0f", callback_data=f"menu:remove:{chat_id}:{page - 1}"))
    nav.append(InlineKeyboardButton(f" {page + 1}/{pages} ", callback_data="noop"))
    if page < pages - 1:
        nav.append(InlineKeyboardButton("\u25b6\ufe0f", callback_data=f"menu:remove:{chat_id}:{page + 1}"))
    if nav:
        buttons.append(nav)
    buttons.append([InlineKeyboardButton("\u274c \u041e\u0442\u043c\u0435\u043d\u0430", callback_data=f"menu:home:{chat_id}")])
    return InlineKeyboardMarkup(buttons)


async def _send_home(chat_id: int, update: Update, edit: bool = False) -> None:
    text = _welcome_text(chat_id)
    markup = _home_inline_keyboard(chat_id)
    if edit and update.callback_query:
        await update.callback_query.edit_message_text(
            text, parse_mode=ParseMode.HTML, reply_markup=markup, disable_web_page_preview=True
        )
    elif update.message:
        await update.message.reply_text(
            text,
            parse_mode=ParseMode.HTML,
            reply_markup=_main_reply_keyboard(),
            disable_web_page_preview=True,
        )
        await update.message.reply_text(
            "\u0411\u044b\u0441\u0442\u0440\u043e\u0435 \u043c\u0435\u043d\u044e:",
            reply_markup=markup,
        )
    elif update.callback_query:
        await update.callback_query.message.reply_text(
            text, parse_mode=ParseMode.HTML, reply_markup=markup, disable_web_page_preview=True
        )


async def _prompt_add(chat_id: int, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    context.user_data["mode"] = "add"
    text = (
        "\u2795 <b>\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043a\u0430\u043d\u0430\u043b</b>\n\n"
        "\u041e\u0442\u043f\u0440\u0430\u0432\u044c \u0441\u0441\u044b\u043b\u043a\u0443:\n"
        "<code>https://youtube.com/channel/UC...</code>\n"
        "<code>https://youtube.com/@handle</code>\n"
        "<code>UCxxxxxxxx</code>"
    )
    markup = InlineKeyboardMarkup([[InlineKeyboardButton("\u274c \u041e\u0442\u043c\u0435\u043d\u0430", callback_data=f"menu:home:{chat_id}")]])
    if update.callback_query:
        await update.callback_query.edit_message_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
    elif update.message:
        await update.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)


async def _send_summary(chat_id: int, update: Update, edit: bool = False) -> None:
    text = _format_summary(chat_id)
    markup = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("\U0001f504 \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0432\u0441\u0435", callback_data=f"menu:check:{chat_id}")],
            [InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")],
        ]
    )
    if edit and update.callback_query:
        await update.callback_query.edit_message_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
    elif update.message:
        await update.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup, disable_web_page_preview=True)
    elif update.callback_query:
        await update.callback_query.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)


async def _send_remove_picker(chat_id: int, update: Update, page: int = 0, edit: bool = False) -> None:
    links = get_channel_links(chat_id)
    if not links:
        text = "\U0001f5d1 \u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442"
        markup = InlineKeyboardMarkup([[InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")]])
        if edit and update.callback_query:
            await update.callback_query.edit_message_text(text, reply_markup=markup)
        elif update.message:
            await update.message.reply_text(text, reply_markup=markup)
        return

    text = "\U0001f5d1 <b>\u041a\u0430\u043a\u043e\u0439 \u043a\u0430\u043d\u0430\u043b \u0443\u0434\u0430\u043b\u0438\u0442\u044c?</b>"
    markup = _remove_picker_keyboard(chat_id, page)
    if edit and update.callback_query:
        await update.callback_query.edit_message_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
    elif update.message:
        await update.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
    elif update.callback_query:
        await update.callback_query.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    context.user_data.pop("mode", None)
    await _send_home(update.effective_chat.id, update)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    markup = InlineKeyboardMarkup([[InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{update.effective_chat.id}")]])
    await update.message.reply_text(HELP_TEXT, parse_mode=ParseMode.HTML, reply_markup=markup)


async def cmd_add(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    if not context.args:
        await _prompt_add(update.effective_chat.id, update, context)
        return

    link = " ".join(context.args).strip()
    if "youtube.com" not in link and not link.startswith("UC") and not link.startswith("@"):
        await update.message.reply_text("\u041d\u0443\u0436\u043d\u0430 \u0441\u0441\u044b\u043b\u043a\u0430 YouTube \u0438\u043b\u0438 UC... / @handle")
        return

    chat_id = update.effective_chat.id
    ok, message = add_channel_link(chat_id, link)
    context.user_data.pop("mode", None)
    markup = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("\U0001f504 \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c", callback_data=f"menu:check:{chat_id}"),
                InlineKeyboardButton("\U0001f4cb \u0421\u043f\u0438\u0441\u043e\u043a", callback_data=f"menu:list:{chat_id}:0"),
            ],
            [InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")],
        ]
    )
    await update.message.reply_text(message, reply_markup=markup)


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
        markup = InlineKeyboardMarkup(
            [
                [InlineKeyboardButton("\u2795 \u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c", callback_data=f"menu:add:{chat_id}")],
                [InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")],
            ]
        )
        await update.message.reply_text("\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442.", reply_markup=markup)
        return

    if context.args and context.args[0].isdigit():
        index = int(context.args[0])
        msg = await update.message.reply_text(f"\u23f3 \u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e \u043a\u0430\u043d\u0430\u043b #{index}...")
        stats = await _fetch_one(chat_id, index)
        if not stats:
            await msg.edit_text(f"\u041d\u0435\u0442 \u043a\u0430\u043d\u0430\u043b\u0430 #{index}. \u0412\u0441\u0435\u0433\u043e: {len(links)}")
            return
        await msg.edit_text(
            _format_channel_card(stats, len(links)),
            parse_mode=ParseMode.HTML,
            reply_markup=_list_keyboard(chat_id, index - 1, len(links), stats),
            disable_web_page_preview=True,
        )
        return

    msg = await update.message.reply_text(f"\u23f3 \u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e {len(links)} \u043a\u0430\u043d\u0430\u043b\u043e\u0432...")
    await _fetch_all(chat_id, links)
    markup = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("\U0001f4cb \u041a \u0441\u043f\u0438\u0441\u043a\u0443", callback_data=f"menu:list:{chat_id}:0")],
            [InlineKeyboardButton("\U0001f4ca \u0421\u0432\u043e\u0434\u043a\u0430", callback_data=f"menu:summary:{chat_id}")],
        ]
    )
    await msg.edit_text("\u2705 \u0413\u043e\u0442\u043e\u0432\u043e!", reply_markup=markup)


async def cmd_remove(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text("\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u0435: /remove 3")
        return

    chat_id = update.effective_chat.id
    ok, message = remove_channel_link(chat_id, int(context.args[0]))
    markup = InlineKeyboardMarkup([[InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")]])
    await update.message.reply_text(message, reply_markup=markup)


async def cmd_list(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update.effective_user and update.effective_user.id):
        await _deny(update)
        return
    await _send_list_page(update.effective_chat.id, update, page=0)


async def _send_list_page(chat_id: int, update: Update, page: int, edit: bool = False) -> None:
    links = get_channel_links(chat_id)
    if not links:
        text = "\U0001f4cb <b>\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442</b>"
        markup = InlineKeyboardMarkup(
            [
                [InlineKeyboardButton("\u2795 \u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c", callback_data=f"menu:add:{chat_id}")],
                [InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")],
            ]
        )
        if edit and update.callback_query:
            await update.callback_query.edit_message_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
        elif update.message:
            await update.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
        elif update.callback_query:
            await update.callback_query.message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
        return

    results = get_results_for_chat(chat_id)
    by_num = {s.channel_number: s for s in results}
    total = len(links)
    page = max(0, min(page, total - 1))
    channel_num = page + 1
    stats = by_num.get(channel_num)

    if stats:
        text = _format_channel_card(stats, total)
    else:
        text = (
            f"<b>\U0001f4fa \u041a\u0430\u043d\u0430\u043b {channel_num} / {total}</b>\n"
            f"\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"
            f"<code>{links[page][:120]}</code>\n\n"
            "\u23f3 \u041d\u0430\u0436\u043c\u0438 \u00ab\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c\u00bb"
        )

    keyboard = _list_keyboard(chat_id, page, total, stats)
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

    if data.startswith("menu:"):
        parts = data.split(":")
        action = parts[1]
        chat_id = int(parts[2])
        if action == "home":
            context.user_data.pop("mode", None)
            await _send_home(chat_id, update, edit=True)
        elif action == "list":
            page = int(parts[3]) if len(parts) > 3 else 0
            await _send_list_page(chat_id, update, page, edit=True)
        elif action == "add":
            await _prompt_add(chat_id, update, context)
        elif action == "check":
            links = get_channel_links(chat_id)
            if not links:
                await query.edit_message_text("\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442.")
                return
            await query.edit_message_text(f"\u23f3 \u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e {len(links)} \u043a\u0430\u043d\u0430\u043b\u043e\u0432...")
            await _fetch_all(chat_id, links)
            await _send_summary(chat_id, update, edit=True)
        elif action == "summary":
            await _send_summary(chat_id, update, edit=True)
        elif action == "remove":
            page = int(parts[3]) if len(parts) > 3 else 0
            await _send_remove_picker(chat_id, update, page, edit=True)
        return

    if data.startswith("pickrm:"):
        _, chat_id_raw, page_raw = data.split(":", 2)
        await _send_remove_picker(int(chat_id_raw), update, int(page_raw), edit=True)
        return

    if data.startswith("remove:"):
        _, chat_id_raw, index_raw = data.split(":", 2)
        chat_id = int(chat_id_raw)
        index = int(index_raw)
        ok, message = remove_channel_link(chat_id, index)
        markup = InlineKeyboardMarkup(
            [
                [InlineKeyboardButton("\U0001f4cb \u041a \u0441\u043f\u0438\u0441\u043a\u0443", callback_data=f"menu:list:{chat_id}:0")],
                [InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")],
            ]
        )
        await query.edit_message_text(message, reply_markup=markup)
        return

    if data.startswith("page:"):
        _, chat_id_raw, page_raw = data.split(":", 2)
        await _send_list_page(int(chat_id_raw), update, int(page_raw), edit=True)
        return

    if data.startswith("refresh_all:"):
        chat_id = int(data.split(":", 1)[1])
        links = get_channel_links(chat_id)
        await query.edit_message_text(f"\u23f3 \u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e {len(links)} \u043a\u0430\u043d\u0430\u043b\u043e\u0432...")
        await _fetch_all(chat_id, links)
        await _send_list_page(chat_id, update, page=0, edit=True)
        return

    if data.startswith("refresh:"):
        _, chat_id_raw, index_raw = data.split(":", 2)
        chat_id = int(chat_id_raw)
        index = int(index_raw)
        await query.edit_message_text(f"\u23f3 \u041e\u0431\u043d\u043e\u0432\u043b\u044f\u044e \u043a\u0430\u043d\u0430\u043b #{index}...")
        stats = await _fetch_one(chat_id, index)
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

    text = update.message.text.strip()
    chat_id = update.effective_chat.id

    if text == BTN_LIST or text == BTN_MENU:
        await _send_list_page(chat_id, update, page=0)
        return
    if text == BTN_ADD:
        await _prompt_add(chat_id, update, context)
        return
    if text == BTN_REFRESH:
        await cmd_check(update, context)
        return
    if text == BTN_SUMMARY:
        await _send_summary(chat_id, update)
        return
    if text == BTN_HELP:
        await cmd_help(update, context)
        return

    if context.user_data.get("mode") == "add":
        match = YOUTUBE_RE.search(text)
        if not match:
            await update.message.reply_text("\u274c \u041d\u0443\u0436\u043d\u0430 \u0441\u0441\u044b\u043b\u043a\u0430 YouTube")
            return
        link = match.group(1).strip()
        ok, message = add_channel_link(chat_id, link)
        context.user_data.pop("mode", None)
        markup = InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton("\U0001f504 \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c", callback_data=f"menu:check:{chat_id}"),
                    InlineKeyboardButton("\U0001f4cb \u0421\u043f\u0438\u0441\u043e\u043a", callback_data=f"menu:list:{chat_id}:0"),
                ],
                [InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")],
            ]
        )
        await update.message.reply_text(message, reply_markup=markup)
        return

    match = YOUTUBE_RE.search(text)
    if not match:
        markup = _home_inline_keyboard(chat_id)
        await update.message.reply_text(
            "\U0001f449 \u0412\u044b\u0431\u0435\u0440\u0438 \u043a\u043d\u043e\u043f\u043a\u0443 \u0438\u043b\u0438 \u043e\u0442\u043f\u0440\u0430\u0432\u044c \u0441\u0441\u044b\u043b\u043a\u0443 YouTube",
            reply_markup=markup,
        )
        return

    link = match.group(1).strip()
    ok, message = add_channel_link(chat_id, link)
    markup = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("\U0001f504 \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c", callback_data=f"menu:check:{chat_id}"),
                InlineKeyboardButton("\U0001f4cb \u0421\u043f\u0438\u0441\u043e\u043a", callback_data=f"menu:list:{chat_id}:0"),
            ],
            [InlineKeyboardButton("\U0001f3e0 \u041c\u0435\u043d\u044e", callback_data=f"menu:home:{chat_id}")],
        ]
    )
    await update.message.reply_text(message, reply_markup=markup)


def main() -> None:
    api_key = (YOUTUBE_API_KEY or os.environ.get("YOUTUBE_API_KEY", "")).strip()
    if api_key:
        set_youtube_api_key(api_key)
    elif not get_youtube_api_key():
        log.warning("YOUTUBE_API_KEY is empty - stats may not load. Get key: https://console.cloud.google.com/apis/credentials")

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
