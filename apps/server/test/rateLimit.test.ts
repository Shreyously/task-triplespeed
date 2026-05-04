import { jest } from '@jest/globals';
import { RateLimiter } from "../src/services/rateLimitService";
import { redis } from "../src/db/redis";

describe("Rate Limiter - Concurrency Tests", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter("test_rate_limit");
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  test("should allow requests within limit", async () => {
    const result = await limiter.check("user1", { limit: 5, window: 60 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  test("should block requests over limit", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("user1", { limit: 5, window: 60 });
    }

    const result = await limiter.check("user1", { limit: 5, window: 60 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("should handle concurrent requests safely", async () => {
    const concurrentRequests = 100;
    const limit = 50;

    const promises = Array.from({ length: concurrentRequests }, (_, i) =>
      limiter.check(`user${i % 10}`, { limit, window: 60 })
    );

    const results = await Promise.all(promises);

    const allowedCount = results.filter(r => r.allowed).length;
    expect(allowedCount).toBeLessThanOrEqual(limit * 10);
  });

  test("should expire old requests in sliding window", async () => {
    const now = Date.now();

    await limiter.check("user1", { limit: 2, window: 1 });

    await new Promise(resolve => setTimeout(resolve, 1100));

    const result = await limiter.check("user1", { limit: 2, window: 1 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  test("should handle race conditions correctly", async () => {
    const promises = Array.from({ length: 10 }, () =>
      limiter.check("race_user", { limit: 5, window: 60 })
    );

    const results = await Promise.all(promises);

    const allowedCount = results.filter(r => r.allowed).length;
    expect(allowedCount).toBe(5);
  });

  test("should provide accurate retry-after time", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("user1", { limit: 5, window: 60 });
    }

    const result = await limiter.check("user1", { limit: 5, window: 60 });
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("should reset user limits", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("user1", { limit: 5, window: 60 });
    }

    await limiter.reset("user1");

    const result = await limiter.check("user1", { limit: 5, window: 60 });
    expect(result.allowed).toBe(true);
  });

  test("should track multiple users independently", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check("user1", { limit: 5, window: 60 });
    }

    const result2 = await limiter.check("user2", { limit: 5, window: 60 });
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(4);
  });

  test("should get current usage", async () => {
    await limiter.check("user1", { limit: 10, window: 60 });
    await limiter.check("user1", { limit: 10, window: 60 });
    await limiter.check("user1", { limit: 10, window: 60 });

    const usage = await limiter.getUsage("user1");
    expect(usage).toBe(3);
  });

  test("should handle Redis failures gracefully", async () => {
    const spy = jest.spyOn(redis, 'eval').mockRejectedValue(new Error("Redis connection failed"));

    const failingLimiter = new RateLimiter("failing_test");

    const result = await failingLimiter.check("user1", { limit: 5, window: 60 });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);

    spy.mockRestore();
  });
});