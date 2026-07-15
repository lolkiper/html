"""In-memory job queue and worker thread."""

from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable, Optional

from app.config import AppConfig
from app.models import CreateJobRequest, JobInfo, JobResult, JobStatus
from app.pipeline import run_pipeline


class JobManager:
    def __init__(self, config: AppConfig, max_workers: int = 1) -> None:
        self.config = config
        self._jobs: dict[str, JobInfo] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._logs: dict[str, list[str]] = {}

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def create_job(self, request: CreateJobRequest) -> JobInfo:
        job_id = uuid.uuid4().hex[:12]
        info = JobInfo(
            id=job_id,
            status=JobStatus.queued,
            created_at=self._now(),
        )
        with self._lock:
            self._jobs[job_id] = info
            self._logs[job_id] = []

        self._executor.submit(self._run_job, job_id, request)
        return info

    def _log(self, job_id: str, msg: str) -> None:
        line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        with self._lock:
            self._logs.setdefault(job_id, []).append(line)

    def _run_job(self, job_id: str, request: CreateJobRequest) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = JobStatus.running
            job.started_at = self._now()

        try:
            result = run_pipeline(
                request,
                self.config,
                log_fn=lambda m: self._log(job_id, m),
            )
            with self._lock:
                job = self._jobs[job_id]
                job.status = JobStatus.completed
                job.result = result
                job.finished_at = self._now()
        except Exception as exc:
            with self._lock:
                job = self._jobs[job_id]
                job.status = JobStatus.failed
                job.error = str(exc)
                job.finished_at = self._now()
                job.result = JobResult(
                    google_login=request.account.google_login,
                    twitch_login=request.account.twitch_login,
                    message=str(exc),
                )
            self._log(job_id, f"FAILED: {exc}\n{traceback.format_exc()}")

    def get_job(self, job_id: str) -> Optional[JobInfo]:
        with self._lock:
            return self._jobs.get(job_id)

    def list_jobs(self, limit: int = 50) -> list[JobInfo]:
        with self._lock:
            jobs = list(self._jobs.values())
        jobs.sort(key=lambda j: j.created_at, reverse=True)
        return jobs[:limit]

    def get_logs(self, job_id: str) -> list[str]:
        with self._lock:
            return list(self._logs.get(job_id, []))

    def queue_size(self) -> int:
        with self._lock:
            return sum(1 for j in self._jobs.values() if j.status == JobStatus.queued)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
