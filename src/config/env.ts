import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // PostgreSQL
  DATABASE_URL: z.string().min(1).default('postgresql://filybase:filybase_secret_pass@localhost:5432/filybase'),
  PG_MAX_CONNECTIONS: z.coerce.number().default(20),
  PG_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
  PG_CONNECTION_TIMEOUT_MS: z.coerce.number().default(5000),

  // Redis
  REDIS_URL: z.string().min(1).default('redis://localhost:6379/0'),
  REDIS_KEY_PREFIX: z.string().default('filybase:'),

  // Auth & Security
  JWT_SECRET: z.string().min(32).default('filybase_super_secret_jwt_key_at_least_32_chars_long_12345'),
  JWT_REFRESH_SECRET: z.string().min(32).default('filybase_super_secret_refresh_jwt_key_32_chars_long_67890'),
  COOKIE_SECRET: z.string().min(32).default('filybase_super_secret_cookie_signing_key_32_chars_long_abcde'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8080,https://app.filybase.com'),

  // Admission Control & Queuing
  QUEUE_WAIT_MS: z.coerce.number().default(10000),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().default(50),

  // Rate Limiting Defaults
  DEFAULT_KEY_RPM: z.coerce.number().default(600),
  DEFAULT_PROJECT_TPM: z.coerce.number().default(500000),

  // Usage Aggregation & Rollup
  USAGE_FLUSH_INTERVAL_MS: z.coerce.number().default(1000),
  USAGE_BATCH_SIZE: z.coerce.number().default(500),
  ROLLUP_REFRESH_INTERVAL_MS: z.coerce.number().default(60000),

  // Body Size Limits
  MAX_REQUEST_BODY_SIZE_BYTES: z.coerce.number().default(1048576), // 1MB
  MAX_AUDIO_BODY_SIZE_BYTES: z.coerce.number().default(26214400), // 25MB

  // Mock Engine
  MOCK_UPSTREAM_ENABLED: z.coerce.boolean().default(true),
  MOCK_UPSTREAM_PORT: z.coerce.number().default(8001),

  // Public URLs (used to build payment redirect + IPN callback URLs)
  APP_URL: z.string().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().default('http://localhost:8080'),

  // NOWPayments crypto checkout (leave blank to disable paid top-ups)
  NOWPAYMENTS_API_KEY: z.string().default(''),
  NOWPAYMENTS_IPN_SECRET: z.string().default(''),
  NOWPAYMENTS_API_URL: z.string().default('https://api.nowpayments.io'),
});

export type Env = z.infer<typeof EnvSchema>;

// Known insecure development defaults that must never reach production.
const INSECURE_DEFAULTS = new Set<string>([
  'filybase_super_secret_jwt_key_at_least_32_chars_long_12345',
  'filybase_super_secret_refresh_jwt_key_32_chars_long_67890',
  'filybase_super_secret_cookie_signing_key_32_chars_long_abcde',
]);

export function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:', result.error.flatten().fieldErrors);
    throw new Error('Environment configuration validation failed');
  }
  const data = result.data;

  if (data.NODE_ENV === 'production') {
    const offenders: string[] = [];
    if (INSECURE_DEFAULTS.has(data.JWT_SECRET)) offenders.push('JWT_SECRET');
    if (INSECURE_DEFAULTS.has(data.JWT_REFRESH_SECRET)) offenders.push('JWT_REFRESH_SECRET');
    if (INSECURE_DEFAULTS.has(data.COOKIE_SECRET)) offenders.push('COOKIE_SECRET');
    if (data.JWT_SECRET === data.JWT_REFRESH_SECRET) offenders.push('JWT_SECRET must differ from JWT_REFRESH_SECRET');
    if (data.CORS_ORIGINS.split(',').map((o) => o.trim()).includes('*')) {
      offenders.push('CORS_ORIGINS may not be "*" in production (credentials are enabled)');
    }
    if (offenders.length > 0) {
      throw new Error(
        `Refusing to start in production with insecure configuration: ${offenders.join(', ')}. ` +
          'Generate strong secrets, e.g. `openssl rand -base64 48`.'
      );
    }
  }

  return data;
}

export const env = loadEnv();
