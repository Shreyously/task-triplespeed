import { BotDetector } from "../src/services/botDetectionService";
import { pool } from "../src/db/pool";
import { redis } from "../src/db/redis";

describe("Bot Detection Service", () => {
  let detector: BotDetector;
  let testUserId: string;
  let testIP: string;

  beforeAll(() => {
    detector = new BotDetector();
    testUserId = "test-user-" + Date.now();
    testIP = "192.168.1.100";
  });

  afterAll(async () => {
    await redis.flushdb();
  });

  test("should detect suspicious user agents", async () => {
    const result = await detector.analyzeRequest({
      userId: testUserId,
      ip: testIP,
      userAgent: "curl/7.68.0",
      timestamp: Date.now(),
    });

    expect(result.score).toBeGreaterThan(0.3);
    expect(result.reasons).toContain("suspicious_user_agent");
  });

  test("should flag super-fast request timing", async () => {
    const now = Date.now();

    await detector.analyzeRequest({
      userId: testUserId,
      ip: testIP,
      userAgent: "Mozilla/5.0",
      timestamp: now - 50,
    });

    const result = await detector.analyzeRequest({
      userId: testUserId,
      ip: testIP,
      userAgent: "Mozilla/5.0",
      timestamp: now,
    });

    expect(result.score).toBeGreaterThan(0.2);
    expect(result.reasons).toContain("unnatural_request_timing");
  });

  test("should detect consistent bot-like timing patterns", async () => {
    const now = Date.now();
    const interval = 100;

    for (let i = 0; i < 5; i++) {
      await detector.analyzeRequest({
        userId: testUserId + "timing",
        ip: testIP,
        userAgent: "Mozilla/5.0",
        timestamp: now + (i * interval),
      });
    }

    const result = await detector.analyzeRequest({
      userId: testUserId + "timing",
      ip: testIP,
      userAgent: "Mozilla/5.0",
      timestamp: now + (5 * interval),
    });

    expect(result.reasons).toContain("unnatural_request_timing");
  });

  test("should handle normal user requests", async () => {
    const result = await detector.analyzeRequest({
      userId: testUserId + "normal",
      ip: "192.168.1.101",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      timestamp: Date.now(),
    });

    expect(result.score).toBeLessThan(0.3);
    expect(result.isBot).toBe(false);
  });

  test("should flag suspicious IPs with multiple accounts", async () => {
    const suspiciousIP = "192.168.1.200";

    for (let i = 0; i < 6; i++) {
      await detector.analyzeRequest({
        userId: `user${i}`,
        ip: suspiciousIP,
        userAgent: "Mozilla/5.0",
        timestamp: Date.now(),
      });
    }

    const result = await detector.analyzeRequest({
      userId: "new_user",
      ip: suspiciousIP,
      userAgent: "Mozilla/5.0",
      timestamp: Date.now(),
    });

    expect(result.reasons).toContain("suspicious_ip");
  });

  test("should update and retrieve bot scores", async () => {
    await detector.analyzeRequest({
      userId: testUserId + "score",
      ip: testIP,
      userAgent: "bot-agent",
      timestamp: Date.now(),
    });

    const score = await detector.getBotScore(testUserId + "score");
    expect(score).toBeGreaterThan(0);
  });

  test("should flag suspicious activity", async () => {
    await detector.flagSuspiciousActivity(
      testUserId + "suspicious",
      testIP,
      "high_bot_score"
    );

    const key = `suspicious_activity:${testUserId}suspicious`;
    const activity = await redis.lrange(key, 0, -1);

    expect(activity.length).toBeGreaterThan(0);
  });

  test("should handle missing user agents", async () => {
    const result = await detector.analyzeRequest({
      userId: testUserId + "no-ua",
      ip: testIP,
      userAgent: "",
      timestamp: Date.now(),
    });

    expect(result.score).toBeGreaterThan(0.3);
    expect(result.reasons).toContain("suspicious_user_agent");
  });

  test("should detect known bot user agents", async () => {
    const botAgents = [
      "Googlebot/2.1",
      "python-requests/2.28.0",
      "Go-http-client/1.1",
    ];

    for (const agent of botAgents) {
      const result = await detector.analyzeRequest({
        userId: testUserId + agent,
        ip: testIP,
        userAgent: agent,
        timestamp: Date.now(),
      });

      expect(result.score).toBeGreaterThan(0.5);
      expect(result.reasons).toContain("suspicious_user_agent");
    }
  });
});