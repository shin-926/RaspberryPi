// DPC連絡表自動生成 精度検証スクリプト（FF1ファイル直接読込み版）
//
// 入力:
//   --ff1 <path>   FF1ファイル（様式1提出済み生データ、SHIFT-JIS）
//   --kn  <path>   Knファイル（患者識別情報、SHIFT-JIS CSV）
//   --output-dir <dir>  レポート出力先（デフォルト ./_out/verify）
//   --max <N>       先頭N件のみ処理（デバッグ用）
//
// 流れ:
//   1. FF1パース → 患者単位の構造化「正解」データ
//   2. Knパース → カナ名・生年月日を付与
//   3. Henryでカナ名+生年月日で患者検索 → UUID取得
//   4. generateRenrakuForms() → Henry+LLMの「予測」生成
//   5. 項目別比較 → summary.csv / mismatches.csv
//
// 事務側の作業は不要（既にDPCシステムが出力するファイルをそのまま使う）

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from './graphql.ts';
import { generateRenrakuForms } from './renraku.ts';
import { parseFF1File } from './ff1-parser.ts';
import { parseKnFile, indexKnByPatientKey, attachIdentity, type FF1PatientWithIdentity } from './kn-parser.ts';
import type { DischargeTarget } from './detect.ts';
import type { RenrakuFormBundle } from './renraku-types.ts';

