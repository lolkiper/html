"""Workflow tree: the scenario the user builds in the visual editor.

A workflow is an ordered tree of nodes::

    START
    ↓
    ANALYZE
    ↓
    IF STATE A
    ├── YES → ACTION A → VERIFY
    └── NO
        ↓
        IF STATE B
        ├── YES → ACTION B
        └── NO → WAIT → RETRY

Supported node types cover the full requested logic set: IF / ELSE IF / ELSE
(with AND, OR, NOT inside the conditions), WAIT, WAIT UNTIL, RETRY, TIMEOUT,
VERIFY, LOOP and STOP.  Nothing in a workflow stores a bare screen coordinate:
positions are relative to the selected LDPlayer window.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Iterable, Iterator, Sequence

from actions import (
    Action,
    ActionResult,
    LeftClick,
    StopRequested,
    Target,
    TargetMode,
    Verify,
    action_from_dict,
    verify_expected,
)
from conditions import (
    Condition,
    StateIs,
    condition_from_dict,
    condition_to_dict,
    describe_condition,
    evaluate,
)
from i18n import tr
from logger import EventLog, get_logger
from safety import EmergencyStop, SafetyViolation
from screen_capture import CaptureError
from state_machine import (
    AnalysisContext,
    EngineState,
    RunReport,
    StepRecord,
    UNKNOWN_STATE,
    VisualState,
)

_node_ids = itertools.count(1)


def _new_id(prefix: str = "n") -> str:
    return f"{prefix}{next(_node_ids)}"


class NodeType(str, Enum):
    ANALYZE = "ANALYZE"
    IF = "IF"
    ACTION = "ACTION"
    VERIFY = "VERIFY"
    WAIT = "WAIT"
    RETRY = "RETRY"
    LOOP = "LOOP"
    STOP = "STOP"
    STATE = "STATE"
    MACRO = "MACRO"


class NodeStatus(str, Enum):
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


@dataclass
class NodeOutcome:
    status: NodeStatus = NodeStatus.SUCCESS
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status is not NodeStatus.FAILED


@dataclass
class Branch:
    """A named list of child nodes (``YES``, ``NO``, ``BODY``, ...)."""

    label: str
    nodes: list["WorkflowNode"] = field(default_factory=list)
    condition: Condition | None = None  # set for ELSE IF branches

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "condition": condition_to_dict(self.condition),
            "nodes": [node.to_dict() for node in self.nodes],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Branch":
        return cls(
            label=str(data.get("label", "")),
            nodes=[WorkflowNode.from_dict(item) for item in data.get("nodes", [])],
            condition=condition_from_dict(data.get("condition")),
        )


@dataclass
class WorkflowNode:
    """One step of the scenario."""

    type: NodeType = NodeType.ACTION
    id: str = field(default_factory=lambda: _new_id())
    title: str = ""
    enabled: bool = True
    # payload
    condition: Condition | None = None
    action: Action | None = None
    state: str = ""
    # child branches
    then_nodes: list["WorkflowNode"] = field(default_factory=list)
    elif_branches: list[Branch] = field(default_factory=list)
    else_nodes: list["WorkflowNode"] = field(default_factory=list)
    body: list["WorkflowNode"] = field(default_factory=list)
    on_success: list["WorkflowNode"] = field(default_factory=list)
    on_failure: list["WorkflowNode"] = field(default_factory=list)
    # timing / limits
    seconds: float = 1.0
    timeout: float = 10.0
    poll: float = 0.4
    attempts: int = 3
    delay: float = 0.8
    count: int = 1
    max_iterations: int = 100
    continue_on_failure: bool = False
    reason: str = ""

    # -------------------------------------------------------------- children
    def branches(self, include_empty: bool = False) -> list[Branch]:
        """Every child branch, in display order.

        ``include_empty`` also lists the branches a node could have but does not
        use yet, which is how the editor offers an empty SUCCESS or ON FAILURE
        slot to drop a step into.
        """
        result: list[Branch] = []
        if self.type is NodeType.IF:
            result.append(Branch("YES", self.then_nodes, self.condition))
            result.extend(self.elif_branches)
            if self.else_nodes or include_empty:
                result.append(Branch("ELSE", self.else_nodes, None))
        elif self.type in (NodeType.RETRY, NodeType.LOOP):
            result.append(Branch("BODY", self.body, None))
            if self.on_failure or (include_empty and self.type is NodeType.RETRY):
                result.append(Branch("ON FAILURE", self.on_failure, None))
        elif self.type is NodeType.VERIFY:
            if self.on_success or self.on_failure or include_empty:
                result.append(Branch("SUCCESS", self.on_success, None))
                result.append(Branch("FAILED", self.on_failure, None))
        return result

    def branch(self, label: str) -> Branch | None:
        for item in self.branches(include_empty=True):
            if item.label == label:
                return item
        return None

    def child_lists(self) -> list[list["WorkflowNode"]]:
        lists = [self.then_nodes, self.else_nodes, self.body, self.on_success, self.on_failure]
        lists.extend(branch.nodes for branch in self.elif_branches)
        return lists

    def walk(self) -> Iterator["WorkflowNode"]:
        yield self
        for children in self.child_lists():
            for child in children:
                yield from child.walk()

    # ----------------------------------------------------------------- label
    def describe(self) -> str:
        if self.title:
            return self.title
        if self.type is NodeType.ANALYZE:
            if self.state:
                return tr("ANALYZE (wait for %s, timeout %gs)") % (self.state, self.timeout)
            return tr("ANALYZE SCREEN")
        if self.type is NodeType.IF:
            return tr("IF %s") % describe_condition(self.condition)
        if self.type is NodeType.ACTION:
            return self.action.describe() if self.action else tr("ACTION (empty)")
        if self.type is NodeType.VERIFY:
            if self.state:
                return tr("VERIFY state %s (timeout %gs)") % (self.state, self.timeout)
            return tr("VERIFY %s") % describe_condition(self.condition)
        if self.type is NodeType.WAIT:
            if self.condition is not None:
                return tr("WAIT UNTIL %s (timeout %gs)") % (
                    describe_condition(self.condition), self.timeout
                )
            return tr("WAIT %gs") % self.seconds
        if self.type is NodeType.RETRY:
            return tr("RETRY x%s (delay %gs)") % (self.attempts, self.delay)
        if self.type is NodeType.LOOP:
            if self.condition is not None:
                return tr("LOOP WHILE %s (max %s)") % (
                    describe_condition(self.condition), self.max_iterations
                )
            return tr("LOOP x%s") % self.count
        if self.type is NodeType.STOP:
            return tr("STOP (%s)") % self.reason if self.reason else tr("STOP")
        if self.type is NodeType.STATE:
            return tr("STATE %s") % (self.state or "?")
        if self.type is NodeType.MACRO:
            return self.title or self.state or tr("MACRO")
        return self.type.value

    # -------------------------------------------------------- serialisation
    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "type": self.type.value,
            "id": self.id,
            "title": self.title,
            "enabled": self.enabled,
            "state": self.state,
            "seconds": self.seconds,
            "timeout": self.timeout,
            "poll": self.poll,
            "attempts": self.attempts,
            "delay": self.delay,
            "count": self.count,
            "max_iterations": self.max_iterations,
            "continue_on_failure": self.continue_on_failure,
            "reason": self.reason,
        }
        if self.condition is not None:
            data["condition"] = condition_to_dict(self.condition)
        if self.action is not None:
            data["action"] = self.action.to_dict()
        if self.then_nodes:
            data["then"] = [node.to_dict() for node in self.then_nodes]
        if self.elif_branches:
            data["elif"] = [branch.to_dict() for branch in self.elif_branches]
        if self.else_nodes:
            data["else"] = [node.to_dict() for node in self.else_nodes]
        if self.body:
            data["body"] = [node.to_dict() for node in self.body]
        if self.on_success:
            data["on_success"] = [node.to_dict() for node in self.on_success]
        if self.on_failure:
            data["on_failure"] = [node.to_dict() for node in self.on_failure]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorkflowNode":
        def nodes(key: str) -> list["WorkflowNode"]:
            return [cls.from_dict(item) for item in data.get(key, [])]

        return cls(
            type=NodeType(str(data.get("type", "ACTION")).upper()),
            id=str(data.get("id") or _new_id()),
            title=str(data.get("title", "")),
            enabled=bool(data.get("enabled", True)),
            condition=condition_from_dict(data.get("condition")),
            action=action_from_dict(data.get("action")),
            state=str(data.get("state", "")),
            then_nodes=nodes("then"),
            elif_branches=[Branch.from_dict(item) for item in data.get("elif", [])],
            else_nodes=nodes("else"),
            body=nodes("body"),
            on_success=nodes("on_success"),
            on_failure=nodes("on_failure"),
            seconds=float(data.get("seconds", 1.0)),
            timeout=float(data.get("timeout", 10.0)),
            poll=float(data.get("poll", 0.4)),
            attempts=int(data.get("attempts", 3)),
            delay=float(data.get("delay", 0.8)),
            count=int(data.get("count", 1)),
            max_iterations=int(data.get("max_iterations", 100)),
            continue_on_failure=bool(data.get("continue_on_failure", False)),
            reason=str(data.get("reason", "")),
        )


@dataclass
class WorkflowSettings:
    loop: bool = True
    cycle_delay: float = 0.5
    max_cycles: int = 0        # 0 = unlimited
    max_duration: float = 0.0  # 0 = unlimited
    stop_on_failure: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "loop": self.loop,
            "cycle_delay": self.cycle_delay,
            "max_cycles": self.max_cycles,
            "max_duration": self.max_duration,
            "stop_on_failure": self.stop_on_failure,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "WorkflowSettings":
        data = dict(data or {})
        known = {name for name in cls.__dataclass_fields__}
        return cls(**{key: value for key, value in data.items() if key in known})


@dataclass
class Workflow:
    name: str = "Workflow"
    nodes: list[WorkflowNode] = field(default_factory=list)
    settings: WorkflowSettings = field(default_factory=WorkflowSettings)

    # ------------------------------------------------------------ structure
    def walk(self) -> Iterator[WorkflowNode]:
        for node in self.nodes:
            yield from node.walk()

    def find(self, node_id: str) -> WorkflowNode | None:
        for node in self.walk():
            if node.id == node_id:
                return node
        return None

    def parent_list(self, node_id: str) -> list[WorkflowNode] | None:
        """The list that contains the node (needed for move/delete in the GUI)."""
        if any(node.id == node_id for node in self.nodes):
            return self.nodes
        for node in self.walk():
            for children in node.child_lists():
                if any(child.id == node_id for child in children):
                    return children
        return None

    def remove(self, node_id: str) -> bool:
        container = self.parent_list(node_id)
        if container is None:
            return False
        for index, node in enumerate(container):
            if node.id == node_id:
                container.pop(index)
                return True
        return False  # pragma: no cover - defensive

    def move(self, node_id: str, delta: int) -> bool:
        container = self.parent_list(node_id)
        if container is None:
            return False
        for index, node in enumerate(container):
            if node.id == node_id:
                target = index + delta
                if 0 <= target < len(container):
                    container[index], container[target] = container[target], container[index]
                    return True
                return False
        return False  # pragma: no cover - defensive

    def referenced_states(self) -> set[str]:
        """Every state name the workflow depends on (for validation)."""
        names: set[str] = set()
        conditions: list[Condition | None] = []
        for node in self.walk():
            if node.state and node.type is not NodeType.MACRO:
                names.add(node.state)
            conditions.append(node.condition)
            conditions.extend(branch.condition for branch in node.elif_branches)
            action = node.action
            target_state = getattr(getattr(action, "target", None), "state", "")
            if target_state:
                names.add(target_state)
            expected = getattr(action, "expected_state", "")
            if expected:
                names.add(expected)
        for condition in conditions:
            for item in _iter_conditions(condition):
                if isinstance(item, StateIs) and item.state:
                    names.add(item.state)
        return names

    # -------------------------------------------------------- serialisation
    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "settings": self.settings.to_dict(),
            "nodes": [node.to_dict() for node in self.nodes],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Workflow":
        data = dict(data or {})
        return cls(
            name=str(data.get("name", "Workflow")),
            nodes=[WorkflowNode.from_dict(item) for item in data.get("nodes", [])],
            settings=WorkflowSettings.from_dict(data.get("settings")),
        )


def _iter_conditions(condition: Condition | None) -> Iterator[Condition]:
    if condition is None:
        return
    yield condition
    for child in condition.children():
        yield from _iter_conditions(child)


# --------------------------------------------------------------------------- #
# outline rendering (used by the GUI tree, the canvas and ``--print-workflow``)
# --------------------------------------------------------------------------- #
@dataclass
class OutlineRow:
    node_id: str
    depth: int
    text: str
    kind: str = "node"        # node | branch | marker
    prefix: str = ""
    branch_label: str = ""

    @property
    def line(self) -> str:
        return f"{self.prefix}{self.text}"


def outline_rows(workflow: Workflow, expand: Iterable[str] = ()) -> list[OutlineRow]:
    """Flatten the tree into printable rows, keeping the branch structure.

    ``expand`` lists node ids whose unused branches should be shown as empty
    slots (the editor passes the current selection).
    """
    rows: list[OutlineRow] = [OutlineRow("", 0, tr("START"), "marker")]
    expanded = set(expand)

    def render(nodes: Sequence[WorkflowNode], depth: int, prefix: str) -> None:
        for index, node in enumerate(nodes):
            if index or depth or rows[-1].kind == "marker":
                rows.append(OutlineRow("", depth, "↓", "marker", prefix))
            label = node.describe()
            if not node.enabled:
                label = f"{label}{tr('  [disabled]')}"
            rows.append(OutlineRow(node.id, depth, label, "node", prefix))
            branches = node.branches(include_empty=node.id in expanded)
            for branch_index, branch in enumerate(branches):
                last = branch_index == len(branches) - 1
                connector = "└── " if last else "├── "
                label = tr(branch.label)
                if branch.condition is not None and branch.label.startswith("ELSE IF"):
                    label = tr("ELSE IF %s") % describe_condition(branch.condition)
                rows.append(
                    OutlineRow(node.id, depth + 1, label, "branch", prefix + connector, branch.label)
                )
                child_prefix = prefix + ("    " if last else "│   ")
                if branch.nodes:
                    render(branch.nodes, depth + 1, child_prefix)
                else:
                    rows.append(
                        OutlineRow(node.id, depth + 2, tr("(empty)"), "marker", child_prefix)
                    )

    render(workflow.nodes, 0, "")
    rows.append(OutlineRow("", 0, tr("END"), "marker"))
    return rows


def outline_text(workflow: Workflow) -> str:
    return "\n".join(row.line for row in outline_rows(workflow))


# --------------------------------------------------------------------------- #
# execution
# --------------------------------------------------------------------------- #
class WorkflowRunner:
    """Executes a workflow tree against a live :class:`AnalysisContext`."""

    def __init__(
        self,
        ctx: AnalysisContext,
        workflow: Workflow,
        log: EventLog | None = None,
        on_engine_state: Any = None,
        on_step: Any = None,
        on_node: Any = None,
    ) -> None:
        self.ctx = ctx
        self.workflow = workflow
        self.log = log or ctx.log
        self.on_engine_state = on_engine_state
        self.on_step = on_step
        self.on_node = on_node
        self.report = RunReport()
        self.engine_state = EngineState.IDLE

    # ------------------------------------------------------------- plumbing
    def _set_engine_state(self, state: EngineState, detail: str = "") -> None:
        self.engine_state = state
        if self.on_engine_state is not None:
            try:
                self.on_engine_state(state, detail)
            except Exception:  # pragma: no cover - listener safety
                pass

    def _record(self, state: str, confidence: float, engine_state: EngineState, detail: str = "") -> None:
        record = StepRecord(time.time(), state, confidence, engine_state.value, detail)
        self.report.steps.append(record)
        if self.on_step is not None:
            try:
                self.on_step(record)
            except Exception:  # pragma: no cover - listener safety
                pass

    def _enter(self, node: WorkflowNode) -> None:
        if self.on_node is not None:
            try:
                self.on_node(node)
            except Exception:  # pragma: no cover - listener safety
                pass

    # ----------------------------------------------------------------- run
    def run(self) -> RunReport:
        self.report = RunReport()
        settings = self.workflow.settings
        if not self.ctx.safety.is_running:
            self.ctx.safety.start()
        deadline = time.monotonic() + settings.max_duration if settings.max_duration else None
        try:
            data = getattr(self.ctx, "test_data", None)
            if data is not None and hasattr(data, "reset"):
                data.reset()
            while True:
                self.ctx.safety.raise_if_stopped()
                self.ctx.safety.wait_while_paused()
                if settings.max_cycles and self.report.cycles >= settings.max_cycles:
                    self.report.stop_reason = f"cycle limit ({settings.max_cycles}) reached"
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    self.report.stop_reason = "time limit reached"
                    break
                self.report.cycles += 1
                self.log.debug("Workflow cycle %s", self.report.cycles)
                outcome = self._run_sequence(self.workflow.nodes)
                if outcome.status is NodeStatus.FAILED:
                    self.report.failures += 1
                    self.log.warning("Cycle %s finished with a failure: %s",
                                     self.report.cycles, outcome.detail)
                    if settings.stop_on_failure:
                        self.report.stop_reason = f"failure: {outcome.detail}"
                        break
                else:
                    self.report.successes += 1
                if not settings.loop:
                    self.report.stop_reason = "single pass finished"
                    break
                if settings.cycle_delay:
                    self.ctx.safety.sleep(settings.cycle_delay)
        except StopRequested as exc:
            self.report.stop_reason = str(exc)
            self.log.info("STOP: %s", exc)
        except EmergencyStop as exc:
            self.report.stop_reason = f"emergency stop: {exc}"
            self.log.error("Run aborted: %s", exc)
        except CaptureError as exc:
            self.report.stop_reason = f"capture failed: {exc}"
            self.log.error("Run aborted: %s", exc)
        finally:
            self.report.ended_at = time.time()
            self._set_engine_state(EngineState.STOPPED, self.report.stop_reason)
            self.log.info("Run finished: %s", self.report.summary())
            if self.report.stop_reason:
                self.log.info("Reason: %s", self.report.stop_reason)
        return self.report

    # ------------------------------------------------------------ sequences
    def _run_sequence(self, nodes: Sequence[WorkflowNode]) -> NodeOutcome:
        outcome = NodeOutcome()
        for node in nodes:
            self.ctx.safety.raise_if_stopped()
            self.ctx.safety.wait_while_paused()
            if not node.enabled:
                continue
            outcome = self._run_node(node)
            if outcome.status is NodeStatus.FAILED and not node.continue_on_failure:
                return outcome
        return outcome

    def _run_node(self, node: WorkflowNode) -> NodeOutcome:
        self._enter(node)
        self._wait_step(node)
        handler = {
            NodeType.ANALYZE: self._node_analyze,
            NodeType.IF: self._node_if,
            NodeType.ACTION: self._node_action,
            NodeType.VERIFY: self._node_verify,
            NodeType.WAIT: self._node_wait,
            NodeType.RETRY: self._node_retry,
            NodeType.LOOP: self._node_loop,
            NodeType.STOP: self._node_stop,
            NodeType.STATE: self._node_state,
            NodeType.MACRO: self._node_macro,
        }.get(node.type)
        if handler is None:  # pragma: no cover - defensive
            return NodeOutcome(NodeStatus.SKIPPED, f"unsupported node {node.type}")
        try:
            return handler(node)
        except SafetyViolation as exc:
            self.report.blocked += 1
            self.log.warning("Node blocked: %s", exc)
            return NodeOutcome(NodeStatus.FAILED, str(exc))

    # ---------------------------------------------------------------- nodes
    def _wait_step(self, node: WorkflowNode) -> None:
        """In STEP BY STEP mode, pause until F10 (F9 still aborts)."""
        if not getattr(self.ctx, "step_by_step", False):
            return
        gate = getattr(self.ctx, "step_continue", None)
        if gate is None:
            return
        detected = "-"
        confidence = 0.0
        if self.ctx.frame is not None:
            outcome = self.ctx.detect()
            detected = outcome.state
            confidence = outcome.confidence
        self.log.info(
            "STEP: %s | state=%s (%.2f) | next: %s | F10 continue, F9 stop",
            self.engine_state.value, detected, confidence, node.describe(),
        )
        gate.clear()
        while not gate.wait(timeout=0.2):
            self.ctx.safety.raise_if_stopped()
            self.ctx.safety.wait_while_paused()

    def _node_macro(self, node: WorkflowNode) -> NodeOutcome:
        from pipeline import ensure_runtime_context

        name = node.state or node.title
        macros = getattr(self.ctx, "macros", {}) or {}
        macro = macros.get(name)
        if macro is None:
            self.log.warning("Macro '%s' is not defined", name)
            return NodeOutcome(NodeStatus.FAILED, f"unknown macro {name}")
        self.ctx.current_macro = name
        self.ctx.allow_password = name == "MACRO_3"
        ensure_runtime_context(self.ctx)
        actions = list(macro.actions)
        if not actions:
            return NodeOutcome(NodeStatus.SUCCESS, f"{name} empty")
        detail = ""
        for action in actions:
            self.ctx.safety.raise_if_stopped()
            self.ctx.safety.wait_while_paused()
            self.log.info("Action: %s", action.describe())
            result = action.execute(self.ctx)
            if not result.success:
                detail = result.detail or f"{name} step failed"
                self.log.warning("%s: %s", name, detail)
                if node.continue_on_failure:
                    break
                return NodeOutcome(NodeStatus.FAILED, detail)
        return NodeOutcome(NodeStatus.SUCCESS, detail or f"{name} finished")

    def _node_analyze(self, node: WorkflowNode) -> NodeOutcome:
        self._set_engine_state(EngineState.ANALYZING)
        self.log.info("Analyzing screen")
        deadline = time.monotonic() + max(0.0, node.timeout) if node.state else None
        while True:
            self.ctx.refresh()
            outcome = self.ctx.detect()
            if outcome.known:
                self._set_engine_state(EngineState.STATE_DETECTED, outcome.state)
                self.log.success(
                    "State detected: %s, confidence=%.2f", outcome.state, outcome.confidence
                )
            else:
                self.log.warning("Unknown state (%s)", outcome.describe())
            self._record(outcome.state, outcome.confidence, EngineState.STATE_DETECTED, outcome.describe())
            if not node.state:
                return NodeOutcome(NodeStatus.SUCCESS, outcome.describe())
            if outcome.state == node.state:
                return NodeOutcome(NodeStatus.SUCCESS, f"{node.state} detected")
            if deadline is not None and time.monotonic() >= deadline:
                self.log.warning("Timeout while waiting for state %s", node.state)
                return NodeOutcome(NodeStatus.FAILED, f"timeout waiting for {node.state}")
            self.ctx.safety.sleep(node.poll)

    def _node_if(self, node: WorkflowNode) -> NodeOutcome:
        self.ctx.ensure_frame()
        result = evaluate(node.condition, self.ctx)
        self.log.info(
            "IF %s -> %s", describe_condition(node.condition),
            tr("YES") if result.value else tr("NO"),
        )
        if result.value:
            return self._run_sequence(node.then_nodes)
        for branch in node.elif_branches:
            branch_result = evaluate(branch.condition, self.ctx)
            self.log.info(
                "ELSE IF %s -> %s", describe_condition(branch.condition),
                tr("YES") if branch_result.value else tr("NO"),
            )
            if branch_result.value:
                return self._run_sequence(branch.nodes)
        if node.else_nodes:
            self.log.info("ELSE branch")
            return self._run_sequence(node.else_nodes)
        return NodeOutcome(NodeStatus.SKIPPED, "no branch matched")

    def _node_action(self, node: WorkflowNode) -> NodeOutcome:
        if node.action is None:
            return NodeOutcome(NodeStatus.SKIPPED, "empty action")
        self._set_engine_state(EngineState.ACTION, node.action.describe())
        self.log.info("Action: %s", node.action.describe())
        result: ActionResult = node.action.execute(self.ctx)
        state = self.ctx.detect().state if self.ctx.frame is not None else ""
        self._record(
            state, result.confidence,
            EngineState.SUCCESS if result.success else EngineState.FAILED, result.detail,
        )
        if result.success:
            return NodeOutcome(NodeStatus.SUCCESS, result.detail)
        return NodeOutcome(NodeStatus.FAILED, result.detail or "action failed")

    def _node_verify(self, node: WorkflowNode) -> NodeOutcome:
        self._set_engine_state(EngineState.VERIFY, node.state or describe_condition(node.condition))
        verification = verify_expected(
            self.ctx, expected_state=node.state or None, condition=node.condition,
            timeout=node.timeout, poll=node.poll,
        )
        self._record(
            verification.observed_state, verification.confidence,
            EngineState.SUCCESS if verification.success else EngineState.FAILED,
            verification.detail,
        )
        if verification.success:
            if node.on_success:
                return self._run_sequence(node.on_success)
            return NodeOutcome(NodeStatus.SUCCESS, verification.detail)
        if node.on_failure:
            self.log.warning("Verification failed, running the FAILED branch")
            return self._run_sequence(node.on_failure)
        return NodeOutcome(NodeStatus.FAILED, verification.detail or "verification failed")

    def _node_wait(self, node: WorkflowNode) -> NodeOutcome:
        if node.condition is None:
            self.log.info("Waiting %.2fs", node.seconds)
            self.ctx.safety.sleep(node.seconds)
            return NodeOutcome(NodeStatus.SUCCESS, f"waited {node.seconds:g}s")
        self.log.info(
            "WAIT UNTIL %s (timeout %.1fs)", describe_condition(node.condition), node.timeout
        )
        deadline = time.monotonic() + max(0.0, node.timeout)
        while True:
            self.ctx.refresh()
            result = evaluate(node.condition, self.ctx)
            if result.value:
                self.log.success("Wait condition satisfied (%s)", result.detail)
                return NodeOutcome(NodeStatus.SUCCESS, result.detail)
            if time.monotonic() >= deadline:
                self.log.warning("WAIT UNTIL timed out")
                return NodeOutcome(NodeStatus.FAILED, f"timeout after {node.timeout:g}s")
            self.ctx.safety.sleep(node.poll)

    def _node_retry(self, node: WorkflowNode) -> NodeOutcome:
        attempts = max(1, node.attempts)
        outcome = NodeOutcome(NodeStatus.FAILED, "no attempt executed")
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                self.report.retries += 1
                self._set_engine_state(EngineState.RETRY, f"{attempt - 1}/{attempts - 1}")
                self.log.warning("Retry %s/%s", attempt - 1, attempts - 1)
                self.ctx.safety.sleep(node.delay)
            outcome = self._run_sequence(node.body)
            if outcome.status is not NodeStatus.FAILED:
                return outcome
        self.log.error("RETRY exhausted after %s attempt(s)", attempts)
        if node.on_failure:
            self._set_engine_state(EngineState.FALLBACK)
            return self._run_sequence(node.on_failure)
        return NodeOutcome(NodeStatus.FAILED, outcome.detail or "retry exhausted")

    def _node_loop(self, node: WorkflowNode) -> NodeOutcome:
        outcome = NodeOutcome()
        if node.condition is None:
            for iteration in range(max(1, node.count)):
                self.log.debug("Loop iteration %s/%s", iteration + 1, node.count)
                outcome = self._run_sequence(node.body)
                if outcome.status is NodeStatus.FAILED and not node.continue_on_failure:
                    return outcome
            return outcome
        iterations = 0
        limit = max(1, node.max_iterations)
        while iterations < limit:
            self.ctx.ensure_frame()
            result = evaluate(node.condition, self.ctx)
            if not result.value:
                return NodeOutcome(NodeStatus.SUCCESS, f"loop ended after {iterations} iteration(s)")
            iterations += 1
            outcome = self._run_sequence(node.body)
            if outcome.status is NodeStatus.FAILED and not node.continue_on_failure:
                return outcome
            self.ctx.refresh()
        self.log.warning("LOOP stopped at the iteration limit (%s)", limit)
        return NodeOutcome(NodeStatus.SUCCESS, f"iteration limit {limit} reached")

    def _node_stop(self, node: WorkflowNode) -> NodeOutcome:
        raise StopRequested(node.reason or "STOP node reached")

    def _node_state(self, node: WorkflowNode) -> NodeOutcome:
        """Run a state from the state table: actions, verification, retries."""
        state = self.ctx.states.get(node.state)
        if state is None:
            self.log.error("State '%s' is not defined", node.state)
            return NodeOutcome(NodeStatus.FAILED, f"unknown state {node.state}")
        attempts = max(1, state.retry_count + 1)
        detail = ""
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                self.report.retries += 1
                self._set_engine_state(EngineState.RETRY, f"{attempt - 1}/{state.retry_count}")
                self.log.warning("Retry %s/%s", attempt - 1, state.retry_count)
                self.ctx.safety.sleep(state.retry_delay)
            self._set_engine_state(EngineState.ACTION, state.name)
            if state.cooldown:
                self.ctx.safety.wait_for_cooldown(f"state:{state.name}", state.cooldown)
            failed = False
            for action in state.actions:
                self.log.info("Action: %s", action.describe())
                result = action.execute(self.ctx)
                if not result.success:
                    detail = result.detail
                    failed = True
                    break
            self.ctx.safety.note_action(f"state:{state.name}")
            if failed:
                continue
            if not state.has_expectation():
                self._record(state.name, 0.0, EngineState.SUCCESS, "no verification")
                return NodeOutcome(NodeStatus.SUCCESS, "actions executed")
            self._set_engine_state(EngineState.VERIFY, state.name)
            verification = verify_expected(
                self.ctx, expected_state=state.expected_state or None,
                condition=state.expected_condition,
                timeout=state.verify_timeout or state.timeout,
            )
            self._record(
                state.name, verification.confidence,
                EngineState.SUCCESS if verification.success else EngineState.FAILED,
                verification.detail,
            )
            if verification.success:
                return NodeOutcome(NodeStatus.SUCCESS, verification.detail)
            detail = verification.detail
        if state.fallback:
            self._set_engine_state(EngineState.FALLBACK, state.fallback)
            if state.fallback.upper() == "STOP":
                raise StopRequested(f"fallback of {state.name} requested STOP")
            fallback = self.ctx.states.get(state.fallback)
            if fallback is not None:
                self.log.warning("Fallback: running state %s", state.fallback)
                for action in fallback.actions:
                    action.execute(self.ctx)
                return NodeOutcome(NodeStatus.SUCCESS, f"fallback {state.fallback} executed")
        return NodeOutcome(NodeStatus.FAILED, detail or f"state {state.name} failed")


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #
def make_node(node_type: NodeType | str, **kwargs: Any) -> WorkflowNode:
    if not isinstance(node_type, NodeType):
        node_type = NodeType(str(node_type).upper())
    return WorkflowNode(type=node_type, **kwargs)


def example_workflow(
    state_a: str = "STATE_A", state_b: str = "STATE_B", state_c: str = "STATE_C"
) -> Workflow:
    """The scenario from the specification, used for a new project.

    ANALYZE, then IF state A -> click the element that identified it and verify
    state C, ELSE IF state B -> click, ELSE -> wait and analyse again.
    """
    click_detected_element = LeftClick(
        target=Target(mode=TargetMode.STATE, state=state_a), require_confidence=0.85
    )
    workflow = Workflow(
        name=tr("Example scenario"),
        nodes=[
            make_node(NodeType.ANALYZE),
            make_node(
                NodeType.IF,
                condition=StateIs(state=state_a),
                then_nodes=[
                    make_node(NodeType.ACTION, action=click_detected_element),
                    make_node(NodeType.VERIFY, state=state_c, timeout=6.0),
                ],
                elif_branches=[
                    Branch(
                        label="ELSE IF",
                        condition=StateIs(state=state_b),
                        nodes=[
                            make_node(
                                NodeType.ACTION,
                                action=LeftClick(target=Target(mode=TargetMode.STATE, state=state_b)),
                            )
                        ],
                    )
                ],
                else_nodes=[
                    make_node(NodeType.WAIT, seconds=1.0),
                    make_node(
                        NodeType.RETRY,
                        attempts=3,
                        delay=1.0,
                        body=[make_node(NodeType.ANALYZE, state=state_a, timeout=8.0)],
                    ),
                ],
            ),
        ],
    )
    return workflow
