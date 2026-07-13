"""Read/write accounts files with handshake upsert."""

from __future__ import annotations

from pathlib import Path

from app.accounts import parse_account_line
from app.models import AccountCredentials
from app.text_io import read_text_auto


def account_to_line(account: AccountCredentials) -> str:
    line = (
        f"{account.google_login}:{account.google_password}:"
        f"{account.twitch_login}:{account.twitch_password}"
    )
    if account.handshake:
        line += f":{account.handshake}"
        if account.twitch_auth_code:
            line += f":{account.twitch_auth_code}"
    return line


def load_accounts_raw(path: Path) -> list[AccountCredentials]:
    if not path.is_file():
        return []
    out: list[AccountCredentials] = []
    for raw in read_text_auto(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(parse_account_line(line))
    return out


def load_accounts_needing_prepare(path: Path) -> list[AccountCredentials]:
    return [a for a in load_accounts_raw(path) if not a.handshake]


def load_accounts_ready_for_farm(path: Path) -> list[AccountCredentials]:
    return [a for a in load_accounts_raw(path) if a.handshake]


def upsert_handshake(
    path: Path,
    account: AccountCredentials,
    handshake: str,
) -> None:
    account.handshake = handshake
    accounts = load_accounts_raw(path) if path.is_file() else []
    updated = False
    for idx, row in enumerate(accounts):
        if row.google_login.lower() == account.google_login.lower():
            accounts[idx] = account
            updated = True
            break
    if not updated:
        accounts.append(account)

    lines = [account_to_line(a) for a in accounts]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_token_log(path: Path, google_login: str, handshake: str) -> None:
    stamp_line = f"{google_login}:{handshake}\n"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(stamp_line)
