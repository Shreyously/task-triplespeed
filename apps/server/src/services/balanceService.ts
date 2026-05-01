import Decimal from "decimal.js";
import { PoolClient } from "pg";
import { getBalanceForUpdate, updateBalance } from "../repositories/balanceRepository";

export async function debitAvailable(client: PoolClient, userId: string, amount: Decimal) {
  const bal = await getBalanceForUpdate(client, userId);
  if (!bal) throw new Error("Balance not found");
  const available = new Decimal(bal.available_balance);
  const held = new Decimal(bal.held_balance);
  if (available.lt(amount)) throw new Error("Insufficient funds");
  await updateBalance(
    client,
    userId,
    available.minus(amount).toFixed(2),
    held.toFixed(2),
    available.plus(held).minus(amount).toFixed(2)
  );
}

export async function creditAvailable(client: PoolClient, userId: string, amount: Decimal) {
  const bal = await getBalanceForUpdate(client, userId);
  if (!bal) throw new Error("Balance not found");
  const available = new Decimal(bal.available_balance);
  const held = new Decimal(bal.held_balance);
  await updateBalance(
    client,
    userId,
    available.plus(amount).toFixed(2),
    held.toFixed(2),
    available.plus(held).plus(amount).toFixed(2)
  );
}

export async function holdFunds(client: PoolClient, userId: string, amount: Decimal) {
  const bal = await getBalanceForUpdate(client, userId);
  if (!bal) throw new Error("Balance not found");
  const available = new Decimal(bal.available_balance);
  const held = new Decimal(bal.held_balance);
  if (available.lt(amount)) throw new Error("Insufficient available funds");
  await updateBalance(
    client,
    userId,
    available.minus(amount).toFixed(2),
    held.plus(amount).toFixed(2),
    available.plus(held).toFixed(2)
  );
}

export async function releaseFunds(client: PoolClient, userId: string, amount: Decimal) {
  const bal = await getBalanceForUpdate(client, userId);
  if (!bal) throw new Error("Balance not found");
  const available = new Decimal(bal.available_balance);
  const held = new Decimal(bal.held_balance);
  if (held.lt(amount)) throw new Error("Held balance underflow");
  await updateBalance(
    client,
    userId,
    available.plus(amount).toFixed(2),
    held.minus(amount).toFixed(2),
    available.plus(held).toFixed(2)
  );
}

export async function spendHeld(client: PoolClient, userId: string, amount: Decimal) {
  const bal = await getBalanceForUpdate(client, userId);
  if (!bal) throw new Error("Balance not found");
  const available = new Decimal(bal.available_balance);
  const held = new Decimal(bal.held_balance);
  if (held.lt(amount)) throw new Error("Held balance underflow");
  await updateBalance(
    client,
    userId,
    available.toFixed(2),
    held.minus(amount).toFixed(2),
    available.plus(held).minus(amount).toFixed(2)
  );
}
