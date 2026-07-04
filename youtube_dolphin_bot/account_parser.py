"""
Parse accounts and proxies from flat text files.

Accounts file format (one account per line):
    email:password:totp_secret
    email:password:totp_secret:proxy_string
    email|password|totp_secret
    email|password|totp_secret|proxy_string

Lines starting with '#' are treated as comments and skipped.
Empty lines are skipped.

Proxies file format (one proxy per line):
    socks5://user:pass@host:port
    http://host:port
    host:port:user:pass
    host:port

Proxies are assigned to accounts round-robin if not embedded in the accounts
file itself.
"""

import csv
import logging
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class Account:
    email: str
    password: str
    totp_secret: str = ""
    proxy_str: str = ""
    profile_id: str = ""      # filled in after Dolphin profile creation
    status: str = "pending"   # pending / success / failed
    note: str = ""


def _detect_separator(line: str) -> str:
    for sep in (":", "|", ";", "\t"):
        if sep in line:
            return sep
    return ":"


def load_accounts(filepath: str | Path) -> list[Account]:
    """Load accounts from a text file."""
    accounts: list[Account] = []
    path = Path(filepath)

    if not path.exists():
        raise FileNotFoundError(f"Accounts file not found: {path}")

    with path.open(encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            sep = _detect_separator(line)
            parts = line.split(sep)

            if len(parts) < 2:
                logger.warning(f"Skipping malformed line: {line!r}")
                continue

            email = parts[0].strip()
            password = parts[1].strip()
            totp_secret = parts[2].strip() if len(parts) > 2 else ""
            proxy_str = parts[3].strip() if len(parts) > 3 else ""

            accounts.append(Account(
                email=email,
                password=password,
                totp_secret=totp_secret,
                proxy_str=proxy_str,
            ))

    logger.info(f"Loaded {len(accounts)} accounts from {path}")
    return accounts


def load_proxies(filepath: str | Path) -> list[str]:
    """Load proxy strings from a text file (one per line)."""
    path = Path(filepath)
    if not path.exists():
        return []

    proxies = []
    with path.open(encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if line and not line.startswith("#"):
                proxies.append(line)

    logger.info(f"Loaded {len(proxies)} proxies from {path}")
    return proxies


def assign_proxies(accounts: list[Account], proxies: list[str]) -> None:
    """
    For accounts that don't already have a proxy assigned, distribute
    the proxies list round-robin.
    """
    if not proxies:
        return

    unassigned = [a for a in accounts if not a.proxy_str]
    for i, account in enumerate(unassigned):
        account.proxy_str = proxies[i % len(proxies)]
