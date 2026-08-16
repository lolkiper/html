"""Keyboard input plus the global F8 / F9 safety hotkeys.

Text typed through :class:`Keyboard` is never written to the log: only its
length is reported, and values wrapped in :class:`logger.Secret` stay redacted
everywhere.
"""

from __future__ import annotations

import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol, Sequence

from i18n import tr
from logger import EventLog, Secret, get_logger, mask_text
from safety import SafetyController

IS_WINDOWS = sys.platform.startswith("win")

#: Human readable aliases mapped to PyAutoGUI key names.
KEY_ALIASES: dict[str, str] = {
    "esc": "esc", "escape": "esc", "return": "enter", "enter": "enter",
    "back": "backspace", "backspace": "backspace", "del": "delete", "delete": "delete",
    "ins": "insert", "pgup": "pageup", "pgdn": "pagedown", "spacebar": "space",
    "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift",
    "win": "win", "super": "win", "cmd": "win", "meta": "win",
    "up": "up", "down": "down", "left": "left", "right": "right",
    "home": "home", "end": "end", "tab": "tab", "space": "space",
    "printscreen": "printscreen", "capslock": "capslock",
}
#: Android specific keys reachable through the LDPlayer key bindings.
ANDROID_KEYS = {"back": "esc", "home": "f1", "menu": "f2", "volume_up": "f3", "volume_down": "f4"}

VIRTUAL_KEYS: dict[str, int] = {f"f{index}": 0x70 + index - 1 for index in range(1, 13)}
VIRTUAL_KEYS.update({"esc": 0x1B, "space": 0x20, "enter": 0x0D, "tab": 0x09, "pause": 0x13})


class KeyboardBackend(Protocol):
    name: str

    def press(self, key: str, presses: int = 1, interval: float = 0.05) -> None: ...
    def key_down(self, key: str) -> None: ...
    def key_up(self, key: str) -> None: ...
    def hotkey(self, keys: Sequence[str]) -> None: ...
    def type_text(self, text: str, interval: float = 0.02) -> None: ...


@dataclass
class KeyEvent:
    """A recorded keyboard operation (dry-run mode and tests)."""

    kind: str
    keys: tuple[str, ...] = ()
    length: int = 0
    at: float = field(default_factory=time.time)


def normalize_key(key: str) -> str:
    cleaned = (key or "").strip().lower()
    return KEY_ALIASES.get(cleaned, cleaned)


def parse_hotkey(combination: str | Sequence[str]) -> tuple[str, ...]:
    """``"ctrl+shift+s"`` (or a list) -> normalised key tuple."""
    if isinstance(combination, str):
        parts = [part for part in combination.replace(" ", "").split("+") if part]
    else:
        parts = list(combination)
    return tuple(normalize_key(part) for part in parts)


class PyAutoGuiKeyboard:
    name = "pyautogui"

    def __init__(self, log: EventLog | None = None) -> None:
        self.log = log or get_logger()
        try:
            import pyautogui
        except Exception as exc:  # pragma: no cover - optional dependency
            raise RuntimeError(f"PyAutoGUI is not available: {exc}") from exc
        pyautogui.PAUSE = 0.0
        self._gui = pyautogui

    def press(self, key: str, presses: int = 1, interval: float = 0.05) -> None:
        self._gui.press(normalize_key(key), presses=presses, interval=interval)

    def key_down(self, key: str) -> None:
        self._gui.keyDown(normalize_key(key))

    def key_up(self, key: str) -> None:
        self._gui.keyUp(normalize_key(key))

    def hotkey(self, keys: Sequence[str]) -> None:
        self._gui.hotkey(*[normalize_key(key) for key in keys])

    def type_text(self, text: str, interval: float = 0.02) -> None:
        raw = text.reveal() if isinstance(text, Secret) else str(text)
        ascii_part = all(ord(char) < 128 for char in raw)
        if ascii_part:
            self._gui.typewrite(raw, interval=interval)
            return
        for char in raw:  # non ASCII: PyAutoGUI cannot type it directly
            if ord(char) < 128:
                self._gui.typewrite(char, interval=interval)
            else:
                self._paste(char)

    def _paste(self, text: str) -> None:  # pragma: no cover - clipboard dependent
        try:
            import pyperclip

            previous = pyperclip.paste()
            pyperclip.copy(text)
            self._gui.hotkey("ctrl", "v")
            time.sleep(0.05)
            pyperclip.copy(previous)
        except Exception:
            self.log.warning("Could not type a non-ASCII character (install pyperclip)")


