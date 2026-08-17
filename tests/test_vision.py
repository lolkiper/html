from __future__ import annotations

import cv2
import numpy as np

from conftest import BANNER, BUTTON, SCREENS
from vision import (
    PixelRect,
    Roi,
    color_distance,
    crop_copy,
    edge_density,
    feature_match,
    find_color,
    histogram_similarity,
    image_difference,
    match_all,
    match_template,
    pixel_color,
    template_similarity,
)


def reference(name: str, rect: PixelRect) -> np.ndarray:
    return crop_copy(SCREENS[name], rect)


def test_roi_pixel_conversion_roundtrip():
    roi = Roi(0.25, 0.5, 0.5, 0.25)
    rect = roi.to_pixels(320, 480)
    assert rect.as_tuple() == (80, 240, 160, 120)
    again = Roi.from_pixels(rect, 320, 480)
    assert abs(again.x - roi.x) < 1e-6 and abs(again.height - roi.height) < 1e-6
    assert abs(Roi(0.9, 0.9, 0.5, 0.5).clamped().width - 0.1) < 1e-9
    assert Roi.full().is_full()


def test_template_match_locates_the_element_and_its_centre():
    result = match_template(SCREENS["A"], reference("A", BUTTON), threshold=0.9, label="ref_A")
    assert result.found and result.confidence > 0.99
    assert result.rect.as_tuple() == BUTTON.as_tuple()
    assert result.center == BUTTON.center
    assert result.normalized_center == (BUTTON.center[0] / 320, BUTTON.center[1] / 480)


def test_template_match_fails_on_a_different_screen():
    result = match_template(SCREENS["B"], reference("A", BUTTON), threshold=0.85)
    assert not result.found
    assert result.confidence < 0.85


def test_roi_limits_the_search_area():
    top_half = Roi(0.0, 0.0, 1.0, 0.5)
    assert not match_template(SCREENS["A"], reference("A", BUTTON), 0.85, roi=top_half).found
    bottom_half = Roi(0.0, 0.5, 1.0, 0.5)
    hit = match_template(SCREENS["A"], reference("A", BUTTON), 0.85, roi=bottom_half)
    assert hit.found and hit.rect.y == BUTTON.y


def test_base_scale_keeps_a_reference_usable_after_a_resize():
    resized = cv2.resize(SCREENS["A"], (256, 384), interpolation=cv2.INTER_AREA)
    template = reference("A", BUTTON)
    naive = match_template(resized, template, threshold=0.85)
    scaled = match_template(
        resized, template, threshold=0.7, base_scale=256 / 320,
        scales=(1.0, 0.95, 1.05),
    )
    assert scaled.confidence > naive.confidence
    assert scaled.found
    assert abs(scaled.center[0] - int(BUTTON.center[0] * 256 / 320)) <= 6


def test_match_all_finds_every_occurrence():
    screen = np.full((200, 400, 3), 20, dtype=np.uint8)
    patch = SCREENS["A"][BUTTON.y : BUTTON.y + 40, BUTTON.x : BUTTON.x + 40]
    screen[20:60, 20:60] = patch
    screen[120:160, 300:340] = patch
    matches = match_all(screen, patch, threshold=0.9)
    assert len(matches) == 2
    centres = sorted(match.center for match in matches)
    assert centres == [(40, 40), (320, 140)]


def test_color_helpers():
    screen = np.zeros((100, 100, 3), dtype=np.uint8)
    screen[10:40, 10:50] = (0, 200, 0)
    match = find_color(screen, (0, 200, 0), tolerance=20, min_coverage=0.05)
    assert match.found
    assert match.rect.as_tuple() == (10, 10, 40, 30)
    assert pixel_color(screen, 20, 20) == (0, 200, 0)
    assert color_distance((0, 200, 0), (0, 200, 0)) == 0.0
    assert color_distance((0, 0, 0), (255, 255, 255)) == 1.0
    assert not find_color(screen, (255, 0, 255), tolerance=5, min_coverage=0.05).found


def test_difference_and_similarity_metrics():
    assert image_difference(SCREENS["A"], SCREENS["A"]) == 0.0
    assert image_difference(SCREENS["A"], SCREENS["B"]) > 0.01
    assert histogram_similarity(SCREENS["A"], SCREENS["A"]) > 0.99
    assert template_similarity(SCREENS["A"], SCREENS["A"]) > 0.99
    assert template_similarity(SCREENS["A"], SCREENS["C"]) < 0.9


def test_feature_match_and_edge_density():
    result = feature_match(SCREENS["B"], reference("B", BANNER), threshold=0.1)
    assert result.confidence > 0.1
    assert edge_density(SCREENS["A"], Roi(0.0, 0.6, 1.0, 0.2)) > 0.0
    assert edge_density(SCREENS["NOISE"]) == 0.0
