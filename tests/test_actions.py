from __future__ import annotations

import pytest

from conftest import BANNER, BUTTON, ScriptedOcrEngine
from actions import (
    ACTION_TYPES,
    Drag,
    DoubleClick,
    Hotkey,
    LeftClick,
    LogMessage,
    MoveMouse,
    PressKey,
    Repeat,
    RightClick,
    SetVariable,
    Stop,
    StopRequested,
    Target,
    TargetMode,
    TypeText,
    Verify,
    Wait,
    WaitUntil,
    action_from_dict,
    verify_expected,
)
from conditions import Always, ReferenceVisible, StateIs
from logger import Secret
from ocr import OcrService
from pipeline import LoadTestData, MarkRecord, NextTestData, SignalFail, WaitForManual, WaitForStartState
from state_machine import ReferenceSpec, VisualState
from vision import PixelRect, Roi


def with_states(context):
    context.set_states(
        {
            "STATE_A": VisualState(
                name="STATE_A", references=[ReferenceSpec(image="ref_A")], confidence=0.85
            ),
            "STATE_C": VisualState(
                name="STATE_C", references=[ReferenceSpec(image="ref_C")], confidence=0.85
            ),
        }
    )


def test_window_target_uses_normalized_coordinates(context):
    context.refresh()
    point = Target(mode=TargetMode.WINDOW, x=0.5, y=0.25).resolve(context)
    assert (point.x, point.y) == (160, 120)
    assert point.confidence is None
    pixels = Target(mode=TargetMode.WINDOW, x=12, y=34, units="pixels").resolve(context)
    assert (pixels.x, pixels.y) == (12, 34)


def test_reference_target_resolves_to_the_element_centre(context):
    context.refresh()
    point = Target(mode=TargetMode.REFERENCE, reference="ref_A", threshold=0.9).resolve(context)
    assert (point.x, point.y) == BUTTON.center
    assert point.confidence > 0.95
    missing = Target(mode=TargetMode.REFERENCE, reference="ref_B", threshold=0.9).resolve(context)
    assert missing is None


def test_state_target_uses_the_element_that_identified_the_state(context):
    with_states(context)
    context.refresh()
    point = Target(mode=TargetMode.STATE, state="STATE_A").resolve(context)
    assert (point.x, point.y) == BUTTON.center


def test_offsets_and_anchors(context):
    context.refresh()
    target = Target(
        mode=TargetMode.REFERENCE, reference="ref_A", anchor="topleft", offset_x=5, offset_y=-3
    )
    point = target.resolve(context)
    assert (point.x, point.y) == (BUTTON.x + 5, BUTTON.y - 3)


def test_click_on_a_recognised_element_hits_the_right_screen_pixel(context):
    context.refresh()
    action = LeftClick(target=Target(mode=TargetMode.REFERENCE, reference="ref_A", threshold=0.9))
    result = action.execute(context)
    assert result.success
    event = context.pointer_backend.events[-1]
    expected = context.window.client_to_screen(*BUTTON.center)
    assert abs(event.x - expected[0]) <= 1 and abs(event.y - expected[1]) <= 1
    assert event.clicks == 1 and event.button == "left"


def test_click_modes_are_reported_in_the_log(context, log):
    context.refresh()
    LeftClick(target=Target(mode=TargetMode.WINDOW, x=0.5, y=0.5)).execute(context)
    assert any("window position" in line for line in log.lines())
    LeftClick(target=Target(mode=TargetMode.REFERENCE, reference="ref_A")).execute(context)
    assert any("reference 'ref_A'" in line for line in log.lines())


def test_double_and_right_click(context):
    context.refresh()
    DoubleClick(target=Target(mode=TargetMode.WINDOW, x=0.5, y=0.5)).execute(context)
    assert context.pointer_backend.events[-1].clicks == 2
    RightClick(target=Target(mode=TargetMode.WINDOW, x=0.5, y=0.5)).execute(context)
    assert context.pointer_backend.events[-1].button == "right"


def test_click_outside_the_window_is_cancelled(context):
    context.refresh()
    action = LeftClick(target=Target(mode=TargetMode.WINDOW, x=1.9, y=0.5, units="normalized"))
    result = action.execute(context)
    assert not result.success
    assert not context.pointer_backend.events


