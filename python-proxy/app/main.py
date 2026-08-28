from fastapi import FastAPI

from . import db
from .dashboard import router as dashboard_router
from .proxy import router as proxy_router

app = FastAPI(title="Python Model Proxy")


@app.on_event("startup")
def on_startup() -> None:
    db.init_db()


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(proxy_router)
app.include_router(dashboard_router)
