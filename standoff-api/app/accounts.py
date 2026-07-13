"""Parse accounts.txt and batch job helper."""

from __future__ import annotations

from pathlib import Path

from app.models import AccountCredentials, CreateJobRequest, JobOptions
from app.text_io import read_text_auto


def parse_account_line(line: str) -> AccountCredentials:
    parts = line.strip().split(":")
    if len(parts) < 4:
        raise ValueError(
            "Формат: google_login:google_pass:twitch_login:twitch_pass"
            "[:handshake][:twitch_auth_code]"
        )
    creds = AccountCredentials(
        google_login=parts[0].strip(),
        google_password=parts[1].strip(),
        twitch_login=parts[2].strip(),
        twitch_password=parts[3].strip(),
    )
    if len(parts) > 4 and parts[4].strip():
        creds.handshake = parts[4].strip()
    if len(parts) > 5 and parts[5].strip():
        creds.twitch_auth_code = parts[5].strip()
    return creds


def load_accounts_file(path: Path) -> list[AccountCredentials]:
    if not path.is_file():
        return []
    out: list[AccountCredentials] = []
    for raw in read_text_auto(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(parse_account_line(line))
    return out


def to_job_request(
    account: AccountCredentials,
    options: JobOptions | None = None,
) -> CreateJobRequest:
    return CreateJobRequest(account=account, options=options or JobOptions())
