import Decimal from "decimal.js";
import { pool, withTx } from "../db/pool";
import { getAllCards, updateCardMarketValues } from "../repositories/cardRepository";
import { emitPortfolioUpdate, emitPriceUpdate } from "../realtime/socket";

const RARITY_BASE_RANGES: Record<string, [number, number]> = {
  Common: [0.05, 0.5],
  Uncommon: [0.25, 2],
  Rare: [1, 10],
  "Holo Rare": [3, 30],
  "Ultra Rare/EX/GX": [15, 150],
  "Secret Rare": [50, 500]
};

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

export function priceForRarity(rarity: string): Decimal {
  const [min, max] = RARITY_BASE_RANGES[rarity] ?? RARITY_BASE_RANGES.Common;
  const variance = randomBetween(-0.08, 0.08);
  const base = new Decimal(randomBetween(min, max));
  return Decimal.max(0.01, base.mul(new Decimal(1).plus(variance))).toDecimalPlaces(2);
}

export async function runPriceTick() {
  console.log("Price tick starting...");
  return withTx(async (client) => {
    const cards = await getAllCards(client);
    console.log(`Found ${cards.length} cards to update`);
    const updates: Array<{ id: string; value: string }> = [];
    const ownerCards = new Map<string, Array<{ id: string; marketValue: string; acquisitionValue: string }>>();
    const ownerTotals = new Map<string, Decimal>();

    for (const card of cards) {
      const current = new Decimal(card.market_value);
      const drift = new Decimal(randomBetween(-0.012, 0.012));
      const next = Decimal.max(0.01, current.mul(new Decimal(1).plus(drift))).toDecimalPlaces(2);

      const diff = next.minus(current);
      const diffStr = diff.gte(0) ? `+${diff.toFixed(2)}` : diff.toFixed(2);
      console.log(`[Price Change] ${card.name}: ${current.toFixed(2)} -> ${next.toFixed(2)} (${next.toFixed(2)} - ${current.toFixed(2)} = ${diffStr})`);

      updates.push({ id: card.id, value: next.toFixed(2) });

      if (!ownerCards.has(card.owner_id)) {
        ownerCards.set(card.owner_id, []);
      }
      ownerCards.get(card.owner_id)!.push({
        id: card.id,
        marketValue: next.toFixed(2),
        acquisitionValue: card.acquisition_value
      });

      ownerTotals.set(card.owner_id, (ownerTotals.get(card.owner_id) ?? new Decimal(0)).plus(next));
    }

    if (!updates.length) return;
    await updateCardMarketValues(client, updates);
    emitPriceUpdate({ 
      updated: updates.length, 
      cards: updates,
      at: new Date().toISOString() 
    });

    for (const [userId, cardUpdates] of ownerCards) {
      emitPortfolioUpdate(userId, {
        userId,
        portfolioValue: ownerTotals.get(userId)!.toFixed(2),
        cards: cardUpdates,
        at: new Date().toISOString()
      });
    }
  });
}

export async function getPortfolioTotal(userId: string): Promise<Decimal> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("select coalesce(sum(market_value),0) as total from cards where owner_id=$1", [userId]);
    return new Decimal(rows[0]?.total ?? 0);
  } finally {
    client.release();
  }
}
