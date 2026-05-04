import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { requireIdempotency } from "../../middleware/idempotency";
import { validateBody } from "../../middleware/validate";
import { buyListingSchema, createListingSchema } from "@pullvault/common";
import { buyListingController, createListingController, listListingsController } from "../../controllers/listingController";
import { asyncHandler } from "../../middleware/async";
import { rateLimitMiddleware } from "../../middleware/rateLimit";

export const listingRoutes = Router();
listingRoutes.get("/listings", rateLimitMiddleware({ type: 'API', access: 'readOnly' }), asyncHandler(listListingsController));
listingRoutes.post("/listings", authMiddleware, rateLimitMiddleware({ type: 'MARKETPLACE', access: 'writeProtected' }), validateBody(createListingSchema), asyncHandler(createListingController));
listingRoutes.post("/listings/:id/buy", authMiddleware, requireIdempotency, rateLimitMiddleware({ type: 'MARKETPLACE', access: 'writeProtected' }), validateBody(buyListingSchema), asyncHandler(buyListingController));
