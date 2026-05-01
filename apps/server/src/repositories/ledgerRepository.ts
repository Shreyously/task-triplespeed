import { PoolClient } from "pg";

export async function createLedger(client: PoolClient, userId: string, type: string, amount: string, referenceId?: string, metadata: object = {}) {
  await client.query(
    "insert into ledger(user_id,type,amount,reference_id,metadata) values($1,$2,$3,$4,$5)",
    [userId, type, amount, referenceId ?? null, metadata]
  );
}
