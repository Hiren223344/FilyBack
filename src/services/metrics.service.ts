import client from 'prom-client';

// Initialize default Node.js and runtime metrics
client.collectDefaultMetrics({
  prefix: 'filybase_',
});

export const metrics = {
  requestsTotal: new client.Counter({
    name: 'filybase_http_requests_total',
    help: 'Total number of HTTP requests processed by FilyBase gateway',
    labelNames: ['model', 'method', 'path', 'status_code'] as const,
  }),

  requestDurationSeconds: new client.Histogram({
    name: 'filybase_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['model', 'engine', 'stream', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  }),

  ttftSeconds: new client.Histogram({
    name: 'filybase_time_to_first_token_seconds',
    help: 'Time to first token (TTFT) for streaming responses in seconds',
    labelNames: ['model', 'engine'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  }),

  tokensTotal: new client.Counter({
    name: 'filybase_tokens_total',
    help: 'Total input and output tokens served',
    labelNames: ['model', 'type'] as const, // type: 'prompt' | 'completion'
  }),

  creditsTotal: new client.Counter({
    name: 'filybase_credits_consumed_total',
    help: 'Total credits consumed by inference requests',
    labelNames: ['model'] as const,
  }),

  activeConcurrency: new client.Gauge({
    name: 'filybase_model_active_concurrency',
    help: 'Current active in-flight requests per model',
    labelNames: ['model'] as const,
  }),

  queueWaitDurationSeconds: new client.Histogram({
    name: 'filybase_queue_wait_duration_seconds',
    help: 'Time requests spend waiting in admission control concurrency queue',
    labelNames: ['model'] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  }),

  rateLimitHitsTotal: new client.Counter({
    name: 'filybase_rate_limit_hits_total',
    help: 'Total rate limit rejections',
    labelNames: ['type'] as const, // 'rpm' | 'tpm'
  }),

  concurrencyRejectionsTotal: new client.Counter({
    name: 'filybase_concurrency_rejections_total',
    help: 'Total requests rejected due to admission control queue timeout',
    labelNames: ['model'] as const,
  }),
};

export async function getPrometheusMetrics(): Promise<string> {
  return client.register.metrics();
}

export function getMetricsContentType(): string {
  return client.register.contentType;
}
