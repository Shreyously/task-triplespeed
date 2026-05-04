import Decimal from "decimal.js";
import { pool, withTx } from "../db/pool";
import { getDropForUpdate, listDrops, updateDrop } from "../repositories/dropRepository";
import { createPackPurchase, getPurchaseById, getPurchaseByIdempotencyKey } from "../repositories/packRepository";
import { createCard, getCardsByPurchase } from "../repositories/cardRepository";
import { createLedger } from "../repositories/ledgerRepository";
import { debitAvailable } from "./balanceService";
import { getCardPool } from "./pokemonCardService";
import { priceForRarity } from "./priceEngineService";
import { emitDropInventory, emitDropPrice, emitDropStatus } from "../realtime/socket";
import { getActiveConfig } from "../repositories/packConfigRepository";

function weightedPick(weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((acc, [, weight]) => acc + Number(weight), 0);
  let roll = Math.random() * total;
  for (const [rarity, weight] of entries) {
    roll -= Number(weight);
    if (roll <= 0) return rarity;
  }
  return entries[entries.length - 1]?.[0] ?? "Common";
}

function pickCards(count: number, pool: Array<{ name: string; setName: string; rarity: string; imageUrl: string }>, rarityWeights: Record<string, number>) {
  const byRarity = pool.reduce<Record<string, Array<{ name: string; setName: string; rarity: string; imageUrl: string }>>>((acc, card) => {
    const key = card.rarity || "Common";
    if (!acc[key]) acc[key] = [];
    acc[key].push(card);
    return acc;
  }, {});
  return Array.from({ length: count }, () => {
    const desired = weightedPick(rarityWeights);
    const candidates = byRarity[desired] ?? byRarity.Common ?? pool;
    return candidates[Math.floor(Math.random() * candidates.length)];
  });
}

export async function getDrops() {
  const client = await pool.connect();
  try {
    return await listDrops(client);
  } finally {
    client.release();
  }
}

export async function buyPack(userId: string, dropId: string, idempotencyKey: string) {
  const cardPool = await getCardPool();
  if (!cardPool.length) throw new Error("Card pool unavailable");
  try {
    return await withTx(async (client) => {
      const existing = await getPurchaseByIdempotencyKey(client, userId, idempotencyKey);
      if (existing) {
        if (existing.drop_id !== dropId) throw new Error("Idempotency key already used for a different drop");
        const inv = await client.query("select inventory from drops where id=$1", [dropId]);
        return { purchase: existing, remainingInventory: Number(inv.rows[0]?.inventory ?? 0) };
      }

      const drop = await getDropForUpdate(client, dropId);
      if (!drop) throw new Error("Drop not found");
      const now = new Date();
      if (new Date(drop.starts_at) > now) throw new Error("Drop not live yet");
      if (new Date(drop.ends_at) < now) throw new Error("Drop closed");
      if (drop.inventory <= 0) throw new Error("Sold out");

      // ── B1: Load active rarity weights for this tier ──────────────────────
      // Weights are tier-scoped (not drop-scoped). Falls back to drop.rarity_weights
      // if no active config exists yet (backward compatible with pre-migration state).
      // Cards are generated here, at buy time. revealPack() only reads stored cards.
      const activeConfig = await getActiveConfig(client, drop.tier);
      const rarityWeights: Record<string, number> =
        activeConfig?.rarity_weights ?? drop.rarity_weights ?? { Common: 1 };
      const configVersionId: string | null = activeConfig?.id ?? null;
      // ─────────────────────────────────────────────────────────────────────

      const price = new Decimal(drop.price);
      await debitAvailable(client, userId, price);
      const invResult = await client.query("update drops set inventory=inventory-1 where id=$1 returning inventory", [dropId]);
      const purchase = await createPackPurchase(client, userId, dropId, price.toFixed(2), idempotencyKey, configVersionId);

      const cards = pickCards(Number(drop.cards_per_pack), cardPool, rarityWeights);
      for (const card of cards) {
        const marketValue = priceForRarity(card.rarity).toFixed(2);
        await createCard(client, {
          purchaseId: purchase.id,
          ownerId: userId,
          name: card.name,
          setName: card.setName,
          rarity: card.rarity,
          imageUrl: card.imageUrl,
          marketValue,
          acquisitionValue: marketValue
        });
      }

      await createLedger(client, userId, "PACK_PURCHASE", price.negated().toFixed(2), purchase.id);
      return { purchase, remainingInventory: Number(invResult.rows[0].inventory) };
    });
  } catch (err) {
    const client = await pool.connect();
    try {
      const purchase = await getPurchaseByIdempotencyKey(client, userId, idempotencyKey);
      if (!purchase) throw err;
      if (purchase.drop_id !== dropId) throw new Error("Idempotency key already used for a different drop");
      const inv = await client.query("select inventory from drops where id=$1", [dropId]);
      return { purchase, remainingInventory: Number(inv.rows[0]?.inventory ?? 0) };
    } finally {
      client.release();
    }
  }
}

export async function revealPack(userId: string, purchaseId: string) {
  const client = await pool.connect();
  try {
    const purchase = await getPurchaseById(client, purchaseId, userId);
    if (!purchase) throw new Error("Purchase not found");
    const cards = await getCardsByPurchase(client, purchaseId) as Array<Record<string, string>>;
    const revealOrder = [...cards].sort((a, b) => {
      const rank: Record<string, number> = {
        Common: 1,
        Uncommon: 2,
        Rare: 3,
        "Holo Rare": 4,
        "Ultra Rare/EX/GX": 5,
        "Secret Rare": 6
      };
      return (rank[a.rarity] ?? 1) - (rank[b.rarity] ?? 1);
    });
    const totalValue = cards.reduce((acc: Decimal, c: Record<string, string>) => acc.plus(c.market_value), new Decimal(0));
    const paid = new Decimal(purchase.price_paid);
    return {
      purchase,
      cards: revealOrder,
      totalValue: totalValue.toFixed(2),
      pnl: totalValue.minus(paid).toFixed(2)
    };
  } finally {
    client.release();
  }
}

export async function adminUpdateDrop(dropId: string, updates: { price?: string; starts_at?: string; ends_at?: string }) {
  const client = await pool.connect();
  try {
    return await updateDrop(client, dropId, updates);
  } finally {
    client.release();
  }
}

const dropCache = new Map<string, { price: string; inventory: number; starts_at: Date; ends_at: Date }>();

export async function syncDrops() {
  const drops = await getDrops();
  for (const drop of drops) {
    const cached = dropCache.get(drop.id);
    const currentPrice = String(drop.price);
    const currentInventory = Number(drop.inventory);
    const currentStarts = new Date(drop.starts_at);
    const currentEnds = new Date(drop.ends_at);

    if (cached) {
      if (cached.price !== currentPrice) {
        emitDropPrice(drop.id, currentPrice);
      }
      if (cached.inventory !== currentInventory) {
        emitDropInventory(drop.id, currentInventory);
      }
      if (cached.starts_at.getTime() !== currentStarts.getTime() || cached.ends_at.getTime() !== currentEnds.getTime()) {
        emitDropStatus(drop.id, currentStarts.toISOString(), currentEnds.toISOString());
      }
    }
    
    dropCache.set(drop.id, { 
      price: currentPrice, 
      inventory: currentInventory,
      starts_at: currentStarts, 
      ends_at: currentEnds 
    });
  }
}
