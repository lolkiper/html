#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LDPlayer automation: Google + Standoff 2 + Twitch Drops cycle.

CLI:
    python main.py

GUI:
    python gui.py

Build:
    pip install -r requirements.txt
    pyinstaller --onefile --console main.py
    pyinstaller --onefile --windowed --name Standoff2Bot gui.py
"""

from __future__ import annotations

import os
import random
import re
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

# ---------------------------------------------------------------------------
# Paths & config
# ---------------------------------------------------------------------------

LogFn = Callable[[str], None]


@dataclass
class BotSettings:
    work_dir: Path
    ldplayer_home: Optional[Path] = None
    emulator_index: int = 0
    adb_host: str = "127.0.0.1"
    adb_port: Optional[int] = None

    def adb_port_resolved(self) -> int:
        if self.adb_port is not None:
            return self.adb_port
        return 5555 + self.emulator_index * 2

    @property
    def adb_serial(self) -> str:
        return f"{self.adb_host}:{self.adb_port_resolved()}"


@dataclass
class RuntimeCtx:
    settings: BotSettings
    log: LogFn = field(default=lambda msg: print(msg, flush=True))
    stop_event: threading.Event = field(default_factory=threading.Event)


_ctx = RuntimeCtx(settings=BotSettings(work_dir=Path(".")))

SCREEN_W = 1280
SCREEN_H = 720

ELEMENT_TIMEOUT_SEC = 60
DELAY_MIN = 1.5
DELAY_MAX = 3.0

GOOGLE_ACCOUNTS_FILE = "google_accs.txt"
TWITCH_ACCOUNTS_FILE = "twitch_accs.txt"
SUCCESS_LOG_FILE = "success_log.txt"
ERRORS_FILE = "errors.txt"

# Standoff 2 fixed coords (1280x720) — подстрой под свой билд при необходимости
COORD_GAME_LOAD_WAIT = (640, 360)       # экран загрузки / тап «продолжить»
COORD_LOGIN_GOOGLE = (640, 420)         # кнопка входа через Google в игре
COORD_LOBBY_SETTINGS = (1200, 40)       # шестерёнка настроек в лобби
COORD_SETTINGS_GAME_TAB = (400, 180)    # вкладка «Игра»
COORD_BIND_TWITCH = (640, 520)          # кнопка «Привязать Twitch»
COORD_LOGOUT_BTN = (640, 600)           # «Выйти» в настройках игры
COORD_CONFIRM_LOGOUT = (800, 450)       # подтверждение выхода

LDPLAYER_SEARCH_PATHS = [
    os.environ.get("LDPLAYER_HOME", ""),
    r"C:\LDPlayer\LDPlayer9",
    r"C:\LDPlayer\LDPlayer4",
    r"C:\Program Files\LDPlayer\LDPlayer9",
    r"D:\LDPlayer\LDPlayer9",
    os.path.expandvars(r"%PROGRAMFILES%\LDPlayer\LDPlayer9"),
    os.path.expandvars(r"%PROGRAMFILES(X86)%\LDPlayer\LDPlayer9"),
]


def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def count_lines(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip())


def rnd_delay() -> None:
    time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    _ctx.log(f"[{ts}] {msg}")


def check_stop() -> None:
    if _ctx.stop_event.is_set():
        raise InterruptedError("Остановлено пользователем")


# ---------------------------------------------------------------------------
# LDPlayer / ADB
# ---------------------------------------------------------------------------

class LdConsole:
    def __init__(self, exe: Path, index: int) -> None:
        self.exe = exe
        self.index = index

    def _run(
        self,
        *args: str,
        check: bool = True,
        quiet: bool = False,
    ) -> subprocess.CompletedProcess:
        cmd = [str(self.exe), *args]
        if not quiet:
            log(f"dnconsole: {' '.join(cmd[1:])}")
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=check,
        )

    def adb_shell(self, command: str) -> str:
        exe = str(self.exe)
        idx = self.index
        cwd = str(self.exe.parent)

        variants = [
            [exe, "adb", "--index", str(idx), "--command", f"shell {command}"],
            [exe, "adb", "--index", str(idx), "--command", command],
            [exe, "adb", "--name", f"LDPlayer-{idx}", "--command", f"shell {command}"],
        ]

        last_out = ""
        for args in variants:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                cwd=cwd,
            )
            last_out = ((result.stdout or "") + (result.stderr or "")).strip()
            if is_adb_ok(last_out):
                return last_out

        return last_out

    def quit(self) -> None:
        try:
            self._run("quit", "--index", str(self.index), check=False)
        except Exception:
            pass
        time.sleep(3)

    def run_app(self, package: str) -> None:
        self._run("runapp", "--index", str(self.index), "--packagename", package, check=False)
        time.sleep(3)

    def launch(self) -> None:
        self._run("launch", "--index", str(self.index), check=False)
        time.sleep(20)

    def randomize_device_ids(self) -> None:
        """IMEI / Android ID / MAC — только при выключенном инстансе."""
        self.quit()
        self._run(
            "modify",
            "--index",
            str(self.index),
            "--imei",
            "auto",
            "--androidid",
            "auto",
            "--mac",
            "auto",
            check=False,
        )
        log("ID эмулятора успешно изменены на новые.")
        self.launch()


def find_dnconsole(settings: BotSettings) -> Path:
    search = []
    if settings.ldplayer_home:
        search.append(str(settings.ldplayer_home))
    search.extend(LDPLAYER_SEARCH_PATHS)
    for p in search:
        if not p:
            continue
        folder = Path(p)
        for name in ("dnconsole.exe", "ldconsole.exe"):
            candidate = folder / name
            if candidate.is_file():
                return candidate
    raise FileNotFoundError(
        "dnconsole.exe / ldconsole.exe не найден. Укажи папку LDPlayer (не подпапку apps)."
    )


BAD_ADB_MARKERS = (
    "not found",
    "unknown command",
    "failed",
    "refused",
    "cannot connect",
    "no devices",
    "error:",
    "unauthorized",
    "offline",
)


def is_adb_ok(out: str) -> bool:
    if not out or not out.strip():
        return False
    low = out.lower()
    return not any(m in low for m in BAD_ADB_MARKERS)


def find_adb_exe(dnconsole: Path) -> Optional[Path]:
    folder = dnconsole.parent
    for name in ("adb.exe", "adb"):
        candidate = folder / name
        if candidate.is_file():
            return candidate
    return None


def guess_adb_ports(index: int) -> list[int]:
    ports = [
        5555 + index * 2,
        5554 + index * 2,
        5555 + index,
        5557 + index * 2,
    ]
    seen: set[int] = set()
    result: list[int] = []
    for p in ports:
        if p not in seen and p > 0:
            seen.add(p)
            result.append(p)
    return result


def adb_run(adb_exe: Path, *args: str) -> str:
    result = subprocess.run(
        [str(adb_exe), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        cwd=str(adb_exe.parent),
    )
    out = ((result.stdout or "") + (result.stderr or "")).strip()
    if out:
        log(f"adb {' '.join(args[:3])}... → {out[:180]}")
    return out


class DirectAdbDevice:
    def __init__(self, adb_exe: Path, serial: str) -> None:
        self.adb_exe = adb_exe
        self.serial = serial

    def shell(self, command: str) -> str:
        inner = command.removeprefix("shell ").strip()
        out = adb_run(self.adb_exe, "-s", self.serial, "shell", inner)
        return out


class DnconsoleDevice:
    """Fallback: dnconsole adb."""

    def __init__(self, ld: LdConsole) -> None:
        self.ld = ld

    def shell(self, command: str) -> str:
        inner = command.removeprefix("shell ").strip()
        return self.ld.adb_shell(inner)


def connect_device(
    settings: BotSettings,
    ld: LdConsole,
    adb_exe: Optional[Path] = None,
    retries: int = 15,
    pause: float = 4.0,
):
    host = settings.adb_host
    ports = guess_adb_ports(settings.emulator_index)
    if settings.adb_port is not None:
        ports.insert(0, settings.adb_port)

    log(f"Подключение ADB index={ld.index}, порты: {ports}")

    if adb_exe and adb_exe.is_file():
        adb_run(adb_exe, "start-server")
        for attempt in range(1, retries + 1):
            check_stop()
            for port in ports:
                serial = f"{host}:{port}"
                adb_run(adb_exe, "connect", serial)
                time.sleep(1)
                devices = adb_run(adb_exe, "devices")
                if serial in devices and "device" in devices:
                    dev = DirectAdbDevice(adb_exe, serial)
                    out = dev.shell("getprop ro.build.version.release")
                    if is_adb_ok(out) and any(ch.isdigit() for ch in out):
                        log(f"ADB подключён: {serial}, Android {out.strip()}")
                        return dev
            log(f"Прямой ADB: попытка {attempt}/{retries} — устройство не найдено")
            time.sleep(pause)

    log("Прямой ADB не сработал, пробую dnconsole adb...")
    dev = DnconsoleDevice(ld)
    for attempt in range(1, retries + 1):
        check_stop()
        out = dev.shell("getprop ro.build.version.release")
        if is_adb_ok(out) and any(ch.isdigit() for ch in out):
            log(f"ADB через dnconsole: Android {out.strip()}")
            return dev
        log(f"dnconsole adb: {out[:200] if out else '(пусто)'} [{attempt}/{retries}]")
        time.sleep(pause)

    raise TimeoutError(
        f"ADB не работает на index={ld.index}.\n"
        "В LDPlayer-10 открой: Настройки → Другие → ADB отладка → «Открыть локальное подключение».\n"
        "Эмулятор должен быть на рабочем столе (не в загрузке).\n"
        f"Проверка: C:\\LDPlayer\\LDPlayer9\\adb.exe connect 127.0.0.1:{ports[0]}"
    )


def shell(device, command: str) -> str:
    out = device.shell(command)
    result = out if isinstance(out, str) else out.decode("utf-8", errors="replace")
    if not is_adb_ok(result):
        log(f"ADB warn: {command[:60]} → {result[:120]}")
    return result


def tap(device, x: int, y: int, jitter: int = 3) -> None:
    jx = x + random.randint(-jitter, jitter)
    jy = y + random.randint(-jitter, jitter)
    shell(device, f"input tap {jx} {jy}")


def tap_coord(device, coord: tuple[int, int], jitter: int = 3) -> None:
    log(f"Клик по координатам [X:{coord[0]}, Y:{coord[1]}].")
    tap(device, coord[0], coord[1], jitter=jitter)
    rnd_delay()


def input_text(device, text: str) -> None:
    """Ввод через ADB input; спецсимволы экранируются."""
    safe = (
        text.replace("\\", "\\\\")
        .replace(" ", "%s")
        .replace("&", "\\&")
        .replace("<", "\\<")
        .replace(">", "\\>")
        .replace("|", "\\|")
        .replace(";", "\\;")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .replace("'", "\\'")
        .replace('"', '\\"')
        .replace("@", "\\@")
        .replace("#", "\\#")
        .replace("$", "\\$")
        .replace("*", "\\*")
        .replace("?", "\\?")
        .replace("`", "\\`")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace("{", "\\{")
        .replace("}", "\\}")
    )
    shell(device, f'input text "{safe}"')


def press_enter(device) -> None:
    shell(device, "input keyevent 66")


# ---------------------------------------------------------------------------
# UI Automator XML
# ---------------------------------------------------------------------------

BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


def uiautomator_dump(device) -> Optional[ET.Element]:
    dump_path = "/sdcard/window_dump.xml"
    shell(device, f"uiautomator dump {dump_path}")
    time.sleep(0.8)
    xml_raw = shell(device, f"cat {dump_path}")
    if not xml_raw or "<?xml" not in xml_raw:
        return None
    start = xml_raw.find("<?xml")
    try:
        return ET.fromstring(xml_raw[start:])
    except ET.ParseError:
        return None


def node_center(node: ET.Element) -> Optional[tuple[int, int]]:
    bounds = node.attrib.get("bounds", "")
    m = BOUNDS_RE.match(bounds)
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def node_matches(node: ET.Element, search_type: str, value: str) -> bool:
    val = value.lower()
    if search_type == "text":
        return val in (node.attrib.get("text") or "").lower()
    if search_type == "content-desc":
        return val in (node.attrib.get("content-desc") or "").lower()
    if search_type == "resource-id":
        return val in (node.attrib.get("resource-id") or "").lower()
    if search_type == "class":
        return val in (node.attrib.get("class") or "").lower()
    return False


def find_node(root: ET.Element, search_type: str, value: str) -> Optional[ET.Element]:
    for node in root.iter():
        if node_matches(node, search_type, value):
            if node.attrib.get("clickable", "false") == "true" or node.attrib.get("bounds"):
                return node
    for node in root.iter():
        if node_matches(node, search_type, value):
            return node
    return None


def click_by_ui_element(
    device,
    search_type: str,
    value: str,
    timeout: float = ELEMENT_TIMEOUT_SEC,
    jitter: int = 3,
) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        check_stop()
        root = uiautomator_dump(device)
        if root is not None:
            node = find_node(root, search_type, value)
            if node is not None:
                center = node_center(node)
                if center:
                    log(f'Элемент "{value}" найден. Клик.')
                    tap(device, center[0], center[1], jitter=jitter)
                    rnd_delay()
                    return True
        time.sleep(1.5)
    log(f'Timeout: элемент "{value}" ({search_type}) не найден за {timeout}s.')
    return False


def wait_for_element(
    device,
    search_type: str,
    value: str,
    timeout: float = ELEMENT_TIMEOUT_SEC,
) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        root = uiautomator_dump(device)
        if root is not None and find_node(root, search_type, value) is not None:
            return True
        time.sleep(1.5)
    return False


def fill_field_by_hint(
    device,
    hints: list[str],
    text: str,
) -> bool:
    """Клик по полю (по hint/text) и ввод."""
    for hint in hints:
        if click_by_ui_element(device, "text", hint, timeout=20):
            time.sleep(0.5)
            input_text(device, text)
            rnd_delay()
            return True
        if click_by_ui_element(device, "content-desc", hint, timeout=10):
            time.sleep(0.5)
            input_text(device, text)
            rnd_delay()
            return True
    root = uiautomator_dump(device)
    if root is not None:
        for node in root.iter():
            cls = node.attrib.get("class", "")
            if "EditText" in cls:
                center = node_center(node)
                if center:
                    tap(device, center[0], center[1])
                    time.sleep(0.4)
                    input_text(device, text)
                    rnd_delay()
                    return True
    return False


# ---------------------------------------------------------------------------
# Account files
# ---------------------------------------------------------------------------

@dataclass
class AccountPair:
    google_login: str
    google_password: str
    twitch_login: str
    twitch_password: str


def read_first_line(path: Path) -> Optional[str]:
    if not path.is_file():
        return None
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return lines[0] if lines else None


def pop_first_line(path: Path) -> None:
    if not path.is_file():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    remaining = [ln for ln in lines[1:] if ln.strip() or ln == ""]
    while remaining and not remaining[0].strip():
        remaining.pop(0)
    path.write_text("\n".join(remaining) + ("\n" if remaining else ""), encoding="utf-8")


def parse_credential(line: str) -> tuple[str, str]:
    if ":" not in line:
        raise ValueError(f"Неверный формат (ожидается login:password): {line!r}")
    login, password = line.split(":", 1)
    return login.strip(), password.strip()


def load_next_pair(root: Path) -> Optional[AccountPair]:
    g_line = read_first_line(root / GOOGLE_ACCOUNTS_FILE)
    t_line = read_first_line(root / TWITCH_ACCOUNTS_FILE)
    if not g_line or not t_line:
        return None
    g_login, g_pass = parse_credential(g_line)
    t_login, t_pass = parse_credential(t_line)
    return AccountPair(g_login, g_pass, t_login, t_pass)


def append_line(path: Path, line: str) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def mark_success(root: Path, pair: AccountPair) -> None:
    append_line(
        root / SUCCESS_LOG_FILE,
        f"google={pair.google_login} | twitch={pair.twitch_login} | {time.strftime('%Y-%m-%d %H:%M:%S')}",
    )
    pop_first_line(root / GOOGLE_ACCOUNTS_FILE)
    pop_first_line(root / TWITCH_ACCOUNTS_FILE)


def mark_error(root: Path, pair: AccountPair, reason: str) -> None:
    append_line(
        root / ERRORS_FILE,
        f"google={pair.google_login} | twitch={pair.twitch_login} | {reason} | {time.strftime('%Y-%m-%d %H:%M:%S')}",
    )
    pop_first_line(root / GOOGLE_ACCOUNTS_FILE)
    pop_first_line(root / TWITCH_ACCOUNTS_FILE)


# ---------------------------------------------------------------------------
# Workflow steps
# ---------------------------------------------------------------------------

def emergency_cleanup(device, google_email: str, ld: LdConsole) -> None:
    log("Аварийная зачистка...")
    try:
        shell(device, "am force-stop com.axlebolt.standoff2")
        shell(device, "pm clear com.axlebolt.standoff2")
        shell(device, "pm clear com.google.android.gms")
        log(f"Удаление аккаунта {google_email} с устройства.")
    except Exception as exc:
        log(f"cleanup shell error: {exc}")
    try:
        ld.quit()
    except Exception:
        pass


def step_google_account(device, pair: AccountPair, ld: LdConsole) -> None:
    ld.run_app("com.android.settings")
    time.sleep(2)

    intents = [
        "am start -a android.settings.ADD_ACCOUNT_SETTINGS",
        "am start -n com.android.settings/.accounts.AddAccountSettings",
        "am start -n com.android.settings/.accounts.ChooseAccountActivity",
    ]
    opened = False
    for intent in intents:
        shell(device, intent)
        time.sleep(3)
        if wait_for_element(device, "text", "Google", timeout=8):
            opened = True
            break
        if wait_for_element(device, "text", "Аккаунт", timeout=5):
            opened = True
            break
        if wait_for_element(device, "text", "Account", timeout=5):
            opened = True
            break

    if not opened:
        raise TimeoutError(
            "Не открылось окно аккаунтов Google. Включи ADB в LDPlayer-10: "
            "Настройки → Другие → ADB отладка → Открыть локальное подключение"
        )

    log("Окно настроек Android открыто.")
    rnd_delay()

    if not click_by_ui_element(device, "text", "Google"):
        if not click_by_ui_element(device, "text", "Гугл"):
            raise TimeoutError("Кнопка Google не найдена")

    rnd_delay()
    click_by_ui_element(device, "text", "Create account", timeout=15) or click_by_ui_element(
        device, "text", "Создать аккаунт", timeout=10
    )
    click_by_ui_element(device, "text", "For myself", timeout=10) or click_by_ui_element(
        device, "text", "Для себя", timeout=10
    )

    # Существующий аккаунт — «Войти» / Sign in
    if not click_by_ui_element(device, "text", "Sign in", timeout=15):
        click_by_ui_element(device, "text", "Войти", timeout=15)
    rnd_delay()

    if not fill_field_by_hint(
        device,
        ["Email or phone", "Phone or email", "Электронная почта", "Телефон или email"],
        pair.google_login,
    ):
        raise TimeoutError("Поле логина Google не найдено")
    click_by_ui_element(device, "text", "Next", timeout=15) or click_by_ui_element(
        device, "text", "Далее", timeout=15
    )
    rnd_delay()

    if not fill_field_by_hint(device, ["Enter your password", "Пароль", "Password"], pair.google_password):
        raise TimeoutError("Поле пароля Google не найдено")
    click_by_ui_element(device, "text", "Next", timeout=15) or click_by_ui_element(
        device, "text", "Далее", timeout=15
    )
    rnd_delay()

    # Пропуск доп. экранов (соглашения, резервный email и т.д.)
    for _ in range(5):
        if wait_for_element(device, "text", "I agree", timeout=5):
            click_by_ui_element(device, "text", "I agree", timeout=10)
        if wait_for_element(device, "text", "Accept", timeout=3):
            click_by_ui_element(device, "text", "Accept", timeout=10)
        if wait_for_element(device, "text", "Принимаю", timeout=3):
            click_by_ui_element(device, "text", "Принимаю", timeout=10)
        rnd_delay()

    log("Логин и пароль Google успешно введены.")
    time.sleep(3)
    log("Вход в Google выполнен. Запуск Standoff 2...")


def step_standoff2_login(device) -> None:
    shell(
        device,
        "am start -n com.axlebolt.standoff2/com.unity3d.player.UnityPlayerActivity",
    )
    time.sleep(random.uniform(8, 12))
    log("Игра загрузилась.")
    tap_coord(device, COORD_GAME_LOAD_WAIT)
    time.sleep(random.uniform(5, 8))
    tap_coord(device, COORD_LOGIN_GOOGLE)
    time.sleep(random.uniform(6, 10))
    # Выбор Google-аккаунта в системном диалоге
    click_by_ui_element(device, "text", "@", timeout=30) or tap_coord(device, (640, 360))
    rnd_delay()
    log("Лобби прогружено. Переход к привязке Twitch...")


def step_twitch_bind(device, pair: AccountPair) -> None:
    tap_coord(device, COORD_LOBBY_SETTINGS)
    time.sleep(2)
    tap_coord(device, COORD_SETTINGS_GAME_TAB)
    time.sleep(2)
    tap_coord(device, COORD_BIND_TWITCH)
    time.sleep(4)
    log(f"Окно Twitch открыто. Авторизация аккаунта {pair.twitch_login}...")

    if not fill_field_by_hint(
        device,
        ["Username", "Имя пользователя", "Логин", "Email", "Phone"],
        pair.twitch_login,
    ):
        raise TimeoutError("Поле логина Twitch не найдено")

    click_by_ui_element(device, "text", "Next", timeout=10) or click_by_ui_element(
        device, "text", "Далее", timeout=10
    ) or press_enter(device)
    rnd_delay()

    if not fill_field_by_hint(device, ["Password", "Пароль"], pair.twitch_password):
        raise TimeoutError("Поле пароля Twitch не найдено")

    # Фиолетовая кнопка авторизации Twitch
    if not click_by_ui_element(device, "text", "Log in", timeout=15):
        if not click_by_ui_element(device, "text", "Войти", timeout=10):
            if not click_by_ui_element(device, "text", "Authorize", timeout=10):
                click_by_ui_element(device, "text", "Авторизовать", timeout=10)

    time.sleep(random.uniform(5, 8))
    click_by_ui_element(device, "text", "Authorize", timeout=20) or click_by_ui_element(
        device, "text", "Авторизовать", timeout=15
    )
    time.sleep(5)
    log("Привязка успешна! Награда Twitch Drops собрана.")


def step_logout_and_cleanup(device, google_email: str) -> None:
    shell(
        device,
        "am start -n com.axlebolt.standoff2/com.unity3d.player.UnityPlayerActivity",
    )
    time.sleep(5)
    tap_coord(device, COORD_LOBBY_SETTINGS)
    time.sleep(2)
    tap_coord(device, COORD_LOGOUT_BTN)
    time.sleep(2)
    tap_coord(device, COORD_CONFIRM_LOGOUT)
    log("Выход с аккаунта в Standoff 2.")
    rnd_delay()

    shell(device, "am force-stop com.axlebolt.standoff2")
    shell(device, "pm clear com.axlebolt.standoff2")
    shell(device, "pm clear com.google.android.gms")
    log(f"Удаление аккаунта {google_email} с устройства.")
    log("Круг завершен.")


def run_cycle(root: Path, ld: LdConsole, pair: AccountPair, settings: BotSettings, adb_exe: Optional[Path]) -> None:
    device = None
    try:
        check_stop()
        ld.randomize_device_ids()
        device = connect_device(settings, ld, adb_exe=adb_exe)

        try:
            step_google_account(device, pair, ld)
        except Exception as exc:
            raise RuntimeError(f"Google: {exc}") from exc

        try:
            step_standoff2_login(device)
        except Exception as exc:
            raise RuntimeError(f"Standoff2: {exc}") from exc

        try:
            step_twitch_bind(device, pair)
        except Exception as exc:
            raise RuntimeError(f"Twitch: {exc}") from exc

        try:
            step_logout_and_cleanup(device, pair.google_login)
        except Exception as exc:
            raise RuntimeError(f"Logout: {exc}") from exc

        mark_success(root, pair)

    except Exception as exc:
        log(f"Критическая ошибка: {exc}")
        mark_error(root, pair, str(exc))
        if device is not None:
            emergency_cleanup(device, pair.google_login, ld)
        else:
            ld.quit()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_bot(
    settings: BotSettings,
    stop_event: threading.Event,
    log_fn: Optional[LogFn] = None,
) -> int:
    global _ctx
    _ctx = RuntimeCtx(
        settings=settings,
        log=log_fn or (lambda msg: print(msg, flush=True)),
        stop_event=stop_event,
    )

    root = settings.work_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    os.chdir(root)
    log(f"Рабочая папка: {root}")

    try:
        dnconsole = find_dnconsole(settings)
    except FileNotFoundError as exc:
        log(str(exc))
        return 1

    idx = settings.emulator_index
    ld = LdConsole(dnconsole, idx)
    adb_exe = find_adb_exe(dnconsole)
    log(f"LDPlayer: {dnconsole} | index={idx} | adb={settings.adb_serial}")

    while not stop_event.is_set():
        pair = load_next_pair(root)
        if pair is None:
            log("База аккаунтов пуста. Выход.")
            break

        log(f"=== Новый круг: Google={pair.google_login} | Twitch={pair.twitch_login} ===")
        try:
            run_cycle(root, ld, pair, settings, adb_exe)
        except InterruptedError:
            log("Цикл прерван.")
            break
        time.sleep(random.uniform(3, 6))

    return 0


def main() -> int:
    idx = int(os.environ.get("EMULATOR_INDEX", "0"))
    adb_env = os.environ.get("ADB_PORT", "").strip()
    ld_env = os.environ.get("LDPLAYER_HOME", "").strip()
    settings = BotSettings(
        work_dir=base_dir(),
        ldplayer_home=Path(ld_env) if ld_env else None,
        emulator_index=idx,
        adb_port=int(adb_env) if adb_env else None,
    )
    return run_bot(settings, threading.Event())


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log("Остановлено пользователем.")
        raise SystemExit(130)
