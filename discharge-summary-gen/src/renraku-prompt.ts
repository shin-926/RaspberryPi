// DPC連絡表のLLM判定項目をまとめて生成するプロンプトレイヤー
//
// 構造:
//   1. buildRenrakuPrompt(): カルテ全データ + 病名候補リスト + 共有情報 → Markdown
//   2. parseRenrakuResponse(): LLMが返したJSONをパースして RenrakuLlmDecisions に変換
//   3. callRenrakuLlm(): ai-proxy 経由でGemini呼び出し（既存generate.tsと同じ仕組み）
//
// 設計方針:
//   - 1回の呼び出しで全LLM項目を返してもらう（コンテキスト共有のため）
//   - 出力は厳格なJSON。各項目に value + evidence + confidence を要求
//   - 病名選択は「候補リストの uuid から選ぶ」形式で誤生成を防止
import { formatHenryDate } from './collect.ts';
import type { HenryPatient, HenryHospitalization } from './types.ts';
import type { DiagnosisItem } from './renraku-types.ts';
import type { SharedInfo } from './renraku-collect.ts';

const GEMINI_PROXY_URL = process.env.AI_PROXY_GEMINI_URL || 'https://sk924.com/api/gemini';
const CLAUDE_PROXY_URL = process.env.AI_PROXY_CLAUDE_URL || 'https://sk924.com/api/claude';

/** プロバイダ切替: 'gemini' (デフォルト) または 'claude' */
const LLM_PROVIDER = (process.env.RENRAKU_LLM_PROVIDER || 'gemini').toLowerCase();
const LLM_MODEL = process.env.RENRAKU_LLM_MODEL || (LLM_PROVIDER === 'claude' ? 'claude-opus-4-7' : 'gemini-2.5-pro');

