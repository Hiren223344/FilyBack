"""Translation between OpenAI's chat-completions shape and Anthropic's Messages API shape,
for both request bodies and (non-streaming + streaming) responses.

Scope: text-only content. Tool use / image blocks are not translated.
"""
import json
import uuid
from typing import Any, AsyncIterator

_STOP_REASON_TO_OPENAI_FINISH = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
}
_OPENAI_FINISH_TO_STOP_REASON = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "content_filter": "end_turn",
}


def flatten_content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return ""


def sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def estimate_token_count(payload: dict[str, Any], system_prompt: str) -> int:
    """Rough char/4 estimate, used only for providers with no native token-counting
    endpoint (e.g. OpenAI). Good enough for Claude Code's context-budget checks."""
    text = system_prompt
    for m in payload.get("messages", []):
        text += flatten_content_to_text(m.get("content", ""))
    return max(1, round(len(text) / 4))


# ---------------------------------------------------------------------------
# OpenAI-shaped request -> Anthropic-shaped request (used when the caller
# speaks OpenAI's /v1/chat/completions but the configured provider is Anthropic)
# ---------------------------------------------------------------------------

def openai_payload_to_anthropic(
    payload: dict[str, Any], provider_model_id: str, combined_system_prompt: str
) -> dict[str, Any]:
    anthropic_messages = []
    for m in payload.get("messages", []):
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        anthropic_messages.append({"role": role, "content": flatten_content_to_text(m.get("content", ""))})

    body: dict[str, Any] = {
        "model": provider_model_id,
        "messages": anthropic_messages,
        "max_tokens": payload.get("max_tokens") or 1024,
        "stream": bool(payload.get("stream", False)),
    }
    if combined_system_prompt.strip():
        body["system"] = combined_system_prompt
    if "temperature" in payload:
        body["temperature"] = payload["temperature"]
    if "top_p" in payload:
        body["top_p"] = payload["top_p"]
    stop = payload.get("stop")
    if stop:
        body["stop_sequences"] = stop if isinstance(stop, list) else [stop]
    return body


def anthropic_response_to_openai(data: dict[str, Any], requested_model_id: str) -> dict[str, Any]:
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    finish_reason = _STOP_REASON_TO_OPENAI_FINISH.get(data.get("stop_reason"), "stop")
    usage = data.get("usage", {})
    prompt_tokens = usage.get("input_tokens", 0)
    completion_tokens = usage.get("output_tokens", 0)
    return {
        "id": data.get("id", f"chatcmpl-{uuid.uuid4().hex}"),
        "object": "chat.completion",
        "model": requested_model_id,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


async def anthropic_sse_to_openai_chunks(
    lines: AsyncIterator[str], requested_model_id: str
) -> AsyncIterator[bytes]:
    chunk_id = f"chatcmpl-{uuid.uuid4().hex}"
    event_type = None
    async for line in lines:
        if line.startswith("event:"):
            event_type = line[len("event:"):].strip()
            continue
        if not line.startswith("data:"):
            continue
        data_str = line[len("data:"):].strip()
        if not data_str:
            continue
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        if event_type == "content_block_delta":
            delta = data.get("delta", {})
            if delta.get("type") == "text_delta" and delta.get("text"):
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "model": requested_model_id,
                    "choices": [{"index": 0, "delta": {"content": delta["text"]}, "finish_reason": None}],
                }
                yield f"data: {json.dumps(chunk)}\n\n".encode()
        elif event_type == "message_delta":
            stop_reason = data.get("delta", {}).get("stop_reason")
            if stop_reason:
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "model": requested_model_id,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {},
                            "finish_reason": _STOP_REASON_TO_OPENAI_FINISH.get(stop_reason, "stop"),
                        }
                    ],
                }
                yield f"data: {json.dumps(chunk)}\n\n".encode()
        elif event_type == "message_stop":
            yield b"data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# Anthropic-shaped request -> OpenAI-shaped request (used when the caller
# speaks Anthropic's /v1/messages but the configured provider is OpenAI-compatible)
# ---------------------------------------------------------------------------

def anthropic_payload_to_openai(
    payload: dict[str, Any], provider_model_id: str, combined_system_prompt: str
) -> dict[str, Any]:
    messages = []
    if combined_system_prompt.strip():
        messages.append({"role": "system", "content": combined_system_prompt})
    for m in payload.get("messages", []):
        messages.append({"role": m.get("role"), "content": flatten_content_to_text(m.get("content", ""))})

    body: dict[str, Any] = {
        "model": provider_model_id,
        "messages": messages,
        "stream": bool(payload.get("stream", False)),
    }
    if "max_tokens" in payload:
        body["max_tokens"] = payload["max_tokens"]
    if "temperature" in payload:
        body["temperature"] = payload["temperature"]
    if "top_p" in payload:
        body["top_p"] = payload["top_p"]
    stop_sequences = payload.get("stop_sequences")
    if stop_sequences:
        body["stop"] = stop_sequences
    return body


def openai_response_to_anthropic(data: dict[str, Any], requested_model_id: str) -> dict[str, Any]:
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message", {})
    text = message.get("content") or ""
    stop_reason = _OPENAI_FINISH_TO_STOP_REASON.get(choice.get("finish_reason"), "end_turn")
    usage = data.get("usage", {})
    return {
        "id": data.get("id", f"msg_{uuid.uuid4().hex}"),
        "type": "message",
        "role": "assistant",
        "model": requested_model_id,
        "content": [{"type": "text", "text": text}],
        "stop_reason": stop_reason,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


async def openai_sse_to_anthropic_events(
    lines: AsyncIterator[str], requested_model_id: str
) -> AsyncIterator[bytes]:
    msg_id = f"msg_{uuid.uuid4().hex}"
    yield sse(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": requested_model_id,
                "content": [],
                "stop_reason": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        },
    )
    yield sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})

    finish_reason = "stop"
    async for line in lines:
        if not line.startswith("data:"):
            continue
        data_str = line[len("data:"):].strip()
        if data_str == "[DONE]" or not data_str:
            continue
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            continue
        choice = (data.get("choices") or [{}])[0]
        delta = choice.get("delta", {})
        text = delta.get("content")
        if text:
            yield sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}})
        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]

    yield sse("content_block_stop", {"type": "content_block_stop", "index": 0})
    yield sse(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": _OPENAI_FINISH_TO_STOP_REASON.get(finish_reason, "end_turn")},
            "usage": {"output_tokens": 0},
        },
    )
    yield sse("message_stop", {"type": "message_stop"})
