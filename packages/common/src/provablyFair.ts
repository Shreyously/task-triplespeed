export type FairCard = {
  name: string;
  setName: string;
  rarity: string;
  imageUrl: string;
};

export type RarityMicros = Record<string, number>;

const SCHEME_VERSION = "pf-pack-v1";

const RARITY_BASE_RANGES: Record<string, [number, number]> = {
  Common: [0.05, 0.5],
  Uncommon: [0.25, 2],
  Rare: [1, 10],
  "Holo Rare": [3, 30],
  "Ultra Rare/EX/GX": [15, 150],
  "Secret Rare": [50, 500]
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

function stableSortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSortObject);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stableSortObject((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(stableSortObject(value));
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

export function normalizeRarityWeightsToMicros(weights: Record<string, number>): RarityMicros {
  const keys = Object.keys(weights).sort();
  const micros: RarityMicros = {};
  let running = 0;
  let maxKey = keys[0] ?? "Common";
  for (const key of keys) {
    const value = Math.max(0, Number(weights[key] ?? 0));
    const m = Math.round(value * 1_000_000);
    micros[key] = m;
    running += m;
    if ((micros[key] ?? 0) > (micros[maxKey] ?? 0)) maxKey = key;
  }
  const delta = 1_000_000 - running;
  micros[maxKey] = Math.max(0, (micros[maxKey] ?? 0) + delta);
  return micros;
}

export function normalizePool(cards: FairCard[]): FairCard[] {
  return [...cards].sort((a, b) =>
    `${a.rarity}|${a.setName}|${a.name}|${a.imageUrl}`.localeCompare(
      `${b.rarity}|${b.setName}|${b.name}|${b.imageUrl}`
    )
  );
}

export async function cardPoolHash(cards: FairCard[]): Promise<string> {
  return sha256Hex(canonicalStringify(normalizePool(cards)));
}

async function drawInt(
  serverSeed: string,
  message: string,
  maxExclusive: number,
  drawOffset = 0
): Promise<number> {
  if (maxExclusive <= 1) return 0;
  const maxBig = BigInt(maxExclusive);
  const limit = (1n << 256n) - ((1n << 256n) % maxBig);
  let ctr = 0;
  while (ctr < 20) {
    const digest = await hmacSha256Hex(serverSeed, `${message}|draw:${drawOffset + ctr}`);
    const value = hexToBigInt(digest);
    if (value < limit) return Number(value % maxBig);
    ctr += 1;
  }
  return 0;
}

function pickRarity(roll: number, weights: RarityMicros): string {
  const entries = Object.entries(weights).sort(([a], [b]) => a.localeCompare(b));
  let cumulative = 0;
  for (const [rarity, w] of entries) {
    cumulative += Number(w);
    if (roll < cumulative) return rarity;
  }
  return entries[entries.length - 1]?.[0] ?? "Common";
}

async function deterministicValue(serverSeed: string, baseMessage: string, rarity: string): Promise<string> {
  const [min, max] = RARITY_BASE_RANGES[rarity] ?? RARITY_BASE_RANGES.Common;
  const baseRoll = await drawInt(serverSeed, `${baseMessage}|purpose:value_base`, 1_000_000, 2000);
  const varianceRoll = await drawInt(serverSeed, `${baseMessage}|purpose:value_var`, 1_000_000, 3000);
  const baseFrac = baseRoll / 1_000_000;
  const varianceFrac = varianceRoll / 1_000_000;
  const base = min + (max - min) * baseFrac;
  const variance = -0.08 + varianceFrac * 0.16;
  const out = Math.max(0.01, base * (1 + variance));
  return out.toFixed(2);
}

export async function derivePackOpening(args: {
  serverSeed: string;
  purchaseId: string;
  dropId: string;
  configVersionId: string | null;
  clientSeed: string;
  nonce: number;
  cardsPerPack: number;
  rarityWeightMicros: RarityMicros;
  cardPool: FairCard[];
}): Promise<Array<FairCard & { acquisitionValue: string }>> {
  const pool = normalizePool(args.cardPool);
  const byRarity = pool.reduce<Record<string, FairCard[]>>((acc, card) => {
    const k = card.rarity || "Common";
    if (!acc[k]) acc[k] = [];
    acc[k].push(card);
    return acc;
  }, {});
  const result: Array<FairCard & { acquisitionValue: string }> = [];
  const poolHash = await cardPoolHash(pool);
  for (let slot = 0; slot < args.cardsPerPack; slot += 1) {
    const prefix = `${SCHEME_VERSION}|purchase:${args.purchaseId}|drop:${args.dropId}|config:${args.configVersionId ?? "null"}|pool:${poolHash}|client:${args.clientSeed}|nonce:${args.nonce}|slot:${slot}`;
    const rarityRoll = await drawInt(args.serverSeed, `${prefix}|purpose:rarity`, 1_000_000, 0);
    const rarity = pickRarity(rarityRoll, args.rarityWeightMicros);
    const candidates = byRarity[rarity] ?? byRarity.Common ?? pool;
    const idx = await drawInt(args.serverSeed, `${prefix}|purpose:card`, candidates.length, 1000);
    const selected = candidates[idx] ?? candidates[0];
    const acquisitionValue = await deterministicValue(args.serverSeed, prefix, selected.rarity);
    result.push({ ...selected, acquisitionValue });
  }
  return result;
}

export async function selectedCardsHash(cards: Array<FairCard & { acquisitionValue: string }>): Promise<string> {
  return sha256Hex(canonicalStringify(cards.map((card) => ({
    name: card.name,
    setName: card.setName,
    rarity: card.rarity,
    imageUrl: card.imageUrl,
    acquisitionValue: card.acquisitionValue
  }))));
}

export async function verifyPackOpeningProof(args: {
  serverSeed: string;
  serverSeedHash: string;
  purchaseId: string;
  dropId: string;
  configVersionId: string | null;
  clientSeed: string;
  nonce: number;
  cardsPerPack: number;
  rarityWeightMicros: RarityMicros;
  cardPool: FairCard[];
  expectedCardPoolHash: string;
  revealedCards: Array<FairCard & { acquisitionValue: string }>;
  expectedSelectedCardsHash: string;
}): Promise<{ ok: boolean; checks: Record<string, boolean> }> {
  const derivedSeedHash = await sha256Hex(args.serverSeed);
  const poolHashComputed = await cardPoolHash(args.cardPool);
  const derivedCards = await derivePackOpening({
    serverSeed: args.serverSeed,
    purchaseId: args.purchaseId,
    dropId: args.dropId,
    configVersionId: args.configVersionId,
    clientSeed: args.clientSeed,
    nonce: args.nonce,
    cardsPerPack: args.cardsPerPack,
    rarityWeightMicros: args.rarityWeightMicros,
    cardPool: args.cardPool
  });
  const derivedCardsHash = await selectedCardsHash(derivedCards);
  const normalizeCardSet = (cards: Array<FairCard & { acquisitionValue: string }>) =>
    [...cards]
      .map((card) => ({
        name: card.name,
        setName: card.setName,
        rarity: card.rarity,
        imageUrl: card.imageUrl,
        acquisitionValue: card.acquisitionValue
      }))
      .sort((a, b) =>
        `${a.rarity}|${a.setName}|${a.name}|${a.imageUrl}|${a.acquisitionValue}`.localeCompare(
          `${b.rarity}|${b.setName}|${b.name}|${b.imageUrl}|${b.acquisitionValue}`
        )
      );
  const sameCards = canonicalStringify(normalizeCardSet(derivedCards)) === canonicalStringify(normalizeCardSet(args.revealedCards));
  const checks = {
    seedHash: derivedSeedHash === args.serverSeedHash,
    poolHash: poolHashComputed === args.expectedCardPoolHash,
    cards: sameCards,
    cardsHash: derivedCardsHash === args.expectedSelectedCardsHash
  };
  const criticalChecks = [checks.seedHash, checks.poolHash, checks.cardsHash];
  return { ok: criticalChecks.every(Boolean), checks };
}

export { SCHEME_VERSION };
