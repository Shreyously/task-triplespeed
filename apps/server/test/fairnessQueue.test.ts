import { createHash, randomUUID } from "crypto";
import { FairnessQueue } from "../src/services/fairnessQueueService";
import { pool } from "../src/db/pool";
import { redis } from "../src/db/redis";

function deterministicOrder(dropId: string, windowId: string, participants: string[]): string[] {
  return [...participants].sort((left, right) => {
    const leftHash = createHash('sha256').update(`${dropId}:${windowId}:${left}`).digest('hex');
    const rightHash = createHash('sha256').update(`${dropId}:${windowId}:${right}`).digest('hex');
    return leftHash.localeCompare(rightHash);
  });
}

describe("Fairness Queue Service", () => {
  let queue: FairnessQueue;
  let testDropId: string;

  beforeAll(async () => {
    queue = new FairnessQueue();
    testDropId = randomUUID();

    await pool.query("DELETE FROM pack_purchases WHERE drop_id IN (SELECT id FROM drops WHERE tier = 'FairnessTestTier')");
    await pool.query("DELETE FROM drops WHERE tier = 'FairnessTestTier'");

    await pool.query(`
      INSERT INTO drops (id, tier, price, cards_per_pack, inventory, starts_at, ends_at, rarity_weights)
      VALUES ($1, 'FairnessTestTier', 5.00, 3, 100, NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '1 hour', '{"Common": 1}')
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

  test("opens a fairness window when pressure and contention are both present", async () => {
    await pool.query("UPDATE drops SET inventory = 1 WHERE id = $1", [testDropId]);

    for (let index = 0; index < 9; index += 1) {
      const userId = randomUUID();
      await pool.query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash') ON CONFLICT DO NOTHING",
        [userId, `fairness-activation-${index}-${userId}@test.com`]
      );
      await pool.query(
        "INSERT INTO pack_purchases (user_id, drop_id, price_paid, idempotency_key) VALUES ($1, $2, $3, $4)",
        [userId, testDropId, 5.00, `fairness-activation-key-${index}`]
      );
    }

    let activated = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      activated = await queue.shouldActivateFairnessMode(testDropId);
    }

    expect(activated).toBe(true);
  });

  test("collapses duplicate entries to one active record per user per drop window", async () => {
    await queue.ensureFairnessWindow(testDropId);

    const first = await queue.addToQueue({
      userId: "duplicate-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "same-key",
    });

    const second = await queue.addToQueue({
      userId: "duplicate-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "same-key",
    });

    expect(second.queuePosition).toBe(first.queuePosition);
    expect(await queue.getQueueSize(testDropId)).toBe(1);
  });

  test("selects deterministic winners for a given fairness window", async () => {
    await queue.ensureFairnessWindow(testDropId);

    const participants = Array.from({ length: 10 }, (_, index) => `user-${index}`);
    const queueResults = [];
    for (const userId of participants) {
      queueResults.push(await queue.addToQueue({
        userId,
        dropId: testDropId,
        timestamp: Date.now(),
        idempotencyKey: `key-${userId}`,
      }));
    }

    const windowId = queueResults[0].windowId!;
    const winners = await queue.processFairnessWindow(testDropId, 3, windowId);
    const expected = deterministicOrder(testDropId, windowId, participants).slice(0, 3);

    expect(winners).toEqual(expected);
  });

  test("100 simultaneous entries produce winners bounded by available inventory", async () => {
    await queue.ensureFairnessWindow(testDropId);

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => queue.addToQueue({
        userId: `race-user-${index}`,
        dropId: testDropId,
        timestamp: Date.now() + index,
        idempotencyKey: `key-${index}`,
      }))
    );

    const winners = await queue.processFairnessWindow(testDropId, 12, results[0].windowId);
    expect(winners).toHaveLength(12);
    expect(new Set(winners).size).toBe(12);
  });

  test("idempotent retries preserve queue and winner state", async () => {
    await queue.ensureFairnessWindow(testDropId);

    const queued = await queue.addToQueue({
      userId: "retry-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "retry-key",
    });

    const replay = await queue.addToQueue({
      userId: "retry-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "retry-key",
    });

    await queue.processFairnessWindow(testDropId, 1, queued.windowId);
    const status = await queue.checkQueueResult("retry-user", testDropId);

    expect(replay.queuePosition).toBe(queued.queuePosition);
    expect(status.windowId).toBe(queued.windowId);
  });

  test("winner claim is single-use and atomic", async () => {
    await queue.ensureFairnessWindow(testDropId);

    const queued = await queue.addToQueue({
      userId: "winner-user",
      dropId: testDropId,
      timestamp: Date.now(),
      idempotencyKey: "winner-key",
    });

    await queue.processFairnessWindow(testDropId, 1, queued.windowId);

    const claims = await Promise.all([
      queue.claimWinnerSlot("winner-user", testDropId),
      queue.claimWinnerSlot("winner-user", testDropId),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
