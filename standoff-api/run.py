#!/usr/bin/env python3
"""Start Standoff 2 API server."""

from __future__ import annotations

import uvicorn

from app.config import AppConfig

if __name__ == "__main__":
    cfg = AppConfig.load()
    uvicorn.run(
        "app.main:app",
        host=cfg.api_host,
        port=cfg.api_port,
        reload=False,
    )
