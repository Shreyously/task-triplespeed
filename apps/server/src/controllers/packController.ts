import { Request, Response } from "express";
import { adminUpdateDrop, buyPack, getDrops, revealPack } from "../services/packService";
import { getIdempotentResponse, setIdempotentResponse } from "../middleware/idempotency";
import { emitDropInventory, emitDropPrice, emitDropStatus } from "../realtime/socket";

export async function listDropsController(_req: Request, res: Response) {
  res.json({ drops: await getDrops(), serverTime: new Date().toISOString() });
}

export async function buyPackController(req: Request, res: Response) {
  const key = (req as Request & { idempotencyKey: string }).idempotencyKey;
  const scope = `pack:${req.user!.userId}`;
  const cached = await getIdempotentResponse(scope, key);
  if (cached) return void res.json(cached);

  const purchase = await buyPack(req.user!.userId, req.body.dropId, key);
  const out = { purchase: purchase.purchase };
  emitDropInventory(req.body.dropId, purchase.remainingInventory);
  await setIdempotentResponse(scope, key, out, 24 * 60 * 60);
  res.json(out);
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
