from __future__ import annotations

from conftest import BANNER, BUTTON
from actions import LeftClick, Stop, Target, TargetMode, Wait
from conditions import ReferenceVisible, StateIs, TextVisible
from state_machine import (
    EngineState,
    ReferenceSpec,
    RunnerSettings,
    StateDetector,
    StateMachineRunner,
    UNKNOWN_STATE,
    VisualState,
    build_states,
)


def state(name: str, reference: str, **kwargs) -> VisualState:
    kwargs.setdefault("confidence", 0.85)
    return VisualState(name=name, references=[ReferenceSpec(image=reference)], **kwargs)


def three_states(context, **a_kwargs) -> None:
    context.set_states(
        {
            "STATE_A": state("STATE_A", "ref_A", **a_kwargs),
            "STATE_B": state("STATE_B", "ref_B"),
            "STATE_C": state("STATE_C", "ref_C"),
        }
    )


def test_detector_identifies_the_current_screen(context):
    three_states(context)
    context.refresh()
    outcome = context.detect()
    assert outcome.state == "STATE_A"
    assert outcome.confidence > 0.95
    assert not outcome.ambiguous
    assert outcome.match.center == BUTTON.center
    assert set(outcome.scores) == {"STATE_A", "STATE_B", "STATE_C"}
    assert "STATE_A" in outcome.describe()


def test_unrecognised_screen_becomes_unknown(context):
    three_states(context)
    context.emulator.screen = "NOISE"
    context.refresh()
    outcome = context.detect()
    assert outcome.state == UNKNOWN_STATE
    assert not outcome.known
    assert "UNKNOWN" in outcome.describe()


def test_detection_is_cached_per_frame(context):
    three_states(context)
    context.refresh()
    first = context.detect()
    assert context.detect() is first
    context.refresh()
    assert context.detect() is not first


def test_ambiguous_recognition_is_flagged(context):
    context.set_states(
        {
            "STATE_A": state("STATE_A", "ref_A"),
            "STATE_A_COPY": state("STATE_A_COPY", "ref_A"),
        }
    )
    context.refresh()
    outcome = context.detect()
    assert outcome.ambiguous
    assert outcome.runner_up in ("STATE_A", "STATE_A_COPY")


def test_states_can_require_several_references(context):
    both = VisualState(
        name="BOTH",
        references=[ReferenceSpec(image="ref_A"), ReferenceSpec(image="ref_B")],
        match_mode="all",
        confidence=0.85,
    )
    context.set_states({"BOTH": both})
    context.refresh()
    assert context.detect().state == UNKNOWN_STATE
    both.match_mode = "any"
    context.set_states({"BOTH": both})
    context.refresh()
    assert context.detect().state == "BOTH"


def test_condition_can_gate_a_state(context):
    gated = VisualState(
        name="GATED",
        references=[ReferenceSpec(image="ref_A")],
        condition=ReferenceVisible(reference="ref_B", threshold=0.9),
        confidence=0.8,
    )
    context.set_states({"GATED": gated})
    context.refresh()
    assert context.detect().state == UNKNOWN_STATE
    gated.condition = ReferenceVisible(reference="ref_A", threshold=0.9)
    context.set_states({"GATED": gated})
    context.refresh()
    assert context.detect().state == "GATED"


def test_state_without_detection_rule_is_never_detected(context):
    context.set_states({"EMPTY": VisualState(name="EMPTY")})
    context.refresh()
    assert context.detect().state == UNKNOWN_STATE


def test_runner_acts_on_the_detected_state_and_verifies_the_result(context, log):
    three_states(
        context,
        actions=[LeftClick(target=Target(mode=TargetMode.STATE, state="STATE_A"))],
        expected_state="STATE_C",
        verify_timeout=1.0,
        cooldown=0.0,
    )
    context.states["STATE_C"].terminal = True
    context.emulator.transitions[("click", "A")] = "C"
    runner = StateMachineRunner(context, RunnerSettings(analyze_interval=0.01, unknown_wait=0.01))
    report = runner.run()
    assert report.successes >= 1
    assert report.failures == 0
    assert "terminal state" in report.stop_reason
    lines = log.lines()
    assert any("State detected: STATE_A" in line for line in lines)
    assert any("Verification started" in line for line in lines)
    assert any("SUCCESS" in line for line in lines)
    assert context.emulator.clicks


