"""
TOTP (Time-based One-Time Password) helper.

The 2FA secret key stored in your accounts file is the same Base32 seed that
authenticator apps (Google Authenticator, Authy, etc.) use.  We generate the
current 6-digit code locally with `pyotp` — no external website needed.

How to find your secret key
----------------------------
If you exported accounts from an authenticator app you usually get the seed
directly.  If you only have a QR-code URL it looks like:
    otpauth://totp/Google%3Ayou%40gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google
The value after `secret=` is the seed to paste in your accounts.txt.
"""

import time
import pyotp


def get_totp_code(secret: str) -> str:
    """
    Return the current 6-digit TOTP code for *secret*.

    The secret must be a Base32-encoded string (letters A–Z, digits 2–7).
    Spaces and hyphens are stripped automatically.
    """
    secret = secret.strip().replace(" ", "").replace("-", "").upper()
    totp = pyotp.TOTP(secret)
    return totp.now()


def get_totp_code_with_validity(secret: str) -> tuple[str, int]:
    """
    Return (code, seconds_remaining) so callers can decide whether to wait
    for the next window before submitting the code.
    """
    secret = secret.strip().replace(" ", "").replace("-", "").upper()
    totp = pyotp.TOTP(secret)
    code = totp.now()
    remaining = 30 - (int(time.time()) % 30)
    return code, remaining


def verify_secret(secret: str) -> bool:
    """Basic sanity-check: try to generate a code without crashing."""
    try:
        get_totp_code(secret)
        return True
    except Exception:
        return False
