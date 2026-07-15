"""Parse accounts.txt and batch job helper."""

from __future__ import annotations

from pathlib import Path

from app.models import AccountCredentials, CreateJobRequest, JobOptions
from app.text_io import read_text_auto


def _looks_like_handshake(value: str) -> bool:
    return len(value) > 40 and (value.startswith("eyJ") or value.count(".") >= 2)


def parse_account_line(line: str) -> AccountCredentials:
    parts = [p.strip() for p in line.strip().split(":")]
    if len(parts) < 2:
        raise ValueError(
            "Формат: google_login:google_pass "
            "или google:pass:twitch:twitch_pass[:handshake]"
        )

    creds = AccountCredentials(
        google_login=parts[0],
        google_password=parts[1],
    )

    if len(parts) == 2:
        return creds

    if len(parts) == 3:
        if _looks_like_handshake(parts[2]):
            creds.handshake = parts[2]
        else:
            creds.twitch_login = parts[2]
        return creds

    creds.twitch_login = parts[2]
    creds.twitch_password = parts[3]
    if len(parts) > 4 and parts[4]:
        creds.handshake = parts[4]
    if len(parts) > 5 and parts[5]:
        creds.twitch_auth_code = parts[5]
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
