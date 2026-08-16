"""Discovery and live tracking of LDPlayer emulator windows.

Everything the engine does is expressed relative to the selected window:

* the window is located by handle, class name, process executable and title;
* its position and client size are re-read on every cycle, so moving or
  resizing the emulator does not invalidate a workflow;
* targets are stored as normalized coordinates (0..1) inside the client area and
  converted to screen pixels at the moment of the action;
* every action is bounds-checked against the current client rectangle, so the
  engine can never click outside the selected window.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

from logger import EventLog, get_logger

IS_WINDOWS = sys.platform.startswith("win")

#: Window classes used by the different LDPlayer generations.
KNOWN_CLASS_NAMES = (
    "LDPlayerMainFrame",
    "LDPlayerMainWnd",
    "TheRender",
    "subWin",
    "RenderWindow",
    "Qt5152QWindowIcon",
)
#: Process executables that host an emulator instance.
KNOWN_EXECUTABLES = ("dnplayer.exe", "ldplayer.exe", "dnmultiplayer.exe")
#: Titles: latin, simplified chinese and the ``LDPlayer-<n>`` instance form.
TITLE_PATTERN = re.compile(r"(ldplayer|leidian|雷电模拟器|dnplayer)", re.IGNORECASE)
INSTANCE_INDEX_PATTERN = re.compile(r"[-_ ](\d+)\s*$")


class WindowError(RuntimeError):
    """Raised when a window cannot be queried or no longer exists."""


@dataclass(frozen=True)
class WindowRect:
    """A rectangle in screen coordinates."""

    left: int
    top: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height

    @property
    def size(self) -> tuple[int, int]:
        return self.width, self.height

    @property
    def center(self) -> tuple[int, int]:
        return self.left + self.width // 2, self.top + self.height // 2

    def as_tuple(self) -> tuple[int, int, int, int]:
        return self.left, self.top, self.width, self.height

    def contains(self, x: float, y: float) -> bool:
        return self.left <= x < self.right and self.top <= y < self.bottom

    def inset(self, left: int = 0, top: int = 0, right: int = 0, bottom: int = 0) -> "WindowRect":
        width = max(0, self.width - left - right)
        height = max(0, self.height - top - bottom)
        return WindowRect(self.left + left, self.top + top, width, height)

    def __str__(self) -> str:  # pragma: no cover - diagnostics
        return f"{self.width}x{self.height}@({self.left},{self.top})"


def enable_dpi_awareness() -> None:
    """Make window rectangles match physical pixels on scaled displays."""
    if not IS_WINDOWS:  # pragma: no cover - platform guard
        return
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # pragma: no cover - older Windows
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class WindowBackend(Protocol):
    """Minimal set of operations the engine needs from the window system."""

    def exists(self, handle: int) -> bool: ...
    def window_rect(self, handle: int) -> WindowRect: ...
    def client_rect(self, handle: int) -> WindowRect: ...
    def is_minimized(self, handle: int) -> bool: ...
    def is_foreground(self, handle: int) -> bool: ...
    def activate(self, handle: int) -> bool: ...
    def title(self, handle: int) -> str: ...


class Win32WindowBackend:
    """Real window backend based on ``user32``."""

    def __init__(self) -> None:
        if not IS_WINDOWS:  # pragma: no cover - platform guard
            raise WindowError("The win32 window backend requires Windows")
        import ctypes
        from ctypes import wintypes

        enable_dpi_awareness()
        self._ctypes = ctypes
        self._wintypes = wintypes
        self._user32 = ctypes.windll.user32

    # -- helpers ----------------------------------------------------------
    def _rect(self, handle: int, client: bool) -> WindowRect:  # pragma: no cover - Windows
        ctypes, wintypes = self._ctypes, self._wintypes
        rect = wintypes.RECT()
        if client:
            if not self._user32.GetClientRect(handle, ctypes.byref(rect)):
                raise WindowError(f"GetClientRect failed for handle {handle}")
            point = wintypes.POINT(0, 0)
            if not self._user32.ClientToScreen(handle, ctypes.byref(point)):
                raise WindowError(f"ClientToScreen failed for handle {handle}")
            return WindowRect(point.x, point.y, rect.right - rect.left, rect.bottom - rect.top)
        if not self._user32.GetWindowRect(handle, ctypes.byref(rect)):
            raise WindowError(f"GetWindowRect failed for handle {handle}")
        return WindowRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)

    # -- protocol ---------------------------------------------------------
    def exists(self, handle: int) -> bool:  # pragma: no cover - Windows
        return bool(self._user32.IsWindow(handle))

    def window_rect(self, handle: int) -> WindowRect:  # pragma: no cover - Windows
        return self._rect(handle, client=False)

    def client_rect(self, handle: int) -> WindowRect:  # pragma: no cover - Windows
        return self._rect(handle, client=True)

    def is_minimized(self, handle: int) -> bool:  # pragma: no cover - Windows
        return bool(self._user32.IsIconic(handle))

    def is_foreground(self, handle: int) -> bool:  # pragma: no cover - Windows
        return int(self._user32.GetForegroundWindow()) == int(handle)

    def activate(self, handle: int) -> bool:  # pragma: no cover - Windows
        SW_RESTORE = 9
        if self.is_minimized(handle):
            self._user32.ShowWindow(handle, SW_RESTORE)
        return bool(self._user32.SetForegroundWindow(handle))

    def title(self, handle: int) -> str:  # pragma: no cover - Windows
        ctypes = self._ctypes
        length = self._user32.GetWindowTextLengthW(handle)
        buffer = ctypes.create_unicode_buffer(length + 1)
        self._user32.GetWindowTextW(handle, buffer, length + 1)
        return buffer.value


class StaticWindowBackend:
    """A window backend backed by an in-memory rectangle.

    Used for the manual screen-region mode, for ``--dry-run`` and by the tests,
    which keeps every geometry rule testable without a real emulator.
    """

    def __init__(
        self,
        rect: WindowRect,
        title: str = "Manual region",
        alive: bool = True,
        border: int = 0,
    ) -> None:
        self.rect = rect
        self._title = title
        self.alive = alive
        self.border = border
        self.minimized = False
        self.foreground = True
        self.activations = 0

    def exists(self, handle: int) -> bool:
        return self.alive

    def window_rect(self, handle: int) -> WindowRect:
        return self.rect

    def client_rect(self, handle: int) -> WindowRect:
        if self.border:
            return self.rect.inset(self.border, self.border, self.border, self.border)
        return self.rect

    def is_minimized(self, handle: int) -> bool:
        return self.minimized

    def is_foreground(self, handle: int) -> bool:
        return self.foreground

    def activate(self, handle: int) -> bool:
        self.activations += 1
        self.foreground = True
        return True

    def title(self, handle: int) -> str:
        return self._title

    # -- test / demo helpers ---------------------------------------------
    def move(self, left: int, top: int) -> None:
        self.rect = WindowRect(left, top, self.rect.width, self.rect.height)

    def resize(self, width: int, height: int) -> None:
        self.rect = WindowRect(self.rect.left, self.rect.top, width, height)


@dataclass(frozen=True)
class LDPlayerInstance:
    """A window found during discovery, before it is selected."""

    handle: int
    title: str
    class_name: str = ""
    process_id: int = 0
    executable: str = ""
    rect: WindowRect | None = None
    instance_index: int | None = None

    @property
    def label(self) -> str:
        parts = [self.title or "(untitled)"]
        if self.rect is not None:
            parts.append(str(self.rect))
        parts.append(f"hwnd={self.handle}")
        return "  |  ".join(parts)

    def open(self, log: EventLog | None = None, insets: tuple[int, int, int, int] = (0, 0, 0, 0)):
        return LDPlayerWindow(
            handle=self.handle,
            title=self.title,
            class_name=self.class_name,
            process_id=self.process_id,
            executable=self.executable,
            insets=insets,
            log=log,
        )


class LDPlayerWindow:
    """A selected emulator window whose geometry is refreshed on demand."""

    def __init__(
        self,
        handle: int,
        title: str = "",
        class_name: str = "",
        process_id: int = 0,
        executable: str = "",
        insets: tuple[int, int, int, int] = (0, 0, 0, 0),
        backend: WindowBackend | None = None,
        log: EventLog | None = None,
    ) -> None:
        self.handle = int(handle)
        self.title = title
        self.class_name = class_name
        self.process_id = process_id
        self.executable = executable
        self.insets = tuple(insets)  # type: ignore[assignment]
        self.log = log or get_logger()
        if backend is None:
            backend = Win32WindowBackend() if IS_WINDOWS else StaticWindowBackend(
                WindowRect(0, 0, 0, 0), title=title, alive=False
            )
        self.backend = backend
        self._window_rect = WindowRect(0, 0, 0, 0)
        self._client_rect = WindowRect(0, 0, 0, 0)
        self._alive = True
        self._listeners: list[Callable[["LDPlayerWindow", str], None]] = []
        self.refresh()

    # ------------------------------------------------------------ geometry
    @property
    def window_rect(self) -> WindowRect:
        return self._window_rect

    @property
    def raw_client_rect(self) -> WindowRect:
        return self._client_rect

    @property
    def client_rect(self) -> WindowRect:
        """Client area minus the configured insets: the workable region."""
        left, top, right, bottom = self.insets
        if any(self.insets):
            return self._client_rect.inset(left, top, right, bottom)
        return self._client_rect

    @property
    def client_size(self) -> tuple[int, int]:
        return self.client_rect.size

    def set_insets(self, left: int = 0, top: int = 0, right: int = 0, bottom: int = 0) -> None:
        """Restrict the workable area (e.g. to exclude the LDPlayer side bar)."""
        self.insets = (int(left), int(top), int(right), int(bottom))

    def add_geometry_listener(self, callback: Callable[["LDPlayerWindow", str], None]) -> None:
        self._listeners.append(callback)

    def refresh(self) -> bool:
        """Re-read geometry. Returns ``True`` when it changed since last call."""
        previous_window, previous_client = self._window_rect, self._client_rect
        try:
            if not self.backend.exists(self.handle):
                if self._alive:
                    self.log.warning("The selected LDPlayer window has disappeared")
                self._alive = False
                return False
            self._window_rect = self.backend.window_rect(self.handle)
            self._client_rect = self.backend.client_rect(self.handle)
            self._alive = True
        except WindowError:
            self._alive = False
            return False
        changed = (previous_window, previous_client) != (self._window_rect, self._client_rect)
        if changed and previous_client.size != (0, 0):
            kind = "resized" if previous_client.size != self._client_rect.size else "moved"
            for listener in list(self._listeners):
                try:
                    listener(self, kind)
                except Exception:  # pragma: no cover - listener safety
                    pass
        return changed

    # -------------------------------------------------------------- status
    def is_alive(self) -> bool:
        try:
            self._alive = bool(self.backend.exists(self.handle))
        except WindowError:  # pragma: no cover - defensive
            self._alive = False
        return self._alive

    def is_minimized(self) -> bool:
        try:
            return bool(self.backend.is_minimized(self.handle))
        except WindowError:  # pragma: no cover - defensive
            return False

    def is_foreground(self) -> bool:
        try:
            return bool(self.backend.is_foreground(self.handle))
        except WindowError:  # pragma: no cover - defensive
            return False

    def is_usable(self) -> bool:
        if not self.is_alive() or self.is_minimized():
            return False
        width, height = self.client_size
        return width > 0 and height > 0

    def activate(self) -> bool:
        try:
            return bool(self.backend.activate(self.handle))
        except WindowError:  # pragma: no cover - defensive
            return False

    # --------------------------------------------------------- coordinates
    def client_to_screen(self, x: float, y: float) -> tuple[int, int]:
        rect = self.client_rect
        return int(round(rect.left + x)), int(round(rect.top + y))

    def screen_to_client(self, x: float, y: float) -> tuple[int, int]:
        rect = self.client_rect
        return int(round(x - rect.left)), int(round(y - rect.top))

    def normalized_to_client(self, nx: float, ny: float) -> tuple[int, int]:
        width, height = self.client_size
        return int(round(nx * max(width - 1, 0))), int(round(ny * max(height - 1, 0)))

    def client_to_normalized(self, x: float, y: float) -> tuple[float, float]:
        width, height = self.client_size
        return (x / width if width else 0.0, y / height if height else 0.0)

    def normalized_to_screen(self, nx: float, ny: float) -> tuple[int, int]:
        return self.client_to_screen(*self.normalized_to_client(nx, ny))

    def contains_client_point(self, x: float, y: float) -> bool:
        width, height = self.client_size
        return 0 <= x < width and 0 <= y < height

    # ------------------------------------------------------------ metadata
    @property
    def label(self) -> str:
        return f"{self.title or 'LDPlayer'} [{self.handle}]"

    def describe(self) -> str:
        rect = self.client_rect
        return f"{self.title or 'LDPlayer'} (hwnd={self.handle}, client={rect})"

    def to_dict(self) -> dict[str, Any]:
        return {
            "handle": self.handle,
            "title": self.title,
            "class_name": self.class_name,
            "process_id": self.process_id,
            "executable": self.executable,
            "insets": list(self.insets),
        }

    def __repr__(self) -> str:  # pragma: no cover - diagnostics
        return f"LDPlayerWindow({self.describe()})"


def manual_window(
    left: int,
    top: int,
    width: int,
    height: int,
    title: str = "Manual region",
    log: EventLog | None = None,
) -> LDPlayerWindow:
    """Create a window bound to a fixed screen rectangle.

    Handy when LDPlayer runs on a machine without window enumeration (or for
    trying a workflow against any other window / screen area).
    """
    backend = StaticWindowBackend(WindowRect(left, top, width, height), title=title)
    return LDPlayerWindow(handle=0, title=title, backend=backend, log=log)


def _process_executable(process_id: int) -> str:  # pragma: no cover - Windows only
    if not IS_WINDOWS or not process_id:
        return ""
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, process_id)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ""
    finally:
        kernel32.CloseHandle(handle)


def _matches_ldplayer(title: str, class_name: str, executable: str) -> bool:
    exe_name = executable.rsplit("\\", 1)[-1].lower()
    if exe_name in KNOWN_EXECUTABLES:
        return True
    if class_name in KNOWN_CLASS_NAMES and TITLE_PATTERN.search(title or ""):
        return True
    return bool(TITLE_PATTERN.search(title or ""))


def enumerate_windows(include_all: bool = False) -> list[LDPlayerInstance]:
    """List candidate emulator windows.

    ``include_all`` returns every visible top level window, which lets the user
    pick an instance whose title was customised beyond recognition.
    """
    if not IS_WINDOWS:
        return []
    import ctypes  # pragma: no cover - Windows only
    from ctypes import wintypes

    enable_dpi_awareness()
    user32 = ctypes.windll.user32
    backend = Win32WindowBackend()
    found: list[LDPlayerInstance] = []

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(handle, _param):  # pragma: no cover - Windows only
        if not user32.IsWindowVisible(handle):
            return True
        length = user32.GetWindowTextLengthW(handle)
        title_buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(handle, title_buffer, length + 1)
        title = title_buffer.value
        class_buffer = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(handle, class_buffer, 256)
        class_name = class_buffer.value
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        executable = _process_executable(pid.value)
        if not include_all and not _matches_ldplayer(title, class_name, executable):
            return True
        try:
            rect = backend.client_rect(handle)
        except WindowError:
            return True
        if rect.width < 64 or rect.height < 64:
            return True
        index_match = INSTANCE_INDEX_PATTERN.search(title or "")
        found.append(
            LDPlayerInstance(
                handle=int(handle),
                title=title,
                class_name=class_name,
                process_id=int(pid.value),
                executable=executable,
                rect=rect,
                instance_index=int(index_match.group(1)) if index_match else None,
            )
        )
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    found.sort(key=lambda item: (item.instance_index if item.instance_index is not None else 0, item.title))
    return found


def find_instance(
    query: str | int | None = None, instances: Iterable[LDPlayerInstance] | None = None
) -> LDPlayerInstance | None:
    """Find an instance by handle, index or (partial) title."""
    candidates = list(instances if instances is not None else enumerate_windows())
    if not candidates:
        return None
    if query is None or query == "":
        return candidates[0]
    if isinstance(query, int) or str(query).isdigit():
        value = int(query)
        for item in candidates:
            if item.handle == value or item.instance_index == value:
                return item
        if 0 <= value < len(candidates):
            return candidates[value]
        return None
    needle = str(query).lower()
    for item in candidates:
        if needle in item.title.lower():
            return item
    return None
