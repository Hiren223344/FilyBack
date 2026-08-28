import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Lightweight in-memory fixed-window limiter for unauthenticated endpoints
 * (login / signup). Protects against credential-stuffing and account
 * enumeration bursts without a Redis round-trip on the hot auth path.
 *
 * For multi-instance deployments this should be fronted by the reverse proxy's
 * own rate limiting; this is a defense-in-depth floor.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodic sweep so the map cannot grow unbounded.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweep.unref?.();

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Namespace so different routes don't share a budget. */
  scope: string;
}

function clientIp(req: FastifyRequest): string {
  // Fastify is configured with trustProxy, so req.ip already respects XFF.
  return req.ip || 'unknown';
}

export function rateLimit(opts: RateLimitOptions) {
  return async function rateLimitHandler(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const now = Date.now();
    const key = `${opts.scope}:${clientIp(req)}`;
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, opts.max - bucket.count);
    reply.header('x-ratelimit-limit', String(opts.max));
    reply.header('x-ratelimit-remaining', String(remaining));

    if (bucket.count > opts.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      reply.header('retry-after', String(retryAfter));
      reply.status(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many attempts. Please wait a moment and try again.',
      });
    }
  };
}
