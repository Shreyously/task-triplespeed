import { createHash } from "crypto";
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
  status: FairnessStatus | 'NORMAL';
  winner?: boolean;
  queuePosition?: number;
  message?: string;
  windowId?: string;
}

interface FairnessWindowState {
  status: FairnessStatus;
  windowId?: string;
  startedAt?: number;
}

export class FairnessQueue {
  private static readonly STATUS_KEY = 'fairness_status';
  private static readonly WINDOW_KEY = 'fairness_window';
  private static readonly REQUEST_RATE_KEY = 'fairness_requests';
  private static readonly REQUESTS_KEY = 'fairness_entries';
  private static readonly RESULTS_KEY = 'fairness_results';
  private static readonly PROCESSING_LOCK_KEY = 'fairness_processing_lock';

  private readonly scheduledWindows = new Map<string, NodeJS.Timeout>();

  async addToQueue(entry: FairnessQueueEntry): Promise<FairnessResult> {
    const window = await this.getWindowState(entry.dropId);

    if (window.status !== 'FAIRNESS_MODE' || !window.windowId) {
      return {
        status: 'NORMAL',
        message: 'Fairness mode not active, proceeding normally',
      };
    }

    const queueKey = this.queueKey(entry.dropId, window.windowId);
    const requestsKey = this.requestsKey(entry.dropId, window.windowId);

    try {
      const script = `
        local queue_key = KEYS[1]
        local requests_key = KEYS[2]
        local user_id = ARGV[1]
        local score = tonumber(ARGV[2])
        local payload = ARGV[3]
        local ttl = tonumber(ARGV[4])

        local existing = redis.call('HGET', requests_key, user_id)
        if existing then
          local parsed = cjson.decode(existing)
          return {0, parsed.position}
        end

        redis.call('ZADD', queue_key, score, user_id)
        local position = redis.call('ZRANK', queue_key, user_id) + 1
        local parsed = cjson.decode(payload)
        parsed.position = position
        redis.call('HSET', requests_key, user_id, cjson.encode(parsed))
        redis.call('EXPIRE', queue_key, ttl)
        redis.call('EXPIRE', requests_key, ttl)
        return {1, position}
      `;

      const [added, position] = await redis.eval(
        script,
        2,
        queueKey,
        requestsKey,
        entry.userId,
        entry.timestamp,
        JSON.stringify({ ...entry, position: 0 }),
        FAIRNESS_CONFIG.fairnessWindowSeconds + FAIRNESS_CONFIG.claimWindowSeconds + 120
      ) as [number, number];

      return {
        status: 'FAIRNESS_MODE',
        queuePosition: position,
        message: added === 1 ? `Added to fairness queue at position ${position}` : 'Already in fairness queue',
        windowId: window.windowId,
      };
    } catch (error) {
      console.error('Add to queue error:', error);
      return {
        status: 'NORMAL',
        message: 'Error adding to queue, proceeding normally',
      };
    }
  }

