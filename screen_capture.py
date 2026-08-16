"""Window capture that lives entirely in RAM.

Pipeline::

    LDPlayer window -> capture -> numpy frame in RAM -> OpenCV / OCR -> result
                                                                    -> release()

This module deliberately contains no image writing code: there is no ``imwrite``,
no ``Image.save`` and no temporary directory.  Frames are numpy buffers that are
zero filled and dropped by :meth:`Frame.release`.  The only images ever read from
disk are reference images the user explicitly added to a project (see
``project.py``).
"""

from __future__ import annotations

import itertools
import platform
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np

from logger import EventLog, get_logger

IS_WINDOWS = sys.platform.startswith("win")

_frame_counter = itertools.count(1)


class CaptureError(RuntimeError):
    """Raised when a frame could not be acquired."""


@dataclass
class Frame:
    """A single BGR frame held in memory.

    ``origin`` is the screen position of pixel (0, 0) so that any pixel found by
    vision or OCR can be translated back into a screen coordinate, whatever the
    window position is at that moment.
    """

    image: np.ndarray
    origin: tuple[int, int] = (0, 0)
    captured_at: float = field(default_factory=time.time)
    source: str = "window"
    token: int = field(default_factory=lambda: next(_frame_counter))

    # ------------------------------------------------------------- geometry
    @property
    def height(self) -> int:
        return 0 if self.image is None else int(self.image.shape[0])

    @property
    def width(self) -> int:
        return 0 if self.image is None else int(self.image.shape[1])

    @property
    def size(self) -> tuple[int, int]:
        return self.width, self.height

    def is_empty(self) -> bool:
        return self.image is None or self.image.size == 0

    def client_to_screen(self, x: float, y: float) -> tuple[int, int]:
        return int(round(self.origin[0] + x)), int(round(self.origin[1] + y))

    def normalized_to_client(self, nx: float, ny: float) -> tuple[int, int]:
        return int(round(nx * max(self.width - 1, 0))), int(round(ny * max(self.height - 1, 0)))

    def client_to_normalized(self, x: float, y: float) -> tuple[float, float]:
        return (
            x / self.width if self.width else 0.0,
            y / self.height if self.height else 0.0,
        )

    def crop(self, rect: Any) -> np.ndarray:
        """Return a view (no copy) of the given pixel rectangle."""
        x, y, w, h = int(rect.x), int(rect.y), int(rect.width), int(rect.height)
        x = max(0, min(x, self.width))
        y = max(0, min(y, self.height))
        w = max(0, min(w, self.width - x))
        h = max(0, min(h, self.height - y))
        return self.image[y : y + h, x : x + w]

    def mean_brightness(self) -> float:
        if self.is_empty():
            return 0.0
        return float(self.image.mean())

    # -------------------------------------------------------------- memory
    def release(self) -> None:
        """Zero the buffer and drop the reference so the frame cannot linger."""
        image = self.image
        self.image = None  # type: ignore[assignment]
        if image is not None and image.base is None:
            try:
                image.fill(0)
            except (ValueError, AttributeError):  # read-only or already gone
                pass

    def __enter__(self) -> "Frame":
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return (
            f"Frame(#{self.token}, {self.width}x{self.height}, origin={self.origin}, "
            f"source={self.source!r})"
        )


class CaptureBackend(Protocol):
    """Anything able to hand back the pixels of a screen rectangle."""

    name: str

    def grab(self, x: int, y: int, width: int, height: int, handle: int | None = None) -> np.ndarray:
        ...

    def close(self) -> None:
        ...


