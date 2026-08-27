export interface Account {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  created_at: Date;
}

export interface Project {
  id: string;
  account_id: string;
  name: string;
  created_at: Date;
}

export interface Balance {
  account_id: string;
  credits: string | number; // bigint from PG
}

export interface LedgerEntry {
  id: number;
  account_id: string;
  delta: string | number;
  reason: string;
  ref: string | null;
  created_at: Date;
}

export interface ApiKey {
  id: string;
  project_id: string;
  name: string;
  key_hash: Buffer;
  prefix: string;
  last4: string;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export type ModelCategory = 'text' | 'image' | 'audio' | 'embedding';
export type ModelEngine = 'vllm' | 'diffusers' | 'whisper' | 'tei';
export type ModelStatus = 'live' | 'disabled' | 'sleeping';

export interface Model {
  id: string;
  display_name: string;
  provider: string;
  category: ModelCategory;
  engine: ModelEngine;
  upstream_url: string;
  upstream_model: string;
  ctx_len: number;
  max_concurrency: number;
  price_in_per_mtok: number | string;
  price_out_per_mtok: number | string;
  price_per_image: number | string;
  price_per_audio_min: number | string;
  status: ModelStatus;
}

export interface Endpoint {
  id: string;
  project_id: string;
  name: string;
  model_id: string;
  live: boolean;
  created_at: Date;
}

export interface EndpointWithStats {
  id: string;
  name: string;
  model: string;
  live: boolean;
  requests_24h: number;
  p50_latency_ms: number;
  created_at: Date;
}

export interface UsageEvent {
  id?: number;
  project_id: string;
  key_id: string | null;
  endpoint_id: string | null;
  model_id: string;
  ts: Date;
  in_tokens: number;
  out_tokens: number;
  images: number;
  audio_sec: number;
  latency_ms: number;
  ttft_ms: number;
  status_code: number;
  cost_credits: number;
}

export interface Invoice {
  id: string;
  account_id: string;
  period: string;
  amount: number | string;
  status: 'paid' | 'pending' | 'void' | 'draft';
  issued_at: Date;
}

export interface HourlyRollupRow {
  project_id: string;
  endpoint_id: string;
  model_id: string;
  hour: Date;
  request_count: string | number;
  in_tokens: string | number;
  out_tokens: string | number;
  images: string | number;
  audio_sec: string | number;
  cost_credits: string | number;
  p50_latency_ms: number;
  p95_latency_ms: number;
}
