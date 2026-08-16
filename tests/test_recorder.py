from __future__ import annotations

import numpy as np
import pytest

from conftest import BUTTON, SCREENS
from actions import (
    DoubleClick,
    Drag,
    Hotkey,
    LeftClick,
    PressKey,
    RightClick,
    TargetMode,
    TypeText,
    Wait,
)
from recorder import (
    ActionRecorder,
    PynputListener,
    RawEvent,
    RecorderSettings,
    ScriptedListener,
    create_listener,
)


def press_release(recorder: ActionRecorder, x: int, y: int, at: float, button: str = "left",
                  release: tuple[int, int] | None = None) -> None:
    recorder.feed(RawEvent(kind="down", x=x, y=y, at=at, button=button))
    end = release or (x, y)
    recorder.feed(RawEvent(kind="up", x=end[0], y=end[1], at=at + 0.05, button=button))


def type_keys(recorder: ActionRecorder, text: str, at: float) -> None:
    for index, character in enumerate(text):
        recorder.feed(
            RawEvent(kind="key_down", key=character.lower(), char=character, at=at + index * 0.05)
        )


def new_recorder(window, log, **settings) -> ActionRecorder:
    options = {"insert_waits": False}
    options.update(settings)
    recorder = ActionRecorder(window, RecorderSettings(**options), log=log)
    recorder.start()
    return recorder


def test_clicks_are_recorded_relative_to_the_window(window, log):
    recorder = new_recorder(window, log)
    # the window sits at (100, 50) and is 320x480
    press_release(recorder, 100 + 160, 50 + 240, at=1.0)
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["click"]
    position = recorder.steps[0].position
    assert abs(position[0] - 0.5) < 0.01 and abs(position[1] - 0.5) < 0.01


def test_recording_survives_a_moved_or_resized_window(window, log):
    recorder = new_recorder(window, log)
    press_release(recorder, 100 + 80, 50 + 120, at=1.0)
    recorded = recorder.steps[0].position
    actions = recorder.to_actions()
    window.fake_backend.move(700, 400)
    window.fake_backend.resize(640, 960)
    window.refresh()
    target = actions[0].target
    assert target.mode is TargetMode.WINDOW
    assert (target.x, target.y) == recorded
    # the same normalized target still points a quarter into the larger window
    assert (target.x, target.y) == (0.25, 0.25)
    assert window.normalized_to_screen(target.x, target.y) == (700 + 160, 400 + 240)


def test_events_outside_the_window_are_ignored(window, log):
    recorder = new_recorder(window, log)
    press_release(recorder, 5, 5, at=1.0)                 # far away from the emulator
    press_release(recorder, 100 + 10, 50 + 10, at=2.0)
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["click"]
    assert recorder.skipped_outside == 2
    assert any("outside the emulator window" in line for line in log.lines())


def test_two_quick_clicks_become_a_double_click(window, log):
    recorder = new_recorder(window, log)
    press_release(recorder, 200, 200, at=1.0)
    press_release(recorder, 201, 201, at=1.2)
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["double"]
    assert isinstance(recorder.to_actions()[0], DoubleClick)


def test_slow_clicks_stay_separate(window, log):
    recorder = new_recorder(window, log)
    press_release(recorder, 200, 200, at=1.0)
    press_release(recorder, 201, 201, at=3.0)
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["click", "click"]


def test_press_and_release_far_apart_is_a_drag(window, log):
    recorder = new_recorder(window, log)
    press_release(recorder, 150, 300, at=1.0, release=(150, 120))
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["drag"]
    action = recorder.to_actions()[0]
    assert isinstance(action, Drag)
    assert action.end.y < action.target.y


def test_right_click_is_recorded(window, log):
    recorder = new_recorder(window, log)
    press_release(recorder, 200, 200, at=1.0, button="right")
    recorder.stop()
    assert isinstance(recorder.to_actions()[0], RightClick)


def test_typing_is_merged_into_one_text_action(window, log):
    recorder = new_recorder(window, log)
    type_keys(recorder, "hello", at=1.0)
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["text"]
    action = recorder.to_actions()[0]
    assert isinstance(action, TypeText) and action.text == "hello"
    assert "5 characters" in recorder.steps[0].describe()


