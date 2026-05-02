import { PoolClient } from "pg";

export async function getDropForUpdate(client: PoolClient, dropId: string) {
  const { rows } = await client.query("select * from drops where id=$1 for update", [dropId]);
  return rows[0] ?? null;
}

export async function listDrops(client: PoolClient) {
  const { rows } = await client.query("select * from drops order by starts_at asc");
  return rows;
}

export async function updateDrop(client: PoolClient, dropId: string, updates: { price?: string; starts_at?: string; ends_at?: string }) {
  const fields: string[] = [];
  const values: any[] = [dropId];
  let i = 2;

  if (updates.price !== undefined) {
    fields.push(`price = $${i++}`);
    values.push(updates.price);
  }
  if (updates.starts_at !== undefined) {
    fields.push(`starts_at = $${i++}`);
    values.push(updates.starts_at);
  }
  if (updates.ends_at !== undefined) {
    fields.push(`ends_at = $${i++}`);
    values.push(updates.ends_at);
  }

  if (fields.length === 0) return null;

  const { rows } = await client.query(
    `update drops set ${fields.join(", ")} where id = $1 returning *`,
    values
  );
  return rows[0] ?? null;
}
