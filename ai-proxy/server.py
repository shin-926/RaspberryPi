"""AI API Proxy Server for Henry EMR discharge summary generation."""

import os
import logging
import requests as http_requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from anthropic import Anthropic

app = Flask(__name__)
CORS(app, origins=[
    "chrome-extension://*",
    "https://*.henry-app.jp",
    "https://maokahp-discharge-summaries.web.app",
])

logging.basicConfig(level=logging.INFO, format="%(asctime)s [PROXY] %(message)s")
logger = logging.getLogger(__name__)

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/claude", methods=["POST"])
def claude_proxy():
    data = request.json
    if not data:
        return jsonify({"error": "Request body required"}), 400

    messages = data.get("messages")
    if not messages or not isinstance(messages, list):
        return jsonify({"error": "messages array required"}), 400

    model = data.get("model", "claude-sonnet-4-20250514")
    max_tokens = min(data.get("max_tokens", 4096), 8192)
    system = data.get("system", "")

    try:
        params = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if system:
            params["system"] = system

        response = client.messages.create(**params)

        text = next(
            (block.text for block in response.content if block.type == "text"), ""
        )

        logger.info(
            "model=%s input=%d output=%d",
            model,
            response.usage.input_tokens,
            response.usage.output_tokens,
        )

        return jsonify({
            "success": True,
            "content": text,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
            },
        })

    except Exception as e:
        logger.error("API error: %s", e)
        return jsonify({"success": False, "error": "AI処理に失敗しました"}), 502


GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


@app.route("/api/gemini", methods=["POST"])
def gemini_proxy():
    data = request.json
    if not data:
        return jsonify({"error": "Request body required"}), 400

    messages = data.get("messages")
    if not messages or not isinstance(messages, list):
        return jsonify({"error": "messages array required"}), 400

    model = data.get("model", "gemini-2.5-pro")
    max_tokens = min(data.get("max_tokens", 8192), 16384)
    system = data.get("system", "")

    # Claude互換のmessagesフォーマットをGemini形式に変換
    contents = []
    for msg in messages:
        contents.append({
            "role": "user" if msg["role"] == "user" else "model",
            "parts": [{"text": msg["content"]}],
        })

    body = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "thinkingConfig": {"thinkingBudget": 128},
        },
    }
    if system:
        body["system_instruction"] = {"parts": [{"text": system}]}

    try:
        url = f"{GEMINI_API_BASE}/{model}:generateContent?key={GEMINI_API_KEY}"
        resp = http_requests.post(url, json=body, timeout=120)

        if resp.status_code != 200:
            logger.error("Gemini API error: %s %s", resp.status_code, resp.text[:500])
            return jsonify({"success": False, "error": "AI処理に失敗しました"}), 502

        result = resp.json()
        text = ""
        candidates = result.get("candidates", [])
        if candidates:
            finish_reason = candidates[0].get("finishReason", "UNKNOWN")
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
            logger.info("finishReason=%s textLen=%d", finish_reason, len(text))
            if not text:
                logger.warning("Empty text. Candidate: %s", str(candidates[0])[:1000])
        else:
            logger.warning("No candidates. Response: %s", str(result)[:1000])

        usage = result.get("usageMetadata", {})
        logger.info("usageMetadata=%s", usage)
        input_tokens = usage.get("promptTokenCount", 0)
        output_tokens = usage.get("candidatesTokenCount", 0)

        logger.info(
            "model=%s input=%d output=%d",
            model,
            input_tokens,
            output_tokens,
        )

        return jsonify({
            "success": True,
            "content": text,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
        })

    except Exception as e:
        logger.error("Gemini API error: %s", e)
        return jsonify({"success": False, "error": "AI処理に失敗しました"}), 502


FIRESTORE_PROJECT = "maokahp-webapps"
FIREBASE_API_KEY = "AIzaSyAs06X1IdEQNzLfj2OvsdwLLikoDxSUi2w"
FIRESTORE_BASE = f"https://firestore.googleapis.com/v1/projects/{FIRESTORE_PROJECT}/databases/(default)/documents"


