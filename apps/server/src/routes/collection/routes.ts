import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { collectionController, portfolioSummaryController } from "../../controllers/collectionController";
import { asyncHandler } from "../../middleware/async";

export const collectionRoutes = Router();
collectionRoutes.get("/collection", authMiddleware, asyncHandler(collectionController));
collectionRoutes.get("/portfolio/summary", authMiddleware, asyncHandler(portfolioSummaryController));
