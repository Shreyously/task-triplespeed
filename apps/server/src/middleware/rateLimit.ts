import { Request, Response, NextFunction } from "express";
import { checkRateLimits } from "../services/rateLimitService";
import { botDetector } from "../services/botDetectionService";
import { fairnessQueue } from "../services/fairnessQueueService";
import { BOT_DETECTION, ACCOUNT_LIMITS, FAIRNESS_CONFIG, RATE_LIMITS, type RateLimitType } from "../config/antibot";
import { pool } from "../db/pool";

declare global {
  namespace Express {
    interface Request {
      clientIp?: string;
      botScore?: number;
      isFairnessMode?: boolean;
      fairnessClaim?: {
        userId: string;
        dropId: string;
      };
    }
  }
}

export function extractClientIP(req: Request): string {
  const rawIp = req.ip || req.socket.remoteAddress || 'unknown';
  return rawIp.replace('::ffff:', '');
}

function getRateLimitHeaderValue(type: RateLimitType): number {
  switch (type) {
    case 'API':
      return RATE_LIMITS.API.perUserPerMinute;
    case 'PACK_PURCHASE':
      return RATE_LIMITS.PACK_PURCHASE.perUserPerMinute;
    case 'AUTH':
      return RATE_LIMITS.AUTH.perIPPerMinute;
    case 'MARKETPLACE':
      return RATE_LIMITS.MARKETPLACE.perUserPerHour;
    default:
      return 100;
  }
}

export function rateLimitMiddleware(type: RateLimitType) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || 'anonymous';
      const ip = extractClientIP(req);

      const result = await checkRateLimits(userId, ip, type);

      res.setHeader('X-RateLimit-Limit', getRateLimitHeaderValue(type).toString());
      res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
      res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter?.toString() || '60');
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: result.retryAfter,
        });
      }

      next();
    } catch (error) {
      console.error('Rate limit middleware error:', error);
      next();
    }
  };
}

export async function botDetectionMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    const ip = extractClientIP(req);
    const userAgent = req.headers['user-agent'] || '';

    if (!userId) {
      return next();
    }

    const result = await botDetector.analyzeRequest({
      userId,
      ip,
      userAgent,
      timestamp: Date.now(),
    });

    req.botScore = result.score;

    if (result.isBot) {
      await botDetector.flagSuspiciousActivity(userId, ip, `High bot score: ${result.score.toFixed(2)}`);

      return res.status(403).json({
        error: 'Request blocked',
        reason: 'bot_detected',
        message: 'Your request pattern suggests automated behavior. Please contact support if this is an error.',
      });
    }

    if (result.score > BOT_DETECTION.botScoreThreshold * 0.7) {
      res.setHeader('X-Bot-Score', result.score.toFixed(2));
    }

    next();
  } catch (error) {
    console.error('Bot detection middleware error:', error);
    next();
  }
}

export async function packPurchaseMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.userId;
    const dropId = req.body.dropId;
    const idempotencyKey = (req as any).idempotencyKey;

    if (!userId || !dropId) {
      return next();
    }

    if (idempotencyKey) {
      const existingPurchase = await pool.query(
        `SELECT 1
         FROM pack_purchases
         WHERE user_id = $1 AND drop_id = $2 AND idempotency_key = $3`,
        [userId, dropId, idempotencyKey]
      );

      if (existingPurchase.rows[0]) {
        return next();
      }
    }

    const accountAgeCheck = await pool.query(
      'SELECT created_at FROM users WHERE id = $1',
      [userId]
    );

    if (accountAgeCheck.rows[0]) {
      const accountAge = (Date.now() - new Date(accountAgeCheck.rows[0].created_at).getTime()) / 1000;
      if (accountAge < ACCOUNT_LIMITS.minAccountAgeSeconds) {
        return res.status(403).json({
          error: 'Account too new',
          message: `Accounts must be at least ${ACCOUNT_LIMITS.minAccountAgeSeconds / 3600} hour(s) old to purchase packs`,
        });
      }
    }

    const shouldActivateFairness = await fairnessQueue.shouldActivateFairnessMode(dropId);
    req.isFairnessMode = shouldActivateFairness;

    if (shouldActivateFairness) {
      const checkResult = await fairnessQueue.checkQueueResult(userId, dropId);
      if (checkResult.winner === true) {
        const claimed = await fairnessQueue.claimWinnerSlot(userId, dropId);
        if (!claimed) {
          return res.status(409).json({
            error: 'Fairness queue',
            message: 'Your fairness slot is already being used or has already been used.',
          });
        }

        req.fairnessClaim = { userId, dropId };
        return next();
      }
      
      if (checkResult.winner === false) {
        return res.status(403).json({
          error: 'Fairness queue',
          message: 'You did not win this fairness window. Please try again later.'
        });
      }

      const fairnessResult = await fairnessQueue.addToQueue({
        userId,
        dropId,
        timestamp: Date.now(),
        idempotencyKey,
      });

      if (fairnessResult.status === 'FAIRNESS_MODE') {
        return res.status(202).json({
          message: fairnessResult.message,
          queuePosition: fairnessResult.queuePosition,
          checkBackIn: FAIRNESS_CONFIG.fairnessWindowSeconds,
        });
      }
    }

    next();
  } catch (error) {
    console.error('Pack purchase middleware error:', error);
    next();
  }
}