@app.route("/api/discharge-destination", methods=["POST"])
def discharge_destination():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    date = data.get("date")
    patient_id = (data.get("patientId") or "").strip()
    if not name or not date:
        return jsonify({"error": "name and date are required"}), 400

    try:
        import re
        clean_name = re.sub(r"\s+", "", name)
        url = f"{FIRESTORE_BASE}:runQuery?key={FIREBASE_API_KEY}"

        def run_query(filters: list, limit: int = 20):
            body = {
                "structuredQuery": {
                    "from": [{"collectionId": "patients"}],
                    "where": {"compositeFilter": {"op": "AND", "filters": filters}},
                    "limit": limit,
                }
            }
            r = http_requests.post(url, json=body, timeout=10)
            if r.status_code != 200:
                logger.error("Firestore error: %s", r.text)
                return None
            return r.json()

        type_filter = {"fieldFilter": {"field": {"fieldPath": "type"}, "op": "EQUAL", "value": {"stringValue": "退院"}}}
        date_filter = {"fieldFilter": {"field": {"fieldPath": "date"}, "op": "EQUAL", "value": {"stringValue": date}}}

        # NOTE: 退院サマリーは退院後（=archived 後）に作成されるのが通常運用なので
        # archived レコードもヒット対象に含める。

        # 1. patientId が指定されていれば ID のみで検索（最優先）
        # 複数ヒット時は要求日付に最も近いレコードを採用（予定日のズレに対応）
        if patient_id:
            id_filter = {"fieldFilter": {"field": {"fieldPath": "patientId"}, "op": "EQUAL", "value": {"stringValue": patient_id}}}
            results = run_query([type_filter, id_filter], limit=20)
            if results:
                docs = [r["document"]["fields"] for r in results if "document" in r]
                if docs:
                    from datetime import date as _date
                    def parse_ymd(s: str):
                        try:
                            y, m, d = s.split("-")
                            return _date(int(y), int(m), int(d))
                        except Exception:
                            return None
                    target = parse_ymd(date)
                    def sort_key(fields):
                        d_str = fields.get("date", {}).get("stringValue", "")
                        d_obj = parse_ymd(d_str)
                        if target and d_obj:
                            return (0, abs((d_obj - target).days))
                        return (1, 0)  # パース不能なものは末尾
                    docs.sort(key=sort_key)
                    chosen = docs[0]
                    source = chosen.get("source", {}).get("stringValue", "")
                    chosen_date = chosen.get("date", {}).get("stringValue", "")
                    return jsonify({"found": True, "source": source, "matchedBy": "patientId", "matchedDate": chosen_date})

        # 2. フォールバック: name + date
        results = run_query([type_filter, date_filter], limit=20)
        if results is None:
            return jsonify({"found": False, "source": None})

        for result in results:
            if "document" not in result:
                continue
            fields = result["document"]["fields"]
            doc_name = fields.get("name", {}).get("stringValue", "")
            if re.sub(r"\s+", "", doc_name) == clean_name:
                source = fields.get("source", {}).get("stringValue", "")
                return jsonify({"found": True, "source": source, "matchedBy": "name"})

        return jsonify({"found": False, "source": None})

    except Exception as e:
        logger.error("Discharge destination error: %s", e)
        return jsonify({"found": False, "source": None}), 500


# =====================================================================
# Henry GraphQL bridge: discharge-summaries-app から呼ばれて
# Henry の患者ファイル本体と Firestore レコードを連動削除する。
# =====================================================================

HENRY_FIREBASE_API_KEY = os.environ.get("HENRY_FIREBASE_API_KEY", "")
HENRY_FIREBASE_REFRESH_TOKEN = os.environ.get("HENRY_FIREBASE_REFRESH_TOKEN", "")
HENRY_ORG_UUID = os.environ.get("HENRY_ORG_UUID", "")
HENRY_GRAPHQL_ENDPOINT = os.environ.get("HENRY_GRAPHQL_ENDPOINT", "https://henry-app.jp/graphql")

# プロセスローカル ID トークンキャッシュ。Firebase ID トークンは 1 時間有効。
_henry_token_cache = {"id_token": None, "expires_at": 0.0}


