import secrets

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import config

_basic = HTTPBasic()


def require_dashboard_auth(
    credentials: HTTPBasicCredentials = Depends(_basic),
) -> str:
    correct_user = secrets.compare_digest(credentials.username, config.DASHBOARD_USERNAME)
    correct_pass = secrets.compare_digest(credentials.password, config.DASHBOARD_PASSWORD)
    if not (correct_user and correct_pass):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid dashboard credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username


def require_proxy_auth(request: Request) -> None:
    if not config.PROXY_API_KEY:
        return
    # Anthropic SDKs (incl. Claude Code) send `x-api-key`; OpenAI SDKs send
    # `Authorization: Bearer`. Accept either so both client families work.
    api_key_header = request.headers.get("x-api-key", "")
    auth_header = request.headers.get("authorization", "")
    bearer_token = auth_header[7:] if auth_header.lower().startswith("bearer ") else ""
    token = api_key_header or bearer_token
    if not secrets.compare_digest(token, config.PROXY_API_KEY):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"message": "Invalid API key", "type": "invalid_request_error", "code": "invalid_api_key"}},
        )