// ============================================================
// SYSTEM PROMPT — DPC連絡表専用
// ============================================================
const SYSTEM_PROMPT = `あなたはDPC様式1の医師連絡表・看護師連絡表を埋めるための医療AIアシスタントです。
マオカ病院（療養型）の入院患者カルテから、連絡表の各項目を判定してください。

【最重要ルール】
1. 提供されたカルテ・病名候補・共有情報のみに基づいて判定すること。推測や創作は絶対禁止
2. カルテに該当記載がなければ confidence を low にし、デフォルト値を返すこと（後述）
3. 病名はマスター病名候補リストの uuid から必ず選択。リストにないものを生成しない
4. 各項目には必ず evidence（カルテからの根拠引用）を添える。短く具体的に
5. 出力は厳密なJSONのみ（前後の説明や Markdownラッパー一切なし）

【マオカ病院の運用前提】
- 急性期病院ではない（療養型／回復期主体）
- 入院時JCSは基本0（明確な記述がある場合のみ1桁範囲で昇格）
- ほぼ全症例で入院目的=4（その他の加療）
- 手術は実施しないため手術関連項目は対象外

【契機病名・主傷病・医療資源病名の判定指針 — 極めて重要】
- DPC様式1の「契機病名」は **入院の本当のきっかけ** を指す。例: 転倒による骨折、脳卒中、肺炎発症
- **現在管理中の併存疾患（認知症・高血圧・糖尿病・心不全等）を契機病名にしてはならない**
- **最も参考になるのは患者プロフィールの「現病歴」セクション**。ここに「自宅で転倒→救急搬送→骨折→マオカで保存療法のため入院」のような経緯が書かれている
- 外傷系（ICD-10のS/T系）、急性疾患（脳卒中I63、脳出血I61、肺炎J18等）が契機になることが多い
- 主傷病・医療資源病名も同じ考え方で、入院期間で「最も医療資源を投入した疾患」を選ぶ。マオカでは大半「契機病名と同じ」になる
- 候補リストの中から、現病歴・入院時記事に明示されている疾患を最優先で選ぶこと

【認知症自立度の判定指針】※JCS判定とは独立
- 厳しめに判定すること。カルテに「認知症」「物忘れ」「徘徊」「BPSD」等の明示記載が無ければ "自立"（=0）を返す
- 患者が「会話可能」「コンセント自分でつなぐ」「リハに前向き」等の記載があれば、独居生活経歴と合わせて "自立" を強く推定
- ランクⅢ以上は「失禁」「徘徊」「介護が必要」等の明示記載が必須
- マオカは認知症記載なし=0 が大半（過剰評価しないこと）

【JCS判定指針】※認知症ルールと独立
- カルテに「JCS 〇〇」と明示記載があればその値を採用（最重要）
- 「意識清明」記載があれば 0
- 「呼びかけで開眼」「痛み刺激で開眼」「かろうじて開眼」等の記載は対応するJCS（10/20/30）
- 「やや傾眠」「混迷」「強い傾眠」等は文脈で判断
- 認知症患者でも意識清明なら JCS=0 が正しい。認知症と意識障害を混同しないこと

【ADLスコア — 必ず10桁数字、10文字未満は禁止】
各桁の意味と取りうる値（連結して10桁の文字列に。区切り文字や桁数不足はNG）:
  桁1 食事:       0/1/2/9（経管栄養なら0）
  桁2 移乗:       0/1/2/3/9（座位バランス困難=0）
  桁3 整容:       0/1/9（顔/髪/歯/ひげ剃り）
  桁4 トイレ動作: 0/1/2/9
  桁5 入浴:       0/1/9
  桁6 平地歩行:   0/1/2/3/9（車いす自立=1、一人介助で歩く=2、自立=3）
  桁7 階段:       0/1/2/9
  桁8 更衣:       0/1/2/9
  桁9 排便管理:   0(失禁)/1(時々失敗)/2(自立)/9
  桁10 排尿管理:  0(失禁)/1(時々失敗)/2(自立)/9
- 出力例: "2120010100"（必ず10文字）。"212001010"（9文字）はNG。"21200101009"（11文字）もNG
- 「手間のかかり具合」で評価する。経管栄養なら食事=0、絶食安静なら「もし食事や歩行をしたら」で判断
- "9"は極力使わない。判断材料がカルテにあれば数値を出す
- digit_evidence 配列は必ず10要素（各桁の根拠を1つずつ）

【入院時併存症 comorbidities ／ 入院後発症疾患 post_admission_diseases の判定指針 — 重要】
両方とも **Henryの登録病名（病名候補リスト）から uuid を選ぶ**。リストにないものを作らない。

■ comorbidities（入院時併存症）
- 採用条件: **患者プロフィールの「既往歴」セクションに記載された病名と意味的に一致する登録病名**
  * 例: 既往歴に「高血圧症、糖尿病、認知症」とあり、登録病名に「高血圧症 I10」「2型糖尿病 E14」「認知症 F03」があれば3件とも採用
- 除外: trigger_disease / resource_disease / 主傷病 (主病名フラグあり) に該当する病名
- 同じ疾患概念の病名が複数登録されていれば1つだけ（重複しない）
- 既往歴セクションに該当記載がない疾患は採用しない（カルテからの推測禁止）
- 最大10件、確実なものを優先

■ post_admission_diseases（入院後発症疾患）
- 採用条件: **医師記録・看護記録に「入院中に新たに発症した」と明示的に読み取れる登録病名**
  * 例: 「10/15 誤嚥性肺炎発症、抗生剤開始」等の発症記載があり、登録病名に「誤嚥性肺炎 J690」があれば採用
- 除外: trigger_disease / resource_disease / 主傷病 / 既に comorbidities で選んだ病名
- 発症の根拠が明示されていない病名は採用しない（登録日が入院後だからといって発症扱いにしない）
- 最大10件、確実なものを優先

【出力JSONスキーマ — value は必ず指定の値域・形式のみ。説明文字列を含めない】
{
  "trigger_disease": {
    "uuid": "string（病名候補リストの uuid を選択）",
    "evidence": "string（選択理由＋カルテ根拠）",
    "confidence": "high|medium|low"
  },
  "resource_disease": { "uuid": "...", "evidence": "...", "confidence": "..." },
  "comorbidities": {
    "selections": [
      { "uuid": "...", "evidence": "既往歴の該当記述を引用" }
    ],
    "confidence": "high|medium|low"
  },
  "post_admission_diseases": {
    "selections": [
      { "uuid": "...", "evidence": "発症記載のカルテ引用（日付＋本文）" }
    ],
    "confidence": "high|medium|low"
  },
  "swallowing_at_admission": { "value": 0, "evidence": "...", "confidence": "..." },
  "swallowing_at_discharge":  { "value": 0, "evidence": "...", "confidence": "..." },
  "outcome": { "value": 1, "evidence": "...", "confidence": "..." },
  "admission_route": {
    "value": "0",
    "evidence": "...",
    "confidence": "..."
  },
  "discharge_destination": {
    "value": "0",
    "evidence": "...",
    "confidence": "..."
  },
  "home_medical_care_before": { "value": 0, "evidence": "...", "confidence": "..." },
  "home_medical_care_after":  { "value": 0, "evidence": "...", "confidence": "..." },
  "dementia_level": { "value": "自立", "evidence": "...", "confidence": "..." },
  "bedridden_level": { "value": "J1", "evidence": "...", "confidence": "..." },
  "adl_at_admission": {
    "raw": "2120010100",
    "digit_evidence": ["食事=2: 根拠", "移乗=1: 根拠", ...10要素],
    "confidence": "..."
  },
  "adl_at_discharge":  {
    "raw": "2120010100",
    "digit_evidence": [...10要素],
    "confidence": "..."
  },
  "readmission_reason": {
    "category": "planned|unplanned|null",
    "code": 1,
    "evidence": "...",
    "confidence": "..."
  }
}

【value のコード値 — 厳格に1〜数文字の文字列のみ】

入院経路 admission_route.value:
  "0"=家庭からの入院 / "1"=他病院・診療所からの転院 / "2"=施設からの入院 / "3"=老健からの入院
  "4"=救急医療入院 / "5"=救急医療入院ではないが緊急入院 / "8"=その他

退院先 discharge_destination.value:
  "0"=他病棟への転棟 / "1"=家庭への退院（当院通院あり） / "2"=家庭への退院（他病院通院）
  "3"=家庭への退院（その他） / "4"=他病院・診療所への転院 / "5"=介護老人保健施設へ入所
  "6"=介護老人福祉施設へ入所 / "7"=社会福祉施設等へ入所 / "8"=死亡退院 / "9"=その他 / "a"=介護医療院へ入所

退院時転帰 outcome.value: 整数 1〜6（1=治癒・軽快, 2=寛解, 3=不変, 4=増悪, 5=他病死亡, 6=その他）。"8"等は禁止

入院前/退院後在宅医療 home_medical_care_*.value: 整数 0=無 / 1=当院が提供 / 2=他施設が提供 / 9=不明

認知症自立度 dementia_level.value: "自立" / "Ⅰ" / "Ⅱa" / "Ⅱb" / "Ⅲa" / "Ⅲb" / "Ⅳ" / "M" のいずれか
寝たきり度 bedridden_level.value: "J1" / "J2" / "A1" / "A2" / "B1" / "B2" / "C1" / "C2" のいずれか
嚥下障害 swallowing_*.value: 整数 0 / 1 / 9
ADL .raw: 必ず10桁の数字文字列`;

