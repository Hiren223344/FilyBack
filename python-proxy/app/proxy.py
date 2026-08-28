import json
from typing import Any, AsyncIterator, Callable

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import anthropic_compat as ac
from . import config, db
from .auth import require_proxy_auth

router = APIRouter(dependencies=[Depends(require_proxy_auth)])

Translator = Callable[[AsyncIterator[str], str], AsyncIterator[bytes]]


def _error(message: str, status_code: int, code: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"message": message, "type": "invalid_request_error", "code": code}},
    )


def _combine_system_prompt(base_prompt: str, model_prompt: str, caller_prompt: str) -> str:
    parts = [p.strip() for p in (base_prompt, model_prompt, caller_prompt) if p and p.strip()]
    return "\n\n".join(parts)


def _upstream_target(config_row) -> tuple[str, dict[str, str]]:
    base = config_row["provider_base_url"]
    if config_row["provider_type"] == "anthropic":
        return f"{base}/messages", {
            "x-api-key": config_row["provider_api_key"],
            "anthropic-version": config.ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }
    return f"{base}/chat/completions", {
        "Authorization": f"Bearer {config_row['provider_api_key']}",
        "Content-Type": "application/json",
    }


def _resolve_model(requested_model: str):
    if not requested_model:
        return None, _error("`model` is required", 400, "missing_model")
    config_row = db.get_model_by_model_id(requested_model)
    if config_row is None:
        return None, _error(f"Model '{requested_model}' is not configured on this proxy", 404, "model_not_found")
    return config_row, None


@router.get("/v1/models")
async def list_models() -> dict[str, Any]:
    rows = db.list_models()
    return {
        "object": "list",
        "data": [
            {"id": row["model_id"], "object": "model", "owned_by": "python-proxy", "created": 0}
            for row in rows
        ],
    }


# ---------------------------------------------------------------------------
# OpenAI-compatible entry point
# ---------------------------------------------------------------------------

@router.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return _error("Request body must be valid JSON", 400, "invalid_json")

    config_row, err = _resolve_model(payload.get("model"))
    if err:
        return err

    messages = payload.get("messages")
    if not isinstance(messages, list):
        return _error("`messages` must be a list", 400, "invalid_messages")

    caller_system_prompt = "\n\n".join(
        m.get("content", "") for m in messages if m.get("role") == "system" and isinstance(m.get("content"), str)
    )
    combined_system_prompt = _combine_system_prompt(
        db.get_base_system_prompt(), config_row["system_prompt"], caller_system_prompt
    )

    url, headers = _upstream_target(config_row)
    is_stream = bool(payload.get("stream"))
    requested_model = payload["model"]

    if config_row["provider_type"] == "anthropic":
        upstream_payload = ac.openai_payload_to_anthropic(
            payload, config_row["provider_model_id"], combined_system_prompt
        )
        if is_stream:
            return await _proxy_stream_translated(url, headers, upstream_payload, ac.anthropic_sse_to_openai_chunks, requested_model)
        return await _proxy_json(url, headers, upstream_payload, lambda data: ac.anthropic_response_to_openai(data, requested_model))

    # OpenAI-shaped provider: merge system prompt back into messages, swap model, passthrough
    non_system = [m for m in messages if m.get("role") != "system"]
    new_messages = [{"role": "system", "content": combined_system_prompt}, *non_system] if combined_system_prompt.strip() else non_system
    upstream_payload = {**payload, "model": config_row["provider_model_id"], "messages": new_messages}

    if is_stream:
        return await _proxy_stream_raw(url, headers, upstream_payload)
    return await _proxy_json(url, headers, upstream_payload)


# ---------------------------------------------------------------------------
# Anthropic-compatible entry point
# ---------------------------------------------------------------------------

