import { query, withTransaction } from '../db/index.js';
import { env } from '../config/env.js';
import { UsageEvent } from '../types/db.types.js';

export class UsageAggregatorService {
  private buffer: UsageEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor() {
    if (env.NODE_ENV !== 'test') {
      this.startPeriodicFlush();
    }
  }

  /**
   * Enqueue a usage event into the in-memory buffer
   */
  enqueue(event: UsageEvent): void {
    this.buffer.push(event);

    if (this.buffer.length >= env.USAGE_BATCH_SIZE && !this.isFlushing) {
      // Fire and forget flush when threshold is reached
      this.flush().catch((err) => {
        console.error('Error during batch size triggered flush:', err);
      });
    }
  }

  /**
   * Start periodic timer to flush buffer every 1 second
   */
  private startPeriodicFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0 && !this.isFlushing) {
        this.flush().catch((err) => {
          console.error('Error during periodic usage flush:', err);
        });
      }
    }, env.USAGE_FLUSH_INTERVAL_MS);

    // Unref so process can exit cleanly during tests if needed
    this.flushTimer.unref();
  }

  /**
   * Flush buffered events to PostgreSQL in a single bulk UNNEST query
   */
  async flush(): Promise<number> {
    if (this.buffer.length === 0 || this.isFlushing) {
      return 0;
    }

    this.isFlushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    const count = batch.length;

    try {
      const projectIds: string[] = [];
      const keyIds: (string | null)[] = [];
      const endpointIds: (string | null)[] = [];
      const modelIds: string[] = [];
      const timestamps: Date[] = [];
      const inTokens: number[] = [];
      const outTokens: number[] = [];
      const images: number[] = [];
      const audioSec: number[] = [];
      const latencies: number[] = [];
      const ttfts: number[] = [];
      const statusCodes: number[] = [];
      const costs: number[] = [];

      for (const e of batch) {
        projectIds.push(e.project_id);
        keyIds.push(e.key_id);
        endpointIds.push(e.endpoint_id);
        modelIds.push(e.model_id);
        timestamps.push(e.ts || new Date());
        inTokens.push(e.in_tokens || 0);
        outTokens.push(e.out_tokens || 0);
        images.push(e.images || 0);
        audioSec.push(e.audio_sec || 0);
        latencies.push(e.latency_ms || 0);
        ttfts.push(e.ttft_ms || 0);
        statusCodes.push(e.status_code || 200);
        costs.push(e.cost_credits || 0);
      }

      await query(
        `
        INSERT INTO usage_events (
          project_id, key_id, endpoint_id, model_id, ts,
          in_tokens, out_tokens, images, audio_sec,
          latency_ms, ttft_ms, status_code, cost_credits
        )
        SELECT * FROM UNNEST(
          $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[],
          $6::int[], $7::int[], $8::int[], $9::int[],
          $10::int[], $11::int[], $12::int[], $13::bigint[]
        );
        `,
        [
          projectIds,
          keyIds,
          endpointIds,
          modelIds,
          timestamps,
          inTokens,
          outTokens,
          images,
          audioSec,
          latencies,
          ttfts,
          statusCodes,
          costs,
        ]
      );

      if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
        console.debug(`Flushed ${count} usage events to Postgres`);
      }

      return count;
    } catch (err) {
      console.error('Failed to flush usage events batch to Postgres:', err);
      // Put events back in buffer to prevent data loss (prepend)
      this.buffer.unshift(...batch);
      throw err;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Stop timer and do final synchronous flush on shutdown
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

export const usageAggregatorService = new UsageAggregatorService();
