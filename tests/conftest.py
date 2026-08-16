"""Shared fixtures: a synthetic LDPlayer emulator that reacts to clicks.

Everything is generated in memory, so the whole engine (capture, recognition,
state machine, workflow, safety) can be tested without a real emulator and
without ever touching the disk.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ldplayer import LDPlayerWindow, StaticWindowBackend, WindowRect  # noqa: E402
from logger import EventLog, LogLevel  # noqa: E402
from mouse import Mouse, RecordingPointer  # noqa: E402
from keyboard import Keyboard, RecordingKeyboard  # noqa: E402
from ocr import OcrService, TextLine  # noqa: E402
from safety import SafetyController, SafetySettings  # noqa: E402
from screen_capture import WindowCapture  # noqa: E402
from state_machine import AnalysisContext, DictReferenceLibrary  # noqa: E402
from vision import PixelRect  # noqa: E402

SCREEN_WIDTH, SCREEN_HEIGHT = 320, 480
BUTTON = PixelRect(60, 300, 200, 60)
BANNER = PixelRect(40, 40, 240, 80)


def patterned(rect: PixelRect, seed: int, base: tuple[int, int, int]) -> np.ndarray:
    """A deterministic, high-contrast patch (template matching needs texture)."""
    generator = np.random.default_rng(seed)
    noise = generator.integers(0, 90, size=(rect.height, rect.width, 3), dtype=np.int16)
    patch = np.clip(np.asarray(base, dtype=np.int16) + noise, 0, 255)
    return patch.astype(np.uint8)


def make_screen(seed: int, base: tuple[int, int, int], rect: PixelRect = BUTTON) -> np.ndarray:
    """A dark screen with one recognisable patterned element."""
    screen = np.full((SCREEN_HEIGHT, SCREEN_WIDTH, 3), 24, dtype=np.uint8)
    screen[8:16, 8:16] = 200  # a static corner marker, same on every screen
    screen[rect.y : rect.bottom, rect.x : rect.right] = patterned(rect, seed, base)
    return screen


SCREENS: dict[str, np.ndarray] = {
    "A": make_screen(11, (20, 140, 20), BUTTON),
    "B": make_screen(22, (20, 20, 160), BANNER),
    "C": make_screen(33, (150, 90, 20), BANNER),
    "NOISE": np.full((SCREEN_HEIGHT, SCREEN_WIDTH, 3), 90, dtype=np.uint8),
}

REFERENCE_RECTS = {"A": BUTTON, "B": BANNER, "C": BANNER}


class FakeEmulator:
    """Serves screens and switches them when the expected button is clicked."""

    def __init__(self, screen: str = "A") -> None:
        self.screen = screen
        self.grabs = 0
        self.clicks: list[tuple[int, int]] = []
        self.transitions: dict[tuple[str, str], str] = {}
        self.window_rect = WindowRect(100, 50, SCREEN_WIDTH, SCREEN_HEIGHT)

    # capture backend protocol
    name = "fake-emulator"

    def grab(self, x: int, y: int, width: int, height: int, handle: int | None = None) -> np.ndarray:
        self.grabs += 1
        image = SCREENS[self.screen]
        return image[:height, :width].copy()

    def close(self) -> None:
        return None

    # reaction to input
    def on_click(self, screen_x: int, screen_y: int) -> None:
        client_x = screen_x - self.window_rect.left
        client_y = screen_y - self.window_rect.top
        self.clicks.append((client_x, client_y))
        rect = REFERENCE_RECTS.get(self.screen)
        if rect is not None and rect.contains(client_x, client_y):
            self.screen = self.transitions.get(("click", self.screen), self.screen)


class ReactivePointer(RecordingPointer):
    """Recording pointer that also tells the fake emulator about the click."""

    def __init__(self, emulator: FakeEmulator) -> None:
        super().__init__()
        self.emulator = emulator

    def click(self, x, y, button="left", clicks=1, interval=0.05, duration=0.0):  # type: ignore[override]
        super().click(x, y, button=button, clicks=clicks, interval=interval, duration=duration)
        self.emulator.on_click(x, y)


class ScriptedOcrEngine:
    """OCR engine returning pre-programmed lines per screen name."""

    name = "scripted"

    def __init__(self, lines: dict[str, list[tuple[str, float, PixelRect]]] | None = None,
                 emulator: FakeEmulator | None = None) -> None:
        self.lines = lines or {}
        self.emulator = emulator
        self.calls = 0

    def available(self) -> bool:
        return True

    def read(self, image: np.ndarray) -> list[tuple[str, float, PixelRect]]:
        self.calls += 1
        key = self.emulator.screen if self.emulator else "*"
        return list(self.lines.get(key, self.lines.get("*", [])))


@pytest.fixture
def log() -> EventLog:
    return EventLog(level=LogLevel.DEBUG)


@pytest.fixture
def emulator() -> FakeEmulator:
    return FakeEmulator()


@pytest.fixture
def window(emulator: FakeEmulator, log: EventLog) -> LDPlayerWindow:
    backend = StaticWindowBackend(emulator.window_rect, title="LDPlayer-1")
    window = LDPlayerWindow(handle=1234, title="LDPlayer-1", backend=backend, log=log)
    window.fake_backend = backend  # type: ignore[attr-defined]
    return window


@pytest.fixture
def safety(log: EventLog) -> SafetyController:
    controller = SafetyController(
        SafetySettings(pointer_cooldown=0.0, repeat_action_cooldown=0.0, min_confidence=0.8),
        log=log,
    )
    controller.start()
    return controller


@pytest.fixture
def references() -> DictReferenceLibrary:
    library = DictReferenceLibrary()
    for name, rect in REFERENCE_RECTS.items():
        patch = SCREENS[name][rect.y : rect.bottom, rect.x : rect.right].copy()
        library.add(f"ref_{name}", patch, source_size=(SCREEN_WIDTH, SCREEN_HEIGHT))
    return library


@pytest.fixture
def context(emulator, window, safety, references, log) -> AnalysisContext:
    capture = WindowCapture(window, backend=emulator, log=log)
    pointer = ReactivePointer(emulator)
    ctx = AnalysisContext(
        window=window,
        capture=capture,
        mouse=Mouse(window, safety, backend=pointer, log=log),
        keyboard=Keyboard(window, safety, backend=RecordingKeyboard(), log=log, focus_window=False),
        safety=safety,
        references=references,
        ocr=OcrService(log=log),
        log=log,
        min_confidence=0.8,
    )
    ctx.pointer_backend = pointer  # type: ignore[attr-defined]
    ctx.emulator = emulator  # type: ignore[attr-defined]
    return ctx
