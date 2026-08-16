"""The visual state machine: analyse, detect, act, verify, choose the next step.

``AnalysisContext`` is the shared runtime: it owns the current frame (in RAM),
the recognition services and the input devices, and caches per-frame results so
several conditions can inspect the same screen cheaply.

``StateDetector`` turns a frame into "this is state X with confidence 0.94", and
``StateMachineRunner`` drives the loop::

    IDLE -> WAITING_FOR_STATE -> STATE_DETECTED -> ACTION -> VERIFY
                                     SUCCESS -> NEXT | FAILED -> FALLBACK | UNKNOWN -> RETRY
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, ClassVar, Protocol, Sequence

import cv2
import numpy as np

from actions import (
    Action,
    ActionResult,
    StopRequested,
    VerificationResult,
    actions_from_list,
    actions_to_list,
    verify_expected,
)
from conditions import Condition, ConditionResult, condition_from_dict, condition_to_dict, evaluate
from i18n import tr
from logger import EventLog, get_logger
from ocr import OcrService, Preprocess
from safety import EmergencyStop, SafetyController, SafetyViolation
from screen_capture import CaptureError, Frame, WindowCapture
from vision import (
    DEFAULT_SCALE_STEPS,
    MatchResult,
    Roi,
    feature_match,
    frame_size,
    histogram_similarity,
    match_template,
    to_gray,
)

UNKNOWN_STATE = "UNKNOWN"
SIGNATURE_SIZE = (64, 64)


class EngineState(str, Enum):
    IDLE = "IDLE"
    WAITING_FOR_STATE = "WAITING_FOR_STATE"
    ANALYZING = "ANALYZING"
    STATE_DETECTED = "STATE_DETECTED"
    ACTION = "ACTION"
    VERIFY = "VERIFY"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    UNKNOWN = "UNKNOWN"
    RETRY = "RETRY"
    FALLBACK = "FALLBACK"
    STOPPED = "STOPPED"


class ReferenceLibrary(Protocol):
    """Source of user-added reference images (implemented by ``project.Project``)."""

    def load_reference(self, name: str) -> np.ndarray | None: ...
    def reference_source_size(self, name: str) -> tuple[int, int] | None: ...


class DictReferenceLibrary:
    """In-memory reference library (tests, demos, generated templates)."""

    def __init__(self, images: dict[str, np.ndarray] | None = None,
                 sizes: dict[str, tuple[int, int]] | None = None) -> None:
        self.images = dict(images or {})
        self.sizes = dict(sizes or {})

    def load_reference(self, name: str) -> np.ndarray | None:
        return self.images.get(name)

    def reference_source_size(self, name: str) -> tuple[int, int] | None:
        return self.sizes.get(name)

    def add(self, name: str, image: np.ndarray, source_size: tuple[int, int] | None = None) -> None:
        self.images[name] = image
        if source_size:
            self.sizes[name] = source_size


# --------------------------------------------------------------------------- #
# state definition
# --------------------------------------------------------------------------- #
@dataclass
class ReferenceSpec:
    """A reference image plus how it should be matched."""

    image: str = ""                 # file name inside the project's references folder
    confidence: float = 0.85
    roi: Roi = field(default_factory=Roi.full)
    grayscale: bool = True
    match_mode: str = "template"    # template | feature | histogram
    multi_scale: bool = True
    source_size: tuple[int, int] | None = None
    weight: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "image": self.image,
            "confidence": self.confidence,
            "roi": self.roi.to_dict(),
            "grayscale": self.grayscale,
            "match_mode": self.match_mode,
            "multi_scale": self.multi_scale,
            "source_size": list(self.source_size) if self.source_size else None,
            "weight": self.weight,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReferenceSpec":
        size = data.get("source_size")
        return cls(
            image=str(data.get("image", "")),
            confidence=float(data.get("confidence", 0.85)),
            roi=Roi.from_dict(data.get("roi")),
            grayscale=bool(data.get("grayscale", True)),
            match_mode=str(data.get("match_mode", "template")),
            multi_scale=bool(data.get("multi_scale", True)),
            source_size=(int(size[0]), int(size[1])) if size else None,
            weight=float(data.get("weight", 1.0)),
        )

    def describe(self) -> str:
        return tr("%s (>= %.2f, %s)") % (self.image, self.confidence, self.roi.describe())


@dataclass
class VisualState:
    """A screen the engine can recognise, plus what to do about it."""

    name: str = ""
    description: str = ""
    references: list[ReferenceSpec] = field(default_factory=list)
    condition: Condition | None = None
    require_condition: bool = True
    match_mode: str = "any"            # any | all (across reference images)
    confidence: float = 0.85
    timeout: float = 10.0
    retry_count: int = 3
    retry_delay: float = 0.8
    cooldown: float = 0.5
    actions: list[Action] = field(default_factory=list)
    expected_state: str = ""           # expected result after the actions
    expected_condition: Condition | None = None
    verify_timeout: float = 5.0
    fallback: str = ""                 # state to run when verification keeps failing
    next_state: str = ""               # state to wait for in the next cycle
    terminal: bool = False             # reaching it successfully ends the run
    enabled: bool = True
    priority: int = 0

    # ---------------------------------------------------------------- helpers
    def has_detection_rule(self) -> bool:
        return bool(self.references) or self.condition is not None

    def has_expectation(self) -> bool:
        return bool(self.expected_state) or self.expected_condition is not None

    def summary(self) -> str:
        parts = [tr("confidence >= %.2f") % self.confidence]
        if self.references:
            parts.append(tr("%s reference image(s)") % len(self.references))
        if self.condition is not None:
            parts.append(self.condition.describe())
        if self.actions:
            parts.append(tr("%s action(s)") % len(self.actions))
        if self.expected_state:
            parts.append(tr("expect %s") % self.expected_state)
        if self.fallback:
            parts.append(tr("fallback %s") % self.fallback)
        return ", ".join(parts)

    # -------------------------------------------------------- serialisation
    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "references": [item.to_dict() for item in self.references],
            "condition": condition_to_dict(self.condition),
            "require_condition": self.require_condition,
            "match_mode": self.match_mode,
            "confidence": self.confidence,
            "timeout": self.timeout,
            "retry_count": self.retry_count,
            "retry_delay": self.retry_delay,
            "cooldown": self.cooldown,
            "actions": actions_to_list(self.actions),
            "expected_state": self.expected_state,
            "expected_condition": condition_to_dict(self.expected_condition),
            "verify_timeout": self.verify_timeout,
            "fallback": self.fallback,
            "next_state": self.next_state,
            "terminal": self.terminal,
            "enabled": self.enabled,
            "priority": self.priority,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VisualState":
        return cls(
            name=str(data.get("name", "")),
            description=str(data.get("description", "")),
            references=[ReferenceSpec.from_dict(item) for item in data.get("references", [])],
            condition=condition_from_dict(data.get("condition")),
            require_condition=bool(data.get("require_condition", True)),
            match_mode=str(data.get("match_mode", "any")),
            confidence=float(data.get("confidence", 0.85)),
            timeout=float(data.get("timeout", 10.0)),
            retry_count=int(data.get("retry_count", 3)),
            retry_delay=float(data.get("retry_delay", 0.8)),
            cooldown=float(data.get("cooldown", 0.5)),
            actions=actions_from_list(data.get("actions")),
            expected_state=str(data.get("expected_state", "")),
            expected_condition=condition_from_dict(data.get("expected_condition")),
            verify_timeout=float(data.get("verify_timeout", 5.0)),
            fallback=str(data.get("fallback", "")),
            next_state=str(data.get("next_state", "")),
            terminal=bool(data.get("terminal", False)),
            enabled=bool(data.get("enabled", True)),
            priority=int(data.get("priority", 0)),
        )


@dataclass
class DetectionOutcome:
    """What the detector concluded about one frame."""

    state: str = UNKNOWN_STATE
    confidence: float = 0.0
    scores: dict[str, float] = field(default_factory=dict)
    matches: dict[str, MatchResult] = field(default_factory=dict)
    runner_up: str = ""
    runner_up_confidence: float = 0.0
    ambiguous: bool = False
    frame_token: int = 0

    @property
    def known(self) -> bool:
        return self.state != UNKNOWN_STATE

    @property
    def match(self) -> MatchResult | None:
        return self.matches.get(self.state)

    def describe(self) -> str:
        if not self.known:
            best = max(self.scores.items(), key=lambda item: item[1], default=("-", 0.0))
            return tr("UNKNOWN (best guess %s at %.2f)") % (best[0], best[1])
        text = tr("%s, confidence=%.2f") % (self.state, self.confidence)
        if self.ambiguous:
            text += tr(" (ambiguous with %s at %.2f)") % (
                self.runner_up, self.runner_up_confidence
            )
        return text


# --------------------------------------------------------------------------- #
# runtime context
# --------------------------------------------------------------------------- #
class AnalysisContext:
    """Everything a condition or an action needs while a workflow runs."""

    def __init__(
        self,
        window: Any,
        capture: WindowCapture,
        mouse: Any,
        keyboard: Any,
        safety: SafetyController,
        states: dict[str, VisualState] | None = None,
        references: ReferenceLibrary | None = None,
        ocr: OcrService | None = None,
        log: EventLog | None = None,
        min_confidence: float = 0.85,
        ambiguity_margin: float = 0.05,
        ocr_preprocess: Preprocess | None = None,
    ) -> None:
        self.window = window
        self.capture = capture
        self.mouse = mouse
        self.keyboard = keyboard
        self.safety = safety
        self.states: dict[str, VisualState] = dict(states or {})
        self.references = references
        self.ocr = ocr or OcrService(log=log)
        self.log = log or get_logger()
        self.min_confidence = min_confidence
        self.ambiguity_margin = ambiguity_margin
        self.ocr_preprocess = ocr_preprocess or Preprocess()
        self.detector = StateDetector(self.states, min_confidence, ambiguity_margin, log=self.log)
        self.variables: dict[str, Any] = {}
        self.frame: Frame | None = None
        self.previous_signature: np.ndarray | None = None
        self.last_match: MatchResult | None = None
        self.frames_analyzed = 0
        self._detection: DetectionOutcome | None = None
        self._signature: np.ndarray | None = None
        self._reference_cache: dict[tuple, MatchResult] = {}
        self._template_cache: dict[str, np.ndarray] = {}

    # ------------------------------------------------------------ lifecycle
    def set_states(self, states: dict[str, VisualState]) -> None:
        self.states = dict(states)
        self.detector.states = self.states
        self._detection = None

    def set_window(self, window: Any) -> None:
        self.window = window
        self.capture.window = window
        if hasattr(self.mouse, "set_window"):
            self.mouse.set_window(window)
        if hasattr(self.keyboard, "set_window"):
            self.keyboard.set_window(window)

    def refresh(self) -> Frame:
        """Capture a new frame into RAM and drop the previous one."""
        self.safety.raise_if_stopped()
        self.safety.wait_while_paused()
        previous = self.frame
        if previous is not None:
            self.previous_signature = self._signature
            previous.release()
        frame = self.capture.grab()
        self.frame = frame
        self.frames_analyzed += 1
        self._detection = None
        self._signature = None
        self._reference_cache.clear()
        self.ocr.invalidate(frame.token)
        return frame

    def ensure_frame(self) -> Frame:
        if self.frame is None or self.frame.is_empty():
            return self.refresh()
        return self.frame

    def release(self) -> None:
        if self.frame is not None:
            self.frame.release()
            self.frame = None
        self._signature = None
        self.previous_signature = None
        self._reference_cache.clear()
        self._template_cache.clear()

    # ---------------------------------------------------------------- frame
    @property
    def image(self) -> np.ndarray:
        return self.ensure_frame().image

    @property
    def frame_token(self) -> int:
        return self.ensure_frame().token

    def signature(self) -> np.ndarray:
        """Small grayscale fingerprint used for 'did the screen change' checks."""
        if self._signature is None:
            self._signature = cv2.resize(
                to_gray(self.image), SIGNATURE_SIZE, interpolation=cv2.INTER_AREA
            )
        return self._signature

    def frame_to_client(self, x: float, y: float) -> tuple[int, int]:
        """Translate frame pixels into client pixels (identical unless scaled)."""
        frame = self.ensure_frame()
        width, height = self.window.client_size
        if frame.width and frame.height and (width, height) != (frame.width, frame.height):
            x = x * width / frame.width
            y = y * height / frame.height
        return int(round(x)), int(round(y))

    # ------------------------------------------------------------ detection
    def detect(self, force: bool = False) -> DetectionOutcome:
        if force or self._detection is None or self._detection.frame_token != self.frame_token:
            self._detection = self.detector.detect(self)
        return self._detection

    def state_match(self, state: str) -> MatchResult | None:
        return self.detect().matches.get(state)

    def set_last_match(self, match: MatchResult | None) -> None:
        if match is not None and match.found:
            self.last_match = match

    # ------------------------------------------------------------ reference
    def reference_template(self, name: str) -> np.ndarray | None:
        if name in self._template_cache:
            return self._template_cache[name]
        if self.references is None:
            return None
        image = self.references.load_reference(name)
        if image is None:
            self.log.warning("Reference image '%s' is not available", name)
            return None
        self._template_cache[name] = image
        return image

    def reference_source_size(self, name: str) -> tuple[int, int] | None:
        if self.references is None:
            return None
        try:
            return self.references.reference_source_size(name)
        except Exception:  # pragma: no cover - library safety
            return None

    def find_reference(
        self,
        name: str,
        threshold: float = 0.85,
        roi: Roi | None = None,
        grayscale: bool = True,
        match_mode: str = "template",
        multi_scale: bool = True,
        source_size: tuple[int, int] | None = None,
    ) -> MatchResult:
        """Locate a reference image on the current frame (results are cached)."""
        roi = (roi or Roi.full()).clamped()
        cache_key = (
            name, round(threshold, 4), roi.x, roi.y, roi.width, roi.height,
            grayscale, match_mode, multi_scale,
        )
        cached = self._reference_cache.get(cache_key)
        if cached is not None:
            return cached
        template = self.reference_template(name)
        image = self.image
        if template is None:
            result = MatchResult(False, 0.0, None, name, match_mode, frame_size(image))
            self._reference_cache[cache_key] = result
            return result
        source = source_size or self.reference_source_size(name)
        base_scale = 1.0
        if source and source[0]:
            base_scale = max(0.2, min(5.0, image.shape[1] / float(source[0])))
        if match_mode == "feature":
            result = feature_match(image, template, threshold=threshold, roi=roi, label=name)
        elif match_mode == "histogram":
            from vision import crop_roi

            area, rect = crop_roi(image, roi)
            score = histogram_similarity(area, template)
            from vision import PixelRect

            result = MatchResult(
                score >= threshold, score, PixelRect(*rect.as_tuple()), name,
                "histogram", frame_size(image),
            )
        else:
            steps = DEFAULT_SCALE_STEPS if multi_scale else (1.0,)
            result = match_template(
                image, template, threshold=threshold, roi=roi, grayscale=grayscale,
                scales=steps, base_scale=base_scale, label=name,
            )
        self._reference_cache[cache_key] = result
        return result

    def find_reference_spec(self, spec: ReferenceSpec) -> MatchResult:
        return self.find_reference(
            spec.image, threshold=spec.confidence, roi=spec.roi, grayscale=spec.grayscale,
            match_mode=spec.match_mode, multi_scale=spec.multi_scale, source_size=spec.source_size,
        )

    # ------------------------------------------------------------------ ocr
    def find_text(self, text: str, roi: Roi | None = None, **kwargs: Any) -> MatchResult:
        return self.ocr.find_text(
            self.image, text, roi=roi, preprocess=self.ocr_preprocess,
            frame_token=self.frame_token, **kwargs,
        )

    def find_number(self, roi: Roi | None = None, **kwargs: Any):
        return self.ocr.find_number(
            self.image, roi=roi, preprocess=self.ocr_preprocess,
            frame_token=self.frame_token, **kwargs,
        )

    def read_text(self, roi: Roi | None = None) -> str:
        return self.ocr.read_text(
            self.image, roi=roi, preprocess=self.ocr_preprocess, frame_token=self.frame_token
        )


# --------------------------------------------------------------------------- #
# detection
# --------------------------------------------------------------------------- #
class StateDetector:
    """Scores every known state against the current frame."""

    def __init__(
        self,
        states: dict[str, VisualState] | None = None,
        min_confidence: float = 0.85,
        ambiguity_margin: float = 0.05,
        log: EventLog | None = None,
    ) -> None:
        self.states = dict(states or {})
        self.min_confidence = min_confidence
        self.ambiguity_margin = ambiguity_margin
        self.log = log or get_logger()

    def score_state(self, ctx: AnalysisContext, state: VisualState) -> tuple[float, MatchResult | None]:
        """Confidence that ``state`` is the screen currently displayed."""
        if not state.has_detection_rule():
            return 0.0, None
        confidence: float | None = None
        best_match: MatchResult | None = None
        if state.references:
            scores: list[float] = []
            for spec in state.references:
                match = ctx.find_reference_spec(spec)
                scores.append(match.confidence)
                if best_match is None or match.confidence > best_match.confidence:
                    best_match = match
            confidence = min(scores) if state.match_mode == "all" else max(scores)
        if state.condition is not None:
            result: ConditionResult = state.condition.evaluate(ctx)
            if state.require_condition and not result.value:
                return 0.0, best_match
            if best_match is None and result.match is not None:
                best_match = result.match
            confidence = result.confidence if confidence is None else min(confidence, result.confidence)
        return float(confidence or 0.0), best_match

    def detect(self, ctx: AnalysisContext) -> DetectionOutcome:
        scores: dict[str, float] = {}
        matches: dict[str, MatchResult] = {}
        for name, state in self.states.items():
            if not state.enabled or not state.has_detection_rule():
                continue
            try:
                confidence, match = self.score_state(ctx, state)
            except Exception as exc:  # a broken state must not kill the run
                self.log.error("State '%s' could not be evaluated: %s", name, exc)
                continue
            scores[name] = confidence
            if match is not None:
                matches[name] = match
        outcome = DetectionOutcome(scores=scores, matches=matches, frame_token=ctx.frame_token)
        if not scores:
            return outcome
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        best_name, best_confidence = ranked[0]
        best_state = self.states[best_name]
        threshold = best_state.confidence or self.min_confidence
        if best_confidence + 1e-9 >= threshold:
            outcome.state = best_name
            outcome.confidence = best_confidence
        else:
            outcome.confidence = best_confidence
        if len(ranked) > 1:
            outcome.runner_up, outcome.runner_up_confidence = ranked[1]
            second_state = self.states.get(outcome.runner_up)
            second_threshold = (second_state.confidence if second_state else self.min_confidence)
            if (
                outcome.known
                and outcome.runner_up_confidence + 1e-9 >= second_threshold
                and abs(best_confidence - outcome.runner_up_confidence) < self.ambiguity_margin
            ):
                outcome.ambiguous = True
        return outcome


# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #
@dataclass
class StepRecord:
    """One analyse/act/verify cycle, kept for the report and the GUI."""

    timestamp: float
    state: str
    confidence: float
    engine_state: str
    detail: str = ""
    verification: str = ""
    attempt: int = 1

    def format(self) -> str:
        clock = time.strftime("%H:%M:%S", time.localtime(self.timestamp))
        return f"[{clock}] {self.state}: {self.engine_state} {self.detail}".rstrip()


@dataclass
class RunnerSettings:
    analyze_interval: float = 0.5
    unknown_wait: float = 1.0
    max_unknown_cycles: int = 20
    max_cycles: int = 0            # 0 = unlimited
    max_duration: float = 0.0      # 0 = unlimited
    stop_on_failure: bool = False
    loop: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "analyze_interval": self.analyze_interval,
            "unknown_wait": self.unknown_wait,
            "max_unknown_cycles": self.max_unknown_cycles,
            "max_cycles": self.max_cycles,
            "max_duration": self.max_duration,
            "stop_on_failure": self.stop_on_failure,
            "loop": self.loop,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RunnerSettings":
        data = dict(data or {})
        known = {name for name in cls.__dataclass_fields__}
        return cls(**{key: value for key, value in data.items() if key in known})


@dataclass
class RunReport:
    started_at: float = field(default_factory=time.time)
    ended_at: float = 0.0
    cycles: int = 0
    successes: int = 0
    failures: int = 0
    retries: int = 0
    unknown: int = 0
    blocked: int = 0
    stop_reason: str = ""
    steps: list[StepRecord] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return (self.ended_at or time.time()) - self.started_at

    def summary(self) -> str:
        return tr(
            "%s cycle(s) in %.1fs, %s success, %s failed, %s retries, %s unknown"
        ) % (
            self.cycles, self.duration, self.successes, self.failures,
            self.retries, self.unknown,
        )


class StateMachineRunner:
    """Autonomous loop over a table of visual states."""

    def __init__(
        self,
        ctx: AnalysisContext,
        settings: RunnerSettings | None = None,
        log: EventLog | None = None,
        on_engine_state: Callable[[EngineState, str], None] | None = None,
        on_step: Callable[[StepRecord], None] | None = None,
    ) -> None:
        self.ctx = ctx
        self.settings = settings or RunnerSettings()
        self.log = log or ctx.log
        self.on_engine_state = on_engine_state
        self.on_step = on_step
        self.engine_state = EngineState.IDLE
        self.report = RunReport()

    # ------------------------------------------------------------- plumbing
    def _set_engine_state(self, state: EngineState, detail: str = "") -> None:
        self.engine_state = state
        if self.on_engine_state is not None:
            try:
                self.on_engine_state(state, detail)
            except Exception:  # pragma: no cover - listener safety
                pass

    def _record(
        self, state: str, confidence: float, engine_state: EngineState,
        detail: str = "", verification: str = "", attempt: int = 1,
    ) -> StepRecord:
        record = StepRecord(time.time(), state, confidence, engine_state.value, detail, verification, attempt)
        self.report.steps.append(record)
        if self.on_step is not None:
            try:
                self.on_step(record)
            except Exception:  # pragma: no cover - listener safety
                pass
        return record

    # ----------------------------------------------------------------- loop
    def run(self, start_state: str = "") -> RunReport:
        self.report = RunReport()
        if not self.ctx.safety.is_running:
            self.ctx.safety.start()
        self._set_engine_state(EngineState.WAITING_FOR_STATE)
        target = start_state
        unknown_streak = 0
        deadline = (
            time.monotonic() + self.settings.max_duration if self.settings.max_duration else None
        )
        try:
            while True:
                self.ctx.safety.raise_if_stopped()
                self.ctx.safety.wait_while_paused()
                if self.settings.max_cycles and self.report.cycles >= self.settings.max_cycles:
                    self.report.stop_reason = f"cycle limit ({self.settings.max_cycles}) reached"
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    self.report.stop_reason = "time limit reached"
                    break
                self.report.cycles += 1
                outcome = self._analyze(target)
                if not outcome.known:
                    unknown_streak += 1
                    self.report.unknown += 1
                    if not self._handle_unknown(outcome, unknown_streak):
                        break
                    target = ""
                    continue
                unknown_streak = 0
                state = self.ctx.states[outcome.state]
                result = self._run_state(state, outcome)
                if result is None:  # stop requested
                    break
                target = result
                if not self.settings.loop and not target:
                    self.report.stop_reason = "single pass finished"
                    break
        except StopRequested as exc:
            self.report.stop_reason = str(exc)
            self.log.info("STOP: %s", exc)
        except EmergencyStop as exc:
            self.report.stop_reason = f"emergency stop: {exc}"
            self.log.error("Run aborted: %s", exc)
        except CaptureError as exc:
            self.report.stop_reason = f"capture failed: {exc}"
            self.log.error("Run aborted: %s", exc)
        finally:
            self.report.ended_at = time.time()
            self._set_engine_state(EngineState.STOPPED, self.report.stop_reason)
            self.log.info("Run finished: %s", self.report.summary())
            if self.report.stop_reason:
                self.log.info("Reason: %s", self.report.stop_reason)
        return self.report

    # -------------------------------------------------------------- analyse
    def _analyze(self, target: str = "") -> DetectionOutcome:
        if target and target in self.ctx.states:
            return self._wait_for_state(target, self.ctx.states[target].timeout)
        self._set_engine_state(EngineState.ANALYZING)
        self.log.info("Analyzing screen")
        self.ctx.refresh()
        outcome = self.ctx.detect()
        if outcome.known:
            self._set_engine_state(EngineState.STATE_DETECTED, outcome.state)
            self.log.success("State detected: %s, confidence=%.2f", outcome.state, outcome.confidence)
        return outcome

    def _wait_for_state(self, name: str, timeout: float) -> DetectionOutcome:
        self._set_engine_state(EngineState.WAITING_FOR_STATE, name)
        self.log.info("Waiting for state %s (timeout %.1fs)", name, timeout)
        deadline = time.monotonic() + max(0.0, timeout)
        outcome = DetectionOutcome(frame_token=0)
        while True:
            self.ctx.refresh()
            outcome = self.ctx.detect()
            if outcome.state == name:
                self._set_engine_state(EngineState.STATE_DETECTED, name)
                self.log.success("State detected: %s, confidence=%.2f", outcome.state, outcome.confidence)
                return outcome
            if outcome.known:
                self.log.info(
                    "Expected %s but found %s (confidence=%.2f)", name, outcome.state, outcome.confidence
                )
                self._set_engine_state(EngineState.STATE_DETECTED, outcome.state)
                return outcome
            if time.monotonic() >= deadline:
                self.log.warning("Timeout while waiting for state %s", name)
                return outcome
            self.ctx.safety.sleep(self.settings.analyze_interval)

    def _handle_unknown(self, outcome: DetectionOutcome, streak: int) -> bool:
        """Returns ``False`` when the run should stop."""
        self._set_engine_state(EngineState.UNKNOWN, outcome.describe())
        self.log.warning("Unknown state (%s)", outcome.describe())
        self._record(UNKNOWN_STATE, outcome.confidence, EngineState.UNKNOWN, outcome.describe())
        handler = self.ctx.states.get(UNKNOWN_STATE)
        if handler is not None and handler.actions:
            self.log.info("Running the UNKNOWN state handler")
            self._execute_actions(handler, attempt=streak)
        if self.settings.max_unknown_cycles and streak >= self.settings.max_unknown_cycles:
            self.report.stop_reason = f"no known state after {streak} attempts"
            self.log.error("Stopping: %s", self.report.stop_reason)
            return False
        self._set_engine_state(EngineState.RETRY, f"unknown x{streak}")
        self.ctx.safety.sleep(self.settings.unknown_wait)
        return True

    # ---------------------------------------------------------------- state
    def _execute_actions(self, state: VisualState, attempt: int) -> tuple[bool, str]:
        self._set_engine_state(EngineState.ACTION, state.name)
        for index, action in enumerate(state.actions, start=1):
            self.ctx.safety.raise_if_stopped()
            self.ctx.safety.wait_while_paused()
            if self.settings.stop_on_failure:
                self.ctx.safety.check_window(self.ctx.window)
            self.log.info("Executing action %s/%s: %s", index, len(state.actions), action.describe())
            try:
                result: ActionResult = action.execute(self.ctx)
            except SafetyViolation as exc:
                self.report.blocked += 1
                self.log.warning("Action blocked: %s", exc)
                return False, str(exc)
            if not result.success:
                self.log.warning("Action failed: %s", result.detail)
                return False, result.detail
        return True, ""

    def _run_state(self, state: VisualState, outcome: DetectionOutcome) -> str | None:
        """Run one state. Returns the next target state, or ``None`` to stop."""
        if outcome.ambiguous:
            self.log.warning(
                "Recognition is ambiguous (%s vs %s): no action performed",
                state.name, outcome.runner_up,
            )
            self._record(state.name, outcome.confidence, EngineState.RETRY, "ambiguous recognition")
            self.ctx.safety.sleep(self.settings.unknown_wait)
            return ""
        if state.cooldown:
            self.ctx.safety.wait_for_cooldown(f"state:{state.name}", state.cooldown)
        attempts = max(1, state.retry_count + 1)
        for attempt in range(1, attempts + 1):
            performed, detail = self._execute_actions(state, attempt)
            self.ctx.safety.note_action(f"state:{state.name}")
            if not performed:
                self.report.failures += 1
                self._record(state.name, outcome.confidence, EngineState.FAILED, detail, attempt=attempt)
                if attempt < attempts:
                    self.report.retries += 1
                    self._set_engine_state(EngineState.RETRY, f"{attempt}/{state.retry_count}")
                    self.log.warning("Retry %s/%s", attempt, state.retry_count)
                    self.ctx.safety.sleep(state.retry_delay)
                    continue
                return self._fallback(state)
            if not state.has_expectation():
                self.report.successes += 1
                self._set_engine_state(EngineState.SUCCESS, state.name)
                self.log.success("SUCCESS")
                self._record(state.name, outcome.confidence, EngineState.SUCCESS, detail or "no verification")
                return self._next_target(state)
            self._set_engine_state(EngineState.VERIFY, state.name)
            verification: VerificationResult = verify_expected(
                self.ctx,
                expected_state=state.expected_state or None,
                condition=state.expected_condition,
                timeout=state.verify_timeout or state.timeout,
            )
            if verification.success:
                self.report.successes += 1
                self._set_engine_state(EngineState.SUCCESS, state.name)
                self.log.success("SUCCESS")
                self._record(
                    state.name, verification.confidence, EngineState.SUCCESS,
                    "verified", verification.detail, attempt,
                )
                return self._next_target(state)
            self.report.failures += 1
            self._record(
                state.name, verification.confidence, EngineState.FAILED,
                "verification failed", verification.detail, attempt,
            )
            if attempt < attempts:
                self.report.retries += 1
                self._set_engine_state(EngineState.RETRY, f"{attempt}/{state.retry_count}")
                self.log.warning("Retry %s/%s", attempt, state.retry_count)
                self.ctx.safety.sleep(state.retry_delay)
        return self._fallback(state)

    def _next_target(self, state: VisualState) -> str | None:
        if state.terminal:
            self.report.stop_reason = f"terminal state {state.name} reached"
            self.log.success("Terminal state %s reached", state.name)
            return None
        if state.next_state:
            self.log.info("Next state: %s", state.next_state)
        return state.next_state

    def _fallback(self, state: VisualState) -> str | None:
        target = (state.fallback or "").strip()
        if not target:
            self.log.error("State %s failed and has no fallback", state.name)
            if self.settings.stop_on_failure:
                self.report.stop_reason = f"state {state.name} failed"
                return None
            return ""
        self._set_engine_state(EngineState.FALLBACK, target)
        if target.upper() == "STOP":
            self.report.stop_reason = f"fallback of {state.name} requested STOP"
            self.log.error("Fallback: STOP")
            return None
        fallback_state = self.ctx.states.get(target)
        if fallback_state is None:
            self.log.error("Fallback state '%s' does not exist", target)
            return ""
        self.log.warning("Fallback: running state %s", target)
        performed, detail = self._execute_actions(fallback_state, attempt=1)
        self._record(
            target, 0.0,
            EngineState.SUCCESS if performed else EngineState.FAILED,
            f"fallback of {state.name}: {detail}" if detail else f"fallback of {state.name}",
        )
        return self._next_target(fallback_state) if performed else ""


def create_context(
    project: Any,
    window: Any,
    safety: SafetyController | None = None,
    log: EventLog | None = None,
    dry_run: bool = False,
    ocr_service: OcrService | None = None,
) -> AnalysisContext:
    """Assemble the runtime for a project and a selected window.

    Used by the GUI and by the headless CLI so both run exactly the same engine.
    """
    from keyboard import Keyboard  # local imports keep the module graph flat
    from mouse import Mouse
    from ocr import create_engine

    log = log or get_logger()
    settings = project.settings
    safety = safety or SafetyController(settings.safety, log=log)
    if hasattr(window, "set_insets"):
        window.set_insets(*settings.window_insets)
    capture = WindowCapture(window, backend=settings.capture_backend, log=log)
    if ocr_service is None:
        ocr_service = OcrService(
            create_engine(settings.ocr_engine, settings.ocr_language, log=log), log=log
        )
    backend_name = "recording" if dry_run else "auto"
    mouse = Mouse(window, safety, backend=backend_name, settings=settings.pointer, log=log)
    keyboard = Keyboard(window, safety, backend=backend_name, log=log)
    context = AnalysisContext(
        window=window,
        capture=capture,
        mouse=mouse,
        keyboard=keyboard,
        safety=safety,
        states=project.states,
        references=project,
        ocr=ocr_service,
        log=log,
        min_confidence=settings.min_confidence,
        ambiguity_margin=settings.safety.ambiguity_margin,
        ocr_preprocess=settings.ocr_preprocess,
    )
    context.variables.update(getattr(project, "variables", {}) or {})
    return context


def build_states(items: Sequence[dict[str, Any]] | None) -> dict[str, VisualState]:
    states: dict[str, VisualState] = {}
    for item in items or []:
        state = VisualState.from_dict(item)
        if state.name:
            states[state.name] = state
    return states
