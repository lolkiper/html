"""OpenCV based visual recognition.

All functions work on in-memory BGR numpy arrays and return a
:class:`MatchResult` holding the confidence and the pixel coordinates of what
was found, so the engine can click the middle of a recognised element instead of
a hard coded position.

Regions of interest are stored normalized (0..1) which keeps a workflow valid
after the LDPlayer window is resized.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import cv2
import numpy as np

DEFAULT_THRESHOLD = 0.85
#: Scale factors tried around the expected template scale.
DEFAULT_SCALE_STEPS = (1.0, 0.95, 1.05, 0.9, 1.1)


class VisionError(RuntimeError):
    """Raised for malformed images or templates."""


@dataclass(frozen=True)
class PixelRect:
    """A rectangle in frame pixels."""

    x: int
    y: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.x + self.width

    @property
    def bottom(self) -> int:
        return self.y + self.height

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.width // 2, self.y + self.height // 2

    @property
    def area(self) -> int:
        return max(0, self.width) * max(0, self.height)

    def as_tuple(self) -> tuple[int, int, int, int]:
        return self.x, self.y, self.width, self.height

    def offset(self, dx: int, dy: int) -> "PixelRect":
        return PixelRect(self.x + dx, self.y + dy, self.width, self.height)

    def contains(self, x: float, y: float) -> bool:
        return self.x <= x < self.right and self.y <= y < self.bottom

    def iou(self, other: "PixelRect") -> float:
        ix = max(0, min(self.right, other.right) - max(self.x, other.x))
        iy = max(0, min(self.bottom, other.bottom) - max(self.y, other.y))
        intersection = ix * iy
        union = self.area + other.area - intersection
        return intersection / union if union else 0.0

    def __str__(self) -> str:  # pragma: no cover - diagnostics
        return f"{self.width}x{self.height}@({self.x},{self.y})"


@dataclass(frozen=True)
class Roi:
    """Normalized region of interest inside a frame."""

    x: float = 0.0
    y: float = 0.0
    width: float = 1.0
    height: float = 1.0
    name: str = ""

    @classmethod
    def full(cls) -> "Roi":
        return cls()

    def is_full(self) -> bool:
        return (self.x, self.y, self.width, self.height) == (0.0, 0.0, 1.0, 1.0)

    def clamped(self) -> "Roi":
        x = min(max(self.x, 0.0), 1.0)
        y = min(max(self.y, 0.0), 1.0)
        width = min(max(self.width, 0.0), 1.0 - x)
        height = min(max(self.height, 0.0), 1.0 - y)
        return Roi(x, y, width, height, self.name)

    def to_pixels(self, frame_width: int, frame_height: int) -> PixelRect:
        roi = self.clamped()
        x = int(round(roi.x * frame_width))
        y = int(round(roi.y * frame_height))
        width = max(1, int(round(roi.width * frame_width)))
        height = max(1, int(round(roi.height * frame_height)))
        width = min(width, max(1, frame_width - x))
        height = min(height, max(1, frame_height - y))
        return PixelRect(x, y, width, height)

    @classmethod
    def from_pixels(
        cls, rect: PixelRect | tuple[int, int, int, int], frame_width: int, frame_height: int, name: str = ""
    ) -> "Roi":
        if isinstance(rect, tuple):
            rect = PixelRect(*rect)
        if frame_width <= 0 or frame_height <= 0:
            return cls(name=name)
        return cls(
            rect.x / frame_width,
            rect.y / frame_height,
            rect.width / frame_width,
            rect.height / frame_height,
            name,
        ).clamped()

    def to_dict(self) -> dict[str, Any]:
        data = {"x": self.x, "y": self.y, "width": self.width, "height": self.height}
        if self.name:
            data["name"] = self.name
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Roi":
        if not data:
            return cls()
        return cls(
            float(data.get("x", 0.0)),
            float(data.get("y", 0.0)),
            float(data.get("width", 1.0)),
            float(data.get("height", 1.0)),
            str(data.get("name", "")),
        )

    def describe(self) -> str:
        if self.is_full():
            return "full screen"
        return f"ROI {self.width:.2f}x{self.height:.2f} at ({self.x:.2f},{self.y:.2f})"


@dataclass
class MatchResult:
    """Outcome of a recognition attempt."""

    found: bool = False
    confidence: float = 0.0
    rect: PixelRect | None = None
    label: str = ""
    method: str = ""
    frame_size: tuple[int, int] = (0, 0)
    scale: float = 1.0
    text: str = ""

    @property
    def center(self) -> tuple[int, int] | None:
        return self.rect.center if self.rect is not None else None

    @property
    def normalized_center(self) -> tuple[float, float] | None:
        if self.rect is None or not all(self.frame_size):
            return None
        cx, cy = self.rect.center
        return cx / self.frame_size[0], cy / self.frame_size[1]

    def describe(self) -> str:
        if not self.found:
            return f"{self.label or self.method or 'match'} not found (confidence={self.confidence:.2f})"
        where = f" at {self.rect}" if self.rect is not None else ""
        return f"{self.label or self.method or 'match'} confidence={self.confidence:.2f}{where}"

    def __bool__(self) -> bool:  # pragma: no cover - trivial
        return self.found


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def ensure_bgr(image: np.ndarray) -> np.ndarray:
    """Normalise any input to a 3 channel BGR array."""
    if image is None:
        raise VisionError("image is None")
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    if image.ndim == 3 and image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    if image.ndim == 3 and image.shape[2] == 3:
        return image
    raise VisionError(f"unsupported image shape {image.shape}")


def to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def frame_size(image: np.ndarray) -> tuple[int, int]:
    return int(image.shape[1]), int(image.shape[0])


def crop(image: np.ndarray, rect: PixelRect) -> np.ndarray:
    """Return a view of ``rect`` clipped to the image bounds."""
    height, width = image.shape[:2]
    x = max(0, min(int(rect.x), width))
    y = max(0, min(int(rect.y), height))
    w = max(0, min(int(rect.width), width - x))
    h = max(0, min(int(rect.height), height - y))
    return image[y : y + h, x : x + w]


def crop_roi(image: np.ndarray, roi: Roi | None) -> tuple[np.ndarray, PixelRect]:
    width, height = frame_size(image)
    if roi is None or roi.is_full():
        rect = PixelRect(0, 0, width, height)
        return image, rect
    rect = roi.to_pixels(width, height)
    return crop(image, rect), rect


def crop_copy(image: np.ndarray, rect: PixelRect) -> np.ndarray:
    """Copy a region out of a frame (used when the user captures a reference)."""
    return np.ascontiguousarray(crop(image, rect).copy())


def load_image(path: str | Path) -> np.ndarray:
    """Read a user provided reference image (unicode safe on Windows)."""
    path = Path(path)
    if not path.exists():
        raise VisionError(f"reference image not found: {path}")
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise VisionError(f"reference image could not be decoded: {path}")
    return image


def split_alpha(template: np.ndarray) -> tuple[np.ndarray, np.ndarray | None]:
    """Split a BGRA template into BGR plus a matching mask."""
    if template.ndim == 3 and template.shape[2] == 4:
        alpha = template[:, :, 3]
        mask = cv2.merge([alpha, alpha, alpha])
        return np.ascontiguousarray(template[:, :, :3]), mask
    return template, None


# --------------------------------------------------------------------------- #
# template matching
# --------------------------------------------------------------------------- #
def _scaled_template(template: np.ndarray, scale: float) -> np.ndarray | None:
    if abs(scale - 1.0) < 1e-3:
        return template
    height, width = template.shape[:2]
    new_width, new_height = int(round(width * scale)), int(round(height * scale))
    if new_width < 4 or new_height < 4:
        return None
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    return cv2.resize(template, (new_width, new_height), interpolation=interpolation)


def match_template(
    image: np.ndarray,
    template: np.ndarray,
    threshold: float = DEFAULT_THRESHOLD,
    roi: Roi | None = None,
    grayscale: bool = True,
    scales: Sequence[float] = (1.0,),
    base_scale: float = 1.0,
    label: str = "",
    use_mask: bool = True,
) -> MatchResult:
    """Locate ``template`` inside ``image``.

    ``base_scale`` is the ratio between the current frame width and the frame
    width the reference was captured at, so a reference stays usable after the
    emulator window is resized.  ``scales`` are relative steps tried around it.
    """
    if template is None or template.size == 0:
        raise VisionError("empty template")
    search_area, rect = crop_roi(image, roi)
    if search_area.size == 0:
        return MatchResult(False, 0.0, None, label, "template", frame_size(image))

    template_bgr, mask = split_alpha(template)
    if not use_mask:
        mask = None
    haystack = to_gray(search_area) if grayscale else ensure_bgr(search_area)
    needle_full = to_gray(template_bgr) if grayscale else ensure_bgr(template_bgr)
    mask_full = None
    if mask is not None:
        mask_full = to_gray(mask) if grayscale else mask

    best = MatchResult(False, 0.0, None, label, "template", frame_size(image))
    tried: set[tuple[int, int]] = set()
    for step in scales or (1.0,):
        scale = base_scale * step
        needle = _scaled_template(needle_full, scale)
        if needle is None:
            continue
        if needle.shape[0] > haystack.shape[0] or needle.shape[1] > haystack.shape[1]:
            # Template larger than the search area: shrink it to fit once.
            fit = min(haystack.shape[0] / needle.shape[0], haystack.shape[1] / needle.shape[1])
            needle = _scaled_template(needle, fit * 0.99)
            if needle is None:
                continue
            scale = scale * fit * 0.99
        key = (needle.shape[1], needle.shape[0])
        if key in tried:
            continue
        tried.add(key)
        needle_mask = None
        if mask_full is not None:
            needle_mask = _scaled_template(mask_full, needle.shape[1] / needle_full.shape[1])
        try:
            if needle_mask is not None and needle_mask.shape[:2] == needle.shape[:2]:
                scores = cv2.matchTemplate(
                    haystack, needle, cv2.TM_CCORR_NORMED, mask=needle_mask
                )
            else:
                scores = cv2.matchTemplate(haystack, needle, cv2.TM_CCOEFF_NORMED)
        except cv2.error:  # pragma: no cover - defensive
            continue
        scores = np.nan_to_num(scores, nan=0.0, posinf=0.0, neginf=0.0)
        _, max_value, _, max_location = cv2.minMaxLoc(scores)
        confidence = float(max_value)
        if confidence > best.confidence:
            found_rect = PixelRect(
                rect.x + int(max_location[0]),
                rect.y + int(max_location[1]),
                int(needle.shape[1]),
                int(needle.shape[0]),
            )
            best = MatchResult(
                found=confidence >= threshold,
                confidence=confidence,
                rect=found_rect,
                label=label,
                method="template",
                frame_size=frame_size(image),
                scale=scale,
            )
        if best.confidence >= 0.999:
            break
    best.found = best.confidence >= threshold
    return best


def match_all(
    image: np.ndarray,
    template: np.ndarray,
    threshold: float = DEFAULT_THRESHOLD,
    roi: Roi | None = None,
    grayscale: bool = True,
    max_results: int = 20,
    overlap: float = 0.3,
    label: str = "",
) -> list[MatchResult]:
    """Find every occurrence of a template (non maximum suppression applied)."""
    search_area, rect = crop_roi(image, roi)
    template_bgr, _ = split_alpha(template)
    haystack = to_gray(search_area) if grayscale else ensure_bgr(search_area)
    needle = to_gray(template_bgr) if grayscale else ensure_bgr(template_bgr)
    if needle.shape[0] > haystack.shape[0] or needle.shape[1] > haystack.shape[1]:
        return []
    scores = cv2.matchTemplate(haystack, needle, cv2.TM_CCOEFF_NORMED)
    scores = np.nan_to_num(scores, nan=0.0)
    candidates: list[MatchResult] = []
    ys, xs = np.where(scores >= threshold)
    for y, x in sorted(zip(ys, xs), key=lambda pos: -scores[pos[0], pos[1]]):
        candidate = PixelRect(rect.x + int(x), rect.y + int(y), needle.shape[1], needle.shape[0])
        if any(candidate.iou(existing.rect) > overlap for existing in candidates if existing.rect):
            continue
        candidates.append(
            MatchResult(
                True,
                float(scores[y, x]),
                candidate,
                label,
                "template",
                frame_size(image),
            )
        )
        if len(candidates) >= max_results:
            break
    return candidates


def template_similarity(image: np.ndarray, reference: np.ndarray, grayscale: bool = True) -> float:
    """Similarity of two images of the same subject, resized to a common size."""
    left = to_gray(image) if grayscale else ensure_bgr(image)
    right = to_gray(reference) if grayscale else ensure_bgr(reference)
    if left.size == 0 or right.size == 0:
        return 0.0
    if left.shape[:2] != right.shape[:2]:
        right = cv2.resize(right, (left.shape[1], left.shape[0]), interpolation=cv2.INTER_AREA)
    scores = cv2.matchTemplate(left, right, cv2.TM_CCOEFF_NORMED)
    return float(np.nan_to_num(scores).max())


# --------------------------------------------------------------------------- #
# colour / difference helpers
# --------------------------------------------------------------------------- #
def pixel_color(image: np.ndarray, x: int, y: int) -> tuple[int, int, int]:
    height, width = image.shape[:2]
    x = min(max(int(x), 0), width - 1)
    y = min(max(int(y), 0), height - 1)
    pixel = ensure_bgr(image)[y, x]
    return int(pixel[0]), int(pixel[1]), int(pixel[2])


def color_distance(left: Sequence[int], right: Sequence[int]) -> float:
    """Euclidean BGR distance normalised to 0..1."""
    diff = np.asarray(left, dtype=np.float32) - np.asarray(right, dtype=np.float32)
    return float(np.linalg.norm(diff) / (255.0 * math.sqrt(3)))


def find_color(
    image: np.ndarray,
    color: Sequence[int],
    tolerance: int = 30,
    roi: Roi | None = None,
    min_coverage: float = 0.02,
    label: str = "",
) -> MatchResult:
    """Locate the largest blob of a colour (useful for buttons or indicators)."""
    search_area, rect = crop_roi(image, roi)
    if search_area.size == 0:
        return MatchResult(False, 0.0, None, label, "color", frame_size(image))
    bgr = ensure_bgr(search_area)
    target = np.asarray(color[:3], dtype=np.int16)
    lower = np.clip(target - tolerance, 0, 255).astype(np.uint8)
    upper = np.clip(target + tolerance, 0, 255).astype(np.uint8)
    mask = cv2.inRange(bgr, lower, upper)
    coverage = float(mask.mean() / 255.0)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    found_rect = None
    if contours:
        largest = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(largest)
        found_rect = PixelRect(rect.x + x, rect.y + y, w, h)
    return MatchResult(
        found=coverage >= min_coverage and found_rect is not None,
        confidence=min(1.0, coverage / min_coverage) if min_coverage > 0 else coverage,
        rect=found_rect,
        label=label,
        method="color",
        frame_size=frame_size(image),
    )


def image_difference(left: np.ndarray, right: np.ndarray) -> float:
    """Mean absolute difference of two frames, normalised to 0..1."""
    a = to_gray(left)
    b = to_gray(right)
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA)
    return float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean() / 255.0)


def histogram_similarity(left: np.ndarray, right: np.ndarray) -> float:
    """Colour distribution similarity (0..1), robust to small layout shifts."""
    def histogram(image: np.ndarray) -> np.ndarray:
        hsv = cv2.cvtColor(ensure_bgr(image), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [50, 60], [0, 180, 0, 256])
        return cv2.normalize(hist, hist).flatten()

    score = cv2.compareHist(histogram(left), histogram(right), cv2.HISTCMP_CORREL)
    return float(max(0.0, min(1.0, (score + 1) / 2 if score < 0 else score)))


def feature_match(
    image: np.ndarray,
    template: np.ndarray,
    threshold: float = 0.5,
    roi: Roi | None = None,
    label: str = "",
    max_features: int = 800,
) -> MatchResult:
    """ORB feature matching: tolerant to scale changes and small rotations."""
    search_area, rect = crop_roi(image, roi)
    gray_scene = to_gray(search_area)
    gray_template = to_gray(split_alpha(template)[0])
    orb = cv2.ORB_create(nfeatures=max_features)
    kp_template, desc_template = orb.detectAndCompute(gray_template, None)
    kp_scene, desc_scene = orb.detectAndCompute(gray_scene, None)
    if desc_template is None or desc_scene is None or len(kp_template) < 4:
        return MatchResult(False, 0.0, None, label, "feature", frame_size(image))
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    raw_matches = matcher.knnMatch(desc_template, desc_scene, k=2)
    good = [pair[0] for pair in raw_matches if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance]
    confidence = len(good) / max(1, min(len(kp_template), len(kp_scene)))
    found_rect = None
    if good:
        points = np.array([kp_scene[match.trainIdx].pt for match in good], dtype=np.float32)
        x, y, w, h = cv2.boundingRect(points)
        found_rect = PixelRect(rect.x + int(x), rect.y + int(y), int(w), int(h))
    return MatchResult(
        found=confidence >= threshold and found_rect is not None,
        confidence=float(min(1.0, confidence)),
        rect=found_rect,
        label=label,
        method="feature",
        frame_size=frame_size(image),
    )


def edge_density(image: np.ndarray, roi: Roi | None = None) -> float:
    """Fraction of edge pixels; a cheap 'is something drawn here' probe."""
    area, _ = crop_roi(image, roi)
    if area.size == 0:
        return 0.0
    edges = cv2.Canny(to_gray(area), 80, 200)
    return float(edges.mean() / 255.0)
