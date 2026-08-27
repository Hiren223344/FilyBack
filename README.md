# ⚡ FilyBase Inference Gateway

> High-throughput, serverless-style inference gateway serving open-weight models (GPT OSS 120B, Llama 3.3, Mixtral 8x7B, Qwen 2.5, Stable Diffusion 3.5, Whisper Large v3, BGE Embeddings) from dedicated GPU infrastructure with strict admission control, zero data retention, and 100% OpenAI SDK compatibility.

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    Client["Clients & SDKs (Python / Node / cURL)"]
    Caddy["Caddy Edge TLS (Unbuffered SSE / Strict TLS)"]
    
    subgraph GatewayStack ["FilyBase Gateway (Node 22 + TypeScript + Fastify)"]
        Auth["1. Auth & Key SHA-256 (60s Redis Cache)"]
        Router["2. Model Registry Resolver (models.yaml)"]
        RateLimiter["3. Token Bucket Rate Limiter (RPM & TPM)"]
        Admission["4. Admission Control Semaphore (GPU Concurrency Cap)"]
        CreditReserve["5. Atomic Credit Reserve (Lua Script)"]
        Proxy["6. Low-Overhead SSE Stream Pipe & TTFT Tracker"]
        Reconcile["7. Credit Reconcile & Semaphore Release"]
        Buffer["8. Async In-Memory Usage Buffer (1s / 500 rows)"]
    end

    subgraph CacheAndStorage ["Storage & Cache Infrastructure"]
        Redis[("Redis 7: Token Buckets, Semaphores, Atomic Credit Lua")]
        Postgres[("PostgreSQL 16: Monthly Partitioned usage_events, citext, Rollups")]
    end

    subgraph GPUHost ["Dedicated GPU Engine Daemons (Host / Private Net)"]
        vLLM["vLLM / TGI (:8001) - GPT OSS 120B, Llama 3.3, Mixtral, Qwen"]
        Diffusers["Diffusers HTTP (:8002) - Stable Diffusion 3.5"]
        Whisper["Faster-Whisper (:8003) - Whisper Large v3"]
        TEI["TEI (:8004) - BGE / E5 Embeddings"]
    end

    subgraph Observability ["Observability"]
        Prometheus["Prometheus /metrics"]
        Grafana["Grafana Dashboards"]
    end

    Client -->|HTTPS Bearer sk-fb-...| Caddy
    Caddy --> GatewayStack
    Auth <--> Redis
    Auth <--> Postgres
    RateLimiter <--> Redis
    Admission <--> Redis
    CreditReserve <--> Redis
    Proxy -->|v1/chat/completions| vLLM
    Proxy -->|v1/images/generations| Diffusers
    Proxy -->|v1/audio/transcriptions| Whisper
    Proxy -->|v1/embeddings| TEI
    Reconcile <--> Redis
    Buffer -->|Bulk UNNEST Insert| Postgres
    Prometheus -->|Scrape| GatewayStack
    Grafana --> Prometheus
```

---

## 🎯 Ground Rules & Core Guarantees

1. **Passive Engine Lifecycle**: GPU processes (`vLLM`, `diffusers`, `faster-whisper`, `TEI`) are managed externally via systemd/docker-compose. The gateway does not start or stop them, performing only passive `/health` checks.
2. **Zero-Retention Hard Guarantee**: Prompts, completions, generated images, and uploaded audio are **never** persisted to disk or database. Logs record only metadata (`model`, `token_counts`, `latency_ms`, `ttft_ms`, `status_code`, `cost_credits`).
3. **OpenAI Drop-In Compatibility**: Inference contracts strictly mirror OpenAI schemas, headers, and error shapes `{ "error": { "message", "type", "code" } }`.
4. **GPU Admission Control**: Redis-backed distributed semaphores prevent GPU saturation by strictly enforcing `max_concurrency` with configurable queue timeouts (`QUEUE_WAIT_MS = 10s`).
5. **Exact Integer Credit Math**: Balances are calculated in integer credits where **$1.00 USD = 500,000 credits** (1 credit = $0.000002), eliminating floating-point rounding drift.

---

## 🔄 SDK Drop-in Replacement

FilyBase is a drop-in replacement for OpenAI SDKs. Change only the `base_url` / `baseURL` and pass your `sk-fb-...` key.

### 🐍 Python SDK (`openai>=1.0.0`)

```python
import openai

