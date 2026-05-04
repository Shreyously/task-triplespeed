/**
 * Pack Economics Service
 *
 * Implements the B1 rarity weight optimizer.
 *
 * ## Algorithm Summary
 *
 * 1. Fetch live market averages μᵣ per rarity from the cards table.
 * 2. Compute two endpoint weight vectors:
 *    - w_profit: max weight on cheapest rarities (maximizes margin)
 *    - w_excite: max weight on most expensive rarities (maximizes EV/variance)
 * 3. Binary search on α ∈ [0,1] to find α* where:
 *      EV(α) = N × Σᵣ w(α)[r] × μᵣ = P × (1 - M)
 *    (EV is monotonically increasing in α, so binary search is valid for this step.)
 *
 * ⚠️  MONOTONICITY CAVEAT:
 *    Binary search finds the α that satisfies the margin constraint analytically.
 *    However, the full constraint set (win-rate floor + weight bounds + delta cap)
 *    can break clean feasibility in the α-space. Win-rate is validated post-hoc
 *    via Monte Carlo simulation. If it fails, we adjust α upward in small steps
 *    (accepting margin concession up to MAX_MARGIN_CONCESSION). If still infeasible,
 *    we report INFEASIBLE and keep the current active config — never activate a
 *    failing candidate.
 *
 * 4. Validate candidate weights via 10K Monte Carlo simulation.
 * 5. Apply delta cap (±MAX_WEIGHT_DELTA) against current active weights.
 * 6. If all 5 acceptance rules pass → activate. Else → reject + log.
 *
 * ## Rebalance Trigger
 *    The drift check computes the CURRENT ACTIVE config's margin against LIVE
 *    prices. Only triggers rebalance when drift > DRIFT_THRESHOLD.
 */

import Decimal from "decimal.js";
import { PoolClient } from "pg";
import { pool, withTx } from "../db/pool";
import {
  PACK_ECONOMICS,
  PackTier,
  TriggerReason,
  FeasibilityStatus,
} from "../config/packEconomics";
import {
  getActiveConfig,
  getNextVersion,
  createConfigVersion,
  activateConfig,
  PackConfigVersion,
} from "../repositories/packConfigRepository";
import { simulateTier, SimulationResult } from "./packSimulationService";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketAverage {
  rarity: string;
  avg: number;
  stddev: number;
  count: number;
}

export interface OptimizationResult {
  tier: string;
  weights: Record<string, number>;
  analyticalEV: number;
  analyticalMargin: number;
  feasibility: FeasibilityStatus;
  simulation: SimulationResult;
  appliedDeltaCap: boolean;
  rejectionReasons: string[];
}

export interface DriftCheckResult {
  tier: string;
  activeConfigId: string;
  activeMargin: number;
  targetMargin: number;
  drift: number;
  needsRebalance: boolean;
}

export interface RebalanceResult {
  tier: string;
  previousWeights: Record<string, number>;
  newWeights: Record<string, number> | null;
  weightDeltas: Record<string, number> | null;
  configVersionId: string | null;
  version: number | null;
  simulation: SimulationResult | null;
  status: "ACTIVATED" | "REJECTED" | "SKIPPED" | "NO_ACTIVE_CONFIG";
  rejectionReasons: string[];
  triggerReason: TriggerReason;
}

// ─── Market Data ─────────────────────────────────────────────────────────────

/** Fetch average and stddev market value per rarity from live card prices. */
export async function getMarketAverages(
  client: PoolClient
): Promise<MarketAverage[]> {
  const { rows } = await client.query(`
    SELECT
      rarity,
      COALESCE(AVG(market_value), 0)::float    AS avg,
      COALESCE(STDDEV(market_value), 0)::float AS stddev,
      COUNT(*)::int                             AS count
    FROM cards
    GROUP BY rarity
    ORDER BY avg ASC
  `);
  return rows.map((r) => ({
    rarity: r.rarity,
    avg: parseFloat(r.avg),
    stddev: parseFloat(r.stddev),
    count: parseInt(r.count, 10),
  }));
}

// ─── Weight Construction ──────────────────────────────────────────────────────

/**
 * Build the "profit-max" weight vector:
 * Greedily give w_max to the cheapest rarities first. The cheapest rarity
 * absorbs whatever budget remains after others take their max.
 */
function computeProfitMaxWeights(
  available: MarketAverage[]
): Record<string, number> {
  // Sort cheapest first
  const sorted = [...available].sort((a, b) => a.avg - b.avg);
  return allocateGreedy(sorted);
}

