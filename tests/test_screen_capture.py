from __future__ import annotations

import numpy as np
import pytest

from screen_capture import CaptureError, Frame, StaticBackend, WindowCapture


def test_capture_returns_a_frame_with_the_window_origin(window, emulator, log):
    capture = WindowCapture(window, backend=emulator, log=log)
    frame = capture.grab()
    assert frame.size == (320, 480)
    assert frame.origin == (100, 50)
    assert frame.client_to_screen(10, 20) == (110, 70)
    assert frame.normalized_to_client(0.5, 0.5) == (160, 240)
    assert emulator.grabs == 1


def test_frame_release_zeroes_the_buffer():
    image = np.full((4, 4, 3), 255, dtype=np.uint8)
    frame = Frame(image=image)
    with frame:
        assert not frame.is_empty()
    assert frame.image is None
    assert int(image.sum()) == 0


def test_capture_follows_window_moves_and_resizes(window, emulator, log):
    capture = WindowCapture(window, backend=emulator, log=log)
    capture.grab()
    window.fake_backend.move(500, 300)
    frame = capture.grab()
    assert frame.origin == (500, 300)
    window.fake_backend.resize(200, 300)
    frame = capture.grab()
    assert frame.size == (200, 300)
    assert any("resized" in line for line in log.lines())


def test_minimised_or_dead_window_raises(window, emulator, log):
    capture = WindowCapture(window, backend=emulator, log=log)
    window.fake_backend.resize(4, 4)
    with pytest.raises(CaptureError, match="too small"):
        capture.grab()
    window.fake_backend.resize(320, 480)
    window.fake_backend.alive = False
    with pytest.raises(CaptureError, match="no longer exists"):
        capture.grab()


def test_static_backend_serves_a_script_of_frames(window, log):
    first = np.zeros((480, 320, 3), dtype=np.uint8)
    second = np.full((480, 320, 3), 7, dtype=np.uint8)
    backend = StaticBackend([first, second], loop=False)
    capture = WindowCapture(window, backend=backend, log=log)
    assert capture.grab().image.mean() == 0
    assert capture.grab().image.mean() == 7
    assert capture.grab().image.mean() == 7  # keeps the last frame


def test_backend_errors_are_reported_as_capture_errors(window, log):
    """A region outside the desktop must not leak a backend specific exception."""
    class BrokenBackend:
        name = "broken"

        def grab(self, x, y, width, height, handle=None):
            raise RuntimeError("X11 Protocol Error")

        def close(self):
            return None

    capture = WindowCapture(window, backend=BrokenBackend(), log=log)
    with pytest.raises(RuntimeError, match="X11 Protocol Error"):
        capture.grab()


def test_mss_backend_wraps_grab_failures(window, log, monkeypatch):
    mss_module = pytest.importorskip("mss")
    from screen_capture import MssBackend

    backend = MssBackend()

    class FailingSession:
        def grab(self, region):
            raise RuntimeError("X11 Protocol Error")

    monkeypatch.setattr(backend, "_session", lambda: FailingSession())
    with pytest.raises(CaptureError, match="off-screen"):
        backend.grab(0, 0, 100, 100)
