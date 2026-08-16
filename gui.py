"""Tkinter front end: visual scenario editor, live log and engine control.

Layout::

    toolbar        project, LDPlayer instance, engine mode, START/PAUSE/STOP
    left           states (with their reference images) and detection test
    centre         the workflow as a diagram, with the ADD ... buttons
    right          details of the selection and validation warnings
    bottom         live log
    status bar     engine state, detected state, confidence, frames

The engine always runs in a worker thread; the GUI only reads from a queue, so a
long recognition step can never freeze the window.  Frames used for the preview
are converted in memory and dropped immediately - nothing is written to disk.
"""

from __future__ import annotations

import os
import queue
import threading
import time
import tkinter as tk
from dataclasses import dataclass, field
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any, Callable, Sequence

import numpy as np

import ldplayer
from i18n import (
    available_languages,
    get_language,
    language_code,
    language_label,
    set_language,
    tr,
)
from recorder import ActionRecorder, RecorderSettings, create_listener
from actions import (
    ACTION_TYPES,
    Action,
    Target,
    TargetMode,
    action_from_dict,
)
from conditions import CONDITION_TYPES, Condition, condition_from_dict, describe_condition
from keyboard import HotkeyManager, install_safety_hotkeys
from logger import EventLog, LogLevel, LogRecord, get_logger
from pipeline import (
    AUTH_ERROR,
    AUTH_MACRO,
    AUTH_SUCCESS,
    MACRO2_ERROR,
    MACRO2_SUCCESS,
    RESET_MACRO,
    SECOND_MACRO,
    bind_typed_text_to_test_data,
)
from project import Project, ProjectError, example_project
from safety import RunState, SafetyController
from screen_capture import CaptureError, WindowCapture, create_backend, looks_blank
from state_machine import (
    AnalysisContext,
    EngineState,
    ReferenceSpec,
    StateMachineRunner,
    UNKNOWN_STATE,
    VisualState,
    create_context,
)
from vision import PixelRect, Roi, crop_copy
from workflow import (
    Branch,
    NodeType,
    Workflow,
    WorkflowNode,
    WorkflowRunner,
    make_node,
    outline_rows,
)

PALETTE = {
    "bg": "#0d0d0d",
    "panel": "#111111",
    "panel_light": "#1a1a1a",
    "border": "#2a2a2a",
    "text": "#e8e8e8",
    "muted": "#9a9a9a",
    "accent": "#f5c518",
    "title": "#f5c518",
    "success": "#1e8a4a",
    "success_active": "#259d56",
    "warning": "#f5c518",
    "error": "#e74c3c",
    "select": "#3a3110",
    "danger": "#7a1f1f",
    "danger_active": "#9a2828",
}

LEVEL_COLORS = {
    LogLevel.DEBUG: PALETTE["muted"],
    LogLevel.INFO: PALETTE["text"],
    LogLevel.SUCCESS: "#3ecf8e",
    LogLevel.WARNING: PALETTE["warning"],
    LogLevel.ERROR: PALETTE["error"],
}

NODE_COLORS = {
    NodeType.ANALYZE: "#1a334d",
    NodeType.IF: "#2e2448",
    NodeType.ACTION: "#143d2e",
    NodeType.VERIFY: "#3d3614",
    NodeType.WAIT: "#22262e",
    NodeType.RETRY: "#3d2418",
    NodeType.LOOP: "#143d3d",
    NodeType.STOP: "#3d1818",
    NodeType.STATE: "#1a2848",
    NodeType.MACRO: "#1e4d2e",
}

UI_FONT = "Segoe UI" if os.name == "nt" else "Noto Sans"
MONO_FONT = "Consolas" if os.name == "nt" else "DejaVu Sans Mono"


def ui_font(size: int = 10, weight: str = "normal") -> tuple[str, int] | tuple[str, int, str]:
    if weight == "normal":
        return (UI_FONT, size)
    return (UI_FONT, size, weight)


def apply_theme(root: tk.Misc) -> None:
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:  # pragma: no cover - platform dependent
        pass
    style.configure(".", background=PALETTE["panel"], foreground=PALETTE["text"],
                    fieldbackground=PALETTE["panel_light"], bordercolor=PALETTE["border"],
                    font=ui_font())
    style.configure("TFrame", background=PALETTE["panel"])
    style.configure("Toolbar.TFrame", background=PALETTE["bg"])
    style.configure("TLabel", background=PALETTE["panel"], foreground=PALETTE["text"],
                    font=ui_font())
    style.configure("Muted.TLabel", foreground=PALETTE["muted"], background=PALETTE["panel"])
    style.configure("Heading.TLabel", font=ui_font(10, "bold"), foreground=PALETTE["title"],
                    background=PALETTE["panel"])
    style.configure("Title.TLabel", font=ui_font(18, "bold"), foreground=PALETTE["title"],
                    background=PALETTE["bg"])
    style.configure("TButton", background=PALETTE["panel_light"], foreground=PALETTE["text"],
                    borderwidth=0, padding=(10, 5), font=ui_font(9), relief="flat")
    style.map("TButton", background=[("active", PALETTE["border"]), ("pressed", PALETTE["border"])],
              foreground=[("disabled", PALETTE["muted"])])
    style.configure("Accent.TButton", background=PALETTE["accent"], foreground="#111111",
                    padding=(12, 6), font=ui_font(9, "bold"))
    style.map("Accent.TButton",
              background=[("active", "#ffd84d"), ("pressed", "#d4a90f")],
              foreground=[("active", "#111111"), ("disabled", "#555555")])
    style.configure("Success.TButton", background=PALETTE["success"], foreground="#ffffff",
                    padding=(16, 9), font=ui_font(10, "bold"))
    style.map("Success.TButton",
              background=[("active", PALETTE["success_active"]), ("pressed", "#165a30")],
              foreground=[("disabled", "#bbbbbb")])
    style.configure("Danger.TButton", background=PALETTE["danger"], foreground="#ffffff",
                    padding=(10, 5), font=ui_font(9, "bold"))
    style.map("Danger.TButton",
              background=[("active", PALETTE["danger_active"]), ("pressed", "#5a1515")],
              foreground=[("disabled", "#bbbbbb")])
    style.configure("TEntry", fieldbackground=PALETTE["panel_light"], foreground=PALETTE["text"],
                    insertcolor=PALETTE["text"], bordercolor=PALETTE["border"],
                    lightcolor=PALETTE["border"], darkcolor=PALETTE["border"])
    style.configure("TCombobox", fieldbackground=PALETTE["panel_light"], foreground=PALETTE["text"],
                    arrowcolor=PALETTE["text"], selectbackground=PALETTE["panel_light"],
                    selectforeground=PALETTE["text"], bordercolor=PALETTE["border"],
                    lightcolor=PALETTE["border"], darkcolor=PALETTE["border"])
    # ttk keeps a separate colour set for the readonly state, which the engine
    # mode / level pickers use; without this they render as empty boxes.
    style.map(
        "TCombobox",
        fieldbackground=[("readonly", PALETTE["panel_light"]), ("disabled", PALETTE["panel"])],
        foreground=[("readonly", PALETTE["text"]), ("disabled", PALETTE["muted"])],
        selectbackground=[("readonly", PALETTE["panel_light"])],
        selectforeground=[("readonly", PALETTE["text"])],
    )
    root.option_add("*TCombobox*Listbox.background", PALETTE["panel_light"])
    root.option_add("*TCombobox*Listbox.foreground", PALETTE["text"])
    root.option_add("*TCombobox*Listbox.selectBackground", PALETTE["select"])
    style.configure("TCheckbutton", background=PALETTE["panel"], foreground=PALETTE["text"],
                    font=ui_font())
    style.map("TCheckbutton", background=[("active", PALETTE["panel"])],
              foreground=[("disabled", PALETTE["muted"])])
    style.configure("Toolbar.TCheckbutton", background=PALETTE["bg"], foreground=PALETTE["text"],
                    font=ui_font())
    style.map("Toolbar.TCheckbutton", background=[("active", PALETTE["bg"])])
    style.configure("Toolbar.TLabel", background=PALETTE["bg"], foreground=PALETTE["text"])
    style.configure("MutedToolbar.TLabel", background=PALETTE["bg"], foreground=PALETTE["muted"])
    style.configure("TNotebook", background=PALETTE["panel"], borderwidth=0)
    style.configure("TNotebook.Tab", background=PALETTE["panel_light"], foreground=PALETTE["muted"],
                    padding=(12, 6), font=ui_font(9, "bold"))
    style.map("TNotebook.Tab", background=[("selected", PALETTE["panel"])],
              foreground=[("selected", PALETTE["title"])])
    style.configure("Treeview", background=PALETTE["panel_light"], fieldbackground=PALETTE["panel_light"],
                    foreground=PALETTE["text"], borderwidth=0, rowheight=24, font=ui_font(9))
    style.map("Treeview", background=[("selected", PALETTE["select"])],
              foreground=[("selected", PALETTE["title"])])
    style.configure("Treeview.Heading", background=PALETTE["bg"], foreground=PALETTE["title"],
                    font=ui_font(9, "bold"), relief="flat")
    style.map("Treeview.Heading", background=[("active", PALETTE["panel_light"])],
              foreground=[("active", PALETTE["title"])])
    style.configure("TSeparator", background=PALETTE["border"])
    style.configure("TScrollbar", background=PALETTE["panel_light"], troughcolor=PALETTE["bg"],
                    bordercolor=PALETTE["bg"], arrowcolor=PALETTE["muted"])


# --------------------------------------------------------------------------- #
# small reusable dialogs
# --------------------------------------------------------------------------- #
@dataclass
class Field:
    """One row of a generated form."""

    key: str
    label: str
    kind: str = "str"          # str|int|float|bool|choice|text|roi|target|color|secret
    choices: Sequence[str] = ()
    default: Any = None
    hint: str = ""


class FormDialog(tk.Toplevel):
    """Modal dialog generated from a list of :class:`Field` descriptions."""

    def __init__(
        self,
        parent: tk.Misc,
        title: str,
        fields: Sequence[Field],
        values: dict[str, Any] | None = None,
        context_provider: "App | None" = None,
    ) -> None:
        super().__init__(parent)
        self.title(title)
        self.configure(background=PALETTE["panel"])
        self.resizable(False, False)
        self.transient(parent)
        self.result: dict[str, Any] | None = None
        self._fields = list(fields)
        self._vars: dict[str, Any] = {}
        self._roi: dict[str, Roi] = {}
        self._app = context_provider
        body = ttk.Frame(self, padding=12)
        body.pack(fill="both", expand=True)
        values = dict(values or {})
        for row, spec in enumerate(self._fields):
            ttk.Label(body, text=spec.label).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 10))
            value = values.get(spec.key, spec.default)
            widget = self._build_widget(body, spec, value)
            widget.grid(row=row, column=1, sticky="ew", pady=4)
            if spec.hint:
                ttk.Label(body, text=spec.hint, style="Muted.TLabel").grid(
                    row=row, column=2, sticky="w", padx=(8, 0)
                )
        body.columnconfigure(1, weight=1)
        buttons = ttk.Frame(self, padding=(12, 0, 12, 12))
        buttons.pack(fill="x")
        ttk.Button(buttons, text=tr('Cancel'), command=self._cancel).pack(side="right")
        ttk.Button(buttons, text=tr('OK'), style="Accent.TButton", command=self._accept).pack(
            side="right", padx=(0, 8)
        )
        self.bind("<Return>", lambda _event: self._accept())
        self.bind("<Escape>", lambda _event: self._cancel())
        self.grab_set()
        self.wait_visibility()
        self.focus_set()

    # ------------------------------------------------------------- widgets
    def _build_widget(self, parent: tk.Misc, spec: Field, value: Any) -> tk.Widget:
        if spec.kind == "bool":
            variable = tk.BooleanVar(value=bool(value))
            self._vars[spec.key] = variable
            return ttk.Checkbutton(parent, variable=variable)
        if spec.kind == "choice":
            variable = tk.StringVar(value="" if value is None else str(value))
            self._vars[spec.key] = variable
            return ttk.Combobox(parent, textvariable=variable, values=list(spec.choices),
                                state="readonly" if spec.choices else "normal", width=28)
        if spec.kind == "text":
            widget = tk.Text(parent, height=4, width=30, background=PALETTE["panel_light"],
                             foreground=PALETTE["text"], insertbackground=PALETTE["text"],
                             borderwidth=0)
            widget.insert("1.0", "" if value is None else str(value))
            self._vars[spec.key] = widget
            return widget
        if spec.kind == "roi":
            roi = value if isinstance(value, Roi) else Roi.from_dict(value)
            self._roi[spec.key] = roi
            frame = ttk.Frame(parent)
            label = ttk.Label(frame, text=roi.describe(), style="Muted.TLabel")
            label.pack(side="left")

            def edit_roi(key: str = spec.key, label: ttk.Label = label) -> None:
                new_roi = ask_roi(self, self._roi[key], self._app)
                if new_roi is not None:
                    self._roi[key] = new_roi
                    label.configure(text=new_roi.describe())

            ttk.Button(frame, text=tr('Region...'), command=edit_roi).pack(side="right")
            return frame
        variable = tk.StringVar(value="" if value is None else str(value))
        self._vars[spec.key] = variable
        show = "*" if spec.kind == "secret" else ""
        return ttk.Entry(parent, textvariable=variable, width=30, show=show)

    # -------------------------------------------------------------- result
    def _collect(self) -> dict[str, Any]:
        values: dict[str, Any] = {}
        for spec in self._fields:
            if spec.kind == "roi":
                values[spec.key] = self._roi[spec.key]
                continue
            holder = self._vars[spec.key]
            if spec.kind == "bool":
                values[spec.key] = bool(holder.get())
            elif spec.kind == "text":
                values[spec.key] = holder.get("1.0", "end").rstrip("\n")
            else:
                raw = holder.get().strip()
                if spec.kind == "int":
                    values[spec.key] = int(float(raw)) if raw else 0
                elif spec.kind == "float":
                    values[spec.key] = float(raw) if raw else None
                else:
                    values[spec.key] = raw
        return values

    def _accept(self) -> None:
        try:
            self.result = self._collect()
        except ValueError as exc:
            messagebox.showerror(tr('Invalid value'), str(exc), parent=self)
            return
        self.destroy()

    def _cancel(self) -> None:
        self.result = None
        self.destroy()

    @classmethod
    def ask(
        cls, parent: tk.Misc, title: str, fields: Sequence[Field],
        values: dict[str, Any] | None = None, app: "App | None" = None,
    ) -> dict[str, Any] | None:
        dialog = cls(parent, title, fields, values, app)
        parent.wait_window(dialog)
        return dialog.result


class RegionSelector(tk.Toplevel):
    """Shows the current frame (from RAM) and lets the user drag a rectangle."""

    def __init__(self, parent: tk.Misc, image: np.ndarray, title: str = "Select a region") -> None:
        super().__init__(parent)
        self.title(title)
        self.configure(background=PALETTE["bg"])
        self.transient(parent)
        self.result: PixelRect | None = None
        self.frame_size = (image.shape[1], image.shape[0])
        self._photo = to_photo_image(image, max_size=(900, 700))
        self._scale = self._photo.width() / image.shape[1]
        self.canvas = tk.Canvas(
            self, width=self._photo.width(), height=self._photo.height(),
            highlightthickness=0, background=PALETTE["bg"],
        )
        self.canvas.pack(padx=8, pady=8)
        self.canvas.create_image(0, 0, anchor="nw", image=self._photo)
        if looks_blank(image):
            ttk.Label(
                self,
                text=tr(
                    "The frame is black: LDPlayer is covered or GPU capture failed. "
                    "Move this window aside, uncover the emulator, then try again. "
                    "Engine settings → Capture backend → mss."
                ),
                style="Heading.TLabel",
                wraplength=max(360, self._photo.width() - 16),
            ).pack(padx=8, pady=(0, 4))
        ttk.Label(
            self, text=tr('Drag to select. The frame is only shown, never saved.'),
            style="Muted.TLabel",
        ).pack(pady=(0, 4))
        buttons = ttk.Frame(self, padding=(8, 0, 8, 8))
        buttons.pack(fill="x")
        ttk.Button(buttons, text=tr('Cancel'), command=self._cancel).pack(side="right")
        ttk.Button(buttons, text=tr('Use selection'), style="Accent.TButton",
                   command=self._accept).pack(side="right", padx=(0, 8))
        ttk.Button(buttons, text=tr('Whole screen'), command=self._select_all).pack(side="left")
        self._start: tuple[int, int] | None = None
        self._rectangle = None
        self.canvas.bind("<ButtonPress-1>", self._on_press)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.bind("<Escape>", lambda _event: self._cancel())
        self.grab_set()

    def _on_press(self, event: tk.Event) -> None:
        self._start = (event.x, event.y)
        if self._rectangle is not None:
            self.canvas.delete(self._rectangle)
        self._rectangle = self.canvas.create_rectangle(
            event.x, event.y, event.x, event.y, outline=PALETTE["accent"], width=2
        )

    def _on_drag(self, event: tk.Event) -> None:
        if self._start is None or self._rectangle is None:
            return
        self.canvas.coords(self._rectangle, self._start[0], self._start[1], event.x, event.y)

    def _selection(self) -> PixelRect | None:
        if self._rectangle is None:
            return None
        x1, y1, x2, y2 = (int(value) for value in self.canvas.coords(self._rectangle))
        left, right = sorted((x1, x2))
        top, bottom = sorted((y1, y2))
        width, height = right - left, bottom - top
        if width < 4 or height < 4:
            return None
        return PixelRect(
            int(left / self._scale), int(top / self._scale),
            int(width / self._scale), int(height / self._scale),
        )

    def _select_all(self) -> None:
        self.result = PixelRect(0, 0, self.frame_size[0], self.frame_size[1])
        self.destroy()

    def _accept(self) -> None:
        selection = self._selection()
        if selection is None:
            messagebox.showinfo(tr('No selection'), tr('Drag a rectangle first.'), parent=self)
            return
        self.result = selection
        self.destroy()

    def _cancel(self) -> None:
        self.result = None
        self.destroy()


