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
