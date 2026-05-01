import { PoolClient } from "pg";

export async function getBalanceForUpdate(client: PoolClient, userId: string) {
  const { rows } = await client.query("select * from balances where user_id=$1 for update", [userId]);
  return rows[0] ?? null;
}

export async function createBalance(client: PoolClient, userId: string, amount: string) {
  await client.query(
    "insert into balances(user_id,available_balance,held_balance,total_balance) values($1,$2,0,$2)",
    [userId, amount]
  );
}

export async function updateBalance(client: PoolClient, userId: string, available: string, held: string, total: string) {
  await client.query(
    "update balances set available_balance=$2, held_balance=$3, total_balance=$4, updated_at=now() where user_id=$1",
    [userId, available, held, total]
  );
}

export async function getBalance(client: PoolClient, userId: string) {
  const { rows } = await client.query("select * from balances where user_id=$1", [userId]);
  return rows[0] ?? null;
}
