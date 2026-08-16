"""GUI smoke tests: widget construction, diagram rendering and tree editing.

Skipped when no display is available (the engine itself is tested headlessly).
"""

from __future__ import annotations

import os

import pytest

tkinter = pytest.importorskip("tkinter")

if not os.environ.get("DISPLAY") and not os.name == "nt":  # pragma: no cover - CI without X
    pytest.skip("no display available", allow_module_level=True)

from conditions import Always, StateIs  # noqa: E402
from ldplayer import manual_window  # noqa: E402
from logger import LogLevel  # noqa: E402
from project import example_project  # noqa: E402
from state_machine import ReferenceSpec, VisualState  # noqa: E402
from workflow import NodeType, outline_text  # noqa: E402


@pytest.fixture
def app(log, references):
    import gui

    try:
        instance = gui.App(project=example_project(), log=log, dry_run=True)
    except tkinter.TclError as exc:  # pragma: no cover - broken display
        pytest.skip(f"Tk is unavailable: {exc}")
    instance.update_idletasks()
    yield instance
    instance.hotkeys.stop()
    instance.log.remove_listener(instance._queue_log_record)
    instance.destroy()


def test_window_builds_with_project_content(app):
    assert app.title() == "LDPlayer Visual UI Tester"
    assert set(app._states_tree.get_children()) == set(app.project.state_names())
    assert app._canvas._hits, "the diagram should contain clickable boxes"
    assert "IF STATE STATE_A detected" in outline_text(app.project.workflow)


def test_log_records_reach_the_view(app):
    app.log.info("hello from the test")
    app._drain_queue()
    app.update_idletasks()
    content = app._log_view.get("1.0", "end")
    assert "hello from the test" in content


def test_log_level_filter_hides_debug_lines(app):
    app.log_level.set("WARNING")
    app.log.info("filtered out")
    app.log.warning("kept line")
    app._drain_queue()
    content = app._log_view.get("1.0", "end")
    assert "filtered out" not in content
    assert "kept line" in content


def test_selecting_a_node_shows_its_details(app):
    if_node = [node for node in app.project.workflow.walk() if node.type is NodeType.IF][0]
    app._on_node_selected(if_node.id, "")
    details = app._details.get("1.0", "end")
    assert "IF" in details and "STATE_A" in details


def test_new_step_is_inserted_after_the_selected_node(app):
    from workflow import make_node

    first = app.project.workflow.nodes[0]
    app._selection = (first.id, "")
    app._insert_node(make_node(NodeType.WAIT, seconds=2.0))
    assert app.project.workflow.nodes[1].type is NodeType.WAIT
    assert app.project.dirty


def test_new_step_is_inserted_into_the_selected_branch(app):
    from workflow import make_node

    if_node = [node for node in app.project.workflow.walk() if node.type is NodeType.IF][0]
    before = len(if_node.else_nodes)
    app._selection = (if_node.id, "ELSE")
    app._insert_node(make_node(NodeType.STOP, reason="from test"))
    assert len(if_node.else_nodes) == before + 1
    assert if_node.else_nodes[-1].type is NodeType.STOP


def test_nodes_can_be_moved_disabled_and_deleted(app):
    workflow = app.project.workflow
    first, second = workflow.nodes[0].id, workflow.nodes[1].id
    app._selection = (first, "")
    app.move_node(1)
    assert workflow.nodes[0].id == second
    app._selection = (second, "")
    app.toggle_node()
    assert workflow.find(second).enabled is False
    app.delete_node()
    assert workflow.find(second) is None


def test_state_selection_and_deletion(app, monkeypatch):
    import gui

    app._states_tree.selection_set("STATE_B")
    app._on_state_selected(None)
    assert app._selected_state == "STATE_B"
    assert "STATE_B" in app._details.get("1.0", "end")
    app.duplicate_state()
    assert "STATE_B_copy" in app.project.states
    monkeypatch.setattr(gui.messagebox, "askyesno", lambda *args, **kwargs: True)
    app._selected_state = "STATE_B_copy"
    app.delete_state()
    assert "STATE_B_copy" not in app.project.states


def test_validation_panel_reports_problems(app):
    app.project.add_state(VisualState(name="NO_RULE"))
    app.validate_project()
    warnings = app._warnings.get("1.0", "end")
    assert "no detection rule" in warnings


def test_analyze_once_uses_the_selected_window(app, references, monkeypatch):
    from conftest import SCREENS

    app.window = manual_window(0, 0, 320, 480, title="fake", log=app.log)
    app.project.settings.capture_backend = "static"

    import screen_capture

    original = screen_capture.StaticBackend.grab

    def serve(self, x, y, width, height, handle=None):
        return SCREENS["A"][:height, :width].copy()

    monkeypatch.setattr(screen_capture.StaticBackend, "grab", serve)
    monkeypatch.setattr(
        app.project, "load_reference", lambda name: references.load_reference(name)
    )
    monkeypatch.setattr(
        app.project, "reference_source_size", lambda name: references.reference_source_size(name)
    )
    app.project.states.clear()
    app.project.add_state(
        VisualState(
            name="SHOP", references=[ReferenceSpec(image="ref_A")], confidence=0.85
        )
    )
    app.analyze_once()
    app.update_idletasks()
    rows = app._scores.get_children()
    assert rows, "the detection test should list the scored states"
    assert app._scores.item(rows[0], "text") == "SHOP"
    assert float(app._scores.item(rows[0], "values")[0]) > 0.9
    screen_capture.StaticBackend.grab = original


def test_engine_start_requires_a_window(app, monkeypatch):
    import gui

    messages: list[str] = []
    monkeypatch.setattr(gui.messagebox, "showinfo", lambda *args, **kw: messages.append(args))
    app.window = None
    app.start_engine()
    assert messages, "starting without a window must be refused"
    assert app._engine_thread is None


def test_emergency_stop_button_stops_the_controller(app):
    app.safety.start()
    app.stop_engine()
    assert app.safety.is_stopped
