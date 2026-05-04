import { redis } from "../db/redis";
import { BOT_DETECTION, type BotScore } from "../config/antibot";
import { pool } from "../db/pool";

interface BotDetectionResult {
  isBot: boolean;
  score: BotScore;
  reasons: string[];
}

interface RequestMetadata {
  userId: string;
  ip: string;
  userAgent: string;
  timestamp: number;
}

function looksLikeUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class BotDetector {
  private static readonly BOT_SCORE_KEY = 'bot_score';
  private static readonly REQUEST_TIMING_KEY = 'request_timing';
  private static readonly SUSPICIOUS_IPS_KEY = 'suspicious_ips';

  async analyzeRequest(metadata: RequestMetadata): Promise<BotDetectionResult> {
    const reasons: string[] = [];
    let score = 0;

    await this.trackAccountForIP(metadata.userId, metadata.ip);

    const useragentScore = this.checkUserAgent(metadata.userAgent);
    score += useragentScore;
    if (useragentScore > 0.3) {
      reasons.push('suspicious_user_agent');
    }

    const timingScore = await this.checkRequestTiming(metadata.userId, metadata.timestamp);
    score += timingScore;
    if (timingScore > 0.2) {
      reasons.push('unnatural_request_timing');
    }

    const accountScore = await this.checkAccountAge(metadata.userId);
    score += accountScore;
    if (accountScore > 0.2) {
      reasons.push('new_account');
    }

    const ipScore = await this.checkIPSuspicious(metadata.ip);
    score += ipScore;
    if (ipScore > 0.3) {
      reasons.push('suspicious_ip');
    }

    const behaviorScore = await this.checkBehavioralPatterns(metadata.userId);
    score += behaviorScore;
    if (behaviorScore > 0.2) {
      reasons.push('unnatural_behavior_patterns');
    }

    const finalScore = Math.min(score, 1.0);
    await this.updateBotScore(metadata.userId, finalScore);

    return {
      isBot: finalScore > BOT_DETECTION.botScoreThreshold,
      score: finalScore,
      reasons,
    };
  }

  private checkUserAgent(userAgent: string): number {
    if (!userAgent || userAgent.length < 10) {
      return 0.4;
    }

    const lowerUA = userAgent.toLowerCase();
    for (const suspicious of BOT_DETECTION.suspiciousUserAgents) {
      if (lowerUA.includes(suspicious)) {
        return 0.8;
      }
    }

    return 0;
  }

  private async checkRequestTiming(userId: string, timestamp: number): Promise<number> {
    const key = `${BotDetector.REQUEST_TIMING_KEY}:${userId}`;
    const now = Date.now();

    try {
      const lastRequest = await redis.get(key);
      if (lastRequest) {
        const interval = timestamp - parseInt(lastRequest);

        if (interval < BOT_DETECTION.minHumanRequestInterval) {
          return 0.5;
        }

        if (interval < BOT_DETECTION.maxBotTimingVariance * 2) {
          const history = await redis.lrange(`${key}:history`, 0, -1);
          if (history.length >= 3) {
            const intervals = history.map((t, i) => {
              if (i === 0) return 0;
              return parseInt(t) - parseInt(history[i - 1]);
            }).slice(1);

            const variance = this.calculateVariance(intervals);
            if (variance < BOT_DETECTION.maxBotTimingVariance) {
              return 0.4;
            }
          }
        }
      }

      await redis.set(key, timestamp, 'EX', 3600);
      await redis.lpush(`${key}:history`, timestamp.toString());
      await redis.ltrim(`${key}:history`, 0, 9);

      return 0;
    } catch (error) {
      console.error('Request timing check error:', error);
      return 0;
    }
  }

  private calculateVariance(intervals: number[]): number {
    if (intervals.length === 0) return 0;
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const squareDiffs = intervals.map(val => Math.pow(val - mean, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / intervals.length);
  }

  private async checkAccountAge(userId: string): Promise<number> {
    if (!looksLikeUUID(userId)) {
      return 0;
    }

    try {
      const result = await pool.query(
        'SELECT created_at FROM users WHERE id = $1',
        [userId]
      );

      if (!result.rows[0]) {
        return 0.5;
      }

      const accountAge = (Date.now() - new Date(result.rows[0].created_at).getTime()) / 1000;

      if (accountAge < BOT_DETECTION.minAccountAgeSeconds) {
        return 0.3;
      }

      return 0;
    } catch (error) {
      console.error('Account age check error:', error);
      return 0;
    }
  }

  private async checkIPSuspicious(ip: string): Promise<number> {
    try {
      const accountsKey = `suspicious_ips:accounts:${ip}`;
      const requestCountKey = `suspicious_ips:requests:${ip}`;

      await redis.incr(requestCountKey);
      await redis.expire(requestCountKey, 86400);

      const uniqueAccounts = await redis.scard(accountsKey);

      if (uniqueAccounts > BOT_DETECTION.maxAccountsPerIP) {
        return 0.6;
      }

      return 0;
    } catch (error) {
      console.error('IP suspicious check error:', error);
      return 0;
    }
  }

  async trackAccountForIP(userId: string, ip: string): Promise<void> {
    try {
      const accountsKey = `suspicious_ips:accounts:${ip}`;
      await redis.sadd(accountsKey, userId);
      await redis.expire(accountsKey, 86400);
    } catch (error) {
      console.error('Track account for IP error:', error);
    }
  }

  private async checkBehavioralPatterns(userId: string): Promise<number> {
    if (!looksLikeUUID(userId)) {
      return 0;
    }

    try {
      const result = await pool.query(
        `SELECT
          COUNT(DISTINCT pp.id) as pack_count,
          COUNT(DISTINCT l.id) as listing_count,
          COUNT(DISTINCT b.id) as bid_count
         FROM users u
         LEFT JOIN pack_purchases pp ON u.id = pp.user_id AND pp.created_at > NOW() - INTERVAL '1 hour'
         LEFT JOIN listings l ON u.id = l.seller_id AND l.created_at > NOW() - INTERVAL '1 hour'
         LEFT JOIN bids b ON u.id = b.bidder_id AND b.created_at > NOW() - INTERVAL '1 hour'
         WHERE u.id = $1`,
        [userId]
      );

      if (!result.rows[0]) {
        return 0;
      }

      const { pack_count, listing_count, bid_count } = result.rows[0];

      if (parseInt(pack_count) > 10) {
        return 0.4;
      }

      if (parseInt(listing_count) === 0 && parseInt(pack_count) > 5) {
        return 0.3;
      }

      return 0;
    } catch (error) {
      console.error('Behavioral patterns check error:', error);
      return 0;
    }
  }

  private async updateBotScore(userId: string, score: BotScore): Promise<void> {
    const key = `${BotDetector.BOT_SCORE_KEY}:${userId}`;
    try {
      await redis.hset(key, {
        score: score.toString(),
        updated_at: Date.now().toString(),
      });
      await redis.expire(key, 86400);
    } catch (error) {
      console.error('Update bot score error:', error);
    }
  }

  async getBotScore(userId: string): Promise<BotScore> {
    const key = `${BotDetector.BOT_SCORE_KEY}:${userId}`;
    try {
      const result = await redis.hget(key, 'score');
      return result ? parseFloat(result) : 0;
    } catch {
      return 0;
    }
  }

  async flagSuspiciousActivity(userId: string, ip: string, reason: string): Promise<void> {
    const key = `suspicious_activity:${userId}`;
    try {
      await redis.lpush(key, JSON.stringify({
        reason,
        ip,
        timestamp: Date.now(),
      }));
      await redis.ltrim(key, 0, 9);
      await redis.expire(key, 604800);
    } catch (error) {
      console.error('Flag suspicious activity error:', error);
    }
  }
}

export const botDetector = new BotDetector();
