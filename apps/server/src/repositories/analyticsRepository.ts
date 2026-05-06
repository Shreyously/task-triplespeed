import { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import type {
  AnalyticsAlert,
  EconomicHealthData,
  FairnessAuditData,
  FraudHealthData,
  UserHealthData
} from "@pullvault/common";

const HEALTH_WINDOW_HOURS = 24;

function toNum(value: unknown): number {
  return Number(value ?? 0);
}

function safeRate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}

function round(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function calcGammaLn(xx: number): number {
  const cof = [
    76.18009172947146,
    -86.50532032941677,
    24.01409824083091,
    -1.231739572450155,
    0.001208650973866179,
    -0.000005395239384953
  ];
  let x = xx - 1;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) {
    x += 1;
    ser += c / x;
  }
  return -tmp + Math.log(2.5066282746310005 * ser);
}

function gammaLowerRegularized(a: number, x: number): number {
  if (x < 0 || a <= 0) return 0;
  if (x === 0) return 0;

  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 1; i <= 100; i += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 3e-7) {
        return sum * Math.exp(-x + a * Math.log(x) - calcGammaLn(a));
      }
    }
    return sum * Math.exp(-x + a * Math.log(x) - calcGammaLn(a));
  }

  let b = x + 1 - a;
  let c = 1 / 1e-30;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 100; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = b + an / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - calcGammaLn(a)) * h;
}

export function chiSquarePValue(statistic: number, degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0 || statistic < 0) return 1;
  const k = degreesOfFreedom / 2;
  const x = statistic / 2;
  const cdf = gammaLowerRegularized(k, x);
  return Math.max(0, Math.min(1, 1 - cdf));
}

export function classifyFairnessSignificance(
  sampleSize: number,
  degreesOfFreedom: number,
  pValue: number | null
): FairnessAuditData["significance"] {
  if (sampleSize < 30 || degreesOfFreedom <= 0 || pValue === null) {
    return "INSUFFICIENT_SAMPLE";
  }
  if (pValue < 0.01) return "FAIL";
  if (pValue < 0.05) return "WATCH";
  return "PASS";
}

export async function insertRateLimitEvent(
  client: Pool | PoolClient,
  event: {
    userId: string | null;
    ipHash: string;
    routeType: string;
    accessPolicy: string;
    allowed: boolean;
    degraded: boolean;
    failureMode: string;
    blockedBy: string | null;
    retryAfterSeconds: number | null;
    requestLimit: number;
    remaining: number;
  }
) {
  await client.query(
    `insert into rate_limit_events(
      user_id, ip_hash, route_type, access_policy, allowed, degraded, failure_mode,
      blocked_by, retry_after_seconds, request_limit, remaining
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      event.userId,
      event.ipHash,
      event.routeType,
      event.accessPolicy,
      event.allowed,
      event.degraded,
      event.failureMode,
      event.blockedBy,
      event.retryAfterSeconds,
      event.requestLimit,
      event.remaining
    ]
  );
}

export async function insertBotActivityEvent(
  client: Pool | PoolClient,
  event: {
    userId: string | null;
    ipHash: string;
    userAgentHash: string;
    score: number;
    action: string;
    reasons: string[];
  }
) {
  await client.query(
    `insert into bot_activity_events(
      user_id, ip_hash, user_agent_hash, score, action, reasons
    ) values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      event.userId,
      event.ipHash,
      event.userAgentHash,
      event.score,
      event.action,
      JSON.stringify(event.reasons)
    ]
  );
}

export async function insertFairnessVerificationEvent(
  client: Pool | PoolClient,
  event: {
    purchaseId: string;
    userId: string | null;
    clientFingerprintHash: string | null;
    ok: boolean;
    checks: Record<string, boolean>;
  }
) {
  await client.query(
    `insert into fairness_verification_events(
      purchase_id, user_id, client_fingerprint_hash, ok, checks
    ) values ($1,$2,$3,$4,$5::jsonb)`,
    [
      event.purchaseId,
      event.userId,
      event.clientFingerprintHash,
      event.ok,
      JSON.stringify(event.checks)
    ]
  );
}