client = openai.OpenAI(
    base_url="https://api.filybase.com/v1",  # Or http://localhost:8080/v1
    api_key="sk-fb-live-demo-key-1234567890abcdef"
)

# 1. Chat Completion (Streaming)
stream = client.chat.completions.create(
    model="llama-3.3-70b",
    messages=[
        {"role": "system", "content": "You are a senior systems engineer."},
        {"role": "user", "content": "Explain Redis token bucket rate limiting in 2 sentences."}
    ],
    stream=True
)

for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)

# 2. Embeddings
embeddings = client.embeddings.create(
    model="bge-large-en-v1.5",
    input="FilyBase high-throughput inference gateway"
)
print(f"\nVector length: {len(embeddings.data[0].embedding)}")

# 3. Image Generation
image = client.images.generate(
    model="stable-diffusion-3.5",
    prompt="A futuristic GPU datacenter glowing in neon emerald green",
    n=1
)
print(f"Generated Image: {image.data[0].url}")
```

### 🟨 Node.js / TypeScript SDK (`openai^4.0.0`)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://api.filybase.com/v1', // Or http://localhost:8080/v1
  apiKey: 'sk-fb-live-demo-key-1234567890abcdef',
});

async function main() {
  const stream = await client.chat.completions.create({
    model: 'llama-3.3-70b',
    messages: [{ role: 'user', content: 'What are the benefits of zero-retention logging?' }],
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

### 🌐 cURL Example

```bash
# Streaming Chat
curl -N http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-fb-live-demo-key-1234567890abcdef" \
  -d '{
    "model": "llama-3.3-70b",
    "messages": [{"role": "user", "content": "Hello Llama!"}],
    "stream": true
  }'
```

---

## ⚡ Request Pipeline & Headers

Every inference request passes through an 8-stage pipeline:

```
Request Arrival
  │
  ├─ 1. Auth: Parse `Authorization: Bearer sk-fb-...` ──> SHA-256 Hash ──> Cached (60s)
  │
  ├─ 2. Route: Resolve model against `models` registry (404 model_not_found if missing)
  │
  ├─ 3. Rate Limit: Token bucket check in Redis for Key (RPM) and Project (TPM)
  │     └─ If exceeded: Return 429 with `Retry-After` & `x-ratelimit-*` headers
  │
  ├─ 4. Admission Control: Acquire per-model Redis semaphore (capped at max_concurrency)
  │     └─ If full: Queue up to `QUEUE_WAIT_MS` (10s), then return 429 backpressure error
  │
  ├─ 5. Credit Reserve: Atomic Lua script reserves estimated cost based on token pricing
  │     └─ If insufficient: Return 402 `insufficient_credits`
  │
  ├─ 6. Proxy Upstream:
  │     ├─ Non-streaming: Await response and usage block
  │     ├─ Streaming: Pipe SSE straight through, capture TTFT on first chunk & final usage
  │     └─ Disconnect detection: `req.raw.on('close')` aborts upstream immediately
  │
  ├─ 7. Reconcile: Atomic Lua script reconciles actual usage (releases difference)
  │     └─ Release concurrency semaphore
  │
  └─ 8. Async Metering: Usage event enqueued to in-memory buffer, flushed to Postgres (1s/500 rows)
