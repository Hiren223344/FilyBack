"""Translation between OpenAI's chat-completions shape and Anthropic's Messages API shape,
for both request bodies and (non-streaming + streaming) responses.

Handles text content and tool use/tool result blocks (needed for Claude Code and other
agentic clients, which rely almost entirely on tool calling). Image content blocks are
not translated.
"""
import json
import re
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

# Raw special/EOS tokens some OpenAI-compatible inference servers (e.g. DeepSeek-family
# models behind vLLM/text-generation-webui without a configured stop sequence) leak into
# message content instead of stripping. Defensively scrub them.
_LEAKED_SPECIAL_TOKENS = re.compile(
    r"<｜end▁of▁sentence｜>|<\|end_of_sentence\|>|<\|endoftext\|>|<\|im_end\|>"
)


def _clean_text(text: str) -> str:
    return _LEAKED_SPECIAL_TOKENS.sub("", text) if text else text


# Some reasoning models (DeepSeek-R1 style) emit a <think>...</think> block before the
# real answer. Some inference servers inject "<think>\n" as an assistant-turn prefix
# that isn't echoed back, so the response can start already "inside" a think block —
# only a bare </think> appears, with no matching opening tag. Strip both cases.
_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_DANGLING_THINK_CLOSE = re.compile(r"^.*?</think>", re.DOTALL | re.IGNORECASE)
_MAX_THINK_TAG_LEN = len("</think>")


def _strip_thinking(text: str) -> str:
    if not text:
        return text
    text = _THINK_BLOCK.sub("", text)
    if "</think>" in text.lower():
        text = _DANGLING_THINK_CLOSE.sub("", text)
    return text.strip()


class _ThinkTagStripper:
    """Streaming counterpart to _strip_thinking: filters <think>...</think> (including
    the dangling-close-with-no-open case) out of a sequence of text deltas.

    Without a visible <think> open tag, there's no way to know whether in-progress text
    is reasoning or a real answer until </think> actually shows up (or the stream ends
    without one). So until that's resolved, everything is held back rather than risking
    a partial reasoning-text leak — trading away token-by-token streaming for a response
    that turns out to have no tags at all (it arrives as one lump at the end instead),
    in exchange for never leaking a dangling close no matter how long the reasoning is.
    """

    def __init__(self) -> None:
        self._buf = ""
        self._in_think = False
        self._decided = False  # False until we've resolved whether this stream opens
        # with a dangling (open-tag-less) think block.

    def feed(self, text: str) -> str:
        if not text:
            return ""
        self._buf += text
        out = []
        while True:
            if self._in_think:
                idx = self._buf.find("</think>")
                if idx == -1:
                    break
                self._buf = self._buf[idx + len("</think>"):].lstrip()
                self._in_think = False
                self._decided = True
                continue
            open_idx = self._buf.find("<think>")
            close_idx = self._buf.find("</think>")
            if open_idx != -1 and (close_idx == -1 or open_idx < close_idx):
                out.append(self._buf[:open_idx])
                self._buf = self._buf[open_idx + len("<think>"):]
                self._in_think = True
                self._decided = True
                continue
            if close_idx != -1:
                # bare </think> with no preceding <think>: everything before it
                # (held, not yet emitted) was thinking content too.
                self._buf = self._buf[close_idx + len("</think>"):].lstrip()
                self._decided = True
                continue
            break

        if self._in_think or not self._decided:
            return "".join(out)

        if self._buf:
            safe_len = max(0, len(self._buf) - (_MAX_THINK_TAG_LEN - 1))
            out.append(self._buf[:safe_len])
            self._buf = self._buf[safe_len:]
        return "".join(out)

    def flush(self) -> str:
        remaining = "" if self._in_think else self._buf
        self._buf = ""
        return remaining


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


