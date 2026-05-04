/**
 * Pack Economics Service
 *
 * Implements the B1 rarity weight optimizer.
 */

import { PoolClient } from "pg";
import { pool, withTx } from "../db/pool";
import {
  PACK_ECONOMICS,
  type TriggerReason,
  type FeasibilityStatus,
} from "../config/packEconomics";
import {
  getActiveConfig,
  getNextVersion,
  createConfigVersion,
  activateConfig,
} from "../repositories/packConfigRepository";
import { simulateTier, type SimulationResult } from "./packSimulationService";
import { getPoolMarketAverages } from "./packMarketDataService";

export interface MarketAverage {
  rarity: string;
  avg: number;
  stddev: number;
  count: number;
}

interface WeightConstraint {
  min: number;
  max: number;
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

export async function getMarketAverages(client: PoolClient): Promise<MarketAverage[]> {
  return getPoolMarketAverages();
}

function buildConstraints(rarities: string[]): Record<string, WeightConstraint> {
  return rarities.reduce<Record<string, WeightConstraint>>((acc, rarity) => {
    acc[rarity] = PACK_ECONOMICS.WEIGHT_BOUNDS[rarity] ?? { min: 0.01, max: 0.5 };
    return acc;
  }, {});
}

function finalizeWeights(weights: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [rarity, value] of Object.entries(weights)) {
    result[rarity] = Number(value.toFixed(8));
  }
  return result;
}

export function projectWeightsToConstraints(
  target: Record<string, number>,
  constraints: Record<string, WeightConstraint>
): Record<string, number> {
  const keys = Object.keys(constraints);
  const result: Record<string, number> = {};

  for (const key of keys) {
    const constraint = constraints[key];
    const raw = target[key] ?? constraint.min;
    result[key] = Math.min(constraint.max, Math.max(constraint.min, raw));
  }

  let delta = 1 - Object.values(result).reduce((sum, value) => sum + value, 0);
  if (delta > 0) {
    for (const key of keys) {
      const slack = constraints[key].max - result[key];
      if (slack <= 0) continue;
      const add = Math.min(slack, delta);
      result[key] += add;
      delta -= add;
      if (delta <= 1e-9) break;
    }
  } else if (delta < 0) {
    let excess = Math.abs(delta);
    for (const key of [...keys].reverse()) {
      const removable = result[key] - constraints[key].min;
      if (removable <= 0) continue;
      const take = Math.min(removable, excess);
      result[key] -= take;
      excess -= take;
      if (excess <= 1e-9) break;
    }
    delta = -excess;
  }

  // Validate that redistribution hasn't violated individual bounds
  for (const key of keys) {
    if (result[key] < constraints[key].min - 1e-9 || result[key] > constraints[key].max + 1e-9) {
      throw new Error(`Weight for ${key} (${result[key]}) violates bounds [${constraints[key].min}, ${constraints[key].max}]`);
    }
  }

  const total = Object.values(result).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error("Unable to project weights into a feasible bounded simplex");
  }

  return finalizeWeights(result);
}

export function allocateGreedy(sorted: MarketAverage[]): Record<string, number> {
  const constraints = buildConstraints(sorted.map(({ rarity }) => rarity));
  const result: Record<string, number> = {};
  let minSum = 0;
  let maxSum = 0;

  for (const rarity of Object.keys(constraints)) {
    result[rarity] = constraints[rarity].min;
    minSum += constraints[rarity].min;
    maxSum += constraints[rarity].max;
  }

  if (minSum > 1.000001 || maxSum < 0.999999) {
    throw new Error("Weight bounds are infeasible for the available rarity set");
  }

  let remaining = 1 - minSum;
  for (const { rarity } of sorted) {
    const capacity = constraints[rarity].max - result[rarity];
    const add = Math.min(capacity, remaining);
    result[rarity] += add;
    remaining -= add;
    if (remaining <= 1e-9) break;
  }

  if (remaining > 1e-6) {
    throw new Error("Unable to allocate endpoint weights within configured bounds");
  }

  return finalizeWeights(result);
}

export function computeProfitMaxWeights(available: MarketAverage[]): Record<string, number> {
  return allocateGreedy([...available].sort((a, b) => a.avg - b.avg));
}

export function computeExcitementMaxWeights(available: MarketAverage[]): Record<string, number> {
  return allocateGreedy([...available].sort((a, b) => b.avg - a.avg));
}

