import { chiSquarePValue, classifyFairnessSignificance } from "../src/repositories/analyticsRepository";

describe("fairness audit statistics", () => {
  test("chi-square p-value decreases for larger statistic", () => {
    const pSmall = chiSquarePValue(2.5, 3);
    const pLarge = chiSquarePValue(20, 3);
    expect(pSmall).toBeGreaterThan(pLarge);
    expect(pSmall).toBeGreaterThan(0);
    expect(pLarge).toBeLessThan(0.01);
  });

  test("significance thresholds map correctly", () => {
    expect(classifyFairnessSignificance(100, 3, 0.2)).toBe("PASS");
    expect(classifyFairnessSignificance(100, 3, 0.03)).toBe("WATCH");
    expect(classifyFairnessSignificance(100, 3, 0.001)).toBe("FAIL");
    expect(classifyFairnessSignificance(10, 3, 0.001)).toBe("INSUFFICIENT_SAMPLE");
  });
});