def test_a_long_pause_splits_typed_text(window, log):
    recorder = new_recorder(window, log, typing_gap=0.5)
    type_keys(recorder, "ab", at=1.0)
    type_keys(recorder, "cd", at=5.0)
    recorder.stop()
    assert [step.text for step in recorder.steps] == ["ab", "cd"]


def test_modifier_combinations_become_hotkeys(window, log):
    recorder = new_recorder(window, log)
    recorder.feed(RawEvent(kind="key_down", key="ctrl", at=1.0))
    recorder.feed(RawEvent(kind="key_down", key="a", char="a", at=1.1))
    recorder.feed(RawEvent(kind="key_up", key="a", char="a", at=1.2))
    recorder.feed(RawEvent(kind="key_up", key="ctrl", at=1.3))
    type_keys(recorder, "x", at=2.0)
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["hotkey", "text"]
    hotkey = recorder.to_actions()[0]
    assert isinstance(hotkey, Hotkey) and hotkey.combination == "ctrl+a"


def test_special_keys_are_recorded_individually(window, log):
    recorder = new_recorder(window, log)
    recorder.feed(RawEvent(kind="key_down", key="enter", at=1.0))
    recorder.stop()
    assert isinstance(recorder.to_actions()[0], PressKey)
    assert recorder.to_actions()[0].key == "enter"


def test_pauses_become_wait_actions(window, log):
    recorder = new_recorder(window, log, insert_waits=True, min_wait=0.3)
    press_release(recorder, 200, 200, at=1.0)
    press_release(recorder, 220, 260, at=3.5)
    press_release(recorder, 240, 300, at=3.6)   # too close in time for a wait
    recorder.stop()
    kinds = [step.kind for step in recorder.steps]
    assert kinds == ["click", "wait", "click", "click"]
    waits = [step for step in recorder.steps if step.kind == "wait"]
    assert abs(waits[0].seconds - 2.5) < 0.01
    actions = recorder.to_actions()
    assert isinstance(actions[1], Wait)


def test_long_pauses_are_clamped(window, log):
    recorder = new_recorder(window, log, insert_waits=True, max_wait=2.0)
    press_release(recorder, 200, 200, at=1.0)
    press_release(recorder, 200, 200, at=60.0)
    recorder.stop()
    assert [step.seconds for step in recorder.steps if step.kind == "wait"] == [2.0]


def test_control_keys_are_never_recorded(window, log):
    recorder = new_recorder(window, log)
    for key in ("f8", "f9"):
        recorder.feed(RawEvent(kind="key_down", key=key, at=1.0))
    recorder.stop()
    assert recorder.steps == []


def test_the_stop_key_ends_the_recording(window, log):
    recorder = new_recorder(window, log, stop_key="f10")
    press_release(recorder, 200, 200, at=1.0)
    recorder.feed(RawEvent(kind="key_down", key="f10", at=1.5))
    assert not recorder.recording
    press_release(recorder, 210, 210, at=2.0)     # ignored after the stop
    assert [step.kind for step in recorder.steps] == ["click"]


def test_pointer_moves_are_optional(window, log):
    recorder = new_recorder(window, log)
    recorder.feed(RawEvent(kind="move", x=200, y=200, at=1.0))
    assert recorder.steps == []
    recorder = new_recorder(window, log, record_moves=True)
    recorder.feed(RawEvent(kind="move", x=200, y=200, at=1.0))
    assert [step.kind for step in recorder.steps] == ["move"]


def test_clicks_can_be_anchored_to_a_reference_image(window, log):
    stored: dict[str, np.ndarray] = {}

    def save(patch: np.ndarray, frame_size: tuple[int, int], name: str) -> str:
        stored[name] = patch
        return name

    recorder = ActionRecorder(
        window,
        RecorderSettings(insert_waits=False, anchor_clicks_to_images=True, anchor_patch=30),
        log=log,
        frame_provider=lambda: SCREENS["A"],
    )
    recorder.start()
    click_x, click_y = BUTTON.center
    press_release(recorder, 100 + click_x, 50 + click_y, at=1.0)
    recorder.stop()
    step = recorder.steps[0]
    assert step.patch is not None
    assert step.frame_size == (320, 480)
    assert "recognised element" in step.describe()

    action = recorder.to_actions(save_reference=save)[0]
    assert isinstance(action, LeftClick)
    assert action.target.mode is TargetMode.REFERENCE
    assert action.target.reference in stored
    assert stored[action.target.reference].shape[:2] == (60, 60)
    assert (action.target.offset_x, action.target.offset_y) == (0, 0)


