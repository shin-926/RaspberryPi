"""Henry EMR 拡張のユーザー設定同期サーバー。

エンドポイント:
  GET  /api/henry-settings/<uuid>   設定取得
  PUT  /api/henry-settings/<uuid>   設定更新

認証: Authorization: Bearer <Henry JWT>
  Henry GraphQL の authenticateToken mutation で検証し、返されたUUIDが
  リクエストパスのUUIDと一致するか確認する。
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import requests as http_requests
from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

ORG_UUID = "ce6b556b-2a8d-4fce-b8dd-89ba638fc825"  # マオカ病院
HENRY_GRAPHQL_URL = "https://henry-app.jp/graphql"
DB_PATH = Path(os.environ.get("DB_PATH", "/data/henry-user-settings.db"))
PORT = int(os.environ.get("PORT", 3003))

# JWT検証結果のキャッシュ (UUID毎、Henry GraphQLへの過剰呼び出し防止)
# token -> (uuid, expiresAt)
_token_cache: dict[str, tuple[str, float]] = {}
TOKEN_CACHE_TTL_SEC = 300  # 5分

logging.basicConfig(level=logging.INFO, format="%(asctime)s [SETTINGS] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, origins=["chrome-extension://*", "https://*.henry-app.jp"])

# ---------------------------------------------------------------------------
# DB 初期化
# ---------------------------------------------------------------------------

def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_settings (
              uuid TEXT PRIMARY KEY,
              settings_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


# ---------------------------------------------------------------------------
# JWT 検証 (Henry GraphQL 経由)
# ---------------------------------------------------------------------------

AUTH_QUERY = """
mutation AuthenticateToken($organizationUuid: String!, $token: String!, $isLogin: Boolean!) {
  authenticateToken(organizationUuid: $organizationUuid, token: $token, isLogin: $isLogin) {
    user { uuid }
  }
}
"""


def verify_jwt(token: str) -> str | None:
    """JWT を Henry に問い合わせて UUID を返す。失敗時は None。"""
    cached = _token_cache.get(token)
    if cached and cached[1] > time.time():
        return cached[0]

    try:
        resp = http_requests.post(
            HENRY_GRAPHQL_URL,
            json={
                "query": AUTH_QUERY,
                "variables": {
                    "organizationUuid": ORG_UUID,
                    "token": token,
                    "isLogin": False,
                },
            },
            timeout=10,
        )
        if resp.status_code != 200:
            logger.warning("Henry auth HTTP %s: %s", resp.status_code, resp.text[:200])
            return None
        data = resp.json()
        uuid = data.get("data", {}).get("authenticateToken", {}).get("user", {}).get("uuid")
        if not uuid:
            errors = data.get("errors")
            if errors:
                logger.warning("Henry auth errors: %s", errors[:1])
            return None
        _token_cache[token] = (uuid, time.time() + TOKEN_CACHE_TTL_SEC)
        return uuid
    except Exception as e:  # noqa: BLE001
        logger.error("verify_jwt exception: %s", e)
        return None


def authorize(path_uuid: str) -> tuple[bool, int, str | None]:
    """Authorization ヘッダを検証し、path_uuid と一致するか確認。

    Returns: (ok, status_code, error_message)
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False, 401, "Missing Bearer token"
    token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        return False, 401, "Empty token"

    auth_uuid = verify_jwt(token)
    if not auth_uuid:
        return False, 401, "Invalid token"
    if auth_uuid != path_uuid:
        return False, 403, "UUID mismatch"
    return True, 200, None


# ---------------------------------------------------------------------------
# ルート
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/henry-settings/<uuid>", methods=["GET"])
def get_settings(uuid: str):
    ok, status, err = authorize(uuid)
    if not ok:
        return jsonify({"error": err}), status

    with db_connect() as conn:
        row = conn.execute(
            "SELECT settings_json, updated_at FROM user_settings WHERE uuid = ?", (uuid,)
        ).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404
    return jsonify({
        "settings": json.loads(row["settings_json"]),
        "updatedAt": row["updated_at"],
    })


@app.route("/api/henry-settings/<uuid>", methods=["PUT"])
def put_settings(uuid: str):
    ok, status, err = authorize(uuid)
    if not ok:
        return jsonify({"error": err}), status

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "JSON body required"}), 400
    settings = body.get("settings")
    if not isinstance(settings, dict):
        return jsonify({"error": "settings (object) required"}), 400
    expected = body.get("expectedUpdatedAt")  # オプション: 楽観的ロック

    settings_json = json.dumps(settings, ensure_ascii=False)
    new_updated = now_iso()

    with db_connect() as conn:
        if expected is not None:
            current = conn.execute(
                "SELECT updated_at FROM user_settings WHERE uuid = ?", (uuid,)
            ).fetchone()
            if current and current["updated_at"] != expected:
                return jsonify({
                    "error": "Conflict",
                    "currentUpdatedAt": current["updated_at"],
                }), 409
        conn.execute(
            """
            INSERT INTO user_settings (uuid, settings_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(uuid) DO UPDATE SET
              settings_json = excluded.settings_json,
              updated_at = excluded.updated_at
            """,
            (uuid, settings_json, new_updated),
        )
        conn.commit()
    return jsonify({"ok": True, "updatedAt": new_updated})


# ---------------------------------------------------------------------------
# 起動
# ---------------------------------------------------------------------------

init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
