import { redis } from "../db/redis";
import { FAIRNESS_CONFIG, type FairnessStatus } from "../config/antibot";
import { pool } from "../db/pool";

interface FairnessQueueEntry {
  userId: string;
  dropId: string;
  timestamp: number;
  idempotencyKey: string;
}

interface FairnessResult {
  status: FairnessStatus;
  winner?: boolean;
  queuePosition?: number;
  message?: string;
}

export class FairnessQueue {
  private static readonly QUEUE_KEY = 'fairness_queue';
  private static readonly REQUESTS_KEY = 'fairness_requests';
  private static readonly RESULTS_KEY = 'fairness_results';
  private static readonly STATUS_KEY = 'fairness_status';
  private static readonly PROCESSING_LOCK_KEY = 'fairness_processing_lock';
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();

  async addToQueue(entry: FairnessQueueEntry): Promise<FairnessResult> {
    const statusKey = `${FairnessQueue.STATUS_KEY}:${entry.dropId}`;
    const queueKey = `${FairnessQueue.QUEUE_KEY}:${entry.dropId}`;
    const requestsKey = `${FairnessQueue.REQUESTS_KEY}:${entry.dropId}`;

    try {
      const script = `
        local status_key = KEYS[1]
        local queue_key = KEYS[2]
        local requests_key = KEYS[3]
        local user_id = ARGV[1]
        local timestamp = ARGV[2]
        local data = ARGV[3]
        local window = tonumber(ARGV[4])

        local status = redis.call('GET', status_key)

        if status == 'PROCESSING' then
          return {1, 0}
        end

        if status ~= 'FAIRNESS_MODE' then
          return {0, 0}
        end

        local existing = redis.call('HGET', requests_key, user_id)
        if existing then
          local parsed = cjson.decode(existing)
          return {2, parsed.position}
        end

        local queue_size = redis.call('ZCARD', queue_key)
        local position = queue_size + 1

        redis.call('ZADD', queue_key, timestamp, user_id)
        local parsed = cjson.decode(data)
        parsed.position = position
        redis.call('HSET', requests_key, user_id, cjson.encode(parsed))
        redis.call('EXPIRE', queue_key, window + 60)
        redis.call('EXPIRE', requests_key, window + 60)

        return {3, position}
      `;

      const result = await redis.eval(
        script,
        3,
        statusKey,
        queueKey,
        requestsKey,
        entry.userId,
        Date.now() + Math.random(),
        JSON.stringify({
          ...entry,
          position: 0,
        }),
        FAIRNESS_CONFIG.fairnessWindowSeconds
      ) as number[];

      const [statusCode, position] = result;

      if (statusCode === 0) {
        return {
          status: 'NORMAL',
          message: 'Fairness mode not active, proceeding normally',
        };
      }

      if (statusCode === 1) {
        return {
          status: 'FAIRNESS_MODE',
          message: 'Currently processing fairness queue, please wait...',
        };
      }

      if (statusCode === 2) {
        return {
          status: 'FAIRNESS_MODE',
          winner: undefined,
          queuePosition: position,
          message: 'Already in fairness queue',
        };
      }

      return {
        status: 'FAIRNESS_MODE',
        winner: undefined,
        queuePosition: position,
        message: `Added to fairness queue at position ${position}`,
      };

    } catch (error) {
      console.error('Add to queue error:', error);
      return {
        status: 'NORMAL',
        message: 'Error adding to queue, proceeding normally',
      };
    }
  }

