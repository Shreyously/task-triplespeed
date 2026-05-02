import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { getBalance } from "../repositories/balanceRepository";
import { getCardsByOwner } from "../repositories/cardRepository";

const HISTORY_INTERVALS: Record<string, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days"
};

export async function getCollection(userId: string) {
  const client = await pool.connect();
  try {
    const cards = await getCardsByOwner(client, userId) as Array<Record<string, string>>;
    return cards.map((card: Record<string, string>) => {
      const pnl = new Decimal(card.market_value).minus(card.acquisition_value);
      return { ...card, pnl: pnl.toFixed(2) };
    });
  } finally {
    client.release();
  }
}

export async function getPortfolioSummary(userId: string) {
  const client = await pool.connect();
  try {
    const cards = await getCardsByOwner(client, userId) as Array<Record<string, string>>;
    const bal = await getBalance(client, userId);
    const portfolio = cards.reduce((acc: Decimal, c: Record<string, string>) => acc.plus(c.market_value), new Decimal(0));
    const available = new Decimal(bal?.available_balance ?? 0);
    const held = new Decimal(bal?.held_balance ?? 0);
    return {
      cardsValue: portfolio.toFixed(2),
      availableBalance: available.toFixed(2),
      heldBalance: held.toFixed(2),
      netWorth: portfolio.plus(available).plus(held).toFixed(2)
    };
  } finally {
    client.release();
  }
}

export async function getPortfolioHistory(userId: string, range: "24h" | "7d" | "30d") {
  const interval = HISTORY_INTERVALS[range] ?? HISTORY_INTERVALS["24h"];
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `select total_value, taken_at
       from portfolio_snapshots
       where user_id = $1 and taken_at >= now() - interval '${interval}'
       order by taken_at asc`,
      [userId]
    );
    return rows.map((row) => ({
      value: Number(row.total_value).toFixed(2),
      at: row.taken_at
    }));
  } finally {
    client.release();
  }
}

export async function recordPortfolioSnapshots() {
  const client = await pool.connect();
  try {
    await client.query(
      `insert into portfolio_snapshots(user_id, total_value, taken_at)
       select
         b.user_id,
         (b.available_balance + b.held_balance + coalesce(card_totals.cards_value, 0))::numeric(18,2) as total_value,
         now()
       from balances b
       left join (
         select owner_id, coalesce(sum(market_value), 0)::numeric(18,2) as cards_value
         from cards
         group by owner_id
       ) card_totals on card_totals.owner_id = b.user_id`
    );
  } finally {
    client.release();
  }
}
