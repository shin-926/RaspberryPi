// 連絡表の各欄を「Henry構造化データ → 様式1の値」に変換するドメイン関数群
// LLMが不要な機械的判定はここで完結させ、LLMが必要な項目はrenraku-promptに分岐する。
//
// マッピング: ~/Projects/Henry/_private/dpc-renraku-mapping.md
import type {
  DiagnosisItem, Decision, AdlScore,
  NutritionOrder, InjectionOrder, CQDModuleCollection,
  PressureUlcerRecord, OxygenEntry, BodyMeasurement,
} from './renraku-types.ts';
import { classifyEnteralRoute, classifyInjectionRoute, extractOxygenData } from './renraku-extract.ts';

// ============================================================
// 病名フィルタ（入院日との関係で「契機/併存/発症後」を仕分け）
// ============================================================
export interface DiseaseClassification {
  beforeOrAtAdmission: DiagnosisItem[]; // 入院日以前 or 入院日に登録（契機候補・併存）
  afterAdmission: DiagnosisItem[];      // 入院日後に登録（発症病名）
  mainAtDischarge: DiagnosisItem | null; // 退院時主病名
  suspected: DiagnosisItem[];           // 疑い病名
}

export function classifyDiseases(
  diseases: DiagnosisItem[],
  admissionDateIso: string,
): DiseaseClassification {
  const beforeOrAt: DiagnosisItem[] = [];
  const after: DiagnosisItem[] = [];
  const suspected: DiagnosisItem[] = [];
  let main: DiagnosisItem | null = null;

  for (const d of diseases) {
    if (d.isSuspected) {
      suspected.push(d);
      continue;
    }
    if (d.isMain) main = d;
    if (d.startDate && d.startDate <= admissionDateIso) {
      beforeOrAt.push(d);
    } else {
      after.push(d);
    }
  }
  return { beforeOrAtAdmission: beforeOrAt, afterAdmission: after, mainAtDischarge: main, suspected };
}

// ============================================================
// 連絡表Ⅱ送り判定（病名に肝硬変・熱傷・凍傷・電撃傷・敗血症を含むか）
// ============================================================
const FORM_II_TRIGGER_PATTERNS = [
  /肝硬変/, /熱傷/, /凍傷/, /電撃傷/, /敗血症/,
  // 連絡表Ⅱの他セクションを開く病名（呼吸器・循環器・脳卒中・急性膵炎）
  /肺炎|インフルエンザ|ウイルス性肺炎/,
  /高血圧性心不全|心不全|I50/,
  /狭心症|慢性虚血性心疾患/,
  /くも膜下出血|脳動脈瘤|脳梗塞|一過性脳虚血|脳卒中|脳血管障害|頭蓋内血腫/,
  /急性膵炎/,
];

export function detectFormIITriggers(diseases: DiagnosisItem[]): string[] {
  const hits: string[] = [];
  for (const d of diseases) {
    if (FORM_II_TRIGGER_PATTERNS.some((p) => p.test(d.name) || p.test(d.icd10))) {
      hits.push(d.name);
    }
  }
  return Array.from(new Set(hits));
}

// ============================================================
// 入院目的のヒューリスティック（フェーズ1：マオカは原則 4=その他の加療）
// ============================================================
export interface AdmissionPurposeHint {
  defaultValue: 1 | 2 | 3 | 4;
  hint: string;
}

export function inferAdmissionPurpose(
  triggerDiseaseName: string,
  prescriptions: Array<Record<string, unknown>>,
): AdmissionPurposeHint {
  // 抗がん剤・放射線療法レジメンなら "3=計画された短期入院の繰り返し"
  const hasChemoOrRT = prescriptions.some((rx) => {
    const orderStatus = rx.orderStatus as string | undefined;
    if (orderStatus !== 'ORDER_STATUS_ACTIVE') return false;
    return /化学療法|抗がん|放射線/.test(JSON.stringify(rx));
  });
  if (hasChemoOrRT) return { defaultValue: 3, hint: '化学療法/放射線療法オーダーあり' };

  // 抜釘術が予定/実施されているなら "3"
  if (/抜釘|プレート抜去/.test(triggerDiseaseName)) {
    return { defaultValue: 3, hint: '抜釘・プレート抜去目的の入院' };
  }

  // 糖尿病教育入院
  if (/糖尿病.*教育|教育.*糖尿病/.test(triggerDiseaseName)) {
    return { defaultValue: 2, hint: '糖尿病教育入院' };
  }

  // 上記いずれにも該当しないならマオカでは "4=その他の加療" がデフォルト
  return { defaultValue: 4, hint: 'マオカは療養型のためデフォルト=4' };
}