def test_runner_retries_then_uses_the_fallback(context, log):
    three_states(
        context,
        actions=[Wait(seconds=0.0)],
        expected_state="STATE_C",   # never reached: nothing changes the screen
        verify_timeout=0.05,
        retry_count=2,
        retry_delay=0.0,
        cooldown=0.0,
        fallback="STOP",
    )
    runner = StateMachineRunner(context, RunnerSettings(analyze_interval=0.01, unknown_wait=0.01))
    report = runner.run()
    assert report.retries == 2
    assert report.failures == 3
    assert "STOP" in report.stop_reason
    assert any("Retry 1/2" in line for line in log.lines())
    assert any("Verification: FAILED" in line for line in log.lines())


def test_runner_runs_a_fallback_state(context):
    three_states(
        context,
        actions=[Wait(seconds=0.0)],
        expected_state="STATE_C",
        verify_timeout=0.02,
        retry_count=0,
        cooldown=0.0,
        fallback="RECOVER",
    )
    context.states["RECOVER"] = VisualState(
        name="RECOVER", actions=[Stop(reason="recovered")], confidence=0.99
    )
    report = StateMachineRunner(context, RunnerSettings(analyze_interval=0.01)).run()
    assert report.stop_reason == "recovered"


def test_runner_stops_after_too_many_unknown_frames(context, log):
    three_states(context)
    context.emulator.screen = "NOISE"
    runner = StateMachineRunner(
        context, RunnerSettings(analyze_interval=0.0, unknown_wait=0.0, max_unknown_cycles=3)
    )
    report = runner.run()
    assert report.unknown == 3
    assert "no known state" in report.stop_reason
    assert any("Unknown state" in line for line in log.lines())


def test_unknown_handler_state_is_executed(context):
    three_states(context)
    context.emulator.screen = "NOISE"
    context.states[UNKNOWN_STATE] = VisualState(
        name=UNKNOWN_STATE, actions=[Stop(reason="giving up")], confidence=0.99
    )
    report = StateMachineRunner(
        context, RunnerSettings(analyze_interval=0.0, unknown_wait=0.0, max_unknown_cycles=5)
    ).run()
    assert report.stop_reason == "giving up"


def test_ambiguity_prevents_actions(context, log):
    context.set_states(
        {
            "STATE_A": state(
                "STATE_A", "ref_A",
                actions=[LeftClick(target=Target(mode=TargetMode.STATE, state="STATE_A"))],
            ),
            "STATE_A_COPY": state("STATE_A_COPY", "ref_A"),
        }
    )
    runner = StateMachineRunner(
        context, RunnerSettings(analyze_interval=0.0, unknown_wait=0.0, max_cycles=1)
    )
    runner.run()
    assert not context.emulator.clicks
    assert any("ambiguous" in line for line in log.lines())


def test_engine_state_transitions_are_reported(context):
    three_states(
        context, actions=[Wait(seconds=0.0)], cooldown=0.0,
    )
    seen: list[str] = []
    runner = StateMachineRunner(
        context,
        RunnerSettings(analyze_interval=0.0, max_cycles=1, loop=False),
        on_engine_state=lambda state, detail: seen.append(state.value),
    )
    runner.run()
    assert "ANALYZING" in seen and "STATE_DETECTED" in seen and "ACTION" in seen
    assert seen[-1] == EngineState.STOPPED.value


def test_emergency_stop_interrupts_the_run(context):
    three_states(context, actions=[Wait(seconds=5.0)], cooldown=0.0)
    import threading

    threading.Timer(0.05, lambda: context.safety.emergency_stop("test")).start()
    report = StateMachineRunner(context, RunnerSettings(analyze_interval=0.0)).run()
    assert "emergency stop" in report.stop_reason


def test_state_serialisation_roundtrip():
    original = VisualState(
        name="STATE_X",
        description="demo",
        references=[ReferenceSpec(image="ref", confidence=0.7, source_size=(320, 480))],
        condition=TextVisible(text="ok"),
        actions=[LeftClick(target=Target(mode=TargetMode.LAST_MATCH))],
        expected_state="STATE_Y",
        expected_condition=StateIs(state="STATE_Y"),
        fallback="STOP",
        next_state="STATE_Y",
        terminal=True,
        priority=5,
    )
    restored = VisualState.from_dict(original.to_dict())
    assert restored.to_dict() == original.to_dict()
    assert restored.references[0].source_size == (320, 480)
    assert "reference image" in restored.summary()
    states = build_states([original.to_dict()])
    assert list(states) == ["STATE_X"]


def test_detector_survives_a_broken_state(context, log):
    class Explosive(ReferenceVisible):
        def evaluate(self, ctx):
            raise RuntimeError("boom")

    context.set_states(
        {
            "GOOD": state("GOOD", "ref_A"),
            "BAD": VisualState(name="BAD", condition=Explosive(reference="x")),
        }
    )
    context.refresh()
    outcome = context.detect()
    assert outcome.state == "GOOD"
    assert any("could not be evaluated" in line for line in log.lines())
