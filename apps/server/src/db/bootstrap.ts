import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pool } from "./pool";
import { config } from "../config/env";

async function applyMigrations(client: any) {
  await client.query(`
    create table if not exists applied_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const dir = join(process.cwd(), "..", "..", "infra", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const exists = await client.query("select 1 from applied_migrations where id=$1", [file]);
    if (exists.rowCount) continue;
    const sql = readFileSync(join(dir, file), "utf-8");
    await client.query(sql);
    await client.query("insert into applied_migrations(id) values($1)", [file]);
  }
}

async function seedInitialPackConfigs(client: any) {
  await client.query(
    `insert into pack_config_versions (
      tier, version, rarity_weights, target_margin, actual_ev,
      simulated_margin, simulated_win_rate, market_snapshot,
      trigger_reason, is_active, activated_at
    )
    select
      d.tier,
      1 as version,
      d.rarity_weights,
      0.2000 as target_margin,
      0.00 as actual_ev,
      0.0000 as simulated_margin,
      0.0000 as simulated_win_rate,
      '{}'::jsonb as market_snapshot,
      'bootstrap_seed'::config_trigger_reason as trigger_reason,
      false as is_active,
      null::timestamptz as activated_at
    from (
      select distinct on (tier) tier, rarity_weights
      from drops
      order by tier, price asc
    ) d
    on conflict (tier, version) do nothing`
  );

  await client.query(
    `with latest as (
      select distinct on (tier) id, tier
      from pack_config_versions
      order by tier, version desc
    )
    update pack_config_versions p
    set is_active = true, activated_at = coalesce(p.activated_at, now())
    from latest l
    where p.id = l.id
      and not exists (
        select 1 from pack_config_versions a
        where a.tier = l.tier and a.is_active = true
      )`
  );
}

export async function bootstrapSchema() {
  const schema = readFileSync(join(process.cwd(), "..", "..", "infra", "schema.sql"), "utf-8");
  const client = await pool.connect();
  try {
    await client.query(schema);
    await applyMigrations(client);

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

    const check = await client.query("select to_regclass('public.pack_config_versions') as t");
    if (!check.rows[0]?.t) {
      throw new Error("B1 bootstrap failed: pack_config_versions table is missing after schema+migrations.");
    }

    await seedInitialPackConfigs(client);
  } catch (e) {
    throw e;
  } finally {
    client.release();
  }
}
