"""Batch prepare: emulator login → handshake for many accounts."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from app.accounts_store import load_accounts_needing_prepare
from app.config import PREPARE_LOG, AppConfig
from app.logger import FarmLogger
from app.models import AccountCredentials, CreateJobRequest, JobOptions
from app.pipeline_prepare import run_prepare_pipeline


@dataclass
class PrepareStats:
    total: int = 0
    processed: int = 0
    ok: int = 0
    errors: int = 0
    elapsed_sec: float = 0.0
    failed_accounts: list[str] = field(default_factory=list)


def run_prepare(
    accounts: list[AccountCredentials],
    config: AppConfig,
    *,
    accounts_out: Path | None = None,
    logger: FarmLogger | None = None,
) -> PrepareStats:
    log = logger or FarmLogger(log_file=PREPARE_LOG)
    stats = PrepareStats(total=len(accounts))
    t0 = time.perf_counter()

    log.standoff(f"prepare start: {len(accounts)} accounts (нужен handshake)")

    for idx, account in enumerate(accounts, start=1):
        stats.processed = idx
        log.standoff(f"{idx}/{len(accounts)} {account.google_login} | getting token...")

        def step_log(msg: str) -> None:
            log.standoff(f"{idx}/{len(accounts)} {msg}")

        try:
            run_prepare_pipeline(
                CreateJobRequest(account=account, options=JobOptions(link_twitch=False, sell_cases=False)),
                config,
                log_fn=step_log,
                accounts_out=accounts_out,
            )
            stats.ok += 1
            log.standoff(f"{idx}/{len(accounts)} {account.google_login} | token OK")
        except Exception as exc:
            stats.errors += 1
            stats.failed_accounts.append(account.google_login)
            log.standoff(f"{idx}/{len(accounts)} {account.google_login} | ERROR: {exc}")

    stats.elapsed_sec = time.perf_counter() - t0
    log.standoff(
        f"prepare done: ok={stats.ok} err={stats.errors} time={stats.elapsed_sec:.1f}s"
    )
    return stats
