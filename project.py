"""Project storage: workflow configuration separated from temporary data.

A project is a directory::

    MyTest.ldproj/
        project.json        states, workflow, settings
        references/         reference images the user added on purpose

Automatically captured frames are never stored: they live in RAM only.  The only
image writing function of the whole application is
:meth:`Project.add_reference_image`, and it is called exclusively from an
explicit user action ("add reference image" / "use current screen as reference").
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np

from logger import EventLog, get_logger
from mouse import PointerSettings
from ocr import Preprocess
from safety import SafetySettings, audit_no_frame_artifacts
from state_machine import ReferenceSpec, RunnerSettings, UNKNOWN_STATE, VisualState, build_states
from vision import Roi, load_image
from workflow import Workflow, example_workflow

PROJECT_FILE = "project.json"
REFERENCES_DIR = "references"
PROJECT_SUFFIX = ".ldproj"
FORMAT_VERSION = 1


class ProjectError(RuntimeError):
    """Raised when a project cannot be read or written."""


@dataclass
class ProjectSettings:
    """Everything the engine needs to configure itself for this project."""

    engine_mode: str = "workflow"          # workflow | states
    capture_backend: str = "auto"
    ocr_engine: str = "auto"
    ocr_language: str = "en"
    ocr_preprocess: Preprocess = field(default_factory=Preprocess)
    min_confidence: float = 0.85
    window_insets: tuple[int, int, int, int] = (0, 0, 0, 0)
    window_hint: str = ""                  # remembered LDPlayer title
    safety: SafetySettings = field(default_factory=SafetySettings)
    pointer: PointerSettings = field(default_factory=PointerSettings)
    runner: RunnerSettings = field(default_factory=RunnerSettings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "engine_mode": self.engine_mode,
            "capture_backend": self.capture_backend,
            "ocr_engine": self.ocr_engine,
            "ocr_language": self.ocr_language,
            "ocr_preprocess": self.ocr_preprocess.to_dict(),
            "min_confidence": self.min_confidence,
            "window_insets": list(self.window_insets),
            "window_hint": self.window_hint,
            "safety": self.safety.to_dict(),
            "pointer": self.pointer.to_dict(),
            "runner": self.runner.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ProjectSettings":
        data = dict(data or {})
        insets = data.get("window_insets") or [0, 0, 0, 0]
        return cls(
            engine_mode=str(data.get("engine_mode", "workflow")),
            capture_backend=str(data.get("capture_backend", "auto")),
            ocr_engine=str(data.get("ocr_engine", "auto")),
            ocr_language=str(data.get("ocr_language", "en")),
            ocr_preprocess=Preprocess.from_dict(data.get("ocr_preprocess")),
            min_confidence=float(data.get("min_confidence", 0.85)),
            window_insets=tuple(int(value) for value in list(insets)[:4]),  # type: ignore[arg-type]
            window_hint=str(data.get("window_hint", "")),
            safety=SafetySettings.from_dict(data.get("safety")),
            pointer=PointerSettings.from_dict(data.get("pointer")),
            runner=RunnerSettings.from_dict(data.get("runner")),
        )


@dataclass
class ReferenceRecord:
    """Metadata of a stored reference image."""

    name: str
    file: str
    source_size: tuple[int, int] | None = None   # frame size it was captured at
    added_at: float = field(default_factory=time.time)
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "file": self.file,
            "source_size": list(self.source_size) if self.source_size else None,
            "added_at": self.added_at,
            "note": self.note,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReferenceRecord":
        size = data.get("source_size")
        return cls(
            name=str(data.get("name", "")),
            file=str(data.get("file", "")),
            source_size=(int(size[0]), int(size[1])) if size else None,
            added_at=float(data.get("added_at", time.time())),
            note=str(data.get("note", "")),
        )


class Project:
    """States, workflow, settings and the user's reference images."""

    def __init__(
        self,
        name: str = "New project",
        path: str | Path | None = None,
        states: dict[str, VisualState] | None = None,
        workflow: Workflow | None = None,
        settings: ProjectSettings | None = None,
        references: dict[str, ReferenceRecord] | None = None,
        variables: dict[str, Any] | None = None,
        log: EventLog | None = None,
    ) -> None:
        self.name = name
        self.path = Path(path) if path else None
        self.states: dict[str, VisualState] = dict(states or {})
        self.workflow = workflow or Workflow()
        self.settings = settings or ProjectSettings()
        self.references: dict[str, ReferenceRecord] = dict(references or {})
        self.variables: dict[str, Any] = dict(variables or {})
        self.log = log or get_logger()
        self._image_cache: dict[str, np.ndarray] = {}
        self.dirty = False

    # --------------------------------------------------------------- layout
    @property
    def directory(self) -> Path | None:
        return self.path

    @property
    def references_dir(self) -> Path | None:
        return None if self.path is None else self.path / REFERENCES_DIR

    def mark_dirty(self) -> None:
        self.dirty = True

    # ------------------------------------------------------- reference API
    def load_reference(self, name: str) -> np.ndarray | None:
        """Reference library entry point used by the engine (read only)."""
        if name in self._image_cache:
            return self._image_cache[name]
        record = self.references.get(name)
        if record is None:
            return None
        directory = self.references_dir
        if directory is None:
            return None
        path = directory / record.file
        try:
            image = load_image(path)
        except Exception as exc:
            self.log.error("Reference image '%s' could not be loaded: %s", name, exc)
            return None
        self._image_cache[name] = image
        return image

    def reference_source_size(self, name: str) -> tuple[int, int] | None:
        record = self.references.get(name)
        return record.source_size if record else None

    def reference_names(self) -> list[str]:
        return sorted(self.references)

    def add_reference_image(
        self,
        image: np.ndarray | str | Path,
        name: str,
        source_size: tuple[int, int] | None = None,
        note: str = "",
    ) -> ReferenceRecord:
        """Store a reference image inside the project (explicit user action).

        ``image`` is either an array (a region the user selected on the current
        screen) or a path to a file the user picked.  This is the only place in
        the application that writes an image to disk.
        """
        if self.path is None:
            raise ProjectError("save the project before adding reference images")
        directory = self.references_dir
        assert directory is not None
        directory.mkdir(parents=True, exist_ok=True)
        safe_name = _safe_file_name(name)
        file_name = f"{safe_name}.png"
        destination = directory / file_name
        if isinstance(image, (str, Path)):
            source = Path(image)
            if not source.exists():
                raise ProjectError(f"reference image not found: {source}")
            array = load_image(source)
            if source.suffix.lower() == ".png":
                shutil.copyfile(source, destination)
            else:
                _write_png(destination, array)
        else:
            array = image
            _write_png(destination, array)
        record = ReferenceRecord(
            name=name, file=file_name, source_size=source_size, note=note
        )
        self.references[name] = record
        self._image_cache[name] = array
        self.mark_dirty()
        self.log.info(
            "Reference image '%s' added (%sx%s)", name, array.shape[1], array.shape[0]
        )
        return record

    def remove_reference(self, name: str, delete_file: bool = True) -> bool:
        record = self.references.pop(name, None)
        self._image_cache.pop(name, None)
        if record is None:
            return False
        if delete_file and self.references_dir is not None:
            path = self.references_dir / record.file
            if path.exists() and not self._reference_file_in_use(record.file):
                try:
                    path.unlink()
                except OSError:  # pragma: no cover - filesystem dependent
                    pass
        self.mark_dirty()
        return True

    def _reference_file_in_use(self, file_name: str) -> bool:
        return any(record.file == file_name for record in self.references.values())

    # ------------------------------------------------------------- states
    def add_state(self, state: VisualState) -> VisualState:
        if not state.name:
            raise ProjectError("a state needs a name")
        self.states[state.name] = state
        self.mark_dirty()
        return state

    def remove_state(self, name: str) -> bool:
        removed = self.states.pop(name, None) is not None
        if removed:
            self.mark_dirty()
        return removed

    def rename_state(self, old: str, new: str) -> bool:
        state = self.states.pop(old, None)
        if state is None:
            return False
        state.name = new
        self.states[new] = state
        for other in self.states.values():
            if other.expected_state == old:
                other.expected_state = new
            if other.fallback == old:
                other.fallback = new
            if other.next_state == old:
                other.next_state = new
        self.mark_dirty()
        return True

    def state_names(self) -> list[str]:
        return sorted(self.states)

    # ------------------------------------------------------------- storage
    def to_dict(self) -> dict[str, Any]:
        return {
            "format": FORMAT_VERSION,
            "name": self.name,
            "saved_at": time.time(),
            "settings": self.settings.to_dict(),
            "states": [state.to_dict() for state in self.states.values()],
            "workflow": self.workflow.to_dict(),
            "references": [record.to_dict() for record in self.references.values()],
            "variables": self.variables,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any], path: Path | None = None, log: EventLog | None = None) -> "Project":
        references = {}
        for item in data.get("references", []):
            record = ReferenceRecord.from_dict(item)
            if record.name:
                references[record.name] = record
        return cls(
            name=str(data.get("name", "Project")),
            path=path,
            states=build_states(data.get("states")),
            workflow=Workflow.from_dict(data.get("workflow")),
            settings=ProjectSettings.from_dict(data.get("settings")),
            references=references,
            variables=dict(data.get("variables") or {}),
            log=log,
        )

    def save(self, path: str | Path | None = None) -> Path:
        """Write ``project.json``. Reference images are already on disk."""
        target = Path(path) if path else self.path
        if target is None:
            raise ProjectError("no project path given")
        if target.suffix == ".json":
            target = target.parent
        if target.suffix != PROJECT_SUFFIX and not target.exists():
            target = target.with_suffix(PROJECT_SUFFIX)
        target.mkdir(parents=True, exist_ok=True)
        (target / REFERENCES_DIR).mkdir(exist_ok=True)
        previous = self.path
        self.path = target
        if previous is not None and previous != target:
            self._copy_references(previous, target)
        payload = self.to_dict()
        with (target / PROJECT_FILE).open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        self.dirty = False
        self.log.success("Project saved: %s", target)
        return target

    def _copy_references(self, source_dir: Path, target_dir: Path) -> None:
        source = source_dir / REFERENCES_DIR
        if not source.exists():
            return
        destination = target_dir / REFERENCES_DIR
        destination.mkdir(parents=True, exist_ok=True)
        for record in self.references.values():
            origin = source / record.file
            if origin.exists() and not (destination / record.file).exists():
                shutil.copyfile(origin, destination / record.file)

    @classmethod
    def load(cls, path: str | Path, log: EventLog | None = None) -> "Project":
        log = log or get_logger()
        location = Path(path)
        if location.is_file():
            directory = location.parent
            project_file = location
        else:
            directory = location
            project_file = location / PROJECT_FILE
        if not project_file.exists():
            raise ProjectError(f"{project_file} does not exist")
        with project_file.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        project = cls.from_dict(data, path=directory, log=log)
        project.dirty = False
        missing = [
            name for name, record in project.references.items()
            if not (directory / REFERENCES_DIR / record.file).exists()
        ]
        if missing:
            log.warning("Missing reference image files: %s", ", ".join(sorted(missing)))
        log.success(
            "Project loaded: %s (%s state(s), %s reference image(s))",
            project.name, len(project.states), len(project.references),
        )
        return project

    # ------------------------------------------------------------ validation
    def validate(self) -> list[str]:
        """Report problems that would make a run fail or behave oddly."""
        problems: list[str] = []
        for name, state in self.states.items():
            if not state.has_detection_rule():
                problems.append(f"state '{name}' has no detection rule (reference image or condition)")
            for spec in state.references:
                if spec.image not in self.references:
                    problems.append(f"state '{name}' uses unknown reference image '{spec.image}'")
            if state.expected_state and state.expected_state not in self.states:
                problems.append(f"state '{name}' expects unknown state '{state.expected_state}'")
            if state.fallback and state.fallback.upper() != "STOP" and state.fallback not in self.states:
                problems.append(f"state '{name}' falls back to unknown state '{state.fallback}'")
            if state.next_state and state.next_state not in self.states:
                problems.append(f"state '{name}' points to unknown next state '{state.next_state}'")
        for name in self.workflow.referenced_states():
            if name and name not in self.states and name != UNKNOWN_STATE:
                problems.append(f"the workflow references the undefined state '{name}'")
        if not self.workflow.nodes and self.settings.engine_mode == "workflow":
            problems.append("the workflow is empty")
        return problems

    def audit_storage(self) -> list[str]:
        """Verify that no captured frames were persisted next to the project."""
        if self.path is None:
            return []
        return audit_no_frame_artifacts(self.path, allowed=(REFERENCES_DIR,))

    def describe(self) -> str:
        return (
            f"{self.name}: {len(self.states)} state(s), "
            f"{len(list(self.workflow.walk()))} workflow node(s), "
            f"{len(self.references)} reference image(s)"
        )


