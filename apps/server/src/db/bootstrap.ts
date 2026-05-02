import { readFileSync } from "fs";
import { join } from "path";
import { pool } from "./pool";
import { config } from "../config/env";

export async function bootstrapSchema() {
  const schema = readFileSync(join(process.cwd(), "..", "..", "infra", "schema.sql"), "utf-8");
  const client = await pool.connect();
  try {
    await client.query(schema);
    await client.query(
      "insert into users(id,email,password_hash) values($1,$2,$3) on conflict (id) do nothing",
      [config.platformUserId, "platform@pullvault.local", "$2a$10$rrWpfKt.dm1f2zDRS/8Tte5CeOclby5YnA5W.pWjfEK/q3IC9aNGm"]
    );
    await client.query(
      "insert into balances(user_id,available_balance,held_balance,total_balance) values($1,0,0,0) on conflict (user_id) do nothing",
      [config.platformUserId]
    );

    await client.query(
      `insert into drops(tier,price,cards_per_pack,inventory,starts_at,ends_at,rarity_weights)
       values
       ('Basic',5,3,180,now(),now()+ interval '2 hour','{"Common":0.72,"Uncommon":0.22,"Rare":0.05,"Holo Rare":0.01}'::jsonb),
       ('Pro',15,5,90,now(),now()+ interval '2 hour','{"Common":0.55,"Uncommon":0.25,"Rare":0.12,"Holo Rare":0.06,"Ultra Rare/EX/GX":0.02}'::jsonb),
       ('Elite',40,7,35,now(),now()+ interval '2 hour','{"Common":0.32,"Uncommon":0.24,"Rare":0.2,"Holo Rare":0.14,"Ultra Rare/EX/GX":0.08,"Secret Rare":0.02}'::jsonb)
       on conflict (tier) do update
       set
         price = excluded.price,
         cards_per_pack = excluded.cards_per_pack,
         inventory = excluded.inventory,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         rarity_weights = excluded.rarity_weights`
    );
  } finally {
    client.release();
  }
}
