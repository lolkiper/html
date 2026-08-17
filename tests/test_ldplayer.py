from __future__ import annotations

from ldplayer import (
    LDPlayerInstance,
    LDPlayerWindow,
    StaticWindowBackend,
    WindowRect,
    _matches_ldplayer,
    find_instance,
    manual_window,
)


def test_window_rect_geometry():
    rect = WindowRect(100, 50, 320, 480)
    assert rect.right == 420 and rect.bottom == 530
    assert rect.center == (260, 290)
    assert rect.contains(100, 50) and not rect.contains(420, 530)
    assert rect.inset(10, 10, 10, 10) == WindowRect(110, 60, 300, 460)


def test_coordinates_follow_a_moved_window(window):
    assert window.client_to_screen(0, 0) == (100, 50)
    window.fake_backend.move(400, 200)
    window.refresh()
    assert window.client_to_screen(0, 0) == (400, 200)
    assert window.normalized_to_screen(0.5, 0.5) == (400 + 160, 200 + 240)


def test_normalized_targets_survive_a_resize(window):
    center_before = window.normalized_to_client(0.5, 0.5)
    window.fake_backend.resize(640, 960)
    window.refresh()
    center_after = window.normalized_to_client(0.5, 0.5)
    assert center_after == (320, 480)
    assert center_after[0] > center_before[0] * 1.9
    normalized = window.client_to_normalized(*center_after)
    assert abs(normalized[0] - 0.5) < 0.01 and abs(normalized[1] - 0.5) < 0.01


def test_geometry_listener_reports_move_and_resize(window):
    events: list[str] = []
    window.add_geometry_listener(lambda _window, kind: events.append(kind))
    window.fake_backend.move(150, 60)
    assert window.refresh() is True
    window.fake_backend.resize(400, 500)
    window.refresh()
    assert events == ["moved", "resized"]


def test_insets_restrict_the_workable_area(window):
    window.set_insets(left=10, top=20, right=30, bottom=40)
    rect = window.client_rect
    assert rect.left == 110 and rect.top == 70
    assert rect.width == 320 - 40 and rect.height == 480 - 60
    assert window.contains_client_point(0, 0)
    assert not window.contains_client_point(rect.width, 0)


def test_dead_window_is_reported(window):
    window.fake_backend.alive = False
    assert not window.is_alive()
    assert not window.is_usable()


def test_manual_window_targets_any_screen_region():
    manual = manual_window(0, 0, 800, 600, title="Region")
    assert manual.client_size == (800, 600)
    assert manual.is_usable()
    assert manual.normalized_to_screen(1.0, 1.0) == (799, 599)


def test_instance_matching_and_selection():
    assert _matches_ldplayer("LDPlayer-2", "LDPlayerMainFrame", "C:\\LDPlayer\\dnplayer.exe")
    assert _matches_ldplayer("", "TheRender", "C:\\LDPlayer\\dnplayer.exe")
    assert not _matches_ldplayer("Notepad", "Notepad", "C:\\Windows\\notepad.exe")
    instances = [
        LDPlayerInstance(handle=10, title="LDPlayer", instance_index=0),
        LDPlayerInstance(handle=11, title="LDPlayer-1", instance_index=1),
    ]
    assert find_instance(None, instances).handle == 10
    assert find_instance(1, instances).handle == 11
    assert find_instance("player-1", instances).handle == 11
    assert find_instance("missing", instances) is None
    assert "hwnd=11" in instances[1].label


def test_instance_can_be_opened_into_a_window():
    instance = LDPlayerInstance(handle=0, title="LDPlayer-3")
    opened = instance.open()
    assert isinstance(opened, LDPlayerWindow)
    assert opened.title == "LDPlayer-3"
    assert opened.to_dict()["handle"] == 0
