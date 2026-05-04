import { BotDetector } from "../src/services/botDetectionService";
import { redis } from "../src/db/redis";

describe("Bot Detection Service", () => {
  let detector: BotDetector;
  let testIP: string;

  beforeAll(() => {
    detector = new BotDetector();
    testIP = "192.168.1.100";
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
  });

  test("medium-score users are throttled instead of blocked", async () => {
    const now = Date.now();
    await detector.analyzeRequest({
      userId: "medium-user",
      ip: testIP,
      userAgent: "Mozilla/5.0",
      timestamp: now,
    });

    const result = await detector.analyzeRequest({
      userId: "medium-user",
      ip: testIP,
      userAgent: "Mozilla/5.0",
      timestamp: now + 50,
    });

    expect(result.action).toBe('throttle');
    expect(result.isBot).toBe(false);
    expect(result.reasons).toContain("unnatural_request_timing");
  });

  test("high-confidence bot user agents are blocked", async () => {
    const result = await detector.analyzeRequest({
      userId: "curl-user",
      ip: testIP,
      userAgent: "curl/7.68.0",
      timestamp: Date.now(),
    });

    expect(result.action).toBe('block');
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  test("legitimate browser-like users are allowed", async () => {
    const result = await detector.analyzeRequest({
      userId: "normal-user",
      ip: "192.168.1.101",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      timestamp: Date.now(),
    });

    expect(result.action).toBe('allow');
    expect(result.score).toBeLessThan(0.3);
  });

  test("multi-account activity on one IP increases restrictions", async () => {
    const suspiciousIP = "192.168.1.200";

    for (let index = 0; index < 6; index += 1) {
      await detector.analyzeRequest({
        userId: `user-${index}`,
        ip: suspiciousIP,
        userAgent: "Mozilla/5.0",
        timestamp: Date.now() + index,
      });
    }

    const result = await detector.analyzeRequest({
      userId: "user-7",
      ip: suspiciousIP,
      userAgent: "Mozilla/5.0",
      timestamp: Date.now() + 10,
    });

    expect(result.reasons).toContain("suspicious_ip");
    expect(['throttle', 'block']).toContain(result.action);
  });
});
