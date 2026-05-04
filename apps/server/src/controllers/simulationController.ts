import { Request, Response } from "express";
import { config } from "../config/env";
import { PACK_ECONOMICS } from "../config/packEconomics";
import { rebalanceTier, optimizeForTier, checkDrift, getMarketAverages } from "../services/packEconomicsService";
import { simulateAllTiers, simulateTier } from "../services/packSimulationService";
import { pool } from "../db/pool";
import { getConfigHistory, getAllActiveConfigs } from "../repositories/packConfigRepository";

// ─── Simulation Endpoint ──────────────────────────────────────────────────────

/**
 * POST /analytics/simulate
 *
 * Body (all optional):
 *   tier?            - Specific tier to simulate; omit for all tiers
 *   customWeights?   - Override weights { "Basic": { "Common": 0.7, ... }, ... }
 *   runs?            - Number of Monte Carlo runs (default: 10,000, max: 50,000)
 *
 * Returns: simulation results + current market snapshot
 */
export async function simulateController(req: Request, res: Response) {
  if (req.user!.userId !== config.platformUserId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { tier, customWeights, runs: rawRuns } = req.body as {
    tier?: string;
    customWeights?: Record<string, Record<string, number>>;
    runs?: number;
  };

  const runs = Math.min(rawRuns ?? PACK_ECONOMICS.SIMULATION_RUNS, 50_000);

  const client = await pool.connect();
  try {
    // Market snapshot for response context
    const averages = await getMarketAverages(client);
    const marketSnapshot: Record<string, { avg: number; count: number }> = {};
    for (const a of averages) {
      marketSnapshot[a.rarity] = { avg: parseFloat(a.avg.toFixed(2)), count: a.count };
    }

    let results;
    if (tier) {
      if (!PACK_ECONOMICS.TIERS.includes(tier as any)) {
        return res.status(400).json({ error: `Invalid tier. Must be one of: ${PACK_ECONOMICS.TIERS.join(", ")}` });
      }
      const tierWeights = customWeights?.[tier] ?? null;
      const sim = await simulateTier(client, tier, tierWeights, runs);
      results = [sim];
    } else {
      results = await Promise.all(
        PACK_ECONOMICS.TIERS.map((t) =>
          simulateTier(client, t, customWeights?.[t] ?? null, runs)
        )
      );
    }

    res.json({
      tiers: results,
      marketSnapshot,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    client.release();
  }
}

// ─── Rebalance Endpoint ───────────────────────────────────────────────────────

/**
 * POST /analytics/rebalance
 *
 * Body:
 *   dryRun?  - If true, compute and return candidate weights but do NOT activate (default: false)
 *   tier?    - Specific tier to rebalance; omit for all tiers
 *
 * Returns: per-tier result with previous/new weights, deltas, simulation, status
 */
export async function rebalanceController(req: Request, res: Response) {
  if (req.user!.userId !== config.platformUserId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { dryRun = false, tier } = req.body as {
    dryRun?: boolean;
    tier?: string;
  };

  const tiers = tier
    ? [tier]
    : [...PACK_ECONOMICS.TIERS];

  for (const t of tiers) {
    if (!PACK_ECONOMICS.TIERS.includes(t as any)) {
      return res.status(400).json({ error: `Invalid tier: ${t}` });
    }
  }

  const results = await Promise.all(
    tiers.map((t) => rebalanceTier(t, "manual", dryRun))
  );

  res.json({
    results,
    dryRun,
    rebalancedAt: new Date().toISOString(),
  });
}

// ─── Drift Status Endpoint ────────────────────────────────────────────────────

/**
 * GET /analytics/drift
 *
 * Returns current margin drift for all tiers relative to their active configs.
 * Used by the admin dashboard to monitor when rebalancing is needed.
 */
export async function driftStatusController(req: Request, res: Response) {
  if (req.user!.userId !== config.platformUserId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const client = await pool.connect();
  try {
    const driftResults = await Promise.all(
      PACK_ECONOMICS.TIERS.map((tier) => checkDrift(client, tier))
    );

    res.json({
      tiers: driftResults,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    client.release();
  }
}

// ─── Config History Endpoint ──────────────────────────────────────────────────

/**
 * GET /analytics/config-history/:tier
 *
 * Returns version history for a tier's pack config (most recent first).
 */
export async function configHistoryController(req: Request, res: Response) {
  if (req.user!.userId !== config.platformUserId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { tier } = req.params;
  if (!PACK_ECONOMICS.TIERS.includes(tier as any)) {
    return res.status(400).json({ error: `Invalid tier: ${tier}` });
  }

  const client = await pool.connect();
  try {
    const history = await getConfigHistory(client, tier, 50);
    res.json({ tier, history });
  } finally {
    client.release();
  }
}
