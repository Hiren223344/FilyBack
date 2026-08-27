import { Redis } from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read Lua scripts
const rateLimiterLua = fs.readFileSync(
  path.join(__dirname, '../redis/lua/rate_limiter.lua'),
  'utf-8'
);
const semaphoreLua = fs.readFileSync(
  path.join(__dirname, '../redis/lua/semaphore.lua'),
  'utf-8'
);
const creditsLua = fs.readFileSync(
  path.join(__dirname, '../redis/lua/credits.lua'),
  'utf-8'
);

export const redis = new Redis(env.REDIS_URL, {
  keyPrefix: env.REDIS_KEY_PREFIX,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  retryStrategy(times) {
    if (env.NODE_ENV === 'test') return null; // don't retry endlessly in tests
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis client error:', err);
});

// Register Lua commands on the Redis instance
redis.defineCommand('filybaseRateLimit', {
  numberOfKeys: 1,
  lua: rateLimiterLua,
});

redis.defineCommand('filybaseSemaphore', {
  numberOfKeys: 1,
  lua: semaphoreLua,
});

redis.defineCommand('filybaseCredits', {
  numberOfKeys: 3,
  lua: creditsLua,
});

// Type declarations for the custom Redis commands
declare module 'ioredis' {
  interface RedisCommander<Context> {
    filybaseRateLimit(
      key: string,
      capacity: number,
      refillRatePerMs: number,
      cost: number,
      nowMs: number,
      ttlSec: number
    ): Promise<[allowed: number, remaining: number, retryAfter: number, resetAfter: number]>;

    filybaseSemaphore(
      key: string,
      action: 'acquire' | 'release' | 'count',
      maxConcurrency: number,
      requestId: string,
      nowMs: number,
      ttlMs: number
    ): Promise<[status: number, currentCount: number, maxConcurrency: number]>;

    filybaseCredits(
      balanceKey: string,
      resKey: string,
      resTotalKey: string,
      action: 'reserve' | 'reconcile' | 'release' | 'set_balance' | 'get_balance',
      amount: number | string,
      param: number | string,
      fallbackBalance: number | string
    ): Promise<[status: number, value1: number, value2: number]>;
  }
}

export async function checkRedisHealth(): Promise<{
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    if (pong === 'PONG') {
      return { status: 'healthy', latencyMs: Date.now() - start };
    }
    return { status: 'unhealthy', latencyMs: Date.now() - start, error: `Unexpected ping response: ${pong}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'unhealthy', latencyMs: Date.now() - start, error: message };
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
