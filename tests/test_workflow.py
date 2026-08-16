from __future__ import annotations

import pytest

from conftest import BUTTON
from actions import LeftClick, LogMessage, SetVariable, Target, TargetMode, Wait
from conditions import Always, ReferenceVisible, StateIs, VariableCompare
from state_machine import ReferenceSpec, VisualState
from workflow import (
    Branch,
    NodeStatus,
    NodeType,
    Workflow,
    WorkflowNode,
    WorkflowRunner,
    WorkflowSettings,
    example_workflow,
    make_node,
    outline_rows,
    outline_text,
)


def mark(name: str, value=1) -> WorkflowNode:
    return make_node(NodeType.ACTION, action=SetVariable(name=name, value=value))


def single_pass(nodes, **settings) -> Workflow:
    options = {"loop": False, "cycle_delay": 0.0}
    options.update(settings)
    return Workflow(nodes=nodes, settings=WorkflowSettings(**options))


def run(context, workflow) -> object:
    return WorkflowRunner(context, workflow).run()


def with_states(context) -> None:
    context.set_states(
        {
            "STATE_A": VisualState(
                name="STATE_A", references=[ReferenceSpec(image="ref_A")], confidence=0.85
            ),
            "STATE_B": VisualState(
                name="STATE_B", references=[ReferenceSpec(image="ref_B")], confidence=0.85
            ),
            "STATE_C": VisualState(
                name="STATE_C", references=[ReferenceSpec(image="ref_C")], confidence=0.85
            ),
        }
    )


def test_if_branch_is_taken(context):
    with_states(context)
    workflow = single_pass(
        [
            make_node(NodeType.ANALYZE),
            make_node(
                NodeType.IF,
                condition=StateIs(state="STATE_A"),
                then_nodes=[mark("path", "A")],
                else_nodes=[mark("path", "else")],
            ),
        ]
    )
    run(context, workflow)
    assert context.variables["path"] == "A"


def test_else_if_and_else_branches(context, log):
    with_states(context)
    context.emulator.screen = "B"
    node = make_node(
        NodeType.IF,
        condition=StateIs(state="STATE_A"),
        then_nodes=[mark("path", "A")],
        elif_branches=[Branch("ELSE IF", [mark("path", "B")], StateIs(state="STATE_B"))],
        else_nodes=[mark("path", "else")],
    )
    run(context, single_pass([make_node(NodeType.ANALYZE), node]))
    assert context.variables["path"] == "B"
    assert any("ELSE IF" in line for line in log.lines())

    context.emulator.screen = "NOISE"
    run(context, single_pass([make_node(NodeType.ANALYZE), node]))
    assert context.variables["path"] == "else"


def test_action_failure_stops_the_cycle_but_not_the_run(context):
    workflow = single_pass(
        [
            make_node(NodeType.ACTION, action=LeftClick(target=Target(mode=TargetMode.LAST_MATCH))),
            mark("unreachable"),
        ]
    )
    report = run(context, workflow)
    assert "unreachable" not in context.variables
    assert report.failures == 1


def test_continue_on_failure_keeps_going(context):
    workflow = single_pass(
        [
            make_node(
                NodeType.ACTION,
                action=LeftClick(target=Target(mode=TargetMode.LAST_MATCH)),
                continue_on_failure=True,
            ),
            mark("reached"),
        ]
    )
    run(context, workflow)
    assert context.variables["reached"] == 1


def test_wait_until_and_timeout(context):
    workflow = single_pass(
        [make_node(NodeType.WAIT, condition=Always(False), timeout=0.05, poll=0.01), mark("after")]
    )
    report = run(context, workflow)
    assert "after" not in context.variables
    assert report.failures == 1
    workflow = single_pass(
        [make_node(NodeType.WAIT, condition=Always(True), timeout=0.5, poll=0.01), mark("after")]
    )
    run(context, workflow)
    assert context.variables["after"] == 1


def test_retry_repeats_the_body_then_runs_on_failure(context, log):
    failing = make_node(
        NodeType.ACTION, action=LeftClick(target=Target(mode=TargetMode.LAST_MATCH))
    )
    node = make_node(
        NodeType.RETRY, attempts=3, delay=0.0, body=[failing], on_failure=[mark("fallback")]
    )
    report = run(context, single_pass([node]))
    assert context.variables["fallback"] == 1
    assert report.retries == 2
    assert any("Retry 1/2" in line for line in log.lines())


