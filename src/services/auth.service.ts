import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { env } from '../config/env.js';
import { AUTH, CACHE_TTL } from '../config/constants.js';
import { query } from '../db/index.js';
import { redis } from '../db/redis.js';
import { Account, ApiKey, Project } from '../types/db.types.js';

export interface UserPayload {
  accountId: string;
  email: string;
  name: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface CachedApiKeyResolution {
  apiKey: ApiKey;
  project: Project;
  account: {
    id: string;
    email: string;
  };
}

export class AuthService {
  /**
   * Hash a password using Argon2id
   */
  async hashPassword(password: string): Promise<string> {
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      timeCost: 2,
      memoryCost: 65536,
      parallelism: 2,
    });
  }

  /**
   * Verify password against Argon2id hash
   */
  async verifyPassword(hashVal: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashVal, plain);
    } catch {
      return false;
    }
  }

  /**
   * Issue JWT access token (15m expiry)
   */
  generateAccessToken(payload: UserPayload): string {
    return jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: AUTH.JWT_EXPIRY,
      issuer: 'filybase-gateway',
      audience: 'filybase-dashboard',
    });
  }

  /**
   * Issue long-lived refresh token
   */
  generateRefreshToken(payload: UserPayload): string {
    return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
      expiresIn: `${AUTH.REFRESH_TOKEN_EXPIRY_DAYS}d`,
      issuer: 'filybase-gateway',
      audience: 'filybase-dashboard-refresh',
    });
  }

  /**
   * Verify access token
   */
  verifyAccessToken(token: string): UserPayload {
    return jwt.verify(token, env.JWT_SECRET, {
      issuer: 'filybase-gateway',
      audience: 'filybase-dashboard',
    }) as UserPayload;
  }

  /**
   * Verify refresh token
   */
  verifyRefreshToken(token: string): UserPayload {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, {
      issuer: 'filybase-gateway',
      audience: 'filybase-dashboard-refresh',
    }) as UserPayload;
  }

  /**
   * Generate an sk-fb- API key and its SHA-256 hash
   */
  generateApiKey(): { rawKey: string; keyHash: Buffer; prefix: string; last4: string } {
    const randomHex = crypto.randomBytes(24).toString('hex');
    const rawKey = `${AUTH.KEY_PREFIX}${randomHex}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest();
    const prefix = rawKey.slice(0, 10);
    const last4 = rawKey.slice(-4);
    return { rawKey, keyHash, prefix, last4 };
  }

  /**
   * Hash raw API key string to SHA-256 buffer
   */
  hashApiKey(rawKey: string): Buffer {
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  /**
   * Resolve API key to ApiKey + Project + Account with 60s Redis caching
   */
  async resolveApiKey(rawKey: string): Promise<CachedApiKeyResolution | null> {
    if (!rawKey.startsWith(AUTH.KEY_PREFIX)) {
      return null;
    }

    const keyHash = this.hashApiKey(rawKey);
    const hashHex = keyHash.toString('hex');
    const cacheKey = `cache:key_res:${hashHex}`;

    // 1. Try Redis cache (60s TTL)
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as CachedApiKeyResolution;
        // Asynchronously update last_used_at in DB
        this.touchKeyLastUsed(parsed.apiKey.id).catch(() => {});
        return parsed;
      } catch {
        // Corrupted cache -> proceed to DB lookup
      }
    }

    // 2. Query PostgreSQL
    const res = await query<{
      key_id: string;
      key_project_id: string;
      key_name: string;
      key_prefix: string;
      key_last4: string;
      key_revoked_at: Date | null;
      key_last_used_at: Date | null;
      key_created_at: Date;
      project_id: string;
      project_account_id: string;
      project_name: string;
      project_created_at: Date;
      account_id: string;
      account_email: string;
    }>(
      `
      SELECT 
        k.id AS key_id,
        k.project_id AS key_project_id,
        k.name AS key_name,
        k.prefix AS key_prefix,
        k.last4 AS key_last4,
        k.revoked_at AS key_revoked_at,
        k.last_used_at AS key_last_used_at,
        k.created_at AS key_created_at,
        p.id AS project_id,
        p.account_id AS project_account_id,
        p.name AS project_name,
        p.created_at AS project_created_at,
        a.id AS account_id,
        a.email AS account_email
      FROM api_keys k
      JOIN projects p ON p.id = k.project_id
      JOIN accounts a ON a.id = p.account_id
      WHERE k.key_hash = $1
      LIMIT 1;
      `,
      [keyHash]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    if (!row) return null;

    // Check if key is revoked
    if (row.key_revoked_at !== null) {
      return null;
    }

    const resolution: CachedApiKeyResolution = {
      apiKey: {
        id: row.key_id,
        project_id: row.key_project_id,
        name: row.key_name,
        key_hash: keyHash,
        prefix: row.key_prefix,
        last4: row.key_last4,
        revoked_at: row.key_revoked_at,
        last_used_at: row.key_last_used_at,
        created_at: row.key_created_at,
      },
      project: {
        id: row.project_id,
        account_id: row.project_account_id,
        name: row.project_name,
        created_at: row.project_created_at,
      },
      account: {
        id: row.account_id,
        email: row.account_email,
      },
    };

    // Cache in Redis for 60s
    await redis.set(
      cacheKey,
      JSON.stringify(resolution),
      'EX',
      CACHE_TTL.KEY_RESOLUTION_SEC
    );

    // Touch last used asynchronously
    this.touchKeyLastUsed(row.key_id).catch(() => {});

    return resolution;
  }

  /**
   * Invalidate cached API key (e.g. on revocation)
   */
  async invalidateKeyCache(keyHash: Buffer): Promise<void> {
    const hashHex = keyHash.toString('hex');
    await redis.del(`cache:key_res:${hashHex}`);
  }

  /**
   * Asynchronously update key's last_used_at in DB
   */
  private async touchKeyLastUsed(keyId: string): Promise<void> {
    await query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyId]);
  }
}

export const authService = new AuthService();
