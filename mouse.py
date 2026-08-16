"""Pointer actions expressed in coordinates of the selected LDPlayer window.

Callers work with client-area pixels (or normalized 0..1 positions); this module
converts them to screen pixels only after :mod:`safety` has validated the window
and the target point.  Nothing here moves the pointer without that check.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from logger import EventLog, get_logger
from safety import EmergencyStop, SafetyController, SafetyViolation

LEFT, MIDDLE, RIGHT = "left", "middle", "right"


@dataclass
class PointerEvent:
    """A recorded pointer operation (dry-run mode and tests)."""

    kind: str
    x: int = 0
    y: int = 0
    button: str = LEFT
    clicks: int = 1
    duration: float = 0.0
    to_x: int = 0
    to_y: int = 0
    at: float = field(default_factory=time.time)


class PointerBackend(Protocol):
    name: str

    def move(self, x: int, y: int, duration: float = 0.0) -> None: ...
    def click(self, x: int, y: int, button: str = LEFT, clicks: int = 1,
              interval: float = 0.05, duration: float = 0.0) -> None: ...
    def drag(self, x1: int, y1: int, x2: int, y2: int, duration: float = 0.4,
             button: str = LEFT) -> None: ...
    def scroll(self, amount: int, x: int | None = None, y: int | None = None) -> None: ...
    def position(self) -> tuple[int, int]: ...


class PyAutoGuiPointer:
    """Real pointer control through PyAutoGUI."""

    name = "pyautogui"

    def __init__(self, log: EventLog | None = None) -> None:
        self.log = log or get_logger()
        try:
            import pyautogui
        except Exception as exc:  # pragma: no cover - optional at import time
            raise RuntimeError(f"PyAutoGUI is not available: {exc}") from exc
        pyautogui.FAILSAFE = True  # pointer to a screen corner aborts everything
        pyautogui.PAUSE = 0.0
        self._gui = pyautogui

    def _call(self, function: Any, *args: Any, **kwargs: Any) -> None:
        try:
            function(*args, **kwargs)
        except Exception as exc:  # FailSafeException and friends
            if type(exc).__name__ == "FailSafeException":
                raise EmergencyStop("PyAutoGUI fail-safe triggered (pointer in screen corner)")
            raise

    def move(self, x: int, y: int, duration: float = 0.0) -> None:
        self._call(self._gui.moveTo, x, y, duration=duration)

    def click(self, x: int, y: int, button: str = LEFT, clicks: int = 1,
              interval: float = 0.05, duration: float = 0.0) -> None:
        self._call(self._gui.moveTo, x, y, duration=duration)
        self._call(self._gui.click, x, y, clicks=clicks, interval=interval, button=button)

    def drag(self, x1: int, y1: int, x2: int, y2: int, duration: float = 0.4,
             button: str = LEFT) -> None:
        self._call(self._gui.moveTo, x1, y1, duration=min(0.2, duration / 2))
        self._call(self._gui.mouseDown, button=button)
        try:
            self._call(self._gui.moveTo, x2, y2, duration=duration)
        finally:
            self._call(self._gui.mouseUp, button=button)

    def scroll(self, amount: int, x: int | None = None, y: int | None = None) -> None:
        if x is not None and y is not None:
            self._call(self._gui.moveTo, x, y)
        self._call(self._gui.scroll, amount)

    def position(self) -> tuple[int, int]:
        point = self._gui.position()
        return int(point[0]), int(point[1])


class RecordingPointer:
    """Records instead of clicking: powers ``--dry-run`` and the test suite."""

    name = "recording"

    def __init__(self) -> None:
        self.events: list[PointerEvent] = []
        self._position = (0, 0)

    def move(self, x: int, y: int, duration: float = 0.0) -> None:
        self._position = (x, y)
        self.events.append(PointerEvent("move", x, y, duration=duration))

    def click(self, x: int, y: int, button: str = LEFT, clicks: int = 1,
              interval: float = 0.05, duration: float = 0.0) -> None:
        self._position = (x, y)
        self.events.append(PointerEvent("click", x, y, button=button, clicks=clicks))

    def drag(self, x1: int, y1: int, x2: int, y2: int, duration: float = 0.4,
             button: str = LEFT) -> None:
        self._position = (x2, y2)
        self.events.append(
            PointerEvent("drag", x1, y1, button=button, duration=duration, to_x=x2, to_y=y2)
        )

    def scroll(self, amount: int, x: int | None = None, y: int | None = None) -> None:
        self.events.append(PointerEvent("scroll", x or 0, y or 0, clicks=amount))

    def position(self) -> tuple[int, int]:
        return self._position

    def clear(self) -> None:
        self.events.clear()


def create_pointer_backend(name: str = "auto", log: EventLog | None = None) -> PointerBackend:
    log = log or get_logger()
    name = (name or "auto").lower()
    if name in ("recording", "dry-run", "dryrun", "none"):
        return RecordingPointer()
    try:
        return PyAutoGuiPointer(log=log)
    except Exception as exc:
        if name in ("pyautogui", "real"):
            raise
        log.warning("Pointer input disabled (%s); running in dry-run mode", exc)
        return RecordingPointer()


@dataclass
class PointerSettings:
    move_duration: float = 0.12
    click_interval: float = 0.06
    jitter: int = 1  # pixels of randomisation, 0 disables
    humanize: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "move_duration": self.move_duration,
            "click_interval": self.click_interval,
            "jitter": self.jitter,
            "humanize": self.humanize,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "PointerSettings":
        data = dict(data or {})
        known = {name for name in cls.__dataclass_fields__}
        return cls(**{key: value for key, value in data.items() if key in known})


class Mouse:
    """Window relative pointer facade used by the action layer."""

    def __init__(
        self,
        window: Any,
        safety: SafetyController,
        backend: PointerBackend | str = "auto",
        settings: PointerSettings | None = None,
        log: EventLog | None = None,
    ) -> None:
        self.window = window
        self.safety = safety
        self.log = log or get_logger()
        self.backend: PointerBackend = (
            create_pointer_backend(backend, self.log) if isinstance(backend, str) else backend
        )
        self.settings = settings or PointerSettings()

    @property
    def is_dry_run(self) -> bool:
        return isinstance(self.backend, RecordingPointer)

    def set_window(self, window: Any) -> None:
        self.window = window

    # ------------------------------------------------------------- internals
    def _humanized(self, x: int, y: int) -> tuple[int, int]:
        if not self.settings.humanize or self.settings.jitter <= 0:
            return x, y
        spread = int(self.settings.jitter)
        return x + random.randint(-spread, spread), y + random.randint(-spread, spread)

    def _duration(self) -> float:
        base = max(0.0, self.settings.move_duration)
        if not self.settings.humanize or base == 0:
            return base
        return base * random.uniform(0.7, 1.4)

    def _authorize(
        self,
        x: float,
        y: float,
        confidence: float | None,
        required: float | None,
        runner_up: float | None,
        key: str,
        cooldown: float | None,
    ):
        jittered_x, jittered_y = self._humanized(int(round(x)), int(round(y)))
        return self.safety.authorize_pointer(
            self.window, jittered_x, jittered_y,
            confidence=confidence, required=required, runner_up=runner_up,
            key=key, cooldown=cooldown,
        )

    # ----------------------------------------------------------------- moves
    def move(self, x: float, y: float, **guard: Any) -> bool:
        decision = self._authorize(x, y, guard.get("confidence"), guard.get("required"),
                                   guard.get("runner_up"), guard.get("key", "move"),
                                   guard.get("cooldown", 0.0))
        if not decision.allowed:
            return False
        self.backend.move(*decision.screen, duration=self._duration())
        self.safety.note_action(guard.get("key", "move"))
        self.log.debug("Mouse moved to client (%s,%s)", *decision.client)
        return True

    def click(
        self,
        x: float,
        y: float,
        button: str = LEFT,
        clicks: int = 1,
        source: str = "absolute",
        **guard: Any,
    ) -> bool:
        key = guard.get("key", f"{button}-click")
        decision = self._authorize(x, y, guard.get("confidence"), guard.get("required"),
                                   guard.get("runner_up"), key, guard.get("cooldown"))
        if not decision.allowed:
            return False
        self.backend.click(
            *decision.screen, button=button, clicks=clicks,
            interval=self.settings.click_interval, duration=self._duration(),
        )
        self.safety.note_action(key)
        confidence = guard.get("confidence")
        suffix = f", confidence={confidence:.2f}" if isinstance(confidence, (int, float)) else ""
        self.log.info(
            "%s at window (%s,%s) [%s%s]",
            {1: "Click", 2: "Double click", 3: "Triple click"}.get(clicks, f"{clicks}x click"),
            decision.client[0], decision.client[1], source, suffix,
        )
        return True

    def double_click(self, x: float, y: float, **guard: Any) -> bool:
        return self.click(x, y, button=LEFT, clicks=2, **guard)

    def right_click(self, x: float, y: float, **guard: Any) -> bool:
        return self.click(x, y, button=RIGHT, clicks=1, **guard)

    def drag(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.4,
        button: str = LEFT,
        source: str = "absolute",
        **guard: Any,
    ) -> bool:
        key = guard.get("key", "drag")
        start = self._authorize(x1, y1, guard.get("confidence"), guard.get("required"),
                                guard.get("runner_up"), key, guard.get("cooldown"))
        if not start.allowed:
            return False
        try:
            end_screen = self.safety.check_point(self.window, int(round(x2)), int(round(y2)))
        except SafetyViolation as exc:
            self.log.warning("Drag cancelled: %s", exc)
            return False
        self.backend.drag(*start.screen, *end_screen, duration=duration, button=button)
        self.safety.note_action(key)
        self.log.info(
            "Drag from window (%s,%s) to (%s,%s) [%s]",
            start.client[0], start.client[1], int(x2), int(y2), source,
        )
        return True

    def scroll(self, amount: int, x: float | None = None, y: float | None = None, **guard: Any) -> bool:
        if x is None or y is None:
            self.backend.scroll(amount)
            return True
        decision = self._authorize(x, y, guard.get("confidence"), guard.get("required"),
                                   guard.get("runner_up"), "scroll", guard.get("cooldown"))
        if not decision.allowed:
            return False
        self.backend.scroll(amount, *decision.screen)
        self.safety.note_action("scroll")
        return True

    # ------------------------------------------------------------ normalized
    def click_normalized(self, nx: float, ny: float, **kwargs: Any) -> bool:
        x, y = self.window.normalized_to_client(nx, ny)
        return self.click(x, y, **kwargs)

    def move_normalized(self, nx: float, ny: float, **kwargs: Any) -> bool:
        x, y = self.window.normalized_to_client(nx, ny)
        return self.move(x, y, **kwargs)
