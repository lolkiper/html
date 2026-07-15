"""Load bot configuration from config.json."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parent


@dataclass
class BotConfig:
    adb_host: str = "127.0.0.1"
    adb_ports: list[int] = field(default_factory=lambda: [5555, 5554])
    ldplayer_home: str = r"C:\LDPlayer\LDPlayer9"
    emulator_index: int = 0
    screen_width: int = 1280
    screen_height: int = 720

    accounts_file: str = "accounts.txt"
    done_file: str = "done.txt"
    error_file: str = "error.txt"
    screenshots_dir: str = "screenshots"

    standoff_package: str = "com.axlebolt.standoff2"
    google_play_package: str = "com.google.android.gms"

    wait_timeout_sec: float = 15.0
    template_threshold: float = 0.78
    delay_after_tap_sec: float = 0.35
    delay_after_screen_sec: float = 0.5
    delay_ui_poll_sec: float = 0.4

    templates: dict[str, str] = field(default_factory=dict)
    coords: dict[str, list[int]] = field(default_factory=dict)
    ocr: dict[str, object] = field(default_factory=dict)
    max_cases_per_account: int = 50

    @classmethod
    def load(cls, path: Path | None = None) -> BotConfig:
        cfg_path = path or (BOT_DIR / "config.json")
        if not cfg_path.exists():
            cfg_path = BOT_DIR / "config.example.json"
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
        return cls(
            adb_host=str(data.get("ADB_HOST", "127.0.0.1")),
            adb_ports=[int(p) for p in data.get("ADB_PORTS", [5555, 5554])],
            ldplayer_home=str(data.get("LDPLAYER_HOME", r"C:\LDPlayer\LDPlayer9")),
            emulator_index=int(data.get("EMULATOR_INDEX", 0)),
            screen_width=int(data.get("SCREEN_WIDTH", 1280)),
            screen_height=int(data.get("SCREEN_HEIGHT", 720)),
            accounts_file=str(data.get("ACCOUNTS_FILE", "accounts.txt")),
            done_file=str(data.get("DONE_FILE", "done.txt")),
            error_file=str(data.get("ERROR_FILE", "error.txt")),
            screenshots_dir=str(data.get("SCREENSHOTS_DIR", "screenshots")),
            standoff_package=str(data.get("STANDOFF_PACKAGE", "com.axlebolt.standoff2")),
            google_play_package=str(data.get("GOOGLE_PLAY_PACKAGE", "com.google.android.gms")),
            wait_timeout_sec=float(data.get("WAIT_TIMEOUT_SEC", 15)),
            template_threshold=float(data.get("TEMPLATE_THRESHOLD", 0.78)),
            delay_after_tap_sec=float(data.get("DELAY_AFTER_TAP_SEC", 0.35)),
            delay_after_screen_sec=float(data.get("DELAY_AFTER_SCREEN_SEC", 0.5)),
            delay_ui_poll_sec=float(data.get("DELAY_UI_POLL_SEC", 0.4)),
            templates=dict(data.get("TEMPLATES", {})),
            coords={k: list(v) for k, v in dict(data.get("COORDS", {})).items()},
            ocr=dict(data.get("OCR", {})),
            max_cases_per_account=int(data.get("MAX_CASES_PER_ACCOUNT", 50)),
        )

    def path(self, *parts: str) -> Path:
        return BOT_DIR.joinpath(*parts)

    def template_path(self, key: str) -> Path:
        rel = self.templates.get(key, "")
        return BOT_DIR / rel if rel else BOT_DIR / "templates" / f"{key}.png"

    def coord(self, key: str, default: tuple[int, int] = (640, 360)) -> tuple[int, int]:
        raw = self.coords.get(key)
        if raw and len(raw) >= 2:
            return int(raw[0]), int(raw[1])
        return default

    def order_price_roi(self) -> tuple[int, int, int, int]:
        roi = self.ocr.get("order_price_roi", [420, 350, 860, 420])
        x1, y1, x2, y2 = [int(v) for v in roi]  # type: ignore[misc]
        return x1, y1, x2, y2
