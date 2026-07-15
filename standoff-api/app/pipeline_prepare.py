"""Prepare: LDPlayer login → extract handshake → save to accounts.txt."""

from __future__ import annotations

import time
from datetime import datetime

from app.accounts_store import append_token_log, upsert_handshake
from app.adb.ldplayer import (
    LdConsole,
    STANDOFF_PACKAGE,
    connect_device,
    find_dnconsole,
    scan_working_emulator,
)
from app.config import ACCOUNTS_FILE, PREPARE_LOG, AppConfig, TOKENS_LOG
from app.handshake_extract import extract_handshake
from app.models import CreateJobRequest, JobResult
from app.steps.launch_standoff import step_launch_standoff_from_home
from app.steps.standoff_login import step_standoff_login


def _append_log(path, line: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"[{stamp}] {line}\n")


def _cleanup(device, ld: LdConsole) -> None:
    try:
        device.shell(f"am force-stop {STANDOFF_PACKAGE}")
        device.shell(f"pm clear {STANDOFF_PACKAGE}")
        device.shell("pm clear com.google.android.gms")
    except Exception:
        pass


def run_prepare_pipeline(
    job: CreateJobRequest,
    config: AppConfig,
    log_fn=print,
    *,
    accounts_out: None = None,
) -> JobResult:
    account = job.account
    out_path = accounts_out or ACCOUNTS_FILE
    result = JobResult(
        google_login=account.google_login,
        twitch_login=account.twitch_login,
    )

    log_fn(f"[prepare] {account.google_login} — старт")
    dnconsole = find_dnconsole(config.ldplayer_home)
    ld = LdConsole(dnconsole, config.emulator_index, log_fn)
    device = None

    try:
        try:
            device = connect_device(
                ld,
                adb_port=config.adb_port,
                delay_min=config.delay_min_sec,
                delay_max=config.delay_max_sec,
                retries=4,
            )
        except RuntimeError as exc:
            if not config.auto_find_emulator:
                raise
            log_fn("ADB авто-поиск эмулятора...")
            device, found_index = scan_working_emulator(
                config.ldplayer_home,
                prefer_index=config.emulator_index,
                log_fn=log_fn,
            )
            if device is None:
                raise RuntimeError("Эмулятор не отвечает по ADB") from exc
            ld = LdConsole(dnconsole, found_index or config.emulator_index, log_fn)

        log_fn("Иконка Standoff 2...")
        step_launch_standoff_from_home(device, config)

        log_fn("Вход Google в игре...")
        step_standoff_login(device, account, config)

        log_fn("Лобби открыто — снимаем handshake...")
        handshake = extract_handshake(device.shell, log_fn=log_fn)

        upsert_handshake(out_path, account, handshake)
        append_token_log(TOKENS_LOG, account.google_login, handshake)

        result.message = f"handshake saved ({len(handshake)} chars)"
        _append_log(PREPARE_LOG, f"ok google={account.google_login} len={len(handshake)}")
        log_fn(f"[prepare] OK → {out_path.name} (+ {TOKENS_LOG.name})")
        return result

    except Exception as exc:
        result.message = str(exc)
        _append_log(PREPARE_LOG, f"err google={account.google_login} | {exc}")
        log_fn(f"[prepare] Ошибка: {exc}")
        raise

    finally:
        if device is not None:
            try:
                _cleanup(device, ld)
            except Exception:
                pass
        time.sleep(1)
