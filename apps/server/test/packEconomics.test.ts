import { allocateGreedy, applyDeltaCap, getMarketAverages, projectWeightsToConstraints } from "../src/services/packEconomicsService";
import { estimateStablePoolCardValue, getPoolMarketCards } from "../src/services/packMarketDataService";
import { simulateTier, simulateAllTiers } from "../src/services/packSimulationService";
import { config } from "../src/config/env";
import { PACK_ECONOMICS } from "../src/config/packEconomics";
import { createTestDrop, resetTestData, seedCardPool, withClient } from "./helpers/db";

describe("Pack economics hardening", () => {
  beforeEach(async () => {
    await resetTestData();
    await seedCardPool();
  });

  test("greedy endpoint allocation stays within bounds and sums to one", () => {
    const weights = allocateGreedy([
      { rarity: "Common", avg: 0.2, stddev: 0, count: 10 },
      { rarity: "Uncommon", avg: 1, stddev: 0, count: 10 },
      { rarity: "Rare", avg: 5, stddev: 0, count: 10 },
      { rarity: "Holo Rare", avg: 20, stddev: 0, count: 10 },
      { rarity: "Ultra Rare/EX/GX", avg: 80, stddev: 0, count: 10 },
      { rarity: "Secret Rare", avg: 250, stddev: 0, count: 10 },
    ]);

    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    expect(weights.Common).toBeLessThanOrEqual(0.85);
    expect(weights.Common).toBeGreaterThanOrEqual(0.15);
    expect(weights["Secret Rare"]).toBeGreaterThanOrEqual(0.002);
  });

  test("delta-cap projection preserves max per-rarity movement", () => {
    const candidate = {
      Common: 0.1,
      Uncommon: 0.1,
      Rare: 0.1,
      "Holo Rare": 0.2,
      "Ultra Rare/EX/GX": 0.2,
      "Secret Rare": 0.3,
    };
    const current = {
      Common: 0.72,
      Uncommon: 0.22,
      Rare: 0.05,
      "Holo Rare": 0.01,
      "Ultra Rare/EX/GX": 0,
      "Secret Rare": 0,
    };

    const { weights, capped } = applyDeltaCap(candidate, current);

    expect(capped).toBe(true);
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    for (const rarity of Object.keys(current) as Array<keyof typeof current>) {
      expect(Math.abs((weights[rarity] ?? 0) - current[rarity])).toBeLessThanOrEqual(0.08 + 1e-6);
    }
  });

  test("market averages are derived from the full pack pool, not only opened cards", async () => {
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO cards(owner_id, name, set_name, rarity, image_url, market_value, acquisition_value)
         VALUES
         ($1, 'Only Opened Common', 'Base Set', 'Common', 'https://img.example/common.png', 999.99, 999.99),
         ($1, 'Only Opened Rare', 'Base Set', 'Rare', 'https://img.example/rare.png', 50.00, 50.00)`,
        [config.platformUserId]
      );
    });

    const averages = await withClient((client) => getMarketAverages(client));
    const rarities = averages.map((average) => average.rarity);

    expect(rarities).toEqual(
      expect.arrayContaining(["Common", "Uncommon", "Rare", "Holo Rare", "Ultra Rare/EX/GX", "Secret Rare"])
    );
    expect(averages.every((average) => average.count >= 1)).toBe(true);
  });

  test("simulation samples pool-based rarity values instead of falling back to opened commons", async () => {
    const drop = await createTestDrop({
      tier: "Elite",
      price: "40.00",
      cardsPerPack: 1,
      rarityWeights: { "Secret Rare": 1 },
    });
    expect(drop.tier).toBe("Elite");

    await withClient(async (client) => {
      const { rows } = await client.query("select id from users order by created_at asc limit 1");
      const ownerId = rows[0].id as string;
      await client.query(
        `INSERT INTO cards(owner_id, name, set_name, rarity, image_url, market_value, acquisition_value)
         VALUES ($1, 'Opened Common Anchor', 'Base Set', 'Common', 'https://img.example/common-anchor.png', 999.99, 999.99)`,
        [ownerId]
      );
    });

    const expectedSecretValue = estimateStablePoolCardValue({
      name: "Rayquaza Gold",
      setName: "Evolving Skies",
      rarity: "Secret Rare",
      imageUrl: "https://img.example/rayquaza.png",
    });

    const simulation = await withClient((client) => simulateTier(client, "Elite", { "Secret Rare": 1 }, 200));

    expect(simulation.meanPackValue).toBeCloseTo(expectedSecretValue, 1);
    expect(simulation.meanPackValue).toBeLessThan(900);
  });

  test("applyDeltaCap handles new rarities without inverted intervals", () => {
    const candidate = {
      Common: 0.70,
      Uncommon: 0.20,
      Rare: 0.10,
      "Holo Rare": 0.0,
    };
    const current = {
      Common: 0.72,
      Uncommon: 0.22,
      Rare: 0.05,
    };

    const { weights } = applyDeltaCap(candidate, current);

    expect(Object.values(weights).reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 6);
    expect(weights["Holo Rare"]).toBeGreaterThanOrEqual(0.01);
    expect(weights["Holo Rare"]).toBeLessThanOrEqual(0.25);
  });

  test("projectWeightsToConstraints respects bounds during redistribution", () => {
    const target = {
      Common: 0.90,
      Uncommon: 0.10,
    };
    const constraints = {
      Common: { min: 0.15, max: 0.85 },
      Uncommon: { min: 0.08, max: 0.50 },
    };

    const weights = projectWeightsToConstraints(target, constraints);

    expect(weights.Common).toBeLessThanOrEqual(0.85 + 1e-9);
    expect(weights.Common).toBeGreaterThanOrEqual(0.15 - 1e-9);
    expect(weights.Uncommon).toBeLessThanOrEqual(0.50 + 1e-9);
    expect(weights.Uncommon).toBeGreaterThanOrEqual(0.08 - 1e-9);
  });

  test("Basic tier uses lower win-rate floor (15% vs 25%)", () => {
    const basicTierTargets = PACK_ECONOMICS.TIER_TARGETS["Basic"];
    const proTierTargets = PACK_ECONOMICS.TIER_TARGETS["Pro"];

    expect(basicTierTargets.winRateFloor).toBe(0.15);
    expect(proTierTargets.winRateFloor).toBe(0.25);
  });

  test("getPoolMarketCards works without client parameter", async () => {
    const cards = await getPoolMarketCards();

    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.marketValue > 0)).toBe(true);
  });

  test("simulateAllTiers handles concurrent simulations safely", async () => {
    // Create drops for all tiers before testing
    await withClient(async (client) => {
      await createTestDrop({
        tier: "Basic",
        price: "5.00",
        cardsPerPack: 3,
        rarityWeights: { Common: 1 },
      });
      await createTestDrop({
        tier: "Pro",
        price: "15.00",
        cardsPerPack: 5,
        rarityWeights: { Common: 1 },
      });
      await createTestDrop({
        tier: "Elite",
        price: "40.00",
        cardsPerPack: 7,
        rarityWeights: { Common: 1 },
      });
    });

    const results = await simulateAllTiers();

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.meanPackValue > 0)).toBe(true);
    expect(results.every((r) => r.winRate >= 0 && r.winRate <= 1)).toBe(true);
  });
});
