"""OCR: text and number recognition on in-memory frames.

PaddleOCR is the default engine (as requested); Tesseract is supported as a
fallback and a null engine keeps the app usable when no OCR is installed.
Every result is mapped back to full-frame pixel coordinates so a recognised word
can be clicked directly.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from typing import Any, Iterable, Protocol, Sequence

import cv2
import numpy as np

from logger import EventLog, get_logger
from vision import MatchResult, PixelRect, Roi, crop_roi, ensure_bgr, frame_size, to_gray

NUMBER_PATTERN = re.compile(r"[-+]?\d{1,3}(?:[ ,]\d{3})+(?:[.,]\d+)?|[-+]?\d+(?:[.,]\d+)?")


class OcrError(RuntimeError):
    """Raised when an OCR engine cannot be initialised."""


@dataclass(frozen=True)
class TextLine:
    """One recognised text fragment."""

    text: str
    confidence: float
    rect: PixelRect

    @property
    def center(self) -> tuple[int, int]:
        return self.rect.center

    def normalized(self) -> str:
        return normalize_text(self.text)


@dataclass(frozen=True)
class Preprocess:
    """In-RAM preprocessing applied before recognition."""

    scale: float = 2.0
    grayscale: bool = True
    contrast: bool = True
    threshold: str = "none"  # none | otsu | adaptive
    invert: bool = False

    def apply(self, image: np.ndarray) -> tuple[np.ndarray, float]:
        result = image
        scale = 1.0
        if self.scale and abs(self.scale - 1.0) > 1e-3 and result.size:
            scale = float(self.scale)
            result = cv2.resize(
                result, None, fx=scale, fy=scale,
                interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA,
            )
        if self.grayscale:
            result = to_gray(result)
            if self.contrast:
                result = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(result)
            if self.threshold == "otsu":
                _, result = cv2.threshold(result, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            elif self.threshold == "adaptive":
                result = cv2.adaptiveThreshold(
                    result, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 5
                )
            if self.invert:
                result = cv2.bitwise_not(result)
            result = cv2.cvtColor(result, cv2.COLOR_GRAY2BGR)
        elif self.invert:
            result = cv2.bitwise_not(result)
        return result, scale

    def to_dict(self) -> dict[str, Any]:
        return {
            "scale": self.scale,
            "grayscale": self.grayscale,
            "contrast": self.contrast,
            "threshold": self.threshold,
            "invert": self.invert,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Preprocess":
        if not data:
            return cls()
        return cls(
            scale=float(data.get("scale", 2.0)),
            grayscale=bool(data.get("grayscale", True)),
            contrast=bool(data.get("contrast", True)),
            threshold=str(data.get("threshold", "none")),
            invert=bool(data.get("invert", False)),
        )

    def key(self) -> tuple:
        return (self.scale, self.grayscale, self.contrast, self.threshold, self.invert)


class OcrEngine(Protocol):
    name: str

    def read(self, image: np.ndarray) -> list[tuple[str, float, PixelRect]]:
        ...

    def available(self) -> bool:
        ...


class NullOcrEngine:
    """Used when no OCR backend is installed; conditions simply find nothing."""

    name = "none"

    def read(self, image: np.ndarray) -> list[tuple[str, float, PixelRect]]:
        return []

    def available(self) -> bool:
        return False


class PaddleOcrEngine:
    """PaddleOCR wrapper supporting both the 2.x and 3.x result formats."""

    name = "paddleocr"

    def __init__(self, language: str = "en", use_gpu: bool = False, log: EventLog | None = None) -> None:
        self.language = language
        self.use_gpu = use_gpu
        self.log = log or get_logger()
        self._engine: Any = None
        self._lock = threading.Lock()
        self._failed = False

    def _create(self) -> Any:
        from paddleocr import PaddleOCR  # imported lazily: heavy dependency

        attempts: list[dict[str, Any]] = [
            {"lang": self.language, "use_angle_cls": True, "show_log": False},
            {"lang": self.language, "use_angle_cls": True},
            {"lang": self.language},
        ]
        last_error: Exception | None = None
        for kwargs in attempts:
            try:
                return PaddleOCR(**kwargs)
            except (TypeError, ValueError) as exc:  # API differences between versions
                last_error = exc
        raise OcrError(f"PaddleOCR could not be initialised: {last_error}")

    def engine(self) -> Any:
        if self._engine is None and not self._failed:
            with self._lock:
                if self._engine is None and not self._failed:
                    try:
                        self.log.info("Loading PaddleOCR (lang=%s), first run may take a while", self.language)
                        self._engine = self._create()
                        self.log.success("PaddleOCR ready")
                    except Exception as exc:
                        self._failed = True
                        self.log.error("PaddleOCR unavailable: %s", exc)
        return self._engine

    def available(self) -> bool:
        try:
            import paddleocr  # noqa: F401
        except Exception:
            return False
        return not self._failed

    @staticmethod
    def _rect_from_polygon(polygon: Sequence[Sequence[float]]) -> PixelRect:
        points = np.asarray(polygon, dtype=np.float32).reshape(-1, 2)
        x, y, w, h = cv2.boundingRect(points)
        return PixelRect(int(x), int(y), int(w), int(h))

    def read(self, image: np.ndarray) -> list[tuple[str, float, PixelRect]]:
        engine = self.engine()
        if engine is None:
            return []
        array = ensure_bgr(image)
        try:
            raw = engine.ocr(array) if hasattr(engine, "ocr") else engine.predict(array)
        except TypeError:  # older signatures require cls=
            raw = engine.ocr(array, cls=True)
        except Exception as exc:  # pragma: no cover - engine specific
            self.log.error("OCR failed: %s", exc)
            return []
        return self._parse(raw)

    def _parse(self, raw: Any) -> list[tuple[str, float, PixelRect]]:
        lines: list[tuple[str, float, PixelRect]] = []
        if raw is None:
            return lines
        pages = raw if isinstance(raw, list) else [raw]
        for page in pages:
            if page is None:
                continue
            # PaddleOCR 3.x: dict with rec_texts / rec_scores / dt_polys
            if isinstance(page, dict):
                texts = page.get("rec_texts") or page.get("texts") or []
                scores = page.get("rec_scores") or page.get("scores") or []
                polygons = page.get("dt_polys") or page.get("rec_polys") or page.get("boxes") or []
                for index, text in enumerate(texts):
                    score = float(scores[index]) if index < len(scores) else 0.0
                    if index < len(polygons):
                        rect = self._rect_from_polygon(polygons[index])
                    else:  # pragma: no cover - defensive
                        rect = PixelRect(0, 0, 0, 0)
                    lines.append((str(text), score, rect))
                continue
            # PaddleOCR 2.x: [[box, (text, score)], ...]
            for entry in page:
                try:
                    box, payload = entry[0], entry[1]
                    text, score = payload[0], float(payload[1])
                    lines.append((str(text), score, self._rect_from_polygon(box)))
                except (TypeError, IndexError, ValueError):  # pragma: no cover - defensive
                    continue
        return lines


class TesseractOcrEngine:
    """pytesseract based engine (lighter alternative to PaddleOCR)."""

    name = "tesseract"

    def __init__(self, language: str = "eng", log: EventLog | None = None) -> None:
        self.language = language
        self.log = log or get_logger()
        self._failed = False

    def available(self) -> bool:
        try:
            import pytesseract  # noqa: F401
        except Exception:
            return False
        return not self._failed

    def read(self, image: np.ndarray) -> list[tuple[str, float, PixelRect]]:
        try:
            import pytesseract
            from PIL import Image
        except Exception as exc:
            if not self._failed:
                self.log.error("Tesseract unavailable: %s", exc)
            self._failed = True
            return []
        rgb = cv2.cvtColor(ensure_bgr(image), cv2.COLOR_BGR2RGB)
        data = pytesseract.image_to_data(
            Image.fromarray(rgb), lang=self.language, output_type=pytesseract.Output.DICT
        )
        lines: list[tuple[str, float, PixelRect]] = []
        for index, text in enumerate(data.get("text", [])):
            text = (text or "").strip()
            if not text:
                continue
            try:
                confidence = float(data["conf"][index]) / 100.0
            except (KeyError, ValueError):  # pragma: no cover - defensive
                confidence = 0.0
            rect = PixelRect(
                int(data["left"][index]),
                int(data["top"][index]),
                int(data["width"][index]),
                int(data["height"][index]),
            )
            lines.append((text, max(0.0, confidence), rect))
        return lines


def create_engine(
    name: str = "auto", language: str = "en", log: EventLog | None = None
) -> OcrEngine:
    """Instantiate an OCR engine; falls back gracefully when none is installed."""
    log = log or get_logger()
    name = (name or "auto").lower()
    if name in ("none", "null", "off"):
        return NullOcrEngine()
    if name in ("paddle", "paddleocr"):
        return PaddleOcrEngine(language=language, log=log)
    if name in ("tesseract", "pytesseract"):
        return TesseractOcrEngine(language="eng" if language == "en" else language, log=log)
    paddle = PaddleOcrEngine(language=language, log=log)
    if paddle.available():
        return paddle
    tesseract = TesseractOcrEngine(language="eng" if language == "en" else language, log=log)
    if tesseract.available():
        log.warning("PaddleOCR is not installed, using Tesseract")
        return tesseract
    log.warning("No OCR engine installed: text and number conditions will not match")
    return NullOcrEngine()


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip().casefold()


def extract_numbers(text: str) -> list[float]:
    """Pull numbers out of OCR text, tolerating thousand separators."""
    values: list[float] = []
    for raw in NUMBER_PATTERN.findall(text or ""):
        cleaned = raw.replace(" ", "").replace(",", "")
        if cleaned.count(".") > 1:
            cleaned = cleaned.replace(".", "", cleaned.count(".") - 1)
        try:
            values.append(float(cleaned))
        except ValueError:  # pragma: no cover - defensive
            continue
    return values


class OcrService:
    """Caching facade over an OCR engine.

    Results are cached per captured frame token so several conditions inspecting
    the same screen do not pay for OCR more than once.
    """

    def __init__(self, engine: OcrEngine | None = None, log: EventLog | None = None) -> None:
        self.engine: OcrEngine = engine or NullOcrEngine()
        self.log = log or get_logger()
        self._cache: dict[tuple, list[TextLine]] = {}
        self._cache_token: int | None = None
        self.calls = 0

    @property
    def engine_name(self) -> str:
        return getattr(self.engine, "name", "unknown")

    def available(self) -> bool:
        return bool(getattr(self.engine, "available", lambda: True)())

    def invalidate(self, token: int | None = None) -> None:
        self._cache.clear()
        self._cache_token = token

    # ------------------------------------------------------------------ read
    def read_lines(
        self,
        image: np.ndarray,
        roi: Roi | None = None,
        preprocess: Preprocess | None = None,
        frame_token: int | None = None,
        min_confidence: float = 0.0,
    ) -> list[TextLine]:
        preprocess = preprocess or Preprocess()
        roi = roi or Roi.full()
        if frame_token is not None and frame_token != self._cache_token:
            self.invalidate(frame_token)
        clamped = roi.clamped()
        cache_key = (
            clamped.x, clamped.y, clamped.width, clamped.height, preprocess.key()
        )
        if frame_token is not None and cache_key in self._cache:
            lines = self._cache[cache_key]
        else:
            area, rect = crop_roi(image, roi)
            if area.size == 0:
                return []
            prepared, scale = preprocess.apply(area)
            self.calls += 1
            lines = []
            for text, confidence, box in self.engine.read(prepared):
                if not (text or "").strip():
                    continue
                mapped = PixelRect(
                    rect.x + int(round(box.x / scale)),
                    rect.y + int(round(box.y / scale)),
                    max(1, int(round(box.width / scale))),
                    max(1, int(round(box.height / scale))),
                )
                lines.append(TextLine(text.strip(), float(confidence), mapped))
            if frame_token is not None:
                self._cache[cache_key] = lines
        if min_confidence > 0:
            return [line for line in lines if line.confidence >= min_confidence]
        return list(lines)

    def read_text(self, image: np.ndarray, roi: Roi | None = None, **kwargs: Any) -> str:
        return " ".join(line.text for line in self.read_lines(image, roi, **kwargs))

    # ------------------------------------------------------------------ find
    def find_text(
        self,
        image: np.ndarray,
        needle: str,
        roi: Roi | None = None,
        min_confidence: float = 0.6,
        regex: bool = False,
        ignore_case: bool = True,
        whole_line: bool = False,
        preprocess: Preprocess | None = None,
        frame_token: int | None = None,
    ) -> MatchResult:
        """Search recognised text; the result carries the matching line's box."""
        lines = self.read_lines(
            image, roi, preprocess=preprocess, frame_token=frame_token
        )
        size = frame_size(image)
        best = MatchResult(False, 0.0, None, needle, "text", size)
        if not lines:
            return best
        if regex:
            flags = re.IGNORECASE if ignore_case else 0
            try:
                pattern = re.compile(needle, flags)
            except re.error as exc:
                self.log.error("Invalid text pattern: %s", exc)
                return best
        else:
            wanted = normalize_text(needle) if ignore_case else (needle or "").strip()
        for line in lines:
            haystack = line.normalized() if ignore_case else line.text.strip()
            if regex:
                hit = bool(pattern.fullmatch(haystack) if whole_line else pattern.search(line.text))
            else:
                hit = haystack == wanted if whole_line else wanted in haystack
            if hit and line.confidence > best.confidence:
                best = MatchResult(
                    found=line.confidence >= min_confidence,
                    confidence=line.confidence,
                    rect=line.rect,
                    label=needle,
                    method="text",
                    frame_size=size,
                    text=line.text,
                )
        return best

    def find_number(
        self,
        image: np.ndarray,
        roi: Roi | None = None,
        min_confidence: float = 0.6,
        index: int = 0,
        preprocess: Preprocess | None = None,
        frame_token: int | None = None,
    ) -> tuple[float | None, MatchResult]:
        """Return the ``index``-th number found in the region and its position."""
        lines = self.read_lines(image, roi, preprocess=preprocess, frame_token=frame_token)
        size = frame_size(image)
        collected: list[tuple[float, TextLine]] = []
        for line in lines:
            for value in extract_numbers(line.text):
                collected.append((value, line))
        if not collected:
            return None, MatchResult(False, 0.0, None, "number", "number", size)
        if index < 0 or index >= len(collected):
            index = 0
        value, line = collected[index]
        return value, MatchResult(
            found=line.confidence >= min_confidence,
            confidence=line.confidence,
            rect=line.rect,
            label=f"number {value:g}",
            method="number",
            frame_size=size,
            text=line.text,
        )
