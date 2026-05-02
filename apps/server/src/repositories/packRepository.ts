import { PoolClient } from "pg";

export async function createPackPurchase(client: PoolClient, userId: string, dropId: string, price: string, idempotencyKey: string) {
  const { rows } = await client.query(
    "insert into pack_purchases(user_id,drop_id,price_paid,idempotency_key) values($1,$2,$3,$4) returning *",
    [userId, dropId, price, idempotencyKey]
  );
  return rows[0];
}

export async function getPurchaseById(client: PoolClient, purchaseId: string, userId: string) {
  const { rows } = await client.query("select * from pack_purchases where id=$1 and user_id=$2", [purchaseId, userId]);
  return rows[0] ?? null;
}

export async function getPurchaseByIdempotencyKey(client: PoolClient, userId: string, idempotencyKey: string) {
  const { rows } = await client.query(
    "select * from pack_purchases where user_id=$1 and idempotency_key=$2",
    [userId, idempotencyKey]
  );
  return rows[0] ?? null;
}