/**
 * Build the "excitement-max" weight vector:
 * Greedily give w_max to the most expensive rarities first.
 */
function computeExcitementMaxWeights(
  available: MarketAverage[]
): Record<string, number> {
  // Sort most expensive first
  const sorted = [...available].sort((a, b) => b.avg - a.avg);
  return allocateGreedy(sorted);
}

/**
 * Greedy allocation: give w_max to each rarity in order.
 * First rarity gets whatever budget remains (clamped to its bounds).
 */
function allocateGreedy(sorted: MarketAverage[]): Record<string, number> {
  const result: Record<string, number> = {};
  let remaining = 1.0;

  for (let i = 0; i < sorted.length; i++) {
    const { rarity } = sorted[i];
    const bounds = PACK_ECONOMICS.WEIGHT_BOUNDS[rarity] ?? { min: 0.01, max: 0.5 };

    if (i === 0) {
      // First rarity absorbs remaining budget
      result[rarity] = Math.min(Math.max(remaining, bounds.min), bounds.max);
    } else {
      const give = Math.min(bounds.max, remaining);
      result[rarity] = Math.max(give, bounds.min);
    }
    remaining -= result[rarity];
  }

  // Renormalize to exactly 1.0 (floating point safety)
  return normalize(result);
}

/** Linear interpolation: w(α) = (1 - α) × w_profit + α × w_excite */
function interpolateWeights(
  wProfit: Record<string, number>,
  wExcite: Record<string, number>,
  alpha: number
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const rarity of Object.keys(wProfit)) {
    result[rarity] = (1 - alpha) * (wProfit[rarity] ?? 0) + alpha * (wExcite[rarity] ?? 0);
  }
  return normalize(result);
}

function normalize(w: Record<string, number>): Record<string, number> {
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  if (total === 0) return w;
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(w)) {
    result[k] = v / total;
  }
  return result;
}

// ─── EV Computation ───────────────────────────────────────────────────────────

function computeAnalyticalEV(
  weights: Record<string, number>,
  averages: MarketAverage[],
  cardsPerPack: number
): number {
  const avgMap = new Map(averages.map((a) => [a.rarity, a.avg]));
  const evPerCard = Object.entries(weights).reduce(
    (sum, [rarity, w]) => sum + w * (avgMap.get(rarity) ?? 0),
    0
  );
  return evPerCard * cardsPerPack;
}

// ─── Binary Search for α* ─────────────────────────────────────────────────────

/**
 * Binary search on α to find the interpolation that produces margin = M analytically.
 * NOTE: This solves only the EV/margin target. Win-rate and delta-cap are
 * validated separately via Monte Carlo (see above caveat).
 */
function findOptimalAlpha(
  price: number,
  cardsPerPack: number,
  targetMargin: number,
  averages: MarketAverage[],
  wProfit: Record<string, number>,
  wExcite: Record<string, number>
): { alpha: number; weights: Record<string, number>; ev: number } {
  const targetEV = price * (1 - targetMargin);

  let lo = 0;
  let hi = 1;

  for (let i = 0; i < PACK_ECONOMICS.BINARY_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const w = interpolateWeights(wProfit, wExcite, mid);
    const ev = computeAnalyticalEV(w, averages, cardsPerPack);

    if (ev < targetEV) {
      lo = mid; // can afford more excitement (higher EV)
    } else {
      hi = mid; // pull back (EV is overshooting)
    }
  }

  const finalAlpha = lo;
  const finalWeights = interpolateWeights(wProfit, wExcite, finalAlpha);
  const finalEV = computeAnalyticalEV(finalWeights, averages, cardsPerPack);

  return { alpha: finalAlpha, weights: finalWeights, ev: finalEV };
}

// ─── Delta Cap ────────────────────────────────────────────────────────────────

/**
 * Apply the ±MAX_WEIGHT_DELTA cap against current active weights.
 * Returns capped weights (renormalized) and whether capping was needed.
 */
function applyDeltaCap(
  candidate: Record<string, number>,
  current: Record<string, number>
): { weights: Record<string, number>; capped: boolean } {
  let capped = false;
  const result: Record<string, number> = {};

  for (const rarity of Object.keys(candidate)) {
    const currentW = current[rarity] ?? 0;
    const delta = candidate[rarity] - currentW;
    if (Math.abs(delta) > PACK_ECONOMICS.MAX_WEIGHT_DELTA) {
      capped = true;
      result[rarity] =
        currentW + Math.sign(delta) * PACK_ECONOMICS.MAX_WEIGHT_DELTA;
    } else {
      result[rarity] = candidate[rarity];
    }
  }

  return { weights: normalize(result), capped };
}

