"""Run batch of accounts as numbered cycles with summary stats."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from app.config import CYCLE_LOG, AppConfig
from app.logger import FarmLogger
from app.models import AccountCredentials, CreateJobRequest, JobOptions
from app.pipeline import run_pipeline


@dataclass
class CycleStats:
    cycle_no: int = 1
    total: int = 0
    processed: int = 0
    ok: int = 0
    errors: int = 0
    sent_gold: float = 0.0
    net_gold: float = 0.0
    elapsed_sec: float = 0.0
    repeat: bool = False
    failed_accounts: list[str] = field(default_factory=list)


def run_cycle(
    accounts: list[AccountCredentials],
    config: AppConfig,
    *,
    cycle_no: int = 1,
    options: JobOptions | None = None,
    repeat: bool = False,
    logger: FarmLogger | None = None,
) -> CycleStats:
    opts = options or JobOptions()
    log = logger or FarmLogger(log_file=CYCLE_LOG)
    stats = CycleStats(cycle_no=cycle_no, total=len(accounts), repeat=repeat)
    fee = config.market_fee_rate

    log.cycle_start(cycle_no, len(accounts), repeat=repeat)
    t0 = time.perf_counter()

    for idx, account in enumerate(accounts, start=1):
        stats.processed = idx
        log.account_start(idx, len(accounts), account.google_login, account.twitch_login)
        acc_t0 = time.perf_counter()

        def step_log(msg: str, step_idx=idx, step_total=len(accounts)) -> None:
            if msg.startswith("Шаг 3"):
                log.step("twitch", step_idx, step_total, msg.replace("Шаг 3/4: ", ""))
            elif msg.startswith("Шаг 4"):
                log.step("market", step_idx, step_total, msg.replace("Шаг 4/4: ", ""))
            elif "Ошибка" in msg or "FAILED" in msg:
                log.standoff(f"{step_idx}/{step_total} {msg[:100]}")

        try:
            result = run_pipeline(
                CreateJobRequest(account=account, options=opts),
                config,
                log_fn=step_log,
            )
            gross = float(result.gold_earned or 0.0)
            net = round(gross * fee, 2)
            elapsed = time.perf_counter() - acc_t0

            stats.ok += 1
            stats.sent_gold += gross
            stats.net_gold += net

            if result.twitch_linked:
                log.step("twitch", idx, len(accounts), f"bind {account.twitch_login}... ok")
            if result.cases_sold:
                log.step(
                    "market",
                    idx,
                    len(accounts),
                    f"sold={result.cases_sold} items, gross={gross:.2f}G",
                )

            log.account_ok(
                idx,
                len(accounts),
                account.google_login,
                twitch_linked=result.twitch_linked,
                cases_sold=result.cases_sold,
                gold_gross=gross,
                gold_net=net,
                elapsed_sec=elapsed,
            )
        except Exception as exc:
            stats.errors += 1
            stats.failed_accounts.append(account.google_login)
            log.account_error(idx, len(accounts), account.google_login, str(exc))

    stats.elapsed_sec = time.perf_counter() - t0
    log.cycle_complete(
        cycle_no,
        processed=stats.processed,
        total=stats.total,
        ok=stats.ok,
        errors=stats.errors,
        sent_gold=stats.sent_gold,
        net_gold=stats.net_gold,
        elapsed_sec=stats.elapsed_sec,
        repeat=repeat,
    )
    return stats
