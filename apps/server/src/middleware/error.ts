import { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : "Internal Server Error";
  const status = message.includes("Unauthorized") ? 401 : message.includes("not found") ? 404 : 400;
  res.status(status).json({ error: message });
}
