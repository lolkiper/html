"""Conditions evaluated against the current screen.

These are the building blocks of the IF / ELSE IF / ELSE / AND / OR / NOT logic:
every condition returns a value *and* the confidence it was decided with, plus
the match rectangle when something was located, so an action can click exactly
what the condition found.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, ClassVar, Iterable, Sequence

from i18n import tr
from vision import MatchResult, Roi, color_distance, find_color, image_difference, pixel_color

if TYPE_CHECKING:  # pragma: no cover - typing only
    from state_machine import AnalysisContext

COMPARISONS: dict[str, Callable[[Any, Any], bool]] = {
    "==": lambda left, right: left == right,
    "!=": lambda left, right: left != right,
    ">": lambda left, right: left > right,
    ">=": lambda left, right: left >= right,
    "<": lambda left, right: left < right,
    "<=": lambda left, right: left <= right,
    "contains": lambda left, right: str(right).casefold() in str(left).casefold(),
    "not_contains": lambda left, right: str(right).casefold() not in str(left).casefold(),
}


class ConditionError(RuntimeError):
    """Raised for malformed condition definitions."""


@dataclass
class ConditionResult:
    """Outcome of one condition evaluation."""

    value: bool = False
    confidence: float = 0.0
    detail: str = ""
    match: MatchResult | None = None

    def __bool__(self) -> bool:
        return self.value

    def describe(self) -> str:
        state = "true" if self.value else "false"
        return f"{state} ({self.detail})" if self.detail else state


CONDITION_TYPES: dict[str, type["Condition"]] = {}


def register_condition(cls: type["Condition"]) -> type["Condition"]:
    CONDITION_TYPES[cls.kind] = cls
    return cls


@dataclass
class Condition:
    """Base class: a serialisable predicate over the current frame."""

    kind: ClassVar[str] = "condition"
    label: ClassVar[str] = "Condition"

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:  # pragma: no cover - abstract
        raise NotImplementedError

    def describe(self) -> str:  # pragma: no cover - overridden
        return self.kind

    def payload(self) -> dict[str, Any]:
        return {}

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, **self.payload()}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Condition":  # pragma: no cover - overridden
        return cls()

    def children(self) -> list["Condition"]:
        return []


def condition_from_dict(data: dict[str, Any] | None) -> Condition | None:
    if not data:
        return None
    kind = str(data.get("kind", "")).lower()
    condition_type = CONDITION_TYPES.get(kind)
    if condition_type is None:
        raise ConditionError(f"unknown condition kind: {kind!r}")
    return condition_type.build(data)


def condition_to_dict(condition: Condition | None) -> dict[str, Any] | None:
    return None if condition is None else condition.to_dict()


def evaluate(condition: Condition | None, ctx: "AnalysisContext") -> ConditionResult:
    """Evaluate a condition; a missing condition is treated as ``True``."""
    if condition is None:
        return ConditionResult(True, 1.0, "no condition")
    result = condition.evaluate(ctx)
    if result.match is not None and result.value:
        ctx.set_last_match(result.match)
    return result


# --------------------------------------------------------------------------- #
# leaf conditions
# --------------------------------------------------------------------------- #
@register_condition
@dataclass
class Always(Condition):
    kind: ClassVar[str] = "always"
    label: ClassVar[str] = "Always / Never"

    value: bool = True

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        return ConditionResult(self.value, 1.0, "always" if self.value else "never")

    def describe(self) -> str:
        return tr("ALWAYS") if self.value else tr("NEVER")

    def payload(self) -> dict[str, Any]:
        return {"value": self.value}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Always":
        return cls(bool(data.get("value", True)))


@register_condition
@dataclass
class StateIs(Condition):
    """True when the visual state detected on the current frame is ``state``."""

    kind: ClassVar[str] = "state_is"
    label: ClassVar[str] = "State detected"

    state: str = ""
    min_confidence: float | None = None

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        outcome = ctx.detect()
        threshold = self.min_confidence
        if threshold is None:
            definition = ctx.states.get(self.state)
            threshold = definition.confidence if definition is not None else ctx.min_confidence
        confidence = outcome.scores.get(self.state, 0.0)
        matches = outcome.state == self.state and confidence + 1e-9 >= threshold
        detail = f"state={outcome.state}, confidence={confidence:.2f}, required={threshold:.2f}"
        if outcome.ambiguous and matches:
            detail += " (ambiguous)"
        return ConditionResult(matches, confidence, detail, outcome.matches.get(self.state))

    def describe(self) -> str:
        return tr("STATE %s detected") % (self.state or "?")

    def payload(self) -> dict[str, Any]:
        return {"state": self.state, "min_confidence": self.min_confidence}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "StateIs":
        raw = data.get("min_confidence")
        return cls(str(data.get("state", "")), None if raw is None else float(raw))


@register_condition
@dataclass
class ReferenceVisible(Condition):
    """True when a reference image is found on screen."""

    kind: ClassVar[str] = "reference_visible"
    label: ClassVar[str] = "Reference image visible"

    reference: str = ""
    threshold: float = 0.85
    roi: Roi = field(default_factory=Roi.full)
    grayscale: bool = True
    match_mode: str = "template"

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        match = ctx.find_reference(
            self.reference, threshold=self.threshold, roi=self.roi,
            grayscale=self.grayscale, match_mode=self.match_mode,
        )
        detail = f"reference '{self.reference}' {match.describe()}"
        return ConditionResult(match.found, match.confidence, detail, match)

    def describe(self) -> str:
        return tr("IMAGE '%s' visible (>= %.2f)") % (self.reference, self.threshold)

    def payload(self) -> dict[str, Any]:
        return {
            "reference": self.reference,
            "threshold": self.threshold,
            "roi": self.roi.to_dict(),
            "grayscale": self.grayscale,
            "match_mode": self.match_mode,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "ReferenceVisible":
        return cls(
            str(data.get("reference", "")),
            float(data.get("threshold", 0.85)),
            Roi.from_dict(data.get("roi")),
            bool(data.get("grayscale", True)),
            str(data.get("match_mode", "template")),
        )


@register_condition
@dataclass
class TextVisible(Condition):
    """OCR based text search inside an optional region."""

    kind: ClassVar[str] = "text_visible"
    label: ClassVar[str] = "Text visible"

    text: str = ""
    roi: Roi = field(default_factory=Roi.full)
    min_confidence: float = 0.6
    regex: bool = False
    ignore_case: bool = True
    whole_line: bool = False

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        match = ctx.find_text(
            self.text, roi=self.roi, min_confidence=self.min_confidence,
            regex=self.regex, ignore_case=self.ignore_case, whole_line=self.whole_line,
        )
        detail = f"text '{self.text}' {'found' if match.found else 'not found'}"
        if match.found:
            detail += f" (confidence={match.confidence:.2f})"
        return ConditionResult(match.found, match.confidence, detail, match)

    def describe(self) -> str:
        return tr("TEXT '%s' visible") % self.text

    def payload(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "roi": self.roi.to_dict(),
            "min_confidence": self.min_confidence,
            "regex": self.regex,
            "ignore_case": self.ignore_case,
            "whole_line": self.whole_line,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "TextVisible":
        return cls(
            str(data.get("text", "")),
            Roi.from_dict(data.get("roi")),
            float(data.get("min_confidence", 0.6)),
            bool(data.get("regex", False)),
            bool(data.get("ignore_case", True)),
            bool(data.get("whole_line", False)),
        )


@register_condition
@dataclass
class NumberCompare(Condition):
    """Read a number with OCR and compare it to a value."""

    kind: ClassVar[str] = "number_compare"
    label: ClassVar[str] = "Number comparison"

    operator: str = ">="
    value: float = 0.0
    roi: Roi = field(default_factory=Roi.full)
    index: int = 0
    min_confidence: float = 0.6

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        number, match = ctx.find_number(
            roi=self.roi, index=self.index, min_confidence=self.min_confidence
        )
        if number is None or not match.found:
            return ConditionResult(False, match.confidence, "no number recognised", None)
        compare = COMPARISONS.get(self.operator)
        if compare is None:
            raise ConditionError(f"unsupported operator: {self.operator}")
        result = bool(compare(number, self.value))
        detail = f"number {number:g} {self.operator} {self.value:g} -> {result}"
        return ConditionResult(result, match.confidence, detail, match)

    def describe(self) -> str:
        return tr("NUMBER %s %g") % (self.operator, self.value)

    def payload(self) -> dict[str, Any]:
        return {
            "operator": self.operator,
            "value": self.value,
            "roi": self.roi.to_dict(),
            "index": self.index,
            "min_confidence": self.min_confidence,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "NumberCompare":
        return cls(
            str(data.get("operator", ">=")),
            float(data.get("value", 0.0)),
            Roi.from_dict(data.get("roi")),
            int(data.get("index", 0)),
            float(data.get("min_confidence", 0.6)),
        )


@register_condition
@dataclass
class ColorAt(Condition):
    """Check the colour of a single normalized position."""

    kind: ClassVar[str] = "color_at"
    label: ClassVar[str] = "Pixel colour"

    x: float = 0.5
    y: float = 0.5
    color: tuple[int, int, int] = (255, 255, 255)
    tolerance: float = 0.08

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        image = ctx.image
        px = int(round(self.x * (image.shape[1] - 1)))
        py = int(round(self.y * (image.shape[0] - 1)))
        actual = pixel_color(image, px, py)
        distance = color_distance(actual, self.color)
        confidence = max(0.0, 1.0 - distance)
        value = distance <= self.tolerance
        detail = f"pixel({px},{py})={actual} expected={tuple(self.color)} distance={distance:.3f}"
        return ConditionResult(value, confidence, detail)

    def describe(self) -> str:
        return tr("COLOR at (%.2f,%.2f) == %s") % (self.x, self.y, tuple(self.color))

    def payload(self) -> dict[str, Any]:
        return {"x": self.x, "y": self.y, "color": list(self.color), "tolerance": self.tolerance}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "ColorAt":
        color = data.get("color", [255, 255, 255])
        return cls(
            float(data.get("x", 0.5)),
            float(data.get("y", 0.5)),
            (int(color[0]), int(color[1]), int(color[2])),
            float(data.get("tolerance", 0.08)),
        )


@register_condition
@dataclass
class ColorPresent(Condition):
    """Check whether enough pixels of a colour are visible in a region."""

    kind: ClassVar[str] = "color_present"
    label: ClassVar[str] = "Colour present in region"

    color: tuple[int, int, int] = (0, 200, 0)
    tolerance: int = 30
    roi: Roi = field(default_factory=Roi.full)
    min_coverage: float = 0.05

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        match = find_color(
            ctx.image, self.color, tolerance=self.tolerance, roi=self.roi,
            min_coverage=self.min_coverage, label="colour",
        )
        detail = f"colour {tuple(self.color)} coverage confidence={match.confidence:.2f}"
        return ConditionResult(match.found, match.confidence, detail, match)

    def describe(self) -> str:
        return tr("COLOR %s present") % (tuple(self.color),)

    def payload(self) -> dict[str, Any]:
        return {
            "color": list(self.color),
            "tolerance": self.tolerance,
            "roi": self.roi.to_dict(),
            "min_coverage": self.min_coverage,
        }

    @classmethod
    def build(cls, data: dict[str, Any]) -> "ColorPresent":
        color = data.get("color", [0, 200, 0])
        return cls(
            (int(color[0]), int(color[1]), int(color[2])),
            int(data.get("tolerance", 30)),
            Roi.from_dict(data.get("roi")),
            float(data.get("min_coverage", 0.05)),
        )


@register_condition
@dataclass
class ScreenChanged(Condition):
    """True when the screen differs from the previously analysed frame."""

    kind: ClassVar[str] = "screen_changed"
    label: ClassVar[str] = "Screen changed"

    threshold: float = 0.02

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        previous = ctx.previous_signature
        current = ctx.signature()
        if previous is None:
            return ConditionResult(False, 0.0, "no previous frame")
        difference = image_difference(current, previous)
        value = difference >= self.threshold
        return ConditionResult(value, min(1.0, difference * 10), f"difference={difference:.4f}")

    def describe(self) -> str:
        return tr("SCREEN changed (>= %.3f)") % self.threshold

    def payload(self) -> dict[str, Any]:
        return {"threshold": self.threshold}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "ScreenChanged":
        return cls(float(data.get("threshold", 0.02)))


@register_condition
@dataclass
class VariableCompare(Condition):
    """Compare a workflow variable (counters, results of earlier steps)."""

    kind: ClassVar[str] = "variable_compare"
    label: ClassVar[str] = "Variable comparison"

    name: str = ""
    operator: str = "=="
    value: Any = 0

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        compare = COMPARISONS.get(self.operator)
        if compare is None:
            raise ConditionError(f"unsupported operator: {self.operator}")
        actual = ctx.variables.get(self.name)
        expected = self.value
        if isinstance(actual, (int, float)) and isinstance(expected, str):
            try:
                expected = float(expected)
            except ValueError:
                actual = str(actual)
        try:
            result = bool(compare(actual, expected))
        except TypeError:
            result = False
        detail = f"variable {self.name}={actual!r} {self.operator} {expected!r} -> {result}"
        return ConditionResult(result, 1.0, detail)

    def describe(self) -> str:
        return tr("VAR %s %s %s") % (self.name, self.operator, self.value)

    def payload(self) -> dict[str, Any]:
        return {"name": self.name, "operator": self.operator, "value": self.value}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "VariableCompare":
        return cls(str(data.get("name", "")), str(data.get("operator", "==")), data.get("value", 0))


# --------------------------------------------------------------------------- #
# composite conditions: NOT / AND / OR
# --------------------------------------------------------------------------- #
@register_condition
@dataclass
class Not(Condition):
    kind: ClassVar[str] = "not"
    label: ClassVar[str] = "NOT"

    condition: Condition | None = None

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        inner = evaluate(self.condition, ctx)
        return ConditionResult(not inner.value, inner.confidence, f"NOT ({inner.detail})")

    def describe(self) -> str:
        inner = self.condition.describe() if self.condition else "?"
        return tr("NOT (%s)") % inner

    def payload(self) -> dict[str, Any]:
        return {"condition": condition_to_dict(self.condition)}

    def children(self) -> list[Condition]:
        return [self.condition] if self.condition else []

    @classmethod
    def build(cls, data: dict[str, Any]) -> "Not":
        return cls(condition_from_dict(data.get("condition")))


@dataclass
class _Composite(Condition):
    conditions: list[Condition] = field(default_factory=list)

    def payload(self) -> dict[str, Any]:
        return {"conditions": [item.to_dict() for item in self.conditions]}

    def children(self) -> list[Condition]:
        return list(self.conditions)

    @classmethod
    def build(cls, data: dict[str, Any]):
        items = [condition_from_dict(item) for item in data.get("conditions", [])]
        return cls([item for item in items if item is not None])


@register_condition
@dataclass
class AllOf(_Composite):
    """AND: every sub-condition must hold. Confidence is the weakest link."""

    kind: ClassVar[str] = "all_of"
    label: ClassVar[str] = "AND"

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        if not self.conditions:
            return ConditionResult(True, 1.0, "AND with no sub-conditions")
        confidences: list[float] = []
        best_match: MatchResult | None = None
        details: list[str] = []
        for item in self.conditions:
            result = item.evaluate(ctx)
            confidences.append(result.confidence)
            details.append(result.detail)
            if result.match is not None and best_match is None:
                best_match = result.match
            if not result.value:
                return ConditionResult(False, min(confidences), f"AND failed: {result.detail}")
        return ConditionResult(True, min(confidences), "AND: " + "; ".join(details), best_match)

    def describe(self) -> str:
        return tr(" AND ").join(f"({item.describe()})" for item in self.conditions) or tr("AND")


@register_condition
@dataclass
class AnyOf(_Composite):
    """OR: the first matching sub-condition decides."""

    kind: ClassVar[str] = "any_of"
    label: ClassVar[str] = "OR"

    def evaluate(self, ctx: "AnalysisContext") -> ConditionResult:
        if not self.conditions:
            return ConditionResult(False, 0.0, "OR with no sub-conditions")
        best = ConditionResult(False, 0.0, "OR: nothing matched")
        for item in self.conditions:
            result = item.evaluate(ctx)
            if result.value:
                return ConditionResult(True, result.confidence, f"OR matched: {result.detail}", result.match)
            if result.confidence > best.confidence:
                best = ConditionResult(False, result.confidence, f"OR best: {result.detail}", result.match)
        return best

    def describe(self) -> str:
        return tr(" OR ").join(f"({item.describe()})" for item in self.conditions) or tr("OR")


def describe_condition(condition: Condition | None) -> str:
    return condition.describe() if condition is not None else tr("always")


def available_conditions() -> list[tuple[str, str]]:
    """``(kind, label)`` pairs for the GUI condition picker."""
    return [(kind, tr(cls.label)) for kind, cls in CONDITION_TYPES.items()]
