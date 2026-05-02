import { Request, Response } from "express";
import { getCollection, getPortfolioHistory, getPortfolioSummary } from "../services/collectionService";

export async function collectionController(req: Request, res: Response) {
  const cards = await getCollection(req.user!.userId);
  res.json({ cards });
}

export async function portfolioSummaryController(req: Request, res: Response) {
  const summary = await getPortfolioSummary(req.user!.userId);
  res.json(summary);
}

export async function portfolioHistoryController(req: Request, res: Response) {
  const raw = String(req.query.range ?? "24h");
  const range = (raw === "7d" || raw === "30d") ? raw : "24h";
  const history = await getPortfolioHistory(req.user!.userId, range);
  res.json({ range, points: history });
}
