"""Async Astandy StandClient session."""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, TypeVar

from Astandy import StandClient

T = TypeVar("T")


def run_astandy(coro: Awaitable[T]) -> T:
    return asyncio.run(coro)


class AstandySession:
    def __init__(self, handshake: str) -> None:
        self.handshake = handshake
        self.client: StandClient | None = None

    async def start(self) -> StandClient:
        self.client = StandClient(self.handshake)
        await self.client.start()
        return self.client

    async def stop(self) -> None:
        if self.client is not None:
            await self.client.stop()
            self.client = None

    async def __aenter__(self) -> StandClient:
        return await self.start()

    async def __aexit__(self, *args: Any) -> None:
        await self.stop()


async def with_client(handshake: str, fn: Callable[[StandClient], Awaitable[T]]) -> T:
    async with AstandySession(handshake) as client:
        return await fn(client)