// ============================================================
// 経管・経静脈栄養 5桁ビット列（A004030 ⑦/⑧）
// 桁:  1=経鼻胃管  2=胃瘻腸瘻  3=末梢静脈栄養  4=中心静脈栄養  5=皮下注射
// ============================================================
export function decideNutritionRoute5Digit(
  date: Date,
  nutritionOrders: NutritionOrder[],
  injectionOrders: InjectionOrder[],
): Decision<string> {
  const enteral = classifyEnteralRoute(date, nutritionOrders);
  const inj = classifyInjectionRoute(date, injectionOrders);

  const digits = [
    enteral.isNGTube ? 1 : 0,
    enteral.isGastrostomy ? 1 : 0,
    inj.isPeripheralVenous && inj.isNutritionMedicine ? 1 : 0,
    inj.isCentralVenous ? 1 : 0,
    inj.isSubcutaneous ? 1 : 0,
  ];
  const raw = digits.join('');

  return {
    value: raw,
    confidence: 'high',
    evidence: [
      { location: 'nutritionOrders', text: `enteral=${JSON.stringify(enteral)}` },
      { location: 'injectionOrders', text: `injection=${JSON.stringify(inj)}` },
    ],
    needsMdReview: inj.isPeripheralVenous && !inj.isNutritionMedicine,
    // ↑ 末梢ルートがあるが栄養剤と判定できなかった場合は医師確認推奨
  };
}

// ============================================================
// JCS（連絡表Ⅰ入院時 / 退院時）
// マオカは急性期ではないので デフォルト = "0"。明確な記述があるときだけ昇格。
// 抽出はLLMに委ねるが、ルール側でカルテ本文からのキーワード一次抽出を試みる
// ============================================================
const JCS_PATTERN = /JCS[\s:：]*(\d{1,3})\s*([RIArial]{0,3})?/i;

export function tryExtractJcsFromText(text: string): string | null {
  const m = text.match(JCS_PATTERN);
  if (!m) return null;
  const num = m[1];
  const supp = (m[2] || '').toUpperCase();
  return num + supp;
}

/**
 * 入院時/退院時の意識障害JCS判定。
 * 一次：医師記録・看護記録の本文から正規表現抽出
 * 二次：見つからない場合は "0"（記載なし＝意識障害なし、マオカは1桁前提）
 * 信頼度は記載があれば high、無ければ medium（医師確認推奨）
 */
export function decideJCS(
  records: Array<{ date: Date | null; text: string }>,
  baseDate: Date,
  windowDays = 3,
): Decision<string> {
  // baseDate ± windowDays の記録だけを対象に検索
  const targets = records.filter((r) => {
    if (!r.date) return false;
    const diff = Math.abs(r.date.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24);
    return diff <= windowDays;
  });

  for (const r of targets) {
    const jcs = tryExtractJcsFromText(r.text);
    if (jcs) {
      return {
        value: jcs,
        confidence: 'high',
        evidence: [{ location: r.date?.toISOString().slice(0, 10) || '不明', text: `JCS ${jcs}` }],
      };
    }
  }
  // デフォルト: マオカは急性期外なのでJCS=0
  return {
    value: '0',
    confidence: 'medium',
    evidence: [],
    needsMdReview: true,
  };
}

// ============================================================
// ADLスコア10桁の構築（看護師連絡表 → 様式1 ADL0010/0020）
// 構造化Decisionのみ。LLMにBarthel判定を委ねる場合は別関数。
// ============================================================
export function buildAdlScoreFromDigits(digits: string): AdlScore {
  if (!/^\d{10}$/.test(digits)) {
    throw new Error(`ADL must be 10 digits: ${digits}`);
  }
  const d = digits.split('').map((c) => parseInt(c, 10));
  return {
    raw: digits,
    meal: d[0] as 0 | 1 | 2 | 9,
    transfer: d[1] as 0 | 1 | 2 | 3 | 9,
    grooming: d[2] as 0 | 1 | 9,
    toilet: d[3] as 0 | 1 | 2 | 9,
    bath: d[4] as 0 | 1 | 9,
    walking: d[5] as 0 | 1 | 2 | 3 | 9,
    stairs: d[6] as 0 | 1 | 2 | 9,
    dressing: d[7] as 0 | 1 | 2 | 9,
    bowel: d[8] as 0 | 1 | 2 | 9,
    urine: d[9] as 0 | 1 | 2 | 9,
  };
}

