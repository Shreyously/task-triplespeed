import { redis } from "../db/redis";
import { config } from "../config/env";

export type CardPoolItem = {
  name: string;
  setName: string;
  rarity: string;
  imageUrl: string;
};

const CACHE_KEY = "tcg:card-pool:v1";
const TTL_SECONDS = 60 * 60;

function normalizeRarity(raw: string | null | undefined): string {
  const value = (raw ?? "Common").toLowerCase();
  if (value.includes("secret")) return "Secret Rare";
  if (value.includes("ultra") || value.includes("ex") || value.includes("gx") || value.includes("vstar")) return "Ultra Rare/EX/GX";
  if (value.includes("holo")) return "Holo Rare";
  if (value.includes("rare")) return "Rare";
  if (value.includes("uncommon")) return "Uncommon";
  return "Common";
}

export async function getCardPool(): Promise<CardPoolItem[]> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached) as CardPoolItem[];
  return refreshCardPool();
}

export async function refreshCardPool(): Promise<CardPoolItem[]> {
  if (!config.pokemonApiKey) throw new Error("Pokemon TCG API key missing");
  const url = `${config.pokemonApiBase}/cards?pageSize=250&select=name,images,set,rarity`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": config.pokemonApiKey }
  });
  if (!res.ok) throw new Error(`Pokemon API failed with ${res.status}`);
  const body = await res.json() as { data?: Array<{ name: string; rarity?: string; set?: { name?: string }; images?: { small?: string } }> };
  const pool = (body.data ?? [])
    .filter((c) => c.name && c.images?.small && c.set?.name)
    .map((c) => ({
      name: c.name,
      setName: c.set?.name ?? "Unknown",
      rarity: normalizeRarity(c.rarity),
      imageUrl: c.images?.small ?? ""
    }));
  if (!pool.length) throw new Error("Pokemon API returned empty pool");
  await redis.set(CACHE_KEY, JSON.stringify(pool), "EX", TTL_SECONDS);
  return pool;
}
