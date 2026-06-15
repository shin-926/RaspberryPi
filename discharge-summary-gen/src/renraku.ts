// DPC連絡表（医師連絡表Ⅰ・看護師連絡表）生成のオーケストレータ
//
// 既存 index.ts（退院サマリー生成）の兄弟ジョブとして、退院検知でトリガされる。
// 検知ロジック (detect.ts) と認証 (preflight) は退院サマリーと共有可能。
//
// ステータス: LLMプロンプトレイヤー組込み済み（renraku-prompt.ts）

import { detectTargets, type DischargeTarget } from './detect.ts';
import {
  getPatient,
  getTargetHospitalization,
  getHospitalizationByAdmissionDate,
  fetchClinicalRecords,
  formatHenryDate,
} from './collect.ts';
import {
  fetchAllDiseases,
  fetchBodyMeasurements,
  fetchFullCalendar,
  fetchRehabRecords,
  fetchPressureUlcerRecords,
  fetchInspectionFindings,
  fetchPatientFiles,
  fetchSharedInfo,
} from './renraku-collect.ts';
import {
  classifyDiseases,
  detectFormIITriggers,
  inferAdmissionPurpose,
  decideNutritionRoute5Digit,
  decideJCS,
  hasActivePressureUlcerAt,
  pickWeightAtDate,
  isReadmissionWithin4Weeks,
  buildAdlScoreFromDigits,
} from './renraku-decide.ts';
import {
  buildRenrakuPrompt,
  callRenrakuLlm,
  validateLlmDecisions,
  type RenrakuLlmDecisions,
} from './renraku-prompt.ts';
import type { RenrakuFormBundle, AdlScore, DiagnosisItem } from './renraku-types.ts';

// ============================================================
// 1患者分の連絡表生成
// ============================================================
export interface GenerateRenrakuOptions {
  /** 検証用：FF1の入院日に対応するHenry入院を選ぶ */
  admissionDateIso?: string;
}

