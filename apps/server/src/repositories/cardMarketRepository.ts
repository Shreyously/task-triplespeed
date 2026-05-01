import { PoolClient } from "pg";

export async function getCardForUpdate(client: PoolClient, cardId: string) {
  const { rows } = await client.query("select * from cards where id=$1 for update", [cardId]);
  return rows[0] ?? null;
}

export async function getCardMarketStateForUpdate(client: PoolClient, cardId: string) {
  const { rows } = await client.query("select * from card_market_state where card_id=$1 for update", [cardId]);
  return rows[0] ?? null;
}

export async function ensureCardMarketState(client: PoolClient, cardId: string) {
  await client.query(
    "insert into card_market_state(card_id,state) values($1,'NONE') on conflict (card_id) do nothing",
    [cardId]
  );
}

export async function updateCardOwner(client: PoolClient, cardId: string, ownerId: string) {
  await client.query("update cards set owner_id=$2 where id=$1", [cardId, ownerId]);
}
