-- UP: 001_initial_schema.sql
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- accounts
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- projects
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_account_id ON projects(account_id);

-- balances: 1 credit = $1 / 500,000
CREATE TABLE IF NOT EXISTS balances (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    credits BIGINT NOT NULL DEFAULT 0
);

-- ledger
CREATE TABLE IF NOT EXISTS ledger (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    delta BIGINT NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_account_created ON ledger(account_id, created_at DESC);

-- api_keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash BYTEA NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    last4 TEXT NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id);

-- models
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('text', 'image', 'audio', 'embedding')),
    engine TEXT NOT NULL CHECK (engine IN ('vllm', 'diffusers', 'whisper', 'tei')),
    upstream_url TEXT NOT NULL,
    upstream_model TEXT NOT NULL,
    ctx_len INT NOT NULL DEFAULT 0,
    max_concurrency INT NOT NULL DEFAULT 16,
    price_in_per_mtok NUMERIC(12, 6) NOT NULL DEFAULT 0,
    price_out_per_mtok NUMERIC(12, 6) NOT NULL DEFAULT 0,
    price_per_image NUMERIC(12, 6) NOT NULL DEFAULT 0,
    price_per_audio_min NUMERIC(12, 6) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'disabled', 'sleeping'))
);

-- endpoints
CREATE TABLE IF NOT EXISTS endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
    live BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_endpoints_project_name UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_endpoints_project ON endpoints(project_id);
CREATE INDEX IF NOT EXISTS idx_endpoints_model ON endpoints(model_id);

-- invoices
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period DATE NOT NULL,
    amount NUMERIC(12, 4) NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('paid', 'pending', 'void', 'draft')),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices(account_id, period DESC);

-- usage_events: Partitioned monthly on ts
CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL,
    project_id UUID NOT NULL,
    key_id UUID,
    endpoint_id UUID,
    model_id TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    in_tokens INT NOT NULL DEFAULT 0,
    out_tokens INT NOT NULL DEFAULT 0,
    images INT NOT NULL DEFAULT 0,
    audio_sec INT NOT NULL DEFAULT 0,
    latency_ms INT NOT NULL DEFAULT 0,
    ttft_ms INT NOT NULL DEFAULT 0,
    status_code INT NOT NULL DEFAULT 200,
    cost_credits BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS idx_usage_events_project_ts ON usage_events (project_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_endpoint_ts ON usage_events (endpoint_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_model_ts ON usage_events (model_id, ts DESC);

-- Initial monthly partitions (and default catch-all partition)
CREATE TABLE IF NOT EXISTS usage_events_default PARTITION OF usage_events DEFAULT;

-- Specific monthly partitions for 2025, 2026, 2027
DO $$
DECLARE
    y INT;
    m INT;
    start_date DATE;
    end_date DATE;
    partition_name TEXT;
BEGIN
    FOR y IN 2025..2027 LOOP
        FOR m IN 1..12 LOOP
            start_date := make_date(y, m, 1);
            end_date := start_date + INTERVAL '1 month';
            partition_name := 'usage_events_y' || y || 'm' || LPAD(m::TEXT, 2, '0');
            
            BEGIN
                EXECUTE format(
                    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L);',
                    partition_name, start_date, end_date
                );
            EXCEPTION WHEN OTHERS THEN
                -- If partition overlaps with default or already exists, continue
                NULL;
            END;
        END LOOP;
    END LOOP;
END $$;
