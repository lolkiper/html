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

    project = example_project()
    project.settings.language = "en"          # the assertions below use English
    try:
        instance = gui.App(project=project, log=log, dry_run=True)
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
    assert "IF STATE VERIFY_1_ERROR detected" in outline_text(app.project.workflow)


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
    if_node = next(
        node for node in app.project.workflow.walk()
        if node.type is NodeType.IF and "VERIFY_1_ERROR" in node.describe()
    )
    app._on_node_selected(if_node.id, "")
    details = app._details.get("1.0", "end")
    assert "IF" in details and "VERIFY_1_ERROR" in details


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
    from workflow import make_node

    workflow = app.project.workflow
    app._selection = (workflow.nodes[0].id, "")
    app._insert_node(make_node(NodeType.WAIT, seconds=1.0))
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

    app._states_tree.selection_set("VERIFY_1_ERROR")
    app._on_state_selected(None)
    assert app._selected_state == "VERIFY_1_ERROR"
    assert "VERIFY_1_ERROR" in app._details.get("1.0", "end")
    app.duplicate_state()
    assert "VERIFY_1_ERROR_copy" in app.project.states
    monkeypatch.setattr(gui.messagebox, "askyesno", lambda *args, **kwargs: True)
    app._selected_state = "VERIFY_1_ERROR_copy"
    app.delete_state()
    assert "VERIFY_1_ERROR_copy" not in app.project.states


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


def test_gui_updates_keep_running_after_a_failing_event(app):
    """A broken event must not stop the update chain (the engine keeps going)."""
    app._queue.put(("engine_state", None))  # malformed on purpose
    app._drain_queue()
    app.log.info("still alive")
    app._drain_queue()
    assert "still alive" in app._log_view.get("1.0", "end")
    assert any("GUI update failed" in line for line in app.log.lines())


def test_status_bar_follows_the_live_counters(app, context):
    class FakeReport:
        cycles = 7

    class FakeRunner:
        report = FakeReport()

    context.frames_analyzed = 42
    app._context = context
    app._runner = FakeRunner()
    app._update_status()
    text = app._status_label.cget("text")
    assert "Frames: 42" in text and "Cycles: 7" in text


def test_details_panel_follows_the_running_step(app):
    node = [n for n in app.project.workflow.walk() if n.type is NodeType.ACTION][0]
    app._queue.put(("node", node.id))
    app._drain_queue()
    details = app._details.get("1.0", "end")
    assert "RUNNING" in details
    assert node.describe() in details
    assert app._canvas._active_node == node.id


def test_the_interface_follows_the_project_language(log):
    import gui
    from i18n import get_language

    project = example_project()
    project.settings.language = "ru"
    app = gui.App(project=project, log=log, dry_run=True)
    try:
        assert get_language() == "ru"
        assert "СОСТОЯНИЕ" in outline_text(app.project.workflow)
        assert app._record_macro_button.cget("text") == "+ ЗАПИСАТЬ МАКРОС  (MACRO_1)"
        assert app._title_label.cget("text") == "🚀  LDPLAYER VISUAL UI TESTER"
    finally:
        app.hotkeys.stop()
        app.log.remove_listener(app._queue_log_record)
        app.destroy()


def test_switching_the_language_rebuilds_the_window(app):
    from i18n import get_language

    assert get_language() == "en"
    app.change_language("ru")
    app.update_idletasks()
    assert get_language() == "ru"
    assert app.project.settings.language == "ru"
    assert "АНАЛИЗ ЭКРАНА" in outline_text(app.project.workflow)
    # the rebuilt window keeps working
    app.log.info("после переключения")
    app._drain_queue()
    assert "после переключения" in app._log_view.get("1.0", "end")
    assert app._states_tree.get_children()


def test_recorded_actions_are_inserted_into_the_scenario(app, monkeypatch):
    """The macro recorder turns real input into steps of the scenario."""
    import gui
    from ldplayer import manual_window
    from recorder import RawEvent, ScriptedListener
    from workflow import NodeType

    app.window = manual_window(0, 0, 320, 480, title="fake", log=app.log)
    events = [
        RawEvent(kind="down", x=160, y=240, at=1.0),
        RawEvent(kind="up", x=160, y=240, at=1.05),
        RawEvent(kind="key_down", key="enter", at=1.4),
    ]

    def scripted(recorder, log=None):
        return ScriptedListener(recorder, events)

    monkeypatch.setattr(gui, "create_listener", scripted)
    before = len(app.project.workflow.nodes)

    dialog = gui.RecorderDialog(app, app)
    dialog._start()                 # the scripted listener feeds the events at once
    dialog._stop()
    # the 0.4s gap between the click and the key became a pause
    assert [step.kind for step in dialog.recorder.steps] == ["click", "wait", "key"]
    dialog._accept()
    actions = dialog.result
    assert [type(action).__name__ for action in actions] == ["LeftClick", "Wait", "PressKey"]

    app._selection = (app.project.workflow.nodes[0].id, "")
    for action in actions:
        app._insert_node(gui.make_node(NodeType.ACTION, action=action))
    assert len(app.project.workflow.nodes) == before + 3
    assert app.project.workflow.nodes[1].action.target.mode.value == "window"


def test_scenario_buttons_wrap_and_stay_reachable(app):
    """Long captions must wrap onto more rows instead of being cut off."""
    from i18n import tr
    import gui

    assert app._record_macro_button.winfo_ismapped()
    assert app._record_macro_button.cget("text") == "+ " + tr("RECORD MACRO") + "  (MACRO_1)"
    assert app._record_macro_button.cget("style") == "Success.TButton"
    assert app._title_label.cget("fg").lower() == gui.PALETTE["title"]
    assert gui.PALETTE["bg"] == "#0d0d0d"
    assert gui.PALETTE["accent"] == "#f5c518"
    assert app._record_macro_button.winfo_rooty() < app._scenario_buttons.winfo_rooty()

    toolbar = app._scenario_buttons
    toolbar.relayout(available=900)          # a realistic centre-panel width
    app.update_idletasks()
    labels = [widget.cget("text") for widget in toolbar._items]
    assert tr("RECORD MACRO") not in labels, "the recorder lives on its own full-width row"
    for name in ("ADD STATE", "ADD CONDITION", "ADD ACTION", "ADD VERIFY", "ADD ELSE",
                 "ADD WAIT", "ADD RETRY", "ADD ANALYZE", "ADD LOOP", "ADD STOP"):
        assert tr(name) in labels
    delete = [widget for widget in toolbar._items if widget.cget("text") == tr("Delete")][0]
    assert delete.cget("style") == "Danger.TButton"
    width = 900
    for widget in toolbar._items:
        right = widget.winfo_x() + widget.winfo_reqwidth()
        assert right <= width + toolbar.spacing, f"{widget.cget('text')} is clipped"
    assert toolbar.rows() > 1, "the buttons should occupy more than one row"
    assert toolbar.winfo_reqheight() > 1


def test_the_macro_button_keeps_the_centre_column_wide(app):
    """The recorder must not be squeezed into a 280px pane and clipped again."""
    app.geometry("1440x900")
    app.update_idletasks()
    app._place_sashes()
    app.update_idletasks()
    assert app._main.sashpos(0) <= 360
    assert app._record_macro_button.winfo_width() >= 500
    assert app._record_macro_button.winfo_rooty() < app._scenario_buttons.winfo_rooty()
    assert app._scenario_buttons.rows() <= 4
