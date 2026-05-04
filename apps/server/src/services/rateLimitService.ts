import { redis } from "../db/redis";
import { RATE_LIMITS } from "../config/antibot";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number;
}

interface RateLimitConfig {
  limit: number;
  window: number;
}

export class RateLimiter {
  constructor(private prefix: string) {}

  async check(
    identifier: string,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const key = `${this.prefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - config.window * 1000;

    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window_start = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local window_ms = tonumber(ARGV[4])

      local unique_id = ARGV[5]

      redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
      local count = redis.call('ZCARD', key)

      if count < limit then
        redis.call('ZADD', key, now, now .. '-' .. unique_id)
        redis.call('EXPIRE', key, math.ceil(window_ms / 1000) + 1)
        return {count + 1, limit - count - 1, 0}
      else
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local retry_after = oldest[2] and math.ceil((oldest[2] + window_ms - now) / 1000) or 1
        return {count, -1, retry_after}
      end
    `;

    const uniqueId = Math.random().toString(36).substring(2, 15);

    try {
      const result = await redis.eval(
        script,
        1,
        key,
        now,
        windowStart,
        config.limit,
        config.window * 1000,
        uniqueId
      ) as [number, number, number];

      const [count, remaining, retryAfter] = result;

      return {
        allowed: remaining >= 0,
        remaining: Math.max(0, remaining),
        resetAt: new Date(now + config.window * 1000),
        retryAfter: retryAfter > 0 ? retryAfter : undefined,
      };
    } catch (error) {
      console.error('Rate limiter error:', error);
      return {
        allowed: true,
        remaining: config.limit,
        resetAt: new Date(now + config.window * 1000),
      };
    }
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

export const apiRateLimiter = new RateLimiter('rate_limit:api');
export const packPurchaseRateLimiter = new RateLimiter('rate_limit:pack_purchase');
export const authRateLimiter = new RateLimiter('rate_limit:auth');
export const marketplaceRateLimiter = new RateLimiter('rate_limit:marketplace');

export async function checkRateLimits(
  userId: string,
  ip: string,
  type: keyof typeof RATE_LIMITS
): Promise<RateLimitResult> {
  switch (type) {
    case 'PACK_PURCHASE': {
      const configs = RATE_LIMITS['PACK_PURCHASE'];

      const userMinuteCheck = await packPurchaseRateLimiter.check(
        `user:${userId}:minute`,
        { limit: configs.perUserPerMinute, window: 60 }
      );

      if (!userMinuteCheck.allowed) {
        return userMinuteCheck;
      }

      const userHourCheck = await packPurchaseRateLimiter.check(
        `user:${userId}:hour`,
        { limit: configs.perUserPerHour, window: 3600 }
      );

      if (!userHourCheck.allowed) {
        return userHourCheck;
      }

      const userDayCheck = await packPurchaseRateLimiter.check(
        `user:${userId}:day`,
        { limit: configs.perUserPerDay, window: 86400 }
      );

      if (!userDayCheck.allowed) {
        return userDayCheck;
      }

      const ipMinuteCheck = await packPurchaseRateLimiter.check(
        `ip:${ip}:minute`,
        { limit: configs.perIPPerMinute, window: 60 }
      );

      if (!ipMinuteCheck.allowed) {
        return ipMinuteCheck;
      }

      const ipHourCheck = await packPurchaseRateLimiter.check(
        `ip:${ip}:hour`,
        { limit: configs.perIPPerHour, window: 3600 }
      );

      return ipHourCheck;
    }

    case 'AUTH': {
      const configs = RATE_LIMITS['AUTH'];
      const ipMinuteCheck = await authRateLimiter.check(
        `ip:${ip}:minute`,
        { limit: configs.perIPPerMinute, window: 60 }
      );

      if (!ipMinuteCheck.allowed) {
        return ipMinuteCheck;
      }

      return authRateLimiter.check(
        `ip:${ip}:hour`,
        { limit: configs.perIPPerHour, window: 3600 }
      );
    }

    case 'API': {
      const configs = RATE_LIMITS['API'];
      const userCheck = await apiRateLimiter.check(
        `user:${userId}`,
        { limit: configs.perUserPerMinute, window: 60 }
      );

      if (!userCheck.allowed) {
        return userCheck;
      }

      return apiRateLimiter.check(
        `ip:${ip}`,
        { limit: configs.perIPPerMinute, window: 60 }
      );
    }

    case 'MARKETPLACE': {
      const configs = RATE_LIMITS['MARKETPLACE'];
      const userCheck = await marketplaceRateLimiter.check(
        `user:${userId}`,
        { limit: configs.perUserPerHour, window: 3600 }
      );

      if (!userCheck.allowed) {
        return userCheck;
      }

      return marketplaceRateLimiter.check(
        `ip:${ip}`,
        { limit: configs.perIPPerHour, window: 3600 }
      );
    }

    default:
      return {
        allowed: true,
        remaining: 100,
        resetAt: new Date(Date.now() + 60000),
      };
  }
}
