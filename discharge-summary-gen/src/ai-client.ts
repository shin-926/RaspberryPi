// ai-proxy (sk924.com) クライアントの共通 transport レイヤー。
// 退院サマリー生成(generate.ts) と DPC連絡表生成(renraku-prompt.ts) が共有する。
// 後処理(XMLタグ抽出 / JSONパース)は呼び出し側に残し、ここは fetch + 応答検証 +
// モデル定数 + base URL のみを所有する（transport と後処理の分離）。

export type AiProvider = 'gemini' | 'claude';
export type AiRole = 'user' | 'assistant';
export interface AiMessage {
  role: AiRole;
  content: string;
}

/** ai-proxy 応答を検証した結果（usage は camelCase に正規化） */
export interface AiProxyResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** ai-proxy (server.py) の生レスポンス形。snake_case。 */
interface AiProxyRawResponse {
  success?: boolean;
  content?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** ai-proxy の base URL。provider はパスで導出する（/api/gemini, /api/claude）。 */
const AI_PROXY_BASE = process.env.AI_PROXY_BASE_URL || 'https://sk924.com/api';
const proxyUrl = (provider: AiProvider): string => `${AI_PROXY_BASE}/${provider}`;

/**
 * 既知モデルID。proxy 既定との食い違い（旧 ④ の claude-opus-4-7 と server.py の
 * claude-sonnet の不一致）を、呼び出し側が明示指定することで根絶するための定数。
 */
export const AI_MODELS = {
  geminiPro: 'gemini-2.5-pro',
  claudeOpus: 'claude-opus-4-7',
} as const;

/**
 * ai-proxy 応答 JSON を検証して AiProxyResult に変換する純粋関数。
 * proxy が HTML エラーページ等を返した場合、JSON.parse の例外メッセージは巨大な本文を
 * 含み得るため定型エラーに変換する（生エラーがログに残るのを防ぐ）。
 * （Henry extension/core/henry_ai.ts の parseAiProxyResponse から昇格）
 */
export function parseAiProxyResponse(body: string): AiProxyResult {
  let data: AiProxyRawResponse;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('AI応答の解析に失敗しました');
  }
  if (!data.success || !data.content) {
    throw new Error('AI応答が空です');
  }
  return {
    content: data.content,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

export interface CallAiProxyOptions {
  provider: AiProvider;
  system: string;
  prompt: string;
  model?: string; // 省略時は proxy 既定
  maxTokens?: number; // 省略時は proxy 既定（claude=4096, gemini=8192。上限は proxy がクランプ）
}

/**
 * ai-proxy (sk924.com) を叩く共通 transport。
 * 後処理（XMLタグ抽出 / JSONパース）は呼び出し側が AiProxyResult.content に対して行う。
 */
export async function callAiProxy(opts: CallAiProxyOptions): Promise<AiProxyResult> {
  const body: Record<string, unknown> = {
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
  };
  if (opts.model !== undefined) body.model = opts.model;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const response = await fetch(proxyUrl(opts.provider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`ai-proxy エラー (${opts.provider}): ${response.status} ${errBody.slice(0, 300)}`);
  }

  return parseAiProxyResponse(await response.text());
}
