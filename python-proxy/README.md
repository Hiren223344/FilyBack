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

Text content and tool use (tool calls + tool results) are translated in both
directions — this is what makes agentic clients like Claude Code work through
an OpenAI-type provider, since they rely almost entirely on tool calling.
Image content blocks are not translated. Matching formats (OpenAI↔OpenAI,
Anthropic↔Anthropic) skip shape translation, but still get the same text
cleanup below (EOS-token/`<think>` stripping) applied.

As a bonus, translated responses also get cleaned up:

- Raw EOS/special tokens some OpenAI-compatible inference servers leak into
  content when a model's stop sequence isn't configured server-side (e.g.
  DeepSeek's `<｜end▁of▁sentence｜>`) are stripped.
- `<think>...</think>` reasoning blocks from DeepSeek-R1-style models are
  stripped from the visible answer — including the case where a server
  injects `<think>` into the prompt template and only echoes back a bare
  `</think>` with no matching open tag, however long that reasoning runs. In
  streaming responses, since there's no way to know whether in-progress text
  is reasoning or a real answer until `</think>` shows up (or doesn't),
  output is held back until that's resolved — a response with a dangling
  close streams normally from that point on, while a response that never
  uses any tag at all arrives as one lump at the end instead of
  token-by-token. `<think>` blocks with a visible open tag stream normally
  before the tag (nothing to hold back for).

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

## Claude Code support

Point the Claude Code CLI itself at this proxy. It always speaks the
Anthropic Messages API, so it works whether the model behind it is
configured as an `anthropic` or `openai` provider — meaning you can run
Claude Code against, say, a GPT-4o backend through this proxy.

1. Add a model entry whose **Model ID** matches the model name Claude Code
   will send (its current default main/small-fast model names — check
   `claude --version`'s docs, or just override them, see below).
2. Point Claude Code at the proxy:

   ```bash
   export ANTHROPIC_BASE_URL=http://localhost:9000
   export ANTHROPIC_API_KEY=<PROXY_API_KEY>       # sent as x-api-key
   # or: export ANTHROPIC_AUTH_TOKEN=<PROXY_API_KEY>  # sent as Authorization: Bearer

   # Make Claude Code request exactly the Model IDs you configured:
   export ANTHROPIC_MODEL=my-claude-model
   export ANTHROPIC_SMALL_FAST_MODEL=my-fast-model

   claude
   ```

`ANTHROPIC_BASE_URL` has no `/v1` suffix — the SDK appends `/v1/messages`
itself, matching this proxy's routes. The proxy also implements
`/v1/messages/count_tokens` (Claude Code calls this to manage its context
budget): for `anthropic`-type providers it's forwarded upstream, for
`openai`-type providers it's a local character-based estimate since OpenAI
has no equivalent endpoint.

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
