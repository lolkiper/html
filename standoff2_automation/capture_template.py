"""Capture UI templates from emulator screenshots (1280x720).

Run once after setting emulator resolution:
    python capture_template.py screenshot.png google_sign_in 100 200 400 280

This crops region (x1,y1,x2,y2) from screenshot and saves to templates/.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2

from config import TEMPLATES_DIR


def main() -> None:
    if len(sys.argv) != 7:
        print(
            "Usage: python capture_template.py <screenshot.png> <name> x1 y1 x2 y2",
            file=sys.stderr,
        )
        sys.exit(1)

    src = Path(sys.argv[1])
    name = sys.argv[2]
    x1, y1, x2, y2 = map(int, sys.argv[3:7])

    img = cv2.imread(str(src))
    if img is None:
        print(f"Cannot read {src}", file=sys.stderr)
        sys.exit(1)

    crop = img[y1:y2, x1:x2]
    TEMPLATES_DIR.mkdir(exist_ok=True)
    out = TEMPLATES_DIR / f"{name}.png"
    cv2.imwrite(str(out), crop)
    print(f"Saved {out} ({crop.shape[1]}x{crop.shape[0]})")


if __name__ == "__main__":
    main()
