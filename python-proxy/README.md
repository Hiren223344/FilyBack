# Python Model Proxy

A small FastAPI proxy with a web dashboard for mapping your own model IDs to
real provider endpoints (OpenAI, Anthropic, OpenAI-compatible gateways,
self-hosted vLLM, OpenRouter, etc.), while merging system prompts
server-side.

For each entry you configure:

- **Model ID** — the name your callers pass as `"model"`.
- **Provider API format** — `openai` (`/chat/completions`, `Authorization:
  Bearer`) or `anthropic` (`/messages`, `x-api-key` + `anthropic-version`).
- **Provider base URL** — e.g. `https://api.openai.com/v1` or
  `https://api.anthropic.com/v1`.
- **Provider API key** — stored server-side, never returned to callers.
- **Provider's model ID** — the real model name sent upstream, e.g. `gpt-4o`
  or `claude-opus-5`.
- **System prompt** — merged as: `base system prompt` (dashboard-wide) + `this
  model's system prompt` + `the caller's own system prompt` (if any), in that
  order.

## Anthropic compatibility

The proxy exposes **both** an OpenAI-style endpoint (`/v1/chat/completions`)
and an Anthropic-style endpoint (`/v1/messages`), and each configured model
can point at **either** an OpenAI-style or an Anthropic-style provider. The
proxy translates between the two shapes (including streaming) whenever the
caller's format and the provider's format don't match, e.g.:

- Anthropic SDK client → `/v1/messages` → provider configured as `openai` →
  request/response translated to/from OpenAI's shape.
- OpenAI SDK client → `/v1/chat/completions` → provider configured as
  `anthropic` → request/response translated to/from Anthropic's Messages API
  shape.

Only text content is translated (no tool-use/image blocks) — matching
formats (OpenAI↔OpenAI, Anthropic↔Anthropic) are passed straight through
untouched.

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:9000",
    api_key="<PROXY_API_KEY>",
)

resp = client.messages.create(
    model="my-claude-model",  # a Model ID you configured, provider can be either type
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

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
