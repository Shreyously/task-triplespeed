import request from "supertest";
import { createApp } from "../../src/app";
import { createTestDrop, queryOne, resetTestData, seedCardPool } from "../helpers/db";
import { signupUser } from "../helpers/auth";

const app = createApp();

describe("Marketplace concurrency", () => {
  beforeEach(async () => {
    await resetTestData();
    await seedCardPool();
  });

  test("same listing cannot be bought twice concurrently", async () => {
    const drop = await createTestDrop({ inventory: 1, price: "10.00", cardsPerPack: 3 });
    const seller = await signupUser(app, "seller");
    const buyerA = await signupUser(app, "buyer-a");
    const buyerB = await signupUser(app, "buyer-b");

    const packBuy = await request(app)
      .post("/packs/buy")
      .set("authorization", `Bearer ${seller.token}`)
      .set("idempotency-key", "seller-pack")
      .send({ dropId: drop.id, idempotencyKey: "seller-pack" });
    expect(packBuy.status).toBe(200);

    const card = await queryOne<{ id: string }>(
      "select id from cards where owner_id=$1 order by created_at asc limit 1",
      [seller.userId]
    );

    const listingRes = await request(app)
      .post("/listings")
      .set("authorization", `Bearer ${seller.token}`)
      .send({ cardId: card.id, price: "25.00" });
    expect(listingRes.status).toBe(200);
    const listingId = listingRes.body.listing.id as string;

    const [buyA, buyB] = await Promise.all([
      request(app)
        .post(`/listings/${listingId}/buy`)
        .set("authorization", `Bearer ${buyerA.token}`)
        .set("idempotency-key", "buyer-a-buy")
        .send({ idempotencyKey: "buyer-a-buy" }),
      request(app)
        .post(`/listings/${listingId}/buy`)
        .set("authorization", `Bearer ${buyerB.token}`)
        .set("idempotency-key", "buyer-b-buy")
        .send({ idempotencyKey: "buyer-b-buy" })
    ]);

    const successCount = [buyA, buyB].filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const listing = await queryOne<{ status: string }>("select status from listings where id=$1", [listingId]);
    expect(listing.status).toBe("SOLD");

    const owner = await queryOne<{ owner_id: string }>("select owner_id from cards where id=$1", [card.id]);
    expect([buyerA.userId, buyerB.userId]).toContain(owner.owner_id);
  });
});
