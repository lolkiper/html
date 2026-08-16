from __future__ import annotations

import json

import numpy as np
import pytest

from conftest import BUTTON, SCREENS
from actions import LeftClick, Target, TargetMode
from conditions import StateIs
from ocr import Preprocess
from project import PROJECT_FILE, REFERENCES_DIR, Project, ProjectError, ProjectSettings, example_project
from state_machine import ReferenceSpec, VisualState
from vision import crop_copy
from workflow import NodeType, example_workflow, make_node


def button_patch() -> np.ndarray:
    return crop_copy(SCREENS["A"], BUTTON)


def test_new_project_saves_states_workflow_and_settings(tmp_path):
    project = example_project()
    project.settings.min_confidence = 0.9
    path = project.save(tmp_path / "MyTest")
    assert path.name == "MyTest.ldproj"
    assert (path / PROJECT_FILE).exists()
    assert (path / REFERENCES_DIR).is_dir()

    reloaded = Project.load(path)
    assert reloaded.name == project.name
    assert set(reloaded.states) == set(project.states)
    assert reloaded.settings.min_confidence == 0.9
    assert reloaded.workflow.to_dict() == project.workflow.to_dict()
    assert not reloaded.dirty


def test_reference_images_are_stored_and_reloaded(tmp_path):
    project = Project(name="refs")
    project.save(tmp_path / "refs")
    with pytest.raises(ProjectError):
        Project(name="unsaved").add_reference_image(button_patch(), "ref_A")

    record = project.add_reference_image(button_patch(), "state_a_button", source_size=(320, 480))
    assert record.file == "state_a_button.png"
    assert (project.references_dir / "state_a_button.png").exists()
    project.save()

    reloaded = Project.load(tmp_path / "refs.ldproj")
    image = reloaded.load_reference("state_a_button")
    assert image is not None
    assert image.shape[:2] == (BUTTON.height, BUTTON.width)
    assert reloaded.reference_source_size("state_a_button") == (320, 480)
    assert reloaded.load_reference("missing") is None
    assert reloaded.reference_names() == ["state_a_button"]


def test_reference_can_be_added_from_a_file(tmp_path):
    source = tmp_path / "external.png"
    import cv2

    ok, buffer = cv2.imencode(".png", button_patch())
    assert ok
    buffer.tofile(str(source))
    project = Project(name="from file")
    project.save(tmp_path / "fromfile")
    project.add_reference_image(source, "external")
    assert project.load_reference("external") is not None
    with pytest.raises(ProjectError):
        project.add_reference_image(tmp_path / "nope.png", "broken")


def test_removing_a_reference_deletes_the_file(tmp_path):
    project = Project(name="refs")
    project.save(tmp_path / "refs")
    project.add_reference_image(button_patch(), "temp_ref")
    path = project.references_dir / "temp_ref.png"
    assert project.remove_reference("temp_ref")
    assert not path.exists()
    assert not project.remove_reference("temp_ref")


def test_saving_under_a_new_name_copies_the_references(tmp_path):
    project = Project(name="original")
    project.save(tmp_path / "original")
    project.add_reference_image(button_patch(), "ref_A")
    project.save(tmp_path / "copy")
    assert (tmp_path / "copy.ldproj" / REFERENCES_DIR / "ref_A.png").exists()
    assert Project.load(tmp_path / "copy.ldproj").load_reference("ref_A") is not None


def test_state_management_and_renaming():
    project = Project()
    project.add_state(VisualState(name="FIRST", expected_state="SECOND"))
    project.add_state(VisualState(name="SECOND", fallback="FIRST", next_state="FIRST"))
    assert project.state_names() == ["FIRST", "SECOND"]
    assert project.rename_state("FIRST", "START")
    assert project.states["SECOND"].fallback == "START"
    assert project.states["SECOND"].next_state == "START"
    assert not project.rename_state("MISSING", "X")
    assert project.remove_state("START")
    assert not project.remove_state("START")
    with pytest.raises(ProjectError):
        project.add_state(VisualState(name=""))


def test_validation_reports_broken_references():
    project = Project()
    project.add_state(
        VisualState(
            name="A",
            references=[ReferenceSpec(image="missing_image")],
            expected_state="GHOST",
            fallback="ALSO_GHOST",
            next_state="NOWHERE",
        )
    )
    project.add_state(VisualState(name="NO_RULE"))
    project.workflow = example_workflow()
    problems = project.validate()
    joined = " | ".join(problems)
    assert "unknown reference image 'missing_image'" in joined
    assert "expects unknown state 'GHOST'" in joined
    assert "falls back to unknown state 'ALSO_GHOST'" in joined
    assert "unknown next state 'NOWHERE'" in joined
    assert "no detection rule" in joined
    assert "undefined state 'STATE_A'" in joined


def test_valid_project_has_no_warnings(tmp_path):
    project = Project(name="clean")
    project.save(tmp_path / "clean")
    project.add_reference_image(button_patch(), "ref_A")
    project.add_state(
        VisualState(name="STATE_A", references=[ReferenceSpec(image="ref_A")], confidence=0.85)
    )
    project.workflow.nodes = [
        make_node(NodeType.ANALYZE),
        make_node(NodeType.IF, condition=StateIs(state="STATE_A"),
                  then_nodes=[make_node(NodeType.ACTION,
                                        action=LeftClick(target=Target(mode=TargetMode.STATE, state="STATE_A")))]),
    ]
    assert project.validate() == []


def test_storage_audit_finds_no_captured_frames(tmp_path):
    project = example_project()
    project.save(tmp_path / "audited")
    project.add_reference_image(button_patch(), "ref_A")
    project.save()
    assert project.audit_storage() == []
    files = sorted(path.name for path in project.path.rglob("*") if path.is_file())
    assert files == ["project.json", "ref_A.png"]


def test_project_settings_roundtrip():
    settings = ProjectSettings(
        engine_mode="states",
        capture_backend="mss",
        ocr_engine="tesseract",
        ocr_language="ru",
        ocr_preprocess=Preprocess(scale=3.0, threshold="adaptive"),
        min_confidence=0.77,
        window_insets=(1, 2, 3, 4),
        window_hint="LDPlayer-2",
    )
    settings.safety.pointer_cooldown = 1.25
    settings.pointer.jitter = 4
    settings.runner.max_cycles = 12
    restored = ProjectSettings.from_dict(settings.to_dict())
    assert restored.to_dict() == settings.to_dict()
    assert restored.window_insets == (1, 2, 3, 4)
    assert restored.safety.pointer_cooldown == 1.25
    assert restored.pointer.jitter == 4
    assert restored.runner.max_cycles == 12


def test_loading_a_missing_project_fails(tmp_path):
    with pytest.raises(ProjectError):
        Project.load(tmp_path / "nothing")


def test_missing_reference_files_are_reported(tmp_path, log):
    project = Project(name="broken")
    project.save(tmp_path / "broken")
    project.add_reference_image(button_patch(), "ref_A")
    project.save()
    (project.path / REFERENCES_DIR / "ref_A.png").unlink()
    Project.load(project.path, log=log)
    assert any("Missing reference image" in line for line in log.lines())


def test_project_json_is_human_readable(tmp_path):
    project = example_project()
    project.save(tmp_path / "readable")
    data = json.loads((project.path / PROJECT_FILE).read_text(encoding="utf-8"))
    assert data["format"] == 1
    assert {state["name"] for state in data["states"]} == set(project.states)
    assert "nodes" in data["workflow"]
    assert project.describe().startswith(project.name)
