export const CREDITS_PER_USD = 500_000;

export const HEADERS = {
  REQUEST_ID: 'x-filybase-request-id',
  MODEL: 'x-filybase-model',
  LATENCY_MS: 'x-filybase-latency-ms',
  TTFT_MS: 'x-filybase-ttft-ms',
  CREDITS_USED: 'x-filybase-credits-used',
  RATELIMIT_LIMIT_REQUESTS: 'x-ratelimit-limit-requests',
  RATELIMIT_REMAINING_REQUESTS: 'x-ratelimit-remaining-requests',
  RATELIMIT_RESET_REQUESTS: 'x-ratelimit-reset-requests',
  RATELIMIT_LIMIT_TOKENS: 'x-ratelimit-limit-tokens',
  RATELIMIT_REMAINING_TOKENS: 'x-ratelimit-remaining-tokens',
  RATELIMIT_RESET_TOKENS: 'x-ratelimit-reset-tokens',
  RETRY_AFTER: 'retry-after',
} as const;

export const CACHE_TTL = {
  KEY_RESOLUTION_SEC: 60, // Cache key -> project in Redis for 60s
  CREDIT_RESERVATION_SEC: 300, // 5 min safety TTL for active reservation
  SEMAPHORE_ACTIVE_SEC: 300, // 5 min safety TTL for concurrency lock
  MODEL_REGISTRY_SEC: 30, // 30s cache for model definitions
} as const;

export const AUTH = {
  KEY_PREFIX: 'sk-fb-',
  JWT_EXPIRY: '15m',
  REFRESH_TOKEN_EXPIRY_DAYS: 30,
  REFRESH_COOKIE_NAME: 'fb_refresh_token',
} as const;

export const BILLING = {
  // Free credits granted once, on signup.
  TRIAL_CREDIT_USD: 5,
  // Bounds for a paid top-up.
  MIN_TOPUP_USD: 5,
  MAX_TOPUP_USD: 10_000,
} as const;
