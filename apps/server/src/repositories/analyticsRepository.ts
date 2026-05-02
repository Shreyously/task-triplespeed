import { PoolClient } from "pg";
import Decimal from "decimal.js";

export async function getRevenueBreakdown(client: PoolClient, platformUserId: string) {
  // Pack revenue (sum of all pack purchases)
  const packResult = await client.query(`
    SELECT COALESCE(SUM(price_paid), 0) as total
    FROM pack_purchases
  `);

  // Trading fees (sum of all trade transaction fees)
  const tradeFeeResult = await client.query(`
    SELECT COALESCE(SUM(fee_amount), 0) as total
    FROM trade_transactions
  `);

  // Auction fees (sum of all auction settlement fees)
  const auctionFeeResult = await client.query(`
    SELECT COALESCE(SUM(fee_amount), 0) as total
    FROM auction_settlements
  `);

  const packRevenue = new Decimal(packResult.rows[0].total || 0);
  const tradeFees = new Decimal(tradeFeeResult.rows[0].total || 0);
  const auctionFees = new Decimal(auctionFeeResult.rows[0].total || 0);
  const totalRevenue = packRevenue.plus(tradeFees).plus(auctionFees);

  return {
    packRevenue: packRevenue.toFixed(2),
    tradeFees: tradeFees.toFixed(2),
    auctionFees: auctionFees.toFixed(2),
    totalRevenue: totalRevenue.toFixed(2)
  };
}

export async function getPackEVAnalysis(client: PoolClient) {
  // Get current market values by rarity
  const marketValuesResult = await client.query(`
    SELECT
      rarity,
      AVG(market_value) as avg_value,
      COUNT(*) as card_count
    FROM cards
    GROUP BY rarity
    ORDER BY rarity
  `);

  const marketValues: Record<string, number> = {};
  marketValuesResult.rows.forEach(row => {
    marketValues[row.rarity] = parseFloat(row.avg_value) || 0;
  });

  // Get pack tier configurations
  const dropsResult = await client.query(`
    SELECT tier, price, cards_per_pack, rarity_weights
    FROM drops
    ORDER BY price
  `);

  const packAnalysis = dropsResult.rows.map(drop => {
    const rarityWeights = drop.rarity_weights;
    let totalEV = 0;
    const breakdown = [];

    for (const [rarity, weight] of Object.entries(rarityWeights)) {
      const avgValue = marketValues[rarity] || 0;
      const contribution = Number(weight) * avgValue * Number(drop.cards_per_pack);
      totalEV += contribution;

      breakdown.push({
        rarity,
        weight: Number(weight),
        avgMarketValue: avgValue.toFixed(2),
        contribution: contribution.toFixed(2)
      });
    }

    const price = Number(drop.price);
    const margin = price - totalEV;
    const marginPercentage = (margin / price) * 100;

    return {
      tier: drop.tier,
      price: price,
      cardsPerPack: Number(drop.cards_per_pack),
      expectedValue: totalEV.toFixed(2),
      margin: margin.toFixed(2),
      marginPercentage: Math.round(marginPercentage * 100) / 100,
      rarityBreakdown: breakdown
    };
  });

  return packAnalysis;
}

export async function getTransactionVolumes(client: PoolClient, timeframe: string = '24h') {
  const interval = timeframe === '24h' ? '24 hours' : timeframe === '7d' ? '7 days' : '30 days';

  // Trade volumes
  const tradeResult = await client.query(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(gross_amount), 0) as total_volume
    FROM trade_transactions
    WHERE created_at >= NOW() - INTERVAL '${interval}'
  `);

  // Auction volumes
  const auctionResult = await client.query(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(gross_amount), 0) as total_volume
    FROM auction_settlements
    WHERE created_at >= NOW() - INTERVAL '${interval}'
  `);

  // Pack purchases
  const packResult = await client.query(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(price_paid), 0) as total_volume
    FROM pack_purchases
    WHERE created_at >= NOW() - INTERVAL '${interval}'
  `);

  return {
    trades: {
      count: tradeResult.rows[0].count || 0,
      totalVolume: tradeResult.rows[0].total_volume || "0.00"
    },
    auctions: {
      count: auctionResult.rows[0].count || 0,
      totalVolume: auctionResult.rows[0].total_volume || "0.00"
    },
    packs: {
      count: packResult.rows[0].count || 0,
      totalVolume: packResult.rows[0].total_volume || "0.00"
    }
  };
}

export async function getPlatformProfitability(client: PoolClient, platformUserId: string) {
  const [packResult, tradeFeeResult, auctionFeeResult, realizedCogsResult] = await Promise.all([
    client.query(`
      SELECT COALESCE(SUM(price_paid), 0) as total
      FROM pack_purchases
    `),
    client.query(`
      SELECT COALESCE(SUM(fee_amount), 0) as total
      FROM trade_transactions
    `),
    client.query(`
      SELECT COALESCE(SUM(fee_amount), 0) as total
      FROM auction_settlements
    `),
    client.query(`
      SELECT COALESCE(SUM(c.acquisition_value), 0) as total
      FROM cards c
      INNER JOIN pack_purchases p ON p.id = c.purchase_id
    `)
  ]);

  const packRevenue = new Decimal(packResult.rows[0].total || 0);
  const tradeFees = new Decimal(tradeFeeResult.rows[0].total || 0);
  const auctionFees = new Decimal(auctionFeeResult.rows[0].total || 0);
  const totalRevenue = packRevenue.plus(tradeFees).plus(auctionFees);
  const totalCosts = new Decimal(realizedCogsResult.rows[0].total || 0);
  const grossProfit = totalRevenue.minus(totalCosts);
  const profitMargin = totalRevenue.gt(0) ? grossProfit.div(totalRevenue).times(100) : new Decimal(0);

  return {
    totalRevenue: totalRevenue.toFixed(2),
    totalCosts: totalCosts.toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    profitMargin: Number(profitMargin.toDecimalPlaces(2).toString())
  };
}

export async function getMarketStats(client: PoolClient) {
  const result = await client.query(`
    SELECT
      rarity,
      AVG(market_value) as avg_value,
      MIN(market_value) as min_value,
      MAX(market_value) as max_value,
      COUNT(*) as card_count
    FROM cards
    GROUP BY rarity
    ORDER BY rarity
  `);

  return result.rows.map(row => ({
    rarity: row.rarity,
    avgValue: row.avg_value || "0.00",
    minValue: row.min_value || "0.00",
    maxValue: row.max_value || "0.00",
    cardCount: row.card_count || 0
  }));
}
