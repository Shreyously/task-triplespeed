export const SOCKET_EVENTS = {
  DROP_INVENTORY_UPDATED: "drop:inventory:updated",
  AUCTION_UPDATED: "auction:updated",
  AUCTION_CLOSED: "auction:closed",
  AUCTION_BID_HISTORY: "auction:bid:history",
  AUCTION_SEALED_STATUS: "auction:sealed:status",
  AUCTION_WATCHERS_UPDATED: "auction:watchers:updated",
  PRICE_CARD_UPDATED: "price:card:updated",
  PORTFOLIO_UPDATED: "portfolio:updated",
  LISTING_SOLD: "listing:sold",
  DROP_PRICE_UPDATED: "drop:price:updated",
  DROP_STATUS_UPDATED: "drop:status:updated",
  LISTING_CREATED: "listing:created",
  JOIN_DROP: "join:drop",
  JOIN_USER: "join:user",
  JOIN_AUCTION: "join:auction"
} as const;
