import { Router } from "express";
import { getEconomicsDashboardController } from "../../controllers/analyticsController";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { asyncHandler } from "../../middleware/async";

export const analyticsRoutes = Router();

analyticsRoutes.get("/analytics/dashboard", authMiddleware, adminMiddleware, asyncHandler(getEconomicsDashboardController));
