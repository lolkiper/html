# -*- coding: utf-8 -*-
"""YouTube channel stats via YouTube Data API v3 with HTML fallback."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

try:
    import yt_dlp
except ImportError:  # pragma: no cover
    yt_dlp = None

DASH = "\u2014"

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
