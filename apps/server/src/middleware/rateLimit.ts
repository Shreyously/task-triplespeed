import { Request, Response, NextFunction } from "express";
import { checkRateLimits, type RouteRateLimitPolicy } from "../services/rateLimitService";
import { botDetector } from "../services/botDetectionService";
import { fairnessQueue } from "../services/fairnessQueueService";
import { ACCOUNT_LIMITS, BOT_DETECTION, FAIRNESS_CONFIG } from "../config/antibot";
import { pool } from "../db/pool";

declare global {
  namespace Express {
    interface Request {
      clientIp?: string;
      botScore?: number;
      isFairnessMode?: boolean;
      forceFairnessMode?: boolean;
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

export function rateLimitMiddleware(policy: RouteRateLimitPolicy) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || 'anonymous';
      const ip = extractClientIP(req);

      const result = await checkRateLimits(userId, ip, policy, {
        botScore: req.botScore,
      });

      res.setHeader('X-RateLimit-Limit', result.limit.toString());
      res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
      res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());
      res.setHeader('X-RateLimit-Policy', result.failureMode);

      if (result.degraded) {
        res.setHeader('X-RateLimit-Degraded', 'true');
      }

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter?.toString() || '60');
        return res.status(result.failureMode === 'degraded-closed' ? 503 : 429).json({
          error: result.failureMode === 'degraded-closed' ? 'Rate limiting temporarily unavailable' : 'Too many requests',
          retryAfter: result.retryAfter,
          blockedBy: result.blockedBy,
          degraded: result.degraded,
        });
      }

      if (result.degraded) {
        console.warn('Rate limiting degraded open', {
          routeType: policy.type,
          path: req.path,
          ip,
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
    req.forceFairnessMode = result.action === 'throttle';

    if (result.action === 'block') {
      await botDetector.flagSuspiciousActivity(userId, ip, `High bot score: ${result.score.toFixed(2)}`);

      return res.status(403).json({
        error: 'Request blocked',
        reason: 'bot_detected',
        message: 'Your request pattern suggests automated behavior. Please contact support if this is an error.',
      });
    }

    if (result.score > BOT_DETECTION.throttleScoreThreshold) {
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
    const idempotencyKey = (req as Request & { idempotencyKey?: string }).idempotencyKey;

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

    if (!shouldActivateFairness) {
      return next();
    }

    await fairnessQueue.processCurrentWindowIfReady(dropId);

    const checkResult = await fairnessQueue.checkQueueResult(userId, dropId);
    if (checkResult.winner === true) {
      const claimed = await fairnessQueue.claimWinnerSlot(userId, dropId);
      if (!claimed) {
        return res.status(409).json({
          error: 'Fairness queue',
          message: 'Your fairness slot is already being used or has already been used.',
          fairness: {
            status: 'claim-conflict',
            dropId,
            windowId: checkResult.windowId,
          },
        });
      }

      req.fairnessClaim = { userId, dropId };
      return next();
    }

    if (checkResult.winner === false) {
      return res.status(409).json({
        error: 'Fairness queue',
        message: 'You did not win this fairness window. Please try again later.',
        fairness: {
          status: 'lost',
          dropId,
          windowId: checkResult.windowId,
        },
      });
    }

    const fairnessResult = await fairnessQueue.addToQueue({
      userId,
      dropId,
      timestamp: Date.now(),
      idempotencyKey: idempotencyKey ?? `${userId}:${dropId}`,
    });

    if (fairnessResult.status === 'FAIRNESS_MODE') {
      return res.status(202).json({
        message: fairnessResult.message,
        fairness: {
          status: 'queued',
          dropId,
          windowId: fairnessResult.windowId,
          queuePosition: fairnessResult.queuePosition,
          checkBackIn: FAIRNESS_CONFIG.fairnessWindowSeconds,
        },
      });
    }

    next();
  } catch (error) {
    console.error('Pack purchase middleware error:', error);
    next();
  }
}
