import { PoolClient } from "pg";
import { TriggerReason } from "../config/packEconomics";

export interface PackConfigVersion {
  id: string;
  tier: string;
  version: number;
  rarity_weights: Record<string, number>;
  target_margin: string;
  actual_ev: string;
  simulated_margin: string;
  simulated_win_rate: string;
  market_snapshot: Record<string, { avg: number; count: number }>;
  trigger_reason: TriggerReason;
  is_active: boolean;
  activated_at: string | null;
  created_at: string;
}

/** Get the currently active config for a tier. Returns null if none exists. */
export async function getActiveConfig(
  client: PoolClient,
  tier: string
): Promise<PackConfigVersion | null> {
  const { rows } = await client.query(
    "SELECT * FROM pack_config_versions WHERE tier = $1 AND is_active = true",
    [tier]
  );
  return rows[0] ?? null;
}

/** Get all active configs (one per tier). Used for startup assertion. */
export async function getAllActiveConfigs(
  client: PoolClient
): Promise<PackConfigVersion[]> {
  const { rows } = await client.query(
    "SELECT * FROM pack_config_versions WHERE is_active = true ORDER BY tier"
  );
  return rows;
}

/** Get the next version number for a tier. */
export async function getNextVersion(
  client: PoolClient,
  tier: string
): Promise<number> {
  const { rows } = await client.query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM pack_config_versions WHERE tier = $1",
    [tier]
  );
  return Number(rows[0].next);
}

export interface CreateConfigVersionInput {
  tier: string;
  version: number;
  rarityWeights: Record<string, number>;
  targetMargin: number;
  actualEv: number;
  simulatedMargin: number;
  simulatedWinRate: number;
  marketSnapshot: Record<string, { avg: number; count: number }>;
  triggerReason: TriggerReason;
}

/** Insert a new config version (not yet active). */
export async function createConfigVersion(
  client: PoolClient,
  input: CreateConfigVersionInput
): Promise<PackConfigVersion> {
  const { rows } = await client.query(
    `INSERT INTO pack_config_versions
      (tier, version, rarity_weights, target_margin, actual_ev,
       simulated_margin, simulated_win_rate, market_snapshot, trigger_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.tier,
      input.version,
      JSON.stringify(input.rarityWeights),
      input.targetMargin.toFixed(4),
      input.actualEv.toFixed(2),
      input.simulatedMargin.toFixed(4),
      input.simulatedWinRate.toFixed(4),
      JSON.stringify(input.marketSnapshot),
      input.triggerReason,
    ]
  );
  return rows[0];
}

/**
 * Atomically deactivate the current active config for a tier and activate the new one.
 * The partial unique index (ux_pack_config_one_active_per_tier) enforces DB-level safety.
 * Must be called inside a withTx() transaction.
 */
export async function activateConfig(
  client: PoolClient,
  configId: string,
  tier: string
): Promise<void> {
  // Step 1: Deactivate all currently active configs for this tier
  await client.query(
    "UPDATE pack_config_versions SET is_active = false WHERE tier = $1 AND is_active = true",
    [tier]
  );
  // Step 2: Activate the new config
  await client.query(
    "UPDATE pack_config_versions SET is_active = true, activated_at = now() WHERE id = $1",
    [configId]
  );
}

/** Get the full version history for a tier (most recent first). */
export async function getConfigHistory(
  client: PoolClient,
  tier: string,
  limit = 20
): Promise<PackConfigVersion[]> {
  const { rows } = await client.query(
    "SELECT * FROM pack_config_versions WHERE tier = $1 ORDER BY version DESC LIMIT $2",
    [tier, limit]
  );
  return rows;
}