export async function getRevenueBreakdown(client: Pool | PoolClient, _platformUserId: string) {
  const [packResult, tradeFeeResult, auctionFeeResult] = await Promise.all([
    client.query(`select coalesce(sum(price_paid), 0) as total from pack_purchases`),
    client.query(`select coalesce(sum(fee_amount), 0) as total from trade_transactions`),
    client.query(`select coalesce(sum(fee_amount), 0) as total from auction_settlements`)
  ]);

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

export async function getPackEVAnalysis(client: Pool | PoolClient) {
  const marketValuesResult = await client.query(`
    select rarity, avg(market_value) as avg_value, count(*) as card_count
    from cards
    group by rarity
    order by rarity
  `);
  const marketValues: Record<string, number> = {};
  marketValuesResult.rows.forEach((row) => {
    marketValues[row.rarity] = parseFloat(row.avg_value) || 0;
  });

  const dropsResult = await client.query(`
    select
      d.tier,
      d.price,
      d.cards_per_pack,
      pcv.rarity_weights,
      pcv.target_margin,
      pcv.simulated_win_rate,
      pcv.trigger_reason,
      pcv.id as config_version_id,
      pcv.created_at as config_created_at
    from drops d
    join pack_config_versions pcv
      on pcv.tier = d.tier and pcv.is_active = true
    order by d.price
  `);

  return dropsResult.rows.map((drop) => {
    const rarityWeights = drop.rarity_weights as Record<string, number>;
    let totalEV = 0;
    const breakdown = Object.entries(rarityWeights).map(([rarity, weight]) => {
      const avgValue = marketValues[rarity] || 0;
      const contribution = Number(weight) * avgValue * Number(drop.cards_per_pack);
      totalEV += contribution;
      return {
        rarity,
        weight: Number(weight),
        avgMarketValue: avgValue.toFixed(2),
        contribution: contribution.toFixed(2)
      };
    });

    const price = Number(drop.price);
    const margin = price - totalEV;
    const marginPercentage = (margin / price) * 100;
    const currentMargin = margin / price;
    const targetMargin = Number(drop.target_margin ?? 0);

    return {
      tier: drop.tier,
      price,
      cardsPerPack: Number(drop.cards_per_pack),
      expectedValue: totalEV.toFixed(2),
      margin: margin.toFixed(2),
      marginPercentage: Math.round(marginPercentage * 100) / 100,
      targetMargin,
      currentMargin,
      winRate: Number(drop.simulated_win_rate ?? 0),
      lastTriggerReason: drop.trigger_reason ?? null,
      configVersionId: drop.config_version_id ?? null,
      lastRebalancedAt: drop.config_created_at ?? null,
      rarityBreakdown: breakdown
    };
  });
}

export async function getTransactionVolumes(client: Pool | PoolClient, timeframe: string = "24h") {
  const interval = timeframe === "24h" ? "24 hours" : timeframe === "7d" ? "7 days" : "30 days";
  const [tradeResult, auctionResult, packResult] = await Promise.all([
    client.query(`
      select count(*) as count, coalesce(sum(gross_amount), 0) as total_volume
      from trade_transactions where created_at >= now() - interval '${interval}'
    `),
    client.query(`
      select count(*) as count, coalesce(sum(gross_amount), 0) as total_volume
      from auction_settlements where created_at >= now() - interval '${interval}'
    `),
    client.query(`
      select count(*) as count, coalesce(sum(price_paid), 0) as total_volume
      from pack_purchases where created_at >= now() - interval '${interval}'
    `)
  ]);

  return {
    trades: { count: Number(tradeResult.rows[0].count || 0), totalVolume: tradeResult.rows[0].total_volume || "0.00" },
    auctions: { count: Number(auctionResult.rows[0].count || 0), totalVolume: auctionResult.rows[0].total_volume || "0.00" },
    packs: { count: Number(packResult.rows[0].count || 0), totalVolume: packResult.rows[0].total_volume || "0.00" }
  };
}

export async function getPlatformProfitability(client: Pool | PoolClient, platformUserId: string) {
  const revenue = await getRevenueBreakdown(client, platformUserId);
  const realizedCogsResult = await client.query(`
    select coalesce(sum(c.acquisition_value), 0) as total
    from cards c
    inner join pack_purchases p on p.id = c.purchase_id
  `);
  const totalRevenue = new Decimal(revenue.totalRevenue);
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

export async function getMarketStats(client: Pool | PoolClient) {
  const result = await client.query(`
    select rarity, avg(market_value) as avg_value, min(market_value) as min_value, max(market_value) as max_value, count(*) as card_count
    from cards
    group by rarity
    order by rarity
  `);
  return result.rows.map((row) => ({
    rarity: row.rarity,
    avgValue: row.avg_value || "0.00",
    minValue: row.min_value || "0.00",
    maxValue: row.max_value || "0.00",
    cardCount: Number(row.card_count || 0)
  }));
}

export async function getAuctionIntegrityMetrics(client: Pool | PoolClient) {
  const [summaryResult, flagCountResult] = await Promise.all([
    client.query(`
      with auction_bidders as (
        select auction_id, count(distinct bidder_id)::numeric as bidder_count
        from (select auction_id, bidder_id from bids union all select auction_id, bidder_id from sealed_bids) s
        group by auction_id
      )
      select
        count(*)::numeric as total_auctions,
        coalesce(avg(case when a.current_bid > 0 then 1 else 0 end), 0) as participation_rate,
        coalesce(avg(coalesce(ab.bidder_count, 0)), 0) as avg_bidders,
        coalesce(avg(case when a.sealed_phase_started_at is not null then 1 else 0 end), 0) as sealed_rate,
        coalesce(avg(case when a.anti_snipe_extensions > 0 then 1 else 0 end), 0) as snipe_rate,
        coalesce(avg(case when s.gross_amount is not null and c.market_value > 0 and s.gross_amount / c.market_value < $1 then 1 else 0 end), 0) as low_close_rate
      from auctions a
      join cards c on c.id = a.card_id
      left join auction_settlements s on s.auction_id = a.id
      left join auction_bidders ab on ab.auction_id = a.id
    `, [0.65]),
    client.query(`select count(*)::numeric as flag_count from auction_integrity_flags`)
  ]);
  const summary = summaryResult.rows[0];
  const totalAuctions = Number(summary?.total_auctions ?? 0);
  const flagCount = Number(flagCountResult.rows[0]?.flag_count ?? 0);
  return {
    participationRate: Number((Number(summary?.participation_rate ?? 0) * 100).toFixed(2)),
    averageBidders: Number(Number(summary?.avg_bidders ?? 0).toFixed(2)),
    sealedEndgameRate: Number((Number(summary?.sealed_rate ?? 0) * 100).toFixed(2)),
    lowCloseRate: Number((Number(summary?.low_close_rate ?? 0) * 100).toFixed(2)),
    flagRate: totalAuctions > 0 ? Number(((flagCount / totalAuctions) * 100).toFixed(2)) : 0,
    snipeRate: Number((Number(summary?.snipe_rate ?? 0) * 100).toFixed(2)),
    auctionsReviewed: flagCount
  };
}

export async function getFlaggedAuctions(client: Pool | PoolClient) {
  const { rows } = await client.query(`
    with bidder_stats as (
      select auction_id, count(distinct bidder_id)::int as bidder_count
      from (select auction_id, bidder_id from bids union all select auction_id, bidder_id from sealed_bids) s
      group by auction_id
    )
    select
      f.id, f.auction_id, f.flag_type, f.severity, f.details, f.created_at, f.status,
      a.seller_id, s.winner_id, s.gross_amount as final_price, c.market_value, coalesce(bs.bidder_count, 0) as bidder_count
    from auction_integrity_flags f
    join auctions a on a.id = f.auction_id
    join cards c on c.id = a.card_id
    left join auction_settlements s on s.auction_id = a.id
    left join bidder_stats bs on bs.auction_id = a.id
    order by f.created_at desc
    limit 25
  `);
  return rows.map((row) => ({
    id: row.id,
    auctionId: row.auction_id,
    flagType: row.flag_type,
    severity: Number(row.severity),
    details: row.details ?? {},
    createdAt: row.created_at,
    status: row.status,
    sellerId: row.seller_id,
    winnerId: row.winner_id,
    finalPrice: row.final_price,
    marketValue: row.market_value,
    bidderCount: Number(row.bidder_count ?? 0)
  }));
}

export async function getFraudHealth(client: Pool | PoolClient): Promise<FraudHealthData> {
  const [rateResult, botSummaryResult, topBucketResult, flaggedAccountsResult] = await Promise.all([
    client.query(`
      select
        count(*)::int as total,
        count(*) filter (where allowed = false)::int as blocked,
        count(*) filter (where failure_mode = 'degraded-open')::int as degraded_open,
        count(*) filter (where failure_mode = 'degraded-closed')::int as degraded_closed
      from rate_limit_events
      where created_at >= now() - interval '${HEALTH_WINDOW_HOURS} hours'
    `),
    client.query(`
      select
        count(*) filter (where action = 'throttle')::int as throttles,
        count(*) filter (where action = 'block')::int as blocks,
        count(distinct user_id) filter (where score >= 0.7 and user_id is not null)::int as high_risk_accounts
      from bot_activity_events
      where created_at >= now() - interval '${HEALTH_WINDOW_HOURS} hours'
    `),
    client.query(`
      select blocked_by, count(*)::int as total
      from rate_limit_events
      where created_at >= now() - interval '${HEALTH_WINDOW_HOURS} hours'
        and allowed = false
        and blocked_by is not null
      group by blocked_by
      order by total desc
      limit 1
    `),
    client.query(`
      select
        user_id,
        count(*)::int as event_count,
        max(score)::numeric as max_score,
        (array_agg(action order by created_at desc))[1] as latest_action,
        max(created_at) as latest_seen_at
      from bot_activity_events
      where created_at >= now() - interval '${HEALTH_WINDOW_HOURS} hours'
      group by user_id
      having max(score) >= 0.45 or count(*) >= 3
      order by max(score) desc, count(*) desc
      limit 10
    `)
  ]);

  const rateRow = rateResult.rows[0];
  const total = Number(rateRow?.total ?? 0);
  const blocked = Number(rateRow?.blocked ?? 0);
  const botRow = botSummaryResult.rows[0];

  return {
    windowHours: HEALTH_WINDOW_HOURS,
    totalProtectedRequests: total,
    blockedRequests: blocked,
    blockRate: round(safeRate(blocked, total), 4),
    degradedOpenCount: Number(rateRow?.degraded_open ?? 0),
    degradedClosedCount: Number(rateRow?.degraded_closed ?? 0),
    rateLimitEffectiveness: round(safeRate(blocked, total), 4),
    topBlockedBucket: topBucketResult.rows[0]?.blocked_by ?? null,
    botThrottleCount: Number(botRow?.throttles ?? 0),
    botBlockCount: Number(botRow?.blocks ?? 0),
    highRiskAccountCount: Number(botRow?.high_risk_accounts ?? 0),
    flaggedAccounts: flaggedAccountsResult.rows.map((row) => ({
      userId: row.user_id,
      recentEvents: Number(row.event_count),
      maxScore: Number(row.max_score),
      latestAction: row.latest_action,
      latestSeenAt: new Date(row.latest_seen_at).toISOString()
    }))
  };
}

export async function getEconomicHealth(client: Pool | PoolClient): Promise<EconomicHealthData> {
  const tierRows = await client.query(`
    select
      d.tier,
      coalesce(stats.sales_count, 0) as sales_count_24h,
      coalesce(stats.revenue, 0) as revenue_24h,
      coalesce(stats.cogs, 0) as cogs_24h,
      pcv.target_margin
    from drops d
    left join (
      select
        pp.drop_id,
        count(pp.id)::int as sales_count,
        sum(pp.price_paid) as revenue,
        sum(cogs_agg.total_cogs) as cogs
      from pack_purchases pp
      left join (
        select purchase_id, sum(acquisition_value) as total_cogs
        from cards
        group by purchase_id
      ) cogs_agg on cogs_agg.purchase_id = pp.id
      where pp.created_at >= now() - interval '24 hours'
      group by pp.drop_id
    ) stats on stats.drop_id = d.id
    left join pack_config_versions pcv
      on pcv.tier = d.tier and pcv.is_active = true
    order by d.tier
  `);

  const revenueRows = await client.query(`
    select
      coalesce((select sum(price_paid) from pack_purchases where created_at >= now() - interval '24 hours'), 0)
      + coalesce((select sum(fee_amount) from trade_transactions where created_at >= now() - interval '24 hours'), 0)
      + coalesce((select sum(fee_amount) from auction_settlements where created_at >= now() - interval '24 hours'), 0)
      as trailing_revenue_24h
  `);
  const trailing = new Decimal(revenueRows.rows[0]?.trailing_revenue_24h || 0);

  return {
    tiers: tierRows.rows.map((row) => {
      const rev = new Decimal(row.revenue_24h || 0);
      const cogs = new Decimal(row.cogs_24h || 0);
      const realizedMargin = rev.gt(0) ? Number(rev.minus(cogs).div(rev).toFixed(4)) : null;
      const targetMargin = row.target_margin !== null ? Number(row.target_margin) : null;
      const delta = realizedMargin !== null && targetMargin !== null ? round(realizedMargin - targetMargin, 4) : null;
      return {
        tier: row.tier,
        salesCount24h: Number(row.sales_count_24h ?? 0),
        revenue24h: rev.toFixed(2),
        realizedCogs24h: cogs.toFixed(2),
        realizedMargin24h: realizedMargin,
        targetMargin,
        marginDeltaFromTarget: delta
      };
    }),
    trailingRevenue24h: trailing.toFixed(2),
    projectedRevenueDaily: trailing.toFixed(2),
    projectedRevenue30d: trailing.times(30).toFixed(2)
  };
}

export async function getFairnessAudit(client: Pool | PoolClient): Promise<FairnessAuditData> {
  const events = await client.query(`
    with rare_obs as (
      select
        jsonb_array_elements_text(payload->'drawnRarities') as rarity,
        count(*)::int as observed
      from pack_opening_audit_events
      where created_at >= now() - interval '7 days'
      group by rarity
    ),
    expected as (
      select
        key as rarity,
        sum((value::numeric / 1000000.0) * pof.cards_per_pack)::numeric as expected
      from pack_opening_fairness pof,
      jsonb_each_text(pof.rarity_weight_micros)
      where pof.created_at >= now() - interval '7 days'
      group by key
    )
    select
      coalesce(o.rarity, e.rarity) as rarity,
      coalesce(o.observed, 0)::int as observed,
      coalesce(e.expected, 0)::numeric as expected
    from rare_obs o
    full outer join expected e on e.rarity = o.rarity
    order by coalesce(o.rarity, e.rarity)
  `);
  const sampleResult = await client.query(`
    select
      (select count(*)::int from pack_opening_fairness where created_at >= now() - interval '7 days') as openings,
      (select count(distinct user_id)::int from fairness_verification_events where created_at >= now() - interval '7 days' and user_id is not null) as verification_users,
      (select count(distinct coalesce(user_id::text, client_fingerprint_hash))::int from fairness_verification_events where created_at >= now() - interval '7 days') as verification_sessions
  `);

  const rows = events.rows.map((row) => ({
    rarity: row.rarity,
    observed: Number(row.observed),
    expected: Number(row.expected)
  }));
  const usable = rows.filter((row) => row.expected >= 5);
  const degreesOfFreedom = Math.max(0, usable.length - 1);
  let statistic = 0;
  for (const row of usable) {
    statistic += ((row.observed - row.expected) ** 2) / row.expected;
  }
  const sampleRow = sampleResult.rows[0];
  const openings = Number(sampleRow?.openings ?? 0);

  if (openings < 30 || degreesOfFreedom <= 0) {
    return {
      sampleSize: openings,
      statistic: null,
      pValue: null,
      degreesOfFreedom,
      significance: "INSUFFICIENT_SAMPLE",
      observedExpectedByRarity: rows.map((row) => ({ ...row, expected: round(row.expected, 4) })),
      verificationUsers: Number(sampleRow?.verification_users ?? 0),
      verificationSessions: Number(sampleRow?.verification_sessions ?? 0)
    };
  }

  const pValue = chiSquarePValue(statistic, degreesOfFreedom);
  const significance = classifyFairnessSignificance(openings, degreesOfFreedom, pValue);
  return {
    sampleSize: openings,
    statistic: round(statistic, 6),
    pValue: round(pValue, 6),
    degreesOfFreedom,
    significance,
    observedExpectedByRarity: rows.map((row) => ({ ...row, expected: round(row.expected, 4) })),
    verificationUsers: Number(sampleRow?.verification_users ?? 0),
    verificationSessions: Number(sampleRow?.verification_sessions ?? 0)
  };
}

export async function getUserHealth(client: Pool | PoolClient): Promise<UserHealthData> {
  const [auctionStats, packDropStats, listingStats, retentionStats] = await Promise.all([
    client.query(`
      with bid_counts as (
        select auction_id, count(*)::int as bid_count, count(distinct bidder_id)::int as bidder_count
        from bids
        where created_at >= now() - interval '24 hours'
        group by auction_id
      )
      select
        count(*)::int as auctions_24h,
        count(*) filter (where coalesce(bc.bid_count, 0) > 0)::int as auctions_with_bids,
        coalesce(avg(coalesce(bc.bidder_count, 0)), 0)::numeric as avg_bidders,
        coalesce(avg(coalesce(bc.bid_count, 0)), 0)::numeric as avg_bids
      from auctions a
      left join bid_counts bc on bc.auction_id = a.id
      where a.created_at >= now() - interval '24 hours'
    `),
    client.query(`
      with live_drops as (
        select
          d.id,
          d.inventory,
          coalesce((
            select count(*)::int from pack_purchases pp where pp.drop_id = d.id
          ), 0) as sold_count
        from drops d
        where d.starts_at <= now() and d.ends_at > now()
      ),
      pack_agg as (
        select
          count(*)::int as packs_bought_24h,
          count(distinct user_id)::int as unique_buyers_24h
        from pack_purchases
        where created_at >= now() - interval '24 hours'
      )
      select
        p.packs_bought_24h,
        p.unique_buyers_24h,
        case
          when count(ld.id) = 0 then 0::numeric
          else coalesce(avg(
            case
              when (ld.sold_count + ld.inventory) > 0
              then ld.sold_count::numeric / (ld.sold_count + ld.inventory)::numeric
              else 0
            end
          ), 0)
        end as sell_through
      from pack_agg p
      left join live_drops ld on true
      group by p.packs_bought_24h, p.unique_buyers_24h
    `),
    client.query(`
      select
        (select count(*)::int from listings where created_at >= now() - interval '24 hours') as created_24h,
        (select count(*)::int from trade_transactions where created_at >= now() - interval '24 hours') as trades_24h
    `),
    client.query(`
      with cohort as (
        select date_trunc('day', created_at) as signup_day, id as user_id
        from users
        where created_at >= now() - interval '14 days'
      ),
      activity as (
        select user_id, created_at from pack_purchases
        union all select seller_id as user_id, created_at from listings
        union all select buyer_id as user_id, created_at from trade_transactions
        union all select bidder_id as user_id, created_at from bids
      )
      select
        coalesce(avg(case when exists (
          select 1 from activity a
          where a.user_id = c.user_id
            and a.created_at >= c.signup_day + interval '1 day'
            and a.created_at < c.signup_day + interval '2 day'
        ) then 1 else 0 end), 0)::numeric as d1_retention,
        coalesce(avg(case when exists (
          select 1 from activity a
          where a.user_id = c.user_id
            and a.created_at >= c.signup_day + interval '7 day'
            and a.created_at < c.signup_day + interval '8 day'
        ) then 1 else 0 end), 0)::numeric as d7_retention
      from cohort c
    `)
  ]);

  const auctionRow = auctionStats.rows[0];
  const dropRow = packDropStats.rows[0];
  const listingRow = listingStats.rows[0];
  const retentionRow = retentionStats.rows[0];

  const auctionCount = Number(auctionRow?.auctions_24h ?? 0);
  const auctionParticipationRate = safeRate(Number(auctionRow?.auctions_with_bids ?? 0), auctionCount);
  const averageBiddersPerAuction = Number(auctionRow?.avg_bidders ?? 0);
  const bidPerAuction = Number(auctionRow?.avg_bids ?? 0);
  const listingsCreated = Number(listingRow?.created_24h ?? 0);
  const tradesCompleted = Number(listingRow?.trades_24h ?? 0);
  const listingConversionRate = safeRate(tradesCompleted, listingsCreated);
  const d1 = Number(retentionRow?.d1_retention ?? 0);
  const d7 = Number(retentionRow?.d7_retention ?? 0);
  const sellThrough = Number(dropRow?.sell_through ?? 0);

  let failedThresholds = 0;
  if (auctionParticipationRate < 0.6) failedThresholds += 1;
  if (averageBiddersPerAuction < 2) failedThresholds += 1;
  if (sellThrough < 0.35) failedThresholds += 1;
  if (d1 < 0.25) failedThresholds += 1;

  const status = failedThresholds === 0 ? "healthy" : failedThresholds === 1 ? "watch" : "unhealthy";

  return {
    status,
    auctionParticipationRate: round(auctionParticipationRate, 4),
    averageBiddersPerAuction: round(averageBiddersPerAuction, 4),
    bidPerAuction: round(bidPerAuction, 4),
    packsBought24h: Number(dropRow?.packs_bought_24h ?? 0),
    uniquePackBuyers24h: Number(dropRow?.unique_buyers_24h ?? 0),
    liveDropSellThrough: round(sellThrough, 4),
    listingsCreated24h: listingsCreated,
    tradesCompleted24h: tradesCompleted,
    listingConversionRate24h: round(listingConversionRate, 4),
    d1Retention: round(d1, 4),
    d7Retention: round(d7, 4)
  };
}

export async function cleanupObservabilityTables(client: Pool | PoolClient) {
  // Retain 7 days of detailed logs
  const retentionInterval = "7 days";
  
  const [rateLimitResult, botActivityResult] = await Promise.all([
    client.query(`delete from rate_limit_events where created_at < now() - interval '${retentionInterval}'`),
    client.query(`delete from bot_activity_events where created_at < now() - interval '${retentionInterval}'`)
  ]);

  return {
    rateLimitDeleted: rateLimitResult.rowCount,
    botActivityDeleted: botActivityResult.rowCount
  };
}

export function buildEconomicAlerts(economic: EconomicHealthData): AnalyticsAlert[] {
  const alerts: AnalyticsAlert[] = [];
  for (const tier of economic.tiers) {
    if (tier.targetMargin === null || tier.realizedMargin24h === null) {
      alerts.push({
        level: "INFO",
        code: "MARGIN_INSUFFICIENT_SAMPLE",
        tier: tier.tier,
        message: `${tier.tier}: not enough sales/config data to evaluate margin`
      });
      continue;
    }

    const delta = tier.realizedMargin24h - tier.targetMargin;
    if (delta <= -0.08) {
      alerts.push({
        level: "CRITICAL",
        code: "MARGIN_DROP_CRITICAL",
        tier: tier.tier,
        value: round(delta, 4),
        message: `${tier.tier}: margin is ${(Math.abs(delta) * 100).toFixed(2)}pp below target`
      });
    } else if (delta <= -0.05) {
      alerts.push({
        level: "WARN",
        code: "MARGIN_DROP_WARN",
        tier: tier.tier,
        value: round(delta, 4),
        message: `${tier.tier}: margin is ${(Math.abs(delta) * 100).toFixed(2)}pp below target`
      });
    } else if (delta >= 0.15) {
      alerts.push({
        level: "WARN",
        code: "MARGIN_TOO_HIGH",
        tier: tier.tier,
        value: round(delta, 4),
        message: `${tier.tier}: margin is ${(delta * 100).toFixed(2)}pp above target`
      });
    }
  }
  return alerts;
}
