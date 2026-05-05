import { getEconomicsDashboardController } from "../src/controllers/analyticsController";

describe("platform health dashboard controller", () => {
  test("returns 403 for non-admin callers", async () => {
    const req: any = {
      user: { userId: "550e8400-e29b-41d4-a716-446655440000" }
    };
    const calls: Array<{ code?: number; payload?: unknown }> = [];
    const json = (payload: unknown) => {
      calls.push({ payload });
      return undefined;
    };
    const status = (code: number) => {
      calls.push({ code });
      return { json };
    };
    const res: any = { status, json };

    await getEconomicsDashboardController(req, res);

    expect(calls.some((entry) => entry.code === 403)).toBe(true);
    expect(calls.some((entry) => JSON.stringify(entry.payload) === JSON.stringify({ error: "Forbidden" }))).toBe(true);
  });
});
