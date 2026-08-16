from __future__ import annotations

import numpy as np

from conftest import SCREENS, ScriptedOcrEngine
from ocr import NullOcrEngine, OcrService, Preprocess, create_engine, extract_numbers, normalize_text
from vision import PixelRect, Roi


def service(lines, emulator=None) -> OcrService:
    return OcrService(ScriptedOcrEngine(lines, emulator))


def test_number_extraction_handles_separators():
    assert extract_numbers("Score: 1,234.50 pts") == [1234.5]
    assert extract_numbers("hp 45/100") == [45.0, 100.0]
    assert extract_numbers("balance 1 250") == [1250.0]
    assert extract_numbers("-12.5C") == [-12.5]
    assert extract_numbers("no digits") == []
    assert normalize_text("  Hello   WORLD ") == "hello world"


def test_find_text_returns_position_and_confidence():
    ocr = service({"*": [("Continue", 0.93, PixelRect(100, 200, 90, 24))]})
    match = ocr.find_text(
        SCREENS["A"], "continue", min_confidence=0.6, preprocess=Preprocess(scale=1.0)
    )
    assert match.found and match.confidence == 0.93
    assert match.center == (145, 212)
    assert not ocr.find_text(SCREENS["A"], "cancel").found


def test_find_text_supports_regex_and_whole_line():
    ocr = service({"*": [("Error code 42", 0.88, PixelRect(0, 0, 100, 20))]})
    assert ocr.find_text(SCREENS["A"], r"error code \d+", regex=True).found
    assert not ocr.find_text(SCREENS["A"], "error", whole_line=True).found
    assert ocr.find_text(SCREENS["A"], "Error code 42", whole_line=True).found


def test_low_confidence_text_is_not_accepted():
    ocr = service({"*": [("Start", 0.4, PixelRect(10, 10, 40, 20))]})
    match = ocr.find_text(SCREENS["A"], "start", min_confidence=0.7)
    assert not match.found
    assert match.confidence == 0.4


def test_roi_offsets_are_added_back_to_the_result():
    ocr = service({"*": [("OK", 0.9, PixelRect(10, 10, 20, 10))]})
    roi = Roi(0.5, 0.5, 0.5, 0.5)
    match = ocr.find_text(SCREENS["A"], "ok", roi=roi, preprocess=Preprocess(scale=1.0))
    assert match.rect.x == 160 + 10 and match.rect.y == 240 + 10


def test_preprocess_scaling_is_undone_in_coordinates():
    ocr = service({"*": [("OK", 0.9, PixelRect(40, 60, 20, 10))]})
    match = ocr.find_text(SCREENS["A"], "ok", preprocess=Preprocess(scale=2.0))
    assert match.rect.x == 20 and match.rect.y == 30


def test_results_are_cached_per_frame_token():
    engine = ScriptedOcrEngine({"*": [("Hi", 0.9, PixelRect(0, 0, 10, 10))]})
    ocr = OcrService(engine)
    ocr.read_lines(SCREENS["A"], frame_token=7)
    ocr.read_lines(SCREENS["A"], frame_token=7)
    assert engine.calls == 1
    ocr.read_lines(SCREENS["A"], frame_token=8)
    assert engine.calls == 2


def test_find_number_returns_value_and_box():
    ocr = service({"*": [("Coins 1500", 0.95, PixelRect(5, 5, 80, 20))]})
    value, match = ocr.find_number(SCREENS["A"])
    assert value == 1500.0 and match.found
    assert "1500" in match.text


def test_missing_engine_degrades_gracefully():
    ocr = OcrService(NullOcrEngine())
    assert ocr.read_lines(SCREENS["A"]) == []
    assert not ocr.find_text(SCREENS["A"], "anything").found
    assert ocr.find_number(SCREENS["A"])[0] is None
    assert not ocr.available()
    assert create_engine("none").name == "none"


def test_preprocess_serialisation_roundtrip():
    original = Preprocess(scale=1.5, grayscale=True, contrast=False, threshold="otsu", invert=True)
    assert Preprocess.from_dict(original.to_dict()) == original
    prepared, scale = original.apply(np.zeros((20, 20, 3), dtype=np.uint8))
    assert scale == 1.5 and prepared.shape[0] == 30
