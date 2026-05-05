import { Request, Response } from "express";
import { adminUpdateDrop, buyPack, getDrops, revealPack } from "../services/packService";
import { getIdempotentResponse, setIdempotentResponse } from "../middleware/idempotency";
import { emitDropInventory, emitDropPrice, emitDropStatus } from "../realtime/socket";
import { fairnessQueue } from "../services/fairnessQueueService";
import { pool, withTx } from "../db/pool";
import { buildPublicOpeningProof, getPublicAuditLog, reserveFairnessCommitment } from "../services/provablyFairService";

export async function listDropsController(_req: Request, res: Response) {
  res.json({ drops: await getDrops(), serverTime: new Date().toISOString() });
}

export async function buyPackController(req: Request, res: Response) {
  const key = (req as Request & { idempotencyKey: string }).idempotencyKey;
  const scope = `pack:${req.user!.userId}`;
  const cached = await getIdempotentResponse(scope, key);
  if (cached) return void res.json(cached);

  try {
    const commitmentId = req.body.commitmentId
      ?? (await withTx((client) => reserveFairnessCommitment(client, req.user!.userId))).commitmentId;
    const clientSeed = req.body.clientSeed ?? `${Date.now()}-${key}`;
    const purchase = await buyPack(
      req.user!.userId,
      req.body.dropId,
      key,
      commitmentId,
      clientSeed
    );
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

export async function reservePackCommitmentController(req: Request, res: Response) {
  const data = await withTx((client) => reserveFairnessCommitment(client, req.user!.userId));
  res.json(data);
}

export async function getPackOpeningProofController(req: Request, res: Response) {
  const client = await pool.connect();
  try {
    const proof = await buildPublicOpeningProof(client, req.params.purchaseId);
    if (!proof) return void res.status(404).json({ error: "Proof not found" });
    res.json(proof);
  } finally {
    client.release();
  }
}

export async function getPackAuditLogController(req: Request, res: Response) {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const client = await pool.connect();
  try {
    const events = await getPublicAuditLog(client, limit, offset);
    res.json({ events, limit, offset });
  } finally {
    client.release();
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
