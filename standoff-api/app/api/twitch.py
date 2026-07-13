"""Bind Twitch via TwitchAuthRemoteService."""

from __future__ import annotations

from Astandy import StandClient
from Astandy.generated.protos import auth_message_pb2
from Astandy.generated.protos import common_message_pb2


def _fill_auth_twitch(msg: auth_message_pb2.AuthTwitch, auth_code: str, game_id: str, game_version: str) -> None:
    msg.gameId = game_id
    msg.gameVersion = game_version
    msg.platform = common_message_pb2.Platform.Android
    msg.store = common_message_pb2.Store.GooglePlay
    msg.authCode = auth_code
    msg.locale = "ru"


async def link_twitch(
    client: StandClient,
    auth_code: str,
    *,
    game_id: str,
    game_version: str,
    log_fn=print,
) -> bool:
    request = auth_message_pb2.TwitchLinkAuthRequest()
    _fill_auth_twitch(request.authTwitch, auth_code, game_id, game_version)
    log_fn("API: привязка Twitch (linkAuth)...")
    await client.raw.TwitchAuthRemoteService.linkAuth(client, request)
    return True
