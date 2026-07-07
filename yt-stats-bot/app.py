#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""YT Stats Bot - YouTube channel statistics panel."""

from __future__ import annotations

import threading
import tkinter as tk
import webbrowser
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from channel_parser import (
    DASH,
    ChannelStats,
    fetch_channel_stats,
    load_results,
    parse_channels_file,
    save_channels_file,
    save_results,
)

APP_DIR = Path(__file__).resolve().parent
CHANNELS_FILE = APP_DIR / "channels.txt"
RESULTS_FILE = APP_DIR / "channel-stats-results.json"

TXT_CHANNELS = "\u041a\u0430\u043d\u0430\u043b\u044b (channels.txt)"
TXT_ONE_LINE = "\u041e\u0434\u043d\u0430 \u0441\u0442\u0440\u043e\u043a\u0430 = \u043e\u0434\u0438\u043d \u043a\u0430\u043d\u0430\u043b."
TXT_SAVE = "\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0441\u043f\u0438\u0441\u043e\u043a"
TXT_OPEN = "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0444\u0430\u0439\u043b..."
TXT_LIST = "\u0421\u043f\u0438\u0441\u043e\u043a \u043a\u0430\u043d\u0430\u043b\u043e\u0432"
TXT_START = "\u25b6 \u0421\u043e\u0431\u0440\u0430\u0442\u044c \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0443"
TXT_STOP = "\u25a0 \u0421\u0442\u043e\u043f"
TXT_REFRESH = "\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0442\u0430\u0431\u043b\u0438\u0446\u0443"
TXT_DETAILS = "\u0414\u0435\u0442\u0430\u043b\u0438 \u043a\u0430\u043d\u0430\u043b\u0430"
TXT_OPEN_CH = "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043a\u0430\u043d\u0430\u043b"
TXT_OPEN_VID = "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0432\u0438\u0434\u0435\u043e"
TXT_LOG = "\u041b\u043e\u0433"
TXT_READY = "\u0413\u043e\u0442\u043e\u0432"
TXT_RUNNING = "\u0421\u0431\u043e\u0440 \u0434\u0430\u043d\u043d\u044b\u0445..."
TXT_UPDATED = "\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e: "
TXT_BANNED = "\u0417\u0410\u0411\u0410\u041d\u0415\u041d"
TXT_ERROR = "\u041e\u0428\u0418\u0411\u041a\u0410"


class StatsApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("YT Stats Bot")
        self.root.geometry("1280x760")
        self.root.minsize(980, 620)
        self.root.configure(bg="#0a0f1a")

        self._stop_event = threading.Event()
        self._worker: threading.Thread | None = None
        self._channels: list[ChannelStats] = []
        self._selected_index: int | None = None

        self._build_style()
        self._build_ui()
        self._load_channels_to_editor()
        self._load_saved_results()

    def _build_style(self) -> None:
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame", background="#0a0f1a")
        style.configure("Card.TFrame", background="#111827")
        style.configure("TLabel", background="#111827", foreground="#f1f5f9", font=("Segoe UI", 10))
        style.configure("Title.TLabel", background="#0a0f1a", foreground="#38bdf8", font=("Segoe UI", 20, "bold"))
        style.configure("Muted.TLabel", background="#111827", foreground="#94a3b8", font=("Segoe UI", 9))
        style.configure("Header.TLabel", background="#0a0f1a", foreground="#94a3b8", font=("Segoe UI", 9))
        style.configure("TButton", font=("Segoe UI", 10, "bold"), padding=8)
        style.configure("Treeview", background="#111827", fieldbackground="#111827", foreground="#f1f5f9", rowheight=28)
        style.configure("Treeview.Heading", background="#1a2332", foreground="#38bdf8", font=("Segoe UI", 9, "bold"))
        style.map("Treeview", background=[("selected", "#1e3a5f")])

    def _build_ui(self) -> None:
        header = ttk.Frame(self.root, style="TFrame")
        header.pack(fill="x", padx=16, pady=(16, 8))
        ttk.Label(header, text="YT Stats Bot", style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            header,
            text="YouTube channels: subscribers, ban, views, last video",
            style="Header.TLabel",
        ).pack(anchor="w", pady=(4, 0))

        self.status_var = tk.StringVar(value=TXT_READY)
        ttk.Label(header, textvariable=self.status_var, style="Header.TLabel").pack(anchor="w", pady=(6, 0))

        body = ttk.Panedwindow(self.root, orient=tk.HORIZONTAL)
        body.pack(fill="both", expand=True, padx=16, pady=8)

        left = ttk.Frame(body, style="Card.TFrame", padding=12)
        center = ttk.Frame(body, style="Card.TFrame", padding=12)
        right = ttk.Frame(body, style="Card.TFrame", padding=12)
        body.add(left, weight=1)
        body.add(center, weight=3)
        body.add(right, weight=2)

        ttk.Label(left, text=TXT_CHANNELS, style="TLabel").pack(anchor="w")
        ttk.Label(left, text=TXT_ONE_LINE, style="Muted.TLabel").pack(anchor="w", pady=(4, 8))

        self.channels_text = tk.Text(
            left,
            height=18,
            bg="#1a2332",
            fg="#f1f5f9",
            insertbackground="#fff",
            relief="flat",
            font=("Consolas", 10),
            wrap="word",
        )
        self.channels_text.pack(fill="both", expand=True)

        left_btns = ttk.Frame(left, style="Card.TFrame")
        left_btns.pack(fill="x", pady=(10, 0))
        ttk.Button(left_btns, text=TXT_SAVE, command=self._save_channels).pack(side="left")
        ttk.Button(left_btns, text=TXT_OPEN, command=self._open_channels_file).pack(side="left", padx=(8, 0))

        center_top = ttk.Frame(center, style="Card.TFrame")
        center_top.pack(fill="x")
        ttk.Label(center_top, text=TXT_LIST, style="TLabel").pack(side="left")
        self.updated_var = tk.StringVar(value=TXT_UPDATED + DASH)
        ttk.Label(center_top, textvariable=self.updated_var, style="Muted.TLabel").pack(side="right")

        table_wrap = ttk.Frame(center, style="Card.TFrame")
        table_wrap.pack(fill="both", expand=True, pady=(8, 0))

        columns = ("num", "name", "subscribers", "views", "last_video", "last_date", "status")
        self.tree = ttk.Treeview(table_wrap, columns=columns, show="headings", selectmode="browse")
        headings = {
            "num": "\u2116",
            "name": "\u041a\u0430\u043d\u0430\u043b",
            "subscribers": "\u041f\u043e\u0434\u043f\u0438\u0441\u0447\u0438\u043a\u0438",
            "views": "\u041f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u044b",
            "last_video": "\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u0432\u0438\u0434\u0435\u043e",
            "last_date": "\u0414\u0430\u0442\u0430",
            "status": "\u0421\u0442\u0430\u0442\u0443\u0441",
        }
        widths = {
            "num": 40,
            "name": 180,
            "subscribers": 100,
            "views": 100,
            "last_video": 220,
            "last_date": 90,
            "status": 120,
        }
        for col in columns:
            self.tree.heading(col, text=headings[col])
            self.tree.column(col, width=widths[col], anchor="w")

        y_scroll = ttk.Scrollbar(table_wrap, orient="vertical", command=self.tree.yview)
        x_scroll = ttk.Scrollbar(table_wrap, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")
        table_wrap.rowconfigure(0, weight=1)
        table_wrap.columnconfigure(0, weight=1)

        self.tree.bind("<<TreeviewSelect>>", self._on_select)
        self.tree.bind("<Double-1>", self._open_selected_video)

        action_row = ttk.Frame(center, style="Card.TFrame")
        action_row.pack(fill="x", pady=(10, 0))
        self.btn_start = ttk.Button(action_row, text=TXT_START, command=self._start_fetch)
        self.btn_start.pack(side="left")
        self.btn_stop = ttk.Button(action_row, text=TXT_STOP, command=self._stop_fetch, state="disabled")
        self.btn_stop.pack(side="left", padx=(8, 0))
        ttk.Button(action_row, text=TXT_REFRESH, command=self._refresh_table).pack(side="left", padx=(8, 0))

        ttk.Label(right, text=TXT_DETAILS, style="TLabel").pack(anchor="w")
        self.detail = tk.Text(
            right,
            height=24,
            bg="#060a12",
            fg="#34d399",
            insertbackground="#fff",
            relief="flat",
            font=("Consolas", 10),
            wrap="word",
        )
        self.detail.pack(fill="both", expand=True, pady=(8, 0))

        detail_btns = ttk.Frame(right, style="Card.TFrame")
        detail_btns.pack(fill="x", pady=(10, 0))
        ttk.Button(detail_btns, text=TXT_OPEN_CH, command=self._open_selected_channel).pack(side="left")
        ttk.Button(detail_btns, text=TXT_OPEN_VID, command=self._open_selected_video).pack(side="left", padx=(8, 0))

        log_card = ttk.Frame(self.root, style="Card.TFrame", padding=12)
        log_card.pack(fill="both", expand=False, padx=16, pady=(0, 16))
        ttk.Label(log_card, text=TXT_LOG, style="TLabel").pack(anchor="w")
        self.log_box = tk.Text(
            log_card,
            height=6,
            bg="#060a12",
            fg="#94a3b8",
            insertbackground="#fff",
            relief="flat",
            font=("Consolas", 9),
            wrap="word",
        )
        self.log_box.pack(fill="both", expand=True, pady=(6, 0))

    def _log(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        self.log_box.insert("end", f"[{stamp}] {message}\n")
        self.log_box.see("end")

    def _set_running(self, running: bool) -> None:
        self.status_var.set(TXT_RUNNING if running else TXT_READY)
        self.btn_start.configure(state="disabled" if running else "normal")
        self.btn_stop.configure(state="normal" if running else "disabled")

    def _load_channels_to_editor(self) -> None:
        if not CHANNELS_FILE.exists():
            CHANNELS_FILE.write_text(
                "# UCxxxxxxxx or https://www.youtube.com/channel/UC...\n",
                encoding="utf-8",
            )
        self.channels_text.delete("1.0", "end")
        self.channels_text.insert("1.0", CHANNELS_FILE.read_text(encoding="utf-8"))

    def _save_channels(self) -> None:
        text = self.channels_text.get("1.0", "end").strip()
        lines = text.splitlines() if text else []
        save_channels_file(CHANNELS_FILE, lines)
        self._log("channels.txt saved")

    def _open_channels_file(self) -> None:
        path = filedialog.askopenfilename(
            title="channels.txt",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
        )
        if not path:
            return
        content = Path(path).read_text(encoding="utf-8")
        self.channels_text.delete("1.0", "end")
        self.channels_text.insert("1.0", content)
        self._log(f"Loaded: {path}")

    def _load_saved_results(self) -> None:
        data = load_results(RESULTS_FILE)
        channels = data.get("channels") or []
        self._channels = []
        for item in channels:
            try:
                self._channels.append(ChannelStats(**item))
            except TypeError:
                continue
        updated = data.get("updated_at")
        if updated:
            try:
                stamp = datetime.fromisoformat(updated.replace("Z", "+00:00")).strftime("%d.%m.%Y %H:%M")
            except ValueError:
                stamp = updated
            self.updated_var.set(TXT_UPDATED + stamp)
        self._refresh_table()

    def _refresh_table(self) -> None:
        for item in self.tree.get_children():
            self.tree.delete(item)

        for idx, channel in enumerate(self._channels):
            if channel.is_blocked:
                status = TXT_BANNED
            elif channel.status == "OK":
                status = "OK"
            elif channel.status == "ERROR":
                status = TXT_ERROR
            else:
                status = channel.status

            self.tree.insert(
                "",
                "end",
                iid=str(idx),
                values=(
                    channel.channel_number,
                    channel.channel_name,
                    channel.subscribers,
                    channel.total_views,
                    channel.last_video_title,
                    channel.last_video_date,
                    status,
                ),
            )

    def _on_select(self, _event: object = None) -> None:
        selected = self.tree.selection()
        if not selected:
            return
        idx = int(selected[0])
        self._selected_index = idx
        self._show_details(self._channels[idx])

    def _show_details(self, channel: ChannelStats) -> None:
        status = TXT_BANNED if channel.is_blocked else channel.status
        lines = [
            f"Channel #{channel.channel_number}",
            f"Name: {channel.channel_name}",
            f"ID: {channel.channel_id or DASH}",
            f"URL: {channel.channel_url or DASH}",
            "",
            f"Subscribers: {channel.subscribers}",
            f"Total views: {channel.total_views}",
            f"Status: {status}",
        ]
        if channel.block_reason:
            lines.append(f"Block reason: {channel.block_reason}")
        if channel.error:
            lines.append(f"Error: {channel.error}")
        lines.extend(
            [
                "",
                f"Last video: {channel.last_video_title}",
                f"Video views: {channel.last_video_views}",
                f"Published: {channel.last_video_date}",
                f"Video URL: {channel.last_video_url or DASH}",
            ]
        )
        self.detail.delete("1.0", "end")
        self.detail.insert("1.0", "\n".join(lines))

    def _get_selected_channel(self) -> ChannelStats | None:
        if self._selected_index is None:
            return None
        if self._selected_index < 0 or self._selected_index >= len(self._channels):
            return None
        return self._channels[self._selected_index]

    def _open_selected_channel(self) -> None:
        channel = self._get_selected_channel()
        if channel and channel.channel_url:
            webbrowser.open(channel.channel_url)

    def _open_selected_video(self, _event: object = None) -> None:
        channel = self._get_selected_channel()
        if channel and channel.last_video_url:
            webbrowser.open(channel.last_video_url)

    def _start_fetch(self) -> None:
        if self._worker and self._worker.is_alive():
            return

        self._save_channels()
        parsed = parse_channels_file(CHANNELS_FILE)
        if not parsed:
            messagebox.showwarning("No channels", "Add at least one channel link to channels.txt")
            return

        self._stop_event.clear()
        self._set_running(True)
        self._log(f"Start: {len(parsed)} channels")

        def worker() -> None:
            results: list[ChannelStats] = []
            for number, raw in parsed:
                if self._stop_event.is_set():
                    self.root.after(0, lambda: self._log("Stopped"))
                    break

                self.root.after(0, lambda n=number, r=raw: self._log(f"Channel #{n}: {r[:80]}"))

                try:
                    stats = fetch_channel_stats(number, raw)
                except Exception as err:  # noqa: BLE001
                    stats = ChannelStats(channel_number=number, raw=raw, status="ERROR", error=str(err))

                results.append(stats)
                self._channels = list(results)
                save_results(RESULTS_FILE, self._channels)
                self.root.after(0, self._refresh_table)
                self.root.after(
                    0,
                    lambda s=stats: self._log(
                        f"  -> {s.channel_name} | subs {s.subscribers} | {s.status}"
                    ),
                )

            self._channels = results
            save_results(RESULTS_FILE, self._channels)
            self.root.after(0, self._refresh_table)
            self.root.after(
                0,
                lambda: self.updated_var.set(TXT_UPDATED + datetime.now().strftime("%d.%m.%Y %H:%M")),
            )
            self.root.after(0, lambda: self._set_running(False))
            self.root.after(0, lambda: self._log("Done"))

        self._worker = threading.Thread(target=worker, daemon=True)
        self._worker.start()

    def _stop_fetch(self) -> None:
        self._stop_event.set()
        self._log("Stopping...")

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    StatsApp().run()


if __name__ == "__main__":
    main()
