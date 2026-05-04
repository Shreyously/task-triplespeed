import Decimal from "decimal.js";
import {
  ANTI_SNIPE_MAX_EXTENSIONS,
  ANTI_SNIPE_SECONDS,
  AUCTION_FLAG_LOW_PRICE_RATIO,
  FAT_FINGER_MULTIPLIER_CURRENT,
  FAT_FINGER_MULTIPLIER_MARKET,
  OPEN_BID_COOLDOWN_MS,
  OPEN_BID_WINDOW_MAX,
  OPEN_BID_WINDOW_MS,
  SEALED_BID_UPDATE_COOLDOWN_MS,
  SEALED_BID_WINDOW_SECONDS
} from "@pullvault/common";
import { redis } from "../db/redis";
import { pool, withTx } from "../db/pool";
import { ensureCardMarketState, getCardForUpdate, getCardMarketStateForUpdate, updateCardOwner } from "../repositories/cardMarketRepository";
import {
  closeExpiredAuctions,
  countRecentSellerWinnerPairs,
  createAuction,
  fetchUnsettledClosedAuctions,
  getAuctionForUpdate,
  getBidByIdempotencyKey,
  getBidHistory,
  getSealedBidByIdempotencyKey,
  getSealedBidForUpdate,
  insertAuctionIntegrityFlag,
  insertBid,
  listLiveAuctions,
  listSealedBids,
  markAuctionSettled,
  recordAuctionSettlementPricing,
  transitionAuctionToSealedEndgame,
  updateAuctionOpenBidState,
  upsertSealedBid
} from "../repositories/auctionRepository";
import { createLedger } from "../repositories/ledgerRepository";
import { updateCardAcquisitionValue } from "../repositories/cardRepository";
import { auctionFee } from "./feeService";
import { creditAvailable, holdFunds, releaseFunds, spendHeld } from "./balanceService";
import { getBalanceForUpdate } from "../repositories/balanceRepository";
import { emitAuctionClosed, emitAuctionCreated, emitAuctionSealedStatus, getAuctionWatcherCount } from "../realtime/socket";

type BidResult =
  | {
      accepted: true;
      mode: "OPEN" | "SEALED";
      auctionId: string;
      highestBid: string;
      highestBidderId: string | null;
      endTime: string;
      status: string;
      biddingMode: "OPEN" | "SEALED";
      yourSealedMaxBid?: string;
      minimumBid?: string;
    }
  | {
      accepted: false;
      confirmationRequired: true;
      mode: "OPEN" | "SEALED";
      auctionId: string;
      suggestedAmount: string;
      message: string;
    };

function minIncrement(current: Decimal): Decimal {
  const pct = current.times(0.05).toDecimalPlaces(2);
  return Decimal.max(new Decimal(1), pct);
}

function minimumBidFor(current: Decimal): Decimal {
  return current.eq(0) ? new Decimal(1) : current.plus(minIncrement(current));
}

function isSealedWindow(auction: { status: string; end_time: Date | string }, now: Date) {
  if (auction.status === "SEALED_ENDGAME") return true;
  const end = new Date(auction.end_time);
  return end.getTime() - now.getTime() <= SEALED_BID_WINDOW_SECONDS * 1000;
}

function shouldRequireHighBidConfirmation(amount: Decimal, currentBid: Decimal, marketValue: Decimal) {
  const currentReference = currentBid.gt(0) ? currentBid : new Decimal(1);
  if (marketValue.lte(0)) return amount.gte(currentReference.times(FAT_FINGER_MULTIPLIER_CURRENT));
  return amount.gte(currentReference.times(FAT_FINGER_MULTIPLIER_CURRENT)) && amount.gte(marketValue.times(FAT_FINGER_MULTIPLIER_MARKET));
}

async function enforceSlidingBidWindow(key: string, windowMs: number, limit: number) {
  const now = Date.now();
  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local start_ms = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local member = ARGV[4]
    redis.call('ZREMRANGEBYSCORE', key, 0, start_ms)
    local count = redis.call('ZCARD', key)
    if count >= limit then
      return 0
    end
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, tonumber(ARGV[5]))
    return 1
  `;

  const allowed = await redis.eval(
    script,
    1,
    key,
    now,
    now - windowMs,
    limit,
    `${now}-${Math.random().toString(36).slice(2)}`,
    windowMs + 1000
  );

  if (Number(allowed) !== 1) {
    throw new Error("Bid pacing limit exceeded");
  }
}

async function enforceCooldown(key: string, cooldownMs: number) {
  const now = Date.now();
  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local cooldown = tonumber(ARGV[2])
    local last = redis.call('GET', key)
    if last and (now - tonumber(last)) < cooldown then
      return 0
    end
    redis.call('SET', key, now, 'PX', cooldown + 1000)
    return 1
  `;

  const allowed = await redis.eval(script, 1, key, now, cooldownMs);
  if (Number(allowed) !== 1) {
    throw new Error("Bid update cooldown active");
  }
}

