"""AI API Proxy Server for Henry EMR discharge summary generation."""

import os
import logging
import requests as http_requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from anthropic import Anthropic

app = Flask(__name__)
CORS(app, origins=["chrome-extension://*", "https://*.henry-app.jp"])

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

        def is_archived(fields: dict) -> bool:
            return fields.get("archived", {}).get("booleanValue") is True

        # 1. patientId が指定されていれば ID のみで検索（最優先）
        # 複数ヒット時は要求日付に最も近いレコードを採用（予定日のズレに対応）
        if patient_id:
            id_filter = {"fieldFilter": {"field": {"fieldPath": "patientId"}, "op": "EQUAL", "value": {"stringValue": patient_id}}}
            results = run_query([type_filter, id_filter], limit=20)
            if results:
                docs = [
                    r["document"]["fields"] for r in results
                    if "document" in r and not is_archived(r["document"]["fields"])
                ]
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
            if is_archived(fields):
                continue
            doc_name = fields.get("name", {}).get("stringValue", "")
            if re.sub(r"\s+", "", doc_name) == clean_name:
                source = fields.get("source", {}).get("stringValue", "")
                return jsonify({"found": True, "source": source, "matchedBy": "name"})

        return jsonify({"found": False, "source": None})

    except Exception as e:
        logger.error("Discharge destination error: %s", e)
        return jsonify({"found": False, "source": None}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3002))
    app.run(host="0.0.0.0", port=port)
