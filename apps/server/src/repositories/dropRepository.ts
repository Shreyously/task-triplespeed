import { PoolClient } from "pg";

export async function getDropForUpdate(client: PoolClient, dropId: string) {
  const { rows } = await client.query("select * from drops where id=$1 for update", [dropId]);
  return rows[0] ?? null;
}

export async function listDrops(client: PoolClient) {
  const { rows } = await client.query("select * from drops order by starts_at asc");
  return rows;
}
