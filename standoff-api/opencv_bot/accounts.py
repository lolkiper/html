"""accounts.txt — email:password, done.txt / error.txt tracking."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from opencv_bot.bot_config import BOT_DIR, BotConfig


@dataclass
class Account:
    email: str
    password: str

    @property
    def line(self) -> str:
        return f"{self.email}:{self.password}"


def _read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    return lines


def load_pending_accounts(cfg: BotConfig) -> list[Account]:
    path = BOT_DIR / cfg.accounts_file
    done = set(_read_lines(BOT_DIR / cfg.done_file))
    errors = set(_read_lines(BOT_DIR / cfg.error_file))
    skip = done | errors
    accounts: list[Account] = []
    for line in _read_lines(path):
        if line in skip:
            continue
        if ":" not in line:
            continue
        email, password = line.split(":", 1)
        email, password = email.strip(), password.strip()
        if email and password:
            accounts.append(Account(email=email, password=password))
    return accounts


def append_result(cfg: BotConfig, filename: str, account: Account, note: str = "") -> None:
    path = BOT_DIR / filename
    stamp = account.line
    if note:
        stamp = f"{stamp}  # {note}"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(stamp + "\n")


def mark_done(cfg: BotConfig, account: Account, note: str = "") -> None:
    append_result(cfg, cfg.done_file, account, note)


def mark_error(cfg: BotConfig, account: Account, note: str = "") -> None:
    append_result(cfg, cfg.error_file, account, note)
