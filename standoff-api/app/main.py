"""Standoff 2 API — login, Twitch bind, sell cases."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status

from app.adb.ldplayer import find_dnconsole
from app.accounts import load_accounts_file, to_job_request
from app.config import ACCOUNTS_FILE, AppConfig
from app.job_manager import JobManager
from app.models import CreateJobRequest, HealthResponse, JobInfo

config = AppConfig.load()
job_manager = JobManager(config, max_workers=1)

app = FastAPI(
    title="Standoff 2 API",
    description="Вход в аккаунт (Google) → привязка Twitch → продажа кейсов на рынке. "
    "Требует Windows + LDPlayer + ADB.",
    version="1.0.0",
)


def verify_api_key(
    x_api_key: Annotated[str | None, Header()] = None,
) -> None:
    if not config.api_key or config.api_key.startswith("ВСТАВЬ"):
        return
    if x_api_key != config.api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    ld_ok = False
    try:
        find_dnconsole(config.ldplayer_home)
        ld_ok = True
    except FileNotFoundError:
        pass
    return HealthResponse(
        status="ok",
        ldplayer_found=ld_ok,
        queue_size=job_manager.queue_size(),
    )


@app.post("/jobs", response_model=JobInfo, dependencies=[Depends(verify_api_key)])
def create_job(request: CreateJobRequest) -> JobInfo:
    return job_manager.create_job(request)


@app.get("/jobs", response_model=list[JobInfo], dependencies=[Depends(verify_api_key)])
def list_jobs(limit: int = 50) -> list[JobInfo]:
    return job_manager.list_jobs(limit=limit)


@app.get("/jobs/{job_id}", response_model=JobInfo, dependencies=[Depends(verify_api_key)])
def get_job(job_id: str) -> JobInfo:
    job = job_manager.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/jobs/{job_id}/logs", dependencies=[Depends(verify_api_key)])
def get_job_logs(job_id: str) -> dict:
    job = job_manager.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "logs": job_manager.get_logs(job_id)}


@app.post("/jobs/batch", response_model=list[JobInfo], dependencies=[Depends(verify_api_key)])
def create_batch_jobs(limit: int | None = None) -> list[JobInfo]:
    """Создать задачи из accounts.txt (google:pass:twitch:pass)."""
    accounts = load_accounts_file(ACCOUNTS_FILE)
    if not accounts:
        raise HTTPException(
            status_code=400,
            detail=f"Нет аккаунтов в {ACCOUNTS_FILE}. Скопируй accounts.example.txt → accounts.txt",
        )
    if limit is not None:
        accounts = accounts[:limit]
    return [job_manager.create_job(to_job_request(acc)) for acc in accounts]


@app.on_event("shutdown")
def on_shutdown() -> None:
    job_manager.shutdown()