```

### Response Headers on Every Call

| Header | Description |
| :--- | :--- |
| `x-filybase-request-id` | Unique UUID assigned to the request |
| `x-filybase-model` | The canonical model ID resolved for the request |
| `x-filybase-latency-ms` | Total end-to-end execution latency in milliseconds |
| `x-filybase-ttft-ms` | Time To First Token in ms (Streaming SSE only) |
| `x-filybase-credits-used` | Exact credits deducted from account balance |
| `x-ratelimit-limit-requests` | Configured requests per minute (RPM) |
| `x-ratelimit-remaining-requests` | Remaining requests allowed in current window |
| `x-ratelimit-reset-requests` | Seconds until request bucket resets |
| `x-ratelimit-limit-tokens` | Configured tokens per minute (TPM) |
| `x-ratelimit-remaining-tokens` | Remaining tokens allowed in current window |
| `x-ratelimit-reset-tokens` | Seconds until token bucket resets |

---

## 💰 Credit & Pricing Model

- Base currency: **Credits**
- Exchange rate: **1 Credit = $1.00 / 500,000 = $0.000002** ($1.00 USD = 500,000 Credits)

### Formulae:

$$\text{Input Tokens Cost} = \left\lceil \frac{\text{Tokens} \times \text{price\_in\_per\_mtok} \times 500,000}{1,000,000} \right\rceil = \left\lceil \frac{\text{Tokens} \times \text{price\_in\_per\_mtok}}{2} \right\rceil$$

$$\text{Output Tokens Cost} = \left\lceil \frac{\text{Tokens} \times \text{price\_out\_per\_mtok} \times 500,000}{1,000,000} \right\rceil = \left\lceil \frac{\text{Tokens} \times \text{price\_out\_per\_mtok}}{2} \right\rceil$$

$$\text{Image Cost} = \left\lceil \text{Images} \times \text{price\_per\_image} \times 500,000 \right\rceil$$

$$\text{Audio Cost} = \left\lceil \frac{\text{Audio Sec}}{60} \times \text{price\_per\_audio\_min} \times 500,000 \right\rceil$$

---

## 🗄️ Database Schema & Monthly Partitions

PostgreSQL 16 schema with `citext`, UUID PKs, and monthly range partitioning on `usage_events`:

```sql
accounts(id uuid pk, email citext unique, password_hash text, name text, created_at timestamptz)
projects(id uuid pk, account_id uuid fk, name text, created_at timestamptz)
balances(account_id uuid pk fk, credits bigint not null default 0)
ledger(id bigserial pk, account_id uuid fk, delta bigint, reason text, ref text, created_at timestamptz)

api_keys(id uuid pk, project_id uuid fk, name text, key_hash bytea unique, prefix text, last4 text,
         revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz)

models(id text pk, display_name text, provider text, category text, engine text,
       upstream_url text, upstream_model text, ctx_len int, max_concurrency int,
       price_in_per_mtok numeric, price_out_per_mtok numeric, price_per_image numeric,
       price_per_audio_min numeric, status text default 'live')

endpoints(id uuid pk, project_id uuid fk, name text, model_id text fk,
          live bool default true, created_at timestamptz, unique(project_id, name))

usage_events(id bigserial, project_id uuid, key_id uuid, endpoint_id uuid,
             model_id text, ts timestamptz, in_tokens int, out_tokens int,
             images int, audio_sec int, latency_ms int, ttft_ms int,
             status_code int, cost_credits bigint, primary key (id, ts))
-- PARTITION BY RANGE (ts)

usage_hourly_rollup -- Materialized view refreshed every 60s for /v1/usage and /v1/endpoints
```

---

## 🚀 Quickstart & Deployment

### Option A: Docker Compose (Full Stack with TLS & Monitoring)

```bash
# 1. Clone repository & enter directory
git clone https://github.com/filybase/filybase-back.git
cd filybase-back

# 2. Configure environment
cp .env.example .env

# 3. Launch full stack (Gateway + Postgres + Redis + Caddy + Prometheus + Grafana)
docker compose up -d --build

# 4. Verify deployment
curl http://localhost:8080/healthz
```

### Option B: Local Node.js Development

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Run unit & integration test suite
npm test

# 4. Run full end-to-end smoke test (auto-boots test servers)
npm run test:smoke

# 5. Verify official OpenAI SDKs
npm run verify:sdk
python scripts/smoke_test.py
```

---

## 📡 Complete API Contract

### 🔑 Authentication & Sessions (Dashboard Only)
*Dashboard routes accept 15-minute JWTs. Inference rejects session JWTs.*

| Method | Route | Description |
| :--- | :--- | :--- |
| `POST` | `/v1/auth/signup` | Register account (`name`, `email`, `password`) using Argon2id |
| `POST` | `/v1/auth/login` | Login, issue JWT (15m) + httpOnly refresh cookie |
| `POST` | `/v1/auth/refresh` | Rotate session token family |
| `POST` | `/v1/auth/logout` | Clear refresh token cookie |
| `GET` | `/v1/auth/me` | Fetch authenticated account and project details |

