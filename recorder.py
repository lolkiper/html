"""Action recorder: turns real input into a reusable action list.

The point is not to replay raw screen coordinates.  Everything is recorded
*relative to the selected LDPlayer window* (normalized 0..1), so a recording
still works after the emulator is moved or resized, and consecutive raw events
are merged into meaningful actions:

    press + release at one spot        -> Left Click
    two clicks in quick succession     -> Double Click
    press at A, release far away at B  -> Drag
    modifier + key                     -> Hotkey
    a run of characters                -> Type Text
    a gap between two actions          -> Wait

Optionally each click is anchored to a small patch of the screen taken at that
moment, which turns the macro into a visual one: the engine then looks for that
patch and clicks what it finds instead of a position.  Those patches are the only
thing that may reach the disk, and only when the user asks for it - they become
ordinary reference images of the project.
"""

from __future__ import annotations

import string
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol, Sequence

import numpy as np

from actions import (
    Action,
    Drag,
    DoubleClick,
    Hotkey,
    LeftClick,
    MoveMouse,
    PressKey,
    RightClick,
    Target,
    TargetMode,
    TypeText,
    Wait,
    normalize_variable_name,
    variable_token_from_text,
)
from i18n import tr
from logger import EventLog, get_logger
from vision import PixelRect, crop_copy

MODIFIERS = ("ctrl", "alt", "shift", "win")
#: Keys the engine reserves for run control; they are never recorded.
CONTROL_KEYS = ("f8", "f9")
PRINTABLE = set(string.printable) - set("\t\r\n\x0b\x0c")


@dataclass
class RawEvent:
    """One raw input event, in screen coordinates."""

    kind: str                  # down | up | move | key_down | key_up | scroll
    at: float = field(default_factory=time.monotonic)
    x: int = 0
    y: int = 0
    button: str = "left"
    key: str = ""              # normalised key name for key events
    char: str = ""             # the character the key produced, if any
    amount: int = 0            # scroll steps


