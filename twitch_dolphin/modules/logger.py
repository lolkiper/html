import logging
import re
from pathlib import Path


class _PasswordFilter(logging.Filter):
    """Prevent accidental password leakage in log records."""

    _PASSWORD_PATTERNS = [
        re.compile(r"(password\s*[:=]\s*)(\S+)", re.IGNORECASE),
        re.compile(r"(passwd\s*[:=]\s*)(\S+)", re.IGNORECASE),
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            msg = record.msg
            for pattern in self._PASSWORD_PATTERNS:
                msg = pattern.sub(r"\1********", msg)
            record.msg = msg
        if record.args:
            record.args = tuple(
                "********" if isinstance(a, str) and "password" in str(a).lower() else a
                for a in record.args
            )
        return True


def setup_logger(log_dir: str = "logs", name: str = "twitch_dolphin") -> logging.Logger:
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    logger.addFilter(_PasswordFilter())

    formatter = logging.Formatter(
        "%(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = logging.FileHandler(Path(log_dir) / "app.log", encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.addFilter(_PasswordFilter())

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    console_handler.addFilter(_PasswordFilter())

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    return logger


def mask_password(password: str) -> str:
    return "********" if password else ""