# --------------------------------------------------------------------------- #
# Windows GDI backend
# --------------------------------------------------------------------------- #
class WindowsGdiBackend:
    """Captures a window with ``PrintWindow`` and falls back to ``BitBlt``.

    ``PrintWindow`` with ``PW_RENDERFULLCONTENT`` also works for windows that are
    partially covered, which matters for an emulator running behind the editor.
    Hardware accelerated renderers sometimes return an empty (black) surface; in
    that case the screen area of the window is copied instead.
    """

    name = "windows-gdi"

    SRCCOPY = 0x00CC0020
    CAPTUREBLT = 0x40000000
    DIB_RGB_COLORS = 0
    PW_CLIENTONLY = 0x00000001
    PW_RENDERFULLCONTENT = 0x00000002

    def __init__(self) -> None:
        if not IS_WINDOWS:  # pragma: no cover - platform guard
            raise CaptureError("The GDI backend is only available on Windows")
        import ctypes  # local import keeps the module importable elsewhere
        from ctypes import wintypes

        self._ctypes = ctypes
        self._wintypes = wintypes
        self._user32 = ctypes.windll.user32
        self._gdi32 = ctypes.windll.gdi32
        try:  # per monitor DPI awareness -> window rects match real pixels
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:  # pragma: no cover - older Windows
            try:
                self._user32.SetProcessDPIAware()
            except Exception:
                pass

    def _bitmap_info(self, width: int, height: int):  # pragma: no cover - Windows only
        ctypes = self._ctypes
        wintypes = self._wintypes

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", wintypes.DWORD),
                ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long),
                ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD),
                ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long),
                ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD),
            ]

        class BITMAPINFO(ctypes.Structure):
            _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]

        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height  # top-down rows
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0  # BI_RGB
        return info

    def grab(  # pragma: no cover - Windows only
        self, x: int, y: int, width: int, height: int, handle: int | None = None
    ) -> np.ndarray:
        if width <= 0 or height <= 0:
            raise CaptureError(f"Invalid capture size {width}x{height}")
        ctypes = self._ctypes
        user32, gdi32 = self._user32, self._gdi32

        source_dc = user32.GetWindowDC(handle) if handle else user32.GetDC(0)
        if not source_dc:
            raise CaptureError("Could not obtain a device context for the window")
        memory_dc = gdi32.CreateCompatibleDC(source_dc)
        bitmap = gdi32.CreateCompatibleBitmap(memory_dc, width, height)
        previous = gdi32.SelectObject(memory_dc, bitmap)
        buffer = ctypes.create_string_buffer(width * height * 4)
        info = self._bitmap_info(width, height)
        try:
            copied = False
            if handle:
                # PW_CLIENTONLY keeps the title bar and the border out of the
                # bitmap, so the frame matches the client rectangle the engine
                # measured and coordinates stay valid.
                copied = bool(
                    user32.PrintWindow(
                        handle, memory_dc, self.PW_CLIENTONLY | self.PW_RENDERFULLCONTENT
                    )
                )
            if not copied:
                screen_dc = user32.GetDC(0)
                try:
                    copied = bool(
                        gdi32.BitBlt(
                            memory_dc, 0, 0, width, height,
                            screen_dc, x, y, self.SRCCOPY | self.CAPTUREBLT,
                        )
                    )
                finally:
                    user32.ReleaseDC(0, screen_dc)
            if not copied:
                raise CaptureError("Both PrintWindow and BitBlt failed")
            gdi32.GetDIBits(
                memory_dc, bitmap, 0, height, buffer,
                ctypes.byref(info), self.DIB_RGB_COLORS,
            )
            bgra = np.frombuffer(buffer, dtype=np.uint8).reshape(height, width, 4)
            image = np.ascontiguousarray(bgra[:, :, :3])
            if not image.any() and handle:
                # Hardware surface returned nothing: copy the screen region.
                return self._grab_screen_region(x, y, width, height)
            return image
        finally:
            gdi32.SelectObject(memory_dc, previous)
            gdi32.DeleteObject(bitmap)
            gdi32.DeleteDC(memory_dc)
            user32.ReleaseDC(handle or 0, source_dc)

    def _grab_screen_region(  # pragma: no cover - Windows only
        self, x: int, y: int, width: int, height: int
    ) -> np.ndarray:
        return self.grab(x, y, width, height, handle=None)

    def close(self) -> None:  # pragma: no cover - nothing to release
        return None


# --------------------------------------------------------------------------- #
# mss backend (cross platform fallback / development)
# --------------------------------------------------------------------------- #
class MssBackend:
    """Screen-region capture through the ``mss`` package."""

    name = "mss"

    def __init__(self) -> None:
        try:
            import mss  # noqa: F401
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise CaptureError("The 'mss' package is required for this backend") from exc
        self._mss_module = __import__("mss")
        self._local = threading.local()

    def _session(self):
        session = getattr(self._local, "session", None)
        if session is None:
            session = self._mss_module.mss()
            self._local.session = session
        return session

    def grab(self, x: int, y: int, width: int, height: int, handle: int | None = None) -> np.ndarray:
        if width <= 0 or height <= 0:
            raise CaptureError(f"Invalid capture size {width}x{height}")
        raw = self._session().grab({"left": x, "top": y, "width": width, "height": height})
        frame = np.frombuffer(raw.rgb, dtype=np.uint8).reshape(raw.height, raw.width, 3)
        return np.ascontiguousarray(frame[:, :, ::-1])  # RGB -> BGR

    def close(self) -> None:
        session = getattr(self._local, "session", None)
        if session is not None:
            try:
                session.close()
            except Exception:  # pragma: no cover
                pass
            self._local.session = None


