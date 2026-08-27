import { redis } from '../db/redis.js';
import { env } from '../config/env.js';

export interface RateLimitResult {
  allowed: boolean;
  limitRequests: number;
  remainingRequests: number;
  resetRequests: number;
  limitTokens: number;
  remainingTokens: number;
  resetTokens: number;
  retryAfter: number;
}

export class RateLimiterService {
  /**
   * Check token-bucket rate limits for API Key RPM and Project TPM
   */
  async checkRateLimits(
    keyId: string,
    projectId: string,
    estimatedTokens: number = 1,
    customKeyRpm?: number,
    customProjectTpm?: number
  ): Promise<RateLimitResult> {
    const keyRpm = customKeyRpm || env.DEFAULT_KEY_RPM;
    const projectTpm = customProjectTpm || env.DEFAULT_PROJECT_TPM;

    const rpmKey = `rl:key:${keyId}:rpm`;
    const tpmKey = `rl:proj:${projectId}:tpm`;

    const nowMs = Date.now();
    const rpmRefillRate = keyRpm / 60000; // tokens per ms
    const tpmRefillRate = projectTpm / 60000; // tokens per ms

    // 1. Check RPM (1 request per call)
    const [rpmAllowed, rpmRemaining, rpmRetryAfter, rpmResetAfter] =
      await redis.filybaseRateLimit(
        rpmKey,
        keyRpm,
        rpmRefillRate,
        1,
        nowMs,
        120
      );

    // 2. Check TPM
    const tokensCost = Math.max(1, estimatedTokens);
    const [tpmAllowed, tpmRemaining, tpmRetryAfter, tpmResetAfter] =
      await redis.filybaseRateLimit(
        tpmKey,
        projectTpm,
        tpmRefillRate,
        tokensCost,
        nowMs,
        120
      );

    const allowed = rpmAllowed === 1 && tpmAllowed === 1;
    const retryAfter = Math.max(rpmRetryAfter, tpmRetryAfter);

    return {
      allowed,
      limitRequests: keyRpm,
      remainingRequests: Math.max(0, rpmRemaining),
      resetRequests: rpmResetAfter,
      limitTokens: projectTpm,
      remainingTokens: Math.max(0, tpmRemaining),
      resetTokens: tpmResetAfter,
      retryAfter,
    };
  }
}

export const rateLimiterService = new RateLimiterService();
