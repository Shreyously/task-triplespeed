import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { getBalance } from "../repositories/balanceRepository";
import { getCardsByOwner } from "../repositories/cardRepository";

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
