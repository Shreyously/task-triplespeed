import { Router } from "express";
import { adminUpdateDropController, buyPackController, listDropsController, revealPackController } from "../../controllers/packController";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { requireIdempotency } from "../../middleware/idempotency";
import { validateBody } from "../../middleware/validate";
import { buyPackSchema } from "@pullvault/common";
import { asyncHandler } from "../../middleware/async";

export const packRoutes = Router();
packRoutes.get("/drops", asyncHandler(listDropsController));
packRoutes.post("/packs/buy", authMiddleware, requireIdempotency, validateBody(buyPackSchema), asyncHandler(buyPackController));
packRoutes.get("/packs/:purchaseId/reveal", authMiddleware, asyncHandler(revealPackController));
packRoutes.patch("/admin/drops/:dropId", authMiddleware, adminMiddleware, asyncHandler(adminUpdateDropController));