class RecordingKeyboard:
    name = "recording"

    def __init__(self) -> None:
        self.events: list[KeyEvent] = []

    def press(self, key: str, presses: int = 1, interval: float = 0.05) -> None:
        self.events.append(KeyEvent("press", (normalize_key(key),) * max(1, presses)))

    def key_down(self, key: str) -> None:
        self.events.append(KeyEvent("down", (normalize_key(key),)))

    def key_up(self, key: str) -> None:
        self.events.append(KeyEvent("up", (normalize_key(key),)))

    def hotkey(self, keys: Sequence[str]) -> None:
        self.events.append(KeyEvent("hotkey", tuple(normalize_key(key) for key in keys)))

    def type_text(self, text: str, interval: float = 0.02) -> None:
        raw = text.reveal() if isinstance(text, Secret) else str(text)
        self.events.append(KeyEvent("type", (), len(raw)))

    def clear(self) -> None:
        self.events.clear()


def create_keyboard_backend(name: str = "auto", log: EventLog | None = None) -> KeyboardBackend:
    log = log or get_logger()
    name = (name or "auto").lower()
    if name in ("recording", "dry-run", "dryrun", "none"):
        return RecordingKeyboard()
    try:
        return PyAutoGuiKeyboard(log=log)
    except Exception as exc:
        if name in ("pyautogui", "real"):
            raise
        log.warning("Keyboard input disabled (%s); running in dry-run mode", exc)
        return RecordingKeyboard()


class Keyboard:
    """Keyboard facade with safety checks and redacted logging."""

    def __init__(
        self,
        window: Any,
        safety: SafetyController,
        backend: KeyboardBackend | str = "auto",
        log: EventLog | None = None,
        focus_window: bool = True,
    ) -> None:
        self.window = window
        self.safety = safety
        self.log = log or get_logger()
        self.backend: KeyboardBackend = (
            create_keyboard_backend(backend, self.log) if isinstance(backend, str) else backend
        )
        self.focus_window = focus_window

    def set_window(self, window: Any) -> None:
        self.window = window

    @property
    def is_dry_run(self) -> bool:
        return isinstance(self.backend, RecordingKeyboard)

    def _prepare(self, key: str) -> bool:
        decision = self.safety.authorize_input(self.window, key=key)
        if not decision.allowed:
            return False
        if self.focus_window and self.window is not None and not self.is_dry_run:
            if not self.window.is_foreground():
                self.window.activate()
                time.sleep(0.05)
        return True

    def press_key(self, key: str, presses: int = 1, interval: float = 0.05) -> bool:
        key_name = normalize_key(key)
        if not self._prepare(f"key:{key_name}"):
            return False
        self.backend.press(key_name, presses=presses, interval=interval)
        self.safety.note_action(f"key:{key_name}")
        self.log.info("Key press: %s%s", key_name, f" x{presses}" if presses > 1 else "")
        return True

    def hotkey(self, combination: str | Sequence[str]) -> bool:
        keys = parse_hotkey(combination)
        if not keys:
            return False
        label = "+".join(keys)
        if not self._prepare(f"hotkey:{label}"):
            return False
        self.backend.hotkey(keys)
        self.safety.note_action(f"hotkey:{label}")
        self.log.info("Hotkey: %s", label)
        return True

    def type_text(self, text: str, interval: float = 0.02, sensitive: bool = False) -> bool:
        raw = text.reveal() if isinstance(text, Secret) else str(text)
        if not raw:
            return True
        if not self._prepare("type"):
            return False
        if sensitive:
            self.log.register_secret(raw)
        self.backend.type_text(raw, interval=interval)
        self.safety.note_action("type")
        self.log.info(
            "Typed text (%s)", mask_text(raw) if sensitive else tr("%s chars") % len(raw)
        )
        return True

    def clear_field(self, select_all: bool = True) -> bool:
        if select_all:
            return self.hotkey("ctrl+a") and self.press_key("delete")
        return self.press_key("backspace", presses=40, interval=0.01)