  async processFairnessWindow(dropId: string, availableInventory: number): Promise<string[]> {
    const queueKey = `${FairnessQueue.QUEUE_KEY}:${dropId}`;
    const requestsKey = `${FairnessQueue.REQUESTS_KEY}:${dropId}`;
    const resultsKey = `${FairnessQueue.RESULTS_KEY}:${dropId}`;
    const lockToken = await this.acquireProcessingLock(dropId);

    if (!lockToken) {
      return [];
    }

    try {
      const currentStatus = await this.getFairnessStatus(dropId);
      if (currentStatus === 'NORMAL') {
        return [];
      }

      await this.setFairnessStatus(dropId, 'PROCESSING');

      const allParticipants = await redis.zrange(queueKey, 0, -1);
      const winners: string[] = [];

      if (allParticipants.length <= availableInventory) {
        winners.push(...allParticipants);
      } else {
        const shuffled = [...allParticipants].sort(() => Math.random() - 0.5);
        winners.push(...shuffled.slice(0, availableInventory));
      }

      const winnerSet = new Set(winners);
      const multi = redis.multi();
      multi.del(resultsKey);

      for (const participant of allParticipants) {
        multi.hset(resultsKey, participant, winnerSet.has(participant) ? 'AVAILABLE' : 'LOST');
      }

      multi.expire(resultsKey, 60);
      multi.expire(requestsKey, 60);
      multi.set(`${FairnessQueue.STATUS_KEY}:${dropId}`, 'NORMAL', 'EX', FAIRNESS_CONFIG.fairnessWindowSeconds + 120);
      await multi.exec();

      const existingTimer = this.cleanupTimers.get(dropId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const cleanupTimer = setTimeout(() => {
        this.cleanupTimers.delete(dropId);
        void this.cleanupQueue(dropId);
      }, 60000);
      cleanupTimer.unref?.();
      this.cleanupTimers.set(dropId, cleanupTimer);

      return winners;
    } catch (error) {
      console.error('Process fairness window error:', error);
      await this.setFairnessStatus(dropId, 'NORMAL');
      return [];
    } finally {
      await this.releaseProcessingLock(dropId, lockToken);
    }
  }

  async checkQueueResult(userId: string, dropId: string): Promise<FairnessResult> {
    const requestsKey = `${FairnessQueue.REQUESTS_KEY}:${dropId}`;
    const resultsKey = `${FairnessQueue.RESULTS_KEY}:${dropId}`;
    const statusKey = `${FairnessQueue.STATUS_KEY}:${dropId}`;

    try {
      const userRequest = await redis.hget(requestsKey, userId);
      const resultState = await redis.hget(resultsKey, userId);
      const status = await redis.get(statusKey);

      if (resultState === 'AVAILABLE' || resultState === 'CLAIMED') {
        return {
          status: 'NORMAL',
          winner: true,
          message: 'You won the fairness queue!',
        };
      }

      if (resultState === 'CONSUMED') {
        return {
          status: 'NORMAL',
          winner: false,
          message: 'Your fairness slot has already been used.',
        };
      }

      if (resultState === 'LOST') {
        return {
          status: 'NORMAL',
          winner: false,
          message: 'Better luck next time!',
        };
      }

      if (!userRequest) {
        return {
          status: 'NORMAL',
          message: 'Not in fairness queue',
        };
      }

      if (status === 'PROCESSING') {
        const request = JSON.parse(userRequest);
        return {
          status: 'FAIRNESS_MODE',
          winner: undefined,
          queuePosition: request.position,
          message: 'Currently processing fairness queue',
        };
      }

      if (status === 'NORMAL' && !resultState) {
        return {
          status: 'NORMAL',
          message: 'Fairness queue expired or was reset. Please try purchasing again.',
        };
      }

      const request = JSON.parse(userRequest);
      return {
        status: 'FAIRNESS_MODE',
        winner: undefined,
        queuePosition: request.position,
        message: `Still processing fairness queue, position ${request.position}`,
      };
    } catch (error) {
      console.error('Check queue result error:', error);
      return {
        status: 'NORMAL',
        message: 'Error checking queue status',
      };
    }
  }

  async claimWinnerSlot(userId: string, dropId: string): Promise<boolean> {
    const resultsKey = `${FairnessQueue.RESULTS_KEY}:${dropId}`;

    try {
      const script = `
        local results_key = KEYS[1]
        local user_id = ARGV[1]
        local state = redis.call('HGET', results_key, user_id)

        if state == 'AVAILABLE' then
          redis.call('HSET', results_key, user_id, 'CLAIMED')
          return 1
        end

        return 0
      `;

      const claimed = await redis.eval(script, 1, resultsKey, userId) as number;
      return claimed === 1;
    } catch (error) {
      console.error('Claim winner slot error:', error);
      return false;
    }
  }

  async completeWinnerSlot(userId: string, dropId: string, success: boolean): Promise<void> {
    const resultsKey = `${FairnessQueue.RESULTS_KEY}:${dropId}`;
    const nextState = success ? 'CONSUMED' : 'AVAILABLE';

    try {
      const script = `
        local results_key = KEYS[1]
        local user_id = ARGV[1]
        local next_state = ARGV[2]
        local state = redis.call('HGET', results_key, user_id)

        if state == 'CLAIMED' then
          redis.call('HSET', results_key, user_id, next_state)
        end

        return 1
      `;

      await redis.eval(script, 1, resultsKey, userId, nextState);
    } catch (error) {
      console.error('Complete winner slot error:', error);
    }
  }

  async shouldActivateFairnessMode(dropId: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT
          d.inventory,
          (d.inventory + (SELECT COUNT(*) FROM pack_purchases WHERE drop_id = d.id)) as original_inventory,
          d.starts_at,
          d.ends_at
         FROM drops d
         WHERE d.id = $1`,
        [dropId]
      );

      if (!result.rows[0]) {
        return false;
      }

      const { inventory, original_inventory, starts_at, ends_at } = result.rows[0];
      const currentInventory = parseInt(inventory);
      const originalInventory = parseInt(original_inventory || inventory);
      const ratio = originalInventory > 0 ? currentInventory / originalInventory : 0;

      const now = new Date();
      const startTime = new Date(starts_at);
      const endTime = new Date(ends_at);
      const dropDuration = endTime.getTime() - startTime.getTime();
      const elapsed = now.getTime() - startTime.getTime();
      const progress = dropDuration > 0 ? elapsed / dropDuration : 0;

      return ratio < FAIRNESS_CONFIG.inventoryThreshold && progress > 0.1;
    } catch (error) {
      console.error('Should activate fairness mode error:', error);
      return false;
    }
  }

  private async getFairnessStatus(dropId: string): Promise<FairnessStatus> {
    const key = `${FairnessQueue.STATUS_KEY}:${dropId}`;
    try {
      const status = await redis.get(key);
      return (status as FairnessStatus) || 'NORMAL';
    } catch {
      return 'NORMAL';
    }
  }

  private async setFairnessStatus(dropId: string, status: FairnessStatus): Promise<void> {
    const key = `${FairnessQueue.STATUS_KEY}:${dropId}`;
    try {
      await redis.set(key, status, 'EX', FAIRNESS_CONFIG.fairnessWindowSeconds + 120);
    } catch (error) {
      console.error('Set fairness status error:', error);
    }
  }

  private async cleanupQueue(dropId: string): Promise<void> {
    const queueKey = `${FairnessQueue.QUEUE_KEY}:${dropId}`;
    const requestsKey = `${FairnessQueue.REQUESTS_KEY}:${dropId}`;
    const resultsKey = `${FairnessQueue.RESULTS_KEY}:${dropId}`;
    const existingTimer = this.cleanupTimers.get(dropId);

    if (existingTimer) {
      clearTimeout(existingTimer);
      this.cleanupTimers.delete(dropId);
    }

    try {
      await redis.del(queueKey, requestsKey, resultsKey);
    } catch (error) {
      if ((error as Error).message?.includes('Connection is closed')) {
        return;
      }
      console.error('Cleanup queue error:', error);
    }
  }

  async getQueueSize(dropId: string): Promise<number> {
    const queueKey = `${FairnessQueue.QUEUE_KEY}:${dropId}`;
    try {
      return await redis.zcard(queueKey);
    } catch {
      return 0;
    }
  }

  private async acquireProcessingLock(dropId: string): Promise<string | null> {
    const key = `${FairnessQueue.PROCESSING_LOCK_KEY}:${dropId}`;
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
      const result = await redis.set(key, token, 'EX', FAIRNESS_CONFIG.maxProcessingTimeSeconds, 'NX');
      return result === 'OK' ? token : null;
    } catch (error) {
      console.error('Acquire processing lock error:', error);
      return null;
    }
  }

  private async releaseProcessingLock(dropId: string, token: string): Promise<void> {
    const key = `${FairnessQueue.PROCESSING_LOCK_KEY}:${dropId}`;

    try {
      const script = `
        local lock_key = KEYS[1]
        local token = ARGV[1]

        if redis.call('GET', lock_key) == token then
          return redis.call('DEL', lock_key)
        end

        return 0
      `;

      await redis.eval(script, 1, key, token);
    } catch (error) {
      console.error('Release processing lock error:', error);
    }
  }
}

export const fairnessQueue = new FairnessQueue();
