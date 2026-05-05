import { pool } from "../db/pool";
import {
  buildEconomicAlerts,
  getEconomicHealth,
  getFairnessAudit,
  getFraudHealth,
  getAuctionIntegrityMetrics,
  getFlaggedAuctions,
  getRevenueBreakdown,
  getPackEVAnalysis,
  getTransactionVolumes,
  getPlatformProfitability,
  getMarketStats,
  getUserHealth
} from "../repositories/analyticsRepository";

export async function getEconomicsDashboard(platformUserId: string) {
  // Use Promise.all to fetch all dashboard components in parallel
  // We use the pool directly to allow concurrent queries (individual clients are sequential)
  const [
    auctionIntegrity,
    flaggedAuctions,
    revenue,
    evAnalysis,
    volumes,
    profitability,
    marketStats,
    fraudHealth,
    economicHealth,
    fairnessAudit,
    userHealth
  ] = await Promise.all([
    getAuctionIntegrityMetrics(pool),
    getFlaggedAuctions(pool),
    getRevenueBreakdown(pool, platformUserId),
    getPackEVAnalysis(pool),
    getTransactionVolumes(pool, "24h"),
    getPlatformProfitability(pool, platformUserId),
    getMarketStats(pool),
    getFraudHealth(pool),
    getEconomicHealth(pool),
    getFairnessAudit(pool),
    getUserHealth(pool)
  ]);

  const alerts = buildEconomicAlerts(economicHealth);

  return {
    revenue,
    evAnalysis,
    volumes,
    profitability,
    marketStats,
    auctionIntegrity,
    flaggedAuctions,
    fraudHealth,
    economicHealth,
    fairnessAudit,
    userHealth,
    alerts,
    generatedAt: new Date().toISOString()
  };
}
