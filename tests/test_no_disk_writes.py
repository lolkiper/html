"""The RAM-only guarantee, enforced by tests.

Captured frames must never be written to disk, and no ``screenshots/``,
``temp/`` or ``cache_images/`` directory may appear.  Only ``project.py`` is
allowed to write an image, and only for reference images the user added.
"""

from __future__ import annotations

import ast
from pathlib import Path

import numpy as np

from conftest import BUTTON
from actions import LeftClick, Target, TargetMode
from conditions import StateIs
from project import Project
from safety import audit_no_frame_artifacts
from screen_capture import Frame
from state_machine import ReferenceSpec, VisualState
from workflow import NodeType, Workflow, WorkflowRunner, WorkflowSettings, make_node

ROOT = Path(__file__).resolve().parents[1]

#: Modules that handle frames. None of them may write image data.
FRAME_MODULES = (
    "screen_capture.py",
    "vision.py",
    "ocr.py",
    "logger.py",
    "conditions.py",
    "actions.py",
    "state_machine.py",
    "workflow.py",
    "mouse.py",
    "keyboard.py",
    "safety.py",
    "ldplayer.py",
    "gui.py",
    "main.py",
)

FORBIDDEN_CALLS = {
    "imwrite", "imsave", "imencode", "tofile", "write_bytes", "savefig", "savez", "copyfile"
}


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Attribute):
        return f"{dotted_name(node.value)}.{node.attr}"
    if isinstance(node, ast.Name):
        return node.id
    return ""


def test_frame_handling_modules_contain_no_image_writing_calls():
    offenders: list[str] = []
    for file_name in FRAME_MODULES:
        path = ROOT / file_name
        if not path.exists():
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = dotted_name(node.func)
            last = name.rsplit(".", 1)[-1]
            if last in FORBIDDEN_CALLS:
                offenders.append(f"{file_name}: {name}()")
            if last == "open":
                for keyword in node.keywords:
                    if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
                        if "b" in str(keyword.value.value):
                            offenders.append(f"{file_name}: binary open()")
                for argument in node.args[1:]:
                    if isinstance(argument, ast.Constant) and "b" in str(argument.value):
                        offenders.append(f"{file_name}: binary open()")
    assert offenders == [], f"image persistence found: {offenders}"


def test_only_the_project_module_writes_images():
    writers = []
    for path in ROOT.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and dotted_name(node.func).endswith("imencode"):
                writers.append(path.name)
    assert sorted(set(writers)) == ["project.py"]


def test_capture_releases_the_previous_frame(context):
    first = context.refresh()
    buffer = first.image
    assert buffer is not None
    second = context.refresh()
    assert first.image is None            # dropped
    assert int(buffer.sum()) == 0         # and zeroed
    assert second.token > first.token
    context.release()
    assert context.frame is None


def test_running_a_workflow_creates_no_files(tmp_path, context, monkeypatch):
    monkeypatch.chdir(tmp_path)
    project = Project(name="ram only")
    project.save(tmp_path / "ram_only")
    context.set_states(
        {
            "STATE_A": VisualState(
                name="STATE_A", references=[ReferenceSpec(image="ref_A")], confidence=0.85
            ),
            "STATE_C": VisualState(
                name="STATE_C", references=[ReferenceSpec(image="ref_C")], confidence=0.85
            ),
        }
    )
    context.emulator.transitions[("click", "A")] = "C"
    workflow = Workflow(
        nodes=[
            make_node(NodeType.ANALYZE),
            make_node(
                NodeType.IF,
                condition=StateIs(state="STATE_A"),
                then_nodes=[
                    make_node(
                        NodeType.ACTION,
                        action=LeftClick(target=Target(mode=TargetMode.STATE, state="STATE_A")),
                    ),
                    make_node(NodeType.VERIFY, state="STATE_C", timeout=1.0, poll=0.01),
                ],
            ),
        ],
        settings=WorkflowSettings(loop=True, cycle_delay=0.0, max_cycles=3),
    )
    before = {path for path in tmp_path.rglob("*")}
    report = WorkflowRunner(context, workflow).run()
    after = {path for path in tmp_path.rglob("*")}

    assert report.cycles == 3
    assert context.emulator.grabs > 3        # frames were really captured
    assert after == before                   # and nothing was persisted
    assert audit_no_frame_artifacts(tmp_path) == []
    assert sorted(path.name for path in (tmp_path / "ram_only.ldproj").rglob("*")) == [
        "project.json",
        "references",
    ]


def test_forbidden_artifact_directories_are_never_created(tmp_path, context):
    context.refresh()
    context.detect()
    for name in ("screenshots", "temp", "cache_images", "frame_cache"):
        assert not (tmp_path / name).exists()
        assert not (ROOT / name).exists()


def test_log_output_contains_no_image_payloads(context, log):
    context.refresh()
    log.info("frame check %s", context.image)
    for line in log.lines():
        assert "\\x" not in line
        assert "array(" not in line
        assert "<image omitted>" in line or "frame check" not in line
