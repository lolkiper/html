"""Run full account pipeline on LDPlayer."""

from __future__ import annotations

import time
import traceback
from datetime import datetime

from app.adb.ldplayer import LdConsole, STANDOFF_PACKAGE, find_dnconsole
from app.config import ERRORS_LOG, SUCCESS_LOG, AppConfig
from app.models import AccountCredentials, CreateJobRequest, JobResult
from app.steps.google_login import step_google_account
from app.steps.sell_cases import step_sell_cases
from app.steps.standoff_login import step_standoff_login
from app.steps.twitch_bind import step_twitch_bind


def _append_log(path, line: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"[{stamp}] {line}\n")


def _cleanup(device, google_login: str, ld: LdConsole) -> None:
    try:
        device.shell(f"am force-stop {STANDOFF_PACKAGE}")
        device.shell(f"pm clear {STANDOFF_PACKAGE}")
        device.shell("pm clear com.google.android.gms")
    except Exception:
        pass
    try:
        ld.quit()
    except Exception:
        pass


def run_pipeline(job: CreateJobRequest, config: AppConfig, log_fn=print) -> JobResult:
    account = job.account
    opts = job.options
    result = JobResult(
        google_login=account.google_login,
        twitch_login=account.twitch_login,
    )

    dnconsole = find_dnconsole(config.ldplayer_home)
    ld = LdConsole(dnconsole, config.emulator_index, log_fn)
    device = None

    try:
        log_fn("Сброс device ID и запуск LDPlayer...")
        ld.randomize_device_ids()
        device = ld.connect_device(config.delay_min_sec, config.delay_max_sec)

        log_fn("Шаг 1/4: Google аккаунт...")
        step_google_account(device, account)

        log_fn("Шаг 2/4: Вход в Standoff 2...")
        step_standoff_login(device)

        if opts.link_twitch:
            log_fn("Шаг 3/4: Привязка Twitch...")
            result.twitch_linked = step_twitch_bind(
                device,
                account,
                skip_if_linked=opts.skip_twitch_if_linked,
            )
        else:
            result.twitch_linked = False
            log_fn("Шаг 3/4: Привязка Twitch пропущена")

        if opts.sell_cases:
            log_fn("Шаг 4/4: Продажа кейсов...")
            sold, gold = step_sell_cases(
                device,
                min_price=opts.sell_min_price,
                max_items=opts.sell_max_items,
            )
            result.cases_sold = sold
            result.gold_earned = gold
        else:
            log_fn("Шаг 4/4: Продажа кейсов пропущена")

        result.message = "OK"
        _append_log(
            SUCCESS_LOG,
            f"google={account.google_login} twitch={account.twitch_login} "
            f"linked={result.twitch_linked} sold={result.cases_sold}",
        )
        log_fn("Готово.")
        return result

    except Exception as exc:
        result.message = str(exc)
        _append_log(
            ERRORS_LOG,
            f"google={account.google_login} twitch={account.twitch_login} | {exc}",
        )
        log_fn(f"Ошибка: {exc}\n{traceback.format_exc()}")
        raise

    finally:
        if device is not None:
            try:
                _cleanup(device, account.google_login, ld)
            except Exception:
                pass
        time.sleep(2)
