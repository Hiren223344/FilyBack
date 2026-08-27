import { query } from '../db/index.js';
import { env } from '../config/env.js';

export class RollupService {
  private timer: NodeJS.Timeout | null = null;
  private isRefreshing = false;

  constructor() {
    if (env.NODE_ENV !== 'test') {
      this.startPeriodicRefresh();
    }
  }

  /**
   * Start periodic 1-minute background refresh of the materialized hourly rollup
   */
  private startPeriodicRefresh(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.refreshRollup().catch((err) => {
        console.error('Error during scheduled rollup refresh:', err);
      });
    }, env.ROLLUP_REFRESH_INTERVAL_MS);

    this.timer.unref();
  }

  /**
   * Refresh materialized view CONCURRENTLY
   */
  async refreshRollup(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
        console.debug('Refreshing usage_hourly_rollup materialized view...');
      }

      try {
        await query('REFRESH MATERIALIZED VIEW CONCURRENTLY usage_hourly_rollup;');
      } catch (err: unknown) {
        // If view has never been populated, CONCURRENTLY fails. Fallback to normal refresh:
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('has not been populated') || msg.includes('cannot refresh')) {
          await query('REFRESH MATERIALIZED VIEW usage_hourly_rollup;');
        } else {
          throw err;
        }
      }

      if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
        console.debug('✓ usage_hourly_rollup refreshed successfully');
      }
    } catch (err) {
      console.error('Failed to refresh usage_hourly_rollup:', err);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Stop background timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const rollupService = new RollupService();
