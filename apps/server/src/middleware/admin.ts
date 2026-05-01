import { Request, Response, NextFunction } from "express";
import { config } from "../config/env";

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.userId !== config.platformUserId) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
