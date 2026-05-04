export type AuctionStatus = "SCHEDULED" | "LIVE" | "CLOSING" | "CLOSED" | "SETTLED";
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
