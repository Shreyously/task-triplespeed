import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { requireIdempotency } from "../../middleware/idempotency";
import { validateBody } from "../../middleware/validate";
import { createAuctionSchema, placeBidSchema } from "@pullvault/common";
import {
  auctionSnapshotController,
  createAuctionController,
  listLiveAuctionsController,
  placeBidController,
  settlementTickController
} from "../../controllers/auctionController";
import { asyncHandler } from "../../middleware/async";
import { rateLimitMiddleware } from "../../middleware/rateLimit";

export const auctionRoutes = Router();
auctionRoutes.get("/auctions/live", rateLimitMiddleware('API'), asyncHandler(listLiveAuctionsController));
auctionRoutes.get("/auctions/:id/snapshot", authMiddleware, rateLimitMiddleware('API'), asyncHandler(auctionSnapshotController));
auctionRoutes.post("/auctions", authMiddleware, rateLimitMiddleware('API'), validateBody(createAuctionSchema), asyncHandler(createAuctionController));
auctionRoutes.post("/auctions/:id/bids", authMiddleware, requireIdempotency, rateLimitMiddleware('API'), validateBody(placeBidSchema), asyncHandler(placeBidController));
auctionRoutes.post("/workers/settlement/tick", asyncHandler(settlementTickController));
