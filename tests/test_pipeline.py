"""Four-stage workflow: each MACRO is followed by a visual VERIFY."""

from __future__ import annotations

import threading

from actions import SetVariable, TypeText
from logger import Secret
from pipeline import (
    EMAIL_VAR,
    PASSWORD_VAR,
    RESET_MACRO,
    STAGE_MACROS,
    Macro,
    PipelineSettings,
    TestData,
    bind_typed_text_to_test_data,
    build_pipeline_workflow,
    parse_record_text,
    substitute_placeholders,
    verify_error,
    verify_success,
)
from project import example_project
from state_machine import ReferenceSpec, VisualState
from workflow import WorkflowRunner, outline_text


FAST = PipelineSettings(
    wait_after_step=0.0,
    start_timeout=0.0,
    unknown_retries=1,
    unknown_delay=0.0,
)


def pipeline_states() -> dict[str, VisualState]:
    states = {}
    for stage in range(1, 5):
        states[verify_error(stage)] = VisualState(
            name=verify_error(stage), references=[ReferenceSpec(image="ref_B")], confidence=0.85
        )
        states[verify_success(stage)] = VisualState(
            name=verify_success(stage), references=[ReferenceSpec(image="ref_C")], confidence=0.85
        )
    return states


def attach(context, macros=None, test_data=None, settings=FAST) -> None:
    context.set_states(pipeline_states())
    context.macros = macros or {
        **{name: Macro(name) for name in STAGE_MACROS},
        RESET_MACRO: Macro(RESET_MACRO),
    }
    context.test_data = test_data if test_data is not None else TestData()
    context.step_by_step = False
    context.skip_manual_wait = True
    context.allow_password = False


def run_pipeline(context, settings=FAST):
    return WorkflowRunner(context, build_pipeline_workflow(settings)).run()


def log_text(log) -> str:
    return "\n".join(log.lines())


def test_example_project_is_four_stages():
    project = example_project()
    assert "STATE_A" not in project.states
    assert "AUTH_VK" not in project.macros
    assert set(project.macros) >= set(STAGE_MACROS) | {RESET_MACRO}
    text = outline_text(project.workflow)
    assert "MACRO_1" in text and "MACRO_4" in text
    assert "IF STATE VERIFY_1_ERROR detected" in text
    assert "ELSE IF STATE VERIFY_1_SUCCESS detected" in text


def test_parse_record_text_supports_pipe_and_colon():
    rows, invalid = parse_record_text(
        "\n".join(
            [
                "one@host.com|alpha",
                "two@host.com:beta",
                "# comment",
                "",
                "not-an-email|x",
                "missing",
                "ok@host.com|",
            ]
        )
    )
    assert [row["email"] for row in rows] == ["one@host.com", "two@host.com"]
    assert [row["password"] for row in rows] == ["alpha", "beta"]
    reasons = {item.reason for item in invalid}
    assert "invalid email" in reasons
    assert "missing separator (use email|password or email:password)" in reasons
    assert "empty password" in reasons


def test_verify_error_skips_later_macros_and_loads_the_next_row(context, log):
    attach(
        context,
        test_data=TestData(
            rows=[
                {"email": "one@host.com", "password": "secret-one"},
                {"email": "two@host.com", "password": "secret-two"},
            ]
        ),
    )
    context.emulator.screen = "B"
    report = run_pipeline(context)
    text = log_text(log)
    assert "VERIFY_1 ERROR" in text
    assert "MACRO_2 started" not in text
    assert "secret-one" not in text
    assert "secret-two" not in text
    starts = [line for line in log.lines() if line.endswith("MACRO_1 started")]
    assert len(starts) == 2
    assert context.test_data.failures == 2
    assert report.stop_reason == "no more test data"


def test_verify_success_unlocks_the_next_macros(context, log):
    attach(
        context,
        macros={
            **{name: Macro(name) for name in STAGE_MACROS},
            "MACRO_2": Macro("MACRO_2", actions=[SetVariable(name="macro2_ran", value=1)]),
            RESET_MACRO: Macro(RESET_MACRO),
        },
        test_data=TestData(rows=[{"email": "ok@host.com", "password": "pw"}]),
    )
    context.macros["MACRO_2"] = Macro("MACRO_2", actions=[SetVariable(name="macro2_ran", value=1)])
    context.emulator.screen = "C"
    report = run_pipeline(context)
    text = log_text(log)
    assert "VERIFY_1 SUCCESS" in text
    assert "MACRO_2 started" in text
    assert "VERIFY_2 SUCCESS" in text
    assert "MACRO_3 started" in text
    assert "MACRO_4 started" in text
    assert "VERIFY_4 SUCCESS" in text
    assert "RECORD #1 SUCCESS" in text
    assert context.variables.get("macro2_ran") == 1
    assert context.test_data.successes == 1
    assert "pw" not in text
    assert report.stop_reason == "no more test data"