def test_retry_stops_as_soon_as_the_body_succeeds(context):
    node = make_node(NodeType.RETRY, attempts=3, delay=0.0, body=[mark("tries", 1)])
    report = run(context, single_pass([node]))
    assert report.retries == 0


def test_loop_with_a_fixed_count(context):
    counter = make_node(
        NodeType.ACTION, action=SetVariable(name="count", value=1, mode="increment")
    )
    run(context, single_pass([make_node(NodeType.LOOP, count=4, body=[counter])]))
    assert context.variables["count"] == 4


def test_loop_while_condition_and_iteration_limit(context):
    context.variables["ticks"] = 0
    body = [make_node(NodeType.ACTION, action=SetVariable(name="ticks", value=1, mode="increment"))]
    node = make_node(
        NodeType.LOOP,
        condition=VariableCompare(name="ticks", operator="<", value=3),
        body=body,
        max_iterations=10,
    )
    run(context, single_pass([node]))
    assert context.variables["ticks"] == 3

    context.variables["ticks"] = 0
    node = make_node(
        NodeType.LOOP, condition=Always(True), body=body, max_iterations=2
    )
    run(context, single_pass([node]))
    assert context.variables["ticks"] == 2


def test_stop_node_ends_the_run(context):
    report = run(
        context,
        Workflow(
            nodes=[make_node(NodeType.STOP, reason="all done"), mark("never")],
            settings=WorkflowSettings(loop=True, cycle_delay=0.0),
        ),
    )
    assert report.stop_reason == "all done"
    assert "never" not in context.variables


def test_verify_node_branches_on_success_and_failure(context):
    with_states(context)
    context.emulator.transitions[("click", "A")] = "C"
    workflow = single_pass(
        [
            make_node(NodeType.ANALYZE),
            make_node(
                NodeType.ACTION,
                action=LeftClick(target=Target(mode=TargetMode.STATE, state="STATE_A")),
            ),
            make_node(
                NodeType.VERIFY,
                state="STATE_C",
                timeout=1.0,
                poll=0.01,
                on_success=[mark("verified", "yes")],
                on_failure=[mark("verified", "no")],
            ),
        ]
    )
    run(context, workflow)
    assert context.variables["verified"] == "yes"

    context.emulator.screen = "A"
    context.emulator.transitions.clear()
    workflow.nodes[2].timeout = 0.05
    run(context, workflow)
    assert context.variables["verified"] == "no"


def test_analyze_node_can_wait_for_a_state(context):
    with_states(context)
    workflow = single_pass([make_node(NodeType.ANALYZE, state="STATE_C", timeout=0.05, poll=0.01)])
    report = run(context, workflow)
    assert report.failures == 1
    workflow = single_pass([make_node(NodeType.ANALYZE, state="STATE_A", timeout=0.5, poll=0.01)])
    report = run(context, workflow)
    assert report.failures == 0


def test_state_node_runs_actions_and_verification(context):
    with_states(context)
    context.states["STATE_A"].actions = [
        LeftClick(target=Target(mode=TargetMode.STATE, state="STATE_A"))
    ]
    context.states["STATE_A"].expected_state = "STATE_C"
    context.states["STATE_A"].verify_timeout = 1.0
    context.states["STATE_A"].cooldown = 0.0
    context.emulator.transitions[("click", "A")] = "C"
    report = run(context, single_pass([make_node(NodeType.ANALYZE), make_node(NodeType.STATE, state="STATE_A")]))
    assert report.failures == 0
    assert context.emulator.screen == "C"


def test_state_node_reports_unknown_state(context):
    report = run(context, single_pass([make_node(NodeType.STATE, state="MISSING")]))
    assert report.failures == 1


def test_disabled_nodes_are_skipped(context):
    node = mark("skipped")
    node.enabled = False
    run(context, single_pass([node]))
    assert "skipped" not in context.variables


def test_loop_settings_limit_the_number_of_cycles(context):
    workflow = Workflow(
        nodes=[make_node(NodeType.ACTION, action=SetVariable(name="c", value=1, mode="increment"))],
        settings=WorkflowSettings(loop=True, cycle_delay=0.0, max_cycles=3),
    )
    report = run(context, workflow)
    assert report.cycles == 3
    assert context.variables["c"] == 3
    assert "cycle limit" in report.stop_reason


