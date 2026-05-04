import { Request, Response } from "express";
import { adminUpdateDrop, buyPack, getDrops, revealPack } from "../services/packService";
import { getIdempotentResponse, setIdempotentResponse } from "../middleware/idempotency";
import { emitDropInventory, emitDropPrice, emitDropStatus } from "../realtime/socket";
import { fairnessQueue } from "../services/fairnessQueueService";

export async function listDropsController(_req: Request, res: Response) {
  res.json({ drops: await getDrops(), serverTime: new Date().toISOString() });
}

export async function buyPackController(req: Request, res: Response) {
  const key = (req as Request & { idempotencyKey: string }).idempotencyKey;
  const scope = `pack:${req.user!.userId}`;
  const cached = await getIdempotentResponse(scope, key);
  if (cached) return void res.json(cached);

  try {
    const purchase = await buyPack(req.user!.userId, req.body.dropId, key);
    const out = { purchase: purchase.purchase };

    if (req.fairnessClaim) {
      await fairnessQueue.completeWinnerSlot(req.fairnessClaim.userId, req.fairnessClaim.dropId, true);
    }

    emitDropInventory(req.body.dropId, purchase.remainingInventory);
    await setIdempotentResponse(scope, key, out, 24 * 60 * 60);
    res.json(out);
  } catch (error) {
    if (req.fairnessClaim) {
      await fairnessQueue.completeWinnerSlot(req.fairnessClaim.userId, req.fairnessClaim.dropId, false);
    }
    throw error;
  }
}

export async function revealPackController(req: Request, res: Response) {
  const data = await revealPack(req.user!.userId, req.params.purchaseId);
  res.json(data);
}

export async function adminUpdateDropController(req: Request, res: Response) {
  const { dropId } = req.params;
  const { price, startsAt, endsAt } = req.body;

  const updated = await adminUpdateDrop(dropId, {
    price,
    starts_at: startsAt,
    ends_at: endsAt
  });

  if (!updated) return res.status(404).json({ error: "Drop not found" });

  if (price !== undefined) {
    emitDropPrice(dropId, updated.price);
  }

  if (startsAt !== undefined || endsAt !== undefined) {
    emitDropStatus(dropId, updated.starts_at, updated.ends_at);
  }

  res.json({ drop: updated });
}

export async function checkFairnessQueueController(req: Request, res: Response) {
  const { dropId } = req.params;
  const userId = req.user!.userId;

  const result = await fairnessQueue.checkQueueResult(userId, dropId);
  res.json(result);
}

export async function processFairnessQueueController(req: Request, res: Response) {
  const { dropId } = req.params;
  const { availableInventory } = req.body;

  if (typeof availableInventory !== 'number' || availableInventory < 0) {
    return res.status(400).json({ error: 'Invalid inventory count' });
  }

  const winners = await fairnessQueue.processFairnessWindow(dropId, availableInventory);

  res.json({
    winners,
    count: winners.length,
    message: `Processed fairness queue, ${winners.length} winners selected`,
  });
}
