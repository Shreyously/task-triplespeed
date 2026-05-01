import express from "express";
import cors from "cors";
import { authRoutes } from "./routes/auth/routes";
import { packRoutes } from "./routes/packs/routes";
import { listingRoutes } from "./routes/listings/routes";
import { auctionRoutes } from "./routes/auctions/routes";
import { collectionRoutes } from "./routes/collection/routes";
import { analyticsRoutes } from "./routes/analytics/routes";
import { errorHandler } from "./middleware/error";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.use("/auth", authRoutes);
  app.use(authRoutes);
  app.use(packRoutes);
  app.use(listingRoutes);
  app.use(auctionRoutes);
  app.use(collectionRoutes);
  app.use(analyticsRoutes);
  app.use(errorHandler);
  return app;
}
