import json
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import db
from .auth import require_proxy_auth

router = APIRouter(dependencies=[Depends(require_proxy_auth)])


def _error(message: str, status_code: int, code: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"message": message, "type": "invalid_request_error", "code": code}},
    )


def _build_messages(messages: list[dict[str, Any]], combined_system_prompt: str) -> list[dict[str, Any]]:
    non_system = [m for m in messages if m.get("role") != "system"]
    if not combined_system_prompt.strip():
        return non_system
    return [{"role": "system", "content": combined_system_prompt}, *non_system]


def _combine_system_prompt(base_prompt: str, model_prompt: str, caller_prompt: str) -> str:
    parts = [p.strip() for p in (base_prompt, model_prompt, caller_prompt) if p and p.strip()]
    return "\n\n".join(parts)


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


@router.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return _error("Request body must be valid JSON", 400, "invalid_json")

    requested_model = payload.get("model")
    if not requested_model:
        return _error("`model` is required", 400, "missing_model")

    config_row = db.get_model_by_model_id(requested_model)
    if config_row is None:
        return _error(f"Model '{requested_model}' is not configured on this proxy", 404, "model_not_found")

    messages = payload.get("messages")
    if not isinstance(messages, list):
        return _error("`messages` must be a list", 400, "invalid_messages")

    caller_system_prompt = "\n\n".join(
        m.get("content", "") for m in messages if m.get("role") == "system" and isinstance(m.get("content"), str)
    )
    combined_system_prompt = _combine_system_prompt(
        db.get_base_system_prompt(), config_row["system_prompt"], caller_system_prompt
    )

    upstream_payload = {**payload, "model": config_row["provider_model_id"]}
    upstream_payload["messages"] = _build_messages(messages, combined_system_prompt)

    upstream_url = f"{config_row['provider_base_url']}/chat/completions"
    headers = {
        "Authorization": f"Bearer {config_row['provider_api_key']}",
        "Content-Type": "application/json",
    }

    is_stream = bool(payload.get("stream"))

    if is_stream:
        return await _proxy_stream(upstream_url, headers, upstream_payload)
    return await _proxy_json(upstream_url, headers, upstream_payload)


async def _proxy_json(url: str, headers: dict[str, str], payload: dict[str, Any]) -> JSONResponse:
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(url, headers=headers, json=payload)
        except httpx.RequestError as exc:
            return _error(f"Failed to reach upstream provider: {exc}", 502, "upstream_unreachable")
    try:
        body = resp.json()
    except ValueError:
        body = {"error": {"message": resp.text, "type": "upstream_error", "code": "invalid_upstream_response"}}
    return JSONResponse(status_code=resp.status_code, content=body)


async def _proxy_stream(url: str, headers: dict[str, str], payload: dict[str, Any]) -> StreamingResponse:
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
