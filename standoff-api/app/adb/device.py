"""ADB + UI Automator helpers for LDPlayer / Android emulator."""

from __future__ import annotations

import random
import re
import time
import xml.etree.ElementTree as ET
from typing import Callable, Optional

BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


class AdbDevice:
    def __init__(
        self,
        shell_fn: Callable[[str], str],
        log_fn: Callable[[str], None] | None = None,
        delay_min: float = 1.2,
        delay_max: float = 2.5,
    ) -> None:
        self.shell_fn = shell_fn
        self.log = log_fn or (lambda msg: None)
        self.delay_min = delay_min
        self.delay_max = delay_max

    def shell(self, command: str) -> str:
        return self.shell_fn(command)

    def rnd_delay(self) -> None:
        time.sleep(random.uniform(self.delay_min, self.delay_max))

    def tap(self, x: int, y: int, jitter: int = 3) -> None:
        tx = x + random.randint(-jitter, jitter)
        ty = y + random.randint(-jitter, jitter)
        self.shell(f"input tap {tx} {ty}")

    def tap_coord(self, coord: tuple[int, int]) -> None:
        self.tap(coord[0], coord[1])
        self.rnd_delay()

    def input_text(self, text: str) -> None:
        safe = (
            text.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace(" ", "%s")
            .replace("&", "\\&")
            .replace("|", "\\|")
            .replace(";", "\\;")
            .replace("<", "\\<")
            .replace(">", "\\>")
            .replace("(", "\\(")
            .replace(")", "\\)")
            .replace("'", "\\'")
        )
        self.shell(f'input text "{safe}"')

    def press_enter(self) -> None:
        self.shell("input keyevent 66")

    def uiautomator_dump(self) -> Optional[ET.Element]:
        dump_path = "/sdcard/window_dump.xml"
        self.shell(f"uiautomator dump {dump_path}")
        time.sleep(0.8)
        xml_raw = self.shell(f"cat {dump_path}")
        if not xml_raw or "<?xml" not in xml_raw:
            return None
        start = xml_raw.find("<?xml")
        try:
            return ET.fromstring(xml_raw[start:])
        except ET.ParseError:
            return None

    @staticmethod
    def node_center(node: ET.Element) -> Optional[tuple[int, int]]:
        bounds = node.attrib.get("bounds", "")
        m = BOUNDS_RE.match(bounds)
        if not m:
            return None
        x1, y1, x2, y2 = map(int, m.groups())
        return (x1 + x2) // 2, (y1 + y2) // 2

    @staticmethod
    def node_matches(node: ET.Element, search_type: str, value: str) -> bool:
        val = value.lower()
        if search_type == "text":
            return val in (node.attrib.get("text") or "").lower()
        if search_type == "content-desc":
            return val in (node.attrib.get("content-desc") or "").lower()
        if search_type == "resource-id":
            return val in (node.attrib.get("resource-id") or "").lower()
        return False

    def find_node(self, root: ET.Element, search_type: str, value: str) -> Optional[ET.Element]:
        needle = value.lower().strip()
        candidates: list[tuple[int, ET.Element]] = []
        for node in root.iter():
            if not self.node_matches(node, search_type, value):
                continue
            raw = (node.attrib.get("content-desc" if search_type == "content-desc" else search_type) or "").strip()
            score = 0
            if raw.lower() == needle:
                score += 10
            if node.attrib.get("clickable", "false") == "true":
                score += 5
            if search_type == "text":
                score += 2
            candidates.append((score, node))
        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

    @staticmethod
    def _parent_map(root: ET.Element) -> dict[ET.Element, ET.Element]:
        return {child: parent for parent in root.iter() for child in parent}

    def _clickable_target(self, node: ET.Element, root: ET.Element) -> ET.Element:
        parent_map = self._parent_map(root)
        current: Optional[ET.Element] = node
        while current is not None:
            if current.attrib.get("clickable", "false") == "true":
                return current
            current = parent_map.get(current)
        return node

    def find_text_nodes(
        self,
        root: ET.Element,
        labels: list[str],
        *,
        exact: bool = False,
    ) -> list[tuple[int, ET.Element, str]]:
        """Return UI nodes matched by visible text (text attribute first)."""
        needles = [label.lower().strip() for label in labels]
        found: list[tuple[int, ET.Element, str]] = []
        for node in root.iter():
            text = (node.attrib.get("text") or "").strip()
            if text:
                text_l = text.lower()
                for needle in needles:
                    matched = text_l == needle if exact else needle in text_l
                    if matched:
                        score = 20 if text_l == needle else 10
                        if len(text) > 40:
                            score -= 20
                        if node.attrib.get("clickable", "false") == "true":
                            score += 5
                        found.append((score, node, text))
                        break
        found.sort(key=lambda item: item[0], reverse=True)
        return found

    def click_text(
        self,
        labels: list[str],
        timeout: float = 20.0,
        *,
        exact: bool = False,
        tap_label: bool = False,
    ) -> bool:
        """Click only by visible text from UI dump (no coordinates fallback)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            root = self.uiautomator_dump()
            if root is not None:
                matches = self.find_text_nodes(root, labels, exact=exact)
                for _, node, matched_text in matches:
                    target = node if tap_label else self._clickable_target(node, root)
                    center = self.node_center(target)
                    if center:
                        self.log(f'Клик по тексту: "{matched_text}"')
                        self.tap(center[0], center[1])
                        self.rnd_delay()
                        return True
            time.sleep(1.0)
        wanted = ", ".join(f'"{label}"' for label in labels)
        self.log(f"Timeout: текст не найден ({wanted})")
        return False

    def fill_field_by_text(
        self,
        labels: list[str],
        text: str,
        timeout: float = 25.0,
        *,
        tap_label: bool = False,
    ) -> bool:
        """Focus input by clicking its visible label text, then type."""
        per_label = max(timeout / max(len(labels), 1), 4.0)
        for label in labels:
            if self.click_text([label], timeout=per_label, tap_label=tap_label):
                time.sleep(0.5)
                self.input_text(text)
                self.rnd_delay()
                return True
        return False

    def click_by_ui(
        self,
        search_type: str,
        value: str,
        timeout: float = 45.0,
    ) -> bool:
        if search_type == "text":
            return self.click_text([value], timeout=timeout)
        deadline = time.time() + timeout
        while time.time() < deadline:
            root = self.uiautomator_dump()
            if root is not None:
                node = self.find_node(root, search_type, value)
                if node is not None:
                    target = self._clickable_target(node, root)
                    center = self.node_center(target)
                    if center:
                        shown = (
                            node.attrib.get("content-desc" if search_type == "content-desc" else search_type)
                            or value
                        ).strip()
                        self.log(f'Клик по тексту: "{shown}"')
                        self.tap(center[0], center[1])
                        self.rnd_delay()
                        return True
            time.sleep(1.2)
        self.log(f'Timeout: "{value}" не найден')
        return False

    def wait_for(self, search_type: str, value: str, timeout: float = 30.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            root = self.uiautomator_dump()
            if root is not None and self.find_node(root, search_type, value) is not None:
                return True
            time.sleep(1.2)
        return False

    def fill_field(self, hints: list[str], text: str, *, text_only: bool = False) -> bool:
        if self.fill_field_by_text(hints, text, timeout=25.0):
            return True
        if text_only:
            return False
        for hint in hints:
            if self.click_by_ui("content-desc", hint, timeout=8):
                time.sleep(0.4)
                self.input_text(text)
                self.rnd_delay()
                return True
        root = self.uiautomator_dump()
        if root is not None:
            for node in root.iter():
                if "EditText" in node.attrib.get("class", ""):
                    center = self.node_center(node)
                    if center:
                        self.tap(center[0], center[1])
                        time.sleep(0.3)
                        self.input_text(text)
                        self.rnd_delay()
                        return True
        return False

    def find_and_click_text(self, labels: list[str], timeout: float = 20.0) -> bool:
        return self.click_text(labels, timeout=timeout)

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 400) -> None:
        self.shell(f"input swipe {x1} {y1} {x2} {y2} {duration_ms}")
        time.sleep(0.6)

    def scroll_down(self, screen_w: int = 1280, screen_h: int = 720) -> None:
        cx = screen_w // 2
        self.swipe(cx, int(screen_h * 0.72), cx, int(screen_h * 0.28), 450)

    def find_and_click_text_with_scroll(
        self,
        labels: list[str],
        timeout: float = 25.0,
        max_scrolls: int = 8,
        screen_w: int = 1280,
        screen_h: int = 720,
    ) -> bool:
        deadline = time.time() + timeout
        scrolls = 0
        while time.time() < deadline:
            if self.find_and_click_text(labels, timeout=2.5):
                return True
            if scrolls < max_scrolls:
                self.scroll_down(screen_w, screen_h)
                scrolls += 1
            else:
                time.sleep(1.0)
        return False

    def click_any(self, labels: list[str], timeout: float = 20.0) -> bool:
        return self.click_text(labels, timeout=timeout)

    def find_nodes_with_text(self, *needles: str) -> list[ET.Element]:
        root = self.uiautomator_dump()
        if root is None:
            return []
        out: list[ET.Element] = []
        lowered = [n.lower() for n in needles]
        for node in root.iter():
            text = (node.attrib.get("text") or "").lower()
            if any(n in text for n in lowered):
                if node.attrib.get("bounds"):
                    out.append(node)
        return out
