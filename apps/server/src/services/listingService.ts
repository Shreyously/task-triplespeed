import Decimal from "decimal.js";
import { withTx, pool } from "../db/pool";
import { ensureCardMarketState, getCardForUpdate, getCardMarketStateForUpdate, updateCardOwner } from "../repositories/cardMarketRepository";
import { createListing, getListingForUpdate, listActiveListings, markListingSold } from "../repositories/listingRepository";
import { createLedger } from "../repositories/ledgerRepository";
import { updateCardAcquisitionValue } from "../repositories/cardRepository";
import { emitListingSold, emitListingCreated } from "../realtime/socket";
import { debitAvailable, creditAvailable } from "./balanceService";
import { tradeFee } from "./feeService";

export async function listCard(userId: string, cardId: string, priceStr: string) {
  return withTx(async (client) => {
    const card = await getCardForUpdate(client, cardId);
    if (!card || card.owner_id !== userId) throw new Error("Card not owned");
    await ensureCardMarketState(client, cardId);
    const state = await getCardMarketStateForUpdate(client, cardId);
    if (!state || state.state !== "NONE") throw new Error("Card already locked in market");
    const listing = await createListing(client, cardId, userId, priceStr);
    await client.query("update card_market_state set state='LISTED', listing_id=$2, updated_at=now() where card_id=$1", [cardId, listing.id]);
    
    emitListingCreated({
      ...listing,
      cardId: card.id,
      card_name: card.name,
      set_name: card.set_name,
      rarity: card.rarity,
      image_url: card.image_url,
      market_value: card.market_value
    });

    return listing;
  });
}

export async function browseListings() {
  const client = await pool.connect();
  try {
    return await listActiveListings(client);
  } finally {
    client.release();
  }
}

export async function buyListing(userId: string, listingId: string, idempotencyKey: string, platformUserId: string) {
  return withTx(async (client) => {
    const listing = await getListingForUpdate(client, listingId);
    if (!listing || listing.status !== "ACTIVE") throw new Error("Listing unavailable");
    if (listing.seller_id === userId) throw new Error("Cannot buy own listing");

    const card = await getCardForUpdate(client, listing.card_id);
    await ensureCardMarketState(client, listing.card_id);
    const state = await getCardMarketStateForUpdate(client, listing.card_id);
    if (!card || !state || state.state !== "LISTED") throw new Error("Invalid market state");

    const gross = new Decimal(listing.price);
    const fee = tradeFee(gross);
    const sellerNet = gross.minus(fee);

    await debitAvailable(client, userId, gross);
    await creditAvailable(client, listing.seller_id, sellerNet);
    await creditAvailable(client, platformUserId, fee);

    await updateCardOwner(client, listing.card_id, userId);
    await updateCardAcquisitionValue(client, listing.card_id, gross.toFixed(2));
    await markListingSold(client, listingId);
    await client.query("update card_market_state set state='NONE', listing_id=null, updated_at=now() where card_id=$1", [listing.card_id]);

    await client.query(
      "insert into trade_transactions(listing_id,buyer_id,seller_id,gross_amount,fee_amount,idempotency_key) values($1,$2,$3,$4,$5,$6)",
      [listingId, userId, listing.seller_id, gross.toFixed(2), fee.toFixed(2), idempotencyKey]
    );

    await createLedger(client, userId, "TRADE", gross.negated().toFixed(2), listing.id, { side: "BUY" });
    await createLedger(client, listing.seller_id, "TRADE", sellerNet.toFixed(2), listing.id, { side: "SELL" });
    await createLedger(client, platformUserId, "FEE_CREDIT", fee.toFixed(2), listing.id, { source: "TRADE" });

    emitListingSold(listing.id, {
      listingId: listing.id,
      cardId: listing.card_id,
      cardName: card.name,
      buyerId: userId,
      sellerId: listing.seller_id,
      price: gross.toFixed(2)
    });

    return { listingId, buyerId: userId, gross: gross.toFixed(2), fee: fee.toFixed(2) };
  });
}
