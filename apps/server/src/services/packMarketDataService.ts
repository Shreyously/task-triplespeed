import { createHash } from "crypto";
import { PoolClient } from "pg";
import { getCardPool, type CardPoolItem } from "./pokemonCardService";
import { RARITY_BASE_RANGES } from "./priceEngineService";
import { pool } from "../db/pool";

export interface PoolMarketCard extends CardPoolItem {
  marketValue: number;
}

export interface PoolMarketAverage {
  rarity: string;
  avg: number;
  stddev: number;
  count: number;
}

function stddev(values: number[], mean: number): number {
  if (values.length < 2) {
    return 0;
  }

  const variance = values.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function stableFraction(input: string): number {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 8);
  const int = parseInt(digest, 16);
  return int / 0xffffffff;
}

export function estimateStablePoolCardValue(card: CardPoolItem): number {
  const [min, max] = RARITY_BASE_RANGES[card.rarity] ?? RARITY_BASE_RANGES.Common;
  const fraction = stableFraction(`${card.name}|${card.setName}|${card.rarity}`);
  const scaled = 0.2 + (fraction * 0.6);
  return Number((min + ((max - min) * scaled)).toFixed(2));
}

export async function getPoolMarketCards(): Promise<PoolMarketCard[]> {
  // Redis call outside of DB transaction context
  const cardPool = await getCardPool();

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT
         name,
         set_name AS "setName",
         rarity,
         AVG(market_value)::float AS "marketValue"
       FROM cards
       GROUP BY name, set_name, rarity`
    );

    const observedValues = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.name}|${row.setName}|${row.rarity}`;
      observedValues.set(key, Number(row.marketValue));
    }

    return cardPool.map((card) => {
      const key = `${card.name}|${card.setName}|${card.rarity}`;
      return {
        ...card,
        marketValue: observedValues.get(key) ?? estimateStablePoolCardValue(card),
      };
    });
  } finally {
    client.release();
  }
}

export async function getPoolMarketAverages(): Promise<PoolMarketAverage[]> {
  const cards = await getPoolMarketCards();
  const valuesByRarity = new Map<string, number[]>();

  for (const card of cards) {
    const bucket = valuesByRarity.get(card.rarity) ?? [];
    bucket.push(card.marketValue);
    valuesByRarity.set(card.rarity, bucket);
  }

  return [...valuesByRarity.entries()]
    .map(([rarity, values]) => {
      const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
      return {
        rarity,
        avg: mean,
        stddev: stddev(values, mean),
        count: values.length,
      };
    })
    .sort((left, right) => left.avg - right.avg);
}
