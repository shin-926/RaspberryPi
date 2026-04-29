"""Henry EMR 拡張のユーザー設定同期サーバー。

エンドポイント:
  GET  /api/henry-settings/<uuid>   設定取得
  PUT  /api/henry-settings/<uuid>   設定更新

認証: なし。UUID は URL パスで指定する。
  設定データは機密性が低く、UUIDを推測する動機もないため、認証コストを払うより
  シンプルにした方が安全（JWTが外部サーバーに渡らないメリットの方が大きい）。
  HTTPS (Cloudflare Tunnel) と CORS で「悪意なき誤接続」「中間者」のみ防ぐ。
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS

DB_PATH = Path(os.environ.get("DB_PATH", "/data/henry-user-settings.db"))
PORT = int(os.environ.get("PORT", 3003))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [SETTINGS] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, origins=["chrome-extension://*", "https://henry-app.jp", "https://*.henry-app.jp"])

# ---------------------------------------------------------------------------
# DB
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
# ルート
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/henry-settings/<uuid>", methods=["GET"])
def get_settings(uuid: str):
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
