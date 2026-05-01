import { Request, Response } from "express";
import { getIdempotentResponse, setIdempotentResponse } from "../middleware/idempotency";
import { browseListings, buyListing, listCard } from "../services/listingService";
import { config } from "../config/env";

export async function createListingController(req: Request, res: Response) {
  const listing = await listCard(req.user!.userId, req.body.cardId, req.body.price);
  res.json({ listing });
}

export async function listListingsController(_req: Request, res: Response) {
  res.json({ listings: await browseListings() });
}

export async function buyListingController(req: Request, res: Response) {
  const key = (req as Request & { idempotencyKey: string }).idempotencyKey;
  const scope = `trade:${req.user!.userId}`;
  const cached = await getIdempotentResponse(scope, key);
  if (cached) return res.json(cached);
  const result = await buyListing(req.user!.userId, req.params.id, key, config.platformUserId);
  await setIdempotentResponse(scope, key, result, 24 * 60 * 60);
  res.json(result);
}