  async processFairnessWindow(dropId: string, availableInventory: number, windowId?: string): Promise<string[]> {
    const window = await this.getWindowState(dropId);
    const activeWindowId = windowId ?? window.windowId;

    if (!activeWindowId) {
      return [];
    }

    const lockToken = await this.acquireProcessingLock(dropId);
    if (!lockToken) {
      return [];
    }

    try {
      const refreshedWindow = await this.getWindowState(dropId);
      if (!refreshedWindow.windowId || refreshedWindow.windowId !== activeWindowId) {
        return [];
      }

      await this.setFairnessStatus(dropId, 'PROCESSING', activeWindowId, refreshedWindow.startedAt);

      const queueKey = this.queueKey(dropId, activeWindowId);
      const requestsKey = this.requestsKey(dropId, activeWindowId);
      const resultsKey = this.resultsKey(dropId, activeWindowId);
      const participants = await redis.zrange(queueKey, 0, -1);
      const winners = this.selectWinners(dropId, activeWindowId, participants, availableInventory);
      const winnerSet = new Set(winners);

      const multi = redis.multi();
      multi.del(resultsKey);
      for (const participant of participants) {
        multi.hset(resultsKey, participant, winnerSet.has(participant) ? 'AVAILABLE' : 'LOST');
      }
      multi.expire(resultsKey, FAIRNESS_CONFIG.claimWindowSeconds + 120);
      multi.expire(requestsKey, FAIRNESS_CONFIG.claimWindowSeconds + 120);
      multi.set(this.statusKey(dropId), 'CLAIMABLE', 'EX', FAIRNESS_CONFIG.claimWindowSeconds + 120);
      multi.set(this.windowKey(dropId), JSON.stringify({
        windowId: activeWindowId,
        startedAt: refreshedWindow.startedAt ?? Date.now(),
      }), 'EX', FAIRNESS_CONFIG.claimWindowSeconds + 120);
      await multi.exec();

      console.info('Fairness window processed', {
        dropId,
        windowId: activeWindowId,
        participants: participants.length,
        winners: winners.length,
      });

      return winners;
    } catch (error) {
      console.error('Process fairness window error:', error);
      await this.setFairnessStatus(dropId, 'NORMAL');
      return [];
    } finally {
      await this.releaseProcessingLock(dropId, lockToken);
    }
  }

  async processCurrentWindowIfReady(dropId: string): Promise<void> {
    const window = await this.getWindowState(dropId);
    if (window.status !== 'FAIRNESS_MODE' || !window.windowId || !window.startedAt) {
      return;
    }

    const readyAt = window.startedAt + (FAIRNESS_CONFIG.fairnessWindowSeconds * 1000);
    if (Date.now() < readyAt) {
      return;
    }

    const availableInventory = await this.getAvailableInventory(dropId);
    await this.processFairnessWindow(dropId, availableInventory, window.windowId);
  }