def test_tree_editing_helpers():
    workflow = example_workflow()
    node_ids = [node.id for node in workflow.walk()]
    assert len(node_ids) == len(set(node_ids))
    if_node = [node for node in workflow.walk() if node.type is NodeType.IF][0]
    assert workflow.find(if_node.id) is if_node
    assert workflow.parent_list(if_node.id) is workflow.nodes
    first = workflow.nodes[0].id
    assert workflow.move(first, 1)
    assert workflow.nodes[1].id == first
    assert not workflow.move(workflow.nodes[0].id, -1)
    inner = if_node.then_nodes[0].id
    assert workflow.parent_list(inner) is if_node.then_nodes
    assert workflow.remove(inner)
    assert workflow.find(inner) is None
    assert not workflow.remove("does-not-exist")
    assert workflow.referenced_states() >= {"STATE_A", "STATE_B", "STATE_C"}


def test_outline_shows_the_branch_structure():
    text = outline_text(example_workflow())
    assert text.startswith("START")
    assert "IF STATE STATE_A detected" in text
    assert "├── YES" in text and "└── ELSE" in text
    assert "ELSE IF STATE STATE_B detected" in text
    assert "RETRY x3" in text
    rows = outline_rows(example_workflow())
    assert rows[0].kind == "marker"
    assert any(row.kind == "branch" and row.branch_label == "YES" for row in rows)
    assert any(row.kind == "node" and row.node_id for row in rows)


def test_workflow_serialisation_roundtrip():
    original = example_workflow()
    restored = Workflow.from_dict(original.to_dict())
    assert outline_text(restored) == outline_text(original)
    assert restored.settings.to_dict() == original.settings.to_dict()
    assert restored.to_dict() == original.to_dict()


def test_empty_if_reports_no_branch(context):
    node = make_node(NodeType.IF, condition=Always(False))
    runner = WorkflowRunner(context, single_pass([node]))
    runner.run()
    assert runner.report.successes == 1  # a skipped branch is not a failure


def test_node_descriptions_cover_every_type():
    nodes = [
        make_node(NodeType.ANALYZE),
        make_node(NodeType.ANALYZE, state="S"),
        make_node(NodeType.IF, condition=Always(True)),
        make_node(NodeType.ACTION, action=Wait(seconds=1)),
        make_node(NodeType.ACTION),
        make_node(NodeType.VERIFY, state="S"),
        make_node(NodeType.VERIFY, condition=Always(True)),
        make_node(NodeType.WAIT),
        make_node(NodeType.WAIT, condition=Always(True)),
        make_node(NodeType.RETRY),
        make_node(NodeType.LOOP),
        make_node(NodeType.LOOP, condition=Always(True)),
        make_node(NodeType.STOP, reason="x"),
        make_node(NodeType.STATE, state="S"),
    ]
    labels = [node.describe() for node in nodes]
    assert all(labels)
    assert labels[0] == "ANALYZE SCREEN"
    titled = make_node(NodeType.WAIT, title="Custom label")
    assert titled.describe() == "Custom label"


def test_empty_branch_slots_appear_only_for_expanded_nodes():
    verify = make_node(NodeType.VERIFY, state="STATE_C")
    retry = make_node(NodeType.RETRY, attempts=2, body=[mark("x")])
    workflow = Workflow(nodes=[verify, retry])
    plain = outline_text(workflow)
    assert "SUCCESS" not in plain and "ON FAILURE" not in plain
    expanded = "\n".join(row.line for row in outline_rows(workflow, expand=[verify.id, retry.id]))
    assert "SUCCESS" in expanded and "FAILED" in expanded and "ON FAILURE" in expanded
    assert verify.branch("SUCCESS") is not None
    assert verify.branch("nope") is None


def test_multiple_else_if_branches_keep_distinct_labels():
    node = make_node(
        NodeType.IF,
        condition=Always(False),
        elif_branches=[
            Branch("ELSE IF 1", [mark("first")], Always(False)),
            Branch("ELSE IF 2", [mark("second")], Always(True)),
        ],
    )
    labels = [branch.label for branch in node.branches()]
    assert labels == ["YES", "ELSE IF 1", "ELSE IF 2"]
    assert node.branch("ELSE IF 2").nodes[0].id == node.elif_branches[1].nodes[0].id
    text = outline_text(Workflow(nodes=[node]))
    assert text.count("ELSE IF") == 2


def test_second_else_if_branch_is_executed(context):
    node = make_node(
        NodeType.IF,
        condition=Always(False),
        then_nodes=[mark("path", "then")],
        elif_branches=[
            Branch("ELSE IF 1", [mark("path", "first")], Always(False)),
            Branch("ELSE IF 2", [mark("path", "second")], Always(True)),
        ],
        else_nodes=[mark("path", "else")],
    )
    run(context, single_pass([node]))
    assert context.variables["path"] == "second"
