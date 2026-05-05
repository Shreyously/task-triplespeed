import { createHash, randomBytes } from "crypto";
import { PoolClient } from "pg";
import {
  SCHEME_VERSION,
  canonicalStringify,
  cardPoolHash,
  derivePackOpening,
  normalizePool,
  normalizeRarityWeightsToMicros,
  selectedCardsHash,
  type FairCard
} from "@pullvault/common";
import {
  createAuditEvent,
  createCommitment,
  getActiveCommitmentForUser,
  getCardPoolSnapshot,
  getCommitmentById,
  getLatestAuditEventHash,
  getOpeningFairnessByPurchaseId,
  listAuditEvents,
  upsertCardPoolSnapshot
} from "../repositories/provablyFairRepository";
import { getCardsByPurchase } from "../repositories/cardRepository";

export function hashSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function reserveFairnessCommitment(client: PoolClient, userId: string) {
  const existing = await getActiveCommitmentForUser(client, userId);
  if (existing) {
    return {
      commitmentId: existing.id as string,
      serverSeedHash: existing.server_seed_hash as string,
      expiresAt: existing.expires_at as string,
      schemeVersion: SCHEME_VERSION
    };
  }
  const serverSeed = randomBytes(32).toString("hex");
  const serverSeedHash = hashSha256(serverSeed);
  const created = await createCommitment(client, userId, serverSeed, serverSeedHash);
  return {
    commitmentId: created.id as string,
    serverSeedHash: created.server_seed_hash as string,
    expiresAt: created.expires_at as string,
    schemeVersion: SCHEME_VERSION
  };
}

export async function prepareProvablyFairInputs(client: PoolClient, cardPool: FairCard[], weights: Record<string, number>) {
  const normalizedPool = normalizePool(cardPool);
  const poolHash = await cardPoolHash(normalizedPool);
  await upsertCardPoolSnapshot(client, poolHash, normalizedPool);
  const rarityWeightMicros = normalizeRarityWeightsToMicros(weights);
  return { normalizedPool, poolHash, rarityWeightMicros };
}

export async function deriveOpeningCards(data: {
  serverSeed: string;
  purchaseId: string;
  dropId: string;
  configVersionId: string | null;
  clientSeed: string;
  nonce: number;
  cardsPerPack: number;
  rarityWeightMicros: Record<string, number>;
  cardPool: FairCard[];
}) {
  const cards = await derivePackOpening(data);
  const cardsHash = await selectedCardsHash(cards);
  return { cards, cardsHash };
}

export async function appendOpeningAuditEvent(
  client: PoolClient,
  purchaseId: string,
  payload: Record<string, unknown>
) {
  const prev = await getLatestAuditEventHash(client);
  const body = canonicalStringify({ previousEventHash: prev, payload });
  const eventHash = hashSha256(body);
  await createAuditEvent(client, purchaseId, eventHash, prev, payload);
}

export async function buildPublicOpeningProof(client: PoolClient, purchaseId: string) {
  const opening = await getOpeningFairnessByPurchaseId(client, purchaseId);
  if (!opening) return null;
  const commitment = await getCommitmentById(client, opening.commitment_id as string);
  if (!commitment) return null;
  const poolSnapshot = await getCardPoolSnapshot(client, opening.card_pool_hash as string);
  if (!poolSnapshot) return null;
  const cards = await getCardsByPurchase(client, purchaseId) as Array<Record<string, string>>;
  const normalizedCards = cards.map((c) => ({
    name: c.name,
    setName: c.set_name,
    rarity: c.rarity,
    imageUrl: c.image_url,
    acquisitionValue: c.acquisition_value
  }));

  return {
    schemeVersion: opening.scheme_version,
    purchaseId: opening.purchase_id,
    commitmentId: opening.commitment_id,
    serverSeedHash: opening.server_seed_hash,
    serverSeed: commitment.server_seed,
    clientSeed: opening.client_seed,
    nonce: opening.nonce,
    dropId: opening.drop_id,
    configVersionId: opening.config_version_id,
    rarityWeightMicros: opening.rarity_weight_micros,
    cardPoolHash: opening.card_pool_hash,
    cardPool: poolSnapshot.snapshot,
    cardsPerPack: opening.cards_per_pack,
    selectedCardsHash: opening.selected_cards_hash,
    cards: normalizedCards,
    createdAt: opening.created_at
  };
}

export async function getPublicAuditLog(client: PoolClient, limit: number, offset: number) {
  return listAuditEvents(client, limit, offset);
}
