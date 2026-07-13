"""Parse accounts.txt and batch job helper."""

from __future__ import annotations

from pathlib import Path

from app.models import AccountCredentials, CreateJobRequest, JobOptions


def parse_account_line(line: str) -> AccountCredentials:
    parts = line.strip().split(":")
    if len(parts) < 4:
        raise ValueError(
            "Формат: google_login:google_pass:twitch_login:twitch_pass"
        )
    return AccountCredentials(
        google_login=parts[0].strip(),
        google_password=parts[1].strip(),
        twitch_login=parts[2].strip(),
        twitch_password=":".join(parts[3:]).strip(),
    )


def load_accounts_file(path: Path) -> list[AccountCredentials]:
    if not path.is_file():
        return []
    out: list[AccountCredentials] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
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
