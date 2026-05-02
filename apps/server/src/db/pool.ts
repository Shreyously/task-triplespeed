import { Pool, PoolClient } from "pg";
import { config } from "../config/env";

export const pool = new Pool({ 
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('neon.tech') || config.databaseUrl.includes('render.com') 
    ? { rejectUnauthorized: false } 
    : false
});

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
