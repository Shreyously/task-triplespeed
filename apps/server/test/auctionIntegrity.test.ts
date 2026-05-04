import request from "supertest";
import { createApp } from "../src/app";
import { queryOne, resetTestData, seedCardPool, withClient } from "./helpers/db";
import { signupUser } from "./helpers/auth";

const app = createApp();

async function createAuctionFixture() {
  const seller = await signupUser(app, "integrity-seller");
  const card = await withClient(async (client) => {
    const inserted = await client.query(
      `insert into cards(owner_id, name, set_name, rarity, image_url, market_value, acquisition_value)
       values($1,'Test Dragon','Spec Set','Rare','https://img.example/test-dragon.png',25.00,25.00)
       returning id`,
      [seller.userId]
    );
    await client.query(
      "insert into card_market_state(card_id, state) values($1, 'NONE')",
      [inserted.rows[0].id]
    );
    return inserted.rows[0] as { id: string };
  });

  const cardRow = await queryOne<{ id: string }>(
    "select id from cards where id=$1",
    [card.id]
  );

  const auctionCreate = await request(app)
    .post("/auctions")
    .set("authorization", `Bearer ${seller.token}`)
    .send({ cardId: cardRow.id, durationSeconds: 300 });
  expect(auctionCreate.status).toBe(200);

  return {
    seller,
    auctionId: auctionCreate.body.auction.id as string
  };
}

