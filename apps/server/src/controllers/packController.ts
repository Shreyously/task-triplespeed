import { Request, Response } from "express";
import { buyPack, getDrops, revealPack } from "../services/packService";
import { getIdempotentResponse, setIdempotentResponse } from "../middleware/idempotency";
import { emitDropInventory } from "../realtime/socket";

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
