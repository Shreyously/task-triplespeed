import { bootstrapSchema } from "./bootstrap";
import { pool } from "./pool";

bootstrapSchema()
  .then(async () => {
    console.log("Schema bootstrapped");
    await pool.end();
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