// ─── Acceptance Rule Validation ───────────────────────────────────────────────

/**
 * The 5 acceptance rules (hard contract — ALL must pass to activate).
 * Returns array of rejection reasons (empty = all pass).
 */
function validateAcceptanceRules(
  weights: Record<string, number>,
  sim: SimulationResult,
  targetMargin: number
): string[] {
  const reasons: string[] = [];

  // Rule 1: Margin
  if (sim.platformMargin < targetMargin) {
    reasons.push(
      `Simulated margin ${(sim.platformMargin * 100).toFixed(2)}% < target ${(targetMargin * 100).toFixed(2)}%`
    );
  }

  // Rule 2: Win rate
  if (sim.winRate < PACK_ECONOMICS.WIN_RATE_FLOOR) {
    reasons.push(
      `Simulated win rate ${(sim.winRate * 100).toFixed(2)}% < floor ${(PACK_ECONOMICS.WIN_RATE_FLOOR * 100).toFixed(2)}%`
    );
  }

  // Rule 3: Weight bounds
  for (const [rarity, w] of Object.entries(weights)) {
    const bounds = PACK_ECONOMICS.WEIGHT_BOUNDS[rarity];
    if (!bounds) continue;
    if (w < bounds.min) reasons.push(`Weight for ${rarity} (${w.toFixed(4)}) below min ${bounds.min}`);
    if (w > bounds.max) reasons.push(`Weight for ${rarity} (${w.toFixed(4)}) above max ${bounds.max}`);
  }

  // Rule 4: Delta cap (already applied before calling validate — logged separately if capped)

  // Rule 5: Weights sum to 1
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  if (Math.abs(total - 1.0) > 0.001) {
    reasons.push(`Weights sum to ${total.toFixed(6)}, not 1.0`);
  }

  return reasons;
}

// ─── Core Optimizer ───────────────────────────────────────────────────────────

/**
 * Full optimization pipeline for a single tier:
 * 1. Fetch drop config for the tier
 * 2. Get market averages
 * 3. Binary search for α*
 * 4. Apply delta cap if current active config exists
 * 5. Monte Carlo validation
 * 6. Win-rate adjustment if needed
 * 7. Return OptimizationResult (does NOT persist to DB)
 */
