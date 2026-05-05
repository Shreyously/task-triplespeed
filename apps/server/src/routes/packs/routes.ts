import { Router } from "express";
import {
  adminUpdateDropController,
  buyPackController,
  checkFairnessQueueController,
  getPackAuditLogController,
  getPackOpeningProofController,
  listDropsController,
  processFairnessQueueController,
  recordFairnessVerificationEventController,
  reservePackCommitmentController,
  revealPackController
} from "../../controllers/packController";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { requireIdempotency } from "../../middleware/idempotency";
import { validateBody } from "../../middleware/validate";
import { buyPackSchema, fairnessVerificationEventSchema } from "@pullvault/common";
import { asyncHandler } from "../../middleware/async";
import { rateLimitMiddleware, botDetectionMiddleware, packPurchaseMiddleware } from "../../middleware/rateLimit";

export const packRoutes = Router();

packRoutes.get("/drops", rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(listDropsController));
packRoutes.post("/provably-fair/commitments/reserve",
  authMiddleware,
  rateLimitMiddleware({ type: 'API', access: 'readOnly' }),
  asyncHandler(reservePackCommitmentController)
);
packRoutes.post("/packs/buy",
  authMiddleware,
  requireIdempotency,
  validateBody(buyPackSchema),
  botDetectionMiddleware,
  rateLimitMiddleware({ type: 'PACK_PURCHASE', access: 'writeProtected' }),
  packPurchaseMiddleware,
  asyncHandler(buyPackController)
);
packRoutes.get("/packs/:purchaseId/reveal", authMiddleware, rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(revealPackController));
packRoutes.get("/provably-fair/openings/:purchaseId", rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(getPackOpeningProofController));
packRoutes.get("/provably-fair/audit-log", rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(getPackAuditLogController));
packRoutes.post(
  "/provably-fair/verification-events",
  rateLimitMiddleware({ type: 'API', access: 'readOnly' }),
  validateBody(fairnessVerificationEventSchema),
  asyncHandler(recordFairnessVerificationEventController)
);
packRoutes.get("/packs/fairness/:dropId/check", authMiddleware, rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(checkFairnessQueueController));
packRoutes.post("/admin/drops/:dropId/process-fairness", authMiddleware, adminMiddleware, asyncHandler(processFairnessQueueController));
packRoutes.patch("/admin/drops/:dropId", authMiddleware, adminMiddleware, asyncHandler(adminUpdateDropController));
