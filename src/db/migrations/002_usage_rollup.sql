-- UP: 002_usage_rollup.sql

CREATE MATERIALIZED VIEW IF NOT EXISTS usage_hourly_rollup AS
SELECT
    project_id,
    COALESCE(endpoint_id, '00000000-0000-0000-0000-000000000000'::uuid) AS endpoint_id,
    model_id,
    date_trunc('hour', ts) AS hour,
    COUNT(*)::bigint AS request_count,
    COALESCE(SUM(in_tokens), 0)::bigint AS in_tokens,
    COALESCE(SUM(out_tokens), 0)::bigint AS out_tokens,
    COALESCE(SUM(images), 0)::bigint AS images,
    COALESCE(SUM(audio_sec), 0)::bigint AS audio_sec,
    COALESCE(SUM(cost_credits), 0)::bigint AS cost_credits,
    COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50_latency_ms,
    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms
FROM usage_events
GROUP BY project_id, COALESCE(endpoint_id, '00000000-0000-0000-0000-000000000000'::uuid), model_id, date_trunc('hour', ts);

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_hourly_rollup_pk 
ON usage_hourly_rollup (project_id, endpoint_id, model_id, hour);

CREATE INDEX IF NOT EXISTS idx_usage_hourly_rollup_project_hour 
ON usage_hourly_rollup (project_id, hour DESC);

CREATE INDEX IF NOT EXISTS idx_usage_hourly_rollup_endpoint_hour 
ON usage_hourly_rollup (endpoint_id, hour DESC);