class HotkeyManager:
    """Process wide hotkeys: F8 start/pause, F9 emergency stop.

    On Windows the keys are registered with ``RegisterHotKey`` so they work while
    LDPlayer has the focus.  Elsewhere (and when registration fails) the GUI
    still binds the same keys on its own window.
    """

    def __init__(self, log: EventLog | None = None) -> None:
        self.log = log or get_logger()
        self._bindings: dict[str, Callable[[], None]] = {}
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.active = False
        self.global_hotkeys = False

    def bind(self, key: str, callback: Callable[[], None]) -> None:
        self._bindings[normalize_key(key)] = callback

    def trigger(self, key: str) -> bool:
        """Invoke a binding manually (used by the GUI and the tests)."""
        callback = self._bindings.get(normalize_key(key))
        if callback is None:
            return False
        try:
            callback()
        except Exception as exc:  # pragma: no cover - callback safety
            self.log.error("Hotkey handler failed: %s", exc)
        return True

    def start(self) -> bool:
        if self.active:
            return self.global_hotkeys
        self.active = True
        self._stop.clear()
        if not IS_WINDOWS:
            self.log.debug("Global hotkeys need Windows; using window-level bindings")
            return False
        self._thread = threading.Thread(target=self._run_windows, name="hotkeys", daemon=True)
        self._thread.start()
        time.sleep(0.05)
        return self.global_hotkeys

    def stop(self) -> None:
        self._stop.set()
        self.active = False
        thread = self._thread
        if thread is not None and thread.is_alive():  # pragma: no cover - Windows only
            thread.join(timeout=1.0)
        self._thread = None

    def _run_windows(self) -> None:  # pragma: no cover - Windows only
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        MOD_NOREPEAT = 0x4000
        WM_HOTKEY = 0x0312
        registered: dict[int, str] = {}
        for index, key in enumerate(sorted(self._bindings), start=1):
            code = VIRTUAL_KEYS.get(key)
            if code is None:
                self.log.warning("Hotkey '%s' cannot be registered globally", key)
                continue
            if user32.RegisterHotKey(None, index, MOD_NOREPEAT, code):
                registered[index] = key
            else:
                self.log.warning("Windows refused to register the %s hotkey", key.upper())
        self.global_hotkeys = bool(registered)
        if registered:
            self.log.info("Global hotkeys active: %s", ", ".join(
                key.upper() for key in registered.values()))
        message = wintypes.MSG()
        try:
            while not self._stop.is_set():
                if user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                    if message.message == WM_HOTKEY:
                        key = registered.get(int(message.wParam))
                        if key:
                            self.trigger(key)
                else:
                    time.sleep(0.02)
        finally:
            for index in registered:
                user32.UnregisterHotKey(None, index)
            self.global_hotkeys = False


def install_safety_hotkeys(
    safety: SafetyController,
    manager: HotkeyManager | None = None,
    log: EventLog | None = None,
    on_change: Callable[[str], None] | None = None,
) -> HotkeyManager:
    """Wire F8 (start/pause) and F9 (emergency stop) to the safety controller."""
    manager = manager or HotkeyManager(log=log)

    def toggle() -> None:
        state = safety.toggle_pause()
        if on_change is not None:
            on_change(state)

    def stop() -> None:
        safety.emergency_stop("F9 pressed")
        if on_change is not None:
            on_change(safety.state)

    manager.bind("f8", toggle)
    manager.bind("f9", stop)
    return manager
