import request from "supertest";
import { createApp } from "../../src/app";
import { createTestDrop, queryAll, queryOne, resetTestData, seedCardPool } from "../helpers/db";
import { signupUser } from "../helpers/auth";
import { runConcurrent } from "../helpers/race";
import { buyPack } from "../../src/services/packService";

const app = createApp();
const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

describe("Pack drop concurrency", () => {
  beforeEach(async () => {
    await resetTestData();
    await seedCardPool();
  });

  test("exactly M users can buy when M inventory exists", async () => {
    const drop = await createTestDrop({ inventory: 5, price: "10.00", cardsPerPack: 3 });
    const users = await Promise.all(
      Array.from({ length: 20 }, (_, i) => signupUser(app, `pack-${i}`, { bypassHttp: true, accountAgeHours: 2 }))
    );

    const results = await runConcurrent(users.length, (i) =>
      request(app)
        .post("/packs/buy")
        .set("authorization", `Bearer ${users[i].token}`)
        .set("user-agent", browserUA)
        .set("x-forwarded-for", `203.0.113.${i + 1}`)
        .set("idempotency-key", `pack-race-${i}`)
        .send({ dropId: drop.id, idempotencyKey: `pack-race-${i}` })
    );

    const successes = results.filter(
      (r): r is PromiseFulfilledResult<any> =>
        r.status === "fulfilled" && r.value.status === 200
    );
    const nonSuccesses = results.filter(
      (r): r is PromiseFulfilledResult<any> =>
        r.status === "fulfilled" && r.value.status !== 200
    );

    expect(successes).toHaveLength(5);
    expect(nonSuccesses.length).toBeGreaterThanOrEqual(15);
    expect(
      nonSuccesses.every((r) => [202, 403, 409, 429].includes(r.value.status) || String(r.value.body?.error ?? "").toLowerCase().includes("sold out"))
    ).toBe(true);

    const dropRow = await queryOne<{ inventory: string }>("select inventory from drops where id=$1", [drop.id]);
    expect(Number(dropRow.inventory)).toBe(0);

    const purchases = await queryOne<{ count: string }>("select count(*)::text as count from pack_purchases where drop_id=$1", [drop.id]);
    expect(Number(purchases.count)).toBe(5);
  });

  test("concurrent idempotency prevents double-charge at service layer", async () => {
    const drop = await createTestDrop({ inventory: 1, price: "10.00", cardsPerPack: 3 });
    const user = await signupUser(app, "idem-service-user", { bypassHttp: true, accountAgeHours: 2 });
    const idemKey = "concurrent-idem-test";

    // Call the service layer directly, bypassing HTTP middleware (rate limiter, etc.)
    const [result1, result2] = await Promise.all([
      buyPack(user.userId, drop.id, idemKey),
      buyPack(user.userId, drop.id, idemKey),
    ]);

    // Both should return the same purchase (idempotency worked)
    expect(result1.purchase.id).toBe(result2.purchase.id);
    expect(result1.purchase.drop_id).toBe(drop.id);
    expect(result2.purchase.drop_id).toBe(drop.id);

    // Verify only one purchase was created
    const purchases = await queryOne<{ count: string }>(
      "select count(*)::text as count from pack_purchases where user_id=$1 and drop_id=$2",
      [user.userId, drop.id]
    );
    expect(Number(purchases.count)).toBe(1);

    // Verify only one charge
    const ledgers = await queryOne<{ count: string }>(
      "select count(*)::text as count from ledger where user_id=$1 and type='PACK_PURCHASE' and reference_id=$2",
      [user.userId, result1.purchase.id]
    );
    expect(Number(ledgers.count)).toBe(1);

    // Verify correct balance
    const balance = await queryOne<{ available_balance: string; total_balance: string }>(
      "select available_balance::text, total_balance::text from balances where user_id=$1",
      [user.userId]
    );
    expect(balance.available_balance).toBe("990.00");
    expect(balance.total_balance).toBe("990.00");
  });

  test("insufficient funds spam cannot overspend", async () => {
    const drop = await createTestDrop({ inventory: 10, price: "10.00", cardsPerPack: 3 });
    const user = await signupUser(app, "low-funds-user", { bypassHttp: true, accountAgeHours: 2 });

    const results = await runConcurrent(150, (i) =>
      request(app)
        .post("/packs/buy")
        .set("authorization", `Bearer ${user.token}`)
        .set("user-agent", browserUA)
        .set("x-forwarded-for", "203.0.113.210")
        .set("idempotency-key", `low-funds-${i}`)
        .send({ dropId: drop.id, idempotencyKey: `low-funds-${i}` })
    );

    const successCount = results.filter(
      (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value.status === 200
    ).length;

    expect(successCount).toBeLessThanOrEqual(10);

    const balance = await queryOne<{ available_balance: string; held_balance: string; total_balance: string }>(
      "select available_balance::text, held_balance::text, total_balance::text from balances where user_id=$1",
      [user.userId]
    );
    expect(Number(balance.available_balance)).toBeGreaterThanOrEqual(0);
    expect(Number(balance.held_balance)).toBeGreaterThanOrEqual(0);
    expect(Number(balance.total_balance)).toBeGreaterThanOrEqual(0);
    expect(Number(balance.available_balance) + Number(balance.held_balance)).toBeCloseTo(Number(balance.total_balance), 2);

    const userPurchases = await queryAll<{ id: string }>("select id from pack_purchases where user_id=$1", [user.userId]);
    expect(userPurchases.length).toBe(successCount);
  });
});
