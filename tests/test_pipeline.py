"""Sequential macros: AUTH_VK is not success; visual check decides MACRO_2."""

from __future__ import annotations

import threading

from actions import LeftClick, SetVariable, Target, TargetMode, TypeText
from logger import Secret
from pipeline import (
    AUTH_ERROR,
    AUTH_MACRO,
    AUTH_SUCCESS,
    MACRO2_ERROR,
    MACRO2_SUCCESS,
    RESET_MACRO,
    SECOND_MACRO,
    Macro,
    PipelineSettings,
    TestData,
    bind_typed_text_to_test_data,
    build_pipeline_workflow,
)
from project import example_project
from state_machine import ReferenceSpec, VisualState
from workflow import WorkflowRunner, outline_text


FAST = PipelineSettings(
    wait_after_auth=0.0,
    wait_after_macro2=0.0,
    unknown_retries=1,
    unknown_delay=0.0,
)


def pipeline_states() -> dict[str, VisualState]:
    return {
        AUTH_ERROR: VisualState(
            name=AUTH_ERROR, references=[ReferenceSpec(image="ref_B")], confidence=0.85
        ),
        AUTH_SUCCESS: VisualState(
            name=AUTH_SUCCESS, references=[ReferenceSpec(image="ref_C")], confidence=0.85
        ),
        MACRO2_ERROR: VisualState(
            name=MACRO2_ERROR, references=[ReferenceSpec(image="ref_B")], confidence=0.85
        ),
        MACRO2_SUCCESS: VisualState(
            name=MACRO2_SUCCESS, references=[ReferenceSpec(image="ref_A")], confidence=0.85
        ),
    }


def attach(context, macros=None, test_data=None, settings=FAST) -> None:
    context.set_states(pipeline_states())
    context.macros = macros or {
        AUTH_MACRO: Macro(AUTH_MACRO),
        SECOND_MACRO: Macro(SECOND_MACRO, actions=[SetVariable(name="macro2_ran", value=1)]),
        RESET_MACRO: Macro(RESET_MACRO),
    }
    context.test_data = test_data if test_data is not None else TestData()
    context.step_by_step = False
    context.step_continue = None


def run_pipeline(context, settings=FAST):
    return WorkflowRunner(context, build_pipeline_workflow(settings)).run()


def log_text(log) -> str:
    return "\n".join(log.lines())


def test_example_project_has_no_demo_states():
    project = example_project()
    assert "STATE_A" not in project.states
    assert "STATE_C" not in project.states
    assert set(project.macros) >= {AUTH_MACRO, SECOND_MACRO, RESET_MACRO}
    text = outline_text(project.workflow)
    assert "AUTH_VK" in text
    assert "MACRO_2" in text
    assert "WAIT FOR AUTH RESULT" in text
    assert "IF STATE AUTH_ERROR detected" in text
    assert "ELSE IF STATE AUTH_SUCCESS detected" in text


def test_auth_error_skips_macro_2_and_loads_the_next_row(context, log):
    attach(
        context,
        test_data=TestData(
            rows=[
                {"login": "one", "password": "secret-one"},
                {"login": "two", "password": "secret-two"},
            ]
        ),
    )
    context.emulator.screen = "B"
    report = run_pipeline(context)
    text = log_text(log)
    assert "AUTH_ERROR detected" in text
    assert "AUTHORIZATION FAILED" in text
    assert "Skipping current test data" in text
    assert "Starting MACRO_2" not in text
    assert "macro2_ran" not in context.variables
    assert "secret-one" not in text
    assert "secret-two" not in text
    starts = [line for line in log.lines() if line.endswith("Starting AUTH_VK")]
    assert len(starts) == 2
    assert report.stop_reason == "no more test data"


