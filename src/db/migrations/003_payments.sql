-- UP: 003_payments.sql
-- Crypto top-up payments (NOWPayments). One row per checkout attempt.
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'nowpayments',
    order_id TEXT NOT NULL UNIQUE,
    provider_invoice_id TEXT,
    provider_payment_id TEXT,
    amount_usd NUMERIC(12, 2) NOT NULL,
    credits BIGINT NOT NULL,
    -- Internal lifecycle: pending -> credited | failed. raw_status keeps the
    -- provider's own status string for auditing.
    status TEXT NOT NULL DEFAULT 'pending',
    raw_status TEXT,
    credited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_account_created ON payments(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
