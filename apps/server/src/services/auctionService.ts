import Decimal from "decimal.js";
import { ANTI_SNIPE_MAX_EXTENSIONS, ANTI_SNIPE_SECONDS } from "@pullvault/common";
import { pool, withTx } from "../db/pool";
import { ensureCardMarketState, getCardForUpdate, getCardMarketStateForUpdate, updateCardOwner } from "../repositories/cardMarketRepository";
import {
  closeExpiredAuctions,
  createAuction,
  fetchUnsettledClosedAuctions,
  getBidByIdempotencyKey,
  getAuctionForUpdate,
  getBidHistory,
  insertBid,
  listLiveAuctions,
  markAuctionSettled
} from "../repositories/auctionRepository";
import { createLedger } from "../repositories/ledgerRepository";
import { updateCardAcquisitionValue } from "../repositories/cardRepository";
import { auctionFee } from "./feeService";
import { creditAvailable, holdFunds, releaseFunds, spendHeld } from "./balanceService";
import { getBalanceForUpdate } from "../repositories/balanceRepository";
import { emitAuctionClosed, emitAuctionCreated, getAuctionWatcherCount } from "../realtime/socket";

function minIncrement(current: Decimal): Decimal {
  const pct = current.times(0.05).toDecimalPlaces(2);
  return Decimal.max(new Decimal(1), pct);
}

export async function createAuctionForCard(userId: string, cardId: string, durationSeconds: number) {
  return withTx(async (client) => {
    const card = await getCardForUpdate(client, cardId);
    if (!card || card.owner_id !== userId) throw new Error("Card not owned");
    await ensureCardMarketState(client, cardId);
    const market = await getCardMarketStateForUpdate(client, cardId);
    if (!market || market.state !== "NONE") throw new Error("Card already in market");

    const start = new Date();
    const end = new Date(start.getTime() + durationSeconds * 1000);
    const auction = await createAuction(client, cardId, userId, start, end);
    await client.query("update card_market_state set state='IN_AUCTION', auction_id=$2, updated_at=now() where card_id=$1", [cardId, auction.id]);

    emitAuctionCreated({
      auctionId: auction.id,
      cardId: card.id,
      cardName: card.name,
      sellerId: userId,
      startingBid: auction.starting_bid,
      endsAt: auction.ends_at
    });

    return auction;
  });
}

export async function getLiveAuctions() {
  const client = await pool.connect();
  try {
    return await listLiveAuctions(client);
  } finally {
    client.release();
  }
}

export async function placeBid(userId: string, auctionId: string, amountStr: string, idempotencyKey: string) {
  try {
    return await withTx(async (client) => {
      const existing = await getBidByIdempotencyKey(client, userId, idempotencyKey);
      if (existing) {
        if (existing.auction_id !== auctionId) throw new Error("Idempotency key already used for a different auction");
        const live = await getAuctionForUpdate(client, auctionId);
        if (!live) throw new Error("Auction not found");
        return {
          auctionId,
          highestBid: new Decimal(existing.amount).toFixed(2),
          highestBidderId: existing.bidder_id,
          endTime: new Date(live.end_time).toISOString()
        };
      }

      const auction = await getAuctionForUpdate(client, auctionId);
      if (!auction) throw new Error("Auction not found");
      if (!["LIVE", "CLOSING"].includes(auction.status)) throw new Error("Auction not live");

      const now = new Date();
      const endTime = new Date(auction.end_time);
      if (endTime <= now) throw new Error("Auction ended");

      const amount = new Decimal(amountStr);
      const current = new Decimal(auction.current_bid);
      const minBid = current.eq(0) ? new Decimal(1) : current.plus(minIncrement(current));
      if (amount.lt(minBid)) throw new Error(`Bid too low. Minimum ${minBid.toFixed(2)}`);

      await getBalanceForUpdate(client, userId);

      if (auction.highest_bidder_id === userId) {
        const delta = amount.minus(current);
        await holdFunds(client, userId, delta);
      } else {
        await holdFunds(client, userId, amount);
        if (auction.highest_bidder_id) {
          await releaseFunds(client, auction.highest_bidder_id, current);
          await createLedger(client, auction.highest_bidder_id, "BID_RELEASE", current.toFixed(2), auction.id);
        }
      }

      const secondsLeft = Math.floor((endTime.getTime() - now.getTime()) / 1000);
      let nextEndTime = endTime;
      let status = auction.status;
      let ext = Number(auction.anti_snipe_extensions);

      if (secondsLeft <= ANTI_SNIPE_SECONDS && ext < ANTI_SNIPE_MAX_EXTENSIONS) {
        nextEndTime = new Date(endTime.getTime() + ANTI_SNIPE_SECONDS * 1000);
        status = "CLOSING";
        ext += 1;
      }

      await client.query(
        "update auctions set current_bid=$2, highest_bidder_id=$3, end_time=$4, anti_snipe_extensions=$5, status=$6 where id=$1",
        [auctionId, amount.toFixed(2), userId, nextEndTime, ext, status]
      );
      await insertBid(client, auctionId, userId, amount.toFixed(2), idempotencyKey);
      await createLedger(client, userId, "BID_HOLD", amount.toFixed(2), auction.id);

      return { auctionId, highestBid: amount.toFixed(2), highestBidderId: userId, endTime: nextEndTime.toISOString() };
    });
  } catch (err) {
    const client = await pool.connect();
    try {
      const existing = await getBidByIdempotencyKey(client, userId, idempotencyKey);
      if (!existing) throw err;
      if (existing.auction_id !== auctionId) throw new Error("Idempotency key already used for a different auction");
      const live = await client.query("select end_time from auctions where id=$1", [auctionId]);
      return {
        auctionId,
        highestBid: new Decimal(existing.amount).toFixed(2),
        highestBidderId: existing.bidder_id,
        endTime: new Date(live.rows[0]?.end_time ?? new Date()).toISOString()
      };
    } finally {
      client.release();
    }
  }
}