@dataclass
class RecorderSettings:
    """How raw input is condensed into actions."""

    insert_waits: bool = True
    min_wait: float = 0.35          # shorter gaps are not worth an action
    max_wait: float = 10.0
    double_click_interval: float = 0.4
    drag_threshold: int = 12        # pixels; above this a press/release is a drag
    merge_typing: bool = True
    typing_gap: float = 1.2         # a longer pause splits the text
    anchor_clicks_to_images: bool = False
    anchor_patch: int = 40          # half the size of the captured patch
    anchor_interval: float = 0.25   # how often the anchor frame buffer refreshes
    anchor_confidence: float = 0.85
    ignore_outside_window: bool = True
    record_moves: bool = False      # pointer paths are usually just noise
    stop_key: str = "f10"

    def to_dict(self) -> dict[str, Any]:
        return {
            "insert_waits": self.insert_waits,
            "min_wait": self.min_wait,
            "max_wait": self.max_wait,
            "double_click_interval": self.double_click_interval,
            "drag_threshold": self.drag_threshold,
            "merge_typing": self.merge_typing,
            "typing_gap": self.typing_gap,
            "anchor_clicks_to_images": self.anchor_clicks_to_images,
            "anchor_patch": self.anchor_patch,
            "anchor_interval": self.anchor_interval,
            "anchor_confidence": self.anchor_confidence,
            "ignore_outside_window": self.ignore_outside_window,
            "record_moves": self.record_moves,
            "stop_key": self.stop_key,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RecorderSettings":
        data = dict(data or {})
        known = {name for name in cls.__dataclass_fields__}
        return cls(**{key: value for key, value in data.items() if key in known})


class FrameBuffer:
    """Keeps the last few frames in RAM while a recording runs.

    An application usually reacts to the button *press*, so a frame captured
    after the click already shows the result.  This buffer refreshes in the
    background, which lets the recorder pick a frame from just before the click
    and anchor it to what the user actually clicked on.
    """

    def __init__(
        self,
        provider: Callable[[], np.ndarray | None],
        interval: float = 0.25,
        keep: int = 3,
        log: EventLog | None = None,
    ) -> None:
        self.provider = provider
        self.interval = max(0.05, float(interval))
        self.log = log or get_logger()
        self._frames: deque[tuple[float, np.ndarray]] = deque(maxlen=max(2, keep))
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop.clear()
        self.capture_once()
        self._thread = threading.Thread(target=self._run, name="anchor-frames", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self.capture_once()

    def capture_once(self) -> np.ndarray | None:
        try:
            image = self.provider()
        except Exception as exc:
            self.log.debug("Could not capture the screen for anchoring: %s", exc)
            return None
        if image is None:
            return None
        with self._lock:
            self._frames.append((time.monotonic(), image))
        return image

    def frame_before(self, moment: float, margin: float = 0.05) -> np.ndarray | None:
        """The newest frame captured before ``moment``, or the oldest one kept."""
        with self._lock:
            frames = list(self._frames)
        if not frames:
            return None
        older = [image for at, image in frames if at <= moment - margin]
        return older[-1] if older else frames[0][1]

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)
        self._thread = None
        with self._lock:
            self._frames.clear()


@dataclass
class RecordedStep:
    """One recorded action, still in an editable form."""

    kind: str                                  # click | double | right | drag | key | hotkey | text | wait | move
    at: float = 0.0
    position: tuple[float, float] | None = None       # normalized inside the window
    end_position: tuple[float, float] | None = None   # for drag
    key: str = ""
    keys: tuple[str, ...] = ()
    text: str = ""
    seconds: float = 0.0
    is_variable: bool = False
    patch: np.ndarray | None = None            # captured around a click, in RAM
    patch_offset: tuple[int, int] = (0, 0)     # click position inside the patch
    frame_size: tuple[int, int] = (0, 0)
    reference: str = ""                        # filled in once it is stored

    def describe(self) -> str:
        if self.kind == "click":
            return tr("Left Click").upper()
        if self.kind == "double":
            return tr("Double Click").upper()
        if self.kind == "right":
            return tr("Right Click").upper()
        if self.kind == "drag" and self.position and self.end_position:
            return tr("Drag %s -> %s") % (
                "(%.3f, %.3f)" % self.position, "(%.3f, %.3f)" % self.end_position
            )
        if self.kind == "move" and self.position:
            return tr("Move pointer to %s") % ("(%.3f, %.3f)" % self.position)
        if self.kind == "hotkey":
            return tr("Hotkey %s") % "+".join(self.keys)
        if self.kind == "key":
            return tr("Key %s") % self.key
        if self.kind == "text":
            if self.is_variable:
                name = variable_token_from_text(self.text) or normalize_variable_name(self.text)
                if name:
                    return tr("TYPE VARIABLE {{%s}}") % name
            preview = self.text if len(self.text) <= 24 else self.text[:21] + "..."
            return tr("TYPE TEXT '%s'") % preview
        if self.kind == "wait":
            return tr("Wait").upper()
        return self.kind


class ActionRecorder:
    """Collects raw events and condenses them into actions."""

    def __init__(
        self,
        window: Any,
        settings: RecorderSettings | None = None,
        log: EventLog | None = None,
        frame_provider: Callable[[], np.ndarray | None] | None = None,
    ) -> None:
        self.window = window
        self.settings = settings or RecorderSettings()
        self.log = log or get_logger()
        self.frame_provider = frame_provider
        self.steps: list[RecordedStep] = []
        self.recording = False
        self.skipped_outside = 0
        self._pending_press: RawEvent | None = None
        self._press_image: np.ndarray | None = None
        self._frames: FrameBuffer | None = None
        self._modifiers: set[str] = set()
        self._text_buffer: str = ""
        self._text_started: float = 0.0
        self._last_step_at: float | None = None
        self._started_at: float = 0.0

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self.clear()
        if self.settings.anchor_clicks_to_images and self.frame_provider is not None:
            self._frames = FrameBuffer(
                self.frame_provider, self.settings.anchor_interval, log=self.log
            )
            self._frames.start()
        self.recording = True
        self._started_at = time.monotonic()
        self.log.info("Recording started (press %s to stop)", self.settings.stop_key.upper())

    def stop(self) -> None:
        if not self.recording:
            return
        self._flush_text()
        self.recording = False
        if self._frames is not None:
            self._frames.stop()
            self._frames = None
        self.log.success("Recording finished: %s step(s)", len(self.steps))
        if self.skipped_outside:
            self.log.info(
                "%s event(s) outside the emulator window were ignored", self.skipped_outside
            )

    def clear(self) -> None:
        self.steps.clear()
        self.skipped_outside = 0
        self._pending_press = None
        self._press_image = None
        self._modifiers.clear()
        self._text_buffer = ""
        self._last_step_at = None

    def release(self) -> None:
        """Drop the captured patches (they are frames and must not linger)."""
        self._press_image = None
        if self._frames is not None:
            self._frames.stop()
            self._frames = None
        for step in self.steps:
            if step.patch is not None:
                step.patch = None

    # -------------------------------------------------------------- helpers
    def _normalize(self, x: int, y: int) -> tuple[float, float] | None:
        """Screen point -> normalized point inside the window client area."""
        if self.window is None:
            return None
        if hasattr(self.window, "refresh"):
            self.window.refresh()
        client_x, client_y = self.window.screen_to_client(x, y)
        if not self.window.contains_client_point(client_x, client_y):
            if self.settings.ignore_outside_window:
                self.skipped_outside += 1
                return None
            width, height = self.window.client_size
            client_x = min(max(client_x, 0), max(width - 1, 0))
            client_y = min(max(client_y, 0), max(height - 1, 0))
        return self.window.client_to_normalized(client_x, client_y)

    def _distance(self, first: RawEvent, second: RawEvent) -> float:
        return float(((first.x - second.x) ** 2 + (first.y - second.y) ** 2) ** 0.5)

    def _append(self, step: RecordedStep) -> RecordedStep:
        if self.settings.insert_waits and self._last_step_at is not None:
            gap = step.at - self._last_step_at
            if gap >= self.settings.min_wait:
                self.steps.append(
                    RecordedStep(
                        kind="wait",
                        at=self._last_step_at,
                        seconds=round(min(gap, self.settings.max_wait), 2),
                    )
                )
        self.steps.append(step)
        self._last_step_at = step.at
        return step

    def _capture_patch(self, step: RecordedStep) -> None:
        """Cut a small patch around the click out of the frame taken at press time."""
        if not self.settings.anchor_clicks_to_images or step.position is None:
            return
        frame = self._press_image
        self._press_image = None
        if frame is None:
            return
        height, width = frame.shape[:2]
        center_x = int(round(step.position[0] * (width - 1)))
        center_y = int(round(step.position[1] * (height - 1)))
        half = max(8, int(self.settings.anchor_patch))
        left = max(0, center_x - half)
        top = max(0, center_y - half)
        right = min(width, center_x + half)
        bottom = min(height, center_y + half)
        if right - left < 8 or bottom - top < 8:
            return
        rect = PixelRect(left, top, right - left, bottom - top)
        step.patch = crop_copy(frame, rect)
        step.patch_offset = (center_x - left, center_y - top)
        step.frame_size = (width, height)

    # ----------------------------------------------------------------- feed
    def feed(self, event: RawEvent) -> None:
        """Consume one raw event. Backends call this from their listener thread."""
        if event.kind in ("key_down", "key_up"):
            self._feed_key(event)
            return
        if not self.recording:
            return
        if event.kind == "down":
            self._pending_press = event
            if self._frames is not None:
                # The buffer already holds frames from before this press.
                self._press_image = self._frames.frame_before(event.at)
            elif self.settings.anchor_clicks_to_images and self.frame_provider is not None:
                try:
                    self._press_image = self.frame_provider()
                except Exception as exc:  # pragma: no cover - capture safety
                    self.log.debug("Could not capture the screen for anchoring: %s", exc)
                    self._press_image = None
        elif event.kind == "up":
            self._feed_release(event)
        elif event.kind == "move" and self.settings.record_moves:
            position = self._normalize(event.x, event.y)
            if position is not None:
                self._append(RecordedStep(kind="move", at=event.at, position=position))

    def _feed_release(self, event: RawEvent) -> None:
        press = self._pending_press
        self._pending_press = None
        if press is None:
            return
        start = self._normalize(press.x, press.y)
        end = self._normalize(event.x, event.y)
        if start is None or end is None:
            return
        self._flush_text()
        if self._distance(press, event) > self.settings.drag_threshold:
            self._append(
                RecordedStep(kind="drag", at=press.at, position=start, end_position=end)
            )
            return
        if event.button == "right":
            step = self._append(RecordedStep(kind="right", at=press.at, position=start))
            self._capture_patch(step)
            return
        previous = self._last_click()
        if (
            previous is not None
            and previous.kind == "click"
            and press.at - previous.at <= self.settings.double_click_interval
            and previous.position is not None
            and abs(previous.position[0] - start[0]) < 0.02
            and abs(previous.position[1] - start[1]) < 0.02
        ):
            previous.kind = "double"          # the pair was really a double click
            previous.at = press.at
            self._last_step_at = press.at
            return
        step = self._append(RecordedStep(kind="click", at=press.at, position=start))
        self._capture_patch(step)

    def _last_click(self) -> RecordedStep | None:
        for step in reversed(self.steps):
            if step.kind in ("click", "double", "right"):
                return step
            if step.kind != "wait":
                return None
        return None

    def _feed_key(self, event: RawEvent) -> None:
        key = (event.key or "").lower()
        if key in MODIFIERS:
            if event.kind == "key_down":
                self._modifiers.add(key)
            else:
                self._modifiers.discard(key)
            return
        if event.kind != "key_down":
            return
        if key == self.settings.stop_key:
            self.stop()
            return
        if not self.recording or key in CONTROL_KEYS:
            return
        if self._modifiers:
            self._flush_text()
            combination = tuple(sorted(self._modifiers, key=MODIFIERS.index)) + (key,)
            self._append(RecordedStep(kind="hotkey", at=event.at, keys=combination))
            return
        character = event.char or ""
        if self.settings.merge_typing and character and character in PRINTABLE:
            if self._text_buffer and event.at - self._text_started > self.settings.typing_gap:
                self._flush_text()
            if not self._text_buffer:
                self._text_started = event.at
            self._text_buffer += character
            self._text_started = event.at
            return
        self._flush_text()
        self._append(RecordedStep(kind="key", at=event.at, key=key))

    def _flush_text(self) -> None:
        if not self._text_buffer:
            return
        text = self._text_buffer
        self._text_buffer = ""
        self._append(RecordedStep(kind="text", at=self._text_started, text=text, is_variable=False))

    def insert_variable(self, name: str, at: float | None = None) -> RecordedStep | None:
        """Record TYPE({{NAME}}) explicitly. Never inferred from typed characters."""
        if not self.recording and self._started_at == 0.0:
            return None
        token = normalize_variable_name(name)
        if not token:
            return None
        self._flush_text()
        moment = time.monotonic() if at is None else float(at)
        return self._append(
            RecordedStep(
                kind="text",
                at=moment,
                text="{{%s}}" % token,
                is_variable=True,
            )
        )

    # -------------------------------------------------------------- actions
    def to_actions(
        self,
        save_reference: Callable[[np.ndarray, tuple[int, int], str], str] | None = None,
        name_prefix: str = "recorded",
    ) -> list[Action]:
        """Convert the recording into engine actions.

        ``save_reference(patch, frame_size, suggested_name) -> stored name`` is
        called for anchored clicks; it is the caller's job to store the patch as
        a reference image of the project.
        """
        actions: list[Action] = []
        anchored = 0
        for index, step in enumerate(self.steps, start=1):
            if step.kind == "wait":
                actions.append(Wait(seconds=step.seconds))
                continue
            if step.kind in ("click", "double", "right", "move"):
                target = self._target_for(step, save_reference, f"{name_prefix}_{index}")
                if target is None:
                    continue
                if step.reference:
                    anchored += 1
                if step.kind == "click":
                    actions.append(LeftClick(target=target))
                elif step.kind == "double":
                    actions.append(DoubleClick(target=target))
                elif step.kind == "right":
                    actions.append(RightClick(target=target))
                else:
                    actions.append(MoveMouse(target=target))
                continue
            if step.kind == "drag" and step.position and step.end_position:
                actions.append(
                    Drag(
                        target=Target(
                            mode=TargetMode.WINDOW, x=step.position[0], y=step.position[1]
                        ),
                        end=Target(
                            mode=TargetMode.WINDOW,
                            x=step.end_position[0],
                            y=step.end_position[1],
                        ),
                    )
                )
                continue
            if step.kind == "hotkey":
                actions.append(Hotkey(combination="+".join(step.keys)))
                continue
            if step.kind == "key":
                actions.append(PressKey(key=step.key))
                continue
            if step.kind == "text":
                token = variable_token_from_text(step.text) if step.is_variable else ""
                actions.append(
                    TypeText(
                        text=step.text,
                        is_variable=bool(step.is_variable),
                        sensitive=token == "PASSWORD",
                    )
                )
        if anchored:
            self.log.info("%s click(s) anchored to a reference image", anchored)
        return actions

    def _target_for(
        self,
        step: RecordedStep,
        save_reference: Callable[[np.ndarray, tuple[int, int], str], str] | None,
        suggested_name: str,
    ) -> Target | None:
        if step.position is None:
            return None
        if step.patch is not None and save_reference is not None:
            try:
                name = save_reference(step.patch, step.frame_size, suggested_name)
            except Exception as exc:
                self.log.warning("The click could not be anchored to an image: %s", exc)
                name = ""
            if name:
                step.reference = name
                patch_center = (step.patch.shape[1] // 2, step.patch.shape[0] // 2)
                return Target(
                    mode=TargetMode.REFERENCE,
                    reference=name,
                    threshold=self.settings.anchor_confidence,
                    offset_x=step.patch_offset[0] - patch_center[0],
                    offset_y=step.patch_offset[1] - patch_center[1],
                )
        return Target(mode=TargetMode.WINDOW, x=step.position[0], y=step.position[1])

    def summary(self) -> list[str]:
        return [step.describe() for step in self.steps]

    @property
    def duration(self) -> float:
        if not self.steps:
            return 0.0
        return max(0.0, self.steps[-1].at - self.steps[0].at)


# --------------------------------------------------------------------------- #
# input listeners
# --------------------------------------------------------------------------- #
class InputListener(Protocol):
    name: str

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def available(self) -> bool: ...


PYNPUT_KEY_ALIASES = {
    "cmd": "win", "cmd_l": "win", "cmd_r": "win", "super": "win",
    "ctrl_l": "ctrl", "ctrl_r": "ctrl", "alt_l": "alt", "alt_r": "alt",
    "alt_gr": "alt", "shift_l": "shift", "shift_r": "shift",
    "return": "enter", "esc": "esc", "space": "space", "backspace": "backspace",
    "page_up": "pageup", "page_down": "pagedown", "caps_lock": "capslock",
}


class PynputListener:
    """Global mouse and keyboard listener based on ``pynput``."""

    name = "pynput"

    def __init__(self, recorder: ActionRecorder, log: EventLog | None = None) -> None:
        self.recorder = recorder
        self.log = log or get_logger()
        self._mouse: Any = None
        self._keyboard: Any = None

    def available(self) -> bool:
        try:
            import pynput  # noqa: F401
        except Exception:
            return False
        return True

    # -- translation -------------------------------------------------------
    @staticmethod
    def _key_name(key: Any) -> tuple[str, str]:
        """pynput key -> (normalised name, character)."""
        character = getattr(key, "char", None)
        if character:
            return character.lower(), character
        name = getattr(key, "name", "") or str(key).replace("Key.", "")
        name = name.lower()
        return PYNPUT_KEY_ALIASES.get(name, name), ""

    def start(self) -> None:
        from pynput import keyboard, mouse

        def on_click(x: int, y: int, button: Any, pressed: bool) -> None:
            name = str(getattr(button, "name", button)).lower()
            self.recorder.feed(
                RawEvent(kind="down" if pressed else "up", x=int(x), y=int(y), button=name)
            )

        def on_move(x: int, y: int) -> None:
            if self.recorder.settings.record_moves:
                self.recorder.feed(RawEvent(kind="move", x=int(x), y=int(y)))

        def on_scroll(x: int, y: int, dx: int, dy: int) -> None:
            self.recorder.feed(RawEvent(kind="scroll", x=int(x), y=int(y), amount=int(dy)))

        def on_press(key: Any) -> None:
            name, character = self._key_name(key)
            self.recorder.feed(RawEvent(kind="key_down", key=name, char=character))

        def on_release(key: Any) -> None:
            name, character = self._key_name(key)
            self.recorder.feed(RawEvent(kind="key_up", key=name, char=character))

        self._mouse = mouse.Listener(on_click=on_click, on_move=on_move, on_scroll=on_scroll)
        self._keyboard = keyboard.Listener(on_press=on_press, on_release=on_release)
        self._mouse.start()
        self._keyboard.start()
        self.log.debug("Input listener active")

    def stop(self) -> None:
        for listener in (self._mouse, self._keyboard):
            if listener is not None:
                try:
                    listener.stop()
                except Exception:  # pragma: no cover - listener teardown
                    pass
        self._mouse = self._keyboard = None


class ScriptedListener:
    """Replays a prepared event list; used by the tests and by ``--dry-run``."""

    name = "scripted"

    def __init__(self, recorder: ActionRecorder, events: Sequence[RawEvent] = ()) -> None:
        self.recorder = recorder
        self.events = list(events)
        self.started = False

    def available(self) -> bool:
        return True

    def start(self) -> None:
        self.started = True
        for event in self.events:
            self.recorder.feed(event)

    def stop(self) -> None:
        self.started = False


def create_listener(
    recorder: ActionRecorder, log: EventLog | None = None
) -> InputListener | None:
    """Return a working listener, or ``None`` when recording is unavailable."""
    log = log or get_logger()
    listener = PynputListener(recorder, log=log)
    if listener.available():
        return listener
    log.error(
        "Recording needs the 'pynput' package (pip install pynput)"
    )
    return None
