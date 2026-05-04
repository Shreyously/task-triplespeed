import { PoolClient } from "pg";

export async function createAuction(client: PoolClient, cardId: string, sellerId: string, startTime: Date, endTime: Date) {
  const { rows } = await client.query(
    `insert into auctions(
      card_id,seller_id,status,start_time,end_time,current_bid,anti_snipe_extensions,settled
    ) values($1,$2,'LIVE',$3,$4,0,0,false) returning *`,
    [cardId, sellerId, startTime, endTime]
  );
  return rows[0];
}

export async function getAuctionForUpdate(client: PoolClient, auctionId: string) {
  const { rows } = await client.query(
    `select a.*, c.market_value, c.name as card_name
     from auctions a
     join cards c on c.id = a.card_id
     where a.id=$1
     for update`,
    [auctionId]
  );
  return rows[0] ?? null;
}

export async function listLiveAuctions(client: PoolClient) {
  const { rows } = await client.query(
    `select a.*, c.name as card_name, c.image_url, c.set_name, c.rarity, c.market_value
     from auctions a
     join cards c on c.id = a.card_id
     where a.status in ('LIVE','CLOSING','SEALED_ENDGAME')
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

export async function getSealedBidByIdempotencyKey(client: PoolClient, bidderId: string, idempotencyKey: string) {
  const { rows } = await client.query(
    "select * from sealed_bids where bidder_id=$1 and idempotency_key=$2",
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

export async function getSealedBidForUpdate(client: PoolClient, auctionId: string, bidderId: string) {
  const { rows } = await client.query(
    "select * from sealed_bids where auction_id=$1 and bidder_id=$2 for update",
    [auctionId, bidderId]
  );
  return rows[0] ?? null;
}

export async function upsertSealedBid(
  client: PoolClient,
  auctionId: string,
  bidderId: string,
  amount: string,
  confirmedHighBid: boolean,
  idempotencyKey: string
) {
  const { rows } = await client.query(
    `insert into sealed_bids(auction_id,bidder_id,max_bid_amount,confirmed_high_bid,idempotency_key)
     values($1,$2,$3,$4,$5)
     on conflict (auction_id, bidder_id)
     do update set
       max_bid_amount=excluded.max_bid_amount,
       confirmed_high_bid=excluded.confirmed_high_bid,
       idempotency_key=excluded.idempotency_key,
       updated_at=now()
     returning *`,
    [auctionId, bidderId, amount, confirmedHighBid, idempotencyKey]
  );
  return rows[0];
}

export async function listSealedBids(client: PoolClient, auctionId: string) {
  const { rows } = await client.query(
    `select * from sealed_bids
     where auction_id=$1
     order by max_bid_amount desc, updated_at asc`,
    [auctionId]
  );
  return rows;
}

export async function transitionAuctionToSealedEndgame(client: PoolClient, auctionId: string, sealedEndsAt: Date, floor: string) {
  const { rows } = await client.query(
    `update auctions
     set status='SEALED_ENDGAME',
         sealed_phase_started_at=coalesce(sealed_phase_started_at, now()),
         sealed_phase_ends_at=$2,
         sealed_bid_floor=$3,
         end_time=$2
     where id=$1
     returning *`,
    [auctionId, sealedEndsAt, floor]
  );
  return rows[0];
}

export async function updateAuctionOpenBidState(
  client: PoolClient,
  auctionId: string,
  amount: string,
  bidderId: string,
  endTime: Date,
  antiSnipeExtensions: number,
  status: string
) {
  await client.query(
    `update auctions
     set current_bid=$2,
         highest_bidder_id=$3,
         end_time=$4,
         anti_snipe_extensions=$5,
         status=$6
     where id=$1`,
    [auctionId, amount, bidderId, endTime, antiSnipeExtensions, status]
  );
}

export async function closeExpiredAuctions(client: PoolClient) {
  await client.query(
    "update auctions set status='CLOSED' where status in ('LIVE','CLOSING','SEALED_ENDGAME') and end_time <= now()"
  );
}

export async function fetchUnsettledClosedAuctions(client: PoolClient) {
  const { rows } = await client.query(
    `select a.*, c.market_value
     from auctions a
     join cards c on c.id = a.card_id
     where a.status='CLOSED' and a.settled=false
     order by a.end_time asc
     limit 100
     for update skip locked`
  );
  return rows;
}

export async function markAuctionSettled(client: PoolClient, auctionId: string) {
  await client.query("update auctions set status='SETTLED', settled=true where id=$1", [auctionId]);
}

export async function recordAuctionSettlementPricing(
  client: PoolClient,
  auctionId: string,
  winningMaxBid: string | null,
  finalClearingPrice: string | null
) {
  await client.query(
    "update auctions set winning_max_bid=$2, final_clearing_price=$3 where id=$1",
    [auctionId, winningMaxBid, finalClearingPrice]
  );
}

export async function insertAuctionIntegrityFlag(
  client: PoolClient,
  auctionId: string,
  flagType: string,
  severity: number,
  details: Record<string, unknown>
) {
  await client.query(
    `insert into auction_integrity_flags(auction_id, flag_type, severity, details)
     values($1,$2,$3,$4::jsonb)`,
    [auctionId, flagType, severity, JSON.stringify(details)]
  );
}

export async function countRecentSellerWinnerPairs(client: PoolClient, sellerId: string, winnerId: string) {
  const { rows } = await client.query(
    `select count(*)::int as count
     from auction_settlements s
     join auctions a on a.id = s.auction_id
     where a.seller_id=$1
       and s.winner_id=$2
       and s.created_at >= now() - interval '30 days'`,
    [sellerId, winnerId]
  );
  return rows[0]?.count ?? 0;
}
