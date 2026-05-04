import { jest } from '@jest/globals';
import { RateLimiter, checkRateLimits } from "../src/services/rateLimitService";
import { redis } from "../src/db/redis";

describe("Rate Limiter - Atomic Sliding Window", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter("test_rate_limit");
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await redis.flushdb();
  });

  test("allows requests within a single-bucket limit", async () => {
    const result = await limiter.check("user1", { limit: 5, window: 60 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.limit).toBe(5);
  });

  test("caps 100 concurrent requests on one hot key exactly at the configured limit", async () => {
    const limit = 7;
    const results = await Promise.all(
      Array.from({ length: 100 }, () => limiter.check("race_user", { limit, window: 60 }))
    );

    const allowedCount = results.filter((result) => result.allowed).length;
    expect(allowedCount).toBe(limit);
  });

  test("expires old requests in the sliding window", async () => {
    await limiter.check("user1", { limit: 2, window: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const result = await limiter.check("user1", { limit: 2, window: 1 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  test("combined route checks are atomic and do not partially consume earlier buckets", async () => {
    for (let index = 0; index < 3; index += 1) {
      await redis.zadd('rate_limit:pack_purchase:user:user-1:minute', Date.now(), `seed:${index}`);
    }
    await redis.pexpire('rate_limit:pack_purchase:user:user-1:minute', 61000);

    const result = await checkRateLimits('user-1', '10.0.0.1', {
      type: 'PACK_PURCHASE',
      access: 'writeProtected',
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('user:minute');

    const hourUsage = await redis.zcard('rate_limit:pack_purchase:user:user-1:hour');
    const dayUsage = await redis.zcard('rate_limit:pack_purchase:user:user-1:day');
    const ipMinuteUsage = await redis.zcard('rate_limit:pack_purchase:ip:10.0.0.1:minute');
    const ipHourUsage = await redis.zcard('rate_limit:pack_purchase:ip:10.0.0.1:hour');

    expect(hourUsage).toBe(0);
    expect(dayUsage).toBe(0);
    expect(ipMinuteUsage).toBe(0);
    expect(ipHourUsage).toBe(0);
  });

  test("retry-after comes from the earliest releasing blocked bucket", async () => {
    const now = Date.now();
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:minute', now - 59000, 'minute-oldest');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:minute', now - 58000, 'minute-2');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:minute', now - 57000, 'minute-3');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:minute', now - 56000, 'minute-4');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:minute', now - 55000, 'minute-5');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 1000, 'hour-1');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 2000, 'hour-2');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 3000, 'hour-3');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 4000, 'hour-4');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 5000, 'hour-5');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 6000, 'hour-6');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 7000, 'hour-7');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 8000, 'hour-8');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 9000, 'hour-9');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 10000, 'hour-10');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 11000, 'hour-11');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 12000, 'hour-12');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 13000, 'hour-13');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 14000, 'hour-14');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 15000, 'hour-15');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 16000, 'hour-16');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 17000, 'hour-17');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 18000, 'hour-18');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 19000, 'hour-19');
    await redis.zadd('rate_limit:auth:ip:10.0.0.2:hour', now - 20000, 'hour-20');

    const result = await checkRateLimits('anonymous', '10.0.0.2', {
      type: 'AUTH',
      access: 'writeProtected',
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('ip:minute');
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter).toBeLessThanOrEqual(2);
  });

  test("read-only routes degrade open when Redis is unavailable", async () => {
    jest.spyOn(redis, 'eval').mockRejectedValue(new Error("Redis connection failed"));

    const result = await checkRateLimits('user-1', '10.0.0.3', {
      type: 'API',
      access: 'readOnly',
    });

    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.failureMode).toBe('degraded-open');
  });

  test("purchase routes degrade closed when Redis is unavailable", async () => {
    jest.spyOn(redis, 'eval').mockRejectedValue(new Error("Redis connection failed"));

    const result = await checkRateLimits('user-1', '10.0.0.4', {
      type: 'PACK_PURCHASE',
      access: 'writeProtected',
    });

    expect(result.allowed).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.failureMode).toBe('degraded-closed');
    expect(result.blockedBy).toBe('redis_unavailable');
  });
});
