import { Request, Response } from "express";
import { getCollection, getPortfolioSummary } from "../services/collectionService";

export async function collectionController(req: Request, res: Response) {
  const cards = await getCollection(req.user!.userId);
  res.json({ cards });
}

export async function portfolioSummaryController(req: Request, res: Response) {
  const summary = await getPortfolioSummary(req.user!.userId);
  res.json(summary);
}