def pillow_available() -> bool:
    """Pillow is only needed to show frames in the editor, so it stays optional."""
    try:
        import PIL.ImageTk  # noqa: F401
    except Exception:
        return False
    return True


def to_photo_image(image: np.ndarray, max_size: tuple[int, int] = (400, 400)):
    """Convert a BGR frame to a Tk image in memory (never touches the disk)."""
    from PIL import Image, ImageTk

    height, width = image.shape[:2]
    scale = min(max_size[0] / width, max_size[1] / height, 1.0)
    rgb = image[:, :, ::-1]
    picture = Image.fromarray(rgb)
    if scale < 1.0:
        picture = picture.resize((max(1, int(width * scale)), max(1, int(height * scale))))
    return ImageTk.PhotoImage(picture)


def ask_roi(parent: tk.Misc, roi: Roi, app: "App | None") -> Roi | None:
    """Edit a region either numerically or by dragging on the current frame."""
    if app is not None and pillow_available() and messagebox.askyesno(
        tr('Select region'),
        tr('Select the region on the current LDPlayer screen?\nChoose No to type the values manually.'),
        parent=parent,
    ):
        frame = app.grab_preview_frame()
        if frame is None:
            return None
        selector = RegionSelector(parent, frame)
        parent.wait_window(selector)
        if selector.result is None:
            return None
        return Roi.from_pixels(selector.result, *selector.frame_size)
    values = FormDialog.ask(
        parent,
        "Region of interest (0..1)",
        [
            Field("x", tr('X'), "float", default=roi.x),
            Field("y", tr('Y'), "float", default=roi.y),
            Field("width", tr('Width'), "float", default=roi.width),
            Field("height", tr('Height'), "float", default=roi.height),
        ],
    )
    if values is None:
        return None
    return Roi(
        float(values["x"] or 0.0), float(values["y"] or 0.0),
        float(values["width"] or 1.0), float(values["height"] or 1.0),
    ).clamped()


# --------------------------------------------------------------------------- #
# condition / action / target editors
# --------------------------------------------------------------------------- #
def condition_fields(kind: str, app: "App") -> list[Field]:
    states = app.project.state_names()
    references = app.project.reference_names()
    common_roi = Field("roi", tr('Region'), "roi", default=Roi.full())
    return {
        "always": [Field("value", tr('Value is true'), "bool", default=True)],
        "state_is": [
            Field("state", tr('State'), "choice", states),
            Field("min_confidence", tr('Minimum confidence'), "float", hint="empty = state default"),
        ],
        "reference_visible": [
            Field("reference", tr('Reference image'), "choice", references),
            Field("threshold", tr('Confidence'), "float", default=0.85),
            common_roi,
            Field("grayscale", tr('Grayscale'), "bool", default=True),
            Field("match_mode", tr('Match mode'), "choice", ("template", "feature", "histogram"),
                  default="template"),
        ],
        "text_visible": [
            Field("text", tr('Text'), "str"),
            common_roi,
            Field("min_confidence", tr('OCR confidence'), "float", default=0.6),
            Field("regex", tr('Regular expression'), "bool", default=False),
            Field("ignore_case", tr('Ignore case'), "bool", default=True),
            Field("whole_line", tr('Whole line'), "bool", default=False),
        ],
        "number_compare": [
            Field("operator", tr('Operator'), "choice", ("==", "!=", ">", ">=", "<", "<="), default=">="),
            Field("value", tr('Value'), "float", default=0.0),
            common_roi,
            Field("index", tr('Number index'), "int", default=0),
            Field("min_confidence", tr('OCR confidence'), "float", default=0.6),
        ],
        "color_at": [
            Field("x", tr('X (0..1)'), "float", default=0.5),
            Field("y", tr('Y (0..1)'), "float", default=0.5),
            Field("color", tr('Colour B,G,R'), "str", default="255,255,255"),
            Field("tolerance", tr('Tolerance (0..1)'), "float", default=0.08),
        ],
        "color_present": [
            Field("color", tr('Colour B,G,R'), "str", default="0,200,0"),
            Field("tolerance", tr('Tolerance (0..255)'), "int", default=30),
            common_roi,
            Field("min_coverage", tr('Minimum coverage'), "float", default=0.05),
        ],
        "screen_changed": [Field("threshold", tr('Difference threshold'), "float", default=0.02)],
        "variable_compare": [
            Field("name", tr('Variable'), "str"),
            Field("operator", tr('Operator'), "choice",
                  ("==", "!=", ">", ">=", "<", "<=", "contains", "not_contains"), default="=="),
            Field("value", tr('Value'), "str"),
        ],
    }.get(kind, [])


def parse_color(text: Any, fallback: tuple[int, int, int]) -> list[int]:
    try:
        parts = [int(float(part)) for part in str(text).replace(";", ",").split(",")]
        if len(parts) == 3:
            return [max(0, min(255, value)) for value in parts]
    except (TypeError, ValueError):
        pass
    return list(fallback)


class ConditionEditor(tk.Toplevel):
    """Builds a condition, including nested AND / OR / NOT trees."""

    COMPOSITE = ("not", "all_of", "any_of")

    def __init__(self, parent: tk.Misc, app: "App", condition: Condition | None = None) -> None:
        super().__init__(parent)
        self.title(tr('Condition'))
        self.configure(background=PALETTE["panel"])
        self.transient(parent)
        self.app = app
        self.result: Condition | None = None
        self._children: list[Condition] = []
        labels = {kind: tr(cls.label) for kind, cls in CONDITION_TYPES.items()}
        self._kinds = list(labels)
        current = condition.kind if condition is not None else "state_is"
        body = ttk.Frame(self, padding=12)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text=tr('Type')).grid(row=0, column=0, sticky="w", pady=4)
        self._kind = tk.StringVar(value=labels.get(current, current))
        combo = ttk.Combobox(body, textvariable=self._kind, state="readonly",
                             values=[labels[kind] for kind in self._kinds], width=30)
        combo.grid(row=0, column=1, sticky="ew", pady=4)
        combo.bind("<<ComboboxSelected>>", lambda _event: self._rebuild())
        self._holder = ttk.Frame(body)
        self._holder.grid(row=1, column=0, columnspan=2, sticky="nsew", pady=(8, 0))
        body.columnconfigure(1, weight=1)
        buttons = ttk.Frame(self, padding=(12, 0, 12, 12))
        buttons.pack(fill="x")
        ttk.Button(buttons, text=tr('Cancel'), command=self._cancel).pack(side="right")
        ttk.Button(buttons, text=tr('OK'), style="Accent.TButton", command=self._accept).pack(
            side="right", padx=(0, 8)
        )
        self._labels = labels
        self._initial = condition
        self._rebuild()
        self.grab_set()

    # ------------------------------------------------------------ internals
    def _selected_kind(self) -> str:
        for kind, label in self._labels.items():
            if label == self._kind.get():
                return kind
        return "always"

    def _rebuild(self) -> None:
        for child in self._holder.winfo_children():
            child.destroy()
        kind = self._selected_kind()
        payload: dict[str, Any] = {}
        if self._initial is not None and self._initial.kind == kind:
            payload = self._initial.to_dict()
            if kind == "not" and payload.get("condition"):
                self._children = [condition_from_dict(payload["condition"])]
            elif kind in ("all_of", "any_of"):
                self._children = [condition_from_dict(item) for item in payload.get("conditions", [])]
        if kind in self.COMPOSITE:
            self._build_composite(kind)
            return
        self._form_vars: dict[str, Any] = {}
        self._form_roi: dict[str, Roi] = {}
        fields = condition_fields(kind, self.app)
        for row, spec in enumerate(fields):
            ttk.Label(self._holder, text=spec.label).grid(row=row, column=0, sticky="w", pady=3)
            value = payload.get(spec.key, spec.default)
            if spec.kind == "roi":
                roi = Roi.from_dict(value) if isinstance(value, dict) else (value or Roi.full())
                self._form_roi[spec.key] = roi
                frame = ttk.Frame(self._holder)
                label = ttk.Label(frame, text=roi.describe(), style="Muted.TLabel")
                label.pack(side="left")

                def edit(key: str = spec.key, label: ttk.Label = label) -> None:
                    new_roi = ask_roi(self, self._form_roi[key], self.app)
                    if new_roi is not None:
                        self._form_roi[key] = new_roi
                        label.configure(text=new_roi.describe())

                ttk.Button(frame, text=tr('Region...'), command=edit).pack(side="right")
                frame.grid(row=row, column=1, sticky="ew", pady=3)
                continue
            if spec.key == "color" and isinstance(value, list):
                value = ",".join(str(item) for item in value)
            if spec.kind == "bool":
                variable: Any = tk.BooleanVar(value=bool(value))
                widget: tk.Widget = ttk.Checkbutton(self._holder, variable=variable)
            elif spec.kind == "choice":
                variable = tk.StringVar(value="" if value is None else str(value))
                widget = ttk.Combobox(self._holder, textvariable=variable, values=list(spec.choices),
                                      state="readonly" if spec.choices else "normal", width=28)
            else:
                variable = tk.StringVar(value="" if value is None else str(value))
                widget = ttk.Entry(self._holder, textvariable=variable, width=30)
            widget.grid(row=row, column=1, sticky="ew", pady=3)
            if spec.hint:
                ttk.Label(self._holder, text=spec.hint, style="Muted.TLabel").grid(
                    row=row, column=2, sticky="w", padx=(6, 0)
                )
            self._form_vars[spec.key] = (spec, variable)
        self._holder.columnconfigure(1, weight=1)

    def _build_composite(self, kind: str) -> None:
        limit = 1 if kind == "not" else 99
        ttk.Label(
            self._holder,
            text="NOT inverts one condition" if kind == "not" else "Sub-conditions",
            style="Muted.TLabel",
        ).pack(anchor="w")
        listbox = tk.Listbox(self._holder, height=6, background=PALETTE["panel_light"],
                            foreground=PALETTE["text"], borderwidth=0, activestyle="none")
        listbox.pack(fill="both", expand=True, pady=6)

        def refresh() -> None:
            listbox.delete(0, "end")
            for child in self._children:
                listbox.insert("end", child.describe())

        def add() -> None:
            if len(self._children) >= limit:
                messagebox.showinfo(tr('Limit'), tr('NOT takes a single condition.'), parent=self)
                return
            child = ConditionEditor.ask(self, self.app)
            if child is not None:
                self._children.append(child)
                refresh()

        def edit() -> None:
            selection = listbox.curselection()
            if not selection:
                return
            index = selection[0]
            child = ConditionEditor.ask(self, self.app, self._children[index])
            if child is not None:
                self._children[index] = child
                refresh()

        def remove() -> None:
            selection = listbox.curselection()
            if selection:
                self._children.pop(selection[0])
                refresh()

        row = ttk.Frame(self._holder)
        row.pack(fill="x")
        ttk.Button(row, text=tr('Add'), command=add).pack(side="left")
        ttk.Button(row, text=tr('Edit'), command=edit).pack(side="left", padx=4)
        ttk.Button(row, text=tr('Remove'), command=remove).pack(side="left")
        refresh()

    def _accept(self) -> None:
        kind = self._selected_kind()
        if kind == "not":
            if not self._children:
                messagebox.showerror(tr('Missing condition'), tr('NOT needs one condition.'), parent=self)
                return
            payload = {"kind": kind, "condition": self._children[0].to_dict()}
        elif kind in ("all_of", "any_of"):
            payload = {"kind": kind, "conditions": [child.to_dict() for child in self._children]}
        else:
            payload = {"kind": kind}
            for key, (spec, variable) in self._form_vars.items():
                raw = variable.get()
                try:
                    if spec.kind == "bool":
                        payload[key] = bool(raw)
                    elif spec.kind == "int":
                        payload[key] = int(float(raw)) if str(raw).strip() else 0
                    elif spec.kind == "float":
                        payload[key] = float(raw) if str(raw).strip() else None
                    elif key == "color":
                        payload[key] = parse_color(raw, (255, 255, 255))
                    else:
                        payload[key] = str(raw)
                except ValueError:
                    messagebox.showerror(tr('Invalid value'), f"{spec.label} is not a number.", parent=self)
                    return
            for key, roi in self._form_roi.items():
                payload[key] = roi.to_dict()
            if payload.get("min_confidence") is None and kind != "state_is":
                payload.pop("min_confidence", None)
        try:
            self.result = condition_from_dict(payload)
        except Exception as exc:
            messagebox.showerror(tr('Invalid condition'), str(exc), parent=self)
            return
        self.destroy()

    def _cancel(self) -> None:
        self.result = None
        self.destroy()

    @classmethod
    def ask(cls, parent: tk.Misc, app: "App", condition: Condition | None = None) -> Condition | None:
        dialog = cls(parent, app, condition)
        parent.wait_window(dialog)
        return dialog.result


def target_fields(app: "App") -> list[Field]:
    return [
        Field("mode", tr('Target'), "choice", tuple(mode.value for mode in TargetMode), default="window"),
        Field("x", tr('X (0..1 or px)'), "float", default=0.5),
        Field("y", tr('Y (0..1 or px)'), "float", default=0.5),
        Field("units", tr('Units'), "choice", ("normalized", "pixels"), default="normalized"),
        Field("reference", tr('Reference image'), "choice", app.project.reference_names()),
        Field("text", tr('Text to find'), "str"),
        Field("state", tr('State'), "choice", app.project.state_names()),
        Field("roi", tr('Search region'), "roi", default=Roi.full()),
        Field("threshold", tr('Confidence'), "float", default=0.85),
        Field("offset_x", tr('Offset X (px)'), "int", default=0),
        Field("offset_y", tr('Offset Y (px)'), "int", default=0),
        Field("anchor", tr('Anchor'), "choice", ("center", "topleft"), default="center"),
    ]