def _safe_json_loads(text: str) -> dict[str, Any]:
    try:
        return json.loads(text) if text else {}
    except json.JSONDecodeError:
        return {}


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
        if role == "system":
            continue
        if role == "tool":
            anthropic_messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": m.get("tool_call_id", ""),
                            "content": flatten_content_to_text(m.get("content", "")),
                        }
                    ],
                }
            )
            continue
        if role == "assistant" and m.get("tool_calls"):
            blocks = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m["tool_calls"]:
                fn = tc.get("function", {})
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": tc.get("id") or f"toolu_{uuid.uuid4().hex}",
                        "name": fn.get("name", ""),
                        "input": _safe_json_loads(fn.get("arguments", "")),
                    }
                )
            anthropic_messages.append({"role": "assistant", "content": blocks})
            continue
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

    tools = payload.get("tools")
    if tools:
        body["tools"] = [
            {
                "name": t["function"]["name"],
                "description": t["function"].get("description", ""),
                "input_schema": t["function"].get("parameters") or {"type": "object", "properties": {}},
            }
            for t in tools
            if t.get("type") == "function"
        ]
    tool_choice = payload.get("tool_choice")
    if tool_choice == "auto":
        body["tool_choice"] = {"type": "auto"}
    elif tool_choice == "required":
        body["tool_choice"] = {"type": "any"}
    elif isinstance(tool_choice, dict):
        name = (tool_choice.get("function") or {}).get("name")
        if name:
            body["tool_choice"] = {"type": "tool", "name": name}
    return body


def anthropic_response_to_openai(data: dict[str, Any], requested_model_id: str) -> dict[str, Any]:
    text_parts = []
    tool_calls = []
    for b in data.get("content", []):
        if b.get("type") == "text":
            text_parts.append(_clean_text(_strip_thinking(b.get("text", ""))))
        elif b.get("type") == "tool_use":
            tool_calls.append(
                {
                    "id": b.get("id") or f"call_{uuid.uuid4().hex}",
                    "type": "function",
                    "function": {"name": b.get("name", ""), "arguments": json.dumps(b.get("input", {}))},
                }
            )

    message: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts) or None}
    if tool_calls:
        message["tool_calls"] = tool_calls

    finish_reason = _STOP_REASON_TO_OPENAI_FINISH.get(data.get("stop_reason"), "stop")
    usage = data.get("usage", {})
    prompt_tokens = usage.get("input_tokens", 0)
    completion_tokens = usage.get("output_tokens", 0)
    return {
        "id": data.get("id", f"chatcmpl-{uuid.uuid4().hex}"),
        "object": "chat.completion",
        "model": requested_model_id,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
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
    # anthropic content-block index -> openai tool_calls index (0-based, tool calls only)
    tool_block_openai_index: dict[int, int] = {}
    next_tool_index = 0
    stripper = _ThinkTagStripper()

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

        if event_type == "content_block_start":
            block = data.get("content_block", {})
            if block.get("type") == "tool_use":
                idx = data.get("index", 0)
                openai_idx = next_tool_index
                next_tool_index += 1
                tool_block_openai_index[idx] = openai_idx
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "model": requested_model_id,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": openai_idx,
                                        "id": block.get("id") or f"call_{uuid.uuid4().hex}",
                                        "type": "function",
                                        "function": {"name": block.get("name", ""), "arguments": ""},
                                    }
                                ]
                            },
                            "finish_reason": None,
                        }
                    ],
                }
                yield f"data: {json.dumps(chunk)}\n\n".encode()

        elif event_type == "content_block_delta":
            delta = data.get("delta", {})
            idx = data.get("index", 0)
            if delta.get("type") == "text_delta" and delta.get("text"):
                visible = _clean_text(stripper.feed(delta["text"]))
                if visible:
                    chunk = {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "model": requested_model_id,
                        "choices": [{"index": 0, "delta": {"content": visible}, "finish_reason": None}],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n".encode()
            elif delta.get("type") == "input_json_delta" and idx in tool_block_openai_index:
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "model": requested_model_id,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {"index": tool_block_openai_index[idx], "function": {"arguments": delta.get("partial_json", "")}}
                                ]
                            },
                            "finish_reason": None,
                        }
                    ],
                }
                yield f"data: {json.dumps(chunk)}\n\n".encode()

        elif event_type == "content_block_stop":
            visible = _clean_text(stripper.flush())
            if visible:
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "model": requested_model_id,
                    "choices": [{"index": 0, "delta": {"content": visible}, "finish_reason": None}],
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
        role = m.get("role")
        content = m.get("content")

        if isinstance(content, str):
            messages.append({"role": role, "content": content})
            continue
        if not isinstance(content, list):
            messages.append({"role": role, "content": flatten_content_to_text(content)})
            continue

        if role == "assistant":
            text_parts = []
            tool_calls = []
            for block in content:
                btype = block.get("type")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    tool_calls.append(
                        {
                            "id": block.get("id") or f"call_{uuid.uuid4().hex}",
                            "type": "function",
                            "function": {"name": block.get("name", ""), "arguments": json.dumps(block.get("input", {}))},
                        }
                    )
            msg: dict[str, Any] = {"role": "assistant", "content": "\n".join(text_parts) or None}
            if tool_calls:
                msg["tool_calls"] = tool_calls
            messages.append(msg)
            continue

        if role == "user":
            text_parts = []
            tool_results = []
            for block in content:
                btype = block.get("type")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "tool_result":
                    tool_results.append(block)
            if text_parts:
                messages.append({"role": "user", "content": "\n".join(text_parts)})
            for tr in tool_results:
                tr_content = tr.get("content")
                tr_text = tr_content if isinstance(tr_content, str) else flatten_content_to_text(tr_content)
                messages.append({"role": "tool", "tool_call_id": tr.get("tool_use_id", ""), "content": tr_text})
            continue

        messages.append({"role": role, "content": flatten_content_to_text(content)})

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

    tools = payload.get("tools")
    if tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.get("name"),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
                },
            }
            for t in tools
        ]
    tool_choice = payload.get("tool_choice")
    if tool_choice:
        tc_type = tool_choice.get("type")
        if tc_type == "auto":
            body["tool_choice"] = "auto"
        elif tc_type == "any":
            body["tool_choice"] = "required"
        elif tc_type == "tool" and tool_choice.get("name"):
            body["tool_choice"] = {"type": "function", "function": {"name": tool_choice["name"]}}
    return body