function interpolateWeights(
  wProfit: Record<string, number>,
  wExcite: Record<string, number>,
  alpha: number
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const rarity of Object.keys(wProfit)) {
    result[rarity] = ((1 - alpha) * (wProfit[rarity] ?? 0)) + (alpha * (wExcite[rarity] ?? 0));
  }
  return projectWeightsToConstraints(result, buildConstraints(Object.keys(result)));
}

function computeAnalyticalEV(
  weights: Record<string, number>,
  averages: MarketAverage[],
  cardsPerPack: number
): number {
  const avgMap = new Map(averages.map((average) => [average.rarity, average.avg]));
  const evPerCard = Object.entries(weights).reduce(
    (sum, [rarity, weight]) => sum + (weight * (avgMap.get(rarity) ?? 0)),
    0
  );
  return evPerCard * cardsPerPack;
}

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

  for (let index = 0; index < PACK_ECONOMICS.BINARY_SEARCH_ITERATIONS; index += 1) {
    const mid = (lo + hi) / 2;
    const weights = interpolateWeights(wProfit, wExcite, mid);
    const ev = computeAnalyticalEV(weights, averages, cardsPerPack);

    if (ev < targetEV) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const alpha = lo;
  const weights = interpolateWeights(wProfit, wExcite, alpha);
  return {
    alpha,
    weights,
    ev: computeAnalyticalEV(weights, averages, cardsPerPack),
  };
}

function buildDeltaConstraints(
  candidate: Record<string, number>,
  current: Record<string, number>
): Record<string, WeightConstraint> {
  return Object.keys(candidate).reduce<Record<string, WeightConstraint>>((acc, rarity) => {
    const currentWeight = current[rarity] ?? 0;
    const bounds = PACK_ECONOMICS.WEIGHT_BOUNDS[rarity] ?? { min: 0.01, max: 0.5 };
    const min = Math.max(bounds.min, currentWeight - PACK_ECONOMICS.MAX_WEIGHT_DELTA);
    const max = Math.min(bounds.max, currentWeight + PACK_ECONOMICS.MAX_WEIGHT_DELTA);

    // Ensure feasible interval (for new rarities where currentWeight = 0)
    if (min > max) {
      acc[rarity] = bounds;
    } else {
      acc[rarity] = { min, max };
    }
    return acc;
  }, {});
}

export function applyDeltaCap(
  candidate: Record<string, number>,
  current: Record<string, number>
): { weights: Record<string, number>; capped: boolean } {
  const constraints = buildDeltaConstraints(candidate, current);
  const projected = projectWeightsToConstraints(candidate, constraints);
  const capped = Object.keys(candidate).some((rarity) => Math.abs((candidate[rarity] ?? 0) - (projected[rarity] ?? 0)) > 1e-6);
  return { weights: projected, capped };
}

function validateAcceptanceRules(
  weights: Record<string, number>,
  sim: SimulationResult,
  targetMargin: number,
  currentWeights: Record<string, number> = {},
  winRateFloor: number = PACK_ECONOMICS.WIN_RATE_FLOOR
): string[] {
  const reasons: string[] = [];

  if (sim.platformMargin < targetMargin) {
    reasons.push(
      `Simulated margin ${(sim.platformMargin * 100).toFixed(2)}% < target ${(targetMargin * 100).toFixed(2)}%`
    );
  }

  if (sim.winRate < winRateFloor) {
    reasons.push(
      `Simulated win rate ${(sim.winRate * 100).toFixed(2)}% < floor ${(winRateFloor * 100).toFixed(2)}%`
    );
  }

  for (const [rarity, weight] of Object.entries(weights)) {
    const bounds = PACK_ECONOMICS.WEIGHT_BOUNDS[rarity];
    if (!bounds) continue;
    if (weight < bounds.min) reasons.push(`Weight for ${rarity} (${weight.toFixed(4)}) below min ${bounds.min}`);
    if (weight > bounds.max) reasons.push(`Weight for ${rarity} (${weight.toFixed(4)}) above max ${bounds.max}`);
  }

  const deltaRarities = new Set([...Object.keys(currentWeights), ...Object.keys(weights)]);
  // Only check deltas for rarities present in both configs to avoid false positives
  const commonRarities = Object.keys(currentWeights).filter((rarity) => rarity in weights);
  for (const rarity of commonRarities) {
    const currentWeight = currentWeights[rarity];
    const nextWeight = weights[rarity];
    if (Math.abs(nextWeight - currentWeight) > PACK_ECONOMICS.MAX_WEIGHT_DELTA + 1e-6) {
      reasons.push(
        `Weight delta for ${rarity} (${Math.abs(nextWeight - currentWeight).toFixed(4)}) exceeds cap ${PACK_ECONOMICS.MAX_WEIGHT_DELTA}`
      );
    }
  }

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1.0) > 0.001) {
    reasons.push(`Weights sum to ${total.toFixed(6)}, not 1.0`);
  }

  return reasons;
}