async function maybePromoteAuctionToSealed(client: any, auction: any) {
  const now = new Date();
  if (!isSealedWindow(auction, now) || auction.status === "SEALED_ENDGAME") {
    return auction;
  }

  const updated = await transitionAuctionToSealedEndgame(
    client,
    auction.id,
    new Date(auction.end_time),
    minimumBidFor(new Decimal(auction.current_bid)).toFixed(2)
  );

  emitAuctionSealedStatus(auction.id, {
    auctionId: auction.id,
    status: "SEALED_ENDGAME",
    biddingMode: "SEALED",
    endTime: new Date(updated.end_time).toISOString()
  });

  return updated;
}

function computeSecondPriceFromCandidates(
  currentBid: Decimal,
  currentHighestBidderId: string | null,
  candidates: Array<{ bidderId: string; maxBid: Decimal }>
) {
  if (candidates.length === 0) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => {
    if (!a.maxBid.eq(b.maxBid)) return b.maxBid.comparedTo(a.maxBid);
    return a.bidderId.localeCompare(b.bidderId);
  });

  const winner = sorted[0];
  const runnerUp = sorted[1] ?? null;
  const baseline = currentBid.gt(0) ? currentBid.plus(minIncrement(currentBid)) : new Decimal(1);
  const secondPrice = runnerUp
    ? Decimal.min(winner.maxBid, runnerUp.maxBid.plus(minIncrement(runnerUp.maxBid)))
    : winner.bidderId === currentHighestBidderId && currentBid.gt(0)
      ? currentBid
      : Decimal.min(winner.maxBid, baseline);

  return {
    winnerId: winner.bidderId,
    winningMaxBid: winner.maxBid.toFixed(2),
    finalClearingPrice: secondPrice.toFixed(2)
  };
}

async function runIntegrityReview(client: any, auction: any, settlementData: { winner_id: string | null; gross_amount: string; winning_max_bid?: string | null }) {
  const bidderStats = await client.query(
    `select count(distinct bidder_id)::int as bidder_count,
            count(*)::int as bid_count
     from bids
     where auction_id=$1`,
    [auction.id]
  );

  const sealedStats = await client.query(
    `select count(distinct bidder_id)::int as bidder_count
     from sealed_bids
     where auction_id=$1`,
    [auction.id]
  );

  const bidderCount = Number(bidderStats.rows[0]?.bidder_count ?? 0) + Number(sealedStats.rows[0]?.bidder_count ?? 0);
  const totalBidCount = Number(bidderStats.rows[0]?.bid_count ?? 0);
  const marketValue = new Decimal(auction.market_value ?? 0);
  const finalPrice = new Decimal(settlementData.gross_amount ?? 0);

  if (settlementData.winner_id) {
    const pairCount = await countRecentSellerWinnerPairs(client, auction.seller_id, settlementData.winner_id);
    if (pairCount >= 3) {
      await insertAuctionIntegrityFlag(client, auction.id, "REPEATED_SELLER_WINNER_PAIR", 3, {
        sellerId: auction.seller_id,
        winnerId: settlementData.winner_id,
        pairCount
      });
    }
  }

  if (marketValue.gt(0) && finalPrice.gt(0) && finalPrice.div(marketValue).lt(AUCTION_FLAG_LOW_PRICE_RATIO) && bidderCount <= 1) {
    await insertAuctionIntegrityFlag(client, auction.id, "LOW_CLOSE_WITHOUT_COMPETITION", 2, {
      marketValue: marketValue.toFixed(2),
      finalPrice: finalPrice.toFixed(2),
      bidderCount
    });
  }

  if (auction.status === "CLOSED" && auction.sealed_phase_started_at && bidderCount <= 2) {
    await insertAuctionIntegrityFlag(client, auction.id, "SEALED_ENDGAME_LOW_COMPETITION", 1, {
      bidderCount,
      totalBidCount
    });
  }

  const rapidBidActors = await client.query(
    `select bidder_id, count(*)::int as bids
     from bids
     where auction_id=$1
     group by bidder_id
     having count(*) >= 8`,
    [auction.id]
  );
  for (const row of rapidBidActors.rows) {
    await insertAuctionIntegrityFlag(client, auction.id, "MICRO_BID_LADDER", 1, {
      bidderId: row.bidder_id,
      bidCount: Number(row.bids)
    });
  }
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
      startingBid: new Decimal(auction.current_bid ?? 0).toFixed(2),
      endsAt: new Date(auction.end_time).toISOString()
    });

    return auction;
  });
}