export async function optimizeForTier(
  client: PoolClient,
  tier: string
): Promise<OptimizationResult> {
  // Get drop config (price, cardsPerPack)
  const { rows: dropRows } = await client.query(
    "SELECT DISTINCT ON (tier) price, cards_per_pack FROM drops WHERE tier = $1 ORDER BY tier, price ASC",
    [tier]
  );
  if (!dropRows[0]) throw new Error(`No drop found for tier: ${tier}`);

  const price = parseFloat(dropRows[0].price);
  const cardsPerPack = parseInt(dropRows[0].cards_per_pack, 10);

  // Market averages (only rarities with cards)
  const allAverages = await getMarketAverages(client);
  const available = allAverages.filter((a) => a.count > 0);

  if (available.length < 2) {
    const emptySim = makeEmptySimResult(tier, price);
    return {
      tier,
      weights: {},
      analyticalEV: 0,
      analyticalMargin: 0,
      feasibility: "INFEASIBLE",
      simulation: emptySim,
      appliedDeltaCap: false,
      rejectionReasons: ["Insufficient rarities in card pool (need ≥2)"],
    };
  }

  // Current active config (for delta cap)
  const activeConfig = await getActiveConfig(client, tier);
  const currentWeights: Record<string, number> = activeConfig?.rarity_weights ?? {};

  // Endpoint weight vectors
  const wProfit = computeProfitMaxWeights(available);
  const wExcite = computeExcitementMaxWeights(available);

  // Binary search for margin-satisfying α
  let { weights: candidateWeights, ev: analyticalEV } = findOptimalAlpha(
    price,
    cardsPerPack,
    PACK_ECONOMICS.TARGET_MARGIN,
    available,
    wProfit,
    wExcite
  );

  // Apply delta cap if we have a current active config
  let appliedDeltaCap = false;
  if (Object.keys(currentWeights).length > 0) {
    const { weights: capped, capped: wasCapped } = applyDeltaCap(candidateWeights, currentWeights);
    if (wasCapped) {
      candidateWeights = capped;
      analyticalEV = computeAnalyticalEV(candidateWeights, available, cardsPerPack);
      appliedDeltaCap = true;
    }
  }

  // Monte Carlo win-rate validation
  let sim = await simulateTier(client, tier, candidateWeights, PACK_ECONOMICS.SIMULATION_RUNS);

  // Win-rate adjustment: nudge α upward if below floor
  // (accepts margin concession up to MAX_MARGIN_CONCESSION)
  if (sim.winRate < PACK_ECONOMICS.WIN_RATE_FLOOR) {
    const maxAlpha = 1.0;
    let alpha = findOptimalAlpha(price, cardsPerPack, PACK_ECONOMICS.TARGET_MARGIN, available, wProfit, wExcite).alpha;

    for (let bump = PACK_ECONOMICS.WIN_RATE_ALPHA_BUMP; alpha + bump <= maxAlpha; bump += PACK_ECONOMICS.WIN_RATE_ALPHA_BUMP) {
      const adjustedWeights = interpolateWeights(wProfit, wExcite, alpha + bump);
      const adjustedEV = computeAnalyticalEV(adjustedWeights, available, cardsPerPack);
      const adjustedMargin = (price - adjustedEV) / price;

      // Accept concession up to MAX_MARGIN_CONCESSION below target
      if (adjustedMargin < PACK_ECONOMICS.TARGET_MARGIN - PACK_ECONOMICS.MAX_MARGIN_CONCESSION) break;

      const adjustedSim = await simulateTier(client, tier, adjustedWeights, PACK_ECONOMICS.SIMULATION_RUNS);
      if (adjustedSim.winRate >= PACK_ECONOMICS.WIN_RATE_FLOOR) {
        candidateWeights = adjustedWeights;
        analyticalEV = adjustedEV;
        sim = adjustedSim;
        break;
      }
    }
  }

  const analyticalMargin = (price - analyticalEV) / price;
  const rejectionReasons = validateAcceptanceRules(candidateWeights, sim, PACK_ECONOMICS.TARGET_MARGIN);

  let feasibility: FeasibilityStatus;
  if (rejectionReasons.length > 0) {
    feasibility = "INFEASIBLE";
  } else if (sim.winRate < PACK_ECONOMICS.WIN_RATE_FLOOR + PACK_ECONOMICS.MARGINAL_WIN_RATE_BUFFER) {
    feasibility = "MARGINAL";
  } else {
    feasibility = "FEASIBLE";
  }

  return {
    tier,
    weights: candidateWeights,
    analyticalEV,
    analyticalMargin,
    feasibility,
    simulation: sim,
    appliedDeltaCap,
    rejectionReasons,
  };
}

// ─── Drift Check ──────────────────────────────────────────────────────────────

/**
 * Check if the CURRENT ACTIVE config's margin has drifted from the target
 * when re-evaluated against LIVE market prices.
 * This is the rebalance trigger — not the post-optimization margin.
 */
export async function checkDrift(
  client: PoolClient,
  tier: string
): Promise<DriftCheckResult> {
  const activeConfig = await getActiveConfig(client, tier);
  if (!activeConfig) {
    return {
      tier,
      activeConfigId: "",
      activeMargin: 0,
      targetMargin: PACK_ECONOMICS.TARGET_MARGIN,
      drift: 1,
      needsRebalance: true, // No config → needs bootstrap
    };
  }

  // Get drop config
  const { rows: dropRows } = await client.query(
    "SELECT DISTINCT ON (tier) price, cards_per_pack FROM drops WHERE tier = $1 ORDER BY tier, price ASC",
    [tier]
  );
  if (!dropRows[0]) {
    return {
      tier,
      activeConfigId: activeConfig.id,
      activeMargin: 0,
      targetMargin: PACK_ECONOMICS.TARGET_MARGIN,
      drift: 0,
      needsRebalance: false,
    };
  }

  const price = parseFloat(dropRows[0].price);
  const cardsPerPack = parseInt(dropRows[0].cards_per_pack, 10);
  const averages = await getMarketAverages(client);
  const targetMargin = parseFloat(String(activeConfig.target_margin ?? PACK_ECONOMICS.TARGET_MARGIN));

  // EV using the ACTIVE config's weights against CURRENT prices
  const currentEV = computeAnalyticalEV(activeConfig.rarity_weights, averages, cardsPerPack);
  const currentMargin = (price - currentEV) / price;
  const drift = Math.abs(currentMargin - targetMargin);

  return {
    tier,
    activeConfigId: activeConfig.id,
    activeMargin: currentMargin,
    targetMargin,
    drift,
    needsRebalance: drift > PACK_ECONOMICS.DRIFT_THRESHOLD,
  };
}

