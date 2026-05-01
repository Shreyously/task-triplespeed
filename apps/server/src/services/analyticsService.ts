import { pool, withTx } from "../db/pool";
import {
  getRevenueBreakdown,
  getPackEVAnalysis,
  getTransactionVolumes,
  getPlatformProfitability,
  getMarketStats
} from "../repositories/analyticsRepository";

export async function getEconomicsDashboard(platformUserId: string) {
  const client = await pool.connect();
  try {
    const [revenue, evAnalysis, volumes, profitability, marketStats] = await Promise.all([
      getRevenueBreakdown(client, platformUserId),
      getPackEVAnalysis(client),
      getTransactionVolumes(client, '24h'),
      getPlatformProfitability(client, platformUserId),
      getMarketStats(client)
    ]);

    return {
      revenue,
      evAnalysis,
      volumes,
      profitability,
      marketStats,
      generatedAt: new Date().toISOString()
    };
  } finally {
    client.release();
  };
}
