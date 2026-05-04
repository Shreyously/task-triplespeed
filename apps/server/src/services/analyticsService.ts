import { pool } from "../db/pool";
import {
  getAuctionIntegrityMetrics,
  getFlaggedAuctions,
  getRevenueBreakdown,
  getPackEVAnalysis,
  getTransactionVolumes,
  getPlatformProfitability,
  getMarketStats
} from "../repositories/analyticsRepository";

export async function getEconomicsDashboard(platformUserId: string) {
  const client = await pool.connect();
  try {
    const [
      auctionIntegrity,
      flaggedAuctions,
      revenue,
      evAnalysis,
      volumes,
      profitability,
      marketStats
    ] = await Promise.all([
      getAuctionIntegrityMetrics(client),
      getFlaggedAuctions(client),
      getRevenueBreakdown(client, platformUserId),
      getPackEVAnalysis(client),
      getTransactionVolumes(client, "24h"),
      getPlatformProfitability(client, platformUserId),
      getMarketStats(client)
    ]);

    return {
      revenue,
      evAnalysis,
      volumes,
      profitability,
      marketStats,
      auctionIntegrity,
      flaggedAuctions,
      generatedAt: new Date().toISOString()
    };
  } finally {
    client.release();
  }
}
