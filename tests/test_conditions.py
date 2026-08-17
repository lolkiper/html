from __future__ import annotations

import pytest

from conftest import BANNER, BUTTON, ScriptedOcrEngine
from conditions import (
    AllOf,
    Always,
    AnyOf,
    ColorAt,
    ColorPresent,
    ConditionError,
    NumberCompare,
    Not,
    ReferenceVisible,
    ScreenChanged,
    StateIs,
    TextVisible,
    VariableCompare,
    condition_from_dict,
    describe_condition,
    evaluate,
)
from ocr import OcrService
from state_machine import ReferenceSpec, VisualState
from vision import PixelRect, Roi


def define_states(context):
    context.set_states(
        {
            "STATE_A": VisualState(
                name="STATE_A", references=[ReferenceSpec(image="ref_A", confidence=0.85)],
                confidence=0.85,
            ),
            "STATE_B": VisualState(
                name="STATE_B", references=[ReferenceSpec(image="ref_B", confidence=0.85)],
                confidence=0.85,
            ),
        }
    )


def test_reference_visible_finds_the_element(context):
    context.refresh()
    result = ReferenceVisible(reference="ref_A", threshold=0.9).evaluate(context)
    assert result.value and result.confidence > 0.95
    assert result.match.center == BUTTON.center
    assert not ReferenceVisible(reference="ref_B", threshold=0.9).evaluate(context).value


def test_reference_visible_respects_the_roi(context):
    context.refresh()
    top = ReferenceVisible(reference="ref_A", threshold=0.85, roi=Roi(0, 0, 1, 0.4))
    assert not top.evaluate(context).value
    bottom = ReferenceVisible(reference="ref_A", threshold=0.85, roi=Roi(0, 0.5, 1, 0.5))
    assert bottom.evaluate(context).value


def test_state_is_uses_the_detector(context):
    define_states(context)
    context.refresh()
    assert StateIs(state="STATE_A").evaluate(context).value
    assert not StateIs(state="STATE_B").evaluate(context).value
    context.emulator.screen = "B"
    context.refresh()
    assert StateIs(state="STATE_B").evaluate(context).value


def test_state_is_can_require_a_higher_confidence(context):
    define_states(context)
    context.refresh()
    assert not StateIs(state="STATE_A", min_confidence=1.01).evaluate(context).value


def test_text_and_number_conditions(context):
    context.ocr = OcrService(
        ScriptedOcrEngine(
            {
                "A": [("Level 12", 0.92, PixelRect(20, 20, 60, 18))],
                "B": [("Connection error", 0.81, PixelRect(20, 20, 120, 18))],
            },
            context.emulator,
        )
    )
    context.refresh()
    assert TextVisible(text="level").evaluate(context).value
    assert NumberCompare(operator=">=", value=10).evaluate(context).value
    assert not NumberCompare(operator=">", value=20).evaluate(context).value
    context.emulator.screen = "B"
    context.refresh()
    assert TextVisible(text="error").evaluate(context).value
    assert not NumberCompare(operator=">", value=0).evaluate(context).value
    context.emulator.screen = "A"
    context.refresh()
    with pytest.raises(ConditionError):
        NumberCompare(operator="~", value=1).evaluate(context)


def test_colour_conditions(context):
    context.refresh()
    corner = ColorAt(x=10 / 319, y=10 / 479, color=(200, 200, 200), tolerance=0.05)
    assert corner.evaluate(context).value
    assert not ColorAt(x=0.5, y=0.05, color=(0, 255, 0), tolerance=0.02).evaluate(context).value
    assert ColorPresent(color=(24, 24, 24), tolerance=6, min_coverage=0.2).evaluate(context).value


def test_screen_changed_compares_with_the_previous_frame(context):
    context.refresh()
    assert not ScreenChanged().evaluate(context).value  # no previous frame yet
    context.refresh()
    assert not ScreenChanged(threshold=0.01).evaluate(context).value
    context.emulator.screen = "C"
    context.refresh()
    assert ScreenChanged(threshold=0.01).evaluate(context).value


def test_variable_comparison(context):
    context.variables["retries"] = 3
    assert VariableCompare(name="retries", operator="==", value=3).evaluate(context).value
    assert VariableCompare(name="retries", operator="<", value="5").evaluate(context).value
    assert not VariableCompare(name="missing", operator="==", value=1).evaluate(context).value


def test_logical_composition(context):
    define_states(context)
    context.refresh()
    a_visible = ReferenceVisible(reference="ref_A", threshold=0.9)
    b_visible = ReferenceVisible(reference="ref_B", threshold=0.9)
    assert Not(condition=b_visible).evaluate(context).value
    assert AllOf([a_visible, Not(condition=b_visible)]).evaluate(context).value
    assert not AllOf([a_visible, b_visible]).evaluate(context).value
    assert AnyOf([b_visible, a_visible]).evaluate(context).value
    assert not AnyOf([b_visible, Not(condition=a_visible)]).evaluate(context).value
    assert AllOf([]).evaluate(context).value
    assert not AnyOf([]).evaluate(context).value


def test_and_confidence_is_the_weakest_link(context):
    define_states(context)
    context.refresh()
    combined = AllOf([Always(True), ReferenceVisible(reference="ref_A", threshold=0.5)])
    result = combined.evaluate(context)
    assert result.value and result.confidence < 1.0


def test_missing_condition_is_true(context):
    assert evaluate(None, context).value
    assert describe_condition(None) == "always"


def test_every_condition_survives_serialisation():
    samples = [
        Always(False),
        StateIs(state="X", min_confidence=0.9),
        ReferenceVisible(reference="r", threshold=0.7, roi=Roi(0.1, 0.2, 0.3, 0.4)),
        TextVisible(text="hi", regex=True, ignore_case=False),
        NumberCompare(operator="<", value=5.5, index=2),
        ColorAt(x=0.1, y=0.2, color=(1, 2, 3), tolerance=0.2),
        ColorPresent(color=(4, 5, 6), tolerance=10, min_coverage=0.3),
        ScreenChanged(threshold=0.05),
        VariableCompare(name="v", operator="contains", value="abc"),
        Not(condition=Always(True)),
        AllOf([Always(True), Always(False)]),
        AnyOf([StateIs(state="Y")]),
    ]
    for condition in samples:
        restored = condition_from_dict(condition.to_dict())
        assert restored.to_dict() == condition.to_dict()
        assert restored.describe() == condition.describe()
    with pytest.raises(ConditionError):
        condition_from_dict({"kind": "does_not_exist"})


def test_successful_match_is_remembered_as_last_match(context):
    context.refresh()
    evaluate(ReferenceVisible(reference="ref_A", threshold=0.9), context)
    assert context.last_match is not None
    assert context.last_match.center == BUTTON.center
