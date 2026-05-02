import { readFileSync } from "fs";
import { join } from "path";
import { pool } from "./pool";

async function seedDatabase() {
  const seedSql = readFileSync(join(process.cwd(), "..", "..", "infra", "seed.sql"), "utf-8");
  const client = await pool.connect();
  try {
    await client.query(seedSql);
    console.log("Seed data loaded");
  } finally {
    client.release();
  }
}

seedDatabase()
  .then(async () => {
    await pool.end();
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
