// FF1ファイル（DPC様式1の患者単位提出データ）のパーサー
//
// フォーマット:
// - SHIFT-JISエンコード、CRLF改行、タブ区切り17列
// - 1患者1入院に対して複数行（各ペイロードコードごとに1行）
//
// 列構造:
// 1.施設コード 2.データ識別番号 3.入院年月日 4.回数管理番号 5.統括診療情報番号
// 6.コード 7.バージョン 8.連番
// 9〜17.ペイロード1〜9
//
// 仕様: 2026年度 DPC調査 実施説明資料（厚労省/DPC調査事務局）
import { readFileSync } from 'node:fs';

// ============================================================
// 型定義
// ============================================================
export interface FF1DiseaseEntry {
  icd10: string;      // ペイロード2（小数点なし、例: "S220", "I509"）
  addCode?: string;   // ペイロード3（病名付加コード、A006030のみ）
  modifierCode?: string; // ペイロード4（修飾語コード）
  name: string;       // ペイロード9（病名文字列）
  seq?: number;       // 連番（A006040/A006050で複数行ある場合）
}

export interface FF1Patient {
  // ヘッダ識別子
  facilityCode: string;
  dataIdentifier: string;     // 患者別識別子（K-ファイルと突合）
  admissionDate: string;      // YYYY-MM-DD
  hospitalizationCount: string;
  parentChildIndex: string;

  // A000010 患者属性
  birthDate: string;          // YYYY-MM-DD
  sex: '男' | '女' | '不明';
  postalCode: string;

  // A000020 入院情報
  admissionRoute: string;
  predefinedOrEmergency: string;
  hasHomeMedicalBefore: string;

  // A000030 退院情報
  dischargeDate: string;      // YYYY-MM-DD
  dischargeDestination: string;
  outcome: string;            // 1〜6
  death24h: string;
  hasHomeMedicalAfter: string;

  // A000031 様式1対象期間
  formStartDate: string;
  formEndDate: string;

  // A000040 診療科
  departmentCode: string;
  departmentChange: string;

  // A000060 診療目的・経過
  admissionPurpose: string;   // 1〜4

  // A000080 再入院調査
  readmissionType?: string;   // 1=計画的 / 2=計画外
  readmissionReason?: string;

  // A001010 身長・体重
  heightCm?: string;
  weightAtAdmission?: string;
  weightAtDischarge?: string;

  // A004010 高齢者情報（認知症自立度）
  dementiaLevel?: string;     // 0〜5

  // A004020 要介護度
  careLevel?: string;         // 0〜9

  // A004030 栄養情報
  glimAtAdmission?: string;
  swallowingAtAdmission: string;       // 0/1/9
  glimAtDischarge?: string;
  swallowingAtDischarge: string;       // 0/1/9
  nutritionRoute5AtAdmission: string;  // 5桁ビット列
  nutritionRoute5AtDischarge: string;  // 5桁ビット列
  nutritionAssessment48h?: string;

  // 病名
  mainDisease?: FF1DiseaseEntry;       // A006010
  triggerDisease?: FF1DiseaseEntry;    // A006020
  resourceDisease?: FF1DiseaseEntry;   // A006030
  comorbidities: FF1DiseaseEntry[];    // A006040（複数）
  postAdmissionDiseases: FF1DiseaseEntry[]; // A006050（複数）

  // ADL
  adlAtAdmission?: string;    // 10桁
  adlAtDischarge?: string;    // 10桁

  // JCS
  jcsAtAdmission?: string;
  jcsAtDischarge?: string;

  // 他にもM010010など重症度系コードがあるが、必要に応じて拡張
}

// ============================================================
// パース
// ============================================================
function decodeShiftJis(buf: Buffer): string {
  // Node標準では cp932 を扱えないので iconv-lite を使う想定だが、
  // ここではNode内蔵の TextDecoder を活用して shift_jis を試みる
  try {
    return new TextDecoder('shift_jis').decode(buf);
  } catch {
    // フォールバック: バイト列をそのままUTF8解釈（病名等の漢字が壊れる可能性あり）
    return buf.toString('utf8');
  }
}

function parseDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8 || yyyymmdd === '99999999' || yyyymmdd === '00000000') return '';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

interface RawRecord {
  facilityCode: string;
  dataIdentifier: string;
  admissionDate: string;     // YYYYMMDD のまま
  hospitalizationCount: string;
  parentChildIndex: string;
  code: string;
  version: string;
  seq: string;
  payloads: string[];        // P1〜P9
}

