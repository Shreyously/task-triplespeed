import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { collectionController, portfolioHistoryController, portfolioSummaryController } from "../../controllers/collectionController";
import { asyncHandler } from "../../middleware/async";
import { rateLimitMiddleware } from "../../middleware/rateLimit";

export const collectionRoutes = Router();
collectionRoutes.get("/collection", authMiddleware, rateLimitMiddleware('API'), asyncHandler(collectionController));
collectionRoutes.get("/portfolio/summary", authMiddleware, rateLimitMiddleware('API'), asyncHandler(portfolioSummaryController));
collectionRoutes.get("/portfolio/history", authMiddleware, rateLimitMiddleware('API'), asyncHandler(portfolioHistoryController));