export async function generateRenrakuForms(
  t: DischargeTarget,
  options: GenerateRenrakuOptions = {},
): Promise<RenrakuFormBundle | null> {
  const [patient, hosp] = await Promise.all([
    getPatient(t.patientUuid),
    options.admissionDateIso
      ? getHospitalizationByAdmissionDate(t.patientUuid, options.admissionDateIso)
      : getTargetHospitalization(t.patientUuid),
  ]);
  if (!patient || !hosp || !hosp.endDate) {
    throw new Error('患者または入院情報が取得できない、もしくは退院日が未定');
  }

  const admissionDate = new Date(hosp.startDate.year, hosp.startDate.month - 1, hosp.startDate.day);
  const dischargeDate = new Date(hosp.endDate.year, hosp.endDate.month - 1, hosp.endDate.day);
  const admissionIso = formatHenryDate(hosp.startDate);
  const dischargeIso = formatHenryDate(hosp.endDate);

  // ===== 1. データ収集（並列） =====
  // NOTE: inspectionFindings / patientFiles はフェーズ2でLLMプロンプトに渡す（連絡表Ⅱの根拠用）
  const [
    diseases,
    records,
    calendar,
    rehabRecords,
    pressureUlcer,
    _inspectionFindings,
    bodyMeasurements,
    _patientFiles,
    sharedInfo,
  ] = await Promise.all([
    fetchAllDiseases(t.patientUuid),
    fetchClinicalRecords(t.patientUuid),
    fetchFullCalendar(t.patientUuid, admissionDate, dischargeDate),
    fetchRehabRecords(t.patientUuid),
    fetchPressureUlcerRecords(t.patientUuid),
    fetchInspectionFindings(t.patientUuid),
    fetchBodyMeasurements(t.patientUuid, admissionIso, dischargeIso),
    fetchPatientFiles(t.patientUuid),
    fetchSharedInfo(t.patientUuid),
  ]);
  void _inspectionFindings; void _patientFiles;

  // ===== 2. 病名仕分け =====
  const classified = classifyDiseases(diseases, admissionIso);
  const formIITriggers = detectFormIITriggers(diseases);

  // ===== 3. 機械的判定（LLM不要） =====
  // 入院時 経管・経静脈栄養5桁
  const nutritionAt = decideNutritionRoute5Digit(
    admissionDate,
    calendar.nutritionOrders,
    calendar.injectionOrders,
  );
  // 退院時 経管・経静脈栄養5桁
  const nutritionAtDischarge = decideNutritionRoute5Digit(
    dischargeDate,
    calendar.nutritionOrders,
    calendar.injectionOrders,
  );

  // 入院時/退院時 JCS（一次：正規表現抽出、二次：デフォルト0）
  const recordsForJcs = [
    ...records.doctorRecords.map((r) => ({ date: new Date(r.date), text: r.text })),
    ...records.nursingRecords.map((r) => ({ date: new Date(r.date), text: r.text })),
  ];
  const jcsAtAdmission = decideJCS(recordsForJcs, admissionDate);
  const jcsAtDischarge = decideJCS(recordsForJcs, dischargeDate);

  // 入院目的のヒューリスティック
  const purposeHint = inferAdmissionPurpose(
    classified.mainAtDischarge?.name || '',
    calendar.prescriptionOrders,
  );

  // 体重
  const bmAtAdmission = pickWeightAtDate(bodyMeasurements, admissionIso);
  const bmAtDischarge = pickWeightAtDate(bodyMeasurements, dischargeIso);

  // 褥瘡有無
  const ulcerAtAdmission = hasActivePressureUlcerAt(pressureUlcer, admissionIso);

  // 再入院判定
  // TODO: previousDischargeIso を取得するために listPatientHospitalizations 全件取得が必要
  const isReadmission = isReadmissionWithin4Weeks(admissionIso, null);

  // ===== 4. LLMに渡す項目 =====
  // 1回のLLM呼び出しで全LLM項目をまとめて取得する。
  // 病名は uuid 形式で候補リストから選ばせる（誤生成防止）
  const validDiseaseUuids = new Set(diseases.map((d) => d.uuid));
  const prompt = buildRenrakuPrompt({
    patient,
    hospitalization: hosp,
    diseasesBeforeOrAtAdmission: classified.beforeOrAtAdmission,
    diseasesAfterAdmission: classified.afterAdmission,
    diseasesAll: diseases,
    patientProfile: records.profile,
    doctorRecords: records.doctorRecords,
    nursingRecords: records.nursingRecords,
    rehabRecords,
    sharedInfo,
    vitalsSummary: buildVitalsSummary(calendar.vitalSigns, admissionDate, dischargeDate),
    notableLabValues: buildLabSummary(calendar.outsideInspectionReportGroups),
  });

  let llm: RenrakuLlmDecisions | null = null;
  let llmWarnings: string[] = [];
  try {
    llm = await callRenrakuLlm(prompt);
    const validation = validateLlmDecisions(llm, validDiseaseUuids);
    llmWarnings = validation.warnings;
    if (validation.warnings.length > 0) {
      console.warn(`[renraku-gen] LLM出力検証警告 (${patient.serialNumber}):`, validation.warnings);
    }
  } catch (e) {
    console.error(`[renraku-gen] LLM呼び出し失敗 (${patient.serialNumber}):`, e instanceof Error ? e.message : e);
    // LLM失敗時はスタブで埋める（needsMdReview=true で全件返す）
  }

  // 病名候補から LLM が選択した uuid に対応する DiagnosisItem を引く
  const diseaseByUuid = new Map<string, DiagnosisItem>(diseases.map((d) => [d.uuid, d]));
  const pickDisease = (uuid: string | undefined): DiagnosisItem | null => {
    if (!uuid) return null;
    return diseaseByUuid.get(uuid) || null;
  };

  // ===== 5. RenrakuFormBundle を組み立てて返す =====
  const bundle: RenrakuFormBundle = {
    patientUuid: t.patientUuid,
    patientName: patient.fullName,
    hospitalizationUuid: hosp.uuid,
    admissionDate: admissionIso,
    dischargeDate: dischargeIso,
    generatedAt: '', // TODO: 呼び出し元で stamp

    doctorFormI_admission: {
      admissionPurpose: {
        value: purposeHint.defaultValue,
        confidence: 'medium',
        evidence: [{ location: 'heuristic', text: purposeHint.hint }],
        needsMdReview: true,
      },
      triggerDisease: {
        value: pickDisease(llm?.trigger_disease?.uuid) ?? classified.beforeOrAtAdmission[0] ?? classified.mainAtDischarge!,
        confidence: llm?.trigger_disease?.confidence ?? 'low',
        evidence: llmEvidence(llm?.trigger_disease?.evidence, 'LLM/契機病名'),
        needsMdReview: llm?.trigger_disease?.confidence !== 'high',
        alternatives: classified.beforeOrAtAdmission.slice(0, 4).map((d) => ({
          value: d,
          reason: `${d.icd10} ${d.startDate}`,
        })),
      },
      jcsAtAdmission,
      swallowingImpairment: {
        value: clamp019(llm?.swallowing_at_admission?.value, 9),
        confidence: llm?.swallowing_at_admission?.confidence ?? 'low',
        evidence: llmEvidence(llm?.swallowing_at_admission?.evidence, 'LLM/嚥下障害(入院時)'),
        needsMdReview: (llm?.swallowing_at_admission?.confidence ?? 'low') !== 'high',
      },
      nutritionRoute5: nutritionAt,
      requiresFormII: formIITriggers,
    },

    doctorFormI_admissionExtras: {
      // 併存症・発症は LLM が選別した uuid のみ採用
      // 主傷病/契機/資源と重複する uuid は除外（emitter側にも保険のdedupあり）
      comorbidities: selectByLlm(
        llm?.comorbidities?.selections,
        diseaseByUuid,
        new Set([
          classified.mainAtDischarge?.uuid,
          llm?.trigger_disease?.uuid,
          llm?.resource_disease?.uuid,
        ].filter((u): u is string => !!u)),
      ),
      postAdmissionDiseases: selectByLlm(
        llm?.post_admission_diseases?.selections,
        diseaseByUuid,
        new Set([
          classified.mainAtDischarge?.uuid,
          llm?.trigger_disease?.uuid,
          llm?.resource_disease?.uuid,
          ...(llm?.comorbidities?.selections?.map((s) => s.uuid) ?? []),
        ].filter((u): u is string => !!u)),
      ),
      readmissionReason: isReadmission
        ? {
            value: {
              category: llm?.readmission_reason?.category ?? null,
              code: llm?.readmission_reason?.code ?? 7,
              label: llm?.readmission_reason?.evidence ?? 'LLM未判定',
            },
            confidence: llm?.readmission_reason?.confidence ?? 'low',
            evidence: llmEvidence(llm?.readmission_reason?.evidence, 'LLM/再入院理由'),
            needsMdReview: true,
          }
        : null,
    },

    doctorFormI_discharge: {
      outcome: {
        value: clampOutcome(llm?.outcome?.value, 1),
        confidence: llm?.outcome?.confidence ?? 'low',
        evidence: llmEvidence(llm?.outcome?.evidence, 'LLM/退院時転帰'),
        needsMdReview: (llm?.outcome?.confidence ?? 'low') !== 'high',
      },
      departmentChange: false, // TODO: 親/子様式1の期間判定
      jcsAtDischarge,
      swallowingImpairmentAtDischarge: {
        value: clamp019(llm?.swallowing_at_discharge?.value, 9),
        confidence: llm?.swallowing_at_discharge?.confidence ?? 'low',
        evidence: llmEvidence(llm?.swallowing_at_discharge?.evidence, 'LLM/嚥下障害(退院時)'),
        needsMdReview: (llm?.swallowing_at_discharge?.confidence ?? 'low') !== 'high',
      },
      nutritionRoute5AtDischarge: nutritionAtDischarge,
      resourceDisease: {
        value: pickDisease(llm?.resource_disease?.uuid) ?? classified.mainAtDischarge ?? classified.beforeOrAtAdmission[0],
        confidence: llm?.resource_disease?.confidence ?? 'low',
        evidence: llmEvidence(llm?.resource_disease?.evidence, 'LLM/医療資源病名'),
        needsMdReview: llm?.resource_disease?.confidence !== 'high',
      },
      mainDisease: classified.mainAtDischarge || classified.beforeOrAtAdmission[0],
    },

    nurseFormAdmission: {
      swallowingImpairment: {
        value: clamp019(llm?.swallowing_at_admission?.value, 9),
        confidence: llm?.swallowing_at_admission?.confidence ?? 'low',
        evidence: llmEvidence(llm?.swallowing_at_admission?.evidence, 'LLM/嚥下'),
        needsMdReview: (llm?.swallowing_at_admission?.confidence ?? 'low') !== 'high',
      },
      homeMedicalCareBeforeAdmission: {
        value: clamp0129(llm?.home_medical_care_before?.value, 9),
        confidence: llm?.home_medical_care_before?.confidence ?? 'low',
        evidence: llmEvidence(llm?.home_medical_care_before?.evidence, 'LLM/入院前在宅医療'),
        needsMdReview: (llm?.home_medical_care_before?.confidence ?? 'low') !== 'high',
      },
      hasPressureUlcer: ulcerAtAdmission,
      heightCm: bmAtAdmission.heightCm,
      weightKg: bmAtAdmission.weightKg,
      bmi: bmAtAdmission.bmi,
      admissionRoute: {
        value: llm?.admission_route?.value ?? '',
        confidence: llm?.admission_route?.confidence ?? 'low',
        evidence: llmEvidence(llm?.admission_route?.evidence, 'LLM/入院経路'),
        needsMdReview: (llm?.admission_route?.confidence ?? 'low') !== 'high',
      },
      dementiaLevel: {
        value: (llm?.dementia_level?.value as any) ?? '自立',
        confidence: llm?.dementia_level?.confidence ?? 'low',
        evidence: llmEvidence(llm?.dementia_level?.evidence, 'LLM/認知症自立度'),
        needsMdReview: (llm?.dementia_level?.confidence ?? 'low') !== 'high',
      },
      bedriddenLevel: {
        value: (llm?.bedridden_level?.value as any) ?? 'J1',
        confidence: llm?.bedridden_level?.confidence ?? 'low',
        evidence: llmEvidence(llm?.bedridden_level?.evidence, 'LLM/寝たきり度'),
        needsMdReview: (llm?.bedridden_level?.confidence ?? 'low') !== 'high',
      },
      ambulanceArrival: false,
      adlScoreAtAdmission: buildAdlDecision(llm?.adl_at_admission),
    },

    nurseFormDischarge: {
      weightAtDischarge: bmAtDischarge.weightKg,
      homeMedicalCareAfterDischarge: {
        value: clamp0129(llm?.home_medical_care_after?.value, 9),
        confidence: llm?.home_medical_care_after?.confidence ?? 'low',
        evidence: llmEvidence(llm?.home_medical_care_after?.evidence, 'LLM/退院後在宅医療'),
        needsMdReview: (llm?.home_medical_care_after?.confidence ?? 'low') !== 'high',
      },
      dischargeDestination: {
        value: llm?.discharge_destination?.value ?? '',
        confidence: llm?.discharge_destination?.confidence ?? 'low',
        evidence: llmEvidence(llm?.discharge_destination?.evidence, 'LLM/退院先'),
        needsMdReview: (llm?.discharge_destination?.confidence ?? 'low') !== 'high',
      },
      adlScoreAtDischarge: buildAdlDecision(llm?.adl_at_discharge),
    },
  };

  if (llmWarnings.length > 0) {
    console.warn(`[renraku-gen] ${patient.serialNumber}: LLM出力に整合性警告${llmWarnings.length}件`);
  }
  return bundle;
}