export async function getAuctionSnapshot(auctionId: string, userId: string) {
  const client = await pool.connect();
  try {
    const auction = await client.query(
      `select a.*, c.name as card_name, c.image_url, c.set_name, c.rarity, c.market_value
       from auctions a
       join cards c on c.id = a.card_id
       where a.id=$1`,
      [auctionId]
    );
    if (!auction.rows[0]) throw new Error("Auction not found");
    const bids = await getBidHistory(client, auctionId);
    const bal = await client.query("select held_balance from balances where user_id=$1", [userId]);
    const settlement = await client.query("select * from auction_settlements where auction_id=$1", [auctionId]);
    const current = new Decimal(auction.rows[0].current_bid);
    const minBid = current.eq(0) ? new Decimal(1) : current.plus(minIncrement(current));
    return {
      auction: auction.rows[0],
      bidHistory: bids,
      yourHeld: bal.rows[0]?.held_balance ?? "0.00",
      watcherCount: getAuctionWatcherCount(auctionId),
      serverTime: new Date().toISOString(),
      timeLeftSeconds: Math.max(0, Math.floor((new Date(auction.rows[0].end_time).getTime() - Date.now()) / 1000)),
      minimumBid: minBid.toFixed(2),
      settlement: settlement.rows[0] ?? null
    };
  } finally {
    client.release();
  }
}

export async function settlementTick(platformUserId: string) {
  return withTx(async (client) => {
    await closeExpiredAuctions(client);
    const auctions = await fetchUnsettledClosedAuctions(client);
    const settledIds: string[] = [];

    for (const auction of auctions) {
      if (auction.settled) continue;

      let settlementData: any = null;

      if (!auction.highest_bidder_id) {
        await markAuctionSettled(client, auction.id);
        await client.query("update card_market_state set state='NONE', auction_id=null where card_id=$1", [auction.card_id]);
        settlementData = { winner_id: null, gross_amount: "0.00", fee_amount: "0.00" };
        settledIds.push(auction.id);
      } else {
        const gross = new Decimal(auction.current_bid);
        const fee = auctionFee(gross);
        const sellerNet = gross.minus(fee);

        await spendHeld(client, auction.highest_bidder_id, gross);
        await creditAvailable(client, auction.seller_id, sellerNet);
        await creditAvailable(client, platformUserId, fee);
        await updateCardOwner(client, auction.card_id, auction.highest_bidder_id);
        await updateCardAcquisitionValue(client, auction.card_id, gross.toFixed(2));

        await client.query(
          "insert into auction_settlements(auction_id,winner_id,gross_amount,fee_amount,idempotency_key) values($1,$2,$3,$4,$5) on conflict (auction_id) do nothing",
          [auction.id, auction.highest_bidder_id, gross.toFixed(2), fee.toFixed(2), `settle-${auction.id}`]
        );

        await createLedger(client, auction.highest_bidder_id, "AUCTION_SETTLEMENT", gross.negated().toFixed(2), auction.id, { side: "BUY" });
        await createLedger(client, auction.seller_id, "AUCTION_SETTLEMENT", sellerNet.toFixed(2), auction.id, { side: "SELL" });
        await createLedger(client, platformUserId, "FEE_CREDIT", fee.toFixed(2), auction.id, { source: "AUCTION" });

        await markAuctionSettled(client, auction.id);
        await client.query("update card_market_state set state='NONE', auction_id=null where card_id=$1", [auction.card_id]);

        settlementData = { winner_id: auction.highest_bidder_id, gross_amount: gross.toFixed(2), fee_amount: fee.toFixed(2) };
        settledIds.push(auction.id);
      }

      emitAuctionClosed(auction.id, { auctionId: auction.id, status: "SETTLED", settlement: settlementData, sellerId: auction.seller_id });
    }

    return settledIds;
  });
}