def action_fields(kind: str, app: "App") -> list[Field]:
    pointer = [
        Field("cooldown", tr('Cooldown (s)'), "float", hint="empty = default"),
        Field("require_confidence", tr('Required confidence'), "float", hint="empty = target default"),
    ]
    return {
        "move_mouse": pointer,
        "left_click": pointer,
        "double_click": pointer,
        "right_click": pointer,
        "drag": [*pointer, Field("duration", tr('Duration (s)'), "float", default=0.4)],
        "press_key": [
            Field("key", tr('Key'), "str", default="enter"),
            Field("presses", tr('Presses'), "int", default=1),
            Field("interval", tr('Interval (s)'), "float", default=0.05),
        ],
        "hotkey": [Field("combination", tr('Combination'), "str", default="ctrl+a")],
        "type_text": [
            Field("text", tr('Text'), "str"),
            Field("sensitive", tr('Sensitive (never logged)'), "bool", default=False),
            Field("variable", tr('Read from variable'), "str", hint="optional"),
            Field("interval", tr('Interval (s)'), "float", default=0.02),
            Field("clear_first", tr('Clear the field first'), "bool", default=False),
        ],
        "wait": [
            Field("seconds", tr('Seconds'), "float", default=1.0),
            Field("jitter", tr('Random extra (s)'), "float", default=0.0),
        ],
        "wait_until": [
            Field("timeout", tr('Timeout (s)'), "float", default=10.0),
            Field("poll", tr('Check every (s)'), "float", default=0.5),
            Field("expect", tr('Wait for true'), "bool", default=True),
        ],
        "verify": [
            Field("expected_state", tr('Expected state'), "choice", app.project.state_names()),
            Field("timeout", tr('Timeout (s)'), "float", default=5.0),
            Field("poll", tr('Check every (s)'), "float", default=0.4),
        ],
        "repeat": [
            Field("times", tr('Times'), "int", default=2),
            Field("delay", tr('Delay (s)'), "float", default=0.2),
            Field("stop_on_failure", tr('Stop on failure'), "bool", default=True),
        ],
        "stop": [Field("reason", tr('Reason'), "str", default="workflow requested stop")],
        "set_variable": [
            Field("name", tr('Variable'), "str", default="counter"),
            Field("value", tr('Value'), "str", default="0"),
            Field("mode", tr('Mode'), "choice",
                  ("set", "increment", "from_number", "from_text", "from_state"), default="set"),
        ],
        "log": [
            Field("message", tr('Message'), "str"),
            Field("level", tr('Level'), "choice", ("DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR"),
                  default="INFO"),
        ],
    }.get(kind, [])


POINTER_ACTIONS = ("move_mouse", "left_click", "double_click", "right_click", "drag")
CONDITION_ACTIONS = ("wait_until",)
NESTED_ACTIONS = ("repeat",)


class ActionEditor(tk.Toplevel):
    """Builds one action, including its target, condition or sub-actions."""

    def __init__(self, parent: tk.Misc, app: "App", action: Action | None = None) -> None:
        super().__init__(parent)
        self.title(tr('Action'))
        self.configure(background=PALETTE["panel"])
        self.transient(parent)
        self.app = app
        self.result: Action | None = None
        self._labels = {kind: tr(cls.label) for kind, cls in ACTION_TYPES.items()}
        self._initial = action
        self._target = Target()
        self._end_target = Target(mode=TargetMode.WINDOW, x=0.5, y=0.2)
        self._condition: Condition | None = None
        self._sub_actions: list[Action] = []
        if action is not None:
            payload = action.to_dict()
            if payload.get("target"):
                self._target = Target.from_dict(payload["target"])
            if payload.get("end"):
                self._end_target = Target.from_dict(payload["end"])
            if payload.get("condition"):
                self._condition = condition_from_dict(payload["condition"])
            if payload.get("actions"):
                self._sub_actions = [action_from_dict(item) for item in payload["actions"]]
        body = ttk.Frame(self, padding=12)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text=tr('Type')).grid(row=0, column=0, sticky="w", pady=4)
        current = action.kind if action is not None else "left_click"
        self._kind = tk.StringVar(value=self._labels.get(current, current))
        combo = ttk.Combobox(body, textvariable=self._kind, state="readonly",
                             values=list(self._labels.values()), width=30)
        combo.grid(row=0, column=1, sticky="ew", pady=4)
        combo.bind("<<ComboboxSelected>>", lambda _event: self._rebuild())
        self._holder = ttk.Frame(body)
        self._holder.grid(row=1, column=0, columnspan=2, sticky="nsew", pady=(8, 0))
        body.columnconfigure(1, weight=1)
        buttons = ttk.Frame(self, padding=(12, 0, 12, 12))
        buttons.pack(fill="x")
        ttk.Button(buttons, text=tr('Cancel'), command=self._cancel).pack(side="right")
        ttk.Button(buttons, text=tr('OK'), style="Accent.TButton", command=self._accept).pack(
            side="right", padx=(0, 8)
        )
        self._rebuild()
        self.grab_set()

    def _selected_kind(self) -> str:
        for kind, label in self._labels.items():
            if label == self._kind.get():
                return kind
        return "left_click"

    def _rebuild(self) -> None:
        for child in self._holder.winfo_children():
            child.destroy()
        kind = self._selected_kind()
        payload = self._initial.to_dict() if (self._initial and self._initial.kind == kind) else {}
        self._form_vars = {}
        row = 0
        if kind in POINTER_ACTIONS:
            row = self._add_target_row(row, "Target", self._target)
            if kind == "drag":
                row = self._add_target_row(row, "Destination", self._end_target, end=True)
        if kind in CONDITION_ACTIONS:
            row = self._add_condition_row(row)
        if kind in NESTED_ACTIONS:
            row = self._add_actions_row(row)
        if kind == "verify":
            row = self._add_condition_row(row, label="Condition (optional)")
        for spec in action_fields(kind, self.app):
            ttk.Label(self._holder, text=spec.label).grid(row=row, column=0, sticky="w", pady=3)
            value = payload.get(spec.key, spec.default)
            if spec.kind == "bool":
                variable: Any = tk.BooleanVar(value=bool(value))
                widget: tk.Widget = ttk.Checkbutton(self._holder, variable=variable)
            elif spec.kind == "choice":
                variable = tk.StringVar(value="" if value is None else str(value))
                widget = ttk.Combobox(self._holder, textvariable=variable, values=list(spec.choices),
                                      state="readonly" if spec.choices else "normal", width=28)
            else:
                show = "*" if spec.key == "text" and payload.get("sensitive") else ""
                variable = tk.StringVar(value="" if value is None else str(value))
                widget = ttk.Entry(self._holder, textvariable=variable, width=30, show=show)
            widget.grid(row=row, column=1, sticky="ew", pady=3)
            if spec.hint:
                ttk.Label(self._holder, text=spec.hint, style="Muted.TLabel").grid(
                    row=row, column=2, sticky="w", padx=(6, 0)
                )
            self._form_vars[spec.key] = (spec, variable)
            row += 1
        self._holder.columnconfigure(1, weight=1)

    def _add_target_row(self, row: int, label: str, target: Target, end: bool = False) -> int:
        ttk.Label(self._holder, text=label).grid(row=row, column=0, sticky="w", pady=3)
        frame = ttk.Frame(self._holder)
        description = ttk.Label(frame, text=target.describe(), style="Muted.TLabel")
        description.pack(side="left")

        def edit() -> None:
            values = FormDialog.ask(
                self, tr("%s position") % label, target_fields(self.app),
                target.to_dict(), app=self.app,
            )
            if values is None:
                return
            payload = target.to_dict()
            for key, value in values.items():
                if key == "roi":
                    payload[key] = value.to_dict() if isinstance(value, Roi) else value
                elif value != "" and value is not None:
                    payload[key] = value
            updated = Target.from_dict(payload)
            if end:
                self._end_target = updated
            else:
                self._target = updated
            description.configure(text=updated.describe())

        ttk.Button(frame, text=tr('Edit...'), command=edit).pack(side="right")
        frame.grid(row=row, column=1, sticky="ew", pady=3)
        return row + 1

    def _add_condition_row(self, row: int, label: str = "Condition") -> int:
        ttk.Label(self._holder, text=label).grid(row=row, column=0, sticky="w", pady=3)
        frame = ttk.Frame(self._holder)
        description = ttk.Label(frame, text=describe_condition(self._condition), style="Muted.TLabel")
        description.pack(side="left")

        def edit() -> None:
            condition = ConditionEditor.ask(self, self.app, self._condition)
            if condition is not None:
                self._condition = condition
                description.configure(text=condition.describe())

        ttk.Button(frame, text=tr('Edit...'), command=edit).pack(side="right")
        frame.grid(row=row, column=1, sticky="ew", pady=3)
        return row + 1

    def _add_actions_row(self, row: int) -> int:
        ttk.Label(self._holder, text=tr('Actions')).grid(row=row, column=0, sticky="nw", pady=3)
        frame = ttk.Frame(self._holder)
        listbox = tk.Listbox(frame, height=5, background=PALETTE["panel_light"],
                            foreground=PALETTE["text"], borderwidth=0, activestyle="none", width=44)
        listbox.pack(side="top", fill="both", expand=True)

        def refresh() -> None:
            listbox.delete(0, "end")
            for action in self._sub_actions:
                listbox.insert("end", action.describe())

        def add() -> None:
            action = ActionEditor.ask(self, self.app)
            if action is not None:
                self._sub_actions.append(action)
                refresh()

        def remove() -> None:
            selection = listbox.curselection()
            if selection:
                self._sub_actions.pop(selection[0])
                refresh()

        controls = ttk.Frame(frame)
        controls.pack(side="top", fill="x", pady=(4, 0))
        ttk.Button(controls, text=tr('Add'), command=add).pack(side="left")
        ttk.Button(controls, text=tr('Remove'), command=remove).pack(side="left", padx=4)
        refresh()
        frame.grid(row=row, column=1, sticky="ew", pady=3)
        return row + 1

    def _accept(self) -> None:
        kind = self._selected_kind()
        payload: dict[str, Any] = {"kind": kind}
        if kind in POINTER_ACTIONS:
            payload["target"] = self._target.to_dict()
            if kind == "drag":
                payload["end"] = self._end_target.to_dict()
        if kind in CONDITION_ACTIONS or (kind == "verify" and self._condition is not None):
            payload["condition"] = self._condition.to_dict() if self._condition else None
        if kind in NESTED_ACTIONS:
            payload["actions"] = [action.to_dict() for action in self._sub_actions]
        for key, (spec, variable) in self._form_vars.items():
            raw = variable.get()
            try:
                if spec.kind == "bool":
                    payload[key] = bool(raw)
                elif spec.kind == "int":
                    payload[key] = int(float(raw)) if str(raw).strip() else 0
                elif spec.kind == "float":
                    text = str(raw).strip()
                    payload[key] = float(text) if text else None
                else:
                    payload[key] = str(raw)
            except ValueError:
                messagebox.showerror(tr('Invalid value'), f"{spec.label} is not a number.", parent=self)
                return
        for key in ("cooldown", "require_confidence"):
            if key in payload and payload[key] is None:
                payload.pop(key)
        for key in ("duration", "interval", "seconds", "jitter", "timeout", "poll", "delay"):
            if payload.get(key) is None:
                payload.pop(key, None)
        try:
            self.result = action_from_dict(payload)
        except Exception as exc:
            messagebox.showerror(tr('Invalid action'), str(exc), parent=self)
            return
        if isinstance(payload.get("text"), str) and payload.get("sensitive"):
            self.app.log.register_secret(payload["text"])
        self.destroy()

    def _cancel(self) -> None:
        self.result = None
        self.destroy()

    @classmethod
    def ask(cls, parent: tk.Misc, app: "App", action: Action | None = None) -> Action | None:
        dialog = cls(parent, app, action)
        parent.wait_window(dialog)
        return dialog.result


class RecorderDialog(tk.Toplevel):
    """Records what the user does in LDPlayer and returns it as actions.

    This is the macro recorder: perform the combination once, and it becomes a
    list of steps that can be attached to a state or inserted into the scenario.
    Because every position is stored relative to the window (and optionally
    anchored to an image of what was clicked), the result keeps working after the
    emulator is moved or resized.
    """

    def __init__(self, parent: tk.Misc, app: "App") -> None:
        super().__init__(parent)
        self.title(tr("Record actions"))
        self.configure(background=PALETTE["panel"])
        self.transient(parent)
        self.attributes("-topmost", True)
        self.app = app
        self.result: list[Action] | None = None
        self.recorder: ActionRecorder | None = None
        self.listener: Any = None
        settings = app.project.settings.recorder
        self._insert_waits = tk.BooleanVar(value=settings.insert_waits)
        self._anchor = tk.BooleanVar(value=settings.anchor_clicks_to_images)
        self._merge_typing = tk.BooleanVar(value=settings.merge_typing)

        body = ttk.Frame(self, padding=12)
        body.pack(fill="both", expand=True)
        ttk.Label(
            body,
            text=tr("Record the actions you perform in LDPlayer, then reuse them as a step."),
            style="Muted.TLabel",
        ).pack(anchor="w", pady=(0, 8))
        for text, variable in (
            (tr("Insert pauses between actions"), self._insert_waits),
            (tr("Merge typed characters into one text action"), self._merge_typing),
            (tr("Anchor clicks to images (resistant to shifts)"), self._anchor),
        ):
            ttk.Checkbutton(body, text=text, variable=variable).pack(anchor="w")
        self._status = ttk.Label(body, text=tr("Ready to record"), style="Heading.TLabel")
        self._status.pack(anchor="w", pady=(10, 4))
        ttk.Label(body, text=tr("Recorded steps")).pack(anchor="w")
        self._steps = tk.Listbox(
            body, height=10, width=58, background=PALETTE["panel_light"],
            foreground=PALETTE["text"], borderwidth=0, activestyle="none",
        )
        self._steps.pack(fill="both", expand=True, pady=4)

        buttons = ttk.Frame(self, padding=(12, 0, 12, 12))
        buttons.pack(fill="x")
        self._start_button = ttk.Button(
            buttons, text=tr("Start recording"), style="Success.TButton", command=self._start
        )
        self._start_button.pack(side="left")
        self._stop_button = ttk.Button(
            buttons, text=tr("Stop"), style="Danger.TButton", command=self._stop, state="disabled"
        )
        self._stop_button.pack(side="left", padx=6)
        ttk.Button(buttons, text=tr("Cancel"), command=self._cancel).pack(side="right")
        self._use_button = ttk.Button(
            buttons, text=tr("Use the recording"), style="Accent.TButton",
            command=self._accept, state="disabled",
        )
        self._use_button.pack(side="right", padx=6)
        self.protocol("WM_DELETE_WINDOW", self._cancel)

    # ------------------------------------------------------------- recording
    def _settings(self) -> RecorderSettings:
        settings = RecorderSettings.from_dict(self.app.project.settings.recorder.to_dict())
        settings.insert_waits = bool(self._insert_waits.get())
        settings.merge_typing = bool(self._merge_typing.get())
        settings.anchor_clicks_to_images = bool(self._anchor.get())
        return settings

    def _start(self) -> None:
        if self.app.window is None:
            messagebox.showinfo(
                tr("No window"), tr("Select an LDPlayer instance first."), parent=self
            )
            return
        settings = self._settings()
        if settings.anchor_clicks_to_images and self.app.project.path is None:
            messagebox.showinfo(
                tr("Reference image"),
                tr("Save the project before anchoring clicks to images."),
                parent=self,
            )
            settings.anchor_clicks_to_images = False
            self._anchor.set(False)
        self.recorder = ActionRecorder(
            self.app.window, settings, log=self.app.log,
            frame_provider=lambda: self.app.capture_frame(quiet=True),
        )
        self.listener = create_listener(self.recorder, log=self.app.log)
        if self.listener is None:
            messagebox.showerror(
                tr("Recording is unavailable"),
                tr("Install the 'pynput' package to record actions (pip install pynput)."),
                parent=self,
            )
            self.recorder = None
            return
        self.app.project.settings.recorder = settings
        # Arm the recorder first, so nothing is missed once the listener runs.
        self.recorder.start()
        self.listener.start()
        self._status.configure(
            text=tr("Recording... switch to LDPlayer and act. %s to stop.")
            % settings.stop_key.upper()
        )
        self._start_button.configure(state="disabled")
        self._stop_button.configure(state="normal")
        self._poll()

    def _poll(self) -> None:
        if self.recorder is None:
            return
        self._refresh_steps()
        if not self.recorder.recording:      # the stop key was pressed
            self._stop()
            return
        self.after(300, self._poll)

    def _refresh_steps(self) -> None:
        if self.recorder is None:
            return
        self._steps.delete(0, "end")
        for index, description in enumerate(self.recorder.summary(), start=1):
            self._steps.insert("end", f"{index:2d}. {description}")
        self._steps.see("end")

    def _stop(self) -> None:
        if self.listener is not None:
            self.listener.stop()
            self.listener = None
        if self.recorder is not None:
            self.recorder.stop()
            self._refresh_steps()
            self._status.configure(
                text=tr("Recording stopped: %s step(s)") % len(self.recorder.steps)
            )
            self._use_button.configure(state="normal" if self.recorder.steps else "disabled")
        self._start_button.configure(state="normal")
        self._stop_button.configure(state="disabled")

    def _accept(self) -> None:
        if self.recorder is None or not self.recorder.steps:
            messagebox.showinfo(
                tr("Nothing recorded"),
                tr("Perform at least one action inside the emulator window."),
                parent=self,
            )
            return
        self.result = self.recorder.to_actions(
            save_reference=self.app.store_reference_patch, name_prefix="recorded"
        )
        self.recorder.release()
        self.app.log.info("Recorded %s action(s)", len(self.result))
        self.destroy()

    def _cancel(self) -> None:
        self._stop()
        if self.recorder is not None:
            self.recorder.release()
        self.result = None
        self.destroy()

    @classmethod
    def ask(cls, parent: tk.Misc, app: "App") -> list[Action] | None:
        dialog = cls(parent, app)
        parent.wait_window(dialog)
        return dialog.result