// ============================================================
// ヘルパー
// ============================================================
/** LLMが選択した uuid 配列から DiagnosisItem を引き、除外uuid・重複・最大10件で絞り込む */
function selectByLlm(
  selections: Array<{ uuid: string; evidence: string }> | undefined,
  diseaseByUuid: Map<string, DiagnosisItem>,
  excludeUuids: Set<string>,
): DiagnosisItem[] {
  if (!selections || selections.length === 0) return [];
  const out: DiagnosisItem[] = [];
  const seen = new Set<string>(excludeUuids);
  for (const s of selections) {
    if (!s.uuid || seen.has(s.uuid)) continue;
    const d = diseaseByUuid.get(s.uuid);
    if (!d) continue;
    seen.add(s.uuid);
    out.push(d);
    if (out.length >= 10) break;
  }
  return out;
}

function llmEvidence(text: string | undefined, location: string): Array<{ location: string; text: string }> {
  if (!text) return [];
  return [{ location, text }];
}

function clamp019(v: unknown, fallback: 0 | 1 | 9): 0 | 1 | 9 {
  return v === 0 || v === 1 || v === 9 ? (v as 0 | 1 | 9) : fallback;
}

function clamp0129(v: unknown, fallback: 0 | 1 | 2 | 9): 0 | 1 | 2 | 9 {
  return v === 0 || v === 1 || v === 2 || v === 9 ? (v as 0 | 1 | 2 | 9) : fallback;
}

