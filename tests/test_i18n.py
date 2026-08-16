from __future__ import annotations

import pytest

from actions import LeftClick, PressKey, Target, TargetMode, Verify, Wait
from conditions import AllOf, ReferenceVisible, StateIs, describe_condition
from i18n import (
    RU,
    available_languages,
    get_language,
    language_code,
    language_label,
    set_language,
    tr,
    validate_translations,
)
from logger import EventLog, LogLevel
from project import ProjectSettings, example_project
from state_machine import ReferenceSpec, VisualState
from vision import Roi
from workflow import NodeType, make_node, outline_text


@pytest.fixture
def russian():
    set_language("ru")
    yield
    set_language("en")


def test_every_translation_keeps_its_format_placeholders():
    """A wrong placeholder would raise at runtime, so this must stay empty."""
    assert validate_translations() == []


def test_language_selection_helpers():
    assert available_languages() == [("ru", "Русский"), ("en", "English")]
    assert language_label("ru") == "Русский"
    assert language_code("English") == "en"
    assert language_code("does not exist") == "ru"
    assert set_language("de") == "ru"      # unknown codes fall back
    assert set_language("en") == "en"
    assert get_language() == "en"


def test_unknown_strings_pass_through(russian):
    assert tr("Verification: SUCCESS") == "Проверка: УСПЕХ"
    assert tr("this string has no translation") == "this string has no translation"
    set_language("en")
    assert tr("Verification: SUCCESS") == "Verification: SUCCESS"


def test_log_templates_are_translated_with_their_values(russian):
    log = EventLog(level=LogLevel.DEBUG)
    log.info("State detected: %s, confidence=%.2f", "ЭКРАН_А", 0.94)
    log.warning("Retry %s/%s", 1, 3)
    lines = log.lines()
    assert "Обнаружено состояние: ЭКРАН_А, уверенность=0.94" in lines[0]
    assert "Повтор 1/3" in lines[1]


def test_action_and_condition_descriptions_are_translated(russian):
    click = LeftClick(target=Target(mode=TargetMode.STATE, state="ЭКРАН_А"))
    assert click.describe() == "ЛЕВЫЙ КЛИК -> элемент состояния «ЭКРАН_А»"
    assert Wait(seconds=2).describe() == "ПАУЗА 2 с"
    assert PressKey(key="enter", presses=2).describe() == "НАЖАТЬ КЛАВИШУ enter x2"
    assert Verify(expected_state="ЭКРАН_Б", timeout=5).describe().startswith("ПРОВЕРКА состояния")
    assert StateIs(state="ЭКРАН_А").describe() == "СОСТОЯНИЕ ЭКРАН_А обнаружено"
    assert ReferenceVisible(reference="кнопка", threshold=0.9).describe() == (
        "ИЗОБРАЖЕНИЕ «кнопка» видно (>= 0.90)"
    )
    combined = AllOf([StateIs(state="A"), StateIs(state="B")]).describe()
    assert " И " in combined
    assert describe_condition(None) == "всегда"


def test_the_scenario_diagram_is_translated(russian):
    project = example_project()
    text = outline_text(project.workflow)
    assert text.startswith("НАЧАЛО")
    assert "ЕСЛИ СОСТОЯНИЕ STATE_A обнаружено" in text
    assert "├── ДА" in text and "└── ИНАЧЕ" in text
    assert "ИНАЧЕ ЕСЛИ" in text
    assert "ПОВТОР x3" in text and "ТЕЛО" in text
    assert text.endswith("КОНЕЦ")


def test_state_and_region_summaries_are_translated(russian):
    state = VisualState(
        name="ЭКРАН_А",
        references=[ReferenceSpec(image="кнопка", confidence=0.9)],
        actions=[Wait(seconds=1)],
        expected_state="ЭКРАН_Б",
        fallback="STOP",
    )
    summary = state.summary()
    assert "уверенность >= 0.85" in summary
    assert "эталонных изображений: 1" in summary
    assert "действий: 1" in summary
    assert "ожидается ЭКРАН_Б" in summary
    assert Roi.full().describe() == "весь экран"
    assert Roi(0.1, 0.2, 0.3, 0.4).describe().startswith("область")
    assert state.references[0].describe() == "кнопка (>= 0.90, весь экран)"


def test_node_descriptions_are_translated(russian):
    assert make_node(NodeType.ANALYZE).describe() == "АНАЛИЗ ЭКРАНА"
    assert make_node(NodeType.WAIT, seconds=1.5).describe() == "ПАУЗА 1.5 с"
    assert make_node(NodeType.RETRY, attempts=2, delay=1).describe() == "ПОВТОР x2 (пауза 1 с)"
    assert make_node(NodeType.STOP).describe() == "СТОП"
    assert make_node(NodeType.STOP, reason="конец").describe() == "СТОП (конец)"
    assert make_node(NodeType.LOOP, count=4).describe() == "ЦИКЛ x4"


def test_the_language_is_part_of_the_project(tmp_path):
    from project import Project

    project = example_project()
    project.settings.language = "en"
    project.save(tmp_path / "localised")
    assert Project.load(tmp_path / "localised.ldproj").settings.language == "en"
    assert ProjectSettings().language == "ru"


def test_the_russian_dictionary_has_no_empty_entries():
    assert all(key and value for key, value in RU.items())
    # Pure layout templates are the same in both languages; anything else that is
    # identical would be a forgotten translation.
    layout_only = {
        "%s -> %s", "%s (>= %.2f, %s)", "X", "Y", "LDPlayer:", "X (0..1)", "Y (0..1)",
    }
    identical = {key for key, value in RU.items() if key == value} - layout_only
    assert identical == set()