class StateEditor(tk.Toplevel):
    """Editor of a visual state: detection, timing, actions, expected result."""

    def __init__(self, parent: tk.Misc, app: "App", state: VisualState | None = None) -> None:
        super().__init__(parent)
        self.title(tr('Visual state'))
        self.configure(background=PALETTE["panel"])
        self.transient(parent)
        self.app = app
        self.result: VisualState | None = None
        self.state = VisualState.from_dict(state.to_dict()) if state is not None else VisualState()
        self._original_name = self.state.name
        notebook = ttk.Notebook(self)
        notebook.pack(fill="both", expand=True, padx=10, pady=10)
        self._build_detection_tab(notebook)
        self._build_actions_tab(notebook)
        self._build_timing_tab(notebook)
        buttons = ttk.Frame(self, padding=(10, 0, 10, 10))
        buttons.pack(fill="x")
        ttk.Button(buttons, text=tr('Cancel'), command=self._cancel).pack(side="right")
        ttk.Button(buttons, text=tr('OK'), style="Accent.TButton", command=self._accept).pack(
            side="right", padx=(0, 8)
        )
        self.grab_set()

    # ------------------------------------------------------------------ tabs
    def _build_detection_tab(self, notebook: ttk.Notebook) -> None:
        tab = ttk.Frame(notebook, padding=12)
        notebook.add(tab, text=tr('Detection'))
        self._name = tk.StringVar(value=self.state.name)
        self._description = tk.StringVar(value=self.state.description)
        self._confidence = tk.StringVar(value=str(self.state.confidence))
        self._match_mode = tk.StringVar(value=self.state.match_mode)
        ttk.Label(tab, text=tr('Name')).grid(row=0, column=0, sticky="w", pady=3)
        ttk.Entry(tab, textvariable=self._name, width=28).grid(row=0, column=1, sticky="ew", pady=3)
        ttk.Label(tab, text=tr('Description')).grid(row=1, column=0, sticky="w", pady=3)
        ttk.Entry(tab, textvariable=self._description, width=28).grid(row=1, column=1, sticky="ew", pady=3)
        ttk.Label(tab, text=tr('Confidence')).grid(row=2, column=0, sticky="w", pady=3)
        ttk.Entry(tab, textvariable=self._confidence, width=10).grid(row=2, column=1, sticky="w", pady=3)
        ttk.Label(tab, text=tr('Reference images must')).grid(row=3, column=0, sticky="w", pady=3)
        ttk.Combobox(tab, textvariable=self._match_mode, state="readonly", width=10,
                     values=("any", "all")).grid(row=3, column=1, sticky="w", pady=3)

        ttk.Label(tab, text=tr('Reference images'), style="Heading.TLabel").grid(
            row=4, column=0, columnspan=2, sticky="w", pady=(12, 4)
        )
        self._references = tk.Listbox(tab, height=5, background=PALETTE["panel_light"],
                                     foreground=PALETTE["text"], borderwidth=0, activestyle="none")
        self._references.grid(row=5, column=0, columnspan=2, sticky="nsew")
        controls = ttk.Frame(tab)
        controls.grid(row=6, column=0, columnspan=2, sticky="w", pady=6)
        ttk.Button(controls, text=tr('From current screen...'), command=self._add_reference_from_screen
                   ).pack(side="left")
        ttk.Button(controls, text=tr('From file...'), command=self._add_reference_from_file).pack(
            side="left", padx=4
        )
        ttk.Button(controls, text=tr('Edit'), command=self._edit_reference).pack(side="left")
        ttk.Button(controls, text=tr('Remove'), command=self._remove_reference).pack(side="left", padx=4)

        ttk.Label(tab, text=tr('Extra condition (AND with the images)')).grid(
            row=7, column=0, columnspan=2, sticky="w", pady=(12, 4)
        )
        condition_row = ttk.Frame(tab)
        condition_row.grid(row=8, column=0, columnspan=2, sticky="ew")
        self._condition_label = ttk.Label(
            condition_row, text=describe_condition(self.state.condition), style="Muted.TLabel"
        )
        self._condition_label.pack(side="left")
        ttk.Button(condition_row, text=tr('Edit...'), command=self._edit_condition).pack(side="right")
        ttk.Button(condition_row, text=tr('Clear'), command=self._clear_condition).pack(
            side="right", padx=4
        )
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(5, weight=1)
        self._refresh_references()

    def _build_actions_tab(self, notebook: ttk.Notebook) -> None:
        tab = ttk.Frame(notebook, padding=12)
        notebook.add(tab, text=tr('Actions'))
        ttk.Label(tab, text=tr('Actions performed when this state is detected')).pack(anchor="w")
        self._actions = tk.Listbox(tab, height=8, background=PALETTE["panel_light"],
                                  foreground=PALETTE["text"], borderwidth=0, activestyle="none")
        self._actions.pack(fill="both", expand=True, pady=6)
        controls = ttk.Frame(tab)
        controls.pack(fill="x")
        ttk.Button(controls, text=tr("Add"), command=self._add_action).pack(side="left")
        ttk.Button(
            controls, text=tr("Record..."), style="Success.TButton", command=self._record_actions
        ).pack(side="left", padx=4)
        ttk.Button(controls, text=tr("Edit"), command=self._edit_action).pack(side="left", padx=4)
        ttk.Button(controls, text=tr('Remove'), style="Danger.TButton",
                   command=self._remove_action).pack(side="left")
        ttk.Button(controls, text=tr('Up'), command=lambda: self._move_action(-1)).pack(side="right")
        ttk.Button(controls, text=tr('Down'), command=lambda: self._move_action(1)).pack(
            side="right", padx=4
        )
        self._refresh_actions()

    def _build_timing_tab(self, notebook: ttk.Notebook) -> None:
        tab = ttk.Frame(notebook, padding=12)
        notebook.add(tab, text=tr('Result and timing'))
        states = [""] + self.app.project.state_names()
        self._expected = tk.StringVar(value=self.state.expected_state)
        self._fallback = tk.StringVar(value=self.state.fallback)
        self._next = tk.StringVar(value=self.state.next_state)
        self._timeout = tk.StringVar(value=str(self.state.timeout))
        self._verify_timeout = tk.StringVar(value=str(self.state.verify_timeout))
        self._retry = tk.StringVar(value=str(self.state.retry_count))
        self._retry_delay = tk.StringVar(value=str(self.state.retry_delay))
        self._cooldown = tk.StringVar(value=str(self.state.cooldown))
        self._terminal = tk.BooleanVar(value=self.state.terminal)
        self._enabled = tk.BooleanVar(value=self.state.enabled)
        rows = [
            (tr("Expected state after the actions"), self._expected, states),
            (tr("Fallback (state name or STOP)"), self._fallback, states + ["STOP"]),
            (tr("Next state to wait for"), self._next, states),
        ]
        row = 0
        for label, variable, choices in rows:
            ttk.Label(tab, text=label).grid(row=row, column=0, sticky="w", pady=3)
            ttk.Combobox(tab, textvariable=variable, values=choices, width=24).grid(
                row=row, column=1, sticky="w", pady=3
            )
            row += 1
        numbers = [
            (tr("State timeout (s)"), self._timeout),
            (tr("Verification timeout (s)"), self._verify_timeout),
            (tr("Retry count"), self._retry),
            (tr("Retry delay (s)"), self._retry_delay),
            (tr("Cooldown (s)"), self._cooldown),
        ]
        for label, variable in numbers:
            ttk.Label(tab, text=label).grid(row=row, column=0, sticky="w", pady=3)
            ttk.Entry(tab, textvariable=variable, width=10).grid(row=row, column=1, sticky="w", pady=3)
            row += 1
        ttk.Checkbutton(tab, text=tr('Terminal state (a successful run ends here)'),
                        variable=self._terminal).grid(row=row, column=0, columnspan=2, sticky="w", pady=3)
        row += 1
        ttk.Checkbutton(tab, text=tr('Enabled'), variable=self._enabled).grid(
            row=row, column=0, columnspan=2, sticky="w", pady=3
        )
        ttk.Label(tab, text=tr('Expected result condition')).grid(row=row + 1, column=0, sticky="w", pady=(12, 3))
        holder = ttk.Frame(tab)
        holder.grid(row=row + 1, column=1, sticky="ew")
        self._expected_condition_label = ttk.Label(
            holder, text=describe_condition(self.state.expected_condition), style="Muted.TLabel"
        )
        self._expected_condition_label.pack(side="left")
        ttk.Button(holder, text=tr('Edit...'), command=self._edit_expected_condition).pack(side="right")
        tab.columnconfigure(1, weight=1)

    # ------------------------------------------------------------ references
    def _refresh_references(self) -> None:
        self._references.delete(0, "end")
        for spec in self.state.references:
            self._references.insert("end", spec.describe())

    def _add_reference_from_screen(self) -> None:
        if not pillow_available():
            messagebox.showinfo(
                tr('Pillow required'),
                tr('Selecting a region on screen needs Pillow (pip install Pillow).\nYou can still add a reference image from a file.'),
                parent=self,
            )
            return
        frame = self.app.grab_preview_frame()
        if frame is None:
            return
        selector = RegionSelector(self, frame, tr("Select the region to remember"))
        self.wait_window(selector)
        if selector.result is None:
            return
        name = self.app.ask_reference_name(self, default=f"{self._name.get() or 'state'}_ref")
        if not name:
            return
        patch = crop_copy(frame, selector.result)
        try:
            self.app.project.add_reference_image(
                patch, name, source_size=(frame.shape[1], frame.shape[0])
            )
        except ProjectError as exc:
            messagebox.showerror(tr('Reference image'), str(exc), parent=self)
            return
        self.state.references.append(
            ReferenceSpec(
                image=name,
                confidence=float(self._confidence.get() or 0.85),
                roi=Roi.from_pixels(selector.result, frame.shape[1], frame.shape[0]),
                source_size=(frame.shape[1], frame.shape[0]),
            )
        )
        self._refresh_references()

    def _add_reference_from_file(self) -> None:
        path = filedialog.askopenfilename(
            parent=self, title=tr('Reference image'),
            filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp"), ("All files", "*.*")],
        )
        if not path:
            return
        name = self.app.ask_reference_name(self, default=Path(path).stem)
        if not name:
            return
        try:
            self.app.project.add_reference_image(path, name)
        except ProjectError as exc:
            messagebox.showerror(tr('Reference image'), str(exc), parent=self)
            return
        self.state.references.append(
            ReferenceSpec(image=name, confidence=float(self._confidence.get() or 0.85))
        )
        self._refresh_references()

    def _edit_reference(self) -> None:
        selection = self._references.curselection()
        if not selection:
            return
        spec = self.state.references[selection[0]]
        values = FormDialog.ask(
            self, "Reference image",
            [
                Field("image", tr('Image'), "choice", self.app.project.reference_names(), spec.image),
                Field("confidence", tr('Confidence'), "float", default=spec.confidence),
                Field("roi", tr('Search region'), "roi", default=spec.roi),
                Field("grayscale", tr('Grayscale'), "bool", default=spec.grayscale),
                Field("match_mode", tr('Match mode'), "choice", ("template", "feature", "histogram"),
                      spec.match_mode),
                Field("multi_scale", tr('Allow scale changes'), "bool", default=spec.multi_scale),
            ],
            app=self.app,
        )
        if values is None:
            return
        payload = spec.to_dict()
        payload.update(
            {
                "image": values["image"] or spec.image,
                "confidence": values["confidence"] or spec.confidence,
                "roi": values["roi"].to_dict(),
                "grayscale": values["grayscale"],
                "match_mode": values["match_mode"] or spec.match_mode,
                "multi_scale": values["multi_scale"],
            }
        )
        self.state.references[selection[0]] = ReferenceSpec.from_dict(payload)
        self._refresh_references()

    def _remove_reference(self) -> None:
        selection = self._references.curselection()
        if selection:
            self.state.references.pop(selection[0])
            self._refresh_references()

    # --------------------------------------------------------------- actions
    def _refresh_actions(self) -> None:
        self._actions.delete(0, "end")
        for action in self.state.actions:
            self._actions.insert("end", action.describe())

    def _add_action(self) -> None:
        action = ActionEditor.ask(self, self.app)
        if action is not None:
            self.state.actions.append(action)
            self._refresh_actions()

    def _record_actions(self) -> None:
        """Record a combination in LDPlayer and append it to this state."""
        actions = RecorderDialog.ask(self, self.app)
        if not actions:
            return
        self.state.actions.extend(actions)
        self._refresh_actions()

    def _edit_action(self) -> None:
        selection = self._actions.curselection()
        if not selection:
            return
        action = ActionEditor.ask(self, self.app, self.state.actions[selection[0]])
        if action is not None:
            self.state.actions[selection[0]] = action
            self._refresh_actions()

    def _remove_action(self) -> None:
        selection = self._actions.curselection()
        if selection:
            self.state.actions.pop(selection[0])
            self._refresh_actions()

    def _move_action(self, delta: int) -> None:
        selection = self._actions.curselection()
        if not selection:
            return
        index = selection[0]
        target = index + delta
        if not 0 <= target < len(self.state.actions):
            return
        actions = self.state.actions
        actions[index], actions[target] = actions[target], actions[index]
        self._refresh_actions()
        self._actions.selection_set(target)

    # ------------------------------------------------------------ conditions
    def _edit_condition(self) -> None:
        condition = ConditionEditor.ask(self, self.app, self.state.condition)
        if condition is not None:
            self.state.condition = condition
            self._condition_label.configure(text=condition.describe())

    def _clear_condition(self) -> None:
        self.state.condition = None
        self._condition_label.configure(text=tr('always'))

    def _edit_expected_condition(self) -> None:
        condition = ConditionEditor.ask(self, self.app, self.state.expected_condition)
        if condition is not None:
            self.state.expected_condition = condition
            self._expected_condition_label.configure(text=condition.describe())

    # ---------------------------------------------------------------- result
    def _accept(self) -> None:
        name = self._name.get().strip()
        if not name:
            messagebox.showerror(tr('Missing name'), tr('The state needs a name.'), parent=self)
            return
        try:
            self.state.name = name
            self.state.description = self._description.get().strip()
            self.state.confidence = float(self._confidence.get() or 0.85)
            self.state.match_mode = self._match_mode.get() or "any"
            self.state.expected_state = self._expected.get().strip()
            self.state.fallback = self._fallback.get().strip()
            self.state.next_state = self._next.get().strip()
            self.state.timeout = float(self._timeout.get() or 10.0)
            self.state.verify_timeout = float(self._verify_timeout.get() or 5.0)
            self.state.retry_count = int(float(self._retry.get() or 0))
            self.state.retry_delay = float(self._retry_delay.get() or 0.0)
            self.state.cooldown = float(self._cooldown.get() or 0.0)
            self.state.terminal = bool(self._terminal.get())
            self.state.enabled = bool(self._enabled.get())
        except ValueError as exc:
            messagebox.showerror(tr('Invalid value'), str(exc), parent=self)
            return
        self.result = self.state
        self.destroy()

    def _cancel(self) -> None:
        self.result = None
        self.destroy()

    @classmethod
    def ask(cls, parent: tk.Misc, app: "App", state: VisualState | None = None):
        dialog = cls(parent, app, state)
        parent.wait_window(dialog)
        return dialog.result, getattr(dialog, "_original_name", "")


