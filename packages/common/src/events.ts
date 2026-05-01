export const SOCKET_EVENTS = {
  DROP_INVENTORY_UPDATED: "drop:inventory:updated",
  AUCTION_UPDATED: "auction:updated",
  AUCTION_CLOSED: "auction:closed",
  AUCTION_BID_HISTORY: "auction:bid:history",
  AUCTION_WATCHERS_UPDATED: "auction:watchers:updated",
  PRICE_CARD_UPDATED: "price:card:updated",
  PORTFOLIO_UPDATED: "portfolio:updated",
  LISTING_SOLD: "listing:sold"
} as const;