def openai_response_to_anthropic(data: dict[str, Any], requested_model_id: str) -> dict[str, Any]:
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message", {}) or {}

    content_blocks: list[dict[str, Any]] = []
    text = message.get("content")
    if text:
        cleaned = _clean_text(_strip_thinking(text))
        if cleaned:
            content_blocks.append({"type": "text", "text": cleaned})
    for tc in message.get("tool_calls") or []:
        fn = tc.get("function", {})
        content_blocks.append(
            {
                "type": "tool_use",
                "id": tc.get("id") or f"toolu_{uuid.uuid4().hex}",
                "name": fn.get("name", ""),
                "input": _safe_json_loads(fn.get("arguments", "")),
            }
        )
    if not content_blocks:
        content_blocks = [{"type": "text", "text": ""}]

    stop_reason = _OPENAI_FINISH_TO_STOP_REASON.get(choice.get("finish_reason"), "end_turn")
    usage = data.get("usage", {})
    return {
        "id": data.get("id", f"msg_{uuid.uuid4().hex}"),
        "type": "message",
        "role": "assistant",
        "model": requested_model_id,
        "content": content_blocks,
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

    text_block_index: int | None = None
    # openai tool_calls delta "index" -> {"anthropic_index", "opened"}
    tool_blocks: dict[int, dict[str, Any]] = {}
    next_block_index = 0
    finish_reason = "stop"
    stripper = _ThinkTagStripper()

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
            visible = _clean_text(stripper.feed(text))
            if visible:
                if text_block_index is None:
                    text_block_index = next_block_index
                    next_block_index += 1
                    yield sse(
                        "content_block_start",
                        {"type": "content_block_start", "index": text_block_index, "content_block": {"type": "text", "text": ""}},
                    )
                yield sse(
                    "content_block_delta",
                    {"type": "content_block_delta", "index": text_block_index, "delta": {"type": "text_delta", "text": visible}},
                )

        for tc in delta.get("tool_calls") or []:
            oi = tc.get("index", 0)
            fn = tc.get("function", {}) or {}
            if oi not in tool_blocks:
                tool_blocks[oi] = {"anthropic_index": None, "id": None, "name": None, "buffered": ""}
            entry = tool_blocks[oi]
            if tc.get("id"):
                entry["id"] = tc["id"]
            if fn.get("name"):
                entry["name"] = fn["name"]
            if entry["anthropic_index"] is None and entry["id"] and entry["name"]:
                entry["anthropic_index"] = next_block_index
                next_block_index += 1
                yield sse(
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": entry["anthropic_index"],
                        "content_block": {"type": "tool_use", "id": entry["id"], "name": entry["name"], "input": {}},
                    },
                )
                if entry["buffered"]:
                    yield sse(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": entry["anthropic_index"],
                            "delta": {"type": "input_json_delta", "partial_json": entry["buffered"]},
                        },
                    )
                    entry["buffered"] = ""
            if fn.get("arguments"):
                if entry["anthropic_index"] is not None:
                    yield sse(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": entry["anthropic_index"],
                            "delta": {"type": "input_json_delta", "partial_json": fn["arguments"]},
                        },
                    )
                else:
                    entry["buffered"] += fn["arguments"]

        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]

    remainder = _clean_text(stripper.flush())
    if remainder:
        if text_block_index is None:
            text_block_index = next_block_index
            next_block_index += 1
            yield sse(
                "content_block_start",
                {"type": "content_block_start", "index": text_block_index, "content_block": {"type": "text", "text": ""}},
            )
        yield sse(
            "content_block_delta",
            {"type": "content_block_delta", "index": text_block_index, "delta": {"type": "text_delta", "text": remainder}},
        )

    if text_block_index is not None:
        yield sse("content_block_stop", {"type": "content_block_stop", "index": text_block_index})
    for entry in tool_blocks.values():
        if entry["anthropic_index"] is not None:
            yield sse("content_block_stop", {"type": "content_block_stop", "index": entry["anthropic_index"]})

    yield sse(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": _OPENAI_FINISH_TO_STOP_REASON.get(finish_reason, "end_turn")},
            "usage": {"output_tokens": 0},
        },
    )
    yield sse("message_stop", {"type": "message_stop"})


