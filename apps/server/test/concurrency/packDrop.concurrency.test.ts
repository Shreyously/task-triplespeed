import request from "supertest";
import { createApp } from "../../src/app";
import { createTestDrop, queryAll, queryOne, resetTestData, seedCardPool } from "../helpers/db";
import { signupUser } from "../helpers/auth";
import { runConcurrent } from "../helpers/race";

const app = createApp();

describe("Pack drop concurrency", () => {
  beforeEach(async () => {
    await resetTestData();
    await seedCardPool();
  });

  test("exactly M users can buy when M inventory exists", async () => {
    const drop = await createTestDrop({ inventory: 5, price: "10.00", cardsPerPack: 3 });
    const users = await Promise.all(Array.from({ length: 20 }, (_, i) => signupUser(app, `pack-${i}`)));

    const results = await runConcurrent(users.length, (i) =>
      request(app)
        .post("/packs/buy")
        .set("authorization", `Bearer ${users[i].token}`)
        .set("idempotency-key", `pack-race-${i}`)
        .send({ dropId: drop.id, idempotencyKey: `pack-race-${i}` })
    );

    const successes = results.filter(
      (r): r is PromiseFulfilledResult<any> =>
        r.status === "fulfilled" && r.value.status === 200
    );
    const soldOut = results.filter(
      (r): r is PromiseFulfilledResult<any> =>
        r.status === "fulfilled" && r.value.status >= 400 && String(r.value.body?.error ?? "").toLowerCase().includes("sold out")
    );

    expect(successes).toHaveLength(5);
    expect(soldOut.length).toBeGreaterThanOrEqual(15);

    const dropRow = await queryOne<{ inventory: string }>("select inventory from drops where id=$1", [drop.id]);
    expect(Number(dropRow.inventory)).toBe(0);

    const purchases = await queryOne<{ count: string }>("select count(*)::text as count from pack_purchases where drop_id=$1", [drop.id]);
    expect(Number(purchases.count)).toBe(5);
  });

  test("no charge without purchase and idempotency replay does not double-charge", async () => {
    const drop = await createTestDrop({ inventory: 1, price: "10.00", cardsPerPack: 3 });
    const user = await signupUser(app, "idem-user");
    const idemKey = "same-idem-key";

    const [first, replay] = await Promise.all([
      request(app)
        .post("/packs/buy")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", idemKey)
        .send({ dropId: drop.id, idempotencyKey: idemKey }),
      request(app)
        .post("/packs/buy")
        .set("authorization", `Bearer ${user.token}`)
        .set("idempotency-key", idemKey)
        .send({ dropId: drop.id, idempotencyKey: idemKey })
    ]);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.purchase.id).toBe(first.body.purchase.id);

    const purchases = await queryOne<{ count: string }>(
      "select count(*)::text as count from pack_purchases where user_id=$1 and drop_id=$2",
      [user.userId, drop.id]
    );
    expect(Number(purchases.count)).toBe(1);

    const ledgers = await queryOne<{ count: string }>(
      "select count(*)::text as count from ledger where user_id=$1 and type='PACK_PURCHASE' and reference_id=$2",
      [user.userId, first.body.purchase.id]
    );
    expect(Number(ledgers.count)).toBe(1);

    const balance = await queryOne<{ available_balance: string; held_balance: string; total_balance: string }>(
      "select available_balance::text, held_balance::text, total_balance::text from balances where user_id=$1",
      [user.userId]
    );
    expect(balance.available_balance).toBe("990.00");
    expect(balance.held_balance).toBe("0.00");
    expect(balance.total_balance).toBe("990.00");
  });

  test("insufficient funds spam cannot overspend", async () => {
    const drop = await createTestDrop({ inventory: 10, price: "10.00", cardsPerPack: 3 });
    const user = await signupUser(app, "low-funds-user");

    const results = await runConcurrent(150, (i) =>
      request(app)
        .post("/packs/buy")
        .set("authorization", `Bearer ${user.token}`)
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
