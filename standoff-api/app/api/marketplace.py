"""Sell cases via MarketplaceRemoteService."""

from __future__ import annotations

from Astandy import StandClient
from Astandy.generated.protos import inventory_message_pb2 as inventory_pb2
from Astandy.generated.protos import marketplace_message_pb2 as marketplace_pb2

_CASE_KEYWORDS = ("case", "кейс", "crate", "box", "container")


def _is_case_item(defn: inventory_pb2.InventoryItemDefinition, allowed_ids: set[int]) -> bool:
    if allowed_ids and defn.id not in allowed_ids:
        return False
    if not defn.canBeTraded:
        return False
    name = (defn.displayName or "").lower()
    if allowed_ids:
        return True
    return any(word in name for word in _CASE_KEYWORDS)


async def _load_definitions(client: StandClient) -> dict[int, inventory_pb2.InventoryItemDefinition]:
    response = await client.raw.InventoryRemoteService.getInventoryItemDefinitionsEncrypted(
        client,
        inventory_pb2.GetInventoryItemDefinitionsRequest(),
    )
    return {item.id: item for item in response.inventoryItemDefinitions}


async def _market_price(client: StandClient, item_definition_id: int, min_price: bool) -> float:
    trades = await client.raw.MarketplaceRemoteService.getTrades2(
        client,
        marketplace_pb2.GetTradesRequest(itemDefinitionIds=[item_definition_id]),
    )
    if not trades.trades:
        return 0.0
    trade = trades.trades[0]
    price = float(trade.salesPrice or trade.purchasesPrice or 0)
    if min_price and price > 0:
        return price
    return price


async def sell_cases(
    client: StandClient,
    *,
    min_price: bool = True,
    max_items: int = 50,
    case_definition_ids: list[int] | None = None,
    log_fn=print,
) -> tuple[int, float]:
    allowed = set(case_definition_ids or [])
    definitions = await _load_definitions(client)
    inv = await client.raw.InventoryRemoteService.getPlayerInventoryEncrypted(
        client,
        inventory_pb2.GetPlayerInventoryRequest(),
    )

    by_definition: dict[int, list[inventory_pb2.PlayerInventoryItem]] = {}
    for item in inv.playerInventory.inventoryItems:
        defn = definitions.get(item.itemDefinitionId)
        if defn is None or not _is_case_item(defn, allowed):
            continue
        if item.quantity <= 0:
            continue
        by_definition.setdefault(item.itemDefinitionId, []).append(item)

    sold = 0
    gold = 0.0

    for def_id, items in by_definition.items():
        if sold >= max_items:
            break
        price = await _market_price(client, def_id, min_price)
        if price <= 0:
            defn = definitions.get(def_id)
            price = float(defn.sellPrice if defn and defn.sellPrice else 1.0)
            log_fn(f"Маркет цена не найдена для id={def_id}, sellPrice={price}")

        stacks: list[marketplace_pb2.InventoryStackAmount] = []
        for item in items:
            if sold >= max_items:
                break
            qty = min(int(item.quantity), max_items - sold)
            if qty <= 0:
                continue
            stack = marketplace_pb2.InventoryStackAmount()
            stack.inventoryItemStackId = int(item.id)
            stack.value = qty
            stacks.append(stack)
            sold += qty

        if not stacks:
            continue

        name = definitions[def_id].displayName or str(def_id)
        log_fn(f'API: продажа "{name}" x{sum(s.value for s in stacks)} по {price}G')
        await client.raw.MarketplaceRemoteService.createMultipleSales(
            client,
            marketplace_pb2.CreateMultipleSalesRequest(
                stacks=stacks,
                price=price,
                itemDefinitionId=def_id,
            ),
        )
        gold += price * sum(s.value for s in stacks)

    return sold, gold