class StaticBackend:
    """Serves pre-built frames. Used by tests, demos and ``--dry-run``."""

    name = "static"

    def __init__(self, images: list[np.ndarray] | np.ndarray | None = None, loop: bool = True):
        if images is None:
            images = []
        if isinstance(images, np.ndarray):
            images = [images]
        self.images = list(images)
        self.loop = loop
        self.index = 0
        self.calls = 0

    def set_images(self, images: list[np.ndarray]) -> None:
        self.images = list(images)
        self.index = 0

    def grab(self, x: int, y: int, width: int, height: int, handle: int | None = None) -> np.ndarray:
        if not self.images:
            raise CaptureError("StaticBackend has no images")
        if self.index >= len(self.images):
            if not self.loop:
                self.index = len(self.images) - 1
            else:
                self.index = 0
        image = self.images[self.index]
        self.index += 1
        self.calls += 1
        if image.shape[0] != height or image.shape[1] != width:
            image = image[:height, :width]
        return image.copy()

    def close(self) -> None:
        self.images = []


def create_backend(name: str = "auto", log: EventLog | None = None) -> CaptureBackend:
    """Instantiate the best capture backend available for this machine."""
    log = log or get_logger()
    name = (name or "auto").lower()
    if name in ("windows", "gdi", "windows-gdi"):
        return WindowsGdiBackend()
    if name == "mss":
        return MssBackend()
    if name == "static":
        return StaticBackend()
    errors: list[str] = []
    if IS_WINDOWS:
        try:
            return WindowsGdiBackend()
        except Exception as exc:  # pragma: no cover - Windows only
            errors.append(f"gdi: {exc}")
    try:
        return MssBackend()
    except Exception as exc:
        errors.append(f"mss: {exc}")
    raise CaptureError(
        "No capture backend available on this system ("
        + "; ".join(errors)
        + f"; platform={platform.system()})"
    )


class WindowCapture:
    """Grabs the client area of a tracked window into RAM.

    The window geometry is re-read before every capture, so moving or resizing
    the emulator while a workflow runs stays safe: coordinates are always
    expressed relative to the freshly measured client area.
    """

    def __init__(
        self,
        window: Any,
        backend: CaptureBackend | str = "auto",
        log: EventLog | None = None,
        min_size: int = 16,
    ) -> None:
        self.window = window
        self.log = log or get_logger()
        self.backend: CaptureBackend = (
            create_backend(backend, self.log) if isinstance(backend, str) else backend
        )
        self.min_size = min_size
        self.frames_captured = 0
        self._last_geometry: tuple[int, int, int, int] | None = None

    # ------------------------------------------------------------------ api
    def grab(self) -> Frame:
        window = self.window
        if window is None:
            raise CaptureError("No window selected")
        if hasattr(window, "refresh"):
            window.refresh()
        if hasattr(window, "is_alive") and not window.is_alive():
            raise CaptureError("The selected LDPlayer window no longer exists")
        rect = window.client_rect
        geometry = (int(rect.left), int(rect.top), int(rect.width), int(rect.height))
        if geometry[2] < self.min_size or geometry[3] < self.min_size:
            raise CaptureError(
                f"The window is too small to analyse ({geometry[2]}x{geometry[3]}); "
                "it may be minimised"
            )
        if self._last_geometry is not None and geometry != self._last_geometry:
            old = self._last_geometry
            if (old[2], old[3]) != (geometry[2], geometry[3]):
                self.log.info(
                    "Window resized: %sx%s -> %sx%s (coordinates rescaled)",
                    old[2], old[3], geometry[2], geometry[3],
                )
            else:
                self.log.debug(
                    "Window moved: (%s,%s) -> (%s,%s)", old[0], old[1], geometry[0], geometry[1]
                )
        self._last_geometry = geometry
        handle = getattr(window, "handle", None)
        image = self.backend.grab(*geometry, handle=handle)
        if image is None or image.size == 0:
            raise CaptureError("The capture backend returned an empty frame")
        self.frames_captured += 1
        return Frame(
            image=image,
            origin=(geometry[0], geometry[1]),
            source=getattr(window, "title", "window"),
        )

    def close(self) -> None:
        self.backend.close()

    def __enter__(self) -> "WindowCapture":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
