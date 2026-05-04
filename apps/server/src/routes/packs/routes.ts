import { Router } from "express";
import { adminUpdateDropController, buyPackController, checkFairnessQueueController, listDropsController, processFairnessQueueController, revealPackController } from "../../controllers/packController";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { requireIdempotency } from "../../middleware/idempotency";
import { validateBody } from "../../middleware/validate";
import { buyPackSchema } from "@pullvault/common";
import { asyncHandler } from "../../middleware/async";
import { rateLimitMiddleware, botDetectionMiddleware, packPurchaseMiddleware } from "../../middleware/rateLimit";

export const packRoutes = Router();

packRoutes.get("/drops", rateLimitMiddleware('API'), asyncHandler(listDropsController));
packRoutes.post("/packs/buy",
  authMiddleware,
  requireIdempotency,
  validateBody(buyPackSchema),
  rateLimitMiddleware('PACK_PURCHASE'),
  botDetectionMiddleware,
  packPurchaseMiddleware,
  asyncHandler(buyPackController)
);
packRoutes.get("/packs/:purchaseId/reveal", authMiddleware, rateLimitMiddleware('API'), asyncHandler(revealPackController));
packRoutes.get("/packs/fairness/:dropId/check", authMiddleware, rateLimitMiddleware('API'), asyncHandler(checkFairnessQueueController));
packRoutes.post("/admin/drops/:dropId/process-fairness", authMiddleware, adminMiddleware, asyncHandler(processFairnessQueueController));
packRoutes.patch("/admin/drops/:dropId", authMiddleware, adminMiddleware, asyncHandler(adminUpdateDropController));
