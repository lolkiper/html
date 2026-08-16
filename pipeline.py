"""Sequential macros with visual result checks (AUTH_VK then MACRO_2).

The recognition engine is unchanged.  This module stores named macros and test
rows, and builds a workflow tree out of the existing IF / WAIT / ANALYZE /
RETRY / STOP nodes::

    LOAD TEST DATA
    ↓
    AUTH_VK
    ↓
    WAIT / ANALYZE
    ├── AUTH_ERROR  → FAILED → RESET → NEXT DATA → (loop)
    ├── AUTH_SUCCESS → MACRO_2 → VERIFY
    └── UNKNOWN → RETRY → STOP
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar

from actions import Action, ActionResult, LogMessage, StopRequested, action_from_dict, register_action
from conditions import AnyOf, Condition, ConditionResult, StateIs, register_condition
from i18n import tr
from logger import Secret
from state_machine import UNKNOWN_STATE, VisualState
from workflow import Branch, NodeType, Workflow, make_node


AUTH_MACRO = "AUTH_VK"
SECOND_MACRO = "MACRO_2"
RESET_MACRO = "RESET"
AUTH_ERROR = "AUTH_ERROR"
AUTH_SUCCESS = "AUTH_SUCCESS"
MACRO2_ERROR = "MACRO2_ERROR"
MACRO2_SUCCESS = "MACRO2_SUCCESS"

SENSITIVE_COLUMNS = ("password", "passwd", "token", "secret", "pwd")


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
class TestData:
    """Rows of values substituted into AUTH_VK (passwords stay out of the log)."""

    __test__ = False
    columns: list[str] = field(default_factory=lambda: ["login", "password"])
    rows: list[dict[str, str]] = field(default_factory=list)
    index: int = 0
    empty_consumed: bool = False

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

    def advance(self) -> bool:
        if not self.rows:
            self.empty_consumed = True
            return False
        self.index += 1
        return self.index < len(self.rows)

    def reset(self) -> None:
        self.index = 0
        self.empty_consumed = False

    def to_dict(self) -> dict[str, Any]:
        return {"columns": list(self.columns), "rows": [dict(row) for row in self.rows]}

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "TestData":
        data = dict(data or {})
        columns = [str(item) for item in data.get("columns") or ["login", "password"]]
        rows = []
        for item in data.get("rows") or []:
            rows.append({str(key): "" if value is None else str(value) for key, value in dict(item).items()})
        return cls(columns=columns, rows=rows)


@dataclass
class PipelineSettings:
    """Names and timings for the sequential-macro workflow."""

    auth_macro: str = AUTH_MACRO
    next_macro: str = SECOND_MACRO
    reset_macro: str = RESET_MACRO
    auth_error: str = AUTH_ERROR
    auth_success: str = AUTH_SUCCESS
    macro2_error: str = MACRO2_ERROR
    macro2_success: str = MACRO2_SUCCESS
    wait_after_auth: float = 1.0
    wait_after_macro2: float = 1.0
    result_timeout: float = 8.0
    unknown_retries: int = 3
    unknown_delay: float = 1.0
    step_by_step: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "auth_macro": self.auth_macro,
            "next_macro": self.next_macro,
            "reset_macro": self.reset_macro,
            "auth_error": self.auth_error,
            "auth_success": self.auth_success,
            "macro2_error": self.macro2_error,
            "macro2_success": self.macro2_success,
            "wait_after_auth": self.wait_after_auth,
            "wait_after_macro2": self.wait_after_macro2,
            "result_timeout": self.result_timeout,
            "unknown_retries": self.unknown_retries,
            "unknown_delay": self.unknown_delay,
            "step_by_step": self.step_by_step,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "PipelineSettings":
        data = dict(data or {})
        return cls(
            auth_macro=str(data.get("auth_macro", AUTH_MACRO)),
            next_macro=str(data.get("next_macro", SECOND_MACRO)),
            reset_macro=str(data.get("reset_macro", RESET_MACRO)),
            auth_error=str(data.get("auth_error", AUTH_ERROR)),
            auth_success=str(data.get("auth_success", AUTH_SUCCESS)),
            macro2_error=str(data.get("macro2_error", MACRO2_ERROR)),
            macro2_success=str(data.get("macro2_success", MACRO2_SUCCESS)),
            wait_after_auth=float(data.get("wait_after_auth", 1.0)),
            wait_after_macro2=float(data.get("wait_after_macro2", 1.0)),
            result_timeout=float(data.get("result_timeout", 8.0)),
            unknown_retries=int(data.get("unknown_retries", 3)),
            unknown_delay=float(data.get("unknown_delay", 1.0)),
            step_by_step=bool(data.get("step_by_step", False)),
        )


def default_macros() -> dict[str, Macro]:
    return {
        AUTH_MACRO: Macro(AUTH_MACRO, note=tr("Record the VK authorisation")),
        SECOND_MACRO: Macro(SECOND_MACRO, note=tr("Record the steps after a successful login")),
        RESET_MACRO: Macro(RESET_MACRO, note=tr("Optional reset after AUTH_ERROR")),
    }


def default_pipeline_states() -> dict[str, VisualState]:
    """Named result screens. Reference images are added only via Capture."""
    specs = (
        (AUTH_ERROR, tr("Unsuccessful authorisation screen")),
        (AUTH_SUCCESS, tr("Screen after a successful authorisation")),
        (MACRO2_ERROR, tr("MACRO_2 failed")),
        (MACRO2_SUCCESS, tr("MACRO_2 succeeded")),
        (UNKNOWN_STATE, tr("Nothing recognised: wait and analyse again")),
    )
    states = {}
    for name, description in specs:
        states[name] = VisualState(
            name=name,
            description=description,
            confidence=0.85,
            retry_count=0,
        )
    return states


def apply_row_to_context(ctx: Any, data: TestData) -> str:
    """Copy the current row into variables; secrets are registered, not logged."""
    row = data.current()
    for column in data.columns:
        value = row.get(column, "")
        if data.is_sensitive(column) and value:
            ctx.variables[column] = Secret(value)
            ctx.log.register_secret(value)
        else:
            ctx.variables[column] = value
    if data.rows:
        return f"{data.index + 1}/{len(data.rows)}"
    return "manual"


def bind_typed_text_to_test_data(macro: Macro, data: TestData) -> int:
    """If a recorded TypeText matches a test-data field, read it from the variable."""
    from actions import TypeText

    row = data.current()
    if not row:
        return 0
    inverted = {value: key for key, value in row.items() if value}
    changed = 0
    for action in macro.actions:
        if not isinstance(action, TypeText) or action.variable:
            continue
        column = inverted.get(action.text)
        if not column:
            continue
        action.variable = column
        action.sensitive = data.is_sensitive(column)
        action.text = ""
        changed += 1
    return changed


@register_condition
@dataclass
class HasMoreTests(Condition):
    """True while a test-data row (or a single empty pass) remains."""

    kind: ClassVar[str] = "has_more_tests"
    label: ClassVar[str] = "Has more test data"

    def evaluate(self, ctx: Any) -> ConditionResult:
        data = getattr(ctx, "test_data", None)
        ok = data is not None and data.has_current()
        detail = "test data remaining" if ok else "no test data remaining"
        return ConditionResult(ok, 1.0 if ok else 0.0, detail)

    def describe(self) -> str:
        return tr("there is another test row")


@register_action
@dataclass
class SignalFail(Action):
    """Fail the current sequence so RETRY can try again."""

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
            ctx.log.info("No test data row; AUTH_VK will use recorded text")
            return ActionResult(True, "no test data")
        label = apply_row_to_context(ctx, data)
        ctx.log.info("Loading test data %s", label)
        return ActionResult(True, f"loaded {label}")

    def describe(self) -> str:
        return tr("LOAD TEST DATA")


@register_action
@dataclass
class NextTestData(Action):
    kind: ClassVar[str] = "next_test_data"
    label: ClassVar[str] = "Next test data"

    def execute(self, ctx: Any) -> ActionResult:
        data = getattr(ctx, "test_data", None)
        if data is None or not data.advance():
            ctx.log.info("No further test data")
            raise StopRequested("no more test data")
        ctx.log.info("Loading next test data")
        label = apply_row_to_context(ctx, data)
        return ActionResult(True, f"next {label}")

    def describe(self) -> str:
        return tr("NEXT TEST DATA")


def _log(message: str, level: str = "INFO"):
    return make_node(NodeType.ACTION, action=LogMessage(message, level))


def _macro(name: str, continue_on_failure: bool = True):
    return make_node(NodeType.MACRO, state=name, title=name, continue_on_failure=continue_on_failure)


def _auth_error_branch(settings: PipelineSettings) -> list:
    return [
        _log("AUTH_ERROR detected", "WARNING"),
        _log("AUTHORIZATION FAILED", "WARNING"),
        _log("Skipping current test data", "INFO"),
        _log("Resetting workflow", "INFO"),
        _macro(settings.reset_macro),
        make_node(NodeType.ACTION, action=NextTestData()),
    ]


def _macro2_success_branch() -> list:
    return [
        _log("MACRO_2 SUCCESS detected", "SUCCESS"),
        _log("Workflow completed", "SUCCESS"),
        make_node(NodeType.STOP, reason="workflow completed"),
    ]


def _macro2_error_branch() -> list:
    return [
        _log("MACRO_2 ERROR detected", "ERROR"),
        make_node(NodeType.STOP, reason="MACRO_2 failed"),
    ]


def _result_unknown_retry(
    settings: PipelineSettings,
    error_name: str,
    success_name: str,
    error_nodes: list,
    success_nodes: list,
    final_reason: str = "UNKNOWN_FINAL",
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
                    condition=AnyOf([StateIs(state=error_name), StateIs(state=success_name)]),
                    then_nodes=[
                        make_node(
                            NodeType.IF,
                            condition=StateIs(state=error_name),
                            then_nodes=error_nodes,
                            else_nodes=success_nodes,
                        )
                    ],
                    else_nodes=[
                        make_node(NodeType.ACTION, action=SignalFail("still unknown")),
                    ],
                ),
            ],
            on_failure=[
                _log("UNKNOWN_FINAL", "ERROR"),
                make_node(NodeType.STOP, reason=final_reason),
            ],
        )
    ]


def _macro2_verify(settings: PipelineSettings) -> Any:
    return make_node(
        NodeType.IF,
        condition=StateIs(state=settings.macro2_error),
        then_nodes=_macro2_error_branch(),
        elif_branches=[
            Branch("ELSE IF", _macro2_success_branch(), StateIs(state=settings.macro2_success)),
        ],
        else_nodes=_result_unknown_retry(
            settings,
            settings.macro2_error,
            settings.macro2_success,
            _macro2_error_branch(),
            _macro2_success_branch(),
        ),
    )


def _auth_success_branch(settings: PipelineSettings) -> list:
    return [
        _log("AUTH_SUCCESS detected", "SUCCESS"),
        _log("AUTHORIZATION SUCCESS", "SUCCESS"),
        _log("Starting MACRO_2"),
        _macro(settings.next_macro),
        _log("MACRO_2 finished"),
        make_node(NodeType.WAIT, seconds=settings.wait_after_macro2),
        make_node(NodeType.ANALYZE),
        _macro2_verify(settings),
    ]


def _unknown_auth_branch(settings: PipelineSettings) -> list:
    return _result_unknown_retry(
        settings,
        settings.auth_error,
        settings.auth_success,
        _auth_error_branch(settings),
        _auth_success_branch(settings),
    )


def build_pipeline_workflow(settings: PipelineSettings | None = None) -> Workflow:
    """The sequential-macro tree. Macros themselves are looked up at run time."""
    settings = settings or PipelineSettings()
    check = make_node(
        NodeType.IF,
        condition=StateIs(state=settings.auth_error),
        then_nodes=_auth_error_branch(settings),
        elif_branches=[
            Branch("ELSE IF", _auth_success_branch(settings), StateIs(state=settings.auth_success)),
        ],
        else_nodes=_unknown_auth_branch(settings),
    )
    body = [
        make_node(NodeType.ACTION, action=LoadTestData()),
        _log("Starting AUTH_VK"),
        _macro(settings.auth_macro),
        _log("AUTH_VK finished"),
        _log("Checking result"),
        make_node(NodeType.WAIT, seconds=settings.wait_after_auth, title="WAIT FOR AUTH RESULT"),
        make_node(NodeType.ANALYZE),
        check,
    ]
    workflow = Workflow(
        name=tr("Sequential macros"),
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