function clampOutcome(v: unknown, fallback: 1 | 2 | 3 | 4 | 5 | 6): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return n >= 1 && n <= 6 ? (n as 1 | 2 | 3 | 4 | 5 | 6) : fallback;
}

function buildAdlDecision(adl: { raw?: string; digit_evidence?: string[]; confidence?: 'high' | 'medium' | 'low' } | undefined): {
  value: AdlScore;
  confidence: 'high' | 'medium' | 'low';
  evidence: Array<{ location: string; text: string }>;
  needsMdReview: boolean;
} {
  const raw = adl?.raw && /^\d{10}$/.test(adl.raw) ? adl.raw : '9999999999';
  const score = buildAdlScoreFromDigits(raw);
  const evidenceList = (adl?.digit_evidence || []).slice(0, 10).map((text, i) => ({ location: `桁${i + 1}`, text }));
  return {
    value: score,
    confidence: adl?.confidence ?? 'low',
    evidence: evidenceList,
    needsMdReview: (adl?.confidence ?? 'low') !== 'high',
  };
}

function buildVitalsSummary(
  vitals: Array<{
    recordTime?: { seconds: number };
    temperature?: { value: number } | null;
    pulseRate?: { value: number } | null;
    bloodPressureUpperBound?: { value: number } | null;
    bloodPressureLowerBound?: { value: number } | null;
    spo2?: { value: number } | null;
  }>,
  admissionDate: Date,
  dischargeDate: Date,
): string {
  if (vitals.length === 0) return '';
  // 入院日±2日 と 退院日±2日 の最初の記録を抜粋
  const window = 2 * 24 * 60 * 60 * 1000;
  const admMs = admissionDate.getTime();
  const disMs = dischargeDate.getTime();
  const inAdmission = vitals.find((v) => {
    const ms = (v.recordTime?.seconds || 0) * 1000;
    return Math.abs(ms - admMs) <= window;
  });
  const inDischarge = vitals.find((v) => {
    const ms = (v.recordTime?.seconds || 0) * 1000;
    return Math.abs(ms - disMs) <= window;
  });
  const lines: string[] = [];
  const fmt = (label: string, v: typeof vitals[0] | undefined): void => {
    if (!v) return;
    const dateStr = v.recordTime?.seconds ? new Date(v.recordTime.seconds * 1000).toISOString().slice(0, 10) : '不明';
    const temp = v.temperature?.value != null ? (v.temperature.value / 10).toFixed(1) : '-';
    const bp =
      v.bloodPressureUpperBound?.value != null && v.bloodPressureLowerBound?.value != null
        ? `${v.bloodPressureUpperBound.value / 10}/${v.bloodPressureLowerBound.value / 10}`
        : '-';
    const hr = v.pulseRate?.value != null ? String(v.pulseRate.value / 10) : '-';
    const spo2 = v.spo2?.value != null ? String(v.spo2.value / 10) : '-';
    lines.push(`${label} (${dateStr}): T=${temp} BP=${bp} HR=${hr} SpO2=${spo2}`);
  };
  fmt('入院時', inAdmission);
  fmt('退院時', inDischarge);
  return lines.join('\n');
}