  async checkQueueResult(userId: string, dropId: string): Promise<FairnessResult> {
    const window = await this.getWindowState(dropId);
    const activeWindowId = window.windowId;

    if (!activeWindowId) {
      return {
        status: 'NORMAL',
        message: 'Fairness mode not active',
      };
    }

    const requestsKey = this.requestsKey(dropId, activeWindowId);
    const resultsKey = this.resultsKey(dropId, activeWindowId);

    try {
      const userRequest = await redis.hget(requestsKey, userId);
      const resultState = await redis.hget(resultsKey, userId);

      if (resultState === 'AVAILABLE' || resultState === 'CLAIMED') {
        return {
          status: 'CLAIMABLE',
          winner: true,
          message: 'You won the fairness queue!',
          windowId: activeWindowId,
        };
      }

      if (resultState === 'CONSUMED') {
        return {
          status: 'NORMAL',
          winner: false,
          message: 'Your fairness slot has already been used.',
          windowId: activeWindowId,
        };
      }

      if (resultState === 'LOST') {
        return {
          status: 'NORMAL',
          winner: false,
          message: 'Better luck next time!',
          windowId: activeWindowId,
        };
      }

      if (!userRequest) {
        return {
          status: window.status,
          message: 'Not in fairness queue',
          windowId: activeWindowId,
        };
      }

      const request = JSON.parse(userRequest) as { position: number };
      return {
        status: window.status,
        winner: undefined,
        queuePosition: request.position,
        message: window.status === 'PROCESSING' ? 'Currently processing fairness queue' : `Still queued for fairness window ${activeWindowId}`,
        windowId: activeWindowId,
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
    const window = await this.getWindowState(dropId);
    if (!window.windowId) {
      return false;
    }

    const resultsKey = this.resultsKey(dropId, window.windowId);

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
    const window = await this.getWindowState(dropId);
    if (!window.windowId) {
      return;
    }

    const resultsKey = this.resultsKey(dropId, window.windowId);
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
    const pressure = await this.measurePressure(dropId);
    if (!pressure.shouldActivate) {
      return false;
    }

    return this.ensureFairnessWindow(dropId);
  }

  async ensureFairnessWindow(dropId: string): Promise<boolean> {
    const existing = await this.getWindowState(dropId);
    if (existing.status === 'FAIRNESS_MODE' || existing.status === 'PROCESSING' || existing.status === 'CLAIMABLE') {
      if (existing.windowId && existing.startedAt) {
        this.scheduleWindowProcessing(dropId, existing.windowId, existing.startedAt);
      }
      return true;
    }

    const windowId = `${Date.now()}`;
    const startedAt = Date.now();

    try {
      const script = `
        local status_key = KEYS[1]
        local window_key = KEYS[2]
        local existing_status = redis.call('GET', status_key)

        if existing_status == 'FAIRNESS_MODE' or existing_status == 'PROCESSING' or existing_status == 'CLAIMABLE' then
          return 0
        end

        redis.call('SET', status_key, 'FAIRNESS_MODE', 'EX', tonumber(ARGV[3]))
        redis.call('SET', window_key, cjson.encode({ windowId = ARGV[1], startedAt = tonumber(ARGV[2]) }), 'EX', tonumber(ARGV[3]))
        return 1
      `;

      const ttl = FAIRNESS_CONFIG.fairnessWindowSeconds + FAIRNESS_CONFIG.claimWindowSeconds + 120;
      const opened = await redis.eval(
        script,
        2,
        this.statusKey(dropId),
        this.windowKey(dropId),
        windowId,
        startedAt,
        ttl
      ) as number;

      const activeWindow = opened === 1 ? { windowId, startedAt } : await this.getWindowState(dropId);
      if (activeWindow.windowId && activeWindow.startedAt) {
        this.scheduleWindowProcessing(dropId, activeWindow.windowId, activeWindow.startedAt);
      }

      if (opened === 1) {
        console.info('Fairness window opened', { dropId, windowId });
      }

      return true;
    } catch (error) {
      console.error('Ensure fairness window error:', error);
      return false;
    }
  }

  async getQueueSize(dropId: string): Promise<number> {
    const window = await this.getWindowState(dropId);
    if (!window.windowId) {
      return 0;
    }

    try {
      return await redis.zcard(this.queueKey(dropId, window.windowId));
    } catch {
      return 0;
    }
  }

  private async measurePressure(dropId: string): Promise<{ shouldActivate: boolean }> {
    try {
      const result = await pool.query(
        `SELECT
          d.inventory,
          (d.inventory + (SELECT COUNT(*) FROM pack_purchases WHERE drop_id = d.id)) as original_inventory
         FROM drops d
         WHERE d.id = $1`,
        [dropId]
      );

      if (!result.rows[0]) {
        return { shouldActivate: false };
      }

      const currentInventory = parseInt(result.rows[0].inventory, 10);
      const originalInventory = parseInt(result.rows[0].original_inventory || result.rows[0].inventory, 10);
      const inventoryRatio = originalInventory > 0 ? currentInventory / originalInventory : 0;
      const requestCount = await this.recordContention(dropId);

      return {
        shouldActivate: inventoryRatio <= FAIRNESS_CONFIG.inventoryThreshold
          && requestCount >= FAIRNESS_CONFIG.contentionRequestThreshold,
      };
    } catch (error) {
      console.error('Measure fairness pressure error:', error);
      return { shouldActivate: false };
    }
  }

  private async recordContention(dropId: string): Promise<number> {
    const key = `${FairnessQueue.REQUEST_RATE_KEY}:${dropId}`;
    const now = Date.now();
    const uniqueId = `${now}:${Math.random().toString(36).slice(2)}`;

    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local cutoff = tonumber(ARGV[2])
      local member = ARGV[3]
      local ttl = tonumber(ARGV[4])

      redis.call('ZADD', key, now, member)
      redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
      redis.call('PEXPIRE', key, ttl)
      return redis.call('ZCARD', key)
    `;

    return await redis.eval(
      script,
      1,
      key,
      now,
      now - (FAIRNESS_CONFIG.contentionWindowSeconds * 1000),
      uniqueId,
      FAIRNESS_CONFIG.contentionWindowSeconds * 1000 + 1000
    ) as number;
  }

  private selectWinners(dropId: string, windowId: string, participants: string[], availableInventory: number): string[] {
    return [...participants]
      .sort((left, right) => this.participantHash(dropId, windowId, left).localeCompare(this.participantHash(dropId, windowId, right)))
      .slice(0, Math.max(0, availableInventory));
  }

  private participantHash(dropId: string, windowId: string, userId: string): string {
    return createHash('sha256').update(`${dropId}:${windowId}:${userId}`).digest('hex');
  }

  private scheduleWindowProcessing(dropId: string, windowId: string, startedAt: number): void {
    const timerKey = `${dropId}:${windowId}`;
    if (this.scheduledWindows.has(timerKey)) {
      return;
    }

    const delay = Math.max(0, startedAt + (FAIRNESS_CONFIG.fairnessWindowSeconds * 1000) - Date.now());
    const timer = setTimeout(() => {
      this.scheduledWindows.delete(timerKey);
      void this.processCurrentWindowIfReady(dropId);
    }, delay);

    timer.unref?.();
    this.scheduledWindows.set(timerKey, timer);
  }

  private async getAvailableInventory(dropId: string): Promise<number> {
    const result = await pool.query('SELECT inventory FROM drops WHERE id = $1', [dropId]);
    return parseInt(result.rows[0]?.inventory ?? '0', 10);
  }

  private async getWindowState(dropId: string): Promise<FairnessWindowState> {
    try {
      const [status, rawWindow] = await Promise.all([
        redis.get(this.statusKey(dropId)),
        redis.get(this.windowKey(dropId)),
      ]);

      if (!status) {
        return { status: 'NORMAL' };
      }

      const parsed = rawWindow ? JSON.parse(rawWindow) as { windowId?: string; startedAt?: number } : {};
      return {
        status: status as FairnessStatus,
        windowId: parsed.windowId,
        startedAt: parsed.startedAt,
      };
    } catch {
      return { status: 'NORMAL' };
    }
  }

  private async setFairnessStatus(dropId: string, status: FairnessStatus, windowId?: string, startedAt?: number): Promise<void> {
    const ttl = FAIRNESS_CONFIG.fairnessWindowSeconds + FAIRNESS_CONFIG.claimWindowSeconds + 120;
    try {
      const multi = redis.multi();
      multi.set(this.statusKey(dropId), status, 'EX', ttl);
      if (windowId) {
        multi.set(this.windowKey(dropId), JSON.stringify({ windowId, startedAt: startedAt ?? Date.now() }), 'EX', ttl);
      }
      await multi.exec();
    } catch (error) {
      console.error('Set fairness status error:', error);
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

  private statusKey(dropId: string): string {
    return `${FairnessQueue.STATUS_KEY}:${dropId}`;
  }

  private windowKey(dropId: string): string {
    return `${FairnessQueue.WINDOW_KEY}:${dropId}`;
  }

  private queueKey(dropId: string, windowId: string): string {
    return `${FairnessQueue.REQUEST_RATE_KEY}:queue:${dropId}:${windowId}`;
  }

  private requestsKey(dropId: string, windowId: string): string {
    return `${FairnessQueue.REQUESTS_KEY}:${dropId}:${windowId}`;
  }

  private resultsKey(dropId: string, windowId: string): string {
    return `${FairnessQueue.RESULTS_KEY}:${dropId}:${windowId}`;
  }
}

export const fairnessQueue = new FairnessQueue();
