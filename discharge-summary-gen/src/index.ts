// Phase E: オーケストレーション本体（cron エントリ）。
// 退院検知 → 対象ごとに 収集→生成→docx→カルテ保存→Firestore登録。
//
// 安全装置:
//   - 既定はドライラン（docxを _out/ に出すだけ。カルテ/Firestoreは触らない）
//   - 実書き込みは `--confirm` 指定時のみ
//   - `--max=N` で1回の処理上限、`--window=N` で検知ウィンドウ日数（既定7）
//   - 患者ごとに try/catch で隔離（1件失敗しても全体は継続）、throttle
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectTargets, type DischargeTarget } from './detect.ts';
import {
  getPatient,
  getTargetHospitalization,
  fetchMainDisease,
  fetchClinicalRecords,
  fetchCalendarData,
  formatHenryDate,
} from './collect.ts';
import { formatCalendarForPrompt, buildPromptMarkdown } from './prompt.ts';
import { callGeminiProxy, fetchDischargeDestination } from './generate.ts';
import { buildReplacements, dischargeSummaryFileName } from './docfields.ts';
import { renderDischargeSummaryDocx } from './google-docs.ts';
import { uploadDocxToHenry, HOSPITALIZATION_FOLDER_UUID } from './henry-upload.ts';
import { registerDischargeSummary } from './firestore.ts';
import { env } from './env.ts';
import { getHenryIdToken } from './henry-auth.ts';
import { getGoogleAccessToken } from './google-auth.ts';
import { getWebappsSession } from './webapps-auth.ts';

const FILE_TYPE_DOCX = 'FILE_TYPE_DOCX';
const PATIENT_DELAY_MS = 1500;

function parseFlag(name: string, def: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return def;
  const n = Number(arg.split('=')[1]);
  return Number.isFinite(n) ? n : def;
}

const CONFIRM = process.argv.includes('--confirm');
const WINDOW_DAYS = parseFlag('window', 7);
const MAX = parseFlag('max', Number.MAX_SAFE_INTEGER);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pingUptimeKuma(status: 'up' | 'down', msg: string): Promise<void> {
  if (!env.uptimeKumaPushUrl) return;
  try {
    const url = new URL(env.uptimeKumaPushUrl);
    url.searchParams.set('status', status);
    url.searchParams.set('msg', msg);
    await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
  } catch { /* ignore */ }
}

