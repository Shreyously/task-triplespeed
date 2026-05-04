import { redis } from "../db/redis";
import { FAIRNESS_CONFIG, RATE_LIMITS, type RateLimitType } from "../config/antibot";

export type RateLimitFailureMode = 'normal' | 'degraded-open' | 'degraded-closed';
export type RouteAccessPolicy = 'readOnly' | 'writeProtected';

interface RateLimitConfig {
  limit: number;
  window: number;
}

interface BucketDefinition extends RateLimitConfig {
  key: string;
  name: string;
}

interface PackPurchaseRuntimeConfig {
  perUserPerMinute: number;
  perUserPerHour: number;
  perUserPerDay: number;
  perIPPerMinute: number;
  perIPPerHour: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number;
  limit: number;
  blockedBy?: string;
  failureMode: RateLimitFailureMode;
  degraded: boolean;
}

export interface RouteRateLimitPolicy {
  type: RateLimitType;
  access: RouteAccessPolicy;
}

interface CheckRateLimitOptions {
  botScore?: number;
}

interface CombinedEvalResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  limit: number;
  blockedBy?: string;
  resetAt: Date;
}

const COMBINED_SLIDING_WINDOW_SCRIPT = `
  local now = tonumber(ARGV[1])
  local request_id = ARGV[2]
  local blocked = false
  local blocked_by = ''
  local retry_after_ms = nil
  local tightest_remaining_after = nil
  local tightest_limit_after = nil
  local tightest_window_ms_after = nil

  for i = 1, #KEYS do
    local arg_index = 3 + ((i - 1) * 3)
    local limit = tonumber(ARGV[arg_index])
    local window_ms = tonumber(ARGV[arg_index + 1])
    local bucket_name = ARGV[arg_index + 2]
    local key = KEYS[i]
    local window_start = now - window_ms

    redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
    local count = redis.call('ZCARD', key)
    local remaining_after = limit - count - 1

    if tightest_remaining_after == nil or remaining_after < tightest_remaining_after or (remaining_after == tightest_remaining_after and limit < tightest_limit_after) then
      tightest_remaining_after = remaining_after
      tightest_limit_after = limit
      tightest_window_ms_after = window_ms
    end

    if count >= limit then
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local release_at = now + window_ms
      if oldest[2] ~= nil then
        release_at = tonumber(oldest[2]) + window_ms
      end

      local bucket_retry_after_ms = math.max(1, release_at - now)
      if retry_after_ms == nil or bucket_retry_after_ms < retry_after_ms then
        retry_after_ms = bucket_retry_after_ms
        blocked_by = bucket_name
      end
      blocked = true
    end
  end

  if blocked then
    return {0, math.max(tightest_remaining_after or 0, 0), math.ceil((retry_after_ms or 1000) / 1000), tightest_limit_after or 0, blocked_by, now + (retry_after_ms or 1000)}
  end

  for i = 1, #KEYS do
    local arg_index = 3 + ((i - 1) * 3)
    local window_ms = tonumber(ARGV[arg_index + 1])
    local key = KEYS[i]
    redis.call('ZADD', key, now, now .. ':' .. request_id .. ':' .. i)
    redis.call('PEXPIRE', key, window_ms + 1000)
  end

  return {1, math.max(tightest_remaining_after or 0, 0), 0, tightest_limit_after or 0, '', now + (tightest_window_ms_after or 1000)}
`;

export class RateLimiter {
  constructor(private prefix: string) {}

  async check(
    identifier: string,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const result = await evaluateCombinedBuckets([
      {
        key: `${this.prefix}:${identifier}`,
        name: identifier,
        limit: config.limit,
        window: config.window,
      },
    ]);

    return {
      ...result,
      failureMode: 'normal',
      degraded: false,
    };
  }

  async reset(identifier: string): Promise<void> {
    const key = `${this.prefix}:${identifier}`;
    await redis.del(key);
  }

  async getUsage(identifier: string): Promise<number> {
    const key = `${this.prefix}:${identifier}`;
    const count = await redis.zcard(key);
    return count;
  }
}

function applyPackPurchaseBotTightening(
  config: typeof RATE_LIMITS.PACK_PURCHASE,
  botScore = 0
): PackPurchaseRuntimeConfig {
  if (botScore < 0.45) {
    return {
      perUserPerMinute: config.perUserPerMinute,
      perUserPerHour: config.perUserPerHour,
      perUserPerDay: config.perUserPerDay,
      perIPPerMinute: config.perIPPerMinute,
      perIPPerHour: config.perIPPerHour,
    };
  }

  const tighten = (value: number) => Math.max(1, Math.floor(value * FAIRNESS_CONFIG.degradedIPLimitFactor));

  return {
    ...config,
    perUserPerMinute: tighten(config.perUserPerMinute),
    perUserPerHour: tighten(config.perUserPerHour),
    perUserPerDay: tighten(config.perUserPerDay),
    perIPPerMinute: tighten(config.perIPPerMinute),
    perIPPerHour: tighten(config.perIPPerHour),
  };
}