function buildLabSummary(groups: Array<Record<string, unknown>>): string {
  if (!groups || groups.length === 0) return '';
  const importantKeywords = ['Cr', 'CRE', 'BUN', '尿素窒素', 'Alb', 'アルブミン', 'CRP', 'BNP', 'NT-proBNP', 'Hb'];
  const lines: string[] = [];
  for (const g of groups) {
    const rows = (g.outsideInspectionReportRows as Array<Record<string, unknown>>) || [];
    for (const row of rows) {
      const name = String(row.name || '');
      if (!importantKeywords.some((k) => name.includes(k))) continue;
      const reports = (row.outsideInspectionReports as Array<{ date?: { year: number; month: number; day: number }; value?: string; isAbnormal?: boolean }>) || [];
      for (const r of reports.slice(0, 3)) {
        const d = r.date ? `${r.date.year}-${String(r.date.month).padStart(2, '0')}-${String(r.date.day).padStart(2, '0')}` : '不明';
        lines.push(`${d} ${name}: ${r.value}${r.isAbnormal ? ' [異常]' : ''}`);
      }
    }
  }
  return lines.slice(0, 40).join('\n');
}

// ============================================================
// バッチエントリ（cron用）
// ============================================================
const CONFIRM = process.argv.includes('--confirm');
const WINDOW_DAYS = parseInt(
  process.argv.find((a) => a.startsWith('--window='))?.split('=')[1] || '7',
  10,
);