# --------------------------------------------------------------------------- #
# workflow diagram
# --------------------------------------------------------------------------- #
class FlowFrame(ttk.Frame):
    """A toolbar that wraps its buttons onto more rows instead of clipping them.

    Button captions differ in length per language, and the centre panel can be
    narrow, so a fixed single row would hide the last buttons.
    """

    def __init__(self, parent: tk.Misc, spacing: int = 4, **kwargs: Any) -> None:
        super().__init__(parent, **kwargs)
        self.spacing = spacing
        self._items: list[tk.Widget] = []
        self._width = 0
        self.bind("<Configure>", self._on_configure)

    def add(self, widget: tk.Widget) -> tk.Widget:
        self._items.append(widget)
        self.after_idle(self.relayout)
        return widget

    def _on_configure(self, event: tk.Event) -> None:
        if abs(event.width - self._width) > 8:
            self._width = event.width
            self.relayout()

    def relayout(self, available: int | None = None) -> None:
        available = available or self._width or self.winfo_width()
        if available <= 1 or not self._items:
            return
        x = y = row_height = 0
        for widget in self._items:
            width = widget.winfo_reqwidth() + self.spacing
            height = widget.winfo_reqheight() + self.spacing
            if x and x + width > available:
                x = 0
                y += row_height
                row_height = 0
            widget.place(x=x, y=y)
            x += width
            row_height = max(row_height, height)
        self.configure(height=y + row_height)

    def rows(self) -> int:
        return len({widget.winfo_y() for widget in self._items}) if self._items else 0