def test_click_below_required_confidence_is_cancelled(context):
    context.refresh()
    action = LeftClick(
        target=Target(mode=TargetMode.REFERENCE, reference="ref_A", threshold=0.5),
        require_confidence=0.999999,
    )
    result = action.execute(context)
    assert not result.success and "confidence" in result.detail
    assert not context.pointer_backend.events


def test_missing_target_is_reported_not_clicked(context):
    context.refresh()
    result = LeftClick(target=Target(mode=TargetMode.LAST_MATCH)).execute(context)
    assert not result.success and "not found" in result.detail


def test_move_and_drag(context):
    context.refresh()
    assert MoveMouse(target=Target(mode=TargetMode.WINDOW, x=0.1, y=0.1)).execute(context).success
    assert context.pointer_backend.events[-1].kind == "move"
    drag = Drag(
        target=Target(mode=TargetMode.WINDOW, x=0.2, y=0.8),
        end=Target(mode=TargetMode.WINDOW, x=0.8, y=0.2),
        duration=0.01,
    )
    assert drag.execute(context).success
    event = context.pointer_backend.events[-1]
    assert event.kind == "drag" and event.to_x > event.x and event.to_y < event.y


def test_keyboard_actions(context):
    context.refresh()
    assert PressKey(key="esc").execute(context).success
    assert Hotkey(combination="ctrl+shift+s").execute(context).success
    events = context.keyboard.backend.events
    assert events[0].keys == ("esc",)
    assert events[1].keys == ("ctrl", "shift", "s")


def test_sensitive_text_is_never_logged(context, log):
    context.refresh()
    action = TypeField = TypeText(text="SuperSecret123", sensitive=True)
    assert action.execute(context).success
    assert all("SuperSecret123" not in line for line in log.lines())
    assert any("Typed text" in line for line in log.lines())
    assert action.describe().count("SuperSecret123") == 0
    assert context.keyboard.backend.events[-1].length == len("SuperSecret123")


def test_text_can_come_from_a_variable(context):
    context.refresh()
    context.variables["login"] = "player_one"
    action = TypeText(variable="login")
    assert action.execute(context).success
    assert context.keyboard.backend.events[-1].length == len("player_one")
    assert TypeText(variable="unset").execute(context).success is False
    assert context.keyboard.backend.events[-1].text == "player_one"


def test_secret_variable_is_typed_but_never_logged(context, log):
    context.refresh()
    context.variables["password"] = Secret("hunter2-secret")
    context.log.register_secret("hunter2-secret")
    action = TypeText(variable="password", sensitive=True)
    assert action.execute(context).success
    assert context.keyboard.backend.events[-1].length == len("hunter2-secret")
    joined = "\n".join(log.lines())
    assert "hunter2-secret" not in joined
    assert "TYPE VARIABLE {{PASSWORD}}" == action.describe()


def test_insert_variable_types_context_and_literal_text_stays_literal(context, log):
    context.refresh()
    context.variables["EMAIL"] = "test@example.com"
    context.variables["PASSWORD"] = Secret("test_password")
    context.log.register_secret("test_password")
    context.allow_password = True

    variable = TypeText(text="{{EMAIL}}", is_variable=True)
    literal = TypeText(text="email@example.com", is_variable=False)
    leftover = TypeText(text="{{EMAIL}}", is_variable=False)

    dumped = variable.to_dict()
    assert dumped["type"] == "type"
    assert dumped["text"] == "{{EMAIL}}"
    assert dumped["is_variable"] is True
    restored = action_from_dict(dumped)
    assert isinstance(restored, TypeText)
    assert restored.is_variable is True
    assert restored.text == "{{EMAIL}}"

    from_alias = action_from_dict({"type": "type", "text": "{{PASSWORD}}", "is_variable": True})
    assert isinstance(from_alias, TypeText) and from_alias.is_variable

    assert variable.execute(context).success
    assert literal.execute(context).success
    leftover_result = leftover.execute(context)
    assert leftover_result.success is False
    typed = [event for event in context.keyboard.backend.events if event.kind == "type"]
    assert typed[0].text == "test@example.com"
    assert typed[1].text == "email@example.com"
    assert all(event.text != "{{EMAIL}}" for event in typed)
    joined = "\n".join(log.lines())
    assert "test@example.com" not in joined
    assert "test_password" not in joined
    assert "{{EMAIL}}" not in [event.text for event in typed]
    assert variable.describe() == "TYPE VARIABLE {{EMAIL}}"
    assert leftover.describe() == "TYPE TEXT '{{EMAIL}}'"


