import { PoolClient } from "pg";

export async function getUserByEmail(client: PoolClient, email: string) {
  const { rows } = await client.query("select * from users where email=$1", [email]);
  return rows[0] ?? null;
}

export async function createUser(client: PoolClient, email: string, passwordHash: string) {
  const { rows } = await client.query(
    "insert into users(email,password_hash) values($1,$2) returning *",
    [email, passwordHash]
  );
  return rows[0];
}
