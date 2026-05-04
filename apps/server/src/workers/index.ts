import { config } from "../config/env";
import { settlementTick } from "../services/auctionService";
import { runPriceTick } from "../services/priceEngineService";
import { refreshCardPool } from "../services/pokemonCardService";
import { syncDrops } from "../services/packService";
import { recordPortfolioSnapshots } from "../services/collectionService";
import { rebalanceIfNeeded } from "../services/packEconomicsService";
import { getAllActiveConfigs } from "../repositories/packConfigRepository";
import { pool } from "../db/pool";
import { PACK_ECONOMICS } from "../config/packEconomics";
import { fairnessQueue } from "../services/fairnessQueueService";
import { FAIRNESS_CONFIG } from "../config/antibot";

export async function startWorkers() {
  console.log("Starting background workers...");

  const client = await pool.connect();
  try {
    const tableCheck = await client.query("select to_regclass('public.pack_config_versions') as t");
    if (!tableCheck.rows[0]?.t) {
      throw new Error("B1 schema missing: pack_config_versions table not found. Run bootstrap/migrations first.");
    }

    const activeConfigs = await getAllActiveConfigs(client);
    const activeTiers = new Set(activeConfigs.map((c) => c.tier));
    const missingTiers = PACK_ECONOMICS.TIERS.filter((t) => !activeTiers.has(t));
    if (missingTiers.length > 0) {
      throw new Error(`[PackEconomics] Missing active configs for tiers: ${missingTiers.join(", ")}.`);
    }
    console.log("[PackEconomics] Startup assertion passed - active configs found for all tiers.");
  } finally {
    client.release();
  }

  refreshCardPool().catch((e) => console.error("card pool refresh error", e));

  setInterval(async () => {
    try {
      await syncDrops();
    } catch (e) {
      console.error("drop sync worker error", e);
    }
  }, 3000);

  setInterval(async () => {
    try {
      await settlementTick(config.platformUserId);
    } catch (e) {
      console.error("settlement worker error", e);
    }
  }, 5000);

  setInterval(async () => {
    try {
      await runPriceTick();
    } catch (e) {
      console.error("price tick error", e);
    }
  }, config.priceTickSeconds * 1000);

  setInterval(async () => {
    try {
      await recordPortfolioSnapshots();
    } catch (e) {
      console.error("portfolio snapshot worker error", e);
    }
  }, 5 * 60 * 1000);

  setInterval(async () => {
    try {
      await rebalanceIfNeeded("scheduled");
    } catch (e) {
      console.error("pack economics rebalance worker error", e);
    }
  }, config.rebalanceIntervalMinutes * 60 * 1000);

  setInterval(async () => {
    try {
      await monitorFairnessQueues();
    } catch (e) {
      console.error("fairness queue monitor error", e);
    }
  }, 10000);
}

async function monitorFairnessQueues() {
  const dropsResult = await pool.query(
    `SELECT id, inventory
     FROM drops
     WHERE starts_at <= NOW() AND ends_at >= NOW()
     AND inventory > 0`
  );

  for (const drop of dropsResult.rows) {
    const shouldActivate = await fairnessQueue.shouldActivateFairnessMode(drop.id);
    const queueSize = await fairnessQueue.getQueueSize(drop.id);

    if (shouldActivate && queueSize > 0) {
      const availableInventory = parseInt(drop.inventory);
      const winners = await fairnessQueue.processFairnessWindow(drop.id, availableInventory);

      if (winners.length > 0) {
        console.log(`[FairnessQueue] Processed drop ${drop.id}: ${winners.length} winners from ${queueSize} participants`);
      }
    }
  }
}