### 🤖 Inference (OpenAI Compatible)
*Inference routes require `Authorization: Bearer sk-fb-...`.*

| Method | Route | Description |
| :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | Chat completions (supports `stream: true` SSE & non-streaming) |
| `POST` | `/v1/completions` | Text completions (supports `stream: true` & non-streaming) |
| `POST` | `/v1/embeddings` | Vector embeddings (TEI / sentence-transformers) |
| `POST` | `/v1/images/generations` | Image generation (Diffusers) |
| `POST` | `/v1/audio/transcriptions` | Multipart audio transcription up to 25MB (Whisper) |

### 📊 Dashboard, Usage & Keys
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/v1/models` | List available models, providers, context windows, and pricing |
| `GET` | `/v1/endpoints` | List endpoints with 24h request counts and p50 latency from rollup |
| `POST` | `/v1/endpoints` | Create a new custom named endpoint (`{ name, model }`) |
| `PATCH` | `/v1/endpoints/:id` | Toggle endpoint active status (`{ live: boolean }`) |
| `DELETE`| `/v1/endpoints/:id` | Delete endpoint |
| `GET` | `/v1/keys` | List API keys (prefix, last4, created_at, last_used_at, revoked_at) |
| `POST` | `/v1/keys` | Create `sk-fb-...` key (returned once only, SHA-256 hashed in DB) |
| `DELETE`| `/v1/keys/:id` | Revoke key immediately & purge Redis cache |
| `GET` | `/v1/usage?range=24h\|7d\|30d` | Aggregated usage metrics & hourly chart from materialized rollup |
| `GET` | `/v1/billing/plan` | Plan details, month-to-date spend, and estimated total |
| `GET` | `/v1/billing/invoices` | Invoices list (`id`, `date`, `amount`, `status`) |
| `GET` | `/v1/billing/cost-breakdown`| Model-by-model cost and token breakdown for `YYYY-MM` |
| `POST` | `/v1/billing/topup` | Add credits to account balance |

### 🩺 System & Observability
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/healthz` | Gateway uptime, memory, DB status, Redis status, and upstream health |
| `GET` | `/metrics` | Prometheus metrics scrape endpoint |

---

## 📈 Prometheus Metrics Reference

| Metric Name | Type | Description |
| :--- | :--- | :--- |
| `filybase_http_requests_total` | Counter | Total requests by `model`, `method`, `path`, `status_code` |
| `filybase_http_request_duration_seconds` | Histogram | Request latency histogram with p50/p90/p99 quantiles |
| `filybase_time_to_first_token_seconds` | Histogram | Time To First Token (TTFT) for streaming responses |
| `filybase_tokens_total` | Counter | Cumulative tokens served by `model` and `type` (`prompt`/`completion`) |
| `filybase_credits_consumed_total` | Counter | Cumulative credits billed per model |
| `filybase_model_active_concurrency` | Gauge | Current in-flight requests running on GPU per model |
| `filybase_queue_wait_duration_seconds` | Histogram | Time requests spend waiting in admission control semaphore queue |
| `filybase_rate_limit_hits_total` | Counter | Total rate limit breaches (`rpm` vs `tpm`) |
| `filybase_concurrency_rejections_total` | Counter | Requests dropped due to admission control queue timeout |

---

## 🔒 Security Hardening

- **Argon2id** password hashing (`time_cost=2`, `memory_cost=65536`, `parallelism=2`).
- **SHA-256 API Key Hashing**; plaintext keys are never stored in database.
- **Parametric SQL**: All queries use `$1, $2` parameters via `pg`.
- **Payload Limits**: 25MB for audio transcriptions, 1MB for all JSON payloads.
- **Strict CORS**: Allowlist configured via `CORS_ORIGINS`.
- **Zero Log Retention**: Sensitive headers (`Authorization`, `Cookie`) and request bodies (prompts, audio, images) are never logged or persisted.

---

## 📄 License

MIT © [FilyBase Team](https://filybase.com)