# ---------------------------------------------------------------------------
# Same-format passthrough with cleaning (caller and provider already agree on
# shape — e.g. an OpenAI-SDK-style client hitting an openai-type provider — so no
# translation is needed, only EOS-token/<think> cleanup of text content).
# ---------------------------------------------------------------------------

def clean_openai_response(data: dict[str, Any], requested_model_id: str) -> dict[str, Any]:
    data["model"] = requested_model_id
    for choice in data.get("choices") or []:
        message = choice.get("message") or {}
        if message.get("content"):
            message["content"] = _clean_text(_strip_thinking(message["content"])) or None
    return data


async def clean_openai_sse_stream(lines: AsyncIterator[str], requested_model_id: str) -> AsyncIterator[bytes]:
    stripper = _ThinkTagStripper()
    async for line in lines:
        if not line.startswith("data:"):
            continue
        data_str = line[len("data:"):].strip()
        if not data_str:
            continue
        if data_str == "[DONE]":
            remainder = _clean_text(stripper.flush())
            if remainder:
                trailer = {"model": requested_model_id, "choices": [{"index": 0, "delta": {"content": remainder}, "finish_reason": None}]}
                yield f"data: {json.dumps(trailer)}\n\n".encode()
            yield b"data: [DONE]\n\n"
            continue
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            yield f"data: {data_str}\n\n".encode()
            continue
        data["model"] = requested_model_id
        for choice in data.get("choices") or []:
            delta = choice.get("delta") or {}
            if delta.get("content"):
                delta["content"] = _clean_text(stripper.feed(delta["content"]))
        yield f"data: {json.dumps(data)}\n\n".encode()


def clean_anthropic_response(data: dict[str, Any], requested_model_id: str) -> dict[str, Any]:
    data["model"] = requested_model_id
    for block in data.get("content") or []:
        if block.get("type") == "text":
            block["text"] = _clean_text(_strip_thinking(block.get("text", "")))
    return data


async def clean_anthropic_sse_stream(lines: AsyncIterator[str], requested_model_id: str) -> AsyncIterator[bytes]:
    stripper = _ThinkTagStripper()
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

        if event_type == "message_start" and "message" in data:
            data["message"]["model"] = requested_model_id
            yield sse(event_type, data)
            continue

        if event_type == "content_block_delta" and data.get("delta", {}).get("type") == "text_delta":
            data["delta"]["text"] = _clean_text(stripper.feed(data["delta"].get("text", "")))
            yield sse(event_type, data)
            continue

        if event_type == "content_block_stop":
            remainder = _clean_text(stripper.flush())
            if remainder:
                idx = data.get("index", 0)
                yield sse(
                    "content_block_delta",
                    {"type": "content_block_delta", "index": idx, "delta": {"type": "text_delta", "text": remainder}},
                )
            yield sse(event_type, data)
            continue

        yield sse(event_type, data)
