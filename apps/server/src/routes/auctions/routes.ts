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

export const auctionRoutes = Router();
auctionRoutes.get("/auctions/live", asyncHandler(listLiveAuctionsController));
auctionRoutes.get("/auctions/:id/snapshot", authMiddleware, asyncHandler(auctionSnapshotController));
auctionRoutes.post("/auctions", authMiddleware, validateBody(createAuctionSchema), asyncHandler(createAuctionController));
auctionRoutes.post("/auctions/:id/bids", authMiddleware, requireIdempotency, validateBody(placeBidSchema), asyncHandler(placeBidController));
auctionRoutes.post("/workers/settlement/tick", asyncHandler(settlementTickController));
