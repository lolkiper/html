#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GUI-панель для LDPlayer automation.

Запуск:
    python gui.py

Сборка .exe (без консоли):
    pyinstaller --onefile --windowed --name Standoff2Bot gui.py
"""

from __future__ import annotations

import queue
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk

from main import (
    ERRORS_FILE,
    GOOGLE_ACCOUNTS_FILE,
    SUCCESS_LOG_FILE,
    TWITCH_ACCOUNTS_FILE,
    BotSettings,
    LdConsole,
    base_dir,
    connect_device,
    count_lines,
    find_dnconsole,
    run_bot,
)


class BotApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Standoff 2 · LDPlayer Bot")
        self.geometry("820x620")
        self.minsize(700, 500)

        self.work_dir = base_dir()
        self.stop_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.log_queue: queue.Queue[str] = queue.Queue()

        self._build_ui()
        self._load_settings_ui()
        self.refresh_stats()
        self.after(100, self._drain_log_queue)

    def _build_ui(self) -> None:
        pad = {"padx": 8, "pady": 4}

        # --- Настройки ---
        cfg = ttk.LabelFrame(self, text="Настройки")
        cfg.pack(fill="x", padx=10, pady=8)

        ttk.Label(cfg, text="Папка LDPlayer (корень LDPlayer9):").grid(row=0, column=0, sticky="w", **pad)
        self.ld_path_var = tk.StringVar()
        ttk.Entry(cfg, textvariable=self.ld_path_var, width=55).grid(row=0, column=1, sticky="ew", **pad)
        ttk.Button(cfg, text="Обзор…", command=self._browse_ldplayer).grid(row=0, column=2, **pad)

        ttk.Label(cfg, text="Индекс эмулятора:").grid(row=1, column=0, sticky="w", **pad)
        self.index_var = tk.StringVar(value="0")
        ttk.Spinbox(cfg, from_=0, to=20, textvariable=self.index_var, width=8).grid(
            row=1, column=1, sticky="w", **pad
        )

        ttk.Label(cfg, text="ADB порт (пусто = авто):").grid(row=2, column=0, sticky="w", **pad)
        self.adb_port_var = tk.StringVar()
        ttk.Entry(cfg, textvariable=self.adb_port_var, width=12).grid(row=2, column=1, sticky="w", **pad)

        ttk.Label(cfg, text="Рабочая папка:").grid(row=3, column=0, sticky="w", **pad)
        self.work_dir_var = tk.StringVar(value=str(self.work_dir))
        ttk.Entry(cfg, textvariable=self.work_dir_var, width=55).grid(row=3, column=1, sticky="ew", **pad)
        ttk.Button(cfg, text="Обзор…", command=self._browse_workdir).grid(row=3, column=2, **pad)

        cfg.columnconfigure(1, weight=1)

        # --- Статистика ---
        stat = ttk.LabelFrame(self, text="База аккаунтов")
        stat.pack(fill="x", padx=10, pady=4)

        self.stat_google = tk.StringVar(value="0")
        self.stat_twitch = tk.StringVar(value="0")
        self.stat_success = tk.StringVar(value="0")
        self.stat_errors = tk.StringVar(value="0")

        for col, (label, var) in enumerate(
            [
                ("Google", self.stat_google),
                ("Twitch", self.stat_twitch),
                ("Успех", self.stat_success),
                ("Ошибки", self.stat_errors),
            ]
        ):
            ttk.Label(stat, text=f"{label}:").grid(row=0, column=col * 2, sticky="e", padx=4, pady=6)
            ttk.Label(stat, textvariable=var, font=("Segoe UI", 10, "bold")).grid(
                row=0, column=col * 2 + 1, sticky="w", padx=4, pady=6
            )

        ttk.Button(stat, text="Обновить", command=self.refresh_stats).grid(row=0, column=8, padx=8)
        ttk.Button(stat, text="Открыть папку", command=self._open_workdir).grid(row=0, column=9, padx=4)

        # --- Управление ---
        ctrl = ttk.Frame(self)
        ctrl.pack(fill="x", padx=10, pady=4)

        self.btn_start = ttk.Button(ctrl, text="▶ Старт", command=self.start_bot)
        self.btn_start.pack(side="left", padx=4)
        self.btn_stop = ttk.Button(ctrl, text="■ Стоп", command=self.stop_bot, state="disabled")
        self.btn_stop.pack(side="left", padx=4)
        ttk.Button(ctrl, text="Тест ADB", command=self.test_adb).pack(side="left", padx=4)

        self.status_var = tk.StringVar(value="Готов")
        ttk.Label(ctrl, textvariable=self.status_var).pack(side="right", padx=8)

        # --- Лог ---
        log_frame = ttk.LabelFrame(self, text="Лог")
        log_frame.pack(fill="both", expand=True, padx=10, pady=8)

        self.log_text = scrolledtext.ScrolledText(
            log_frame,
            height=18,
            font=("Consolas", 9),
            bg="#1e1e1e",
            fg="#d4d4d4",
            insertbackground="#d4d4d4",
            state="disabled",
        )
        self.log_text.pack(fill="both", expand=True, padx=4, pady=4)

        ttk.Button(log_frame, text="Очистить лог", command=self._clear_log).pack(anchor="e", padx=4, pady=2)

    def _load_settings_ui(self) -> None:
        cfg_path = self.work_dir / "bot_settings.txt"
        if not cfg_path.is_file():
            return
        data = {}
        for line in cfg_path.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip()
        self.ld_path_var.set(data.get("ldplayer_home", ""))
        self.index_var.set(data.get("emulator_index", "0"))
        self.adb_port_var.set(data.get("adb_port", ""))
        if data.get("work_dir"):
            self.work_dir_var.set(data["work_dir"])

    def _save_settings_ui(self) -> None:
        cfg_path = Path(self.work_dir_var.get()) / "bot_settings.txt"
        lines = [
            f"ldplayer_home={self.ld_path_var.get()}",
            f"emulator_index={self.index_var.get()}",
            f"adb_port={self.adb_port_var.get()}",
            f"work_dir={self.work_dir_var.get()}",
        ]
        cfg_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _browse_ldplayer(self) -> None:
        path = filedialog.askdirectory(title="Папка LDPlayer9 (где dnconsole.exe / ldconsole.exe)")
        if path:
            self.ld_path_var.set(path)

    def _browse_workdir(self) -> None:
        path = filedialog.askdirectory(title="Рабочая папка с аккаунтами")
        if path:
            self.work_dir_var.set(path)
            self.work_dir = Path(path)
            self.refresh_stats()

    def _open_workdir(self) -> None:
        path = Path(self.work_dir_var.get())
        path.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            subprocess.Popen(["explorer", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])

    def _clear_log(self) -> None:
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def _append_log(self, line: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _drain_log_queue(self) -> None:
        while True:
            try:
                msg = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self._append_log(msg)
        self.after(100, self._drain_log_queue)

    def _log_callback(self, msg: str) -> None:
        self.log_queue.put(msg)

    def refresh_stats(self) -> None:
        root = Path(self.work_dir_var.get())
        self.stat_google.set(str(count_lines(root / GOOGLE_ACCOUNTS_FILE)))
        self.stat_twitch.set(str(count_lines(root / TWITCH_ACCOUNTS_FILE)))
        self.stat_success.set(str(count_lines(root / SUCCESS_LOG_FILE)))
        self.stat_errors.set(str(count_lines(root / ERRORS_FILE)))

    def _build_settings(self) -> BotSettings:
        adb_raw = self.adb_port_var.get().strip()
        adb_port = int(adb_raw) if adb_raw else None
        ld_home = self.ld_path_var.get().strip() or None
        return BotSettings(
            work_dir=Path(self.work_dir_var.get()),
            ldplayer_home=Path(ld_home) if ld_home else None,
            emulator_index=int(self.index_var.get()),
            adb_port=adb_port,
        )

    def start_bot(self) -> None:
        if self.worker and self.worker.is_alive():
            return

        root = Path(self.work_dir_var.get())
        root.mkdir(parents=True, exist_ok=True)
        for fname in (GOOGLE_ACCOUNTS_FILE, TWITCH_ACCOUNTS_FILE):
            if not (root / fname).is_file():
                (root / fname).touch()

        g_count = count_lines(root / GOOGLE_ACCOUNTS_FILE)
        t_count = count_lines(root / TWITCH_ACCOUNTS_FILE)
        if g_count == 0 or t_count == 0:
            messagebox.showwarning(
                "Нет аккаунтов",
                f"Заполни {GOOGLE_ACCOUNTS_FILE} и {TWITCH_ACCOUNTS_FILE}\n"
                "формат: login:password (по одной паре на строку, строки должны совпадать по порядку).",
            )
            return

        self._save_settings_ui()
        self.stop_event.clear()
        self.btn_start.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.status_var.set("Работает…")
        self._append_log("=== Старт бота ===")

        settings = self._build_settings()

        def _run() -> None:
            try:
                run_bot(settings, self.stop_event, self._log_callback)
            except Exception as exc:
                self._log_callback(f"Фатальная ошибка: {exc}")
            finally:
                self.after(0, self._on_bot_finished)

        self.worker = threading.Thread(target=_run, daemon=True)
        self.worker.start()

    def stop_bot(self) -> None:
        self.stop_event.set()
        self.status_var.set("Останавливается…")
        self._append_log("=== Запрошена остановка ===")

    def _on_bot_finished(self) -> None:
        self.btn_start.configure(state="normal")
        self.btn_stop.configure(state="disabled")
        self.status_var.set("Готов")
        self.refresh_stats()
        self._append_log("=== Бот остановлен ===")


def main() -> None:
    app = BotApp()
    app.mainloop()


if __name__ == "__main__":
    main()
