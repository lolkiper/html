from __future__ import annotations

import time

import pytest

from safety import (
    EmergencyStop,
    RunState,
    SafetyController,
    SafetySettings,
    SafetyViolation,
    audit_no_frame_artifacts,
)


def test_f8_cycles_through_run_states(log):
    controller = SafetyController(log=log)
    assert controller.state == RunState.IDLE
    assert controller.toggle_pause() == RunState.RUNNING
    assert controller.toggle_pause() == RunState.PAUSED
    assert controller.toggle_pause() == RunState.RUNNING


def test_f9_stops_immediately(log):
    controller = SafetyController(log=log)
    controller.start()
    controller.emergency_stop("F9 pressed")
    assert controller.is_stopped
    with pytest.raises(EmergencyStop):
        controller.raise_if_stopped()
    with pytest.raises(EmergencyStop):
        controller.sleep(0.01)


def test_pointer_outside_the_window_is_refused(window, log):
    controller = SafetyController(log=log)
    controller.start()
    decision = controller.authorize_pointer(window, 10, 10)
    assert decision.allowed
    assert decision.screen == window.client_to_screen(10, 10)
    outside = controller.authorize_pointer(window, 5000, 10)
    assert not outside.allowed
    assert "outside" in outside.reason
    assert controller.blocked_actions == 1


def test_dead_or_minimised_window_blocks_actions(window, log):
    controller = SafetyController(log=log)
    controller.start()
    window.fake_backend.minimized = True
    assert not controller.authorize_pointer(window, 10, 10).allowed
    window.fake_backend.minimized = False
    window.fake_backend.alive = False
    assert not controller.authorize_pointer(window, 10, 10).allowed


def test_low_confidence_and_ambiguity_are_refused(window, log):
    controller = SafetyController(SafetySettings(min_confidence=0.85, ambiguity_margin=0.05), log=log)
    controller.start()
    assert not controller.authorize_pointer(window, 10, 10, confidence=0.5).allowed
    assert not controller.authorize_pointer(
        window, 10, 10, confidence=0.90, runner_up=0.88
    ).allowed
    assert controller.authorize_pointer(window, 10, 10, confidence=0.95, runner_up=0.40).allowed


def test_cooldown_delays_a_repeated_action(window, log):
    controller = SafetyController(SafetySettings(pointer_cooldown=0.15), log=log)
    controller.start()
    controller.authorize_pointer(window, 5, 5, key="click")
    controller.note_action("click")
    started = time.monotonic()
    controller.authorize_pointer(window, 5, 5, key="click")
    assert time.monotonic() - started >= 0.1


def test_paused_engine_waits_until_resumed(log):
    controller = SafetyController(log=log)
    controller.start()
    controller.pause()
    started = time.monotonic()
    controller.wait_while_paused(timeout=0.1)
    assert time.monotonic() - started >= 0.09


def test_storage_audit_flags_frame_artifacts(tmp_path):
    (tmp_path / "references").mkdir()
    (tmp_path / "references" / "state_a.png").write_bytes(b"fake png")
    assert audit_no_frame_artifacts(tmp_path) == []
    (tmp_path / "screenshots").mkdir()
    (tmp_path / "screenshots" / "frame_1.png").write_bytes(b"fake png")
    problems = audit_no_frame_artifacts(tmp_path)
    assert any("forbidden directory" in problem for problem in problems)
    assert any("unexpected image file" in problem for problem in problems)