def get_henry_id_token() -> str:
    """Henry の Firebase Refresh Token から ID トークンを取得（1 時間キャッシュ）"""
    import time
    now = time.time()
    cached = _henry_token_cache.get("id_token")
    if cached and now < _henry_token_cache["expires_at"] - 60:
        return cached
    if not HENRY_FIREBASE_API_KEY or not HENRY_FIREBASE_REFRESH_TOKEN:
        raise RuntimeError("Henry 認証情報が未設定")
    res = http_requests.post(
        f"https://securetoken.googleapis.com/v1/token?key={HENRY_FIREBASE_API_KEY}",
        data={
            "grant_type": "refresh_token",
            "refresh_token": HENRY_FIREBASE_REFRESH_TOKEN,
        },
        timeout=10,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Henry token refresh failed: {res.status_code} {res.text[:200]}")
    data = res.json()
    _henry_token_cache["id_token"] = data["id_token"]
    _henry_token_cache["expires_at"] = now + int(data.get("expires_in", "3600"))
    return data["id_token"]


def verify_webapps_id_token(id_token: str) -> dict | None:
    """maokahp-webapps の Firebase ID トークンを検証して payload を返す。
    Identity Toolkit の lookup が成功すれば signature/有効期限は OK と判断し、
    payload はトークンから直接 base64 decode して custom claim (henryUuid) を取り出す。
    """
    import base64
    import json as _json
    try:
        res = http_requests.post(
            f"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={FIREBASE_API_KEY}",
            json={"idToken": id_token},
            timeout=10,
        )
    except Exception as e:
        logger.error("ID token verify request error: %s", e)
        return None
    if res.status_code != 200 or not (res.json().get("users") or []):
        return None
    parts = id_token.split(".")
    if len(parts) != 3:
        return None
    payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return _json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return None


@app.route("/api/henry/delete-patient-file", methods=["POST"])
def delete_patient_file():
    data = request.get_json(silent=True) or {}
    # ID Token は Authorization: Bearer <token> ヘッダで受け取るのを正式とする。
    # 旧クライアント互換のため body の idToken もフォールバックとして許容する。
    auth_header = request.headers.get("Authorization", "")
    id_token = ""
    if auth_header.startswith("Bearer "):
        id_token = auth_header[len("Bearer "):].strip()
    if not id_token:
        id_token = data.get("idToken") or ""
    patient_file_uuid = data.get("patientFileUuid")
    if not id_token or not patient_file_uuid:
        return jsonify({"error": "idToken (Authorization header) and patientFileUuid are required"}), 400

    # 1. 呼び出し元の Firebase ID トークン検証 + henryUuid claim 必須
    claims = verify_webapps_id_token(id_token)
    if not claims:
        return jsonify({"error": "invalid token"}), 401
    if not claims.get("henryUuid"):
        return jsonify({"error": "not a Henry-authenticated user"}), 403

    # 2. Henry の DeletePatientFile を実行
    try:
        henry_token = get_henry_id_token()
    except Exception as e:
        logger.error("Henry auth failed: %s", e)
        return jsonify({"error": "henry auth unavailable"}), 503

    mutation = (
        "mutation DeletePatientFile($input: DeletePatientFileRequestInput!) {"
        " deletePatientFile(input: $input) }"
    )
    try:
        henry_res = http_requests.post(
            HENRY_GRAPHQL_ENDPOINT,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {henry_token}",
                "x-auth-organization-uuid": HENRY_ORG_UUID,
            },
            json={"query": mutation, "variables": {"input": {"uuid": patient_file_uuid}}},
            timeout=15,
        )
    except Exception as e:
        logger.error("Henry API call failed: %s", e)
        return jsonify({"error": "henry call failed"}), 502
    if henry_res.status_code != 200:
        logger.error("Henry API HTTP %s: %s", henry_res.status_code, henry_res.text[:200])
        return jsonify({"error": "henry returned non-200"}), 502

    henry_json = henry_res.json()
    henry_errors = henry_json.get("errors") or []
    if henry_errors:
        # 既に削除済みのファイルは NOT_FOUND が返る。これは握りつぶして
        # Firestore 側の掃除に進む（孤立レコードの撤去用途）。
        msgs = "; ".join(e.get("message", "") for e in henry_errors)
        logger.warning("Henry deletion warning (continuing): %s", msgs)

    # 3. Firestore ドキュメントを呼び出し元の ID トークン経由で削除
    #    （Firestore ルールがそのまま効く）
    try:
        fs_res = http_requests.delete(
            f"{FIRESTORE_BASE}/discharge_summaries/{patient_file_uuid}",
            headers={"Authorization": f"Bearer {id_token}"},
            timeout=10,
        )
    except Exception as e:
        logger.error("Firestore delete request failed: %s", e)
        return jsonify({"error": "firestore delete failed"}), 500
    if fs_res.status_code not in (200, 204):
        logger.error("Firestore delete HTTP %s: %s", fs_res.status_code, fs_res.text[:200])
        return jsonify({"error": "firestore delete failed"}), 500

    logger.info(
        "deleted discharge summary: file=%s by=%s",
        patient_file_uuid,
        claims.get("henryUuid"),
    )
    return jsonify({"deleted": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3002))
    app.run(host="0.0.0.0", port=port)
