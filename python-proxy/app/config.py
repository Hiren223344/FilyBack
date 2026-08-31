import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "9000"))

DATABASE_PATH = Path(os.getenv("DATABASE_PATH", "./data/proxy.db"))
if not DATABASE_PATH.is_absolute():
    DATABASE_PATH = BASE_DIR / DATABASE_PATH

DEFAULT_SYSTEM_PROMPT = os.getenv("DEFAULT_SYSTEM_PROMPT", "You are a helpful assistant.")

DASHBOARD_USERNAME = os.getenv("DASHBOARD_USERNAME", "admin")
DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD", "change-me")

PROXY_API_KEY = os.getenv("PROXY_API_KEY", "").strip()

ANTHROPIC_VERSION = os.getenv("ANTHROPIC_VERSION", "2023-06-01")
