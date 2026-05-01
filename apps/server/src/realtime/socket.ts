import { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { config } from "../config/env";
import { SOCKET_EVENTS } from "@pullvault/common";

let io: Server | null = null;
const auctionWatchers = new Map<string, Set<string>>();

export function setupSocket(server: HttpServer) {
  io = new Server(server, { cors: { origin: config.corsOrigin } });
  io.on("connection", (socket) => {
    socket.on("join:drop", (dropId: string) => socket.join(`drop:${dropId}`));
    socket.on("join:user", (userId: string) => socket.join(`user:${userId}`));
    socket.on("join:auction", (auctionId: string) => {
      socket.join(`auction:${auctionId}`);
      const current = auctionWatchers.get(auctionId) ?? new Set<string>();
      current.add(socket.id);
      auctionWatchers.set(auctionId, current);
      emitAuctionWatchers(auctionId, current.size);
    });
    socket.on("disconnect", () => {
      for (const [auctionId, watchers] of auctionWatchers) {
        if (watchers.delete(socket.id)) {
          emitAuctionWatchers(auctionId, watchers.size);
          if (watchers.size === 0) auctionWatchers.delete(auctionId);
        }
      }
    });
  });
  return io;
}

export function emitDropInventory(dropId: string, inventory: number) {
  io?.to(`drop:${dropId}`).emit(SOCKET_EVENTS.DROP_INVENTORY_UPDATED, { dropId, inventory });
}

export function emitAuctionUpdate(auctionId: string, payload: unknown) {
  io?.to(`auction:${auctionId}`).emit(SOCKET_EVENTS.AUCTION_UPDATED, payload);
}

export function emitAuctionBidHistory(auctionId: string, payload: unknown) {
  io?.to(`auction:${auctionId}`).emit(SOCKET_EVENTS.AUCTION_BID_HISTORY, payload);
}

export function emitAuctionWatchers(auctionId: string, count: number) {
  io?.to(`auction:${auctionId}`).emit(SOCKET_EVENTS.AUCTION_WATCHERS_UPDATED, { auctionId, watchers: count });
}

export function emitAuctionClosed(auctionId: string, payload: { auctionId: string; status: string; settlement: any }) {
  io?.to(`auction:${auctionId}`).emit(SOCKET_EVENTS.AUCTION_CLOSED, payload);
}

export function emitListingSold(listingId: string, payload: {
  listingId: string;
  cardId: string;
  cardName: string;
  buyerId: string;
  sellerId: string;
  price: string;
}) {
  io?.emit(SOCKET_EVENTS.LISTING_SOLD, payload);
}

export function getAuctionWatcherCount(auctionId: string): number {
  return auctionWatchers.get(auctionId)?.size ?? 0;
}

export function emitPriceUpdate(payload: unknown) {
  io?.emit(SOCKET_EVENTS.PRICE_CARD_UPDATED, payload);
}

export function emitPortfolioUpdate(userId: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(SOCKET_EVENTS.PORTFOLIO_UPDATED, payload);
}
