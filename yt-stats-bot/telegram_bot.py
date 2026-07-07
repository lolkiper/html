# -*- coding: utf-8 -*-
"""Telegram bot for YouTube channel statistics."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any

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

from channel_parser import ChannelStats, fetch_channel_stats
from storage import (
    add_channel_link,
    get_channel_links,
    get_results_for_chat,
    remove_channel_link,
    save_chat_results,
)

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("yt-stats-bot")

PAGE_SIZE = 1

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


def _allowed_users() -> set[int] | None:
    raw = os.environ.get("ALLOWED_USER_IDS", "").strip()
    if not raw:
        return None
    ids = set()
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids or None


def _is_allowed(user_id: int | None) -> bool:
    if user_id is None:
        return False
    allowed = _allowed_users()
    if allowed is None:
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
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN environment variable")

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