def _safe_file_name(name: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in "-_." else "_" for char in name.strip())
    return cleaned or "reference"


def _write_png(path: Path, image: np.ndarray) -> None:
    """Encode in memory and write bytes (unicode safe on Windows)."""
    success, buffer = cv2.imencode(".png", image)
    if not success:  # pragma: no cover - encoder failure
        raise ProjectError(f"could not encode {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer.tofile(str(path))


def example_project(name: str = "LDPlayer example") -> Project:
    """A ready to edit project with the four example states and the scenario."""
    states = {
        "STATE_A": VisualState(
            name="STATE_A",
            description="Main screen the test starts from",
            confidence=0.85,
            timeout=10.0,
            retry_count=3,
            expected_state="STATE_C",
            fallback="STATE_B",
        ),
        "STATE_B": VisualState(
            name="STATE_B",
            description="Error message screen",
            confidence=0.85,
            timeout=8.0,
            retry_count=2,
            fallback="STOP",
        ),
        "STATE_C": VisualState(
            name="STATE_C",
            description="Success screen",
            confidence=0.85,
            terminal=False,
        ),
        UNKNOWN_STATE: VisualState(
            name=UNKNOWN_STATE,
            description="Nothing recognised: wait and analyse again",
            confidence=0.99,
            retry_count=0,
        ),
    }
    project = Project(name=name, states=states, workflow=example_workflow())
    project.settings.engine_mode = "workflow"
    return project
