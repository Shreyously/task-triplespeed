import request from "supertest";
import { createApp } from "../../src/app";
import { createTestDrop, queryOne, resetTestData, seedCardPool } from "../helpers/db";
import { signupUser } from "../helpers/auth";

const app = createApp();
const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

describe("Auction bid concurrency", () => {
  beforeEach(async () => {
    await resetTestData();
    await seedCardPool();
  });

  test("simultaneous same-amount bids result in one highest winner", async () => {
    const drop = await createTestDrop({ inventory: 1, price: "10.00", cardsPerPack: 3 });
    const seller = await signupUser(app, "auction-seller", { bypassHttp: true, accountAgeHours: 2 });
    const bidderA = await signupUser(app, "auction-bidder-a", { bypassHttp: true, accountAgeHours: 2 });
    const bidderB = await signupUser(app, "auction-bidder-b", { bypassHttp: true, accountAgeHours: 2 });

    const packBuy = await request(app)
      .post("/packs/buy")
      .set("authorization", `Bearer ${seller.token}`)
      .set("user-agent", browserUA)
      .set("x-forwarded-for", "203.0.113.20")
      .set("idempotency-key", "seller-pack-auction")
      .send({ dropId: drop.id, idempotencyKey: "seller-pack-auction" });
    expect(packBuy.status).toBe(200);

    const card = await queryOne<{ id: string }>(
      "select id from cards where owner_id=$1 order by created_at asc limit 1",
      [seller.userId]
    );

    const auctionCreate = await request(app)
      .post("/auctions")
      .set("authorization", `Bearer ${seller.token}`)
      .send({ cardId: card.id, durationSeconds: 300 });
    expect(auctionCreate.status).toBe(200);

    const auctionId = auctionCreate.body.auction.id as string;

    const [bidA, bidB] = await Promise.all([
      request(app)
        .post(`/auctions/${auctionId}/bids`)
        .set("authorization", `Bearer ${bidderA.token}`)
        .set("user-agent", browserUA)
        .set("x-forwarded-for", "203.0.113.21")
        .set("idempotency-key", "bid-a-10")
        .send({ amount: "1.00", idempotencyKey: "bid-a-10" }),
      request(app)
        .post(`/auctions/${auctionId}/bids`)
        .set("authorization", `Bearer ${bidderB.token}`)
        .set("user-agent", browserUA)
        .set("x-forwarded-for", "203.0.113.22")
        .set("idempotency-key", "bid-b-10")
        .send({ amount: "1.00", idempotencyKey: "bid-b-10" })
    ]);

    const successCount = [bidA, bidB].filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const auctionRow = await queryOne<{ current_bid: string; highest_bidder_id: string | null }>(
      "select current_bid::text, highest_bidder_id from auctions where id=$1",
      [auctionId]
    );
    expect(auctionRow.current_bid).toBe("1.00");
    expect([bidderA.userId, bidderB.userId]).toContain(auctionRow.highest_bidder_id ?? "");
  });
});
