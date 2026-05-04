import { Router } from "express";
import { getEconomicsDashboardController } from "../../controllers/analyticsController";
import {
  simulateController,
  rebalanceController,
  driftStatusController,
  configHistoryController,
} from "../../controllers/simulationController";
import { authMiddleware } from "../../middleware/auth";
import { adminMiddleware } from "../../middleware/admin";
import { asyncHandler } from "../../middleware/async";
import { validateBody } from "../../middleware/validate";
import { rebalanceEconomicsSchema, simulateEconomicsSchema } from "@pullvault/common";

export const analyticsRoutes = Router();

// Existing dashboard
analyticsRoutes.get(
  "/analytics/dashboard",
  authMiddleware, adminMiddleware,
  asyncHandler(getEconomicsDashboardController)
);

// B1: Pack Economics endpoints (all admin-only)
analyticsRoutes.post(
  "/analytics/simulate",
  authMiddleware, adminMiddleware,
  validateBody(simulateEconomicsSchema),
  asyncHandler(simulateController)
);

analyticsRoutes.post(
  "/analytics/rebalance",
  authMiddleware, adminMiddleware,
  validateBody(rebalanceEconomicsSchema),
  asyncHandler(rebalanceController)
);

analyticsRoutes.get(
  "/analytics/drift",
  authMiddleware, adminMiddleware,
  asyncHandler(driftStatusController)
);

analyticsRoutes.get(
  "/analytics/config-history/:tier",
  authMiddleware, adminMiddleware,
  asyncHandler(configHistoryController)
);
