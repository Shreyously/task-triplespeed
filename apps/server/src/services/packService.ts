import Decimal from "decimal.js";
import { randomUUID } from "crypto";
import { pool, withTx } from "../db/pool";
import { getDropForUpdate, listDrops, updateDrop } from "../repositories/dropRepository";
import { createPackPurchase, getPurchaseById, getPurchaseByIdempotencyKey } from "../repositories/packRepository";
import { createCard, getCardsByPurchase } from "../repositories/cardRepository";
import { createLedger } from "../repositories/ledgerRepository";
import { debitAvailable } from "./balanceService";
import { getCardPool } from "./pokemonCardService";
import { emitDropInventory, emitDropPrice, emitDropStatus } from "../realtime/socket";
import { getActiveConfig } from "../repositories/packConfigRepository";
import { ACCOUNT_LIMITS } from "../config/antibot";
import {
  consumeCommitment,
  createOpeningFairnessRecord,
  getCommitmentForUpdate,
  getOpeningFairnessByPurchaseId,
  markCommitmentRevealed
} from "../repositories/provablyFairRepository";
import {
  appendOpeningAuditEvent,
  buildPublicOpeningProof,
  deriveOpeningCards,
  prepareProvablyFairInputs,
  reserveFairnessCommitment
} from "./provablyFairService";

export async function getDrops() {
  const client = await pool.connect();
  try {
    return await listDrops(client);
  } finally {
    client.release();
  }
}

export async function buyPack(
  userId: string,
  dropId: string,
  idempotencyKey: string,
  commitmentId?: string,
  clientSeed?: string
) {
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

      await client.query(
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [userId, dropId]
      );
      const packCountResult = await client.query(
        `select count(*) as count
         from pack_purchases
         where user_id = $1 and drop_id = $2`,
        [userId, dropId]
      );
      const packCount = Number(packCountResult.rows[0]?.count ?? 0);
      if (packCount >= ACCOUNT_LIMITS.maxPacksPerDrop) {
        throw new Error(`Maximum ${ACCOUNT_LIMITS.maxPacksPerDrop} packs per drop`);
      }

      const activeConfig = await getActiveConfig(client, drop.tier);
      const rarityWeights: Record<string, number> =
        activeConfig?.rarity_weights ?? drop.rarity_weights ?? { Common: 1 };
      const configVersionId: string | null = activeConfig?.id ?? null;

      const resolvedCommitmentId = commitmentId
        ?? (await reserveFairnessCommitment(client, userId)).commitmentId;
      const resolvedClientSeed = clientSeed ?? `${randomUUID()}-${Date.now()}`;

      const commitment = await getCommitmentForUpdate(client, resolvedCommitmentId);
      if (!commitment) throw new Error("Fairness commitment not found");
      if (commitment.reserved_by !== userId) throw new Error("Fairness commitment belongs to another user");
      if (commitment.status !== "RESERVED") throw new Error("Fairness commitment already used");
      if (new Date(commitment.expires_at) <= new Date()) throw new Error("Fairness commitment expired");

      const { normalizedPool, poolHash, rarityWeightMicros } = await prepareProvablyFairInputs(client, cardPool, rarityWeights);

      const price = new Decimal(drop.price);
      await debitAvailable(client, userId, price);
      const invResult = await client.query("update drops set inventory=inventory-1 where id=$1 returning inventory", [dropId]);
      const purchase = await createPackPurchase(client, userId, dropId, price.toFixed(2), idempotencyKey, configVersionId);

      const { cards, cardsHash } = await deriveOpeningCards({
        serverSeed: commitment.server_seed,
        purchaseId: purchase.id,
        dropId,
        configVersionId,
        clientSeed: resolvedClientSeed,
        nonce: 0,
        cardsPerPack: Number(drop.cards_per_pack),
        rarityWeightMicros,
        cardPool: normalizedPool
      });

      for (const card of cards) {
        const marketValue = card.acquisitionValue;
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

      await createOpeningFairnessRecord(client, {
        purchaseId: purchase.id,
        commitmentId: commitment.id,
        serverSeedHash: commitment.server_seed_hash,
        clientSeed: resolvedClientSeed,
        nonce: 0,
        dropId,
        configVersionId,
        rarityWeightMicros,
        cardPoolHash: poolHash,
        cardsPerPack: Number(drop.cards_per_pack),
        selectedCardsHash: cardsHash
      });

      await consumeCommitment(client, commitment.id, purchase.id, resolvedClientSeed);
      await appendOpeningAuditEvent(client, purchase.id, {
        purchaseId: purchase.id,
        dropId,
        configVersionId,
        serverSeedHash: commitment.server_seed_hash,
        clientSeed: resolvedClientSeed,
        rarityWeightMicros,
        cardsPerPack: Number(drop.cards_per_pack),
        drawnRarities: cards.map((c) => c.rarity),
        cardPoolHash: poolHash,
        selectedCardsHash: cardsHash
      });

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

    const fairness = await getOpeningFairnessByPurchaseId(client, purchaseId);
    if (fairness) {
      await markCommitmentRevealed(client, fairness.commitment_id);
    }
    const fairnessProof = await buildPublicOpeningProof(client, purchaseId);

    return {
      purchase,
      cards: revealOrder,
      totalValue: totalValue.toFixed(2),
      pnl: totalValue.minus(paid).toFixed(2),
      fairnessProof
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
