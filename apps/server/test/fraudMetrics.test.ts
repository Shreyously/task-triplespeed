import { buildEconomicAlerts } from "../src/repositories/analyticsRepository";

describe("economic alert thresholds", () => {
  test("triggers critical when margin is 8pp below target", () => {
    const alerts = buildEconomicAlerts({
      trailingRevenue24h: "100.00",
      projectedRevenueDaily: "100.00",
      projectedRevenue30d: "3000.00",
      tiers: [
        {
          tier: "Basic",
          salesCount24h: 10,
          revenue24h: "100.00",
          realizedCogs24h: "90.00",
          realizedMargin24h: 0.12,
          targetMargin: 0.2,
          marginDeltaFromTarget: -0.08
        }
      ]
    });

    expect(alerts.some((a) => a.level === "CRITICAL")).toBe(true);
  });

  test("triggers warn when margin is 5pp below target", () => {
    const alerts = buildEconomicAlerts({
      trailingRevenue24h: "100.00",
      projectedRevenueDaily: "100.00",
      projectedRevenue30d: "3000.00",
      tiers: [
        {
          tier: "Pro",
          salesCount24h: 10,
          revenue24h: "100.00",
          realizedCogs24h: "85.00",
          realizedMargin24h: 0.15,
          targetMargin: 0.2,
          marginDeltaFromTarget: -0.05
        }
      ]
    });

    expect(alerts.some((a) => a.level === "WARN")).toBe(true);
  });
});
