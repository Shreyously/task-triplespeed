/**
 * Pack Simulation Service
 *
 * Monte Carlo engine for pack opening simulation.
 * Used both for the POST /analytics/simulate endpoint and as the
 * win-rate validation step inside the weight optimizer.
 */

import { PoolClient } from "pg";
import { pool } from "../db/pool";
import { PACK_ECONOMICS, FeasibilityStatus } from "../config/packEconomics";

export interface SimulationResult {
  tier: string;
  price: number;
  runs: number;
  meanPackValue: number;
  medianPackValue: number;
  stdDevPackValue: number;
  percentiles: {
    p5: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
  };
  winRate: number;          // fraction of packs where value >= price
  platformMargin: number;   // (price - mean) / price
  projectedProfit: {
    per1000Packs: number;
    per10000Packs: number;
  };
  rarityHitRates: Record<string, number>; // actual rarity frequencies across all cards drawn
  bestPack: number;
  worstPack: number;
  feasibility: FeasibilityStatus;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Weighted random pick from a rarity weight map. Same algorithm as packService.ts. */
function weightedPick(weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((acc, [, w]) => acc + w, 0);
  let roll = Math.random() * total;
  for (const [rarity, w] of entries) {
    roll -= w;
    if (roll <= 0) return rarity;
  }
  return entries[entries.length - 1]?.[0] ?? "Common";
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Core simulation ──────────────────────────────────────────────────────────

/**
 * Run N pack opening simulations for a given tier with given weights.
 *
 * Uses the actual card values from the database (grouped by rarity) so that
 * results reflect current live prices, not just averages.
 *
 * @param client  - DB client (caller manages connection lifecycle)
 * @param tier    - Pack tier string for metadata
 * @param weights - Rarity weights to use (if null, reads active config from DB)
 * @param runs    - Number of simulations (default: SIMULATION_RUNS = 10,000)
 */
export async function simulateTier(
  client: PoolClient,
  tier: string,
  weights: Record<string, number> | null = null,
  runs: number = PACK_ECONOMICS.SIMULATION_RUNS
): Promise<SimulationResult> {
  // Get drop config
  const { rows: dropRows } = await client.query(
    "SELECT DISTINCT ON (tier) price, cards_per_pack FROM drops WHERE tier = $1 ORDER BY tier, price ASC",
    [tier]
  );
  if (!dropRows[0]) throw new Error(`No drop found for tier: ${tier}`);

  const price = parseFloat(dropRows[0].price);
  const cardsPerPack = parseInt(dropRows[0].cards_per_pack, 10);

  // If no weights supplied, read from active config
  let simWeights = weights;
  if (!simWeights) {
    const { rows: configRows } = await client.query(
      "SELECT rarity_weights FROM pack_config_versions WHERE tier = $1 AND is_active = true",
      [tier]
    );
    simWeights = configRows[0]?.rarity_weights ?? { Common: 1 };
  }

  // Load card values by rarity from live DB (array of floats per rarity)
  const { rows: cardRows } = await client.query(
    "SELECT rarity, market_value::float AS value FROM cards ORDER BY rarity"
  );

  const cardsByRarity: Record<string, number[]> = {};
  for (const row of cardRows) {
    if (!cardsByRarity[row.rarity]) cardsByRarity[row.rarity] = [];
    cardsByRarity[row.rarity].push(parseFloat(row.value));
  }

  // Monte Carlo simulation
  const packValues: number[] = [];
  const rarityHits: Record<string, number> = {};
  let wins = 0;

  for (let i = 0; i < runs; i++) {
    let packValue = 0;
    for (let c = 0; c < cardsPerPack; c++) {
      const rarity = weightedPick(simWeights!);
      rarityHits[rarity] = (rarityHits[rarity] ?? 0) + 1;

      // Pick a random card from this rarity; fall back to Common, then global avg
      const pool = cardsByRarity[rarity] ?? cardsByRarity["Common"] ?? [];
      const cardValue =
        pool.length > 0
          ? pool[Math.floor(Math.random() * pool.length)]
          : 0.25; // ultimate fallback: $0.25

      packValue += cardValue;
    }
    packValues.push(packValue);
    if (packValue >= price) wins++;
  }

  // Statistics
  const sorted = [...packValues].sort((a, b) => a - b);
  const mean = packValues.reduce((s, v) => s + v, 0) / runs;
  const sd = stddev(packValues, mean);
  const margin = (price - mean) / price;
  const winRate = wins / runs;

  // Rarity hit rates (per card drawn, not per pack)
  const totalCards = runs * cardsPerPack;
  const rarityHitRates: Record<string, number> = {};
  for (const [rarity, count] of Object.entries(rarityHits)) {
    rarityHitRates[rarity] = count / totalCards;
  }

  // Feasibility
  let feasibility: FeasibilityStatus;
  if (margin < PACK_ECONOMICS.TARGET_MARGIN || winRate < PACK_ECONOMICS.WIN_RATE_FLOOR) {
    feasibility = "INFEASIBLE";
  } else if (winRate < PACK_ECONOMICS.WIN_RATE_FLOOR + PACK_ECONOMICS.MARGINAL_WIN_RATE_BUFFER) {
    feasibility = "MARGINAL";
  } else {
    feasibility = "FEASIBLE";
  }

  return {
    tier,
    price,
    runs,
    meanPackValue: parseFloat(mean.toFixed(2)),
    medianPackValue: parseFloat(percentile(sorted, 50).toFixed(2)),
    stdDevPackValue: parseFloat(sd.toFixed(2)),
    percentiles: {
      p5:  parseFloat(percentile(sorted, 5).toFixed(2)),
      p10: parseFloat(percentile(sorted, 10).toFixed(2)),
      p25: parseFloat(percentile(sorted, 25).toFixed(2)),
      p50: parseFloat(percentile(sorted, 50).toFixed(2)),
      p75: parseFloat(percentile(sorted, 75).toFixed(2)),
      p90: parseFloat(percentile(sorted, 90).toFixed(2)),
      p95: parseFloat(percentile(sorted, 95).toFixed(2)),
    },
    winRate: parseFloat(winRate.toFixed(4)),
    platformMargin: parseFloat(margin.toFixed(4)),
    projectedProfit: {
      per1000Packs:  parseFloat((margin * price * 1_000).toFixed(2)),
      per10000Packs: parseFloat((margin * price * 10_000).toFixed(2)),
    },
    rarityHitRates,
    bestPack:  parseFloat(sorted[sorted.length - 1].toFixed(2)),
    worstPack: parseFloat(sorted[0].toFixed(2)),
    feasibility,
  };
}

/** Simulate all tiers using their current active config weights (or custom overrides). */
export async function simulateAllTiers(
  customWeightsByTier?: Record<string, Record<string, number>>,
  runs: number = PACK_ECONOMICS.SIMULATION_RUNS
): Promise<SimulationResult[]> {
  const client = await pool.connect();
  try {
    return await Promise.all(
      PACK_ECONOMICS.TIERS.map((tier) =>
        simulateTier(client, tier, customWeightsByTier?.[tier] ?? null, runs)
      )
    );
  } finally {
    client.release();
  }
}
