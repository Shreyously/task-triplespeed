process.env.NODE_ENV = "test";

import { pool } from "../src/db/pool";
import { redis } from "../src/db/redis";

afterAll(async () => {
  await pool.end();
  await redis.quit();
});
