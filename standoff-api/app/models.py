"""Pydantic models for Standoff API."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class AccountCredentials(BaseModel):
    google_login: str = Field(..., min_length=1)
    google_password: str = Field(default="")
    twitch_login: str = Field(..., min_length=1)
    twitch_password: str = Field(default="")
    handshake: Optional[str] = None
    twitch_auth_code: Optional[str] = None


class JobOptions(BaseModel):
    link_twitch: bool = True
    sell_cases: bool = True
    sell_min_price: bool = True
    sell_max_items: int = Field(50, ge=1, le=200)
    skip_twitch_if_linked: bool = True


class CreateJobRequest(BaseModel):
    account: AccountCredentials
    options: JobOptions = Field(default_factory=JobOptions)


class JobResult(BaseModel):
    google_login: str
    twitch_login: str
    twitch_linked: bool = False
    cases_sold: int = 0
    gold_earned: float = 0.0
    message: str = ""


class JobInfo(BaseModel):
    id: str
    status: JobStatus
    created_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    result: Optional[JobResult] = None


class HealthResponse(BaseModel):
    status: str
    pipeline_mode: str
    ldplayer_found: bool
    queue_size: int


class CycleRunRequest(BaseModel):
    limit: Optional[int] = None
    cycle_no: int = 1
    repeat: bool = False
    options: JobOptions = Field(default_factory=JobOptions)


class CycleRunResponse(BaseModel):
    cycle_no: int
    total: int
    processed: int
    ok: int
    errors: int
    sent_gold: float
    net_gold: float
    elapsed_sec: float
    repeat: bool
    failed_accounts: list[str] = Field(default_factory=list)