def test_auth_success_runs_macro_2_then_verifies(context, log):
    click = LeftClick(target=Target(mode=TargetMode.STATE, state=AUTH_SUCCESS))
    attach(
        context,
        macros={
            AUTH_MACRO: Macro(AUTH_MACRO),
            SECOND_MACRO: Macro(
                SECOND_MACRO,
                actions=[click, SetVariable(name="macro2_ran", value=1)],
            ),
            RESET_MACRO: Macro(RESET_MACRO),
        },
    )
    context.emulator.screen = "C"
    context.emulator.transitions[("click", "C")] = "A"
    report = run_pipeline(context)
    text = log_text(log)
    assert "AUTH_SUCCESS detected" in text
    assert "AUTHORIZATION SUCCESS" in text
    assert "Starting MACRO_2" in text
    assert "MACRO_2 finished" in text
    assert "MACRO_2 SUCCESS detected" in text
    assert "Workflow completed" in text
    assert context.variables["macro2_ran"] == 1
    assert report.stop_reason == "workflow completed"


def test_empty_auth_vk_still_does_the_visual_check(context, log):
    attach(context)
    assert context.macros[AUTH_MACRO].actions == []
    context.emulator.screen = "C"
    run_pipeline(context)
    text = log_text(log)
    assert "AUTH_VK finished" in text
    assert "Checking result" in text
    assert "AUTH_SUCCESS detected" in text
    assert "Starting MACRO_2" in text


def test_unknown_auth_retries_then_stops(context, log):
    attach(context)
    context.emulator.screen = "NOISE"
    report = run_pipeline(context)
    text = log_text(log)
    assert "Starting MACRO_2" not in text
    assert "UNKNOWN_FINAL" in text
    assert report.stop_reason == "UNKNOWN_FINAL"


def test_passwords_from_test_data_are_typed_but_not_logged(context, log):
    attach(
        context,
        macros={
            AUTH_MACRO: Macro(
                AUTH_MACRO,
                actions=[TypeText(variable="password", sensitive=True)],
            ),
            SECOND_MACRO: Macro(SECOND_MACRO, actions=[SetVariable(name="macro2_ran", value=1)]),
            RESET_MACRO: Macro(RESET_MACRO),
        },
        test_data=TestData(rows=[{"login": "user", "password": "hunter2-secret"}]),
    )
    context.emulator.screen = "B"
    run_pipeline(context)
    text = log_text(log)
    assert "hunter2-secret" not in text
    assert isinstance(context.variables.get("password"), Secret)
    assert context.keyboard.backend.events[-1].length == len("hunter2-secret")
    assert "Starting MACRO_2" not in text


def test_bind_typed_text_to_test_data_replaces_recorded_values():
    data = TestData(rows=[{"login": "player", "password": "pw"}])
    macro = Macro(AUTH_MACRO, actions=[TypeText(text="pw"), TypeText(text="player")])
    assert bind_typed_text_to_test_data(macro, data) == 2
    assert macro.actions[0].variable == "password" and macro.actions[0].sensitive
    assert macro.actions[0].text == ""
    assert macro.actions[1].variable == "login" and not macro.actions[1].sensitive


def test_step_by_step_waits_for_continue(context):
    from actions import SetVariable
    from workflow import NodeType, Workflow, WorkflowSettings, make_node

    context.step_by_step = True
    context.step_continue = threading.Event()
    workflow = Workflow(
        nodes=[make_node(NodeType.ACTION, action=SetVariable(name="stepped", value=1))],
        settings=WorkflowSettings(loop=False, cycle_delay=0.0),
    )
    finished = threading.Event()

    def worker():
        WorkflowRunner(context, workflow).run()
        finished.set()

    thread = threading.Thread(target=worker, name="step-test")
    thread.start()
    thread.join(timeout=0.4)
    assert thread.is_alive(), "the runner must wait for F10"
    assert "stepped" not in context.variables
    context.step_continue.set()
    finished.wait(timeout=2.0)
    thread.join(timeout=1.0)
    assert not thread.is_alive()
    assert context.variables["stepped"] == 1
