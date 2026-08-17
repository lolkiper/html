"""Safety layer: nothing is clicked before these checks pass.

Before every pointer or keyboard action the engine verifies that

1. the LDPlayer window still exists, is not minimised and has a usable size;
2. the detected state is still the one the action was planned for;
3. the target coordinates fall inside the selected window;
4. the recognition confidence reaches the required threshold;
5. the recognition is not ambiguous (two states matching almost equally well);
6. the per-target cooldown has elapsed and the global rate limit allows it.

The controller also owns the run/pause/stop state driven by F8 and F9.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

from logger import EventLog, get_logger


class SafetyViolation(RuntimeError):
    """An action was refused because a safety check failed."""


class EmergencyStop(RuntimeError):
    """Raised inside the engine thread when the user requested a hard stop."""


@dataclass
class SafetySettings:
    """Tunable safety limits, persisted as part of a project."""

    min_confidence: float = 0.85
    ambiguity_margin: float = 0.05
    pointer_cooldown: float = 0.30
    repeat_action_cooldown: float = 0.60
    max_actions_per_minute: int = 240
    require_window_alive: bool = True
    require_foreground: bool = False
    clamp_to_window: bool = False
    edge_margin: int = 0
    confirm_state_before_action: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "min_confidence": self.min_confidence,
            "ambiguity_margin": self.ambiguity_margin,
            "pointer_cooldown": self.pointer_cooldown,
            "repeat_action_cooldown": self.repeat_action_cooldown,
            "max_actions_per_minute": self.max_actions_per_minute,
            "require_window_alive": self.require_window_alive,
            "require_foreground": self.require_foreground,
            "clamp_to_window": self.clamp_to_window,
            "edge_margin": self.edge_margin,
            "confirm_state_before_action": self.confirm_state_before_action,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "SafetySettings":
        data = dict(data or {})
        known = {field_name for field_name in cls.__dataclass_fields__}
        return cls(**{key: value for key, value in data.items() if key in known})


@dataclass
class PointerDecision:
    """Result of authorising a pointer action."""

    allowed: bool
    reason: str = ""
    client: tuple[int, int] | None = None
    screen: tuple[int, int] | None = None


class RunState:
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    STOPPED = "STOPPED"


class SafetyController:
    """Run-state machine plus the pre-action checks."""

    def __init__(self, settings: SafetySettings | None = None, log: EventLog | None = None) -> None:
        self.settings = settings or SafetySettings()
        self.log = log or get_logger()
        self._resume = threading.Event()
        self._resume.set()
        self._stop = threading.Event()
        self._running = False
        self._lock = threading.RLock()
        self._cooldowns: dict[str, float] = {}
        self._recent_actions: deque[float] = deque()
        self._state_listeners: list[Callable[[str], None]] = []
        self.blocked_actions = 0
        self.emergency_stops = 0

    # ------------------------------------------------------------ run state
    @property
    def state(self) -> str:
        if self._stop.is_set():
            return RunState.STOPPED
        if not self._running:
            return RunState.IDLE
        return RunState.RUNNING if self._resume.is_set() else RunState.PAUSED

    def add_state_listener(self, callback: Callable[[str], None]) -> None:
        self._state_listeners.append(callback)

    def _notify(self) -> None:
        state = self.state
        for listener in list(self._state_listeners):
            try:
                listener(state)
            except Exception:  # pragma: no cover - listener safety
                pass

    def start(self) -> None:
        with self._lock:
            self._stop.clear()
            self._resume.set()
            self._running = True
            self._cooldowns.clear()
            self._recent_actions.clear()
        self.log.info("Engine started")
        self._notify()

    def pause(self) -> None:
        if self._resume.is_set():
            self._resume.clear()
            self.log.warning("Engine paused (F8 to resume)")
            self._notify()

    def resume(self) -> None:
        if not self._resume.is_set():
            self._resume.set()
            self.log.info("Engine resumed")
            self._notify()

    def toggle_pause(self) -> str:
        """F8 handler: start, pause or resume depending on the current state."""
        state = self.state
        if state in (RunState.IDLE, RunState.STOPPED):
            self.start()
        elif state == RunState.RUNNING:
            self.pause()
        else:
            self.resume()
        return self.state

    def emergency_stop(self, reason: str = "user request") -> None:
        """F9 handler: stop immediately, no further action is authorised."""
        with self._lock:
            self.emergency_stops += 1
            self._stop.set()
            self._resume.set()  # release any thread waiting in a pause
            self._running = False
        self.log.error("EMERGENCY STOP (%s)", reason)
        self._notify()

    def finish(self, reason: str = "workflow finished") -> None:
        with self._lock:
            self._running = False
            self._resume.set()
        self.log.info("Engine idle (%s)", reason)
        self._notify()

    def reset(self) -> None:
        with self._lock:
            self._stop.clear()
            self._resume.set()
            self._running = False
            self._cooldowns.clear()
            self._recent_actions.clear()
        self._notify()

    @property
    def is_stopped(self) -> bool:
        return self._stop.is_set()

    @property
    def is_paused(self) -> bool:
        return self._running and not self._resume.is_set()

    @property
    def is_running(self) -> bool:
        return self.state == RunState.RUNNING

    # ----------------------------------------------------------- wait/sleep
    def raise_if_stopped(self) -> None:
        if self._stop.is_set():
            raise EmergencyStop("Emergency stop requested")

    def wait_while_paused(self, timeout: float | None = None) -> None:
        """Block while paused; raises :class:`EmergencyStop` after F9."""
        self.raise_if_stopped()
        if self._resume.is_set():
            return
        self._resume.wait(timeout)
        self.raise_if_stopped()

    def sleep(self, seconds: float) -> bool:
        """Interruptible sleep. Returns ``False`` if interrupted by a stop."""
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            self.wait_while_paused(0.1)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return True
            if self._stop.wait(min(remaining, 0.05)):
                raise EmergencyStop("Emergency stop requested")

    # -------------------------------------------------------------- checks
    def check_window(self, window: Any) -> None:
        if not self.settings.require_window_alive:
            return
        if window is None:
            raise SafetyViolation("no LDPlayer window is selected")
        if hasattr(window, "refresh"):
            window.refresh()
        if not window.is_alive():
            raise SafetyViolation("the LDPlayer window no longer exists")
        if window.is_minimized():
            raise SafetyViolation("the LDPlayer window is minimised")
        width, height = window.client_size
        if width <= 0 or height <= 0:
            raise SafetyViolation(f"the LDPlayer window has no usable size ({width}x{height})")
        if self.settings.require_foreground and not window.is_foreground():
            raise SafetyViolation("the LDPlayer window is not in the foreground")

    def check_confidence(self, confidence: float | None, required: float | None = None) -> None:
        if confidence is None:
            return
        threshold = self.settings.min_confidence if required is None else required
        if confidence + 1e-9 < threshold:
            raise SafetyViolation(
                f"confidence {confidence:.2f} is below the required {threshold:.2f}"
            )

    def check_ambiguity(self, best: float | None, runner_up: float | None) -> None:
        if best is None or runner_up is None:
            return
        margin = self.settings.ambiguity_margin
        if margin <= 0:
            return
        if abs(best - runner_up) < margin:
            raise SafetyViolation(
                f"ambiguous recognition (best={best:.2f}, second={runner_up:.2f}, "
                f"margin={margin:.2f})"
            )

    def check_point(self, window: Any, x: float, y: float) -> tuple[int, int]:
        """Validate a client-area point and translate it into screen pixels."""
        width, height = window.client_size
        margin = max(0, int(self.settings.edge_margin))
        if self.settings.clamp_to_window:
            x = min(max(x, margin), max(width - 1 - margin, margin))
            y = min(max(y, margin), max(height - 1 - margin, margin))
        if not (margin <= x < width - margin and margin <= y < height - margin):
            raise SafetyViolation(
                f"target ({int(x)},{int(y)}) is outside the window area {width}x{height}"
            )
        return window.client_to_screen(x, y)

    # ------------------------------------------------------------ cooldowns
    def remaining_cooldown(self, key: str, seconds: float | None = None) -> float:
        if seconds is None:
            seconds = self.settings.pointer_cooldown
        last = self._cooldowns.get(key)
        if last is None or seconds <= 0:
            return 0.0
        return max(0.0, seconds - (time.monotonic() - last))

    def wait_for_cooldown(self, key: str, seconds: float | None = None) -> float:
        waited = self.remaining_cooldown(key, seconds)
        if waited > 0:
            self.log.debug("Cooldown: waiting %.2fs before repeating '%s'", waited, key)
            self.sleep(waited)
        return waited

    def note_action(self, key: str) -> None:
        now = time.monotonic()
        self._cooldowns[key] = now
        self._recent_actions.append(now)
        while self._recent_actions and now - self._recent_actions[0] > 60.0:
            self._recent_actions.popleft()

    def enforce_rate_limit(self) -> None:
        limit = int(self.settings.max_actions_per_minute)
        if limit <= 0 or len(self._recent_actions) < limit:
            return
        oldest = self._recent_actions[0]
        wait = max(0.0, 60.0 - (time.monotonic() - oldest))
        if wait > 0:
            self.log.warning("Rate limit reached (%s actions/min), waiting %.1fs", limit, wait)
            self.sleep(wait)

    # ----------------------------------------------------------- authorise
    def authorize_pointer(
        self,
        window: Any,
        x: float,
        y: float,
        confidence: float | None = None,
        required: float | None = None,
        runner_up: float | None = None,
        key: str = "pointer",
        cooldown: float | None = None,
    ) -> PointerDecision:
        """Run every pre-click check and return the validated screen point."""
        self.raise_if_stopped()
        self.wait_while_paused()
        try:
            self.check_window(window)
            self.check_confidence(confidence, required)
            self.check_ambiguity(confidence, runner_up)
            screen = self.check_point(window, x, y)
        except SafetyViolation as exc:
            self.blocked_actions += 1
            self.log.warning("Action cancelled: %s", exc)
            return PointerDecision(False, str(exc))
        self.wait_for_cooldown(key, cooldown)
        self.enforce_rate_limit()
        self.raise_if_stopped()
        return PointerDecision(True, "", (int(x), int(y)), screen)

    def authorize_input(self, window: Any, key: str = "keyboard") -> PointerDecision:
        """Checks for keyboard actions (no coordinates involved)."""
        self.raise_if_stopped()
        self.wait_while_paused()
        try:
            self.check_window(window)
        except SafetyViolation as exc:
            self.blocked_actions += 1
            self.log.warning("Action cancelled: %s", exc)
            return PointerDecision(False, str(exc))
        self.wait_for_cooldown(key, self.settings.repeat_action_cooldown)
        self.enforce_rate_limit()
        return PointerDecision(True)


FORBIDDEN_ARTIFACT_DIRS = ("screenshots", "temp", "tmp_frames", "cache_images", "frame_cache")
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff")


def audit_no_frame_artifacts(root: Any, allowed: tuple[str, ...] = ("references",)) -> list[str]:
    """Report captured-frame artefacts, so the RAM-only rule stays verifiable.

    Only user-added reference images (inside ``references/``) may exist on disk.
    """
    from pathlib import Path

    root = Path(root)
    problems: list[str] = []
    if not root.exists():
        return problems
    for path in root.rglob("*"):
        relative_parts = path.relative_to(root).parts
        if path.is_dir():
            if path.name.lower() in FORBIDDEN_ARTIFACT_DIRS:
                problems.append(f"forbidden directory: {path}")
            continue
        if path.suffix.lower() in IMAGE_SUFFIXES and not any(
            part in allowed for part in relative_parts
        ):
            problems.append(f"unexpected image file: {path}")
    return problems