export async function getLiveAuctions() {
  const client = await pool.connect();
  try {
    await client.query(
      `update auctions
       set status='SEALED_ENDGAME',
           sealed_phase_started_at=coalesce(sealed_phase_started_at, now()),
           sealed_phase_ends_at=end_time
       where status in ('LIVE','CLOSING')
         and end_time > now()
         and end_time <= now() + ($1 * interval '1 second')`,
      [SEALED_BID_WINDOW_SECONDS]
    );

    const auctions = await listLiveAuctions(client);
    return auctions.map((auction) => ({
      ...auction,
      bidding_mode: auction.status === "SEALED_ENDGAME" ? "SEALED" : "OPEN"
    }));
  } finally {
    client.release();
  }
}

export async function placeBid(
  userId: string,
  auctionId: string,
  amountStr: string,
  idempotencyKey: string,
  confirmHighBid = false
): Promise<BidResult> {
  return withTx(async (client) => {
    const existingVisible = await getBidByIdempotencyKey(client, userId, idempotencyKey);
    if (existingVisible) {
      const live = await getAuctionForUpdate(client, auctionId);
      if (!live) throw new Error("Auction not found");
      return {
        accepted: true,
        mode: "OPEN",
        auctionId,
        highestBid: new Decimal(existingVisible.amount).toFixed(2),
        highestBidderId: existingVisible.bidder_id,
        endTime: new Date(live.end_time).toISOString(),
        status: live.status,
        biddingMode: live.status === "SEALED_ENDGAME" ? "SEALED" : "OPEN"
      };
    }

    const existingSealed = await getSealedBidByIdempotencyKey(client, userId, idempotencyKey);
    if (existingSealed) {
      const live = await getAuctionForUpdate(client, auctionId);
      if (!live) throw new Error("Auction not found");
      return {
        accepted: true,
        mode: "SEALED",
        auctionId,
        highestBid: new Decimal(live.current_bid).toFixed(2),
        highestBidderId: live.highest_bidder_id,
        endTime: new Date(live.end_time).toISOString(),
        status: live.status,
        biddingMode: "SEALED",
        yourSealedMaxBid: new Decimal(existingSealed.max_bid_amount).toFixed(2),
        minimumBid: minimumBidFor(new Decimal(live.current_bid)).toFixed(2)
      };
    }

    let auction = await getAuctionForUpdate(client, auctionId);
    if (!auction) throw new Error("Auction not found");
    if (!["LIVE", "CLOSING", "SEALED_ENDGAME"].includes(auction.status)) throw new Error("Auction not live");
    if (auction.seller_id === userId) throw new Error("Seller cannot bid on own auction");

    const now = new Date();
    const endTime = new Date(auction.end_time);
    if (endTime <= now) throw new Error("Auction ended");

    auction = await maybePromoteAuctionToSealed(client, auction);
    const amount = new Decimal(amountStr).toDecimalPlaces(2);
    const current = new Decimal(auction.current_bid);
    const marketValue = new Decimal(auction.market_value ?? 0);
    const minBid = minimumBidFor(current);

    if (amount.lt(minBid)) throw new Error(`Bid too low. Minimum ${minBid.toFixed(2)}`);
    if (shouldRequireHighBidConfirmation(amount, current, marketValue) && !confirmHighBid) {
      return {
        accepted: false,
        confirmationRequired: true,
        mode: auction.status === "SEALED_ENDGAME" ? "SEALED" : "OPEN",
        auctionId,
        suggestedAmount: amount.toFixed(2),
        message: "Bid is far above current pricing and requires confirmation"
      };
    }

    await getBalanceForUpdate(client, userId);

    if (auction.status === "SEALED_ENDGAME") {
      await enforceCooldown(`auction:sealed:${auctionId}:${userId}`, SEALED_BID_UPDATE_COOLDOWN_MS);
      const priorSealedBid = await getSealedBidForUpdate(client, auctionId, userId);
      const currentCommitment = priorSealedBid
        ? new Decimal(priorSealedBid.max_bid_amount)
        : auction.highest_bidder_id === userId
          ? current
          : new Decimal(0);
      const delta = amount.minus(currentCommitment);

      if (delta.gt(0)) {
        await holdFunds(client, userId, delta);
        await createLedger(client, userId, "BID_HOLD", delta.toFixed(2), auction.id, { phase: "SEALED", totalHeldForAuction: amount.toFixed(2) });
      } else if (delta.lt(0)) {
        await releaseFunds(client, userId, delta.abs());
        await createLedger(client, userId, "BID_RELEASE", delta.abs().toFixed(2), auction.id, { phase: "SEALED", totalHeldForAuction: amount.toFixed(2) });
      }

      await upsertSealedBid(client, auctionId, userId, amount.toFixed(2), confirmHighBid, idempotencyKey);

      return {
        accepted: true,
        mode: "SEALED",
        auctionId,
        highestBid: current.toFixed(2),
        highestBidderId: auction.highest_bidder_id,
        endTime: new Date(auction.end_time).toISOString(),
        status: auction.status,
        biddingMode: "SEALED",
        yourSealedMaxBid: amount.toFixed(2),
        minimumBid: minBid.toFixed(2)
      };
    }

    await enforceCooldown(`auction:open:${auctionId}:${userId}:cooldown`, OPEN_BID_COOLDOWN_MS);
    await enforceSlidingBidWindow(`auction:open:${auctionId}:${userId}:window`, OPEN_BID_WINDOW_MS, OPEN_BID_WINDOW_MAX);

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

    await updateAuctionOpenBidState(client, auctionId, amount.toFixed(2), userId, nextEndTime, ext, status);
    await insertBid(client, auctionId, userId, amount.toFixed(2), idempotencyKey);
    await createLedger(client, userId, "BID_HOLD", amount.toFixed(2), auction.id, { phase: "OPEN" });

    return {
      accepted: true,
      mode: "OPEN",
      auctionId,
      highestBid: amount.toFixed(2),
      highestBidderId: userId,
      endTime: nextEndTime.toISOString(),
      status,
      biddingMode: "OPEN",
      minimumBid: minimumBidFor(amount).toFixed(2)
    };
  });
}

