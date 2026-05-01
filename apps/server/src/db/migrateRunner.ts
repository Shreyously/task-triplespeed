import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pool, withTx } from "./pool";

async function ensureMigrationsTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists applied_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
  } finally {
    client.release();
  }
}

async function runMigrations() {
  const dir = join(process.cwd(), "..", "..", "infra", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) {
    console.log("No migrations found");
    return;
  }

  for (const file of files) {
    const id = file;
    const sql = readFileSync(join(dir, file), "utf-8");
    await withTx(async (client) => {
      const exists = await client.query("select 1 from applied_migrations where id=$1", [id]);
      if (exists.rowCount) {
        console.log(`Skipping ${id} (already applied)`);
        return;
      }
      await client.query(sql);
      await client.query("insert into applied_migrations(id) values($1)", [id]);
      console.log(`Applied ${id}`);
    });
  }
}

ensureMigrationsTable()
  .then(runMigrations)
  .then(async () => {
    await pool.end();
    console.log("Migrations complete");
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
