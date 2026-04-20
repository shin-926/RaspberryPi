"""Claude API Proxy Server for Henry EMR discharge summary generation."""

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


FIRESTORE_PROJECT = "maokahp-webapps"
FIREBASE_API_KEY = "AIzaSyAs06X1IdEQNzLfj2OvsdwLLikoDxSUi2w"
FIRESTORE_BASE = f"https://firestore.googleapis.com/v1/projects/{FIRESTORE_PROJECT}/databases/(default)/documents"


@app.route("/api/discharge-destination", methods=["POST"])
def discharge_destination():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    date = data.get("date")
    if not name or not date:
        return jsonify({"error": "name and date are required"}), 400

    try:
        # Firestore REST API: type + date で絞り込み、名前はスペース除去で比較
        import re
        clean_name = re.sub(r"\s+", "", name)

        url = f"{FIRESTORE_BASE}:runQuery?key={FIREBASE_API_KEY}"
        query_body = {
            "structuredQuery": {
                "from": [{"collectionId": "patients"}],
                "where": {
                    "compositeFilter": {
                        "op": "AND",
                        "filters": [
                            {"fieldFilter": {"field": {"fieldPath": "type"}, "op": "EQUAL", "value": {"stringValue": "退院"}}},
                            {"fieldFilter": {"field": {"fieldPath": "date"}, "op": "EQUAL", "value": {"stringValue": date}}},
                        ],
                    }
                },
                "limit": 20,
            }
        }

        resp = http_requests.post(url, json=query_body, timeout=10)
        if resp.status_code != 200:
            logger.error("Firestore error: %s", resp.text)
            return jsonify({"found": False, "source": None})

        results = resp.json()
        for result in results:
            if "document" not in result:
                continue
            fields = result["document"]["fields"]
            doc_name = fields.get("name", {}).get("stringValue", "")
            if re.sub(r"\s+", "", doc_name) == clean_name:
                source = fields.get("source", {}).get("stringValue", "")
                return jsonify({"found": True, "source": source})

        return jsonify({"found": False, "source": None})

    except Exception as e:
        logger.error("Discharge destination error: %s", e)
        return jsonify({"found": False, "source": None}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3002))
    app.run(host="0.0.0.0", port=port)
