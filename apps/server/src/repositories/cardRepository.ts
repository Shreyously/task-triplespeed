import { PoolClient } from "pg";

export async function createCard(client: PoolClient, data: Record<string, unknown>) {
  const { rows } = await client.query(
    `insert into cards(purchase_id,owner_id,name,set_name,rarity,image_url,market_value,acquisition_value)
     values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [data.purchaseId, data.ownerId, data.name, data.setName, data.rarity, data.imageUrl, data.marketValue, data.acquisitionValue]
  );
  return rows[0];
}

export async function getCardsByPurchase(client: PoolClient, purchaseId: string) {
  const { rows } = await client.query("select * from cards where purchase_id=$1 order by market_value asc", [purchaseId]);
  return rows;
}

export async function getCardsByOwner(client: PoolClient, ownerId: string) {
  const { rows } = await client.query(
    `select c.*, cms.state as market_state, cms.listing_id, cms.auction_id
     from cards c
     left join card_market_state cms on c.id = cms.card_id
     where c.owner_id=$1
     order by c.created_at desc`,
    [ownerId]
  );
  return rows;
}

export async function updateCardMarketValues(client: PoolClient, rowsToUpdate: Array<{ id: string; value: string }>) {
  for (const row of rowsToUpdate) {
    await client.query("update cards set market_value=$2 where id=$1", [row.id, row.value]);
  }
}

export async function getAllCards(client: PoolClient) {
  const { rows } = await client.query("select id, name, owner_id, rarity, market_value, acquisition_value from cards");
  return rows;
}

export async function updateCardAcquisitionValue(client: PoolClient, cardId: string, acquisitionValue: string) {
  await client.query("update cards set acquisition_value=$2 where id=$1", [cardId, acquisitionValue]);
}
