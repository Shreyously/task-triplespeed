import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { requireIdempotency } from "../../middleware/idempotency";
import { validateBody } from "../../middleware/validate";
import { buyListingSchema, createListingSchema } from "@pullvault/common";
import { buyListingController, createListingController, listListingsController } from "../../controllers/listingController";
import { asyncHandler } from "../../middleware/async";

export const listingRoutes = Router();
listingRoutes.get("/listings", asyncHandler(listListingsController));
listingRoutes.post("/listings", authMiddleware, validateBody(createListingSchema), asyncHandler(createListingController));
listingRoutes.post("/listings/:id/buy", authMiddleware, requireIdempotency, validateBody(buyListingSchema), asyncHandler(buyListingController));
