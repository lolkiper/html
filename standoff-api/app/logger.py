"""Structured console/file logging in farm style."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TextIO


class FarmLogger:
    def __init__(
        self,
        *,
        console: TextIO | None = None,
        log_file: Path | None = None,
    ) -> None:
        self.console = console or sys.stdout
        self.log_file = log_file
        if log_file:
            log_file.parent.mkdir(parents=True, exist_ok=True)

    def _write(self, line: str) -> None:
        self.console.write(line + "\n")
        self.console.flush()
        if self.log_file:
            with self.log_file.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")

    def tag(self, tag: str, message: str) -> None:
        self._write(f"[{tag}] {message}")

    def farm(self, message: str) -> None:
        self.tag("farm", message)

    def standoff(self, message: str) -> None:
        self.tag("standoff", message)

    def twitch(self, message: str) -> None:
        self.tag("twitch", message)

    def market(self, message: str) -> None:
        self.tag("market", message)

    def cycle_start(self, cycle_no: int, total: int, *, repeat: bool) -> None:
        repeat_label = "repeat" if repeat else "no repeat"
        self.twitch(f"cycle {cycle_no} start: {total} accounts, {repeat_label}")

    def cycle_complete(
        self,
        cycle_no: int,
        *,
        processed: int,
        total: int,
        ok: int,
        errors: int,
        sent_gold: float,
        net_gold: float,
        elapsed_sec: float,
        repeat: bool,
    ) -> None:
        repeat_label = "repeat" if repeat else "no repeat"
        self.farm(
            f"cycle {cycle_no} complete: processed {processed}/{total}, "
            f"ok={ok}, errors={errors}, "
            f"sent={sent_gold:.2f}G, net≈{net_gold:.2f}G, "
            f"time={elapsed_sec:.1f}s, {repeat_label}"
        )

    def account_start(self, idx: int, total: int, google: str, twitch: str) -> None:
        self.standoff(f"{idx}/{total} google={google} | twitch={twitch} | starting...")

    def account_ok(
        self,
        idx: int,
        total: int,
        google: str,
        *,
        twitch_linked: bool,
        cases_sold: int,
        gold_gross: float,
        gold_net: float,
        elapsed_sec: float,
    ) -> None:
        link = "linked" if twitch_linked else "skip-link"
        self.standoff(
            f"{idx}/{total} google={google} | done ok | {link} | "
            f"sold={cases_sold} | gross={gold_gross:.2f}G net≈{gold_net:.2f}G | "
            f"time={elapsed_sec:.1f}s"
        )

    def account_error(self, idx: int, total: int, google: str, error: str) -> None:
        short = error.replace("\n", " ")[:120]
        self.standoff(f"{idx}/{total} google={google} | ERROR: {short}")

    def step(self, tag: str, idx: int, total: int, message: str) -> None:
        self.tag(tag, f"{idx}/{total} {message}")
