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
        for node in root.iter():
            if self.node_matches(node, search_type, value):
                if node.attrib.get("clickable", "false") == "true" or node.attrib.get("bounds"):
                    return node
        for node in root.iter():
            if self.node_matches(node, search_type, value):
                return node
        return None

    def click_by_ui(
        self,
        search_type: str,
        value: str,
        timeout: float = 45.0,
    ) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            root = self.uiautomator_dump()
            if root is not None:
                node = self.find_node(root, search_type, value)
                if node is not None:
                    center = self.node_center(node)
                    if center:
                        self.log(f'Клик: "{value}"')
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

    def fill_field(self, hints: list[str], text: str) -> bool:
        for hint in hints:
            if self.click_by_ui("text", hint, timeout=15):
                time.sleep(0.4)
                self.input_text(text)
                self.rnd_delay()
                return True
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

    def click_any(self, labels: list[str], timeout: float = 20.0) -> bool:
        for label in labels:
            if self.click_by_ui("text", label, timeout=timeout / max(len(labels), 1)):
                return True
        return False

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