function getBucketDefinitions(
  userId: string,
  ip: string,
  type: RateLimitType,
  botScore = 0
): BucketDefinition[] {
  switch (type) {
    case 'PACK_PURCHASE': {
      const config = applyPackPurchaseBotTightening(RATE_LIMITS.PACK_PURCHASE, botScore);
      return [
        { key: `rate_limit:pack_purchase:user:${userId}:minute`, name: 'user:minute', limit: config.perUserPerMinute, window: 60 },
        { key: `rate_limit:pack_purchase:user:${userId}:hour`, name: 'user:hour', limit: config.perUserPerHour, window: 3600 },
        { key: `rate_limit:pack_purchase:user:${userId}:day`, name: 'user:day', limit: config.perUserPerDay, window: 86400 },
        { key: `rate_limit:pack_purchase:ip:${ip}:minute`, name: 'ip:minute', limit: config.perIPPerMinute, window: 60 },
        { key: `rate_limit:pack_purchase:ip:${ip}:hour`, name: 'ip:hour', limit: config.perIPPerHour, window: 3600 },
      ];
    }
    case 'AUTH':
      return [
        { key: `rate_limit:auth:ip:${ip}:minute`, name: 'ip:minute', limit: RATE_LIMITS.AUTH.perIPPerMinute, window: 60 },
        { key: `rate_limit:auth:ip:${ip}:hour`, name: 'ip:hour', limit: RATE_LIMITS.AUTH.perIPPerHour, window: 3600 },
      ];
    case 'API':
      return [
        { key: `rate_limit:api:user:${userId}:minute`, name: 'user:minute', limit: RATE_LIMITS.API.perUserPerMinute, window: 60 },
        { key: `rate_limit:api:ip:${ip}:minute`, name: 'ip:minute', limit: RATE_LIMITS.API.perIPPerMinute, window: 60 },
      ];
    case 'MARKETPLACE':
      return [
        { key: `rate_limit:marketplace:user:${userId}:hour`, name: 'user:hour', limit: RATE_LIMITS.MARKETPLACE.perUserPerHour, window: 3600 },
        { key: `rate_limit:marketplace:ip:${ip}:hour`, name: 'ip:hour', limit: RATE_LIMITS.MARKETPLACE.perIPPerHour, window: 3600 },
      ];
    default:
      return [];
  }
}

async function evaluateCombinedBuckets(buckets: BucketDefinition[]): Promise<CombinedEvalResult> {
  const now = Date.now();
  const requestId = `${now}:${Math.random().toString(36).slice(2)}`;
  const keys = buckets.map((bucket) => bucket.key);
  const args = [
    now.toString(),
    requestId,
    ...buckets.flatMap((bucket) => [bucket.limit.toString(), (bucket.window * 1000).toString(), bucket.name]),
  ];

  const result = await redis.eval(
    COMBINED_SLIDING_WINDOW_SCRIPT,
    keys.length,
    ...keys,
    ...args
  ) as [number, number, number, number, string, number];

  const [allowedCode, remaining, retryAfter, limit, blockedBy, resetAt] = result;

  return {
    allowed: allowedCode === 1,
    remaining: Math.max(0, Number(remaining)),
    retryAfter: Number(retryAfter) > 0 ? Number(retryAfter) : undefined,
    limit: Number(limit),
    blockedBy: blockedBy || undefined,
    resetAt: new Date(Number(resetAt)),
  };
}

function degradedResult(policy: RouteRateLimitPolicy, type: RateLimitType): RateLimitResult {
  const fallbackLimit = getBucketDefinitions('anonymous', 'unknown', type)[0]?.limit ?? 100;
  const failureMode: RateLimitFailureMode = policy.access === 'readOnly' ? 'degraded-open' : 'degraded-closed';

  return {
    allowed: policy.access === 'readOnly',
    remaining: fallbackLimit,
    resetAt: new Date(Date.now() + 60000),
    retryAfter: policy.access === 'readOnly' ? undefined : 30,
    limit: fallbackLimit,
    blockedBy: policy.access === 'readOnly' ? undefined : 'redis_unavailable',
    failureMode,
    degraded: true,
  };
}

export async function checkRateLimits(
  userId: string,
  ip: string,
  policy: RouteRateLimitPolicy,
  options: CheckRateLimitOptions = {}
): Promise<RateLimitResult> {
  const buckets = getBucketDefinitions(userId, ip, policy.type, options.botScore);

  try {
    const result = await evaluateCombinedBuckets(buckets);
    return {
      ...result,
      failureMode: 'normal',
      degraded: false,
    };
  } catch (error) {
    console.error('Rate limiter error:', error);
    return degradedResult(policy, policy.type);
  }
}
