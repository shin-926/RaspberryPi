// Phase C 検証: 収集→生成→テンプレ置換→docx書き出し を実患者で通し、
// .docx を gitignore 済みの _out/ に保存する（カルテには上げない）。コンソールは構造情報のみ。
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
import { buildReplacements, dischargeSummaryFileName } from './docfields.ts';
import { renderDischargeSummaryDocx } from './google-docs.ts';
import { env } from './env.ts';

const PATIENT_UUID = process.argv[2] || '89b640ba-264d-411d-9df5-8c03eff76cca';

async function main(): Promise<void> {
  console.log('[verify-docx] 収集→生成→docx を実行します（カルテには上げません）...');

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

  const replacements = buildReplacements(patient, hosp, ai, dischargeDestination, calendar.dischargePrescriptions);

  const title = dischargeSummaryFileName();
  console.log('[verify-docx] テンプレ複製→置換→docx書き出し中...');
  const docxBytes = await renderDischargeSummaryDocx(title, replacements);

  const outDir = resolve(env.rootDir, '_out');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${title}_${PATIENT_UUID.slice(0, 8)}.docx`);
  writeFileSync(outPath, docxBytes);

  console.log('[verify-docx] OK。構造情報（本文非表示）:');
  console.log({ docxBytes: docxBytes.length, dischargeDestinationFound: !!dischargeDestination, title });
  console.log(`[verify-docx] docx保存先: ${outPath}`);
  console.log('[verify-docx] ↑このWordファイルを開いて、テンプレの体裁通りに差し込まれているか確認してください。');
}

main().catch((e) => {
  console.error('[verify-docx] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
