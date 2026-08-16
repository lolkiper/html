from __future__ import annotations

import numpy as np

from logger import IMAGE_PLACEHOLDER, REDACTED, EventLog, LogLevel, Secret, mask_text


def test_records_are_formatted_with_a_clock():
    log = EventLog()
    record = log.info("LDPlayer selected")
    assert record is not None
    assert record.format().startswith("[")
    assert record.format().endswith("LDPlayer selected")


def test_image_payloads_never_reach_the_log():
    log = EventLog(level=LogLevel.DEBUG)
    frame = np.zeros((10, 10, 3), dtype=np.uint8)
    log.info(frame)
    log.info("frame: %s", frame)
    log.info("raw: %s", b"\x89PNG\r\n\x1a\n")
    for line in log.lines():
        assert IMAGE_PLACEHOLDER in line
    assert not any("array(" in line for line in log.lines())


def test_registered_secrets_are_redacted():
    log = EventLog()
    log.register_secret("hunter2")
    log.info("typing hunter2 into the login field")
    assert "hunter2" not in log.lines()[0]
    assert REDACTED in log.lines()[0]


def test_secret_values_are_masked_but_still_usable():
    secret = Secret("s3cret")
    log = EventLog()
    log.info("value=%s", secret)
    assert "s3cret" not in log.lines()[0]
    assert secret.reveal() == "s3cret"
    assert "6 chars" in mask_text("s3cret")
    assert "s3cret" not in mask_text("s3cret")


def test_listeners_and_level_filter():
    log = EventLog(level=LogLevel.WARNING)
    seen: list[str] = []
    log.add_listener(lambda record: seen.append(record.message))
    log.debug("ignored")
    log.warning("kept")
    assert seen == ["kept"]
    log.remove_listener(log._listeners[0])
    log.error("after removal")
    assert seen == ["kept"]


def test_file_sink_writes_text_only(tmp_path):
    path = tmp_path / "run.log"
    log = EventLog(file_path=path)
    log.info("State A detected, confidence=0.94")
    content = path.read_text(encoding="utf-8")
    assert "State A detected" in content
    assert content.isprintable() or content.endswith("\n")


def test_broken_listener_does_not_break_logging():
    log = EventLog()

    def explode(record):
        raise RuntimeError("boom")

    log.add_listener(explode)
    assert log.info("still fine") is not None
