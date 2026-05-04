import { jest } from '@jest/globals';
import { FairnessQueue } from "../src/services/fairnessQueueService";
import { pool, withTx } from "../src/db/pool";
import { redis } from "../src/db/redis";
import { FAIRNESS_CONFIG } from "../src/config/antibot";
import { randomUUID } from "crypto";

describe("Fairness Queue Service", () => {
  let queue: FairnessQueue;
  let testDropId: string;
  let testUserId: string;

  beforeAll(async () => {
    queue = new FairnessQueue();
    testDropId = randomUUID();
    testUserId = randomUUID();

    await pool.query("DELETE FROM pack_purchases WHERE drop_id IN (SELECT id FROM drops WHERE tier = 'FairnessTestTier')");
    await pool.query("DELETE FROM drops WHERE tier = 'FairnessTestTier'");

    await pool.query(`
      INSERT INTO drops (id, tier, price, cards_per_pack, inventory, starts_at, ends_at, rarity_weights)
      VALUES ($1, 'FairnessTestTier', 5.00, 3, 100, NOW(), NOW() + INTERVAL '1 hour', '{"Common": 1}')
    `, [testDropId]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM pack_purchases WHERE drop_id = $1", [testDropId]);
    await pool.query("DELETE FROM drops WHERE id = $1", [testDropId]);
    await redis.flushdb();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterEach(async () => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("should add user to fairness queue", async () => {
    await pool.query("UPDATE drops SET inventory = 10, starts_at = NOW() - INTERVAL '15 minutes' WHERE id = $1", [testDropId]);
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');

    const result = await queue.addToQueue({
      userId: testUserId,
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "test-key-1",
    });

    expect(result.status).toBe("FAIRNESS_MODE");
    expect(result.message).toContain("Added to fairness queue");
  });

  test("should handle fairness mode activation", async () => {
    await pool.query("UPDATE drops SET inventory = 1, starts_at = NOW() - INTERVAL '15 minutes' WHERE id = $1", [testDropId]);
    for (let i = 0; i < 9; i++) {
        const u = randomUUID();
        await pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash') ON CONFLICT DO NOTHING", [u, `test${i}-${u}@test.com`]);
        await pool.query("INSERT INTO pack_purchases (user_id, drop_id, price_paid, idempotency_key) VALUES ($1, $2, $3, $4)", [u, testDropId, 5.00, `test-activation-key-${i}`]);
    }

    const shouldActivate = await queue.shouldActivateFairnessMode(testDropId);
    expect(shouldActivate).toBe(true);
  });

  test("should process fairness window and select winners", async () => {
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');
    const users = Array.from({ length: 20 }, (_, i) => `user-${i}`);

    for (const userId of users) {
      await queue.addToQueue({
        userId,
        dropId: testDropId,
        timestamp: Date.now(),
        idempotencyKey: `key-${userId}`,
      });
    }

    const winners = await queue.processFairnessWindow(testDropId, 5);

    expect(winners).toHaveLength(5);
    expect(new Set(winners).size).toBe(5);
  });

  test("should give queue position to participants", async () => {
    await pool.query("UPDATE drops SET inventory = 5 WHERE id = $1", [testDropId]);
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');

    const user1 = await queue.addToQueue({
      userId: "user-1",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "key-1",
    });

    const user2 = await queue.addToQueue({
      userId: "user-2",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "key-2",
    });

    expect(user1.queuePosition).toBeDefined();
    expect(user2.queuePosition).toBeDefined();
    expect(user2.queuePosition).toBeGreaterThan(user1.queuePosition!);
  });

  test("should handle duplicate queue entries", async () => {
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');

    await queue.addToQueue({
      userId: "duplicate-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "key-duplicate",
    });

    const result = await queue.addToQueue({
      userId: "duplicate-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "key-duplicate",
    });

    expect(result.message).toContain("Already in fairness queue");
  });

  test("should check queue results correctly", async () => {
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');
    const userId = "result-user";

    await queue.addToQueue({
      userId,
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "key-result",
    });

    const winners = await queue.processFairnessWindow(testDropId, 1);

    const result = await queue.checkQueueResult(userId, testDropId);

    expect(result.winner).toBeDefined();
    if (result.winner) {
      expect(result.winner).toBe(winners.includes(userId));
    }
  });

  test("should return queue size", async () => {
    await redis.flushdb();
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');

    for (let i = 0; i < 5; i++) {
      await queue.addToQueue({
        userId: `size-user-${i}`,
        dropId: testDropId,
        timestamp: Date.now(),
        idempotencyKey: `key-size-${i}`,
      });
    }

    const size = await queue.getQueueSize(testDropId);
    expect(size).toBe(5);
  });

  test("should handle everyone winning scenario", async () => {
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');
    const users = [`winner-${Date.now()}-1`, `winner-${Date.now()}-2`, `winner-${Date.now()}-3`];

    for (const userId of users) {
      await queue.addToQueue({
        userId,
        dropId: testDropId,
        timestamp: Date.now(),
        idempotencyKey: `key-${userId}`,
      });
    }

    const winners = await queue.processFairnessWindow(testDropId, 10);

    expect(winners).toHaveLength(3);
    expect(winners).toContain(users[0]);
    expect(winners).toContain(users[1]);
    expect(winners).toContain(users[2]);
  });

  test("should cleanup queue after processing", async () => {
    jest.useFakeTimers();

    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');

    await queue.addToQueue({
      userId: "cleanup-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "key-cleanup",
    });

    await queue.processFairnessWindow(testDropId, 1);

    await jest.advanceTimersByTimeAsync(61000);

    const size = await queue.getQueueSize(testDropId);
    expect(size).toBe(0);
  });

  test("should handle edge case with no participants", async () => {
    const winners = await queue.processFairnessWindow(testDropId, 5);
    expect(winners).toHaveLength(0);
  });

  test("should handle race conditions in queue addition", async () => {
    await queue['setFairnessStatus'](testDropId, 'FAIRNESS_MODE');

    const promises = Array.from({ length: 50 }, (_, i) =>
      queue.addToQueue({
        userId: `race-user-${i}`,
        dropId: testDropId,
        timestamp: Date.now(),
        idempotencyKey: `key-race-${i}`,
      })
    );

    const results = await Promise.all(promises);

    results.forEach(result => {
      expect(result).toBeDefined();
      expect(['NORMAL', 'FAIRNESS_MODE']).toContain(result.status);
    });

    const size = await queue.getQueueSize(testDropId);
    expect(size).toBe(50);
  });
});
