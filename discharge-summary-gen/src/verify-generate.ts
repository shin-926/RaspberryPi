// Phase B 検証: 収集→プロンプト→Gemini生成→退院先 を実患者で通し、
// 結果（PII含む）を gitignore 済みの _out/ にローカル保存する。コンソールには構造情報のみ。
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getPatient,
  getTargetHospitalization,
  fetchMainDisease,
  fetchClinicalRecords,
  fetchCalendarData,
} from './collect.ts';
import { formatCalendarForPrompt, buildPromptMarkdown } from './prompt.ts';
import { callGeminiProxy, fetchDischargeDestination } from './generate.ts';
import { env } from './env.ts';

const PATIENT_UUID = process.argv[2] || '89b640ba-264d-411d-9df5-8c03eff76cca';

async function main(): Promise<void> {
  console.log('[verify-generate] 収集→生成 を実行します（本文は _out/ に保存、コンソール非表示）...');

  const [patient, hosp] = await Promise.all([
    getPatient(PATIENT_UUID),
    getTargetHospitalization(PATIENT_UUID),
  ]);
  if (!patient || !hosp) throw new Error('患者または入院情報の取得に失敗');

  const hospStartDate = new Date(hosp.startDate.year, (hosp.startDate.month || 1) - 1, hosp.startDate.day || 1);

  const [disease, records, calendarData] = await Promise.all([
    fetchMainDisease(PATIENT_UUID),
    fetchClinicalRecords(PATIENT_UUID),
    fetchCalendarData(PATIENT_UUID, hospStartDate),
  ]);

  const calendar = formatCalendarForPrompt(calendarData);
  const promptMarkdown = buildPromptMarkdown(
    patient, hosp, disease, records.profile, records.doctorRecords, records.nursingRecords, calendar,
  );

  const [dischargeDestination, ai] = await Promise.all([
    fetchDischargeDestination(patient.fullName, hosp.endDate, patient.serialNumber || ''),
    callGeminiProxy(promptMarkdown),
  ]);

  // 結果をローカル（gitignore済み）に保存
  const outDir = resolve(env.rootDir, '_out');
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(outDir, `verify-${PATIENT_UUID.slice(0, 8)}-${ts}.md`);

  const doc = [
    '# Phase B 検証出力（PII注意・gitignore済み）',
    '',
    '## 退院先（patient-status由来）',
    dischargeDestination || '(取得なし)',
    '',
    '## 退院時処方（システム自動出力分）',
    calendar.dischargePrescriptions || 'なし',
    '',
    '## === AI生成結果 ===',
    '',
    '### 主訴', ai.chiefComplaint || '(空)',
    '', '### 現病歴', ai.presentIllness || '(空)',
    '', '### 既往歴', ai.pastHistory || '(空)',
    '', '### 入院時所見', ai.admissionFindings || '(空)',
    '', '### 入院経過（プロブレムリスト＋全体経過）', ai.progress || '(空)',
    '', '### 退院後の方針', ai.plan || '(空)',
    '',
    '## === AIへの入力プロンプト（参考） ===', '', promptMarkdown,
  ].join('\n');

  writeFileSync(outPath, doc, 'utf8');

  console.log('[verify-generate] OK。構造情報（本文非表示）:');
  console.log({
    promptChars: promptMarkdown.length,
    dischargeDestinationFound: !!dischargeDestination,
    ai: {
      主訴: ai.chiefComplaint.length,
      現病歴: ai.presentIllness.length,
      既往歴: ai.pastHistory.length,
      入院時所見: ai.admissionFindings.length,
      入院経過: ai.progress.length,
      退院後の方針: ai.plan.length,
    },
  });
  console.log(`[verify-generate] 本文（PII）の保存先: ${outPath}`);
  console.log('[verify-generate] ↑このファイルを開いて品質を確認してください（git管理外）。');
}

main().catch((e) => {
  console.error('[verify-generate] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
