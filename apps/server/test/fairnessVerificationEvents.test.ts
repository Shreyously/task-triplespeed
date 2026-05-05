import { fairnessVerificationEventSchema } from "@pullvault/common";

describe("fairness verification event schema", () => {
  test("accepts valid payload", () => {
    const parsed = fairnessVerificationEventSchema.parse({
      purchaseId: "550e8400-e29b-41d4-a716-446655440000",
      ok: true,
      checks: {
        seedHash: true,
        cardsHash: true
      },
      clientFingerprint: "browser-session-abc12345"
    });
    expect(parsed.ok).toBe(true);
  });

  test("rejects invalid purchase id", () => {
    const result = fairnessVerificationEventSchema.safeParse({
      purchaseId: "not-a-uuid",
      ok: true,
      checks: {}
    });
    expect(result.success).toBe(false);
  });
});
