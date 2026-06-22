// Phase B: AI生成（Gemini）＋退院先取得（henry_discharge_summary.ts より移植）
// window.HenryBridge.fetch → 通常の fetch に置換。URL は env で上書き可（Pi では localhost 最適化可能）。
import { formatHenryDate } from './collect.ts';
import type { HenryDate, AiResult } from './types.ts';
import { callAiProxy, AI_MODELS } from './ai-client.ts';

const DISCHARGE_DEST_URL = process.env.DISCHARGE_DEST_URL || 'https://sk924.com/api/discharge-destination';

// henry_discharge_summary.ts L648-691 と逐語一致（出力タグを規定）
const SYSTEM_PROMPT = `あなたは退院サマリーを作成する医療AIアシスタントです。
JAMI（日本医療情報学会）の退院サマリー作成ガイダンスに準拠して、提供されたカルテデータから退院サマリーを作成してください。

出力形式（必ずこのXMLタグで区切ること）:

<主訴>入院理由を簡潔に1〜2文で。必ず記載すること。</主訴>

<現病歴>今回の入院に至るまでの経過。改行せず連続した文で記述。必ず記載すること。</現病歴>

<既往歴>現在治療・管理中の疾患と過去の疾患をまとめて記載。改行せず連続した文で記述。</既往歴>

<入院時所見>入院時の身体所見と検査所見をまとめて記述。改行せず連続した文で記述。データがなければ「特記事項なし」。</入院時所見>

<プロブレムリスト>
「#番号 問題名」の見出し行の後に改行し、その問題の経過を連続した文で記述する。
各問題の間は空行で区切る。
主病名のみで副次的な問題がない場合は、番号なしで連続した文として記述する。

出力例:
#1 化膿性脊椎炎
入院後の精査にてL2/3椎体に化膿性脊椎炎を認め、抗菌薬内服加療を開始した。…

#2 頻尿
入院中、夜間頻尿の訴えが強く、シロドシンを開始した。…

構成ルール:
- 主病名の治療経過が軸（治療内容→経過→転帰）。入院中に診断された場合は診断経緯も簡潔に含める
- 副次的な問題はそれぞれ簡潔に（1〜3文）
- 検査値は治療効果や転帰を示すものだけ記載（例: CRP陰性化、Hb低下傾向）
- 日付の羅列や経過の逐一記録は不要。臨床的に重要なイベントに絞る
</プロブレムリスト>

<全体的な経過>特定のプロブレムに属さない全体的な経過（退院時の状態、全身状態の変化、臨終の経過など）を連続した文で記述。該当なしなら「特記事項なし」。</全体的な経過>

<退院後方針>転帰（転院先・施設入所・自宅退院など）、今後の治療計画・フォローアップ予定を連続した文で記述。</退院後方針>

※退院時処方はシステムが自動出力する。「## 退院時処方」のデータは無視し、退院時処方に関する記述は一切出力しないこと。

ルール:
- 提供されたデータのみに基づいて記述すること（推測や創作は禁止）
- データにない項目は「特記事項なし」と記載する
- 簡潔で医学的に正確な文体を使用。略語はできる限り使用しない
- 退院サマリーは「要約」であり「経過記録」ではない。読み手が短時間で臨床像を把握できることを最優先する
- 看護記録・医師記録の重要な所見を反映する`;

export async function callGeminiProxy(promptMarkdown: string): Promise<AiResult> {
  const { content, usage } = await callAiProxy({
    provider: 'gemini',
    model: AI_MODELS.geminiPro,
    maxTokens: 8192,
    system: SYSTEM_PROMPT,
    prompt: promptMarkdown,
  });

  // AI出力の途中改行を除去（見出し後・箇条書き前の改行は維持）
  const normalize = (text: string): string =>
    text
      .replace(/(#\d+ [^\n]+)\n+/g, '$1\x00')
      .replace(/\n+(?=#\d+ )/g, '\n')
      .replace(/\n(?!・|- |\d+\.|#\d+ )/g, '')
      .replace(/\x00/g, '\n');

  const extract = (tag: string, fallback = '特記事項なし'): string => {
    const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || '';
    return normalize(match) || fallback;
  };

  const chiefComplaint = extract('主訴', '');
  const presentIllness = extract('現病歴', '');
  const pastHistory = extract('既往歴');
  const admissionFindings = extract('入院時所見');
  const problemList = extract('プロブレムリスト');
  const generalCourse = extract('全体的な経過', '');
  const plan = extract('退院後方針');

  const progressParts = [problemList];
  if (generalCourse && generalCourse !== '特記事項なし') {
    progressParts.push(generalCourse);
  }
  const progress = progressParts.join('\n');

  if (chiefComplaint === '' && presentIllness === '' && progress === '特記事項なし') {
    throw new Error('AIの応答をパースできませんでした');
  }

  console.log(`[generate] AI生成完了 (input: ${usage.inputTokens}, output: ${usage.outputTokens})`);
  return { chiefComplaint, presentIllness, pastHistory, admissionFindings, progress, plan };
}

interface DischargeDestResponse {
  found?: boolean;
  source?: string;
}

/** 退院先を patient-status から取得（patientId 優先、name+date フォールバック） */
export async function fetchDischargeDestination(
  name: string,
  date: HenryDate | null,
  patientId: string,
): Promise<string> {
  if (!name || !date) return '';
  try {
    const cleanName = name.replace(/\s+/g, '');
    const dateStr = formatHenryDate(date);
    const response = await fetch(DISCHARGE_DEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, name: cleanName, date: dateStr }),
    });
    if (!response.ok) return '';
    const data = (await response.json()) as DischargeDestResponse;
    return data.found ? (data.source || '') : '';
  } catch (e) {
    console.error('[generate] 退院先取得エラー', e instanceof Error ? e.message : e);
    return '';
  }
}
