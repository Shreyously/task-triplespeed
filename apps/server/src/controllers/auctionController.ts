import { Request, Response } from "express";
import { config } from "../config/env";
import { getIdempotentResponse, setIdempotentResponse } from "../middleware/idempotency";
import { createAuctionForCard, getAuctionSnapshot, getLiveAuctions, placeBid, settlementTick } from "../services/auctionService";
import { emitAuctionBidHistory, emitAuctionSealedStatus, emitAuctionUpdate } from "../realtime/socket";

export async function createAuctionController(req: Request, res: Response) {
  const auction = await createAuctionForCard(req.user!.userId, req.body.cardId, req.body.durationSeconds);
  res.json({ auction });
}

export async function listLiveAuctionsController(_req: Request, res: Response) {
  res.json({ auctions: await getLiveAuctions(), serverTime: new Date().toISOString() });
}

export async function placeBidController(req: Request, res: Response) {
  const key = (req as Request & { idempotencyKey: string }).idempotencyKey;
  const scope = `bid:${req.user!.userId}:${req.params.id}`;
  const cached = await getIdempotentResponse(scope, key);
  if (cached) return void res.json(cached);
  const out = await placeBid(req.user!.userId, req.params.id, req.body.amount, key, Boolean(req.body.confirmHighBid));
  if (!out.accepted) {
    return void res.status(409).json(out);
  }

  if (out.mode === "OPEN") {
    emitAuctionUpdate(req.params.id, out);
    const snapshot = await getAuctionSnapshot(req.params.id, req.user!.userId);
    emitAuctionBidHistory(req.params.id, { auctionId: req.params.id, bids: snapshot.bidHistory });
  } else {
    emitAuctionSealedStatus(req.params.id, {
      auctionId: req.params.id,
      status: out.status,
      biddingMode: out.biddingMode,
      endTime: out.endTime
    });
  }

  await setIdempotentResponse(scope, key, out, 2 * 60 * 60);
  res.json(out);
}

export async function auctionSnapshotController(req: Request, res: Response) {
  const out = await getAuctionSnapshot(req.params.id, req.user!.userId);
  res.json(out);
}

export async function settlementTickController(_req: Request, res: Response) {
  const settled = await settlementTick(config.platformUserId);
  res.json({ settled });
}