export async function optimizeForTier(
  client: PoolClient,
  tier: string
): Promise<OptimizationResult> {
  const { rows: dropRows } = await client.query(
    `SELECT price, cards_per_pack FROM drops
     WHERE tier = $1 AND starts_at <= NOW() AND ends_at > NOW() AND inventory > 0
     ORDER BY starts_at DESC LIMIT 1`,
    [tier]
  );
  if (!dropRows[0]) throw new Error(`No drop found for tier: ${tier}`);

  // Get tier-specific targets (fallback to global defaults)
  const tierTargets = PACK_ECONOMICS.TIER_TARGETS[tier] || {
    targetMargin: PACK_ECONOMICS.TARGET_MARGIN,
    winRateFloor: PACK_ECONOMICS.WIN_RATE_FLOOR,
  };

  const price = parseFloat(dropRows[0].price);
  const cardsPerPack = parseInt(dropRows[0].cards_per_pack, 10);
  const allAverages = await getMarketAverages(client);
  const available = allAverages.filter((average) => average.count > 0);

  if (available.length < 2) {
    return {
      tier,
      weights: {},
      analyticalEV: 0,
      analyticalMargin: 0,
      feasibility: "INFEASIBLE",
      simulation: makeEmptySimResult(tier, price),
      appliedDeltaCap: false,
      rejectionReasons: ["Insufficient rarities in card pool (need >=2)"],
    };
  }

  const activeConfig = await getActiveConfig(client, tier);
  const currentWeights: Record<string, number> = activeConfig?.rarity_weights ?? {};
  const wProfit = computeProfitMaxWeights(available);
  const wExcite = computeExcitementMaxWeights(available);

  const baseline = findOptimalAlpha(
    price,
    cardsPerPack,
    PACK_ECONOMICS.TARGET_MARGIN,
    available,
    wProfit,
    wExcite
  );

  let candidateWeights = baseline.weights;
  let analyticalEV = baseline.ev;
  let appliedDeltaCap = false;

  if (Object.keys(currentWeights).length > 0) {
    const capped = applyDeltaCap(candidateWeights, currentWeights);
    candidateWeights = capped.weights;
    analyticalEV = computeAnalyticalEV(candidateWeights, available, cardsPerPack);
    appliedDeltaCap = capped.capped;
  }

  let sim = await simulateTier(client, tier, candidateWeights, PACK_ECONOMICS.SIMULATION_RUNS);

  if (sim.winRate < tierTargets.winRateFloor) {
    let bumpIteration = 0;
    for (
      let alpha = baseline.alpha + PACK_ECONOMICS.WIN_RATE_ALPHA_BUMP;
      alpha <= 1.000001 && bumpIteration < PACK_ECONOMICS.MAX_BUMP_ITERATIONS;
      alpha += PACK_ECONOMICS.WIN_RATE_ALPHA_BUMP
    ) {
      bumpIteration++;
      let adjustedWeights = interpolateWeights(wProfit, wExcite, alpha);
      if (Object.keys(currentWeights).length > 0) {
        const capped = applyDeltaCap(adjustedWeights, currentWeights);
        adjustedWeights = capped.weights;
        appliedDeltaCap = appliedDeltaCap || capped.capped;
      }

      const adjustedEV = computeAnalyticalEV(adjustedWeights, available, cardsPerPack);
      const adjustedMargin = (price - adjustedEV) / price;
      if (adjustedMargin < PACK_ECONOMICS.TARGET_MARGIN - PACK_ECONOMICS.MAX_MARGIN_CONCESSION) {
        break;
      }

      // Use reduced iterations during bump loop for performance
      const adjustedSim = await simulateTier(client, tier, adjustedWeights, PACK_ECONOMICS.BUMP_LOOP_SIMULATION_RUNS);
      if (adjustedSim.winRate >= tierTargets.winRateFloor) {
        candidateWeights = adjustedWeights;
        analyticalEV = adjustedEV;
        // Run final validation with full simulation runs
        sim = await simulateTier(client, tier, adjustedWeights, PACK_ECONOMICS.SIMULATION_RUNS);
        break;
      }
    }
  }

  const analyticalMargin = (price - analyticalEV) / price;

  const rejectionReasons = validateAcceptanceRules(
    candidateWeights,
    sim,
    tierTargets.targetMargin,
    currentWeights,
    tierTargets.winRateFloor
  );

  const feasibility: FeasibilityStatus =
    rejectionReasons.length > 0
      ? "INFEASIBLE"
      : sim.winRate < tierTargets.winRateFloor + PACK_ECONOMICS.MARGINAL_WIN_RATE_BUFFER
        ? "MARGINAL"
        : "FEASIBLE";

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
      needsRebalance: true,
    };
  }

  const { rows: dropRows } = await client.query(
    `SELECT price, cards_per_pack FROM drops
     WHERE tier = $1 AND starts_at <= NOW() AND ends_at > NOW() AND inventory > 0
     ORDER BY starts_at DESC LIMIT 1`,
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

export async function rebalanceTier(
  tier: string,
  triggerReason: TriggerReason,
  dryRun = false
): Promise<RebalanceResult> {
  const client = await pool.connect();
  try {
    const activeConfig = await getActiveConfig(client, tier);
    const previousWeights = activeConfig?.rarity_weights ?? {};
    const optimization = await optimizeForTier(client, tier);

    if (optimization.feasibility === "INFEASIBLE") {
      console.warn(`[PackEconomics] Rebalance REJECTED for ${tier}:`, optimization.rejectionReasons);
      return {
        tier,
        previousWeights,
        newWeights: null,
        weightDeltas: null,
        configVersionId: null,
        version: null,
        simulation: optimization.simulation,
        status: "REJECTED",
        rejectionReasons: optimization.rejectionReasons,
        triggerReason,
      };
    }

    const weightDeltas = Object.keys(optimization.weights).reduce<Record<string, number>>((acc, rarity) => {
      acc[rarity] = (optimization.weights[rarity] ?? 0) - (previousWeights[rarity] ?? 0);
      return acc;
    }, {});

    if (dryRun) {
      return {
        tier,
        previousWeights,
        newWeights: optimization.weights,
        weightDeltas,
        configVersionId: null,
        version: null,
        simulation: optimization.simulation,
        status: "SKIPPED",
        rejectionReasons: [],
        triggerReason,
      };
    }

    const allAverages = await getMarketAverages(client);
    const marketSnapshot = allAverages.reduce<Record<string, { avg: number; count: number }>>((acc, average) => {
      acc[average.rarity] = { avg: average.avg, count: average.count };
      return acc;
    }, {});

    return withTx(async (txClient) => {
      const nextVersion = await getNextVersion(txClient, tier);
      const newConfig = await createConfigVersion(txClient, {
        tier,
        version: nextVersion,
        rarityWeights: optimization.weights,
        targetMargin: PACK_ECONOMICS.TARGET_MARGIN,
        actualEv: optimization.analyticalEV,
        simulatedMargin: optimization.simulation.platformMargin,
        simulatedWinRate: optimization.simulation.winRate,
        marketSnapshot,
        triggerReason,
      });
      await activateConfig(txClient, newConfig.id, tier);

      console.log(`[PackEconomics] Activated v${nextVersion} for ${tier} (${triggerReason})`);

      return {
        tier,
        previousWeights,
        newWeights: optimization.weights,
        weightDeltas,
        configVersionId: newConfig.id,
        version: nextVersion,
        simulation: optimization.simulation,
        status: "ACTIVATED" as const,
        rejectionReasons: [],
        triggerReason,
      };
    });
  } finally {
    client.release();
  }
}

export async function rebalanceIfNeeded(
  triggerReason: TriggerReason = "scheduled"
): Promise<RebalanceResult[]> {
  const results: RebalanceResult[] = [];

  for (const tier of PACK_ECONOMICS.TIERS) {
    const client = await pool.connect();
    try {
      const drift = await checkDrift(client, tier);
      if (!drift.needsRebalance) {
        console.log(`[PackEconomics] ${tier} within tolerance (drift=${(drift.drift * 100).toFixed(2)}%) - skipping`);
        continue;
      }
      console.log(`[PackEconomics] ${tier} drift=${(drift.drift * 100).toFixed(2)}% - rebalancing`);
    } finally {
      client.release();
    }

    results.push(await rebalanceTier(tier, triggerReason));
  }

  return results;
}

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
