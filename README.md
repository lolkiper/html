# LDPlayer Visual UI Tester

A Windows application for automated UI testing of Android apps running in
**LDPlayer**.  It is a *visual* automation engine, not a macro recorder: it looks
at the emulator window, decides which screen is currently shown, performs the
action that belongs to that screen, checks the result and only then chooses the
next branch.

```
ANALYZE SCREEN  ->  DETECT CURRENT STATE  ->  EXECUTE ACTION  ->  VERIFY RESULT  ->  SELECT NEXT STATE
```

Captured frames never touch the disk:

```
LDPlayer -> capture -> RAM -> OpenCV / OCR -> result -> release memory
```

Русская документация: [README.ru.md](README.ru.md). The interface itself is
Russian by default and can be switched to English in the toolbar.

No `screenshots/`, `temp/` or `cache_images/` directory is ever created, and no
image data is written to the log.  The only images stored on disk are the
reference images **you** add to a project.

---

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [How recognition works](#how-recognition-works)
- [Recording a macro](#recording-a-macro)
- [Visual states](#visual-states)
- [Scenarios: conditions, actions, verification](#scenarios-conditions-actions-verification)
- [State machine mode](#state-machine-mode)
- [Safety](#safety)
- [Storage layout](#storage-layout)
- [Command line](#command-line)
- [Architecture](#architecture)
- [Tests](#tests)

---

## Installation

Requires Python 3.11 or newer on Windows (the engine also runs on Linux against
a screen region, which is how its test suite exercises the full pipeline).
Install Python from [python.org](https://www.python.org/downloads/windows/) with
**Add python.exe to PATH** ticked.

Download the code as a ZIP from GitHub (**Code → Download ZIP**) or clone it:

```bat
git clone https://github.com/lolkiper/html.git
cd html
```

Then double-click **`run.bat`**, which creates the virtual environment, installs
the dependencies on first start and launches the app. The manual equivalent:

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

OCR is optional and is a large download, so it is kept separate. Install it only
if you need the text or number conditions:

```bat
pip install -r requirements-ocr.txt
```

Notes on the dependencies:

| Package | Used for | File |
|---|---|---|
| `numpy`, `opencv-python` | frame handling, template / colour / feature matching | `requirements.txt` |
| `pyautogui` | mouse and keyboard input (dry run works without it) | `requirements.txt` |
| `Pillow` | decoding reference images, preview in the editor | `requirements.txt` |
| `mss` | capture fallback / screen-region capture | `requirements.txt` |
| `pyperclip` | typing non-ASCII text | `requirements.txt` |
| `pynput` | the macro recorder | `requirements.txt` |
| `paddleocr` + `paddlepaddle` | OCR for text and number conditions | `requirements-ocr.txt` |
| `pytesseract` | lighter OCR alternative | install on demand |
| `pytest` | running the tests | `requirements-dev.txt` |

If no OCR engine is installed the app still runs; text and number conditions
simply never match and a warning is written to the log.  Tkinter ships with
CPython on Windows, so the GUI needs no extra install.

---

## Quick start

1. Start the LDPlayer instance you want to test.
2. Run `python main.py`.
3. Pick the instance in the **LDPlayer** list and press **Select**.  If discovery
   finds nothing (for example a heavily customised window title), use
   **Screen region...** and give the rectangle by hand.
4. Create the screens you want to recognise: **ADD STATE**, then
   **From current screen...** and drag a rectangle around something
   characteristic (a button, a banner, an error icon).  That crop is stored as
   the reference image of the state, together with the confidence threshold.
5. Use **Detection test → Analyze the current screen** to see the confidence of
   every state against the live screen.  Tune the thresholds until the right
   state wins clearly.
6. Build the scenario in the centre panel with **ADD CONDITION**, **ADD ACTION**,
   **ADD VERIFY**, **ADD ELSE**, **ADD WAIT**, **ADD RETRY**, ...
7. Press **START (F8)**.  **F9** stops everything immediately.

Tip: switch on **Dry run** first.  The engine then analyses, decides and logs
exactly what it would do, without moving the mouse.

---

## Recording a macro

**RECORD MACRO** in the scenario panel, or **Record...** in the state editor,
opens the recorder: press *Start recording*, perform the combination in LDPlayer,
press **F10**, then *Use the recording*.

Raw input is condensed into meaningful actions:

| What you did | What was recorded |
|---|---|
| press and release on one spot | Left Click |
| two quick clicks | Double Click |
| press here, release far away | Drag |
| Ctrl+A and friends | Hotkey |
| a run of characters | one Type Text action |
| a gap between actions | a Wait of the same length |
| anything outside the emulator window | ignored |

Positions are stored relative to the window (0..1), so a recording keeps working
after the emulator is moved or resized.  With **Anchor clicks to images** the
recorder also keeps a small patch of what was clicked, stores it as a reference
image and clicks the element the engine finds - which is what makes this a visual
macro rather than a coordinate replay.

To run a different combination per screen, record one into each state
(`REWARD_SCREEN`, `ERROR_SCREEN`, ...) and let the scenario dispatch on the
detected state, or use the *states* engine mode, which walks the state table on
its own.

Recording needs the `pynput` package (part of `requirements.txt`).

---

## How recognition works

Everything is relative to the selected window, and the window is re-measured
before every capture, so moving or resizing LDPlayer mid-run is safe:

- targets are stored **normalized** (`0..1`) inside the client area;
- a reference image remembers the window size it was captured at, so it is
  re-scaled automatically when the window size changes (a reference taken at
  360x560 is still found at 288x448);
- every action is bounds-checked against the current client rectangle, so the
  engine cannot click outside the emulator;
- a region of interest (ROI) is normalized too, which keeps a "top right corner"
  ROI meaningful at any window size.

Available recognition methods:

| Method | Condition | Notes |
|---|---|---|
| Template matching | `Reference image visible` | multi-scale, alpha masks, per-ROI, returns the element position |
| Feature matching (ORB) | `match_mode = feature` | tolerant to scale and small rotation |
| Histogram similarity | `match_mode = histogram` | whole-screen "does it look like this" check |
| OCR text | `Text visible` | substring, whole line, or regular expression |
| OCR numbers | `Number comparison` | `>=`, `<`, ... against a recognised number |
| Pixel colour | `Pixel colour` | single normalized position with tolerance |
| Colour coverage | `Colour present in region` | e.g. "the button turned green" |
| Frame difference | `Screen changed` | detects any visual change since the last cycle |

Each result carries a confidence and, when something was located, its
rectangle - so an action can click the **centre of what was just recognised**
instead of a fixed coordinate.

---

## Visual states

A state is one screen the engine can recognise, plus what to do about it:

| Field | Meaning |
|---|---|
| name / description | e.g. `STATE_B`, "error message screen" |
| reference images | one or many, each with its own confidence and ROI |
| condition | extra logic ANDed with the images (OCR, colour, variables, AND/OR/NOT) |
| images must match | `any` (default) or `all` |
| confidence | threshold this state must reach to be considered detected |
| timeout | how long the engine waits for this state |
| retry count / delay | how often the actions are repeated when verification fails |
| cooldown | minimum pause before this state may act again |
| actions | what to do when the state is detected |
| expected result | the state (or condition) that must appear afterwards |
| verification timeout | how long to wait for that result |
| fallback | state to run when all retries failed, or `STOP` |
| next state | the state to wait for in the next cycle |
| terminal | a successful run ends here |

Example, matching the specification:

```
STATE_A   reference image   confidence 0.85   -> expected STATE_C, fallback STATE_B
STATE_B   reference image   confidence 0.85   -> error screen, fallback STOP
STATE_C   reference image   confidence 0.85   -> success screen
UNKNOWN   nothing matched                     -> wait and analyse again
```

`UNKNOWN` is a real state: if you define it with actions, those actions run
whenever nothing is recognised (for example "press Back and analyse again").

---

## Scenarios: conditions, actions, verification

The scenario is a tree, displayed and edited as a diagram:

```
START
↓
ANALYZE SCREEN
↓
IF STATE STATE_A detected
├── YES
│   ↓
│   LEFT CLICK -> element of state 'STATE_A'
│   ↓
│   VERIFY state STATE_C (timeout 6s)
├── ELSE IF STATE STATE_B detected
│   ↓
│   LEFT CLICK -> element of state 'STATE_B'
└── ELSE
    ↓
    WAIT 1s
    ↓
    RETRY x3 (delay 1s)
    └── BODY
        ↓
        ANALYZE (wait for STATE_A, timeout 8s)
```

Supported control flow: `IF`, `ELSE IF`, `ELSE`, `AND`, `OR`, `NOT`, `WAIT`,
`WAIT UNTIL`, `RETRY`, `TIMEOUT`, `VERIFY`, `LOOP`, `STOP`.

Supported actions: `Move Mouse`, `Left Click`, `Double Click`, `Right Click`,
`Drag`, `Press Key`, `Hotkey`, `Type Text`, `Wait`, `Wait Until`, `Verify`,
`Repeat`, `Stop`, `Set Variable`, `Log Message`.

Every pointer action has a target, which is either

1. **a position inside the selected window** (normalized, or exact pixels), or
2. **the position of something recognised**: the last match, a reference image,
   a text found by OCR, or the element that identified the current state -
   `detect STATE_A -> object coordinates = X,Y -> click centre`.

Targets also support an offset, a `center`/`topleft` anchor and a minimum
confidence, and clicks are refused when that confidence is not reached.

### Verification

After the actions the engine captures a **new** frame, analyses it, detects the
state, compares it with the expectation and records the result:

```
[19:30:01] State detected: SCREEN_A, confidence=0.94
[19:30:01] Click at window (179,250) [element of state 'SCREEN_A', confidence=0.94]
[19:30:02] Verification started
[19:30:02] State detected: SCREEN_B
[19:30:02] Verification: SUCCESS
```

and when the expected screen does not appear:

```
[19:30:05] Verification: FAILED (expected SCREEN_B, observed SCREEN_A)
[19:30:05] Retry 1/3
```

---

## State machine mode

Instead of a scenario tree you can let the engine drive the state table itself
(**Engine mode: states**).  It then loops:

```
IDLE -> WAITING_FOR_STATE -> STATE_DETECTED -> ACTION -> VERIFY
                                     ├── SUCCESS -> NEXT
                                     ├── FAILED  -> FALLBACK
                                     └── UNKNOWN -> RETRY
```

The current engine state, the detected state, its confidence, the analysed frame
count and the cycle count are shown in the status bar.

---

## Safety

- **F8** start / pause / resume, **F9** emergency stop.  On Windows both are
  registered globally, so they work while LDPlayer has the focus; the GUI binds
  them as well.
- Before **every** pointer or keyboard action the engine checks that the window
  still exists, is not minimised and has a usable size; that the target point is
  inside the window; that the confidence reaches the threshold; and that the
  recognition is not ambiguous (two states matching within the ambiguity margin
  cancel the action instead of guessing).
- Cooldowns per target and per state, plus a global actions-per-minute limit.
- PyAutoGUI's fail-safe stays enabled: moving the pointer into a screen corner
  aborts the run.
- **Dry run** performs the whole analysis without sending input.
- Text marked *sensitive* is redacted everywhere in the log (only its length is
  reported), and it can be supplied through a runtime variable so it is not
  stored in the project file at all.
- The log never receives image data: frames, buffers and PIL images are replaced
  by `<image omitted>`.

---

## Storage layout

Workflow configuration is separate from anything temporary:

```
MyTest.ldproj/
    project.json        states, scenario, settings (human readable)
    references/         only the reference images you added yourself
```

Captured frames stay in RAM (`Frame.release()` zeroes and drops the buffer).
`Project.audit_storage()` - also available in the GUI through **Check the
project** - verifies that no captured-frame artefacts appeared next to a
project, and the test suite asserts the same rule against the source code.

---

## Command line

```bash
python main.py                                            # GUI
python main.py --list-instances                           # list LDPlayer windows
python main.py --project MyTest.ldproj                    # GUI with a project
python main.py --project MyTest.ldproj --print-workflow    # print the scenario tree
python main.py --project MyTest.ldproj --analyze           # one detection cycle
python main.py --project MyTest.ldproj --run               # headless run
python main.py --project MyTest.ldproj --run --dry-run --max-cycles 5
python main.py --project MyTest.ldproj --run --region 120,90,360,560
```

Useful flags: `--instance` (index, handle or part of the title), `--mode
workflow|states`, `--start-state`, `--duration`, `--log-file`, `--log-level`,
`--lang ru|en`.
The exit code is `0` when no step failed, `1` otherwise, so a scenario can be
used as a CI check.

---

## Architecture

| Module | Responsibility |
|---|---|
| `main.py` | CLI, headless run, GUI start |
| `gui.py` | scenario editor, state editor, live log, engine control |
| `ldplayer.py` | window discovery, live geometry, coordinate mapping |
| `screen_capture.py` | RAM-only capture (PrintWindow / BitBlt, `mss` fallback) |
| `vision.py` | OpenCV matching, ROIs, colour and difference metrics |
| `ocr.py` | PaddleOCR / Tesseract, text and number search |
| `state_machine.py` | state definitions, detector, autonomous runner, runtime context |
| `conditions.py` | IF / AND / OR / NOT predicates over the current frame |
| `actions.py` | actions, targets, verification |
| `workflow.py` | scenario tree, execution, outline rendering |
| `mouse.py`, `keyboard.py` | window-relative input, global hotkeys |
| `safety.py` | pre-action checks, cooldowns, run/pause/stop |
| `project.py` | project storage and reference images |
| `recorder.py` | records real input and condenses it into actions |
| `logger.py` | text-only log with redaction |
| `i18n.py` | interface and log translations |

---

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

The suite runs the complete engine against a synthetic emulator that reacts to
clicks, so detection, verification, retries, fallbacks, branching and the safety
rules are all covered without a real LDPlayer.  It also enforces the storage
policy: the frame-handling modules are parsed and must not contain any image
writing call, and a full workflow run must leave the filesystem untouched.
