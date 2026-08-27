import { redis } from '../db/redis.js';
import { env } from '../config/env.js';
import { CACHE_TTL } from '../config/constants.js';

export interface SemaphoreAcquisition {
  acquired: boolean;
  waitMs: number;
  currentCount: number;
  maxConcurrency: number;
}

export class SemaphoreService {
  /**
   * Acquire a concurrency slot for a specific model.
   * If slot is full, waits up to queueWaitMs before returning false.
   */
  async acquireSlot(
    modelId: string,
    maxConcurrency: number,
    requestId: string,
    queueWaitMs: number = env.QUEUE_WAIT_MS,
    pollIntervalMs: number = env.QUEUE_POLL_INTERVAL_MS
  ): Promise<SemaphoreAcquisition> {
    const key = `sem:model:${modelId}`;
    const startTime = Date.now();
    const ttlMs = CACHE_TTL.SEMAPHORE_ACTIVE_SEC * 1000;

    while (true) {
      const nowMs = Date.now();
      const [status, currentCount, configuredMax] = await redis.filybaseSemaphore(
        key,
        'acquire',
        maxConcurrency,
        requestId,
        nowMs,
        ttlMs
      );

      if (status === 1) {
        return {
          acquired: true,
          waitMs: Date.now() - startTime,
          currentCount,
          maxConcurrency: configuredMax,
        };
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= queueWaitMs) {
        return {
          acquired: false,
          waitMs: elapsed,
          currentCount,
          maxConcurrency: configuredMax,
        };
      }

      // Back off slightly with jitter to avoid stampede
      const jitter = Math.floor(Math.random() * 10);
      const sleepTime = Math.min(pollIntervalMs + jitter, queueWaitMs - elapsed);
      if (sleepTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepTime));
      }
    }
  }

  /**
   * Release an acquired concurrency slot for a model
   */
  async releaseSlot(modelId: string, requestId: string): Promise<void> {
    const key = `sem:model:${modelId}`;
    const nowMs = Date.now();
    try {
      await redis.filybaseSemaphore(key, 'release', 0, requestId, nowMs, 0);
    } catch (err) {
      console.error(`Failed to release semaphore for model ${modelId}, req ${requestId}:`, err);
    }
  }

  /**
   * Get active concurrency count for a model
   */
  async getActiveCount(modelId: string): Promise<number> {
    const key = `sem:model:${modelId}`;
    const nowMs = Date.now();
    try {
      const [, count] = await redis.filybaseSemaphore(key, 'count', 0, '', nowMs, 0);
      return count;
    } catch {
      return 0;
    }
  }
}

export const semaphoreService = new SemaphoreService();