describe("Auction integrity", () => {
  beforeEach(async () => {
    await resetTestData();
    await seedCardPool();
  });

  test("snapshot promotes auction into sealed endgame near threshold", async () => {
    const { auctionId } = await createAuctionFixture();
    const bidder = await signupUser(app, "sealed-threshold-bidder");

    await withClient((client) =>
      client.query("update auctions set end_time = now() + interval '5 seconds' where id=$1", [auctionId])
    );

    const snapshot = await request(app)
      .get(`/auctions/${auctionId}/snapshot`)
      .set("authorization", `Bearer ${bidder.token}`);

    expect(snapshot.status).toBe(200);
    expect(snapshot.body.auction.status).toBe("SEALED_ENDGAME");
    expect(snapshot.body.auction.bidding_mode).toBe("SEALED");
  });

  test("sealedBid_winner_pays_second_price", async () => {
    const { auctionId } = await createAuctionFixture();
    const alice = await signupUser(app, "sealed-alice");
    const bob = await signupUser(app, "sealed-bob");

    await withClient((client) =>
      client.query("update auctions set end_time = now() + interval '5 seconds' where id=$1", [auctionId])
    );

    const aliceBid = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${alice.token}`)
      .set("idempotency-key", "alice-sealed-100")
      .send({ amount: "100.00", idempotencyKey: "alice-sealed-100", confirmHighBid: true });
    expect(aliceBid.status).toBe(200);
    expect(aliceBid.body.mode).toBe("SEALED");

    const bobBid = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${bob.token}`)
      .set("idempotency-key", "bob-sealed-80")
      .send({ amount: "80.00", idempotencyKey: "bob-sealed-80", confirmHighBid: true });
    expect(bobBid.status).toBe(200);

    await withClient((client) =>
      client.query("update auctions set end_time = now() - interval '1 second' where id=$1", [auctionId])
    );

    const settle = await request(app).post("/workers/settlement/tick");
    expect(settle.status).toBe(200);

    const settlement = await queryOne<{
      winner_id: string;
      gross_amount: string;
      winning_max_bid: string;
      final_clearing_price: string;
    }>(
      "select winner_id, gross_amount::text, winning_max_bid::text, final_clearing_price::text from auction_settlements where auction_id=$1",
      [auctionId]
    );

    expect(settlement.winner_id).toBe(alice.userId);
    expect(settlement.winning_max_bid).toBe("100.00");
    expect(settlement.final_clearing_price).toBe("84.00");
    expect(settlement.gross_amount).toBe("84.00");

    const aliceBalance = await queryOne<{ available_balance: string; held_balance: string; total_balance: string }>(
      "select available_balance::text, held_balance::text, total_balance::text from balances where user_id=$1",
      [alice.userId]
    );
    const bobBalance = await queryOne<{ available_balance: string; held_balance: string; total_balance: string }>(
      "select available_balance::text, held_balance::text, total_balance::text from balances where user_id=$1",
      [bob.userId]
    );

    expect(aliceBalance.available_balance).toBe("916.00");
    expect(aliceBalance.held_balance).toBe("0.00");
    expect(aliceBalance.total_balance).toBe("916.00");
    expect(bobBalance.available_balance).toBe("1000.00");
    expect(bobBalance.held_balance).toBe("0.00");
  });

  test("sealed bid replacement updates held amount atomically", async () => {
    const { auctionId } = await createAuctionFixture();
    const bidder = await signupUser(app, "sealed-replace");

    await withClient((client) =>
      client.query("update auctions set end_time = now() + interval '5 seconds' where id=$1", [auctionId])
    );

    const firstBid = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${bidder.token}`)
      .set("idempotency-key", "sealed-100")
      .send({ amount: "100.00", idempotencyKey: "sealed-100", confirmHighBid: true });
    expect(firstBid.status).toBe(200);

    let balance = await queryOne<{ available_balance: string; held_balance: string }>(
      "select available_balance::text, held_balance::text from balances where user_id=$1",
      [bidder.userId]
    );
    expect(balance.available_balance).toBe("900.00");
    expect(balance.held_balance).toBe("100.00");

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const secondBid = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${bidder.token}`)
      .set("idempotency-key", "sealed-70")
      .send({ amount: "70.00", idempotencyKey: "sealed-70", confirmHighBid: true });
    expect(secondBid.status).toBe(200);

    balance = await queryOne<{ available_balance: string; held_balance: string }>(
      "select available_balance::text, held_balance::text from balances where user_id=$1",
      [bidder.userId]
    );
    expect(balance.available_balance).toBe("930.00");
    expect(balance.held_balance).toBe("70.00");

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const thirdBid = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${bidder.token}`)
      .set("idempotency-key", "sealed-120")
      .send({ amount: "120.00", idempotencyKey: "sealed-120", confirmHighBid: true });
    expect(thirdBid.status).toBe(200);

    balance = await queryOne<{ available_balance: string; held_balance: string }>(
      "select available_balance::text, held_balance::text from balances where user_id=$1",
      [bidder.userId]
    );
    expect(balance.available_balance).toBe("880.00");
    expect(balance.held_balance).toBe("120.00");
  });

  test("seller cannot self bid", async () => {
    const { auctionId, seller } = await createAuctionFixture();
    const response = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${seller.token}`)
      .set("idempotency-key", "self-bid")
      .send({ amount: "1.00", idempotencyKey: "self-bid" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Seller cannot bid");
  });

  test("open bidding is paced to block rapid-fire micro-bids", async () => {
    const { auctionId } = await createAuctionFixture();
    const bidder = await signupUser(app, "rapid-bidder");

    const snapshot = await request(app)
      .get(`/auctions/${auctionId}/snapshot`)
      .set("authorization", `Bearer ${bidder.token}`);

    expect(snapshot.status).toBe(200);

    const firstAmount = snapshot.body.minimumBid as string;
    const secondAmount = String(Number(firstAmount) + 1);

    const firstBid = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${bidder.token}`)
      .set("idempotency-key", "rapid-01")
      .send({ amount: firstAmount, idempotencyKey: "rapid-01" });

    expect(firstBid.status).toBe(200);

    const secondBid = await request(app)
      .post(`/auctions/${auctionId}/bids`)
      .set("authorization", `Bearer ${bidder.token}`)
      .set("idempotency-key", "rapid-02")
      .send({ amount: secondAmount, idempotencyKey: "rapid-02" });


    expect(secondBid.status).toBe(400);
    expect(secondBid.body.error).toMatch(/cooldown|pacing/i);
  });

});
