"""Entry point.

Examples::

    python main.py                                  # start the GUI
    python main.py --list-instances                 # show LDPlayer windows
    python main.py --project MyTest.ldproj          # GUI with a project loaded
    python main.py --project MyTest.ldproj --run    # run headless
    python main.py --project MyTest.ldproj --run --dry-run
    python main.py --project MyTest.ldproj --print-workflow
    python main.py --project MyTest.ldproj --analyze # one detection cycle, then exit
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import ldplayer
from keyboard import install_safety_hotkeys
from logger import EventLog, LogLevel, LogRecord, get_logger, set_logger
from project import Project, ProjectError, example_project
from safety import SafetyController, audit_no_frame_artifacts
from screen_capture import CaptureError
from state_machine import StateMachineRunner, create_context
from workflow import WorkflowRunner, outline_text

BANNER = "LDPlayer Visual UI Tester"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="main.py", description=f"{BANNER} - visual UI automation for LDPlayer"
    )
    parser.add_argument("--project", "-p", help="project folder (*.ldproj) to load")
    parser.add_argument("--run", action="store_true", help="run the project without the GUI")
    parser.add_argument("--analyze", action="store_true", help="analyse one frame and exit")
    parser.add_argument("--list-instances", action="store_true", help="list LDPlayer windows")
    parser.add_argument("--print-workflow", action="store_true", help="print the scenario tree")
    parser.add_argument("--instance", help="LDPlayer window: index, handle or part of the title")
    parser.add_argument(
        "--region", help="use a screen region instead of a window: LEFT,TOP,WIDTH,HEIGHT"
    )
    parser.add_argument("--mode", choices=("workflow", "states"), help="engine mode override")
    parser.add_argument("--start-state", default="", help="state to wait for first (states mode)")
    parser.add_argument("--max-cycles", type=int, help="stop after N cycles")
    parser.add_argument("--duration", type=float, help="stop after N seconds")
    parser.add_argument(
        "--dry-run", action="store_true", help="analyse and decide, but do not click or type"
    )
    parser.add_argument("--log-file", help="write the text log to this file")
    parser.add_argument("--log-level", default="INFO",
                        choices=("DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR"))
    parser.add_argument("--no-gui", action="store_true", help="never open the GUI")
    return parser


def configure_logging(level: str, log_file: str | None) -> EventLog:
    log = EventLog(level=LogLevel.parse(level), file_path=log_file)
    set_logger(log)
    return log


def echo(record: LogRecord) -> None:
    print(record.format(), flush=True)


def load_project(path: str | None, log: EventLog) -> Project:
    if not path:
        return example_project()
    return Project.load(path, log=log)


def select_window(args: argparse.Namespace, project: Project, log: EventLog):
    if args.region:
        try:
            left, top, width, height = (int(part) for part in args.region.split(","))
        except ValueError:
            raise SystemExit("--region expects LEFT,TOP,WIDTH,HEIGHT")
        return ldplayer.manual_window(left, top, width, height, log=log)
    query = args.instance if args.instance is not None else (project.settings.window_hint or None)
    instances = ldplayer.enumerate_windows()
    if not instances:
        raise SystemExit(
            "No LDPlayer window found. Start an instance, or pass --region LEFT,TOP,WIDTH,HEIGHT."
        )
    instance = ldplayer.find_instance(query, instances)
    if instance is None:
        listing = "\n".join(f"  [{index}] {item.label}" for index, item in enumerate(instances))
        raise SystemExit(f"No LDPlayer window matches {query!r}. Available:\n{listing}")
    log.success("LDPlayer selected: %s", instance.label)
    return instance.open(log=log, insets=project.settings.window_insets)


def list_instances(log: EventLog) -> int:
    instances = ldplayer.enumerate_windows()
    if not instances:
        print("No LDPlayer window found.")
        if not sys.platform.startswith("win"):
            print("Window discovery requires Windows; use --region on other systems.")
        return 1
    print(f"{len(instances)} LDPlayer window(s):")
    for index, instance in enumerate(instances):
        print(f"  [{index}] {instance.label}")
    return 0


def run_headless(args: argparse.Namespace, project: Project, log: EventLog) -> int:
    window = select_window(args, project, log)
    safety = SafetyController(project.settings.safety, log=log)
    hotkeys = install_safety_hotkeys(safety, log=log)
    hotkeys.start()
    context = create_context(project, window, safety=safety, log=log, dry_run=args.dry_run)
    if args.dry_run:
        log.warning("Dry run: recognition runs, but no click or keystroke is sent")
    mode = args.mode or project.settings.engine_mode
    if args.max_cycles is not None:
        project.settings.runner.max_cycles = args.max_cycles
        project.workflow.settings.max_cycles = args.max_cycles
    if args.duration is not None:
        project.settings.runner.max_duration = args.duration
        project.workflow.settings.max_duration = args.duration
    problems = project.validate()
    for problem in problems:
        log.warning("Project warning: %s", problem)
    safety.start()
    try:
        if mode == "states":
            report = StateMachineRunner(context, project.settings.runner, log=log).run(
                start_state=args.start_state
            )
        else:
            report = WorkflowRunner(context, project.workflow, log=log).run()
    except CaptureError as exc:
        log.error("Capture failed: %s", exc)
        return 2
    finally:
        context.release()
        hotkeys.stop()
    print()
    print(f"Result: {report.summary()}")
    if report.stop_reason:
        print(f"Stopped because: {report.stop_reason}")
    if project.path is not None:
        leftovers = audit_no_frame_artifacts(project.path)
        if leftovers:  # pragma: no cover - would indicate a policy violation
            print("WARNING, unexpected image artefacts found:")
            for item in leftovers:
                print(f"  {item}")
    return 0 if report.failures == 0 else 1


def analyze_once(args: argparse.Namespace, project: Project, log: EventLog) -> int:
    window = select_window(args, project, log)
    safety = SafetyController(project.settings.safety, log=log)
    context = create_context(project, window, safety=safety, log=log, dry_run=True)
    safety.start()
    try:
        context.refresh()
        outcome = context.detect()
    except CaptureError as exc:
        log.error("Capture failed: %s", exc)
        return 2
    finally:
        window_size = window.client_size
        context.release()
    print()
    print(f"Window: {window.title} {window_size[0]}x{window_size[1]}")
    print(f"Detected state: {outcome.describe()}")
    if outcome.scores:
        print("Scores:")
        for name, confidence in sorted(outcome.scores.items(), key=lambda item: -item[1]):
            match = outcome.matches.get(name)
            where = f" at {match.rect}" if match is not None and match.rect else ""
            print(f"  {name:<24} {confidence:.3f}{where}")
    else:
        print("No state defines a detection rule yet.")
    return 0 if outcome.known else 1


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    log = configure_logging(args.log_level, args.log_file)
    headless = args.run or args.analyze or args.list_instances or args.print_workflow or args.no_gui
    if headless:
        log.add_listener(echo)
    log.info("%s starting (frames are analysed in RAM and never stored)", BANNER)

    if args.list_instances:
        return list_instances(log)

    try:
        project = load_project(args.project, log)
    except ProjectError as exc:
        raise SystemExit(str(exc))
    if args.mode:
        project.settings.engine_mode = args.mode

    if args.print_workflow:
        print(f"Project: {project.describe()}")
        print()
        print(outline_text(project.workflow))
        print()
        print("States:")
        for name in project.state_names():
            print(f"  {name:<24} {project.states[name].summary()}")
        return 0

    if args.analyze:
        return analyze_once(args, project, log)
    if args.run:
        return run_headless(args, project, log)
    if args.no_gui:
        print("Nothing to do. Use --run, --analyze, --print-workflow or --list-instances.")
        return 0

    try:
        from gui import run_gui
    except Exception as exc:  # pragma: no cover - missing Tk
        raise SystemExit(f"The GUI could not be started ({exc}). Use --run for headless mode.")
    run_gui(project=project, log=log, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
