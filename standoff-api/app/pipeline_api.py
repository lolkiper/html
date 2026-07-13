"""API pipeline via Astandy — без LDPlayer/ADB."""

from __future__ import annotations

import time
from datetime import datetime

from app.api.marketplace import sell_cases
from app.api.session import run_astandy, with_client
from app.api.twitch import link_twitch
from app.config import ERRORS_LOG, SUCCESS_LOG, AppConfig
from app.models import CreateJobRequest, JobResult


def _append_log(path, line: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"[{stamp}] {line}\n")


async def _run_api_job_async(
    job: CreateJobRequest,
    config: AppConfig,
    log_fn=print,
) -> JobResult:
    account = job.account
    opts = job.options
    result = JobResult(
        google_login=account.google_login,
        twitch_login=account.twitch_login,
    )

    if not account.handshake:
        raise ValueError(
            "Для API-режима нужен handshake (5-й параметр в accounts.txt). "
            "Получи токен после входа в игру — см. https://github.com/BonePolk/AstandyClient"
        )

    log_fn(f"API: подключение handshake={account.handshake[:16]}...")

    async def _work(client):
        profile = await client.me()
        player = profile.player
        log_fn(f"API: аккаунт {player.name} (uid={player.uid})")

        if opts.link_twitch:
            if account.twitch_auth_code:
                result.twitch_linked = await link_twitch(
                    client,
                    account.twitch_auth_code,
                    game_id=config.game_id,
                    game_version=config.game_version,
                    log_fn=log_fn,
                )
            elif opts.skip_twitch_if_linked:
                log_fn("API: Twitch auth_code не задан — пропуск привязки")
                result.twitch_linked = False
            else:
                raise ValueError(
                    "Для привязки Twitch в API нужен twitch_auth_code (6-й параметр accounts.txt)"
                )
        else:
            result.twitch_linked = False
            log_fn("API: привязка Twitch отключена")

        if opts.sell_cases:
            log_fn("API: продажа кейсов на маркетплейсе...")
            sold, gold = await sell_cases(
                client,
                min_price=opts.sell_min_price,
                max_items=opts.sell_max_items,
                case_definition_ids=config.case_definition_ids or None,
                log_fn=log_fn,
            )
            result.cases_sold = sold
            result.gold_earned = gold
        else:
            log_fn("API: продажа кейсов отключена")

        return result

    result = await with_client(account.handshake, _work)
    result.message = "OK"
    _append_log(
        SUCCESS_LOG,
        f"api google={account.google_login} twitch={account.twitch_login} "
        f"linked={result.twitch_linked} sold={result.cases_sold}",
    )
    log_fn("API: готово.")
    return result


def run_api_pipeline(job: CreateJobRequest, config: AppConfig, log_fn=print) -> JobResult:
    account = job.account
    try:
        return run_astandy(_run_api_job_async(job, config, log_fn))
    except Exception as exc:
        _append_log(
            ERRORS_LOG,
            f"api google={account.google_login} twitch={account.twitch_login} | {exc}",
        )
        log_fn(f"API ошибка: {exc}")
        raise
    finally:
        time.sleep(0.3)
