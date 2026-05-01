import { PoolClient } from "pg";

export async function createListing(client: PoolClient, cardId: string, sellerId: string, price: string) {
  const { rows } = await client.query(
    "insert into listings(card_id,seller_id,price,status) values($1,$2,$3,'ACTIVE') returning *",
    [cardId, sellerId, price]
  );
  return rows[0];
}

export async function getListingForUpdate(client: PoolClient, listingId: string) {
  const { rows } = await client.query("select * from listings where id=$1 for update", [listingId]);
  return rows[0] ?? null;
}

export async function listActiveListings(client: PoolClient) {
  const { rows } = await client.query(
    `select l.*, c.name as card_name, c.set_name, c.rarity, c.image_url, c.market_value
     from listings l
     join cards c on c.id = l.card_id
     where l.status='ACTIVE'
     order by l.created_at desc`
  );
  return rows;
}

export async function markListingSold(client: PoolClient, listingId: string) {
  await client.query("update listings set status='SOLD' where id=$1", [listingId]);
}
