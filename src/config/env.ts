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
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:', result.error.flatten().fieldErrors);
    throw new Error('Environment configuration validation failed');
  }
  return result.data;
}

export const env = loadEnv();
