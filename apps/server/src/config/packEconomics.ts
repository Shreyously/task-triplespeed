// Pack Economics Algorithm — Configuration Constants
// Justification for defaults: see docs/ARCHITECTURE.md §Pack Economics

export const PACK_ECONOMICS = {
  // Target platform gross margin per pack (20% = 80¢ returned per $1 spent)
  TARGET_MARGIN: 0.20,

  // Minimum win-rate: fraction of pack openings where value >= price paid
  // 25% = 1-in-4 packs is a "win" — intermittent reinforcement retention floor
  // Note: Basic tier uses a lower floor (15%) due to structural feasibility constraints
  WIN_RATE_FLOOR: 0.25,

  // Tier-specific targets (overrides defaults where specified)
  TIER_TARGETS: {
    "Basic": { targetMargin: 0.20, winRateFloor: 0.15 },  // Lower win-rate for Basic due to price/cards constraint
    "Pro": { targetMargin: 0.20, winRateFloor: 0.25 },
    "Elite": { targetMargin: 0.20, winRateFloor: 0.25 },
  } as Record<string, { targetMargin: number; winRateFloor: number }>,

  // Monte Carlo runs for win-rate validation and simulation endpoint
  SIMULATION_RUNS: 10_000,

  // Reduced Monte Carlo runs for win-rate bump loop (faster iteration during optimization)
  BUMP_LOOP_SIMULATION_RUNS: 2_000,

  // Maximum iterations for win-rate bump loop (prevents excessive computation)
  MAX_BUMP_ITERATIONS: 15,

  // Maximum absolute weight change per rarity per rebalance cycle (±8%)
  // Prevents whiplash from sudden price spikes / crashes
  MAX_WEIGHT_DELTA: 0.08,

  // Binary search iteration count (converges to <0.0001% error in 50 steps)
  BINARY_SEARCH_ITERATIONS: 50,

  // Margin drift threshold that triggers rebalance (5% absolute from target)
  DRIFT_THRESHOLD: 0.05,

  // How close to win-rate floor triggers a "MARGINAL" warning
  MARGINAL_WIN_RATE_BUFFER: 0.02,

  // Max margin concession during win-rate adjustment step (5% below target)
  MAX_MARGIN_CONCESSION: 0.05,

  // Win-rate adjustment step size per iteration
  WIN_RATE_ALPHA_BUMP: 0.02,

  // Allowed tiers — must match `tier` values in the drops table
  TIERS: ["Basic", "Pro", "Elite"] as const,

  // Weight bounds per rarity: [min, max]
  // min > 0 prevents zero-weight for present rarities
  // max prevents degenerate all-one-rarity solutions
  WEIGHT_BOUNDS: {
    "Common":            { min: 0.15, max: 0.85 },
    "Uncommon":          { min: 0.08, max: 0.50 },
    "Rare":              { min: 0.02, max: 0.35 },
    "Holo Rare":         { min: 0.01, max: 0.25 },
    "Ultra Rare/EX/GX":  { min: 0.005, max: 0.15 },
    "Secret Rare":       { min: 0.002, max: 0.08 },
  } as Record<string, { min: number; max: number }>,
} as const;

export type PackTier = typeof PACK_ECONOMICS.TIERS[number];
export type TriggerReason = "bootstrap_seed" | "scheduled" | "margin_drift" | "manual" | "price_anomaly";
export type FeasibilityStatus = "FEASIBLE" | "MARGINAL" | "INFEASIBLE";