export async function getAuctionSnapshot(auctionId: string, userId: string) {
  const client = await pool.connect();
  try {
    await client.query(
      `update auctions
       set status='SEALED_ENDGAME',
           sealed_phase_started_at=coalesce(sealed_phase_started_at, now()),
           sealed_phase_ends_at=end_time
       where id=$1
         and status in ('LIVE','CLOSING')
         and end_time > now()
         and end_time <= now() + ($2 * interval '1 second')`,
      [auctionId, SEALED_BID_WINDOW_SECONDS]
    );

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
    const yourSealedBid = await client.query(
      "select max_bid_amount from sealed_bids where auction_id=$1 and bidder_id=$2",
      [auctionId, userId]
    );
    const current = new Decimal(auction.rows[0].current_bid);
    const minBid = minimumBidFor(current);
    const isSealed = auction.rows[0].status === "SEALED_ENDGAME";
    return {
      auction: {
        ...auction.rows[0],
        bidding_mode: isSealed ? "SEALED" : "OPEN"
      },
      bidHistory: bids,
      yourHeld: bal.rows[0]?.held_balance ?? "0.00",
      yourSealedMaxBid: yourSealedBid.rows[0]?.max_bid_amount ?? null,
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

      const currentBid = new Decimal(auction.current_bid);
      const sealedBids = await listSealedBids(client, auction.id);
      const sealedCandidates = sealedBids.map((row) => ({
        bidderId: row.bidder_id as string,
        maxBid: new Decimal(row.max_bid_amount)
      }));

      if (auction.highest_bidder_id && !sealedCandidates.some((row) => row.bidderId === auction.highest_bidder_id)) {
        sealedCandidates.push({
          bidderId: auction.highest_bidder_id,
          maxBid: currentBid
        });
      }

      const secondPriceResult = computeSecondPriceFromCandidates(currentBid, auction.highest_bidder_id, sealedCandidates);

      if (!secondPriceResult) {
        await markAuctionSettled(client, auction.id);
        await client.query("update card_market_state set state='NONE', auction_id=null where card_id=$1", [auction.card_id]);
        settlementData = {
          winner_id: null,
          gross_amount: "0.00",
          fee_amount: "0.00",
          winning_max_bid: null,
          final_clearing_price: null
        };
        settledIds.push(auction.id);
      } else {
        const gross = new Decimal(secondPriceResult.finalClearingPrice);
        const fee = auctionFee(gross);
        const sellerNet = gross.minus(fee);
        const winnerSealedBid = sealedBids.find((bid) => bid.bidder_id === secondPriceResult.winnerId);
        const heldMaxAmount = winnerSealedBid
          ? new Decimal(winnerSealedBid.max_bid_amount)
          : currentBid;
        const losingParticipants = new Map<string, Decimal>();
        for (const sealedBid of sealedBids) {
          if (sealedBid.bidder_id !== secondPriceResult.winnerId) {
            losingParticipants.set(sealedBid.bidder_id, new Decimal(sealedBid.max_bid_amount));
          }
        }
        if (
          auction.highest_bidder_id &&
          auction.highest_bidder_id !== secondPriceResult.winnerId &&
          !losingParticipants.has(auction.highest_bidder_id) &&
          currentBid.gt(0)
        ) {
          losingParticipants.set(auction.highest_bidder_id, currentBid);
        }
        for (const [loserId, heldAmount] of losingParticipants) {
          await releaseFunds(client, loserId, heldAmount);
          await createLedger(client, loserId, "BID_RELEASE", heldAmount.toFixed(2), auction.id, {
            phase: "SEALED_SETTLEMENT",
            losingRelease: true
          });
        }
        const excessHold = heldMaxAmount.minus(gross);

        if (excessHold.gt(0)) {
          await releaseFunds(client, secondPriceResult.winnerId, excessHold);
          await createLedger(client, secondPriceResult.winnerId, "BID_RELEASE", excessHold.toFixed(2), auction.id, {
            phase: "SEALED_SETTLEMENT",
            releasedExcess: true
          });
        }

        await spendHeld(client, secondPriceResult.winnerId, gross);
        await creditAvailable(client, auction.seller_id, sellerNet);
        await creditAvailable(client, platformUserId, fee);
        await updateCardOwner(client, auction.card_id, secondPriceResult.winnerId);
        await updateCardAcquisitionValue(client, auction.card_id, gross.toFixed(2));
        await recordAuctionSettlementPricing(client, auction.id, secondPriceResult.winningMaxBid, secondPriceResult.finalClearingPrice);

        await client.query(
          `insert into auction_settlements(
            auction_id,winner_id,gross_amount,winning_max_bid,final_clearing_price,fee_amount,idempotency_key
          ) values($1,$2,$3,$4,$5,$6,$7) on conflict (auction_id) do nothing`,
          [
            auction.id,
            secondPriceResult.winnerId,
            gross.toFixed(2),
            secondPriceResult.winningMaxBid,
            secondPriceResult.finalClearingPrice,
            fee.toFixed(2),
            `settle-${auction.id}`
          ]
        );

        await createLedger(client, secondPriceResult.winnerId, "AUCTION_SETTLEMENT", gross.negated().toFixed(2), auction.id, {
          side: "BUY",
          winningMaxBid: secondPriceResult.winningMaxBid,
          finalClearingPrice: secondPriceResult.finalClearingPrice
        });
        await createLedger(client, auction.seller_id, "AUCTION_SETTLEMENT", sellerNet.toFixed(2), auction.id, { side: "SELL" });
        await createLedger(client, platformUserId, "FEE_CREDIT", fee.toFixed(2), auction.id, { source: "AUCTION" });

        await markAuctionSettled(client, auction.id);
        await client.query("update card_market_state set state='NONE', auction_id=null where card_id=$1", [auction.card_id]);

        settlementData = {
          winner_id: secondPriceResult.winnerId,
          gross_amount: gross.toFixed(2),
          fee_amount: fee.toFixed(2),
          winning_max_bid: secondPriceResult.winningMaxBid,
          final_clearing_price: secondPriceResult.finalClearingPrice
        };
        await runIntegrityReview(client, auction, settlementData);
        settledIds.push(auction.id);
      }

      emitAuctionClosed(auction.id, { auctionId: auction.id, status: "SETTLED", settlement: settlementData, sellerId: auction.seller_id });
    }

    return settledIds;
  });
}