// ============================================================
// 体重・BMI
// ============================================================
export function pickWeightAtDate(
  measurements: BodyMeasurement[],
  targetIso: string,
): { weightKg: number | null; heightCm: number | null; bmi: number | null } {
  if (measurements.length === 0) return { weightKg: null, heightCm: null, bmi: null };
  // measuredAt が targetIso 以前で最も近いものを採用
  const sorted = [...measurements].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  let pick: BodyMeasurement | null = null;
  for (const m of sorted) {
    if (m.measuredAt.slice(0, 10) <= targetIso) pick = m;
  }
  if (!pick) pick = sorted[0];
  const weightKg = pick.weightGram != null ? pick.weightGram / 1000 : null;
  const heightCm = pick.heightCm;
  const bmi = weightKg && heightCm ? Math.round((weightKg / Math.pow(heightCm / 100, 2)) * 10) / 10 : null;
  return { weightKg, heightCm, bmi };
}

// ============================================================
// 褥瘡の有無（看護師連絡表 + A001040）
// ============================================================
export function hasActivePressureUlcerAt(records: PressureUlcerRecord[], targetIso: string): boolean {
  // targetIso 時点以前の最新の評価記録に部位があれば「あり」
  const sorted = [...records]
    .filter((r) => r.date)
    .sort((a, b) => (a.date!.getTime() - b.date!.getTime()));
  let latest: PressureUlcerRecord | null = null;
  for (const r of sorted) {
    if (r.date!.toISOString().slice(0, 10) <= targetIso) latest = r;
  }
  if (!latest) return false;
  return !!latest.site && latest.site.length > 0;
}

// ============================================================
// 入院時/退院時の酸素投与判定（連絡表Ⅱ呼吸不全用）
// ============================================================
export interface OxygenStatusAt {
  hasOxygen: boolean;
  flow: string | null;   // 酸素流量
  method: string | null; // 投与方法（カニューレ/マスク/NPPV等）
  hasRespiratorySupport: boolean; // NPPV/挿管なら true
}

export function decideOxygenStatusAt(
  modules: CQDModuleCollection[],
  targetIso: string,
): OxygenStatusAt {
  const map = extractOxygenData(modules);
  const entries = map.get(targetIso) || [];
  if (entries.length === 0) {
    return { hasOxygen: false, flow: null, method: null, hasRespiratorySupport: false };
  }
  // その日の入院初時刻（time が小さいもの）を採用
  const first: OxygenEntry = entries[0];
  const method = first.method || '';
  const hasRespiratorySupport = /NPPV|挿管|呼吸器|BiPAP|CPAP/.test(method);
  return {
    hasOxygen: !!first.flow && first.flow !== '0',
    flow: first.flow,
    method: first.method,
    hasRespiratorySupport,
  };
}

// ============================================================
// 入院時収縮期血圧の連絡表Ⅱ区分（1=<100 / 2=100〜140 / 3=>140）
// ============================================================
export function categorizeSBP(sbp: number): 1 | 2 | 3 {
  if (sbp < 100) return 1;
  if (sbp <= 140) return 2;
  return 3;
}

// ============================================================
// BNP / NT-proBNP のM050090カテゴリ判定
// 1=BNP<400 or NT-proBNP<1800
// 2=BNP 400-1200 or NT-proBNP 1800-5000
// 3=BNP>=1200 or NT-proBNP>=5000
// 9=不明
// ============================================================
export function categorizeBNP(
  bnp: number | null,
  ntProBnp: number | null,
): 1 | 2 | 3 | 9 {
  if (bnp != null) {
    if (bnp < 400) return 1;
    if (bnp < 1200) return 2;
    return 3;
  }
  if (ntProBnp != null) {
    if (ntProBnp < 1800) return 1;
    if (ntProBnp < 5000) return 2;
    return 3;
  }
  return 9;
}

// ============================================================
// 再入院 4週以内判定（連絡表Ⅰ入院時後半・A000080トリガー）
// ============================================================
export function isReadmissionWithin4Weeks(
  currentAdmissionIso: string,
  previousDischargeIso: string | null,
): boolean {
  if (!previousDischargeIso) return false;
  const cur = new Date(currentAdmissionIso).getTime();
  const prev = new Date(previousDischargeIso).getTime();
  const days = (cur - prev) / (1000 * 60 * 60 * 24);
  return days >= 0 && days <= 28;
}