function parseLine(line: string): RawRecord | null {
  const cols = line.split('\t');
  if (cols.length < 8) return null;
  return {
    facilityCode: cols[0],
    dataIdentifier: cols[1],
    admissionDate: cols[2],
    hospitalizationCount: cols[3],
    parentChildIndex: cols[4],
    code: cols[5],
    version: cols[6],
    seq: cols[7],
    payloads: cols.slice(8), // ペイロード1〜9
  };
}

/** 患者キー = データ識別番号 + 入院年月日 */
function patientKey(rec: RawRecord): string {
  return `${rec.dataIdentifier}_${rec.admissionDate}`;
}

/**
 * FF1ファイルをパースして患者単位の構造化データに変換
 * @param path FF1ファイルパス（SHIFT-JISエンコード）
 */
export function parseFF1File(path: string): FF1Patient[] {
  const buf = readFileSync(path);
  const text = decodeShiftJis(buf);
  const lines = text.split(/\r?\n/);

  // 患者ごとにレコードを集約
  const byPatient = new Map<string, RawRecord[]>();
  let lineNum = 0;
  for (const line of lines) {
    lineNum++;
    if (!line.trim()) continue;
    // ヘッダ行スキップ（"施設コード" で始まる場合）
    if (lineNum === 1 && line.startsWith('施設コード')) continue;
    const rec = parseLine(line);
    if (!rec) continue;
    const key = patientKey(rec);
    if (!byPatient.has(key)) byPatient.set(key, []);
    byPatient.get(key)!.push(rec);
  }

  const patients: FF1Patient[] = [];
  for (const [key, records] of byPatient) {
    const patient = buildPatient(records);
    if (patient) patients.push(patient);
    else console.warn(`[ff1-parser] パース失敗: ${key}`);
  }
  return patients;
}

/** 1患者分のレコード群から構造化データを構築 */
function buildPatient(records: RawRecord[]): FF1Patient | null {
  if (records.length === 0) return null;
  const first = records[0];

  // レコードをコード別にindex化（連番ありはMap of arrayへ）
  const single = new Map<string, RawRecord>();
  const multi = new Map<string, RawRecord[]>();
  for (const r of records) {
    if (r.code === 'A006040' || r.code === 'A006050') {
      if (!multi.has(r.code)) multi.set(r.code, []);
      multi.get(r.code)!.push(r);
    } else {
      // 同コード複数は最新（最後）を採用
      single.set(r.code, r);
    }
  }

  const p = (code: string): RawRecord | undefined => single.get(code);
  const pl = (code: string, idx: number): string => {
    const rec = p(code);
    return rec?.payloads[idx - 1] || '';
  };

  // A000010
  const a010 = p('A000010');
  if (!a010) return null; // 患者属性は必須
  const birthDate = parseDate(pl('A000010', 1));
  const sexCode = pl('A000010', 2);
  const sex: '男' | '女' | '不明' = sexCode === '1' ? '男' : sexCode === '2' ? '女' : '不明';

  // A000020
  const admissionRoute = pl('A000020', 2);
  const predefinedOrEmergency = pl('A000020', 5);
  const hasHomeMedicalBefore = pl('A000020', 7);

  // A000030
  const dischargeDate = parseDate(pl('A000030', 1));
  const dischargeDestination = pl('A000030', 2);
  const outcome = pl('A000030', 3);
  const death24h = pl('A000030', 4);
  const hasHomeMedicalAfter = pl('A000030', 5);

  // A000031
  const formStartDate = parseDate(pl('A000031', 1));
  const formEndDate = parseDate(pl('A000031', 2));

  // A000040
  const departmentCode = pl('A000040', 2);
  const departmentChange = pl('A000040', 3);

  // A000060
  const admissionPurpose = pl('A000060', 2);

  // A000080
  const readmissionType = pl('A000080', 2) || undefined;
  const readmissionReason = pl('A000080', 3) || undefined;

  // A001010
  const heightCm = pl('A001010', 2) || undefined;
  const weightAtAdmission = pl('A001010', 3) || undefined;
  const weightAtDischarge = pl('A001010', 4) || undefined;

  // A004010
  const dementiaLevel = pl('A004010', 2) || undefined;

  // A004020
  const careLevel = pl('A004020', 2) || undefined;

  // A004030
  const glimAtAdmission = pl('A004030', 3) || undefined;
  const swallowingAtAdmission = pl('A004030', 4) || '9';
  const glimAtDischarge = pl('A004030', 5) || undefined;
  const swallowingAtDischarge = pl('A004030', 6) || '9';
  const nutritionRoute5AtAdmission = pl('A004030', 7) || '00000';
  const nutritionRoute5AtDischarge = pl('A004030', 8) || '00000';
  const nutritionAssessment48h = pl('A004030', 9) || undefined;

  // 病名
  const mainDisease = toDisease(p('A006010'));
  const triggerDisease = toDisease(p('A006020'));
  const resourceDisease = toDisease(p('A006030'), /*isResource*/ true);
  const comorbidities = (multi.get('A006040') || []).map((r) => toDisease(r)!).filter(Boolean);
  const postAdmissionDiseases = (multi.get('A006050') || []).map((r) => toDisease(r)!).filter(Boolean);

  // ADL
  const adlAtAdmission = pl('ADL0010', 2) || undefined;
  const adlAtDischarge = pl('ADL0020', 2) || undefined;

  // JCS
  const jcsAtAdmission = pl('JCS0010', 2) || undefined;
  const jcsAtDischarge = pl('JCS0020', 2) || undefined;

  return {
    facilityCode: first.facilityCode,
    dataIdentifier: first.dataIdentifier,
    admissionDate: parseDate(first.admissionDate),
    hospitalizationCount: first.hospitalizationCount,
    parentChildIndex: first.parentChildIndex,
    birthDate,
    sex,
    postalCode: pl('A000010', 3),
    admissionRoute,
    predefinedOrEmergency,
    hasHomeMedicalBefore,
    dischargeDate,
    dischargeDestination,
    outcome,
    death24h,
    hasHomeMedicalAfter,
    formStartDate,
    formEndDate,
    departmentCode,
    departmentChange,
    admissionPurpose,
    readmissionType,
    readmissionReason,
    heightCm,
    weightAtAdmission,
    weightAtDischarge,
    dementiaLevel,
    careLevel,
    glimAtAdmission,
    swallowingAtAdmission,
    glimAtDischarge,
    swallowingAtDischarge,
    nutritionRoute5AtAdmission,
    nutritionRoute5AtDischarge,
    nutritionAssessment48h,
    mainDisease,
    triggerDisease,
    resourceDisease,
    comorbidities,
    postAdmissionDiseases,
    adlAtAdmission,
    adlAtDischarge,
    jcsAtAdmission,
    jcsAtDischarge,
  };
}

