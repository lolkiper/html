"""Actions the engine can perform, and the verification step that follows them.

A pointer action never carries a bare screen coordinate.  Its target is either

* a position inside the selected window (normalized, so it survives a resize), or
* the position of something that was just recognised (reference image, text, or
  the element that identified the current state).

Every action returns an :class:`ActionResult`; failures are reported instead of
raised so a workflow can branch on them.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, ClassVar, Sequence

from conditions import Condition, ConditionResult, condition_from_dict, condition_to_dict, evaluate
from i18n import tr
from logger import Secret, mask_text
from safety import EmergencyStop, SafetyViolation
from vision import MatchResult, Roi

if TYPE_CHECKING:  # pragma: no cover - typing only
    from state_machine import AnalysisContext


class StopRequested(RuntimeError):
    """Raised by the STOP action to end the run in a controlled way."""


class TargetMode(str, Enum):
    WINDOW = "window"            # fixed position inside the selected window
    LAST_MATCH = "last_match"    # centre of the most recent recognition
    REFERENCE = "reference"      # find a reference image now, click its centre
    TEXT = "text"                # find a text now, click its centre
    STATE = "state"              # element that identified the (given) state
    CURRENT = "current"          # wherever the pointer already is


@dataclass
class ResolvedPoint:
    x: int
    y: int
    confidence: float | None = None
    source: str = "window"
    match: MatchResult | None = None
    required: float | None = None


@dataclass
class Target:
    """Where an action should happen."""

    mode: TargetMode = TargetMode.WINDOW
    x: float = 0.5
    y: float = 0.5
    units: str = "normalized"          # normalized | pixels
    reference: str = ""
    text: str = ""
    state: str = ""
    roi: Roi = field(default_factory=Roi.full)
    threshold: float = 0.85
    offset_x: int = 0
    offset_y: int = 0
    anchor: str = "center"             # center | topleft

    # ------------------------------------------------------------- resolving
    def resolve(self, ctx: "AnalysisContext") -> ResolvedPoint | None:
        mode = TargetMode(self.mode)
        if mode is TargetMode.WINDOW:
            if self.units == "pixels":
                x, y = int(self.x), int(self.y)
            else:
                x, y = ctx.window.normalized_to_client(self.x, self.y)
            return ResolvedPoint(
                x + self.offset_x, y + self.offset_y, None, tr("window position")
            )
        if mode is TargetMode.CURRENT:
            return ResolvedPoint(-1, -1, None, tr("current pointer position"))
        match: MatchResult | None = None
        source = ""
        if mode is TargetMode.LAST_MATCH:
            match, source = ctx.last_match, tr("last match")
        elif mode is TargetMode.REFERENCE:
            match = ctx.find_reference(self.reference, threshold=self.threshold, roi=self.roi)
            source = tr("reference '%s'") % self.reference
        elif mode is TargetMode.TEXT:
            match = ctx.find_text(self.text, roi=self.roi)
            source = tr("text '%s'") % self.text
        elif mode is TargetMode.STATE:
            state_name = self.state or ctx.detect().state
            match = ctx.state_match(state_name)
            source = tr("element of state '%s'") % state_name
        if match is None or match.rect is None or not match.found:
            return None
        if self.anchor == "topleft":
            px, py = match.rect.x, match.rect.y
        else:
            px, py = match.rect.center
        x, y = ctx.frame_to_client(px, py)
        return ResolvedPoint(
            x + self.offset_x, y + self.offset_y, match.confidence, source, match, self.threshold
        )

    # -------------------------------------------------------- serialisation
    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": TargetMode(self.mode).value,
            "x": self.x,
            "y": self.y,
            "units": self.units,
            "reference": self.reference,
            "text": self.text,
            "state": self.state,
            "roi": self.roi.to_dict(),
            "threshold": self.threshold,
            "offset_x": self.offset_x,
            "offset_y": self.offset_y,
            "anchor": self.anchor,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Target":
        if not data:
            return cls()
        return cls(
            TargetMode(str(data.get("mode", "window"))),
            float(data.get("x", 0.5)),
            float(data.get("y", 0.5)),
            str(data.get("units", "normalized")),
            str(data.get("reference", "")),
            str(data.get("text", "")),
            str(data.get("state", "")),
            Roi.from_dict(data.get("roi")),
            float(data.get("threshold", 0.85)),
            int(data.get("offset_x", 0)),
            int(data.get("offset_y", 0)),
            str(data.get("anchor", "center")),
        )

    def describe(self) -> str:
        mode = TargetMode(self.mode)
        if mode is TargetMode.WINDOW:
            if self.units == "pixels":
                return tr("window pixel (%s,%s)") % (int(self.x), int(self.y))
            return tr("window (%.3f,%.3f)") % (self.x, self.y)
        if mode is TargetMode.LAST_MATCH:
            return tr("last match")
        if mode is TargetMode.REFERENCE:
            return tr("image '%s'") % self.reference
        if mode is TargetMode.TEXT:
            return tr("text '%s'") % self.text
        if mode is TargetMode.STATE:
            return tr("element of state '%s'") % (self.state or tr("current"))
        return tr("current pointer")


@dataclass
class ActionResult:
    success: bool = True
    detail: str = ""
    confidence: float = 0.0
    match: MatchResult | None = None
    value: Any = None

    def __bool__(self) -> bool:
        return self.success


ACTION_TYPES: dict[str, type["Action"]] = {}


def register_action(cls: type["Action"]) -> type["Action"]:
    ACTION_TYPES[cls.kind] = cls
    return cls


@dataclass
class Action:
    """Base class for everything the engine can do."""

    kind: ClassVar[str] = "action"
    label: ClassVar[str] = "Action"

    def execute(self, ctx: "AnalysisContext") -> ActionResult:  # pragma: no cover - abstract
        raise NotImplementedError

    def describe(self) -> str:  # pragma: no cover - overridden
        return self.label

    def payload(self) -> dict[str, Any]:
        return {}

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, **self.payload()}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Action":  # pragma: no cover - overridden
        return cls()


def action_from_dict(data: dict[str, Any] | None) -> Action | None:
    if not data:
        return None
    kind = str(data.get("kind", "")).lower()
    action_type = ACTION_TYPES.get(kind)
    if action_type is None:
        raise ValueError(f"unknown action kind: {kind!r}")
    return action_type.build(data)


def actions_from_list(items: Sequence[dict[str, Any]] | None) -> list[Action]:
    result: list[Action] = []
    for item in items or []:
        action = action_from_dict(item)
        if action is not None:
            result.append(action)
    return result


def actions_to_list(actions: Sequence[Action]) -> list[dict[str, Any]]:
    return [action.to_dict() for action in actions]


# --------------------------------------------------------------------------- #
# pointer actions
# --------------------------------------------------------------------------- #
@dataclass
class PointerAction(Action):
    """Shared plumbing: resolve the target, then let safety authorise it."""

    target: Target = field(default_factory=Target)
    cooldown: float | None = None
    require_confidence: float | None = None

    def _resolve(self, ctx: "AnalysisContext") -> tuple[ResolvedPoint | None, ActionResult | None]:
        point = self.target.resolve(ctx)
        if point is None:
            return None, ActionResult(False, f"target not found: {self.target.describe()}")
        required = self.require_confidence if self.require_confidence is not None else point.required
        if point.confidence is not None and required is not None:
            if point.confidence + 1e-9 < required:
                return None, ActionResult(
                    False,
                    f"confidence {point.confidence:.2f} below required {required:.2f}",
                    point.confidence,
                )
        return point, None

    def _guard(self, point: ResolvedPoint) -> dict[str, Any]:
        return {
            "confidence": point.confidence,
            "required": self.require_confidence if self.require_confidence is not None else point.required,
            "key": f"{self.kind}:{self.target.describe()}",
            "cooldown": self.cooldown,
            "source": point.source,
        }

    def payload(self) -> dict[str, Any]:
        return {
            "target": self.target.to_dict(),
            "cooldown": self.cooldown,
            "require_confidence": self.require_confidence,
        }

    @classmethod
    def _common(cls, data: dict[str, Any]) -> dict[str, Any]:
        cooldown = data.get("cooldown")
        required = data.get("require_confidence")
        return {
            "target": Target.from_dict(data.get("target")),
            "cooldown": None if cooldown is None else float(cooldown),
            "require_confidence": None if required is None else float(required),
        }


@register_action
@dataclass
class MoveMouse(PointerAction):
    kind: ClassVar[str] = "move_mouse"
    label: ClassVar[str] = "Move Mouse"

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        point, failure = self._resolve(ctx)
        if failure is not None:
            return failure
        guard = self._guard(point)
        guard.pop("source", None)
        moved = ctx.mouse.move(point.x, point.y, **guard)
        return ActionResult(moved, f"move to {self.target.describe()}", point.confidence or 0.0, point.match)

    def describe(self) -> str:
        return tr("%s -> %s") % (tr(self.label).upper(), self.target.describe())

    @classmethod
    def build(cls, data: dict[str, Any]) -> "MoveMouse":
        return cls(**cls._common(data))


@dataclass
class _Click(PointerAction):
    button: ClassVar[str] = "left"
    clicks: ClassVar[int] = 1

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        point, failure = self._resolve(ctx)
        if failure is not None:
            return failure
        guard = self._guard(point)
        source = guard.pop("source")
        clicked = ctx.mouse.click(
            point.x, point.y, button=self.button, clicks=self.clicks, source=source, **guard
        )
        detail = f"{self.label} on {self.target.describe()}"
        return ActionResult(clicked, detail, point.confidence or 0.0, point.match)

    def describe(self) -> str:
        return tr("%s -> %s") % (tr(self.label).upper(), self.target.describe())

    @classmethod
    def build(cls, data: dict[str, Any]):
        return cls(**cls._common(data))


@register_action
@dataclass
class LeftClick(_Click):
    kind: ClassVar[str] = "left_click"
    label: ClassVar[str] = "Left Click"
    button: ClassVar[str] = "left"
    clicks: ClassVar[int] = 1


@register_action
@dataclass
class DoubleClick(_Click):
    kind: ClassVar[str] = "double_click"
    label: ClassVar[str] = "Double Click"
    button: ClassVar[str] = "left"
    clicks: ClassVar[int] = 2


@register_action
@dataclass
class RightClick(_Click):
    kind: ClassVar[str] = "right_click"
    label: ClassVar[str] = "Right Click"
    button: ClassVar[str] = "right"
    clicks: ClassVar[int] = 1


@register_action
@dataclass
class Drag(PointerAction):
    kind: ClassVar[str] = "drag"
    label: ClassVar[str] = "Drag"

    end: Target = field(default_factory=Target)
    duration: float = 0.4

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        start, failure = self._resolve(ctx)
        if failure is not None:
            return failure
        finish = self.end.resolve(ctx)
        if finish is None:
            return ActionResult(False, f"drag destination not found: {self.end.describe()}")
        guard = self._guard(start)
        source = guard.pop("source")
        dragged = ctx.mouse.drag(
            start.x, start.y, finish.x, finish.y,
            duration=self.duration, source=source, **guard,
        )
        detail = f"drag {self.target.describe()} -> {self.end.describe()}"
        return ActionResult(dragged, detail, start.confidence or 0.0, start.match)

    def describe(self) -> str:
        return tr("%s -> %s") % (tr(self.label).upper(),
                                 f"{self.target.describe()} -> {self.end.describe()}")

    def payload(self) -> dict[str, Any]:
        return {**super().payload(), "end": self.end.to_dict(), "duration": self.duration}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Drag":
        return cls(
            **cls._common(data),
            end=Target.from_dict(data.get("end")),
            duration=float(data.get("duration", 0.4)),
        )


# --------------------------------------------------------------------------- #
# keyboard actions
# --------------------------------------------------------------------------- #
@register_action
@dataclass
class PressKey(Action):
    kind: ClassVar[str] = "press_key"
    label: ClassVar[str] = "Press Key"

    key: str = "enter"
    presses: int = 1
    interval: float = 0.05

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        done = ctx.keyboard.press_key(self.key, presses=self.presses, interval=self.interval)
        return ActionResult(done, f"press {self.key}")

    def describe(self) -> str:
        if self.presses > 1:
            return tr("PRESS KEY %s x%s") % (self.key, self.presses)
        return tr("PRESS KEY %s") % self.key

    def payload(self) -> dict[str, Any]:
        return {"key": self.key, "presses": self.presses, "interval": self.interval}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "PressKey":
        return cls(
            str(data.get("key", "enter")),
            int(data.get("presses", 1)),
            float(data.get("interval", 0.05)),
        )


@register_action
@dataclass
class Hotkey(Action):
    kind: ClassVar[str] = "hotkey"
    label: ClassVar[str] = "Hotkey"

    combination: str = "ctrl+a"

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        done = ctx.keyboard.hotkey(self.combination)
        return ActionResult(done, f"hotkey {self.combination}")

    def describe(self) -> str:
        return tr("HOTKEY %s") % self.combination

    def payload(self) -> dict[str, Any]:
        return {"combination": self.combination}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Hotkey":
        return cls(str(data.get("combination", "")))


@register_action
@dataclass
class TypeText(Action):
    """Type text. Sensitive values are redacted in the log and never echoed."""

    kind: ClassVar[str] = "type_text"
    label: ClassVar[str] = "Type Text"

    text: str = ""
    sensitive: bool = False
    interval: float = 0.02
    clear_first: bool = False
    variable: str = ""  # read the value from a variable instead of the project file

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        if self.variable:
            raw = ctx.variables.get(self.variable, "")
            if isinstance(raw, Secret):
                value = raw.reveal()
                sensitive = True
            else:
                value = str(raw or "")
                sensitive = self.sensitive
        else:
            value = self.text
            sensitive = self.sensitive
        if not value:
            return ActionResult(False, "nothing to type")
        if self.clear_first:
            ctx.keyboard.clear_field()
        done = ctx.keyboard.type_text(value, interval=self.interval, sensitive=sensitive)
        detail = "typed " + (mask_text(value) if sensitive else f"{len(value)} chars")
        return ActionResult(done, detail)

    def describe(self) -> str:
        if self.variable:
            return tr("TYPE TEXT from variable '%s'") % self.variable
        if self.sensitive:
            return tr("TYPE TEXT (%s)") % mask_text(self.text)
        preview = self.text if len(self.text) <= 24 else self.text[:21] + "..."
        return tr("TYPE TEXT '%s'") % preview

    def payload(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "sensitive": self.sensitive,
            "interval": self.interval,
            "clear_first": self.clear_first,
            "variable": self.variable,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "TypeText":
        return cls(
            str(data.get("text", "")),
            bool(data.get("sensitive", False)),
            float(data.get("interval", 0.02)),
            bool(data.get("clear_first", False)),
            str(data.get("variable", "")),
        )


# --------------------------------------------------------------------------- #
# flow actions
# --------------------------------------------------------------------------- #
@register_action
@dataclass
class Wait(Action):
    kind: ClassVar[str] = "wait"
    label: ClassVar[str] = "Wait"

    seconds: float = 1.0
    jitter: float = 0.0

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        duration = max(0.0, self.seconds + (random.uniform(0, self.jitter) if self.jitter else 0.0))
        ctx.log.info("Waiting %.2fs", duration)
        ctx.safety.sleep(duration)
        return ActionResult(True, f"waited {duration:.2f}s")

    def describe(self) -> str:
        return tr("WAIT %gs") % self.seconds

    def payload(self) -> dict[str, Any]:
        return {"seconds": self.seconds, "jitter": self.jitter}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Wait":
        return cls(float(data.get("seconds", 1.0)), float(data.get("jitter", 0.0)))


@register_action
@dataclass
class WaitUntil(Action):
    """WAIT UNTIL a condition holds, with a TIMEOUT."""

    kind: ClassVar[str] = "wait_until"
    label: ClassVar[str] = "Wait Until"

    condition: Condition | None = None
    timeout: float = 10.0
    poll: float = 0.5
    expect: bool = True

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        deadline = time.monotonic() + max(0.0, self.timeout)
        attempts = 0
        while True:
            attempts += 1
            ctx.refresh()
            result = evaluate(self.condition, ctx)
            if result.value == self.expect:
                ctx.log.info("Wait condition satisfied after %s check(s)", attempts)
                return ActionResult(True, result.detail, result.confidence, result.match)
            if time.monotonic() >= deadline:
                ctx.log.warning("WAIT UNTIL timed out after %.1fs", self.timeout)
                return ActionResult(False, f"timeout after {self.timeout:g}s ({result.detail})")
            ctx.safety.sleep(self.poll)

    def describe(self) -> str:
        from conditions import describe_condition

        template = "WAIT UNTIL %s (timeout %gs)" if self.expect else "WAIT WHILE NOT %s (timeout %gs)"
        return tr(template) % (describe_condition(self.condition), self.timeout)

    def payload(self) -> dict[str, Any]:
        return {
            "condition": condition_to_dict(self.condition),
            "timeout": self.timeout,
            "poll": self.poll,
            "expect": self.expect,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "WaitUntil":
        return cls(
            condition_from_dict(data.get("condition")),
            float(data.get("timeout", 10.0)),
            float(data.get("poll", 0.5)),
            bool(data.get("expect", True)),
        )


@register_action
@dataclass
class Verify(Action):
    """Capture a new frame, re-analyse it and compare with the expectation."""

    kind: ClassVar[str] = "verify"
    label: ClassVar[str] = "Verify"

    expected_state: str = ""
    condition: Condition | None = None
    timeout: float = 5.0
    poll: float = 0.4

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        outcome = verify_expected(
            ctx, expected_state=self.expected_state or None, condition=self.condition,
            timeout=self.timeout, poll=self.poll,
        )
        return ActionResult(outcome.success, outcome.detail, outcome.confidence)

    def describe(self) -> str:
        from conditions import describe_condition

        if self.expected_state:
            return tr("VERIFY state %s (timeout %gs)") % (self.expected_state, self.timeout)
        return tr("VERIFY %s") % describe_condition(self.condition)

    def payload(self) -> dict[str, Any]:
        return {
            "expected_state": self.expected_state,
            "condition": condition_to_dict(self.condition),
            "timeout": self.timeout,
            "poll": self.poll,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Verify":
        return cls(
            str(data.get("expected_state", "")),
            condition_from_dict(data.get("condition")),
            float(data.get("timeout", 5.0)),
            float(data.get("poll", 0.4)),
        )


@register_action
@dataclass
class Repeat(Action):
    """Run a group of actions several times (LOOP / REPEAT)."""

    kind: ClassVar[str] = "repeat"
    label: ClassVar[str] = "Repeat"

    actions: list[Action] = field(default_factory=list)
    times: int = 2
    delay: float = 0.2
    stop_on_failure: bool = True

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        performed = 0
        for iteration in range(max(1, self.times)):
            ctx.log.debug("Repeat iteration %s/%s", iteration + 1, self.times)
            for action in self.actions:
                result = action.execute(ctx)
                performed += 1
                if not result.success and self.stop_on_failure:
                    return ActionResult(False, f"repeat stopped: {result.detail}")
            if self.delay:
                ctx.safety.sleep(self.delay)
        return ActionResult(True, f"repeated {self.times}x ({performed} actions)")

    def describe(self) -> str:
        return tr("REPEAT %sx (%s action(s))") % (self.times, len(self.actions))

    def payload(self) -> dict[str, Any]:
        return {
            "actions": actions_to_list(self.actions),
            "times": self.times,
            "delay": self.delay,
            "stop_on_failure": self.stop_on_failure,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Repeat":
        return cls(
            actions_from_list(data.get("actions")),
            int(data.get("times", 2)),
            float(data.get("delay", 0.2)),
            bool(data.get("stop_on_failure", True)),
        )


@register_action
@dataclass
class Stop(Action):
    kind: ClassVar[str] = "stop"
    label: ClassVar[str] = "Stop"

    reason: str = "workflow requested stop"

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        raise StopRequested(self.reason)

    def describe(self) -> str:
        return tr("STOP (%s)") % self.reason

    def payload(self) -> dict[str, Any]:
        return {"reason": self.reason}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Stop":
        return cls(str(data.get("reason", "workflow requested stop")))


@register_action
@dataclass
class SetVariable(Action):
    """Store a value (or a recognised number) in a workflow variable."""

    kind: ClassVar[str] = "set_variable"
    label: ClassVar[str] = "Set Variable"

    name: str = "counter"
    value: Any = 0
    mode: str = "set"  # set | increment | from_number | from_text | from_state

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        if self.mode == "increment":
            current = ctx.variables.get(self.name, 0)
            try:
                new_value: Any = float(current) + float(self.value or 1)
                if new_value.is_integer():
                    new_value = int(new_value)
            except (TypeError, ValueError):
                return ActionResult(False, f"variable {self.name} is not numeric")
        elif self.mode == "from_number":
            number, match = ctx.find_number()
            if number is None:
                return ActionResult(False, "no number recognised")
            new_value = number
        elif self.mode == "from_text":
            new_value = ctx.read_text()
        elif self.mode == "from_state":
            new_value = ctx.detect().state
        else:
            new_value = self.value
        ctx.variables[self.name] = new_value
        return ActionResult(True, f"{self.name} = {new_value!r}", value=new_value)

    def describe(self) -> str:
        if self.mode == "increment":
            return tr("SET VARIABLE %s += %s") % (self.name, self.value)
        return tr("SET VARIABLE %s = %r (%s)") % (self.name, self.value, self.mode)

    def payload(self) -> dict[str, Any]:
        return {"name": self.name, "value": self.value, "mode": self.mode}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "SetVariable":
        return cls(str(data.get("name", "counter")), data.get("value", 0), str(data.get("mode", "set")))


@register_action
@dataclass
class LogMessage(Action):
    """Write a note into the live log (no sensitive data please)."""

    kind: ClassVar[str] = "log"
    label: ClassVar[str] = "Log Message"

    message: str = ""
    level: str = "INFO"

    def execute(self, ctx: "AnalysisContext") -> ActionResult:
        ctx.log.log(self.level, "%s", self.message)
        return ActionResult(True, "logged")

    def describe(self) -> str:
        return tr("LOG '%s'") % self.message

    def payload(self) -> dict[str, Any]:
        return {"message": self.message, "level": self.level}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "LogMessage":
        return cls(str(data.get("message", "")), str(data.get("level", "INFO")))


# --------------------------------------------------------------------------- #
# verification
# --------------------------------------------------------------------------- #
@dataclass
class VerificationResult:
    success: bool
    observed_state: str = ""
    confidence: float = 0.0
    detail: str = ""
    timed_out: bool = False
    attempts: int = 0


def verify_expected(
    ctx: "AnalysisContext",
    expected_state: str | None = None,
    condition: Condition | None = None,
    timeout: float = 5.0,
    poll: float = 0.4,
) -> VerificationResult:
    """Capture -> analyse -> detect -> compare with the expectation -> report.

    This is the VERIFY step of the engine loop and is shared by the state machine
    and the workflow VERIFY node.
    """
    ctx.log.info("Verification started")
    deadline = time.monotonic() + max(0.0, timeout)
    attempts = 0
    last_detail = ""
    observed = ""
    confidence = 0.0
    while True:
        attempts += 1
        ctx.refresh()
        if condition is not None:
            result = evaluate(condition, ctx)
            last_detail, confidence = result.detail, result.confidence
            if result.value:
                ctx.log.success("Verification: SUCCESS (%s)", result.detail)
                return VerificationResult(True, ctx.detect().state, confidence, result.detail, False, attempts)
        if expected_state:
            outcome = ctx.detect()
            observed, confidence = outcome.state, outcome.confidence
            ctx.log.info("State detected: %s", outcome.state)
            if outcome.state == expected_state:
                if outcome.ambiguous:
                    last_detail = tr("ambiguous match with %s") % outcome.runner_up
                    ctx.log.warning("Verification: ambiguous (%s)", last_detail)
                else:
                    ctx.log.success("Verification: SUCCESS")
                    return VerificationResult(
                        True, observed, confidence,
                        tr("expected %s confirmed") % expected_state, False, attempts,
                    )
            else:
                last_detail = tr("expected %s, observed %s") % (expected_state, outcome.state)
        if condition is None and not expected_state:
            return VerificationResult(
                True, ctx.detect().state, 1.0, tr("nothing to verify"), False, attempts
            )
        if time.monotonic() >= deadline:
            ctx.log.warning("Verification: FAILED (%s)", last_detail or "timeout")
            return VerificationResult(
                False, observed, confidence, last_detail or tr("timeout"), True, attempts
            )
        ctx.safety.sleep(poll)


def available_actions() -> list[tuple[str, str]]:
    """``(kind, label)`` pairs for the GUI action picker."""
    return [(kind, tr(cls.label)) for kind, cls in ACTION_TYPES.items()]