class WorkflowCanvas(ttk.Frame):
    """Draws the workflow as connected boxes and reports the selection."""

    BOX_HEIGHT = 30
    BOX_WIDTH = 300
    INDENT = 34
    GAP = 16

    def __init__(self, parent: tk.Misc, on_select: Callable[[str, str], None],
                 on_activate: Callable[[str, str], None]) -> None:
        super().__init__(parent)
        self.on_select = on_select
        self.on_activate = on_activate
        self.canvas = tk.Canvas(self, background=PALETTE["bg"], highlightthickness=0)
        scroll_y = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        scroll_x = ttk.Scrollbar(self, orient="horizontal", command=self.canvas.xview)
        self.canvas.configure(yscrollcommand=scroll_y.set, xscrollcommand=scroll_x.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        scroll_y.grid(row=0, column=1, sticky="ns")
        scroll_x.grid(row=1, column=0, sticky="ew")
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<Double-Button-1>", self._on_double_click)
        self.canvas.bind("<MouseWheel>", self._on_wheel)
        self.canvas.bind("<Button-4>", lambda event: self.canvas.yview_scroll(-2, "units"))
        self.canvas.bind("<Button-5>", lambda event: self.canvas.yview_scroll(2, "units"))
        self._hits: list[tuple[int, int, int, int, str, str]] = []
        self.selection: tuple[str, str] = ("", "")
        self._workflow: Workflow | None = None
        self._active_node: str = ""

    def _on_wheel(self, event: tk.Event) -> None:  # pragma: no cover - GUI event
        self.canvas.yview_scroll(-1 * int(event.delta / 120), "units")

    def _hit(self, event: tk.Event) -> tuple[str, str] | None:
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        for left, top, right, bottom, node_id, branch in self._hits:
            if left <= x <= right and top <= y <= bottom:
                return node_id, branch
        return None

    def _on_click(self, event: tk.Event) -> None:  # pragma: no cover - GUI event
        hit = self._hit(event)
        if hit is None:
            return
        self.selection = hit
        self.render(self._workflow)
        self.on_select(*hit)

    def _on_double_click(self, event: tk.Event) -> None:  # pragma: no cover - GUI event
        hit = self._hit(event)
        if hit is not None:
            self.selection = hit
            self.on_activate(*hit)

    def set_active(self, node_id: str) -> None:
        self._active_node = node_id
        self.render(self._workflow)

    def render(self, workflow: Workflow | None) -> None:
        self._workflow = workflow
        canvas = self.canvas
        canvas.delete("all")
        self._hits.clear()
        if workflow is None:
            return
        y = 16
        expand = [self.selection[0]] if self.selection[0] else []
        for row in outline_rows(workflow, expand=expand):
            x = 16 + row.depth * self.INDENT
            text = row.text
            if row.kind == "marker":
                canvas.create_text(x + 10, y + 8, text=text, anchor="w",
                                   fill=PALETTE["muted"], font=(MONO_FONT, 10))
                y += 20
                continue
            if row.kind == "branch":
                canvas.create_text(x, y + 8, text=f"{text} →", anchor="w",
                                   fill=PALETTE["accent"], font=ui_font(9, "bold"))
                self._hits.append((x, y, x + 160, y + 18, row.node_id, row.branch_label))
                y += 22
                continue
            node = workflow.find(row.node_id)
            node_type = node.type if node is not None else NodeType.ACTION
            fill = NODE_COLORS.get(node_type, PALETTE["panel_light"])
            selected = self.selection == (row.node_id, "")
            outline = PALETTE["accent"] if selected else PALETTE["border"]
            width = 3 if selected else 1
            if row.node_id == self._active_node:
                outline, width = PALETTE["success"], 3
            box = canvas.create_rectangle(
                x, y, x + self.BOX_WIDTH, y + self.BOX_HEIGHT,
                fill=fill, outline=outline, width=width,
            )
            canvas.create_text(x + 10, y + self.BOX_HEIGHT / 2, text=text, anchor="w",
                               fill=PALETTE["text"], font=ui_font(9))
            self._hits.append((x, y, x + self.BOX_WIDTH, y + self.BOX_HEIGHT, row.node_id, ""))
            y += self.BOX_HEIGHT + 6
        canvas.configure(scrollregion=(0, 0, 16 + self.BOX_WIDTH + 240, y + 20))


# --------------------------------------------------------------------------- #
# main window
# --------------------------------------------------------------------------- #
class App(tk.Tk):
    """The application window."""

    def __init__(self, project: Project | None = None, log: EventLog | None = None,
                 dry_run: bool = False) -> None:
        super().__init__()
        self.log = log or get_logger()
        self.project = project or example_project()
        set_language(self.project.settings.language)
        self.title(tr('LDPlayer Visual UI Tester'))
        self.geometry("1440x900")
        self.minsize(1100, 700)
        self.configure(background=PALETTE["bg"])
        apply_theme(self)
        self.safety = SafetyController(self.project.settings.safety, log=self.log)
        self.window: ldplayer.LDPlayerWindow | None = None
        self.instances: list[ldplayer.LDPlayerInstance] = []
        self.dry_run = tk.BooleanVar(value=dry_run)
        self.step_by_step = tk.BooleanVar(value=self.project.pipeline.step_by_step)
        self.engine_mode = tk.StringVar(value=self.project.settings.engine_mode)
        self.autoscroll = tk.BooleanVar(value=True)
        self.log_level = tk.StringVar(value="INFO")
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._engine_thread: threading.Thread | None = None
        self._context: AnalysisContext | None = None
        self._runner: Any = None
        self._ocr_service: Any = None
        self._closing = False
        self._tick: str | None = None
        self._selected_state: str = ""
        self._selection: tuple[str, str] = ("", "")
        self._preview_photo = None
        self._status = {
            "engine": "IDLE", "state": "-", "confidence": 0.0, "frames": 0, "cycles": 0
        }
        self._build_ui()
        self.log.add_listener(self._queue_log_record)
        self.safety.add_state_listener(lambda state: self._queue.put(("run_state", state)))
        self.hotkeys: HotkeyManager = install_safety_hotkeys(
            self.safety, log=self.log, on_change=lambda state: self._queue.put(("run_state", state))
        )
        self.hotkeys.bind("f8", self._on_hotkey_start_pause)
        self.hotkeys.bind("f10", self._on_hotkey_step)
        self.hotkeys.start()
        self.bind_all("<F8>", lambda _event: self._on_hotkey_start_pause())
        self.bind_all("<F9>", lambda _event: self.stop_engine())
        self.bind_all("<F10>", lambda _event: self._on_hotkey_step())
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._tick: str | None = self.after(80, self._drain_queue)
        self.refresh_instances()
        self.refresh_states()
        self.refresh_workflow()
        self.log.info("Ready. F8 = start/pause, F9 = emergency stop")

    # ------------------------------------------------------------------- UI
    def _build_ui(self) -> None:
        title_bar = tk.Frame(self, background=PALETTE["bg"])
        title_bar.pack(fill="x")
        self._title_label = tk.Label(
            title_bar,
            text="🚀  LDPLAYER VISUAL UI TESTER",
            font=ui_font(18, "bold"),
            fg=PALETTE["title"],
            bg=PALETTE["bg"],
        )
        self._title_label.pack(pady=(16, 8))

        project_bar = ttk.Frame(self, style="Toolbar.TFrame", padding=(10, 8, 10, 2))
        project_bar.pack(fill="x")
        ttk.Button(project_bar, text=tr('New'), command=self.new_project).pack(side="left")
        ttk.Button(project_bar, text=tr('Open...'), command=self.open_project).pack(side="left", padx=4)
        ttk.Button(project_bar, text=tr('Save'), command=self.save_project).pack(side="left")
        ttk.Button(project_bar, text=tr('Save as...'), command=self.save_project_as).pack(side="left", padx=4)
        ttk.Separator(project_bar, orient="vertical").pack(side="left", fill="y", padx=10)
        ttk.Label(project_bar, text=tr('LDPlayer:'), style="Toolbar.TLabel").pack(side="left")
        self._instance_box = ttk.Combobox(project_bar, state="readonly", width=52)
        self._instance_box.pack(side="left", padx=6)
        ttk.Button(project_bar, text=tr('Refresh'), command=self.refresh_instances).pack(side="left")
        ttk.Button(project_bar, text=tr('Select'), style="Accent.TButton",
                   command=self.select_instance).pack(side="left", padx=4)
        ttk.Button(project_bar, text=tr('Screen region...'),
                   command=self.select_manual_region).pack(side="left")

        engine_bar = ttk.Frame(self, style="Toolbar.TFrame", padding=(10, 2, 10, 8))
        engine_bar.pack(fill="x")
        ttk.Label(engine_bar, text=tr('Engine mode:'), style="Toolbar.TLabel").pack(side="left")
        ttk.Combobox(engine_bar, textvariable=self.engine_mode, state="readonly", width=12,
                     values=("workflow", "states")).pack(side="left", padx=6)
        ttk.Checkbutton(engine_bar, text=tr("Dry run (analyse only, no input)"),
                        variable=self.dry_run, style="Toolbar.TCheckbutton").pack(side="left", padx=6)
        ttk.Checkbutton(engine_bar, text=tr("STEP BY STEP (F10)"),
                        variable=self.step_by_step, style="Toolbar.TCheckbutton").pack(side="left", padx=6)
        ttk.Label(engine_bar, text=tr("Language:"), style="Toolbar.TLabel").pack(
            side="left", padx=(14, 4)
        )
        self._language_box = ttk.Combobox(
            engine_bar, state="readonly", width=10,
            values=[label for _code, label in available_languages()],
        )
        self._language_box.set(language_label(get_language()))
        self._language_box.bind(
            "<<ComboboxSelected>>",
            lambda _event: self.change_language(language_code(self._language_box.get())),
        )
        self._language_box.pack(side="left")
        ttk.Label(engine_bar, text=tr('F8 start/pause    F9 stop    F10 step'),
                  style="MutedToolbar.TLabel").pack(side="left", padx=14)
        ttk.Button(engine_bar, text=tr('■ STOP (F9)'), style="Danger.TButton",
                   command=self.stop_engine).pack(side="right")
        self._start_button = ttk.Button(
            engine_bar, text=tr('▶ START (F8)'), style="Success.TButton", command=self.start_engine
        )
        self._start_button.pack(side="right", padx=6)
        ttk.Button(engine_bar, text=tr('Analyze once'), command=self.analyze_once).pack(side="right", padx=6)

        main = ttk.PanedWindow(self, orient="horizontal")
        main.pack(fill="both", expand=True, padx=8, pady=(8, 4))
        main.add(self._build_left_panel(main), weight=1)
        main.add(self._build_center_panel(main), weight=4)
        main.add(self._build_right_panel(main), weight=1)
        self._main = main
        self._build_log_panel()
        self._build_status_bar()
        self.after_idle(self._place_sashes)

    def _build_pipeline_tab(self, parent: tk.Misc) -> ttk.Frame:
        tab = ttk.Frame(parent, padding=8)
        ttk.Label(tab, text=tr("MACROS"), style="Heading.TLabel").pack(anchor="w")
        for name in (AUTH_MACRO, SECOND_MACRO, RESET_MACRO):
            row = ttk.Frame(tab)
            row.pack(fill="x", pady=3)
            ttk.Label(row, text=name, width=12).pack(side="left")
            ttk.Button(row, text=tr("Record"), style="Success.TButton",
                       command=lambda n=name: self.record_named_macro(n)).pack(side="left", padx=2)
            ttk.Button(row, text=tr("Edit"), command=lambda n=name: self.edit_named_macro(n)).pack(
                side="left", padx=2
            )
            ttk.Button(row, text=tr("Test"), command=lambda n=name: self.test_named_macro(n)).pack(
                side="left", padx=2
            )

        ttk.Label(tab, text=tr("STATES"), style="Heading.TLabel").pack(anchor="w", pady=(12, 4))
        for name, capture_label in (
            (AUTH_ERROR, tr("CAPTURE ERROR STATE")),
            (AUTH_SUCCESS, tr("CAPTURE SUCCESS STATE")),
            (MACRO2_ERROR, tr("CAPTURE MACRO 2 ERROR STATE")),
            (MACRO2_SUCCESS, tr("CAPTURE MACRO 2 SUCCESS STATE")),
        ):
            block = ttk.Frame(tab)
            block.pack(fill="x", pady=4)
            ttk.Label(block, text=name, style="Heading.TLabel").pack(anchor="w")
            buttons = ttk.Frame(block)
            buttons.pack(fill="x")
            ttk.Button(
                buttons, text=tr("Capture"), style="Success.TButton",
                command=lambda n=name: self.capture_result_state(n),
            ).pack(side="left", padx=(0, 4))
            ttk.Button(
                buttons, text=tr("Test detection"),
                command=lambda n=name: self.test_state_detection(n),
            ).pack(side="left", padx=2)
            ttk.Button(buttons, text=tr("Edit"), command=lambda n=name: self.edit_named_state(n)).pack(
                side="left", padx=2
            )

        ttk.Label(tab, text=tr("TEST DATA"), style="Heading.TLabel").pack(anchor="w", pady=(12, 4))
        ttk.Label(
            tab,
            text=tr("login / password — AUTH_VK types these; passwords are not logged"),
            style="Muted.TLabel", wraplength=280,
        ).pack(anchor="w")
        columns = tuple(self.project.test_data.columns)
        self._test_data_tree = ttk.Treeview(tab, columns=columns, show="headings", height=5)
        for column in columns:
            self._test_data_tree.heading(column, text=column)
            self._test_data_tree.column(column, width=110)
        self._test_data_tree.pack(fill="x", pady=4)
        data_buttons = ttk.Frame(tab)
        data_buttons.pack(fill="x")
        ttk.Button(data_buttons, text=tr("+ Add row"), style="Success.TButton",
                   command=self.add_test_row).pack(side="left")
        ttk.Button(data_buttons, text=tr("Delete"), style="Danger.TButton",
                   command=self.delete_test_row).pack(side="left", padx=4)
        self.refresh_test_data()
        return tab

    def _build_left_panel(self, parent: tk.Misc) -> ttk.Frame:
        frame = ttk.Frame(parent, width=330)
        notebook = ttk.Notebook(frame)
        notebook.pack(fill="both", expand=True)
        self._left_notebook = notebook

        states_tab = ttk.Frame(notebook, padding=8)
        notebook.add(self._build_pipeline_tab(notebook), text=tr("Pipeline"))
        notebook.add(states_tab, text=tr('States'))
        columns = ("confidence", "references", "actions")
        self._states_tree = ttk.Treeview(states_tab, columns=columns, show="tree headings", height=12)
        self._states_tree.heading("#0", text=tr('State'))
        self._states_tree.heading("confidence", text=tr('Conf.'))
        self._states_tree.heading("references", text=tr('Refs'))
        self._states_tree.heading("actions", text=tr('Acts'))
        self._states_tree.column("#0", width=150)
        for column in columns:
            self._states_tree.column(column, width=45, anchor="center")
        self._states_tree.pack(fill="both", expand=True)
        self._states_tree.bind("<<TreeviewSelect>>", self._on_state_selected)
        self._states_tree.bind("<Double-1>", lambda _event: self.edit_state())
        controls = ttk.Frame(states_tab)
        controls.pack(fill="x", pady=6)
        ttk.Button(controls, text=tr('ADD STATE'), style="Success.TButton",
                   command=self.add_state).pack(side="left")
        ttk.Button(controls, text=tr('Edit'), command=self.edit_state).pack(side="left", padx=4)
        ttk.Button(controls, text=tr('Copy'), command=self.duplicate_state).pack(side="left")
        ttk.Button(controls, text=tr('Delete'), style="Danger.TButton",
                   command=self.delete_state).pack(side="left", padx=4)

        detection_tab = ttk.Frame(notebook, padding=8)
        notebook.add(detection_tab, text=tr('Detection test'))
        ttk.Button(detection_tab, text=tr('Analyze the current screen'),
                   command=self.analyze_once).pack(fill="x")
        self._scores = ttk.Treeview(detection_tab, columns=("confidence", "where"),
                                   show="tree headings", height=8)
        self._scores.heading("#0", text=tr('State'))
        self._scores.heading("confidence", text=tr('Confidence'))
        self._scores.heading("where", text=tr('Position'))
        self._scores.column("#0", width=110)
        self._scores.column("confidence", width=80, anchor="center")
        self._scores.column("where", width=110, anchor="center")
        self._scores.pack(fill="x", pady=8)
        self._preview = tk.Label(detection_tab, background=PALETTE["bg"],
                                text=tr('No frame captured yet'), foreground=PALETTE["muted"])
        self._preview.pack(fill="both", expand=True)
        return frame

    def _build_center_panel(self, parent: tk.Misc) -> ttk.Frame:
        frame = ttk.Frame(parent)
        header = ttk.Frame(frame)
        header.pack(fill="x", pady=(0, 4))
        ttk.Label(header, text=tr('Scenario'), style="Heading.TLabel").pack(side="left")
        ttk.Label(header, text=tr('  (select a box or a branch, then add a step)'),
                  style="Muted.TLabel").pack(side="left")
        ttk.Label(frame, text=tr("MACRO"), style="Heading.TLabel").pack(anchor="w", pady=(6, 4))
        self._record_macro_button = ttk.Button(
            frame,
            text="+ " + tr("RECORD MACRO") + f"  ({AUTH_MACRO})",
            style="Success.TButton",
            command=lambda: self.record_named_macro(AUTH_MACRO),
        )
        self._record_macro_button.pack(fill="x", pady=(0, 4))
        extra = ttk.Frame(frame)
        extra.pack(fill="x", pady=(0, 8))
        ttk.Button(
            extra, text=tr("RECORD MACRO 2"), style="Success.TButton",
            command=lambda: self.record_named_macro(SECOND_MACRO),
        ).pack(side="left")
        ttk.Button(
            extra, text=tr("CAPTURE ERROR STATE"), style="Danger.TButton",
            command=lambda: self.capture_result_state(AUTH_ERROR),
        ).pack(side="left", padx=4)
        ttk.Button(
            extra, text=tr("CAPTURE SUCCESS STATE"), style="Success.TButton",
            command=lambda: self.capture_result_state(AUTH_SUCCESS),
        ).pack(side="left")
        buttons = FlowFrame(frame)
        buttons.pack(fill="x", pady=(0, 6))
        for label, command, style in [
            (tr("ADD STATE"), self.add_state_node, "Success.TButton"),
            (tr("ADD CONDITION"), self.add_condition_node, "TButton"),
            (tr("ADD ACTION"), self.add_action_node, "TButton"),
            (tr("ADD VERIFY"), self.add_verify_node, "TButton"),
            (tr("ADD ELSE"), self.add_else_branch, "TButton"),
            (tr("ADD WAIT"), self.add_wait_node, "TButton"),
            (tr("ADD RETRY"), self.add_retry_node, "TButton"),
            (tr("ADD ANALYZE"), self.add_analyze_node, "TButton"),
            (tr("ADD LOOP"), self.add_loop_node, "TButton"),
            (tr("ADD STOP"), self.add_stop_node, "TButton"),
            (tr("Edit"), self.edit_node, "TButton"),
            (tr("Delete"), self.delete_node, "Danger.TButton"),
            ("↑", lambda: self.move_node(-1), "TButton"),
            ("↓", lambda: self.move_node(1), "TButton"),
            (tr("On/off"), self.toggle_node, "TButton"),
        ]:
            buttons.add(ttk.Button(buttons, text=label, command=command, style=style))
        self._scenario_buttons = buttons
        self._canvas = WorkflowCanvas(frame, self._on_node_selected, lambda *_: self.edit_node())
        self._canvas.pack(fill="both", expand=True)
        return frame

    def _build_right_panel(self, parent: tk.Misc) -> ttk.Frame:
        frame = ttk.Frame(parent, width=320)
        ttk.Label(frame, text=tr('Details'), style="Heading.TLabel").pack(anchor="w")
        self._details = tk.Text(frame, height=14, wrap="word", background=PALETTE["panel_light"],
                               foreground=PALETTE["text"], borderwidth=0, state="disabled")
        self._details.pack(fill="both", expand=True, pady=(4, 8))
        ttk.Label(frame, text=tr('Validation'), style="Heading.TLabel").pack(anchor="w")
        self._warnings = tk.Text(frame, height=8, wrap="word", background=PALETTE["panel_light"],
                                foreground=PALETTE["warning"], borderwidth=0, state="disabled")
        self._warnings.pack(fill="both", expand=True, pady=(4, 8))
        ttk.Button(frame, text=tr('Check the project'), command=self.validate_project).pack(fill="x")
        ttk.Button(frame, text=tr('Engine settings...'), command=self.edit_settings).pack(fill="x", pady=4)
        return frame

    def _build_log_panel(self) -> None:
        frame = ttk.Frame(self, padding=(8, 4))
        frame.pack(fill="both", expand=False)
        header = ttk.Frame(frame)
        header.pack(fill="x")
        ttk.Label(header, text=tr('Live log'), style="Heading.TLabel").pack(side="left")
        ttk.Checkbutton(header, text=tr('Autoscroll'), variable=self.autoscroll).pack(side="right")
        ttk.Combobox(header, textvariable=self.log_level, state="readonly", width=9,
                     values=("DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR")).pack(side="right", padx=6)
        ttk.Button(header, text=tr('Clear'), command=self.clear_log).pack(side="right")
        ttk.Button(header, text=tr('Save log...'), command=self.save_log).pack(side="right", padx=6)
        body = ttk.Frame(frame)
        body.pack(fill="both", expand=True, pady=(4, 0))
        self._log_view = tk.Text(body, height=11, wrap="none", background="#0a0a0a",
                                foreground=PALETTE["text"], borderwidth=0, state="disabled",
                                font=(MONO_FONT, 9))
        scroll_y = ttk.Scrollbar(body, orient="vertical", command=self._log_view.yview)
        scroll_x = ttk.Scrollbar(body, orient="horizontal", command=self._log_view.xview)
        self._log_view.configure(yscrollcommand=scroll_y.set, xscrollcommand=scroll_x.set)
        self._log_view.grid(row=0, column=0, sticky="nsew")
        scroll_y.grid(row=0, column=1, sticky="ns")
        scroll_x.grid(row=1, column=0, sticky="ew")
        body.columnconfigure(0, weight=1)
        body.rowconfigure(0, weight=1)
        for level, color in LEVEL_COLORS.items():
            self._log_view.tag_configure(level.name, foreground=color)

    def _build_status_bar(self) -> None:
        bar = ttk.Frame(self, style="Toolbar.TFrame", padding=(10, 4))
        bar.pack(fill="x")
        self._status_label = ttk.Label(bar, text="", style="MutedToolbar.TLabel")
        self._status_label.pack(side="left")
        self._window_label = ttk.Label(bar, text=tr('No LDPlayer selected'),
                                      style="MutedToolbar.TLabel")
        self._window_label.pack(side="right")
        self._update_status()

    def _place_sashes(self) -> None:
        """Keep the scenario (and the MACRO button) the widest column."""
        paned = getattr(self, "_main", None)
        if paned is None:
            return
        width = paned.winfo_width()
        if width < 400:
            return
        left = 310
        right = max(width - 330, left + 480)
        try:
            if abs(paned.sashpos(0) - left) > 40:
                paned.sashpos(0, left)
            if abs(paned.sashpos(1) - right) > 40:
                paned.sashpos(1, right)
        except tk.TclError:  # pragma: no cover - widget gone
            return
        toolbar = getattr(self, "_scenario_buttons", None)
        if toolbar is not None:
            toolbar.relayout()

    # -------------------------------------------------------------- helpers
    def _set_text(self, widget: tk.Text, content: str) -> None:
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        widget.insert("1.0", content)
        widget.configure(state="disabled")

    def _update_status(self) -> None:
        # Read the live counters straight from the running engine, so the bar
        # moves during a run instead of only at the end.
        if self._context is not None:
            self._status["frames"] = self._context.frames_analyzed
        if self._runner is not None:
            self._status["cycles"] = self._runner.report.cycles
        text = tr(
            "Engine: %s   |   Run: %s   |   State: %s (%.2f)   |   Frames: %s   |   "
            "Cycles: %s   |   OCR: %s   |   %s"
        ) % (
            self._status["engine"], self.safety.state, self._status["state"],
            self._status["confidence"], self._status["frames"], self._status["cycles"],
            self.project.settings.ocr_engine,
            tr("DRY RUN") if self.dry_run.get() else tr("LIVE INPUT"),
        )
        self._status_label.configure(text=text)
        if self.window is not None and self.window.is_alive():
            rect = self.window.client_rect
            self._window_label.configure(text=f"{self.window.title}  {rect}")
        elif self.window is not None:
            self._window_label.configure(text=tr("%s (window lost)") % self.window.title)

    def _queue_log_record(self, record: LogRecord) -> None:
        self._queue.put(("log", record))

    def _drain_queue(self) -> None:
        """Apply queued engine events, then schedule the next tick.

        A failing event handler must never break the chain: without the
        ``finally`` the whole GUI would stop updating while the engine keeps
        running in its worker thread.
        """
        if self._closing:
            return
        try:
            self._process_events()
            self._update_status()
        except Exception as exc:  # pragma: no cover - defensive
            self.log.error("GUI update failed: %s", exc)
        finally:
            if not self._closing:
                self._tick = self.after(80, self._drain_queue)

    def _process_events(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == "log":
                    self._append_log(payload)
                elif kind == "engine_state":
                    state, detail = payload
                    self._status["engine"] = state.value
                    if detail and state is EngineState.STATE_DETECTED:
                        self._status["state"] = detail
                elif kind == "step":
                    self._status["state"] = payload.state or "-"
                    self._status["confidence"] = payload.confidence
                elif kind == "node":
                    self._canvas.set_active(payload)
                    running = self.project.workflow.find(payload)
                    if running is not None:
                        self._set_text(
                            self._details,
                            self._describe_node(running, prefix=tr("RUNNING - ")),
                        )
                elif kind == "run_state":
                    self._start_button.configure(
                        text=tr("⏸ PAUSE (F8)") if payload == RunState.RUNNING else tr("▶ START (F8)")
                    )
                elif kind == "frames":
                    self._status["frames"] = payload
                elif kind == "cycles":
                    self._status["cycles"] = payload
                elif kind == "finished":
                    self._on_engine_finished(payload)
        except queue.Empty:
            pass

    def _append_log(self, record: LogRecord) -> None:
        try:
            minimum = LogLevel.parse(self.log_level.get())
        except (KeyError, ValueError):
            minimum = LogLevel.INFO
        if record.level < minimum:
            return
        self._log_view.configure(state="normal")
        self._log_view.insert("end", record.format() + "\n", record.level.name)
        limit = int(self._log_view.index("end-1c").split(".")[0])
        if limit > 4000:
            self._log_view.delete("1.0", f"{limit - 3000}.0")
        self._log_view.configure(state="disabled")
        if self.autoscroll.get():
            self._log_view.see("end")

    # ------------------------------------------------------------- projects
    def new_project(self) -> None:
        if not self._confirm_discard():
            return
        self.project = example_project()
        self.project.settings.language = get_language()
        self.safety.settings = self.project.settings.safety
        self.engine_mode.set(self.project.settings.engine_mode)
        self.step_by_step.set(self.project.pipeline.step_by_step)
        self.refresh_states()
        self.refresh_workflow()
        self.refresh_test_data()
        self.log.info("New project created")

    def open_project(self) -> None:
        if not self._confirm_discard():
            return
        path = filedialog.askdirectory(title=tr('Open a project folder (*.ldproj)'))
        if not path:
            return
        try:
            self.project = Project.load(path, log=self.log)
        except ProjectError as exc:
            messagebox.showerror(tr('Open project'), str(exc))
            return
        self.safety.settings = self.project.settings.safety
        self.engine_mode.set(self.project.settings.engine_mode)
        self.step_by_step.set(self.project.pipeline.step_by_step)
        if self.project.settings.language != get_language():
            set_language(self.project.settings.language)
            self._rebuild_ui()
        self.refresh_states()
        self.refresh_workflow()
        self.refresh_test_data()
        self.validate_project()

    def save_project(self) -> None:
        if self.project.path is None:
            self.save_project_as()
            return
        self.project.settings.engine_mode = self.engine_mode.get()
        self.project.save()

    def save_project_as(self) -> None:
        path = filedialog.asksaveasfilename(
            title=tr('Save the project'), defaultextension=".ldproj",
            filetypes=[("LDPlayer test project", "*.ldproj")],
        )
        if not path:
            return
        self.project.settings.engine_mode = self.engine_mode.get()
        try:
            self.project.save(path)
        except ProjectError as exc:
            messagebox.showerror(tr('Save project'), str(exc))

    def _confirm_discard(self) -> bool:
        if not self.project.dirty:
            return True
        answer = messagebox.askyesnocancel(
            tr('Unsaved changes'), tr('Save the current project first?')
        )
        if answer is None:
            return False
        if answer:
            self.save_project()
        return True

    def validate_project(self) -> None:
        problems = self.project.validate() + self.project.audit_storage()
        if problems:
            self._set_text(self._warnings, "\n".join(f"• {problem}" for problem in problems))
        else:
            self._set_text(self._warnings, tr("No problems found."))

    def edit_settings(self) -> None:
        settings = self.project.settings
        values = FormDialog.ask(
            self, "Engine settings",
            [
                Field("min_confidence", tr('Default confidence'), "float", default=settings.min_confidence),
                Field("ambiguity_margin", tr('Ambiguity margin'), "float",
                      default=settings.safety.ambiguity_margin),
                Field("pointer_cooldown", tr('Click cooldown (s)'), "float",
                      default=settings.safety.pointer_cooldown),
                Field("max_actions_per_minute", tr('Max actions / minute'), "int",
                      default=settings.safety.max_actions_per_minute),
                Field("require_foreground", tr('Require the window in front'), "bool",
                      default=settings.safety.require_foreground),
                Field("capture_backend", tr('Capture backend'), "choice", ("auto", "windows", "mss"),
                      default=settings.capture_backend),
                Field("ocr_engine", tr('OCR engine'), "choice", ("auto", "paddleocr", "tesseract", "none"),
                      default=settings.ocr_engine),
                Field("ocr_language", tr('OCR language'), "str", default=settings.ocr_language),
                Field("ocr_scale", tr('OCR upscaling'), "float", default=settings.ocr_preprocess.scale),
                Field("loop", tr('Repeat the workflow'), "bool", default=settings.runner.loop),
                Field("cycle_delay", tr('Delay between cycles (s)'), "float",
                      default=settings.runner.analyze_interval),
                Field("max_cycles", tr('Max cycles (0 = unlimited)'), "int",
                      default=settings.runner.max_cycles),
                Field("inset_left", tr('Inset left (px)'), "int", default=settings.window_insets[0]),
                Field("inset_top", tr('Inset top (px)'), "int", default=settings.window_insets[1]),
                Field("inset_right", tr('Inset right (px)'), "int", default=settings.window_insets[2]),
                Field("inset_bottom", tr("Inset bottom (px)"), "int", default=settings.window_insets[3]),
                Field("language", tr("Interface language"), "choice",
                      [label for _code, label in available_languages()],
                      default=language_label(get_language())),
            ],
        )
        if values is None:
            return
        settings.min_confidence = values["min_confidence"] or 0.85
        settings.safety.ambiguity_margin = values["ambiguity_margin"] or 0.0
        settings.safety.pointer_cooldown = values["pointer_cooldown"] or 0.0
        settings.safety.min_confidence = settings.min_confidence
        settings.safety.max_actions_per_minute = int(values["max_actions_per_minute"])
        settings.safety.require_foreground = bool(values["require_foreground"])
        settings.capture_backend = values["capture_backend"] or "auto"
        settings.ocr_engine = values["ocr_engine"] or "auto"
        settings.ocr_language = values["ocr_language"] or "en"
        settings.ocr_preprocess = Preprocess(
            scale=values["ocr_scale"] or 2.0,
            grayscale=settings.ocr_preprocess.grayscale,
            contrast=settings.ocr_preprocess.contrast,
            threshold=settings.ocr_preprocess.threshold,
            invert=settings.ocr_preprocess.invert,
        )
        settings.runner.loop = bool(values["loop"])
        settings.runner.analyze_interval = values["cycle_delay"] or 0.0
        settings.runner.max_cycles = int(values["max_cycles"])
        self.project.workflow.settings.loop = settings.runner.loop
        self.project.workflow.settings.cycle_delay = settings.runner.analyze_interval
        self.project.workflow.settings.max_cycles = settings.runner.max_cycles
        settings.window_insets = (
            int(values["inset_left"]), int(values["inset_top"]),
            int(values["inset_right"]), int(values["inset_bottom"]),
        )
        if self.window is not None:
            self.window.set_insets(*settings.window_insets)
        self.project.mark_dirty()
        self.log.info("Engine settings updated")
        chosen = language_code(str(values.get("language", "")))
        if chosen != get_language():
            self.change_language(chosen)

    # ------------------------------------------------------------ instances
    def refresh_instances(self) -> None:
        self.instances = ldplayer.enumerate_windows()
        labels = [instance.label for instance in self.instances]
        self._instance_box.configure(values=labels)
        if labels:
            self._instance_box.current(0)
            self.log.info("Found %s LDPlayer window(s)", len(labels))
        else:
            self._instance_box.set("")
            self.log.warning(
                "No LDPlayer window found. Start an instance, or use 'Screen region...'"
            )

    def select_instance(self) -> None:
        index = self._instance_box.current()
        if index < 0 or index >= len(self.instances):
            messagebox.showinfo(tr('Select LDPlayer'), tr('Refresh the list and pick an instance.'))
            return
        instance = self.instances[index]
        self.window = instance.open(log=self.log, insets=self.project.settings.window_insets)
        self.project.settings.window_hint = instance.title
        self.window.add_geometry_listener(
            lambda window, kind: self.log.debug("Window %s: %s", kind, window.client_rect)
        )
        self.log.success("LDPlayer selected: %s", self.window.describe())
        self._update_status()

    def select_manual_region(self) -> None:
        values = FormDialog.ask(
            self, "Screen region",
            [
                Field("left", tr('Left'), "int", default=0),
                Field("top", tr('Top'), "int", default=0),
                Field("width", tr('Width'), "int", default=960),
                Field("height", tr('Height'), "int", default=540),
                Field("title", tr('Name'), "str", default="Screen region"),
            ],
        )
        if values is None:
            return
        self.window = ldplayer.manual_window(
            int(values["left"]), int(values["top"]), int(values["width"]), int(values["height"]),
            title=values["title"] or "Screen region", log=self.log,
        )
        self.log.success("Using the screen region %s", self.window.client_rect)
        self._update_status()

    # ----------------------------------------------------------- capture/test
    def grab_preview_frame(self) -> np.ndarray | None:
        return self.capture_frame()

    def capture_frame(self, quiet: bool = False) -> np.ndarray | None:
        """Capture one frame for the UI (kept in RAM, never written to disk)."""
        if self.window is None:
            if not quiet:
                messagebox.showinfo(tr("No window"), tr("Select an LDPlayer instance first."))
            return None
        image = self._grab_once(quiet=quiet)
        if image is None:
            return None
        if looks_blank(image):
            try:
                self.window.activate()
            except Exception:
                pass
            self.update_idletasks()
            time.sleep(0.15)
            retry = self._grab_once(quiet=True)
            if retry is not None:
                image = retry
        if looks_blank(image) and not quiet:
            messagebox.showwarning(
                tr("Capture failed"),
                tr(
                    "The captured frame is black. Uncover the LDPlayer window "
                    "(do not minimise it), move this editor aside, then try again. "
                    "If it stays black: Engine settings → Capture backend → mss."
                ),
            )
        return image

    def _grab_once(self, quiet: bool = False) -> np.ndarray | None:
        try:
            capture = WindowCapture(self.window, backend=self.project.settings.capture_backend,
                                    log=self.log)
            frame = capture.grab()
            image = frame.image.copy()
            frame.release()
            capture.close()
            return image
        except CaptureError as exc:
            if not quiet:
                messagebox.showerror(tr("Capture failed"), str(exc))
            return None

    def analyze_once(self) -> None:
        """Capture one frame, score every state and show the result."""
        if self.window is None:
            messagebox.showinfo(tr('No window'), tr('Select an LDPlayer instance first.'))
            return
        context = self._build_context(dry_run=True)
        if context is None:
            return
        try:
            context.refresh()
            outcome = context.detect()
            self._scores.delete(*self._scores.get_children())
            for name, confidence in sorted(outcome.scores.items(), key=lambda item: -item[1]):
                match = outcome.matches.get(name)
                where = str(match.rect) if match is not None and match.rect else "-"
                self._scores.insert("", "end", text=name, values=(f"{confidence:.3f}", where))
            self._status["state"] = outcome.state
            self._status["confidence"] = outcome.confidence
            self.log.info("Analysis: %s", outcome.describe())
            self._show_preview(context.image)
        except CaptureError as exc:
            messagebox.showerror(tr('Capture failed'), str(exc))
        finally:
            context.release()

    def _show_preview(self, image: np.ndarray) -> None:
        try:
            self._preview_photo = to_photo_image(image, max_size=(300, 420))
        except Exception as exc:  # pragma: no cover - Pillow missing
            self._preview.configure(text=f"Preview unavailable: {exc}")
            return
        self._preview.configure(image=self._preview_photo, text="")

    def ask_reference_name(self, parent: tk.Misc, default: str = "reference") -> str:
        values = FormDialog.ask(
            parent, "Reference image name", [Field("name", tr('Name'), "str", default=default)]
        )
        if values is None:
            return ""
        name = str(values["name"]).strip()
        if name and name in self.project.references:
            if not messagebox.askyesno(
                tr("Replace"), tr("Replace the image '%s'?") % name, parent=parent
            ):
                return ""
        return name

    # --------------------------------------------------------------- states
    def refresh_states(self) -> None:
        self._states_tree.delete(*self._states_tree.get_children())
        for name in self.project.state_names():
            state = self.project.states[name]
            self._states_tree.insert(
                "", "end", iid=name, text=name,
                values=(f"{state.confidence:.2f}", len(state.references), len(state.actions)),
            )
        self.validate_project()

    def _on_state_selected(self, _event: tk.Event) -> None:
        selection = self._states_tree.selection()
        if not selection:
            return
        self._selected_state = selection[0]
        state = self.project.states.get(self._selected_state)
        if state is None:
            return
        lines = [
            tr("STATE %s") % state.name,
            state.description or tr("(no description)"),
            "",
        ]
        lines.append(state.summary())
        if state.references:
            lines.append("")
            lines.append(tr("Reference images:"))
            lines.extend(f"  • {spec.describe()}" for spec in state.references)
        if state.condition is not None:
            lines.append("")
            lines.append(tr("Condition: %s") % state.condition.describe())
        if state.actions:
            lines.append("")
            lines.append(tr("Actions:"))
            lines.extend(f"  {index}. {action.describe()}"
                         for index, action in enumerate(state.actions, start=1))
        if state.has_expectation():
            lines.append("")
            lines.append(
                tr("Expected: %s")
                % (state.expected_state or describe_condition(state.expected_condition))
            )
            lines.append(tr("Verification timeout: %gs") % state.verify_timeout)
        lines.append("")
        lines.append(
            tr("Retries: %s (delay %gs), cooldown %gs")
            % (state.retry_count, state.retry_delay, state.cooldown)
        )
        if state.fallback:
            lines.append(tr("Fallback: %s") % state.fallback)
        self._set_text(self._details, "\n".join(lines))

    def add_state(self) -> None:
        state, _ = StateEditor.ask(self, self)
        if state is None:
            return
        self.project.add_state(state)
        self.refresh_states()
        self.log.info("State added: %s", state.name)

    def edit_state(self) -> None:
        if not self._selected_state:
            return
        current = self.project.states.get(self._selected_state)
        if current is None:
            return
        state, original = StateEditor.ask(self, self, current)
        if state is None:
            return
        if original and original != state.name:
            self.project.rename_state(original, state.name)
        self.project.states.pop(original, None)
        self.project.add_state(state)
        self.refresh_states()

    def duplicate_state(self) -> None:
        if not self._selected_state:
            return
        original = self.project.states[self._selected_state]
        copy = VisualState.from_dict(original.to_dict())
        copy.name = f"{original.name}_copy"
        self.project.add_state(copy)
        self.refresh_states()

    def delete_state(self) -> None:
        if not self._selected_state:
            return
        if not messagebox.askyesno(
            tr("Delete state"), tr("Delete '%s'?") % self._selected_state
        ):
            return
        self.project.remove_state(self._selected_state)
        self._selected_state = ""
        self.refresh_states()

    # ------------------------------------------------------------- workflow
    def refresh_workflow(self) -> None:
        self._canvas.render(self.project.workflow)
        self.validate_project()

    def _on_node_selected(self, node_id: str, branch: str) -> None:
        self._selection = (node_id, branch)
        node = self.project.workflow.find(node_id)
        if node is not None:
            self._set_text(self._details, self._describe_node(node, branch))

    def _describe_node(self, node: WorkflowNode, branch: str = "", prefix: str = "") -> str:
        lines = [f"{prefix}{node.type.value}: {node.describe()}"]
        if branch:
            lines.append(tr("Selected branch: %s") % tr(branch))
        if node.condition is not None:
            lines.append(tr("Condition: %s") % node.condition.describe())
        if node.action is not None:
            lines.append(tr("Action: %s") % node.action.describe())
        if node.type in (NodeType.VERIFY, NodeType.ANALYZE, NodeType.WAIT):
            lines.append(tr("Timeout: %gs, check every %gs") % (node.timeout, node.poll))
        if node.type is NodeType.RETRY:
            lines.append(tr("Attempts: %s, delay %gs") % (node.attempts, node.delay))
        if node.type is NodeType.LOOP:
            lines.append(tr("Count: %s, iteration limit %s") % (node.count, node.max_iterations))
        if not node.enabled:
            lines.append(tr("This step is disabled."))
        return "\n".join(lines)

    def _insertion_point(self) -> tuple[list[WorkflowNode], int]:
        """Where a new step goes: into the selected branch, or after the node."""
        node_id, branch = self._selection
        workflow = self.project.workflow
        if node_id:
            node = workflow.find(node_id)
            if node is not None and branch:
                container = {
                    "YES": node.then_nodes,
                    "ELSE": node.else_nodes,
                    "BODY": node.body,
                    "SUCCESS": node.on_success,
                    "FAILED": node.on_failure,
                    "ON FAILURE": node.on_failure,
                }.get(branch)
                if container is None:
                    selected = node.branch(branch)
                    container = selected.nodes if selected is not None else None
                if container is not None:
                    return container, len(container)
            container = workflow.parent_list(node_id)
            if container is not None:
                for index, item in enumerate(container):
                    if item.id == node_id:
                        return container, index + 1
        return workflow.nodes, len(workflow.nodes)

    def _insert_node(self, node: WorkflowNode) -> None:
        container, index = self._insertion_point()
        container.insert(index, node)
        self.project.mark_dirty()
        self._selection = (node.id, "")
        self._canvas.selection = (node.id, "")
        self.refresh_workflow()
        self.log.info("Step added: %s", node.describe())

    def add_analyze_node(self) -> None:
        values = FormDialog.ask(
            self, "ANALYZE",
            [
                Field("state", tr('Wait for state (optional)'), "choice",
                      [""] + self.project.state_names()),
                Field("timeout", tr('Timeout (s)'), "float", default=10.0),
                Field("poll", tr('Check every (s)'), "float", default=0.4),
            ],
        )
        if values is None:
            return
        self._insert_node(make_node(
            NodeType.ANALYZE, state=values["state"], timeout=values["timeout"] or 10.0,
            poll=values["poll"] or 0.4,
        ))

    def add_condition_node(self) -> None:
        condition = ConditionEditor.ask(self, self)
        if condition is None:
            return
        self._insert_node(make_node(NodeType.IF, condition=condition))

    def add_action_node(self) -> None:
        action = ActionEditor.ask(self, self)
        if action is None:
            return
        self._insert_node(make_node(NodeType.ACTION, action=action))

    def add_state_node(self) -> None:
        names = self.project.state_names()
        if not names:
            messagebox.showinfo(tr('No states'), tr('Create a visual state first.'))
            return
        values = FormDialog.ask(
            self, "Run a state", [Field("state", tr('State'), "choice", names, default=names[0])]
        )
        if values is None or not values["state"]:
            return
        self._insert_node(make_node(NodeType.STATE, state=values["state"]))

    def add_verify_node(self) -> None:
        values = FormDialog.ask(
            self, "VERIFY",
            [
                Field("state", tr('Expected state'), "choice", [""] + self.project.state_names()),
                Field("timeout", tr('Timeout (s)'), "float", default=5.0),
                Field("poll", tr('Check every (s)'), "float", default=0.4),
                Field("with_branches", tr('Add SUCCESS / FAILED branches'), "bool", default=True),
            ],
        )
        if values is None:
            return
        node = make_node(
            NodeType.VERIFY, state=values["state"], timeout=values["timeout"] or 5.0,
            poll=values["poll"] or 0.4,
        )
        if not values["state"]:
            condition = ConditionEditor.ask(self, self)
            if condition is None:
                return
            node.condition = condition
        if values["with_branches"]:
            node.on_success = []
            node.on_failure = [make_node(NodeType.WAIT, seconds=1.0)]
        self._insert_node(node)

    def add_else_branch(self) -> None:
        node_id, _branch = self._selection
        node = self.project.workflow.find(node_id) if node_id else None
        if node is None or node.type is not NodeType.IF:
            messagebox.showinfo(tr('Select an IF'), tr('Select the IF step you want to extend.'))
            return
        answer = messagebox.askyesnocancel(
            tr('ADD ELSE'), tr('Add an ELSE IF branch with its own condition?\nChoose No for a plain ELSE.')
        )
        if answer is None:
            return
        if answer:
            condition = ConditionEditor.ask(self, self)
            if condition is None:
                return
            # The label identifies the branch when a step is inserted, so it has
            # to stay unique per IF node.
            node.elif_branches.append(
                Branch(f"ELSE IF {len(node.elif_branches) + 1}", [], condition)
            )
        elif not node.else_nodes:
            node.else_nodes.append(make_node(NodeType.WAIT, seconds=1.0))
        else:
            messagebox.showinfo(tr('ELSE exists'), tr('This IF already has an ELSE branch.'))
            return
        self.project.mark_dirty()
        self.refresh_workflow()

    def add_wait_node(self) -> None:
        values = FormDialog.ask(
            self, "WAIT",
            [
                Field("seconds", tr('Seconds'), "float", default=1.0),
                Field("until", tr('Wait until a condition instead'), "bool", default=False),
                Field("timeout", tr('Timeout (s)'), "float", default=10.0),
                Field("poll", tr('Check every (s)'), "float", default=0.4),
            ],
        )
        if values is None:
            return
        node = make_node(
            NodeType.WAIT, seconds=values["seconds"] or 1.0,
            timeout=values["timeout"] or 10.0, poll=values["poll"] or 0.4,
        )
        if values["until"]:
            condition = ConditionEditor.ask(self, self)
            if condition is None:
                return
            node.condition = condition
        self._insert_node(node)

    def add_retry_node(self) -> None:
        values = FormDialog.ask(
            self, "RETRY",
            [
                Field("attempts", tr('Attempts'), "int", default=3),
                Field("delay", tr('Delay between attempts (s)'), "float", default=1.0),
            ],
        )
        if values is None:
            return
        self._insert_node(make_node(
            NodeType.RETRY, attempts=max(1, int(values["attempts"])), delay=values["delay"] or 0.0,
            body=[], on_failure=[],
        ))

    def add_loop_node(self) -> None:
        values = FormDialog.ask(
            self, "LOOP",
            [
                Field("count", tr('Iterations (0 = while a condition holds)'), "int", default=3),
                Field("max_iterations", tr('Iteration limit'), "int", default=100),
            ],
        )
        if values is None:
            return
        node = make_node(
            NodeType.LOOP, count=max(0, int(values["count"])),
            max_iterations=max(1, int(values["max_iterations"])), body=[],
        )
        if node.count == 0:
            condition = ConditionEditor.ask(self, self)
            if condition is None:
                return
            node.condition = condition
            node.count = 1
        self._insert_node(node)

    def record_macro_node(self) -> None:
        self.record_named_macro(AUTH_MACRO)

    def record_named_macro(self, name: str) -> None:
        """Record clicks in LDPlayer and store them as a named macro, not STATE_A."""
        actions = RecorderDialog.ask(self, self)
        if not actions:
            return
        macro = self.project.ensure_macro(name)
        macro.actions = list(actions)
        bound = bind_typed_text_to_test_data(macro, self.project.test_data)
        self.project.mark_dirty()
        self.refresh_workflow()
        self.log.info("Recorded %s action(s) into %s", len(actions), name)
        if bound:
            self.log.info("Bound %s typed field(s) to test data variables", bound)

    def edit_named_macro(self, name: str) -> None:
        macro = self.project.ensure_macro(name)
        if not macro.actions:
            messagebox.showinfo(name, tr("This macro has no steps. Press Record first."))
            return
        lines = [f"{index + 1}. {action.describe()}" for index, action in enumerate(macro.actions)]
        messagebox.showinfo(name, "\n".join(lines) if lines else tr("(empty)"))

    def test_named_macro(self, name: str) -> None:
        """Play one macro without the rest of the workflow and without clicking if dry-run."""
        macro = self.project.ensure_macro(name)
        if not macro.actions:
            messagebox.showinfo(name, tr("This macro has no steps. Press Record first."))
            return
        if self.window is None:
            messagebox.showinfo(tr("No window"), tr("Select an LDPlayer instance first."))
            return
        context = self._build_context(dry_run=self.dry_run.get())
        if context is None:
            return
        self.log.info("Starting %s (test)", name)
        try:
            for action in macro.actions:
                self.log.info("Action: %s", action.describe())
                result = action.execute(context)
                if not result.success:
                    self.log.warning("%s: %s", name, result.detail)
                    break
            self.log.info("%s finished", name)
        finally:
            context.release()

    def capture_result_state(self, name: str) -> None:
        """CAPTURE ERROR/SUCCESS: small reference crop, stored in the project only."""
        if self.project.path is None:
            messagebox.showinfo(
                tr("Save the project"),
                tr("Save the project before capturing a result state."),
            )
            return
        state = self.project.ensure_result_state(name)
        if not pillow_available():
            messagebox.showinfo(
                tr("Pillow required"),
                tr("Selecting a region on screen needs Pillow (pip install Pillow)."),
            )
            return
        frame = self.grab_preview_frame()
        if frame is None:
            return
        selector = RegionSelector(self, frame, tr("Select the region to remember"))
        self.wait_window(selector)
        if selector.result is None:
            return
        area = selector.result.width * selector.result.height
        frame_area = max(1, frame.shape[0] * frame.shape[1])
        if area / frame_area > 0.45:
            if not messagebox.askyesno(
                tr("Region too large"),
                tr("The selection covers most of the screen. A small unique element "
                   "(error text, button) works better. Use it anyway?"),
            ):
                return
        values = FormDialog.ask(
            self, name,
            [Field("confidence", tr("Confidence"), "float", default=state.confidence or 0.85)],
        )
        if values is None:
            return
        ref_name = f"{name.lower()}_ref"
        patch = crop_copy(frame, selector.result)
        try:
            self.project.add_reference_image(
                patch, ref_name, source_size=(frame.shape[1], frame.shape[0])
            )
        except ProjectError as exc:
            messagebox.showerror(tr("Reference image"), str(exc))
            return
        from state_machine import ReferenceSpec
        from vision import Roi
        state.confidence = float(values["confidence"] or 0.85)
        state.references = [
            ReferenceSpec(
                image=ref_name,
                confidence=state.confidence,
                roi=Roi.from_pixels(selector.result, frame.shape[1], frame.shape[0]),
                source_size=(frame.shape[1], frame.shape[0]),
            )
        ]
        self.project.add_state(state)
        self.project.mark_dirty()
        self.refresh_states()
        self.refresh_workflow()
        self.log.success("Saved result state %s (confidence %.2f)", name, state.confidence)

    def test_state_detection(self, name: str) -> None:
        """Analyze the current screen only — no clicks."""
        if self.window is None:
            messagebox.showinfo(tr("No window"), tr("Select an LDPlayer instance first."))
            return
        context = self._build_context(dry_run=True)
        if context is None:
            return
        try:
            context.refresh()
            outcome = context.detect()
            score = float(outcome.scores.get(name, 0.0))
            match = outcome.matches.get(name)
            detected = name == outcome.state
            where = "-"
            if match is not None and match.rect is not None:
                where = f"{match.rect.x}/{match.rect.y}"
            self.log.info(
                "TEST %s | Detected: %s | Confidence: %.2f | Coordinates: %s",
                name, "YES" if detected else "NO", score, where,
            )
            messagebox.showinfo(
                tr("Test detection"),
                tr("State: %s\nDetected: %s\nConfidence: %.2f\nCoordinates: %s")
                % (name, tr("YES") if detected else tr("NO"), score, where),
            )
        except CaptureError as exc:
            messagebox.showerror(tr("Capture failed"), str(exc))
        finally:
            context.release()

    def edit_named_state(self, name: str) -> None:
        self.project.ensure_result_state(name)
        self._selected_state = name
        self.edit_state()

    def refresh_test_data(self) -> None:
        tree = getattr(self, "_test_data_tree", None)
        if tree is None:
            return
        tree.delete(*tree.get_children())
        data = self.project.test_data
        for index, row in enumerate(data.rows):
            values = []
            for column in data.columns:
                value = row.get(column, "")
                if data.is_sensitive(column) and value:
                    values.append("***")
                else:
                    values.append(value)
            tree.insert("", "end", iid=str(index), values=values)

    def add_test_row(self) -> None:
        data = self.project.test_data
        fields = [
            Field(column, column, "secret" if data.is_sensitive(column) else "str")
            for column in data.columns
        ]
        values = FormDialog.ask(self, tr("Test data row"), fields)
        if values is None:
            return
        data.rows.append({column: str(values.get(column) or "") for column in data.columns})
        self.project.mark_dirty()
        self.refresh_test_data()
        self.refresh_workflow()

    def delete_test_row(self) -> None:
        tree = getattr(self, "_test_data_tree", None)
        if tree is None:
            return
        selection = tree.selection()
        if not selection:
            return
        index = int(selection[0])
        if 0 <= index < len(self.project.test_data.rows):
            self.project.test_data.rows.pop(index)
            self.project.mark_dirty()
            self.refresh_test_data()

    def _on_hotkey_step(self) -> None:
        context = self._context
        if context is not None and getattr(context, "step_continue", None) is not None:
            context.step_continue.set()

    def store_reference_patch(
        self, patch: np.ndarray, frame_size: tuple[int, int], suggested_name: str
    ) -> str:
        """Store a patch captured while recording as a project reference image."""
        if self.project.path is None:
            return ""
        name = suggested_name
        index = 1
        while name in self.project.references:
            index += 1
            name = f"{suggested_name}_{index}"
        self.project.add_reference_image(patch, name, source_size=frame_size)
        return name

    def change_language(self, code: str) -> None:
        """Switch the interface language and rebuild the window."""
        if code == get_language():
            return
        set_language(code)
        self.project.settings.language = code
        self.project.mark_dirty()
        self.title(tr('LDPlayer Visual UI Tester'))
        self._rebuild_ui()
        self.log.info("Language changed to %s", language_label(code))

    def _rebuild_ui(self) -> None:
        selection = self._selection
        for child in list(self.winfo_children()):
            child.destroy()
        self._build_ui()
        self._selection = selection
        self._canvas.selection = selection
        self.refresh_states()
        self.refresh_workflow()
        self.refresh_test_data()
        for record in self.log.records():
            self._append_log(record)
        self._update_status()

    def add_stop_node(self) -> None:
        values = FormDialog.ask(
            self, "STOP", [Field("reason", tr('Reason'), "str", default="scenario finished")]
        )
        if values is None:
            return
        self._insert_node(make_node(NodeType.STOP, reason=values["reason"]))

    def edit_node(self) -> None:
        node_id, _branch = self._selection
        node = self.project.workflow.find(node_id) if node_id else None
        if node is None:
            return
        if node.type is NodeType.ACTION:
            action = ActionEditor.ask(self, self, node.action)
            if action is not None:
                node.action = action
        elif node.type is NodeType.IF:
            condition = ConditionEditor.ask(self, self, node.condition)
            if condition is not None:
                node.condition = condition
        elif node.type in (NodeType.WAIT, NodeType.VERIFY, NodeType.ANALYZE, NodeType.LOOP):
            fields = [
                Field("timeout", tr('Timeout (s)'), "float", default=node.timeout),
                Field("poll", tr('Check every (s)'), "float", default=node.poll),
                Field("seconds", tr('Wait seconds'), "float", default=node.seconds),
                Field("state", tr('State'), "choice", [""] + self.project.state_names(), node.state),
                Field("edit_condition", tr('Edit the condition too'), "bool", default=False),
            ]
            values = FormDialog.ask(self, node.type.value, fields)
            if values is None:
                return
            node.timeout = values["timeout"] or node.timeout
            node.poll = values["poll"] or node.poll
            node.seconds = values["seconds"] or node.seconds
            node.state = values["state"]
            if values["edit_condition"]:
                condition = ConditionEditor.ask(self, self, node.condition)
                if condition is not None:
                    node.condition = condition
        elif node.type is NodeType.RETRY:
            values = FormDialog.ask(
                self, "RETRY",
                [
                    Field("attempts", tr('Attempts'), "int", default=node.attempts),
                    Field("delay", tr('Delay (s)'), "float", default=node.delay),
                ],
            )
            if values is None:
                return
            node.attempts = max(1, int(values["attempts"]))
            node.delay = values["delay"] or 0.0
        elif node.type is NodeType.STOP:
            values = FormDialog.ask(self, "STOP", [Field("reason", tr('Reason'), "str", default=node.reason)])
            if values is None:
                return
            node.reason = values["reason"]
        elif node.type is NodeType.STATE:
            values = FormDialog.ask(
                self, "Run a state",
                [Field("state", tr('State'), "choice", self.project.state_names(), node.state)],
            )
            if values is None:
                return
            node.state = values["state"] or node.state
        self.project.mark_dirty()
        self.refresh_workflow()

    def delete_node(self) -> None:
        node_id, _branch = self._selection
        if not node_id:
            return
        if self.project.workflow.remove(node_id):
            self._selection = ("", "")
            self.project.mark_dirty()
            self.refresh_workflow()

    def move_node(self, delta: int) -> None:
        node_id, _branch = self._selection
        if node_id and self.project.workflow.move(node_id, delta):
            self.project.mark_dirty()
            self.refresh_workflow()

    def toggle_node(self) -> None:
        node_id, _branch = self._selection
        node = self.project.workflow.find(node_id) if node_id else None
        if node is None:
            return
        node.enabled = not node.enabled
        self.project.mark_dirty()
        self.refresh_workflow()

    # --------------------------------------------------------------- engine
    def _ocr(self) -> Any:
        """One OCR service for the whole session: loading a model is expensive."""
        from ocr import OcrService, create_engine

        settings = self.project.settings
        signature = (settings.ocr_engine, settings.ocr_language)
        if self._ocr_service is None or getattr(self._ocr_service, "signature", None) != signature:
            service = OcrService(
                create_engine(settings.ocr_engine, settings.ocr_language, log=self.log),
                log=self.log,
            )
            service.signature = signature  # type: ignore[attr-defined]
            self._ocr_service = service
        return self._ocr_service

    def _build_context(self, dry_run: bool | None = None) -> AnalysisContext | None:
        if self.window is None:
            return None
        self.project.settings.safety = self.safety.settings
        try:
            return create_context(
                self.project, self.window, safety=self.safety, log=self.log,
                dry_run=self.dry_run.get() if dry_run is None else dry_run,
                ocr_service=self._ocr(),
            )
        except CaptureError as exc:
            messagebox.showerror(tr('Capture backend'), str(exc))
            return None

    def _on_hotkey_start_pause(self) -> None:
        if self._engine_thread is not None and self._engine_thread.is_alive():
            self.safety.toggle_pause()
        else:
            self.start_engine()

    def start_engine(self) -> None:
        if self._engine_thread is not None and self._engine_thread.is_alive():
            self.safety.toggle_pause()
            return
        if self.window is None:
            messagebox.showinfo(tr('No window'), tr('Select an LDPlayer instance first.'))
            return
        problems = self.project.validate()
        if problems:
            self.validate_project()
            if not messagebox.askyesno(
                tr("Warnings"),
                tr("The project has warnings:\n\n%s\n\nStart anyway?")
                % "\n".join(problems[:6]),
            ):
                return
        self.project.pipeline.step_by_step = bool(self.step_by_step.get())
        context = self._build_context()
        if context is None:
            return
        self._context = context
        self.safety.reset()
        self.safety.start()
        mode = self.engine_mode.get()
        if mode == "states":
            runner: Any = StateMachineRunner(
                context, self.project.settings.runner, log=self.log,
                on_engine_state=lambda state, detail: self._queue.put(("engine_state", (state, detail))),
                on_step=lambda record: self._queue.put(("step", record)),
            )
        else:
            runner = WorkflowRunner(
                context, self.project.workflow, log=self.log,
                on_engine_state=lambda state, detail: self._queue.put(("engine_state", (state, detail))),
                on_step=lambda record: self._queue.put(("step", record)),
                on_node=lambda node: self._queue.put(("node", node.id)),
            )
        self._runner = runner
        self._engine_thread = threading.Thread(
            target=self._run_engine, args=(context, runner), name="engine", daemon=True
        )
        self._engine_thread.start()

    def _run_engine(self, context: AnalysisContext, runner: Any) -> None:
        try:
            report = runner.run()
            self._queue.put(("cycles", report.cycles))
            self._queue.put(("finished", report))
        except Exception as exc:  # pragma: no cover - reported to the user
            self.log.error("Engine error: %s", exc)
            self._queue.put(("finished", None))
        finally:
            self._queue.put(("frames", context.frames_analyzed))
            context.release()
            self.safety.finish("run ended")

    def _on_engine_finished(self, report: Any) -> None:
        self._status["engine"] = EngineState.STOPPED.value
        self._canvas.set_active("")
        if report is not None:
            self.log.info("Report: %s", report.summary())

    def stop_engine(self) -> None:
        self.safety.emergency_stop("F9 / STOP button")

    # ------------------------------------------------------------------ log
    def clear_log(self) -> None:
        self.log.clear()
        self._log_view.configure(state="normal")
        self._log_view.delete("1.0", "end")
        self._log_view.configure(state="disabled")

    def save_log(self) -> None:
        path = filedialog.asksaveasfilename(
            title=tr('Save the log'), defaultextension=".log",
            filetypes=[("Text log", "*.log *.txt")],
        )
        if not path:
            return
        Path(path).write_text("\n".join(self.log.lines()), encoding="utf-8")
        self.log.info("Log saved (text only)")

    def destroy(self) -> None:
        """Stop the update tick before the widgets go away."""
        self._closing = True
        if self._tick is not None:
            try:
                self.after_cancel(self._tick)
            except tk.TclError:  # pragma: no cover - already gone
                pass
            self._tick = None
        super().destroy()

    def _on_close(self) -> None:
        if self._engine_thread is not None and self._engine_thread.is_alive():
            self.safety.emergency_stop("application closing")
            self._engine_thread.join(timeout=2.0)
        if not self._confirm_discard():
            return
        self._closing = True
        self.hotkeys.stop()
        self.log.remove_listener(self._queue_log_record)
        self.destroy()


def run_gui(project: Project | None = None, log: EventLog | None = None, dry_run: bool = False) -> None:
    app = App(project=project, log=log, dry_run=dry_run)
    app.mainloop()