@router.post("/v1/messages")
async def messages(request: Request) -> Any:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return _error("Request body must be valid JSON", 400, "invalid_json")

    config_row, err = _resolve_model(payload.get("model"))
    if err:
        return err

    if not isinstance(payload.get("messages"), list):
        return _error("`messages` must be a list", 400, "invalid_messages")

    caller_system_prompt = ac.flatten_content_to_text(payload.get("system", ""))
    combined_system_prompt = _combine_system_prompt(
        db.get_base_system_prompt(), config_row["system_prompt"], caller_system_prompt
    )

    url, headers = _upstream_target(config_row)
    is_stream = bool(payload.get("stream"))
    requested_model = payload["model"]

    if config_row["provider_type"] == "openai":
        upstream_payload = ac.anthropic_payload_to_openai(
            payload, config_row["provider_model_id"], combined_system_prompt
        )
        if is_stream:
            return await _proxy_stream_translated(url, headers, upstream_payload, ac.openai_sse_to_anthropic_events, requested_model)
        return await _proxy_json(url, headers, upstream_payload, lambda data: ac.openai_response_to_anthropic(data, requested_model))

    # Anthropic-shaped provider: passthrough with model swap + merged system prompt
    upstream_payload = {**payload, "model": config_row["provider_model_id"]}
    if combined_system_prompt.strip():
        upstream_payload["system"] = combined_system_prompt
    else:
        upstream_payload.pop("system", None)

    if is_stream:
        return await _proxy_stream_raw(url, headers, upstream_payload)
    return await _proxy_json(url, headers, upstream_payload)


@router.post("/v1/messages/count_tokens")
async def count_tokens(request: Request) -> Any:
    """Anthropic's token-counting endpoint. Claude Code calls this to manage its
    context budget, so a 404 here breaks it even though no completion is generated."""
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return _error("Request body must be valid JSON", 400, "invalid_json")

    config_row, err = _resolve_model(payload.get("model"))
    if err:
        return err

    caller_system_prompt = ac.flatten_content_to_text(payload.get("system", ""))
    combined_system_prompt = _combine_system_prompt(
        db.get_base_system_prompt(), config_row["system_prompt"], caller_system_prompt
    )

    if config_row["provider_type"] == "anthropic":
        base = config_row["provider_base_url"]
        url = f"{base}/messages/count_tokens"
        headers = {
            "x-api-key": config_row["provider_api_key"],
            "anthropic-version": config.ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }
        upstream_payload = {**payload, "model": config_row["provider_model_id"]}
        if combined_system_prompt.strip():
            upstream_payload["system"] = combined_system_prompt
        else:
            upstream_payload.pop("system", None)
        return await _proxy_json(url, headers, upstream_payload)

    # OpenAI-shaped providers have no equivalent endpoint; estimate locally.
    return JSONResponse(content={"input_tokens": ac.estimate_token_count(payload, combined_system_prompt)})


# ---------------------------------------------------------------------------
# Upstream call helpers
# ---------------------------------------------------------------------------

async def _proxy_json(
    url: str, headers: dict[str, str], payload: dict[str, Any], translate: Callable[[dict], dict] | None = None
) -> JSONResponse:
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(url, headers=headers, json=payload)
        except httpx.RequestError as exc:
            return _error(f"Failed to reach upstream provider: {exc}", 502, "upstream_unreachable")
    try:
        body = resp.json()
    except ValueError:
        body = {"error": {"message": resp.text, "type": "upstream_error", "code": "invalid_upstream_response"}}
    if translate is not None and resp.status_code < 400:
        body = translate(body)
    return JSONResponse(status_code=resp.status_code, content=body)


async def _proxy_stream_raw(url: str, headers: dict[str, str], payload: dict[str, Any]) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=None)

    async def event_gen():
        try:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    yield f"data: {body.decode(errors='replace')}\n\n".encode()
                    return
                async for chunk in resp.aiter_raw():
                    if chunk:
                        yield chunk
        except httpx.RequestError as exc:
            err = json.dumps({"error": {"message": f"Failed to reach upstream provider: {exc}", "type": "upstream_unreachable"}})
            yield f"data: {err}\n\n".encode()
        finally:
            await client.aclose()

    return StreamingResponse(event_gen(), media_type="text/event-stream")


async def _proxy_stream_translated(
    url: str, headers: dict[str, str], payload: dict[str, Any], translator: Translator, requested_model: str
) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=None)

    async def event_gen():
        try:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    yield f"data: {body.decode(errors='replace')}\n\n".encode()
                    return
                async for chunk in translator(resp.aiter_lines(), requested_model):
                    yield chunk
        except httpx.RequestError as exc:
            err = json.dumps({"error": {"message": f"Failed to reach upstream provider: {exc}", "type": "upstream_unreachable"}})
            yield f"data: {err}\n\n".encode()
        finally:
            await client.aclose()

    return StreamingResponse(event_gen(), media_type="text/event-stream")
