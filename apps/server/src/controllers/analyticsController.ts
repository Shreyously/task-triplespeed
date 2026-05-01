import { Request, Response } from "express";
import { config } from "../config/env";
import { getEconomicsDashboard } from "../services/analyticsService";

export async function getEconomicsDashboardController(req: Request, res: Response) {
  // Verify admin/platform user
  if (req.user!.userId !== config.platformUserId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const data = await getEconomicsDashboard(config.platformUserId);
  res.json(data);
}