/** 1患者分: 収集→生成→docx。confirm時はカルテ保存＋Firestore登録まで。 */
async function processTarget(t: DischargeTarget): Promise<'generated' | 'uploaded'> {
  const [patient, hosp] = await Promise.all([
    getPatient(t.patientUuid),
    getTargetHospitalization(t.patientUuid),
  ]);
  if (!patient || !hosp) throw new Error('患者または入院情報の取得に失敗');

  const hospStartDate = new Date(hosp.startDate.year, (hosp.startDate.month || 1) - 1, hosp.startDate.day || 1);
  const [disease, records, calendarData] = await Promise.all([
    fetchMainDisease(t.patientUuid),
    fetchClinicalRecords(t.patientUuid),
    fetchCalendarData(t.patientUuid, hospStartDate),
  ]);

  const calendar = formatCalendarForPrompt(calendarData);
  const promptMarkdown = buildPromptMarkdown(
    patient, hosp, disease, records.profile, records.doctorRecords, records.nursingRecords, calendar,
  );
  const [dischargeDestination, ai] = await Promise.all([
    fetchDischargeDestination(patient.fullName, hosp.endDate, patient.serialNumber || ''),
    callGeminiProxy(promptMarkdown),
  ]);

  const title = dischargeSummaryFileName(); // YYYYMMDD_退院サマリー
  const replacements = buildReplacements(patient, hosp, ai, dischargeDestination, calendar.dischargePrescriptions);
  const docxBytes = await renderDischargeSummaryDocx(title, replacements);

  if (!CONFIRM) {
    const outDir = resolve(env.rootDir, '_out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `gen-${t.serialNumber || t.patientUuid.slice(0, 8)}.docx`), docxBytes);
    return 'generated';
  }

  // description='discharge-summary' を付与すると、編集→再保存後も一覧アプリから開ける
  // （Henry拡張の henry_drive_docs_handler が description を見て Firestore docId を付け替える）
  // 退院サマリーは入院に紐づく文書なので「入院」フォルダ配下に保存する。
  const patientFileUuid = await uploadDocxToHenry(t.patientUuid, docxBytes, title, HOSPITALIZATION_FOLDER_UUID, 'discharge-summary');
  try {
    await registerDischargeSummary({
      patientFileUuid,
      patientUuid: t.patientUuid,
      patientSerialNumber: t.serialNumber,
      patientName: patient.fullName || '',
      patientNamePhonetic: patient.fullNamePhonetic || '',
      birthDate: formatHenryDate(patient.detail?.birthDate ?? null),
      sex: patient.detail?.sexType || '',
      admissionDate: formatHenryDate(hosp.startDate),
      dischargeDate: formatHenryDate(hosp.endDate ?? null),
      dischargeDestination,
      doctorName: hosp.hospitalizationDoctor?.doctor?.name || t.doctorName || '',
      fileTitle: title,
      fileType: FILE_TYPE_DOCX,
    });
  } catch (e) {
    // カルテ保存は成功済み。登録だけ失敗 → 復旧のため patientFileUuid を残す。
    throw new Error(
      `カルテ保存は成功 (patientFileUuid=${patientFileUuid}) したが Firestore 登録に失敗: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return 'uploaded';
}

/**
 * 認証の事前疎通。Gemini呼び出し前に Henry/Google/(本番のみ)maokahp-webapps を
 * 軽く refresh して、いずれか失効していれば対象ループに入らず即停止する。
 * これにより「9件全部 Gemini を呼んだ後に Google で全件失敗」のような無駄を防ぐ。
 */
async function preflight(): Promise<void> {
  const checks: Array<[string, () => Promise<unknown>]> = [
    ['Henry', getHenryIdToken],
    ['Google (OAuth/Docs)', getGoogleAccessToken],
    // 検知段階で discharge_summaries Firestore を冪等性キーとして参照するため、
    // ドライランでも webapps セッションが必須
    ['maokahp-webapps (Firestore)', getWebappsSession],
  ];

  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const msg = `認証事前疎通失敗 [${name}]: ${detail}`;
      console.error(`[gen] FATAL ${msg}`);
      await pingUptimeKuma('down', msg.slice(0, 180));
      process.exit(1);
    }
  }
  console.log('[gen] 認証事前疎通OK');
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const mode = CONFIRM ? '本番（カルテ書き込み）' : 'ドライラン（_out/ にdocx出力のみ）';
  console.log(`[gen] 開始 ${startedAt.toISOString()} / モード: ${mode} / window=${WINDOW_DAYS}日 / max=${MAX === Number.MAX_SAFE_INTEGER ? '無制限' : MAX}`);

  await preflight();

  const { totalDischarged, inWindow, alreadyHasSummary, targets } = await detectTargets(WINDOW_DAYS);
  console.log(`[gen] 検知: 退院済み${totalDischarged} / 直近${WINDOW_DAYS}日${inWindow} / サマリ有${alreadyHasSummary} / 対象${targets.length}`);

  const toProcess = targets.slice(0, MAX);
  if (toProcess.length < targets.length) {
    console.log(`[gen] max=${MAX} のため ${toProcess.length}件のみ処理（残り${targets.length - toProcess.length}件は次回）`);
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < toProcess.length; i++) {
    const t = toProcess[i];
    const label = `${t.serialNumber || t.patientUuid.slice(0, 8)}`;
    try {
      console.log(`[gen] (${i + 1}/${toProcess.length}) 処理中: ${label} ...`);
      const result = await processTarget(t);
      ok++;
      console.log(`[gen] (${i + 1}/${toProcess.length}) ${result === 'uploaded' ? 'カルテ保存+登録' : 'docx生成'}完了: ${label}`);
    } catch (e) {
      failed++;
      console.error(`[gen] (${i + 1}/${toProcess.length}) 失敗: ${label}:`, e instanceof Error ? e.message : e);
    }
    if (i < toProcess.length - 1) await sleep(PATIENT_DELAY_MS);
  }

  const elapsed = Math.round((Date.now() - startedAt.getTime()) / 1000);
  const summary = `${mode}: 成功${ok} 失敗${failed} / 対象${targets.length} (${elapsed}s)`;
  console.log(`[gen] 完了: ${summary}`);
  await pingUptimeKuma(failed > 0 ? 'down' : 'up', summary);
}

main().catch(async (err) => {
  console.error('[gen] FATAL:', err instanceof Error ? err.message : err);
  await pingUptimeKuma('down', `FATAL: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}`);
  process.exit(1);
});