def test_wait_and_wait_until(context):
    context.refresh()
    assert Wait(seconds=0.01).execute(context).success
    reached = WaitUntil(condition=Always(True), timeout=0.5, poll=0.01)
    assert reached.execute(context).success
    timed_out = WaitUntil(condition=Always(False), timeout=0.05, poll=0.01)
    result = timed_out.execute(context)
    assert not result.success and "timeout" in result.detail


def test_repeat_runs_the_group_and_stops_on_failure(context):
    context.refresh()
    ok = Repeat(actions=[Wait(seconds=0.0)], times=3, delay=0.0)
    assert ok.execute(context).success
    failing = Repeat(
        actions=[LeftClick(target=Target(mode=TargetMode.LAST_MATCH))], times=2, delay=0.0
    )
    assert not failing.execute(context).success


def test_stop_action_raises(context):
    with pytest.raises(StopRequested, match="done"):
        Stop(reason="done").execute(context)


def test_variables_can_be_set_and_incremented(context):
    context.refresh()
    SetVariable(name="runs", value=1).execute(context)
    assert context.variables["runs"] == 1
    SetVariable(name="runs", value=2, mode="increment").execute(context)
    assert context.variables["runs"] == 3
    context.ocr = OcrService(ScriptedOcrEngine({"*": [("42 gold", 0.9, PixelRect(0, 0, 40, 10))]}))
    SetVariable(name="gold", mode="from_number").execute(context)
    assert context.variables["gold"] == 42.0
    LogMessage(message="checkpoint").execute(context)


def test_verify_confirms_the_state_change_after_a_click(context, log):
    with_states(context)
    context.emulator.transitions[("click", "A")] = "C"
    context.refresh()
    click = LeftClick(target=Target(mode=TargetMode.STATE, state="STATE_A"))
    assert click.execute(context).success
    result = Verify(expected_state="STATE_C", timeout=1.0, poll=0.01).execute(context)
    assert result.success
    lines = log.lines()
    assert any("Verification started" in line for line in lines)
    assert any("Verification: SUCCESS" in line for line in lines)


def test_verify_fails_when_the_expected_state_never_appears(context, log):
    with_states(context)
    context.refresh()
    outcome = verify_expected(context, expected_state="STATE_C", timeout=0.05, poll=0.01)
    assert not outcome.success and outcome.timed_out
    assert any("Verification: FAILED" in line for line in log.lines())


def test_verify_accepts_a_condition(context):
    context.refresh()
    outcome = verify_expected(
        context, condition=ReferenceVisible(reference="ref_A", threshold=0.9), timeout=0.1, poll=0.01
    )
    assert outcome.success


def test_every_action_survives_serialisation():
    samples = [
        MoveMouse(target=Target(mode=TargetMode.LAST_MATCH, offset_x=3)),
        LeftClick(target=Target(mode=TargetMode.REFERENCE, reference="r"), require_confidence=0.9),
        DoubleClick(),
        RightClick(cooldown=1.5),
        Drag(end=Target(mode=TargetMode.WINDOW, x=0.9, y=0.9), duration=0.7),
        PressKey(key="enter", presses=3),
        Hotkey(combination="alt+f4"),
        TypeText(text="abc", sensitive=True, clear_first=True),
        Wait(seconds=2.5, jitter=0.5),
        WaitUntil(condition=StateIs(state="X"), timeout=7.0),
        Verify(expected_state="Y", timeout=3.0),
        Repeat(actions=[Wait(seconds=1.0)], times=4),
        Stop(reason="finished"),
        SetVariable(name="n", value=5, mode="increment"),
        LogMessage(message="hello"),
        SignalFail(reason="still unknown"),
        LoadTestData(),
        NextTestData(),
        MarkRecord(outcome="success"),
        WaitForManual(),
        WaitForStartState(timeout=5.0),
    ]
    for action in samples:
        restored = action_from_dict(action.to_dict())
        assert restored.to_dict() == action.to_dict()
        assert restored.describe() == action.describe()
    assert len(ACTION_TYPES) == len(samples)
    with pytest.raises(ValueError):
        action_from_dict({"kind": "nope"})