def test_anchored_click_can_be_replayed_on_the_live_screen(window, log, context, references):
    """An anchored click must land on the element, not on the old position."""
    def save(patch, frame_size, name):
        references.add(name, patch, source_size=frame_size)
        return name

    recorder = ActionRecorder(
        window,
        RecorderSettings(insert_waits=False, anchor_clicks_to_images=True, anchor_patch=30),
        log=log,
        frame_provider=lambda: SCREENS["A"],
    )
    recorder.start()
    press_release(recorder, 100 + BUTTON.center[0], 50 + BUTTON.center[1], at=1.0)
    recorder.stop()
    action = recorder.to_actions(save_reference=save)[0]

    context.refresh()
    assert action.execute(context).success
    event = context.pointer_backend.events[-1]
    expected = window.client_to_screen(*BUTTON.center)
    assert abs(event.x - expected[0]) <= 2 and abs(event.y - expected[1]) <= 2


def test_anchoring_failure_falls_back_to_the_position(window, log):
    def failing(patch, frame_size, name):
        raise RuntimeError("disk full")

    recorder = ActionRecorder(
        window,
        RecorderSettings(insert_waits=False, anchor_clicks_to_images=True),
        log=log,
        frame_provider=lambda: SCREENS["A"],
    )
    recorder.start()
    press_release(recorder, 200, 200, at=1.0)
    recorder.stop()
    action = recorder.to_actions(save_reference=failing)[0]
    assert action.target.mode is TargetMode.WINDOW
    assert any("could not be anchored" in line for line in log.lines())


def test_release_drops_the_captured_patches(window, log):
    recorder = ActionRecorder(
        window,
        RecorderSettings(anchor_clicks_to_images=True),
        log=log,
        frame_provider=lambda: SCREENS["A"],
    )
    recorder.start()
    press_release(recorder, 200, 200, at=1.0)
    recorder.stop()
    assert recorder.steps[0].patch is not None
    recorder.release()
    assert all(step.patch is None for step in recorder.steps)


def test_a_recorded_macro_produces_a_complete_action_list(window, log):
    recorder = new_recorder(window, log, insert_waits=True, min_wait=0.3)
    press_release(recorder, 200, 200, at=1.0)                 # click
    press_release(recorder, 201, 201, at=1.2)                 # -> double click
    type_keys(recorder, "abc", at=2.0)                        # text
    recorder.feed(RawEvent(kind="key_down", key="enter", at=3.0))
    press_release(recorder, 150, 400, at=4.0, release=(150, 200))   # drag
    recorder.stop()
    kinds = [step.kind for step in recorder.steps]
    assert kinds == ["double", "wait", "text", "wait", "key", "wait", "drag"]
    actions = recorder.to_actions()
    assert [type(action).__name__ for action in actions] == [
        "DoubleClick", "Wait", "TypeText", "Wait", "PressKey", "Wait", "Drag"
    ]
    assert len(recorder.summary()) == len(recorder.steps)


def test_scripted_listener_feeds_the_recorder(window, log):
    recorder = new_recorder(window, log)
    events = [
        RawEvent(kind="down", x=200, y=200, at=1.0),
        RawEvent(kind="up", x=200, y=200, at=1.1),
    ]
    listener = ScriptedListener(recorder, events)
    assert listener.available()
    listener.start()
    listener.stop()
    recorder.stop()
    assert [step.kind for step in recorder.steps] == ["click"]


def test_pynput_key_translation():
    assert PynputListener._key_name(type("K", (), {"char": "A"})()) == ("a", "A")
    assert PynputListener._key_name(type("K", (), {"char": None, "name": "ctrl_l"})()) == ("ctrl", "")
    assert PynputListener._key_name(type("K", (), {"char": None, "name": "return"})()) == ("enter", "")


def test_listener_creation_reports_a_missing_dependency(window, log, monkeypatch):
    recorder = ActionRecorder(window, log=log)
    monkeypatch.setattr(PynputListener, "available", lambda self: False)
    assert create_listener(recorder, log=log) is None
    assert any("pynput" in line for line in log.lines())
