export type AuctionStatus = "SCHEDULED" | "LIVE" | "CLOSING" | "SEALED_ENDGAME" | "CLOSED" | "SETTLED";
export type CardMarketState = "NONE" | "LISTED" | "IN_AUCTION";
export type LedgerType =
  | "PACK_PURCHASE"
  | "BID_HOLD"
  | "BID_RELEASE"
  | "TRADE"
  | "AUCTION_SETTLEMENT"
  | "FEE_CREDIT";

export interface JwtUser {
  userId: string;
  email: string;
}

// Analytics types
export interface RevenueBreakdown {
  packRevenue: string;
  tradeFees: string;
  auctionFees: string;
  totalRevenue: string;
}

export interface PackEVAnalysis {
  tier: string;
  price: number;
  cardsPerPack: number;
  expectedValue: string;
  margin: string;
  marginPercentage: number;
  targetMargin?: number;
  currentMargin?: number;
  winRate?: number;
  lastTriggerReason?: string | null;
  configVersionId?: string | null;
  lastRebalancedAt?: string | null;
  rarityBreakdown: Array<{
    rarity: string;
    weight: number;
    avgMarketValue: string;
    contribution: string;
  }>;
}

export interface TransactionVolumes {
  trades: { count: number; totalVolume: string };
  auctions: { count: number; totalVolume: string };
  packs: { count: number; totalVolume: string };
}

export interface PlatformProfitability {
  totalRevenue: string;
  totalCosts: string;
  grossProfit: string;
  profitMargin: number;
}

export interface MarketStats {
  rarity: string;
  avgValue: string;
  minValue: string;
  maxValue: string;
  cardCount: number;
}

export interface AuctionIntegrityMetrics {
  participationRate: number;
  averageBidders: number;
  sealedEndgameRate: number;
  lowCloseRate: number;
  flagRate: number;
  snipeRate: number;
  auctionsReviewed: number;
}

export interface AuctionIntegrityFlagSummary {
  id: string;
  auctionId: string;
  flagType: string;
  severity: number;
  details: Record<string, unknown>;
  createdAt: string;
  status: string;
  sellerId: string;
  winnerId: string | null;
  finalPrice: string | null;
  marketValue: string | null;
  bidderCount: number;
}

export interface AnalyticsAlert {
  level: "INFO" | "WARN" | "CRITICAL";
  code: string;
  message: string;
  tier?: string;
  value?: number;
}

export interface FraudHealthData {
  windowHours: number;
  totalProtectedRequests: number;
  blockedRequests: number;
  blockRate: number;
  degradedOpenCount: number;
  degradedClosedCount: number;
  rateLimitEffectiveness: number;
  topBlockedBucket: string | null;
  botThrottleCount: number;
  botBlockCount: number;
  highRiskAccountCount: number;
  flaggedAccounts: Array<{
    userId: string | null;
    recentEvents: number;
    maxScore: number;
    latestAction: string;
    latestSeenAt: string;
  }>;
}

export interface EconomicHealthTier {
  tier: string;
  salesCount24h: number;
  revenue24h: string;
  realizedCogs24h: string;
  realizedMargin24h: number | null;
  targetMargin: number | null;
  marginDeltaFromTarget: number | null;
}

export interface EconomicHealthData {
  tiers: EconomicHealthTier[];
  trailingRevenue24h: string;
  projectedRevenueDaily: string;
  projectedRevenue30d: string;
}

export interface FairnessAuditData {
  sampleSize: number;
  statistic: number | null;
  pValue: number | null;
  degreesOfFreedom: number;
  significance: "PASS" | "WATCH" | "FAIL" | "INSUFFICIENT_SAMPLE";
  observedExpectedByRarity: Array<{
    rarity: string;
    observed: number;
    expected: number;
  }>;
  verificationUsers: number;
  verificationSessions: number;
}

export interface UserHealthData {
  status: "healthy" | "watch" | "unhealthy";
  auctionParticipationRate: number;
  averageBiddersPerAuction: number;
  bidPerAuction: number;
  packsBought24h: number;
  uniquePackBuyers24h: number;
  liveDropSellThrough: number;
  listingsCreated24h: number;
  tradesCompleted24h: number;
  listingConversionRate24h: number;
  d1Retention: number;
  d7Retention: number;
}

export interface AnalyticsDashboardData {
  revenue: RevenueBreakdown;
  evAnalysis: PackEVAnalysis[];
  volumes: TransactionVolumes;
  profitability: PlatformProfitability;
  marketStats: MarketStats[];
  auctionIntegrity: AuctionIntegrityMetrics;
  flaggedAuctions: AuctionIntegrityFlagSummary[];
  fraudHealth: FraudHealthData;
  economicHealth: EconomicHealthData;
  fairnessAudit: FairnessAuditData;
  userHealth: UserHealthData;
  alerts: AnalyticsAlert[];
  generatedAt: string;
}