def test_macro_finish_is_not_verify_success(context, log):
    attach(context)
    context.emulator.screen = "C"
    run_pipeline(context)
    text = log_text(log)
    assert "MACRO_1 finished" in text
    assert "VERIFY_1 started" in text
    assert "VERIFY_1 SUCCESS" in text


def test_unknown_skips_the_record_and_does_not_start_macro_2(context, log):
    attach(context, test_data=TestData(rows=[{"email": "a@b.c", "password": "x"}]))
    context.emulator.screen = "NOISE"
    report = run_pipeline(context)
    text = log_text(log)
    assert "MACRO_2 started" not in text
    assert "UNKNOWN" in text
    assert context.test_data.failures == 1
    assert report.stop_reason == "no more test data"


def test_email_placeholder_is_typed_password_stays_out_of_macro_1(context, log):
    attach(
        context,
        macros={
            "MACRO_1": Macro("MACRO_1", actions=[TypeText(text="{{EMAIL}}", is_variable=True)]),
            "MACRO_2": Macro("MACRO_2"),
            "MACRO_3": Macro("MACRO_3"),
            "MACRO_4": Macro("MACRO_4"),
            RESET_MACRO: Macro(RESET_MACRO),
        },
        test_data=TestData(rows=[{"email": "user@host.com", "password": "hunter2-secret"}]),
    )
    context.emulator.screen = "B"
    run_pipeline(context)
    text = log_text(log)
    assert "hunter2-secret" not in text
    assert context.keyboard.backend.events[-1].length == len("user@host.com")
    assert "hunter2-secret" not in text


def test_password_placeholder_types_only_in_macro_3(context, log):
    context.allow_password = False
    context.variables[PASSWORD_VAR] = Secret("hunter2-secret")
    context.log.register_secret("hunter2-secret")
    skipped = TypeText(text="{{PASSWORD}}", is_variable=True).execute(context)
    assert skipped.detail == "password skipped"
    context.allow_password = True
    typed = TypeText(text="{{PASSWORD}}", is_variable=True).execute(context)
    assert typed.success
    assert context.keyboard.backend.events[-1].length == len("hunter2-secret")
    assert "hunter2-secret" not in "\n".join(log.lines())


def test_bind_email_placeholder_does_not_bind_password_on_macro_1():
    data = TestData(rows=[{"email": "player@host.com", "password": "pw"}])
    macro = Macro("MACRO_1", actions=[TypeText(text="player@host.com"), TypeText(text="pw")])
    assert bind_typed_text_to_test_data(macro, data, allow_password=False) == 1
    assert macro.actions[0].variable == EMAIL_VAR
    assert macro.actions[1].variable == ""
    assert bind_typed_text_to_test_data(macro, data, allow_password=True) == 1
    assert macro.actions[1].variable == PASSWORD_VAR


def test_substitute_password_requires_allow_flag(context):
    context.variables[PASSWORD_VAR] = Secret("hidden")
    context.allow_password = False
    text, sensitive = substitute_placeholders("pre {{PASSWORD}} post", context)
    assert "hidden" not in text
    context.allow_password = True
    text, sensitive = substitute_placeholders("{{PASSWORD}}", context)
    assert text == "hidden" and sensitive


def test_wait_for_manual_blocks_until_continue(context):
    from pipeline import WaitForManual

    context.skip_manual_wait = False
    context.manual_continue = threading.Event()
    finished = threading.Event()

    def worker():
        WaitForManual().execute(context)
        finished.set()

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(timeout=0.3)
    assert thread.is_alive()
    context.manual_continue.set()
    finished.wait(timeout=2.0)
    thread.join(timeout=1.0)
    assert not thread.is_alive()


def test_imported_passwords_are_not_written_to_the_project(tmp_path):
    project = example_project()
    project.test_data.replace_rows(
        [{"email": "keep@host.com", "password": "secret-pass"}], [], "accounts.txt"
    )
    project.save(tmp_path / "safe")
    raw = (project.path / "project.json").read_text(encoding="utf-8")
    assert "secret-pass" not in raw
    assert "keep@host.com" not in raw
    reloaded = type(project).load(project.path)
    assert reloaded.test_data.rows == []