// ─── Rebalance Orchestrator ───────────────────────────────────────────────────

/**
 * Run the full optimize → validate → (conditionally) activate pipeline for one tier.
 * Hard contract: NEVER activates a config that fails any acceptance rule.
 */
export async function rebalanceTier(
  tier: string,
  triggerReason: TriggerReason,
  dryRun = false
): Promise<RebalanceResult> {
  const client = await pool.connect();
  try {
    const activeConfig = await getActiveConfig(client, tier);
    const previousWeights = activeConfig?.rarity_weights ?? {};

    const opt = await optimizeForTier(client, tier);

    if (opt.feasibility === "INFEASIBLE") {
      console.warn(`[PackEconomics] Rebalance REJECTED for ${tier}:`, opt.rejectionReasons);
      return {
        tier,
        previousWeights,
        newWeights: null,
        weightDeltas: null,
        configVersionId: null,
        version: null,
        simulation: opt.simulation,
        status: "REJECTED",
        rejectionReasons: opt.rejectionReasons,
        triggerReason,
      };
    }

    const weightDeltas: Record<string, number> = {};
    for (const rarity of Object.keys(opt.weights)) {
      weightDeltas[rarity] = (opt.weights[rarity] ?? 0) - (previousWeights[rarity] ?? 0);
    }

    if (dryRun) {
      return {
        tier,
        previousWeights,
        newWeights: opt.weights,
        weightDeltas,
        configVersionId: null,
        version: null,
        simulation: opt.simulation,
        status: "SKIPPED",
        rejectionReasons: [],
        triggerReason,
      };
    }

    // Build market snapshot for storage
    const allAverages = await getMarketAverages(client);
    const marketSnapshot: Record<string, { avg: number; count: number }> = {};
    for (const a of allAverages) {
      marketSnapshot[a.rarity] = { avg: a.avg, count: a.count };
    }

    // Persist and activate atomically
    return await withTx(async (txClient) => {
      const nextVersion = await getNextVersion(txClient, tier);
      const newConfig = await createConfigVersion(txClient, {
        tier,
        version: nextVersion,
        rarityWeights: opt.weights,
        targetMargin: PACK_ECONOMICS.TARGET_MARGIN,
        actualEv: opt.analyticalEV,
        simulatedMargin: opt.simulation.platformMargin,
        simulatedWinRate: opt.simulation.winRate,
        marketSnapshot,
        triggerReason,
      });
      await activateConfig(txClient, newConfig.id, tier);

      console.log(`[PackEconomics] Activated v${nextVersion} for ${tier} (${triggerReason})`);

      return {
        tier,
        previousWeights,
        newWeights: opt.weights,
        weightDeltas,
        configVersionId: newConfig.id,
        version: nextVersion,
        simulation: opt.simulation,
        status: "ACTIVATED" as const,
        rejectionReasons: [],
        triggerReason,
      };
    });
  } finally {
    client.release();
  }
}

/** Run drift check + conditional rebalance for all tiers. Called by the background worker. */
export async function rebalanceIfNeeded(
  triggerReason: TriggerReason = "scheduled"
): Promise<RebalanceResult[]> {
  const results: RebalanceResult[] = [];

  for (const tier of PACK_ECONOMICS.TIERS) {
    const client = await pool.connect();
    try {
      const drift = await checkDrift(client, tier);
      if (!drift.needsRebalance) {
        console.log(`[PackEconomics] ${tier} within tolerance (drift=${(drift.drift * 100).toFixed(2)}%) — skipping`);
        continue;
      }
      console.log(`[PackEconomics] ${tier} drift=${(drift.drift * 100).toFixed(2)}% — rebalancing`);
    } finally {
      client.release();
    }

    const result = await rebalanceTier(tier, triggerReason);
    results.push(result);
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmptySimResult(tier: string, price: number): SimulationResult {
  return {
    tier,
    price,
    runs: 0,
    meanPackValue: 0,
    medianPackValue: 0,
    stdDevPackValue: 0,
    percentiles: { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0 },
    winRate: 0,
    platformMargin: 1,
    projectedProfit: { per1000Packs: 0, per10000Packs: 0 },
    rarityHitRates: {},
    bestPack: 0,
    worstPack: 0,
    feasibility: "INFEASIBLE",
  };
}
