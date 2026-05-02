import bcrypt from "bcryptjs";
import { PoolClient } from "pg";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/db/redis";
import { config } from "../../src/config/env";

const CARD_POOL_CACHE_KEY = "tcg:card-pool:v1";

export async function resetTestData() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("truncate table bids, auction_settlements, auctions, trade_transactions, listings, card_market_state, cards, pack_purchases, ledger, portfolio_snapshots restart identity cascade");
    await client.query("delete from balances where user_id <> $1", [config.platformUserId]);
    await client.query("delete from users where id <> $1", [config.platformUserId]);
    await client.query(
      "insert into users(id,email,password_hash) values($1,$2,$3) on conflict (id) do nothing",
      [config.platformUserId, "platform@pullvault.local", await bcrypt.hash("platform-pass", 10)]
    );
    await client.query(
      "insert into balances(user_id,available_balance,held_balance,total_balance) values($1,0,0,0) on conflict (user_id) do update set available_balance=0, held_balance=0, total_balance=0",
      [config.platformUserId]
    );
    await client.query("delete from drops");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await redis.del(CARD_POOL_CACHE_KEY);
}

export async function seedCardPool() {
  const poolItems = [
    { name: "Pikachu", setName: "Base Set", rarity: "Common", imageUrl: "https://img.example/pikachu.png" },
    { name: "Charmeleon", setName: "Base Set", rarity: "Uncommon", imageUrl: "https://img.example/charmeleon.png" },
    { name: "Gyarados", setName: "Base Set", rarity: "Rare", imageUrl: "https://img.example/gyarados.png" },
    { name: "Mewtwo", setName: "Base Set", rarity: "Holo Rare", imageUrl: "https://img.example/mewtwo.png" },
    { name: "Lugia EX", setName: "Neo", rarity: "Ultra Rare/EX/GX", imageUrl: "https://img.example/lugia.png" },
    { name: "Rayquaza Gold", setName: "Evolving Skies", rarity: "Secret Rare", imageUrl: "https://img.example/rayquaza.png" }
  ];
  await redis.set(CARD_POOL_CACHE_KEY, JSON.stringify(poolItems), "EX", 3600);
}

export async function createTestDrop(overrides?: {
  price?: string;
  inventory?: number;
  cardsPerPack?: number;
  rarityWeights?: Record<string, number>;
  startsAt?: Date;
  endsAt?: Date;
  tier?: string;
}) {
  const client = await pool.connect();
  try {
    const now = new Date();
    const startsAt = overrides?.startsAt ?? new Date(now.getTime() - 60_000);
    const endsAt = overrides?.endsAt ?? new Date(now.getTime() + 3_600_000);
    const price = overrides?.price ?? "10.00";
    const inventory = overrides?.inventory ?? 5;
    const cardsPerPack = overrides?.cardsPerPack ?? 3;
    const rarityWeights = overrides?.rarityWeights ?? { Common: 1 };
    const tier = overrides?.tier ?? "Test";
    const { rows } = await client.query(
      `insert into drops(tier,price,cards_per_pack,inventory,starts_at,ends_at,rarity_weights)
       values($1,$2,$3,$4,$5,$6,$7::jsonb) returning *`,
      [tier, price, cardsPerPack, inventory, startsAt.toISOString(), endsAt.toISOString(), JSON.stringify(rarityWeights)]
    );
    return rows[0];
  } finally {
    client.release();
  }
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows[0] as T;
  } finally {
    client.release();
  }
}

export async function queryAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows as T[];
  } finally {
    client.release();
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
