from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from . import db
from .auth import require_dashboard_auth
from .config import BASE_DIR

router = APIRouter(dependencies=[Depends(require_dashboard_auth)])
templates = Jinja2Templates(directory=str(BASE_DIR / "app" / "templates"))


def _mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}{'*' * (len(key) - 8)}{key[-4:]}"


@router.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "models": db.list_models(),
            "base_system_prompt": db.get_base_system_prompt(),
            "mask": _mask,
            "edit_row": None,
        },
    )


@router.get("/models/{pk_id}/edit", response_class=HTMLResponse)
def edit_form(request: Request, pk_id: int):
    row = db.get_model(pk_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Model not found")
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "models": db.list_models(),
            "base_system_prompt": db.get_base_system_prompt(),
            "mask": _mask,
            "edit_row": row,
        },
    )


@router.post("/models")
def create_model(
    model_id: str = Form(...),
    provider_base_url: str = Form(...),
    provider_api_key: str = Form(...),
    provider_model_id: str = Form(...),
    system_prompt: str = Form(""),
):
    if db.get_model_by_model_id(model_id.strip()) is not None:
        raise HTTPException(status_code=400, detail=f"Model id '{model_id}' already exists")
    db.create_model(
        model_id.strip(),
        provider_base_url.strip(),
        provider_api_key.strip(),
        provider_model_id.strip(),
        system_prompt,
    )
    return RedirectResponse(url="/", status_code=303)


@router.post("/models/{pk_id}")
def update_model(
    pk_id: int,
    model_id: str = Form(...),
    provider_base_url: str = Form(...),
    provider_api_key: str = Form(""),
    provider_model_id: str = Form(...),
    system_prompt: str = Form(""),
):
    if db.get_model(pk_id) is None:
        raise HTTPException(status_code=404, detail="Model not found")
    db.update_model(
        pk_id,
        model_id.strip(),
        provider_base_url.strip(),
        provider_api_key.strip() or None,
        provider_model_id.strip(),
        system_prompt,
    )
    return RedirectResponse(url="/", status_code=303)


@router.post("/models/{pk_id}/delete")
def delete_model(pk_id: int):
    db.delete_model(pk_id)
    return RedirectResponse(url="/", status_code=303)


@router.post("/settings")
def update_settings(base_system_prompt: str = Form("")):
    db.set_base_system_prompt(base_system_prompt)
    return RedirectResponse(url="/", status_code=303)