async function main(): Promise<void> {
  const started = new Date();
  const mode = CONFIRM ? '本番' : 'ドライラン';
  console.log(`[renraku-gen] 開始 ${started.toISOString()} / モード: ${mode} / window=${WINDOW_DAYS}日`);

  const { targets } = await detectTargets(WINDOW_DAYS);
  console.log(`[renraku-gen] 対象: ${targets.length}件`);

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const label = t.serialNumber || t.patientUuid.slice(0, 8);
    try {
      const bundle = await generateRenrakuForms(t);
      if (!bundle) throw new Error('生成失敗');
      // TODO: --confirm 時は Firestore 登録＋docx出力＋カルテ保存
      // 現時点はドライランで JSON を _out/ に出すのみ
      const json = JSON.stringify(bundle, null, 2);
      const path = `./_out/renraku-${label}.json`;
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync('./_out', { recursive: true });
      writeFileSync(path, json);
      ok++;
      console.log(`[renraku-gen] (${i + 1}/${targets.length}) 生成完了: ${label} → ${path}`);
    } catch (e) {
      failed++;
      console.error(`[renraku-gen] (${i + 1}/${targets.length}) 失敗: ${label}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`[renraku-gen] 完了 成功${ok} 失敗${failed}`);
}

// このファイルが直接実行された時のみ main() を走らせる
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[renraku-gen] FATAL:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
