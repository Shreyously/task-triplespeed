import { NextFunction, Request, Response } from "express";
import { redis } from "../db/redis";

export function requireIdempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("idempotency-key") || req.body?.idempotencyKey;
  if (!key) {
    res.status(400).json({ error: "Missing Idempotency-Key" });
    return;
  }
  (req as Request & { idempotencyKey: string }).idempotencyKey = key;
  next();
}

export async function getIdempotentResponse(scope: string, key: string): Promise<unknown | null> {
  const raw = await redis.get(`idem:${scope}:${key}`);
  return raw ? JSON.parse(raw) : null;
}

export async function setIdempotentResponse(scope: string, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.set(`idem:${scope}:${key}`, JSON.stringify(value), "EX", ttlSeconds);
}
