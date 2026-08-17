"""Four-stage visual workflow: MACRO_n then VERIFY_n, then the next record.

Recognition is unchanged.  This module stores named macros and in-memory test
rows, and builds the tree out of the existing IF / WAIT / ANALYZE / RETRY
nodes::

    LOAD RECORD
    ↓
    MACRO_1 → WAIT → VERIFY_1
    ↓
    MACRO_2 → WAIT → VERIFY_2   (pauses on MANUAL_ACTION_REQUIRED)
    ↓
    MACRO_3 → WAIT → VERIFY_3   ({{PASSWORD}} is allowed only here)
    ↓
    MACRO_4 → WAIT → VERIFY_4
    ↓
    SUCCESS → NEXT RECORD

A finished macro is not a success.  Only a visual VERIFY_n_SUCCESS match
unlocks the next macro.  There is no CAPTCHA / bot-check solver: that screen
stops the run until the user confirms they finished it by hand.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from actions import Action, ActionResult, LogMessage, StopRequested, TypeText, action_from_dict, register_action
from conditions import AnyOf, Condition, ConditionResult, register_condition
from i18n import tr
from logger import Secret
from state_machine import UNKNOWN_STATE, VisualState
from workflow import Branch, NodeType, Workflow, make_node

STAGE_MACROS = ("MACRO_1", "MACRO_2", "MACRO_3", "MACRO_4")
RESET_MACRO = "RESET"
START_STATE = "START_STATE"
MANUAL_STATE = "MANUAL_ACTION_REQUIRED"
EMAIL_VAR = "EMAIL"
PASSWORD_VAR = "PASSWORD"
PASSWORD_STAGE = "MACRO_3"

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SENSITIVE_COLUMNS = ("password", "passwd", "token", "secret", "pwd")

# Kept so older tests/imports that still mention the two-macro names keep working.
AUTH_MACRO = "MACRO_1"
SECOND_MACRO = "MACRO_2"
AUTH_ERROR = "VERIFY_1_ERROR"
AUTH_SUCCESS = "VERIFY_1_SUCCESS"
MACRO2_ERROR = "VERIFY_2_ERROR"
MACRO2_SUCCESS = "VERIFY_2_SUCCESS"


def verify_success(stage: int) -> str:
    return f"VERIFY_{stage}_SUCCESS"


def verify_error(stage: int) -> str:
    return f"VERIFY_{stage}_ERROR"


@dataclass
class Macro:
    """A named recording: the user performs the clicks, the engine replays them."""

    name: str
    actions: list[Action] = field(default_factory=list)
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "note": self.note,
            "actions": [action.to_dict() for action in self.actions],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Macro":
        actions = []
        for item in data.get("actions") or []:
            try:
                actions.append(action_from_dict(item))
            except Exception:
                continue
        return cls(name=str(data.get("name", "")), actions=actions, note=str(data.get("note", "")))


@dataclass
class InvalidRow:
    line: int
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {"line": self.line, "reason": self.reason}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "InvalidRow":
        return cls(int(data.get("line", 0)), str(data.get("reason", "")))


def parse_record_line(line: str) -> tuple[dict[str, str] | None, str]:
    """Return (record, error).  The error string never contains the password."""
    text = line.strip()
    if not text or text.startswith("#"):
        return None, "empty"
    if "|" in text:
        email, separator, rest = text.partition("|")
    elif ":" in text:
        email, separator, rest = text.partition(":")
    else:
        return None, "missing separator (use email|password or email:password)"
    email = email.strip()
    password = rest.strip()
    if not email:
        return None, "empty email"
    if not EMAIL_RE.match(email):
        return None, "invalid email"
    if not password:
        return None, "empty password"
    return {"email": email, "password": password}, ""


def parse_record_text(text: str) -> tuple[list[dict[str, str]], list[InvalidRow]]:
    rows: list[dict[str, str]] = []
    invalid: list[InvalidRow] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        record, error = parse_record_line(raw)
        if error == "empty":
            continue
        if record is None:
            invalid.append(InvalidRow(number, error))
            continue
        rows.append(record)
    return rows, invalid


def parse_record_file(path: str | Path) -> tuple[list[dict[str, str]], list[InvalidRow]]:
    content = Path(path).read_text(encoding="utf-8-sig")
    return parse_record_text(content)


@dataclass
class TestData:
    """In-memory email/password rows. Passwords are never written to disk."""

    __test__ = False
    columns: list[str] = field(default_factory=lambda: ["email", "password"])
    rows: list[dict[str, str]] = field(default_factory=list)
    invalid: list[InvalidRow] = field(default_factory=list)
    index: int = 0
    empty_consumed: bool = False
    successes: int = 0
    failures: int = 0
    source_name: str = ""

    def is_sensitive(self, column: str) -> bool:
        return column.lower() in SENSITIVE_COLUMNS

    def has_current(self) -> bool:
        if self.rows:
            return 0 <= self.index < len(self.rows)
        return not self.empty_consumed

    def current(self) -> dict[str, str]:
        if self.rows and 0 <= self.index < len(self.rows):
            return dict(self.rows[self.index])
        return {}

    def current_number(self) -> int:
        if self.rows:
            return self.index + 1
        return 1

    def total(self) -> int:
        return len(self.rows)

    def advance(self) -> bool:
        if not self.rows:
            self.empty_consumed = True
            return False
        self.index += 1
        return self.index < len(self.rows)

    def reset(self) -> None:
        self.index = 0
        self.empty_consumed = False
        self.successes = 0
        self.failures = 0

    def replace_rows(self, rows: list[dict[str, str]], invalid: list[InvalidRow], source_name: str = "") -> None:
        self.rows = rows
        self.invalid = invalid
        self.source_name = source_name
        self.reset()

    def to_dict(self) -> dict[str, Any]:
        # Emails may be remembered as a count only. Passwords never leave RAM.
        return {
            "columns": ["email", "password"],
            "source_file": self.source_name,
            "row_count": len(self.rows),
            "invalid": [item.to_dict() for item in self.invalid],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "TestData":
        data = dict(data or {})
        invalid = [InvalidRow.from_dict(item) for item in data.get("invalid") or []]
        # Older projects stored login/password rows; drop the secrets, keep emails empty.
        return cls(
            columns=["email", "password"],
            rows=[],
            invalid=invalid,
            source_name=str(data.get("source_file") or ""),
        )


@dataclass
class PipelineSettings:
    """Names and timings for the four-stage workflow."""

    version: int = 2
    reset_macro: str = RESET_MACRO
    start_state: str = START_STATE
    manual_state: str = MANUAL_STATE
    wait_after_step: float = 1.0
    start_timeout: float = 8.0
    unknown_retries: int = 3
    unknown_delay: float = 1.0
    step_by_step: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "reset_macro": self.reset_macro,
            "start_state": self.start_state,
            "manual_state": self.manual_state,
            "wait_after_step": self.wait_after_step,
            "start_timeout": self.start_timeout,
            "unknown_retries": self.unknown_retries,
            "unknown_delay": self.unknown_delay,
            "step_by_step": self.step_by_step,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "PipelineSettings":
        data = dict(data or {})
        return cls(
            version=int(data.get("version", 2)),
            reset_macro=str(data.get("reset_macro", RESET_MACRO)),
            start_state=str(data.get("start_state", START_STATE)),
            manual_state=str(data.get("manual_state", MANUAL_STATE)),
            wait_after_step=float(data.get("wait_after_step", data.get("wait_after_auth", 1.0))),
            start_timeout=float(data.get("start_timeout", 8.0)),
            unknown_retries=int(data.get("unknown_retries", 3)),
            unknown_delay=float(data.get("unknown_delay", 1.0)),
            step_by_step=bool(data.get("step_by_step", False)),
        )


def default_macros() -> dict[str, Macro]:
    notes = {
        "MACRO_1": tr("Record stage 1. Type {{EMAIL}} in the email field."),
        "MACRO_2": tr("Record stage 2. Bot-checks wait for you; they are not solved."),
        "MACRO_3": tr("Record stage 3. Type {{PASSWORD}} where the password belongs."),
        "MACRO_4": tr("Record stage 4, after the previous verifies succeeded."),
        RESET_MACRO: tr("Optional reset between records"),
    }
    return {name: Macro(name, note=notes[name]) for name in (*STAGE_MACROS, RESET_MACRO)}


def default_pipeline_states() -> dict[str, VisualState]:
    specs = [
        (START_STATE, tr("Screen that means the workflow is back at the start")),
        (MANUAL_STATE, tr("Manual confirmation / bot-check — wait, do not solve")),
        (UNKNOWN_STATE, tr("Nothing recognised: wait and analyse again")),
    ]
    for stage in range(1, 5):
        specs.append((verify_success(stage), tr("VERIFY_%s succeeded") % stage))
        specs.append((verify_error(stage), tr("VERIFY_%s failed") % stage))
    states = {}
    for name, description in specs:
        states[name] = VisualState(
            name=name,
            description=description,
            confidence=0.85,
            retry_count=0,
        )
    return states


def clear_record_variables(ctx: Any) -> None:
    for key in (EMAIL_VAR, PASSWORD_VAR, "email", "password", "login"):
        ctx.variables.pop(key, None)


def apply_row_to_context(ctx: Any, data: TestData) -> str:
    """Copy the current row into EMAIL / PASSWORD. Secrets are never logged."""
    clear_record_variables(ctx)
    row = data.current()
    email = row.get("email") or row.get("login") or ""
    password = row.get("password") or ""
    ctx.variables[EMAIL_VAR] = email
    ctx.variables["email"] = email
    if password:
        secret = Secret(password)
        ctx.variables[PASSWORD_VAR] = secret
        ctx.variables["password"] = secret
        ctx.log.register_secret(password)
    if data.rows:
        return f"{data.index + 1}/{len(data.rows)}"
    return "manual"


def bind_typed_text_to_test_data(macro: Macro, data: TestData, allow_password: bool = False) -> int:
    """If a recorded TypeText matches the current row, read it from {{EMAIL}} / {{PASSWORD}}."""
    row = data.current()
    if not row and data.rows:
        row = dict(data.rows[0])
    changed = 0
    email = (row.get("email") or row.get("login") or "").strip()
    password = (row.get("password") or "").strip()
    for action in macro.actions:
        if not isinstance(action, TypeText) or action.variable:
            continue
        raw = (action.text or "").strip()
        if raw in ("{{EMAIL}}", "{{email}}") or (email and raw == email):
            action.variable = EMAIL_VAR
            action.sensitive = False
            action.text = "{{EMAIL}}"
            changed += 1
            continue
        if not allow_password:
            continue
        if raw in ("{{PASSWORD}}", "{{password}}") or (password and raw == password):
            action.variable = PASSWORD_VAR
            action.sensitive = True
            action.text = "{{PASSWORD}}"
            changed += 1
    return changed


def substitute_placeholders(text: str, ctx: Any) -> tuple[str, bool]:
    """Replace {{EMAIL}} / {{PASSWORD}}.  Never returns a password into the log."""
    sensitive = False
    allow_password = bool(getattr(ctx, "allow_password", True))
    macro = getattr(ctx, "current_macro", "") or ""
    if macro:
        allow_password = macro == PASSWORD_STAGE

    def replacer(match: re.Match[str]) -> str:
        nonlocal sensitive
        name = match.group(1).upper()
        if name == PASSWORD_VAR:
            if not allow_password:
                return ""
            sensitive = True
            raw = ctx.variables.get(PASSWORD_VAR, "")
            return raw.reveal() if isinstance(raw, Secret) else str(raw or "")
        raw = ctx.variables.get(name, ctx.variables.get(name.lower(), ""))
        if isinstance(raw, Secret):
            sensitive = True
            return raw.reveal() if allow_password else ""
        return str(raw or "")

    return PLACEHOLDER.sub(replacer, text), sensitive


@register_condition
@dataclass
class StateScore(Condition):
    """True when this named state's own score clears its threshold.

    Sequential VERIFY_1 / VERIFY_2 may share a similar screen. The winner of
    ``detect()`` must not hide a later VERIFY that also matches.
    """

    kind: ClassVar[str] = "state_score"
    label: ClassVar[str] = "State score"
    state: str = ""
    min_confidence: float | None = None

    def evaluate(self, ctx: Any) -> ConditionResult:
        outcome = ctx.detect()
        threshold = self.min_confidence
        if threshold is None:
            definition = (getattr(ctx, "states", None) or {}).get(self.state)
            threshold = definition.confidence if definition is not None else getattr(ctx, "min_confidence", 0.85)
        score = float(outcome.scores.get(self.state, 0.0))
        ok = score + 1e-9 >= float(threshold)
        return ConditionResult(
            ok, score,
            f"{self.state} score={score:.2f} required={threshold:.2f}",
            outcome.matches.get(self.state),
        )

    def describe(self) -> str:
        return tr("STATE %s detected") % (self.state or "?")

    def payload(self) -> dict[str, Any]:
        return {"state": self.state, "min_confidence": self.min_confidence}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "StateScore":
        raw = data.get("min_confidence")
        return cls(str(data.get("state", "")), None if raw is None else float(raw))


@register_condition
@dataclass
class HasMoreTests(Condition):
    kind: ClassVar[str] = "has_more_tests"
    label: ClassVar[str] = "Has more test data"

    def evaluate(self, ctx: Any) -> ConditionResult:
        data = getattr(ctx, "test_data", None)
        ok = data is not None and data.has_current()
        return ConditionResult(ok, 1.0 if ok else 0.0, "records remaining" if ok else "no records remaining")

    def describe(self) -> str:
        return tr("there is another test row")


@register_action
@dataclass
class SignalFail(Action):
    kind: ClassVar[str] = "fail"
    label: ClassVar[str] = "Fail"
    reason: str = "unknown"

    def execute(self, ctx: Any) -> ActionResult:
        return ActionResult(False, self.reason)

    def describe(self) -> str:
        return tr("FAIL (%s)") % self.reason

    def payload(self) -> dict[str, Any]:
        return {"reason": self.reason}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "SignalFail":
        return cls(str(data.get("reason", "unknown")))


@register_action
@dataclass
class LoadTestData(Action):
    kind: ClassVar[str] = "load_test_data"
    label: ClassVar[str] = "Load test data"

    def execute(self, ctx: Any) -> ActionResult:
        data = getattr(ctx, "test_data", None)
        if data is None or not data.has_current():
            ctx.log.info("No test data row; macros will use recorded text")
            return ActionResult(True, "no test data")
        label = apply_row_to_context(ctx, data)
        ctx.log.info("Record #%s loaded", data.current_number())
        return ActionResult(True, f"loaded {label}")

    def describe(self) -> str:
        return tr("LOAD RECORD")


@register_action
@dataclass
class NextTestData(Action):
    kind: ClassVar[str] = "next_test_data"
    label: ClassVar[str] = "Next test data"

    def execute(self, ctx: Any) -> ActionResult:
        data = getattr(ctx, "test_data", None)
        clear_record_variables(ctx)
        if data is None or not data.advance():
            ctx.log.info("No further test data")
            raise StopRequested("no more test data")
        ctx.log.info("Loading next record")
        return ActionResult(True, f"next {data.current_number()}")

    def describe(self) -> str:
        return tr("NEXT RECORD")


@register_action
@dataclass
class MarkRecord(Action):
    kind: ClassVar[str] = "mark_record"
    label: ClassVar[str] = "Mark record"
    outcome: str = "failed"

    def execute(self, ctx: Any) -> ActionResult:
        data = getattr(ctx, "test_data", None)
        number = data.current_number() if data is not None else 0
        if self.outcome == "success":
            if data is not None:
                data.successes += 1
            ctx.log.success("WORKFLOW SUCCESS")
            ctx.log.success("RECORD #%s SUCCESS", number)
        else:
            if data is not None:
                data.failures += 1
            label = "UNKNOWN" if self.outcome == "unknown" else "FAILED"
            ctx.log.warning("RECORD #%s %s", number, label)
        return ActionResult(True, f"{self.outcome} #{number}")

    def describe(self) -> str:
        return tr("RECORD RESULT (%s)") % self.outcome

    def payload(self) -> dict[str, Any]:
        return {"outcome": self.outcome}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "MarkRecord":
        return cls(str(data.get("outcome", "failed")))


@register_action
@dataclass
class WaitForManual(Action):
    """Pause until the user finishes a bot-check / confirmation by hand.

    This is not a solver.  The engine does not click, OCR, or bypass the gate.
    """

    kind: ClassVar[str] = "wait_for_manual"
    label: ClassVar[str] = "Wait for manual action"

    def execute(self, ctx: Any) -> ActionResult:
        ctx.log.warning("MANUAL ACTION REQUIRED")
        if getattr(ctx, "skip_manual_wait", False):
            ctx.log.info("Manual wait skipped (test)")
            return ActionResult(True, "skipped")
        gate = getattr(ctx, "manual_continue", None)
        if gate is None:
            gate = threading.Event()
            ctx.manual_continue = gate
        ctx.manual_required = True
        gate.clear()
        while not gate.wait(timeout=0.2):
            ctx.safety.raise_if_stopped()
            ctx.safety.wait_while_paused()
        ctx.manual_required = False
        ctx.log.info("Manual action confirmed, continuing")
        return ActionResult(True, "continued")

    def describe(self) -> str:
        return tr("MANUAL ACTION REQUIRED")


@register_action
@dataclass
class WaitForStartState(Action):
    kind: ClassVar[str] = "wait_for_start"
    label: ClassVar[str] = "Wait for start state"
    timeout: float = 8.0
    poll: float = 0.4

    def execute(self, ctx: Any) -> ActionResult:
        import time

        name = START_STATE
        state = (getattr(ctx, "states", None) or {}).get(name)
        if state is None or not state.has_detection_rule():
            return ActionResult(True, "no start state")
        deadline = time.monotonic() + max(0.0, self.timeout)
        while True:
            ctx.refresh()
            outcome = ctx.detect()
            if outcome.state == name:
                ctx.log.info("Start state detected")
                return ActionResult(True, "start state")
            if time.monotonic() >= deadline:
                ctx.log.warning("Start state not detected, continuing")
                return ActionResult(True, "start timeout")
            ctx.safety.sleep(self.poll)

    def describe(self) -> str:
        return tr("WAIT FOR START STATE")

    def payload(self) -> dict[str, Any]:
        return {"timeout": self.timeout, "poll": self.poll}

    @classmethod
    def build(cls, data: dict[str, Any]) -> "WaitForStartState":
        return cls(float(data.get("timeout", 8.0)), float(data.get("poll", 0.4)))


def _log(message: str, level: str = "INFO"):
    return make_node(NodeType.ACTION, action=LogMessage(message, level))


def _macro(name: str, continue_on_failure: bool = True):
    return make_node(NodeType.MACRO, state=name, title=name, continue_on_failure=continue_on_failure)


def _fail_record(settings: PipelineSettings, unknown: bool = False) -> list:
    return [
        make_node(NodeType.ACTION, action=MarkRecord("unknown" if unknown else "failed")),
        _macro(settings.reset_macro),
        make_node(NodeType.ACTION, action=NextTestData()),
    ]


def _complete_record(settings: PipelineSettings) -> list:
    return [
        make_node(NodeType.ACTION, action=MarkRecord("success")),
        _macro(settings.reset_macro),
        make_node(NodeType.ACTION, action=NextTestData()),
    ]


def _manual_gate(settings: PipelineSettings) -> list:
    return [
        make_node(
            NodeType.IF,
            condition=StateScore(state=settings.manual_state),
            then_nodes=[
                make_node(NodeType.ACTION, action=WaitForManual()),
                make_node(NodeType.ANALYZE),
            ],
        )
    ]


def _unknown_retry(
    settings: PipelineSettings,
    error_name: str,
    success_name: str,
    error_nodes: list,
    success_nodes: list,
) -> list:
    delay = max(0.0, settings.unknown_delay)
    return [
        make_node(
            NodeType.RETRY,
            attempts=max(1, settings.unknown_retries),
            delay=delay,
            body=[
                make_node(NodeType.WAIT, seconds=delay),
                make_node(NodeType.ANALYZE),
                make_node(
                    NodeType.IF,
                    condition=AnyOf([StateScore(state=error_name), StateScore(state=success_name)]),
                    then_nodes=[
                        make_node(
                            NodeType.IF,
                            condition=StateScore(state=error_name),
                            then_nodes=error_nodes,
                            else_nodes=success_nodes,
                        )
                    ],
                    else_nodes=[make_node(NodeType.ACTION, action=SignalFail("still unknown"))],
                ),
            ],
            on_failure=[
                _log("UNKNOWN", "WARNING"),
                *_fail_record(settings, unknown=True),
            ],
        )
    ]


def _verify_branch(
    settings: PipelineSettings,
    stage: int,
    success_nodes: list,
) -> Any:
    error_name = verify_error(stage)
    success_name = verify_success(stage)
    error_nodes = [
        _log(f"VERIFY_{stage} ERROR", "WARNING"),
        *_fail_record(settings),
    ]
    ok_nodes = [
        _log(f"VERIFY_{stage} SUCCESS", "SUCCESS"),
        *success_nodes,
    ]
    return make_node(
        NodeType.IF,
        condition=StateScore(state=error_name),
        then_nodes=error_nodes,
        elif_branches=[Branch("ELSE IF", ok_nodes, StateScore(state=success_name))],
        else_nodes=_unknown_retry(settings, error_name, success_name, error_nodes, ok_nodes),
    )


def _stage(settings: PipelineSettings, stage: int, success_nodes: list) -> list:
    name = f"MACRO_{stage}"
    nodes = [
        _log(f"{name} started"),
        _macro(name),
        _log(f"{name} finished"),
        _log(f"VERIFY_{stage} started"),
        make_node(NodeType.WAIT, seconds=settings.wait_after_step, title=f"WAIT FOR VERIFY_{stage}"),
        make_node(NodeType.ANALYZE),
        *_manual_gate(settings),
        _verify_branch(settings, stage, success_nodes),
    ]
    return nodes


def build_pipeline_workflow(settings: PipelineSettings | None = None) -> Workflow:
    """MACRO_1..4, each followed by a visual VERIFY. Macros are looked up at run time."""
    settings = settings or PipelineSettings()
    after_four = _complete_record(settings)
    after_three = _stage(settings, 4, after_four)
    after_two = _stage(settings, 3, after_three)
    after_one = _stage(settings, 2, after_two)
    body = [
        make_node(NodeType.ACTION, action=LoadTestData()),
        _macro(settings.reset_macro),
        make_node(
            NodeType.ACTION,
            action=WaitForStartState(timeout=settings.start_timeout),
        ),
        *_stage(settings, 1, after_one),
    ]
    workflow = Workflow(
        name=tr("Four-stage macros"),
        nodes=[
            make_node(
                NodeType.LOOP,
                condition=HasMoreTests(),
                max_iterations=1000,
                body=body,
                continue_on_failure=True,
            )
        ],
    )
    workflow.settings.loop = False
    workflow.settings.stop_on_failure = False
    return workflow
