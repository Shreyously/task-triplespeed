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
auctionRoutes.get("/auctions/live", rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(listLiveAuctionsController));
auctionRoutes.get("/auctions/:id/snapshot", authMiddleware, rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(auctionSnapshotController));
auctionRoutes.post("/auctions", authMiddleware, rateLimitMiddleware({ type: 'API', access: 'writeProtected' }), validateBody(createAuctionSchema), asyncHandler(createAuctionController));
auctionRoutes.post("/auctions/:id/bids", authMiddleware, requireIdempotency, rateLimitMiddleware({ type: 'API', access: 'writeProtected' }), validateBody(placeBidSchema), asyncHandler(placeBidController));
auctionRoutes.post("/workers/settlement/tick", asyncHandler(settlementTickController));
