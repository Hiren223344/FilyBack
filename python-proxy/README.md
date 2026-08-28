# Python Model Proxy

A small FastAPI proxy with a web dashboard for mapping your own model IDs to
real provider endpoints (OpenAI, Anthropic-compatible gateways, self-hosted
vLLM, OpenRouter, etc.), while merging system prompts server-side.

For each entry you configure:

- **Model ID** — the name your callers pass as `"model"`.
- **Provider base URL** — e.g. `https://api.openai.com/v1`.
- **Provider API key** — stored server-side, never returned to callers.
- **Provider's model ID** — the real model name sent upstream, e.g. `gpt-4o`.
- **System prompt** — merged as: `base system prompt` (dashboard-wide) + `this
  model's system prompt` + `the caller's own system prompt` (if any), in that
  order.

## Setup

```bash
cd python-proxy
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # edit DASHBOARD_PASSWORD, PROXY_API_KEY, etc.
python run.py
```

- Dashboard: `http://localhost:9000/` (HTTP Basic Auth, `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`)
- Proxy: `http://localhost:9000/v1/chat/completions` (OpenAI-compatible; set
  `PROXY_API_KEY` in `.env` and send it as `Authorization: Bearer <key>` from
  callers)

## Usage

```python
import openai

client = openai.OpenAI(
    base_url="http://localhost:9000/v1",
    api_key="<PROXY_API_KEY>",
)

resp = client.chat.completions.create(
    model="my-gpt4",  # the Model ID you configured in the dashboard
    messages=[{"role": "user", "content": "Hello!"}],
)
```

The proxy looks up `my-gpt4` in its config, swaps in the provider's real
model ID and API key, prepends the merged system prompt, and forwards the
request (streaming included) to the provider's `/chat/completions` endpoint.

Config is stored in a local SQLite file (`DATABASE_PATH`, default
`./data/proxy.db`).