function toDisease(rec: RawRecord | undefined, isResource = false): FF1DiseaseEntry | undefined {
  if (!rec) return undefined;
  const icd10 = rec.payloads[1] || '';
  if (!icd10) return undefined;
  return {
    icd10,
    addCode: isResource ? rec.payloads[2] || undefined : undefined,
    modifierCode: rec.payloads[3] || undefined,
    name: rec.payloads[8] || '',
    seq: Number(rec.seq) || undefined,
  };
}

// ============================================================
// 動作テスト用エントリポイント（npx tsx で実行可）
// ============================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: ff1-parser.ts <FF1.txt>');
    process.exit(2);
  }
  const patients = parseFF1File(path);
  console.log(`患者数: ${patients.length}`);
  for (const p of patients) {
    console.log('---');
    console.log(`データ識別番号: ${p.dataIdentifier}`);
    console.log(`入院日: ${p.admissionDate} 退院日: ${p.dischargeDate}`);
    console.log(`生年月日: ${p.birthDate} 性別: ${p.sex}`);
    console.log(`入院目的: ${p.admissionPurpose} 退院時転帰: ${p.outcome}`);
    console.log(`JCS: 入院時=${p.jcsAtAdmission} 退院時=${p.jcsAtDischarge}`);
    console.log(`ADL: 入院時=${p.adlAtAdmission} 退院時=${p.adlAtDischarge}`);
    console.log(`嚥下障害: 入院時=${p.swallowingAtAdmission} 退院時=${p.swallowingAtDischarge}`);
    console.log(`栄養5桁: 入院時=${p.nutritionRoute5AtAdmission} 退院時=${p.nutritionRoute5AtDischarge}`);
    console.log(`主傷病: ${p.mainDisease?.icd10} ${p.mainDisease?.name}`);
    console.log(`契機病名: ${p.triggerDisease?.icd10} ${p.triggerDisease?.name}`);
    console.log(`医療資源: ${p.resourceDisease?.icd10} ${p.resourceDisease?.name}`);
    console.log(`併存病名(${p.comorbidities.length}件): ${p.comorbidities.map((d) => `${d.icd10} ${d.name}`).join(', ')}`);
  }
}
