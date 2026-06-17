"""Henry EMR 拡張のエラーテレメトリ受信サーバー。

エンドポイント:
  POST /api/henry-telemetry              拡張からのエラーイベント受信（バッチ）
  GET  /api/henry-telemetry/events       ダッシュボード用クエリAPI（JSON）
  GET  /telemetry/                       閲覧ダッシュボード（HTML）
  GET  /health                           ヘルスチェック

認証: なし。henry-user-settings と同じ方針（UUID-only / 認証コスト最小化）。
  Cloudflare Tunnel + CORS で外部からの悪意なき誤接続を防ぐ。
  PII（患者UUID/医師UUID）が含まれるため、ダッシュボード閲覧側は
  Tailscale など院内VPN経由を推奨。
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

DB_PATH = Path(os.environ.get("DB_PATH", "/data/henry-telemetry.db"))
PORT = int(os.environ.get("PORT", 3004))
MAX_BODY_BYTES = 1 * 1024 * 1024  # 1MB: 100イベントバッチ x 平均10KB を許容
MAX_QUERY_LIMIT = 500
DEFAULT_QUERY_LIMIT = 100

logging.basicConfig(level=logging.INFO, format="%(asctime)s [TELEMETRY] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES
# 拡張(Chrome)と henry-app.jp（content script の fetch via Bridge）からの POST を許可
CORS(app, origins=["chrome-extension://*", "https://henry-app.jp", "https://*.henry-app.jp"])


@app.errorhandler(413)
def request_too_large(_e):
    return jsonify({"error": "Payload too large"}), 413


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              received_at TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              script_name TEXT NOT NULL,
              type TEXT NOT NULL,
              message TEXT NOT NULL,
              stack TEXT,
              url TEXT,
              extension_version TEXT,
              patient_uuid TEXT,
              user_uuid TEXT,
              user_agent TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_script_name ON events(script_name)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_user_uuid ON events(user_uuid)")
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


@app.route("/api/henry-telemetry", methods=["POST"])
def receive_events():
    # sendBeacon が text/plain で送ってくる場合があるため silent=True で寛容に
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        # sendBeacon 経由は Content-Type が application/json でも parse 失敗することがあるので生データから再試行
        try:
            body = json.loads(request.get_data(as_text=True) or "{}")
        except (ValueError, json.JSONDecodeError):
            return jsonify({"error": "JSON body required"}), 400

    events = body.get("events")
    if not isinstance(events, list):
        return jsonify({"error": "events (array) required"}), 400

    received_at = now_iso()
    rows = []
    for e in events:
        if not isinstance(e, dict):
            continue
        ctx = e.get("context") or {}
        rows.append((
            received_at,
            str(e.get("timestamp") or received_at),
            str(e.get("scriptName") or "unknown"),
            str(e.get("type") or "unknown"),
            str(e.get("message") or ""),
            e.get("stack"),
            ctx.get("url"),
            ctx.get("extensionVersion"),
            ctx.get("patientUuid"),
            ctx.get("userUuid"),
            ctx.get("userAgent"),
        ))

    if not rows:
        return jsonify({"received": 0})

    with db_connect() as conn:
        conn.executemany(
            """
            INSERT INTO events (
              received_at, timestamp, script_name, type, message, stack,
              url, extension_version, patient_uuid, user_uuid, user_agent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()

    return jsonify({"received": len(rows)})


@app.route("/api/henry-telemetry/events", methods=["GET"])
def query_events():
    """ダッシュボード用クエリ。

    クエリパラメータ（全て optional、AND 条件）:
      since=<ISO timestamp>     これより新しい received_at のみ
      until=<ISO timestamp>     これより古い received_at のみ
      scriptName=<str>          完全一致
      type=<str>                完全一致 (console-error / uncaught / unhandled-rejection / user-report)
      userUuid=<str>            完全一致
      q=<str>                   message に含まれる文字列（部分一致 LIKE）
      limit=<int>               最大 500、デフォルト 100
      offset=<int>              ページング用
    """
    where: list[str] = []
    params: list = []

    since = request.args.get("since")
    if since:
        where.append("received_at > ?")
        params.append(since)

    until = request.args.get("until")
    if until:
        where.append("received_at < ?")
        params.append(until)

    script_name = request.args.get("scriptName")
    if script_name:
        where.append("script_name = ?")
        params.append(script_name)

    event_type = request.args.get("type")
    if event_type:
        where.append("type = ?")
        params.append(event_type)

    user_uuid = request.args.get("userUuid")
    if user_uuid:
        where.append("user_uuid = ?")
        params.append(user_uuid)

    q = request.args.get("q")
    if q:
        where.append("message LIKE ?")
        params.append(f"%{q}%")

    try:
        limit = min(int(request.args.get("limit", DEFAULT_QUERY_LIMIT)), MAX_QUERY_LIMIT)
    except ValueError:
        limit = DEFAULT_QUERY_LIMIT
    try:
        offset = max(int(request.args.get("offset", 0)), 0)
    except ValueError:
        offset = 0

    where_clause = (" WHERE " + " AND ".join(where)) if where else ""
    sql = f"""
      SELECT id, received_at, timestamp, script_name, type, message, stack,
             url, extension_version, patient_uuid, user_uuid, user_agent
      FROM events
      {where_clause}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    """
    params_with_paging = [*params, limit, offset]

    with db_connect() as conn:
        rows = conn.execute(sql, params_with_paging).fetchall()
        total_row = conn.execute(
            f"SELECT COUNT(*) AS c FROM events{where_clause}", params
        ).fetchone()

    return jsonify({
        "events": [dict(r) for r in rows],
        "total": total_row["c"] if total_row else 0,
        "limit": limit,
        "offset": offset,
    })


@app.route("/api/henry-telemetry/stats", methods=["GET"])
def stats():
    """ダッシュボード上部の集計用。直近24時間の scriptName 別/type 別件数。"""
    with db_connect() as conn:
        by_script = [dict(r) for r in conn.execute(
            """
            SELECT script_name, COUNT(*) AS count
            FROM events
            WHERE received_at > datetime('now', '-1 day')
            GROUP BY script_name
            ORDER BY count DESC
            """
        ).fetchall()]
        by_type = [dict(r) for r in conn.execute(
            """
            SELECT type, COUNT(*) AS count
            FROM events
            WHERE received_at > datetime('now', '-1 day')
            GROUP BY type
            ORDER BY count DESC
            """
        ).fetchall()]
        total_24h = conn.execute(
            "SELECT COUNT(*) AS c FROM events WHERE received_at > datetime('now', '-1 day')"
        ).fetchone()["c"]
        total_all = conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"]

    return jsonify({
        "byScript": by_script,
        "byType": by_type,
        "total24h": total_24h,
        "totalAll": total_all,
    })


@app.route("/telemetry/", methods=["GET"])
@app.route("/telemetry", methods=["GET"])
def dashboard():
    return render_template("dashboard.html")


# ---------------------------------------------------------------------------
# 起動
# ---------------------------------------------------------------------------

init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