// ============================================================
// プロンプト構築
// ============================================================
export interface RenrakuPromptInput {
  patient: HenryPatient;
  hospitalization: HenryHospitalization;
  diseasesBeforeOrAtAdmission: DiagnosisItem[];
  diseasesAfterAdmission: DiagnosisItem[];
  diseasesAll: DiagnosisItem[];
  patientProfile: string;
  doctorRecords: Array<{ date: string; text: string; author: string }>;
  nursingRecords: Array<{ date: string; text: string }>;
  rehabRecords: Array<{ date: Date | null; text: string }>;
  sharedInfo: SharedInfo;
  vitalsSummary: string; // 入院時/退院時バイタル
  notableLabValues: string; // 異常値リスト
}

export function buildRenrakuPrompt(d: RenrakuPromptInput): string {
  const lines: string[] = [];

  // ===== 入院期間内の記録のみに絞る（複数入院をまたぐ混在を防止）=====
  const admissionIso = d.hospitalization.startDate
    ? `${d.hospitalization.startDate.year}-${String(d.hospitalization.startDate.month).padStart(2, '0')}-${String(d.hospitalization.startDate.day).padStart(2, '0')}`
    : '';
  const dischargeIsoCutoff = d.hospitalization.endDate
    ? `${d.hospitalization.endDate.year}-${String(d.hospitalization.endDate.month).padStart(2, '0')}-${String(d.hospitalization.endDate.day).padStart(2, '0')}`
    : '9999-12-31';
  // 入院前7日を含めて参考にする（紹介状参照や入院前評価のため）
  const lookbackIso = admissionIso ? shiftDate(admissionIso, -7) : '';
  const inPeriod = (iso: string): boolean => {
    if (!iso) return true;
    if (lookbackIso && iso < lookbackIso) return false;
    if (iso > dischargeIsoCutoff) return false;
    return true;
  };
  const filteredDoctor = d.doctorRecords.filter((r) => inPeriod(r.date));
  const filteredNursing = d.nursingRecords.filter((r) => inPeriod(r.date));
  const filteredRehab = d.rehabRecords.filter((r) => {
    const iso = r.date ? r.date.toISOString().slice(0, 10) : '';
    return inPeriod(iso);
  });

  lines.push('# 患者情報');
  lines.push(`氏名: ${d.patient.fullName}`);
  if (d.patient.detail?.birthDate?.year) {
    const today = new Date();
    const birth = new Date(d.patient.detail.birthDate.year, (d.patient.detail.birthDate.month || 1) - 1, d.patient.detail.birthDate.day || 1);
    const age = today.getFullYear() - birth.getFullYear();
    lines.push(`年齢: ${age}歳 性別: ${d.patient.detail.sexType?.includes('FEMALE') ? '女' : d.patient.detail.sexType?.includes('MALE') ? '男' : '不明'}`);
  }
  lines.push(`入院日: ${formatHenryDate(d.hospitalization.startDate)}`);
  if (d.hospitalization.endDate) lines.push(`退院日: ${formatHenryDate(d.hospitalization.endDate)}`);
  lines.push(`在院日数: ${d.hospitalization.hospitalizationDayCount?.value ?? '不明'}日`);
  lines.push('');

  // ===== 現病歴を最優先で提示（契機病名・主傷病判定の主要情報源）=====
  const presentIllness = extractPresentIllness(d.patientProfile);
  if (presentIllness) {
    lines.push('# 現病歴 ★契機病名・主傷病・医療資源病名の判定で最も重視するセクション★');
    lines.push(presentIllness);
    lines.push('');
  }

  // ===== 病名候補（入院日近接順ソート、LLMが選択する元データ）=====
  // 入院日に近い登録順で並べると「入院のきっかけ病名」が上位に来やすい
  const sortedCandidates = [...d.diseasesBeforeOrAtAdmission].sort((a, b) => {
    // 1. 入院日と病名登録日の差（小さい順）
    if (admissionIso) {
      const da = Math.abs(daysBetween(a.startDate, admissionIso));
      const db = Math.abs(daysBetween(b.startDate, admissionIso));
      if (da !== db) return da - db;
    }
    // 2. 同点なら登録日新しい順
    return b.startDate.localeCompare(a.startDate);
  });
  lines.push('# 病名候補（入院日に近い登録順 — 上位ほど「入院のきっかけ病名」の可能性が高い）');
  for (const dx of sortedCandidates) {
    const daysFromAdmission = admissionIso ? Math.abs(daysBetween(dx.startDate, admissionIso)) : 0;
    lines.push(`- uuid=${dx.uuid} | ${dx.name} | ICD10=${dx.icd10} | 登録日=${dx.startDate} (入院日との差${daysFromAdmission}日) | ${dx.isMain ? '主病名フラグあり' : '副病名'}${dx.isSuspected ? '(疑い)' : ''}`);
  }
  if (sortedCandidates.length === 0) lines.push('（該当なし）');
  lines.push('');

  if (d.diseasesAfterAdmission.length > 0) {
    lines.push('# 病名候補（入院後発症 — 医療資源病名の追加選択肢）');
    for (const dx of d.diseasesAfterAdmission) {
      lines.push(`- uuid=${dx.uuid} | ${dx.name} | ICD10=${dx.icd10} | 登録日=${dx.startDate}`);
    }
    lines.push('');
  }

  // ===== 患者プロフィール（既往歴・ADL等）=====
  // 注意: 患者プロフィールは入院ごとに上書きされる可能性があり、本入院期間より後の
  // 情報を含むことがある。LLMには参考情報として注意して使うよう指示する
  if (d.patientProfile) {
    lines.push('# 患者プロフィール（既往歴・入院前ADL等）');
    lines.push('※注意: このプロフィールは患者単位のドキュメントで、本入院より後に更新されている可能性あり。本入院期間（' + admissionIso + ' 〜 ' + dischargeIsoCutoff + '）と矛盾する記述があれば医師記録を優先');
    lines.push(d.patientProfile);
    lines.push('');
  }

  // ===== 共有情報（タイムラインV2、退院支援用）=====
  if (d.sharedInfo.notes) {
    lines.push('# 共有情報（多職種共有メモ — 退院先・在宅医療等の主要情報源）');
    lines.push(d.sharedInfo.notes);
    lines.push('');
  }

  // ===== 入院時/退院時のバイタル =====
  if (d.vitalsSummary) {
    lines.push('# バイタルサイン');
    lines.push(d.vitalsSummary);
    lines.push('');
  }

  // ===== 検査値（重要な数値）=====
  if (d.notableLabValues) {
    lines.push('# 検査値（重要な数値）');
    lines.push(d.notableLabValues);
    lines.push('');
  }

  // ===== 医師記録（入院期間内、初期＋退院前を優先）=====
  if (filteredDoctor.length > 0) {
    const focused = focusRecords(filteredDoctor);
    lines.push(`# 医師記録（入院期間 ${admissionIso} 〜 ${dischargeIsoCutoff} 内、初期＋退院前を優先抽出）`);
    for (const r of focused) {
      lines.push(`### ${r.date}${r.author ? ` (${r.author})` : ''}`);
      lines.push(r.text);
      lines.push('');
    }
  }

  // ===== 看護記録（入院期間内、同じく初期＋退院前を優先）=====
  if (filteredNursing.length > 0) {
    const focused = focusRecords(filteredNursing);
    lines.push('# 看護記録（入院期間内、初期＋退院前を優先抽出）');
    for (const r of focused) {
      lines.push(`### ${r.date}`);
      lines.push(r.text);
      lines.push('');
    }
  }

  // ===== リハビリ記録（入院期間内のもののみ、ADL判定の主要情報源）=====
  if (filteredRehab.length > 0) {
    lines.push('# リハビリ記録（入院期間内、ADL判定の主要情報源）');
    for (const r of filteredRehab.slice(-30)) {
      const date = r.date ? r.date.toISOString().slice(0, 10) : '不明';
      lines.push(`### ${date}`);
      lines.push(r.text);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('上記の情報のみに基づいて、指定された連絡表項目をJSON形式で返してください。');
  return lines.join('\n');
}

/** 入院初期7日 + 退院前7日に絞ってトークン節約 */
function focusRecords<T extends { date: string }>(records: T[]): T[] {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length <= 14) return sorted;
  return [...sorted.slice(0, 7), ...sorted.slice(-7)];
}

/** YYYY-MM-DD 形式の文字列間の日数差（dateA - dateB） */
function daysBetween(dateA: string, dateB: string): number {
  if (!dateA || !dateB) return 0;
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
}

/** YYYY-MM-DD を N日シフト */
function shiftDate(iso: string, days: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 患者プロフィール本文から「現病歴」セクションを抽出 */
function extractPresentIllness(profile: string): string {
  if (!profile) return '';
  // 【現病歴】〜次の【】見出し まで
  const m = profile.match(/【現病歴】([\s\S]*?)(?=【|$)/);
  if (m) return m[1].trim();
  // フォールバック: 「現病歴」キーワード以降
  const idx = profile.indexOf('現病歴');
  if (idx >= 0) {
    const after = profile.slice(idx);
    const nextHeader = after.slice(3).search(/【.{1,15}】/);
    if (nextHeader > 0) return after.slice(0, nextHeader + 3).trim();
    return after.slice(0, 400).trim();
  }
  return '';
}

// ============================================================
// 出力JSON の型
// ============================================================
interface FieldDecision<V> {
  value: V;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

interface DiseaseChoice {
  uuid: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

interface DiseaseSelections {
  selections: Array<{ uuid: string; evidence: string }>;
  confidence: 'high' | 'medium' | 'low';
}

interface AdlDecision {
  raw: string;
  digit_evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface ReadmissionReasonDecision {
  category: 'planned' | 'unplanned' | null;
  code: number | null;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface RenrakuLlmDecisions {
  trigger_disease: DiseaseChoice;
  resource_disease: DiseaseChoice;
  comorbidities?: DiseaseSelections;
  post_admission_diseases?: DiseaseSelections;
  swallowing_at_admission: FieldDecision<number>;
  swallowing_at_discharge: FieldDecision<number>;
  outcome: FieldDecision<number>;
  admission_route: FieldDecision<string>;
  discharge_destination: FieldDecision<string>;
  home_medical_care_before: FieldDecision<number>;
  home_medical_care_after: FieldDecision<number>;
  dementia_level: FieldDecision<string>;
  bedridden_level: FieldDecision<string>;
  adl_at_admission: AdlDecision;
  adl_at_discharge: AdlDecision;
  readmission_reason: ReadmissionReasonDecision;
}

// ============================================================
// レスポンスパース
// ============================================================
export function parseRenrakuResponse(content: string): RenrakuLlmDecisions {
  // Markdown コードブロックでラップされている場合の除去
  let trimmed = content.trim();
  const codeBlockMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (codeBlockMatch) trimmed = codeBlockMatch[1].trim();
  // 前後の説明文を除去（最初の { から最後の } まで）
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(trimmed) as RenrakuLlmDecisions;
  } catch (e) {
    throw new Error(`LLM出力JSONパース失敗: ${e instanceof Error ? e.message : e}\n生応答: ${content.slice(0, 500)}`);
  }
}

// ============================================================
// ai-proxy 経由でGemini呼び出し
// ============================================================
interface GeminiProxyResponse {
  success?: boolean;
  content?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function callRenrakuLlm(prompt: string): Promise<RenrakuLlmDecisions> {
  const url = LLM_PROVIDER === 'claude' ? CLAUDE_PROXY_URL : GEMINI_PROXY_URL;
  const body: Record<string, unknown> = {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 8192,
    model: LLM_MODEL,
  };
  if (LLM_PROVIDER === 'gemini') {
    body.response_format = 'json';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`renraku LLM プロキシエラー (${LLM_PROVIDER}): ${response.status} ${errBody.slice(0, 300)}`);
  }

  const data = (await response.json()) as GeminiProxyResponse;
  if (!data.success || !data.content) {
    throw new Error(`renraku LLM応答が空です (${LLM_PROVIDER})`);
  }

  console.log(
    `[renraku-prompt] LLM完了 [${LLM_PROVIDER}/${LLM_MODEL}] (input: ${data.usage?.input_tokens ?? '?'}, output: ${data.usage?.output_tokens ?? '?'})`,
  );

  return parseRenrakuResponse(data.content);
}

// ============================================================
// バリデーション（LLM出力の整合性チェック）
// ============================================================
export function validateLlmDecisions(
  decisions: RenrakuLlmDecisions,
  validDiseaseUuids: Set<string>,
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // 病名uuid が候補リストにあるかチェック
  if (decisions.trigger_disease?.uuid && !validDiseaseUuids.has(decisions.trigger_disease.uuid)) {
    warnings.push(`trigger_disease.uuid (${decisions.trigger_disease.uuid}) が候補リストにない`);
  }
  if (decisions.resource_disease?.uuid && !validDiseaseUuids.has(decisions.resource_disease.uuid)) {
    warnings.push(`resource_disease.uuid (${decisions.resource_disease.uuid}) が候補リストにない`);
  }
  for (const s of decisions.comorbidities?.selections ?? []) {
    if (s.uuid && !validDiseaseUuids.has(s.uuid)) {
      warnings.push(`comorbidities.uuid (${s.uuid}) が候補リストにない`);
    }
  }
  for (const s of decisions.post_admission_diseases?.selections ?? []) {
    if (s.uuid && !validDiseaseUuids.has(s.uuid)) {
      warnings.push(`post_admission_diseases.uuid (${s.uuid}) が候補リストにない`);
    }
  }

  // ADL10桁の形式チェック
  if (!/^\d{10}$/.test(decisions.adl_at_admission?.raw || '')) {
    warnings.push(`adl_at_admission.raw が10桁数字でない: "${decisions.adl_at_admission?.raw}"`);
  }
  if (!/^\d{10}$/.test(decisions.adl_at_discharge?.raw || '')) {
    warnings.push(`adl_at_discharge.raw が10桁数字でない: "${decisions.adl_at_discharge?.raw}"`);
  }

  // 嚥下障害は 0/1/9
  if (![0, 1, 9].includes(decisions.swallowing_at_admission?.value)) {
    warnings.push(`swallowing_at_admission.value が 0/1/9 でない: ${decisions.swallowing_at_admission?.value}`);
  }
  if (![0, 1, 9].includes(decisions.swallowing_at_discharge?.value)) {
    warnings.push(`swallowing_at_discharge.value が 0/1/9 でない: ${decisions.swallowing_at_discharge?.value}`);
  }

  // 退院時転帰は 1-6
  if (decisions.outcome?.value < 1 || decisions.outcome?.value > 6) {
    warnings.push(`outcome.value が 1-6 でない: ${decisions.outcome?.value}`);
  }

  return { valid: warnings.length === 0, warnings };
}
