import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, Optional

from . import config

SETTINGS_BASE_SYSTEM_PROMPT_KEY = "base_system_prompt"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    config.DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS model_configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model_id TEXT UNIQUE NOT NULL,
                provider_base_url TEXT NOT NULL,
                provider_api_key TEXT NOT NULL,
                provider_model_id TEXT NOT NULL,
                system_prompt TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (SETTINGS_BASE_SYSTEM_PROMPT_KEY, config.DEFAULT_SYSTEM_PROMPT),
        )


def get_base_system_prompt() -> str:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?",
            (SETTINGS_BASE_SYSTEM_PROMPT_KEY,),
        ).fetchone()
        return row["value"] if row else config.DEFAULT_SYSTEM_PROMPT


def set_base_system_prompt(value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (SETTINGS_BASE_SYSTEM_PROMPT_KEY, value),
        )


def list_models() -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM model_configs ORDER BY model_id COLLATE NOCASE"
        ).fetchall()


def get_model(model_pk_id: int) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM model_configs WHERE id = ?", (model_pk_id,)
        ).fetchone()


def get_model_by_model_id(model_id: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM model_configs WHERE model_id = ?", (model_id,)
        ).fetchone()


def create_model(
    model_id: str,
    provider_base_url: str,
    provider_api_key: str,
    provider_model_id: str,
    system_prompt: str,
) -> None:
    now = _now()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO model_configs
                (model_id, provider_base_url, provider_api_key, provider_model_id,
                 system_prompt, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                model_id,
                provider_base_url.rstrip("/"),
                provider_api_key,
                provider_model_id,
                system_prompt,
                now,
                now,
            ),
        )


def update_model(
    model_pk_id: int,
    model_id: str,
    provider_base_url: str,
    provider_api_key: Optional[str],
    provider_model_id: str,
    system_prompt: str,
) -> None:
    with get_conn() as conn:
        if provider_api_key:
            conn.execute(
                """
                UPDATE model_configs
                SET model_id = ?, provider_base_url = ?, provider_api_key = ?,
                    provider_model_id = ?, system_prompt = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    model_id,
                    provider_base_url.rstrip("/"),
                    provider_api_key,
                    provider_model_id,
                    system_prompt,
                    _now(),
                    model_pk_id,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE model_configs
                SET model_id = ?, provider_base_url = ?,
                    provider_model_id = ?, system_prompt = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    model_id,
                    provider_base_url.rstrip("/"),
                    provider_model_id,
                    system_prompt,
                    _now(),
                    model_pk_id,
                ),
            )


def delete_model(model_pk_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM model_configs WHERE id = ?", (model_pk_id,))
