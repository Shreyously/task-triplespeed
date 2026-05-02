import { PoolClient } from "pg";

export async function createAuction(client: PoolClient, cardId: string, sellerId: string, startTime: Date, endTime: Date) {
  const { rows } = await client.query(
    "insert into auctions(card_id,seller_id,status,start_time,end_time,current_bid,anti_snipe_extensions,settled) values($1,$2,'LIVE',$3,$4,0,0,false) returning *",
    [cardId, sellerId, startTime, endTime]
  );
  return rows[0];
}

export async function getAuctionForUpdate(client: PoolClient, auctionId: string) {
  const { rows } = await client.query("select * from auctions where id=$1 for update", [auctionId]);
  return rows[0] ?? null;
}

export async function listLiveAuctions(client: PoolClient) {
  const { rows } = await client.query(
    `select a.*, c.name as card_name, c.image_url, c.set_name, c.rarity, c.market_value
     from auctions a
     join cards c on c.id = a.card_id
     where a.status in ('LIVE','CLOSING')
     order by a.end_time asc`
  );
  return rows;
}

export async function insertBid(client: PoolClient, auctionId: string, bidderId: string, amount: string, idempotencyKey: string) {
  const { rows } = await client.query(
    "insert into bids(auction_id,bidder_id,amount,idempotency_key) values($1,$2,$3,$4) returning *",
    [auctionId, bidderId, amount, idempotencyKey]
  );
  return rows[0];
}

export async function getBidByIdempotencyKey(client: PoolClient, bidderId: string, idempotencyKey: string) {
  const { rows } = await client.query(
    "select * from bids where bidder_id=$1 and idempotency_key=$2",
    [bidderId, idempotencyKey]
  );
  return rows[0] ?? null;
}

export async function getBidHistory(client: PoolClient, auctionId: string) {
  const { rows } = await client.query(
    "select * from bids where auction_id=$1 order by created_at desc limit 25",
    [auctionId]
  );
  return rows;
}

export async function closeExpiredAuctions(client: PoolClient) {
  await client.query("update auctions set status='CLOSED' where status in ('LIVE','CLOSING') and end_time <= now()");
}

export async function fetchUnsettledClosedAuctions(client: PoolClient) {
  const { rows } = await client.query(
    "select * from auctions where status='CLOSED' and settled=false order by end_time asc limit 100 for update skip locked"
  );
  return rows;
}

export async function markAuctionSettled(client: PoolClient, auctionId: string) {
  await client.query("update auctions set status='SETTLED', settled=true where id=$1", [auctionId]);
}