// ============================================================
// CLI引数
// ============================================================
const argv = process.argv.slice(2);
function arg(name: string): string | null {
  const i = argv.findIndex((a) => a === `--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}
const FF1_PATH = arg('ff1');
const KN_PATH = arg('kn');
const OUTPUT_DIR = arg('output-dir') || './_out/verify';
const MAX = Number(arg('max')) || Number.MAX_SAFE_INTEGER;

if (!FF1_PATH || !KN_PATH) {
  console.error('Usage: verify-renraku.ts --ff1 <FF1.txt> --kn <Kn.csv> [--output-dir <dir>] [--max <N>]');
  process.exit(2);
}

// ============================================================
// Henry患者検索（カナ名+生年月日マッチ）
// ============================================================
const Q_SEARCH_PATIENT = `
  query ListPatientsV2($input: ListPatientsV2RequestInput!) {
    listPatientsV2(input: $input) {
      entries {
        patient {
          uuid
          serialNumber
          fullName
          fullNamePhonetic
          detail {
            sexType
            birthDate { year month day }
          }
        }
      }
      nextPageToken
    }
  }`;

interface HenryPatientHit {
  uuid: string;
  serialNumber: string;
  fullName: string;
  fullNamePhonetic: string;
  birthDateIso: string;
  sex: '男' | '女' | '不明';
}

async function searchByKana(kana: string): Promise<HenryPatientHit[]> {
  const data = await query<{
    listPatientsV2?: {
      entries?: Array<{
        patient?: {
          uuid: string;
          serialNumber: string;
          fullName: string;
          fullNamePhonetic: string;
          detail?: { sexType?: string; birthDate?: { year: number; month: number; day: number } };
        };
      }>;
    };
  }>(Q_SEARCH_PATIENT, {
    input: {
      generalFilter: { query: kana, patientCareType: 'PATIENT_CARE_TYPE_ANY' },
      hospitalizationFilter: { doctorUuid: null, roomUuids: [], wardUuids: [], states: [], onlyLatest: true },
      sorts: [],
      pageSize: 20,
      pageToken: '',
    },
  });
  const entries = data.listPatientsV2?.entries || [];
  return entries
    .filter((e) => e.patient?.uuid)
    .map((e) => {
      const p = e.patient!;
      const bd = p.detail?.birthDate;
      const sexType = p.detail?.sexType || '';
      return {
        uuid: p.uuid,
        serialNumber: p.serialNumber,
        fullName: p.fullName,
        fullNamePhonetic: p.fullNamePhonetic,
        birthDateIso: bd ? `${bd.year}-${String(bd.month).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}` : '',
        sex: sexType.includes('FEMALE') ? '女' : sexType.includes('MALE') ? '男' : '不明',
      };
    });
}

/**
 * カナ名 + 生年月日で完全一致する患者を1人見つける
 */
async function findHenryPatient(
  kana: string,
  birthDateIso: string,
  sex: '男' | '女' | '不明',
): Promise<HenryPatientHit | null> {
  if (!kana || !birthDateIso) return null;
  // カナ表記の揺れに対応（半角・全角・スペース）
  const candidates = await searchByKana(kana);
  // 生年月日完全一致 → 性別一致を優先
  const byBirth = candidates.filter((c) => c.birthDateIso === birthDateIso);
  if (byBirth.length === 0) {
    // フォールバック: カナの先頭3文字で再検索
    if (kana.length > 3) {
      const fallback = await searchByKana(kana.slice(0, 3));
      const byBirthFb = fallback.filter((c) => c.birthDateIso === birthDateIso);
      if (byBirthFb.length === 1) return byBirthFb[0];
    }
    return null;
  }
  if (byBirth.length === 1) return byBirth[0];
  // 複数候補：性別で絞り込み
  const bySex = byBirth.filter((c) => c.sex === sex);
  return bySex[0] || byBirth[0];
}

// ============================================================
// 項目別比較
// ============================================================
interface CompareResult {
  dataIdentifier: string;
  henrySerial: string;
  field: string;
  expected: string;
  actual: string;
  match: 'exact' | 'partial' | 'mismatch' | 'na';
  note?: string;
}

function compare(
  ff1: FF1PatientWithIdentity,
  henrySerial: string,
  bundle: RenrakuFormBundle,
): CompareResult[] {
  const r: CompareResult[] = [];
  const id = ff1.dataIdentifier;

  // 入院目的
  r.push(row(id, henrySerial, '入院目的', ff1.admissionPurpose, String(bundle.doctorFormI_admission.admissionPurpose.value)));

  // 入院時契機病名 ICD10（前3文字部分一致を許容）
  r.push({
    dataIdentifier: id,
    henrySerial,
    field: '入院時契機病名_ICD10',
    expected: ff1.triggerDisease?.icd10 || '',
    actual: bundle.doctorFormI_admission.triggerDisease.value?.icd10 || '',
    match: icdMatch(ff1.triggerDisease?.icd10 || '', bundle.doctorFormI_admission.triggerDisease.value?.icd10 || ''),
  });

  // 入院時JCS
  r.push(row(id, henrySerial, '入院時JCS', ff1.jcsAtAdmission || '', bundle.doctorFormI_admission.jcsAtAdmission.value, normalizeJcs));

  // 入院時嚥下障害
  r.push(row(id, henrySerial, '入院時嚥下障害', ff1.swallowingAtAdmission, String(bundle.doctorFormI_admission.swallowingImpairment.value)));

  // 入院時 経管・経静脈栄養5桁
  r.push(row(id, henrySerial, '入院時_経管経静脈栄養5桁', ff1.nutritionRoute5AtAdmission, bundle.doctorFormI_admission.nutritionRoute5.value));

  // 退院時転帰
  r.push(row(id, henrySerial, '退院時転帰', ff1.outcome, String(bundle.doctorFormI_discharge.outcome.value)));

  // 退院時JCS
  r.push(row(id, henrySerial, '退院時JCS', ff1.jcsAtDischarge || '', bundle.doctorFormI_discharge.jcsAtDischarge.value, normalizeJcs));

  // 退院時嚥下障害
  r.push(row(id, henrySerial, '退院時嚥下障害', ff1.swallowingAtDischarge, String(bundle.doctorFormI_discharge.swallowingImpairmentAtDischarge.value)));

  // 退院時 経管・経静脈栄養5桁
  r.push(row(id, henrySerial, '退院時_経管経静脈栄養5桁', ff1.nutritionRoute5AtDischarge, bundle.doctorFormI_discharge.nutritionRoute5AtDischarge.value));

  // 主傷病ICD10
  r.push({
    dataIdentifier: id,
    henrySerial,
    field: '主傷病_ICD10',
    expected: ff1.mainDisease?.icd10 || '',
    actual: bundle.doctorFormI_discharge.mainDisease?.icd10 || '',
    match: icdMatch(ff1.mainDisease?.icd10 || '', bundle.doctorFormI_discharge.mainDisease?.icd10 || ''),
  });

  // 医療資源病名 ICD10
  r.push({
    dataIdentifier: id,
    henrySerial,
    field: '医療資源_ICD10',
    expected: ff1.resourceDisease?.icd10 || '',
    actual: bundle.doctorFormI_discharge.resourceDisease.value?.icd10 || '',
    match: icdMatch(ff1.resourceDisease?.icd10 || '', bundle.doctorFormI_discharge.resourceDisease.value?.icd10 || ''),
  });

  // 入院時ADL10桁
  r.push({
    dataIdentifier: id,
    henrySerial,
    field: '入院時ADL10桁',
    expected: ff1.adlAtAdmission || '',
    actual: bundle.nurseFormAdmission.adlScoreAtAdmission.value.raw,
    match: adlMatch(ff1.adlAtAdmission || '', bundle.nurseFormAdmission.adlScoreAtAdmission.value.raw),
  });

  // 退院時ADL10桁
  r.push({
    dataIdentifier: id,
    henrySerial,
    field: '退院時ADL10桁',
    expected: ff1.adlAtDischarge || '',
    actual: bundle.nurseFormDischarge.adlScoreAtDischarge.value.raw,
    match: adlMatch(ff1.adlAtDischarge || '', bundle.nurseFormDischarge.adlScoreAtDischarge.value.raw),
  });

  // 退院先（コード値のみで比較。LLMが "4=他病院転院" を返すケースに対応）
  r.push(row(id, henrySerial, '退院先', ff1.dischargeDestination, bundle.nurseFormDischarge.dischargeDestination.value, extractLeadingCode));

  // 認知症自立度
  r.push(row(id, henrySerial, '認知症自立度', ff1.dementiaLevel || '', dementiaLevelToFf1Code(bundle.nurseFormAdmission.dementiaLevel.value)));

  // 入院前在宅医療
  r.push(row(id, henrySerial, '入院前在宅医療', ff1.hasHomeMedicalBefore, String(bundle.nurseFormAdmission.homeMedicalCareBeforeAdmission.value)));

  // 退院後在宅医療
  r.push(row(id, henrySerial, '退院後在宅医療', ff1.hasHomeMedicalAfter, String(bundle.nurseFormDischarge.homeMedicalCareAfterDischarge.value)));

  return r;
}

function row(
  dataIdentifier: string,
  henrySerial: string,
  field: string,
  expected: string,
  actual: string,
  normalize?: (s: string) => string,
): CompareResult {
  if (!expected) return { dataIdentifier, henrySerial, field, expected, actual, match: 'na' };
  const e = normalize ? normalize(expected) : expected;
  const a = normalize ? normalize(actual) : actual;
  return { dataIdentifier, henrySerial, field, expected, actual, match: e === a ? 'exact' : 'mismatch' };
}

/** "4=他病院転院" のような形式から先頭のコードだけ抽出（数字、英字小文字、'a'-'z'対応） */
function extractLeadingCode(s: string): string {
  if (!s) return '';
  const m = s.trim().match(/^([0-9a-z])/i);
  return m ? m[1].toLowerCase() : s.trim();
}

/** ICD10は前3文字（カテゴリ）で部分一致を許容 */
function icdMatch(expected: string, actual: string): 'exact' | 'partial' | 'mismatch' | 'na' {
  if (!expected) return 'na';
  if (!actual) return 'mismatch';
  const e = expected.toUpperCase().replace(/\./g, '');
  const a = actual.toUpperCase().replace(/\./g, '');
  if (e === a) return 'exact';
  if (e.slice(0, 3) === a.slice(0, 3)) return 'partial';
  return 'mismatch';
}

function normalizeJcs(s: string): string {
  if (!s) return '';
  const m = s.match(/^(\d+)([RIArial]*)$/);
  if (!m) return s.toUpperCase();
  const num = m[1];
  const supp = (m[2] || '').toUpperCase().split('').sort().join('');
  return num + supp;
}

function adlMatch(expected: string, actual: string): 'exact' | 'partial' | 'mismatch' | 'na' {
  if (!expected) return 'na';
  if (!actual) return 'mismatch';
  if (expected === actual) return 'exact';
  if (expected.length !== 10 || actual.length !== 10) return 'mismatch';
  let same = 0;
  for (let i = 0; i < 10; i++) if (expected[i] === actual[i]) same++;
  return same >= 7 ? 'partial' : 'mismatch';
}

/** Henryの認知症自立度 (自立/Ⅰ/Ⅱa/Ⅱb/Ⅲa/Ⅲb/Ⅳ/M) → FF1コード(0〜5) */
function dementiaLevelToFf1Code(level: string): string {
  switch (level) {
    case '自立': return '0';
    case 'Ⅰ': return '1';
    case 'Ⅱa': case 'Ⅱb': return '2';
    case 'Ⅲa': case 'Ⅲb': return '3';
    case 'Ⅳ': return '4';
    case 'M': return '5';
    default: return '';
  }
}

// ============================================================
// レポート
// ============================================================
interface ReportSummary {
  field: string;
  total: number;
  exact: number;
  partial: number;
  mismatch: number;
  na: number;
  exactRate: number;
  exactPlusPartialRate: number;
}

function buildSummary(all: CompareResult[]): ReportSummary[] {
  const byField = new Map<string, CompareResult[]>();
  for (const r of all) {
    if (!byField.has(r.field)) byField.set(r.field, []);
    byField.get(r.field)!.push(r);
  }
  const out: ReportSummary[] = [];
  for (const [field, results] of byField) {
    const exact = results.filter((r) => r.match === 'exact').length;
    const partial = results.filter((r) => r.match === 'partial').length;
    const mismatch = results.filter((r) => r.match === 'mismatch').length;
    const na = results.filter((r) => r.match === 'na').length;
    const valid = exact + partial + mismatch;
    out.push({
      field,
      total: results.length,
      exact,
      partial,
      mismatch,
      na,
      exactRate: valid > 0 ? exact / valid : 0,
      exactPlusPartialRate: valid > 0 ? (exact + partial) / valid : 0,
    });
  }
  return out;
}

function writeSummaryCsv(path: string, summary: ReportSummary[]): void {
  const lines: string[] = ['項目,件数,一致,部分一致,不一致,N/A,一致率,一致+部分一致率'];
  for (const s of summary) {
    lines.push(
      [
        s.field,
        s.total,
        s.exact,
        s.partial,
        s.mismatch,
        s.na,
        (s.exactRate * 100).toFixed(1) + '%',
        (s.exactPlusPartialRate * 100).toFixed(1) + '%',
      ].join(','),
    );
  }
  writeFileSync(path, lines.join('\n'));
}

function writeMismatchCsv(path: string, all: CompareResult[]): void {
  const mismatches = all.filter((r) => r.match === 'mismatch' || r.match === 'partial');
  const lines: string[] = ['データ識別番号,Henry患者番号,項目,FF1正解,Henry出力,判定,判断列'];
  for (const r of mismatches) {
    lines.push([r.dataIdentifier, r.henrySerial, r.field, r.expected, r.actual, r.match, ''].join(','));
  }
  writeFileSync(path, lines.join('\n'));
}

// ============================================================
// メイン
// ============================================================
async function main(): Promise<void> {
  const started = new Date();
  console.log(`[verify] FF1パース中: ${FF1_PATH}`);
  const ff1Patients = parseFF1File(FF1_PATH!);
  console.log(`[verify] FF1患者数: ${ff1Patients.length}`);

  console.log(`[verify] Knパース中: ${KN_PATH}`);
  const knRecords = parseKnFile(KN_PATH!);
  const knByKey = indexKnByPatientKey(knRecords);
  const withIdentity = attachIdentity(ff1Patients, knByKey);

  const matched = withIdentity.filter((p) => p.kanaName);
  const unmatched = withIdentity.filter((p) => !p.kanaName);
  console.log(`[verify] Kn突合: ${matched.length}件成功 / ${unmatched.length}件 不一致`);
  for (const u of unmatched) {
    console.warn(`  - Kn未突合: dataId=${u.dataIdentifier} 入院日=${u.admissionDate}`);
  }

  // 在院中患者（FF1の退院日が空）は検証対象外
  const discharged = matched.filter((p) => p.dischargeDate);
  const inHospital = matched.filter((p) => !p.dischargeDate);
  console.log(`[verify] 退院済み: ${discharged.length}件 / 在院中（スキップ）: ${inHospital.length}件`);
  for (const ih of inHospital) {
    console.log(`  - 在院中スキップ: ${ih.dataIdentifier} ${ih.kanaName} 入院日${ih.admissionDate}`);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const targets = discharged.slice(0, MAX);
  const allResults: CompareResult[] = [];
  let processed = 0;
  let failed = 0;
  let unresolved = 0;

  for (const ff1 of targets) {
    try {
      // Henry患者検索（カナ+生年月日）
      const henry = await findHenryPatient(ff1.kanaName, ff1.birthDate, ff1.sex);
      if (!henry) {
        console.warn(`[verify] Henry患者未解決: ${ff1.dataIdentifier} ${ff1.kanaName} ${ff1.birthDate}`);
        unresolved++;
        continue;
      }

      const target: DischargeTarget = {
        patientUuid: henry.uuid,
        serialNumber: henry.serialNumber,
        fullName: henry.fullName,
        fullNamePhonetic: henry.fullNamePhonetic,
        birthDate: null,
        sexType: '',
        admissionDate: null,
        dischargeDate: null,
        doctorName: '',
      };

      const bundle = await generateRenrakuForms(target, { admissionDateIso: ff1.admissionDate });
      if (!bundle) {
        failed++;
        continue;
      }

      const compared = compare(ff1, henry.serialNumber, bundle);
      allResults.push(...compared);
      processed++;
      if (processed % 5 === 0) console.log(`[verify] 進捗 ${processed}/${targets.length}`);
    } catch (e) {
      console.error(`[verify] 失敗: ${ff1.dataIdentifier}:`, e instanceof Error ? e.message : e);
      failed++;
    }
  }

  // レポート出力
  const summary = buildSummary(allResults);
  const summaryPath = resolve(OUTPUT_DIR, 'summary.csv');
  const mismatchPath = resolve(OUTPUT_DIR, 'mismatches.csv');
  writeSummaryCsv(summaryPath, summary);
  writeMismatchCsv(mismatchPath, allResults);

  const elapsed = Math.round((Date.now() - started.getTime()) / 1000);
  console.log(`\n[verify] 完了 (${elapsed}s)`);
  console.log(`  処理成功: ${processed}件 / 失敗: ${failed}件 / Henry未解決: ${unresolved}件`);
  console.log(`  サマリ: ${summaryPath}`);
  console.log(`  不一致詳細: ${mismatchPath}`);
  console.log('\n--- 項目別一致率 ---');
  const padField = (s: string): string => {
    let width = 0;
    for (const c of s) width += /[ -ÿ]/.test(c) ? 1 : 2;
    return s + ' '.repeat(Math.max(0, 28 - width));
  };
  for (const s of summary) {
    const valid = s.total - s.na;
    console.log(
      `  ${padField(s.field)} 一致 ${(s.exactRate * 100).toFixed(1)}% (${s.exact}/${valid}) +部分一致 ${(s.exactPlusPartialRate * 100).toFixed(1)}%`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[verify] FATAL:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
